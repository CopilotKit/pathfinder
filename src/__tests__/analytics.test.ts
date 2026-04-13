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
    expect(result.total_queries_7d).toBe(200);
    expect(result.empty_result_count_7d).toBe(10);
    expect(result.empty_result_rate_7d).toBeCloseTo(0.05);
    expect(result.avg_latency_ms_7d).toBe(45);
    // p95 of [1..200] sorted: index = floor(200 * 0.95) = 190, value = 191
    expect(result.p95_latency_ms_7d).toBe(191);
    expect(result.queries_by_source).toEqual([
      { source_name: "docs", count: 150 },
    ]);
    expect(result.queries_per_day_7d).toHaveLength(2);
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
    expect(result.empty_result_rate_7d).toBe(0);
    expect(result.p95_latency_ms_7d).toBe(0);
    expect(result.queries_by_source).toEqual([]);
    expect(result.queries_per_day_7d).toEqual([]);
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
    expect(result.p95_latency_ms_7d).toBe(42);
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
    expect(result.p95_latency_ms_7d).toBe(50);
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
    expect(result.p95_latency_ms_7d).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// getTopQueries
// ---------------------------------------------------------------------------

describe("getTopQueries", () => {
  it("returns top queries with frequency and avg stats", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          query_text: "install guide",
          count: 42,
          avg_result_count: "3.5",
          avg_top_score: "0.88",
        },
        {
          query_text: "api reference",
          count: 30,
          avg_result_count: "5.0",
          avg_top_score: null,
        },
      ],
    });

    const result = await getTopQueries(7, 50);

    expect(result).toHaveLength(2);
    expect(result[0].query_text).toBe("install guide");
    expect(result[0].count).toBe(42);
    expect(result[0].avg_result_count).toBeCloseTo(3.5);
    expect(result[0].avg_top_score).toBeCloseTo(0.88);
    expect(result[1].avg_top_score).toBeNull();
  });

  it("passes days and limit to query params", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getTopQueries(30, 10);

    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual([30, 10]);
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
