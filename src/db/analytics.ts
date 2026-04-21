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
  total_queries_window: number;
  empty_result_count_window: number;
  empty_result_rate_window: number;
  avg_latency_ms_window: number;
  p95_latency_ms_window: number;
  queries_by_source: Array<{ source_name: string; count: number }>;
  queries_per_day_window: Array<{ day: string; count: number }>;
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
  /**
   * Optional inclusive date range. When both `from` and `to` are set the
   * underlying queries filter on `created_at >= from AND created_at <= to`
   * instead of the default `NOW() - INTERVAL '<days> days'` window.
   *
   * Callers should ensure both are provided together; endpoints reject
   * half-specified ranges before they reach the DB layer.
   */
  from?: Date;
  to?: Date;
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
  try {
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
  } catch (err) {
    // Telemetry failures must never break tool callers. Swallow the error
    // after logging with enough context (tool_name + source_name) to
    // diagnose. The tool result path is the source of truth for the
    // caller; a missing analytics row is preferable to a failed tool call.
    console.error(
      `[analytics] logQuery failed (tool_name=${entry.tool_name} source_name=${entry.source_name ?? "null"}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escape LIKE pattern metacharacters so user-supplied values don't act as
 * wildcards. Applied with an explicit `ESCAPE '|'` clause on the LIKE so
 * that literal `%`, `_`, and `|` in the input match exactly.
 *
 * We use `|` (pipe) rather than the SQL-standard `\` to sidestep a Postgres
 * gotcha: with `standard_conforming_strings=on` (the default since 9.1), the
 * literal `'\\'` is TWO characters, not one, and `ESCAPE` requires exactly
 * one character. Using `|` keeps the SQL literal unambiguous regardless of
 * `standard_conforming_strings` mode.
 */
function escapeLikePattern(s: string): string {
  return s.replace(/([|%_])/g, "|$1");
}

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
    // Escape LIKE metacharacters in user input; declare the escape character
    // explicitly so `%` and `_` in the input match literally rather than as
    // wildcards.
    clauses.push(`tool_name LIKE $${idx} || '-%' ESCAPE '|'`);
    params.push(escapeLikePattern(filter.tool_type));
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

/**
 * Build a date-window clause + params for the given filter, falling back to
 * a rolling "last N days" window when `from`/`to` are not provided.
 *
 * - When `filter.from` and `filter.to` are both set, returns
 *   `created_at >= $N AND created_at <= $N+1` with the two Date params.
 * - Otherwise, returns `created_at > NOW() - INTERVAL '1 day' * $N` with the
 *   `days` number param.
 *
 * `startIdx` is the next available `$` placeholder index. The returned
 * `nextIdx` is the next index to use after this clause.
 */
function buildDateWindow(
  filter: AnalyticsFilter,
  days: number,
  startIdx: number,
): { clauses: string[]; params: unknown[]; nextIdx: number } {
  if (filter.from && filter.to) {
    return {
      clauses: [`created_at >= $${startIdx}`, `created_at <= $${startIdx + 1}`],
      params: [filter.from, filter.to],
      nextIdx: startIdx + 2,
    };
  }
  return {
    clauses: [`created_at > NOW() - INTERVAL '1 day' * $${startIdx}`],
    params: [days],
    nextIdx: startIdx + 1,
  };
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
 *
 * `days` controls the rolling "last N days" window for the non-total
 * subqueries (summary counts, latency, per-day, by-source). When the caller
 * supplies `filter.from`/`filter.to`, that explicit range takes precedence
 * and `days` is ignored — see {@link buildDateWindow}.
 */
export async function getAnalyticsSummary(
  filter: AnalyticsFilter = {},
  days: number = 7,
): Promise<AnalyticsSummary> {
  const pool = getPool();

  const { clauses: fc, params: fp } = buildFilterClauses(filter);

  // Total queries (all time, filtered)
  const totalWhere = whereAnd([], fc);
  const totalRes = await pool.query(
    `SELECT count(*)::int AS count FROM query_log ${totalWhere}`,
    fp,
  );

  // Windowed summary. Backfilled rows (latency_ms<0) are excluded from every
  // windowed aggregate (summary, latency, by-source, per-day, getToolCounts,
  // getTopQueries, getEmptyQueries) for consistency: otherwise the
  // empty_result_rate_window denominator would include backfilled rows
  // while the numerator and avg_latency implicitly exclude them, inflating
  // the rate. All windowed aggregates exclude `latency_ms < 0`. The only
  // aggregate that intentionally includes backfilled rows is the all-time
  // `total_queries` count in this function (see the totals query below).
  const { clauses: fc2, params: fp2, nextIdx: n2 } = buildFilterClauses(filter);
  const dw2 = buildDateWindow(filter, days, n2);
  const summaryBase = [...dw2.clauses, "latency_ms >= 0"];
  const summaryWhere = whereAnd(summaryBase, fc2);
  const summaryRes = await pool.query(
    `SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE result_count = 0)::int AS empty,
        COALESCE(avg(latency_ms)::int, 0) AS avg_latency
    FROM query_log
    ${summaryWhere}`,
    [...fp2, ...dw2.params],
  );

  // Latencies for p95 (exclude backfilled rows where latency_ms < 0)
  const { clauses: fc3, params: fp3, nextIdx: n3 } = buildFilterClauses(filter);
  const dw3 = buildDateWindow(filter, days, n3);
  const latencyBase = [...dw3.clauses, "latency_ms >= 0"];
  const latencyWhere = whereAnd(latencyBase, fc3);
  const latencyRes = await pool.query(
    `SELECT latency_ms FROM query_log ${latencyWhere} ORDER BY latency_ms`,
    [...fp3, ...dw3.params],
  );

  // By source (filtered). Excludes backfilled rows (latency_ms < 0) so the
  // doughnut totals line up with summary + per-day.
  const { clauses: fc4, params: fp4, nextIdx: n4 } = buildFilterClauses(filter);
  const dw4 = buildDateWindow(filter, days, n4);
  const sourceBase = [
    "source_name IS NOT NULL",
    ...dw4.clauses,
    "latency_ms >= 0",
  ];
  const sourceWhere = whereAnd(sourceBase, fc4);
  const bySourceRes = await pool.query(
    `SELECT source_name, count(*)::int AS count
    FROM query_log
    ${sourceWhere}
    GROUP BY source_name
    ORDER BY count DESC`,
    [...fp4, ...dw4.params],
  );

  // Per day (filtered). Excludes backfilled rows (latency_ms < 0) so the
  // per-day bars match the summary/latency aggregates above.
  const { clauses: fc5, params: fp5, nextIdx: n5 } = buildFilterClauses(filter);
  const dw5 = buildDateWindow(filter, days, n5);
  const dayBase = [...dw5.clauses, "latency_ms >= 0"];
  const dayWhere = whereAnd(dayBase, fc5);
  const perDayRes = await pool.query(
    `SELECT date_trunc('day', created_at)::date::text AS day, count(*)::int AS count
    FROM query_log
    ${dayWhere}
    GROUP BY day
    ORDER BY day`,
    [...fp5, ...dw5.params],
  );

  const totalQueries = totalRes.rows[0]?.count ?? 0;
  const s = summaryRes.rows[0] ?? {};
  const totalWindow = s.total ?? 0;
  const emptyWindow = s.empty ?? 0;

  // Compute p95 in application code
  const latencies = latencyRes.rows.map(
    (r: Record<string, unknown>) => r.latency_ms as number,
  );
  const p95Latency = computeP95(latencies);

  return {
    total_queries: totalQueries,
    total_queries_window: totalWindow,
    empty_result_count_window: emptyWindow,
    empty_result_rate_window: totalWindow > 0 ? emptyWindow / totalWindow : 0,
    avg_latency_ms_window: s.avg_latency ?? 0,
    p95_latency_ms_window: p95Latency,
    queries_by_source: bySourceRes.rows.map((r: Record<string, unknown>) => ({
      source_name: r.source_name as string,
      count: r.count as number,
    })),
    queries_per_day_window: perDayRes.rows.map(
      (r: Record<string, unknown>) => ({
        day: r.day as string,
        count: r.count as number,
      }),
    ),
  };
}

/**
 * Get top queries by frequency over the last N days, or over the explicit
 * `filter.from`/`filter.to` range when provided. Groups by (query_text,
 * tool_name) and orders by count desc.
 */
export async function getTopQueries(
  days: number = 7,
  limit: number = 50,
  filter: AnalyticsFilter = {},
): Promise<TopQuery[]> {
  const pool = getPool();

  const { clauses: fc, params: fp, nextIdx } = buildFilterClauses(filter);
  const dw = buildDateWindow(filter, days, nextIdx);
  const baseClauses = [
    ...dw.clauses,
    "query_text != '<redacted>'",
    "latency_ms >= 0",
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
    LIMIT $${dw.nextIdx}`,
    [...fp, ...dw.params, limit],
  );

  return rows.map((r: Record<string, unknown>) => {
    // parseFloat can produce NaN for unexpected values. Guard with
    // Number.isFinite so stat rendering downstream doesn't produce a
    // literal "NaN" in the Top Queries table.
    const avgRc =
      r.avg_result_count != null
        ? parseFloat(r.avg_result_count as string)
        : null;
    const avgTs =
      r.avg_top_score != null ? parseFloat(r.avg_top_score as string) : null;
    return {
      query_text: r.query_text as string,
      tool_name: r.tool_name as string,
      count: r.count as number,
      avg_result_count: avgRc != null && Number.isFinite(avgRc) ? avgRc : null,
      avg_top_score: avgTs != null && Number.isFinite(avgTs) ? avgTs : null,
    };
  });
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
  const dw = buildDateWindow(filter, days, nextIdx);
  const baseClauses = [
    "result_count = 0",
    ...dw.clauses,
    "query_text != '<redacted>'",
    "latency_ms >= 0",
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
    LIMIT $${dw.nextIdx}`,
    [...fp, ...dw.params, limit],
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
 *
 * Accepts an optional filter with `from`/`to` to use an explicit date range.
 * When not provided, falls back to the rolling "last N days" window.
 */
export async function getToolCounts(
  days: number = 7,
  filter: AnalyticsFilter = {},
): Promise<ToolCount[]> {
  const pool = getPool();

  // tool_type intentionally ignored: filtering tool counts by tool type would
  // be circular (asking "what tool types exist given only this one"). We only
  // honor `source` from the filter here.
  const { tool_type: _ignoredToolType, ...rest } = filter;
  void _ignoredToolType;
  const sourceOnlyFilter: AnalyticsFilter = rest;

  const {
    clauses: fc,
    params: fp,
    nextIdx,
  } = buildFilterClauses(sourceOnlyFilter);
  const dw = buildDateWindow(sourceOnlyFilter, days, nextIdx);
  // Exclude backfilled rows (latency_ms < 0) so tool counts match the
  // windowed aggregates used elsewhere (summary, latency, per-day).
  const baseClauses = [...dw.clauses, "latency_ms >= 0"];
  const where = whereAnd(baseClauses, fc);
  const { rows } = await pool.query(
    `SELECT
        split_part(tool_name, '-', 1) AS tool_type,
        count(*)::int AS count
    FROM query_log
    ${where}
    GROUP BY tool_type
    ORDER BY count DESC`,
    [...fp, ...dw.params],
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
 *
 * This is a rolling retention window anchored to NOW(); it does not accept
 * an AnalyticsFilter. Per-filter deletion isn't a supported operation —
 * retention is global.
 *
 * Returns the number of rows deleted.
 */
export async function cleanupOldQueryLogs(
  retentionDays: number,
): Promise<number> {
  // Hard-reject non-positive or non-finite retention. Crucially guards
  // against `cleanupOldQueryLogs(0)` which would otherwise translate to
  // `created_at <= NOW() - 0 days` and delete the entire table. NaN and
  // negatives are rejected for the same reason.
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    console.warn(
      `[analytics] cleanupOldQueryLogs: invalid retentionDays=${retentionDays}, skipping`,
    );
    return 0;
  }
  const pool = getPool();
  // Use `<=` here so the partition is complete vs. the rolling-window reads
  // (which use `created_at > NOW() - INTERVAL`). With strict `<`, rows sitting
  // exactly at the retention edge would be visible to reads but not cleaned
  // up by retention. `<=` is the safer choice — we'd rather delete an extra
  // row at the boundary than leak rows past the retention window.
  try {
    const result = await pool.query(
      `DELETE FROM query_log WHERE created_at <= NOW() - INTERVAL '1 day' * $1`,
      [retentionDays],
    );
    const rowCount = result.rowCount ?? 0;
    console.log(
      `[analytics] cleanupOldQueryLogs: deleted ${rowCount} rows older than ${retentionDays} days`,
    );
    return rowCount;
  } catch (err) {
    // Log with [analytics] prefix before rethrowing — callers (the
    // scheduler) handle the error but should always have a log line.
    console.error(
      `[analytics] cleanupOldQueryLogs failed (retentionDays=${retentionDays}): ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}
