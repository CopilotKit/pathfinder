// Atlas audience/relevance gate (corpus-scoping spec §4) — the
// external-builder-vs-internal-ops core.
//
// Runs AFTER enforceDistillation, BEFORE dedupAgainstRagCorpus (wiring is S7).
// For each candidate the gate produces an `AudienceVerdict`:
//
//   - relevant     → PASS unchanged (answers a WHY/HOW/WHAT an external
//                    CopilotKit/Pathfinder builder would genuinely need).
//   - borderline   → set `needsReview=true` so the human gate reviews it
//                    (primarily internal but with some external utility).
//   - internal-ops → stamp INTERNAL_OPS_MARKER (the S0 shared literal, from
//                    types.ts) onto a carrier the shared floor predicate reads,
//                    so the downstream approvability recompute floors it at
//                    `approvable=false`. NEVER dropped.
//
// NEVER-DROP: the output array is the SAME LENGTH as the input, in the same
// order, and every input candidate is preserved (an internal-ops candidate is
// marked non-approvable, never removed). The input candidates are never mutated
// — each returned candidate is a fresh object (structural spread), matching the
// pure-transform discipline of distillation-gate/canonicalize/validate.
//
// A cheap DETERMINISTIC pre-screen (§4.3, fail-restrictive) short-circuits the
// clear-cut cases WITHOUT calling the LLM judge — the SAME "cheap deterministic
// first, LLM second" pattern as exclude.ts's isCredentialRule/containsCredential
// pre-screen and distillation-gate's metadata-header pre-filter. The LLM judge is
// reserved for the genuinely ambiguous middle.

import type { Candidate, KnowledgeType } from "./types.js";
import { INTERNAL_OPS_MARKER } from "./types.js";

// The gate's verdict on a candidate's audience fit. A discriminated union on
// `kind` mirroring DistillationVerdict — the LLM seam in llm.ts (`judgeAudience`),
// this gate module, and any consumer narrow on the SAME `kind` discriminant.
export type AudienceVerdict =
  | { kind: "relevant" }
  | { kind: "borderline"; reason: string }
  | { kind: "internal-ops"; reason: string };

// What the judge sees for one candidate. Kept structural (title/content +
// knowledge_type + subsystem) — the same narrow shape the llm.ts seam consumes —
// so the gate can hand a Candidate straight through after the deterministic
// pre-screen declines to classify it. Mirrors DistillationJudge.
export interface AudienceJudge {
  judge(
    c: Pick<Candidate, "title" | "content"> & {
      knowledge_type: KnowledgeType;
      subsystem: string;
    },
  ): Promise<AudienceVerdict>;
}

// Context handed to the gate: the LLM-backed judge seam. A struct (not a bare
// function) so the harvest driver can widen it later without changing the call
// signature, mirroring DistillationGateContext / RagDedupContext.
export interface AudienceGateContext {
  judge: AudienceJudge;
}

// The `"; "` carrier delimiter. `validated_against` is a `"; "`-joined WHOLE-token
// list, and the S0 shared floor predicate (hasFloorMarker) reads it by splitting
// on this exact sequence and matching a whole token. Kept in lock-step with
// distillation-gate's VALIDATED_AGAINST_DELIMITER and types.ts's hasFloorMarker.
const VALIDATED_AGAINST_DELIMITER = "; ";

// Append `token` to the `"; "`-joined `provenance.validated_against` token list —
// the SAME carrier idiom distillation-gate/rag-dedup use and the S0 floor
// predicate reads (splitting on `"; "` and matching a WHOLE token). Idempotent on
// whole-token equality: if the token is already present it is not re-appended, so
// a re-run keeps the carrier byte-identical. Empty segments (from a malformed
// carrier with leading/trailing/adjacent delimiters) are filtered so they never
// accrue across re-runs. Returns a fresh provenance object; input never mutated.
function withValidatedAgainstToken(
  c: Candidate,
  token: string,
): Candidate["provenance"] {
  const existing = c.provenance.validated_against;
  const tokens = existing
    ? existing.split(VALIDATED_AGAINST_DELIMITER).filter((t) => t.length > 0)
    : [];
  if (tokens.some((t) => t === token)) {
    // Re-run no-op on the token, but still normalize away any empty segments a
    // prior malformed carrier left behind (idempotent, whitespace-safe).
    const normalized = tokens.join(VALIDATED_AGAINST_DELIMITER);
    if (normalized === existing) {
      return c.provenance;
    }
    return { ...c.provenance, validated_against: normalized };
  }
  tokens.push(token);
  return {
    ...c.provenance,
    validated_against: tokens.join(VALIDATED_AGAINST_DELIMITER),
  };
}

// Strip any pre-existing INTERNAL_OPS_MARKER floor marker from a candidate on
// BOTH carrier idioms the S0 floor predicate reads (types.ts `hasFloorMarker`):
// a WHOLE `"; "`-delimited token in `provenance.validated_against`, AND a
// `fused_from` evidence ref whose `ref` is the WHOLE marker. Returns fresh
// `provenance` + `evidence` (input never mutated). The validated_against arm
// splits on the SAME `"; "` carrier delimiter and matches whole tokens (never a
// substring), filtering empty segments so a malformed carrier never accrues
// empties across re-runs; the evidence arm drops only the exact whole-ref
// `fused_from` marker item (never a substring, so co-resident refs survive) —
// both mirroring `hasFloorMarker`'s dual-carrier whole-token/whole-ref match and
// distillation-gate's `stripRestatementMarker`.
//
// VERDICT-FLIP HYGIENE (mirrors distillation-gate): a re-run can flip a candidate
// a PRIOR run scoped to internal-ops (carrying this floor marker) to a NON-
// internal-ops verdict (`relevant` or `borderline`). `processCandidatePipeline`
// runs the whole chain TWICE per harvest — once for `run --upsert` (runHarvest)
// and once for the approval artifact (buildArtifactCandidates) — and both must
// produce identical candidates; a non-deterministic judge flipping the verdict,
// or a carrier already holding the marker, must not leave the candidate floored.
// Leaving a stale marker on EITHER carrier would keep the S0 `isApprovableFloored`
// predicate (which validate + canonicalize both read) flooring `approvable=false`
// forever, silently defeating the flip. Applied UNIFORMLY on EVERY non-internal-
// ops verdict so no verdict-flip path can leave a stale floor. Only the internal-
// ops path (re)stamps the marker. Idempotent: a candidate with no stale marker on
// either carrier is returned with the same object references.
function stripInternalOpsMarker(
  c: Candidate,
): Pick<Candidate, "provenance" | "evidence"> {
  return {
    provenance: stripMarkerFromValidatedAgainst(c),
    evidence: stripMarkerFromEvidence(c),
  };
}

// The `provenance.validated_against` arm of the dual-carrier strip. Returns the
// same provenance object when no stale marker is present (byte-identical carrier).
function stripMarkerFromValidatedAgainst(
  c: Candidate,
): Candidate["provenance"] {
  const existing = c.provenance.validated_against;
  if (!existing) {
    return c.provenance;
  }
  const kept = existing
    .split(VALIDATED_AGAINST_DELIMITER)
    .filter((t) => t.length > 0 && t !== INTERNAL_OPS_MARKER);
  const rebuilt = kept.join(VALIDATED_AGAINST_DELIMITER);
  if (rebuilt === existing) {
    return c.provenance;
  }
  // `validated_against` is `.optional()`: an all-empty result must drop the field
  // rather than persist an empty string, keeping the "no carrier" shape canonical.
  const provenance = { ...c.provenance };
  if (rebuilt) {
    provenance.validated_against = rebuilt;
  } else {
    delete provenance.validated_against;
  }
  return provenance;
}

// The `fused_from` evidence-ref arm of the dual-carrier strip. Drops ONLY the
// exact whole-ref `fused_from` INTERNAL_OPS_MARKER item (matching hasFloorMarker's
// whole-ref semantics), leaving every other evidence item — including unrelated
// `fused_from` refs — intact. Returns the same array when no stale marker item is
// present so an untouched candidate keeps its evidence reference.
function stripMarkerFromEvidence(c: Candidate): Candidate["evidence"] {
  const hasStaleMarker = c.evidence.some(
    (e) => e.kind === "fused_from" && e.ref === INTERNAL_OPS_MARKER,
  );
  if (!hasStaleMarker) {
    return c.evidence;
  }
  return c.evidence.filter(
    (e) => !(e.kind === "fused_from" && e.ref === INTERNAL_OPS_MARKER),
  );
}

// ── Deterministic pre-screen (§4.3, fail-restrictive) ─────────────────────────

// Clear internal-ops: an infra subsystem slug. Whole-string match on a leading
// infra family so `railway-web` matches but a hypothetical `not-railway` does not
// (`\b` word-boundary anchored to the START of the slug).
const INFRA_SUBSYSTEM_RE = /^(?:railway|ci|deploy|pr-closeout)-/;

// Clear internal-ops: Railway/CI/deploy platform + action vocabulary in the body
// (only consulted when knowledge_type === "operational"). Two arms: a hosting
// platform name, and a deploy/PR-closeout action phrase.
const DEPLOY_PLATFORM_RE = /\b(?:railway|vercel|render|up\.railway\.app)\b/i;
const DEPLOY_ACTION_RE = /\b(?:redeployed|promoted to|merged PR #\d+)\b/i;

// Clear relevant: knowledge types that are inherently external-builder-facing
// (architecture, design rationale, root cause, protocol, security) — the
// complement of the internal-ops-leaning operational/process families.
const CLEAR_RELEVANT_KNOWLEDGE_TYPES: ReadonlySet<KnowledgeType> =
  new Set<KnowledgeType>([
    "architecture",
    "design-rationale",
    "root-cause",
    "protocol",
    "security",
  ]);

// A product-portable specific an external builder can look up, call, or configure
// (§3.2 discriminator). Because a clear-relevant match SHORT-CIRCUITS the gate and
// SKIPS the fail-restrictive judge, every arm must match ONLY a genuine specific —
// never ordinary prose. Each arm is scoped so an incidental token in internal-ops
// narrative (a "503 candidates" count, an "orchestrator (see …)" parenthetical)
// does NOT force the bypass:
//
//   1. HTTP-method endpoint — a REST verb immediately followed by a slash-rooted
//      path (`POST /admin/reindex`). Verb + path together, not either alone.
//   2. HTTP status code IN GENUINE HTTP CONTEXT — a 4xx/5xx code only when a
//      real HTTP status marker sits adjacent, so a bare "503 candidates" count
//      (or the incidental prose words "code"/"error"/"status" near a number) is
//      NOT matched. A marker is either an HTTP RESPONSE VERB (returns/returned/
//      responds/responded/HTTP) OR the two-word status NOUN PHRASE ("status
//      code" / "error code" / "HTTP status") — never a bare "code"/"error"/
//      "status" on its own (finding 4 floor escape: those bare words matched
//      ordinary internal-ops prose like "during code review we saw 503
//      candidates" and forced the clear-relevant bypass). Checked in both orders
//      ("returns 401", "401 error code").
//   3. Call-shaped API symbol — a plausible identifier immediately followed by
//      `(` with NO intervening space, AND either camelCase/PascalCase (an interior
//      uppercase letter, e.g. `useCoAgent(`, `runHarvest(`) OR wrapped in a
//      backtick/code fence. This rejects prose parentheticals ("orchestrator (see
//      …)" has a space) and bare lowercase call-shaped words ("promote()").
//   4. Config-file key — a `.yaml`/`.yml`/`.json`/`.toml` extension.
//
// Deliberately conservative — it only GRANTS the bypass; anything it does not
// recognize falls through to the judge rather than being force-passed.
const HTTP_ENDPOINT_RE = /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/\S/;
// A genuine HTTP-status marker: an HTTP response VERB, or the two-word status
// NOUN PHRASE. Deliberately EXCLUDES bare "code"/"error"/"status" — those only
// qualify as part of "status code"/"error code"/"HTTP status", never alone (a
// bare word matches incidental prose and would force the bypass; finding 4).
const HTTP_STATUS_VERB = "returns?|returned|respond(?:s|ed)?|HTTP";
const HTTP_STATUS_NOUN = "(?:status|error|HTTP)\\s+code|HTTP\\s+status";
const HTTP_STATUS_IN_CONTEXT_RE = new RegExp(
  // response verb within a short window before a 4xx/5xx code …
  `\\b(?:${HTTP_STATUS_VERB})\\b[^.\\n]{0,24}?\\b[45]\\d{2}\\b` +
    // … or the status noun phrase within a short window before the code …
    `|\\b(?:${HTTP_STATUS_NOUN})\\b[^.\\n]{0,24}?\\b[45]\\d{2}\\b` +
    // … or a 4xx/5xx code immediately followed by the status noun phrase
    //   ("401 error code" / "500 status code").
    `|\\b[45]\\d{2}\\b\\s+(?:${HTTP_STATUS_NOUN})\\b`,
  "i",
);
// A camelCase/PascalCase identifier (has an interior uppercase) glued to `(` with
// no space, OR any backtick-fenced call-shaped identifier.
const CALL_SHAPED_SYMBOL_RE =
  /\b[a-zA-Z_$][\w$]*[A-Z][\w$]*\(|`[a-zA-Z_$][\w$]*\s*\(/;
const CONFIG_KEY_RE = /\.(?:ya?ml|json|toml)\b/;

function hasProductPortableSpecific(content: string): boolean {
  return (
    HTTP_ENDPOINT_RE.test(content) ||
    HTTP_STATUS_IN_CONTEXT_RE.test(content) ||
    CALL_SHAPED_SYMBOL_RE.test(content) ||
    CONFIG_KEY_RE.test(content)
  );
}

// Does the candidate's body/subsystem clear the internal-ops pre-screen?
function isClearInternalOps(
  c: Pick<Candidate, "content"> & {
    knowledge_type: KnowledgeType;
    subsystem: string;
  },
): boolean {
  if (INFRA_SUBSYSTEM_RE.test(c.subsystem)) {
    return true;
  }
  return (
    c.knowledge_type === "operational" &&
    DEPLOY_PLATFORM_RE.test(c.content) &&
    DEPLOY_ACTION_RE.test(c.content)
  );
}

// Does the candidate clear the relevant pre-screen (§4.3)?
function isClearRelevant(
  c: Pick<Candidate, "content"> & { knowledge_type: KnowledgeType },
): boolean {
  return (
    CLEAR_RELEVANT_KNOWLEDGE_TYPES.has(c.knowledge_type) &&
    hasProductPortableSpecific(c.content)
  );
}

// Enforce the audience/relevance gate over a candidate set. NEVER drops;
// same-length, same-order output; input never mutated. Each candidate is first
// run through the deterministic pre-screen; only the genuinely ambiguous middle
// reaches the injected LLM judge. Routed by verdict:
//   - relevant     → passed through unchanged (fresh object).
//   - borderline   → needsReview=true (human gate reviews it).
//   - internal-ops → INTERNAL_OPS_MARKER stamped onto provenance.validated_against
//                    (the carrier the S0 floor predicate reads) so validate floors
//                    approvable=false and canonicalize floors the rank weight.
export async function enforceAudienceRelevance(
  cands: Candidate[],
  ctx: AudienceGateContext,
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const c of cands) {
    const knowledge_type = c.provenance.classification.knowledge_type;
    const screenInput = {
      content: c.content,
      knowledge_type,
      subsystem: c.subsystem,
    };

    // Deterministic pre-screen first (fail-restrictive): clear internal-ops and
    // clear relevant short-circuit WITHOUT the LLM judge. Internal-ops is checked
    // first so a clear infra candidate never leaks through on a coincidental
    // product-portable-specific match.
    let verdict: AudienceVerdict;
    if (isClearInternalOps(screenInput)) {
      verdict = {
        kind: "internal-ops",
        reason: "deterministic pre-screen: infra/deploy",
      };
    } else if (isClearRelevant(screenInput)) {
      verdict = { kind: "relevant" };
    } else {
      verdict = await ctx.judge.judge({
        title: c.title,
        content: c.content,
        knowledge_type,
        subsystem: c.subsystem,
      });
    }

    if (verdict.kind === "relevant") {
      // Already external-builder-relevant — pass through as a fresh object so the
      // input is never handed on by reference. Strip any stale INTERNAL_OPS_MARKER
      // a PRIOR run left on EITHER carrier so a flip to relevant is not
      // stale-floored (dual-carrier: validated_against + fused_from evidence).
      out.push({ ...c, ...stripInternalOpsMarker(c) });
      continue;
    }

    if (verdict.kind === "borderline") {
      // Primarily internal but with some external utility → human review. Does
      // NOT floor approvable — so strip any stale INTERNAL_OPS_MARKER a PRIOR run
      // left on EITHER carrier (a flip from internal-ops to borderline must
      // un-floor on validated_against + fused_from evidence alike).
      out.push({
        ...c,
        ...stripInternalOpsMarker(c),
        needsReview: true,
      });
      continue;
    }

    // internal-ops: zero external-builder utility. Stamp the S0-read floor marker
    // onto the carrier; the candidate is NOT dropped (it renders as a
    // non-approvable note in the review artifact for the audit trail). This is the
    // ONLY path that stamps INTERNAL_OPS_MARKER — every other verdict strips a
    // stale one (verdict-flip hygiene); `withValidatedAgainstToken` is idempotent
    // so a re-run that stays internal-ops keeps the carrier byte-identical.
    out.push({
      ...c,
      provenance: withValidatedAgainstToken(c, INTERNAL_OPS_MARKER),
    });
  }
  return out;
}
