#!/usr/bin/env tsx
/// <reference types="node" />
/**
 * weekly-search-report.ts
 *
 * Weekly (7-day lookback) Pathfinder search-query report. Runs from a scheduled
 * GitHub Action and publishes a deterministic (no-LLM) report to Notion.
 *
 * This REPLACES a brittle claude.ai routine that scraped ephemeral Railway
 * stdout logs and, when its token was missing, silently posted a Notion "error
 * page" masquerading as a report. The two structural fixes here:
 *
 *   1. DURABLE SOURCE. It reads the query_log-backed analytics JSON API (the
 *      same source as monthly-gap-analysis), not Railway stdout.
 *   2. FAIL LOUD. A run that cannot fetch its data — missing token, a non-2xx
 *      from any required endpoint, or a malformed payload — logs a greppable
 *      "[weekly-report] FAILED: <reason>", POSTs a Slack alert, and exits
 *      non-zero. It NEVER publishes a degraded/error Notion page. A Notion
 *      publish failure AFTER a good fetch is also fail-loud.
 *
 * Unlike gap-analysis, there is NO LLM step: categorization is deterministic
 * keyword bucketing against the CATEGORY_TAXONOMY constant below, so the report
 * needs no ANTHROPIC_API_KEY.
 *
 * Secrets / env:
 *   PATHFINDER_ANALYTICS_TOKEN  Bearer token for the analytics API. REQUIRED —
 *                               a missing/empty value is a fail-loud condition
 *                               (this is the exact 2026-06-21 failure mode).
 *   NOTION_TOKEN                Notion integration token (required to publish).
 *   NOTION_PARENT_PAGE_ID       Parent page id (default the Pathfinder project
 *                               page).
 *   SLACK_WEBHOOK               Incoming-webhook URL the script posts FAILURE
 *                               alerts to (#oss-alerts). The WORKFLOW maps the
 *                               org secret (SLACK_WEBHOOK: ${{ secrets.SLACK_WEBHOOK_OSS_ALERTS }}).
 *                               If unset, the alert no-ops but the non-zero exit
 *                               still stands.
 *   SLACK_ENGR_WEBHOOK          Incoming-webhook URL the script posts a SUCCESS
 *                               digest to (#engr), so a healthy weekly report is
 *                               visible to engineering. The WORKFLOW maps the org
 *                               secret (SLACK_ENGR_WEBHOOK: ${{ secrets.SLACK_WEBHOOK_ENGR }}).
 *                               Distinct from the failure SLACK_WEBHOOK. If unset,
 *                               the success ping is simply skipped (it never
 *                               affects the exit code or any fail-loud path).
 *   ANALYTICS_BASE_URL          Override the analytics host (default prod).
 *   REPORT_DAYS                 Lookback window in days (default 7).
 *
 * Usage:
 *   npx tsx scripts/weekly-search-report/weekly-search-report.ts
 *   npx tsx scripts/weekly-search-report/weekly-search-report.ts --report /tmp/weekly.md
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Types: the analytics API CONTRACT (build fixtures to match) ───────────────

export interface QueriesPerDay {
  day: string;
  count: number;
}

export interface AnalyticsSummary {
  total_queries_window: number;
  unique_ip_count_window: number;
  unique_session_count_window: number;
  empty_result_count_window: number;
  empty_result_rate_window: number;
  low_confidence_count_window: number;
  low_confidence_rate_window: number;
  avg_latency_ms_window: number;
  p95_latency_ms_window: number;
  queries_by_source: Array<{ source_name: string; count: number }>;
  queries_per_day_window: QueriesPerDay[];
  earliest_query_day?: string | null;
}

/** `/queries` row — only queries with >=1 result appear here. */
export interface TopQuery {
  query_text: string;
  tool_name: string;
  count: number;
  // The analytics API returns these averages nullable (e.g. NULL when no
  // scored rows). They are not rendered, but the type must match the contract.
  avg_result_count: number | null;
  avg_top_score: number | null;
}

/** `/empty-queries` row. */
export interface EmptyQuery {
  query_text: string;
  tool_name: string;
  // The analytics API returns source_name nullable — a NULL must render as an
  // empty cell, NOT the literal text "null".
  source_name: string | null;
  count: number;
  last_seen: string;
}

/** `/tool-breakdown` row (count desc). */
export interface ToolBreakdownRow {
  tool_name: string;
  count: number;
}

export interface AnalyticsBundle {
  summary: AnalyticsSummary;
  queries: TopQuery[];
  emptyQueries: EmptyQuery[];
  toolBreakdown: ToolBreakdownRow[];
}

// ── Keyword categorization taxonomy (deterministic, NO LLM) ───────────────────
//
// Ordered, first-match-wins list of (category, keyword[]) rules. The buckets
// mirror the taxonomy the retired routine used. "Other" is the implicit
// fallback when no keyword matches; it is listed last with an empty keyword set
// so the category name is enumerable.

export interface CategoryRule {
  category: string;
  keywords: string[];
}

export const CATEGORY_TAXONOMY: CategoryRule[] = [
  {
    category: "Agents/CoAgents/AG-UI",
    keywords: ["coagent", "co-agent", "ag-ui", "agui", "langgraph", "agent"],
  },
  {
    category: "Runtime/Backend",
    keywords: ["runtime", "backend", "server", "endpoint", "api route"],
  },
  {
    category: "Actions/Frontend tools",
    keywords: [
      "usecopilotaction",
      "copilotaction",
      "frontend tool",
      "frontend action",
      "action",
    ],
  },
  {
    category: "Theming/CSS",
    keywords: ["theme", "theming", "css", "style", "styling"],
  },
  {
    category: "Generative UI/Rendering",
    keywords: ["generative ui", "render", "rendering", "renderandwait"],
  },
  {
    category: "v2 Migration/Hooks",
    keywords: ["v2", "migration", "migrate", "usecopilotchat", "hook"],
  },
  {
    category: "Chat UI/Components",
    keywords: [
      "copilotchat",
      "copilotpopup",
      "copilotsidebar",
      "chat ui",
      "component",
    ],
  },
  {
    category: "Getting started/Setup",
    keywords: [
      "getting started",
      "quickstart",
      "quick start",
      "install",
      "setup",
      "tutorial",
    ],
  },
  {
    category: "State/Context",
    keywords: ["usecoagent", "shared state", "readable", "state", "context"],
  },
  {
    category: "Human-in-the-loop",
    keywords: [
      "human in the loop",
      "human-in-the-loop",
      "hitl",
      "interrupt",
      "approval",
    ],
  },
  {
    category: "MCP/Middleware",
    keywords: ["mcp", "middleware"],
  },
  {
    category: "Streaming/Events",
    keywords: ["stream", "streaming", "event", "sse"],
  },
  // Implicit fallback — listed so the bucket name is enumerable. No keywords.
  {
    category: "Other",
    keywords: [],
  },
];

/** Deterministically categorize one query_text into a taxonomy bucket. */
export function categorizeQuery(queryText: string): string {
  const text = queryText.toLowerCase();
  for (const rule of CATEGORY_TAXONOMY) {
    if (rule.keywords.length === 0) continue; // skip the "Other" fallback
    if (rule.keywords.some((kw) => text.includes(kw))) {
      return rule.category;
    }
  }
  return "Other";
}

export interface CategoryCount {
  category: string;
  count: number;
}

/**
 * Aggregate `/queries` rows into their categories, weighted by each row's
 * frequency `count`. Returned sorted by count desc. Categories with zero hits
 * are omitted.
 */
export function categorizeQueries(queries: TopQuery[]): CategoryCount[] {
  const totals = new Map<string, number>();
  for (const q of queries) {
    const cat = categorizeQuery(q.query_text);
    totals.set(cat, (totals.get(cat) ?? 0) + q.count);
  }
  return [...totals.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

/** Top-N `/queries` by frequency (count desc). Does not mutate the input. */
export function topNQueries(queries: TopQuery[], n: number): TopQuery[] {
  return [...queries].sort((a, b) => b.count - a.count).slice(0, n);
}

/** The explore-* rows of a tool breakdown (the bash/explore command breakdown). */
export function exploreBreakdown(rows: ToolBreakdownRow[]): ToolBreakdownRow[] {
  return rows.filter((r) => r.tool_name.startsWith("explore-"));
}

/** Split total tool-call counts into search-vs-explore by tool-name prefix. */
export function searchVsExploreSplit(rows: ToolBreakdownRow[]): {
  search: number;
  explore: number;
  other: number;
} {
  let search = 0;
  let explore = 0;
  let other = 0;
  for (const r of rows) {
    if (r.tool_name.startsWith("search-")) search += r.count;
    else if (r.tool_name.startsWith("explore-")) explore += r.count;
    else other += r.count;
  }
  return { search, explore, other };
}

// ── Date / window / title ───────────────────────────────────────────────────--

/**
 * The single source of truth for the report's data window. Computes the window
 * EXACTLY as the server's `buildDateWindow` (src/db/analytics.ts) does for a
 * `?days=N` rolling request, so every label that names the window — the in-body
 * banner AND the page title/H1 — derives from the same dates and can never
 * contradict each other or the data that was actually queried.
 *
 * Server semantics (rolling mode): the read WHERE is
 *   created_at >= (NOW() AT TIME ZONE 'UTC')::date - (N - 1)
 * i.e. an INCLUSIVE N-UTC-calendar-day window `[today-(N-1) .. today]`. So:
 *   - `end`   = the UTC calendar date of `now` (YYYY-MM-DD).
 *   - `start` = `end - (days - 1)` UTC calendar days (NOT `now - days`, which is
 *               one day too early and was the source of the off-by-one banner).
 *   - `isCalendarWeek` = true ONLY when the window is a true Mon–Sun calendar
 *               week: `days === 7` AND `start` is a Monday AND `end` is a Sunday.
 *               The production Sunday cron with REPORT_DAYS=7 satisfies this; a
 *               manual / retried / clock-drifted non-Sunday 7-day run does not,
 *               so it must NOT be mislabeled "Week of …".
 *
 * Uses UTC throughout so the GHA-cron date is stable regardless of runner TZ.
 */
export function reportWindow(
  now: Date,
  days: number,
): { start: string; end: string; isCalendarWeek: boolean } {
  // Anchor to the UTC calendar date of `now` (drop the time-of-day).
  const endDate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  // Inclusive N-day window ending today → start is N-1 days earlier.
  const startDate = new Date(endDate.getTime());
  startDate.setUTCDate(startDate.getUTCDate() - (days - 1));

  const start = startDate.toISOString().slice(0, 10);
  const end = endDate.toISOString().slice(0, 10);

  // getUTCDay(): 0=Sun..6=Sat. A true calendar week is exactly 7 days running
  // Monday(start) .. Sunday(end).
  const isCalendarWeek =
    days === 7 && startDate.getUTCDay() === 1 && endDate.getUTCDay() === 0;

  return { start, end, isCalendarWeek };
}

/**
 * The report's page title / H1, derived from {@link reportWindow} so it never
 * contradicts the in-body banner. "Week of <start>" is used ONLY for a true
 * Mon–Sun calendar week (the production default); every other window uses the
 * explicit "<N> days ending <end>" framing.
 */
export function reportTitle(now: Date, days: number): string {
  const prefix = "Pathfinder Search Query Report —";
  const { start, end, isCalendarWeek } = reportWindow(now, days);
  if (isCalendarWeek) {
    return `${prefix} Week of ${start}`;
  }
  return `${prefix} ${days} days ending ${end}`;
}

// ── days / argv parsing ───────────────────────────────────────────────────────

/**
 * Parse REPORT_DAYS strictly (positive integer); anything else falls back to the
 * 7-day default with a warning rather than passing a bad value to the API.
 */
export function parseReportDays(raw: string | undefined): number {
  const DEFAULT_DAYS = 7;
  if (raw === undefined || raw.trim() === "") return DEFAULT_DAYS;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    console.warn(
      `[weekly-report] REPORT_DAYS="${raw}" is not a valid integer — using default ${DEFAULT_DAYS}.`,
    );
    return DEFAULT_DAYS;
  }
  const days = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(days) || days <= 0) {
    console.warn(
      `[weekly-report] REPORT_DAYS="${raw}" must be a positive integer — using default ${DEFAULT_DAYS}.`,
    );
    return DEFAULT_DAYS;
  }
  return days;
}

/**
 * Resolve `--report <path>` from an argv array. Returns null when absent, has no
 * following token, or the following token is itself a flag (`--report --dry`
 * must not write a file literally named "--dry").
 */
export function reportPathArgFrom(argv: readonly string[]): string | null {
  const idx = argv.indexOf("--report");
  if (idx === -1 || idx + 1 >= argv.length) return null;
  const next = argv[idx + 1];
  if (next.startsWith("--")) {
    console.warn(
      `[weekly-report] --report expects a file path but got the flag "${next}" — ignoring --report.`,
    );
    return null;
  }
  return resolve(next);
}

// ── Payload validation (malformed → fail loud) ────────────────────────────────

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Throw a descriptive Error if the summary payload is missing required fields. */
export function assertValidSummary(s: unknown): asserts s is AnalyticsSummary {
  if (!s || typeof s !== "object") {
    throw new Error("summary payload is not an object");
  }
  const o = s as Record<string, unknown>;
  const requiredNums = [
    "total_queries_window",
    "unique_ip_count_window",
    "unique_session_count_window",
    "empty_result_count_window",
    "empty_result_rate_window",
    "p95_latency_ms_window",
  ];
  for (const k of requiredNums) {
    if (!isFiniteNumber(o[k])) {
      throw new Error(`summary.${k} missing or not a number`);
    }
  }
  if (!Array.isArray(o.queries_per_day_window)) {
    throw new Error("summary.queries_per_day_window is not an array");
  }
  o.queries_per_day_window.forEach((row, i) => {
    if (!row || typeof row !== "object") {
      throw new Error(`summary.queries_per_day_window row ${i}: not an object`);
    }
    const r = row as Record<string, unknown>;
    if (!isNonEmptyString(r.day)) {
      throw new Error(
        `summary.queries_per_day_window row ${i}: day missing or not a non-empty string`,
      );
    }
    if (!isFiniteNumber(r.count)) {
      throw new Error(
        `summary.queries_per_day_window row ${i}: count missing or not a number`,
      );
    }
  });
}

/**
 * Assert `v` is an array AND every row passes `validateRow` (which throws a
 * descriptive Error naming the endpoint + bad field). The array-ness check runs
 * first so a non-array payload fails loud with a clear message.
 */
function assertArrayOf<T>(
  name: string,
  v: unknown,
  validateRow: (row: Record<string, unknown>, i: number) => void,
): asserts v is T[] {
  if (!Array.isArray(v)) {
    throw new Error(`${name} payload is not an array`);
  }
  v.forEach((row, i) => {
    if (!row || typeof row !== "object") {
      throw new Error(`${name} row ${i}: not an object`);
    }
    validateRow(row as Record<string, unknown>, i);
  });
}

/** Validate a `/queries` (TopQuery) row's required fields. */
function assertTopQueryRow(
  name: string,
  r: Record<string, unknown>,
  i: number,
) {
  if (typeof r.query_text !== "string") {
    throw new Error(`${name} row ${i}: query_text missing or not a string`);
  }
  if (typeof r.tool_name !== "string") {
    throw new Error(`${name} row ${i}: tool_name missing or not a string`);
  }
  if (!isFiniteNumber(r.count)) {
    throw new Error(`${name} row ${i}: count missing or not a number`);
  }
}

/** Validate an `/empty-queries` (EmptyQuery) row's required fields. */
function assertEmptyQueryRow(
  name: string,
  r: Record<string, unknown>,
  i: number,
) {
  if (typeof r.query_text !== "string") {
    throw new Error(`${name} row ${i}: query_text missing or not a string`);
  }
  if (typeof r.tool_name !== "string") {
    throw new Error(`${name} row ${i}: tool_name missing or not a string`);
  }
  // source_name may be string|null (handled in rendering by a separate fix);
  // reject only other types.
  if (r.source_name !== null && typeof r.source_name !== "string") {
    throw new Error(`${name} row ${i}: source_name must be a string or null`);
  }
  if (!isFiniteNumber(r.count)) {
    throw new Error(`${name} row ${i}: count missing or not a number`);
  }
}

/** Validate a `/tool-breakdown` (ToolBreakdownRow) row's required fields. */
function assertToolBreakdownRow(
  name: string,
  r: Record<string, unknown>,
  i: number,
) {
  if (typeof r.tool_name !== "string") {
    throw new Error(`${name} row ${i}: tool_name missing or not a string`);
  }
  if (!isFiniteNumber(r.count)) {
    throw new Error(`${name} row ${i}: count missing or not a number`);
  }
}

// ── Report rendering ──────────────────────────────────────────────────────────

const TOP_QUERIES_N = 20;

export function renderMarkdown(
  bundle: AnalyticsBundle,
  now: Date,
  days: number,
): string {
  const { summary, queries, emptyQueries, toolBreakdown } = bundle;
  const lines: string[] = [];

  // Banner + title both flow from the SAME reportWindow result, so they can
  // never disagree with each other or with the queried ?days=N window. The
  // window is calendar-aligned exactly as the server's buildDateWindow:
  // start = end - (days - 1) (NOT now - days), end = UTC date of now.
  const { start, end, isCalendarWeek } = reportWindow(now, days);
  // "(week of <start>)" is appended ONLY for a true Mon–Sun calendar week.
  const windowDetail = isCalendarWeek ? ` (week of ${start})` : "";

  lines.push(`# ${reportTitle(now, days)}`);
  lines.push("");
  lines.push(
    `Window: ${days} days (${start} – ${end})${windowDetail} · ` +
      `Source: analytics API (query_log-backed, read-only)`,
  );
  lines.push("");

  // 1. Header metrics
  lines.push("## Header metrics");
  lines.push("");
  lines.push(`- Total tool calls: ${summary.total_queries_window}`);
  lines.push(`- Unique IPs: ${summary.unique_ip_count_window}`);
  lines.push(`- Unique sessions: ${summary.unique_session_count_window}`);
  lines.push(
    `- Empty-result count: ${summary.empty_result_count_window} ` +
      `(${(summary.empty_result_rate_window * 100).toFixed(1)}%)`,
  );
  lines.push(`- p95 latency: ${summary.p95_latency_ms_window} ms`);
  lines.push("");

  // 2. Activity by day
  lines.push("## Activity by day");
  lines.push("");
  lines.push("| Day | Tool calls |");
  lines.push("| --- | --- |");
  for (const d of summary.queries_per_day_window) {
    lines.push(`| ${sanitizeCell(d.day)} | ${d.count} |`);
  }
  lines.push("");

  // 3. Tool breakdown
  const split = searchVsExploreSplit(toolBreakdown);
  lines.push("## Tool breakdown");
  lines.push("");
  lines.push(
    `Search calls: ${split.search} · Explore calls: ${split.explore}` +
      (split.other ? ` · Other: ${split.other}` : ""),
  );
  lines.push("");
  lines.push("| Tool | Calls |");
  lines.push("| --- | --- |");
  for (const t of toolBreakdown) {
    lines.push(`| ${sanitizeCell(t.tool_name)} | ${t.count} |`);
  }
  lines.push("");

  // 4. Top query categories
  const cats = categorizeQueries(queries);
  lines.push("## Top query categories");
  lines.push("");
  lines.push(
    "_(categories of queries that returned >=1 result; always-empty traffic is in the Empty-result section)_",
  );
  lines.push("");
  lines.push("| Category | Queries |");
  lines.push("| --- | --- |");
  for (const c of cats) {
    lines.push(`| ${c.category} | ${c.count} |`);
  }
  lines.push("");

  // 5. Top 20 queries
  const top = topNQueries(queries, TOP_QUERIES_N);
  lines.push(`## Top ${TOP_QUERIES_N} queries by frequency`);
  lines.push("");
  lines.push("| Query | Tool | Count |");
  lines.push("| --- | --- | --- |");
  for (const q of top) {
    lines.push(
      `| ${sanitizeCell(q.query_text)} | ${sanitizeCell(q.tool_name)} | ${q.count} |`,
    );
  }
  lines.push("");

  // 6. Empty-result queries
  lines.push("## Empty-result queries (what users wanted but didn't find)");
  lines.push("");
  if (emptyQueries.length === 0) {
    lines.push("(none)");
  } else {
    lines.push("| Query | Tool | Source | Count |");
    lines.push("| --- | --- | --- | --- |");
    for (const e of emptyQueries) {
      lines.push(
        `| ${sanitizeCell(e.query_text)} | ${sanitizeCell(e.tool_name)} | ${sanitizeCell(e.source_name ?? "(none)")} | ${e.count} |`,
      );
    }
  }
  lines.push("");

  // 7. Explore / bash command breakdown
  const explore = exploreBreakdown(toolBreakdown);
  lines.push("## Explore/bash command breakdown");
  lines.push("");
  if (explore.length === 0) {
    lines.push("(none)");
  } else {
    lines.push("| Command | Calls |");
    lines.push("| --- | --- |");
    for (const e of explore) {
      lines.push(`| ${sanitizeCell(e.tool_name)} | ${e.count} |`);
    }
  }
  lines.push("");

  // 8. Observations (computed ONLY from the current window — stateless)
  lines.push("## Observations");
  lines.push("");
  for (const obs of buildObservations(bundle)) {
    lines.push(`- ${obs}`);
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Neutralize a markdown TABLE cell so a pipe in user/analytics text can't break
 * the row. Pipes are escaped (`\|`) — the native Notion table path unescapes
 * them back via tableCellText — and every flavor of line break (\r\n, \r, \n)
 * collapses to a single space so a multi-line value can't split a table row.
 *
 * Use sanitizeInline (NOT this) for bullet/paragraph text: those block paths do
 * NOT unescape `\|`, so escaping a pipe there would publish a literal backslash.
 */
export function sanitizeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, " ");
}

/**
 * Neutralize inline (bullet / paragraph) text. Unlike sanitizeCell this does
 * NOT escape `|`: bullets and paragraphs are not markdown tables, and their
 * Notion block path does not unescape `\|`, so an escaped pipe would render the
 * literal backslash. Newlines still collapse to a space so a single observation
 * can't split into extra blocks.
 */
export function sanitizeInline(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " ");
}

/**
 * Deterministic observations from the CURRENT 7-day window only. The report is
 * stateless (no prior-run history), so observations must NOT reference
 * cross-week baselines / medians / trends.
 */
export function buildObservations(bundle: AnalyticsBundle): string[] {
  const { summary, queries, emptyQueries } = bundle;
  const out: string[] = [];
  out.push(
    `Empty-result rate is ${(summary.empty_result_rate_window * 100).toFixed(1)}% ` +
      `of ${summary.total_queries_window} tool calls in the window.`,
  );
  out.push(
    `${summary.unique_ip_count_window} unique IPs across ${summary.unique_session_count_window} sessions.`,
  );
  const cats = categorizeQueries(queries);
  if (cats.length > 0) {
    out.push(
      `Top category is ${cats[0].category} with ${cats[0].count} queries.`,
    );
  }
  if (emptyQueries.length > 0) {
    const topEmpty = [...emptyQueries].sort((a, b) => b.count - a.count)[0];
    out.push(
      `Highest-frequency empty query: "${sanitizeInline(topEmpty.query_text)}" (${topEmpty.count} hits, ${sanitizeInline(topEmpty.tool_name)}).`,
    );
  }
  return out;
}

// ── Notion block rendering (mirrors gap-analysis) ─────────────────────────────

export const NOTION_RICH_TEXT_LIMIT = 2000;
export const NOTION_MAX_BLOCKS_PER_REQUEST = 100;

interface NotionRichText {
  type: "text";
  text: { content: string };
}

type NotionBlockType =
  | "heading_1"
  | "heading_2"
  | "heading_3"
  | "bulleted_list_item"
  | "paragraph"
  | "table";

interface NotionBlock {
  object: "block";
  type: NotionBlockType;
  [key: string]: unknown;
}

interface NotionTableRow {
  type: "table_row";
  table_row: { cells: NotionRichText[][] };
}

interface NotionTableBlock extends NotionBlock {
  type: "table";
  table: {
    table_width: number;
    has_column_header: boolean;
    has_row_header: boolean;
    children: NotionTableRow[];
  };
}

/** Max DATA rows (excluding header) emitted per Notion table. */
export const NOTION_MAX_TABLE_ROWS = 100;

function lineToRichText(line: string): NotionRichText[] {
  if (line.length <= NOTION_RICH_TEXT_LIMIT) {
    return [{ type: "text", text: { content: line } }];
  }
  const spans: NotionRichText[] = [];
  for (let i = 0; i < line.length; i += NOTION_RICH_TEXT_LIMIT) {
    spans.push({
      type: "text",
      text: { content: line.slice(i, i + NOTION_RICH_TEXT_LIMIT) },
    });
  }
  return spans;
}

function makeBlock(type: NotionBlockType, text: string): NotionBlock {
  return {
    object: "block",
    type,
    [type]: { rich_text: lineToRichText(text) },
  };
}

/** A markdown table row line starts and ends with a pipe (after trimming). */
function isTableLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length > 1;
}

/** A `| --- | :--: |`-style separator row that delimits header from body. */
function isSeparatorRow(line: string): boolean {
  return splitTableRow(line).every((c) => /^:?-{1,}:?$/.test(c.trim()));
}

/**
 * Split one `| a | b |` line into its cell strings (drops the outer pipes).
 * Splits on UNESCAPED pipes only, so a `\|` inside a cell (the escaping
 * `sanitizeCell` introduced) stays part of that cell.
 */
function splitTableRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  // Negative lookbehind: a `|` not preceded by a backslash is a delimiter.
  return t.split(/(?<!\\)\|/);
}

/**
 * Un-escape a markdown table cell (Notion cells are not markdown, so the `\|`
 * that `sanitizeCell` introduced must be undone) and trim surrounding space.
 */
function tableCellText(raw: string): string {
  return raw.replace(/\\\|/g, "|").trim();
}

function makeTableRow(cells: string[]): NotionTableRow {
  return {
    type: "table_row",
    table_row: { cells: cells.map((c) => lineToRichText(tableCellText(c))) },
  };
}

/**
 * Build a native Notion `table` block from a contiguous run of `|...|` lines.
 * The separator row is dropped; the first remaining row is the header. Tables
 * are capped at NOTION_MAX_TABLE_ROWS data rows (a trailing truncation note is
 * the caller's responsibility) and every cell respects the rich_text cap.
 */
function tableRunToBlock(run: string[]): {
  block: NotionTableBlock;
  truncatedFrom: number | null;
} {
  const rows = run.filter((l) => !isSeparatorRow(l)).map(splitTableRow);
  const width = rows.reduce((max, r) => Math.max(max, r.length), 0);
  const header = rows[0] ?? [];
  const dataRows = rows.slice(1);
  const totalData = dataRows.length;
  const keptData =
    totalData > NOTION_MAX_TABLE_ROWS
      ? dataRows.slice(0, NOTION_MAX_TABLE_ROWS)
      : dataRows;

  // Pad ragged rows to a uniform width so Notion accepts the table.
  const pad = (cells: string[]): string[] =>
    cells.length >= width
      ? cells
      : [...cells, ...Array(width - cells.length).fill("")];

  const children: NotionTableRow[] = [
    makeTableRow(pad(header)),
    ...keptData.map((r) => makeTableRow(pad(r))),
  ];

  return {
    block: {
      object: "block",
      type: "table",
      table: {
        table_width: width,
        has_column_header: true,
        has_row_header: false,
        children,
      },
    },
    truncatedFrom: totalData > NOTION_MAX_TABLE_ROWS ? totalData : null,
  };
}

/**
 * Convert the markdown report into native Notion blocks (headings, bullets,
 * paragraphs, and tables). The leading `# <title>` line is dropped because it
 * duplicates the page title (set via properties.title). A contiguous run of
 * `|...|` lines becomes one native `table` block (separator row dropped, first
 * row as header); tables longer than NOTION_MAX_TABLE_ROWS data rows are capped
 * with a trailing truncation note. Every block respects the 2000-char
 * rich_text cap.
 */
export function markdownToNotionBlocks(markdown: string): NotionBlock[] {
  const blocks: NotionBlock[] = [];
  const rawLines = markdown.split("\n");

  for (let idx = 0; idx < rawLines.length; idx++) {
    const line = rawLines[idx];
    if (idx === 0 && line.startsWith("# ")) continue; // drop duplicate-title H1

    // Gather a contiguous run of table lines and emit one table block.
    if (isTableLine(line)) {
      const run: string[] = [];
      while (idx < rawLines.length && isTableLine(rawLines[idx])) {
        run.push(rawLines[idx]);
        idx++;
      }
      idx--; // step back: the for-loop's idx++ re-consumes the non-table line
      const { block, truncatedFrom } = tableRunToBlock(run);
      blocks.push(block);
      if (truncatedFrom !== null) {
        blocks.push(
          makeBlock(
            "paragraph",
            `(table truncated to first ${NOTION_MAX_TABLE_ROWS} rows of ${truncatedFrom})`,
          ),
        );
      }
      continue;
    }

    if (line.trim() === "") continue;
    if (line.startsWith("### ")) {
      blocks.push(makeBlock("heading_3", line.slice(4)));
    } else if (line.startsWith("## ")) {
      blocks.push(makeBlock("heading_2", line.slice(3)));
    } else if (line.startsWith("# ")) {
      blocks.push(makeBlock("heading_1", line.slice(2)));
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      blocks.push(makeBlock("bulleted_list_item", line.slice(2)));
    } else {
      blocks.push(makeBlock("paragraph", line));
    }
  }
  return blocks;
}

export function batchBlocks<T>(blocks: T[], size: number): T[][] {
  if (size <= 0) {
    throw new Error(
      `batchBlocks: size must be a positive integer, got ${size}`,
    );
  }
  const batches: T[][] = [];
  for (let i = 0; i < blocks.length; i += size) {
    batches.push(blocks.slice(i, i + size));
  }
  return batches;
}

// ── Injected dependencies (so run() is unit-testable without the network) ─────

export interface RunEnv {
  PATHFINDER_ANALYTICS_TOKEN?: string;
  NOTION_TOKEN?: string;
  NOTION_PARENT_PAGE_ID?: string;
  SLACK_WEBHOOK?: string;
  SLACK_ENGR_WEBHOOK?: string;
  ANALYTICS_BASE_URL?: string;
  REPORT_DAYS?: string;
}

export interface RunDeps {
  env: RunEnv;
  argv: readonly string[];
  /** Fetch + parse one analytics endpoint. Throws on non-2xx. */
  fetchJson: <T>(path: string) => Promise<T>;
  /** Publish the report to Notion. Returns the page URL (or null). Throws on failure. */
  publishNotion: (title: string, markdown: string) => Promise<string | null>;
  /** Post a Slack FAILURE alert to #oss-alerts (no-op if the webhook is unset). Never throws. */
  postSlack: (text: string) => Promise<void>;
  /**
   * Post a Slack SUCCESS digest to #engr (no-op if the webhook is unset). Never
   * throws and never affects the exit code — purely best-effort visibility.
   */
  postSuccess: (text: string) => Promise<void>;
  /**
   * Write the rendered report to a local path (mkdir -p its parent first).
   * Injected so the --report write is a unit-testable fail-loud surface like
   * fetch/notion/slack. Throws on any mkdir/write failure.
   */
  writeReport: (path: string, markdown: string) => void;
  exit: (code: number) => void;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const DEFAULT_BASE_URL = "https://mcp.copilotkit.ai";
const DEFAULT_PARENT_PAGE_ID = "3793aa38-1852-80a5-89d3-c3d37147aa22";

/**
 * Build the real (network-backed) fetchJson bound to a base URL + token, modeled
 * on monthly-gap-analysis's helper.
 */
export function makeFetchJson(
  baseUrl: string,
  token: string,
): <T>(path: string) => Promise<T> {
  const base = baseUrl.replace(/\/+$/, "");
  return async <T>(path: string): Promise<T> => {
    const url = `${base}${path}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "pathfinder-weekly-search-report",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Analytics fetch failed: ${res.status} ${res.statusText} for ${path}${
          body ? ` — ${body.slice(0, 200)}` : ""
        }`,
      );
    }
    return (await res.json()) as T;
  };
}

/**
 * The minimal slice of the Notion SDK client this module uses. Declared as an
 * interface so the publish core (publishNotionWithClient) can be unit-tested
 * with an injected fake, without loading the real `@notionhq/client` SDK.
 */
export interface NotionClientLike {
  pages: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create: (args: any) => Promise<{ id: string; url?: string | null }>;
    update: (args: { page_id: string; archived: boolean }) => Promise<unknown>;
  };
  blocks: {
    children: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      append: (args: any) => Promise<unknown>;
    };
  };
}

/**
 * Publish core: create the page with the first 100-block batch, then append the
 * remaining batches. Notion has NO transactional multi-batch create — once
 * pages.create succeeds the page exists, so if any later append throws we would
 * otherwise be left with a PARTIAL/orphaned page while the run reports failure.
 * To honor the "never publish a degraded page" promise, on any append failure we
 * make a BEST-EFFORT attempt to archive the just-created page (ignoring errors
 * from the archive itself) and then re-throw the ORIGINAL append error so the
 * caller still fails loud (Slack + exit 1).
 *
 * Separated from makePublishNotion (which only wires the real SDK) so it can be
 * unit-tested with a fake NotionClientLike.
 */
export async function publishNotionWithClient(
  notion: NotionClientLike,
  parentPageId: string,
  title: string,
  markdown: string,
): Promise<string | null> {
  const blocks = markdownToNotionBlocks(markdown);
  const batches = batchBlocks(blocks, NOTION_MAX_BLOCKS_PER_REQUEST);
  const firstBatch = batches[0] ?? [];
  const page = await notion.pages.create({
    parent: { page_id: parentPageId },
    properties: {
      title: { title: [{ type: "text", text: { content: title } }] },
    },
    children: firstBatch,
  });
  try {
    for (const batch of batches.slice(1)) {
      await notion.blocks.children.append({
        block_id: page.id,
        children: batch,
      });
    }
  } catch (appendErr) {
    // The page already exists (Notion can't create multi-batch atomically).
    // Best-effort archive the partial page so no degraded page survives; swallow
    // any archive error, then re-throw the original append failure.
    try {
      await notion.pages.update({ page_id: page.id, archived: true });
    } catch {
      // Intentionally ignored — archiving is best-effort cleanup.
    }
    throw appendErr;
  }
  return page.url ?? null;
}

/** The real Notion publisher (dynamic import so tests never load the SDK). */
export function makePublishNotion(
  notionToken: string,
  parentPageId: string,
): (title: string, markdown: string) => Promise<string | null> {
  return async (title: string, markdown: string): Promise<string | null> => {
    const { Client } = await import("@notionhq/client");
    const notion = new Client({ auth: notionToken });
    return publishNotionWithClient(
      notion as unknown as NotionClientLike,
      parentPageId,
      title,
      markdown,
    );
  };
}

/** The real Slack poster (no-op when the webhook is unset). Never throws. */
export function makePostSlack(
  webhook: string,
): (text: string) => Promise<void> {
  return async (text: string): Promise<void> => {
    if (!webhook) {
      console.log(
        "[weekly-report] SLACK_WEBHOOK unset — skipping Slack alert.",
      );
      return;
    }
    try {
      const res = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        console.warn(
          `[weekly-report] Slack POST failed: ${res.status} ${res.statusText}`,
        );
      }
    } catch (err) {
      console.warn(`[weekly-report] Slack POST error: ${String(err)}`);
    }
  };
}

/**
 * Fetch all four required endpoints and validate their shapes. Throws (the
 * fail-loud signal) on any non-2xx (from fetchJson) or malformed payload.
 */
export async function fetchBundle(
  deps: Pick<RunDeps, "fetchJson">,
  days: number,
): Promise<AnalyticsBundle> {
  const summary = await deps.fetchJson<AnalyticsSummary>(
    `/api/analytics/summary?days=${days}`,
  );
  assertValidSummary(summary);

  const queries = await deps.fetchJson<TopQuery[]>(
    `/api/analytics/queries?days=${days}&limit=200`,
  );
  assertArrayOf<TopQuery>("/queries", queries, (r, i) =>
    assertTopQueryRow("/queries", r, i),
  );

  const emptyQueries = await deps.fetchJson<EmptyQuery[]>(
    `/api/analytics/empty-queries?days=${days}&limit=200`,
  );
  assertArrayOf<EmptyQuery>("/empty-queries", emptyQueries, (r, i) =>
    assertEmptyQueryRow("/empty-queries", r, i),
  );

  const toolBreakdown = await deps.fetchJson<ToolBreakdownRow[]>(
    `/api/analytics/tool-breakdown?days=${days}`,
  );
  assertArrayOf<ToolBreakdownRow>("/tool-breakdown", toolBreakdown, (r, i) =>
    assertToolBreakdownRow("/tool-breakdown", r, i),
  );

  return { summary, queries, emptyQueries, toolBreakdown };
}

/**
 * The orchestrating run. Dependency-injected so every fail-loud path is
 * unit-testable without the network. The contract this enforces is the whole
 * point of the rebuild:
 *   - missing token / any fetch failure / malformed payload → log "FAILED",
 *     POST a Slack alert, exit(1), and NEVER publish a Notion page.
 *   - a Notion publish failure AFTER a good fetch → also Slack + exit(1).
 */
export async function run(deps: RunDeps): Promise<void> {
  const token = (deps.env.PATHFINDER_ANALYTICS_TOKEN ?? "").trim();

  // The exact 2026-06-21 failure mode: no token → fail loud, no error page.
  if (!token) {
    const reason = "PATHFINDER_ANALYTICS_TOKEN is missing or empty";
    deps.error(`[weekly-report] FAILED: ${reason}`);
    await deps.postSlack(`Pathfinder weekly search report FAILED: ${reason}`);
    deps.exit(1);
    return;
  }

  const days = parseReportDays(deps.env.REPORT_DAYS);

  let bundle: AnalyticsBundle;
  try {
    bundle = await fetchBundle(deps, days);
  } catch (err) {
    const reason = String(err instanceof Error ? err.message : err);
    deps.error(`[weekly-report] FAILED: ${reason}`);
    await deps.postSlack(`Pathfinder weekly search report FAILED: ${reason}`);
    deps.exit(1);
    return;
  }

  const now = new Date();
  const title = reportTitle(now, days);
  const markdown = renderMarkdown(bundle, now, days);

  // A requested --report path is written before publish — it's a local artifact
  // the workflow uploads, not an external side effect, and is useful even if the
  // publish step later fails.
  const reportPath = reportPathArgFrom(deps.argv);
  if (reportPath) {
    try {
      deps.writeReport(reportPath, markdown);
      deps.log(`[weekly-report] Report written to ${reportPath}`);
    } catch (err) {
      const reason = `--report write failed: ${String(
        err instanceof Error ? err.message : err,
      )}`;
      deps.error(`[weekly-report] FAILED: ${reason}`);
      await deps.postSlack(`Pathfinder weekly search report FAILED: ${reason}`);
      deps.exit(1);
      return;
    }
  }

  // Notion publish failure after a good fetch is also fail-loud.
  let url: string | null;
  try {
    url = await deps.publishNotion(title, markdown);
    deps.log(`[weekly-report] Published to Notion: ${url ?? "(no url)"}`);
  } catch (err) {
    const reason = `Notion publish failed: ${String(
      err instanceof Error ? err.message : err,
    )}`;
    deps.error(`[weekly-report] FAILED: ${reason}`);
    await deps.postSlack(`Pathfinder weekly search report FAILED: ${reason}`);
    deps.exit(1);
    return;
  }

  // Best-effort SUCCESS visibility to #engr. postSuccess never throws and never
  // touches the exit code, so it cannot affect the fail-loud contract above.
  await deps.postSuccess(buildSuccessDigest(bundle, url));

  deps.log("[weekly-report] Done.");
}

/**
 * Build the one-line Slack mrkdwn SUCCESS digest posted to #engr after a healthy
 * publish. The Notion link is rendered as an `<url|report>` hyperlink (a
 * `[report]` link, NOT the raw url); when there is no url (publish returned
 * null) the trailing segment is the plain text `(report published)` instead.
 * The `top:` segment is omitted when there are no categorized queries.
 */
export function buildSuccessDigest(
  bundle: AnalyticsBundle,
  url: string | null,
): string {
  const { summary } = bundle;
  const emptyRatePct = (summary.empty_result_rate_window * 100).toFixed(1);
  const cats = categorizeQueries(bundle.queries);
  const topSegment = cats.length > 0 ? ` · top: ${cats[0].category}` : "";
  const link = url ? `<${url}|report>` : "(report published)";
  return (
    `:bar_chart: Pathfinder weekly search report — ` +
    `${summary.total_queries_window} tool calls · ` +
    `${summary.unique_ip_count_window} unique IPs${topSegment} · ` +
    `${emptyRatePct}% empty · ${link}`
  );
}

// ── Real-environment wiring (only runs when invoked directly) ─────────────────

function buildRealDeps(): RunDeps {
  const env: RunEnv = {
    PATHFINDER_ANALYTICS_TOKEN: process.env.PATHFINDER_ANALYTICS_TOKEN,
    NOTION_TOKEN: process.env.NOTION_TOKEN,
    NOTION_PARENT_PAGE_ID: process.env.NOTION_PARENT_PAGE_ID,
    SLACK_WEBHOOK: process.env.SLACK_WEBHOOK,
    SLACK_ENGR_WEBHOOK: process.env.SLACK_ENGR_WEBHOOK,
    ANALYTICS_BASE_URL: process.env.ANALYTICS_BASE_URL,
    REPORT_DAYS: process.env.REPORT_DAYS,
  };
  const baseUrl = env.ANALYTICS_BASE_URL ?? DEFAULT_BASE_URL;
  const token = (env.PATHFINDER_ANALYTICS_TOKEN ?? "").trim();
  const notionToken = env.NOTION_TOKEN ?? "";
  const parentPageId = env.NOTION_PARENT_PAGE_ID ?? DEFAULT_PARENT_PAGE_ID;
  const webhook = env.SLACK_WEBHOOK ?? "";
  const engrWebhook = env.SLACK_ENGR_WEBHOOK ?? "";

  return {
    env,
    argv: process.argv,
    fetchJson: makeFetchJson(baseUrl, token),
    publishNotion: makePublishNotion(notionToken, parentPageId),
    postSlack: makePostSlack(webhook),
    postSuccess: makePostSlack(engrWebhook),
    writeReport: (path: string, markdown: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, markdown, "utf-8");
    },
    exit: (code: number) => process.exit(code),
    // eslint-disable-next-line no-console
    log: (...args: unknown[]) => console.log(...args),
    // eslint-disable-next-line no-console
    error: (...args: unknown[]) => console.error(...args),
  };
}

// Only run when invoked directly (npx tsx … / node …), not when imported by the
// unit tests, which exercise the exported pure helpers + run() with fakes.
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  console.log("=== Pathfinder Weekly Search Report ===");
  run(buildRealDeps()).catch((err) => {
    console.error("[weekly-report] Fatal error:", err);
    process.exit(1);
  });
}
