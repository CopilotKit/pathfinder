---
title: Atlas Zod refinement coverage
status: living
source: src/atlas/types.ts
generated: 2026-06-12
---

# Atlas Zod refinement coverage

This document enumerates every Zod refinement and transform currently in
`src/atlas/types.ts` (the foundational Atlas contract). For each, it
records whether the constraint is **JSON-Schema-expressible** (and therefore
survives `zod-to-json-schema` conversion at orchestrator-shell boot) or
whether it **requires a post-pass** Zod parse after JSON Schema validation
(because it is a runtime predicate / transform that `zod-to-json-schema`
silently drops).

This file is paired with test `src/__tests__/atlas-refinement-coverage.test.ts`
(T9 per spec §7.9). The test asserts the refinement count in this doc matches
the refinement count counted in source — so if you add a new `.refine(...)` /
`.superRefine(...)` / `.transform(...)` to `src/atlas/types.ts`, you MUST
add a corresponding row here, otherwise T9 fails with a stale-doc message.

## Refinement table

| Refinement                                                              | Schema                                        | JSON-Schema-expressible?                                                   | Post-pass note                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subsystemHasNoDelimiter` (fragment)                                    | `CandidateFragmentSchema` (line ~145)         | No (runtime predicate over a string body)                                  | Rejects when `subsystem` contains `:`, `⟦`, or `⟧`. JSON Schema cannot express a predicate over unicode delimiters as a portable `pattern`. Enforced by the CLI helper's post-pass `CandidateFragmentSchema.parse(input)` step (see spec §4.2.1, STEP 2).                                                                                                                                                           |
| `subsystemHasNoDelimiter` (finalized candidate)                         | `CandidateSchema` (line ~207)                 | No (runtime predicate)                                                     | Same predicate as the fragment row above, applied to the finalized Tier-3 `Candidate` after canonicalization. JSON Schema is not the validation surface for finalized rows — they are validated in TS by `CandidateSchema.parse(...)` — so this lives purely in Zod.                                                                                                                                                |
| `episodic.needsReview === true`                                         | `EpisodicCandidateFragmentSchema` (line ~166) | No (semantic invariant, not structural)                                    | Rejects when `needsReview !== true`. Episodic leaves are "guilty until validated" — the per-family invariant cannot be expressed as a JSON Schema `const` on a `boolean` because the base `CandidateFragmentSchema` permits both values; only the episodic narrowing forbids `false`. Enforced as a SECOND parse via `EpisodicCandidateFragmentSchema` when `sourcetype === "episodic"` (spec §4.6).                |
| `episodic.provenance.classification.provenance_class === "derived"`     | `EpisodicCandidateFragmentSchema` (line ~173) | No (semantic invariant)                                                    | Rejects when `provenance_class !== "derived"`. Episodic leaves can never be `"primary"`. Enforced post-pass via the episodic-narrowed schema.                                                                                                                                                                                                                                                                       |
| `episodic.provenance.classification.confidence === "low"`               | `EpisodicCandidateFragmentSchema` (line ~177) | No (semantic invariant)                                                    | Rejects when `confidence !== "low"`. Episodic confidence is clamped to `"low"` by policy. Enforced post-pass via the episodic-narrowed schema.                                                                                                                                                                                                                                                                      |
| `episodic.provenance.classification.validation_status === "unverified"` | `EpisodicCandidateFragmentSchema` (line ~181) | No (semantic invariant)                                                    | Rejects when `validation_status !== "unverified"`. Episodic claims are unverified by construction. Enforced post-pass via the episodic-narrowed schema.                                                                                                                                                                                                                                                             |
| `episodic sensitivity floor` (transform)                                | `EpisodicCandidateFragmentSchema` (line ~190) | No (`.transform` mutates the parsed value; not expressible in JSON Schema) | Coerces `sensitivity === "public"` upward to `"internal"`; `"internal"` / `"proprietary"` / `"secret"` are preserved verbatim. This is a "coerce up to floor" rewrite, NOT a "reject below floor" predicate, so even the JSON-Schema `enum` shape would not catch it (the input is allowed; the value just gets rewritten before persistence). Enforced post-pass via `EpisodicCandidateFragmentSchema.parse(...)`. |

## Summary

- Total refinements / transforms in `src/atlas/types.ts`: **7**
- JSON-Schema-expressible: **0**
- Post-pass required: **7**

All seven entries are runtime predicates or transforms; none survive
`zod-to-json-schema` conversion. The CLI helper at `atlas harvest
write-fragment --stdin` therefore re-parses every fragment through Zod
(`CandidateFragmentSchema.parse` for base fragments, and additionally
`EpisodicCandidateFragmentSchema.parse` when `sourcetype === "episodic"`)
to enforce all seven. See spec §4.1.1, §4.2.1, and §4.6 for the full
orchestration-shell vs CLI-helper split.

## Future-edit note

If you add a `.refine(...)`, `.superRefine(...)`, `.transform(...)`, or
`.regex(...)` to `src/atlas/types.ts`, you must:

1. Add a row to the table above describing the constraint, the host
   schema, whether it is JSON-Schema-expressible, and where it is
   enforced.
2. Update the **Summary** counts.
3. Re-run `npx vitest run src/__tests__/atlas-refinement-coverage.test.ts`
   and confirm green.

T9 fails fast on count drift so the silent-drop class of bug (a new
runtime predicate added to `types.ts` but never wired into the CLI
post-pass) is caught at test time, not at first failing leaf.
