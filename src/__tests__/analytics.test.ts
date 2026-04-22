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
  REDACTED_QUERY_TEXT,
  P95_LATENCY_ROW_CAP,
} from "../db/analytics.js";
import type { QueryLogEntry } from "../db/analytics.js";

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) so any queued `.mockResolvedValueOnce`
  // implementations also clear between tests. A test that queues N mocks for
  // one pool.query() call chain but the code only consumes M (<N) would
  // otherwise leak the remaining N-M implementations into the next test.
  vi.resetAllMocks();
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
    // Assert the whole param array rather than only params[1]; this
    // matches the shape already used by the non-redacted path test
    // above so any future drift (column order, extra fields) shows up
    // the same way on both paths.
    expect(params).toEqual([
      baseEntry.tool_name,
      REDACTED_QUERY_TEXT,
      baseEntry.result_count,
      baseEntry.top_score,
      baseEntry.latency_ms,
      baseEntry.source_name,
      baseEntry.session_id,
    ]);
    // And pin the literal so the constant can never silently drift to a
    // different sentinel that downstream reads wouldn't recognize.
    expect(REDACTED_QUERY_TEXT).toBe("<redacted>");
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
  it("swallows DB errors so telemetry failures never break tool callers", async () => {
    // Telemetry is best-effort. A failing pool.query must not propagate to
    // the caller — otherwise an analytics outage would take down every
    // tool call. We log with [analytics] prefix and resolve normally.
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockQuery.mockRejectedValueOnce(new Error("connection refused"));
    await expect(
      logQuery({
        tool_name: "search-docs",
        query_text: "test",
        result_count: 0,
        top_score: null,
        latency_ms: 10,
        source_name: "docs",
        session_id: null,
      }),
    ).resolves.toBeUndefined();
    // Must include the [analytics] prefix and context (tool_name, source_name).
    const logged = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(logged).toContain("[analytics]");
    expect(logged).toContain("search-docs");
    expect(logged).toContain("docs");
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// getAnalyticsSummary
// ---------------------------------------------------------------------------

describe("getAnalyticsSummary", () => {
  it("returns aggregated summary data", async () => {
    // Mock order: total, summaryWindow, latency rows, bySource, perDay
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: 1000 }] }) // total
      .mockResolvedValueOnce({
        rows: [{ total: 200, empty: 10, avg_latency: 45 }],
      }) // windowed summary
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
      }) // per day
      .mockResolvedValueOnce({ rows: [{ earliest_day: "2026-04-10" }] }); // earliest day

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
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ earliest_day: null }] });

    const result = await getAnalyticsSummary();

    expect(result.total_queries).toBe(0);
    expect(result.empty_result_rate_window).toBe(0);
    expect(result.p95_latency_ms_window).toBe(0);
    expect(result.queries_by_source).toEqual([]);
    expect(result.queries_per_day_window).toEqual([]);
  });

  it("per-day SQL uses generate_series + LEFT JOIN so zero-count days stay in the result", async () => {
    // Regression: pre-fix, the per-day subquery was a plain GROUP BY over
    // date_trunc('day', created_at), so days with zero matching rows were
    // silently dropped. That caused the "Last 14 days" chart to render
    // fewer bars than the window length on sparse data. The gap-fill
    // rewrite LEFT JOINs against generate_series so every day in the
    // window gets a row (with count=0 when empty).
    //
    // We identify the per-day call by SQL content ("GROUP BY day" on the
    // inner aggregate) rather than by hard-coded call index so that
    // reordering other subqueries in getAnalyticsSummary can't silently
    // invalidate this assertion.
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: 0 }] })
      .mockResolvedValueOnce({
        rows: [{ total: 0, empty: 0, avg_latency: 0 }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await getAnalyticsSummary({}, 14);

    const perDayCall = mockQuery.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        /GROUP BY day/i.test(call[0]) &&
        !/tool_name/i.test(call[0]), // not getTopQueries-style grouping
    );
    expect(perDayCall, "per-day query not found").toBeDefined();
    const perDaySql = perDayCall![0] as string;
    expect(perDaySql).toMatch(/generate_series/i);
    expect(perDaySql).toMatch(/LEFT JOIN/i);
  });
});

// ---------------------------------------------------------------------------
// earliest_query_day — data-availability probe for the UI
//
// The dashboard surfaces a "showing N days of data" subtext whenever the
// requested window exceeds the actual query_log depth. To compute N the UI
// needs the earliest row's date regardless of the current filter — picking a
// 90-day window shouldn't hide the fact that data only stretches back 9 days.
// The field is therefore sourced from an UNFILTERED MIN(created_at) query and
// lives alongside the windowed aggregates on the same summary response.
// ---------------------------------------------------------------------------

describe("getAnalyticsSummary earliest_query_day", () => {
  it("returns the earliest day from query_log as a YYYY-MM-DD string", async () => {
    // 5 existing subqueries + 1 new earliest-day subquery (6th call).
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: 1000 }] }) // total
      .mockResolvedValueOnce({
        rows: [{ total: 200, empty: 10, avg_latency: 45 }],
      }) // windowed summary
      .mockResolvedValueOnce({ rows: [] }) // latency rows
      .mockResolvedValueOnce({ rows: [] }) // by source
      .mockResolvedValueOnce({ rows: [] }) // per day
      .mockResolvedValueOnce({ rows: [{ earliest_day: "2026-04-12" }] }); // earliest day

    const result = await getAnalyticsSummary();

    expect(result.earliest_query_day).toBe("2026-04-12");
  });

  it("returns null when query_log is empty", async () => {
    // An empty query_log makes MIN(created_at) return NULL — surface that as
    // `null` on the response so the UI can skip the label entirely rather
    // than rendering "showing NaN days of data".
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: 0 }] })
      .mockResolvedValueOnce({
        rows: [{ total: 0, empty: 0, avg_latency: 0 }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ earliest_day: null }] });

    const result = await getAnalyticsSummary();

    expect(result.earliest_query_day).toBeNull();
  });

  it("queries the unfiltered earliest created_at (no filter/window applied)", async () => {
    // The label describes data availability in absolute terms — picking a
    // tool_type, source, or narrow from/to window must NOT change the reported
    // earliest day. Verify the SQL for the earliest-day subquery has no WHERE
    // clause and no filter params are bound to it.
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: 0 }] })
      .mockResolvedValueOnce({
        rows: [{ total: 0, empty: 0, avg_latency: 0 }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ earliest_day: "2026-03-01" }] });

    await getAnalyticsSummary(
      { tool_type: "search", source: "docs" },
      30,
    );

    // Index 5 is the new earliest-day subquery (0=total, 1=summary, 2=latency,
    // 3=by-source, 4=per-day, 5=earliest-day).
    const [sql, params] = mockQuery.mock.calls[5];
    expect(sql).toMatch(/min\(created_at/i);
    expect(sql).toMatch(/FROM query_log/i);
    expect(sql).not.toMatch(/WHERE/i);
    // No filter or window params bound to the earliest-day query.
    expect(params ?? []).toEqual([]);
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
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ earliest_day: null }] });

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
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ earliest_day: null }] });

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
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ earliest_day: null }] });

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

  it("excludes redacted queries via bound REDACTED_QUERY_TEXT param", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getTopQueries();

    const [sql, params] = mockQuery.mock.calls[0];
    // The clause binds the sentinel instead of inlining '<redacted>' so
    // REDACTED_QUERY_TEXT is the single source of truth for the value.
    expect(sql).toMatch(/query_text != \$\d+/);
    expect(sql).not.toContain("'<redacted>'");
    expect(params).toContain(REDACTED_QUERY_TEXT);
  });
});

// ---------------------------------------------------------------------------
// getTopQueries edge cases
// ---------------------------------------------------------------------------

// The server layer (parseDaysOrError / parseLimitOrError in src/server.ts)
// already rejects days=0 and limit=0 with a 400 before the request ever
// reaches the DB. These tests exist as defense-in-depth: they lock in the
// DB layer's behavior today so a future refactor that moves or removes
// the server-layer check can't silently introduce a wipe-the-table bug.
describe("getTopQueries edge cases", () => {
  it("DB layer accepts days=0 without throwing (server layer enforces > 0; this locks down regression if that check ever moves)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getTopQueries(0, 50);
    expect(result).toEqual([]);
    const [, params] = mockQuery.mock.calls[0];
    expect(params[0]).toBe(0);
  });

  it("DB layer accepts limit=0 without throwing (server layer enforces > 0; this locks down regression if that check ever moves)", async () => {
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

  it("excludes redacted queries via bound REDACTED_QUERY_TEXT param", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getEmptyQueries();

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/query_text != \$\d+/);
    expect(sql).not.toContain("'<redacted>'");
    expect(params).toContain(REDACTED_QUERY_TEXT);
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

  it("uses <= boundary so retention-edge rows aren't leaked", async () => {
    // The rolling-window reads use `created_at > NOW() - INTERVAL`. If
    // cleanup used a strict `<`, rows sitting exactly at the retention
    // edge would be visible to reads forever but never get cleaned up.
    // `<=` closes the partition so retention-edge rows are removed.
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    await cleanupOldQueryLogs(90);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("created_at <= NOW()");
  });
});

// ---------------------------------------------------------------------------
// cleanupOldQueryLogs error handling
// ---------------------------------------------------------------------------

describe("cleanupOldQueryLogs error handling", () => {
  it("propagates DB error to caller (after logging)", async () => {
    // Scheduler catches the throw; we just verify it still propagates
    // rather than being swallowed like logQuery. Suppress the error log
    // so test output stays clean.
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockQuery.mockRejectedValueOnce(new Error("disk full"));
    await expect(cleanupOldQueryLogs(90)).rejects.toThrow("disk full");
    const logged = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(logged).toContain("[analytics]");
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// cleanupOldQueryLogs input validation
//
// Regression guard: cleanupOldQueryLogs(0) would translate to
// `created_at <= NOW() - 0 days` and wipe the entire table. Same risk with
// negative values. Both must reject hard (not silently no-op) so a
// misconfigured retention surfaces in the scheduler's .catch() handler
// instead of being swallowed on every nightly run.
// ---------------------------------------------------------------------------

describe("cleanupOldQueryLogs input validation", () => {
  it("retentionDays=0 throws and does not query the DB", async () => {
    await expect(cleanupOldQueryLogs(0)).rejects.toThrow(
      /invalid retentionDays=0/,
    );
    expect(mockQuery.mock.calls).toHaveLength(0);
  });

  it("retentionDays=-1 throws and does not query the DB", async () => {
    await expect(cleanupOldQueryLogs(-1)).rejects.toThrow(
      /invalid retentionDays=-1/,
    );
    expect(mockQuery.mock.calls).toHaveLength(0);
  });

  it("retentionDays=NaN throws and does not query the DB", async () => {
    await expect(cleanupOldQueryLogs(NaN)).rejects.toThrow(
      /invalid retentionDays=NaN/,
    );
    expect(mockQuery.mock.calls).toHaveLength(0);
  });

  it("retentionDays=Infinity throws and does not query the DB", async () => {
    // Number.isFinite(Infinity) is false, so the guard rejects it just like
    // NaN. Locking it in explicitly because `Infinity` is the other
    // non-finite value that can slip through a naive `value > 0` check.
    await expect(cleanupOldQueryLogs(Infinity)).rejects.toThrow(
      /invalid retentionDays=Infinity/,
    );
    expect(mockQuery.mock.calls).toHaveLength(0);
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

// ---------------------------------------------------------------------------
// Windowed-aggregate invariant: every windowed query must exclude backfilled
// rows (latency_ms < 0) so the numerator/denominator line up across the
// dashboard. The all-time `total_queries` count is the intentional exception
// — it is inclusive of backfilled rows so the "Total Queries" card shows the
// real row count.
// ---------------------------------------------------------------------------

describe("windowed aggregates exclude backfilled rows (latency_ms >= 0)", () => {
  function mockSummaryQueries() {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: 500 }] })
      .mockResolvedValueOnce({
        rows: [{ total: 100, empty: 5, avg_latency: 50 }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ earliest_day: null }] }); // earliest day
  }

  it("getAnalyticsSummary: all four windowed subqueries filter latency_ms >= 0", async () => {
    mockSummaryQueries();
    await getAnalyticsSummary({});

    // Indexes 1..4 are the windowed subqueries: summary counts, latency
    // rows, by-source, per-day. Each must carry the backfill filter.
    for (let i = 1; i <= 4; i++) {
      const [sql] = mockQuery.mock.calls[i];
      expect(sql).toContain("latency_ms >= 0");
    }
  });

  it("getAnalyticsSummary: total_queries (index 0) intentionally does NOT filter latency", async () => {
    // The all-time total count is inclusive by design: the "Total Queries"
    // card reflects every row, including backfilled historical rows. Only
    // the windowed cards need the backfill exclusion.
    mockSummaryQueries();
    await getAnalyticsSummary({});

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).not.toContain("latency_ms >= 0");
  });

  it("getTopQueries filters latency_ms >= 0", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getTopQueries(7, 50);

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("latency_ms >= 0");
  });

  it("getEmptyQueries filters latency_ms >= 0", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getEmptyQueries(7, 50);

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("latency_ms >= 0");
  });

  it("getToolCounts filters latency_ms >= 0", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getToolCounts(7);

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("latency_ms >= 0");
  });
});

describe("getAnalyticsSummary p95 latency row cap", () => {
  function mockSummaryQueries() {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: 500 }] })
      .mockResolvedValueOnce({
        rows: [{ total: 100, empty: 5, avg_latency: 50 }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ earliest_day: null }] }); // earliest day
  }

  it("emits ORDER BY random() LIMIT on the latency subquery and binds P95_LATENCY_ROW_CAP", async () => {
    // PGlite can't percentile_cont; we sort in JS. "All time" (days=99999)
    // on a busy install would otherwise load every latency row into memory.
    // The LIMIT caps the sample so memory stays bounded; the cap value is
    // bound rather than inlined so there's one source of truth.
    //
    // Random sampling matters: ORDER BY latency_ms LIMIT N would take the
    // smallest N latencies, systematically under-reporting p95. ORDER BY
    // random() gives an unbiased sample so the p95 estimate stays accurate
    // even when the cap is hit.
    mockSummaryQueries();
    await getAnalyticsSummary({});

    // Index 2 is the latency query (0=total, 1=summary, 2=latency, 3=by-source, 4=per-day).
    const [sql, params] = mockQuery.mock.calls[2];
    expect(sql).toMatch(/ORDER BY random\(\)/);
    expect(sql).toMatch(/LIMIT \$\d+/);
    // The query fetches cap+1 rows (not cap) to distinguish "exactly the
    // cap" (all rows returned, no sampling) from "more than the cap" (true
    // sampling) — a strict LIMIT $cap misreports the exact-match case.
    expect(params).toContain(P95_LATENCY_ROW_CAP + 1);
  });

  it("logs a warn when the latency sample hits the cap (sampled p95)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Return P95_LATENCY_ROW_CAP + 1 rows so the overflow branch trips —
    // exactly cap rows means "all rows returned" (not sampled), so the
    // cap-hit branch only fires at cap+1.
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: 500 }] })
      .mockResolvedValueOnce({
        rows: [{ total: 100, empty: 5, avg_latency: 50 }],
      })
      .mockResolvedValueOnce({
        rows: Array.from({ length: P95_LATENCY_ROW_CAP + 1 }, (_, i) => ({
          latency_ms: i + 1,
        })),
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ earliest_day: null }] });
    const result = await getAnalyticsSummary({});
    const logged = warnSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(logged).toContain("[analytics]");
    expect(logged).toContain("capped");
    // The cap-hit branch must also surface `p95_latency_sampled: true` on
    // the response so the UI can render a "(sampled)" badge instead of
    // implying the value is exact.
    expect(result.p95_latency_sampled).toBe(true);
    warnSpy.mockRestore();
  });

  it("omits p95_latency_sampled when the cap is not hit", async () => {
    // Only a handful of latency rows — well below the cap — so the flag
    // must be absent (treat absence as "exact" to stay backwards-compatible
    // with older UI builds).
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: 500 }] })
      .mockResolvedValueOnce({
        rows: [{ total: 100, empty: 5, avg_latency: 50 }],
      })
      .mockResolvedValueOnce({
        rows: [{ latency_ms: 10 }, { latency_ms: 20 }, { latency_ms: 30 }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ earliest_day: null }] });
    const result = await getAnalyticsSummary({});
    expect(result.p95_latency_sampled).toBeUndefined();
  });
});

describe("getAnalyticsSummary per-day excludes redacted rows", () => {
  function mockSummaryQueries() {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: 500 }] })
      .mockResolvedValueOnce({
        rows: [{ total: 100, empty: 5, avg_latency: 50 }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ earliest_day: null }] }); // earliest day
  }

  it("per-day subquery filters query_text != REDACTED_QUERY_TEXT (consistency with top/empty)", async () => {
    // The daily-chart bars should count the same population surfaced by the
    // top-queries and empty-queries tables below it. Pre-fix, per-day
    // included redacted rows while those tables filtered them out, so the
    // chart total > table total for any window with redacted traffic.
    mockSummaryQueries();
    await getAnalyticsSummary({});

    // Index 4 is the per-day subquery.
    const [sql, params] = mockQuery.mock.calls[4];
    expect(sql).toMatch(/query_text != \$\d+/);
    expect(params).toContain(REDACTED_QUERY_TEXT);
  });

  it("latency subquery filters query_text != REDACTED_QUERY_TEXT (p95/avg population alignment)", async () => {
    // Pre-fix: avg_latency (summary subquery) excluded redacted rows but
    // p95 (latency subquery) did not. That meant the two latency cards were
    // computed over different populations, so p95 could be lower than avg
    // whenever redacted traffic carried unusually high latency (or vice
    // versa). Aligning both on the same population makes the cards
    // directly comparable.
    mockSummaryQueries();
    await getAnalyticsSummary({});

    // Index 2 is the latency subquery (0=total, 1=summary, 2=latency).
    const [sql, params] = mockQuery.mock.calls[2];
    expect(sql).toMatch(/query_text != \$\d+/);
    expect(params).toContain(REDACTED_QUERY_TEXT);
  });
});

describe("getAnalyticsSummary with filters", () => {
  function mockSummaryQueries() {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: 500 }] }) // total
      .mockResolvedValueOnce({
        rows: [{ total: 100, empty: 5, avg_latency: 50 }],
      }) // windowed summary
      .mockResolvedValueOnce({ rows: [] }) // latency rows
      .mockResolvedValueOnce({ rows: [] }) // by source
      .mockResolvedValueOnce({ rows: [] }) // per day
      .mockResolvedValueOnce({ rows: [{ earliest_day: null }] }); // earliest day
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
    // The SQL must include an ESCAPE clause AND the wildcard in the
    // parameter must be prefixed with the pipe escape character. Assert
    // on the exact expected param rather than searching by "any string
    // with an underscore" — the search pattern misfires the moment
    // another underscore-containing string is added to the call
    // (sentinel constants, filter literals, etc).
    expect(params).toContain("|_");
    // SQL carries an explicit ESCAPE '|' clause so `|_` in the param is
    // treated as a literal `_` rather than a LIKE wildcard. We use `|`
    // rather than `\` because Postgres with standard_conforming_strings=on
    // (the default) treats '\\' as two characters, which ESCAPE rejects.
    expect(sql).toContain("ESCAPE '|'");
  });

  it("escapes pipe and percent", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getTopQueries(7, 50, { tool_type: "a%b|c" });

    const [, params] = mockQuery.mock.calls[0];
    // Each |, %, _ must be prefixed with a literal `|`. Assert on the
    // exact expected param rather than filtering params by "not 'docs'"
    // — the filter predicate was a leftover from a copy-paste and
    // nothing in this test sets source="docs" anyway.
    expect(params).toContain("a|%b||c");
  });

  it("escapes bare '|' wildcard in tool_type", async () => {
    // '|' is the ESCAPE character itself — a bare pipe in the filter value
    // must be escaped (`||`) so Postgres treats it as a literal pipe in the
    // LIKE pattern rather than the start of a 2-char escape sequence. This
    // is the "escape the escape" case; the previous tests cover %/_/|
    // wildcards but don't individually pin a bare pipe.
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getTopQueries(7, 50, { tool_type: "a|b" });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("ESCAPE '|'");
    expect(params).toContain("a||b");
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
      }) // windowed summary
      .mockResolvedValueOnce({ rows: [] }) // latency rows
      .mockResolvedValueOnce({ rows: [] }) // by source
      .mockResolvedValueOnce({ rows: [] }) // per day
      .mockResolvedValueOnce({ rows: [{ earliest_day: null }] }); // earliest day
  }

  it("passes the requested `days` value to every windowed subquery", async () => {
    mockSummaryQueries();
    await getAnalyticsSummary({}, 30);

    // Skip mock.calls[0] — the totals query has no date window.
    // All windowed subqueries (summary, latency, by-source, per-day) now
    // share the same UTC-calendar-day rolling shape:
    //   created_at >= (NOW() AT TIME ZONE 'UTC')::date - (LEAST($N, 366) - 1)
    // The per-day query additionally wraps its inner WHERE in a
    // generate_series + LEFT JOIN.
    // With no filter params, days is the first (and only) param on each
    // windowed subquery. Assert directly on params[0] rather than using
    // `.not.toContain(7)`, which could accidentally pass for any other
    // reason a `7` is absent.
    for (let i = 1; i < 4; i++) {
      const [sql, params] = mockQuery.mock.calls[i];
      expect(sql).toContain("(NOW() AT TIME ZONE 'UTC')::date");
      expect(sql).toContain("LEAST");
      expect(sql).not.toContain("NOW() - INTERVAL");
      expect(params[0]).toBe(30);
    }
    // Per-day subquery: still receives `days=30`, now in BOTH the outer
    // series AND the inner WHERE (same UTC-midnight LEAST expression).
    const [perDaySql, perDayParams] = mockQuery.mock.calls[4];
    expect(perDaySql).toContain("generate_series");
    expect(perDaySql).toContain("LEAST");
    expect(perDayParams[0]).toBe(30);
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
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ earliest_day: null }] }); // earliest day
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

  it("falls back to UTC-calendar-day rolling window when from/to are not set", async () => {
    mockSummaryQueries();
    await getAnalyticsSummary({});

    // Indexes 1..3 (summary, latency, by-source) share buildDateWindow's
    // UTC-calendar-day rolling window. Old shape (`NOW() - INTERVAL`) is
    // gone: it drifted from the per-day series bounds whenever NOW() wasn't
    // exactly UTC midnight, causing sum(queries_per_day_window) to under-
    // count total_queries_window by up to traffic_rate * hours_into_UTC_day.
    for (let i = 1; i < 4; i++) {
      const [sql] = mockQuery.mock.calls[i];
      expect(sql).toContain("created_at >=");
      expect(sql).toContain("(NOW() AT TIME ZONE 'UTC')::date");
      expect(sql).toContain("LEAST");
      expect(sql).not.toContain("NOW() - INTERVAL");
    }
    // Index 4 (per-day) uses the gap-fill helper: generate_series over
    // UTC-midnight calendar days for the outer series, plus the exact
    // buildDateWindow WHERE (now also UTC-calendar-day bounded) reused
    // verbatim on the inner aggregate. The inner reuse is what keeps
    // sum-of-bars EXACTLY aligned with total_queries_window.
    const [perDaySql] = mockQuery.mock.calls[4];
    expect(perDaySql).toContain("generate_series");
    expect(perDaySql).toContain("(NOW() AT TIME ZONE 'UTC')::date");
    expect(perDaySql).toContain("LEAST");
    expect(perDaySql).not.toContain("NOW() - INTERVAL");
    // Inner grouping must be UTC-normalized so bars align with the UTC
    // series regardless of server TimeZone GUC.
    expect(perDaySql).toContain("AT TIME ZONE 'UTC'");
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

  it("falls back to UTC-calendar-day rolling window when no range filter provided", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getToolCounts(14);

    const [sql, params] = mockQuery.mock.calls[0];
    // Rolling mode is now UTC-calendar-day bounded so all windowed
    // aggregates (getToolCounts included) align with the per-day gap-fill
    // series. Old `NOW() - INTERVAL` shape is gone.
    expect(sql).toContain("created_at >=");
    expect(sql).toContain("(NOW() AT TIME ZONE 'UTC')::date");
    expect(sql).toContain("LEAST");
    expect(sql).not.toContain("NOW() - INTERVAL");
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

  it("honors source and silently drops tool_type when both are supplied", async () => {
    // Combination regression: the two filter branches ('source' applied,
    // 'tool_type' dropped) are each exercised individually above, but the
    // shared filter-stripping path is only hit when both are set at once.
    // A future refactor that e.g. re-introduces tool_type into the WHERE
    // clause would need to trip this test rather than either of the
    // single-filter cases.
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getToolCounts(7, { tool_type: "search", source: "docs" });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).not.toContain("tool_name LIKE");
    expect(sql).toContain("source_name =");
    expect(params).toContain("docs");
    expect(params).not.toContain("search");
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
