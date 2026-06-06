import pgvector from "pgvector";
import { getPool } from "./client.js";
import type {
  Chunk,
  ChunkResult,
  FaqChunkResult,
  IndexState,
  IndexStatus,
} from "../types.js";

/**
 * Coerce a DB-returned value to a finite JS number, defaulting to 0. Mirrors
 * the `toFiniteNumber` discipline in analytics.ts (getAnalyticsSummary):
 * node-postgres deserializes numeric/`count(*)::int` columns as STRINGS (and
 * `Number()` of a non-numeric value such as "high" or undefined yields NaN),
 * so trusting `as number` / a raw `Number()` risks a string or NaN leaking into
 * similarity sort order, top_score, or the index-stats counts. The
 * `Number.isFinite` guard maps any NaN (and ±Infinity) back to 0. (`Number()`
 * also coerces "" and null to 0, which is the desired default here.) Replicated
 * here rather than imported to avoid coupling queries.ts to an
 * analytics-internal closure.
 */
function toFiniteNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Cosine similarity search on the unified chunks table.
 * Optionally filtered by source_name and/or version. Returns results ordered
 * by similarity (highest first).
 */
export async function searchChunks(
  embedding: number[],
  limit: number,
  sourceName?: string,
  version?: string,
): Promise<ChunkResult[]> {
  const pool = getPool();

  const conditions: string[] = [];
  const params: unknown[] = [pgvector.toSql(embedding)];
  let paramIdx = 2;

  if (sourceName) {
    conditions.push(`source_name = $${paramIdx++}`);
    params.push(sourceName);
  }
  if (version) {
    conditions.push(`version = $${paramIdx++}`);
    params.push(version);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const sql = `
        SELECT
            id,
            source_name,
            source_url,
            title,
            content,
            repo_url,
            file_path,
            start_line,
            end_line,
            language,
            1 - (embedding <=> $1) AS similarity
        FROM chunks
        ${whereClause}
        ORDER BY embedding <=> $1
        LIMIT $${paramIdx}
    `;
  params.push(limit);

  const { rows } = await pool.query(sql, params);
  return rows.map((r: Record<string, unknown>) => ({
    id: r.id as number,
    source_name: r.source_name as string,
    source_url: (r.source_url as string) ?? null,
    title: (r.title as string) ?? null,
    content: r.content as string,
    repo_url: (r.repo_url as string) ?? null,
    file_path: r.file_path as string,
    start_line: (r.start_line as number) ?? null,
    end_line: (r.end_line as number) ?? null,
    language: (r.language as string) ?? null,
    // Coerce to a finite number: a non-numeric similarity would Number() to
    // NaN and corrupt the similarity sort order / top_score downstream.
    similarity: toFiniteNumber(r.similarity),
  }));
}

/**
 * Full-text keyword search using PostgreSQL tsvector/tsquery.
 * Uses plainto_tsquery for safe query parsing (no operator injection).
 * Results are ranked by ts_rank (term frequency relevance).
 */
export async function textSearchChunks(
  pattern: string,
  limit: number,
  sourceName?: string,
  version?: string,
): Promise<ChunkResult[]> {
  if (!pattern.trim()) return [];

  const pool = getPool();

  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  // tsquery from user input — plainto_tsquery handles special chars safely
  conditions.push(`tsv @@ plainto_tsquery('english', $${paramIdx})`);
  params.push(pattern);
  paramIdx++;

  if (sourceName) {
    conditions.push(`source_name = $${paramIdx}`);
    params.push(sourceName);
    paramIdx++;
  }

  if (version) {
    conditions.push(`version = $${paramIdx++}`);
    params.push(version);
  }

  const whereClause = conditions.join(" AND ");

  const sql = `
        SELECT
            id,
            source_name,
            source_url,
            title,
            content,
            repo_url,
            file_path,
            start_line,
            end_line,
            language,
            ts_rank(tsv, plainto_tsquery('english', $1)) AS similarity
        FROM chunks
        WHERE ${whereClause}
        ORDER BY ts_rank(tsv, plainto_tsquery('english', $1)) DESC
        LIMIT $${paramIdx}
    `;
  params.push(limit);

  const { rows } = await pool.query(sql, params);
  return rows.map((r: Record<string, unknown>) => ({
    id: r.id as number,
    source_name: r.source_name as string,
    source_url: (r.source_url as string) ?? null,
    title: (r.title as string) ?? null,
    content: r.content as string,
    repo_url: (r.repo_url as string) ?? null,
    file_path: r.file_path as string,
    start_line: (r.start_line as number) ?? null,
    end_line: (r.end_line as number) ?? null,
    language: (r.language as string) ?? null,
    // Coerce to a finite number: a non-numeric similarity would Number() to
    // NaN and corrupt the similarity sort order / top_score downstream.
    similarity: toFiniteNumber(r.similarity),
  }));
}

/**
 * Hybrid search combining vector similarity and full-text keyword search
 * using Reciprocal Rank Fusion (RRF) to merge ranked lists.
 *
 * Strategy: run two independent indexed queries (vector + keyword),
 * then merge in application code using RRF scoring.
 * This is faster than a single SQL query because each query uses its
 * respective index (HNSW for vector, GIN for tsvector).
 *
 * min_score gates ONLY the vector candidates, and does so BEFORE the RRF
 * merge. It is a cosine-similarity floor, so it is meaningful only for the
 * vector list; the keyword list has no comparable score. A hit that surfaces
 * via keyword search but is NOT in the surviving vector set therefore enters
 * the fused output UNGATED by min_score — min_score raises the semantic floor
 * of the vector contribution, it does not filter keyword-only matches.
 */
export async function hybridSearchChunks(
  embedding: number[],
  queryText: string,
  limit: number,
  sourceName?: string,
  version?: string,
  minScore?: number,
): Promise<ChunkResult[]> {
  // Fetch 2x candidates from each retriever to ensure good RRF coverage
  const candidateLimit = limit * 2;

  // Run both searches in parallel
  const [vectorResults, keywordResults] = await Promise.all([
    searchChunks(embedding, candidateLimit, sourceName, version),
    textSearchChunks(queryText, candidateLimit, sourceName, version),
  ]);

  // Apply min_score to the VECTOR candidates only, before merging. Keyword-only
  // hits (present in keywordResults but not in the surviving vector set) are not
  // score-gated here — they still enter the RRF merge below.
  const filteredVectorResults =
    minScore != null
      ? vectorResults.filter((r) => r.similarity >= minScore)
      : vectorResults;

  return rrfMerge(filteredVectorResults, keywordResults, limit);
}

/**
 * Reciprocal Rank Fusion: merges two ranked lists into one.
 *
 * RRF_score(doc) = 1/(k + rank_vector) + 1/(k + rank_keyword)
 *
 * where k = 60 (standard constant from the original RRF paper).
 * Documents appearing in only one list get a single-term score.
 *
 * Exported for direct unit testing of the merge logic.
 */
export const RRF_K = 60;

export function rrfMerge(
  vectorResults: ChunkResult[],
  keywordResults: ChunkResult[],
  limit: number,
): ChunkResult[] {
  // Map chunk ID -> { rrfScore, bestResult }
  const scores = new Map<number, { rrfScore: number; result: ChunkResult }>();

  // Score vector results by rank position
  for (let i = 0; i < vectorResults.length; i++) {
    const r = vectorResults[i];
    if (scores.has(r.id)) continue; // keep first/best-ranked
    const rank = i + 1; // 1-indexed
    const rrfScore = 1 / (RRF_K + rank);
    scores.set(r.id, { rrfScore, result: r });
  }

  // Score keyword results by rank position, accumulate
  const seenKeyword = new Set<number>();
  for (let i = 0; i < keywordResults.length; i++) {
    const r = keywordResults[i];
    if (seenKeyword.has(r.id)) continue; // keep first/best-ranked
    seenKeyword.add(r.id);
    const rank = i + 1;
    const rrfContribution = 1 / (RRF_K + rank);

    const existing = scores.get(r.id);
    if (existing) {
      existing.rrfScore += rrfContribution;
      // Keep the vector result (has cosine similarity) as the canonical result
    } else {
      scores.set(r.id, { rrfScore: rrfContribution, result: r });
    }
  }

  // Sort by RRF score descending, take top N
  const sorted = Array.from(scores.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, limit);

  // Return ChunkResult[] with similarity set to the RRF score
  return sorted.map(({ rrfScore, result }) => ({
    ...result,
    similarity: rrfScore,
  }));
}

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------

/**
 * SQL for inserting a single chunk row, updating in place on the
 * (source_name, file_path, chunk_index) conflict. Shared by upsertChunks and
 * replaceChunksForFile so the column list and tsv derivation stay in lockstep.
 */
const INSERT_CHUNK_SQL = `
            INSERT INTO chunks
                (source_name, source_url, title, content, embedding, repo_url,
                 file_path, start_line, end_line, language, chunk_index,
                 metadata, commit_sha, version, indexed_at, tsv)
            VALUES
                ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(),
                 to_tsvector('english', $4))
            ON CONFLICT (source_name, file_path, chunk_index) DO UPDATE SET
                source_url = EXCLUDED.source_url,
                title      = EXCLUDED.title,
                content    = EXCLUDED.content,
                embedding  = EXCLUDED.embedding,
                repo_url   = EXCLUDED.repo_url,
                start_line = EXCLUDED.start_line,
                end_line   = EXCLUDED.end_line,
                language   = EXCLUDED.language,
                metadata   = EXCLUDED.metadata,
                commit_sha = EXCLUDED.commit_sha,
                version    = EXCLUDED.version,
                indexed_at = NOW(),
                tsv        = EXCLUDED.tsv
        `;

/** Positional params for INSERT_CHUNK_SQL, in column order. */
function chunkInsertParams(chunk: Chunk): unknown[] {
  return [
    chunk.source_name,
    chunk.source_url ?? null,
    chunk.title ?? null,
    chunk.content,
    pgvector.toSql(chunk.embedding),
    chunk.repo_url,
    chunk.file_path,
    chunk.start_line ?? null,
    chunk.end_line ?? null,
    chunk.language ?? null,
    chunk.chunk_index,
    JSON.stringify(chunk.metadata ?? {}),
    chunk.commit_sha ?? null,
    chunk.version ?? null,
  ];
}

/**
 * Atomically replace all chunks for a (source_name, file_path) pair: delete the
 * file's existing chunks and insert the new set on a SINGLE pooled client inside
 * one BEGIN/COMMIT, rolling back on any error.
 *
 * This is the durable form of "delete old chunks, then upsert new ones". Running
 * the DELETE and the INSERTs as separate awaits risks permanent data loss: if an
 * INSERT throws after the DELETE has committed, the file is left with zero chunks
 * (and the caller typically advances its index-state token, so the gap is never
 * re-filled). Wrapping both in a transaction guarantees the pre-existing chunks
 * survive intact when any insert fails.
 *
 * Passing an empty `chunks` array performs the delete only (used to drop a file
 * that no longer produces any chunks).
 */
export async function replaceChunksForFile(
  sourceName: string,
  filePath: string,
  chunks: Chunk[],
): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM chunks WHERE source_name = $1 AND file_path = $2",
      [sourceName, filePath],
    );
    for (const chunk of chunks) {
      await client.query(INSERT_CHUNK_SQL, chunkInsertParams(chunk));
    }
    await client.query("COMMIT");
  } catch (err) {
    // Swallow a ROLLBACK rejection (e.g. dead connection) so it can't mask the
    // ORIGINAL error — that error is the real cause and must reach the caller.
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Batch upsert chunks. Uses ON CONFLICT to update existing rows matched by
 * (source_name, file_path, chunk_index).
 */
export async function upsertChunks(chunks: Chunk[]): Promise<void> {
  if (chunks.length === 0) return;

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const chunk of chunks) {
      await client.query(INSERT_CHUNK_SQL, chunkInsertParams(chunk));
    }

    await client.query("COMMIT");
  } catch (err) {
    // Swallow a ROLLBACK rejection so it can't mask the original error.
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Delete all chunks for a given source + file path.
 */
export async function deleteChunksByFile(
  sourceName: string,
  filePath: string,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    "DELETE FROM chunks WHERE source_name = $1 AND file_path = $2",
    [sourceName, filePath],
  );
}

/**
 * Delete all chunks for a source (useful for full reindex).
 */
export async function deleteChunksBySource(sourceName: string): Promise<void> {
  const pool = getPool();
  await pool.query("DELETE FROM chunks WHERE source_name = $1", [sourceName]);
}

/**
 * Get all unique item IDs (stored as file_path) for a given source.
 * Used by providers that support deleted-item detection during incremental acquire.
 */
export async function getIndexedItemIds(
  sourceName: string,
): Promise<Set<string>> {
  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT DISTINCT file_path FROM chunks WHERE source_name = $1",
    [sourceName],
  );
  return new Set(
    rows.map((r: Record<string, unknown>) => r.file_path as string),
  );
}

// ---------------------------------------------------------------------------
// Index state
// ---------------------------------------------------------------------------

/**
 * Get the indexing state for a given source.
 */
export async function getIndexState(
  sourceType: string,
  sourceKey: string,
): Promise<IndexState | null> {
  const pool = getPool();
  const sql = `
        SELECT source_type, source_key, last_commit_sha, last_indexed_at, status, error_message
        FROM index_state
        WHERE source_type = $1 AND source_key = $2
    `;
  const { rows } = await pool.query(sql, [sourceType, sourceKey]);
  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    source_type: row.source_type,
    source_key: row.source_key,
    last_commit_sha: row.last_commit_sha,
    last_indexed_at: row.last_indexed_at,
    status: row.status as IndexStatus,
    error_message: row.error_message,
  };
}

/**
 * Upsert the indexing state for a given source.
 */
export async function upsertIndexState(state: IndexState): Promise<void> {
  const pool = getPool();
  const sql = `
        INSERT INTO index_state
            (source_type, source_key, last_commit_sha, last_indexed_at, status, error_message)
        VALUES
            ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (source_type, source_key) DO UPDATE SET
            last_commit_sha = EXCLUDED.last_commit_sha,
            last_indexed_at = EXCLUDED.last_indexed_at,
            status          = EXCLUDED.status,
            error_message   = EXCLUDED.error_message
    `;
  await pool.query(sql, [
    state.source_type,
    state.source_key,
    state.last_commit_sha ?? null,
    state.last_indexed_at ?? null,
    state.status ?? "idle",
    state.error_message ?? null,
  ]);
}

// ---------------------------------------------------------------------------
// Collected data
// ---------------------------------------------------------------------------

/**
 * Insert a row into the collected_data table.
 */
export async function insertCollectedData(
  toolName: string,
  data: Record<string, unknown>,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    "INSERT INTO collected_data (tool_name, data) VALUES ($1, $2)",
    [toolName, JSON.stringify(data)],
  );
}

// ---------------------------------------------------------------------------
// Webhook delivery tracking
// ---------------------------------------------------------------------------

export interface WebhookDelivery {
  id: number;
  source: string;
  event_type: string | null;
  repo: string | null;
  decision: string;
  reason: string | null;
  payload_size: number | null;
  delivered_at: Date;
}

/**
 * Record a webhook delivery. Fire-and-forget: catches all errors and logs
 * them so webhook processing is never blocked by tracking failures.
 */
export async function recordWebhookDelivery(delivery: {
  source: string;
  event_type?: string;
  repo?: string;
  decision: string;
  reason?: string;
  payload_size?: number;
}): Promise<void> {
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO webhook_deliveries (source, event_type, repo, decision, reason, payload_size)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        delivery.source,
        delivery.event_type ?? null,
        delivery.repo ?? null,
        delivery.decision,
        delivery.reason ?? null,
        delivery.payload_size ?? null,
      ],
    );
  } catch (err) {
    console.error("[webhook-tracking] Failed to record delivery:", err);
  }
}

/**
 * Fetch recent webhook deliveries, ordered by most recent first.
 */
export async function getRecentWebhookDeliveries(
  limit: number = 50,
): Promise<WebhookDelivery[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, source, event_type, repo, decision, reason, payload_size, delivered_at
     FROM webhook_deliveries
     ORDER BY delivered_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map((r: Record<string, unknown>) => ({
    id: r.id as number,
    source: r.source as string,
    event_type: (r.event_type as string) ?? null,
    repo: (r.repo as string) ?? null,
    decision: r.decision as string,
    reason: (r.reason as string) ?? null,
    payload_size: (r.payload_size as number) ?? null,
    delivered_at: r.delivered_at as Date,
  }));
}

/**
 * Get webhook delivery stats for the last 24 hours, for the health endpoint.
 */
export async function getWebhookDeliveryStats(): Promise<{
  total_24h: number;
  by_decision: Record<string, number>;
  last_delivery_at: string | null;
  errors_24h: Array<{
    source: string;
    reason: string | null;
    delivered_at: Date;
  }>;
}> {
  const pool = getPool();

  const [countsResult, lastResult, errorsResult] = await Promise.all([
    pool.query(
      `SELECT decision, count(*)::int AS count
       FROM webhook_deliveries
       WHERE delivered_at > NOW() - INTERVAL '24 hours'
       GROUP BY decision`,
    ),
    pool.query(
      `SELECT delivered_at FROM webhook_deliveries ORDER BY delivered_at DESC LIMIT 1`,
    ),
    pool.query(
      `SELECT source, reason, delivered_at
       FROM webhook_deliveries
       WHERE decision = 'error' AND delivered_at > NOW() - INTERVAL '24 hours'
       ORDER BY delivered_at DESC`,
    ),
  ]);

  const byDecision: Record<string, number> = {};
  let total = 0;
  for (const row of countsResult.rows) {
    // Coerce through toFiniteNumber: node-postgres deserializes count(*)::int as
    // a STRING, and by_decision is declared Record<string, number> and
    // serialized into the /health endpoint, so storing the raw string emits
    // {"accept":"5"} — a user-facing type violation. Mirrors the toFiniteNumber
    // discipline used by every sibling count site (getIndexStats, analytics.ts).
    byDecision[row.decision as string] = toFiniteNumber(row.count);
    // The total likewise coerces before accumulating: a driver returning the
    // count as a string would make `0 + "5"` evaluate to "05" (string concat),
    // corrupting the total.
    total += toFiniteNumber(row.count);
  }

  const lastRow = lastResult.rows[0];
  const lastDeliveryAt = lastRow
    ? (lastRow.delivered_at as Date).toISOString()
    : null;

  const errors = errorsResult.rows.map((r: Record<string, unknown>) => ({
    source: r.source as string,
    reason: (r.reason as string) ?? null,
    delivered_at: r.delivered_at as Date,
  }));

  return {
    total_24h: total,
    by_decision: byDecision,
    last_delivery_at: lastDeliveryAt,
    errors_24h: errors,
  };
}

// ---------------------------------------------------------------------------
// Webhook delivery cleanup
// ---------------------------------------------------------------------------

/**
 * Delete webhook_deliveries rows older than the specified number of days.
 * Mirrors cleanupOldQueryLogs in analytics.ts — rolling retention window
 * anchored to NOW().
 *
 * Returns the number of rows deleted.
 */
export async function cleanupOldWebhookDeliveries(
  retentionDays: number,
): Promise<number> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new Error(
      `[webhook-tracking] cleanupOldWebhookDeliveries: invalid retentionDays=${retentionDays} (must be a positive finite number)`,
    );
  }
  const pool = getPool();
  try {
    const result = await pool.query(
      `DELETE FROM webhook_deliveries WHERE delivered_at <= NOW() - INTERVAL '1 day' * $1`,
      [retentionDays],
    );
    const rowCount = result.rowCount ?? 0;
    console.log(
      `[webhook-tracking] cleanupOldWebhookDeliveries: deleted ${rowCount} rows older than ${retentionDays} days`,
    );
    return rowCount;
  } catch (err) {
    console.error(
      `[webhook-tracking] cleanupOldWebhookDeliveries failed (retentionDays=${retentionDays})`,
      err,
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export interface IndexStats {
  totalChunks: number;
  bySource: Array<{ source_name: string; count: number }>;
  indexedRepos: number;
  indexStates: IndexState[];
}

/**
 * Fetch all chunks (without embeddings) for llms.txt generation.
 * Ordered by source_name, file_path, chunk_index for deterministic output.
 */
export async function getAllChunksForLlms(): Promise<
  {
    source_name: string;
    file_path: string;
    title: string | null;
    content: string;
    chunk_index: number;
  }[]
> {
  const pool = getPool();
  const result = await pool.query(
    "SELECT source_name, file_path, title, content, chunk_index FROM chunks ORDER BY source_name, file_path, chunk_index",
  );
  return result.rows;
}

/**
 * Fetch FAQ chunks filtered by source name and minimum confidence.
 * Confidence is stored in chunk metadata JSONB; this query extracts and filters it.
 * Results are ordered by indexed_at DESC, then id DESC — i.e. global recency
 * across all queried sources. source_name deliberately does NOT lead the
 * ordering: a leading source_name would let a global LIMIT be consumed entirely
 * by the alphabetically-first source, starving more-recent rows from later
 * sources.
 */
export async function getFaqChunks(
  sourceNames: string[],
  minConfidence: number,
  limit?: number,
): Promise<FaqChunkResult[]> {
  const pool = getPool();

  if (sourceNames.length === 0) return [];

  // Build parameterized source_name IN clause
  const placeholders = sourceNames.map((_, i) => `$${i + 1}`).join(", ");
  const confidenceParam = sourceNames.length + 1;

  // Guard BOTH confidence casts with jsonb_typeof so a row whose `confidence`
  // KEY exists but holds non-numeric text (e.g. "high") degrades to 0.0 instead
  // of raising `invalid input syntax for type double precision` and crashing the
  // whole browse listing. `metadata ? 'confidence'` only checks key presence —
  // it does NOT guarantee the value is a number — so the raw `::float` cast in
  // the projection AND the WHERE comparison could each crash on a single bad
  // row. Mirrors the CASE guard in getFaqChunksByIds. A degraded 0.0 row is
  // correctly excluded by any positive minConfidence threshold.
  let sql = `
        SELECT
            id,
            source_name,
            source_url,
            title,
            content,
            repo_url,
            file_path,
            start_line,
            end_line,
            language,
            0.0 AS similarity,
            metadata,
            CASE
              WHEN jsonb_typeof(metadata->'confidence') = 'number'
              THEN (metadata->>'confidence')::float
              ELSE 0.0
            END AS confidence
        FROM chunks
        WHERE source_name IN (${placeholders})
          AND metadata ? 'confidence'
          AND CASE
                WHEN jsonb_typeof(metadata->'confidence') = 'number'
                THEN (metadata->>'confidence')::float
                ELSE 0.0
              END >= $${confidenceParam}
        ORDER BY indexed_at DESC, id DESC
    `;

  const params: unknown[] = [...sourceNames, minConfidence];

  if (limit != null) {
    sql += ` LIMIT $${confidenceParam + 1}`;
    params.push(limit);
  }

  const { rows } = await pool.query(sql, params);
  return rows.map((r: Record<string, unknown>) => ({
    id: r.id as number,
    source_name: r.source_name as string,
    source_url: (r.source_url as string) ?? null,
    title: (r.title as string) ?? null,
    content: r.content as string,
    repo_url: (r.repo_url as string) ?? null,
    file_path: r.file_path as string,
    start_line: (r.start_line as number) ?? null,
    end_line: (r.end_line as number) ?? null,
    language: (r.language as string) ?? null,
    // Coerce to a finite number: a non-numeric similarity string would Number()
    // to NaN and corrupt sort order / top_score. Same guard as confidence below.
    similarity: toFiniteNumber(r.similarity),
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    // Coerce to a finite number for the same reason as similarity above:
    // toFiniteNumber maps a non-numeric confidence string (Number(...)=NaN) back
    // to 0, while null/'' already Number() to 0 — either way confidence stays a
    // finite number so threshold comparisons / sort order are not corrupted.
    confidence: toFiniteNumber(r.confidence),
  }));
}

/**
 * Fetch FAQ metadata (including extracted confidence) for an EXACT set of chunk
 * ids. Unlike getFaqChunks, this does NOT order by indexed_at or apply a top-N
 * window — the caller has already ranked the ids (e.g. by vector similarity) and
 * needs the FAQ confidence/metadata for precisely those rows.
 *
 * This exists because cross-referencing similarity hits against an
 * indexed_at-DESC top-N window silently drops a relevant hit whose id falls
 * outside that recency window. Looking up by id keeps every ranked hit.
 *
 * Returns rows in arbitrary order; the caller re-associates them by id and
 * applies its own confidence threshold. Empty input → no query, empty result.
 */
export async function getFaqChunksByIds(
  ids: number[],
): Promise<FaqChunkResult[]> {
  if (ids.length === 0) return [];

  const pool = getPool();
  // Guard the confidence cast: getFaqChunksByIds looks up an EXACT id set with
  // no `metadata ? 'confidence'` WHERE filter (unlike getFaqChunks), so a
  // single row whose confidence is non-numeric text (e.g. "high") would raise
  // `invalid input syntax for type double precision` and reject the WHOLE
  // knowledge lookup. The jsonb_typeof check casts only genuine JSON numbers
  // and degrades any malformed/missing value to 0.0 so one bad row can't crash
  // the search.
  const sql = `
        SELECT
            id,
            source_name,
            source_url,
            title,
            content,
            repo_url,
            file_path,
            start_line,
            end_line,
            language,
            0.0 AS similarity,
            metadata,
            CASE
              WHEN jsonb_typeof(metadata->'confidence') = 'number'
              THEN (metadata->>'confidence')::float
              ELSE 0.0
            END AS confidence
        FROM chunks
        WHERE id = ANY($1)
    `;

  const { rows } = await pool.query(sql, [ids]);
  return rows.map((r: Record<string, unknown>) => ({
    id: r.id as number,
    source_name: r.source_name as string,
    source_url: (r.source_url as string) ?? null,
    title: (r.title as string) ?? null,
    content: r.content as string,
    repo_url: (r.repo_url as string) ?? null,
    file_path: r.file_path as string,
    start_line: (r.start_line as number) ?? null,
    end_line: (r.end_line as number) ?? null,
    language: (r.language as string) ?? null,
    // Coerce to a finite number: a non-numeric similarity would Number() to NaN
    // and corrupt sort order / top_score. Same guard as confidence below.
    similarity: toFiniteNumber(r.similarity),
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    // Coerce to a finite number for the same reason as similarity above: a
    // null/non-numeric confidence would otherwise yield NaN and corrupt
    // threshold comparisons / sort order.
    confidence: toFiniteNumber(r.confidence),
  }));
}

/**
 * Get aggregate statistics for the health endpoint.
 */
export async function getIndexStats(): Promise<IndexStats> {
  const pool = getPool();

  const [totalCount, bySource, repoCount, states] = await Promise.all([
    pool.query("SELECT count(*)::int AS count FROM chunks"),
    pool.query(
      "SELECT source_name, count(*)::int AS count FROM chunks GROUP BY source_name ORDER BY source_name",
    ),
    pool.query(
      "SELECT count(DISTINCT repo_url)::int AS count FROM chunks WHERE repo_url IS NOT NULL",
    ),
    pool.query(
      "SELECT source_type, source_key, last_commit_sha, last_indexed_at, status, error_message FROM index_state ORDER BY source_type, source_key",
    ),
  ]);

  // Coerce the counts through toFiniteNumber: although each is `count(*)::int`
  // in SQL, node-postgres deserializes integer/numeric columns as STRINGS, so
  // `as number` / `?? 0` would let a string leak into totalChunks/indexedRepos
  // (and `?? 0` only catches null/undefined, not a "0" string). Mirrors the
  // same discipline in getAnalyticsSummary.
  return {
    totalChunks: toFiniteNumber(totalCount.rows[0]?.count),
    bySource: bySource.rows.map((r: Record<string, unknown>) => ({
      source_name: r.source_name as string,
      count: toFiniteNumber(r.count),
    })),
    indexedRepos: toFiniteNumber(repoCount.rows[0]?.count),
    indexStates: states.rows.map((r: Record<string, unknown>) => ({
      source_type: r.source_type as string,
      source_key: r.source_key as string,
      last_commit_sha: r.last_commit_sha as string | null,
      last_indexed_at: r.last_indexed_at as Date | null,
      status: r.status as IndexStatus,
      error_message: r.error_message as string | null,
    })),
  };
}
