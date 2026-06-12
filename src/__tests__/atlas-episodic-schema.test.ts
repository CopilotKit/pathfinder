import { describe, it, expect } from "vitest";
import { EpisodicCandidateFragmentSchema } from "../atlas/types.js";

// ── T6 — EpisodicCandidateFragmentSchema invariants (spec §4.6 / §7.3) ────────
//
// EpisodicCandidateFragmentSchema narrows CandidateFragmentSchema with five
// episodic-leaf invariants:
//   - needsReview === true                       (refine, reject)
//   - provenance_class === "derived"             (refine, reject)
//   - confidence === "low"                       (refine, reject)
//   - validation_status === "unverified"         (refine, reject)
//   - sensitivity floor "internal" (transform: "public" coerced up; stronger
//     values preserved verbatim — NOT a reject-below rule)
//
// These tests prove (i) the sensitivity transform coerces the four input
// sensitivities correctly, and (ii) each of the four predicate invariants
// rejects with an error path/message that names the violated field.

// Base fixture: a structurally-valid episodic fragment with every episodic
// invariant satisfied. Per-test variants clone this and mutate ONE field so the
// failure cause is unambiguous.
const baseEpisodic = () => ({
  sourcetype: "episodic" as const,
  subsystem: "agent-orchestration",
  source_name: "session-2026-06-12",
  title:
    "Blitz manifest decomposition is the orchestrator's job, not the executor's",
  content:
    "When the user invokes a blitz, the orchestrator (not a sub-agent) decomposes the plan into Depends-annotated slot tasks. Executors receive a single pre-computed slot and never see the manifest.",
  provenance: {
    source: "episodic-session",
    classification: {
      sensitivity: "internal" as const,
      knowledge_type: "process" as const,
      audience: "all-staff",
      validation_status: "unverified" as const,
      confidence: "low" as const,
      provenance_class: "derived" as const,
      freshness: { as_of: "2026-06-12" },
    },
  },
  evidence: [],
  needsReview: true,
  validationTargets: [],
});

describe("EpisodicCandidateFragmentSchema — sensitivity-floor transform", () => {
  it("coerces sensitivity=public up to internal", () => {
    const input = baseEpisodic();
    input.provenance.classification.sensitivity = "public" as "internal";
    const parsed = EpisodicCandidateFragmentSchema.parse(input);
    expect(parsed.provenance.classification.sensitivity).toBe("internal");
  });

  it("preserves sensitivity=internal verbatim", () => {
    const input = baseEpisodic();
    input.provenance.classification.sensitivity = "internal";
    const parsed = EpisodicCandidateFragmentSchema.parse(input);
    expect(parsed.provenance.classification.sensitivity).toBe("internal");
  });

  it("preserves sensitivity=proprietary verbatim (stronger than floor)", () => {
    const input = baseEpisodic();
    input.provenance.classification.sensitivity = "proprietary" as "internal";
    const parsed = EpisodicCandidateFragmentSchema.parse(input);
    expect(parsed.provenance.classification.sensitivity).toBe("proprietary");
  });

  it("preserves sensitivity=secret verbatim (strongest)", () => {
    const input = baseEpisodic();
    input.provenance.classification.sensitivity = "secret" as "internal";
    const parsed = EpisodicCandidateFragmentSchema.parse(input);
    expect(parsed.provenance.classification.sensitivity).toBe("secret");
  });

  it("does not mutate the caller's input when coercing sensitivity to floor", () => {
    // Regression: a `.transform` that writes through `f.provenance.classification.sensitivity = ...`
    // would mutate the caller's input. Zod actually rebuilds the object graph on parse,
    // so the transform is non-mutating in practice. This test pins that empirical guarantee.
    // If a future maintainer "optimizes" the transform to in-place mutation (or Zod's
    // semantics change), this test catches it before the regression ships.
    const input = baseEpisodic();
    input.provenance.classification.sensitivity = "public" as "internal";
    const snapshot = structuredClone(input);
    const parsed = EpisodicCandidateFragmentSchema.parse(input);
    expect(input).toEqual(snapshot); // input not mutated
    expect(input.provenance.classification.sensitivity).toBe("public");
    expect(parsed.provenance.classification.sensitivity).toBe("internal"); // coerced on output
  });
});

describe("EpisodicCandidateFragmentSchema — predicate-refinement rejections", () => {
  it("rejects needsReview=false (episodic must be needsReview=true)", () => {
    const input = baseEpisodic();
    input.needsReview = false;
    const result = EpisodicCandidateFragmentSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.path.includes("needsReview"),
      );
      expect(issue).toBeDefined();
      expect(issue!.message).toMatch(/needsReview/);
    }
  });

  it("rejects provenance_class=primary (episodic must be derived)", () => {
    const input = baseEpisodic();
    input.provenance.classification.provenance_class = "primary" as "derived";
    const result = EpisodicCandidateFragmentSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.path.includes("provenance_class"),
      );
      expect(issue).toBeDefined();
      expect(issue!.message).toMatch(/provenance_class/);
    }
  });

  it("rejects confidence=high (episodic must be confidence=low)", () => {
    const input = baseEpisodic();
    input.provenance.classification.confidence = "high" as "low";
    const result = EpisodicCandidateFragmentSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.path.includes("confidence"),
      );
      expect(issue).toBeDefined();
      expect(issue!.message).toMatch(/confidence/);
    }
  });

  it("rejects validation_status=source-verified (episodic must be unverified)", () => {
    const input = baseEpisodic();
    input.provenance.classification.validation_status =
      "source-verified" as "unverified";
    const result = EpisodicCandidateFragmentSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.path.includes("validation_status"),
      );
      expect(issue).toBeDefined();
      expect(issue!.message).toMatch(/validation_status/);
    }
  });
});
