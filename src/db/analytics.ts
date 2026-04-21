import { getPool } from "./client.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Sentinel written to `query_log.query_text` when a tool is configured with
 * `log_queries: false`. The top-queries and empty-queries readers exclude
 * this value so redacted rows don't pollute "frequent search" output. Also
 * exported so tests can assert the sentinel without duplicating the literal.
 */
export const REDACTED_QUERY_TEXT = "<redacted>";

/**
 * Cap on the number of latency rows fetched for p95 computation. PGlite
 * doesn't support `percentile_cont`, so we pull latencies to JS and sort
 * them; on "All time" (days=99999) with a busy install this would be
 * unbounded. 100k rows is a safe ceiling (~0.8 MB for int latencies) and
 * preserves correctness for any realistic dataset.
 *
 * Sampling strategy: when the number of matching rows exceeds the cap, we
 * take a RANDOM sample (ORDER BY random()) rather than the smallest N
 * latencies. An ordered-by-latency LIMIT would systematically chop off the
 * tail and under-report p95; random sampling gives an unbiased estimate.
 * When the LIMIT is hit we log a warning so the operator knows the reading
 * is sampled.
 */
export const P95_LATENCY_ROW_CAP = 100000;

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
  /**
   * True when the p95 latency was computed over a random sample capped at
   * {@link P95_LATENCY_ROW_CAP} rows rather than the full population. The
   * UI surfaces this as a "(sampled)" badge so operators know the reading
   * is approximate. Only set when the cap was actually hit; otherwise
   * omitted so existing consumers can treat absence as "exact".
   */
  p95_latency_sampled?: boolean;
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
   * Callers should ensure both are provided together. Endpoints reject
   * half-specified ranges, calendar-invalid dates (e.g. Feb 30),
   * array-shape parameters (Express multi-value), and ranges wider than
   * `MAX_DAYS` (see `src/server.ts`) before they reach the DB layer;
   * direct callers (tests, future internal consumers) must replicate
   * those guards.
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
  const text = logQueryText ? entry.query_text : REDACTED_QUERY_TEXT;
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
 *
 * Uses nearest-rank (index = floor(n * 0.95)), not linear interpolation —
 * results may differ by one sample from Postgres' `percentile_cont(0.95)`
 * query.
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
  //
  // Redacted rows (query_text = REDACTED_QUERY_TEXT) are also excluded from
  // the summary `total`/`empty` counts, the latency aggregates (avg AND p95),
  // AND the per-day bars so `empty_result_rate_window`, the latency cards,
  // and the daily-chart totals all match the population surfaced by
  // getEmptyQueries() / getTopQueries() — which also filter redacted out.
  // Without this, the rate denominator (summary) would include redacted
  // rows while the visible empty-queries list omits them, so clicking
  // through to the list would show fewer entries than the rate suggests.
  // avg_latency and p95_latency are kept on the SAME population so the two
  // cards are comparable (pre-fix: avg excluded redacted but p95 did not,
  // so p95/avg ratios were computed over different row sets). by-source
  // intentionally stays inclusive of redacted rows (the doughnut shows
  // source mix and redacted traffic still originates from a real source).
  //
  // NOTE: getToolCounts intentionally does NOT exclude redacted rows — see
  // its JSDoc for rationale (tool-usage signal survives redaction because
  // the tool_name is never redacted). Do not "fix this for consistency" —
  // the divergence is deliberate.
  const { clauses: fc2, params: fp2, nextIdx: n2 } = buildFilterClauses(filter);
  const dw2 = buildDateWindow(filter, days, n2);
  const redactedIdx2 = dw2.nextIdx;
  const summaryBase = [
    ...dw2.clauses,
    "latency_ms >= 0",
    `query_text != $${redactedIdx2}`,
  ];
  const summaryWhere = whereAnd(summaryBase, fc2);
  const summaryRes = await pool.query(
    `SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE result_count = 0)::int AS empty,
        COALESCE(avg(latency_ms)::int, 0) AS avg_latency
    FROM query_log
    ${summaryWhere}`,
    [...fp2, ...dw2.params, REDACTED_QUERY_TEXT],
  );

  // Latencies for p95 (exclude backfilled rows where latency_ms < 0, AND
  // redacted rows so the p95 is computed over the SAME population as
  // avg_latency above — otherwise avg and p95 diverge whenever redacted
  // traffic exists).
  // Capped at P95_LATENCY_ROW_CAP so "All time" on a busy install doesn't
  // load an unbounded result into JS. We use ORDER BY random() so the cap
  // takes an unbiased random sample instead of the smallest N latencies
  // (ORDER BY latency_ms LIMIT N would systematically chop off the tail
  // and under-report p95). When the cap is hit we log a warn so the
  // reading is known to be sampled rather than exact.
  const { clauses: fc3, params: fp3, nextIdx: n3 } = buildFilterClauses(filter);
  const dw3 = buildDateWindow(filter, days, n3);
  const redactedIdxLatency = dw3.nextIdx;
  const latencyBase = [
    ...dw3.clauses,
    "latency_ms >= 0",
    `query_text != $${redactedIdxLatency}`,
  ];
  const latencyWhere = whereAnd(latencyBase, fc3);
  const latencyLimitIdx = redactedIdxLatency + 1;
  const latencyRes = await pool.query(
    `SELECT latency_ms FROM query_log ${latencyWhere} ORDER BY random() LIMIT $${latencyLimitIdx}`,
    [...fp3, ...dw3.params, REDACTED_QUERY_TEXT, P95_LATENCY_ROW_CAP],
  );
  const p95Sampled = latencyRes.rows.length >= P95_LATENCY_ROW_CAP;
  if (p95Sampled) {
    console.warn(
      `[analytics] getAnalyticsSummary: p95 latency sample capped at ${P95_LATENCY_ROW_CAP} rows; result may be approximate`,
    );
  }

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

  // Per day (filtered). Excludes backfilled rows (latency_ms < 0) AND
  // redacted rows (query_text = REDACTED_QUERY_TEXT) so the per-day bars
  // match the summary/latency aggregates above AND the top-queries /
  // empty-queries tables below — all of which filter redacted out.
  const { clauses: fc5, params: fp5, nextIdx: n5 } = buildFilterClauses(filter);
  const dw5 = buildDateWindow(filter, days, n5);
  const redactedIdx5 = dw5.nextIdx;
  const dayBase = [
    ...dw5.clauses,
    "latency_ms >= 0",
    `query_text != $${redactedIdx5}`,
  ];
  const dayWhere = whereAnd(dayBase, fc5);
  const perDayRes = await pool.query(
    `SELECT date_trunc('day', created_at)::date::text AS day, count(*)::int AS count
    FROM query_log
    ${dayWhere}
    GROUP BY day
    ORDER BY day`,
    [...fp5, ...dw5.params, REDACTED_QUERY_TEXT],
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
    // Only set when the cap was actually hit so existing consumers (tests,
    // older UI builds) can treat the absence of the flag as "exact".
    ...(p95Sampled ? { p95_latency_sampled: true } : {}),
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
  // Bind REDACTED_QUERY_TEXT rather than interpolating the literal so the
  // sentinel has a single source of truth (the module constant) and the
  // SQL stays shielded from the value.
  const redactedIdx = dw.nextIdx;
  const baseClauses = [
    ...dw.clauses,
    `query_text != $${redactedIdx}`,
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
    LIMIT $${redactedIdx + 1}`,
    [...fp, ...dw.params, REDACTED_QUERY_TEXT, limit],
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
 * Get queries that returned zero results. Grouped by
 * (query_text, tool_name, source_name); results with the same query text
 * but different tool/source appear separately.
 */
export async function getEmptyQueries(
  days: number = 7,
  limit: number = 50,
  filter: AnalyticsFilter = {},
): Promise<EmptyQuery[]> {
  const pool = getPool();

  const { clauses: fc, params: fp, nextIdx } = buildFilterClauses(filter);
  const dw = buildDateWindow(filter, days, nextIdx);
  // Same rationale as getTopQueries: bind the REDACTED_QUERY_TEXT sentinel
  // so the SQL literal isn't duplicated across reads.
  const redactedIdx = dw.nextIdx;
  const baseClauses = [
    "result_count = 0",
    ...dw.clauses,
    `query_text != $${redactedIdx}`,
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
    LIMIT $${redactedIdx + 1}`,
    [...fp, ...dw.params, REDACTED_QUERY_TEXT, limit],
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
 *
 * Population notes (intentional divergences from other windowed aggregates):
 *
 *  - Backfilled rows (`latency_ms < 0`) are EXCLUDED, matching every other
 *    windowed aggregate in this module. Without that filter the tool-type
 *    donut would include historical backfill while the other cards would
 *    not, so donut totals wouldn't line up with the summary counts.
 *  - A `tool_type` filter on the input is silently IGNORED. Filtering the
 *    "what tool types exist" aggregate by tool type is circular — the
 *    donut always shows the full type distribution within the selected
 *    window/source. Only the `source` filter is honored here.
 *  - Redacted rows (`query_text = REDACTED_QUERY_TEXT`) are deliberately
 *    NOT excluded. Redacted rows still carry a truthful `tool_name` (only
 *    `query_text` is scrubbed), so they contribute valid tool-usage signal.
 *    Excluding them would under-report tools whose configuration sets
 *    `log_queries: false`. This is a deliberate divergence from
 *    getAnalyticsSummary / getTopQueries / getEmptyQueries, which all
 *    exclude redacted rows because their output surfaces query text.
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
  //
  // Throws rather than returning 0 so a misconfigured retention surfaces
  // loudly in the scheduler's .catch() handler instead of being silently
  // no-op'd on every nightly run. The caller (orchestrator.ts) already
  // has a .catch that logs — this just makes sure the log happens.
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new Error(
      `[analytics] cleanupOldQueryLogs: invalid retentionDays=${retentionDays} (must be a positive finite number)`,
    );
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
