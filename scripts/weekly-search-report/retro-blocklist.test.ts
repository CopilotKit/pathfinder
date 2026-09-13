/**
 * End-to-end proof that off-topic rows logged BEFORE the blocklist learned
 * their pattern cannot reach either PUBLISHED surface: the weekly Notion
 * search report (cron `7 9 * * 0`) and the bi-weekly gap-analysis LLM prompt
 * (cron `0 4 1,15 * *`), whose output is also published to Notion.
 *
 * The 2026-09-13 weekly report carried 19 such rows out of 49 — Emmy/Grammy/
 * Academy-Awards and US-midterm/redistricting scraping, all with
 * `blocked = false` because the awards/election families only started firing
 * in production at 2026-09-10T16:40Z. See
 * src/__tests__/analytics-retro-blocklist.test.ts for the measurement and the
 * design rationale; this suite exists because "the DB layer filters it" is a
 * claim about a different file than the ones that publish.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  __setPoolForTesting,
  __resetPoolForTesting,
} from "../../src/db/client.js";
import {
  getAnalyticsSummary,
  getEmptyQueries,
  getToolBreakdown,
  getTopQueries,
} from "../../src/db/analytics.js";
import { generatePostSchemaMigration } from "../../src/db/schema.js";
import { fetchBundle, renderMarkdown } from "./weekly-search-report.js";
import type {
  AnalyticsBundle,
  AnalyticsSummary as ReportSummary,
  EmptyQuery as ReportEmptyQuery,
  TopQuery as ReportTopQuery,
  ToolBreakdownRow,
} from "./weekly-search-report.js";
import { buildLlmPrompt } from "../gap-analysis/monthly-gap-analysis.js";
import { clusterQueries, filterSynthetic } from "../gap-analysis/cluster.js";

const QUERY_LOG_DDL_MARKER =
  "-- Analytics: query_log table for tracking tool usage";

function extractAnalyticsDdl(): string {
  const full = generatePostSchemaMigration();
  const idx = full.indexOf(QUERY_LOG_DDL_MARKER);
  if (idx < 0) {
    throw new Error(`Could not locate "${QUERY_LOG_DDL_MARKER}" in schema`);
  }
  return full.slice(idx);
}

function poolFromPglite(db: PGlite) {
  return {
    query: (text: string, params?: unknown[]) => db.query(text, params),
    connect: async () => ({
      query: (text: string, params?: unknown[]) => db.query(text, params),
      release: () => {},
    }),
    end: async () => db.close(),
  };
}

/** Verbatim off-topic rows from the 2026-09-13 report window. */
const STALE_OFFTOPIC = [
  "Emmy Awards 2026 Widow's Bay nominations",
  "GRAMMY Record of the Year historical winners base rates",
  "Michigan House districts 2026 midterm",
  "Missouri congressional redistricting 2026",
  "Swedish election 2026 Green Party polls",
  "Brazil 2026 presidential election Lula polls",
];

/** Verbatim genuine zero-result developer queries from the same window. */
const REAL_GAPS = [
  "CopilotKit v2 useInterrupt human in the loop AG-UI resume interrupt resolve pendingInterrupts",
  "CopilotChatUserMessage copyButton slot props CopyButton component onClick v2 message toolbar",
  "useHumanInTheLoop respond status executing complete renderAndWaitForResponse",
];

async function insertRow(
  db: PGlite,
  text: string,
  results: number,
): Promise<void> {
  await db.query(
    `INSERT INTO query_log
       (tool_name, query_text, result_count, top_score, score_kind, latency_ms,
        source_name, session_id, request_source, client_ip, user_agent,
        blocked, block_reason)
     VALUES ('search-docs',$1,$2,$3,$4,25,'docs','s-1','user',
             '160.79.106.34','Claude-User',false,NULL)`,
    [text, results, results > 0 ? 0.4 : null, results > 0 ? "cosine" : null],
  );
}

async function bundle(): Promise<AnalyticsBundle> {
  return {
    summary: (await getAnalyticsSummary({}, 7)) as unknown as ReportSummary,
    queries: (await getTopQueries(7, 200)) as unknown as ReportTopQuery[],
    emptyQueries: (await getEmptyQueries(
      7,
      200,
    )) as unknown as ReportEmptyQuery[],
    toolBreakdown: (await getToolBreakdown(
      7,
      {},
    )) as unknown as ToolBreakdownRow[],
  };
}

describe("published reports re-judge stale off-topic rows", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.waitReady;
    await db.exec(extractAnalyticsDdl());
    __setPoolForTesting(poolFromPglite(db));
  });

  afterAll(async () => {
    __resetPoolForTesting();
    await db.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM query_log");
    for (const q of STALE_OFFTOPIC) await insertRow(db, q, 0);
    for (const q of REAL_GAPS) await insertRow(db, q, 0);
    await insertRow(db, "how do I install copilotkit", 5);
  });

  it("renders no stale off-topic row into the weekly Notion report", async () => {
    const md = renderMarkdown(
      await bundle(),
      new Date("2026-09-13T09:44:00Z"),
      7,
    );
    for (const q of STALE_OFFTOPIC) expect(md).not.toContain(q);
  });

  it("still renders every genuine documentation gap in the weekly report", async () => {
    const md = renderMarkdown(
      await bundle(),
      new Date("2026-09-13T09:44:00Z"),
      7,
    );
    for (const q of REAL_GAPS) expect(md).toContain(q);
  });

  it("puts no stale off-topic row into the gap-analysis LLM prompt", async () => {
    const b = await bundle();
    const emptyRows = filterSynthetic(b.emptyQueries).map((q) => ({
      query_text: q.query_text,
      tool_name: q.tool_name,
      count: q.count,
    }));
    const prompt = buildLlmPrompt(
      {
        total_queries_window: b.summary.total_queries_window,
        empty_result_count_window: b.summary.empty_result_count_window,
        empty_result_rate_window: b.summary.empty_result_rate_window,
        queries_by_source: b.summary.queries_by_source,
      } as never,
      {
        topClusters: [],
        emptyClusters: clusterQueries(emptyRows),
        syntheticDropped: 0,
      },
    );
    for (const q of STALE_OFFTOPIC) expect(prompt).not.toContain(q);
    expect(prompt).toContain("pendingInterrupts");
  });

  it("serves the filtered list through the analytics HTTP bundle", async () => {
    // docs/analytics.html and both report scripts read the SAME
    // /api/analytics/empty-queries payload, so pin the fetched bundle too.
    const emptyQueries = (await getEmptyQueries(
      7,
      200,
    )) as unknown as ReportEmptyQuery[];
    const fetched = await fetchBundle(
      {
        fetchJson: async <T>(path: string): Promise<T> => {
          if (path.startsWith("/api/analytics/empty-queries")) {
            return emptyQueries as unknown as T;
          }
          if (path.startsWith("/api/analytics/queries"))
            return [] as unknown as T;
          if (path.startsWith("/api/analytics/tool-breakdown")) {
            return [] as unknown as T;
          }
          if (path.startsWith("/api/analytics/relay-exclusions")) {
            return [] as unknown as T;
          }
          return (await getAnalyticsSummary({}, 7)) as unknown as T;
        },
      } as never,
      7,
    );
    const texts = fetched.emptyQueries.map((e) => e.query_text);
    for (const q of STALE_OFFTOPIC) expect(texts).not.toContain(q);
    for (const q of REAL_GAPS) expect(texts).toContain(q);
  });
});
