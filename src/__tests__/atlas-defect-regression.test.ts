import { describe, test, expect } from "vitest";
import { CandidateFragmentSchema } from "../atlas/types.js";

// ── T4 + T5 + T7 — Defect-regression corpus (spec §1.1 / §7.4 / §7.7) ─────────
//
// This file codifies, as parametric regression tests, every defect class
// observed in one full-monty run that the new schema-enforcement boundary
// (CandidateFragmentSchema as the single I/O contract) must reject. It
// REPLACES today's repair-shim's permissive acceptance: any defect that the
// shim used to silently coerce is now a loud Zod rejection.
//
// The corpus comes in three blocks:
//
//   T4 — 14 alias names for `provenance.classification.knowledge_type`
//        (`kind` / `category` / `discipline` / `topic` / `domain` / `area` /
//         `type` / `facet` / `bucket` / `class` / `subject` / `theme` /
//         `label` / `tag`). Each fixture is otherwise-valid but substitutes
//        the alias key for `knowledge_type`. The Zod schema rejects because
//        `knowledge_type` is required.
//
//   T5 — 12 other defect rows from §1.1 (rows 2–8 and 10–14; row 9 is
//        DROPPED per plan SLOT-5 N1, because `audience` has a default and a
//        fragment that ONLY omits it parses successfully under the current
//        schema — the original observation reflects an older/lossy intake
//        path, not a current-schema rejection).
//
//   T7 — Integration: a happy-path fragment parses, and then for EACH of
//        the 26 defect fixtures above, swapping the defect into the happy
//        path yields a rejection. This ties T4 + T5 into a single
//        comprehensive regression assertion: the same base, the same
//        per-defect mutator, the same rejection.
//
// Row 14 footnote: §1.1 row 14 is "extra/unknown top-level fields silently
// dropped." Under the BASE (non-`.strict()`) CandidateFragmentSchema, extras
// are stripped during parse — the parse SUCCEEDS but the extras do not
// survive into the parsed object. That is a known asymmetry vs the spec's
// "rejects all rows 2–14" framing, and per spec NG1 we are not permitted to
// tighten the schema in this slot. The row-14 fixture therefore asserts the
// CURRENT contract (extras stripped, no extra-field leakage into the parsed
// candidate), so the test still guards against drift (a future change that
// causes extras to leak through would fail the assertion).

// ── Helpers ──────────────────────────────────────────────────────────────────

// Deep-clone a plain JSON-shaped object. The fixtures here are all
// JSON-safe (no Dates, no functions, no Maps), so structured cloning via
// JSON round-trip is sufficient and keeps each parametric case independent.
const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o)) as T;

// Base happy-path fragment. T7's first assertion is that THIS parses; every
// defect fixture below is produced by applying ONE mutator to a clone of
// this base, so any rejection unambiguously traces to that single mutation.
const baseHappyPath = () => ({
  sourcetype: "memory" as const,
  subsystem: "atlas-harvest",
  source_name: "spec-§1.1",
  title: "Schema-enforcement boundary catches every observed defect class",
  content:
    "Each defect row in §1.1 is a separate parse failure under CandidateFragmentSchema; the repair shim is no longer required.",
  provenance: {
    source: "atlas-leaf",
    classification: {
      sensitivity: "internal" as const,
      knowledge_type: "process" as const,
      audience: "all-staff",
      validation_status: "unverified" as const,
      confidence: "high" as const,
      provenance_class: "primary" as const,
      freshness: { as_of: "2026-06-12" },
    },
  },
  evidence: [],
  needsReview: false,
  validationTargets: [],
});

// Serialize all zod issues into one string so per-case regex assertions can
// match anywhere in the issue list (path OR message). Joining keeps the
// per-case `expect(...).toMatch(...)` line readable: the assertion fails
// with the FULL issue list pretty-printed, which makes drift diagnoses
// obvious.
const formatIssues = (
  issues: ReadonlyArray<{ path: ReadonlyArray<unknown>; message: string }>,
): string =>
  issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join(" | ");

// ── T4 — 14 classification-key aliases ───────────────────────────────────────
//
// Each alias replaces the literal `knowledge_type` key in
// `provenance.classification` while keeping the same valid enum VALUE
// (`"process"`). The Zod object schema requires `knowledge_type`, so the
// parse fails with an issue rooted at
// `provenance.classification.knowledge_type` (required field missing). The
// presence of the alias key itself is silently ignored (z.object strips
// unknowns) — the rejection is driven by the required key being absent,
// which is the right signal: it names the canonical key the model needs
// to emit.

const KNOWLEDGE_TYPE_ALIASES = [
  "kind",
  "category",
  "discipline",
  "topic",
  "domain",
  "area",
  "type",
  "facet",
  "bucket",
  "class",
  "subject",
  "theme",
  "label",
  "tag",
] as const;

// Build a fragment that uses `alias` instead of `knowledge_type` in
// `provenance.classification`. Returns a plain object (not typed against
// CandidateFragment, because by construction it does NOT satisfy the
// inferred type).
const fragmentWithAlias = (alias: string): unknown => {
  const f = clone(baseHappyPath()) as Record<string, unknown> & {
    provenance: { classification: Record<string, unknown> };
  };
  const c = f.provenance.classification;
  // Move the value to the alias key and drop the canonical key.
  c[alias] = c.knowledge_type;
  delete c.knowledge_type;
  return f;
};

describe("T4: classification.knowledge_type key aliases (§1.1 row 1)", () => {
  test.each(KNOWLEDGE_TYPE_ALIASES.map((alias) => [alias] as const))(
    "rejects fragment whose classification uses alias %s instead of knowledge_type",
    (alias) => {
      const fixture = fragmentWithAlias(alias);
      const result = CandidateFragmentSchema.safeParse(fixture);
      expect(result.success).toBe(false);
      if (result.success) return; // type guard
      const formatted = formatIssues(result.error.issues);
      // The rejection must be rooted at the canonical key the model SHOULD
      // have emitted, so the operator can read the error and fix the alias.
      expect(formatted).toMatch(/provenance\.classification\.knowledge_type/);
    },
  );
});

// ── T5 — 12 other defect rows (rows 2–8, 10–14; row 9 dropped) ───────────────
//
// Each row is a mutator that turns the happy-path base into a single-defect
// fixture, plus a regex the formatted-issues string must match so the
// rejection's path/message names the offending field.

interface DefectCase {
  row: number;
  desc: string;
  // Mutate a CLONE of the happy-path base in place; the caller passes a
  // fresh clone for each invocation.
  mutate: (f: ReturnType<typeof baseHappyPath>) => unknown;
  // The formatted-issues string MUST match this regex. Keep the regex tight
  // enough to name the right field/path, loose enough to survive minor
  // zod-message wording drift across patch releases.
  expect: RegExp;
}

const DEFECT_CASES: DefectCase[] = [
  {
    row: 2,
    desc: "classification lifted to top-level (top-level `sensitivity`)",
    mutate: (f) => {
      const lifted: Record<string, unknown> = { ...(f as object) };
      lifted.sensitivity = f.provenance.classification.sensitivity;
      // Drop the nested copy so the inner Sensitivity enum field is missing.
      delete (lifted.provenance as { classification: Record<string, unknown> })
        .classification.sensitivity;
      return lifted;
    },
    expect: /provenance\.classification\.sensitivity/,
  },
  {
    row: 3,
    desc: "evidence as string (path) instead of array",
    mutate: (f) => {
      (f as unknown as { evidence: unknown }).evidence = "src/foo.ts";
      return f;
    },
    expect: /evidence/,
  },
  {
    row: 4,
    desc: "evidence as plain object instead of array",
    mutate: (f) => {
      (f as unknown as { evidence: unknown }).evidence = {
        kind: "changed_file",
        path: "src/foo.ts",
      };
      return f;
    },
    expect: /evidence/,
  },
  {
    row: 5,
    desc: "evidence items missing `kind` discriminator",
    mutate: (f) => {
      (f as unknown as { evidence: unknown }).evidence = [
        { path: "src/foo.ts" },
      ];
      return f;
    },
    expect: /evidence\.0(\..*)?/,
  },
  {
    row: 6,
    desc: "provenance flattened — top-level `source`/`url` instead of nested",
    mutate: (f) => {
      const flat: Record<string, unknown> = { ...(f as object) };
      flat.source = f.provenance.source;
      flat.url = "https://example.invalid/issue/42";
      delete (flat as { provenance?: unknown }).provenance;
      return flat;
    },
    expect: /provenance/,
  },
  {
    row: 7,
    desc: "provenance.classification lifted to top-level",
    mutate: (f) => {
      const lifted: Record<string, unknown> = { ...(f as object) };
      lifted.classification = f.provenance.classification;
      delete (lifted.provenance as { classification?: unknown }).classification;
      return lifted;
    },
    expect: /provenance\.classification/,
  },
  {
    row: 8,
    desc: "freshness as string instead of `{ as_of }` object",
    mutate: (f) => {
      (
        f.provenance.classification as unknown as { freshness: unknown }
      ).freshness = "2026-06-09";
      return f;
    },
    expect: /provenance\.classification\.freshness/,
  },
  // Row 9 dropped — see file-header comment.
  {
    row: 10,
    desc: "validationTargets as string instead of array",
    mutate: (f) => {
      (f as unknown as { validationTargets: unknown }).validationTargets =
        "src/foo.ts";
      return f;
    },
    expect: /validationTargets/,
  },
  {
    row: 11,
    desc: "needsReview as string instead of boolean",
    mutate: (f) => {
      (f as unknown as { needsReview: unknown }).needsReview = "true";
      return f;
    },
    expect: /needsReview/,
  },
  {
    row: 12,
    desc: "subsystem containing canonical-key delimiter `:`",
    mutate: (f) => {
      f.subsystem = "foo:bar";
      return f;
    },
    expect: /subsystem/,
  },
  {
    row: 13,
    desc: "missing top-level `sourcetype`",
    mutate: (f) => {
      delete (f as unknown as { sourcetype?: unknown }).sourcetype;
      return f;
    },
    expect: /sourcetype/,
  },
  {
    row: 14,
    desc: "extra/unknown top-level fields (e.g. `summary`, `tags`) — stripped, not rejected (base schema is non-strict; see file header)",
    // Row 14 is the one defect class where the BASE schema does not REJECT —
    // z.object() strips unknown keys. We instead assert that the extras do
    // not LEAK into the parsed candidate (the contract the rest of the
    // pipeline depends on). NG1 forbids tightening the schema to `.strict()`
    // in this slot.
    mutate: (f) => {
      const withExtras = { ...(f as object), summary: "drop me", tags: ["x"] };
      return withExtras;
    },
    expect: /__row14_marker_unused__/, // never matched; row 14 takes the alternate assertion path below
  },
];

describe("T5: other defect rows (§1.1 rows 2–8, 10–14)", () => {
  test.each(DEFECT_CASES.map((c) => [c.row, c.desc, c] as const))(
    "row %d — %s",
    (row, _desc, c) => {
      const fixture = c.mutate(clone(baseHappyPath()));
      const result = CandidateFragmentSchema.safeParse(fixture);

      if (row === 14) {
        // Row 14 — assert the documented current behavior: parse SUCCEEDS,
        // extras stripped, canonical fields all present.
        expect(result.success).toBe(true);
        if (!result.success) return;
        const parsedKeys = Object.keys(result.data);
        expect(parsedKeys).not.toContain("summary");
        expect(parsedKeys).not.toContain("tags");
        // The canonical fields survived the parse.
        expect(parsedKeys).toEqual(
          expect.arrayContaining([
            "sourcetype",
            "subsystem",
            "source_name",
            "title",
            "content",
            "provenance",
            "evidence",
            "needsReview",
            "validationTargets",
          ]),
        );
        return;
      }

      expect(result.success).toBe(false);
      if (result.success) return; // type guard
      const formatted = formatIssues(result.error.issues);
      expect(formatted).toMatch(c.expect);
    },
  );
});

// ── T7 — Integration: happy-path passes; every defect swap rejects ───────────
//
// T7 ties T4 + T5 together: ONE base, the SAME per-defect mutators, parse
// runs end-to-end. The intent is to prove the happy path is wired correctly
// AND that no defect leaks through under the same surface the production
// helper uses. If a future schema tweak accidentally re-admits a defect,
// this block fails at the integration layer in addition to the focused
// T4/T5 case.

describe("T7: integration — happy path + every defect swap", () => {
  test("happy-path fragment parses successfully", () => {
    const result = CandidateFragmentSchema.safeParse(baseHappyPath());
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Sanity: the parsed candidate's enum-typed fields survived.
    expect(result.data.sourcetype).toBe("memory");
    expect(result.data.provenance.classification.knowledge_type).toBe(
      "process",
    );
  });

  test.each(KNOWLEDGE_TYPE_ALIASES.map((a) => [a] as const))(
    "alias swap (%s) rejected at integration layer",
    (alias) => {
      const result = CandidateFragmentSchema.safeParse(
        fragmentWithAlias(alias),
      );
      expect(result.success).toBe(false);
    },
  );

  test.each(DEFECT_CASES.map((c) => [c.row, c.desc, c] as const))(
    "defect-row swap (row %d — %s) handled at integration layer",
    (row, _desc, c) => {
      const fixture = c.mutate(clone(baseHappyPath()));
      const result = CandidateFragmentSchema.safeParse(fixture);
      // Mirror T5: row 14 PASSES with extras stripped; all others REJECT.
      if (row === 14) {
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(Object.keys(result.data)).not.toContain("summary");
        return;
      }
      expect(result.success).toBe(false);
    },
  );
});
