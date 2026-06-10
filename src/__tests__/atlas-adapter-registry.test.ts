// Unit tests for the Atlas adapter-registry CONTRACT (S2).
//
// Scope is the contract only: `getAdapter` resolving against a HAND-BUILT stub
// registry and throwing on a missing sourcetype. The stub adapter is a pure
// `vi.fn` (allowed — it is NOT an LLM call; per the plan S2 test strategy). No
// real adapters (S3-S9) and no registry assembly (S18) are exercised here.

import { describe, it, expect, vi } from "vitest";
import {
  getAdapter,
  type AdapterContext,
  type LeafAdapter,
  type LeafAdapterRegistry,
} from "../atlas/adapters/types.js";
import type { CandidateFragment } from "../atlas/types.js";

// A minimal valid fragment the stub adapter can return, so the contract is
// exercised end-to-end (extract → fragment[]).
function stubFragment(): CandidateFragment {
  return {
    sourcetype: "memory",
    subsystem: "atlas",
    source_name: "memory/MEMORY.md",
    title: "stub claim",
    content: "why/how prose",
    provenance: {
      source: "memory",
      classification: {
        sensitivity: "internal",
        knowledge_type: "architecture",
        audience: "all-staff",
        validation_status: "unverified",
        confidence: "medium",
        provenance_class: "primary",
        freshness: { as_of: "2026-06-08" },
      },
    },
    evidence: [],
    needsReview: false,
    validationTargets: [],
  };
}

describe("getAdapter (registry contract)", () => {
  it("resolves the adapter registered for a sourcetype", async () => {
    const extract = vi.fn(async () => [stubFragment()]);
    const memoryAdapter: LeafAdapter = { sourcetype: "memory", extract };
    const registry: LeafAdapterRegistry = { memory: memoryAdapter };

    const resolved = getAdapter(registry, "memory");
    expect(resolved).toBe(memoryAdapter);
    expect(resolved.sourcetype).toBe("memory");

    // The resolved adapter is callable through the contract.
    const ctx: AdapterContext = { now: new Date("2026-06-08T00:00:00.000Z") };
    const out = await resolved.extract({ any: "unit" }, ctx);
    expect(out).toHaveLength(1);
    expect(out[0].sourcetype).toBe("memory");
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("throws for a sourcetype with no registered adapter", () => {
    const registry: LeafAdapterRegistry = {
      memory: { sourcetype: "memory", extract: vi.fn(async () => []) },
    };
    // `episodic` is a valid sourcetype but not registered → must throw.
    expect(() => getAdapter(registry, "episodic")).toThrow(/episodic/);
  });

  it("throws against an empty registry", () => {
    expect(() => getAdapter({}, "github-pr")).toThrow(
      /No leaf adapter registered/,
    );
  });
});
