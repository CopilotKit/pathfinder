// Bidirectional candidate ⇄ Notion-block mapping for the approval artifact
// (spec §11.1; plan §3/§4.9 / S16). SHARED with the sync slot (S17): generate.ts
// uses the BUILD side (candidate/rule → block-request), and sync.ts uses the
// PARSE side (fetched block-response → checkbox state / exclusion rule).
//
// Why an in-text marker, not block metadata? Notion blocks have no hidden,
// round-trippable property for a `to_do`/`bulleted_list_item`, and the lead
// edits the page by hand (toggling checkboxes, editing/adding rule bullets). So
// the candidate's canonical_key and the exclusion-rule structure are encoded
// INLINE, in the block's rich-text, behind a stable machine marker that survives
// a human round-trip:
//
//   • a candidate to_do  → leading `⟦atlas:<canonical_key>⟧ ` marker, then the
//     distilled title + an inline flag badge; provenance + evidence are rendered
//     as child blocks (callout/paragraph) of the to_do.
//   • an exclusion rule  → a bullet whose text is `atlas-rule: <json>` (the JSON
//     is the canonical ExclusionRule shape), so the lead can add/edit rules in
//     place and the sync slot parses them back losslessly.
//   • an UNVERIFIED behavior fact (approvable=false) → a NON-checkable callout
//     note carrying the same canonical-key marker + title, so the reviewer sees
//     it but cannot approve it (§7 binding gate).
//
// The marker is deliberately ugly/unambiguous so a human-typed line never
// false-positives as a machine record, and a record the human leaves untouched
// parses back byte-for-byte.

import type {
  BlockObjectRequest,
  BlockObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client";
import type { Candidate, Classification } from "../types.js";
import {
  ClassificationSchema,
  Sensitivity,
  KnowledgeType,
  ValidationStatus,
  Confidence,
} from "../types.js";
import type { ExclusionRule } from "../exclude.js";

// A flag rule's `dimension` must be a real key of Classification (the §4.8 flag
// variant is `dimension: keyof Classification`). The SDK does not surface the
// valid keys at runtime, so we derive them from the S0 Zod schema once — used to
// narrow an arbitrary parsed `dimension: string` back to `keyof Classification`
// without a cast. The run-store persists (and Zod-validates) the canonical
// shape, so the only sources of an unvalidated string are hand-edited rule
// bullets and hand-edited manifest files (§11.5).
const CLASSIFICATION_KEYS = new Set(
  Object.keys(ClassificationSchema.shape),
) as Set<keyof Classification>;

function isClassificationKey(value: string): value is keyof Classification {
  return CLASSIFICATION_KEYS.has(value as keyof Classification);
}

// The four badge-round-tripped dimensions a flag rule may target, mapped to
// their S0 enum schemas. A flag rule's `equals` is validated against the
// dimension's ACTUAL enum: an out-of-enum value (a `sensitivity=secrt` typo)
// could never match any row's classification, so accepting it would leave a
// permanently inert rule in the rule-set — re-seeded into EVERY next run's
// artifact (§11.5) — the same can-never-fire rationale that warn-rejects
// `freshness`/`audience`/`provenance_class` in coerceExclusionRule below.
const FLAG_DIMENSION_ENUMS = {
  sensitivity: Sensitivity,
  knowledge_type: KnowledgeType,
  validation_status: ValidationStatus,
  confidence: Confidence,
} as const;

// Notion permits child blocks ONE level deep on a parent block-request; the SDK
// types that depth as a distinct (non-exported) union. Our candidate children
// are only callouts + bullets, which live within that depth, so we capture the
// element type structurally from BlockObjectRequest's own `children` field.
type ChildBlockRequest = NonNullable<
  Extract<BlockObjectRequest, { type?: "callout" }>["callout"]["children"]
>[number];

// ── Markers ───────────────────────────────────────────────────────────────────

// A canonical_key is wrapped `⟦atlas:<key>⟧` at the START of a candidate block's
// text. The brackets are the rarely-typed U+27E6/U+27E7 so a human note never
// collides. Exported so S17 (and the tests) reference the exact same tokens.
export const CANONICAL_KEY_OPEN = "⟦atlas:";
export const CANONICAL_KEY_CLOSE = "⟧";

// An exclusion-rule bullet's text is `atlas-rule: <json>` where <json> is the
// canonical ExclusionRule serialized compactly. A human-added free-form bullet
// without this prefix is simply ignored by the parser. Serialization always
// emits the single-space form; the PARSE side tolerates any (or no) whitespace
// after the colon (`atlas-rule:{…}` is a one-keystroke hand-edit away and must
// not silently demote the rule to prose).
// Case-insensitive: Notion auto-capitalizes the first letter of a typed line,
// so a hand-typed rule arrives as `Atlas-rule: …`. Generation always emits
// lowercase; accepting case variants is strictly more tolerant of hand edits.
const RULE_PREFIX = "atlas-rule: ";
const RULE_PREFIX_RE = /^atlas-rule:\s*/i;

// ── rich-text helpers ──────────────────────────────────────────────────────────

// Notion rejects any single rich-text run whose content exceeds 2000 characters
// (the page create/append 400s). Machine markers and titles stay far below it;
// thread-evidence bodies and long english-rule JSON do not.
const RICH_TEXT_RUN_MAX = 2000;

// Notion also caps a block's rich_text ARRAY at 100 elements — an uncapped
// split of a pathological >200k-char body emits 100+ runs and 400s the WHOLE
// batch request. The split caps at this many runs total, replacing the final
// run with an explicit truncation marker (the round-trip is already lossy past
// Notion's own caps; a marked truncation beats a 400).
const RICH_TEXT_MAX_RUNS = 100;

// A single plain rich-text run. Notion's request rich_text wants a `text`
// object; we never use links/annotations in the machine markers, so this is the
// only constructor we need.
function rt(content: string): {
  type: "text";
  text: { content: string };
} {
  return { type: "text", text: { content } };
}

// Equivalent of String.prototype.toWellFormed() (ES2024 — the tsconfig lib
// target is ES2022, so the regex form is used instead): replace every LONE
// surrogate — a high surrogate not followed by a low, or a low surrogate not
// preceded by a high — with U+FFFD (the replacement char), leaving valid astral
// pairs intact. LOCKSTEP with rag-dedup.ts `toWellFormedUtf16` (same regex,
// same rationale): Notion 400s on malformed UTF-16, and the upstream
// title/content that flows into the probe text flows into these blocks too.
function toWellFormedUtf16(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "\uFFFD",
  );
}

// A full rich_text array for `content`, SPLIT into ≤2000-char runs rather than
// truncated: Notion renders consecutive runs contiguously and a fetched block's
// plain_text is the concatenation of its runs, so the round-trip (incl. a long
// english-rule JSON) stays lossless. The split is surrogate-safe: when the
// 2000-code-unit boundary would land between the halves of a surrogate pair (an
// astral char — emoji in thread evidence), the run ends one unit early so the
// pair stays intact in the next run; a lone surrogate would render U+FFFD /
// 400 at Notion and break the lossless round-trip.
//
// Run COUNT is bounded too (RICH_TEXT_MAX_RUNS): content that would need more
// than 100 runs is truncated at run 100, which is replaced by an explicit
// "… [truncated: N more chars]" marker run — the only lossy case, and a marked
// one.
function richText(content: string): Array<{
  type: "text";
  text: { content: string };
}> {
  // Sanitize EMBEDDED lone surrogates at entry: the boundary backoff below only
  // protects run EDGES, so malformed upstream UTF-16 (a lone surrogate already
  // mid-content — the same input class rag-dedup's probe text declares
  // reachable) would otherwise ride through (the ≤2000-char path does no
  // processing at all) and 400 the WHOLE page create at Notion. The backoff
  // stays as belt-and-braces for pair-splitting at run edges.
  content = toWellFormedUtf16(content);
  if (content.length <= RICH_TEXT_RUN_MAX) return [rt(content)];
  const runs: Array<{ type: "text"; text: { content: string } }> = [];
  let i = 0;
  while (i < content.length) {
    if (
      runs.length === RICH_TEXT_MAX_RUNS - 1 &&
      content.length - i > RICH_TEXT_RUN_MAX
    ) {
      // The remainder cannot fit in the one run slot left under Notion's
      // 100-element cap — close out with the truncation marker.
      runs.push(rt(`… [truncated: ${content.length - i} more chars]`));
      return runs;
    }
    let end = Math.min(i + RICH_TEXT_RUN_MAX, content.length);
    const last = content.charCodeAt(end - 1);
    if (end < content.length && last >= 0xd800 && last <= 0xdbff) {
      end -= 1; // boundary splits a surrogate pair — back off one unit
    }
    runs.push(rt(content.slice(i, end)));
    i = end;
  }
  return runs;
}

// ── canonical-key marker (build + parse) ────────────────────────────────────────

// Build the leading `⟦atlas:<key>⟧` marker string.
function canonicalKeyMarker(canonicalKey: string): string {
  return `${CANONICAL_KEY_OPEN}${canonicalKey}${CANONICAL_KEY_CLOSE}`;
}

// Extract the canonical_key from a block's plain text, or null when the text
// does not OPEN with the marker. The marker must be FIRST (tolerating only
// leading whitespace) — exactly what the build side renders and the header
// documents: a hand-typed note QUOTING a key mid-prose ("follow up on
// ⟦atlas:…⟧ tomorrow") is prose, never a machine record (an anywhere-offset
// match would let that unchecked note REJECT the quoted candidate). An EMPTY
// marker (`⟦atlas:⟧`) is treated as absent — returning "" would otherwise
// drive approve/reject on a blank canonical_key downstream.
//
// Exported for S17's child-prose filter: a marker-OPENED child block of ANY
// type (nested to_do, unverified-note callout, hand-pasted marker block) is a
// machine record, not prose to fold into an english-rule payload.
export function extractCanonicalKey(plainText: string): string | null {
  const trimmed = plainText.trimStart();
  if (!trimmed.startsWith(CANONICAL_KEY_OPEN)) return null;
  const keyStart = CANONICAL_KEY_OPEN.length;
  const close = trimmed.indexOf(CANONICAL_KEY_CLOSE, keyStart);
  if (close === -1) return null;
  const key = trimmed.slice(keyStart, close);
  return key === "" ? null : key;
}

// ── flag badge ──────────────────────────────────────────────────────────────--

// The inline one-line badge rendered next to a candidate's title in its to_do /
// note text: `[sensitivity · knowledge_type · validation_status · confidence]`.
// LOAD-BEARING round-trip contract: S17's `parseFlagBadge` reads these four
// `·`-separated fields back off the edited page to reconstruct the candidate's
// classification, which drives flag-rule exclusion (e.g. a `sensitivity=secret`
// rule). It is NOT free-form presentation — the shape (trailing, bracketed,
// exactly four ` · `-joined fields at end-of-string) is a parse contract. Change
// it and you MUST change `parseFlagBadge` in lockstep, or a secret-classified
// candidate silently round-trips as `internal` and dodges its exclusion rule.
export function flagBadge(c: Candidate): string {
  const cls = c.provenance.classification;
  return `[${cls.sensitivity} · ${cls.knowledge_type} · ${cls.validation_status} · ${cls.confidence}]`;
}

// ── evidence rendering ───────────────────────────────────────────────────────--

// One evidence item → a short human string. Mirrors the §9.3 evidence union.
function evidenceLine(item: Candidate["evidence"][number]): string {
  switch (item.kind) {
    case "changed_file":
      return `changed file: ${item.path}`;
    case "linked_issue":
      return `linked issue: ${item.url}`;
    case "thread":
      return `thread: ${item.body}`;
    case "fused_from":
      return `fused from: ${item.ref}`;
  }
}

// Notion caps a single block's `children` array at ~100 entries per request.
// A candidate's children are 1 provenance callout + N evidence bullets, so the
// evidence is truncated at this bound with an explicit "…and N more" tail
// bullet (the full evidence list lives in the run corpus, not the approval
// page). 95 + callout + tail = 97 keeps headroom under the cap.
const MAX_EVIDENCE_BULLETS = 95;

// Provenance + evidence as child blocks of a candidate's to_do/note. The
// provenance line (source + url + date) is a callout; each evidence item is a
// bulleted_list_item. Child blocks keep the checkbox itself terse while still
// surfacing the audit trail inline (expandable under the item); an
// evidence list past MAX_EVIDENCE_BULLETS is truncated with a visible tail.
function provenanceAndEvidenceChildren(c: Candidate): ChildBlockRequest[] {
  const children: ChildBlockRequest[] = [];

  const prov = c.provenance;
  const provParts = [`source: ${prov.source}`];
  if (prov.url) provParts.push(prov.url);
  if (prov.date) provParts.push(`as of ${prov.date}`);
  children.push({
    type: "callout",
    callout: {
      rich_text: richText(provParts.join("  ·  ")),
      icon: { type: "emoji", emoji: "\u{1F4CE}" }, // 📎
    },
  });

  const omitted = Math.max(0, c.evidence.length - MAX_EVIDENCE_BULLETS);
  const rendered =
    omitted > 0 ? c.evidence.slice(0, MAX_EVIDENCE_BULLETS) : c.evidence;
  for (const item of rendered) {
    children.push({
      type: "bulleted_list_item",
      bulleted_list_item: { rich_text: richText(evidenceLine(item)) },
    });
  }
  if (omitted > 0) {
    children.push({
      type: "bulleted_list_item",
      bulleted_list_item: {
        rich_text: richText(
          `…and ${omitted} more evidence items (see run corpus)`,
        ),
      },
    });
  }

  return children;
}

// ── candidate → to_do (build) ───────────────────────────────────────────────---

// Generate-time clamp on the candidate TITLE inside a to_do/note text. The
// text layout is `⟦marker⟧ title  badge` — the badge is LAST, so a
// pathological title (>100×2000 chars) would push it past richText's
// RICH_TEXT_MAX_RUNS budget: the marker (first) survives truncation and the
// row still parses as a candidate, but BADGE-LESS — and a badge-less row
// reconstructs with sync's neutral default classification, laundering a
// secret-classified candidate past its sensitivity exclusion rules. The
// invariant: the marker AND the flag badge must ALWAYS survive richText
// truncation — the badge is load-bearing security metadata, while the title
// is display-only (the full title lives in the run corpus and the round-trip
// is already lossy past Notion's caps). marker + clamped title + badge stays
// far below even a single 2000-char run.
//
// The "far below" arithmetic assumes the canonical KEY inside the marker is
// machine-shaped (kebab claim slugs / repo names — claimSlug emits short
// `[a-z0-9-]` segments), nowhere near the 100×2000 budget. The key itself
// cannot be clamped here (it is the round-trip identity), so a pathological
// ≥~199k-char machine-generated key would re-open the severed-badge path —
// capping the slug at the key-format layer is an S20 key-format decision
// (cross-run key stability class), not handled at this clamp.
const TODO_TITLE_MAX = 1000;

function clampTitle(title: string): string {
  if (title.length <= TODO_TITLE_MAX) return title;
  // The clamp boundary may land between the halves of a surrogate pair (an
  // astral char straddling index TODO_TITLE_MAX): a naive slice would keep a
  // lone HIGH surrogate, which richText's entry sanitize renders as U+FFFD
  // before the ellipsis. Back off one unit so the pair is dropped whole —
  // same boundary backoff as richText's run-edge handling.
  const last = title.charCodeAt(TODO_TITLE_MAX - 1);
  const end =
    last >= 0xd800 && last <= 0xdbff ? TODO_TITLE_MAX - 1 : TODO_TITLE_MAX;
  return `${title.slice(0, end)}…`;
}

// Render an APPROVABLE candidate as a to_do checkbox (checked = approve; default
// unchecked). Text = `⟦atlas:<key>⟧ <title>  <flag-badge>`; provenance + evidence
// are child blocks. The marker is FIRST so the parse side can find it cheaply.
export function candidateToDoBlock(c: Candidate): BlockObjectRequest {
  const text = `${canonicalKeyMarker(c.canonical_key)} ${clampTitle(c.title)}  ${flagBadge(c)}`;
  return {
    type: "to_do",
    to_do: {
      rich_text: richText(text),
      checked: false,
      children: provenanceAndEvidenceChildren(c),
    },
  };
}

// Render a NON-approvable candidate (an unverified behavior/architecture fact,
// §7) as a NON-checkable callout note — present for the reviewer's awareness but
// impossible to approve. Carries the same canonical-key marker + title + badge,
// and the same provenance/evidence children, then appends a trailing
// " — unverified (not approvable)" marker after the badge, so it reads like the
// to_do (minus the checkbox) plus that explicit marker. A ⚠️ icon flags WHY it
// is non-checkable.
export function unverifiedNoteBlock(c: Candidate): BlockObjectRequest {
  const text = `${canonicalKeyMarker(c.canonical_key)} ${clampTitle(c.title)}  ${flagBadge(c)} — unverified (not approvable)`;
  return {
    type: "callout",
    callout: {
      rich_text: richText(text),
      icon: { type: "emoji", emoji: "⚠️" }, // ⚠️
      children: provenanceAndEvidenceChildren(c),
    },
  };
}

// ── candidates → grouped, ranked block list (build) ─────────────────────────────

// Group candidates by subsystem (deterministic: subsystems sorted alphabetically,
// candidates within a subsystem by rankScore desc — showcase-verified/high-
// confidence first, §11.1). Each subsystem gets a heading_2; each candidate is a
// to_do when approvable, else a non-checkable note. ORDER-ONLY: every candidate
// is rendered, none dropped here.
export function buildCandidateBlocks(
  candidates: Candidate[],
): BlockObjectRequest[] {
  const bySubsystem = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = bySubsystem.get(c.subsystem);
    if (list) list.push(c);
    else bySubsystem.set(c.subsystem, [c]);
  }

  const blocks: BlockObjectRequest[] = [];
  for (const subsystem of [...bySubsystem.keys()].sort()) {
    const group = bySubsystem
      .get(subsystem)!
      .slice()
      .sort((a, b) => b.rankScore - a.rankScore);

    blocks.push({
      type: "heading_2",
      heading_2: { rich_text: richText(subsystem) },
    });

    for (const c of group) {
      blocks.push(
        c.approvable ? candidateToDoBlock(c) : unverifiedNoteBlock(c),
      );
    }
  }

  return blocks;
}

// ── exclusion rule ⇄ bullet (build + parse) ─────────────────────────────────---

// Serialize an ExclusionRule to its bullet text: `atlas-rule: <compact-json>`.
// The JSON is the canonical §4.8 shape, so a flag rule and an english rule both
// round-trip losslessly through `parseRuleFromText`.
export function ruleToBulletText(rule: ExclusionRule): string {
  return `${RULE_PREFIX}${JSON.stringify(rule)}`;
}

// Narrow an arbitrary value into the canonical §4.8 `ExclusionRule`, or null if
// it doesn't match either variant. This is the single validation seam shared by
// the bullet-text parser AND the prior-run-manifest seed path (generate.ts).
// The run-store persists (and Zod-validates) the canonical shape, so for the
// manifest path this is defensive redundancy; a hand-edited bullet or manifest,
// however, may carry any shape, so a flag rule's `dimension` is validated
// against the real Classification keys — narrowing back to
// `keyof Classification` with no cast.
//
// EVERY rejection warns: any value reaching this function was INTENDED as a
// rule (a rule-prefixed bullet or a persisted rule-set entry), so dropping it
// silently would lose the lead's intended rule from enforcement AND from the
// next run's seeding.
export function coerceExclusionRule(value: unknown): ExclusionRule | null {
  const reject = (reason: string): null => {
    console.warn(
      `[atlas] dropping exclusion rule (${reason}): ${JSON.stringify(value)}`,
    );
    return null;
  };
  if (typeof value !== "object" || value === null) {
    return reject("not an object");
  }
  const r = value as Record<string, unknown>;
  if (r.kind === "flag") {
    if (typeof r.dimension !== "string") {
      return reject("flag rule `dimension` is missing or not a string");
    }
    if (typeof r.equals !== "string") {
      return reject("flag rule `equals` is missing or not a string");
    }
    if (!isClassificationKey(r.dimension)) {
      return reject(
        `unknown dimension "${r.dimension}" (not a Classification key)`,
      );
    }
    // `freshness` IS a Classification key, but its value is an object
    // (`{as_of}`) — a flag rule's string-equality predicate can never match it,
    // so accepting the rule would let it sit in the rule-set without ever firing.
    if (r.dimension === "freshness") {
      return reject(
        'dimension "freshness" is not flag-matchable (its value is an object, not a string)',
      );
    }
    // `audience` and `provenance_class` are Classification keys too, but the
    // approval-page badge round-trips only 4 of the 7 dims (sensitivity ·
    // knowledge_type · validation_status · confidence) — sync's
    // reconstructCandidate synthesizes the other two as constants, so a flag
    // rule on either dim would judge that synthetic default on EVERY row
    // (`provenance_class=primary` can never match; `=derived` matches
    // everything). Accepting the rule would leave it silently mis-judging, so
    // reject it the same way as `freshness`. Widening the badge to all 7 dims
    // is a generate+parse contract change tracked as an S20/spec follow-up.
    if (r.dimension === "audience" || r.dimension === "provenance_class") {
      return reject(
        `dimension "${r.dimension}" cannot be evaluated at sync (the approval-page badge does not round-trip this dimension — sync would judge a synthetic default on every row)`,
      );
    }
    // `equals` must be a member of the dimension's actual enum: an
    // out-of-enum value (e.g. `sensitivity=secrt`) can never match any row,
    // so accepting it would seed a permanently inert rule run after run.
    const dimensionEnum = FLAG_DIMENSION_ENUMS[r.dimension];
    if (!dimensionEnum.safeParse(r.equals).success) {
      return reject(
        `flag rule \`equals\` "${r.equals}" is not a valid "${r.dimension}" value (allowed: ${dimensionEnum.options.join(", ")}) — the rule could never fire`,
      );
    }
    return { kind: "flag", dimension: r.dimension, equals: r.equals };
  }
  if (r.kind === "english") {
    if (typeof r.text !== "string") {
      return reject("english rule `text` is missing or not a string");
    }
    // An empty/whitespace instruction can never usefully fire — same rationale
    // as the out-of-enum `equals` reject above. Worse than inert, though:
    // exclude.ts bills one LLM call per candidate to evaluate `text`, and an
    // empty instruction is UNDEFINED judgment, while §11.5 would re-seed the
    // rule into every next run's artifact. The emptiness check does NOT trim
    // the accepted value — real text round-trips verbatim.
    if (r.text.trim() === "") {
      return reject(
        "english rule `text` is empty/whitespace — there is no instruction to evaluate (the rule would bill an LLM call per candidate with undefined judgment)",
      );
    }
    return { kind: "english", text: r.text };
  }
  return reject(`unknown kind ${JSON.stringify(r.kind)}`);
}

// Whether bullet text is rule-INTENDED (carries the `atlas-rule:` prefix),
// regardless of JSON validity. Exported for S17's recursive checkbox walk: an
// INDENTED rule bullet is never parsed (rules must stay top-level), but the
// walk must WARN about it rather than let the lead's intended rule vanish from
// enforcement and §11.5 seeding silently.
export function isRuleBulletText(text: string): boolean {
  return RULE_PREFIX_RE.test(text.trim());
}

// Parse an ExclusionRule from bullet text, or null when the text is not a rule
// marker (a human's free-form bullet) or the JSON is malformed/invalid. The
// prefix match tolerates any/no whitespace after `atlas-rule:` so a hand-edit
// that drops the space doesn't silently demote the rule to prose.
export function parseRuleFromText(text: string): ExclusionRule | null {
  const trimmed = text.trim();
  const prefixMatch = RULE_PREFIX_RE.exec(trimmed);
  if (!prefixMatch) return null;
  const json = trimmed.slice(prefixMatch[0].length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // The bullet clearly INTENDED a rule (it carries the rule prefix) but its
    // JSON is malformed — a lead's typo. Warn before dropping it (mirroring
    // coerceExclusionRule's warn) so the intended rule isn't silently lost.
    console.warn(
      `[atlas] dropping malformed exclusion-rule bullet (invalid JSON): ${trimmed}`,
    );
    return null;
  }
  return coerceExclusionRule(parsed);
}

// Build the editable Exclusion-Rules section: a heading_2 followed by one
// bulleted_list_item per rule. The lead edits/adds/deletes bullets in place; the
// sync slot reads them back via `parseExclusionRules`.
export function buildExclusionRuleBlocks(
  rules: ExclusionRule[],
): BlockObjectRequest[] {
  const blocks: BlockObjectRequest[] = [
    {
      type: "heading_2",
      heading_2: { rich_text: [rt("Exclusion Rules")] },
    },
  ];
  for (const rule of rules) {
    blocks.push({
      type: "bulleted_list_item",
      bulleted_list_item: { rich_text: richText(ruleToBulletText(rule)) },
    });
  }
  return blocks;
}

// ── response-block parse helpers (the S17 read side) ─────────────────────────---

// Concatenate the plain_text of a response rich-text array.
function plainTextOfResponse(richText: RichTextItemResponse[]): string {
  return richText.map((r) => r.plain_text).join("");
}

// The checkbox state parsed off a fetched to_do block: which candidate, and
// whether the lead checked it. `null` for non-to_do blocks and for to_do blocks
// lacking the canonical-key marker (a checkbox the lead typed by hand).
export interface CheckboxState {
  canonicalKey: string;
  checked: boolean;
}

export function parseCheckboxState(
  block: BlockObjectResponse,
): CheckboxState | null {
  if (block.type !== "to_do") return null;
  const canonicalKey = extractCanonicalKey(
    plainTextOfResponse(block.to_do.rich_text),
  );
  if (canonicalKey === null) return null;
  return { canonicalKey, checked: block.to_do.checked };
}

// Read the edited Exclusion-Rules section back from a page's fetched blocks: any
// bulleted_list_item whose text is a valid rule marker becomes an ExclusionRule,
// in document order. Non-bullet blocks (headings, to_dos) and free-form bullets
// are skipped, so the lead can interleave prose freely.
export function parseExclusionRules(
  blocks: BlockObjectResponse[],
): ExclusionRule[] {
  const rules: ExclusionRule[] = [];
  for (const block of blocks) {
    if (block.type !== "bulleted_list_item") continue;
    const rule = parseRuleFromText(
      plainTextOfResponse(block.bulleted_list_item.rich_text),
    );
    if (rule) rules.push(rule);
  }
  return rules;
}
