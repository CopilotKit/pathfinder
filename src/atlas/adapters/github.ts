// GitHub PR + issue leaf adapter (Tier-1).
//
// GENERALIZES the proven `extractAtlasPullRequestSeedCandidates`
// (src/webhooks/atlas.ts) into the batch-harvest contract. A GitHub unit (one
// merged PR, or one issue) becomes ONE richer `CandidateFragment`:
//
//   - a DISTILLED-claim title (the PR/issue substance — never the raw
//     `PR #N: <title>` webhook prefix; that prefix is webhook-only, see B2/M1),
//   - body → why/how `content` prose with boilerplate stripped
//     (`distillBodyToContent`),
//   - a kind-discriminated `EvidenceItem[]` fused from changed files
//     (`changed_file`), linked issues (`linked_issue`), and review threads
//     (`thread`),
//   - the richer `ProvenanceSchema` provenance (source/url/commit) carrying a
//     first-pass classification.
//
// THE NARROW SHARED SURFACE (B2): the ONLY code shared with the webhook path is
// the body→content assembly helper `buildGitHubSeedContent`. The webhook calls
// it with its RAW body so its output stays BYTE-UNCHANGED (raw title, the
// `[{ type: "pull_request", url, title, body }]` evidence, NO classification);
// the batch adapter calls it with a pre-distilled body. The evidence schema and
// the title are NOT shared — those are batch-only enrichments.
//
// This adapter is a PURE function of one unit (no LLM — distillation here is
// deterministic boilerplate-stripping; the episodic adapter (S6) is the only
// LLM-backed adapter).

import type { AdapterContext, LeafAdapter } from "./types.js";
import { sanitizeEnvRefs } from "./sanitize-env-refs.js";
import { scanSensitivity } from "./sensitivity-scan.js";
import { extractValidationTargets } from "./validation-targets.js";
import type { CandidateFragment, Provenance, Sensitivity } from "../types.js";

// ── Unit shapes (assembled by the Tier-1 leaf agent from the GitHub API) ──────
//
// Richer than the raw webhook payload: the leaf agent fetches the changed-file
// list, linked issues, and resolved review threads alongside the PR/issue.

export interface GitHubRepoRef {
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
}

export interface GitHubPullRequestUnit {
  kind: "pull_request";
  sourceName: string;
  repo: GitHubRepoRef;
  pullRequest: {
    number: number;
    title: string;
    body?: string | null;
    htmlUrl: string;
    mergeCommitSha?: string | null;
    baseRef?: string | null;
    headRef?: string | null;
    author?: string | null;
    mergedBy?: string | null;
  };
  changedFiles?: string[];
  linkedIssues?: string[];
  reviewThreads?: string[];
}

export interface GitHubIssueUnit {
  kind: "issue";
  sourceName: string;
  repo: GitHubRepoRef;
  issue: {
    number: number;
    title: string;
    body?: string | null;
    htmlUrl: string;
    author?: string | null;
    state?: string | null;
  };
  linkedIssues?: string[];
  // For an issue these are the issue's COMMENT threads (issues have no PR-style
  // review threads). The field name is shared with GitHubPullRequestUnit so both
  // map through the same `thread` evidence kind; on an issue read it as
  // "comment threads".
  reviewThreads?: string[];
}

export type GitHubPrOrIssueUnit = GitHubPullRequestUnit | GitHubIssueUnit;

// ── THE NARROW SHARED SURFACE (B2) ────────────────────────────────────────────
//
// `buildGitHubSeedContent` is the body→content assembly the webhook already
// performed inline. Extracting it verbatim lets the webhook call it and keep its
// output BYTE-IDENTICAL (it passes the same raw body); the batch adapter reuses
// the same assembly with a pre-distilled body. The line ORDER and labels match
// the historic webhook block exactly so the behavior-equivalence oracle
// (atlas-github-webhook.test.ts) stays green.

export interface GitHubSeedContentParts {
  kindLabel: "PR" | "Issue";
  number: number;
  title: string;
  repoFullName: string;
  baseBranch?: string | null;
  headBranch?: string | null;
  mergeSha?: string | null;
  author?: string | null;
  mergedBy?: string | null;
  url: string;
  // The body text to embed. The webhook passes the RAW body (byte-equivalence)
  // — which can be null, so it relies on `emptyBodyFallback`; the batch adapter
  // passes an already-distilled body (never null) and omits the fallback. When
  // omitted, the shared `EMPTY_BODY_FALLBACK` is used.
  bodyText: string | null;
  emptyBodyFallback?: string;
}

// The WHAT-metadata header block (title line + Repository/branch/commit/author/
// URL facts). Extracted from `buildGitHubSeedContent` as a standalone step so
// the BATCH adapter (A.3) can keep this WHAT-metadata OUT of the seed `content`
// (which must be pure why/how prose the distillation gate judges) while still
// carrying the facts as provenance on the fragment. The WEBHOOK path re-inlines
// it via `buildGitHubSeedContent` below, so its output stays BYTE-IDENTICAL. The
// line ORDER and labels match the historic webhook block exactly.
export function buildGitHubWhatHeader(
  parts: Omit<GitHubSeedContentParts, "bodyText" | "emptyBodyFallback">,
): string {
  return [
    `# ${parts.kindLabel} #${parts.number}: ${parts.title}`,
    "",
    `Repository: ${parts.repoFullName}`,
    // Truthy (not just non-null) so an empty-string base never emits a dangling
    // "Base branch: " line. The webhook always passes a non-empty base, so its
    // output stays byte-identical.
    parts.baseBranch ? `Base branch: ${parts.baseBranch}` : null,
    parts.headBranch ? `Head branch: ${parts.headBranch}` : null,
    parts.mergeSha ? `Merge commit: ${parts.mergeSha}` : null,
    parts.author ? `Author: ${parts.author}` : null,
    parts.mergedBy ? `Merged by: ${parts.mergedBy}` : null,
    `URL: ${parts.url}`,
  ]
    .filter((line): line is string => line != null)
    .join("\n");
}

export function buildGitHubSeedContent(parts: GitHubSeedContentParts): string {
  // The webhook seed content is the WHAT-metadata header, one blank line, then
  // the raw body. Composed from `buildGitHubWhatHeader` so the header assembly
  // has ONE source of truth shared with the batch path (which uses the header
  // for provenance, not content) — the join here reproduces the historic
  // webhook bytes exactly (header + "\n\n" + body).
  return [
    buildGitHubWhatHeader(parts),
    "",
    parts.bodyText ?? parts.emptyBodyFallback ?? EMPTY_BODY_FALLBACK,
  ].join("\n");
}

// ── body → why/how distillation (batch-only refinement) ───────────────────────
//
// Strips HTML comments and conventional PR/issue boilerplate sections (Test
// plan, Checklist, and the CONTRIBUTING acknowledgement line) so the `content`
// is the substantive why/how prose. Deterministic + pure (no LLM). This is used
// by the BATCH adapter only; the webhook keeps its raw body verbatim.

const EMPTY_BODY_FALLBACK = "(No body provided.)";

// Markdown section headings whose entire section (until the next heading) is
// boilerplate to drop.
const BOILERPLATE_HEADINGS = [
  "test plan",
  "checklist",
  "how to test",
  "screenshots",
];

// The CONTRIBUTING acknowledgement is the boilerplate "I have read the
// CONTRIBUTING …" checklist item that PR templates inject. We anchor the drop
// to the acknowledgement SHAPE — a list marker (`-`, `*`, `+`) optionally with
// a `[ ]`/`[x]` task box, an acknowledgement phrase ("I have read", "read
// the", "agree(d) to"), AND the word CONTRIBUTING — so substantive bullets
// that merely contain the word "contributing" (e.g. "- the largest
// contributing factor was the stale cache") are preserved.
const CONTRIBUTING_ACK_LINE =
  /^\s*[-*+]\s*(\[[ xX]\]\s*)?.*\b(i(?:'ve| have)? read|read the|agree(?:d)? to)\b.*\bcontributing\b/i;

export function distillBodyToContent(body: string | null | undefined): string {
  if (body == null) return EMPTY_BODY_FALLBACK;
  // Strip HTML comments (possibly multi-line) first.
  const withoutComments = body.replace(/<!--[\s\S]*?-->/g, "");

  const lines = withoutComments.split("\n");
  const kept: string[] = [];
  let droppingSection = false;
  let inFence = false;
  // Fence parity WITHIN the current dropped boilerplate section. Fences inside
  // a dropped section must not toggle `inFence` (an UNCLOSED fence there would
  // latch `inFence`+`droppingSection` forever and silently lose the rest of
  // the body), but their parity still matters: when a `# …` line INSIDE such a
  // fence is parsed as a heading and ends the drop (the heading-recovery
  // over-keep), the section's fence is still open, so `inFence` must be set
  // true — otherwise the fence's CLOSER toggles `inFence` while the parser is
  // actually outside any fence, inverting parity for the rest of the body and
  // dropping a later real fence's `# comment` content as boilerplate. The
  // parity resets only on a fresh-drop ENTRY (non-dropping → dropping); on a
  // dropped→dropped transition (a boilerplate-named heading inside the
  // section's still-open fence) it must be preserved, for the same reason.
  let inDroppedFence = false;
  // When the outside-section blank-line recovery below ends an OPEN fence early
  // (treating it as possibly unterminated), the parser is deliberately forced
  // back OUTSIDE any fence so heading-parsing — and boilerplate stripping —
  // resumes. But the line-based scan cannot know whether the fence markers that
  // FOLLOW the recovery point are (a) that same fence's real trailing closer
  // (a legitimate block with an internal blank line), or (b) the opener+closer
  // of a later INDEPENDENT fenced block, or (c) nothing at all (truly
  // unterminated). A bare ``` is byte-identical in all three, so it is not
  // disambiguable line-by-line — and an earlier attempt (p3-fix-1) that tried
  // to absorb only the "next" closer inverted parity in case (b): the new
  // block's OPENER got absorbed (no `inFence = true`), so the block's real
  // closer toggled `inFence` true while the parser was outside, and a trailing
  // `## Test plan` was mis-kept.
  //
  // The principled resolution: the RELEVANT downstream consumer of `inFence` is
  // ONLY the heading short-circuit (fence content is kept as literal prose
  // whether or not `inFence` is set, because the outside-fence branch keeps
  // every non-heading line too). Across all three cases the parser ends OUTSIDE
  // a fence once the trailing markers are consumed, and every boilerplate
  // heading of interest appears AFTER those markers. So once a recovery fires,
  // we STAY logically outside for the rest of the body: every subsequent
  // outside-fence ``` is kept as literal content and NEVER re-toggles parity.
  // This satisfies all three cases uniformly (heading-parsing/stripping stays
  // live to EOF, parity never inverts) at the cost of the same documented,
  // accepted heuristic tradeoff — a `#`-shaped line inside a genuine post-
  // recovery fenced block may parse as a heading. That over-keep/over-drop is
  // strictly better than the parity inversion it replaces. The flag is sticky:
  // it arms on recovery and stays armed to EOF.
  let recoveredOutsideFence = false;
  for (const line of lines) {
    // Fenced code blocks are literal content: a `# …` line inside a fence is
    // (e.g.) a shell comment, not a markdown heading, and must neither toggle
    // section dropping nor trip the CONTRIBUTING drop. Fences inside a dropped
    // boilerplate section drop with the section WITHOUT touching `inFence`,
    // tracking parity in `inDroppedFence` instead (see above). The deliberate
    // tradeoff of the heading-recovery itself is over-KEEP: a `# …` heading
    // line inside such a fence ends the drop early and keeps some boilerplate.
    if (/^\s*```/.test(line)) {
      if (droppingSection) {
        inDroppedFence = !inDroppedFence;
        continue;
      }
      // After an outside-section blank-line recovery has fired, stay logically
      // outside a fence for the rest of the body: keep every subsequent
      // outside-fence ``` as literal content WITHOUT toggling parity, so a
      // later boilerplate heading is still parsed and stripped and parity can
      // never invert (see `recoveredOutsideFence`). This uniformly covers a
      // real block's trailing closer, an independent block's opener+closer, and
      // a truly unterminated fence. It only applies while genuinely outside a
      // fence — if a recovery has NOT fired, `recoveredOutsideFence` is false
      // and the normal toggle below runs.
      if (recoveredOutsideFence && !inFence) {
        kept.push(line);
        continue;
      }
      // A genuine fence open/close toggle (no recovery has fired since the last
      // toggle balanced out).
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    if (inFence) {
      // Unterminated-fence recovery for a fence opened OUTSIDE any dropped
      // section. Left latched, `inFence` short-circuits the heading parse below
      // all the way to EOF, so a later boilerplate heading would be silently
      // KEPT (over-keep) and stripping would be disabled for the rest of the
      // body. A markdown fence is a paragraph-level construct, so a BLANK line
      // while such a fence is still open is the recovery boundary (mirroring
      // the dropped-fence recovery below): treat the unterminated fence as
      // ended here so heading parsing — and stripping — resumes for what
      // follows. The deliberate tradeoff is the same rare over-keep as the
      // dropped case: a real fence that legitimately contains an internal blank
      // line and DOES later close ends early; but keeping stripping alive is
      // the better failure than silently disabling it. This does not touch the
      // dropped-section fence (tracked in `inDroppedFence`) — the s4 case where
      // a fence INSIDE a dropped section drops its content is unaffected.
      if (line.trim() === "") {
        inFence = false;
        // Arm the sticky recovery: for the rest of the body, every outside-
        // fence ``` is kept as literal content without re-toggling parity, so
        // heading-parsing/stripping stays live and parity can never invert —
        // whether this fence later closes, an independent block follows, or the
        // fence is truly unterminated. See the flag's declaration.
        recoveredOutsideFence = true;
      }
      if (!droppingSection) kept.push(line);
      continue;
    }
    // Unterminated-fence recovery. A fence that OPENED inside a dropped
    // boilerplate section and is not closed before EOF would otherwise latch
    // `droppingSection` to the end of the body — silently swallowing any REAL
    // why/how prose that trails the last boilerplate section. A markdown fence
    // is a paragraph-level construct, so a BLANK line while such a fence is
    // still open is our recovery boundary: treat the unterminated fence as
    // ended there and exit the drop, so trailing real prose is retained. The
    // boilerplate section's own content (the fenced lines up to the blank
    // line) is still stripped. The deliberate tradeoff — mirroring the
    // heading-recovery over-keep already documented above — is that a
    // boilerplate fence which legitimately contains an internal blank line and
    // DOES later close would end the drop early; that shape is vanishingly
    // rare in Test-plan/Checklist boilerplate, and losing real trailing prose
    // (content loss) is the worse failure. A blank line while NOT inside a
    // dropped fence keeps dropping (a normal multi-paragraph boilerplate
    // section still runs to its next heading / EOF as before).
    if (inDroppedFence && line.trim() === "") {
      inDroppedFence = false;
      droppingSection = false;
      // Arm the sticky recovery, symmetric with the outside-section branch
      // (L282-290): a fence that OPENED inside this dropped section and is
      // being treated as unterminated here means the parser is now logically
      // OUTSIDE any fence. Left un-armed, a later ``` marker toggles `inFence`
      // true while outside — inverting parity for the rest of the body, which
      // over-keeps a subsequent boilerplate heading and can silently drop real
      // trailing why/how prose to EOF. Arming keeps every post-recovery ``` as
      // literal content without re-toggling parity, so heading-parsing and
      // stripping stay live to EOF. See the flag's declaration.
      recoveredOutsideFence = true;
      kept.push(line);
      continue;
    }
    const heading = parseMarkdownHeading(line);
    if (heading != null) {
      const wasDropping = droppingSection;
      droppingSection = BOILERPLATE_HEADINGS.includes(heading.toLowerCase());
      if (droppingSection) {
        // A new boilerplate drop starts: its fence parity starts fresh — but
        // ONLY when ENTERING the drop from a non-dropping state. On a
        // dropped→dropped transition (a boilerplate-named `# …` shell comment
        // inside the section's still-open fence) the parity must be KEPT:
        // resetting it would make the section fence's CLOSER toggle parity
        // back to true while the parser is actually outside the fence,
        // inverting `inFence` downstream and dropping a later real fence's
        // `# comment` content as boilerplate.
        if (!wasDropping) inDroppedFence = false;
        continue;
      }
      if (wasDropping && inDroppedFence) {
        // The heading-recovery fired INSIDE a fence that opened in the dropped
        // section: that fence is still open, so repair the parity — its closer
        // now toggles `inFence` back to false correctly.
        inFence = true;
        inDroppedFence = false;
      }
    }
    if (droppingSection) continue;
    // Drop the CONTRIBUTING acknowledgement checklist line wherever it appears,
    // but only when it is the boilerplate checklist item — not any bullet that
    // happens to contain the word "contributing".
    if (CONTRIBUTING_ACK_LINE.test(line)) continue;
    kept.push(line);
  }

  const cleaned = kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length > 0 ? cleaned : EMPTY_BODY_FALLBACK;
}

// Return the heading text if the line is a markdown ATX heading, else null.
function parseMarkdownHeading(line: string): string | null {
  const match = /^#{1,6}\s+(.*)$/.exec(line.trim());
  return match ? match[1].trim() : null;
}

// ── Distilled-claim title (batch-only) ────────────────────────────────────────
//
// The batch title is the claim substance, NOT the raw `PR #N:` / `Issue #N:`
// prefix (that prefix is webhook-only — B2/M1). We use the PR/issue title
// verbatim as the distilled claim; it is already the human-authored one-line
// statement of the change. We deliberately strip any leading `[scope]` /
// conventional-commit `type:` noise so the claim reads as a fact.
// Only the canonical conventional-commit types are stripped, so a
// natural-language "Word: …" title ("Note: explains the why", "Add: x") keeps
// its prefix instead of being mangled.
const CONVENTIONAL_COMMIT_PREFIX =
  /^\s*(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]*\))?:\s+/i;

function distillTitle(rawTitle: string): string {
  return rawTitle
    .replace(/^\s*\[[^\]]*\]\s*/, "") // leading [scope] tag
    .replace(CONVENTIONAL_COMMIT_PREFIX, "") // conventional-commit prefix
    .trim();
}

// A title like `"[wip]"` or `"chore: "` distills to "" (the whole title was a
// scope tag / conventional-commit prefix). An empty title yields a degenerate
// canonical key downstream (`github-pr:<repo>:`), so — like notion.ts, which
// falls back to the original heading — fall back to the trimmed raw title, then
// to a `<kind> #<number>` form when the raw is empty too.
function titleOrFallback(rawTitle: string, fallback: string): string {
  const distilled = distillTitle(rawTitle);
  if (distilled !== "") return distilled;
  const rawTrimmed = rawTitle.trim();
  return rawTrimmed !== "" ? rawTrimmed : fallback;
}

// ── Evidence builder (batch-only, kind-discriminated) ─────────────────────────

// A.3: wrap the lifted WHAT-metadata header block as a provenance evidence
// entry. The EvidenceItem union has no dedicated metadata kind (types.ts is the
// frozen contract), so we carry the block on the free-text `thread` kind — the
// only shape that survives `CandidateFragmentSchema.parse` (extra provenance
// keys are stripped by Zod). This keeps the facts (Repository/branch/commit/
// author/URL) queryable on the fragment after they leave `content`. The
// sensitivity scan iterates `unit.reviewThreads`, NOT fragment evidence, so
// this entry never perturbs the credential/GTM scan.
function whatHeaderEvidence(
  header: string,
): CandidateFragment["evidence"][number] {
  return { kind: "thread", body: header };
}

function buildEvidence(
  changedFiles: string[] | undefined,
  linkedIssues: string[] | undefined,
  reviewThreads: string[] | undefined,
): CandidateFragment["evidence"] {
  const evidence: CandidateFragment["evidence"] = [];
  for (const path of changedFiles ?? []) {
    evidence.push({ kind: "changed_file", path });
  }
  for (const url of linkedIssues ?? []) {
    evidence.push({ kind: "linked_issue", url });
  }
  for (const body of reviewThreads ?? []) {
    evidence.push({ kind: "thread", body });
  }
  return evidence;
}

// ── Cited validation targets for the ISSUE path (files/paths in prose) ────────
//
// A PR carries a structured `changedFiles` list, so its `validationTargets` are
// lifted directly (see extractPullRequest). An ISSUE has no such list — the
// files it concerns are named in prose. A.4: lift the concrete repo-relative
// PATHS + bare code/config filenames the issue cites (across its title +
// distilled body + comment threads) so the validation gate (S14) has something
// to grep on origin/main → source-verified → promotable. An issue that cites NO
// file yields an empty list by design: target-less prose stays unverified and
// falls to the human review page (same non-approvable-as-behavior posture the
// PR path has when it carries no changedFiles). Pure deterministic regex lift —
// no LLM. The lift is FILES-ONLY (issue prose names files, not bare calls) and
// is factored into the shared `validation-targets` module (mirrors the
// sensitivity-scan extraction) so the two file shapes mirror the memory/notion
// siblings and the prose over-capture screen stays consistent across all three:
//   • a repo-relative PATH (a "/"-bearing token ending in a code/config ext),
//     which validate.ts treats as a path oracle (`isPathLike`);
//   • a bare FILENAME with a code/config extension ("vitest.config.ts") — but a
//     bare prose runtime token ("node.js"/"next.js") is screened out as prose.
function extractIssueValidationTargets(text: string): string[] {
  return extractValidationTargets(text, { files: true });
}

// First-pass classification for a GitHub-sourced fact. Merged PRs and issues are
// primary, internal-by-default knowledge; the validate stage (S14) promotes the
// validation_status and the classify stage (S11) normalizes the rest. We anchor
// freshness to the injected clock so the adapter is deterministic under test.
// `sensitivity` comes from the shared credential/GTM scan over title +
// RAW body + verbatim review-thread bodies + linked-issue URLs (see the
// call sites — the RAW body, not the distilled `content`, so a credential in a
// stripped section still escalates) — never hardcoded `internal`, so the
// deterministic DEFAULT_EXCLUSION_RULES layer (sensitivity ≥ proprietary) can
// fire on a leaked credential / customer detail. Batch-side only; the webhook
// path stamps no classification (B2).
function firstPassProvenance(
  url: string,
  commit: string | null,
  now: Date,
  sensitivity: Sensitivity,
): Provenance {
  const asOf = now.toISOString().slice(0, 10);
  return {
    source: "github",
    url,
    commit: commit ?? undefined,
    // Set the top-level provenance.date (matching memory.ts / source-comment.ts).
    // canonicalize.ts reads provenance.date — NOT freshness.as_of — for both
    // recency() and supersedes(); without it a github fragment gets the neutral
    // 0.5 recency and (dateToEpochMs(undefined) = -Infinity) never wins
    // supersession. It carries the same date-only value as freshness.as_of.
    date: asOf,
    classification: {
      sensitivity,
      knowledge_type: "architecture",
      audience: "all-staff",
      validation_status: "unverified",
      confidence: "medium",
      provenance_class: "primary",
      freshness: { as_of: asOf },
    },
  };
}

function extractPullRequest(
  unit: GitHubPullRequestUnit,
  ctx: AdapterContext,
): CandidateFragment {
  const pr = unit.pullRequest;
  // Batch-side branch normalization: trim padded refs and map a
  // whitespace-only ref to null so the shared builder's truthy guards see
  // "no branch" (never a padded string that would emit a dangling label).
  // The webhook path is untouched — it always passes a non-empty base, so
  // buildGitHubSeedContent's output stays byte-identical (B2).
  const baseBranch = pr.baseRef?.trim() || null;
  const headBranch = pr.headRef?.trim() || null;
  // A.3: the batch seed `content` is the DISTILLED why/how body ONLY — the
  // WHAT-metadata header (Repository/branch/commit/author/URL) is NOT injected
  // into content here (the distillation gate S8 judges why-vs-what, and a
  // metadata header would inflate a bare restatement into looking substantive).
  // The header facts are RETAINED as provenance on the fragment via
  // `buildGitHubWhatHeader` below — relocated, not dropped (criterion 4). The
  // webhook path is untouched: it still calls `buildGitHubSeedContent`.
  const content = distillBodyToContent(pr.body);
  const whatHeader = buildGitHubWhatHeader({
    kindLabel: "PR",
    number: pr.number,
    title: pr.title,
    repoFullName: unit.repo.fullName,
    baseBranch,
    headBranch,
    mergeSha: pr.mergeCommitSha ?? null,
    author: pr.author ?? null,
    mergedBy: pr.mergedBy ?? null,
    url: pr.htmlUrl,
  });

  // Shared credential/GTM scan over the RAW body — the full unstripped PR text
  // — NOT the distilled `content`. distillBodyToContent strips whole sections
  // (Test plan / Checklist / How to test / Screenshots) and HTML comments; a
  // credential or customer-identifying detail living ONLY in a stripped section
  // would be REMOVED before the scan saw it and the fragment would classify
  // `internal`, dodging DEFAULT_EXCLUSION_RULES and leaking. memory.ts scans the
  // raw body and notion.ts scans raw section bodies — this path matches them.
  // The scan also covers the raw title and the verbatim reviewThread bodies +
  // linkedIssue URLs that buildEvidence renders into `thread`/`linked_issue`
  // evidence (and onto the approval page) — a credential pasted in a review
  // comment must not dodge the scan. Bare credential MENTIONS escalate too:
  // PR bodies are high-volume third-party text, so the over-flag direction
  // wins (the exclusion stage is the safety net).
  const scanHaystack = [
    pr.body ?? "",
    ...(unit.reviewThreads ?? []),
    ...(unit.linkedIssues ?? []),
  ].join("\n");
  const sensitivity = scanSensitivity(pr.title, "", scanHaystack, {
    bareCredentialMentions: true,
  });

  // §3.3: sanitize the emitted content (and provenance.source) through the
  // shared env-reference pass immediately before returning the fragment, so a
  // machine-local path / session UUID / private ref in the distilled PR body
  // is rewritten to its repo-relative tail / placeholder before it enters the
  // pipeline.
  const provenance = firstPassProvenance(
    pr.htmlUrl,
    pr.mergeCommitSha ?? null,
    ctx.now,
    sensitivity,
  );
  const { content: sanitizedContent, source: sanitizedSource } =
    sanitizeEnvRefs(content, provenance.source);
  provenance.source = sanitizedSource;

  return {
    sourcetype: "github-pr",
    // TRIMMED: the intake guard only trims fullName for its check; the
    // subsystem is a STRUCTURAL canonical-key component
    // (<sourcetype>:<subsystem>:<claim-slug>), so a padded " owner/repo "
    // must never land in the key. The shared builder above keeps the RAW
    // value (its arg shape is webhook byte-equivalence territory, B2).
    subsystem: unit.repo.fullName.trim(),
    source_name: unit.sourceName,
    repo_url: unit.repo.cloneUrl,
    // baseBranch is pre-normalized above (trim → null), so `??` is equivalent
    // to a truthy fallback here: an empty/whitespace-only baseRef arrives as
    // null and falls back to the default branch — and a kept ref is already
    // TRIMMED (a padded " main " would break downstream ref comparisons/
    // checkouts).
    ref: baseBranch ?? unit.repo.defaultBranch,
    title: titleOrFallback(pr.title, `PR #${pr.number}`),
    content: sanitizedContent,
    provenance,
    // A.3: the WHAT-metadata header lifted off `content` is RETAINED here as a
    // provenance evidence entry — the facts (Repository/branch/commit/author/
    // URL) are relocated, not dropped. Prepended so it reads as the fragment's
    // provenance banner ahead of the changed-file / linked-issue / thread
    // evidence.
    evidence: [
      whatHeaderEvidence(whatHeader),
      ...buildEvidence(
        unit.changedFiles,
        unit.linkedIssues,
        unit.reviewThreads,
      ),
    ],
    needsReview: false,
    validationTargets: [...(unit.changedFiles ?? [])],
  };
}

function extractIssue(
  unit: GitHubIssueUnit,
  ctx: AdapterContext,
): CandidateFragment {
  const issue = unit.issue;
  // A.3: batch seed `content` is the DISTILLED why/how body ONLY (no
  // WHAT-metadata header); the header facts are retained as provenance below.
  // See extractPullRequest for the rationale.
  const content = distillBodyToContent(issue.body);
  const whatHeader = buildGitHubWhatHeader({
    kindLabel: "Issue",
    number: issue.number,
    title: issue.title,
    repoFullName: unit.repo.fullName,
    baseBranch: null,
    headBranch: null,
    mergeSha: null,
    author: issue.author ?? null,
    mergedBy: null,
    url: issue.htmlUrl,
  });

  // Shared credential/GTM scan — same rationale and same haystack rule as the
  // PR path: scan the RAW body (never the distilled `content`, which strips
  // Test plan / Checklist / How to test / Screenshots sections and HTML
  // comments), plus the issue's comment threads + linked issues that land in
  // evidence verbatim too.
  const scanHaystack = [
    issue.body ?? "",
    ...(unit.reviewThreads ?? []),
    ...(unit.linkedIssues ?? []),
  ].join("\n");
  const sensitivity = scanSensitivity(issue.title, "", scanHaystack, {
    bareCredentialMentions: true,
  });

  // A.4: lift the files/paths this issue cites in prose (title + distilled body
  // + comment threads) into validationTargets, so the validation gate (S14) has
  // a concrete source-verification target. A target-less issue yields [] — it
  // then stays unverified and human-gated (see the field comment below).
  const validationTargets = extractIssueValidationTargets(
    [issue.title, content, ...(unit.reviewThreads ?? [])].join("\n"),
  );

  // §3.3: sanitize the emitted content (and provenance.source) before return —
  // same rationale as the PR path above.
  const provenance = firstPassProvenance(
    issue.htmlUrl,
    null,
    ctx.now,
    sensitivity,
  );
  const { content: sanitizedContent, source: sanitizedSource } =
    sanitizeEnvRefs(content, provenance.source);
  provenance.source = sanitizedSource;

  return {
    sourcetype: "github-issue",
    // TRIMMED for the same canonical-key reason as the PR path; the shared
    // builder keeps the RAW value (B2).
    subsystem: unit.repo.fullName.trim(),
    source_name: unit.sourceName,
    repo_url: unit.repo.cloneUrl,
    ref: unit.repo.defaultBranch,
    title: titleOrFallback(issue.title, `Issue #${issue.number}`),
    content: sanitizedContent,
    provenance,
    // A.3: WHAT-metadata header retained as a provenance evidence entry (see
    // extractPullRequest).
    evidence: [
      whatHeaderEvidence(whatHeader),
      ...buildEvidence(undefined, unit.linkedIssues, unit.reviewThreads),
    ],
    needsReview: false,
    // A.4: unlike a PR (which carries a structured `changedFiles` list), an
    // issue's files live in prose — lifted above via
    // `extractIssueValidationTargets`. An issue that cites NO file keeps an
    // empty list: the validation gate (S14) then has nothing to grep and can
    // never promote it — non-approvable-as-behavior BY DESIGN until a human adds
    // targets. Same posture notion.ts documents at its emission site.
    validationTargets,
  };
}

// ── The adapter ───────────────────────────────────────────────────────────────

export const githubAdapter: LeafAdapter<GitHubPrOrIssueUnit> = {
  // PRs and issues share one adapter; the fragment's own `sourcetype` field
  // distinguishes `github-pr` from `github-issue` per unit. The registry
  // (`buildLeafAdapterRegistry` in src/atlas/harvest-cli.ts) registers this
  // adapter object under BOTH keys; the declared `sourcetype` here is the PR
  // one (the dominant GitHub unit) per the LeafAdapter contract.
  sourcetype: "github-pr",
  async extract(
    unit: GitHubPrOrIssueUnit,
    ctx: AdapterContext,
  ): Promise<CandidateFragment[]> {
    // `repo.fullName` is the fragment's `subsystem` — a STRUCTURAL
    // canonical-key component (<sourcetype>:<subsystem>:<claim-slug>) — on
    // BOTH the PR and issue paths. The schema's z.string() admits blanks
    // silently (only ':' fails loud via the refine), so a blank value would
    // flow into a degenerate `github-pr::<slug>` key far downstream, away
    // from the identifiable producer. Fail loud at intake instead (mirrors
    // the notion/showcase intake guards).
    if (unit.repo.fullName.trim() === "") {
      const what =
        unit.kind === "pull_request"
          ? `PR #${unit.pullRequest.number} (${unit.pullRequest.htmlUrl})`
          : `issue #${unit.issue.number} (${unit.issue.htmlUrl})`;
      throw new Error(
        `[atlas/adapters/github] repo.fullName is empty/blank for ${what} — ` +
          `every GitHub unit must carry a non-empty repo.fullName.`,
      );
    }

    if (unit.kind === "pull_request") {
      return [extractPullRequest(unit, ctx)];
    }
    return [extractIssue(unit, ctx)];
  },
};
