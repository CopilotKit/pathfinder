// Atlas distillation gate (Theme A.1) — the WHY-vs-WHAT core.
//
// Runs BETWEEN canonicalize and rag-dedup. For each candidate the gate asks the
// LLM judge one question: is this a distilled why/how claim, a salvageable claim
// that merely NEEDS rewriting into why/how prose, or a pure WHAT restatement of
// already-obvious metadata? The verdict is one of the `DistillationVerdict`
// discriminants (from types.ts):
//
//   - distilled    → PASS unchanged (already a why/how claim).
//   - rewritten    → the judge returned a why/how rewrite; we swap in the new
//                    title/content and stamp a `distilled-from-restatement:`
//                    provenance marker so the salvage is auditable. Still PASSES.
//   - restatement  → a pure WHAT restatement carrying no NEW verifiable claim.
//                    We stamp `RESTATEMENT_MARKER` (the S1 shared literal) onto a
//                    carrier S4's validate gate reads, so the downstream
//                    approvability recompute floors it at `approvable=false`.
//
// NEVER-DROP: the output array is the SAME LENGTH as the input, in the same
// order, and every input candidate is preserved (a restatement is marked
// non-approvable, never removed). The input candidates are never mutated — each
// returned candidate is a fresh object (structural spread), matching the
// pure-transform discipline of canonicalize/validate.
//
// A cheap DETERMINISTIC pre-filter strips the GitHub WHAT-metadata header block
// (the `# Kind #N: title` line + `Key: value` facts the batch adapter lifts to
// provenance — S3 keeps it OFF `content`, but this is a belt-and-suspenders
// safety net) from the text handed to the judge, so the model judges pure
// why/how prose rather than being fooled into rating a bare restatement
// "substantive" by the metadata scaffolding riding along with it.

import type { Candidate, DistillationVerdict, KnowledgeType } from "./types.js";
import { RESTATEMENT_MARKER } from "./types.js";

// The provenance marker stamped on a SALVAGED candidate (verdict `rewritten`):
// the gate replaced a pure-WHAT title/content with the judge's why/how rewrite,
// and this token records that the current prose is a distillation of an original
// restatement — an audit breadcrumb, NOT the approvability floor (that is
// RESTATEMENT_MARKER, reserved for the un-salvageable `restatement` verdict).
export const REWRITTEN_FROM_RESTATEMENT_MARKER = "distilled-from-restatement";

// What the judge sees for one candidate. Kept structural (title/content +
// knowledge_type) — the same narrow shape the llm.ts seam's `judgeDistillation`
// consumes — so the gate can hand a Candidate straight through after the
// deterministic pre-filter.
export interface DistillationJudge {
  judge(
    c: Pick<Candidate, "title" | "content"> & { knowledge_type: KnowledgeType },
  ): Promise<DistillationVerdict>;
}

// Context handed to the gate: the LLM-backed judge seam. A struct (not a bare
// function) so the harvest driver can widen it later without changing the call
// signature, mirroring RagDedupContext / ValidationContext.
export interface DistillationGateContext {
  judge: DistillationJudge;
}

// The GitHub WHAT-metadata header line: `# PR #N: title` or `# Issue #N: title`
// (the ONLY two `kindLabel`s buildGitHubWhatHeader emits — see
// adapters/github.ts). Anchored to those exact labels + `#<number>:` so a
// legitimate human heading like `# Design decision #3: why…` is NOT mistaken for
// the metadata header and stripped from the judge's input. (A prior form —
// `/^#\s+\S.*#\d+:/` — matched ANY `# …#N:` heading, over-eagerly eating real
// human `#` headings that happen to contain `#<digits>:`.)
const GITHUB_HEADING_RE = /^#\s+(?:PR|Issue)\s+#\d+:/;
const GITHUB_FACT_LABEL_RE =
  /^(?:Repository|Base branch|Head branch|Merge commit|Author|Merged by|URL):\s/;

// Deterministic pre-filter (safety net for S3): strip a LEADING GitHub
// WHAT-metadata header block — the `# Kind #N: title` heading and the contiguous
// run of `Key: value` fact lines that follow it, up to the first blank line —
// from `content`, returning the substantive why/how prose that follows. If no
// such header is present (the normal batch-adapter case, where S3 already keeps
// the header off `content`), the content is returned unchanged. Pure; no I/O.
export function stripGitHubMetadataHeader(content: string): string {
  const lines = content.split("\n");
  if (lines.length === 0 || !GITHUB_HEADING_RE.test(lines[0] ?? "")) {
    return content;
  }
  // Walk past the heading and any immediately-following fact/blank lines until
  // the first line that is neither a metadata fact nor blank — that is where the
  // why/how prose begins.
  let i = 1;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || GITHUB_FACT_LABEL_RE.test(line)) {
      i += 1;
      continue;
    }
    break;
  }
  return lines.slice(i).join("\n").trimStart();
}

// The `"; "` carrier delimiter. `validated_against` is a `"; "`-joined WHOLE-token
// list, and S4's validate gate reads it by splitting on this exact sequence and
// matching a whole token. Any free text folded INTO a token must therefore be
// delimiter-safe — a literal `"; "` inside a token would fragment it across two
// split segments and defeat the whole-token contract (both the validate read and
// the idempotency dedup below).
const VALIDATED_AGAINST_DELIMITER = "; ";

// Make a model-authored free-text breadcrumb (e.g. the `rewritten` verdict's
// `reason`) safe to fold into a `validated_against` token: collapse any run of
// whitespace-surrounded semicolons — i.e. any occurrence of the `"; "` carrier
// delimiter (or its raw variants like `";"` / `" ;"` / `" ; "`) — to a single
// space so the token can never fragment on the delimiter. Keeps the RESTATEMENT
// whole-token contract validate.ts reads intact.
function sanitizeCarrierText(text: string): string {
  return text.replace(/\s*;\s*/g, " ").trim();
}

// Append `token` to the `"; "`-joined `provenance.validated_against` token list
// — the SAME carrier idiom the rag-dedup overlap gate uses and S4's validate
// gate reads (splitting on `"; "` and matching a WHOLE token). Idempotent under
// a caller-supplied `isDuplicate` predicate: if any existing token satisfies it
// the new token is not appended. Empty segments (from a malformed carrier with
// leading/trailing/adjacent delimiters) are filtered so they never accrue across
// re-runs — mirroring rag-dedup's guarded whole-token split. Returns a fresh
// provenance object; the input is never mutated.
//
// `isDuplicate` defaults to whole-token equality — the exact contract S4's
// validate reader uses for RESTATEMENT_MARKER (`tok === marker`). The `rewritten`
// breadcrumb path overrides it with a STABLE class-prefix predicate (see below)
// so the model-authored, NON-DETERMINISTIC reason payload cannot defeat the
// dedup and grow the carrier unbounded across re-runs.
function withValidatedAgainstToken(
  c: Candidate,
  token: string,
  isDuplicate: (existingToken: string) => boolean = (t) => t === token,
): Candidate["provenance"] {
  const existing = c.provenance.validated_against;
  const tokens = existing
    ? existing.split(VALIDATED_AGAINST_DELIMITER).filter((t) => t.length > 0)
    : [];
  if (tokens.some(isDuplicate)) {
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

// Strip every WHOLE-token in `validated_against` that satisfies `shouldDrop`,
// returning a fresh provenance object (input never mutated). Splits on the SAME
// `"; "` carrier delimiter and matches whole tokens (never a substring), and
// filters empty segments so a malformed carrier never accrues empties across
// re-runs — mirroring `withValidatedAgainstToken`'s guarded whole-token split.
// Idempotent: a candidate with nothing to drop is returned unchanged (same object
// when the carrier is already byte-identical). The two verdict-flip cleanups —
// `stripRestatementMarker` (every non-restatement verdict) and
// `stripRewrittenBreadcrumb` (the restatement verdict) — are the SAME whole-token
// filter over different predicates, so both share this one place and can never
// drift on delimiter/empty-segment handling.
function stripValidatedAgainstTokens(
  c: Candidate,
  shouldDrop: (token: string) => boolean,
): Candidate["provenance"] {
  const existing = c.provenance.validated_against;
  if (!existing) {
    return c.provenance;
  }
  const kept = existing
    .split(VALIDATED_AGAINST_DELIMITER)
    .filter((t) => t.length > 0 && !shouldDrop(t));
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

// Strip any pre-existing `RESTATEMENT_MARKER` WHOLE-token from a candidate's
// `provenance.validated_against`. Applied UNIFORMLY on EVERY NON-restatement
// verdict (distilled AND rewritten AND any future non-restatement verdict): a
// candidate a PRIOR run ruled a `restatement` carries the S4-read floor marker,
// but on a re-run that flips it to any non-restatement verdict the marker is
// stale — leaving it in place would let validate.ts's `hasRestatementMarker` keep
// flooring `approvable=false` forever and silently defeat the flip. Stripping it
// in ONE place for ALL non-restatement verdicts means no verdict-flip path can
// leave a stale floor (the per-branch fix that missed `distilled` cannot recur).
// NEVER call on the `restatement` path — that verdict must (re)stamp the marker.
function stripRestatementMarker(c: Candidate): Candidate["provenance"] {
  return stripValidatedAgainstTokens(c, (t) => t === RESTATEMENT_MARKER);
}

// Strip any pre-existing `rewritten`-salvage breadcrumb (the bare
// `distilled-from-restatement` token OR any `distilled-from-restatement:<reason>`
// variant of the same class) from a candidate's `provenance.validated_against`.
// Applied ONLY on the `restatement` verdict path: a candidate a PRIOR run ruled
// `rewritten` carries the salvage breadcrumb (plus the judge's why/how title +
// content), but on a re-run that flips it to `restatement` that breadcrumb is a
// contradictory audit record — it would sit alongside the NEW floor marker and
// falsely claim the current (restated) prose is a distillation of a restatement.
// Removing it keeps the provenance internally consistent: a restatement carries
// the floor marker and NO salvage breadcrumb. (The stale salvaged title/content
// is cleaned separately on the restatement path — see enforceDistillation.)
function stripRewrittenBreadcrumb(c: Candidate): Candidate["provenance"] {
  return stripValidatedAgainstTokens(
    c,
    (t) =>
      t === REWRITTEN_FROM_RESTATEMENT_MARKER ||
      t.startsWith(`${REWRITTEN_FROM_RESTATEMENT_MARKER}:`),
  );
}

// Build the `rewritten`-salvage breadcrumb token and its STABLE idempotency
// predicate. The dedup keys on the FIXED class prefix `distilled-from-restatement`
// — NEVER on the model-authored `reason`, which is non-deterministic across runs
// and would otherwise let every re-run append a fresh duplicate (unbounded
// provenance growth). The reason is preserved as an audit payload on the token
// ONLY when non-empty; an empty reason yields the bare fixed token (no trailing
// colon). Either way the result is ONE whole `"; "`-safe token, so the carrier
// stays byte-identical across re-runs regardless of the reason text.
function rewrittenBreadcrumb(reason: string): {
  token: string;
  isDuplicate: (existingToken: string) => boolean;
} {
  // Sanitize the model-authored reason so an embedded `"; "` cannot fragment the
  // breadcrumb into fake carrier tokens (keeps it ONE whole token the validate
  // reader and the class-prefix dedup rely on).
  const safeReason = sanitizeCarrierText(reason);
  const token = safeReason
    ? `${REWRITTEN_FROM_RESTATEMENT_MARKER}:${safeReason}`
    : REWRITTEN_FROM_RESTATEMENT_MARKER;
  // Match the bare fixed token OR any prior reason-bearing variant of the same
  // class — stable regardless of what reason text a re-run's judge returns.
  const isDuplicate = (existingToken: string): boolean =>
    existingToken === REWRITTEN_FROM_RESTATEMENT_MARKER ||
    existingToken.startsWith(`${REWRITTEN_FROM_RESTATEMENT_MARKER}:`);
  return { token, isDuplicate };
}

// Enforce the distillation gate over a candidate set. NEVER drops; same-length,
// same-order output; input never mutated. Each candidate is judged after the
// deterministic pre-filter strips any GitHub WHAT-metadata header, then routed by
// verdict:
//   - distilled   → passed through with any stale RESTATEMENT_MARKER stripped.
//   - rewritten   → title/content swapped for the judge's why/how rewrite; a
//                   `distilled-from-restatement[:<reason>]` provenance marker
//                   records the salvage (reason payload omitted when empty).
//                   Deduped on the fixed class prefix so re-runs stay idempotent.
//                   Still approvable downstream.
//   - restatement → RESTATEMENT_MARKER stamped onto provenance.validated_against
//                   (the carrier S4 reads) so validate floors approvable=false.
//
// VERDICT-FLIP HYGIENE (structural, not per-branch): a re-run can flip a
// candidate's verdict, and the carrier from the PRIOR run must never contradict
// the NEW verdict. EVERY non-restatement verdict strips any stale
// RESTATEMENT_MARKER (so a restatement→distilled OR restatement→rewritten flip
// can't leave a floor that pins approvable=false forever); the restatement
// verdict strips any stale `distilled-from-restatement` salvage breadcrumb (so a
// rewritten→restatement flip can't leave a breadcrumb claiming the restated prose
// is a salvage). Both are the SAME whole-token filter (stripValidatedAgainstTokens)
// over different predicates, so no flip path can leave contradictory provenance.
export async function enforceDistillation(
  cands: Candidate[],
  ctx: DistillationGateContext,
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const c of cands) {
    const verdict = await ctx.judge.judge({
      title: c.title,
      content: stripGitHubMetadataHeader(c.content),
      knowledge_type: c.provenance.classification.knowledge_type,
    });

    if (verdict.kind !== "restatement") {
      // EVERY non-restatement verdict (distilled, rewritten, and any future one)
      // FIRST strips any pre-existing RESTATEMENT_MARKER a PRIOR run's `restatement`
      // verdict left on the carrier. Doing this UNIFORMLY in one place — rather
      // than per-branch — means no verdict-flip path (restatement→distilled OR
      // restatement→rewritten) can leave a stale floor marker that would make
      // validate.ts's `hasRestatementMarker` keep flooring `approvable=false`
      // forever. The `restatement` path below is the ONLY one that (re)stamps it.
      const stripped: Candidate = {
        ...c,
        provenance: stripRestatementMarker(c),
      };

      if (verdict.kind === "distilled") {
        // Already a why/how claim — pass through with only the stale floor marker
        // (if any) stripped; a fresh object so the input is never handed on by
        // reference.
        out.push(stripped);
        continue;
      }

      // rewritten: salvageable. Adopt the judge's why/how rewrite and record the
      // salvage as a provenance breadcrumb (NOT the approvability floor). The
      // breadcrumb is deduped on the STABLE `distilled-from-restatement` class
      // prefix — never on the non-deterministic reason — so re-runs stay
      // idempotent (one marker, no unbounded growth) regardless of what reason
      // text the judge returns.
      const { token, isDuplicate } = rewrittenBreadcrumb(verdict.reason);
      out.push({
        ...stripped,
        title: verdict.title,
        content: verdict.content,
        provenance: withValidatedAgainstToken(stripped, token, isDuplicate),
      });
      continue;
    }

    // restatement: no NEW verifiable claim. Stamp the S4-read floor marker; the
    // candidate is NOT dropped (it renders as a non-checkable note downstream).
    //
    // FIRST strip any stale `rewritten`-salvage breadcrumb a PRIOR run left on the
    // carrier: on a re-run that flips rewritten→restatement the salvage breadcrumb
    // is contradictory — it would sit alongside the NEW floor marker and falsely
    // claim the current prose is a distillation of a restatement. Cleaning it
    // keeps the provenance internally consistent (a restatement carries the floor
    // marker and NO salvage breadcrumb), mirroring the non-restatement paths'
    // stale-marker cleanup so no verdict-flip leaves contradictory provenance.
    const cleaned: Candidate = {
      ...c,
      provenance: stripRewrittenBreadcrumb(c),
    };
    out.push({
      ...cleaned,
      provenance: withValidatedAgainstToken(cleaned, RESTATEMENT_MARKER),
    });
  }
  return out;
}
