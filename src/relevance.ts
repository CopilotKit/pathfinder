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
 * A deployment MAY set a positive `min_score` (deploy/copilotkit-docs.yaml uses
 * 0.3 on its four search tools), but that floor is per-tool, optional,
 * request-overridable, and skipped entirely by the keyword and knowledge paths —
 * so it is a property of one config, not of the metric. These constants encode
 * the scale pgvector actually produces; a threshold that wants a tighter floor
 * derives it (see LOW_CONFIDENCE_SCORE_THRESHOLD) instead of assuming the
 * config.
 *
 * The interaction between that floor and this scale is worth stating outright,
 * because getting it wrong is what made the whole metric a lie once already. A
 * `min_score` gates DELIVERY, not measurement: `top_score` records the best
 * cosine the request measured, so the full [-1, 1] range stays reachable in
 * `query_log` no matter how high the floor is set, and the low-confidence
 * classifier can fire across its entire band [-1, 0.5). Reduce the score over
 * the post-floor results instead and the metric collapses onto the config: with
 * a 0.3 floor, `avg_top_score` cannot report below 0.3, and low-confidence can
 * only fire in [0.3, 0.5) because everything worse logs NULL and reads as "no
 * score". That is the censored version this contract exists to prevent — see
 * maxCosineScore and src/mcp/tools/search.ts.
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

/**
 * Best of several independent cosine measurements, or null when none of them is
 * one. The combiner for the case where a request measures relevance in more than
 * one place — which is what `min_score` creates.
 *
 * A retrieval mode with a floor MEASURES a cosine for every vector candidate and
 * then DELIVERS only the ones above the floor. Those are different concerns and
 * `query_log.top_score` belongs to the first: it is the reading this request
 * took of the index, not a summary of what survived the caller's delivery
 * contract. Reducing only over the returned rows made the metric report the
 * floor back at itself — `avg_top_score` could not go below `min_score` by
 * construction, and a query whose best chunk measured 0.29 under a 0.3 floor
 * logged NULL, which analytics reads as "no score at all" and is therefore
 * indistinguishable from a query that matched nothing. See
 * src/mcp/tools/search.ts, where the pre-floor measurement is captured and
 * combined here with whatever cosine still rides on the returned rows.
 *
 * Taking the MAX (rather than preferring the pre-floor reading outright) is
 * deliberate defence in depth: in production the delivered rows are a subset of
 * the measured ones, so the max IS the pre-floor reading; but a retriever that
 * never reports a pre-floor measurement — a future mode, or a test double
 * standing in for one — still contributes the cosine visible on its own output
 * instead of silently degrading `top_score` to NULL.
 */
export function maxCosineScore(...scores: Array<number | null>): number | null {
  let best: number | null = null;
  for (const score of scores) {
    if (typeof score !== "number" || !Number.isFinite(score)) continue;
    if (best === null || score > best) best = score;
  }
  return best;
}
