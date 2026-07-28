// Retrieval-row fixtures, typed off the producers they stand in for.
//
// `makeChunkResult` used to be copy-pasted into every suite that needed a
// retrieval row, and the copies drifted: some derived `cosine_similarity` from
// the row's ranking score (what the vector retriever actually does), others
// pinned a fixed cosine that stayed put while a test overrode `similarity` —
// producing rows the production query cannot emit, and always in the generous
// direction. A fixture more generous than its producer is worse than no
// fixture: it makes the assertion pass for a state that never occurs.
//
// So the row types here are DERIVED from the producers' own return types. If
// `searchChunks` grows a field, or narrows one, these fixtures stop compiling
// instead of quietly modelling last month's contract.

import type { searchChunks, textSearchChunks } from "../../db/queries.js";

/** A row exactly as the VECTOR retriever produces it. */
export type VectorRow = Awaited<ReturnType<typeof searchChunks>>[number];
/** A row exactly as the KEYWORD retriever produces it. */
export type KeywordRow = Awaited<ReturnType<typeof textSearchChunks>>[number];

/**
 * Default ranking score for a vector row. On a freshly fetched vector row the
 * ranking score IS the cosine, so this doubles as the default relevance score —
 * see {@link makeChunkResult}.
 */
export const DEFAULT_COSINE = 0.9;

/**
 * Default ranking score for a keyword row: a ts_rank, which lives on a scale
 * two orders of magnitude below a cosine. Sharing the vector default here would
 * let a keyword fixture look like a strong semantic match, which is the confusion
 * the whole `similarity` / `cosine_similarity` split exists to prevent.
 */
export const DEFAULT_TS_RANK = 0.04;

/** Everything about a row that is not a score. */
export const CHUNK_RESULT_DEFAULTS = {
  id: 1,
  source_name: "docs",
  source_url: "https://docs.example.com/page",
  title: "Test Page",
  content: "Test content.",
  repo_url: null,
  file_path: "docs/page.md",
  start_line: null,
  end_line: null,
  language: null,
} satisfies Omit<VectorRow, "similarity" | "cosine_similarity">;

/**
 * A row as `searchChunks` returns it: the ranking score and the relevance score
 * are the SAME number, because a vector row's ranking score is its cosine.
 *
 * Deriving the cosine from `similarity` (rather than pinning it) is the load-
 * bearing part. `min_score`, `topCosineScore` and the low-confidence classifier
 * all read `cosine_similarity`; a fixture that overrides only `similarity` and
 * leaves a fixed cosine behind models a row the retriever cannot produce, and
 * every one of those assertions then exercises the wrong number.
 *
 * A caller that genuinely wants the two decoupled — an RRF-ranked row, where
 * `similarity` is a fusion score and the cosine is the surviving relevance
 * reading — passes `cosine_similarity` explicitly.
 */
export function makeChunkResult(overrides: Partial<VectorRow> = {}): VectorRow {
  const similarity = overrides.similarity ?? DEFAULT_COSINE;
  return {
    ...CHUNK_RESULT_DEFAULTS,
    similarity,
    cosine_similarity: similarity,
    ...overrides,
  };
}

/**
 * A {@link makeChunkResult} with suite-specific defaults baked in, for suites
 * whose assertions name their own titles / paths / sources. The score derivation
 * is inherited, so a per-suite base cannot reintroduce the drift.
 */
export function chunkResultFactory(
  base: Partial<VectorRow>,
): (overrides?: Partial<VectorRow>) => VectorRow {
  return (overrides: Partial<VectorRow> = {}) =>
    makeChunkResult({ ...base, ...overrides });
}

/**
 * Overrides accepted by {@link makeKeywordResult}. `cosine_similarity` is
 * deliberately absent: naming it is a COMPILE error, not a silently discarded
 * argument.
 */
export type KeywordOverrides = Omit<Partial<KeywordRow>, "cosine_similarity">;

/**
 * A row as `textSearchChunks` returns it: `similarity` holds a ts_rank, and
 * `cosine_similarity` is ALWAYS null.
 *
 * The null is a CONTRACT, not a default. `textSearchChunks` selects
 * `ts_rank(...) AS similarity` and writes a literal `cosine_similarity: null`
 * on every row (see src/db/queries.ts) — a keyword-only hit compared no
 * embedding, so no cosine exists for it anywhere in the request. Two things
 * follow, and both are why this factory refuses a `cosine_similarity` override
 * at the type level rather than just defaulting it:
 *
 *   * a test that asserts a cosine on a keyword row is asserting about a state
 *     production cannot reach; and
 *   * `isBelowCosineFloor` never excludes a null cosine (unknown relevance is
 *     not bad relevance), so a keyword row can never be filtered by `min_score`
 *     — which makes "min_score is not applied in keyword mode" UNOBSERVABLE via
 *     the cosine, and any test claiming to show it has to observe something
 *     else. See the keyword-mode block in search-hybrid.test.ts.
 */
export function makeKeywordResult(
  overrides: KeywordOverrides = {},
): KeywordRow {
  return {
    ...makeChunkResult({ similarity: DEFAULT_TS_RANK, ...overrides }),
    cosine_similarity: null,
  };
}
