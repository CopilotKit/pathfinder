// Relevance scoring contract shared by the retrieval tools and the analytics
// layer.
//
// Retrieval produces TWO distinct numbers per result and they must not be
// confused. `ChunkResult.similarity` is a RANKING score whose scale depends on
// the retriever (cosine in vector mode, ts_rank in keyword mode, a Reciprocal
// Rank Fusion score in hybrid mode). `ChunkResult.cosine_similarity` is a
// RELEVANCE score, always on the 0-1 cosine scale or null. Only the latter may
// be persisted, aggregated, or compared against a threshold.

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
 * Upper bound of the metric `query_log.top_score` is recorded on — cosine
 * similarity, which pgvector reports as `1 - (embedding <=> query)` in [0, 1].
 * Exported so any threshold compared against `top_score` can be derived from
 * the scale instead of hard-coded onto it.
 */
export const COSINE_SCORE_MAX = 1;

/**
 * Best RELEVANCE score across a result set: the highest cosine similarity any
 * row carries, or null when none does (an empty set, or a set made entirely of
 * keyword-only hits).
 *
 * This is what belongs in `query_log.top_score` — NOT `Math.max(...similarity)`.
 * Maxing `similarity` persists a cosine in vector mode, a ts_rank in keyword
 * mode, and an RRF fusion score capped at 2/(RRF_K+1) ≈ 0.033 in hybrid mode.
 * Comparing those against a single 0-1 threshold is a scale error: it flagged
 * every scored hybrid query as low-confidence and rendered a meaningless "Avg
 * Score" on the dashboard. Reducing over `cosine_similarity` keeps one metric
 * on one scale in all three modes, at the cost of returning null when only
 * keyword hits came back — which the analytics layer already treats as "no
 * score", not "a low score".
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
