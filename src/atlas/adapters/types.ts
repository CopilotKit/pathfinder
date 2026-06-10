// Atlas leaf-adapter CONTRACT + adapter-registry CONTRACT (types + accessor only).
//
// This file defines the SHAPE every per-source leaf adapter (S3-S9) conforms to,
// and the SHAPE of the adapter registry — but it deliberately does NOT assemble
// the registry map. Per the plan (§2 / §4.2 / S2), the populated
// `LeafAdapterRegistry` is built in exactly ONE place: the S18 harvest driver
// (`scripts/atlas-harvest.ts`), which imports all seven adapters. There is NO
// shared `src/atlas/adapters/index.ts`. S2 owns only the contract type and the
// `getAdapter` accessor.
//
// A leaf adapter is a PURE function of one small unit (the Tier-1 "one unit each"
// rule, spec §4): raw source unit → `CandidateFragment[]`. The episodic adapter
// is the only one that needs `ctx.llm` (distillation); the rest ignore it.

import type { CandidateFragment } from "../types.js";

// ── LLM distiller seam ────────────────────────────────────────────────────────
//
// `AdapterContext.llm` is S1's concrete `LlmDistiller`, re-exported here so every
// adapter and the S18 driver share one type. (S1 is merged; the earlier
// structural placeholder is removed — its 1-arg shape was too narrow for S1's
// real `distillEpisodicWindow(text, ctx)` and `evaluateEnglishExclusionRule(rule,
// candidate)` signatures.) The episodic adapter passes an `OpenAIDistiller` as
// `ctx.llm`.
import type { LlmDistiller } from "../llm.js";
export type { LlmDistiller };

// ── Adapter context (passed to every extract call) ────────────────────────────

export interface AdapterContext {
  // Optional — only the episodic adapter requires it. Structurally satisfied by
  // S1's concrete `LlmDistiller` (see note above).
  llm?: LlmDistiller;
  // Injected clock so adapters are deterministic under test (provenance dates,
  // freshness.as_of, etc. derive from this rather than `new Date()` inline).
  now: Date;
}

// ── Leaf adapter contract ─────────────────────────────────────────────────────

// One per source type. `sourcetype` is the discriminant tying an adapter to the
// `CandidateFragment.sourcetype` it produces; `extract` turns one unit into zero
// or more candidate fragments. EXCEPTION: the github adapter produces TWO
// sourcetypes (`github-pr` and `github-issue`) and the S18 driver registers the
// one adapter object under BOTH keys; its declared `sourcetype` is the dominant
// `github-pr` (see github.ts's own note at the adapter definition).
export interface LeafAdapter<U = unknown> {
  sourcetype: CandidateFragment["sourcetype"];
  extract(unit: U, ctx: AdapterContext): Promise<CandidateFragment[]>;
}

// ── Registry CONTRACT (type only — never populated here) ───────────────────────

// A partial map from sourcetype → adapter. Partial because the populated map is
// assembled incrementally in the S18 driver and a given run need not wire every
// source. The KEY type is exactly `CandidateFragment["sourcetype"]`, so adding a
// sourcetype to the S0 enum surfaces here automatically.
export type LeafAdapterRegistry = Partial<
  Record<CandidateFragment["sourcetype"], LeafAdapter>
>;

// Resolve the adapter for a sourcetype, throwing if the registry has no adapter
// registered for it. The harvest driver assembles the map; callers use this
// accessor so a missing adapter fails loud (spec fail-loud discipline) rather
// than yielding `undefined` and a downstream `cannot read property 'extract'`.
export function getAdapter(
  reg: LeafAdapterRegistry,
  sourcetype: CandidateFragment["sourcetype"],
): LeafAdapter {
  const adapter = reg[sourcetype];
  if (!adapter) {
    throw new Error(
      `No leaf adapter registered for sourcetype "${sourcetype}". ` +
        `Registered sourcetypes: [${Object.keys(reg).join(", ")}].`,
    );
  }
  return adapter;
}
