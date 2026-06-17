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
 * Sentinel written to `query_log.query_text` by the knowledge-tool browse
 * path (empty query → "return all FAQ entries above confidence"). It is a
 * synthetic marker, NOT a real user search, so the empty-queries reader
 * excludes it the same way it excludes {@link REDACTED_QUERY_TEXT} — an empty
 * browse call should not surface as a literal `<browse>` row in the
 * Empty-Result dashboard. The value MUST stay in sync with the literal logged
 * in `src/mcp/tools/knowledge.ts`.
 */
export const BROWSE_QUERY_TEXT = "<browse>";

/**
 * Sentinel `days` value meaning "all time" — no lower time bound at all. The
 * dashboard's "All time" preset sends this (docs/analytics.html
 * ALL_TIME_DAYS) and the server's `days` parser admits it (server.ts
 * MAX_DAYS=100000 stays above it). When a windowed reader is asked for a
 * window `>= ALL_TIME_DAYS`, {@link buildDateWindow} OMITS the lower-bound
 * `created_at >=` clause entirely instead of clamping to
 * {@link ROLLING_WINDOW_CAP_DAYS}, so the summary/aggregate cards genuinely
 * span every row — including history older than the rolling cap. Exported so
 * the server-side comment and tests share one source of truth.
 */
export const ALL_TIME_DAYS = 99999;

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

/**
 * Score threshold below which a non-empty result set is considered
 * "low confidence". A query that returned rows but whose best match scored
 * under this value is surfaced separately so operators can spot content gaps
 * that look like hits but aren't actually relevant. Exported so tool handlers,
 * readers, and tests share a single source of truth.
 *
 * Predicate (matches the brief): `result_count > 0 AND top_score < 0.5`.
 * `top_score IS NULL` (e.g. browse/keyword rows that never compute a cosine
 * score) is intentionally NOT low-confidence — absence of a score is not a
 * low score.
 */
export const LOW_CONFIDENCE_SCORE_THRESHOLD = 0.5;

/**
 * Canonical request-origin tags persisted on `query_log.request_source`.
 * Sourced from the `X-Pathfinder-Source` request header on the MCP init
 * request. Anything outside this set (including a missing header) is coerced
 * to {@link DEFAULT_REQUEST_SOURCE} at the edge so the column only ever holds
 * a known value going forward.
 */
export const REQUEST_SOURCE_VALUES = ["user", "synthetic", "analysis"] as const;
export type RequestSource = (typeof REQUEST_SOURCE_VALUES)[number];

/**
 * HTTP header that carries the request-origin tag on the MCP init request.
 * Lower-cased because Node/Express normalize header names to lower case on
 * `req.headers`. Exported so the server-side capture site and tests share one
 * literal.
 */
export const REQUEST_SOURCE_HEADER = "x-pathfinder-source";

/**
 * Default request source when the `X-Pathfinder-Source` header is absent or
 * not one of {@link REQUEST_SOURCE_VALUES}. New traffic without an explicit
 * tag is treated as a real user — the conservative choice that keeps the
 * default KPIs (which exclude synthetic/analysis) honest.
 */
export const DEFAULT_REQUEST_SOURCE: RequestSource = "user";

/**
 * Request-source values that count as "real users" for the default analytics
 * KPIs. Includes NULL (historical rows predating the column) via the SQL in
 * {@link buildRequestSourceClause}. Synthetic/analysis traffic is excluded by
 * default and only included when the caller explicitly asks for an
 * all-sources view (see {@link AnalyticsFilter.request_source}).
 */
export const REAL_USER_REQUEST_SOURCES: readonly RequestSource[] = ["user"];

/**
 * Normalize an arbitrary `X-Pathfinder-Source` header value to a known
 * {@link RequestSource}. Unknown/empty/missing values fall back to
 * {@link DEFAULT_REQUEST_SOURCE}. Case-insensitive and whitespace-trimmed so
 * `"Synthetic"` / `" analysis "` still tag correctly.
 */
export function normalizeRequestSource(
  value: string | null | undefined,
): RequestSource {
  if (typeof value !== "string") return DEFAULT_REQUEST_SOURCE;
  const v = value.trim().toLowerCase();
  return (REQUEST_SOURCE_VALUES as readonly string[]).includes(v)
    ? (v as RequestSource)
    : DEFAULT_REQUEST_SOURCE;
}

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
  /**
   * Request-origin tag (user|synthetic|analysis) from X-Pathfinder-Source.
   * Optional on the entry so existing call sites that don't tag still compile;
   * the writer coerces an absent/unknown value to {@link DEFAULT_REQUEST_SOURCE}
   * so the persisted column is always a known value for new rows.
   */
  request_source?: RequestSource | string | null;
  /**
   * Per-request client IP at MCP-session init, resolved via the same trust-
   * proxy boundary as {@link oauthClientIp} / {@link clientIp}. Optional so
   * existing call sites compile unchanged; absent values persist as NULL.
   */
  client_ip?: string | null;
  /**
   * Per-request User-Agent at MCP-session init, truncated to
   * {@link USER_AGENT_MAX_LEN} chars at the write boundary to bound row size.
   */
  user_agent?: string | null;
  /**
   * Whether the abuse blocklist short-circuited the query. Defaults to false
   * at the write boundary so call sites that don't pass it compile and read
   * back as "not blocked".
   */
  blocked?: boolean;
  /**
   * Free-form reason string when {@link blocked} is true (e.g. a
   * `pattern:<name>` tag from the abuse blocklist). NULL when not blocked.
   */
  block_reason?: string | null;
}

/**
 * Hard cap on `user_agent` storage to bound row size. Pathfinder doesn't need
 * the full UA for any analytics workflow — first 256 chars is more than enough
 * to distinguish Claude-User, browsers, curl, and the common bots. Truncating
 * at the write boundary keeps a runaway / pathological UA header from bloating
 * the column.
 */
export const USER_AGENT_MAX_LEN = 256;

export interface AnalyticsSummary {
  total_queries: number;
  total_queries_window: number;
  empty_result_count_window: number;
  empty_result_rate_window: number;
  /**
   * Count of "low confidence" queries in the window: rows that returned at
   * least one result but whose top_score fell below
   * {@link LOW_CONFIDENCE_SCORE_THRESHOLD}. Computed over the SAME population
   * as the other windowed cards (backfilled + redacted rows excluded, default
   * request-source filter applied) so it's directly comparable to
   * total_queries_window. Rows with a NULL top_score are NOT counted —
   * absence of a score is not a low score.
   */
  low_confidence_count_window: number;
  /**
   * low_confidence_count_window / total_queries_window (0 when the window is
   * empty). Surfaced alongside empty_result_rate_window so the dashboard can
   * show "looks like a hit but isn't relevant" as its own signal.
   */
  low_confidence_rate_window: number;
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
  /**
   * ISO UTC date (YYYY-MM-DD) of the oldest query_log row, or null if
   * query_log is empty. Sourced from an UNFILTERED MIN(created_at) — no
   * tool_type/source/days/from/to filters apply — because the UI uses
   * this to label windows that exceed actual data depth (e.g. "showing
   * 9 days of data" when the user picks a 30-day window on a 9-day
   * install). Filter-dependent values would conflate "no data for this
   * filter" with "no data at all".
   */
  earliest_query_day: string | null;
}

export interface AtlasRetrievalMetrics {
  atlas_queries_window: number;
  atlas_successful_queries_window: number;
  atlas_empty_queries_window: number;
  atlas_retrieval_rate_window: number;
  total_user_queries_window: number;
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

/**
 * Aggregate row for the "Blocked Queries" analytics panel — one row per
 * `block_reason` value, summarizing how many times that off-topic / abuse
 * pattern fired in the window. Surfaced separately from {@link EmptyQuery}
 * so operators can see the abuse blocklist actively short-circuiting traffic
 * (the same rows are excluded from the empty-results list to avoid
 * double-counting blocked queries as "real users found nothing").
 *
 * `block_reason` is the raw classifier label (e.g. `box-office`,
 * `kalshi-scotus`, `scary-movie-2026`); the dashboard renders it verbatim.
 * `sample_queries` is a deduplicated, alphabetically-sorted preview capped at
 * 5 entries per reason so the panel can show concrete examples without
 * leaking the long tail.
 */
export interface BlockedQueryGroup {
  block_reason: string;
  hits: number;
  last_seen: string;
  sample_queries: string[];
}

export interface ToolCount {
  tool_type: string;
  count: number;
}

export interface AnalyticsFilter {
  tool_type?: string;
  source?: string;
  /**
   * Service-originated rows use the existing session_id column with a
   * `service:` prefix. Analytics views exclude them by default so Atlas
   * gardening/probe traffic does not inflate human/agent usage metrics.
   */
  include_service_traffic?: boolean;
  /**
   * Request-origin filter for the analytics readers.
   *
   * - `undefined` (the default): restrict to REAL USER traffic —
   *   `request_source IN ('user') OR request_source IS NULL`. This is what
   *   makes the dashboard's KPIs default to real users while still counting
   *   historical rows (NULL) that predate the column.
   * - `"all"`: no request-source restriction — every row regardless of origin.
   *   Use for the explicit "all sources" dashboard view.
   * - a specific {@link RequestSource} (`"user"` | `"synthetic"` | `"analysis"`):
   *   restrict to exactly that origin. `"user"` here ALSO includes NULL rows
   *   (they're real users); `"synthetic"`/`"analysis"` match the literal value
   *   only.
   */
  request_source?: RequestSource | "all";
  /**
   * Optional inclusive date range. When both `from` and `to` are set the
   * underlying queries filter on `created_at >= from AND created_at <= to`
   * instead of the default rolling window — a UTC-calendar-day-aligned
   * `created_at >= (NOW() AT TIME ZONE 'UTC')::date - (LEAST(days, cap) - 1)`
   * (see {@link buildDateWindow}), or no lower bound at all when
   * `days >= ALL_TIME_DAYS`.
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
  // Coerce the request source to a known value at the write boundary so the
  // column only ever holds user|synthetic|analysis going forward (an absent or
  // unrecognized tag becomes DEFAULT_REQUEST_SOURCE = 'user'). Historical rows
  // written before this column existed stay NULL and are read back as real
  // users by the analytics layer.
  const requestSource = normalizeRequestSource(entry.request_source);
  // Defensive truncation at the write boundary so a pathological UA header
  // can't bloat the row. See USER_AGENT_MAX_LEN. `null`/`undefined` pass
  // through unchanged; `slice` on a string is safe for non-ASCII too because
  // it operates on UTF-16 code units, not bytes, so a 256-cap always fits
  // any DB text column with reasonable headroom.
  const userAgent =
    typeof entry.user_agent === "string"
      ? entry.user_agent.slice(0, USER_AGENT_MAX_LEN)
      : (entry.user_agent ?? null);
  const blocked = entry.blocked ?? false;
  const blockReason = entry.block_reason ?? null;
  const clientIp = entry.client_ip ?? null;
  try {
    await pool.query(
      `INSERT INTO query_log (tool_name, query_text, result_count, top_score, latency_ms, source_name, session_id, request_source, client_ip, user_agent, blocked, block_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        entry.tool_name,
        text,
        entry.result_count,
        entry.top_score,
        entry.latency_ms,
        entry.source_name,
        entry.session_id,
        requestSource,
        clientIp,
        userAgent,
        blocked,
        blockReason,
      ],
    );
  } catch (err) {
    // Telemetry failures must never break tool callers. Swallow the error
    // after logging with enough context (tool_name + source_name) to
    // diagnose. The tool result path is the source of truth for the
    // caller; a missing analytics row is preferable to a failed tool call.
    // Pass err as the second arg so V8 preserves the stack trace and any
    // pg-level metadata (error code, detail, position) instead of flattening
    // to `err.message`. Losing the stack on a telemetry failure makes DB
    // regressions much harder to diagnose from prod logs.
    console.error(
      `[analytics] logQuery failed (tool_name=${entry.tool_name} source_name=${entry.source_name ?? "null"})`,
      err,
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
    // wildcards. Exact tool names also count as their own tool type:
    // `tool_name = 'atlas'` and `tool_name = 'atlas-search'` should both
    // match `tool_type=atlas`, mirroring getToolCounts' split_part grouping.
    clauses.push(
      `(tool_name = $${idx} OR tool_name LIKE $${idx + 1} || '-%' ESCAPE '|')`,
    );
    params.push(filter.tool_type, escapeLikePattern(filter.tool_type));
    idx += 2;
  }
  if (filter.source) {
    clauses.push(`source_name = $${idx}`);
    params.push(filter.source);
    idx++;
  }
  if (!filter.include_service_traffic) {
    clauses.push(`(session_id IS NULL OR session_id NOT LIKE 'service:%')`);
  }

  return { clauses, params, nextIdx: idx };
}

function whereAnd(baseClauses: string[], filterClauses: string[]): string {
  const all = [...baseClauses, ...filterClauses];
  return all.length > 0 ? "WHERE " + all.join(" AND ") : "";
}

/**
 * Build the request-source WHERE fragment + params for a reader.
 *
 * Semantics (see {@link AnalyticsFilter.request_source}):
 *  - `undefined` → default to real users:
 *    `(request_source IN ('user') OR request_source IS NULL)`. NULL is folded
 *    in so rows predating the column (which have no tag) still count as real
 *    user traffic — this is the back-compat guarantee.
 *  - `"all"` → no clause (every row, regardless of origin).
 *  - `"user"` → same as the default (real users incl. NULL).
 *  - `"synthetic"` | `"analysis"` → exact-match on the literal value
 *    (`request_source = $N`); NULL rows are NOT synthetic/analysis so they're
 *    excluded.
 *
 * Returns `{ clauses, params, nextIdx }` shaped like {@link buildFilterClauses}
 * so callers can splice it into their base clauses + param list uniformly.
 */
function buildRequestSourceClause(
  filter: AnalyticsFilter,
  startIdx: number,
): { clauses: string[]; params: unknown[]; nextIdx: number } {
  const rs = filter.request_source;

  if (rs === "all") {
    return { clauses: [], params: [], nextIdx: startIdx };
  }

  // Default (undefined) and explicit "user" both mean real users, which
  // includes the untagged historical rows (request_source IS NULL).
  if (rs === undefined || rs === "user") {
    return {
      clauses: [`(request_source = $${startIdx} OR request_source IS NULL)`],
      params: ["user"],
      nextIdx: startIdx + 1,
    };
  }

  // Specific non-user origin: exact literal match. NULL rows are real users,
  // not synthetic/analysis, so the bare equality (which is NULL-rejecting in
  // SQL three-valued logic) correctly excludes them.
  return {
    clauses: [`request_source = $${startIdx}`],
    params: [rs],
    nextIdx: startIdx + 1,
  };
}

/**
 * Rolling-window cap, applied to every days-based windowed aggregate
 * (summary totals, latency, by-source, per-day, top/empty-queries, tool
 * counts). The per-day chart renders one bar per day so a year of bars is
 * already beyond any useful granularity; bigger windows are payload bloat
 * with no UI benefit. Other aggregates share the cap so `days=1000` on a
 * rolling window produces consistent results across every card on the
 * dashboard. Explicit from/to ranges are user-chosen bounds and pass
 * through uncapped (the per-day series width is still capped — see
 * {@link buildPerDayWindow}). The all-time sentinel
 * ({@link ALL_TIME_DAYS}) bypasses this cap for the summary/aggregate window
 * entirely (no lower bound). Exported so the per-day cap and tests reference
 * the same constant.
 */
export const ROLLING_WINDOW_CAP_DAYS = 366;

/**
 * Build a date-window clause + params for the given filter, falling back to
 * a rolling UTC-calendar-day window when `from`/`to` are not provided.
 *
 * - When `filter.from` and `filter.to` are both set, returns
 *   `created_at >= $N AND created_at <= $N+1` with the two Date params.
 * - When `days >= ALL_TIME_DAYS` (the "All time" sentinel) and no from/to is
 *   set, returns NO clause and binds NO params — the window has no lower
 *   bound, so the summary/aggregate cards span every row regardless of how
 *   far back history goes (the rolling cap does not apply to "all time").
 * - Otherwise, returns a UTC-calendar-day-bounded rolling window:
 *   `created_at >= (NOW() AT TIME ZONE 'UTC')::date - (LEAST($N, 366) - 1)`
 *   with the `days` number param. Rolling mode semantics: "last N days"
 *   means "today + the previous N-1 UTC calendar days" = N UTC calendar
 *   days inclusive of today. Capped at {@link ROLLING_WINDOW_CAP_DAYS}.
 *
 *   The UTC-calendar alignment is load-bearing: the per-day chart emits a
 *   UTC-midnight `generate_series`, so the summary/latency/by-source WHERE
 *   must also be UTC-calendar-bounded or `sum(queries_per_day_window)`
 *   drifts below `total_queries_window` by up to
 *   `traffic_rate * hours_into_UTC_day` on every read. Previously the
 *   rolling WHERE was `created_at > NOW() - INTERVAL '1 day' * $N` — a
 *   NOW()-relative slide that admitted partial-UTC-day rows the outer
 *   series never emitted, dropping them silently in the LEFT JOIN.
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
  // "All time": omit the lower bound entirely so the summary/aggregate cards
  // cover every row, not just the last ROLLING_WINDOW_CAP_DAYS. No clause and
  // no param are emitted, so the caller's other clauses (latency_ms >= 0,
  // redacted filter, request-source) still apply unchanged and the `$`
  // placeholder numbering carries on from startIdx untouched.
  if (days >= ALL_TIME_DAYS) {
    return { clauses: [], params: [], nextIdx: startIdx };
  }
  // Rolling: UTC-calendar-day-aligned. LEAST caps the span at
  // ROLLING_WINDOW_CAP_DAYS so `days=huge` can't produce an unbounded
  // subtraction. `-1` gives an inclusive N-day window ending today
  // (today-(N-1) .. today). Reused verbatim by buildPerDayWindow so the
  // per-day bars can never drift from the summary window.
  return {
    clauses: [
      `created_at >= (NOW() AT TIME ZONE 'UTC')::date - (LEAST($${startIdx}, ${ROLLING_WINDOW_CAP_DAYS}) - 1)`,
    ],
    params: [days],
    nextIdx: startIdx + 1,
  };
}

/**
 * Build a series expression + narrowed WHERE clause for the per-day chart.
 *
 * The inner WHERE is delegated to {@link buildDateWindow} so the per-day
 * aggregate counts the EXACT same rows as the summary window. With both
 * sides now UTC-calendar-day aligned in rolling mode (since buildDateWindow
 * switched off NOW()-relative intervals), `sum(queries_per_day_window)` ==
 * `total_queries_window` exactly — no drift regardless of what time of UTC
 * day the read happens to land. Any future divergence between the two
 * WHERE forms would show up in production as "my bars add up to less than
 * my summary card"; reusing buildDateWindow removes the whole class of bug.
 *
 * The SERIES is emitted separately as UTC-midnight calendar days so that the
 * LEFT JOIN renders one bar per day even when no rows were logged. The series
 * width is ALWAYS capped at ROLLING_WINDOW_CAP_DAYS so the payload can never
 * exceed a year of daily bars:
 *  - Rolling mode caps via `LEAST($days, cap)` (shared with buildDateWindow),
 *    so sum-of-bars == total_queries_window exactly.
 *  - Range mode caps the UPPER bound at `from + (cap - 1)` days; the summary
 *    aggregate still spans the full user-chosen range, but the chart only
 *    renders the first `cap` days of it (a multi-thousand-day range would
 *    otherwise emit one JSON row per day — payload bloat / DoS).
 *  - All-time mode (days >= ALL_TIME_DAYS) emits a literal `cap`-day series
 *    ending today and binds NO placeholder (buildDateWindow returns no date
 *    clause for all-time, so the inner aggregate counts every row).
 * All three force UTC on the series ::date cast so a non-UTC session TimeZone
 * GUC can't shift the series one day earlier than intended.
 *
 * `startIdx` is the next available `$` placeholder index; `nextIdx` is the
 * next index to use after this helper's params.
 */
function buildPerDayWindow(
  filter: AnalyticsFilter,
  days: number,
  startIdx: number,
): {
  seriesExpr: string;
  whereClause: string;
  params: unknown[];
  nextIdx: number;
} {
  // Inner WHERE is byte-identical to the summary window. For rolling mode
  // buildDateWindow binds $startIdx = days; for range mode it binds
  // $startIdx = from and $startIdx+1 = to; for all-time it binds nothing.
  // The series below reuses those exact placeholders so the two sides can
  // never drift apart.
  const dw = buildDateWindow(filter, days, startIdx);
  const whereClause = dw.clauses.join(" AND ");

  if (filter.from && filter.to) {
    // Range: lower bound is `($from AT TIME ZONE 'UTC')::date`; upper bound is
    // capped at `lower + (cap - 1)` days via LEAST so the series width never
    // exceeds ROLLING_WINDOW_CAP_DAYS even for an enormous range (the endpoint
    // allows a from/to span up to MAX_DAYS, which would otherwise emit ~100k
    // daily rows). The `AT TIME ZONE 'UTC'` forces the timestamptz to be
    // interpreted in UTC before the ::date cast; without it, a non-UTC session
    // TimeZone GUC (common on managed Postgres that inherit a regional
    // default) coerces `'2026-04-15T00:00:00Z'::date` to the session-local day
    // `2026-04-14`, shifting the series one day earlier than the caller
    // intended. Combined with the UTC-normalized date_trunc in the inner
    // aggregate (see getAnalyticsSummary), this keeps bars aligned regardless
    // of TZ. The summary/aggregate WHERE (dw.clauses) still spans the FULL
    // range — only the chart series is capped.
    const fromDate = `($${startIdx}::timestamptz AT TIME ZONE 'UTC')::date`;
    const toDate = `($${startIdx + 1}::timestamptz AT TIME ZONE 'UTC')::date`;
    const cappedTo = `LEAST(${toDate}, ${fromDate} + (${ROLLING_WINDOW_CAP_DAYS} - 1))`;
    return {
      seriesExpr: `generate_series(${fromDate}, ${cappedTo}, '1 day'::interval)`,
      whereClause,
      params: dw.params,
      nextIdx: dw.nextIdx,
    };
  }

  if (days >= ALL_TIME_DAYS) {
    // All-time. buildDateWindow emitted no date clause (whereClause is ""),
    // so the inner aggregate counts every row. The series is a literal
    // cap-day window ending today — bounded so years of history don't bloat
    // the chart — and binds no placeholder. Rows older than the cap are still
    // counted by the summary cards (no lower bound there); they simply don't
    // render as bars.
    return {
      seriesExpr: `generate_series((NOW() AT TIME ZONE 'UTC')::date - (${ROLLING_WINDOW_CAP_DAYS} - 1), (NOW() AT TIME ZONE 'UTC')::date, '1 day'::interval)`,
      whereClause,
      params: dw.params,
      nextIdx: dw.nextIdx,
    };
  }

  // Rolling. Emit today-(N-1) .. today in UTC, capped at
  // ROLLING_WINDOW_CAP_DAYS so a huge $days value can't bloat the payload.
  // The cap lives in SQL (LEAST in the series expression) and reuses the
  // same $days placeholder that buildDateWindow binds — no extra param
  // needed. Both the series lower bound and the buildDateWindow WHERE now
  // apply the same `(NOW() AT TIME ZONE 'UTC')::date - (LEAST($N, cap) - 1)`
  // expression, so sum-of-bars == total_queries_window exactly.
  const cappedExpr = `LEAST($${startIdx}, ${ROLLING_WINDOW_CAP_DAYS})`;
  return {
    seriesExpr: `generate_series((NOW() AT TIME ZONE 'UTC')::date - (${cappedExpr} - 1), (NOW() AT TIME ZONE 'UTC')::date, '1 day'::interval)`,
    whereClause,
    params: dw.params,
    nextIdx: dw.nextIdx,
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
 * Index = `floor(n * 0.95)`, clamped to the last element. This is NOT the
 * standard nearest-rank method (`ceil(0.95 * n) - 1`): for small n the two
 * differ, and `floor` skews toward the high end. Concretely, for n = 20
 * `floor(20 * 0.95) = 19`, which selects the MAXIMUM sample (index 19),
 * whereas nearest-rank would pick index 18. We keep this behavior
 * deliberately — the dashboard has been calibrated against it and the
 * difference is at most one sample — and the boundary is pinned by a test so
 * the comment and behavior cannot drift. Either way, results may differ by
 * one sample from Postgres' `percentile_cont(0.95)` (which interpolates).
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
  const rs2 = buildRequestSourceClause(filter, dw2.nextIdx);
  const redactedIdx2 = rs2.nextIdx;
  const lowConfIdx2 = redactedIdx2 + 1;
  const summaryBase = [
    ...dw2.clauses,
    ...rs2.clauses,
    "latency_ms >= 0",
    `query_text != $${redactedIdx2}`,
  ];
  const summaryWhere = whereAnd(summaryBase, fc2);
  // low_confidence shares this subquery (and therefore the exact same
  // population as total/empty/avg_latency) via a FILTER, so the
  // low_confidence_rate denominator lines up with total_queries_window. The
  // threshold is bound, not inlined, so LOW_CONFIDENCE_SCORE_THRESHOLD stays
  // the single source of truth. `top_score IS NOT NULL` is part of the FILTER
  // so NULL-score rows (browse/keyword) never count as low confidence.
  const summaryRes = await pool.query(
    `SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE result_count = 0)::int AS empty,
        count(*) FILTER (
          WHERE result_count > 0
            AND top_score IS NOT NULL
            AND top_score < $${lowConfIdx2}
        )::int AS low_confidence,
        COALESCE(avg(latency_ms)::int, 0) AS avg_latency
    FROM query_log
    ${summaryWhere}`,
    [
      ...fp2,
      ...dw2.params,
      ...rs2.params,
      REDACTED_QUERY_TEXT,
      LOW_CONFIDENCE_SCORE_THRESHOLD,
    ],
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
  const rs3 = buildRequestSourceClause(filter, dw3.nextIdx);
  const redactedIdxLatency = rs3.nextIdx;
  const latencyBase = [
    ...dw3.clauses,
    ...rs3.clauses,
    "latency_ms >= 0",
    `query_text != $${redactedIdxLatency}`,
  ];
  const latencyWhere = whereAnd(latencyBase, fc3);
  const latencyLimitIdx = redactedIdxLatency + 1;
  // Fetch cap+1 rows so we can distinguish "exactly the cap" (all rows
  // returned, no sampling) from "more than the cap" (true sampling occurred).
  // With a strict LIMIT $cap, a dataset with exactly $cap rows would
  // misreport as sampled even though every row is in the result set. We
  // slice back to the cap for the actual p95 computation.
  const latencyRes = await pool.query(
    `SELECT latency_ms FROM query_log ${latencyWhere} ORDER BY random() LIMIT $${latencyLimitIdx}`,
    [
      ...fp3,
      ...dw3.params,
      ...rs3.params,
      REDACTED_QUERY_TEXT,
      P95_LATENCY_ROW_CAP + 1,
    ],
  );
  const p95Sampled = latencyRes.rows.length > P95_LATENCY_ROW_CAP;
  if (p95Sampled) {
    console.warn(
      `[analytics] getAnalyticsSummary: p95 latency sample capped at ${P95_LATENCY_ROW_CAP} rows; result may be approximate`,
    );
  }

  // By source (filtered). Excludes backfilled rows (latency_ms < 0) so the
  // doughnut totals line up with summary + per-day.
  const { clauses: fc4, params: fp4, nextIdx: n4 } = buildFilterClauses(filter);
  const dw4 = buildDateWindow(filter, days, n4);
  const rs4 = buildRequestSourceClause(filter, dw4.nextIdx);
  const sourceBase = [
    "source_name IS NOT NULL",
    ...dw4.clauses,
    ...rs4.clauses,
    "latency_ms >= 0",
  ];
  const sourceWhere = whereAnd(sourceBase, fc4);
  const bySourceRes = await pool.query(
    `SELECT source_name, count(*)::int AS count
    FROM query_log
    ${sourceWhere}
    GROUP BY source_name
    ORDER BY count DESC`,
    [...fp4, ...dw4.params, ...rs4.params],
  );

  // Per day (filtered). LEFT JOIN against generate_series so every day in
  // the window emits a row — even when zero queries were logged that day.
  // Pre-fix, a plain GROUP BY silently dropped zero-count days, so sparse
  // data rendered fewer bars than the window length ("Last 14 days" → 10
  // bars on sparse data). See buildPerDayWindow for the series bounds.
  //
  // Inner subquery preserves the same filters as the pre-fix path:
  // backfilled rows (latency_ms < 0) AND redacted rows
  // (query_text = REDACTED_QUERY_TEXT) are excluded so the per-day bars
  // match the summary/latency aggregates above AND the top-queries /
  // empty-queries tables below — all of which filter redacted out.
  //
  // dayWhere filters live ONLY on the inner subquery. Applying them on the
  // outer LEFT JOIN would turn it back into an inner join and re-drop the
  // zero-count days the gap-fill exists to surface.
  const { clauses: fc5, params: fp5, nextIdx: n5 } = buildFilterClauses(filter);
  const pdw = buildPerDayWindow(filter, days, n5);
  const rs5 = buildRequestSourceClause(filter, pdw.nextIdx);
  const redactedIdx5 = rs5.nextIdx;
  // pdw.whereClause is empty in all-time mode (buildDateWindow omits the date
  // bound). Drop the empty fragment so whereAnd doesn't splice a dangling
  // `AND` into the inner aggregate's WHERE.
  const dayBase = [
    ...(pdw.whereClause ? [pdw.whereClause] : []),
    ...rs5.clauses,
    "latency_ms >= 0",
    `query_text != $${redactedIdx5}`,
  ];
  const dayWhere = whereAnd(dayBase, fc5);
  // Inner grouping is normalized to UTC via `AT TIME ZONE 'UTC'` so the
  // aggregated bucket column aligns with the UTC-midnight series regardless
  // of the session's `TimeZone` GUC. Without the cast, production Postgres
  // sessions whose TimeZone != UTC (common on managed instances that
  // inherit a regional default) silently bucket rows by local-day, the
  // LEFT JOIN misses the corresponding series day, and bars go to zero.
  // PGlite defaults to UTC so this diverges only in production — the
  // non-UTC TZ test in analytics-gap-fill.test.ts is the regression guard.
  const perDayRes = await pool.query(
    `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            COALESCE(q.count, 0)::int AS count
     FROM ${pdw.seriesExpr} AS d(day)
     LEFT JOIN (
       SELECT date_trunc('day', created_at AT TIME ZONE 'UTC')::date AS day,
              count(*)::int AS count
       FROM query_log
       ${dayWhere}
       GROUP BY day
     ) q ON q.day = d.day::date
     ORDER BY d.day`,
    [...fp5, ...pdw.params, ...rs5.params, REDACTED_QUERY_TEXT],
  );

  // Earliest query day (UNFILTERED — the UI uses this to label windows
  // that have plateaued against actual data depth, which is an absolute
  // property of the table, not relative to the current filter. Keeping
  // this subquery sequential with the others preserves the existing
  // ordering (tests assert on mock.calls[5] as the earliest-day query);
  // parallelizing would need the rest of getAnalyticsSummary to move to
  // Promise.all at the same time, which is out of scope here.
  //
  // date_trunc → cast to date → cast to text produces a bare YYYY-MM-DD
  // string regardless of the session timezone. Cast at `created_at AT
  // TIME ZONE 'UTC'` so the "day" boundary is always UTC and matches
  // the per-day bars + client-side Date comparisons the UI already
  // does in UTC.
  const earliestRes = await pool.query(
    `SELECT min(created_at AT TIME ZONE 'UTC')::date::text AS earliest_day FROM query_log`,
  );

  // Coerce a DB numeric to a finite JS number, defaulting to 0. The summary
  // columns are `::int`-cast in SQL, but PGlite and node-postgres disagree on
  // whether integer/numeric columns deserialize as `number` or `string`
  // (node-postgres returns `bigint`/`numeric` as strings). Trusting the driver
  // typing risks a string leaking into total_queries_window or a NaN into the
  // *_rate fields when the value is unexpectedly non-numeric. getTopQueries
  // already guards its parseFloat results this way; mirror it here so the
  // summary numerics stay consistent. Defensive given the `::int` casts —
  // intentionally minimal.
  const toFiniteNumber = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const totalQueries = toFiniteNumber(totalRes.rows[0]?.count);
  const s = summaryRes.rows[0] ?? {};
  const totalWindow = toFiniteNumber(s.total);
  const emptyWindow = toFiniteNumber(s.empty);
  const lowConfidenceWindow = toFiniteNumber(s.low_confidence);
  const avgLatencyWindow = toFiniteNumber(s.avg_latency);
  // Normalize undefined (truly missing) to null so consumers get a
  // consistent shape regardless of whether the DB returned an empty
  // row, a row with NULL, or no row at all.
  const earliestDay =
    (earliestRes.rows[0]?.earliest_day as string | null | undefined) ?? null;

  // Compute p95 in application code. Slice back to the cap so the extra
  // "overflow probe" row fetched above doesn't skew the sample size. Coerce
  // each latency through toFiniteNumber: node-postgres deserializes a numeric
  // column as a STRING, so trusting `as number` here would leave computeP95
  // sorting/returning strings (wrong/NaN p95). Mirrors the summary numerics
  // above which already coerce defensively.
  const latencies = latencyRes.rows
    .slice(0, P95_LATENCY_ROW_CAP)
    .map((r: Record<string, unknown>) => toFiniteNumber(r.latency_ms));
  const p95Latency = computeP95(latencies);

  return {
    total_queries: totalQueries,
    total_queries_window: totalWindow,
    empty_result_count_window: emptyWindow,
    empty_result_rate_window: totalWindow > 0 ? emptyWindow / totalWindow : 0,
    low_confidence_count_window: lowConfidenceWindow,
    low_confidence_rate_window:
      totalWindow > 0 ? lowConfidenceWindow / totalWindow : 0,
    avg_latency_ms_window: avgLatencyWindow,
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
    earliest_query_day: earliestDay,
  };
}

/**
 * Get top queries by frequency over the last N days, or over the explicit
 * `filter.from`/`filter.to` range when provided. Groups by (query_text,
 * tool_name) and orders by count desc. Excludes (query_text, tool_name)
 * pairs whose every event returned zero results — those belong exclusively
 * in `getEmptyQueries`. Without this filter, a query that only ever returns
 * empty would render in BOTH the Top Queries and Empty Result Queries
 * tables with the same count, and the dashboard's two tables disagree on
 * the predicate for "empty."
 */
export async function getTopQueries(
  days: number = 7,
  limit: number = 50,
  filter: AnalyticsFilter = {},
): Promise<TopQuery[]> {
  const pool = getPool();

  const { clauses: fc, params: fp, nextIdx } = buildFilterClauses(filter);
  const dw = buildDateWindow(filter, days, nextIdx);
  const rs = buildRequestSourceClause(filter, dw.nextIdx);
  // Bind REDACTED_QUERY_TEXT rather than interpolating the literal so the
  // sentinel has a single source of truth (the module constant) and the
  // SQL stays shielded from the value.
  const redactedIdx = rs.nextIdx;
  const baseClauses = [
    ...dw.clauses,
    ...rs.clauses,
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
    HAVING bool_or(result_count > 0)
    ORDER BY count DESC
    LIMIT $${redactedIdx + 1}`,
    [...fp, ...dw.params, ...rs.params, REDACTED_QUERY_TEXT, limit],
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
 *
 * Both synthetic sentinels are excluded: REDACTED_QUERY_TEXT (log_queries:
 * false) and BROWSE_QUERY_TEXT (the knowledge-tool browse path, which logs
 * "<browse>" for an empty-query "return all FAQ entries" call). A browse call
 * that happens to return zero entries is not a real "user searched and found
 * nothing" gap, so surfacing a literal `<browse>` row in the Empty-Result
 * dashboard would be misleading noise.
 *
 * Blocked rows (`blocked = true`) are ALSO excluded: those queries were
 * short-circuited by the abuse blocklist (v1.15.2) before they ever reached
 * the index, so `result_count = 0` is a known by-design outcome — not a
 * content gap. They surface in {@link getBlockedQueries} instead so operators
 * can see the blocklist actively catching abuse without polluting the
 * "real users searched and found nothing" view. `blocked` is
 * `BOOLEAN NOT NULL DEFAULT FALSE` so the predicate is safe for historical
 * rows that predate the column (they read back as `false`).
 */
export async function getEmptyQueries(
  days: number = 7,
  limit: number = 50,
  filter: AnalyticsFilter = {},
): Promise<EmptyQuery[]> {
  const pool = getPool();

  const { clauses: fc, params: fp, nextIdx } = buildFilterClauses(filter);
  const dw = buildDateWindow(filter, days, nextIdx);
  const rs = buildRequestSourceClause(filter, dw.nextIdx);
  // Same rationale as getTopQueries: bind the sentinels so the SQL literals
  // aren't duplicated across reads. Both REDACTED_QUERY_TEXT and
  // BROWSE_QUERY_TEXT are filtered out (see JSDoc).
  const redactedIdx = rs.nextIdx;
  const browseIdx = redactedIdx + 1;
  const limitIdx = browseIdx + 1;
  const baseClauses = [
    "result_count = 0",
    // Exclude rows the v1.15.2 abuse blocklist short-circuited (see JSDoc).
    // The column is BOOLEAN NOT NULL DEFAULT FALSE so a plain `= false` is
    // correct for both historical (pre-column) and current rows.
    "blocked = false",
    ...dw.clauses,
    ...rs.clauses,
    `query_text != $${redactedIdx}`,
    `query_text != $${browseIdx}`,
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
    LIMIT $${limitIdx}`,
    [
      ...fp,
      ...dw.params,
      ...rs.params,
      REDACTED_QUERY_TEXT,
      BROWSE_QUERY_TEXT,
      limit,
    ],
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
 * Get rows the v1.15.2 abuse blocklist short-circuited (`blocked = true`),
 * grouped by `block_reason` so operators can see at a glance which patterns
 * are firing and how often. Counterpart to {@link getEmptyQueries}, which now
 * excludes these rows so a blocked query doesn't double-count as both
 * "blocked" and "empty result".
 *
 * Returns up to 5 sample `query_text` values per `block_reason` (deduplicated,
 * alphabetically sorted) so the panel can show concrete examples without
 * leaking the long tail or unbounded text.
 *
 * Rows with `blocked = true` but `block_reason IS NULL` (defensive — should
 * not happen since the writer sets both atomically) collapse into a single
 * `<unknown>` bucket so they remain visible rather than silently dropping.
 *
 * Window semantics intentionally match {@link getEmptyQueries}:
 * `created_at > NOW() - INTERVAL '<days> days'`. No filter parameter — the
 * blocklist panel is operational-only and the filter wiring (tool/source/
 * request_source) doesn't carry meaning for short-circuited rows that never
 * reached the retrieval layer.
 */
export async function getBlockedQueries(
  days: number = 7,
): Promise<BlockedQueryGroup[]> {
  const pool = getPool();

  // Plain `interval N days` is bound via a parameterized integer so the
  // operator-facing panel can't be SQL-injected through the days arg even
  // if a future route surfaces it. Postgres rejects negative intervals on
  // the `created_at >` half-bound anyway, but defense-in-depth.
  const { rows } = await pool.query(
    `SELECT
        COALESCE(block_reason, '<unknown>') AS block_reason,
        count(*)::int AS hits,
        max(created_at)::text AS last_seen,
        (
          SELECT array_agg(s ORDER BY s)
          FROM (
            SELECT DISTINCT query_text AS s
            FROM query_log AS inner_q
            WHERE inner_q.blocked = true
              AND COALESCE(inner_q.block_reason, '<unknown>')
                  = COALESCE(query_log.block_reason, '<unknown>')
              AND inner_q.created_at > NOW() - ($1 || ' days')::interval
            ORDER BY query_text
            LIMIT 5
          ) sub
        ) AS sample_queries
     FROM query_log
     WHERE blocked = true
       AND created_at > NOW() - ($1 || ' days')::interval
     GROUP BY COALESCE(block_reason, '<unknown>')
     ORDER BY hits DESC`,
    [String(days)],
  );

  return rows.map((r: Record<string, unknown>) => ({
    block_reason: r.block_reason as string,
    hits: r.hits as number,
    last_seen: r.last_seen as string,
    sample_queries: Array.isArray(r.sample_queries)
      ? (r.sample_queries as string[])
      : [],
  }));
}

/**
 * Get query counts grouped by tool type prefix (e.g. "search", "explore").
 * Accepts an optional `from`/`to` filter for an explicit date range; falls
 * back to the rolling "last N days" window when unset.
 *
 * Intentional divergences from other aggregates:
 *  - Backfilled rows (`latency_ms < 0`) excluded (matches every other
 *    windowed aggregate; keeps donut totals aligned with the summary cards).
 *  - Input `tool_type` filter silently ignored — filtering the tool-type
 *    donut by tool type is circular; only `source` is honored here.
 *  - Redacted rows (`query_text = REDACTED_QUERY_TEXT`) NOT excluded —
 *    `tool_name` survives redaction, so they contribute valid tool-usage
 *    signal. Deliberate divergence from the other readers (summary,
 *    top-queries, empty-queries) which DO exclude redacted because their
 *    output surfaces query text.
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
  // request_source survives in `rest` (only tool_type is stripped above), so
  // the tool-counts donut honors the same real-users-by-default behavior as
  // every other windowed aggregate.
  const rs = buildRequestSourceClause(sourceOnlyFilter, dw.nextIdx);
  // Exclude backfilled rows (latency_ms < 0) so tool counts match the
  // windowed aggregates used elsewhere (summary, latency, per-day).
  const baseClauses = [...dw.clauses, ...rs.clauses, "latency_ms >= 0"];
  const where = whereAnd(baseClauses, fc);
  const { rows } = await pool.query(
    `SELECT
        split_part(tool_name, '-', 1) AS tool_type,
        count(*)::int AS count
    FROM query_log
    ${where}
    GROUP BY tool_type
    ORDER BY count DESC`,
    [...fp, ...dw.params, ...rs.params],
  );

  return rows.map((r: Record<string, unknown>) => ({
    tool_type: r.tool_type as string,
    count: r.count as number,
  }));
}

/**
 * Get Atlas-specific retrieval health for the current window.
 *
 * Atlas traffic is identified through the existing analytics surface:
 * an Atlas source is named `atlas` or `atlas-*`/`atlas:*`, and Atlas tools
 * use `atlas`/`atlas-*`/`*-atlas` names. Ordinary search traffic contributes
 * only to `total_user_queries_window`, never to the Atlas retrieval-rate
 * denominator.
 */
export async function getAtlasRetrievalMetrics(
  days: number = 7,
  filter: AnalyticsFilter = {},
): Promise<AtlasRetrievalMetrics> {
  const pool = getPool();

  const { clauses: fc, params: fp, nextIdx } = buildFilterClauses(filter);
  const dw = buildDateWindow(filter, days, nextIdx);
  const redactedIdx = dw.nextIdx;
  const baseClauses = [
    ...dw.clauses,
    "latency_ms >= 0",
    `query_text != $${redactedIdx}`,
  ];
  const params = [...fp, ...dw.params, REDACTED_QUERY_TEXT];
  const userWhere = whereAnd(baseClauses, fc);
  const atlasWhere = whereAnd(
    [
      ...baseClauses,
      `(
        source_name = 'atlas'
        OR source_name LIKE 'atlas-%'
        OR source_name LIKE 'atlas:%'
        OR tool_name = 'atlas'
        OR tool_name LIKE 'atlas-%'
        OR tool_name LIKE '%-atlas'
      )`,
    ],
    fc,
  );

  const [atlasRes, totalUserRes] = await Promise.all([
    pool.query(
      `SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE result_count > 0)::int AS successful,
          count(*) FILTER (WHERE result_count = 0)::int AS empty
       FROM query_log
       ${atlasWhere}`,
      params,
    ),
    pool.query(
      `SELECT count(*)::int AS total
       FROM query_log
       ${userWhere}`,
      params,
    ),
  ]);

  const atlas = atlasRes.rows[0] ?? {};
  const atlasTotal = (atlas.total as number | undefined) ?? 0;
  const successful = (atlas.successful as number | undefined) ?? 0;
  const empty = (atlas.empty as number | undefined) ?? 0;
  const totalUser = (totalUserRes.rows[0]?.total as number | undefined) ?? 0;

  return {
    atlas_queries_window: atlasTotal,
    atlas_successful_queries_window: successful,
    atlas_empty_queries_window: empty,
    atlas_retrieval_rate_window: atlasTotal > 0 ? successful / atlasTotal : 0,
    total_user_queries_window: totalUser,
  };
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
  // Cleanup is a retention purge anchored to wall-clock NOW(), independent
  // of the UTC-calendar-day-aligned read window buildDateWindow emits. The
  // `<=` (non-strict) boundary means any row at or past the retention
  // cutoff is reachable by cleanup; we never want a row to be invisible to
  // reads AND immune to purge at the same time.
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
    // scheduler) handle the error but should always have a log line. Pass
    // err as the second arg so V8 preserves the stack + pg error metadata
    // rather than collapsing to err.message.
    console.error(
      `[analytics] cleanupOldQueryLogs failed (retentionDays=${retentionDays})`,
      err,
    );
    throw err;
  }
}
