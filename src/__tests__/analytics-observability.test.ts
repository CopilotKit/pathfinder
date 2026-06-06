import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { __setPoolForTesting, __resetPoolForTesting } from "../db/client.js";
import {
  getAnalyticsSummary,
  getToolCounts,
  logQuery,
} from "../db/analytics.js";
import { generatePostSchemaMigration } from "../db/schema.js";

// -----------------------------------------------------------------------------
// Integration tests for the observability primitives (request_source +
// low-confidence) against a real in-process PGlite instance.
//
// Mock-pool unit tests pin the generated SQL strings + bound params, but they
// can't catch an off-by-one in the `$N` placeholder numbering — only running
// the SQL end-to-end does. These tests seed query_log with a known mix of
// origins and scores, then assert getAnalyticsSummary / getToolCounts return
// the right COUNTS, exercising every windowed subquery (which is where the
// request-source clause is spliced between the date-window and redacted
// params).
//
// Schema source of truth: generatePostSchemaMigration() — we slice out just
// the query_log section so we don't need the pgvector extension.
// -----------------------------------------------------------------------------

const QUERY_LOG_DDL_MARKER =
  "-- Analytics: query_log table for tracking tool usage";

function extractQueryLogDdl(): string {
  const full = generatePostSchemaMigration();
  const idx = full.indexOf(QUERY_LOG_DDL_MARKER);
  if (idx < 0) {
    throw new Error(
      `Could not locate "${QUERY_LOG_DDL_MARKER}" in generatePostSchemaMigration(); ` +
        `schema.ts may have been refactored — update the marker.`,
    );
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

/** A timestamp inside today's UTC day (noon, avoids TZ edge ambiguity). */
function nowNoonUtc(): Date {
  const day = new Date().toISOString().slice(0, 10);
  return new Date(`${day}T12:00:00.000Z`);
}

interface SeedOpts {
  request_source?: string | null;
  top_score?: number | null;
  result_count?: number;
  query_text?: string;
}

async function seed(db: PGlite, count: number, opts: SeedOpts = {}) {
  const createdAt = nowNoonUtc();
  for (let i = 0; i < count; i++) {
    await db.query(
      `INSERT INTO query_log
        (tool_name, query_text, result_count, top_score, latency_ms,
         source_name, session_id, request_source, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        "search-docs",
        opts.query_text ?? "q",
        opts.result_count ?? 5,
        opts.top_score === undefined ? 0.9 : opts.top_score,
        42,
        "docs",
        "sess-1",
        opts.request_source === undefined ? "user" : opts.request_source,
        createdAt,
      ],
    );
  }
}

describe("observability: request_source + low-confidence (PGlite integration)", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.waitReady;
    await db.exec(extractQueryLogDdl());
    __setPoolForTesting(poolFromPglite(db));
  });

  afterAll(async () => {
    __resetPoolForTesting();
    await db.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM query_log");
  });

  // ---------------------------------------------------------------------------
  // request_source default = real users (user + NULL), synthetic/analysis out
  // ---------------------------------------------------------------------------

  it("default summary counts real users (user) AND untagged (NULL), excludes synthetic/analysis", async () => {
    await seed(db, 10, { request_source: "user" });
    await seed(db, 4, { request_source: null }); // historical, untagged
    await seed(db, 7, { request_source: "synthetic" });
    await seed(db, 3, { request_source: "analysis" });

    const result = await getAnalyticsSummary({}, 7);

    // user (10) + null (4) = 14; synthetic/analysis excluded.
    expect(result.total_queries_window).toBe(14);
    // total_queries (all-time, all origins) counts everything.
    expect(result.total_queries).toBe(24);
  });

  it("request_source: 'all' counts every origin in the window", async () => {
    await seed(db, 10, { request_source: "user" });
    await seed(db, 4, { request_source: null });
    await seed(db, 7, { request_source: "synthetic" });
    await seed(db, 3, { request_source: "analysis" });

    const result = await getAnalyticsSummary({ request_source: "all" }, 7);

    expect(result.total_queries_window).toBe(24);
  });

  it("request_source: 'synthetic' counts only synthetic rows (NULL excluded)", async () => {
    await seed(db, 10, { request_source: "user" });
    await seed(db, 4, { request_source: null });
    await seed(db, 7, { request_source: "synthetic" });

    const result = await getAnalyticsSummary(
      { request_source: "synthetic" },
      7,
    );

    expect(result.total_queries_window).toBe(7);
  });

  it("request_source: 'user' explicitly still folds in NULL rows (real users)", async () => {
    await seed(db, 10, { request_source: "user" });
    await seed(db, 4, { request_source: null });
    await seed(db, 7, { request_source: "synthetic" });

    const result = await getAnalyticsSummary({ request_source: "user" }, 7);

    expect(result.total_queries_window).toBe(14);
  });

  it("getToolCounts honors the real-users default and the all-sources view", async () => {
    await seed(db, 6, { request_source: "user" });
    await seed(db, 2, { request_source: null });
    await seed(db, 5, { request_source: "synthetic" });

    const defaultCounts = await getToolCounts(7);
    const totalDefault = defaultCounts.reduce((a, c) => a + c.count, 0);
    expect(totalDefault).toBe(8); // user + null

    const allCounts = await getToolCounts(7, { request_source: "all" });
    const totalAll = allCounts.reduce((a, c) => a + c.count, 0);
    expect(totalAll).toBe(13);
  });

  // ---------------------------------------------------------------------------
  // low-confidence: result_count > 0 AND top_score < 0.5 (NULL excluded)
  // ---------------------------------------------------------------------------

  it("counts low-confidence rows (result_count>0 AND top_score<0.5), excludes NULL-score and empty", async () => {
    // 5 strong hits (0.9), 3 low-confidence (0.3), 2 empty (0 results, null
    // score), 1 borderline (exactly 0.5 — NOT low because predicate is < 0.5).
    await seed(db, 5, { top_score: 0.9, result_count: 5 });
    await seed(db, 3, { top_score: 0.3, result_count: 4 });
    await seed(db, 2, { top_score: null, result_count: 0 });
    await seed(db, 1, { top_score: 0.5, result_count: 4 });

    const result = await getAnalyticsSummary({}, 7);

    // Only the 3 rows scoring 0.3 are low-confidence.
    expect(result.low_confidence_count_window).toBe(3);
    // 11 rows total in the window, 3 low-confidence.
    expect(result.total_queries_window).toBe(11);
    expect(result.low_confidence_rate_window).toBeCloseTo(3 / 11);
  });

  it("low-confidence respects the request-source default (synthetic low-conf excluded)", async () => {
    await seed(db, 2, {
      top_score: 0.3,
      result_count: 4,
      request_source: "user",
    });
    await seed(db, 5, {
      top_score: 0.3,
      result_count: 4,
      request_source: "synthetic",
    });

    const result = await getAnalyticsSummary({}, 7);

    // Only the 2 real-user low-confidence rows count by default.
    expect(result.low_confidence_count_window).toBe(2);
  });

  it("a NULL top_score with results is NOT low-confidence (absence of score != low score)", async () => {
    await seed(db, 4, { top_score: null, result_count: 5 });

    const result = await getAnalyticsSummary({}, 7);

    expect(result.low_confidence_count_window).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // logQuery → readers round-trip (writer persists request_source end-to-end)
  // ---------------------------------------------------------------------------

  it("logQuery persists request_source so the readers can filter on it", async () => {
    await logQuery({
      tool_name: "search-docs",
      query_text: "q",
      result_count: 5,
      top_score: 0.9,
      latency_ms: 10,
      source_name: "docs",
      session_id: "live-1",
      request_source: "analysis",
    });
    await logQuery({
      tool_name: "search-docs",
      query_text: "q",
      result_count: 5,
      top_score: 0.9,
      latency_ms: 10,
      source_name: "docs",
      session_id: "live-2",
      request_source: "user",
    });

    // Default view sees only the real user row.
    const def = await getAnalyticsSummary({}, 7);
    expect(def.total_queries_window).toBe(1);

    // Analysis view sees only the analysis row.
    const analysis = await getAnalyticsSummary(
      { request_source: "analysis" },
      7,
    );
    expect(analysis.total_queries_window).toBe(1);

    // Confirm the writer actually stored session_id (no longer hardcoded null)
    // and the request_source column.
    const { rows } = await db.query<{
      session_id: string | null;
      request_source: string | null;
    }>("SELECT session_id, request_source FROM query_log ORDER BY session_id");
    expect(rows.map((r) => r.session_id)).toEqual(["live-1", "live-2"]);
    expect(rows.map((r) => r.request_source)).toEqual(["analysis", "user"]);
  });
});
