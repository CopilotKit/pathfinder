// Approval-artifact sync / enactment (spec §11.2/§11.3, plan §4.9 / S17).
//
// The mirror of S16's generate step. generate.ts WRITES the per-run approval
// page (editable Exclusion-Rules section on top, candidates as to_do checkboxes
// grouped by subsystem); the lead then edits that page by hand — toggling
// checkboxes (checked = approve) and adding/editing/removing exclusion-rule
// bullets. `syncApprovalArtifact` reads the EDITED page back and ENACTS it:
//
//   1. Page → blocks (paginated read of the page's children).
//   2. blocks → exclusion rules (parseExclusionRules) + per-candidate checkbox
//      state (parseCheckboxState), both from the shared S16 notion-blocks parser.
//      Checkbox discovery is RECURSIVE (an accidentally-indented candidate row
//      is still found, with a warn), but rule bullets must remain TOP-LEVEL —
//      an indented `atlas-rule:` bullet is not parsed (it is WARNED about, not
//      silently dropped), and descent past the depth cap is warned at the
//      truncation boundary. Unverified-behavior
//      callout notes (rendered non-checkable at generate time, §7) are not
//      to_dos and are never enacted here: their server rows stay pending until
//      a later run re-proposes them with verification or a human settles them.
//   3. The lead's rules are APPLIED to the checked candidates via the S13
//      exclusion engine (applyExclusions): a flag rule is judged in-process; an
//      english rule is judged by the LLM seam (S1) — the ONE LLM touchpoint here.
//      An english rule judges REAL candidate content: each checked to_do's child
//      blocks (the provenance/evidence prose S16 renders under the checkbox) are
//      fetched and joined onto the title, so a clean-titled candidate whose body
//      reveals e.g. a credential is still caught (§11). Title-only is the
//      documented fallback for a row with no children (a hand-typed checkbox).
//   4. Enactment against the live ratification endpoints via the Atlas HTTP
//      client (S15): a candidate that is CHECKED and NOT excluded is approved —
//      UNLESS it reconstructs to a non-approvable unverified behavior/
//      architecture fact, in which case the §7 binding gate rejects it (the
//      third outcome: checked + kept + non-approvable → rejected); everything
//      else (unchecked, or checked-but-excluded) is rejected. The client treats
//      a 409 (already-settled / never-pending) as an idempotent no-op, so
//      re-running sync on a page whose rows a prior run already enacted does
//      not throw — but a key the server refused to enact that way is tallied
//      under `conflicted`, never under approved/rejected/excluded.
//   5. The run's FINAL rule-set (exactly the rules on the edited page) is
//      persisted into the run manifest so the NEXT run seeds its Exclusion-Rules
//      section from it (§11.5).
//
// We NEVER re-implement ratification — we drive the same endpoints the human
// reviewer's tooling does, exactly as the spec mandates (§11.3).

import type { Client } from "@notionhq/client";
import { isFullBlock } from "@notionhq/client";
import type { BlockObjectResponse } from "@notionhq/client";

import type { AtlasHttpClient } from "../client.js";
import type { LlmDistiller } from "../llm.js";
import {
  CorruptRunManifestError,
  type RunManifest,
  type RunStore,
} from "../run-store.js";
import { applyExclusions, type ExclusionRule } from "../exclude.js";
import {
  parseCheckboxState,
  parseExclusionRules,
  extractCanonicalKey,
  isRuleBulletText,
  CANONICAL_KEY_OPEN,
  CANONICAL_KEY_CLOSE,
  type CheckboxState,
} from "./notion-blocks.js";
import {
  BEHAVIOR_KNOWLEDGE_TYPES,
  CandidateSchema,
  parseCanonicalKey,
  Sensitivity,
  KnowledgeType,
  ValidationStatus,
  Confidence,
  type Candidate,
  type Classification,
} from "../types.js";

export interface SyncApprovalArtifactOptions {
  // The Notion client used to read the edited approval page.
  notion: Client;
  // The approval page whose children carry the edited checkboxes + rule bullets.
  pageId: string;
  // The live-endpoint client that enacts approve/reject (§11.3).
  client: AtlasHttpClient;
  // Attribution stamped on every ratification (X-Atlas-Actor).
  actor: string;
  // The LLM seam the english-rule exclusion path routes through (S1/S13).
  llm: LlmDistiller;
  // When both are provided, the run's final rule-set is persisted into the run
  // manifest for next-run seeding (§11.5). Omitting them skips persistence.
  runStore?: RunStore;
  runId?: string;
}

export interface SyncApprovalArtifactResult {
  // canonicalKeys approved (checked AND not excluded by any rule).
  approved: string[];
  // canonicalKeys rejected for a non-rule reason: rows the lead left unchecked,
  // PLUS checked rows the §7 binding gate refused (reconstructed to a
  // non-approvable unverified behavior/architecture fact — see the approve loop).
  rejected: string[];
  // canonicalKeys rejected because an exclusion rule dropped them (they were
  // checked, but a rule excludes them). Surfaced separately from `rejected` for
  // the audit trail; both are enacted via client.reject.
  excluded: string[];
  // canonicalKeys whose ratification the server REFUSED with the idempotent
  // not-pending 409 (already settled or missing — e.g. a row a prior run
  // already rejected). The client swallows that 409 (no throw), but the
  // enactment did NOT happen, so these keys are tallied here — never under
  // approved/rejected/excluded, which record only ENACTED outcomes.
  conflicted: string[];
}

// The reason recorded on a rule-based rejection, so the live row carries WHY it
// was dropped. Unchecked rejections carry the simpler "not approved" reason.
function exclusionReason(rule: ExclusionRule): string {
  return rule.kind === "flag"
    ? `excluded by rule: ${rule.dimension}=${rule.equals}`
    : `excluded by rule: ${rule.text}`;
}

// Read every child block of the approval page, following pagination. Notion caps
// a single `blocks.children.list` at 100 results, and an edited approval page can
// hold far more (one to_do per candidate), so we MUST page through `next_cursor`
// — a single-page read would silently drop candidates past the first 100.
// Partial (id-only) block responses are narrowed away with the SDK's `isFullBlock`
// guard so the parser only ever sees full blocks.
async function readAllBlocks(
  notion: Client,
  pageId: string,
): Promise<BlockObjectResponse[]> {
  const blocks: BlockObjectResponse[] = [];
  let cursor: string | undefined;
  do {
    const page = await notion.blocks.children.list({
      block_id: pageId,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    for (const block of page.results) {
      if (isFullBlock(block)) blocks.push(block);
    }
    cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
  } while (cursor);
  return blocks;
}

// The inline flag badge S16 renders into a candidate's to_do text is
// `[<sensitivity> · <knowledge_type> · <validation_status> · <confidence>]`,
// ALWAYS appended LAST. We anchor it to END-OF-STRING (exactly four ` · `-joined
// fields inside a trailing `[ … ]`) rather than scanning with lastIndexOf("["):
// a title may legitimately contain its own brackets (e.g. "[bugfix] handle [a]"),
// and a non-anchored locator can mis-slice it, yield parts.length !== 4, and
// silently fall back to the `internal` default — so a `secret` candidate would
// round-trip as `internal` and dodge a `sensitivity=secret` flag rule.
//
// The regex requires the badge at the very end, with the four interior fields
// separated by ` · ` and NO bracket chars inside, so a bracketed title left of
// the badge is never confused for it. The `unverifiedNoteBlock` suffix
// " — unverified (not approvable)" is tolerated after the badge.
//
// TWO-TIER location: the end-anchored regex is the PRIMARY locator. When it
// misses but a badge-shaped 4-field group IS present somewhere in the text
// (the lead appended an annotation AFTER the badge — "… [secret · …] —
// confirmed with Bob"), the FALLBACK scan locates the LAST such group and
// parses it anyway, with a warn. Silently discarding the badge in that case
// would launder the row to the neutral `internal` default — a checked SECRET
// row would dodge a `sensitivity=secret` flag rule and get approved. A false
// positive (a legit mid-title `[a · b · c · d]` on a genuinely badge-less
// row) degrades safely: every field fails the per-field enum coercion in
// `reconstructCandidate`, landing on the same neutral classification as
// today, plus warns. A row with NO badge-shaped group at all keeps the silent
// badge-less neutral default.
const FLAG_BADGE_RE =
  /\[([^[\]·]+)·([^[\]·]+)·([^[\]·]+)·([^[\]·]+)\](?:\s+—\s+unverified \(not approvable\))?\s*$/;
// Pattern source only: `locateFlagBadge` below clones it with a fresh `g`, so
// the constant's own flag/lastIndex is never used for iteration.
const FLAG_BADGE_ANYWHERE_RE =
  /\[([^[\]·]+)·([^[\]·]+)·([^[\]·]+)·([^[\]·]+)\]/g;

// Locate the flag badge: end-anchored first, then the LAST badge-shaped group
// anywhere in the text. Shared by `parseFlagBadge` (field extraction) and
// `extractTitle` (stripping). The two call sites pass DIFFERENT strings
// (parseFlagBadge gets the FULL plain text; extractTitle locates on the
// marker-STRIPPED text), so agreement is by construction only on the anchored
// path (both anchor to the end of the string). Fallback divergence would
// require the only badge-shaped group to live INSIDE the ⟦atlas:key⟧ marker —
// machine-generated kebab/repo content (claimSlug emits `[a-z0-9-]` only), so
// that input is contrived — and it degrades to the neutral badge-less default
// on the parse side plus a cosmetic title on the strip side.
function locateFlagBadge(
  plainText: string,
): { match: RegExpExecArray; anchored: boolean } | null {
  const anchored = FLAG_BADGE_RE.exec(plainText);
  if (anchored) return { match: anchored, anchored: true };
  let last: RegExpExecArray | null = null;
  // Fresh regex state per call (the shared constant is only the pattern source).
  const re = new RegExp(FLAG_BADGE_ANYWHERE_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(plainText)) !== null) last = m;
  if (!last) return null;
  return { match: last, anchored: false };
}

// Pull the four badge values back out so a reconstructed candidate carries a real
// classification for flag-rule evaluation. Returns null when no badge-shaped
// group is present at all (then the caller falls back to a neutral default
// classification). A non-end-anchored badge (trailing lead annotation) is parsed
// via the fallback scan, with a warn naming the canonical_key (when the caller
// provides it) and the trailing text. Exported so the generate→sync round-trip
// (the build side renders `flagBadge`, the parse side reads it here) is directly
// testable as the load-bearing contract it is.
export function parseFlagBadge(
  plainText: string,
  canonicalKey?: string,
): {
  sensitivity: string;
  knowledge_type: string;
  validation_status: string;
  confidence: string;
} | null {
  const located = locateFlagBadge(plainText);
  if (!located) return null;
  const m = located.match;
  if (!located.anchored) {
    const trailing = plainText.slice(m.index + m[0].length).trim();
    console.warn(
      `[atlas] sync: flag badge for canonical_key="${canonicalKey ?? "<unknown>"}" is not end-anchored — trailing text after badge ("${trailing}"); parsed anyway`,
    );
  }
  const [, sensitivity, knowledge_type, validation_status, confidence] = [
    ...m,
  ].map((p) => p?.trim() ?? "");
  return { sensitivity, knowledge_type, validation_status, confidence };
}

// Strip the leading `⟦atlas:<key>⟧ ` marker and the trailing `[ … ]` flag badge
// off a to_do's plain text, leaving the human-readable distilled title. Used as
// the reconstructed candidate's `title`, and as the base of its `content` (the
// why/how prose lives in child blocks, which `syncApprovalArtifact` fetches and
// joins on for english-rule judgment; title-only is the no-children fallback).
//
// The close marker is located AFTER the open (mirroring `extractCanonicalKey`
// in notion-blocks.ts). Since the parse side requires the marker FIRST
// (extractCanonicalKey), any block reaching here opens with the marker — but
// the close is still anchored to the open rather than the first `⟧` in the
// string, so a stray `⟧` inside the KEY itself never widens the slice.
//
// The badge is removed with the SAME two-tier locator as `parseFlagBadge` —
// end-anchored primary, last-badge-shaped-group fallback — so on the anchored
// path the group stripped here is exactly the one `parseFlagBadge` parsed
// (the fallback runs on marker-stripped text; see the divergence note at
// `locateFlagBadge`). A title containing
// its own `[`/`]` (e.g. "fix [a] and [b]") keeps those brackets intact (the
// 4-field `·`-joined shape never matches them); a non-end-anchored badge is
// stripped IN PLACE, preserving the lead's trailing annotation in the title.
function extractTitle(plainText: string): string {
  let text = plainText;
  const open = text.indexOf(CANONICAL_KEY_OPEN);
  if (open !== -1) {
    const close = text.indexOf(
      CANONICAL_KEY_CLOSE,
      open + CANONICAL_KEY_OPEN.length,
    );
    if (close !== -1) {
      text = text.slice(close + CANONICAL_KEY_CLOSE.length);
    }
  }
  const located = locateFlagBadge(text);
  if (located) {
    const { match } = located;
    text =
      text.slice(0, match.index) + text.slice(match.index + match[0].length);
  }
  return text.trim();
}

// Plain text of an arbitrary fetched block: every text-bearing block type
// carries a `rich_text` array under its own type key (paragraph, callout,
// bulleted_list_item, …). Non-text blocks (divider, image, …) yield "".
function blockPlainText(block: BlockObjectResponse): string {
  const data = (
    block as unknown as Record<
      string,
      { rich_text?: Array<{ plain_text?: string }> } | undefined
    >
  )[block.type];
  const richText = data?.rich_text;
  if (!Array.isArray(richText)) return "";
  return richText.map((r) => r.plain_text ?? "").join("");
}

// The prose under a candidate's to_do — the provenance callout + evidence
// bullets `provenanceAndEvidenceChildren` rendered at generate time (plus
// anything the lead added by hand). This is the real candidate CONTENT an
// english rule must judge (§11): a clean-titled candidate whose body reveals
// e.g. a credential is only catchable here. Empty for a childless row (a
// hand-typed checkbox) — the caller then falls back to title-only content.
//
// A marker-bearing child is NOT prose, whatever its block TYPE: a nested
// marker to_do is a CANDIDATE in its own right (the recursive discovery walk
// treats it as one — folding its text in would double-judge it), and a
// marker-bearing CALLOUT (an unverified §7 note, or any hand-pasted marker
// block) is a machine record. Folding either's text into the parent's content
// would leak the `⟦atlas:…⟧` machine marker into the english-rule payload, so
// the filter keys on the marker itself (extractCanonicalKey), not on
// to_do-ness.
async function fetchChildProse(
  notion: Client,
  block: BlockObjectResponse,
): Promise<string> {
  if (!block.has_children) return "";
  const children = await readAllBlocks(notion, block.id);
  return children
    .filter((child) => extractCanonicalKey(blockPlainText(child)) === null)
    .map((child) => blockPlainText(child).trim())
    .filter((text) => text !== "")
    .join("\n");
}

// A neutral classification used when a checkbox carries no parseable badge (e.g.
// a hand-typed checkbox). The SHIPPED default flag rules (sensitivity=
// proprietary/secret, exclude.ts DEFAULT_EXCLUSION_RULES) never match these
// neutral values — but a LEAD-AUTHORED flag rule targeting one of the synthesized
// badge defaults (`sensitivity=internal`, `knowledge_type=operational`,
// `validation_status=unverified`, `confidence=low`) DOES match and will exclude
// a badge-less row. (`audience`/`provenance_class` are synthesized for EVERY
// row — the badge does not round-trip them — so coerceExclusionRule rejects
// flag rules on those dims outright.) English rules still run against the
// row's text either way — so a missing badge degrades gracefully.
//
// `knowledge_type` MUST be a NON-behavior type (`operational`, not
// `design-rationale`): the §7 enactment gate (re-derived in `reconstructCandidate`)
// rejects a behavior/architecture fact still `unverified`. A badge-less row the
// lead deliberately checked carries `validation_status: unverified` by default, so
// a behavior default would silently reject it — defeating the "degrades gracefully"
// intent. `operational` keeps the default row approvable.
function defaultClassification(now: string): Classification {
  return {
    sensitivity: "internal",
    knowledge_type: "operational",
    audience: "all-staff",
    validation_status: "unverified",
    confidence: "low",
    provenance_class: "derived",
    // Date-only, per the fleet convention: every adapter stamps `as_of` via
    // date-only `isoDate(...)`, never a full ISO timestamp.
    freshness: { as_of: now.slice(0, 10) },
  };
}

// Behavior/architecture knowledge that stays `unverified` is NOT approvable
// (the §7 binding gate, mirrored from canonicalize.ts `isApprovable`). The gate
// is enforced at GENERATE time (such a fact renders as a non-checkable note, not
// a to_do), but a lead could hand-paste a checkbox row for one. Re-deriving
// `approvable` here from the reconstructed classification lets the ENACTMENT loop
// (`syncApprovalArtifact`) close that bypass: a checked candidate that
// reconstructs to `approvable:false` is REJECTED, never approved — see the
// reconstructed-`approvable` guard in the approve loop below. The gate SET
// (BEHAVIOR_KNOWLEDGE_TYPES, imported from types.ts) is the single
// contract-level definition shared with canonicalize.ts and validate.ts, so
// the three §7 gate sites can never silently drift.

// The §7 binding gate over a (possibly pre-validation) classification (mirrors
// canonicalize.ts `isApprovable`): a behavior/architecture fact still
// `unverified` is NOT approvable. Reads only `knowledge_type`/`validation_status`
// as plain strings, so it works on BOTH the raw badge classification (before Zod
// narrowing) and the validated/`base` one — computed from the classification the
// candidate ACTUALLY ships with. See `reconstructCandidate`, where it MUST run
// AFTER the parse-or-fall-back resolves which classification is used, so
// `approvable` never reflects a discarded raw badge.
function isApprovable(classification: {
  knowledge_type: string;
  validation_status: string;
}): boolean {
  return !(
    BEHAVIOR_KNOWLEDGE_TYPES.has(
      classification.knowledge_type as KnowledgeType,
    ) && classification.validation_status === "unverified"
  );
}

// Reconstruct a minimal, schema-valid Candidate from a fetched to_do block. The
// edited page round-trips the canonical_key (marker), the title, the flag badge,
// and the child-block prose — NOT the full Candidate — so we rebuild exactly the
// fields the exclusion engine reads: provenance.classification (flag rules) and
// title/content/subsystem (english rules). `content` is the title plus the
// fetched child-block prose (`childProse`, "" for a childless row → title-only
// fallback), so an english rule judges real candidate content, not just the
// checkbox line. The badge is coerced through the S0 Zod schema, so a bogus
// hand-edited value fails loud rather than mis-judging a flag rule. `subsystem`
// is recovered from the canonical_key (`<sourcetype>:<subsystem>:<claim-slug>`)
// so english rules judged on subsystem (exclude.ts) see the REAL subsystem, not
// a placeholder.
//
// Returns NULL for a row the schema cannot represent at all (even the neutral
// fallback fails — e.g. a hand-typed key whose interior `⟦` survives the
// marker slice and puts a delimiter in the recovered subsystem): the caller
// skips it, leaving the row PENDING. One corrupt hand-edited row must never
// abort the whole sync (a throw here unwinds the reconstruction loop — nothing
// gets enacted and §11.5 rule persistence is skipped).
function reconstructCandidate(
  block: BlockObjectResponse,
  canonicalKey: string,
  now: string,
  childProse: string,
): Candidate | null {
  // Only to_do blocks reach here (parseCheckboxState already gated on type),
  // but read the text defensively through the same shape the parser uses.
  const plainText =
    block.type === "to_do"
      ? block.to_do.rich_text.map((r) => r.plain_text).join("")
      : "";
  const title = extractTitle(plainText) || canonicalKey;
  const badge = parseFlagBadge(plainText, canonicalKey);

  // Recover the real subsystem from the canonical_key so subsystem-aware english
  // rules judge correctly. A malformed key (missing a structural colon) is
  // tolerated — fall back to "unknown" rather than throwing on enactment.
  let subsystem = "unknown";
  try {
    subsystem = parseCanonicalKey(canonicalKey).subsystem;
  } catch {
    // Malformed canonical_key — keep the placeholder subsystem, but NAME the
    // degrade: a subsystem-targeted english rule will judge "unknown" instead
    // of the real subsystem for this row, and a silent catch hides that.
    console.warn(
      `[atlas] sync: malformed canonical_key "${canonicalKey}" — subsystem falls back to "unknown"; subsystem-targeted english rules will not match this row`,
    );
  }

  const base = defaultClassification(now);

  // Candidate scaffolding shared by both the badge-derived and fallback paths.
  // `approvable` is intentionally NOT set here — the §7 gate is re-derived BELOW
  // from whichever classification the candidate actually ships with, so a
  // discarded badge field can never leak a stale `approvable` onto the result.
  const baseCandidate = {
    // "derived" because a reconstructed row is synthesized from page state,
    // not a source observation.
    sourcetype: "derived" as const,
    subsystem,
    source_name: canonicalKey,
    title,
    content: childProse === "" ? title : `${title}\n\n${childProse}`,
    evidence: [],
    needsReview: false,
    validationTargets: [],
    canonical_key: canonicalKey,
    rankScore: 0,
  };

  // The classification the badge round-trips, coerced PER FIELD against the §12
  // enums: a hand-edited out-of-enum value in ONE field defaults ONLY that
  // field (warned below, naming the canonical_key + each discarded
  // field/value); every VALID field is kept. A whole-badge fallback here would
  // LAUNDER the valid fields too — e.g. a `[secret · … · LOWish]` badge would
  // reset to the neutral `internal` default and dodge a `sensitivity=secret`
  // flag rule, approving a checked secret row. A missing badge field (no badge
  // at all) takes the neutral default without a warn — that is the documented
  // badge-less degrade, not corruption.
  const discarded: string[] = [];
  function coerce<T>(
    field: string,
    raw: string | undefined,
    schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
    fallback: T,
  ): T {
    if (raw === undefined) return fallback;
    const result = schema.safeParse(raw);
    if (result.success) return result.data as T;
    discarded.push(`${field}="${raw}"`);
    return fallback;
  }
  const badgeClassification = {
    sensitivity: coerce(
      "sensitivity",
      badge?.sensitivity,
      Sensitivity,
      base.sensitivity,
    ),
    knowledge_type: coerce(
      "knowledge_type",
      badge?.knowledge_type,
      KnowledgeType,
      base.knowledge_type,
    ),
    audience: base.audience,
    validation_status: coerce(
      "validation_status",
      badge?.validation_status,
      ValidationStatus,
      base.validation_status,
    ),
    confidence: coerce(
      "confidence",
      badge?.confidence,
      Confidence,
      base.confidence,
    ),
    provenance_class: base.provenance_class,
    freshness: base.freshness,
  };
  if (discarded.length > 0) {
    console.warn(
      `[atlas] sync: approval-page badge for canonical_key="${canonicalKey}" carries out-of-enum field(s) — defaulting ONLY those, keeping the valid fields: ${discarded.join(", ")}`,
    );
  }

  // Parse-or-fall-back: per-field coercion above guarantees every badge field is
  // enum-valid, so the strict parse succeeds on the badge path; the fallback
  // remains as defense for a non-badge schema failure. CRITICAL: `approvable`
  // is computed from the FINAL classification the candidate ships with (the
  // per-field-coerced one on success, the neutral `base` on fallback), never
  // from a discarded raw badge value — the §7 gate must judge exactly what the
  // candidate carries.
  const parsed = CandidateSchema.safeParse({
    ...baseCandidate,
    provenance: { source: canonicalKey, classification: badgeClassification },
    approvable: isApprovable(badgeClassification),
  });
  if (parsed.success) return parsed.data;
  const fallback = CandidateSchema.safeParse({
    ...baseCandidate,
    provenance: { source: canonicalKey, classification: base },
    approvable: isApprovable(base),
  });
  if (fallback.success) return fallback.data;
  // Even the neutral fallback is schema-invalid (a non-classification field —
  // e.g. the subsystem delimiter refine — is what failed). Warn-and-skip:
  // left PENDING is the correct terminal state for a row the schema cannot
  // represent; a throw would take down the whole page's enactment.
  console.warn(
    `[atlas] sync: malformed hand-edited row for canonical_key="${canonicalKey}" — skipped, left pending (cannot reconstruct a schema-valid candidate: ${fallback.error.issues.map((i) => i.message).join("; ")})`,
  );
  return null;
}

export async function syncApprovalArtifact(
  opts: SyncApprovalArtifactOptions,
): Promise<SyncApprovalArtifactResult> {
  const { notion, pageId, client, actor, llm } = opts;

  const blocks = await readAllBlocks(notion, pageId);
  const now = new Date().toISOString();

  // The lead's final rule-set, exactly as edited on the page.
  const rules = parseExclusionRules(blocks);

  // Per-candidate checkbox state, keyed by canonical_key in document order. A
  // block lacking the marker (a hand-typed checkbox or a non-to_do) yields null
  // and is skipped. We keep the originating block so we can rebuild the
  // candidate the exclusion engine needs.
  //
  // DEDUPE by canonical_key: a lead may duplicate a row (e.g. check it once and
  // leave a copy unchecked). We collapse to ONE decision per key — checked
  // ANYWHERE wins (and the checked block is kept for reconstruction) — so the
  // same key is never both approved and rejected. First document occurrence sets
  // the order.
  //
  // Discovery is RECURSIVE (DFS, bounded depth): in Notion, Tab indents a row
  // under the PREVIOUS sibling, so an accidentally-indented candidate row is a
  // CHILD block a flat top-level scan never sees — not approved, not rejected,
  // pending forever, silently. Every fetched block with children is descended
  // into (one extra children fetch per parent block — acceptable for a
  // once-per-run sync) and any marker-bearing to_do found below the top level
  // is treated as a candidate, with a warn asking the lead to un-indent it.
  // Evidence callouts/bullets under to_dos are not to_dos and remain
  // non-candidates. Exclusion-rule bullets are NOT discovered recursively —
  // see the header: rule bullets must remain top-level.
  const MAX_NESTED_CANDIDATE_DEPTH = 3;
  const byKey = new Map<
    string,
    { canonicalKey: string; checked: boolean; block: BlockObjectResponse }
  >();
  const record = (state: CheckboxState, block: BlockObjectResponse): void => {
    const existing = byKey.get(state.canonicalKey);
    if (!existing) {
      byKey.set(state.canonicalKey, { ...state, block });
    } else if (state.checked && !existing.checked) {
      // A checked occurrence supersedes an earlier unchecked one.
      byKey.set(state.canonicalKey, { ...state, block });
    }
  };
  async function collectCheckboxes(
    levelBlocks: BlockObjectResponse[],
    depth: number,
  ): Promise<void> {
    for (const block of levelBlocks) {
      const state = parseCheckboxState(block);
      if (state) {
        if (depth > 0) {
          console.warn(
            `[atlas] sync: indented candidate row for canonical_key="${state.canonicalKey}" (nested ${depth} level(s) deep) — treated as a candidate; un-indent it on the page`,
          );
        }
        record(state, block);
      }
      // An INDENTED rule bullet is never PARSED (rules must stay top-level —
      // see the header; full rule recursion stays deferred), but skipping it
      // with no signal makes the lead's intended rule vanish from enforcement
      // AND §11.5 seeding silently — so it is WARNED, like the nested
      // candidate rows above.
      if (
        depth > 0 &&
        block.type === "bulleted_list_item" &&
        isRuleBulletText(blockPlainText(block))
      ) {
        console.warn(
          `[atlas] sync: indented atlas-rule bullet (nested ${depth} level(s) deep) is not parsed — un-indent it on the page: "${blockPlainText(block)}"`,
        );
      }
      if (block.has_children) {
        if (depth < MAX_NESTED_CANDIDATE_DEPTH) {
          await collectCheckboxes(
            await readAllBlocks(notion, block.id),
            depth + 1,
          );
        } else {
          // The walk's charter says an accidentally-indented candidate row is
          // still found — at the depth cap that stops being true, so the
          // truncation boundary must be NAMED: a marker to_do nested deeper
          // would otherwise sit pending forever, silently.
          console.warn(
            `[atlas] sync: block ${block.id} at depth ${depth} has children that were NOT scanned for candidate rows (max nested depth ${MAX_NESTED_CANDIDATE_DEPTH}) — un-indent any candidate rows nested deeper`,
          );
        }
      }
    }
  }
  await collectCheckboxes(blocks, 0);
  const checkboxes = [...byKey.values()];

  // Run the exclusion engine ONLY over the candidates the lead checked — an
  // unchecked candidate is rejected regardless of the rules, so it never needs an
  // LLM call (and never pays for a child-block fetch). Reconstruct the minimal
  // candidate each checked checkbox stands for, fetching its child-block prose
  // so english rules judge real content, not just the checkbox title.
  const checked = checkboxes.filter((c) => c.checked);
  const checkedCandidates: Candidate[] = [];
  for (const c of checked) {
    const childProse = await fetchChildProse(notion, c.block);
    const candidate = reconstructCandidate(
      c.block,
      c.canonicalKey,
      now,
      childProse,
    );
    // A null is a row the schema cannot represent (warned inside) — skipped,
    // left pending; it lands in NO outcome bucket.
    if (candidate !== null) checkedCandidates.push(candidate);
  }

  const { kept, excluded } = await applyExclusions(
    checkedCandidates,
    rules,
    llm,
  );

  const approved: string[] = [];
  const rejected: string[] = [];
  const excludedKeys: string[] = [];
  const conflicted: string[] = [];

  // A ratification the server REFUSED with the idempotent not-pending 409
  // (client resolved false): the key was NOT enacted, so it must not land in
  // the enacted-outcome bucket — tally it under `conflicted` and warn.
  function tallyConflict(canonicalKey: string, action: "approve" | "reject") {
    conflicted.push(canonicalKey);
    console.warn(
      `[atlas] sync: ${action} for canonical_key="${canonicalKey}" was NOT enacted (server refused with the idempotent not-pending 409 — already settled or missing); tallied as conflicted`,
    );
  }

  // 1. Checked & kept → approve — UNLESS the reconstructed candidate is not
  //    approvable (§7 binding gate). A checked row that reconstructs to an
  //    unverified behavior/architecture fact (`approvable:false`) is REJECTED,
  //    never approved: the generate-time render gate (non-checkable note) is
  //    bypassable by a hand-pasted checkbox, so the gate is re-enforced HERE at
  //    enactment. This is the live close of the §7 gate, not just a render shape.
  for (const candidate of kept) {
    if (!candidate.approvable) {
      const enacted = await client.reject(
        {
          canonicalKey: candidate.canonical_key,
          reason: "unverified behavior fact not approvable (§7 gate)",
        },
        actor,
      );
      if (enacted) rejected.push(candidate.canonical_key);
      else tallyConflict(candidate.canonical_key, "reject");
      continue;
    }
    const enacted = await client.approve(
      { canonicalKey: candidate.canonical_key },
      actor,
    );
    if (enacted) approved.push(candidate.canonical_key);
    else tallyConflict(candidate.canonical_key, "approve");
  }

  // 2. Checked but excluded by a rule → reject, with the rule as the reason.
  for (const { candidate, rule } of excluded) {
    const enacted = await client.reject(
      { canonicalKey: candidate.canonical_key, reason: exclusionReason(rule) },
      actor,
    );
    if (enacted) excludedKeys.push(candidate.canonical_key);
    else tallyConflict(candidate.canonical_key, "reject");
  }

  // 3. Unchecked → reject (the lead declined it).
  for (const { canonicalKey, checked: isChecked } of checkboxes) {
    if (isChecked) continue;
    const enacted = await client.reject(
      { canonicalKey, reason: "not approved on the review artifact" },
      actor,
    );
    if (enacted) rejected.push(canonicalKey);
    else tallyConflict(canonicalKey, "reject");
  }

  // 4. Persist the run's final rule-set for next-run seeding (§11.5), preserving
  // the fragmentCount a prior pipeline write recorded for this run. This step
  // runs AFTER the enactment above — a CORRUPT prior manifest must not abort
  // the sync here (the approvals/rejections already happened and the rule-set
  // would be lost), so corruption is warned and treated as "no prior";
  // writeManifest's own repair path then persists a fresh manifest. Any other
  // error (a real fs failure) still propagates.
  if (opts.runStore && opts.runId) {
    let prior: RunManifest | undefined;
    try {
      prior = opts.runStore.readManifest(opts.runId);
    } catch (err) {
      if (!(err instanceof CorruptRunManifestError)) throw err;
      console.warn(
        `[atlas] sync: corrupt prior run manifest for run "${opts.runId}" — treating as no prior and repairing (${err.message})`,
      );
      prior = undefined;
    }
    // A dry-run-only run never wrote a manifest (runHarvest persists it only on
    // a non-dry-run), so a missing prior is a real, reachable state. The ruleSet
    // write must still proceed — fragmentCount degrades to 0 — but stamping that
    // 0 silently would present a fabricated count as recorded fact, so warn.
    if (prior === undefined) {
      console.warn(
        `[atlas] sync: no prior manifest for run "${opts.runId}" — fragmentCount unknown, stamping 0`,
      );
    }
    opts.runStore.writeManifest(opts.runId, {
      fragmentCount: prior?.fragmentCount ?? 0,
      ruleSet: rules,
    });
  }

  return { approved, rejected, excluded: excludedKeys, conflicted };
}
