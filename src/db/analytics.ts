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
  tool_name: string;
  count: number;
  avg_result_count: number | null;
  avg_top_score: number | null;
}

export interface EmptyQuery {
  query_text: string;
  tool_name: string;
  source_name: string | null;
  count: number;
  last_seen: string;
}

export interface ToolCount {
  tool_type: string;
  count: number;
}

export interface AnalyticsFilter {
  tool_type?: string;
  source?: string;
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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build WHERE clause fragments and params for tool_type and source filters.
 * Returns { clauses: string[], params: any[], nextIdx: number }.
 */
function buildFilterClauses(
  filter: AnalyticsFilter,
  startIdx: number = 1,
): { clauses: string[]; params: unknown[]; nextIdx: number } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let idx = startIdx;

  if (filter.tool_type) {
    clauses.push(`tool_name LIKE $${idx} || '-%'`);
    params.push(filter.tool_type);
    idx++;
  }
  if (filter.source) {
    clauses.push(`source_name = $${idx}`);
    params.push(filter.source);
    idx++;
  }

  return { clauses, params, nextIdx: idx };
}

function whereAnd(baseClauses: string[], filterClauses: string[]): string {
  const all = [...baseClauses, ...filterClauses];
  return all.length > 0 ? "WHERE " + all.join(" AND ") : "";
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
export async function getAnalyticsSummary(
  filter: AnalyticsFilter = {},
): Promise<AnalyticsSummary> {
  const pool = getPool();

  const { clauses: fc, params: fp } = buildFilterClauses(filter);

  // Total queries (all time, filtered)
  const totalWhere = whereAnd([], fc);
  const totalRes = await pool.query(
    `SELECT count(*)::int AS count FROM query_log ${totalWhere}`,
    fp,
  );

  // 7d summary (filtered) - exclude backfilled rows from latency/empty stats
  const { clauses: fc2, params: fp2, nextIdx: _ } = buildFilterClauses(filter);
  const base7d = ["created_at > NOW() - INTERVAL '7 days'"];
  const summary7dWhere = whereAnd(base7d, fc2);
  const summary7dRes = await pool.query(
    `SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE result_count = 0)::int AS empty,
        COALESCE(avg(latency_ms) FILTER (WHERE latency_ms >= 0)::int, 0) AS avg_latency
    FROM query_log
    ${summary7dWhere}`,
    fp2,
  );

  // Latencies for p95 (exclude backfilled rows with latency_ms=-1)
  const { clauses: fc3, params: fp3 } = buildFilterClauses(filter);
  const latencyBase = [
    "created_at > NOW() - INTERVAL '7 days'",
    "latency_ms >= 0",
  ];
  const latencyWhere = whereAnd(latencyBase, fc3);
  const latencyRes = await pool.query(
    `SELECT latency_ms FROM query_log ${latencyWhere} ORDER BY latency_ms`,
    fp3,
  );

  // By source (7d, filtered)
  const { clauses: fc4, params: fp4 } = buildFilterClauses(filter);
  const sourceBase = [
    "source_name IS NOT NULL",
    "created_at > NOW() - INTERVAL '7 days'",
  ];
  const sourceWhere = whereAnd(sourceBase, fc4);
  const bySourceRes = await pool.query(
    `SELECT source_name, count(*)::int AS count
    FROM query_log
    ${sourceWhere}
    GROUP BY source_name
    ORDER BY count DESC`,
    fp4,
  );

  // Per day (7d, filtered)
  const { clauses: fc5, params: fp5 } = buildFilterClauses(filter);
  const dayBase = ["created_at > NOW() - INTERVAL '7 days'"];
  const dayWhere = whereAnd(dayBase, fc5);
  const perDayRes = await pool.query(
    `SELECT date_trunc('day', created_at)::date::text AS day, count(*)::int AS count
    FROM query_log
    ${dayWhere}
    GROUP BY day
    ORDER BY day`,
    fp5,
  );

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
 * Now includes tool_name in the grouping.
 */
export async function getTopQueries(
  days: number = 7,
  limit: number = 50,
  filter: AnalyticsFilter = {},
): Promise<TopQuery[]> {
  const pool = getPool();

  const { clauses: fc, params: fp, nextIdx } = buildFilterClauses(filter);
  const baseClauses = [
    `created_at > NOW() - INTERVAL '1 day' * $${nextIdx}`,
    "query_text != '<redacted>'",
  ];
  const where = whereAnd(baseClauses, fc);

  const { rows } = await pool.query(
    `SELECT
        query_text,
        tool_name,
        count(*)::int AS count,
        avg(result_count) FILTER (WHERE result_count >= 0)::real AS avg_result_count,
        avg(top_score) FILTER (WHERE top_score IS NOT NULL)::real AS avg_top_score
    FROM query_log
    ${where}
    GROUP BY query_text, tool_name
    ORDER BY count DESC
    LIMIT $${nextIdx + 1}`,
    [...fp, days, limit],
  );

  return rows.map((r: Record<string, unknown>) => ({
    query_text: r.query_text as string,
    tool_name: r.tool_name as string,
    count: r.count as number,
    avg_result_count:
      r.avg_result_count != null
        ? parseFloat(r.avg_result_count as string)
        : null,
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
  filter: AnalyticsFilter = {},
): Promise<EmptyQuery[]> {
  const pool = getPool();

  const { clauses: fc, params: fp, nextIdx } = buildFilterClauses(filter);
  const baseClauses = [
    "result_count = 0",
    `created_at > NOW() - INTERVAL '1 day' * $${nextIdx}`,
    "query_text != '<redacted>'",
  ];
  const where = whereAnd(baseClauses, fc);

  const { rows } = await pool.query(
    `SELECT
        query_text,
        tool_name,
        source_name,
        count(*)::int AS count,
        max(created_at)::text AS last_seen
    FROM query_log
    ${where}
    GROUP BY query_text, tool_name, source_name
    ORDER BY count DESC
    LIMIT $${nextIdx + 1}`,
    [...fp, days, limit],
  );

  return rows.map((r: Record<string, unknown>) => ({
    query_text: r.query_text as string,
    tool_name: r.tool_name as string,
    source_name: (r.source_name as string) ?? null,
    count: r.count as number,
    last_seen: r.last_seen as string,
  }));
}

/**
 * Get query counts grouped by tool type prefix (e.g. "search", "explore").
 */
export async function getToolCounts(days: number = 7): Promise<ToolCount[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT
        split_part(tool_name, '-', 1) AS tool_type,
        count(*)::int AS count
    FROM query_log
    WHERE created_at > NOW() - INTERVAL '1 day' * $1
    GROUP BY tool_type
    ORDER BY count DESC`,
    [days],
  );

  return rows.map((r: Record<string, unknown>) => ({
    tool_type: r.tool_type as string,
    count: r.count as number,
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
