// Atlas source-comment / agent-doc leaf adapter (S8).
//
// Mines a CopilotKit/ag-ui *design-block comment* — the "The Problem / The
// Solution", intentional-coupling rationale that engineers write directly above
// the code it justifies — together with the code region it annotates, and FUSES
// them into ONE **derived** CandidateFragment. The canonical worked example is
// §12.2 of the strategy: the react-core state-render-bridge messageId-binding
// fact, sourced from `use-coagent-state-render-bridge.tsx:24-45`.
//
// "Derived, never a copy" is the contract of this adapter. A design block plus
// its code says something neither says alone — the *intent* behind an otherwise
// non-obvious coupling. So `content` is a DISTILLED why/how claim, not the raw
// comment text echoed back. The decorative section headers ("The Problem", rule
// lines) never survive into the claim. The fragment is `provenance_class:
// "derived"`, `sourcetype: "agent-doc"`, and its `evidence` anchors the file:line
// via a `changed_file` entry and records the comment+code fusion via a
// `fused_from` entry (spec §9.3 / §12.2).
//
// Pure function of one structured unit (the Tier-1 "one unit each" rule, §4); no
// LLM, no I/O. The injected `ctx.now` clock drives every date so the adapter is
// deterministic under test.

import type { CandidateFragment, EvidenceItem } from "../types.js";
import type { AdapterContext, LeafAdapter } from "./types.js";
import { sanitizeEnvRefs } from "./sanitize-env-refs.js";
import { scanSensitivity } from "./sensitivity-scan.js";

// ── Unit shape ────────────────────────────────────────────────────────────────

// One design-block comment + the code region it annotates. The Tier-1 leaf
// fleet builds this from a single source file by slicing the comment block and
// the immediately-following code it justifies. Line anchors are 1-based and
// inclusive; `file:line` is rendered as `<filePath>:<lineStart>-<lineEnd>`.
export interface SourceCommentUnit {
  // Repo-relative path to the file carrying the design block.
  filePath: string;
  // 1-based inclusive line span the comment + annotated code occupy.
  lineStart: number;
  lineEnd: number;
  // The raw design-block comment text (decorative markers stripped or not — the
  // adapter distills regardless).
  commentText: string;
  // The code region the comment annotates (used to extract validation targets
  // and to confirm the comment is load-bearing, not orphaned).
  codeRegion: string;
  // Optional subsystem label (e.g. "cpk-react-core"); defaults to a slug derived
  // from the path when absent.
  subsystem?: string;
  // Optional repo + ref for provenance; default to undefined (the run driver
  // fills repo-wide defaults).
  repoUrl?: string;
  ref?: string;
  // Optional canonical URL to the exact line range (GitHub blob #Lx-Ly).
  sourceUrl?: string;
}

// ── file:line anchor ──────────────────────────────────────────────────────────

function fileLine(unit: SourceCommentUnit): string {
  return `${unit.filePath}:${unit.lineStart}-${unit.lineEnd}`;
}

// ── Distillation (the "derived, never a copy" core) ────────────────────────────

// Strip a design block down to its load-bearing sentences. We drop decorative
// section headers ("The Problem", "The Solution") and their underline rules,
// collapse whitespace, and join the remaining prose. The result is a normalized
// rationale corpus we distill a claim from — it is intentionally NOT identical
// to `commentText` (no headers, no rule lines, single-spaced).
const HEADER_LINE = /^\s*(the\s+problem|the\s+solution|problem|solution)\s*$/i;
const RULE_LINE = /^[\s\-=_*]+$/;

function stripDesignBlock(commentText: string): string {
  const kept: string[] = [];
  for (const raw of commentText.split(/\r?\n/)) {
    // Drop the leading comment marker regardless of style — `//`, `#`, JSDoc
    // `*`, and the `/**` / `*/` fence lines (which strip to empty and are
    // dropped). The unit contract promises marker-agnostic distillation.
    const line = raw.replace(/^\s*(?:\/\/+|\*+\/?|\/\*+|#+)\s?/, "").trimEnd();
    if (line.trim() === "") continue;
    if (HEADER_LINE.test(line)) continue;
    if (RULE_LINE.test(line)) continue;
    kept.push(line.trim());
  }
  return kept.join(" ").replace(/\s+/g, " ").trim();
}

// Split normalized prose into sentences (cheap, good enough for design blocks).
function sentences(prose: string): string[] {
  return prose
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Lower-case the leading letter so a selected sentence can be embedded mid-claim
// after a synthesized lead clause (which is what makes the output a derivation
// rather than an excerpt). Acronym-led sentences are left intact: when the
// leading word is acronym-shaped (2+ consecutive uppercase letters, e.g.
// "API ..."), lowercasing only the first letter would produce garbage
// ("aPI ...").
function decapitalize(s: string): string {
  if (/^[A-Z]{2}/.test(s)) return s;
  return s.length > 0 ? s[0].toLowerCase() + s.slice(1) : s;
}

// FUSE the design-block rationale with the annotated code symbol into a single
// DERIVED claim. This is the heart of "derived, never a copy": the output
// integrates the *code* (the symbol the comment annotates) with the *comment*
// (the rationale), so it states something neither source states alone — exactly
// the §10 bar a derived row must clear. Concretely we (1) select the signal
// sentences (decision → failure mode → intent), (2) wrap them in a synthesized
// frame that names the annotated symbol and asserts the coupling is intentional.
// The synthesized frame guarantees the result is never byte-identical to the
// comment text even when the comment is a single sentence.
function distillClaim(prose: string, symbol: string | undefined): string {
  const all = sentences(prose);
  const base = all.length === 0 ? [prose] : all;

  const intentional = base.filter((s) => /intentional|deliberate/i.test(s));
  const failure = base.filter((s) =>
    /\b(without|otherwise|would|detach|wrong|stale|exhaust|fail|breaks?)\b/i.test(
      s,
    ),
  );
  const decision = base.filter((s) =>
    /\b(bind|binds|bound|couple|coupling|coupled|keep|enforces?|capture[ds]?)\b/i.test(
      s,
    ),
  );

  // De-duplicated, capped pick of the load-bearing sentences in priority order.
  const ordered = [...decision, ...failure, ...intentional];
  const seen = new Set<string>();
  const picked: string[] = [];
  for (const s of ordered) {
    if (seen.has(s)) continue;
    seen.add(s);
    picked.push(s);
    if (picked.length >= 3) break;
  }
  const core = (picked.length > 0 ? picked : base.slice(0, 2)).join(" ");

  // Synthesized derivation frame. Naming the symbol fuses code into the claim;
  // the leading clause restates the rationale rather than echoing it. The intent
  // sentence is appended only if the PICKED CORE does not already state it (a
  // source intent sentence evicted by the 3-sentence cap is re-asserted by the
  // frame, never duplicated), so the output carries exactly one "intentional"
  // assertion.
  const subject = symbol ? `\`${symbol}\`` : "this code path";
  const lead = `As implemented in ${subject}, ${decapitalize(core)}`;
  const alreadyIntentional = /intentional|deliberate/i.test(core);
  const tail = alreadyIntentional
    ? ""
    : " This coupling is intentional, not incidental.";
  return `${lead}${/[.!?]$/.test(lead) ? "" : "."}${tail}`.trim();
}

// A short distilled title naming the decision and its subject — a synthesized
// claim, never the raw first comment line. No frame-stripping happens here:
// the title is selected directly from the distilled prose (the first
// decision-verb sentence, falling back to the first sentence).
function distillTitle(prose: string, symbol: string | undefined): string {
  const all = sentences(prose);
  const decision =
    all.find((s) =>
      /\b(bind|binds|bound|couple|coupling|coupled|keep|enforces?)\b/i.test(s),
    ) ??
    all[0] ??
    prose;
  const subject = symbol ? `${symbol}: ` : "";
  const trimmed = decision.replace(/[.;:]\s*$/, "");
  const titled = `${subject}${trimmed}`;
  if (titled.length <= 120) return titled;
  return `${titled.slice(0, 117).trimEnd()}...`;
}

// ── Validation targets (symbols validate.ts can grep on origin/main) ────────────

// Pull declared symbol names out of the annotated code region so the validation
// gate (S14) can grep the real checkout for them → source-verified. Matches
// function/const/class/export declarations; falls back to [] when none found.
const DECL_RE =
  /\b(?:export\s+)?(?:async\s+)?(?:function|const|let|class|interface|type)\s+([A-Za-z_$][\w$]*)/g;

function extractValidationTargets(codeRegion: string): string[] {
  const out = new Set<string>();
  for (const m of codeRegion.matchAll(DECL_RE)) {
    if (m[1]) out.add(m[1]);
  }
  return [...out];
}

// ── Subsystem fallback ──────────────────────────────────────────────────────────

// Derive a subsystem slug from the path when the unit omits one (e.g.
// "packages/react-core/..." → "react-core"). Kept deterministic and dependency
// free; the run driver normally supplies an explicit subsystem.
function subsystemFor(unit: SourceCommentUnit): string {
  // Return the TRIMMED value, not the raw one — subsystem is a STRUCTURAL
  // canonical-key component (<sourcetype>:<subsystem>:<claim-slug>), and a
  // padded " cpk-react-core " would mint a padded canonical key downstream.
  const subsystem = unit.subsystem?.trim();
  if (subsystem) return subsystem;
  const m = unit.filePath.match(/packages\/([^/]+)\//);
  if (m && m[1]) return m[1];
  const segs = unit.filePath.split("/").filter(Boolean);
  return segs.length > 1 ? segs[segs.length - 2] : "source";
}

// ── Adapter ──────────────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// re_verify_by: design rationale is durable but code drifts; re-verify in 3
// months (matches the §12.2 worked row: as_of 2026-06-08 → re_verify_by
// 2026-09-08).
function reVerifyBy(now: Date): string {
  // Compute the target year/month, then clamp the day to the last valid day of
  // that month. A naive `setUTCMonth(+3)` overflows for end-of-month dates
  // (e.g. 2026-11-30 → 2027-03-02, silently SKIPPING February) because the
  // 30th doesn't exist in the target month. Clamping keeps "+3 months" from
  // ever skipping a month.
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 3;
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  // Day 0 of (targetMonth + 1) is the last day of targetMonth.
  const lastDay = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0),
  ).getUTCDate();
  const day = Math.min(now.getUTCDate(), lastDay);
  return isoDate(new Date(Date.UTC(targetYear, targetMonth, day)));
}

export const sourceCommentAdapter: LeafAdapter<SourceCommentUnit> = {
  sourcetype: "agent-doc",

  async extract(
    unit: SourceCommentUnit,
    ctx: AdapterContext,
  ): Promise<CandidateFragment[]> {
    const anchor = fileLine(unit);
    const prose = stripDesignBlock(unit.commentText);
    // An orphaned comment (no load-bearing prose after stripping decorative
    // headers/rules) yields a malformed claim ("As implemented in `x`, ."), so
    // emit nothing rather than a degraded fragment.
    if (prose === "") {
      return [];
    }
    const validationTargets = extractValidationTargets(unit.codeRegion);
    // The primary annotated symbol fuses code into the distilled claim.
    const primarySymbol = validationTargets[0];
    const content = distillClaim(prose, primarySymbol);
    const title = distillTitle(prose, primarySymbol);
    const subsystem = subsystemFor(unit);
    const asOf = isoDate(ctx.now);

    // Shared credential/GTM first-pass scan over everything the fragment can
    // carry: the distilled title, the raw comment, AND the annotated code
    // region — the likeliest credential carrier in the fleet, and this is the
    // only adapter that self-stamps `source-verified`/`high`, so an
    // under-flagged leak here would rank HIGHEST in the review queue. Bare
    // credential MENTIONS stay OFF (default options — a judged call): code
    // regions routinely NAME `apiKey`/`token` identifiers, and bare-mention
    // escalation over code would flag a large fraction of honest fragments
    // and drown the queue. Credential-VALUE signals (assignment-shaped, PEM)
    // still fire; the exclusion stage (S13) remains the safety net.
    const sensitivity = scanSensitivity(
      title,
      unit.commentText,
      unit.codeRegion,
    );

    // Evidence anchors the fact at the file:line (changed_file) AND records that
    // it was FUSED from the comment+code at that anchor (fused_from). The
    // changed_file path DELIBERATELY carries the `:start-end` anchor suffix —
    // unlike github.ts, which emits bare repo paths for actually-changed files.
    // It is provenance DISPLAY only (the schema in types.ts and the artifact
    // render in notion-blocks.ts are the sole consumers); nothing treats it as
    // a bare filesystem path. The
    // fused_from ref is file:line based so the provenance is traceable without a
    // canonical key (which is assigned later, in Tier-3).
    const evidence: EvidenceItem[] = [
      { kind: "changed_file", path: anchor },
      { kind: "fused_from", ref: `source-comment:${anchor}` },
    ];

    // §3.3: sanitize the emitted content (and provenance.source) through the
    // shared env-reference pass immediately before returning the fragment, so a
    // machine-local path / session UUID / private ref that survived into the
    // distilled claim is rewritten before it enters the pipeline. (The
    // file:line anchor on `validated_against` is repo-relative by contract and
    // is not touched here.)
    const { content: sanitizedContent, source: sanitizedSource } =
      sanitizeEnvRefs(content, "source-comment");

    const fragment: CandidateFragment = {
      sourcetype: "agent-doc",
      subsystem,
      source_name: "source-comment",
      repo_url: unit.repoUrl,
      ref: unit.ref,
      title,
      content: sanitizedContent,
      provenance: {
        source: sanitizedSource,
        url: unit.sourceUrl,
        date: asOf,
        validated_against: anchor,
        classification: {
          // From the shared scan above — never hardcoded `internal`, so the
          // deterministic DEFAULT_EXCLUSION_RULES layer (sensitivity ≥
          // proprietary) can fire on a leaked credential / customer detail.
          sensitivity,
          knowledge_type: "architecture",
          audience: "engineering",
          // Source-anchored: the comment lives at a real file:line, so the claim
          // is source-verified (not merely unverified).
          // CONTRACT NOTE (self-claimed verification): stamping `source-verified`
          // at intake is a DESIGNED exception to S14-owned promotion — the
          // file:line anchor IS the verification. S14 may promote further via
          // validationTargets (possibly zero of them); validate.ts's STATUS_RANK
          // only promotes UP, never demotes, so it cannot undo this stamp.
          validation_status: "source-verified",
          confidence: "high",
          // FUSED across comment + code → this is a DERIVED fragment.
          provenance_class: "derived",
          freshness: { as_of: asOf, re_verify_by: reVerifyBy(ctx.now) },
        },
      },
      evidence,
      needsReview: false,
      validationTargets,
    };

    return [fragment];
  },
};
