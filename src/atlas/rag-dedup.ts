// RAG-corpus dedup gate — spec §6.2 / §10 bar 6 ("zero RAG-duplication").
//
// The harvest produces Atlas seed candidates that ride the SAME indexed corpus
// the generic RAG already serves. If a candidate's prose is verbatim (or
// near-verbatim) already-indexed content, re-seeding it adds duplication, not
// knowledge. This gate probes the live `GET /api/search` RAG endpoint (via
// `AtlasHttpClient.search`, the same probe the human-facing search uses) for
// each candidate and, on overlap above a similarity threshold, MARKS it as a
// known overlap — it annotates `provenance.validated_against` and appends a
// `fused_from` evidence item pointing at the overlapping corpus passage. Both
// carry the RAG_CORPUS_OVERLAP_REF_PREFIX so canonicalize's evidenceDepth can
// exclude the mark from ranking — the annotation is rank-NEUTRAL (a corpus
// duplicate must never OUTRANK its un-duplicated twin; §6.2).
//
// This is a MARK-ONLY gate (spec §6.2 / §10: "on RAG-corpus overlap, distill OR
// mark — NEVER silently drop"). Marking fully satisfies the bar. The optional
// LLM delta-rewrite (rewrite `content` down to only the net-new part the corpus
// does NOT already cover) is DEFERRED — it is an additive enhancement layered on
// top of the same mark, not a prerequisite.
//
// It NEVER silently drops a candidate (spec §6.2): a missed or over-eager
// overlap can only ever annotate prose, never lose a row. The returned array
// therefore always has the same length as the input. Ranking/drop decisions
// stay the human reviewer's call at ratification time.
//
// Determinism note: the search probe is non-deterministic across runs, but the
// downstream upsert is idempotent pending-only (§5), and because we never drop,
// a re-run can only re-annotate — it cannot lose work.
//
// Open item: `GET /api/search` is NOT an existing live route on the server
// today — the runtime probe target is a plan open item, to be wired/confirmed
// before the first live harvest run (see client.ts / S20).

import type { AtlasHttpClient, SearchHit } from "../atlas/client.js";
import { RAG_CORPUS_OVERLAP_REF_PREFIX } from "../atlas/canonicalize.js";
import type { Candidate, EvidenceItem } from "../atlas/types.js";

export interface RagDedupContext {
  // The live RAG-corpus probe. Only `.search({ text, source?, limit? })` is
  // used. (Spec §4.6 leaves room for an MCP search fn; the AtlasHttpClient
  // surface is the concrete wiring the S18 driver injects.) Typed as the
  // `search`-only slice so the driver can pass its client without a widening
  // cast and tests can inject a `search`-only stub.
  client: Pick<AtlasHttpClient, "search">;
  // Similarity in [0,1] at/above which a corpus hit counts as verbatim/near-
  // verbatim overlap. Defaults to DEFAULT_MIN_OVERLAP (verbatim-ish).
  minOverlap?: number;
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
// protection against a missing/misrouted `/api/search` route (see the header
// open item). Exported for the byte-bound test.
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

// Fail-fast bound on CONSECUTIVE probe failures. A single transient blip must
// never abort the batch (per-candidate catch below), but N failures in a row —
// with no intervening success — means the endpoint is down or misconfigured
// (url/auth), and silently passing EVERY remaining candidate through
// un-annotated would disable the dedup gate for the whole run while looking
// like success. Better to abort loudly so the run is re-pointed/re-run. A
// successful probe resets the streak.
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
  for (const cand of cands) {
    // The token set we measure containment against — the FULL candidate body,
    // never the truncated probe slice. Computed once, up front, so it can both
    // gate the (expensive) network probe and feed `bestOverlap`'s denominator.
    const candTokens = tokenSet(candidateFullText(cand));

    // Efficiency short-circuit: a candidate with too few distinct tokens can
    // never clear the containment gate (`bestOverlap` discards it below the
    // MIN_CANDIDATE_TOKENS floor — too few tokens to discriminate true
    // duplication from incidental common-word overlap). Skip the network probe
    // entirely and pass it through un-annotated rather than pay an HTTP
    // round-trip only to discard the result. (Still NEVER drops — mark-only.)
    if (candTokens.size < MIN_CANDIDATE_TOKENS) {
      out.push(cand);
      continue;
    }

    // The query text sent over the network is truncated (URL-length safety);
    // the containment denominator above is NOT — see candidateProbeQueryText.
    const probeQueryText = candidateProbeQueryText(cand);
    // Set iff the probe itself resolved this iteration — distinguishes a probe
    // failure (counts toward the fail-fast streak) from a post-probe failure
    // (pass-through only) inside the shared catch below.
    let hits: SearchHit[] | undefined;
    try {
      hits = await ctx.client.search({
        text: probeQueryText,
        limit: PROBE_LIMIT,
      });
      consecutiveProbeFailures = 0;

      // A malformed endpoint payload (a hit whose `content` is not a string)
      // must not unwind the batch either: skip the bad hit with a warn naming
      // the candidate key, and keep evaluating the remaining VALID hits — a
      // valid overlapping hit in the same array still marks.
      const malformed = hits.filter((h) => typeof h.content !== "string");
      if (malformed.length > 0) {
        console.warn(
          `[rag-dedup] malformed search hit — skipping ${malformed.length} hit(s) with non-string content for candidate ${cand.canonical_key}`,
        );
      }
      const usableHits = hits.filter((h) => typeof h.content === "string");

      const match = bestOverlap(candTokens, usableHits);
      if (!match || match.overlap < minOverlap) {
        // No verbatim/near-verbatim corpus hit — pass through unchanged.
        out.push(cand);
        continue;
      }
      out.push(annotateOverlap(cand, match.hit));
    } catch (err) {
      // A transient per-candidate failure (network blip, 5xx, or an unexpected
      // overlap/annotation error) must NEVER abort the whole harvest on its
      // own: the throw would unwind runHarvest and lose every candidate
      // processed before this one (nothing is upserted yet). The gate's
      // invariant is "never silently drop" — so on ANY per-candidate failure
      // we pass this candidate through UN-annotated (a missed mark, not a lost
      // row) and keep going. The error is logged (visible + greppable, with
      // the candidate key) so a re-run can re-annotate it.
      //
      // EXCEPT: a streak of probe failures with no intervening success means
      // the endpoint is down or misconfigured — passing everything through
      // would silently disable the gate for the whole run, so fail fast.
      if (hits === undefined) {
        consecutiveProbeFailures++;
        if (consecutiveProbeFailures >= MAX_CONSECUTIVE_PROBE_FAILURES) {
          throw new Error(
            `rag-dedup probe failed ${MAX_CONSECUTIVE_PROBE_FAILURES} consecutive times — endpoint down or misconfigured (url/auth); aborting rather than silently disabling the dedup gate`,
            { cause: err },
          );
        }
      }
      const stage = hits === undefined ? "search probe" : "overlap annotation";
      console.error(
        `[rag-dedup] ${stage} failed for candidate ${cand.canonical_key}; passing through un-annotated:`,
        err,
      );
      out.push(cand);
      continue;
    }
  }
  return out;
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
function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0),
  );
}

// MARK a candidate that overlaps already-indexed corpus content. NEVER returns
// undefined — the candidate is always retained, only annotated. (The optional
// LLM delta-rewrite that would trim `content` down to its net-new part is
// deferred; this gate only marks.)
function annotateOverlap(cand: Candidate, hit: SearchHit): Candidate {
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
// Assumption: a `rag-corpus-overlap:<ref>` marker does not itself contain the
// `"; "` separator. `ref` is a source URL, a synthetic `corpus#<id>`, or a hit
// title (see overlapRef). A `"; "` inside a ref (e.g. a pathological URL with a
// literal "; " in a query string) would fragment the marker across two split
// segments and defeat this idempotency check — at worst causing a duplicate
// marker to be appended on a re-run, never a lost row (the gate is mark-only).
// The probability is low and the failure mode is benign, so we keep the simple
// whole-token split rather than a delimiter-safe encoding.
function markerAlreadyPresent(
  existing: string | undefined,
  marker: string,
): boolean {
  if (!existing) return false;
  return existing.split("; ").some((tok) => tok === marker);
}

// A stable reference string for the overlapping corpus hit, used in both the
// provenance note and the fused_from evidence ref. Prefer the source URL, then
// a synthetic id, then the title — always something, never empty.
function overlapRef(hit: SearchHit): string {
  if (hit.sourceUrl) return hit.sourceUrl;
  if (hit.id !== undefined) return `corpus#${hit.id}`;
  if (hit.title) return hit.title;
  return "corpus";
}
