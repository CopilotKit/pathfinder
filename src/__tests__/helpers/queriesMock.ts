// A COMPLETE-BY-CONSTRUCTION module mock for `src/db/queries.js`.
//
// The shape this replaces:
//
//   vi.mock("../db/queries.js", () => ({
//     searchChunks: vi.fn(),
//     textSearchChunks: vi.fn(),
//     hybridSearchChunks: vi.fn(),
//   }));
//
// That compiles, and nothing anywhere says that `src/mcp/tools/search.ts` also
// imports `isBelowCosineFloor` from the same module. The omission is invisible
// until a test happens to reach the missing export, and then it surfaces as
// vitest's opaque "No 'isBelowCosineFloor' export is defined on the mock" from
// somewhere deep inside the tool handler — or, far more likely, it does not
// surface at all, because the test that WOULD have reached it is the one nobody
// wrote. That is not a hypothetical: search-hybrid.test.ts and
// search-analytics.test.ts both mocked the module that way, which is precisely
// why a `min_score` case could not be added to either of them.
//
// Two properties make that class of gap impossible here:
//
//   1. the real module is spread in, so every export the code under test
//      imports is present and behaves like production unless a suite has
//      deliberately replaced it; and
//   2. the `satisfies` below turns completeness into a COMPILE-time check
//      rather than a convention — delete the `...actual` spread and `tsc` names
//      every export the mock no longer provides. When production grows a new
//      export, a mock that omits it is a build error, not a runtime surprise.
//
// Overrides are typed against the real module too, so a stub whose signature
// has drifted from the function it stands in for is also a build error.

import type { Mock } from "vitest";

/** The module under mock, as the single source of truth for its own shape. */
type QueriesModule = typeof import("../../db/queries.js");

/**
 * A partial map of real exports, each at the real export's own type (or a
 * vitest mock of it). Naming an export that does not exist, or stubbing one
 * with the wrong signature, fails to compile.
 */
export type QueriesOverrides = {
  [K in keyof QueriesModule]?: QueriesModule[K] extends (
    ...args: infer A
  ) => infer R
    ? QueriesModule[K] | Mock<(...args: A) => R>
    : QueriesModule[K];
};

/**
 * Build the `../db/queries.js` mock: the real module, with `overrides` layered
 * on top.
 *
 * Usage from a test file (the factory must stay in the test file so vitest can
 * hoist the `vi.mock` call):
 *
 *   vi.mock("../db/queries.js", async (importOriginal) =>
 *     mockQueriesModule(importOriginal, {
 *       searchChunks: vi.fn(),
 *       textSearchChunks: vi.fn(),
 *       hybridSearchChunks: vi.fn(),
 *     }),
 *   );
 *
 * The return type is deliberately INFERRED from the `satisfies` expression
 * rather than annotated as `QueriesModule`: the annotation would check the same
 * thing, but callers then lose the narrower types of their own overrides, and
 * the check would no longer be visibly attached to the spread it is guarding.
 */
export async function mockQueriesModule<T extends QueriesOverrides>(
  importOriginal: () => Promise<QueriesModule>,
  overrides: T,
) {
  const actual = await importOriginal();
  // Removing `...actual` here is a COMPILE error listing every unmocked
  // export — that is the whole point of this helper.
  return { ...actual, ...overrides } satisfies QueriesModule;
}
