import { describe, it, expect } from "vitest";
import { runDualRun } from "../atlas/dual-run.js";

// T10 — dual-run shadow gate scaffold (spec §6.2, §7.6).
//
// Exercises the three precondition branches of `runDualRun`:
//   (a) seed-present + match  ........... byte-equality after canonicalize
//   (a) seed-present + diverge  ......... canonicalize differs → diagnose field
//   (b) no-seed + relaxed-match  ........ same shape + enums + text ≥ 0.95
//   (b) no-seed + diverge  .............. enum field differs
//   (c) neither-available + gated  ...... refuse to advance

describe("runDualRun — §7.6 T10 shadow-gate scaffold", () => {
  it("seed-present: identical runs canonicalize equal → match", () => {
    // Key-permuted but value-identical fragments. canonicalizeFragment sorts
    // keys + normalizes whitespace, so the stringified canonical output is
    // byte-equal — strict-comparator match.
    const runA = {
      title: "Atlas schema enforcement",
      content: "First line.\nSecond line.",
      sensitivity: "internal",
      confidence: "high",
    };
    const runB = {
      // Same fields, different insertion order, equivalent whitespace.
      content: "First line. Second line.",
      sensitivity: "internal",
      title: "Atlas schema enforcement",
      confidence: "high",
    };

    const verdict = runDualRun({
      runA,
      runB,
      seedAvailable: true,
      relaxedComparatorAvailable: false,
    });

    expect(verdict.result).toBe("match");
    expect(verdict.reason).toMatch(/seed-present/);
  });

  it("seed-present: runs differing in title → diverge, reason names title", () => {
    const runA = {
      title: "Atlas schema enforcement",
      content: "Same content body.",
      sensitivity: "internal",
      confidence: "high",
    };
    const runB = {
      title: "Atlas schema enforcement — revised",
      content: "Same content body.",
      sensitivity: "internal",
      confidence: "high",
    };

    const verdict = runDualRun({
      runA,
      runB,
      seedAvailable: true,
      relaxedComparatorAvailable: false,
    });

    expect(verdict.result).toBe("diverge");
    expect(verdict.reason).toContain("title");
  });

  // M-1 + M-5 regression coverage — the no-seed-relaxed branch must read the
  // five classification enums at their REAL nested path
  // (provenance.classification.<field>) AND must also enforce sourcetype
  // (top-level) and per-item evidence[].kind. The "both-missing" case for any
  // covered enum is a structural divergence (per spec §7.6 the relaxed
  // comparator's purpose is to catch enum drift; the classification record
  // itself is a structural invariant).

  // Minimum-valid CandidateFragment shape — matches CandidateFragmentObject
  // in src/atlas/types.ts (validated by CandidateFragmentSchema). Helper keeps
  // the relaxed-branch tests below readable; tests that need to perturb a
  // single field call baseFragment() on both sides and mutate one side.
  const baseFragment = () => ({
    sourcetype: "github-pr" as const,
    subsystem: "atlas",
    source_name: "test-source",
    title: "Atlas pipeline overview",
    content: "Pipeline that canonicalizes fragments under provenance.",
    provenance: {
      source: "test",
      classification: {
        sensitivity: "internal" as const,
        knowledge_type: "architecture" as const,
        audience: "all-staff",
        validation_status: "showcase-verified" as const,
        confidence: "high" as const,
        provenance_class: "primary" as const,
        freshness: { as_of: "2026-06-12" },
      },
    },
    evidence: [
      { kind: "changed_file" as const, path: "src/atlas/dual-run.ts" },
    ],
    needsReview: false,
    validationTargets: [],
  });

  it("no-seed: same enums + highly-similar text → relaxed-match", () => {
    // Same shape (identical key set), nested enums byte-equal, text fields
    // differ by ONE token out of 20+ — Jaccard well above 0.95.
    const sharedTokens =
      "the atlas pipeline canonicalizes fragments and ranks them by confidence and recency under provenance class primary";
    const runA = baseFragment();
    runA.content = sharedTokens + " plus an extra clarifying token here";
    const runB = baseFragment();
    runB.content = sharedTokens + " plus an extra clarifying token here";

    const verdict = runDualRun({
      runA,
      runB,
      seedAvailable: false,
      relaxedComparatorAvailable: true,
    });

    expect(verdict.result).toBe("relaxed-match");
  });

  it("no-seed: enum field differs (sensitivity) → diverge", () => {
    const runA = baseFragment();
    const runB = baseFragment();
    runB.provenance.classification.sensitivity =
      "public" as typeof runB.provenance.classification.sensitivity;

    const verdict = runDualRun({
      runA,
      runB,
      seedAvailable: false,
      relaxedComparatorAvailable: true,
    });

    expect(verdict.result).toBe("diverge");
    expect(verdict.reason).toContain("sensitivity");
  });

  it("M-1 nesting: mismatched provenance.classification.knowledge_type → diverge", () => {
    // Independent corroboration of the nested-path read for a SECOND enum
    // (not sensitivity, exercised above). Catches a future regression that
    // hardcodes the path for sensitivity but mis-handles the other four.
    const runA = baseFragment();
    const runB = baseFragment();
    runB.provenance.classification.knowledge_type =
      "ownership" as typeof runB.provenance.classification.knowledge_type;

    const verdict = runDualRun({
      runA,
      runB,
      seedAvailable: false,
      relaxedComparatorAvailable: true,
    });

    expect(verdict.result).toBe("diverge");
    expect(verdict.reason).toContain("knowledge_type");
  });

  it("M-1 sourcetype: top-level sourcetype mismatch → diverge", () => {
    const runA = baseFragment();
    const runB = baseFragment();
    runB.sourcetype = "notion-doc" as typeof runB.sourcetype;

    const verdict = runDualRun({
      runA,
      runB,
      seedAvailable: false,
      relaxedComparatorAvailable: true,
    });

    expect(verdict.result).toBe("diverge");
    expect(verdict.reason).toContain("sourcetype");
  });

  it("T-R5-1 both-missing sourcetype: neither side has sourcetype → diverge", () => {
    // CandidateFragmentObject declares `sourcetype` as a REQUIRED enum (no
    // .optional(), no .default()). Per the M-5/T-R3-1/T-R3-2 precedent, the
    // relaxed comparator must NOT silently pass when both sides are missing a
    // required structural field. JSON.stringify(undefined) === undefined on
    // both sides would compare-equal and silent-pass without an explicit
    // both-missing guard.
    const runA = baseFragment();
    const runB = baseFragment();
    delete (runA as any).sourcetype;
    delete (runB as any).sourcetype;

    const verdict = runDualRun({
      runA,
      runB,
      seedAvailable: false,
      relaxedComparatorAvailable: true,
    });

    expect(verdict.result).toBe("diverge");
    expect(verdict.reason).toContain("sourcetype");
  });

  it("M-1 evidence[].kind: per-item evidence kind mismatch → diverge", () => {
    const runA = baseFragment();
    const runB = baseFragment();
    // Swap the single evidence item's discriminant on runB.
    runB.evidence = [{ kind: "linked_issue" as const, path: "x" } as any];

    const verdict = runDualRun({
      runA,
      runB,
      seedAvailable: false,
      relaxedComparatorAvailable: true,
    });

    expect(verdict.result).toBe("diverge");
    expect(verdict.reason).toMatch(/evidence/);
  });

  it("M-5 both-missing: neither side has provenance.classification.sensitivity → diverge", () => {
    const runA = baseFragment();
    const runB = baseFragment();
    // Drop sensitivity on both sides. The classification record is a
    // structural invariant per spec §7.6; both-missing must NOT silently pass.
    delete (runA.provenance.classification as any).sensitivity;
    delete (runB.provenance.classification as any).sensitivity;

    const verdict = runDualRun({
      runA,
      runB,
      seedAvailable: false,
      relaxedComparatorAvailable: true,
    });

    expect(verdict.result).toBe("diverge");
    expect(verdict.reason).toContain("sensitivity");
  });

  // T-R3-1: extend M-5 "both-missing → diverge" precedent to the required
  // structural text fields (title, content). CandidateFragmentObject declares
  // title: z.string() and content: z.string() — both REQUIRED, no .default(),
  // no .optional(). Two fragments both lacking `title` (or both lacking
  // `content`) are both malformed; the relaxed comparator must NOT collapse
  // them to an empty-string Jaccard 1.0 silent pass.

  it("T-R3-1 both-missing title: neither side has title → diverge", () => {
    const runA = baseFragment();
    const runB = baseFragment();
    delete (runA as any).title;
    delete (runB as any).title;

    const verdict = runDualRun({
      runA,
      runB,
      seedAvailable: false,
      relaxedComparatorAvailable: true,
    });

    expect(verdict.result).toBe("diverge");
    expect(verdict.reason).toContain("title");
  });

  it("T-R3-1 both-non-string title: neither side has string title → diverge", () => {
    const runA = baseFragment();
    const runB = baseFragment();
    (runA as any).title = 42;
    (runB as any).title = null;

    const verdict = runDualRun({
      runA,
      runB,
      seedAvailable: false,
      relaxedComparatorAvailable: true,
    });

    expect(verdict.result).toBe("diverge");
    expect(verdict.reason).toContain("title");
  });

  it("T-R3-1 both-missing content: neither side has content → diverge", () => {
    const runA = baseFragment();
    const runB = baseFragment();
    delete (runA as any).content;
    delete (runB as any).content;

    const verdict = runDualRun({
      runA,
      runB,
      seedAvailable: false,
      relaxedComparatorAvailable: true,
    });

    expect(verdict.result).toBe("diverge");
    expect(verdict.reason).toContain("content");
  });

  // T-R3-2: extend M-5 "both-missing → diverge" precedent to the evidence
  // array. The schema declares `evidence: z.array(...).default([])` so AFTER
  // parse evidence is always an array — but the comparator receives untyped
  // `object` from upstream and is the structural pin against malformation
  // bypassing the parser. Both sides missing the evidence field entirely
  // means both fragments are malformed in the same way → diverge, not silent
  // empty-array match.

  it("T-R3-2 both-missing evidence: neither side has evidence → diverge", () => {
    const runA = baseFragment();
    const runB = baseFragment();
    delete (runA as any).evidence;
    delete (runB as any).evidence;

    const verdict = runDualRun({
      runA,
      runB,
      seedAvailable: false,
      relaxedComparatorAvailable: true,
    });

    expect(verdict.result).toBe("diverge");
    expect(verdict.reason).toMatch(/evidence/);
  });

  // T-R4-1: extend the M-5 / T-R3-2 "both-missing → diverge" precedent to the
  // ASYMMETRIC mixed-shape variant. When ONE side's `evidence` is a non-array
  // value (undefined / string / scalar / object) and the OTHER side is a
  // well-formed array (including the empty array `[]`), the prior `?? []`
  // fallback collapsed both sides to length-0 and the per-index loop trivially
  // matched — a silent relaxed-match on a structurally divergent pair. Per
  // spec §7.6, structurally different evidence shapes must diverge.

  it("T-R4-1 asymmetric evidence: undefined vs [] → diverge", () => {
    const runA = baseFragment();
    const runB = baseFragment();
    // Keep the `evidence` key present on both sides (so the top-level key-set
    // check does not fire first); set runA to a non-array value to exercise
    // the XOR shape-mismatch branch directly.
    (runA as any).evidence = undefined; // non-array (undefined)
    (runB as any).evidence = []; // valid empty array

    const verdict = runDualRun({
      runA,
      runB,
      seedAvailable: false,
      relaxedComparatorAvailable: true,
    });

    expect(verdict.result).toBe("diverge");
    expect(verdict.reason).toMatch(/evidence/);
  });

  it("T-R4-1 asymmetric evidence: non-array string vs [] → diverge", () => {
    const runA = baseFragment();
    const runB = baseFragment();
    (runA as any).evidence = "not-an-array";
    (runB as any).evidence = [];

    const verdict = runDualRun({
      runA,
      runB,
      seedAvailable: false,
      relaxedComparatorAvailable: true,
    });

    expect(verdict.result).toBe("diverge");
    expect(verdict.reason).toMatch(/evidence/);
  });

  // T-R4-2: extend the T-R3-1 "both-missing/non-string → diverge" precedent
  // to the ASYMMETRIC mixed-shape variant for text fields. When ONE side has
  // a valid empty string `""` and the OTHER side is non-string (undefined /
  // number / null / object), the prior `?? ""` fallback collapsed both to
  // `""`, Jaccard("", "") = 1.0, and the gate silently relaxed-matched on a
  // structurally divergent pair. Per spec §7.6 + the schema's required
  // `z.string()` declaration, shape-mismatch must diverge.

  it("T-R4-2 asymmetric title: empty string vs undefined → diverge", () => {
    const runA = baseFragment();
    const runB = baseFragment();
    // Keep the `title` key present on both sides (so the top-level key-set
    // check does not fire first); the non-string side exercises the text-XOR
    // shape-mismatch branch directly.
    (runA as any).title = ""; // valid empty string
    (runB as any).title = undefined; // non-string (undefined value)

    const verdict = runDualRun({
      runA,
      runB,
      seedAvailable: false,
      relaxedComparatorAvailable: true,
    });

    expect(verdict.result).toBe("diverge");
    expect(verdict.reason).toContain("title");
  });

  it("T-R4-2 asymmetric content: empty string vs non-string → diverge", () => {
    const runA = baseFragment();
    const runB = baseFragment();
    (runA as any).content = ""; // valid empty string
    (runB as any).content = 42; // non-string number

    const verdict = runDualRun({
      runA,
      runB,
      seedAvailable: false,
      relaxedComparatorAvailable: true,
    });

    expect(verdict.result).toBe("diverge");
    expect(verdict.reason).toContain("content");
  });

  it("neither seed nor relaxed comparator available → gated", () => {
    const runA = { title: "x" };
    const runB = { title: "x" };

    const verdict = runDualRun({
      runA,
      runB,
      seedAvailable: false,
      relaxedComparatorAvailable: false,
    });

    expect(verdict.result).toBe("gated");
    expect(verdict.reason).toMatch(/neither/i);
  });
});
