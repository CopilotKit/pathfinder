// S16 — approval-artifact generate + Notion-block mapping.
//
// Two units under test:
//   • notion-blocks.ts — the BIDIRECTIONAL candidate ⇄ Notion-block mapping
//     (shared with S17's sync slot). We assert the BUILD side here (candidate →
//     to_do, rule → bullet, unverified fact → non-checkable note) AND the PARSE
//     side (fetched to_do → {canonicalKey, checked}; fetched bullets →
//     ExclusionRule[]) since S17 depends on parse round-tripping the build.
//   • generate.ts — generateApprovalArtifact, which assembles the create-page
//     payload: Exclusion-Rules section FIRST (seeded from the prior run's
//     manifest ruleSet + DEFAULT_EXCLUSION_RULES), candidates grouped by
//     subsystem in ranked order, each an inline-flagged to_do, unverified
//     behavior facts rendered non-checkable.
//
// Notion is a NON-LLM external service, so the client is mocked with vi.fn
// (org rule: aimock is only for LLM calls).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@notionhq/client";
import type {
  BlockObjectResponse,
  ToDoBlockObjectResponse,
  BulletedListItemBlockObjectResponse,
} from "@notionhq/client";

import {
  candidateToDoBlock,
  unverifiedNoteBlock,
  buildExclusionRuleBlocks,
  buildCandidateBlocks,
  ruleToBulletText,
  parseRuleFromText,
  parseExclusionRules,
  parseCheckboxState,
  coerceExclusionRule,
  flagBadge,
  CANONICAL_KEY_OPEN,
  CANONICAL_KEY_CLOSE,
} from "../atlas/artifact/notion-blocks.js";
import { generateApprovalArtifact } from "../atlas/artifact/generate.js";
import { parseFlagBadge } from "../atlas/artifact/sync.js";
import { RunStore } from "../atlas/run-store.js";
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
import {
  DEFAULT_EXCLUSION_RULES,
  type ExclusionRule,
} from "../atlas/exclude.js";

// ── Candidate builder ───────────────────────────────────────────────────────
// Mirrors the makeFragment idiom from atlas-canonicalize.test.ts, then finalizes
// into a Candidate (canonical_key/rankScore/approvable) so each test states only
// the dimensions it exercises. Validated against the S0 CandidateSchema.

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

// ── Notion response-block fixtures (the PARSE side, used by S17) ──────────────

function toDoResponse(
  plainText: string,
  checked: boolean,
): ToDoBlockObjectResponse {
  return {
    type: "to_do",
    to_do: {
      rich_text: [
        {
          type: "text",
          plain_text: plainText,
          href: null,
          annotations: {
            bold: false,
            italic: false,
            strikethrough: false,
            underline: false,
            code: false,
            color: "default",
          },
          text: { content: plainText, link: null },
        },
      ],
      color: "default",
      checked,
    },
    parent: { type: "page_id", page_id: "p" },
    object: "block",
    id: "block-id",
    created_time: "2026-06-08T00:00:00.000Z",
    created_by: { object: "user", id: "u" },
    last_edited_time: "2026-06-08T00:00:00.000Z",
    last_edited_by: { object: "user", id: "u" },
    has_children: false,
    in_trash: false,
    archived: false,
  } as ToDoBlockObjectResponse;
}

function bulletResponse(
  plainText: string,
): BulletedListItemBlockObjectResponse {
  return {
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: [
        {
          type: "text",
          plain_text: plainText,
          href: null,
          annotations: {
            bold: false,
            italic: false,
            strikethrough: false,
            underline: false,
            code: false,
            color: "default",
          },
          text: { content: plainText, link: null },
        },
      ],
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

// Pull the first rich-text plain string out of a request block (build side).
function plainTextOf(block: unknown): string {
  const b = block as Record<
    string,
    { rich_text?: Array<{ text?: { content?: string } }> }
  >;
  const key = (block as { type?: string }).type as string;
  const rt = b[key]?.rich_text ?? [];
  return rt.map((r) => r.text?.content ?? "").join("");
}

// Pull the rich-text run contents out of a request block (build side) — used to
// assert the Notion 2000-char-per-run clamp.
function richTextRunsOf(block: unknown): string[] {
  const b = block as Record<
    string,
    { rich_text?: Array<{ text?: { content?: string } }> }
  >;
  const key = (block as { type?: string }).type as string;
  const rt = b[key]?.rich_text ?? [];
  return rt.map((r) => r.text?.content ?? "");
}

// Matches any LONE surrogate (a high not followed by a low, or a low not
// preceded by a high) — i.e. malformed UTF-16. Mirrors the well-formed check in
// rag-dedup.ts / notion-blocks.ts.
const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// Count a request block's nested children (build side) — used to assert the
// per-block children cap and the per-request TOTAL block budget.
function childCountOf(block: unknown): number {
  const b = block as Record<string, { children?: unknown[] }>;
  const key = (block as { type?: string }).type as string;
  return (b[key]?.children ?? []).length;
}

// A block's TOTAL block count including ALL descendants at any depth (self + a
// recursive walk of every `children` array). Candidate to_dos now nest a
// `toggle` whose own paragraph children are a second level (to_do → toggle →
// paragraph), so the per-request budget must count them — mirrors generate.ts's
// recursive `blockCost`.
function deepBlockCount(block: unknown): number {
  const b = block as Record<string, { children?: unknown[] }>;
  const key = (block as { type?: string }).type as string;
  const children = b[key]?.children ?? [];
  let count = 1;
  for (const child of children) count += deepBlockCount(child);
  return count;
}

describe("notion-blocks — build side (candidate → blocks)", () => {
  it("renders an APPROVABLE candidate as a to_do checkbox, unchecked by default", () => {
    const c = makeCandidate({ title: "Two-layer shim to the v2 engine" });
    const block = candidateToDoBlock(c);
    expect((block as { type: string }).type).toBe("to_do");
    const todo = (block as { to_do: { checked: boolean } }).to_do;
    expect(todo.checked).toBe(false);
  });

  it("embeds the canonical_key in the to_do text so S17 can parse it back", () => {
    const c = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:two-layer-shim",
    });
    const block = candidateToDoBlock(c);
    const text = plainTextOf(block);
    expect(text).toContain(
      `${CANONICAL_KEY_OPEN}github-pr:cpk-runtime:two-layer-shim${CANONICAL_KEY_CLOSE}`,
    );
    expect(text).toContain("Some distilled claim about the runtime");
  });

  it("renders the classification flags inline (sensitivity / knowledge_type / validation / confidence)", () => {
    const c = makeCandidate({
      sensitivity: "internal",
      knowledge_type: "architecture",
      validation_status: "showcase-verified",
      confidence: "high",
    });
    const text = plainTextOf(candidateToDoBlock(c));
    expect(text).toContain("internal");
    expect(text).toContain("architecture");
    expect(text).toContain("showcase-verified");
    expect(text).toContain("high");
  });

  it("renders provenance + evidence inline as child blocks of the to_do", () => {
    const c = makeCandidate({
      url: "https://github.com/CopilotKit/CopilotKit/pull/1746",
      evidence: [
        { kind: "changed_file", path: "packages/runtime/src/index.ts" },
        { kind: "linked_issue", url: "https://github.com/x/y/issues/1" },
      ],
    });
    const block = candidateToDoBlock(c) as {
      to_do: { children?: unknown[] };
    };
    const children = block.to_do.children ?? [];
    expect(children.length).toBeGreaterThan(0);
    const childText = children.map((ch) => plainTextOf(ch)).join("\n");
    // Provenance URL is surfaced.
    expect(childText).toContain(
      "https://github.com/CopilotKit/CopilotKit/pull/1746",
    );
    // Each evidence item is rendered.
    expect(childText).toContain("packages/runtime/src/index.ts");
    expect(childText).toContain("https://github.com/x/y/issues/1");
  });

  it("renders an UNVERIFIED behavior fact as a NON-checkable note (not a to_do)", () => {
    const c = makeCandidate({
      approvable: false,
      knowledge_type: "architecture",
      validation_status: "unverified",
      title: "CopilotNext does X",
    });
    const block = unverifiedNoteBlock(c);
    expect((block as { type: string }).type).not.toBe("to_do");
    // It should still carry the canonical_key + title for the reviewer.
    const text = plainTextOf(block);
    expect(text).toContain("CopilotNext does X");
    expect(text).toContain(
      `${CANONICAL_KEY_OPEN}${c.canonical_key}${CANONICAL_KEY_CLOSE}`,
    );
  });
});

describe("notion-blocks — 2000-char rich-text clamp (Notion API limit)", () => {
  it("splits an oversized thread-evidence body into ≤2000-char runs, content preserved", () => {
    const body = "x".repeat(5000);
    const c = makeCandidate({
      evidence: [{ kind: "thread", body }],
    });
    const block = candidateToDoBlock(c) as {
      to_do: { children?: unknown[] };
    };
    const children = block.to_do.children ?? [];
    // Find the evidence bullet carrying the thread body.
    const evidenceBullet = children.find((ch) =>
      plainTextOf(ch).includes("thread:"),
    );
    expect(evidenceBullet).toBeDefined();
    const runs = richTextRunsOf(evidenceBullet);
    expect(runs.length).toBeGreaterThan(1);
    for (const run of runs) {
      expect(run.length).toBeLessThanOrEqual(2000);
    }
    // The full body is preserved across the split runs (no truncation).
    expect(runs.join("")).toBe(`thread: ${body}`);
  });

  it("splits an oversized english-rule bullet JSON into ≤2000-char runs that still round-trip", () => {
    const rule: ExclusionRule = {
      kind: "english",
      text: "Exclude " + "very ".repeat(800) + "long instruction.",
    };
    const blocks = buildExclusionRuleBlocks([rule]);
    const bullet = blocks.find(
      (b) => (b as { type: string }).type === "bulleted_list_item",
    );
    expect(bullet).toBeDefined();
    const runs = richTextRunsOf(bullet);
    expect(runs.length).toBeGreaterThan(1);
    for (const run of runs) {
      expect(run.length).toBeLessThanOrEqual(2000);
    }
    // Notion concatenates runs for plain_text, so the parse side still
    // round-trips the rule losslessly.
    expect(parseRuleFromText(runs.join(""))).toEqual(rule);
  });

  it("never splits a surrogate pair at the 2000-char run boundary (emoji-safe)", () => {
    // "thread: " is 8 chars, so 1991 x's put the emoji's HIGH surrogate exactly
    // at code-unit index 1999 of the rendered evidence line — a naive 2000-slice
    // cuts between the surrogates, leaving a lone high surrogate at the end of
    // run 1 and a lone low surrogate at the start of run 2 (Notion 400s / renders
    // U+FFFD, and the round-trip is lossy).
    const body = "x".repeat(1991) + "\u{1F600}" + "y".repeat(50);
    const c = makeCandidate({ evidence: [{ kind: "thread", body }] });
    const block = candidateToDoBlock(c) as {
      to_do: { children?: unknown[] };
    };
    const children = block.to_do.children ?? [];
    const bullet = children.find((ch) => plainTextOf(ch).includes("thread:"));
    expect(bullet).toBeDefined();
    const runs = richTextRunsOf(bullet);
    expect(runs.length).toBeGreaterThan(1);
    for (const run of runs) {
      // The surrogate backoff must never emit an EMPTY run (Notion rejects
      // empty rich-text content).
      expect(run.length).toBeGreaterThan(0);
      expect(run.length).toBeLessThanOrEqual(2000);
      // No run may end on a lone high surrogate or start on a lone low one.
      expect(/[\uD800-\uDBFF]$/.test(run)).toBe(false);
      expect(/^[\uDC00-\uDFFF]/.test(run)).toBe(false);
    }
    // Lossless concatenation across the surrogate-safe split.
    expect(runs.join("")).toBe(`thread: ${body}`);
  });

  it("sanitizes an EMBEDDED lone surrogate to U+FFFD on the short (≤2000-char) path — every run is well-formed UTF-16", () => {
    // Y15: the boundary backoff only protects run EDGES; a lone surrogate
    // already embedded mid-content in malformed upstream text rides through the
    // ≤2000-char path untouched and 400s the whole page create at Notion. The
    // same input class fix8 declared reachable for the rag-dedup probe text
    // flows here too.
    const body = "upstream-mangled \uD83D text"; // lone HIGH surrogate mid-content
    const c = makeCandidate({ evidence: [{ kind: "thread", body }] });
    const block = candidateToDoBlock(c) as {
      to_do: { children?: unknown[] };
    };
    const children = block.to_do.children ?? [];
    const bullet = children.find((ch) => plainTextOf(ch).includes("thread:"));
    expect(bullet).toBeDefined();
    const runs = richTextRunsOf(bullet);
    for (const run of runs) {
      expect(LONE_SURROGATE_RE.test(run)).toBe(false);
    }
    // The lone surrogate is sanitized to the replacement char, not dropped.
    expect(runs.join("")).toBe("thread: upstream-mangled � text");
  });

  it("sanitizes an EMBEDDED lone surrogate on the SPLIT (>2000-char) path too", () => {
    const body = "x".repeat(1000) + "\uDC00" + "y".repeat(2000); // lone LOW surrogate mid-content
    const c = makeCandidate({ evidence: [{ kind: "thread", body }] });
    const block = candidateToDoBlock(c) as {
      to_do: { children?: unknown[] };
    };
    const children = block.to_do.children ?? [];
    const bullet = children.find((ch) => plainTextOf(ch).includes("thread:"));
    expect(bullet).toBeDefined();
    const runs = richTextRunsOf(bullet);
    expect(runs.length).toBeGreaterThan(1);
    for (const run of runs) {
      expect(LONE_SURROGATE_RE.test(run)).toBe(false);
    }
    // Length-preserving sanitize (U+FFFD replaces the lone surrogate 1:1).
    expect(runs.join("").length).toBe(`thread: ${body}`.length);
    expect(runs.join("")).toContain("�");
  });

  it("caps the rich_text array at 100 runs, replacing the tail with an explicit truncation marker (Notion 100-element limit)", () => {
    // Notion caps a block's rich_text array at 100 elements — an uncapped
    // split of a pathological >200k-char body emits 100+ runs and 400s the
    // whole batch request. The split must cap at 100 runs total, with the
    // FINAL run carrying an explicit truncation marker (a marked truncation
    // beats a 400; the round-trip is already lossy past Notion's own caps).
    const body = "x".repeat(250000);
    const c = makeCandidate({ evidence: [{ kind: "thread", body }] });
    const block = candidateToDoBlock(c) as {
      to_do: { children?: unknown[] };
    };
    const children = block.to_do.children ?? [];
    const bullet = children.find((ch) => plainTextOf(ch).includes("thread:"));
    expect(bullet).toBeDefined();
    const runs = richTextRunsOf(bullet);
    expect(runs.length).toBe(100);
    for (const run of runs) {
      expect(run.length).toBeLessThanOrEqual(2000);
    }
    // The last run is the truncation marker, naming the dropped char count.
    expect(runs[runs.length - 1]).toMatch(/truncated: \d+ more chars/);
    // Everything BEFORE the marker is a clean prefix of the original line.
    expect(`thread: ${body}`.startsWith(runs.slice(0, -1).join(""))).toBe(true);
  });

  it("clamps a pathological TITLE at generate time so the trailing flag badge always survives the run budget (Z6)", () => {
    // The to_do/note text is `⟦marker⟧ title  badge` — badge LAST. Without a
    // generate-time title clamp, a >100×2000-char title pushes the badge past
    // the 100-run cap: the marker (first) survives, the badge is severed, and
    // the row still parses as a candidate — but badge-less, so sync's neutral
    // default launders a secret-classified candidate past its exclusion
    // rules. The badge is load-bearing security metadata; the title is
    // display-only, so the title is the safe lossy edge.
    const c = makeCandidate({
      title: "x".repeat(250000),
      sensitivity: "secret",
    });
    for (const block of [candidateToDoBlock(c), unverifiedNoteBlock(c)]) {
      const text = richTextRunsOf(block).join("");
      // The canonical-key marker still OPENS the text…
      expect(
        text.startsWith(
          `${CANONICAL_KEY_OPEN}${c.canonical_key}${CANONICAL_KEY_CLOSE}`,
        ),
      ).toBe(true);
      // …and the FULL flag badge survives (no severed/truncated badge).
      expect(text).toContain(flagBadge(c));
    }
  });

  it("clamps a title WITHOUT splitting a surrogate pair at the clamp boundary (no U+FFFD before the ellipsis)", () => {
    // An astral char (surrogate PAIR) straddling the clamp boundary: a naive
    // `slice(0, max)` keeps only the lone HIGH surrogate, which richText's
    // entry sanitize then renders as U+FFFD ("�…") in the to_do text. The
    // clamp must back off one unit so the pair is dropped whole.
    const title = "x".repeat(999) + "🚀" + "y".repeat(50); // 🚀 spans indices 999–1000
    const c = makeCandidate({ title, sensitivity: "secret" });
    for (const block of [candidateToDoBlock(c), unverifiedNoteBlock(c)]) {
      const runs = richTextRunsOf(block);
      const text = runs.join("");
      // Well-formed: no lone surrogate in any run, and no replacement char
      // (a U+FFFD would mean the clamp split the pair and sanitize mangled it).
      for (const run of runs) {
        expect(LONE_SURROGATE_RE.test(run)).toBe(false);
      }
      expect(text).not.toContain("�");
      // The clamp still happened (ellipsis present, tail dropped)…
      expect(text).toContain("…");
      expect(text).not.toContain("y");
      // …and the FULL flag badge survives intact.
      expect(text).toContain(flagBadge(c));
    }
  });
});

describe("notion-blocks — per-block children cap (Notion ~100-children limit)", () => {
  it("caps an evidence-heavy candidate's children and appends an '…and N more' tail bullet", () => {
    const evidence: EvidenceItem[] = Array.from({ length: 150 }, (_, i) => ({
      kind: "fused_from" as const,
      ref: `fragment-ref-${i}`,
    }));
    // Empty content ⇒ no leading content-toggle child, so this test's indices
    // address the provenance callout + evidence bullets directly (this case is
    // about the EVIDENCE cap, not the body toggle).
    const c = makeCandidate({ evidence, content: "" });
    const block = candidateToDoBlock(c) as {
      to_do: { children?: unknown[] };
    };
    const children = block.to_do.children ?? [];
    // Notion caps a block's children at ~100; the raw render would be 151.
    expect(children.length).toBeLessThanOrEqual(100);
    const texts = children.map((ch) => plainTextOf(ch));
    // Provenance callout stays first; evidence order is preserved up to the cap.
    expect(texts[0]).toContain("source:");
    for (let i = 0; i < 95; i++) {
      expect(texts[1 + i]).toContain(`fragment-ref-${i}`);
    }
    // The omitted remainder is surfaced, not silently dropped.
    expect(texts[texts.length - 1]).toContain("and 55 more evidence items");
  });

  it("leaves a small evidence list uncapped, with no tail bullet", () => {
    const c = makeCandidate({
      content: "", // no body toggle — this test counts provenance + evidence
      evidence: [
        { kind: "fused_from", ref: "a" },
        { kind: "fused_from", ref: "b" },
      ],
    });
    const block = candidateToDoBlock(c) as {
      to_do: { children?: unknown[] };
    };
    const children = block.to_do.children ?? [];
    expect(children).toHaveLength(3); // provenance callout + 2 evidence bullets
    const allText = children.map((ch) => plainTextOf(ch)).join("\n");
    expect(allText).not.toContain("more evidence items");
  });
});

describe("flag badge — generate → sync round-trip (load-bearing for flag rules)", () => {
  it("parses back the exact classification the build side rendered", () => {
    const c = makeCandidate({
      sensitivity: "secret",
      knowledge_type: "architecture",
      validation_status: "showcase-verified",
      confidence: "high",
    });
    const badge = flagBadge(c);
    const parsed = parseFlagBadge(badge);
    expect(parsed).toEqual({
      sensitivity: "secret",
      knowledge_type: "architecture",
      validation_status: "showcase-verified",
      confidence: "high",
    });
  });

  it("locates the badge at end-of-string even when the title contains brackets", () => {
    const c = makeCandidate({
      title: "[bugfix] handle [a] and [b]",
      sensitivity: "proprietary",
      knowledge_type: "design-rationale",
      validation_status: "source-verified",
      confidence: "medium",
    });
    // The full to_do text the build side renders: marker + bracketed title + badge.
    const text = plainTextOf(candidateToDoBlock(c));
    const parsed = parseFlagBadge(text);
    expect(parsed).toEqual({
      sensitivity: "proprietary",
      knowledge_type: "design-rationale",
      validation_status: "source-verified",
      confidence: "medium",
    });
  });
});

describe("notion-blocks — exclusion-rule round-trip (flag + english)", () => {
  it("round-trips a flag rule through bullet text", () => {
    const rule: ExclusionRule = {
      kind: "flag",
      dimension: "sensitivity",
      equals: "secret",
    };
    const text = ruleToBulletText(rule);
    const parsed = parseRuleFromText(text);
    expect(parsed).toEqual(rule);
  });

  it("round-trips an english rule through bullet text", () => {
    const rule: ExclusionRule = {
      kind: "english",
      text: "Exclude anything about the Athena engagement.",
    };
    const text = ruleToBulletText(rule);
    const parsed = parseRuleFromText(text);
    expect(parsed).toEqual(rule);
  });

  it("warns (not silently null) when a rule-prefixed bullet carries malformed JSON", () => {
    // A lead typo'd the JSON of a bullet they clearly intended as a rule (it has
    // the rule prefix). Dropping it silently loses the lead's intended rule, so it
    // must warn before returning null — mirroring coerceExclusionRule's warn.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const malformed = "atlas-rule: {kind:'flag', dimension: sensitivity}"; // not valid JSON
    const parsed = parseRuleFromText(malformed);
    expect(parsed).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("atlas-rule");
    warn.mockRestore();
  });

  it("warns and drops an EMPTY-text english rule bullet (no instruction to evaluate)", () => {
    // A hand-edited bullet like `atlas-rule: {"kind":"english","text":""}` is
    // syntactically valid JSON but carries NO instruction — accepted, it would
    // bill an LLM call per candidate with undefined judgment and be re-seeded
    // by §11.5 forever. It must be warned and dropped, like every other
    // can-never-usefully-fire shape.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      parseRuleFromText('atlas-rule: {"kind":"english","text":""}'),
    ).toBeNull();
    expect(
      parseRuleFromText('atlas-rule: {"kind":"english","text":"   "}'),
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain(
      "no instruction to evaluate",
    );
    warn.mockRestore();
  });

  it("parses a rule bullet whose prefix has no space after the colon (hand-edited)", () => {
    // A lead hand-editing a bullet may drop the space after `atlas-rule:` — the
    // rule must still parse rather than silently becoming prose.
    const parsed = parseRuleFromText(
      'atlas-rule:{"kind":"english","text":"x"}',
    );
    expect(parsed).toEqual({ kind: "english", text: "x" });
  });

  it("parses a rule bullet with extra whitespace after the prefix colon", () => {
    const parsed = parseRuleFromText(
      'atlas-rule:    {"kind":"flag","dimension":"sensitivity","equals":"secret"}',
    );
    expect(parsed).toEqual({
      kind: "flag",
      dimension: "sensitivity",
      equals: "secret",
    });
  });

  it("parses a rule bullet whose prefix Notion auto-capitalized (`Atlas-rule:`) — case-insensitive prefix (Z9)", () => {
    // The approval page is hand-edited BY DESIGN, and Notion auto-capitalizes
    // the first letter of a typed line — a hand-typed `Atlas-rule: {…}` must
    // parse as a rule, not silently demote to a plain bullet.
    const rule: ExclusionRule = {
      kind: "flag",
      dimension: "sensitivity",
      equals: "secret",
    };
    const capitalized = `A${ruleToBulletText(rule).slice(1)}`; // "Atlas-rule: {…}"
    expect(parseRuleFromText(capitalized)).toEqual(rule);
  });

  it("buildExclusionRuleBlocks emits a heading + one editable bullet per rule", () => {
    const rules: ExclusionRule[] = [
      { kind: "flag", dimension: "sensitivity", equals: "secret" },
      { kind: "english", text: "Exclude the Athena engagement." },
    ];
    const blocks = buildExclusionRuleBlocks(rules);
    const types = blocks.map((b) => (b as { type: string }).type);
    expect(types[0]).toBe("heading_2");
    const bullets = blocks.filter(
      (b) => (b as { type: string }).type === "bulleted_list_item",
    );
    expect(bullets).toHaveLength(2);
  });

  it("parseExclusionRules reads rules back from fetched bullet blocks (S17 path)", () => {
    const rules: ExclusionRule[] = [
      { kind: "flag", dimension: "knowledge_type", equals: "gtm" },
      { kind: "english", text: "Exclude customer-identifying deal content." },
    ];
    const responseBlocks: BlockObjectResponse[] = rules.map((r) =>
      bulletResponse(ruleToBulletText(r)),
    );
    const parsed = parseExclusionRules(responseBlocks);
    expect(parsed).toEqual(rules);
  });

  it("parseExclusionRules ignores non-bullet blocks (headings, todos, free text)", () => {
    const blocks: BlockObjectResponse[] = [
      bulletResponse(ruleToBulletText({ kind: "english", text: "Exclude X." })),
      toDoResponse("a candidate checkbox", true),
      // A free-form bullet a human added that is not a rule marker → skipped.
      bulletResponse("just a note the lead jotted down"),
    ];
    const parsed = parseExclusionRules(blocks);
    expect(parsed).toEqual([{ kind: "english", text: "Exclude X." }]);
  });
});

describe("coerceExclusionRule — warns on EVERY malformed shape (no silent drops)", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("warns and drops a flag rule with a missing equals", () => {
    expect(
      coerceExclusionRule({ kind: "flag", dimension: "sensitivity" }),
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("warns and drops a flag rule with a non-string equals", () => {
    expect(
      coerceExclusionRule({
        kind: "flag",
        dimension: "sensitivity",
        equals: 42,
      }),
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("warns and drops a flag rule with a non-string dimension", () => {
    expect(
      coerceExclusionRule({ kind: "flag", dimension: 42, equals: "secret" }),
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("warns and drops a flag rule with an unknown dimension (existing behavior)", () => {
    expect(
      coerceExclusionRule({
        kind: "flag",
        dimension: "sensitvity",
        equals: "secret",
      }),
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("sensitvity");
  });

  it("warns and drops a flag rule whose `equals` is outside the dimension's enum (could never fire, Z7)", () => {
    // A `sensitivity=secrt` typo can never match any row's classification —
    // accepted, it would sit permanently inert in the rule-set AND be
    // re-seeded into every next run's artifact (§11.5). Same can-never-fire
    // rationale that already rejects freshness/audience/provenance_class.
    expect(
      coerceExclusionRule({
        kind: "flag",
        dimension: "sensitivity",
        equals: "secrt",
      }),
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("secrt");
    // The warn names the dimension's allowed values so the lead can fix it.
    expect(String(warn.mock.calls[0][0])).toContain("secret");
  });

  it("warns and drops an out-of-enum `equals` on every badge dimension (Z7)", () => {
    expect(
      coerceExclusionRule({
        kind: "flag",
        dimension: "knowledge_type",
        equals: "gtm-stuff",
      }),
    ).toBeNull();
    expect(
      coerceExclusionRule({
        kind: "flag",
        dimension: "validation_status",
        equals: "verified",
      }),
    ).toBeNull();
    expect(
      coerceExclusionRule({
        kind: "flag",
        dimension: "confidence",
        equals: "High",
      }),
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("warns and drops a freshness-dimension flag rule (representable but never matchable)", () => {
    // `freshness` IS a Classification key, but its value is an object — a flag
    // rule's string-equality predicate can never match it, so accepting the rule
    // would silently never fire.
    expect(
      coerceExclusionRule({
        kind: "flag",
        dimension: "freshness",
        equals: "x",
      }),
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("freshness");
  });

  it("warns and drops an audience-dimension flag rule (the approval-page badge does not round-trip it)", () => {
    // The badge round-trips only sensitivity/knowledge_type/validation_status/
    // confidence; sync reconstructs `audience` as a synthetic default, so an
    // audience flag rule would judge a constant — accepted, it sits in the
    // rule-set silently mis-judging every row.
    expect(
      coerceExclusionRule({
        kind: "flag",
        dimension: "audience",
        equals: "all-staff",
      }),
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("audience");
    expect(String(warn.mock.calls[0][0])).toContain("badge");
  });

  it("warns and drops a provenance_class-dimension flag rule (sync judges a synthetic default)", () => {
    // `provenance_class=primary` can NEVER match at sync (the synthetic
    // default is `derived`), and `=derived` matches EVERY row — either way the
    // rule does not express the lead's intent.
    expect(
      coerceExclusionRule({
        kind: "flag",
        dimension: "provenance_class",
        equals: "primary",
      }),
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("provenance_class");
    expect(String(warn.mock.calls[0][0])).toContain("badge");
  });

  it("warns and drops an english rule with a non-string text", () => {
    expect(coerceExclusionRule({ kind: "english", text: 42 })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("warns and drops an english rule with EMPTY text (no instruction to evaluate)", () => {
    // An empty instruction can never usefully fire — exclude.ts bills one LLM
    // call per candidate to evaluate `text`, and an empty instruction is
    // UNDEFINED judgment; accepted, §11.5 would re-seed it into every next run.
    // Same can-never-usefully-fire rationale as the out-of-enum `equals` (Z7).
    expect(coerceExclusionRule({ kind: "english", text: "" })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(
      "no instruction to evaluate",
    );
  });

  it("warns and drops an english rule with WHITESPACE-ONLY text", () => {
    expect(coerceExclusionRule({ kind: "english", text: "   " })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(
      "no instruction to evaluate",
    );
  });

  it("accepts an english rule with padded-but-real text VERBATIM (emptiness check only — no trim of the value)", () => {
    expect(
      coerceExclusionRule({ kind: "english", text: " Exclude X. " }),
    ).toEqual({ kind: "english", text: " Exclude X. " });
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns and drops an unknown kind", () => {
    expect(coerceExclusionRule({ kind: "banana" })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("banana");
  });

  it("warns and drops a non-object input", () => {
    expect(coerceExclusionRule("not an object")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does NOT warn on a valid rule", () => {
    expect(
      coerceExclusionRule({
        kind: "flag",
        dimension: "sensitivity",
        equals: "secret",
      }),
    ).toEqual({ kind: "flag", dimension: "sensitivity", equals: "secret" });
    expect(
      coerceExclusionRule({ kind: "english", text: "Exclude X." }),
    ).toEqual({ kind: "english", text: "Exclude X." });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("notion-blocks — checkbox-state parse (S17 path)", () => {
  it("parses {canonicalKey, checked} from a fetched to_do block", () => {
    const c = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:two-layer-shim",
    });
    // Build → render text → simulate the fetched response of that same text.
    const text = plainTextOf(candidateToDoBlock(c));
    const checkedState = parseCheckboxState(toDoResponse(text, true));
    expect(checkedState).toEqual({
      canonicalKey: "github-pr:cpk-runtime:two-layer-shim",
      checked: true,
    });
    const uncheckedState = parseCheckboxState(toDoResponse(text, false));
    expect(uncheckedState).toEqual({
      canonicalKey: "github-pr:cpk-runtime:two-layer-shim",
      checked: false,
    });
  });

  it("returns null for a to_do block with no canonical-key marker", () => {
    expect(parseCheckboxState(toDoResponse("free text, no marker", true))).toBe(
      null,
    );
  });

  it("returns null for a non-to_do block", () => {
    expect(parseCheckboxState(bulletResponse("a bullet"))).toBe(null);
  });

  it("returns null for an EMPTY canonical-key marker (⟦atlas:⟧)", () => {
    // An empty key must not yield "" (which would drive approve/reject on a blank
    // key); it parses as if there were no marker at all.
    const text = `${CANONICAL_KEY_OPEN}${CANONICAL_KEY_CLOSE} a title`;
    expect(parseCheckboxState(toDoResponse(text, true))).toBe(null);
  });

  it("returns null when the marker is MID-PROSE (a hand-typed note quoting a key is not a candidate)", () => {
    // Y6: the marker must be FIRST (after leading whitespace) — the docs say so,
    // and the parser must enforce it. Under an anywhere-offset match, the lead's
    // hand-typed unchecked note quoting a key would REJECT that candidate.
    const text = `follow up on ${CANONICAL_KEY_OPEN}github-pr:auth:x${CANONICAL_KEY_CLOSE} tomorrow`;
    expect(parseCheckboxState(toDoResponse(text, false))).toBe(null);
    expect(parseCheckboxState(toDoResponse(text, true))).toBe(null);
  });

  it("parses a marker preceded ONLY by leading whitespace", () => {
    const text = `  ${CANONICAL_KEY_OPEN}github-pr:cpk-runtime:ws-key${CANONICAL_KEY_CLOSE} a title`;
    expect(parseCheckboxState(toDoResponse(text, true))).toEqual({
      canonicalKey: "github-pr:cpk-runtime:ws-key",
      checked: true,
    });
  });
});

describe("buildCandidateBlocks — grouping + ranked order + non-checkable notes", () => {
  it("groups candidates by subsystem with a heading per group", () => {
    const blocks = buildCandidateBlocks([
      makeCandidate({ subsystem: "agui-protocol", rankScore: 5 }),
      makeCandidate({ subsystem: "cpk-runtime", rankScore: 9 }),
    ]);
    const headings = blocks
      .filter((b) => (b as { type: string }).type === "heading_2")
      .map((b) => plainTextOf(b));
    expect(headings.some((h) => h.includes("agui-protocol"))).toBe(true);
    expect(headings.some((h) => h.includes("cpk-runtime"))).toBe(true);
  });

  it("orders candidates within a subsystem by rankScore descending", () => {
    const blocks = buildCandidateBlocks([
      makeCandidate({
        subsystem: "cpk-runtime",
        rankScore: 2,
        canonical_key: "github-pr:cpk-runtime:low",
        title: "low ranked",
      }),
      makeCandidate({
        subsystem: "cpk-runtime",
        rankScore: 8,
        canonical_key: "github-pr:cpk-runtime:high",
        title: "high ranked",
      }),
    ]);
    const todoTexts = blocks
      .filter((b) => (b as { type: string }).type === "to_do")
      .map((b) => plainTextOf(b));
    const highIdx = todoTexts.findIndex((t) => t.includes("high ranked"));
    const lowIdx = todoTexts.findIndex((t) => t.includes("low ranked"));
    expect(highIdx).toBeGreaterThanOrEqual(0);
    expect(lowIdx).toBeGreaterThan(highIdx);
  });

  it("renders an unverified (non-approvable) candidate as a non-checkable note", () => {
    const blocks = buildCandidateBlocks([
      makeCandidate({
        subsystem: "cpk-runtime",
        approvable: false,
        validation_status: "unverified",
        knowledge_type: "architecture",
        title: "unproven behavior fact",
      }),
    ]);
    const todos = blocks.filter(
      (b) => (b as { type: string }).type === "to_do",
    );
    expect(todos).toHaveLength(0);
    // The non-approvable candidate still appears (as a note).
    const allText = blocks.map((b) => plainTextOf(b)).join("\n");
    expect(allText).toContain("unproven behavior fact");
  });
});

// ── generate.ts ──────────────────────────────────────────────────────────────

interface MockNotion {
  client: Client;
  createCalls: Array<Record<string, unknown>>;
  appendCalls: Array<Record<string, unknown>>;
}

function makeMockNotion(): MockNotion {
  const createCalls: Array<Record<string, unknown>> = [];
  const appendCalls: Array<Record<string, unknown>> = [];
  const create = vi.fn(async (args: Record<string, unknown>) => {
    createCalls.push(args);
    return {
      object: "page",
      id: "new-page-id-123",
      url: "https://www.notion.so/new-page-id-123",
    };
  });
  const append = vi.fn(async (args: Record<string, unknown>) => {
    appendCalls.push(args);
    return { object: "list", results: [] };
  });
  const client = {
    pages: { create },
    blocks: { children: { append } },
  } as unknown as Client;
  return { client, createCalls, appendCalls };
}

describe("generateApprovalArtifact", () => {
  let runsDir: string;

  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), "atlas-artifact-"));
  });

  afterEach(() => {
    rmSync(runsDir, { recursive: true, force: true });
  });

  it("creates a page under the parent and returns its id + url", async () => {
    const { client, createCalls } = makeMockNotion();
    const res = await generateApprovalArtifact({
      notion: client,
      parentPageId: "parent-page-id",
      runId: "run-2026-06-08",
      candidates: [makeCandidate()],
      rules: DEFAULT_EXCLUSION_RULES,
    });
    expect(res).toEqual({
      pageId: "new-page-id-123",
      url: "https://www.notion.so/new-page-id-123",
    });
    expect(createCalls).toHaveLength(1);
    const payload = createCalls[0];
    expect(payload.parent).toEqual({ page_id: "parent-page-id" });
  });

  it("puts the Exclusion-Rules section FIRST, before any candidate group", async () => {
    const { client, createCalls } = makeMockNotion();
    await generateApprovalArtifact({
      notion: client,
      parentPageId: "parent",
      runId: "run-1",
      candidates: [makeCandidate({ subsystem: "cpk-runtime" })],
      rules: DEFAULT_EXCLUSION_RULES,
    });
    const children = (createCalls[0].children ?? []) as Array<{
      type: string;
    }>;
    const firstHeading = children.find((b) => b.type === "heading_2");
    expect(firstHeading).toBeDefined();
    const firstHeadingText = plainTextOf(firstHeading);
    expect(firstHeadingText.toLowerCase()).toContain("exclusion");
    // The exclusion heading precedes the first candidate (to_do) block.
    const firstTodoIdx = children.findIndex((b) => b.type === "to_do");
    const firstExclBulletIdx = children.findIndex(
      (b) => b.type === "bulleted_list_item",
    );
    expect(firstExclBulletIdx).toBeGreaterThanOrEqual(0);
    expect(firstExclBulletIdx).toBeLessThan(firstTodoIdx);
  });

  it("seeds the Exclusion-Rules section from the PRIOR run's manifest ruleSet + defaults", async () => {
    // A prior run persisted a custom english rule in its manifest.
    const store = new RunStore(runsDir);
    const priorRule: ExclusionRule = {
      kind: "english",
      text: "Exclude anything about the Athena engagement.",
    };
    store.writeManifest("prior-run", {
      fragmentCount: 3,
      ruleSet: [priorRule],
    });

    const { client, createCalls } = makeMockNotion();
    await generateApprovalArtifact({
      notion: client,
      parentPageId: "parent",
      runId: "run-2",
      candidates: [makeCandidate()],
      rules: [], // generate seeds from prior-run + defaults itself
      runStore: store,
      priorRunId: "prior-run",
    });

    const children = (createCalls[0].children ?? []) as Array<{
      type: string;
    }>;
    const bulletTexts = children
      .filter((b) => b.type === "bulleted_list_item")
      .map((b) => plainTextOf(b));
    // The prior run's custom english rule is prefilled.
    expect(bulletTexts.some((t) => t.includes("Athena engagement"))).toBe(true);
    // The defaults are also present (e.g. the sensitivity:secret flag rule).
    const parsedRules = children
      .filter((b) => b.type === "bulleted_list_item")
      .map((b) => parseRuleFromText(plainTextOf(b)))
      .filter((r): r is ExclusionRule => r !== null);
    expect(parsedRules).toContainEqual(priorRule);
    for (const def of DEFAULT_EXCLUSION_RULES) {
      expect(parsedRules).toContainEqual(def);
    }
    // No duplicate rules even though defaults + prior-run are merged.
    const serialized = parsedRules.map((r) => JSON.stringify(r));
    expect(new Set(serialized).size).toBe(serialized.length);
  });

  it("groups candidates by subsystem, each an inline-flagged to_do, in ranked order", async () => {
    const { client, createCalls } = makeMockNotion();
    await generateApprovalArtifact({
      notion: client,
      parentPageId: "parent",
      runId: "run-3",
      candidates: [
        makeCandidate({
          subsystem: "cpk-runtime",
          rankScore: 3,
          canonical_key: "github-pr:cpk-runtime:b",
          title: "runtime low",
          validation_status: "source-verified",
        }),
        makeCandidate({
          subsystem: "cpk-runtime",
          rankScore: 9,
          canonical_key: "github-pr:cpk-runtime:a",
          title: "runtime high",
          validation_status: "showcase-verified",
        }),
        makeCandidate({
          subsystem: "agui-protocol",
          rankScore: 5,
          canonical_key: "github-pr:agui-protocol:c",
          title: "protocol mid",
        }),
      ],
      rules: DEFAULT_EXCLUSION_RULES,
    });
    const children = (createCalls[0].children ?? []) as Array<{
      type: string;
    }>;
    const todoTexts = children
      .filter((b) => b.type === "to_do")
      .map((b) => plainTextOf(b));
    expect(todoTexts).toHaveLength(3);
    // Within cpk-runtime, the showcase-verified high-rank candidate comes first.
    const highIdx = todoTexts.findIndex((t) => t.includes("runtime high"));
    const lowIdx = todoTexts.findIndex((t) => t.includes("runtime low"));
    expect(highIdx).toBeGreaterThanOrEqual(0);
    expect(lowIdx).toBeGreaterThan(highIdx);
    // Flags are inline in each checkbox.
    expect(todoTexts.some((t) => t.includes("showcase-verified"))).toBe(true);
  });

  it("renders an unverified behavior fact as a non-checkable note, not a to_do", async () => {
    const { client, createCalls } = makeMockNotion();
    await generateApprovalArtifact({
      notion: client,
      parentPageId: "parent",
      runId: "run-4",
      candidates: [
        makeCandidate({
          subsystem: "cpk-runtime",
          approvable: false,
          validation_status: "unverified",
          knowledge_type: "architecture",
          title: "CopilotNext unproven claim",
        }),
        makeCandidate({
          subsystem: "cpk-runtime",
          approvable: true,
          title: "proven runtime claim",
        }),
      ],
      rules: DEFAULT_EXCLUSION_RULES,
    });
    const children = (createCalls[0].children ?? []) as Array<{
      type: string;
    }>;
    const todoTexts = children
      .filter((b) => b.type === "to_do")
      .map((b) => plainTextOf(b));
    // Only the approvable candidate is a checkbox.
    expect(todoTexts).toHaveLength(1);
    expect(todoTexts[0]).toContain("proven runtime claim");
    // The unverified one is present but NOT as a to_do.
    const allText = children.map((b) => plainTextOf(b)).join("\n");
    expect(allText).toContain("CopilotNext unproven claim");
  });

  it("throws (fail-loud) when the create response lacks a url", async () => {
    const createCalls: Array<Record<string, unknown>> = [];
    const create = vi.fn(async (args: Record<string, unknown>) => {
      createCalls.push(args);
      // A partial / archived response with no url — must NOT silently yield "".
      return { object: "page", id: "page-no-url" };
    });
    const client = { pages: { create } } as unknown as Client;

    await expect(
      generateApprovalArtifact({
        notion: client,
        parentPageId: "parent",
        runId: "run-no-url",
        candidates: [makeCandidate()],
        rules: DEFAULT_EXCLUSION_RULES,
      }),
    ).rejects.toThrow(/url/i);
  });

  it("dedups merged rules regardless of object key order (not JSON.stringify-sensitive)", async () => {
    // The caller-supplied rule and the prior-run rule are the SAME flag rule but
    // with their keys in different order. A JSON.stringify-based dedup would treat
    // them as distinct and emit a duplicate bullet; a fixed-field key must collapse
    // them to one.
    const store = new RunStore(runsDir);
    // Persisted prior-run rule with keys in {dimension, equals, kind} order.
    store.writeManifest("prior-order", {
      fragmentCount: 1,
      ruleSet: [
        {
          dimension: "sensitivity",
          equals: "secret",
          kind: "flag",
        } as ExclusionRule,
      ],
    });

    const { client, createCalls } = makeMockNotion();
    await generateApprovalArtifact({
      notion: client,
      parentPageId: "parent",
      runId: "run-order",
      // Caller rule with keys in {kind, dimension, equals} order — same rule.
      rules: [{ kind: "flag", dimension: "sensitivity", equals: "secret" }],
      candidates: [makeCandidate()],
      runStore: store,
      priorRunId: "prior-order",
    });

    const children = (createCalls[0].children ?? []) as Array<{ type: string }>;
    const parsedRules = children
      .filter((b) => b.type === "bulleted_list_item")
      .map((b) => parseRuleFromText(plainTextOf(b)))
      .filter((r): r is ExclusionRule => r !== null);
    const secretRules = parsedRules.filter(
      (r) =>
        r.kind === "flag" &&
        r.dimension === "sensitivity" &&
        r.equals === "secret",
    );
    // Despite differing key order, the rule appears exactly once.
    expect(secretRules).toHaveLength(1);
  });

  it("falls back to defaults only when no prior run is named", async () => {
    const store = new RunStore(runsDir);
    const { client, createCalls } = makeMockNotion();
    await generateApprovalArtifact({
      notion: client,
      parentPageId: "parent",
      runId: "first-run",
      candidates: [makeCandidate()],
      rules: [],
      runStore: store,
    });
    const children = (createCalls[0].children ?? []) as Array<{
      type: string;
    }>;
    const parsedRules = children
      .filter((b) => b.type === "bulleted_list_item")
      .map((b) => parseRuleFromText(plainTextOf(b)))
      .filter((r): r is ExclusionRule => r !== null);
    expect(parsedRules).toEqual(DEFAULT_EXCLUSION_RULES);
  });

  it("throws (fail-loud) when an explicitly named prior run has no manifest", async () => {
    // The operator named a specific run via --prior-run-id; silently seeding
    // defaults-only would lose every rule the lead curated on that run (§11.5's
    // whole point). The error must name the missing run.
    const store = new RunStore(runsDir);
    const { client } = makeMockNotion();
    await expect(
      generateApprovalArtifact({
        notion: client,
        parentPageId: "parent",
        runId: "run-x",
        candidates: [makeCandidate()],
        rules: [],
        runStore: store,
        priorRunId: "nonexistent-prior",
      }),
    ).rejects.toThrow(/nonexistent-prior/);
  });

  it("merges rules caller-first, then prior-run, then defaults (order preserved)", async () => {
    const store = new RunStore(runsDir);
    const priorRule: ExclusionRule = {
      kind: "english",
      text: "Prior-run curated rule.",
    };
    store.writeManifest("prior-run", {
      fragmentCount: 1,
      ruleSet: [priorRule],
    });

    const callerRule: ExclusionRule = {
      kind: "english",
      text: "Caller-supplied rule.",
    };
    const { client, createCalls } = makeMockNotion();
    await generateApprovalArtifact({
      notion: client,
      parentPageId: "parent",
      runId: "run-order-2",
      candidates: [makeCandidate()],
      rules: [callerRule],
      runStore: store,
      priorRunId: "prior-run",
    });

    const children = (createCalls[0].children ?? []) as Array<{ type: string }>;
    const parsedRules = children
      .filter((b) => b.type === "bulleted_list_item")
      .map((b) => parseRuleFromText(plainTextOf(b)))
      .filter((r): r is ExclusionRule => r !== null);
    const callerIdx = parsedRules.findIndex(
      (r) => r.kind === "english" && r.text === callerRule.text,
    );
    const priorIdx = parsedRules.findIndex(
      (r) => r.kind === "english" && r.text === priorRule.text,
    );
    const firstDefaultIdx = parsedRules.findIndex(
      (r) => JSON.stringify(r) === JSON.stringify(DEFAULT_EXCLUSION_RULES[0]),
    );
    expect(callerIdx).toBe(0);
    expect(priorIdx).toBeGreaterThan(callerIdx);
    expect(firstDefaultIdx).toBeGreaterThan(priorIdx);
  });

  it("chunks >100 blocks: page created with the first ≤100, remainder appended in ≤100-block batches", async () => {
    // 250 candidates in one subsystem: 1 exclusion heading + one bullet per
    // default rule + 1 subsystem heading + one to_do per candidate. Notion
    // rejects any single create/append carrying >100 top-level children, so
    // generate must create with the first batch and append the rest in order.
    const candidates = Array.from({ length: 250 }, (_, i) =>
      makeCandidate({
        subsystem: "cpk-runtime",
        rankScore: 250 - i,
        canonical_key: `github-pr:cpk-runtime:cand-${i}`,
        title: `candidate number ${i} of the big run`,
      }),
    );
    // Top-level block count computed from the test's own inputs (NOT hardcoded:
    // it must track DEFAULT_EXCLUSION_RULES.length and the candidate count).
    const expectedTopLevel =
      1 + DEFAULT_EXCLUSION_RULES.length + 1 + candidates.length;
    const { client, createCalls, appendCalls } = makeMockNotion();
    await generateApprovalArtifact({
      notion: client,
      parentPageId: "parent",
      runId: "run-big",
      candidates,
      rules: DEFAULT_EXCLUSION_RULES,
    });

    expect(createCalls).toHaveLength(1);
    const createChildren = (createCalls[0].children ?? []) as Array<{
      type: string;
    }>;
    expect(createChildren.length).toBeLessThanOrEqual(100);

    // Every append batch targets the created page and stays ≤100.
    expect(appendCalls.length).toBeGreaterThan(0);
    let appendedChildren: Array<{ type: string }> = [];
    for (const call of appendCalls) {
      expect(call.block_id).toBe("new-page-id-123");
      const batch = (call.children ?? []) as Array<{ type: string }>;
      expect(batch.length).toBeGreaterThan(0);
      expect(batch.length).toBeLessThanOrEqual(100);
      appendedChildren = appendedChildren.concat(batch);
    }

    // Order is preserved across the create/append boundary: all 250 to_dos
    // appear, in rank order (rankScore desc == insertion order here).
    const allChildren = [...createChildren, ...appendedChildren];
    expect(allChildren).toHaveLength(expectedTopLevel);
    const todoTitles = allChildren
      .filter((b) => b.type === "to_do")
      .map((b) => plainTextOf(b));
    expect(todoTitles).toHaveLength(250);
    for (let i = 0; i < 250; i++) {
      expect(todoTitles[i]).toContain(`candidate number ${i} of the big run`);
    }
  });

  it("budgets batches by TOTAL block count (top-level + nested children), order preserved", async () => {
    // 30 candidates each carrying 150 evidence items. After the per-block cap,
    // each to_do still carries ~97 nested children, so a batcher that counts
    // only top-level blocks would pack all 30 to_dos (~3000 total blocks) into
    // one request and blow Notion's ~1000-total-blocks-per-request limit. The
    // batcher must budget by TOTAL block count and flush early.
    const evidence: EvidenceItem[] = Array.from({ length: 150 }, (_, i) => ({
      kind: "fused_from" as const,
      ref: `ev-${i}`,
    }));
    const candidates = Array.from({ length: 30 }, (_, i) =>
      makeCandidate({
        subsystem: "cpk-runtime",
        rankScore: 30 - i,
        canonical_key: `github-pr:cpk-runtime:heavy-${i}`,
        title: `heavy candidate ${i}`,
        evidence,
      }),
    );
    const { client, createCalls, appendCalls } = makeMockNotion();
    await generateApprovalArtifact({
      notion: client,
      parentPageId: "parent",
      runId: "run-heavy",
      candidates,
      rules: DEFAULT_EXCLUSION_RULES,
    });

    expect(createCalls).toHaveLength(1);
    const requests: unknown[][] = [
      (createCalls[0].children ?? []) as unknown[],
      ...appendCalls.map((call) => (call.children ?? []) as unknown[]),
    ];
    for (const batch of requests) {
      // ≤100 top-level blocks per request…
      expect(batch.length).toBeLessThanOrEqual(100);
      // …no block's own children array exceeds 100…
      for (const block of batch) {
        expect(childCountOf(block)).toBeLessThanOrEqual(100);
      }
      // …and the request's TOTAL block count (top-level + nested) stays under
      // a conservative budget below Notion's ~1000-blocks-per-request cap.
      const total = batch.reduce(
        (sum: number, block) => sum + 1 + childCountOf(block),
        0,
      );
      expect(total).toBeLessThanOrEqual(800);
    }

    // Order is preserved across the create/append boundary.
    const allChildren = requests.flat() as Array<{ type: string }>;
    const todoTitles = allChildren
      .filter((b) => b.type === "to_do")
      .map((b) => plainTextOf(b));
    expect(todoTitles).toHaveLength(30);
    for (let i = 0; i < 30; i++) {
      expect(todoTitles[i]).toContain(`heavy candidate ${i}`);
    }
  });

  it("budgets by DEEP block count (toggle→paragraph grandchildren counted), keeping each request ≤800 total", async () => {
    // Each candidate carries a long distilled body, which renders as a `toggle`
    // whose paragraph children are a SECOND nesting level under the to_do
    // (to_do → toggle → paragraphs). Plus 90 evidence bullets. A batcher that
    // counted only the to_do's DIRECT children would miss the toggle's own
    // grandchildren and could pack a request past Notion's ~1000-block total.
    // The DEEP per-request count (self + all descendants) must stay ≤800.
    const evidence: EvidenceItem[] = Array.from({ length: 90 }, (_, i) => ({
      kind: "fused_from" as const,
      ref: `ev-${i}`,
    }));
    const candidates = Array.from({ length: 40 }, (_, i) =>
      makeCandidate({
        subsystem: "cpk-runtime",
        rankScore: 40 - i,
        canonical_key: `github-pr:cpk-runtime:deep-${i}`,
        title: `deep candidate ${i}`,
        content: `distilled body ${i}: `.padEnd(6000, "x"),
        evidence,
      }),
    );
    const { client, createCalls, appendCalls } = makeMockNotion();
    await generateApprovalArtifact({
      notion: client,
      parentPageId: "parent",
      runId: "run-deep",
      candidates,
      rules: DEFAULT_EXCLUSION_RULES,
    });

    const requests: unknown[][] = [
      (createCalls[0].children ?? []) as unknown[],
      ...appendCalls.map((call) => (call.children ?? []) as unknown[]),
    ];
    for (const batch of requests) {
      expect(batch.length).toBeLessThanOrEqual(100);
      const deepTotal = batch.reduce(
        (sum: number, block) => sum + deepBlockCount(block),
        0,
      );
      expect(deepTotal).toBeLessThanOrEqual(800);
    }

    // Every candidate still rendered, in rank order (nothing dropped by the
    // tighter budget).
    const allChildren = requests.flat() as Array<{ type: string }>;
    const todoTitles = allChildren
      .filter((b) => b.type === "to_do")
      .map((b) => plainTextOf(b));
    expect(todoTitles).toHaveLength(40);
    for (let i = 0; i < 40; i++) {
      expect(todoTitles[i]).toContain(`deep candidate ${i}`);
    }
  });

  it("does not call append when the page fits in a single create (≤100 blocks)", async () => {
    const { client, appendCalls } = makeMockNotion();
    await generateApprovalArtifact({
      notion: client,
      parentPageId: "parent",
      runId: "run-small",
      candidates: [makeCandidate()],
      rules: DEFAULT_EXCLUSION_RULES,
    });
    expect(appendCalls).toHaveLength(0);
  });
});
