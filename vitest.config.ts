import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "dist/**", "**/.claude/**"],

    // Pin the suite's timezone. Unpinned, four tests that reason about UTC-day
    // boundaries (analytics-gap-fill's rolling-UTC-day alignment, plus three
    // analytics-ui availability-label cases) fail in any zone far enough from
    // UTC; `TZ=Pacific/Kiritimati` (UTC+14) reproduces all four. Those tests
    // assert real UTC-day behavior, so the fix is to give the suite the zone it
    // already assumes rather than to loosen the assertions to whatever the host
    // happens to be set to.
    env: { TZ: "UTC" },

    // NOT set here, deliberately: `mockReset: true`.
    //
    // It would close a real leak. `vi.clearAllMocks()` clears only the call
    // log, so a `mockResolvedValueOnce` that its own test never consumed stays
    // QUEUED and is handed to whichever later test calls the mock next. Proven
    // by queueing a sentinel row in `text-search-tsvector.test.ts`'s
    // empty-string case (which returns before ever touching the pool): the
    // sentinel surfaced in the results of the NEXT test, which asserts `[]`.
    // `mockReset: true` does fix that specific case.
    //
    // But as a repo-wide default it breaks 243 tests across 27 files, because
    // a reset mock returns `undefined` instead of keeping its implementation,
    // and many suites here arm a mock once in `beforeAll` or at module scope.
    // Flipping it would mean rewriting those 27 files, which is a far larger
    // change than the leak it prevents.
    //
    // So the invariant is enforced statically instead: the
    // `clear-all-mocks-with-once` rule in `scripts/check-test-shapes.mjs`
    // fails CI when a file mixes `vi.clearAllMocks()` with `*Once(` values,
    // which is exactly the combination that can leak. Suites that want the
    // stronger semantics opt in locally with `vi.resetAllMocks()` /
    // `mock.mockReset()` in their own `beforeEach` — as the `row mapping`
    // block in `text-search-tsvector.test.ts` already does.
  },
});
