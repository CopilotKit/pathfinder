import { describe, it, expect } from "vitest";
import { finalizeClassification } from "../atlas/classify.js";
import { CandidateFragmentSchema } from "../atlas/types.js";
import type { CandidateFragment, Classification } from "../atlas/types.js";

// ── Test helpers ──────────────────────────────────────────────────────────────
//
// finalizeClassification operates on c.provenance.classification — the
// 7-dimension flag-set (sensitivity, knowledge_type, audience,
// validation_status, confidence, provenance_class, freshness). The stage is the
// normalizer that runs AFTER the leaf adapters / aggregator have produced
// fragments whose classification may be only partially filled; it completes the
// flag-set with sensible defaults, is idempotent, and never overwrites a value
// the upstream already set.

// Build a CandidateFragment carrying a (possibly partial) classification flag-set.
// The classification is supplied as a partial object so a test can omit dims to
// prove they get defaulted. The harness intentionally bypasses
// CandidateFragmentSchema.parse here (which would inject schema-level audience
// defaults) so the stage — not Zod — is what is under test.
function fragmentWithClassification(
  classification: Partial<Classification>,
  overrides: Partial<CandidateFragment> = {},
): CandidateFragment {
  return {
    sourcetype: "memory",
    subsystem: "testing-sse",
    source_name: "memory-store",
    title: "t",
    content: "c",
    provenance: {
      source: "memory-store",
      // classification is deliberately partial at runtime — that is exactly the
      // input finalizeClassification exists to normalize.
      classification: classification as Classification,
    },
    evidence: [],
    needsReview: false,
    validationTargets: [],
    ...overrides,
  };
}

// A fully-populated, already-finalized classification (every dim set, non-default
// values where possible) used to prove finalize preserves what upstream set.
const COMPLETE_CLASSIFICATION: Classification = {
  sensitivity: "proprietary",
  knowledge_type: "architecture",
  audience: "engineering",
  validation_status: "source-verified",
  confidence: "high",
  provenance_class: "primary",
  freshness: { as_of: "2026-01-02", re_verify_by: "2026-07-02" },
};

const ALL_DIMENSIONS: (keyof Classification)[] = [
  "sensitivity",
  "knowledge_type",
  "audience",
  "validation_status",
  "confidence",
  "provenance_class",
  "freshness",
];

describe("finalizeClassification — incomplete flag-set normalization", () => {
  it("fills every missing dimension with a schema-valid default", () => {
    // Empty classification: the stage must produce a complete, schema-valid set.
    const out = finalizeClassification(fragmentWithClassification({}));
    const cls = out.provenance.classification;

    for (const dim of ALL_DIMENSIONS) {
      expect(cls[dim]).toBeDefined();
    }
    // The result must satisfy the contract schema (every enum value valid,
    // freshness.as_of present). Re-parsing the whole fragment proves it.
    expect(() => CandidateFragmentSchema.parse(out)).not.toThrow();
  });

  it("defaults each enum dimension to a conservative value", () => {
    const cls = finalizeClassification(fragmentWithClassification({}))
      .provenance.classification;
    // Conservative defaults: company knowledge is internal (not public) until
    // proven otherwise; unverified until the validate stage proves it; low
    // confidence until assessed; derived unless marked primary.
    expect(cls.sensitivity).toBe("internal");
    expect(cls.validation_status).toBe("unverified");
    expect(cls.confidence).toBe("low");
    expect(cls.provenance_class).toBe("derived");
    // knowledge_type must be a valid KnowledgeType enum member.
    expect(typeof cls.knowledge_type).toBe("string");
    expect(cls.knowledge_type.length).toBeGreaterThan(0);
  });

  it("fills freshness.as_of when freshness is entirely missing", () => {
    const cls = finalizeClassification(fragmentWithClassification({}))
      .provenance.classification;
    expect(cls.freshness).toBeDefined();
    expect(typeof cls.freshness.as_of).toBe("string");
    expect(cls.freshness.as_of.length).toBeGreaterThan(0);
  });

  it("completes a partially-filled flag-set without disturbing the set dims", () => {
    const out = finalizeClassification(
      fragmentWithClassification({
        sensitivity: "secret",
        knowledge_type: "security",
      }),
    );
    const cls = out.provenance.classification;
    // The two dims the upstream set survive verbatim.
    expect(cls.sensitivity).toBe("secret");
    expect(cls.knowledge_type).toBe("security");
    // The rest are defaulted.
    expect(cls.audience).toBe("all-staff");
    expect(cls.validation_status).toBe("unverified");
    expect(cls.confidence).toBe("low");
    expect(cls.provenance_class).toBe("derived");
    expect(cls.freshness.as_of).toBeTruthy();
  });
});

describe("finalizeClassification — audience default", () => {
  it("defaults audience to all-staff when absent", () => {
    const cls = finalizeClassification(fragmentWithClassification({}))
      .provenance.classification;
    expect(cls.audience).toBe("all-staff");
  });

  it("does not override an explicitly-set audience", () => {
    const cls = finalizeClassification(
      fragmentWithClassification({ audience: "engineering" }),
    ).provenance.classification;
    expect(cls.audience).toBe("engineering");
  });
});

describe("finalizeClassification — preserves already-set values", () => {
  it("leaves a fully-populated classification byte-identical", () => {
    const out = finalizeClassification(
      fragmentWithClassification({ ...COMPLETE_CLASSIFICATION }),
    );
    expect(out.provenance.classification).toEqual(COMPLETE_CLASSIFICATION);
  });

  it("preserves freshness.re_verify_by and a non-default as_of", () => {
    const cls = finalizeClassification(
      fragmentWithClassification({
        freshness: { as_of: "2025-12-01", re_verify_by: "2026-06-01" },
      }),
    ).provenance.classification;
    expect(cls.freshness.as_of).toBe("2025-12-01");
    expect(cls.freshness.re_verify_by).toBe("2026-06-01");
  });

  it("preserves a present as_of even when re_verify_by is absent", () => {
    const cls = finalizeClassification(
      fragmentWithClassification({ freshness: { as_of: "2025-11-11" } }),
    ).provenance.classification;
    expect(cls.freshness.as_of).toBe("2025-11-11");
    expect(cls.freshness.re_verify_by).toBeUndefined();
  });
});

describe("finalizeClassification — non-classification fields untouched", () => {
  it("preserves the surrounding fragment fields and other provenance keys", () => {
    const input = fragmentWithClassification(
      { sensitivity: "public" },
      {
        sourcetype: "github-pr",
        subsystem: "cpk-runtime",
        title: "distilled claim",
        content: "why/how prose",
        needsReview: true,
        validationTargets: ["packages/runtime/src/v2/runtime/core/runtime.ts"],
      },
    );
    input.provenance.url = "https://example.com/pr/1";
    input.provenance.date = "2026-06-08";

    const out = finalizeClassification(input);

    expect(out.sourcetype).toBe("github-pr");
    expect(out.subsystem).toBe("cpk-runtime");
    expect(out.title).toBe("distilled claim");
    expect(out.content).toBe("why/how prose");
    expect(out.needsReview).toBe(true);
    expect(out.validationTargets).toEqual([
      "packages/runtime/src/v2/runtime/core/runtime.ts",
    ]);
    expect(out.provenance.url).toBe("https://example.com/pr/1");
    expect(out.provenance.date).toBe("2026-06-08");
    expect(out.provenance.classification.sensitivity).toBe("public");
  });
});

describe("finalizeClassification — idempotency", () => {
  it("finalize(finalize(x)) deep-equals finalize(x) for an empty flag-set", () => {
    const once = finalizeClassification(fragmentWithClassification({}));
    const twice = finalizeClassification(once);
    expect(twice).toEqual(once);
  });

  it("finalize(finalize(x)) deep-equals finalize(x) for a partial flag-set", () => {
    const once = finalizeClassification(
      fragmentWithClassification({
        sensitivity: "secret",
        confidence: "medium",
      }),
    );
    const twice = finalizeClassification(once);
    expect(twice).toEqual(once);
  });

  it("finalize(finalize(x)) deep-equals finalize(x) for a complete flag-set", () => {
    const once = finalizeClassification(
      fragmentWithClassification({ ...COMPLETE_CLASSIFICATION }),
    );
    const twice = finalizeClassification(once);
    expect(twice).toEqual(once);
  });

  it("a stable freshness.as_of survives the second pass unchanged", () => {
    const once = finalizeClassification(fragmentWithClassification({}));
    const asOfAfterFirst = once.provenance.classification.freshness.as_of;
    const twice = finalizeClassification(once);
    // The default as_of, once set, must not be regenerated on re-finalize.
    expect(twice.provenance.classification.freshness.as_of).toBe(
      asOfAfterFirst,
    );
  });

  // fix10 Z17: the test above is vacuous against same-day regeneration — a
  // finalize that REGENERATED as_of would still produce today's date string
  // twice. Pinning a preset PAST date distinguishes "preserved" from
  // "regenerated today" with no clock seam.
  it("a preset past as_of is preserved exactly through finalize and re-finalize (fix10 Z17)", () => {
    const once = finalizeClassification(
      fragmentWithClassification({ freshness: { as_of: "2020-01-01" } }),
    );
    expect(once.provenance.classification.freshness.as_of).toBe("2020-01-01");
    const twice = finalizeClassification(once);
    expect(twice.provenance.classification.freshness.as_of).toBe("2020-01-01");
  });
});

describe("finalizeClassification — purity", () => {
  it("does not mutate the input fragment", () => {
    const input = fragmentWithClassification({ sensitivity: "public" });
    // structuredClone + toStrictEqual (not a JSON round-trip) so an injected
    // `undefined`-valued key or prototype change would be caught too (fix10
    // 6b#2 fold of the Y18(f) mechanic).
    const before = structuredClone(input);
    finalizeClassification(input);
    // Input classification object is unchanged (audience/freshness NOT injected
    // into the original).
    expect(input).toStrictEqual(before);
  });
});
