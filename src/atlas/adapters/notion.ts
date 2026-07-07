// Atlas Notion-page leaf adapter (S5).
//
// Maps ONE structured Notion page (`NotionPageUnit`) → zero or more
// `CandidateFragment`s, per the Tier-1 "one unit each" rule (spec §4 / §4.2 / S5):
//
//   • A ratified single-decision page  → ONE fragment.
//   • A multi-decision ADR set (e.g. "Interrupts Proposal — Design Decisions")
//     → SPLIT into N fragments, one per ratified decision section.
//   • A page with NO decision-style headings (or only content-free ones)
//     → ZERO fragments by design: there is no ratified decision to harvest.
//
// The split is DETERMINISTIC — it operates on the page's already-structured
// section headings, so this adapter needs NO LLM (it ignores `ctx.llm`). The
// Tier-1 leaf harness (S19) is responsible for fetching the Notion page and
// shaping it into a `NotionPageUnit` before handing it here.
//
// Sensitivity is a CAREFUL FIRST PASS (spec S5 "sensitivity-careful"): a
// GTM / customer-identifying page is flagged `proprietary` (or `secret` when it
// is customer-identifying — a named-customer mention OR a credential term;
// each alternative ALONE fires, no commercial term required) so the
// downstream DEFAULT_EXCLUSION_RULES (§4.8: "drop sensitivity:proprietary|secret,
// creds, customer-identifying GTM") can exclude it. The shared `scanSensitivity`
// is composed ESCALATE-ONLY on top of the bespoke classifier — it adds the
// credential-VALUE signals (assignments, PEM blocks) the mention-shaped bespoke
// regex cannot see (see `classifyFirstPass`). The adapter never drops a
// fragment itself — it flags, and exclusion happens in the dedicated stage (S13).
//
// `provenance.url` is the Notion page URL; cited PR/issue references in the
// decision body are lifted into `linked_issue` evidence, and the page itself is
// recorded as `thread` evidence. Concrete repo-relative paths and code symbols
// a decision cites are lifted into `validationTargets` so the validation gate
// (S14) can source-verify the claim on origin/main; a decision that cites
// nothing keeps an empty target list and stays human-gated (prose-aware).

import type { AdapterContext, LeafAdapter } from "./types.js";
import { sanitizeEnvRefs } from "./sanitize-env-refs.js";
import { scanSensitivity } from "./sensitivity-scan.js";
import { extractValidationTargets } from "./validation-targets.js";
import { mostRestrictiveSensitivity } from "../types.js";
import type {
  CandidateFragment,
  Confidence,
  KnowledgeType,
  ProvenanceClass,
  Sensitivity,
  ValidationStatus,
} from "../types.js";

// ── NotionPageUnit: the structured page the Tier-1 harness hands the adapter ──

// One section of a Notion page. The `heading` drives the decision-split; the
// `body` is the prose distilled into a fragment's `content`.
export interface NotionPageSection {
  heading: string;
  body: string;
}

// One Notion page, pre-structured (no live Notion API call happens here). A
// page may record a single ratified decision or an ADR set of many; the split
// is driven entirely by the section headings (see `isDecisionHeading`).
export interface NotionPageUnit {
  // Canonical Notion page URL → becomes `provenance.url`.
  url: string;
  // Page title → recorded as `thread` evidence and used for the sensitivity
  // first-pass heuristic.
  title: string;
  // Subsystem/saga this page concerns (e.g. "agui-protocol"). Carried onto
  // every emitted fragment.
  subsystem: string;
  // Optional repo this page's decisions concern (for downstream validation).
  repo_url?: string;
  ref?: string;
  // Optional page date (ISO). Falls back to `ctx.now` when absent.
  date?: string;
  // The page's sections. Decision-bearing sections become fragments.
  sections: NotionPageSection[];
}

const SOURCE_NAME = "notion-doc";

// ── Decision-split rule (deterministic, heading-driven) ───────────────────────

// Context / non-decision heading keywords. A section whose heading reads as
// one of these is page-level CONTEXT only and is NOT split into a decision
// fragment — even when it carries a numeric prefix (e.g. "1. Background"). The
// numbered form must not defeat that intent. Matched against the heading with
// any leading enumerator already stripped (see `isDecisionHeading`). Includes
// the standard ADR template's non-decision sections ("Alternatives
// Considered", "Decision Drivers", "Consequences", "Status", "Open
// Questions", "Risks", "References", "Appendix") — harvesting those as
// ratified decisions is the unsafe over-capture direction (rejected
// alternatives ratified as decisions). This screen runs FIRST, so "Decision
// Drivers" is screened as context before the "decision" keyword test sees it.
const CONTEXT_HEADING =
  /^(background|overview|context|summary|goals?|scope|motivation|introduction|abstract|prior\s+art|non-goals?|alternatives|consequences|status|decision\s+drivers|open\s+questions|risks|references|appendix)\b/i;

// A section is a "decision" section when its heading marks a ratified decision:
//   • contains "decision"/"decisions" (e.g. "Decision: …", "Decisions")
//   • or is an ADR-style entry ("ADR 3: …") or numbered entry ("3. …").
// Non-decision sections (Context / Background / Overview / Summary) are NOT
// split out — they provide page-level context only. The CONTEXT screen runs
// FIRST, against the enumerator-stripped heading, so neither a numeric prefix
// ("1. Background") nor a later keyword mention ("Background on the decision")
// defeats that intent: a heading that READS as context is context.
function isDecisionHeading(heading: string): boolean {
  const h = heading.trim();
  // Strip any leading enumerator ("1. ", "2) ") to inspect the substantive
  // title text — both the context screen and the keyword tests run on it.
  const hasEnumerator = /^\d+[.)]\s+/.test(h);
  const titleText = h.replace(/^\d+[.)]\s+/, "").trim();
  // A bare enumerator with no substantive text ("1. ") is not a decision.
  if (hasEnumerator && titleText === "") return false;
  // CONTEXT screen first: a context-shaped heading ("Background …",
  // "1. Overview") is page context even when it mentions "decision" later.
  if (CONTEXT_HEADING.test(titleText)) return false;
  // Singular AND plural — ADR sets commonly title the section "Decisions".
  if (/\bdecisions?\b/i.test(titleText)) return true;
  if (/^adr\b/i.test(titleText)) return true;
  // Any other numbered entry with substantive text is an ADR-style decision.
  return hasEnumerator;
}

// Strip a leading "Decision[ N]:" / "ADR N:" / "N." enumerator so the heading
// reads as a claim title. (Falls through to the trimmed heading if no marker.)
// The enumerator is stripped FIRST so a combined "1. Decision: Use X" exposes
// its "Decision:" marker to the prefix strips (enumerator-last would leave it).
// Singular AND plural, matching `isDecisionHeading`: a "Decisions: Use X"
// heading splits as a decision, so its marker must strip here too.
function decisionTitleFromHeading(heading: string): string {
  const trimmed = heading.trim();
  const stripped = trimmed
    .replace(/^\d+[.)]\s+/, "")
    .replace(/^decisions?\s*\d*\s*[:\-—]\s*/i, "")
    .replace(/^adr\s*\d*\s*[:\-—]\s*/i, "")
    .trim();
  // A skeleton heading (e.g. "Decision:") strips to "" — an empty title yields
  // a degenerate canonical-key slug downstream, so fall back to the original.
  return stripped === "" ? trimmed : stripped;
}

// ── Cited-reference extraction → linked_issue evidence ────────────────────────

// Pull PR/issue references out of a decision body. Recognizes both bare
// "PR #1746" / "issue #1732" mentions (a pr|pull request|issue keyword is
// REQUIRED — a naked "#123" is NOT matched) and full GitHub URLs.
//
// URL refs are keyed on `repo#number` so two URLs to the SAME number in
// DIFFERENT repos (e.g. ".../pathfinder/pull/42" and ".../showcase/issues/42")
// stay distinct rather than colliding on the bare number. A bare mention
// ("PR #42") genuinely cannot know its repo, so it is collected separately and
// only emitted when NO URL ref already covers that number — i.e. a bare mention
// collapses onto a URL form by number, but two URLs are NEVER merged across
// repos. The URL form wins on collapse (it is the richer representation).
// Output is sorted so fragment output is deterministic.
function extractCitedReferences(body: string): string[] {
  // URL refs keyed on `repo#number` → the full URL (richer display value).
  const urlByRepoNum = new Map<string, string>();
  // Set of numbers that already have a URL form, so bare mentions of the same
  // number de-dupe against the URL (by number alone) without merging repos.
  const numbersWithUrl = new Set<string>();

  // Full GitHub issue/PR URLs.
  const urlRe =
    /https?:\/\/github\.com\/([^\s/]+\/[^\s/]+)\/(?:issues|pull)\/(\d+)/gi;
  for (const m of body.matchAll(urlRe)) {
    const repo = m[1];
    const num = m[2];
    urlByRepoNum.set(`${repo}#${num}`, m[0]);
    numbersWithUrl.add(num);
  }

  // Bare "PR #123" / "issue #123" mentions (keyword required), keyed by number.
  const bareByNum = new Map<string, string>();
  const bareRe = /\b(?:pr|pull request|issue)\s+#(\d+)\b/gi;
  for (const m of body.matchAll(bareRe)) {
    const num = m[1];
    // Only keep the bare form when no richer URL form already covers this
    // number (de-dupe bare against URL by number; never merge two URLs).
    if (!numbersWithUrl.has(num)) {
      bareByNum.set(num, `#${num}`);
    }
  }

  return [...urlByRepoNum.values(), ...bareByNum.values()].sort();
}

// ── Sensitivity / knowledge-type first-pass classifier ────────────────────────

// GTM / commercial signal words. Presence of any → the page is GTM knowledge and
// at least `proprietary`.
// NOTE: "deal" is GTM-QUALIFIED ("deal size"/"deal value"/"the deal"/"deal
// flow") rather than the bare verb, so ordinary architecture prose like "deal
// with downstream errors" does NOT false-positive into gtm/proprietary.
const GTM_SIGNAL =
  /\b(gtm|go-to-market|pricing|revenue|arr|acv|deal\s+size|deal\s+value|deal\s+flow|the\s+deal|contract value|prospect|sales|quota|discount|renewal)\b/i;

// Customer-identifying / credential signals → escalate to `secret`. The regex
// is a plain DISJUNCTION: a named-customer mention alone, an account-name
// mention alone, or a credential term alone fires — no co-occurring commercial
// term is required. That is deliberately the SAFE (over-flag) direction, and
// DEFAULT_EXCLUSION_RULES treats the result as the most restrictive.
// NOTE: the credential alternatives are deliberately CONTEXT-QUALIFIED
// (e.g. "api key", "access token", "secret key") so that a protocol primitive
// like an "opaque resume token" in an architecture decision does NOT false-
// positive into `secret`. EVERY alternative matches its PLURAL too ("named
// customers", "account names", "API keys", "access tokens", "credentials") —
// plural forms are exactly as identifying, and a singular-only match would
// under-flag in the LEAK direction.
const CUSTOMER_IDENTIFYING =
  /\b(customer-identif\w+|named customers?|account names?|api[_ -]?keys?|access[_ -]?tokens?|secret[_ -]?keys?|credentials?)\b/i;

// Architecture signal words → knowledge_type "architecture" rather than the
// "design-rationale" default for a decision page.
const ARCH_SIGNAL =
  /\b(architecture|two-layer|delegation chain|compatibility shim|topology|deployment|infrastructure)\b/i;

interface FirstPassClass {
  sensitivity: Sensitivity;
  knowledge_type: KnowledgeType;
}

// Decide sensitivity + knowledge_type from the PAGE-WIDE haystack (title +
// every section's heading and body — see `extract`).
// CAREFUL first pass: when in doubt about GTM/customer data, over-flag (the
// exclusion stage is the safety net; a missed flag would leak proprietary data).
function classifyFirstPass(haystack: string): FirstPassClass {
  const isGtm = GTM_SIGNAL.test(haystack);
  const isCustomerIdentifying = CUSTOMER_IDENTIFYING.test(haystack);

  // Sensitivity: customer-identifying (a named party OR a credential — the
  // regex is disjunctive) is the most restrictive; plain GTM is proprietary.
  const bespoke: Sensitivity = isCustomerIdentifying
    ? "secret"
    : isGtm
      ? "proprietary"
      : "internal";

  // Compose the SHARED first-pass scan ESCALATE-ONLY (most restrictive of the
  // bespoke result and the shared result). The bespoke CUSTOMER_IDENTIFYING
  // catches credential MENTIONS, but has no credential-VALUE patterns — a raw
  // assignment (`password=…`, `token: <opaque>`) or a PEM private-key block
  // carries the secret itself yet names no keyword the mention regex knows,
  // so without this it would classify `internal` and dodge
  // DEFAULT_EXCLUSION_RULES. Default options (bareCredentialMentions OFF):
  // the bespoke regex already covers mentions; the shared scan adds the
  // VALUE-shaped signals. mostRestrictive means the composition can only
  // ESCALATE — every existing bespoke classification is preserved.
  const sensitivity: Sensitivity = mostRestrictiveSensitivity(
    bespoke,
    scanSensitivity(haystack, "", ""),
  );

  // Knowledge type is decided INDEPENDENTLY of the sensitivity escalation:
  // only a GTM/commercial signal makes the page gtm knowledge. A
  // credential-only hit (e.g. a security/architecture decision discussing API
  // keys) keeps the architecture/design-rationale classification — the secret
  // sensitivity flag alone is what drives downstream exclusion.
  const knowledge_type: KnowledgeType = isGtm
    ? "gtm"
    : ARCH_SIGNAL.test(haystack)
      ? "architecture"
      : "design-rationale";

  return { sensitivity, knowledge_type };
}

// Format an ISO date (YYYY-MM-DD) from a Date — the freshness/as_of convention
// used across the worked §12 rows.
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── Fragment construction ─────────────────────────────────────────────────────

function buildFragment(
  unit: NotionPageUnit,
  section: NotionPageSection,
  // The TRIMMED subsystem (computed once in `extract`, next to the intake
  // guard). Passed explicitly rather than re-read from `unit.subsystem` so a
  // padded value can never leak into the STRUCTURAL canonical-key component.
  subsystem: string,
  pageHaystack: string,
  ctx: AdapterContext,
): CandidateFragment {
  const title = decisionTitleFromHeading(section.heading);

  // Sensitivity/knowledge-type first pass runs against the PAGE-WIDE haystack
  // (built once in `extract`: the page title plus EVERY section's heading and
  // body — including non-decision Background/Context sections, which emit no
  // fragments of their own but are still page content). A GTM / credential
  // signal ANYWHERE on the page flags every one of its decisions — the
  // over-flag direction; the exclusion stage (S13) is the safety net.
  const { sensitivity, knowledge_type } = classifyFirstPass(pageHaystack);

  const asOf = unit.date ?? isoDate(ctx.now);

  // Cited PR/issue references → linked_issue evidence (deterministic order).
  const citedEvidence = extractCitedReferences(section.body).map((url) => ({
    kind: "linked_issue" as const,
    url,
  }));

  // The page itself is recorded as thread evidence (which decision, on which
  // page) so the aggregator can fuse and the reviewer can trace it.
  const threadEvidence = {
    kind: "thread" as const,
    body: `${unit.title} (decision: ${title})`,
  };

  // Cited symbols/paths → validationTargets, so a decision that names a
  // concrete code entity gives the validation gate (S14) something to grep on
  // origin/main → source-verified → promotable. Scanned over the section
  // heading (which BECOMES the persisted title, and often carries the "in
  // src/…" citation) plus the body. A decision that cites NOTHING keeps an
  // empty list: target-less prose stays unverified and falls to the human
  // review page (the strict + prose-aware policy — correct, not a regression).
  // Sorted so fragment output is deterministic (mirrors extractCitedReferences).
  // The shared lift returns first-seen order; notion pins a sorted list.
  const validationTargets = extractValidationTargets(
    `${section.heading}\n${section.body}`,
  ).sort();

  // Notion text is a primary source; `validation_status` stays `unverified`
  // here regardless of targets — the validation gate (S14), not this adapter,
  // is what promotes a fragment once its targets source-verify. A target-less
  // fragment simply has nothing for the gate to grep and remains human-gated.
  // Confidence is high for a ratified decision page.
  const validation_status: ValidationStatus = "unverified";
  const provenance_class: ProvenanceClass = "primary";
  const confidence: Confidence = "high";

  // §3.3: sanitize the emitted content (and provenance.source) through the
  // shared env-reference pass immediately before returning the fragment. The
  // E3 Notion arm rewrites any private notion.so page link in the decision body
  // to `<notion-page-link>` in `content`, while `provenance.url` (the page URL)
  // is DELIBERATELY retained as harvest attribution (spec §3.1-E3).
  const { content: sanitizedContent, source: sanitizedSource } =
    sanitizeEnvRefs(section.body.trim(), SOURCE_NAME);

  return {
    sourcetype: "notion-doc",
    subsystem,
    source_name: SOURCE_NAME,
    ...(unit.repo_url ? { repo_url: unit.repo_url } : {}),
    ...(unit.ref ? { ref: unit.ref } : {}),
    title,
    content: sanitizedContent,
    provenance: {
      source: sanitizedSource,
      url: unit.url,
      date: asOf,
      classification: {
        sensitivity,
        knowledge_type,
        audience: "all-staff",
        validation_status,
        confidence,
        provenance_class,
        freshness: { as_of: asOf },
      },
    },
    evidence: [threadEvidence, ...citedEvidence],
    needsReview: false,
    validationTargets,
  };
}

// ── The adapter ───────────────────────────────────────────────────────────────

// `extract` is a pure function of one `NotionPageUnit`. It selects the page's
// decision sections and emits one fragment per substantive decision (a
// single-decision page yields one). A page with NO decision-style headings —
// or only content-free ones — yields ZERO fragments by design: it carries no
// ratified decision to harvest. No `ctx.llm` use — the split is deterministic.
export const notionAdapter: LeafAdapter<NotionPageUnit> = {
  sourcetype: "notion-doc",
  async extract(
    unit: NotionPageUnit,
    ctx: AdapterContext,
  ): Promise<CandidateFragment[]> {
    // `subsystem` is a STRUCTURAL canonical-key component
    // (<sourcetype>:<subsystem>:<claim-slug>) — an empty/blank value would
    // yield a degenerate key far downstream, away from the identifiable
    // producer. Fail loud at intake instead (mirrors the fail-loud ':'
    // refinement on CandidateFragmentSchema).
    // The trimmed value is also what every emitted fragment carries (see
    // buildFragment) — a padded " auth " must never reach the canonical key.
    const subsystem = unit.subsystem.trim();
    if (subsystem === "") {
      throw new Error(
        `[atlas/adapters/notion] unit.subsystem is empty/blank for page ` +
          `"${unit.title}" (${unit.url}) — every NotionPageUnit must carry a ` +
          `non-empty subsystem.`,
      );
    }

    // A decision section must carry substantive prose: a heading-only section
    // (empty/whitespace body) has no claim content, and emitting it would
    // produce a content-free fragment (every sibling adapter guards this).
    const decisionSections = unit.sections.filter(
      (s) => isDecisionHeading(s.heading) && s.body.trim() !== "",
    );

    // Page-level classification haystack, built ONCE: the page title plus
    // EVERY section's heading and body. Non-decision sections (Background /
    // Context / Overview) emit no fragments, but a GTM/credential signal that
    // lives only there still describes the page — so it must flag every
    // decision the page yields (sensitivity-careful: over-flag when in doubt;
    // the exclusion stage is the safety net).
    const pageHaystack = [
      unit.title,
      ...unit.sections.flatMap((s) => [s.heading, s.body]),
    ].join("\n");

    return decisionSections.map((section) =>
      buildFragment(unit, section, subsystem, pageHaystack, ctx),
    );
  },
};
