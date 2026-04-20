import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the pool before importing analytics module
const mockQuery = vi.fn();
vi.mock("../db/client.js", () => ({
  getPool: () => ({ query: mockQuery }),
}));

import {
  logQuery,
  getAnalyticsSummary,
  getTopQueries,
  getEmptyQueries,
  getToolCounts,
  cleanupOldQueryLogs,
} from "../db/analytics.js";
import type { QueryLogEntry } from "../db/analytics.js";

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// logQuery
// ---------------------------------------------------------------------------

describe("logQuery", () => {
  const baseEntry: QueryLogEntry = {
    tool_name: "search-docs",
    query_text: "how to install",
    result_count: 5,
    top_score: 0.92,
    latency_ms: 42,
    source_name: "docs",
    session_id: "sess-123",
  };

  it("inserts a row with all fields", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await logQuery(baseEntry);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("INSERT INTO query_log");
    expect(params).toEqual([
      "search-docs",
      "how to install",
      5,
      0.92,
      42,
      "docs",
      "sess-123",
    ]);
  });

  it("redacts query_text when logQueryText is false", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await logQuery(baseEntry, false);

    const [, params] = mockQuery.mock.calls[0];
    expect(params[1]).toBe("<redacted>");
  });

  it("passes null for nullable fields", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await logQuery({
      ...baseEntry,
      top_score: null,
      source_name: null,
      session_id: null,
    });

    const [, params] = mockQuery.mock.calls[0];
    expect(params[3]).toBeNull(); // top_score
    expect(params[5]).toBeNull(); // source_name
    expect(params[6]).toBeNull(); // session_id
  });
});

// ---------------------------------------------------------------------------
// logQuery error handling
// ---------------------------------------------------------------------------

describe("logQuery error handling", () => {
  it("propagates DB connection error to caller", async () => {
    mockQuery.mockRejectedValueOnce(new Error("connection refused"));
    await expect(
      logQuery({
        tool_name: "search",
        query_text: "test",
        result_count: 0,
        top_score: null,
        latency_ms: 10,
        source_name: null,
        session_id: null,
      }),
    ).rejects.toThrow("connection refused");
  });
});

// ---------------------------------------------------------------------------
// getAnalyticsSummary
// ---------------------------------------------------------------------------

describe("getAnalyticsSummary", () => {
  it("returns aggregated summary data", async () => {
    // Mock order: total, summary7d, latency rows, bySource, perDay
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: 1000 }] }) // total
      .mockResolvedValueOnce({
        rows: [{ total: 200, empty: 10, avg_latency: 45 }],
      }) // 7d summary
      .mockResolvedValueOnce({
        rows: Array.from({ length: 200 }, (_, i) => ({
          latency_ms: i + 1,
        })),
      }) // latency rows for p95 computation
      .mockResolvedValueOnce({
        rows: [{ source_name: "docs", count: 150 }],
      }) // by source
      .mockResolvedValueOnce({
        rows: [
          { day: "2026-04-10", count: 30 },
          { day: "2026-04-11", count: 25 },
        ],
      }); // per day

    const result = await getAnalyticsSummary();

    expect(result.total_queries).toBe(1000);
    expect(result.total_queries_window).toBe(200);
    expect(result.empty_result_count_window).toBe(10);
    expect(result.empty_result_rate_window).toBeCloseTo(0.05);
    expect(result.avg_latency_ms_window).toBe(45);
    // p95 of [1..200] sorted: index = floor(200 * 0.95) = 190, value = 191
    expect(result.p95_latency_ms_window).toBe(191);
    expect(result.queries_by_source).toEqual([
      { source_name: "docs", count: 150 },
    ]);
    expect(result.queries_per_day_window).toHaveLength(2);
  });

  it("handles zero queries gracefully", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: 0 }] })
      .mockResolvedValueOnce({
        rows: [{ total: 0, empty: 0, avg_latency: 0 }],
      })
      .mockResolvedValueOnce({ rows: [] }) // empty latency rows
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await getAnalyticsSummary();

    expect(result.total_queries).toBe(0);
    expect(result.empty_result_rate_window).toBe(0);
    expect(result.p95_latency_ms_window).toBe(0);
    expect(result.queries_by_source).toEqual([]);
    expect(result.queries_per_day_window).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// p95 computation edge cases (tested indirectly via getAnalyticsSummary)
// ---------------------------------------------------------------------------

describe("p95 computation edge cases", () => {
  it("p95 of single latency value returns that value", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: 1 }] })
      .mockResolvedValueOnce({
        rows: [{ total: 1, empty: 0, avg_latency: 42 }],
      })
      .mockResolvedValueOnce({ rows: [{ latency_ms: 42 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await getAnalyticsSummary();
    expect(result.p95_latency_ms_window).toBe(42);
  });

  it("p95 of all identical values returns that value", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: 100 }] })
      .mockResolvedValueOnce({
        rows: [{ total: 100, empty: 0, avg_latency: 50 }],
      })
      .mockResolvedValueOnce({
        rows: Array.from({ length: 100 }, () => ({ latency_ms: 50 })),
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await getAnalyticsSummary();
    expect(result.p95_latency_ms_window).toBe(50);
  });

  it("p95 of two values returns the higher one", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: 2 }] })
      .mockResolvedValueOnce({
        rows: [{ total: 2, empty: 0, avg_latency: 75 }],
      })
      .mockResolvedValueOnce({
        rows: [{ latency_ms: 50 }, { latency_ms: 100 }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await getAnalyticsSummary();
    // floor(2 * 0.95) = 1, sorted[1] = 100
    expect(result.p95_latency_ms_window).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// getTopQueries
// ---------------------------------------------------------------------------

describe("getTopQueries", () => {
  it("returns top queries with frequency, tool_name, and avg stats", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          query_text: "install guide",
          tool_name: "search-docs",
          count: 42,
          avg_result_count: "3.5",
          avg_top_score: "0.88",
        },
        {
          query_text: "api reference",
          tool_name: "search-code",
          count: 30,
          avg_result_count: "5.0",
          avg_top_score: null,
        },
      ],
    });

    const result = await getTopQueries(7, 50);

    expect(result).toHaveLength(2);
    expect(result[0].query_text).toBe("install guide");
    expect(result[0].tool_name).toBe("search-docs");
    expect(result[0].count).toBe(42);
    expect(result[0].avg_result_count).toBeCloseTo(3.5);
    expect(result[0].avg_top_score).toBeCloseTo(0.88);
    expect(result[1].tool_name).toBe("search-code");
    expect(result[1].avg_top_score).toBeNull();
  });

  it("passes days and limit to query params", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getTopQueries(30, 10);

    const [, params] = mockQuery.mock.calls[0];
    // No filter params, so just days and limit
    expect(params).toContain(30);
    expect(params).toContain(10);
  });

  it("excludes redacted queries", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getTopQueries();

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("query_text != '<redacted>'");
  });
});

// ---------------------------------------------------------------------------
// getTopQueries edge cases
// ---------------------------------------------------------------------------

describe("getTopQueries edge cases", () => {
  it("handles days=0 gracefully", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getTopQueries(0, 50);
    expect(result).toEqual([]);
    const [, params] = mockQuery.mock.calls[0];
    expect(params[0]).toBe(0);
  });

  it("handles limit=0 gracefully", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getTopQueries(7, 0);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getEmptyQueries
// ---------------------------------------------------------------------------

describe("getEmptyQueries", () => {
  it("returns empty-result queries grouped by text+tool+source", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          query_text: "nonexistent thing",
          tool_name: "search-docs",
          source_name: "docs",
          count: 15,
          last_seen: "2026-04-11T10:00:00Z",
        },
      ],
    });

    const result = await getEmptyQueries(7, 50);

    expect(result).toHaveLength(1);
    expect(result[0].query_text).toBe("nonexistent thing");
    expect(result[0].count).toBe(15);
    expect(result[0].source_name).toBe("docs");
  });

  it("filters on result_count = 0", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getEmptyQueries();

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("result_count = 0");
  });

  it("returns null for missing source_name", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          query_text: "q",
          tool_name: "t",
          source_name: null,
          count: 1,
          last_seen: "2026-04-11",
        },
      ],
    });

    const result = await getEmptyQueries();
    expect(result[0].source_name).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getEmptyQueries edge cases
// ---------------------------------------------------------------------------

describe("getEmptyQueries edge cases", () => {
  it("handles limit=0 gracefully", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getEmptyQueries(7, 0);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// cleanupOldQueryLogs
// ---------------------------------------------------------------------------

describe("cleanupOldQueryLogs", () => {
  it("deletes rows older than retention period and returns count", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 150 });
    const deleted = await cleanupOldQueryLogs(90);
    expect(deleted).toBe(150);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("DELETE FROM query_log");
    expect(params).toEqual([90]);
  });

  it("returns 0 when no rows match", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    const deleted = await cleanupOldQueryLogs(90);
    expect(deleted).toBe(0);
  });

  it("handles null rowCount gracefully", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: null });
    const deleted = await cleanupOldQueryLogs(90);
    expect(deleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// cleanupOldQueryLogs error handling
// ---------------------------------------------------------------------------

describe("cleanupOldQueryLogs error handling", () => {
  it("propagates DB error to caller", async () => {
    mockQuery.mockRejectedValueOnce(new Error("disk full"));
    await expect(cleanupOldQueryLogs(90)).rejects.toThrow("disk full");
  });
});

// ---------------------------------------------------------------------------
// getToolCounts
// ---------------------------------------------------------------------------

describe("getToolCounts", () => {
  it("returns counts grouped by tool type prefix", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { tool_type: "search", count: 3033 },
        { tool_type: "explore", count: 755 },
      ],
    });

    const result = await getToolCounts(7);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ tool_type: "search", count: 3033 });
    expect(result[1]).toEqual({ tool_type: "explore", count: 755 });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("split_part(tool_name");
    expect(params).toEqual([7]);
  });

  it("returns empty array when no queries exist", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getToolCounts(7);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Filter support (tool_type, source)
// ---------------------------------------------------------------------------

describe("getAnalyticsSummary with filters", () => {
  function mockSummaryQueries() {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: 500 }] }) // total
      .mockResolvedValueOnce({
        rows: [{ total: 100, empty: 5, avg_latency: 50 }],
      }) // 7d summary
      .mockResolvedValueOnce({ rows: [] }) // latency rows
      .mockResolvedValueOnce({ rows: [] }) // by source
      .mockResolvedValueOnce({ rows: [] }); // per day
  }

  it("passes tool_type filter as LIKE clause to all queries", async () => {
    mockSummaryQueries();
    await getAnalyticsSummary({ tool_type: "search" });

    // All 5 queries should have the filter
    for (let i = 0; i < 5; i++) {
      const [sql, params] = mockQuery.mock.calls[i];
      expect(sql).toContain("tool_name LIKE");
      expect(params).toContain("search");
    }
  });

  it("passes source filter as exact match to all queries", async () => {
    mockSummaryQueries();
    await getAnalyticsSummary({ source: "docs" });

    for (let i = 0; i < 5; i++) {
      const [sql, params] = mockQuery.mock.calls[i];
      expect(sql).toContain("source_name =");
      expect(params).toContain("docs");
    }
  });

  it("passes both filters when provided", async () => {
    mockSummaryQueries();
    await getAnalyticsSummary({ tool_type: "search", source: "docs" });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("tool_name LIKE");
    expect(sql).toContain("source_name =");
    expect(params).toContain("search");
    expect(params).toContain("docs");
  });

  it("omits filter clauses when no filter provided", async () => {
    mockSummaryQueries();
    await getAnalyticsSummary({});

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).not.toContain("tool_name LIKE");
    expect(sql).not.toContain("source_name =");
  });
});

describe("getTopQueries LIKE injection hardening", () => {
  it("escapes '%' and '_' wildcards in tool_type", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getTopQueries(7, 50, { tool_type: "_" });

    const [sql, params] = mockQuery.mock.calls[0];
    // The SQL must include an ESCAPE clause or escape the wildcard character
    // in the parameter value. Verify the wildcard is not passed raw — i.e.
    // the param should contain an escaped form ('\_') and the SQL should
    // declare the escape character.
    const toolParam = params.find(
      (p: unknown) => typeof p === "string" && p.includes("_"),
    );
    expect(typeof toolParam).toBe("string");
    expect(toolParam).toBe("\\_");
    // SQL carries an explicit ESCAPE '\' clause so `\_` in the param is treated
    // as a literal `_` rather than a LIKE wildcard.
    expect(sql).toContain("ESCAPE '\\'");
  });

  it("escapes backslash and percent", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getTopQueries(7, 50, { tool_type: "a%b\\c" });

    const [, params] = mockQuery.mock.calls[0];
    const toolParam = params.find(
      (p: unknown) => typeof p === "string" && p.length > 0 && p !== "docs",
    );
    // Each \, %, _ must be prefixed with a backslash
    expect(toolParam).toBe("a\\%b\\\\c");
  });
});

describe("getTopQueries with filters", () => {
  it("includes tool_type filter in WHERE clause", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getTopQueries(7, 50, { tool_type: "explore" });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("tool_name LIKE");
    expect(params).toContain("explore");
  });

  it("includes source filter in WHERE clause", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getTopQueries(7, 50, { source: "ag-ui-docs" });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("source_name =");
    expect(params).toContain("ag-ui-docs");
  });
});

describe("getEmptyQueries with filters", () => {
  it("includes tool_type filter in WHERE clause", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getEmptyQueries(7, 50, { tool_type: "search" });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("tool_name LIKE");
    expect(params).toContain("search");
  });
});

// ---------------------------------------------------------------------------
// Date range filter (from/to) support
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// getAnalyticsSummary honors `days` parameter
//
// Regression: pre-fix, getAnalyticsSummary ignored any caller-supplied window
// and always hardcoded `buildDateWindow(filter, 7, ...)`. The dashboard's
// "Last 30 days" preset sent days=30 to /api/analytics/summary, but the
// handler never parsed it — so stat cards + daily chart showed 7-day data
// while the tables (which DO thread days through) showed 30-day data.
// ---------------------------------------------------------------------------

describe("getAnalyticsSummary honors days window", () => {
  function mockSummaryQueries() {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: 500 }] }) // total
      .mockResolvedValueOnce({
        rows: [{ total: 100, empty: 5, avg_latency: 50 }],
      }) // 7d summary
      .mockResolvedValueOnce({ rows: [] }) // latency rows
      .mockResolvedValueOnce({ rows: [] }) // by source
      .mockResolvedValueOnce({ rows: [] }); // per day
  }

  it("passes the requested `days` value to every windowed subquery", async () => {
    mockSummaryQueries();
    await getAnalyticsSummary({}, 30);

    // Skip mock.calls[0] — the totals query has no date window.
    // With no filter params, days is the first (and only) param on each
    // windowed subquery. Assert directly on params[0] rather than using
    // `.not.toContain(7)`, which could accidentally pass for any other
    // reason a `7` is absent.
    for (let i = 1; i < 5; i++) {
      const [sql, params] = mockQuery.mock.calls[i];
      expect(sql).toContain("NOW() - INTERVAL");
      expect(params[0]).toBe(30);
    }
  });

  it("defaults `days` to 7 when not provided (backward compatible)", async () => {
    mockSummaryQueries();
    await getAnalyticsSummary({});

    for (let i = 1; i < 5; i++) {
      const [, params] = mockQuery.mock.calls[i];
      expect(params).toContain(7);
    }
  });

  it("explicit from/to takes precedence over days", async () => {
    mockSummaryQueries();
    const from = new Date("2026-04-01T00:00:00.000Z");
    const to = new Date("2026-04-20T23:59:59.999Z");
    // Passing a `days` value should be ignored when from/to is set.
    await getAnalyticsSummary({ from, to }, 30);

    for (let i = 1; i < 5; i++) {
      const [sql, params] = mockQuery.mock.calls[i];
      expect(sql).toContain("created_at >=");
      expect(params).toContain(from);
      expect(params).toContain(to);
      expect(params).not.toContain(30);
      expect(params).not.toContain(7);
    }
  });
});

describe("getAnalyticsSummary with from/to range", () => {
  function mockSummaryQueries() {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: 500 }] })
      .mockResolvedValueOnce({
        rows: [{ total: 100, empty: 5, avg_latency: 50 }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
  }

  it("generates created_at >= / <= range clause and passes Date params", async () => {
    mockSummaryQueries();
    const from = new Date("2026-04-01T00:00:00.000Z");
    const to = new Date("2026-04-20T23:59:59.999Z");
    await getAnalyticsSummary({ from, to });

    // Total query has no date window (all time).
    const [totalSql] = mockQuery.mock.calls[0];
    expect(totalSql).not.toContain("created_at");

    // The other four queries should use the explicit range, not NOW() - INTERVAL.
    for (let i = 1; i < 5; i++) {
      const [sql, params] = mockQuery.mock.calls[i];
      expect(sql).toContain("created_at >=");
      expect(sql).toContain("created_at <=");
      expect(sql).not.toContain("NOW() - INTERVAL");
      expect(params).toContain(from);
      expect(params).toContain(to);
    }
  });

  it("falls back to NOW() - INTERVAL window when from/to are not set", async () => {
    mockSummaryQueries();
    await getAnalyticsSummary({});

    for (let i = 1; i < 5; i++) {
      const [sql] = mockQuery.mock.calls[i];
      expect(sql).toContain("NOW() - INTERVAL");
      expect(sql).not.toContain("created_at >=");
    }
  });
});

describe("getTopQueries with from/to range", () => {
  it("combines tool_type filter with explicit range", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const from = new Date("2026-04-01T00:00:00.000Z");
    const to = new Date("2026-04-20T23:59:59.999Z");
    await getTopQueries(7, 50, { tool_type: "search", from, to });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("tool_name LIKE");
    expect(sql).toContain("created_at >=");
    expect(sql).toContain("created_at <=");
    expect(sql).not.toContain("NOW() - INTERVAL");
    expect(params).toContain("search");
    expect(params).toContain(from);
    expect(params).toContain(to);
    // limit still appears at the end
    expect(params).toContain(50);
  });

  it("does not pass `days` when range is active", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const from = new Date("2026-04-01T00:00:00.000Z");
    const to = new Date("2026-04-05T23:59:59.999Z");
    await getTopQueries(30, 10, { from, to });

    const [, params] = mockQuery.mock.calls[0];
    // days=30 should NOT be in params — only range Dates + limit
    expect(params).not.toContain(30);
    expect(params).toContain(10);
  });
});

describe("getEmptyQueries with from/to range", () => {
  it("uses explicit range alongside result_count = 0", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const from = new Date("2026-04-01T00:00:00.000Z");
    const to = new Date("2026-04-20T23:59:59.999Z");
    await getEmptyQueries(7, 50, { from, to });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("result_count = 0");
    expect(sql).toContain("created_at >=");
    expect(sql).toContain("created_at <=");
    expect(params).toContain(from);
    expect(params).toContain(to);
  });
});

describe("getToolCounts with from/to range", () => {
  it("uses explicit range when filter.from/to are set", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const from = new Date("2026-04-01T00:00:00.000Z");
    const to = new Date("2026-04-20T23:59:59.999Z");
    await getToolCounts(7, { from, to });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("created_at >=");
    expect(sql).toContain("created_at <=");
    expect(sql).not.toContain("NOW() - INTERVAL");
    expect(params).toEqual([from, to]);
  });

  it("falls back to days window when no range filter provided", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getToolCounts(14);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("NOW() - INTERVAL");
    expect(params).toEqual([14]);
  });
});

// ---------------------------------------------------------------------------
// getToolCounts respects source filter; intentionally ignores tool_type
// ---------------------------------------------------------------------------

describe("getToolCounts respects source filter", () => {
  it("applies source filter to WHERE clause", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getToolCounts(7, { source: "docs" });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("source_name =");
    expect(params).toContain("docs");
  });

  it("ignores tool_type filter (intentional — would be circular)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getToolCounts(7, { tool_type: "search" });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).not.toContain("tool_name LIKE");
    expect(params).not.toContain("search");
  });

  it("combines source filter with from/to range", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const from = new Date("2026-04-01T00:00:00.000Z");
    const to = new Date("2026-04-20T23:59:59.999Z");
    await getToolCounts(7, { source: "docs", from, to });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("source_name =");
    expect(sql).toContain("created_at >=");
    expect(params).toContain("docs");
    expect(params).toContain(from);
    expect(params).toContain(to);
  });
});

// ---------------------------------------------------------------------------
// avg_result_count null handling
// ---------------------------------------------------------------------------

describe("getTopQueries null avg_result_count", () => {
  it("returns null avg_result_count when SQL returns null (backfilled data)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          query_text: "cat /INDEX.md",
          tool_name: "explore-docs",
          count: 17,
          avg_result_count: null,
          avg_top_score: null,
        },
      ],
    });

    const result = await getTopQueries(7, 50);

    expect(result[0].avg_result_count).toBeNull();
    expect(result[0].avg_top_score).toBeNull();
  });

  it("returns 0 avg_result_count when SQL returns '0' (real zero-result queries)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          query_text: "nonexistent",
          tool_name: "search-docs",
          count: 5,
          avg_result_count: "0",
          avg_top_score: "0.0",
        },
      ],
    });

    const result = await getTopQueries(7, 50);

    expect(result[0].avg_result_count).toBe(0);
    expect(result[0].avg_top_score).toBe(0);
  });
});
