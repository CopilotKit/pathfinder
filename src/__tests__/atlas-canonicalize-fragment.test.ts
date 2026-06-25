import { describe, it, expect } from "vitest";
import { canonicalizeFragment } from "../atlas/canonicalize.js";

// Tests for the §6.2 `canonicalizeFragment` JSON-stringify normalizer used by
// the Phase-2 dual-run shadow comparator. The function is named
// `canonicalizeFragment` (not `canonicalize`) inside src/atlas/canonicalize.ts
// because that module already exports the Tier-3 ranker `canonicalize`
// (different signature, different role). See SLOT-1 of the implementation plan.

describe("canonicalizeFragment — §6.2 normalizer", () => {
  // ── T1: recursive key-sort stability ────────────────────────────────────────
  // Two objects whose keys differ only by INSERTION ORDER must canonicalize to
  // byte-identical JSON.stringify output. The dual-run comparator relies on
  // `JSON.stringify(canonicalizeFragment(a)) === JSON.stringify(canonicalizeFragment(b))`
  // (spec §6.2), so the canonical output must be stable regardless of which
  // order the model emitted the keys.
  it("T1: emits stable JSON-stringified output across key-permuted inputs", () => {
    // Two CandidateFragment-shaped objects whose top-level AND nested keys are
    // permuted between the two literals. Same field values; different order.
    const a = {
      sourcetype: "github" as const,
      subsystem: "atlas",
      title: "Schema enforcement at the leaf boundary",
      content: "Hello world.",
      claimSlugHint: "schema-enforcement",
      evidence: [
        { kind: "url", ref: "https://example.com/a" },
        { kind: "url", ref: "https://example.com/b" },
      ],
      provenance: {
        date: "2026-06-12",
        classification: {
          knowledge_type: "behavior",
          provenance_class: "primary",
          validation_status: "showcase-verified",
          confidence: "high",
        },
      },
    };

    const b = {
      // Top-level keys permuted.
      title: "Schema enforcement at the leaf boundary",
      provenance: {
        // Nested keys permuted.
        classification: {
          confidence: "high",
          validation_status: "showcase-verified",
          provenance_class: "primary",
          knowledge_type: "behavior",
        },
        date: "2026-06-12",
      },
      // evidence kept in the SAME element order (arrays are positional).
      evidence: [
        { ref: "https://example.com/a", kind: "url" },
        { ref: "https://example.com/b", kind: "url" },
      ],
      claimSlugHint: "schema-enforcement",
      content: "Hello world.",
      subsystem: "atlas",
      sourcetype: "github" as const,
    };

    const canonA = JSON.stringify(canonicalizeFragment(a));
    const canonB = JSON.stringify(canonicalizeFragment(b));
    expect(canonA).toBe(canonB);
    // Also assert deep-equal as a redundant structural check.
    expect(canonicalizeFragment(a)).toEqual(canonicalizeFragment(b));
  });

  // ── T2: whitespace normalization + numeric round-trip + array order ────────
  // §6.2(b): strings trim + collapse internal whitespace runs (including
  // newlines and tabs) to a single space — explicitly lossy on free-text fields.
  // §6.2(c): numeric round-trip so `1.0 ≡ 1`.
  // §6.2(d): arrays are NOT sorted — element order is load-bearing for
  // `evidence[]` and must be preserved positionally.
  it("T2: normalizes whitespace lossily, round-trips numerics, preserves array order", () => {
    // Whitespace: leading + trailing trim, internal runs (spaces + newlines +
    // tabs) collapse to ONE space.
    const out = canonicalizeFragment({
      content: "  hello\n\n  world  ",
      title: "foo  bar",
      provenance: {
        // Nested string also normalized.
        note: "alpha\n\tbeta",
      },
    }) as {
      content: string;
      title: string;
      provenance: { note: string };
    };
    expect(out.content).toBe("hello world");
    expect(out.title).toBe("foo bar");
    expect(out.provenance.note).toBe("alpha beta");

    // Whitespace-only string collapses to empty (trim removes everything).
    const ws = canonicalizeFragment({ s: "   \n\t  " }) as { s: string };
    expect(ws.s).toBe("");

    // Numeric canonicalization: 1.0 and 1 must compare equal after canonicalize.
    const n1 = JSON.stringify(canonicalizeFragment({ x: 1.0 }));
    const n2 = JSON.stringify(canonicalizeFragment({ x: 1 }));
    expect(n1).toBe(n2);
    // Non-integer numerics also round-trip stably.
    const n3 = JSON.stringify(canonicalizeFragment({ x: 1.5 }));
    const n4 = JSON.stringify(canonicalizeFragment({ x: 1.5 }));
    expect(n3).toBe(n4);

    // Array order PRESERVED — ["a","b"] must NOT canonicalize equal to ["b","a"].
    const ab = JSON.stringify(canonicalizeFragment({ arr: ["a", "b"] }));
    const ba = JSON.stringify(canonicalizeFragment({ arr: ["b", "a"] }));
    expect(ab).not.toBe(ba);

    // Same array order DOES canonicalize equal, even with nested objects whose
    // keys are permuted.
    const ev1 = JSON.stringify(
      canonicalizeFragment({
        evidence: [
          { kind: "url", ref: "x" },
          { kind: "url", ref: "y" },
        ],
      }),
    );
    const ev2 = JSON.stringify(
      canonicalizeFragment({
        evidence: [
          { ref: "x", kind: "url" },
          { ref: "y", kind: "url" },
        ],
      }),
    );
    expect(ev1).toBe(ev2);
  });
});
