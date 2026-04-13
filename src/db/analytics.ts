import { getPool } from "./client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueryLogEntry {
  tool_name: string;
  query_text: string;
  result_count: number;
  top_score: number | null;
  latency_ms: number;
  source_name: string | null;
  session_id: string | null;
}

export interface AnalyticsSummary {
  total_queries: number;
  total_queries_7d: number;
  empty_result_count_7d: number;
  empty_result_rate_7d: number;
  avg_latency_ms_7d: number;
  p95_latency_ms_7d: number;
  queries_by_source: Array<{ source_name: string; count: number }>;
  queries_per_day_7d: Array<{ day: string; count: number }>;
}

export interface TopQuery {
  query_text: string;
  count: number;
  avg_result_count: number;
  avg_top_score: number | null;
}

export interface EmptyQuery {
  query_text: string;
  tool_name: string;
  source_name: string | null;
  count: number;
  last_seen: string;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Log a query to the query_log table.
 * When log_queries is false, query_text is stored as '<redacted>'.
 */
export async function logQuery(
  entry: QueryLogEntry,
  logQueryText: boolean = true,
): Promise<void> {
  const pool = getPool();
  const text = logQueryText ? entry.query_text : "<redacted>";
  await pool.query(
    `INSERT INTO query_log (tool_name, query_text, result_count, top_score, latency_ms, source_name, session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.tool_name,
      text,
      entry.result_count,
      entry.top_score,
      entry.latency_ms,
      entry.source_name,
      entry.session_id,
    ],
  );
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Compute p95 latency in application code instead of SQL.
 * PGlite does NOT support percentile_cont(), so we fetch all latencies
 * and compute the percentile in JS.
 */
function computeP95(latencies: number[]): number {
  if (latencies.length === 0) return 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  const index = Math.floor(sorted.length * 0.95);
  return sorted[Math.min(index, sorted.length - 1)] ?? 0;
}

/**
 * Get a summary of analytics data.
 */
export async function getAnalyticsSummary(): Promise<AnalyticsSummary> {
  const pool = getPool();

  // Note: percentile_cont is NOT used in SQL because PGlite doesn't support it.
  // Instead, we fetch latencies and compute p95 in application code.
  const [totalRes, summary7dRes, latencyRes, bySourceRes, perDayRes] =
    await Promise.all([
      pool.query("SELECT count(*)::int AS count FROM query_log"),
      pool.query(`
            SELECT
                count(*)::int AS total,
                count(*) FILTER (WHERE result_count = 0)::int AS empty,
                COALESCE(avg(latency_ms)::int, 0) AS avg_latency
            FROM query_log
            WHERE created_at > NOW() - INTERVAL '7 days'
        `),
      pool.query(`
            SELECT latency_ms FROM query_log
            WHERE created_at > NOW() - INTERVAL '7 days'
            ORDER BY latency_ms
        `),
      pool.query(`
            SELECT source_name, count(*)::int AS count
            FROM query_log
            WHERE source_name IS NOT NULL
              AND created_at > NOW() - INTERVAL '7 days'
            GROUP BY source_name
            ORDER BY count DESC
        `),
      pool.query(`
            SELECT date_trunc('day', created_at)::date::text AS day, count(*)::int AS count
            FROM query_log
            WHERE created_at > NOW() - INTERVAL '7 days'
            GROUP BY day
            ORDER BY day
        `),
    ]);

  const totalQueries = totalRes.rows[0]?.count ?? 0;
  const s = summary7dRes.rows[0] ?? {};
  const total7d = s.total ?? 0;
  const empty7d = s.empty ?? 0;

  // Compute p95 in application code
  const latencies = latencyRes.rows.map(
    (r: Record<string, unknown>) => r.latency_ms as number,
  );
  const p95Latency = computeP95(latencies);

  return {
    total_queries: totalQueries,
    total_queries_7d: total7d,
    empty_result_count_7d: empty7d,
    empty_result_rate_7d: total7d > 0 ? empty7d / total7d : 0,
    avg_latency_ms_7d: s.avg_latency ?? 0,
    p95_latency_ms_7d: p95Latency,
    queries_by_source: bySourceRes.rows.map((r: Record<string, unknown>) => ({
      source_name: r.source_name as string,
      count: r.count as number,
    })),
    queries_per_day_7d: perDayRes.rows.map((r: Record<string, unknown>) => ({
      day: r.day as string,
      count: r.count as number,
    })),
  };
}

/**
 * Get top queries by frequency over the last N days.
 */
export async function getTopQueries(
  days: number = 7,
  limit: number = 50,
): Promise<TopQuery[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `
        SELECT
            query_text,
            count(*)::int AS count,
            avg(result_count)::real AS avg_result_count,
            avg(top_score)::real AS avg_top_score
        FROM query_log
        WHERE created_at > NOW() - INTERVAL '1 day' * $1
          AND query_text != '<redacted>'
        GROUP BY query_text
        ORDER BY count DESC
        LIMIT $2
    `,
    [days, limit],
  );

  return rows.map((r: Record<string, unknown>) => ({
    query_text: r.query_text as string,
    count: r.count as number,
    avg_result_count: parseFloat(r.avg_result_count as string) || 0,
    avg_top_score:
      r.avg_top_score != null ? parseFloat(r.avg_top_score as string) : null,
  }));
}

/**
 * Get queries that returned zero results, grouped by query text.
 */
export async function getEmptyQueries(
  days: number = 7,
  limit: number = 50,
): Promise<EmptyQuery[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `
        SELECT
            query_text,
            tool_name,
            source_name,
            count(*)::int AS count,
            max(created_at)::text AS last_seen
        FROM query_log
        WHERE result_count = 0
          AND created_at > NOW() - INTERVAL '1 day' * $1
          AND query_text != '<redacted>'
        GROUP BY query_text, tool_name, source_name
        ORDER BY count DESC
        LIMIT $2
    `,
    [days, limit],
  );

  return rows.map((r: Record<string, unknown>) => ({
    query_text: r.query_text as string,
    tool_name: r.tool_name as string,
    source_name: (r.source_name as string) ?? null,
    count: r.count as number,
    last_seen: r.last_seen as string,
  }));
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Delete query_log rows older than the specified number of days.
 * Returns the number of rows deleted.
 */
export async function cleanupOldQueryLogs(
  retentionDays: number,
): Promise<number> {
  const pool = getPool();
  const result = await pool.query(
    `DELETE FROM query_log WHERE created_at < NOW() - INTERVAL '1 day' * $1`,
    [retentionDays],
  );
  return result.rowCount ?? 0;
}
