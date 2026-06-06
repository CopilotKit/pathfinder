import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { __setPoolForTesting, __resetPoolForTesting } from "../db/client.js";
import {
  getAnalyticsSummary,
  getAtlasRetrievalMetrics,
  getTopQueries,
  getToolCounts,
  logQuery,
} from "../db/analytics.js";
import { generatePostSchemaMigration } from "../db/schema.js";

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

async function insertQuery(
  db: PGlite,
  row: {
    toolName: string;
    queryText: string;
    resultCount: number;
    sourceName: string | null;
    sessionId?: string | null;
  },
) {
  await db.query(
    `INSERT INTO query_log
      (tool_name, query_text, result_count, top_score, latency_ms, source_name, session_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      row.toolName,
      row.queryText,
      row.resultCount,
      row.resultCount > 0 ? 0.91 : null,
      25,
      row.sourceName,
      row.sessionId ?? null,
    ],
  );
}

describe("Atlas retrieval analytics", () => {
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
  });

  it("logs Atlas query metadata using the existing source and session columns", async () => {
    await logQuery({
      tool_name: "atlas-search",
      query_text: "how does runtime auth work?",
      result_count: 3,
      top_score: 0.88,
      latency_ms: 18,
      source_name: "atlas",
      session_id: "service:atlas-gardener",
    });

    const rows = await db.query(
      `SELECT tool_name, query_text, source_name, session_id
       FROM query_log`,
    );

    expect(rows.rows).toEqual([
      {
        tool_name: "atlas-search",
        query_text: "how does runtime auth work?",
        source_name: "atlas",
        session_id: "service:atlas-gardener",
      },
    ]);
  });

  it("excludes service-originated Atlas traffic from ordinary analytics aggregates by default", async () => {
    await insertQuery(db, {
      toolName: "search-docs",
      queryText: "ordinary docs query",
      resultCount: 2,
      sourceName: "docs",
    });
    await insertQuery(db, {
      toolName: "atlas-search",
      queryText: "user atlas query",
      resultCount: 1,
      sourceName: "atlas",
    });
    await insertQuery(db, {
      toolName: "atlas-search",
      queryText: "gardening probe",
      resultCount: 1,
      sourceName: "atlas",
      sessionId: "service:atlas-gardener",
    });

    const summary = await getAnalyticsSummary({}, 7);
    const toolCounts = await getToolCounts(7);
    const topQueries = await getTopQueries(7, 10);

    expect(summary.total_queries_window).toBe(2);
    expect(summary.queries_by_source).toEqual(
      expect.arrayContaining([
        { source_name: "atlas", count: 1 },
        { source_name: "docs", count: 1 },
      ]),
    );
    const sortedToolCounts = [...toolCounts].sort((a, b) =>
      a.tool_type.localeCompare(b.tool_type),
    );
    expect(sortedToolCounts).toEqual([
      { tool_type: "atlas", count: 1 },
      { tool_type: "search", count: 1 },
    ]);
    expect(topQueries.map((q) => q.query_text)).not.toContain(
      "gardening probe",
    );
  });

  it("can include service-originated traffic when explicitly requested", async () => {
    await insertQuery(db, {
      toolName: "atlas-search",
      queryText: "user atlas query",
      resultCount: 1,
      sourceName: "atlas",
    });
    await insertQuery(db, {
      toolName: "atlas-search",
      queryText: "gardening probe",
      resultCount: 1,
      sourceName: "atlas",
      sessionId: "service:atlas-gardener",
    });

    const summary = await getAnalyticsSummary(
      { include_service_traffic: true },
      7,
    );

    expect(summary.total_queries_window).toBe(2);
    expect(summary.queries_by_source).toEqual([
      { source_name: "atlas", count: 2 },
    ]);
  });

  it("includes exact Atlas tool names when filtering analytics by Atlas tool type", async () => {
    await insertQuery(db, {
      toolName: "atlas",
      queryText: "exact atlas tool query",
      resultCount: 1,
      sourceName: "atlas",
    });
    await insertQuery(db, {
      toolName: "atlas-search",
      queryText: "prefixed atlas tool query",
      resultCount: 1,
      sourceName: "atlas",
    });
    await insertQuery(db, {
      toolName: "search-docs",
      queryText: "ordinary docs query",
      resultCount: 1,
      sourceName: "docs",
    });

    const summary = await getAnalyticsSummary({ tool_type: "atlas" }, 7);
    const topQueries = await getTopQueries(7, 10, { tool_type: "atlas" });

    expect(summary.total_queries_window).toBe(2);
    expect(summary.queries_by_source).toEqual([
      { source_name: "atlas", count: 2 },
    ]);
    expect(topQueries.map((query) => query.tool_name).sort()).toEqual([
      "atlas",
      "atlas-search",
    ]);
  });

  it("computes Atlas retrieval rate without ordinary search traffic in the denominator", async () => {
    await insertQuery(db, {
      toolName: "search-docs",
      queryText: "ordinary docs query",
      resultCount: 2,
      sourceName: "docs",
    });
    await insertQuery(db, {
      toolName: "atlas-search",
      queryText: "atlas hit",
      resultCount: 2,
      sourceName: "atlas",
    });
    await insertQuery(db, {
      toolName: "search-atlas",
      queryText: "atlas miss",
      resultCount: 0,
      sourceName: "atlas",
    });
    await insertQuery(db, {
      toolName: "atlas-search",
      queryText: "service hit",
      resultCount: 1,
      sourceName: "atlas",
      sessionId: "service:atlas-gardener",
    });

    const metrics = await getAtlasRetrievalMetrics(7);

    expect(metrics).toEqual({
      atlas_queries_window: 2,
      atlas_successful_queries_window: 1,
      atlas_empty_queries_window: 1,
      atlas_retrieval_rate_window: 0.5,
      total_user_queries_window: 3,
    });
  });
});
