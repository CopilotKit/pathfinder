// S17 — dedicated unit suite for notion-blocks.ts (the candidate ⇄ Notion-block
// mapping module). notion-blocks.ts carries ~600 LOC of block-serialization
// logic that, prior to this suite, was only exercised TRANSITIVELY through the
// S16 generate/sync tests. This suite pins the module's serialization edge
// cases in isolation, at the exact numeric boundaries the source calls out:
//
//   • the ≤2000-char-per-run split and its EXACT run boundaries (RICH_TEXT_RUN_MAX),
//   • the 100-run cap and the truncation marker (RICH_TEXT_MAX_RUNS),
//   • the `⟦atlas:…⟧` canonical-key marker (delimiter) parse contract,
//   • the `atlas-rule:` bullet delimiter (case / whitespace tolerance),
//   • a full candidate → block → parse round-trip (build ⇄ parse identity),
//   • degenerate inputs (empty strings, exact-boundary lengths, lone surrogates).
//
// This is NEW COVERAGE of EXISTING behavior: every assertion is written against
// what notion-blocks.ts does TODAY (verification = the suite passes green), NOT
// a behavior change (no red-green). notion-blocks.ts is not modified.
//
// Notion is a NON-LLM external service; nothing here calls an LLM, so no aimock.

import { describe, it, expect, vi, afterEach } from "vitest";

import {
  candidateToDoBlock,
  unverifiedNoteBlock,
  buildCandidateBlocks,
  buildExclusionRuleBlocks,
  ruleToBulletText,
  parseRuleFromText,
  parseExclusionRules,
  parseCheckboxState,
  coerceExclusionRule,
  isRuleBulletText,
  extractCanonicalKey,
  flagBadge,
  CANONICAL_KEY_OPEN,
  CANONICAL_KEY_CLOSE,
} from "../atlas/artifact/notion-blocks.js";
import {
  CandidateSchema,
  type Candidate,
  type CandidateFragment,
  type ValidationStatus,
  type KnowledgeType,
  type Confidence,
  type EvidenceItem,
  type Sensitivity,
} from "../atlas/types.js";
import type { ExclusionRule } from "../atlas/exclude.js";
import type {
  BlockObjectResponse,
  ToDoBlockObjectResponse,
  BulletedListItemBlockObjectResponse,
  ParagraphBlockObjectResponse,
} from "@notionhq/client";

// The two run/array caps notion-blocks.ts enforces (mirrored here as local
// constants: the source does not export them, and pinning them by value is the
// point — a change to either cap should visibly break this suite).
const RICH_TEXT_RUN_MAX = 2000;
const RICH_TEXT_MAX_RUNS = 100;
// The generate-time title clamp (TODO_TITLE_MAX in source).
const TODO_TITLE_MAX = 1000;

// ── Candidate builder ─────────────────────────────────────────────────────────
// Mirrors the makeCandidate idiom from atlas-artifact-generate.test.ts so each
// test states only the dimensions it exercises; finalized through the S0
// CandidateSchema so the fixture stays a real Candidate.

interface CandidateOverrides {
  sourcetype?: CandidateFragment["sourcetype"];
  subsystem?: string;
  title?: string;
  content?: string;
  canonical_key?: string;
  rankScore?: number;
  approvable?: boolean;
  sensitivity?: Sensitivity;
  knowledge_type?: KnowledgeType;
  validation_status?: ValidationStatus;
  confidence?: Confidence;
  url?: string;
  evidence?: EvidenceItem[];
}

function makeCandidate(o: CandidateOverrides = {}): Candidate {
  const subsystem = o.subsystem ?? "cpk-runtime";
  const title = o.title ?? "Some distilled claim about the runtime";
  const date = "2026-06-08";
  return CandidateSchema.parse({
    sourcetype: o.sourcetype ?? "github-pr",
    subsystem,
    source_name: o.sourcetype ?? "github-pr",
    repo_url: "https://github.com/CopilotKit/CopilotKit",
    ref: "main",
    title,
    content: o.content ?? "why/how prose explaining the decision",
    provenance: {
      source: o.sourcetype ?? "github-pr",
      url: o.url ?? "https://github.com/CopilotKit/CopilotKit/pull/1746",
      date,
      classification: {
        sensitivity: o.sensitivity ?? "internal",
        knowledge_type: o.knowledge_type ?? "architecture",
        audience: "all-staff",
        validation_status: o.validation_status ?? "source-verified",
        confidence: o.confidence ?? "high",
        provenance_class: "primary",
        freshness: { as_of: date },
      },
    },
    evidence: o.evidence ?? [],
    needsReview: false,
    validationTargets: [],
    canonical_key:
      o.canonical_key ?? `github-pr:${subsystem}:some-distilled-claim`,
    rankScore: o.rankScore ?? 10,
    approvable: o.approvable ?? true,
  });
}

// ── request-block introspection (build side) ───────────────────────────────────
// notion-blocks.ts emits BlockObjectRequest shapes keyed by `type` (e.g.
// `{ type: "to_do", to_do: { rich_text, ... } }`). These pull the run contents /
// children off whatever the block's type key is, without caring which it is.

function runsOf(block: unknown): string[] {
  const b = block as Record<
    string,
    { rich_text?: Array<{ text?: { content?: string } }> }
  >;
  const key = (block as { type?: string }).type as string;
  const rt = b[key]?.rich_text ?? [];
  return rt.map((r) => r.text?.content ?? "");
}

function plainTextOf(block: unknown): string {
  return runsOf(block).join("");
}

function childrenOf(block: unknown): unknown[] {
  const b = block as Record<string, { children?: unknown[] }>;
  const key = (block as { type?: string }).type as string;
  return b[key]?.children ?? [];
}

const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// ── response-block fixtures (parse side) ────────────────────────────────────────
// Minimal BlockObjectResponse shapes carrying only the fields the parse helpers
// read (`type`, the per-type `rich_text[].plain_text`, and `to_do.checked`).

function richTextResponse(plainText: string) {
  return [
    {
      type: "text" as const,
      plain_text: plainText,
      href: null,
      annotations: {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        code: false,
        color: "default" as const,
      },
      text: { content: plainText, link: null },
    },
  ];
}

function toDoResponse(
  plainText: string,
  checked: boolean,
): ToDoBlockObjectResponse {
  return {
    type: "to_do",
    to_do: { rich_text: richTextResponse(plainText), color: "default", checked },
    parent: { type: "page_id", page_id: "p" },
    object: "block",
    id: "todo-id",
    created_time: "2026-06-08T00:00:00.000Z",
    created_by: { object: "user", id: "u" },
    last_edited_time: "2026-06-08T00:00:00.000Z",
    last_edited_by: { object: "user", id: "u" },
    has_children: false,
    in_trash: false,
    archived: false,
  } as ToDoBlockObjectResponse;
}

function bulletResponse(plainText: string): BulletedListItemBlockObjectResponse {
  return {
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: richTextResponse(plainText),
      color: "default",
    },
    parent: { type: "page_id", page_id: "p" },
    object: "block",
    id: "bullet-id",
    created_time: "2026-06-08T00:00:00.000Z",
    created_by: { object: "user", id: "u" },
    last_edited_time: "2026-06-08T00:00:00.000Z",
    last_edited_by: { object: "user", id: "u" },
    has_children: false,
    in_trash: false,
    archived: false,
  } as BulletedListItemBlockObjectResponse;
}

function paragraphResponse(plainText: string): ParagraphBlockObjectResponse {
  return {
    type: "paragraph",
    paragraph: { rich_text: richTextResponse(plainText), color: "default" },
    parent: { type: "page_id", page_id: "p" },
    object: "block",
    id: "para-id",
    created_time: "2026-06-08T00:00:00.000Z",
    created_by: { object: "user", id: "u" },
    last_edited_time: "2026-06-08T00:00:00.000Z",
    last_edited_by: { object: "user", id: "u" },
    has_children: false,
    in_trash: false,
    archived: false,
  } as ParagraphBlockObjectResponse;
}

// ── rich-text run split: exact boundaries (RICH_TEXT_RUN_MAX = 2000) ────────────

describe("notion-blocks — rich-text run split (exact ≤2000-char boundaries)", () => {
  // richText is not exported; it is exercised through candidateToDoBlock, whose
  // text is `⟦atlas:<key>⟧ <title>  <badge>`. To drive the split precisely we
  // feed the whole layout as a long EVIDENCE body (a `thread` item), which flows
  // through richText untouched (no clamp) into a bulleted_list_item child.
  function evidenceBodyBlock(body: string) {
    const c = makeCandidate({
      evidence: [{ kind: "thread", body }],
    });
    const children = childrenOf(candidateToDoBlock(c));
    // children[0] is the provenance callout; children[1] is the first evidence
    // bullet, whose text is `thread: <body>`.
    return children[1];
  }

  it("emits a SINGLE run when the content is exactly at the 2000-char cap (no split)", () => {
    // `thread: ` prefix (8 chars) + body → tune the body so the run is exactly 2000.
    const body = "a".repeat(RICH_TEXT_RUN_MAX - "thread: ".length);
    const runs = runsOf(evidenceBodyBlock(body));
    expect(runs).toHaveLength(1);
    expect(runs[0].length).toBe(RICH_TEXT_RUN_MAX);
  });

  it("splits into TWO runs when the content is one char past the cap", () => {
    const body = "a".repeat(RICH_TEXT_RUN_MAX - "thread: ".length + 1);
    const runs = runsOf(evidenceBodyBlock(body));
    expect(runs).toHaveLength(2);
    expect(runs[0].length).toBe(RICH_TEXT_RUN_MAX);
    expect(runs[1].length).toBe(1);
  });

  it("preserves content byte-for-byte across the split (concatenation is lossless)", () => {
    const body = "ab".repeat(RICH_TEXT_RUN_MAX * 2); // ~8000 chars
    const block = evidenceBodyBlock(body);
    const runs = runsOf(block);
    expect(runs.length).toBeGreaterThan(1);
    // Every non-final run is exactly at the cap; the concatenation reconstructs
    // the full `thread: <body>` line.
    for (const r of runs.slice(0, -1)) {
      expect(r.length).toBeLessThanOrEqual(RICH_TEXT_RUN_MAX);
    }
    expect(runs.join("")).toBe(`thread: ${body}`);
  });

  it("backs off one code unit when the 2000-boundary would split a surrogate pair", () => {
    // Place an astral char (😀 = surrogate pair) so its HIGH half lands at the
    // run-2000 boundary; the run must end at 1999 so the pair rides intact into
    // the next run, and no run may contain a lone surrogate.
    const emoji = "\u{1F600}";
    const filler = "x".repeat(RICH_TEXT_RUN_MAX - "thread: ".length - 1);
    const body = `${filler}${emoji}${"y".repeat(50)}`;
    const runs = runsOf(evidenceBodyBlock(body));
    expect(runs.length).toBeGreaterThan(1);
    for (const r of runs) {
      expect(LONE_SURROGATE_RE.test(r)).toBe(false);
    }
    expect(runs.join("")).toBe(`thread: ${body}`);
  });
});

// ── run-count cap + truncation marker (RICH_TEXT_MAX_RUNS = 100) ────────────────

describe("notion-blocks — 100-run cap with explicit truncation marker", () => {
  function evidenceBodyRuns(body: string): string[] {
    const c = makeCandidate({
      evidence: [{ kind: "thread", body }],
    });
    return runsOf(childrenOf(candidateToDoBlock(c))[1]);
  }

  it("caps a pathological body at 100 runs and marks the truncation", () => {
    // A body far larger than 100 × 2000 chars.
    const body = "z".repeat(RICH_TEXT_RUN_MAX * 200);
    const runs = evidenceBodyRuns(body);
    expect(runs).toHaveLength(RICH_TEXT_MAX_RUNS);
    // The final run is the truncation marker (not raw content).
    expect(runs[RICH_TEXT_MAX_RUNS - 1]).toMatch(
      /^… \[truncated: \d+ more chars\]$/,
    );
    // The 99 runs before it are full-cap content runs.
    for (const r of runs.slice(0, RICH_TEXT_MAX_RUNS - 1)) {
      expect(r.length).toBe(RICH_TEXT_RUN_MAX);
    }
  });

  it("does NOT truncate when the content fits in exactly 100 runs (boundary)", () => {
    // Exactly 100 full runs of content, no marker needed. Body = 100×2000 minus
    // the `thread: ` prefix so the rendered line is exactly 200000 chars.
    const body = "q".repeat(RICH_TEXT_RUN_MAX * RICH_TEXT_MAX_RUNS - "thread: ".length);
    const runs = evidenceBodyRuns(body);
    expect(runs).toHaveLength(RICH_TEXT_MAX_RUNS);
    // No truncation marker: the last run is real content.
    expect(runs[RICH_TEXT_MAX_RUNS - 1]).not.toMatch(/truncated/);
    expect(runs.join("")).toBe(`thread: ${body}`);
  });
});

// ── degenerate inputs (empty / short-path / embedded lone surrogate) ────────────

describe("notion-blocks — degenerate rich-text inputs", () => {
  it("renders a candidate with an EMPTY title without throwing (marker + badge survive)", () => {
    const c = makeCandidate({ title: "" });
    const text = plainTextOf(candidateToDoBlock(c));
    expect(text).toContain(`${CANONICAL_KEY_OPEN}${c.canonical_key}${CANONICAL_KEY_CLOSE}`);
    expect(text).toContain(flagBadge(c));
  });

  it("sanitizes an embedded lone surrogate to U+FFFD on the short (≤2000-char) path", () => {
    // A lone high surrogate mid-title, short enough to take the no-split path.
    const c = makeCandidate({ title: `before\uD83Dafter` });
    const runs = runsOf(candidateToDoBlock(c));
    expect(runs).toHaveLength(1);
    expect(LONE_SURROGATE_RE.test(runs[0])).toBe(false);
    expect(runs[0]).toContain("�");
  });
});

// ── canonical-key marker: the `⟦atlas:…⟧` delimiter parse contract ──────────────

describe("notion-blocks — canonical-key marker (delimiter parse contract)", () => {
  it("extracts the key when the marker OPENS the text", () => {
    expect(
      extractCanonicalKey(`${CANONICAL_KEY_OPEN}github-pr:cpk:x${CANONICAL_KEY_CLOSE} title`),
    ).toBe("github-pr:cpk:x");
  });

  it("tolerates ONLY leading whitespace before the marker", () => {
    expect(
      extractCanonicalKey(`   ${CANONICAL_KEY_OPEN}k${CANONICAL_KEY_CLOSE} rest`),
    ).toBe("k");
  });

  it("returns null when the marker is MID-PROSE (a quoted key is not a record)", () => {
    expect(
      extractCanonicalKey(`follow up on ${CANONICAL_KEY_OPEN}k${CANONICAL_KEY_CLOSE} later`),
    ).toBeNull();
  });

  it("returns null for an EMPTY marker (⟦atlas:⟧) — not an empty-key record", () => {
    expect(extractCanonicalKey(`${CANONICAL_KEY_OPEN}${CANONICAL_KEY_CLOSE} x`)).toBeNull();
  });

  it("returns null for an UNCLOSED marker (no close delimiter)", () => {
    expect(extractCanonicalKey(`${CANONICAL_KEY_OPEN}github-pr:cpk:x no close`)).toBeNull();
  });

  it("returns null for empty text and for plain prose with no marker", () => {
    expect(extractCanonicalKey("")).toBeNull();
    expect(extractCanonicalKey("just a normal human note")).toBeNull();
  });

  it("keeps a key that itself CONTAINS a close bracket up to the FIRST close", () => {
    // The parser stops at the first `⟧`; a key containing the close delimiter
    // truncates there (documents the first-close-wins behavior).
    expect(
      extractCanonicalKey(`${CANONICAL_KEY_OPEN}a${CANONICAL_KEY_CLOSE}b${CANONICAL_KEY_CLOSE}`),
    ).toBe("a");
  });
});

// ── rule bullet: the `atlas-rule:` delimiter (case / whitespace tolerance) ──────

describe("notion-blocks — rule-bullet delimiter tolerance", () => {
  const flagRule: ExclusionRule = {
    kind: "flag",
    dimension: "sensitivity",
    equals: "secret",
  };

  it("serializes a rule to `atlas-rule: <json>` with a single space", () => {
    expect(ruleToBulletText(flagRule)).toBe(`atlas-rule: ${JSON.stringify(flagRule)}`);
  });

  it("parses the canonical serialized form back to the identical rule", () => {
    expect(parseRuleFromText(ruleToBulletText(flagRule))).toEqual(flagRule);
  });

  it("parses a NO-space hand-edit (`atlas-rule:{…}`)", () => {
    expect(parseRuleFromText(`atlas-rule:${JSON.stringify(flagRule)}`)).toEqual(flagRule);
  });

  it("parses EXTRA whitespace after the colon", () => {
    expect(parseRuleFromText(`atlas-rule:   ${JSON.stringify(flagRule)}`)).toEqual(flagRule);
  });

  it("parses a Notion-auto-capitalized prefix (`Atlas-rule:`) case-insensitively", () => {
    expect(parseRuleFromText(`Atlas-rule: ${JSON.stringify(flagRule)}`)).toEqual(flagRule);
  });

  it("ignores a free-form bullet with NO rule prefix (returns null)", () => {
    expect(parseRuleFromText("just a human bullet about the release")).toBeNull();
  });

  it("warns (not silently null) on a rule-prefixed bullet with malformed JSON", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseRuleFromText("atlas-rule: {not valid json")).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("isRuleBulletText recognizes the prefix regardless of JSON validity or case", () => {
    expect(isRuleBulletText("atlas-rule: {}")).toBe(true);
    expect(isRuleBulletText("Atlas-rule:garbage")).toBe(true);
    expect(isRuleBulletText("  atlas-rule: {}")).toBe(true);
    expect(isRuleBulletText("a normal bullet")).toBe(false);
  });
});

// ── full candidate ⇄ block round-trip (build → parse identity) ──────────────────

describe("notion-blocks — candidate ⇄ block round-trip", () => {
  afterEach(() => vi.restoreAllMocks());

  it("round-trips {canonicalKey, checked} through candidateToDoBlock → parseCheckboxState", () => {
    const c = makeCandidate({ canonical_key: "github-pr:cpk-runtime:round-trip" });
    // Build side gives a request block; simulate the fetched response by lifting
    // its rendered text into a to_do RESPONSE (the checkbox the lead checked).
    const built = candidateToDoBlock(c);
    const renderedText = plainTextOf(built);
    const state = parseCheckboxState(toDoResponse(renderedText, true));
    expect(state).toEqual({ canonicalKey: c.canonical_key, checked: true });
  });

  it("preserves an UNCHECKED default through the round-trip", () => {
    const c = makeCandidate();
    const state = parseCheckboxState(
      toDoResponse(plainTextOf(candidateToDoBlock(c)), false),
    );
    expect(state).toEqual({ canonicalKey: c.canonical_key, checked: false });
  });

  it("round-trips a flag AND an english rule through build → parse", () => {
    const rules: ExclusionRule[] = [
      { kind: "flag", dimension: "sensitivity", equals: "secret" },
      { kind: "english", text: "exclude anything about the Athena engagement" },
    ];
    const built = buildExclusionRuleBlocks(rules);
    // built[0] is the heading; built[1..] are the rule bullets. Lift each bullet
    // into a bullet RESPONSE and read them back.
    const responses: BlockObjectResponse[] = built
      .slice(1)
      .map((b) => bulletResponse(plainTextOf(b)));
    expect(parseExclusionRules(responses)).toEqual(rules);
  });

  it("parseExclusionRules skips non-bullet blocks and free-form bullets, keeping order", () => {
    const rule: ExclusionRule = {
      kind: "flag",
      dimension: "sensitivity",
      equals: "secret",
    };
    const blocks: BlockObjectResponse[] = [
      paragraphResponse("intro prose"),
      bulletResponse("a human free-form bullet"),
      bulletResponse(ruleToBulletText(rule)),
      toDoResponse("a checkbox, not a rule", false),
    ];
    expect(parseExclusionRules(blocks)).toEqual([rule]);
  });

  it("a candidate's rendered marker survives clampTitle and parses back (pathological title)", () => {
    // A title far past the generate-time clamp — the marker (first) and badge
    // (last) must both survive so the row still parses as its candidate.
    const c = makeCandidate({
      title: "T".repeat(TODO_TITLE_MAX * 5),
      canonical_key: "github-pr:cpk-runtime:huge-title",
    });
    const rendered = plainTextOf(candidateToDoBlock(c));
    expect(parseCheckboxState(toDoResponse(rendered, true))).toEqual({
      canonicalKey: c.canonical_key,
      checked: true,
    });
    // The badge (load-bearing security metadata) is still present at the tail.
    expect(rendered).toContain(flagBadge(c));
  });
});

// ── grouped block list: order + non-checkable notes (structure round-trip) ──────

describe("notion-blocks — buildCandidateBlocks structure", () => {
  it("groups by subsystem (alpha) with a heading, candidates ranked desc within a group", () => {
    const blocks = buildCandidateBlocks([
      makeCandidate({ subsystem: "zeta", canonical_key: "k:zeta:1", rankScore: 1 }),
      makeCandidate({ subsystem: "alpha", canonical_key: "k:alpha:lo", rankScore: 2 }),
      makeCandidate({ subsystem: "alpha", canonical_key: "k:alpha:hi", rankScore: 9 }),
    ]);
    // heading(alpha), todo(hi), todo(lo), heading(zeta), todo(1)
    expect((blocks[0] as { type: string }).type).toBe("heading_2");
    expect(plainTextOf(blocks[0])).toBe("alpha");
    expect(extractCanonicalKey(plainTextOf(blocks[1]))).toBe("k:alpha:hi");
    expect(extractCanonicalKey(plainTextOf(blocks[2]))).toBe("k:alpha:lo");
    expect(plainTextOf(blocks[3])).toBe("zeta");
    expect(extractCanonicalKey(plainTextOf(blocks[4]))).toBe("k:zeta:1");
  });

  it("renders a non-approvable candidate as a NON-checkable callout note (not a to_do)", () => {
    const c = makeCandidate({ approvable: false, canonical_key: "k:cpk:unverified" });
    const built = unverifiedNoteBlock(c);
    expect((built as { type: string }).type).toBe("callout");
    const text = plainTextOf(built);
    expect(text).toContain("unverified (not approvable)");
    // parseCheckboxState only reads to_do blocks, so an unverified note (as a
    // fetched paragraph/callout, never a to_do) can never be approved.
    expect(parseCheckboxState(paragraphResponse(text))).toBeNull();
  });

  it("emits an empty block list for no candidates (degenerate)", () => {
    expect(buildCandidateBlocks([])).toEqual([]);
  });
});

// ── coerceExclusionRule: representative validation seams ────────────────────────
// The generate suite exhaustively covers coerceExclusionRule; here we pin only
// the seams parseRuleFromText routes through, so the delimiter tests above have
// a documented validation floor in THIS file.

describe("notion-blocks — coerceExclusionRule validation floor", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts a valid flag rule and a valid english rule", () => {
    expect(
      coerceExclusionRule({ kind: "flag", dimension: "sensitivity", equals: "secret" }),
    ).toEqual({ kind: "flag", dimension: "sensitivity", equals: "secret" });
    expect(coerceExclusionRule({ kind: "english", text: "drop X" })).toEqual({
      kind: "english",
      text: "drop X",
    });
  });

  it("warns and drops an out-of-enum flag `equals` (could never fire)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      coerceExclusionRule({ kind: "flag", dimension: "sensitivity", equals: "secrt" }),
    ).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("warns and drops an empty/whitespace english `text` (no instruction)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(coerceExclusionRule({ kind: "english", text: "   " })).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("warns and drops a non-object input", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(coerceExclusionRule(42)).toBeNull();
    expect(coerceExclusionRule(null)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
