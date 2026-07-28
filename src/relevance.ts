// Relevance scoring contract shared by the retrieval tools and the analytics
// layer.
//
// Retrieval produces TWO distinct numbers per result and they must not be
// confused. `ChunkResult.similarity` is a RANKING score whose scale depends on
// the retriever (cosine in vector mode, ts_rank in keyword mode, a Reciprocal
// Rank Fusion score in hybrid mode). `ChunkResult.cosine_similarity` is a
// RELEVANCE score, always on the [-1, 1] cosine scale or null. Only the latter
// may be persisted, aggregated, or compared against a threshold.

import type { ChunkResult } from "./types.js";

/**
 * Value written to `query_log.score_kind` when `top_score` holds a cosine
 * similarity — the only kind a tool ever writes today. The column exists to
 * fence HISTORY: rows predating it hold mode-dependent values under a NULL
 * score_kind, so score-based readers require this value and skip the rest
 * rather than reinterpreting them. See src/db/schema.ts for why there is no
 * backfill.
 */
export const COSINE_SCORE_KIND = "cosine";

/**
 * Bounds of the metric `query_log.top_score` is recorded on. searchChunks
 * SELECTs `1 - (embedding <=> $1)`, and pgvector's `<=>` under
 * `vector_cosine_ops` is cosine DISTANCE in [0, 2] (it clamps the underlying
 * similarity to [-1, 1] before subtracting it from 1), so the value that
 * reaches `cosine_similarity` is a cosine similarity in [-1, 1] — NOT [0, 1],
 * as this contract claimed until the bound was actually measured. Anything
 * pointed away from the query is negative; 0 means orthogonal.
 *
 * A deployment MAY make negatives unreachable by setting a positive
 * `min_score` (deploy/copilotkit-docs.yaml uses 0.3 on its four search tools),
 * but that floor is per-tool, optional, request-overridable, and skipped
 * entirely by the keyword and knowledge paths — so it is a property of one
 * config, not of the metric. These constants encode the scale pgvector
 * actually produces; a threshold that wants a tighter floor derives it (see
 * LOW_CONFIDENCE_SCORE_THRESHOLD) instead of assuming the config.
 */
export const COSINE_SCORE_MIN = -1;
export const COSINE_SCORE_MAX = 1;

/**
 * Cosine value of two ORTHOGONAL embeddings — the point on the scale at which
 * a chunk bears no semantic relationship to the query. It is the midpoint of
 * [{@link COSINE_SCORE_MIN}, {@link COSINE_SCORE_MAX}] and the floor of the
 * only half of the scale that carries usable relevance signal, which is what a
 * relevance threshold has to be anchored to.
 */
export const COSINE_SCORE_ORTHOGONAL = 0;

/**
 * Best RELEVANCE score across a result set: the highest cosine similarity any
 * row carries, or null when none does (an empty set, or a set made entirely of
 * keyword-only hits).
 *
 * This is what belongs in `query_log.top_score` — NOT `Math.max(...similarity)`.
 * Maxing `similarity` persists a cosine in vector mode, a ts_rank in keyword
 * mode, and an RRF fusion score capped at 2/(RRF_K+1) ≈ 0.033 in hybrid mode.
 * Comparing those against a single cosine-scaled threshold is a scale error:
 * it flagged every scored hybrid query as low-confidence and rendered a
 * meaningless "Avg Score" on the dashboard. Reducing over `cosine_similarity`
 * keeps one metric on one scale in all three modes, at the cost of returning
 * null when only keyword hits came back — which the analytics layer already
 * treats as "no score", not "a low score".
 *
 * The non-finite guard below is defence in depth: producers already map a
 * corrupt similarity to null rather than to a number (see toCosineScoreOrNull
 * in src/db/queries.ts), because on a [-1, 1] scale the old "coerce to 0"
 * fallback was indistinguishable from a genuine orthogonal hit and logged a
 * corrupt row as a real — and low-confidence — reading.
 */
export function topCosineScore(results: ChunkResult[]): number | null {
  let best: number | null = null;
  for (const r of results) {
    const cosine = r.cosine_similarity;
    if (typeof cosine !== "number" || !Number.isFinite(cosine)) continue;
    if (best === null || cosine > best) best = cosine;
  }
  return best;
}
