// Atlas JSON Schema derivation (spec §4.1).
//
// The orchestration shell that fans out atlas harvest leaves passes a JSON
// Schema document to the harness `agent(prompt, {schema})` call so the model
// emits a structurally-valid CandidateFragment by construction (Route-B of
// spec §4). The atlas package owns the DERIVATION of that schema — a single
// source of truth wired to the Zod contract in `./types.ts` — so the shell
// can boot, call `jsonSchemaForFamily(family)`, and hand the result to the
// harness without re-implementing schema conversion.
//
// Per spec §4.1.1, Zod `.refine(...)` / `.transform(...)` constraints are
// silently dropped by `zod-to-json-schema` (they are runtime predicates, not
// structural). Two callouts:
//   1. The `subsystemHasNoDelimiter` refinement on `CandidateFragmentSchema`
//      is dropped here; the post-pass Zod parse in
//      `atlas harvest write-fragment --stdin` still rejects.
//   2. The four episodic predicate refinements on
//      `EpisodicCandidateFragmentSchema` (needsReview, provenance_class,
//      confidence, validation_status) and the sensitivity-floor
//      `.transform()` are runtime-only and are silently dropped by
//      `zod-to-json-schema`; they are re-applied by the post-pass
//      `EpisodicCandidateFragmentSchema.parse(...)` in
//      `atlas harvest write-fragment --stdin`. The derived JSON Schema
//      therefore enforces only the base structural contract — the episodic
//      clamps live in the Zod post-pass.

import { zodToJsonSchema } from "zod-to-json-schema";

import {
  CandidateFragmentSchema,
  EpisodicCandidateFragmentSchema,
  type CandidateFragment,
} from "./types.js";

// `sourcetype` is an inline enum on `CandidateFragmentObject` and is not
// re-exported as a named symbol from `./types.js`. Derive it from the
// inferred `CandidateFragment` type so this file stays in lock-step with the
// Zod contract (any addition to the enum surfaces here as a type error
// where `jsonSchemaForFamily` switches on it).
export type SourceType = CandidateFragment["sourcetype"];

// Base CandidateFragment JSON Schema (spec §4.1).
//
// `$refStrategy: "none"` inlines every sub-schema so the result is a single
// self-contained document with no `$ref` indirection. The harness consumes
// this schema directly; inlining keeps the wire payload self-describing and
// avoids `$defs` resolution ordering issues across harness implementations.
export const CANDIDATE_FRAGMENT_JSON_SCHEMA: object = zodToJsonSchema(
  CandidateFragmentSchema,
  { name: "CandidateFragment", $refStrategy: "none" },
);

// Episodic-narrowed CandidateFragment JSON Schema (spec §4.6).
//
// `EpisodicCandidateFragmentSchema` adds four predicate refinements
// (needsReview=true, provenance_class=derived, confidence=low,
// validation_status=unverified) and one `.transform()` (sensitivity floor).
// `zod-to-json-schema` drops ALL of these because they are runtime-only
// (refine/transform never round-trip into JSON Schema). The shell-side
// schema therefore expresses only the base structural shape; the four
// predicate clamps and the sensitivity-floor transform are re-applied by
// the post-pass `EpisodicCandidateFragmentSchema.parse(...)` in
// `atlas harvest write-fragment --stdin` (spec §4.2.1, step 3).
export const EPISODIC_CANDIDATE_FRAGMENT_JSON_SCHEMA: object = zodToJsonSchema(
  EpisodicCandidateFragmentSchema,
  { name: "EpisodicCandidateFragment", $refStrategy: "none" },
);

/**
 * Family-picker for the harness `agent(prompt, {schema})` call.
 *
 * Returns the JSON Schema document the orchestration shell should hand to
 * the harness for a given leaf family:
 *   - `"episodic"` → {@link EPISODIC_CANDIDATE_FRAGMENT_JSON_SCHEMA}
 *   - any other `SourceType` value → {@link CANDIDATE_FRAGMENT_JSON_SCHEMA}
 *
 * This is the canonical entrypoint for the shell — the shell never imports
 * the two `*_JSON_SCHEMA` constants directly; it switches on the family it
 * is dispatching and lets this helper return the right document.
 *
 * Note: the returned schema is structural ONLY. The runtime-only Zod
 * refinements (subsystem-delimiter guard, episodic invariant clamps,
 * sensitivity-floor transform) are still enforced post-write by the
 * `atlas harvest write-fragment --stdin` Zod parse — see spec §4.1.1.
 */
export function jsonSchemaForFamily(family: SourceType): object {
  return family === "episodic"
    ? EPISODIC_CANDIDATE_FRAGMENT_JSON_SCHEMA
    : CANDIDATE_FRAGMENT_JSON_SCHEMA;
}
