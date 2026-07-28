// RAG-corpus dedup gate — spec §6.2 / §10 bar 6 ("zero RAG-duplication").
//
// The harvest produces Atlas seed candidates that ride the SAME indexed corpus
// the generic RAG already serves. If a candidate's prose is already-indexed
// content, re-seeding it adds duplication, not knowledge. This gate detects that
// overlap in TWO layers, then RESOLVES it:
//
//   1. LEXICAL PRE-FILTER (fast, no embed) — probe the live `GET /api/search`
//      RAG endpoint (via `AtlasHttpClient.search`) and compute token containment.
//      A VERBATIM/near-verbatim hit (≥ the verbatim threshold) short-circuits:
//      the candidate is a byte-level duplicate, so we mark it and SKIP the
//      (expensive) embedding round-trip entirely. This owns the query-shortening
//      / byte-bound behavior — it is the fast path, not the whole gate.
//
//   2. SEMANTIC RETRIEVAL (pgvector cosine) — for candidates that SURVIVE the
//      lexical pre-filter (no verbatim hit), embed the candidate and query the
//      corpus by vector similarity (the injected `embed` + `vectorSearch`
//      seams). Cosine top-k catches PARAPHRASE and NON-LATIN (CJK) overlap that
//      the lexical `containment()` oracle misses (its [a-z0-9] tokenizer yields
//      an EMPTY token set for CJK, and a paraphrase shares few surface tokens).
//      This is the primary overlap oracle.
//
// On EITHER kind of overlap the gate DISTILLS-TO-DELTA (not mark-only): the
// injected `distillDelta` LLM seam rewrites `content` down to only the NET-NEW
// part the corpus does not already cover. A rewrite adopts the delta prose; a
// `no-delta` verdict marks the candidate `approvable=false` (a corpus duplicate
// with nothing net-new is not worth re-seeding, but is NEVER dropped — the human
// reviewer decides at ratification). Every overlapping candidate is also
// ANNOTATED: `provenance.validated_against` gets a marker and a `fused_from`
// evidence item points at the overlapping passage, both carrying the
// RAG_CORPUS_OVERLAP_REF_PREFIX so canonicalize's evidenceDepth excludes the mark
// from ranking — the annotation is rank-NEUTRAL (a corpus duplicate must never
// OUTRANK its un-duplicated twin; §6.2).
//
// FALLBACK (mark-only): when the semantic seams (`embed`/`vectorSearch`/
// `distillDelta`) are NOT injected, the gate degrades to the lexical mark-only
// behavior — it annotates a verbatim/near-verbatim overlap but does not embed or
// rewrite. This keeps the deterministic-transform tests (which inject only
// `client`) exercising the pre-filter in isolation.
//
// It NEVER silently drops a candidate (spec §6.2): a missed or over-eager
// overlap can only ever annotate/rewrite prose or floor approvability, never
// lose a row. The returned array therefore always has the same length as the
// input. Ranking/drop decisions stay the human reviewer's call at ratification.
//
// Determinism note: the search probe is non-deterministic across runs, but the
// downstream upsert is idempotent pending-only (§5), and because we never drop,
// a re-run can only re-annotate — it cannot lose work.
//
// FAILURE MODE (Theme C.3) — soft-disable, not hard-abort. A single transient
// probe blip passes that one candidate through un-annotated (a missed mark,
// never a lost row). A STREAK of MAX_CONSECUTIVE_PROBE_FAILURES probe failures
// with no intervening success means the endpoint is down/misconfigured
// (url/auth); rather than THROW — which would unwind runHarvest and lose every
// candidate processed so far (the gate runs BEFORE upsert) — the gate
// SOFT-disables: it stops probing, passes the rest through un-annotated, and
// emits a loud run-level `"dedup gate disabled: N/M probes failed"` warning. It
// ALSO emits a run-level `probesFailed`/`probesSkipped` metric on every run so
// dedup coverage is always visible.
//
// RUNBOOK — ≤MAX_CONSECUTIVE_PROBE_FAILURES-candidate LIMITATION. A run with
// fewer PROBEABLE candidates than the consecutive-failure threshold (i.e. ≤4
// with the default of 5) can NEVER reach the streak, so a down endpoint for
// such a run will NOT trip the soft-disable warning — the gate is effectively
// disabled with no "dedup gate disabled" line. Operators must therefore watch
// the run-level `probesFailed`/`probesSkipped` metric (always emitted): a small
// run whose `probesFailed` equals its candidate count had its dedup gate
// silently disabled and should be re-pointed/re-run against a healthy
// `/api/search` endpoint. (This note lives here rather than in a runbook doc
// because there is no operational runbook file in-repo yet — S14 introduces
// SANDBOX.md; fold this limitation into its harvest ops section when it lands.)
//
// `GET /api/search` is LIVE on the server: lexical tsvector search over the
// indexed chunks table, mounted alongside the atlas ratification routes and
// authenticated with the same bearer (see src/server.ts / client.ts). The
// vectorSearch seam runs cosine retrieval over the SAME chunks table
// (db/queries.ts:searchChunks) via the harvest driver's DB context.

import type { AtlasHttpClient, SearchHit } from "../atlas/client.js";
import { RAG_CORPUS_OVERLAP_REF_PREFIX } from "../atlas/canonicalize.js";
import { RAG_NO_DELTA_MARKER } from "../atlas/types.js";
import type {
  Candidate,
  CorpusHit,
  DistillDeltaResult,
  EvidenceItem,
} from "../atlas/types.js";

export interface RagDedupContext {
  // The live RAG-corpus probe. Only `.search({ text, source?, limit? })` is
  // used. (Spec §4.6 leaves room for an MCP search fn; the AtlasHttpClient
  // surface is the concrete wiring the S18 driver injects.) Typed as the
  // `search`-only slice so the driver can pass its client without a widening
  // cast and tests can inject a `search`-only stub. Drives the LEXICAL
  // PRE-FILTER (verbatim short-circuit).
  client: Pick<AtlasHttpClient, "search">;
  // Similarity in [0,1] at/above which a LEXICAL corpus hit counts as
  // verbatim/near-verbatim overlap (the pre-filter's short-circuit threshold).
  // Defaults to DEFAULT_MIN_OVERLAP (verbatim-ish).
  minOverlap?: number;
  // NEW (Theme B) — embed a text into a dense vector for the semantic probe.
  // When omitted (with vectorSearch/distillDelta) the gate degrades to the
  // lexical mark-only fallback.
  embed?: (text: string) => Promise<number[]>;
  // NEW (Theme B) — cosine top-k retrieval over the corpus vector index. `k` is
  // how many hits to return; the gate keeps the best by `similarity`.
  vectorSearch?: (vector: number[], k: number) => Promise<CorpusHit[]>;
  // NEW (Theme B) — rewrite an overlapping candidate's content down to its
  // net-new delta (or report no-delta / no-overlap). See llm.ts:distillDelta.
  distillDelta?: (
    cand: Candidate,
    overlaps: CorpusHit[],
  ) => Promise<DistillDeltaResult>;
  // Cosine similarity in [0,1] at/above which a SEMANTIC (vector) corpus hit
  // counts as overlap worth resolving via distill-to-delta. Defaults to
  // DEFAULT_MIN_SEMANTIC_OVERLAP. Distinct from `minOverlap` (the lexical
  // verbatim threshold) — semantic near-duplicates need not be byte-identical.
  minSemanticOverlap?: number;
  // How many corpus hits the vector probe retrieves per candidate. Defaults to
  // VECTOR_PROBE_LIMIT.
  vectorProbeLimit?: number;
  // Builds the (truncated, URL-safe) text sent to the lexical probe for a
  // candidate. Defaults to the module's `candidateProbeQueryText`. Injectable so
  // the empty/whitespace-probe skip (finding 3) can be exercised deterministically
  // without contriving the truncation math — production always uses the default.
  candidateProbeQueryText?: (cand: Candidate) => string;
}

// Verbatim/near-verbatim by default: most of the candidate's tokens already
// appear in a single corpus passage. Tuned high so only true duplication trips
// the gate — partial topical overlap is normal and must NOT be trimmed away.
const DEFAULT_MIN_OVERLAP = 0.8;

// How many corpus hits to probe per candidate. One run-time round-trip per
// candidate; a small top-k is enough to catch a verbatim re-index.
const PROBE_LIMIT = 5;

// Maximum probe-text length (chars). `AtlasHttpClient.search` puts the probe
// into a `GET` query string, so a large distilled body can blow past common
// URL-length limits (~8 KB total request line; the query value must stay well
// under that) → a 414/400 the per-candidate try/catch would swallow as a
// silent no-op for exactly the LARGEST candidates. We truncate to a safe
// leading slice before sending. Containment is computed on the candidate's
// tokens against the hit, and a leading slice is sufficient for the overlap
// heuristic (a verbatim re-index overlaps in its opening prose too).
const MAX_PROBE_TEXT_CHARS = 2048;

// Maximum ENCODED probe-text length: the length of the form-urlencoded query
// VALUE (ASCII, so chars === bytes) that `client.search` puts in the GET URL —
// it serializes via `new URLSearchParams({ text })`, so the bound is measured
// with that SAME encoder (see wireEncodedLength below), NOT
// encodeURIComponent. The two diverge: `! ' ( ) ~` are kept literal by
// encodeURIComponent (1 char each) but percent-encoded on the wire (3 chars
// each), so an encodeURIComponent-measured bound under-counts an
// `!'()~`-dense probe by up to ~3x and lets it past the budget. The char
// slice above is necessary but NOT sufficient: form-urlencoding expands
// non-ASCII ~9x (one BMP CJK char = 3 UTF-8 bytes = 9 encoded chars), so a
// 2048-CHAR slice of CJK prose is ~18 KB of URL — the server rejects it
// (414/431), the per-candidate catch counts that as a PROBE failure, and five
// non-ASCII candidates in a row trip the consecutive fail-fast with an
// "endpoint down or misconfigured" MISdiagnosis. Bounding the ENCODED length
// keeps every script inside the same ~8 KB request-line budget (6 KB value +
// path/params/headroom). Deliberately fixed HERE rather than by excluding 4xx
// from the failure streak — 4xx-exclusion would defeat the fail-fast's
// protection against a missing/misrouted `/api/search` route (see the
// header). Exported for the byte-bound test.
export const MAX_PROBE_TEXT_ENCODED_BYTES = 6144;

// The EXACT length of the wire-encoded query VALUE `client.search` produces:
// serialize with the SAME encoder it uses (`new URLSearchParams({ text })`,
// application/x-www-form-urlencoded) and subtract the `text=` key prefix.
// Never throws — URLSearchParams applies USVString conversion (a lone
// surrogate becomes U+FFFD) instead of encodeURIComponent's URIError, which
// composes with the well-formedness sanitize in candidateProbeQueryText.
// Exported for the byte-bound pin test.
export function wireEncodedLength(text: string): number {
  return new URLSearchParams({ text }).toString().length - "text=".length;
}

// Minimum distinct candidate tokens before the containment gate is allowed to
// fire. A very short candidate (a handful of common tokens) can spuriously hit
// the high containment threshold against unrelated corpus prose that happens to
// contain those same common words — a false "overlap" mark. Below this floor we
// never mark; the gate is mark-only, so the only cost of skipping is a missed
// annotation, never a lost row.
const MIN_CANDIDATE_TOKENS = 5;

// Maximum candidate-body length (chars) sent to the embedding seam. The
// embedding model has a hard input-token limit (~8192 tokens for the OpenAI
// text-embedding-* family ≈ 32K chars); an oversized body 400/413s, the
// per-candidate semantic try/catch swallows it as `semanticFailed`, and the
// LARGEST — most duplication-prone — candidates SILENTLY skip semantic dedup.
// So we truncate to a safe leading slice before embedding, mirroring the
// lexical probe's truncation (candidateProbeQueryText) and the embedding
// provider's own char cap (indexing/embeddings.ts MAX_CHARS = 30_000). A
// leading slice is sufficient to place the candidate in vector space for the
// overlap decision — a verbatim/paraphrase re-index overlaps in its opening
// prose too. Kept in step with the provider cap so the gate never hands the
// provider a body the provider itself would truncate (or reject).
const MAX_EMBED_TEXT_CHARS = 30_000;

// Cosine similarity in [0,1] at/above which a SEMANTIC (vector) corpus hit
// counts as overlap. Lower than the lexical verbatim threshold because a
// paraphrase — the exact case semantic retrieval exists to catch — is a real
// duplicate at a cosine well below byte-identity. Tuned so a genuine paraphrase
// of an indexed passage trips it while merely topically-adjacent prose does not.
const DEFAULT_MIN_SEMANTIC_OVERLAP = 0.82;

// How many corpus hits the vector probe retrieves per candidate. A small top-k
// is enough: the delta rewrite subtracts all of them, and only the best few
// meaningfully overlap.
const VECTOR_PROBE_LIMIT = 5;

// Fail-fast bound on CONSECUTIVE probe failures. A single transient blip must
// never abort the batch (per-candidate catch below), but N failures in a row —
// with no intervening success — means the endpoint is down or misconfigured
// (url/auth), and silently passing EVERY remaining candidate through
// un-annotated would disable the dedup gate for the whole run while looking
// like success. Rather than HARD-ABORT the whole harvest (which would unwind
// runHarvest and lose every candidate processed so far — the gate runs BEFORE
// the upsert, so an abort is pure lost work), the gate SOFT-fails: once the
// streak trips, it stops probing, passes the remaining candidates through
// un-annotated, and emits a loud run-level `"dedup gate disabled"` warning +
// the run-level probe metric so the run is re-pointed/re-run. A successful
// probe resets the streak. NOTE (≤4-candidate limitation): a run with fewer
// than this many PROBEABLE candidates can never reach the streak, so an
// endpoint that is down for such a run cannot trip the soft-disable — the
// run-level metric (probesFailed/probesSkipped) is the signal there instead
// (see the RUNBOOK note in the module header).
const MAX_CONSECUTIVE_PROBE_FAILURES = 5;

// Per candidate: probe the corpus, and on overlap MARK it. Returns the
// candidates in input order, same length (NEVER drops). Pure w.r.t. the input
// array — a no-overlap (or failed-probe) candidate is passed through as the
// caller's original object, unchanged; an overlap produces a fresh annotated
// object (the input is never mutated in place).
export async function dedupAgainstRagCorpus(
  cands: Candidate[],
  ctx: RagDedupContext,
): Promise<Candidate[]> {
  if (cands.length === 0) return [];
  const minOverlap = ctx.minOverlap ?? DEFAULT_MIN_OVERLAP;

  const out: Candidate[] = [];
  // Streak of probe (client.search) failures with no intervening success — see
  // MAX_CONSECUTIVE_PROBE_FAILURES. Only PROBE failures count toward the
  // streak; a post-probe (overlap/annotation) failure still passes the
  // candidate through but does not indicate the endpoint is down.
  let consecutiveProbeFailures = 0;
  // Run-level probe telemetry (spec Theme C.3). `probesFailed` counts LEXICAL
  // probes that THREW (network/endpoint failures); `probesSkipped` counts
  // candidates that never issued a probe (sub-token-floor, empty/whitespace
  // probe text, or probing stopped after the gate soft-disabled);
  // `semanticFailed` (below) counts SEMANTIC-layer failures. Emitted once at the
  // end so a run can see how much of the batch the dedup gate actually covered —
  // the ONLY disabled-gate signal for a run with too few candidates to trip the
  // consecutive-failure streak.
  let probesFailed = 0;
  let probesSkipped = 0;
  // Count of candidates that actually ISSUED a probe (reached client.search),
  // whether it resolved or threw. This is the "M" denominator the header
  // defines the "N/M probes failed" disable ratio over — the PROBEABLE count,
  // NOT cands.length (a batch padded with sub-token-floor or soft-disabled
  // candidates that never probed must not dilute the ratio).
  let probeable = 0;
  // Count of SEMANTIC-layer failures (embed/vectorSearch/distillDelta threw).
  // Semantic failures are NOT probe failures (they never touch the
  // consecutive-probe streak — see the semantic try/catch), but a fully-failing
  // semantic layer would otherwise report probesFailed=0/probesSkipped=0 and
  // look like a clean run. Counted + surfaced in the run-level metric so the
  // degradation is never silent (the header's "never silently disabled" claim).
  let semanticFailed = 0;
  // Count of candidates that reached the SEMANTIC layer WITHOUT throwing (embed
  // + vectorSearch both resolved) — the semantic-side "probeable" denominator.
  // Reached from BOTH the lexical-survivor path AND the CJK sub-token-floor
  // route. Counted so an all-CJK / all-semantic healthy run still emits a
  // run-level coverage line (finding 2): those candidates were previously
  // counted in neither probeable nor probesSkipped, so a healthy semantic-only
  // run emitted NO coverage line at all.
  let semanticProbed = 0;
  // Of the `semanticProbed` candidates, how many got ZERO usable corpus hits
  // back from vectorSearch. A vectorSearch that returns `[]` for EVERY probed
  // candidate (index empty/misconfigured, NOT throwing) means ZERO effective
  // semantic dedup while looking like a clean run — the semantic parallel of
  // the lexical fail-fast (finding 1). When `semanticProbed > 0` and this
  // equals it, the whole semantic layer was a silent no-op and the gate emits a
  // run-level "semantic dedup degraded" warning.
  let semanticZeroHits = 0;
  // SOFT-abort latch: set once the consecutive-failure streak trips. Rather
  // than throw (which would unwind runHarvest and lose every candidate — the
  // gate runs BEFORE upsert), the gate stops probing and passes the remaining
  // candidates through un-annotated, warning loudly at the end.
  let gateDisabled = false;
  for (const cand of cands) {
    // The token set we measure containment against — the FULL candidate body,
    // never the truncated probe slice. Computed once, up front, so it can both
    // gate the (expensive) network probe and feed `bestOverlap`'s denominator.
    const candTokens = tokenSet(candidateFullText(cand));

    // Efficiency short-circuit: a candidate with too few distinct LEXICAL
    // tokens can never clear the containment gate (`bestOverlap` discards it
    // below the MIN_CANDIDATE_TOKENS floor — too few tokens to discriminate
    // true duplication from incidental common-word overlap). So SKIP the
    // lexical network probe entirely rather than pay an HTTP round-trip only to
    // discard the result.
    //
    // BUT the lexical tokenizer is [a-z0-9]-only, so a CJK / non-Latin
    // candidate yields an EMPTY token set even though it carries real content.
    // The SEMANTIC layer (embeddings) is language-agnostic and was built (§6.2)
    // specifically to catch that CJK / paraphrase overlap the lexical oracle
    // misses. So a candidate with insufficient LEXICAL tokens but NON-TRIVIAL
    // content must still be ROUTED to the semantic path (when the semantic
    // seams are wired) rather than short-circuited out. Only a GENUINELY empty
    // candidate (no content to embed) is skipped here. Either way: never drops
    // — the fall-through push preserves the mark-only invariant.
    if (candTokens.size < MIN_CANDIDATE_TOKENS) {
      const semanticWired =
        Boolean(ctx.embed) &&
        Boolean(ctx.vectorSearch) &&
        Boolean(ctx.distillDelta);
      const hasContent = candidateFullText(cand).trim() !== "";
      if (semanticWired && hasContent) {
        // Route to the semantic path: the lexical probe has no signal for this
        // candidate, but embeddings do. (The lexical `hits` are empty — a
        // sub-token-floor candidate never issued a lexical probe.)
        const resolved = await resolveSemantic(cand, ctx);
        if (resolved.semanticFailed) semanticFailed++;
        if (resolved.semanticProbed) {
          semanticProbed++;
          if (resolved.zeroHits) semanticZeroHits++;
        }
        out.push(resolved.candidate);
        continue;
      }
      // Genuinely empty, or no semantic seams wired: skip cleanly (never drops).
      probesSkipped++;
      out.push(cand);
      continue;
    }

    // Gate soft-disabled by a probe-failure streak: stop probing the (down)
    // endpoint and pass the rest through un-annotated. Counted as SKIPPED (no
    // probe issued), not FAILED (no probe attempted).
    if (gateDisabled) {
      probesSkipped++;
      out.push(cand);
      continue;
    }

    // The query text sent over the network is truncated (URL-length safety);
    // the containment denominator above is NOT — see candidateProbeQueryText.
    // The builder is injectable (defaults to the module fn) so the empty-probe
    // skip below can be exercised deterministically.
    const probeQueryText = (
      ctx.candidateProbeQueryText ?? candidateProbeQueryText
    )(cand);

    // Empty/whitespace probe text: a candidate can clear the MIN_CANDIDATE_TOKENS
    // floor on its FULL body while its truncated probe WINDOW (leading
    // MAX_PROBE_TEXT_CHARS chars) is entirely whitespace — the tokens live
    // beyond the char window. Sending an empty query would draw a server 400
    // that the per-candidate catch would MIScount as a probe failure (tripping
    // the false "endpoint down" fail-fast). So skip it: don't send it, and count
    // it as SKIPPED (never issued a probe), NOT FAILED. Still never drops.
    if (probeQueryText.trim() === "") {
      probesSkipped++;
      out.push(cand);
      continue;
    }

    // This candidate is about to issue a real probe — it counts toward the
    // PROBEABLE denominator (see `probeable`), whether the probe resolves or
    // throws. Incremented BEFORE the call so a thrown probe still counts.
    probeable++;
    // The probe result, iff `client.search` resolved this iteration. Undefined
    // means the probe threw (counted toward the fail-fast streak in the catch).
    let hits: SearchHit[] | undefined;
    try {
      hits = await ctx.client.search({
        text: probeQueryText,
        limit: PROBE_LIMIT,
      });
      consecutiveProbeFailures = 0;
    } catch (err) {
      // A transient per-candidate PROBE failure (network blip, 5xx) must NEVER
      // abort the whole harvest on its own: the throw would unwind runHarvest
      // and lose every candidate processed before this one (nothing is upserted
      // yet). The gate's invariant is "never silently drop" — so we pass this
      // candidate through UN-annotated (a missed mark, not a lost row) and keep
      // going. The error is logged (visible + greppable, with the candidate
      // key) so a re-run can re-annotate it.
      //
      // A streak of probe failures with no intervening success means the
      // endpoint is down or misconfigured — passing EVERY remaining candidate
      // through would silently disable the gate. So on the Nth consecutive
      // failure we SOFT-disable the gate (latch below) and warn at the end,
      // rather than hard-abort and lose the whole run's work.
      probesFailed++;
      consecutiveProbeFailures++;
      if (consecutiveProbeFailures >= MAX_CONSECUTIVE_PROBE_FAILURES) {
        gateDisabled = true;
      }
      console.error(
        `[rag-dedup] search probe failed for candidate ${cand.canonical_key}; passing through un-annotated:`,
        err,
      );
      out.push(cand);
      continue;
    }

    // ── DETERMINISTIC lexical annotation — OUTSIDE the probe try/catch ──
    // From here the probe has RESOLVED; the remaining lexical work
    // (malformed-hit filtering, bestOverlap containment, annotateOverlap) is
    // pure/deterministic. It is deliberately NOT wrapped in the probe catch: a
    // bug here (e.g. a containment or marker-append regression) is a CODE
    // defect, not a transient endpoint blip, so it must PROPAGATE loudly rather
    // than be silently swallowed as a per-candidate "pass-through" that hides
    // the bug behind a green run. (The probe catch above only ever masked
    // NETWORK failures; masking a deterministic bug was an accident of the
    // shared try.)

    // A malformed endpoint payload (a hit whose `content` is not a string) must
    // not unwind the batch: skip the bad hit with a warn naming the candidate
    // key, and keep evaluating the remaining VALID hits — a valid overlapping
    // hit in the same array still marks.
    const malformed = hits.filter((h) => typeof h.content !== "string");
    if (malformed.length > 0) {
      console.warn(
        `[rag-dedup] malformed search hit — skipping ${malformed.length} hit(s) with non-string content for candidate ${cand.canonical_key}`,
      );
    }
    const usableHits = hits.filter((h) => typeof h.content === "string");

    // LEXICAL PRE-FILTER (fast path): a verbatim/near-verbatim hit is a
    // byte-level duplicate — the STRONGEST possible overlap. It short-circuits
    // the (expensive) embedding round-trip, but it must NOT be mark-only: §6.2
    // and the module header state the gate DISTILLS-TO-DELTA on EITHER kind of
    // overlap. Route it through the SAME distill-to-delta / floor seam the
    // semantic path uses (applyDistillDelta) so a verbatim corpus duplicate with
    // nothing net-new is FLOORED approvable=false — not left fully approvable
    // while a WEAKER semantic paraphrase gets floored. The lexical hit ALREADY
    // confirmed the overlap, so we distill directly against it WITHOUT
    // re-embedding / re-vector-searching (the fast-path win is preserved). When
    // distillDelta is NOT wired, degrade to the mark-only lexical fallback.
    const match = bestOverlap(candTokens, usableHits);
    if (match && match.overlap >= minOverlap) {
      out.push(await resolveLexicalVerbatim(cand, match.hit, ctx));
      continue;
    }

    // SEMANTIC RETRIEVAL: the candidate survived the lexical pre-filter (no
    // verbatim hit). If the semantic seams are wired, embed it and query the
    // corpus by vector cosine — this catches PARAPHRASE and CJK overlap the
    // lexical containment oracle misses. When the seams are NOT wired the gate
    // degrades to the lexical mark-only fallback (pass through unchanged here).
    if (!ctx.embed || !ctx.vectorSearch || !ctx.distillDelta) {
      out.push(cand);
      continue;
    }

    const resolved = await resolveSemantic(cand, ctx);
    if (resolved.semanticFailed) semanticFailed++;
    if (resolved.semanticProbed) {
      semanticProbed++;
      if (resolved.zeroHits) semanticZeroHits++;
    }
    out.push(resolved.candidate);
  }

  // Run-level probe telemetry + soft-disable warning. `probeable` counts the
  // candidates that actually ISSUED a probe (cleared the token floor, had
  // non-empty probe text, and were reached before any soft-disable) — the
  // denominator the "N/M probes failed" ratio is about. Emitted once so a run's
  // dedup coverage is always visible,
  // including for a ≤MAX_CONSECUTIVE_PROBE_FAILURES-candidate run that can never
  // trip the streak (the metric is the only disabled-gate signal there).
  // Emit whenever ANY lexical probe failed/skipped OR the semantic layer
  // engaged at all (semanticProbed>0) OR a semantic failure occurred. Including
  // `semanticProbed>0` is finding 2's fix: a healthy all-CJK / all-semantic run
  // (no lexical probes, no failures) previously left probesFailed=probesSkipped=
  // semanticFailed=0 and emitted NO coverage line, so its dedup coverage was
  // invisible. `semanticProbed` is the semantic-side denominator (candidates
  // that reached the layer without throwing).
  if (
    probesFailed > 0 ||
    probesSkipped > 0 ||
    semanticFailed > 0 ||
    semanticProbed > 0
  ) {
    console.warn(
      `[rag-dedup] run-level probe metric: probesFailed=${probesFailed} ` +
        `probesSkipped=${probesSkipped} semanticFailed=${semanticFailed} ` +
        `semanticProbed=${semanticProbed} semanticZeroHits=${semanticZeroHits} of ` +
        `${cands.length} candidate(s)`,
    );
  }
  // SEMANTIC silent-degrade (finding 1): the semantic layer engaged for one or
  // more candidates but vectorSearch returned ZERO usable hits for EVERY one of
  // them (empty/misconfigured index that never throws). That is zero effective
  // semantic dedup masquerading as a clean run — the semantic parallel of the
  // lexical probe-failure fail-fast. Warn loudly so "never silently disabled"
  // holds for the semantic path too. Gated on semanticProbed>0 so a run that
  // never engaged the semantic layer does not false-positive.
  if (semanticProbed > 0 && semanticZeroHits === semanticProbed) {
    console.warn(
      `[rag-dedup] semantic dedup degraded: vectorSearch returned 0 hits for ` +
        `all ${semanticProbed} semantically-probed candidate(s) — the vector ` +
        `index is likely empty or misconfigured, so semantic dedup was a no-op ` +
        `for this run. Verify the corpus vector index and re-run.`,
    );
  }
  if (gateDisabled) {
    // Ratio over the PROBEABLE denominator (candidates that actually issued a
    // probe), NOT cands.length — a batch padded with sub-token-floor or
    // soft-disabled candidates that never probed must not dilute the ratio.
    console.warn(
      `[rag-dedup] dedup gate disabled: ${probesFailed}/${probeable} probes failed — ` +
        `endpoint down or misconfigured (url/auth); remaining candidates passed through ` +
        `un-annotated. Re-point/re-run the harvest to re-annotate.`,
    );
  }
  return out;
}

// Run the SEMANTIC layer for one candidate: embed (truncated to the model's
// input budget), vector-retrieve, and on overlap distill-to-delta / annotate.
// PRECONDITION: the caller has verified all three semantic seams are wired
// (embed/vectorSearch/distillDelta). Reached from BOTH the main flow (lexical
// pre-filter survivor) AND the sub-token-floor CJK route (finding 1) — the
// lexical tokenizer yields an empty set for CJK, so those candidates carry
// real content the language-agnostic embeddings can still place.
//
// The seams are NETWORK/LLM calls (embed → /v1/embeddings, distillDelta →
// /v1/chat/completions, vectorSearch → DB), so a transient failure THERE must
// still pass the candidate through un-annotated rather than unwind the harvest
// — kept in its own try. A semantic failure is NOT a probe failure: it does
// not touch the consecutive-probe streak. Returns the resolved candidate (a
// fresh annotated object on overlap, or the original on no-overlap / failure)
// and whether the semantic layer FAILED (so the caller can count it toward the
// run-level `semanticFailed` metric). NEVER drops.
async function resolveSemantic(
  cand: Candidate,
  ctx: RagDedupContext,
): Promise<{
  candidate: Candidate;
  semanticFailed: boolean;
  // The semantic layer ENGAGED (embed + vectorSearch both resolved without
  // throwing) for this candidate — the semantic-side "probeable" signal.
  // `false` iff a seam threw (semanticFailed). Feeds the run-level coverage
  // metric (finding 2).
  semanticProbed: boolean;
  // Iff `semanticProbed`: vectorSearch returned ZERO rows for this candidate
  // (empty/misconfigured index signal — NOT "hits present but below the cosine
  // threshold"). Feeds the run-level silent-degrade detection (finding 1).
  zeroHits: boolean;
}> {
  // Non-null asserted: the caller guarantees the seams are wired (see the
  // PRECONDITION above). Kept as an explicit local so the calls read cleanly.
  const embed = ctx.embed!;
  const vectorSearch = ctx.vectorSearch!;
  const distillDelta = ctx.distillDelta!;
  try {
    // Truncate to the embedding model's input budget BEFORE embedding: an
    // oversized body 400/413s the model, the catch below would swallow it as a
    // semantic failure, and the LARGEST — most duplication-prone — candidates
    // would silently skip semantic dedup (finding 2). The lexical probe
    // already truncates for the same reason. A leading slice suffices to place
    // the candidate in vector space for the overlap decision.
    const vector = await embed(embedInputText(cand));
    const vectorHits = await vectorSearch(
      vector,
      ctx.vectorProbeLimit ?? VECTOR_PROBE_LIMIT,
    );
    // From here embed + vectorSearch both RESOLVED — the semantic layer engaged
    // for this candidate. `zeroHits` distinguishes an empty/misconfigured index
    // (vectorSearch returned NO rows at all) from a functioning index that
    // simply found nothing similar (rows present, all below the cosine
    // threshold). The former, if it holds for EVERY probed candidate, is the
    // silent-degrade the caller warns on (finding 1).
    const semanticProbed = true;
    const zeroHits = vectorHits.length === 0;
    const minSemanticOverlap =
      ctx.minSemanticOverlap ?? DEFAULT_MIN_SEMANTIC_OVERLAP;
    const overlaps = vectorHits
      .filter(
        (h) =>
          typeof h.content === "string" &&
          typeof h.similarity === "number" &&
          h.similarity >= minSemanticOverlap,
      )
      .sort((a, b) => b.similarity - a.similarity);

    if (overlaps.length === 0) {
      // No semantic corpus overlap — genuinely net-new (or an empty index; the
      // caller distinguishes via `zeroHits`). Pass through.
      return {
        candidate: cand,
        semanticFailed: false,
        semanticProbed,
        zeroHits,
      };
    }

    // SEMANTIC OVERLAP → distill-to-delta. Rewrite content to the net-new
    // part, or floor approvability if nothing net-new remains. Even a
    // no-overlap verdict (the seam disagreeing with the vector oracle that
    // already flagged this candidate) still ANNOTATES the overlap — EVERY
    // resolution annotates it (rank-neutral) so the provenance/evidence trail
    // records the vector-confirmed corpus match — NEVER drops.
    const result = await distillDelta(cand, overlaps);
    return {
      candidate: applyDistillDelta(cand, overlaps, result),
      semanticFailed: false,
      semanticProbed,
      zeroHits,
    };
  } catch (err) {
    // Surface the semantic-layer failure (counted by the caller into the
    // run-level metric) rather than looking like a clean run. NOT a probe
    // failure: it does not touch the consecutive-probe streak. Still never
    // drops — the candidate rides through un-annotated.
    console.error(
      `[rag-dedup] semantic dedup failed for candidate ${cand.canonical_key}; passing through un-annotated:`,
      err,
    );
    // A seam threw, so the layer did NOT successfully engage: not counted as
    // semanticProbed (that is the "resolved without throwing" denominator), and
    // zeroHits is moot. semanticFailed carries the degradation signal instead.
    return {
      candidate: cand,
      semanticFailed: true,
      semanticProbed: false,
      zeroHits: false,
    };
  }
}

// Resolve a LEXICAL verbatim/near-verbatim overlap after the pre-filter matched
// (containment ≥ minOverlap). §6.2 / the module header require DISTILL-TO-DELTA
// on EITHER kind of overlap, so a verbatim corpus duplicate must be resolved the
// SAME way the semantic path resolves one — NOT left mark-only (fully
// approvable). The lexical hit ALREADY confirmed the overlap, so we distill
// against it DIRECTLY, WITHOUT re-embedding / re-vector-searching (the fast-path
// win the pre-filter exists for is preserved).
//
//   - distillDelta wired → convert the lexical SearchHit to the CorpusHit shape
//     the seam + applyDistillDelta consume and route through the SAME
//     distill/floor logic: no-delta ⇒ approvable=false (floored via
//     floorNoDelta), delta ⇒ adopt net-new content, no-overlap ⇒ annotate only.
//   - distillDelta NOT wired → degrade to the lexical mark-only fallback
//     (annotateOverlap), matching the deterministic-transform tests that inject
//     only `client`.
//
// The distill seam is a NETWORK/LLM call, so a transient failure THERE must not
// unwind the harvest — it is caught and the candidate falls back to annotate-only
// (a missed floor, never a lost row). A distill failure here is NOT a probe
// failure: it does not touch the consecutive-probe streak. NEVER drops.
async function resolveLexicalVerbatim(
  cand: Candidate,
  hit: SearchHit,
  ctx: RagDedupContext,
): Promise<Candidate> {
  // No distill seam wired → mark-only lexical fallback (annotate the overlap,
  // leave content/approvability untouched). This is the deterministic-transform
  // path (only `client` injected).
  if (!ctx.distillDelta) {
    return annotateOverlap(cand, hit);
  }

  // The lexical hit IS the confirmed overlap the distill seam subtracts from the
  // candidate. Convert it to the CorpusHit shape distillDelta + applyDistillDelta
  // consume (same attribution fields; `similarity` set to 1 — a verbatim/lexical
  // match is a maximal-confidence overlap, and applyDistillDelta only sorts by it).
  const overlap: CorpusHit = {
    similarity: 1,
    content: typeof hit.content === "string" ? hit.content : "",
    id: hit.id,
    title: hit.title,
    sourceUrl: hit.sourceUrl,
    sourceName: hit.sourceName,
  };
  try {
    const result = await ctx.distillDelta(cand, [overlap]);
    return applyDistillDelta(cand, [overlap], result);
  } catch (err) {
    // A distill blip must not unwind the harvest: fall back to annotate-only
    // (the overlap is still recorded — a missed floor, never a lost row). NOT a
    // probe failure (does not touch the consecutive-probe streak).
    console.error(
      `[rag-dedup] verbatim distill-to-delta failed for candidate ${cand.canonical_key}; annotating overlap only:`,
      err,
    );
    return annotateOverlap(cand, hit);
  }
}

// The text sent to the embedding seam: SAME surface as candidateFullText, but
// truncated to the model's input-char budget (see MAX_EMBED_TEXT_CHARS). A
// large body would otherwise exceed the model's token limit and be swallowed
// as a semantic failure. Distinct from candidateProbeQueryText (the lexical
// probe's ~6 KB URL budget): the embed budget is far larger (~30 KB) because
// there is no URL to blow, only the model's input-token ceiling.
function embedInputText(cand: Candidate): string {
  const full = candidateFullText(cand);
  return full.length > MAX_EMBED_TEXT_CHARS
    ? full.slice(0, MAX_EMBED_TEXT_CHARS)
    : full;
}

// The candidate's FULL indexable surface: distilled title + why/how prose,
// joined (the same surface that would be indexed). This is the text the
// containment denominator is measured over — it is NEVER truncated. Truncating
// it would shrink the candidate token set to a leading slice; if that opening
// slice is corpus boilerplate, a long candidate whose BULK is net-new would be
// mis-marked as a duplicate even though most of it is novel. The token-set
// denominator must reflect the whole candidate, not its first ~2 KB.
function candidateFullText(cand: Candidate): string {
  return `${cand.title}\n${cand.content}`.trim();
}

// The text we send to `client.search` over the wire. SAME surface as
// candidateFullText, but truncated so the probe stays within `GET` query-string
// limits — a large body would otherwise 414/400 and be swallowed by the
// per-candidate try/catch (a silent no-op for the largest candidates), or — for
// non-ASCII corpora — manufacture a 4xx PROBE-failure streak that trips the
// consecutive fail-fast with an "endpoint down" misdiagnosis (see
// MAX_PROBE_TEXT_ENCODED_BYTES). Truncation is therefore TWO-stage: the cheap
// char slice first, then a proportional shrink until the WIRE-encoded length
// (wireEncodedLength — the same URLSearchParams serialization client.search
// produces) fits the byte budget (one pass usually lands it; a mixed-script
// tail may take a second). This function must NEVER throw: it is called
// OUTSIDE the per-candidate try (a throw here would unwind the whole harvest;
// moving the call INSIDE would instead mis-count the throw as a probe failure
// toward the fail-fast streak). So the slice is first sanitized to WELL-FORMED
// UTF-16 — a lone surrogate already embedded mid-string in malformed upstream
// title/content becomes U+FFFD — and cut points stay surrogate-safe (richText
// precedent): a boundary inside an astral pair backs off one unit. A leading
// slice is sufficient to *find* the overlapping corpus passage; the precision
// of the overlap decision is then computed against the FULL candidate text
// (candidateFullText), not this truncated query. Exported for the byte-bound
// test (fragmentIdentity precedent).
export function candidateProbeQueryText(cand: Candidate): string {
  let text = toWellFormedUtf16(
    trimLoneTrailingHighSurrogate(
      candidateFullText(cand).slice(0, MAX_PROBE_TEXT_CHARS),
    ),
  );
  let encodedLength = wireEncodedLength(text);
  while (encodedLength > MAX_PROBE_TEXT_ENCODED_BYTES && text.length > 0) {
    // Proportional backoff: keep the prefix the current encoded-bytes-per-char
    // ratio says will fit. Strictly decreasing (floor of a <1 ratio, capped at
    // length-1), so the loop terminates.
    const next = Math.min(
      text.length - 1,
      Math.floor((text.length * MAX_PROBE_TEXT_ENCODED_BYTES) / encodedLength),
    );
    // Slicing a well-formed string can only create a NEW lone surrogate at the
    // cut boundary — the trim handles it; no re-sanitize needed.
    text = trimLoneTrailingHighSurrogate(text.slice(0, next));
    encodedLength = wireEncodedLength(text);
  }
  return text;
}

// Equivalent of String.prototype.toWellFormed() (ES2024 — the tsconfig lib
// target is ES2022, so the regex form is used instead): replace every LONE
// surrogate — a high surrogate not followed by a low, or a low surrogate not
// preceded by a high — with U+FFFD (the replacement char), leaving valid
// astral pairs intact. Malformed UTF-16 embedded mid-string in upstream
// title/content must never make the probe-text builder throw (see
// candidateProbeQueryText's never-throw contract above).
function toWellFormedUtf16(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "\uFFFD",
  );
}

// Back off one code unit when a slice boundary leaves a lone HIGH surrogate at
// the end (an astral char — emoji in distilled prose — split mid-pair). Same
// precedent as the artifact richText surrogate-safe split: a lone surrogate is
// malformed UTF-16. With toWellFormedUtf16 in the pipeline nothing throws any
// more (belt-and-braces), but a clean trim beats shipping a trailing U+FFFD
// replacement char in the probe text where backing off one unit suffices.
function trimLoneTrailingHighSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

interface OverlapMatch {
  hit: SearchHit;
  overlap: number;
}

// Find the corpus hit with the highest token-containment overlap against the
// candidate. `candTokens` is the FULL candidate token set (see
// candidateFullText) — the caller computes it once and also uses it to gate the
// network probe. Returns undefined when there are no hits or the candidate has
// too few distinct tokens to discriminate true duplication from incidental
// common-word overlap (don't risk a spurious mark).
function bestOverlap(
  candTokens: Set<string>,
  hits: SearchHit[],
): OverlapMatch | undefined {
  if (candTokens.size < MIN_CANDIDATE_TOKENS) return undefined;
  let best: OverlapMatch | undefined;
  for (const hit of hits) {
    const overlap = containment(candTokens, tokenSet(hit.content));
    if (!best || overlap > best.overlap) best = { hit, overlap };
  }
  return best;
}

// Containment of `a` within `b`: fraction of A's distinct tokens that also
// appear in B. This is asymmetric on purpose — a long corpus passage that fully
// contains a short candidate's prose IS verbatim overlap, even though Jaccard
// would be diluted by the corpus passage's extra length.
function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  let shared = 0;
  for (const tok of a) if (b.has(tok)) shared++;
  return shared / a.size;
}

// Normalize to lowercase alphanumeric tokens; drop empties. Cheap, dependency-
// free, and good enough to catch verbatim/near-verbatim re-indexing (the gate
// only needs to separate "basically the same passage" from "different prose").
// Scope limitation: tokens are [a-z0-9] runs, so non-Latin prose (e.g. CJK)
// yields an EMPTY token set and such candidates always skip the gate at the
// MIN_CANDIDATE_TOKENS floor — a missed overlap annotation, never a lost row.
function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0),
  );
}

// MARK a candidate that overlaps already-indexed corpus content. NEVER returns
// undefined — the candidate is always retained, only annotated. Accepts either a
// lexical SearchHit (verbatim pre-filter path) or a semantic CorpusHit (both
// carry the attribution fields overlapRef reads). The delta rewrite that trims
// `content` to its net-new part is layered ON TOP of this mark by
// applyDistillDelta on the semantic path.
function annotateOverlap(
  cand: Candidate,
  hit: Pick<SearchHit, "sourceUrl" | "id" | "title">,
): Candidate {
  // ONE prefixed string serves as BOTH the provenance.validated_against marker
  // and the fused_from evidence ref — greppable, human-legible, and (via the
  // shared RAG_CORPUS_OVERLAP_REF_PREFIX) recognizable by canonicalize's
  // evidenceDepth, which excludes it from ranking so the §6.2 duplication mark
  // is rank-neutral. Using the same string for both keeps the idempotency
  // check below in lockstep with what is actually appended.
  const marker = `${RAG_CORPUS_OVERLAP_REF_PREFIX}${overlapRef(hit)}`;
  const existing = cand.provenance.validated_against;

  // Idempotent re-annotation: a re-run of the gate over an already-annotated
  // candidate must NOT append a duplicate marker/evidence item. If this exact
  // overlap marker is already present in validated_against AND the matching
  // fused_from evidence ref is already recorded, this is a re-annotation no-op
  // — return the candidate unchanged. (Determinism note in the header: "a
  // re-run can only re-annotate"; re-annotation must be a true no-op, not a
  // duplicating append.)
  const markerPresent = markerAlreadyPresent(existing, marker);
  const evidencePresent = cand.evidence.some(
    (e) => e.kind === "fused_from" && e.ref === marker,
  );
  if (markerPresent && evidencePresent) {
    return cand;
  }

  const validated_against = markerPresent
    ? existing
    : existing && existing.length > 0
      ? `${existing}; ${marker}`
      : marker;

  const overlapEvidence: EvidenceItem = { kind: "fused_from", ref: marker };
  const evidence = evidencePresent
    ? cand.evidence
    : [...cand.evidence, overlapEvidence];

  return {
    ...cand,
    provenance: {
      ...cand.provenance,
      validated_against,
    },
    // Append the overlap marker; preserve all pre-existing evidence.
    evidence,
  };
}

// Whether `marker` is already one of the `; `-separated tokens in an existing
// validated_against string. Substring matching would be wrong (one ref could be
// a prefix of another), so we split on the same separator the marker is joined
// with and compare whole tokens.
//
// A `rag-corpus-overlap:<ref>` marker never itself contains the `"; "`
// separator: `ref` is a source URL, a synthetic `corpus#<id>`, or a hit title
// (see overlapRef), and overlapRef SANITIZES the URL/title through
// sanitizeCarrierText (collapsing any `"; "` carrier delimiter to a space)
// before it is folded — mirroring distillation-gate. So a pathological ref (a
// URL with a literal "; " in a query string) can no longer fragment the marker
// across two split segments and defeat this whole-token idempotency check. The
// simple whole-token split is therefore correct, not merely benign.
function markerAlreadyPresent(
  existing: string | undefined,
  marker: string,
): boolean {
  if (!existing) return false;
  return existing.split("; ").some((tok) => tok === marker);
}

// Make a ref string safe to fold into the `"; "`-joined validated_against
// carrier: collapse any run of whitespace-surrounded semicolons — i.e. any
// occurrence of the `"; "` carrier delimiter (or its raw variants `";"` /
// `" ;"` / `" ; "`) — to a single space so the folded marker can never fragment
// on the delimiter. Mirrors distillation-gate's sanitizeCarrierText: BOTH
// modules fold model-/source-authored free text into the SAME `"; "`-joined
// whole-token carrier the S4 validate reader and the idempotency dedup split on,
// so both must sanitize before folding. Without this a pathological ref (e.g. a
// source URL carrying a literal "; " in a query string) fragments the marker
// across two split segments, defeating markerAlreadyPresent's whole-token
// idempotency check → a re-run appends a duplicate marker/evidence item.
function sanitizeCarrierText(text: string): string {
  return text.replace(/\s*;\s*/g, " ").trim();
}

// A stable reference string for an overlapping corpus hit, used in both the
// provenance note and the fused_from evidence ref. Prefer the source URL, then
// a synthetic id, then the title — always something, never empty. Accepts either
// a lexical SearchHit or a semantic CorpusHit (both carry the same attribution
// fields). The chosen ref is SANITIZED of the `"; "` carrier delimiter before
// return (see sanitizeCarrierText) so it stays ONE whole carrier token when
// annotateOverlap folds it into validated_against.
function overlapRef(
  hit: Pick<SearchHit, "sourceUrl" | "id" | "title">,
): string {
  if (hit.sourceUrl) return sanitizeCarrierText(hit.sourceUrl);
  if (hit.id !== undefined) return `corpus#${hit.id}`;
  if (hit.title) return sanitizeCarrierText(hit.title);
  return "corpus";
}

// Resolve a SEMANTIC overlap (Theme B fix (c)) after distill-to-delta. This is
// only reached because the VECTOR oracle already flagged the candidate as a
// corpus overlap (cosine ≥ the semantic threshold at the call site) — that is
// the ONLY reason distillDelta was invoked. So EVERY branch ANNOTATES the
// overlap against the best (highest-similarity) hit — the same rank-neutral
// marker/evidence the lexical path stamps — honoring the module header's "every
// overlapping candidate is ANNOTATED" guarantee. Then it applies the delta
// verdict:
//   - delta      → adopt the rewritten net-new `content`; still approvable.
//                  A DEGENERATE delta whose content is empty/whitespace is NOT
//                  a real rewrite — adopting it would blank the candidate's
//                  content AND leave it approvable with nothing to seed. Such a
//                  delta is treated as no-delta (below): content untouched,
//                  approvable=false. (The OpenAI seam already coerces an
//                  empty-content delta to no-delta, but the seam is injectable,
//                  so this floor guards the gate against ANY seam that returns a
//                  degenerate delta.)
//   - no-delta   → floor `approvable=false` (a corpus duplicate with nothing
//                  net-new is not worth re-seeding), NEVER dropped.
//   - no-overlap → the distill seam DISAGREED with the vector oracle and judged
//                  the hits non-overlapping after all. The vector oracle already
//                  positively flagged this candidate as a corpus overlap, so we
//                  do NOT silently pass it through un-annotated (that would
//                  violate the every-overlap-is-annotated guarantee — a
//                  candidate the semantic layer identified as a match would
//                  leave no provenance trail). Instead ANNOTATE it (rank-neutral)
//                  but leave content and approvability untouched — the delta seam
//                  declined to trim it, so it is not floored like no-delta.
// The input candidate is never mutated in place — a fresh object is returned.
function applyDistillDelta(
  cand: Candidate,
  overlaps: CorpusHit[],
  result: DistillDeltaResult,
): Candidate {
  // Annotate against the strongest overlapping passage (overlaps is sorted
  // desc by similarity at the call site). This runs for EVERY verdict — the
  // vector oracle already confirmed the overlap, so the annotation is owed even
  // when the distill seam returns no-overlap.
  const annotated = annotateOverlap(cand, overlaps[0]);

  if (result.kind === "no-overlap") {
    // The distill seam disagreed with the vector oracle, but the vector overlap
    // is real (cosine ≥ threshold) — record it. Content/approvability are left
    // untouched: the seam declined to trim, so this is NOT the no-delta floor.
    // But if a PRIOR run floored this candidate no-delta, its stale
    // RAG_NO_DELTA_MARKER must be stripped from BOTH carriers — otherwise
    // validate.ts:promoteValidation would keep flooring approvable=false forever
    // even though this verdict is NOT the floor (mirrors distillation-gate's
    // stripRestatementMarker on every non-restatement verdict flip).
    return stripNoDeltaFloor(annotated);
  }

  // A real delta carries net-new prose. A delta whose content is
  // empty/whitespace is degenerate — adopting it would overwrite the
  // candidate's content with nothing while leaving it approvable. Fall through
  // to the no-delta floor: keep the original content, mark approvable=false.
  if (result.kind === "delta" && result.content.trim() !== "") {
    // Adopt the net-new content AND strip any stale no-delta floor a PRIOR run
    // stamped: this verdict flipped no-delta→delta, so the candidate is once
    // again approvable and must NOT carry the floor marker on either carrier.
    return stripNoDeltaFloor({ ...annotated, content: result.content });
  }

  // no-delta (or a degenerate delta treated as such): floor approvability. The
  // candidate rides through as a non-approvable corpus duplicate with its
  // original content intact — the reviewer decides at ratification.
  //
  // Stamp the DEDICATED no-delta floor marker (RAG_NO_DELTA_MARKER) alongside
  // the generic overlap annotation `annotateOverlap` already added. The overlap
  // annotation is stamped for EVERY verdict (delta included, where the candidate
  // stays approvable), so `approvable=false` + the overlap marker is ambiguous
  // with a delta that merely inherited canonicalize's status-rule floor. The
  // downstream validation gate (validate.ts:promoteValidation) recomputes
  // approvability from the PROMOTED status and would otherwise LIFT this floor
  // when the duplicate's symbols source-verify. The dedicated marker is the
  // unambiguous floor trace it reads to keep a corpus duplicate non-approvable —
  // mirroring how RESTATEMENT_MARKER carries the distillation gate's floor.
  return floorNoDelta(annotated);
}

// Stamp the dedicated RAG_NO_DELTA_MARKER floor trace and floor approvability on
// a no-delta corpus duplicate. Carries the marker BOTH as a `"; "`-joined
// validated_against token and as a `fused_from` evidence ref (the same dual
// idiom RESTATEMENT_MARKER uses and validate.ts reads), and is idempotent: a
// re-run over an already-floored candidate must not append a duplicate marker.
function floorNoDelta(cand: Candidate): Candidate {
  const existing = cand.provenance.validated_against;
  const markerPresent = markerAlreadyPresent(existing, RAG_NO_DELTA_MARKER);
  const evidencePresent = cand.evidence.some(
    (e) => e.kind === "fused_from" && e.ref === RAG_NO_DELTA_MARKER,
  );

  const validated_against = markerPresent
    ? existing
    : existing && existing.length > 0
      ? `${existing}; ${RAG_NO_DELTA_MARKER}`
      : RAG_NO_DELTA_MARKER;

  const floorEvidence: EvidenceItem = {
    kind: "fused_from",
    ref: RAG_NO_DELTA_MARKER,
  };
  const evidence = evidencePresent
    ? cand.evidence
    : [...cand.evidence, floorEvidence];

  return {
    ...cand,
    approvable: false,
    provenance: { ...cand.provenance, validated_against },
    evidence,
  };
}

// Strip a stale RAG_NO_DELTA_MARKER floor trace from BOTH carriers — the
// `"; "`-joined `validated_against` token AND the `fused_from` evidence ref —
// the SAME two carriers `floorNoDelta` stamps and `validate.ts:hasFloorMarker`
// reads. Applied on the NON-no-delta resolution paths in `applyDistillDelta`
// (delta and no-overlap): a PRIOR run may have floored this candidate no-delta,
// but a re-run that flips the verdict must NOT leave the floor marker behind —
// otherwise `promoteValidation` re-floors `approvable=false` PERMANENTLY,
// silently defeating the flip. This mirrors distillation-gate's
// `stripRestatementMarker` for RESTATEMENT_MARKER (the RAG marker just lives on
// two carriers, not one). Idempotent: a candidate with no floor marker is
// returned unchanged. NEVER call on the no-delta path — that verdict OWNS the
// floor and must (re)stamp it via `floorNoDelta`.
function stripNoDeltaFloor(cand: Candidate): Candidate {
  const existing = cand.provenance.validated_against;
  const inValidatedAgainst =
    existing !== undefined &&
    markerAlreadyPresent(existing, RAG_NO_DELTA_MARKER);
  const inEvidence = cand.evidence.some(
    (e) => e.kind === "fused_from" && e.ref === RAG_NO_DELTA_MARKER,
  );

  // Nothing to strip → return the candidate unchanged (idempotent no-op).
  if (!inValidatedAgainst && !inEvidence) {
    return cand;
  }

  const provenance = { ...cand.provenance };
  if (inValidatedAgainst) {
    // Whole-token filter on the SAME `"; "` delimiter the marker is joined with
    // (never a substring — one marker could be a prefix of another).
    const kept = existing!
      .split("; ")
      .filter((tok) => tok.length > 0 && tok !== RAG_NO_DELTA_MARKER);
    const rebuilt = kept.join("; ");
    // `validated_against` is optional: an all-empty result drops the field
    // rather than persist an empty string (keeps the "no carrier" shape
    // canonical, matching distillation-gate's stripValidatedAgainstTokens).
    if (rebuilt) {
      provenance.validated_against = rebuilt;
    } else {
      delete provenance.validated_against;
    }
  }

  const evidence = inEvidence
    ? cand.evidence.filter(
        (e) => !(e.kind === "fused_from" && e.ref === RAG_NO_DELTA_MARKER),
      )
    : cand.evidence;

  return { ...cand, provenance, evidence };
}
