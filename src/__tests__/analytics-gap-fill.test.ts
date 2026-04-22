import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { __setPoolForTesting, __resetPoolForTesting } from "../db/client.js";
import { getAnalyticsSummary } from "../db/analytics.js";
import { generatePostSchemaMigration } from "../db/schema.js";

// -----------------------------------------------------------------------------
// Integration tests for the per-day gap-fill + 366-day cap.
//
// These tests run the real analytics SQL against an in-process PGlite instance
// rather than a hand-rolled pool mock so they exercise generate_series,
// LEFT JOIN, date coercion, and window bounds end-to-end. We install a
// pg.Pool-shaped wrapper around PGlite via __setPoolForTesting so that
// getAnalyticsSummary's internal getPool() lookup returns it.
//
// Schema source of truth: generatePostSchemaMigration() in src/db/schema.ts.
// That function returns DDL for both `chunks` (requires the pgvector
// extension) and `query_log`. For gap-fill we only need query_log, so we
// slice out just the "-- Analytics: query_log" section — avoids pulling in
// the pgvector extension setup that initializePGlite performs.
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

/**
 * Duck-typed pg.Pool around PGlite. Only implements the methods
 * analytics.ts actually calls (query). connect/end are stubs for safety.
 */
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

/** ISO "YYYY-MM-DD" for a UTC day offset from today. */
function utcDayString(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/** A timestamp inside the given UTC day (noon UTC, avoids TZ edge ambiguity). */
function utcNoonOfDay(offsetDays: number): Date {
  const day = utcDayString(offsetDays);
  return new Date(`${day}T12:00:00.000Z`);
}

async function seedQueryLog(
  db: PGlite,
  rows: Array<{ created_at: Date; latency_ms?: number; query_text?: string }>,
) {
  for (const row of rows) {
    await db.query(
      `INSERT INTO query_log
        (tool_name, query_text, result_count, top_score, latency_ms,
         source_name, session_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        "search-docs",
        row.query_text ?? "q",
        5,
        0.9,
        row.latency_ms ?? 42,
        "docs",
        "sess-1",
        row.created_at,
      ],
    );
  }
}

describe("analytics per-day gap-fill (PGlite integration)", () => {
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

  it("rolling: 14-day window on sparse data emits 14 ascending rows, non-zero only on seeded days", async () => {
    // Seed 3 of the 14 days. Days -13 .. 0 (today) should all appear in the
    // result; the 11 unseeded days must be zero-count but still present.
    const seeded = new Set([0, -5, -10]);
    await seedQueryLog(db, [
      { created_at: utcNoonOfDay(0) },
      { created_at: utcNoonOfDay(-5) },
      { created_at: utcNoonOfDay(-10) },
    ]);

    const result = await getAnalyticsSummary({}, 14);

    expect(result.queries_per_day_window).toHaveLength(14);

    const days = result.queries_per_day_window.map((r) => r.day);
    // Ascending order
    expect([...days].sort()).toEqual(days);
    // All 14 expected days present
    const expectedDays = Array.from({ length: 14 }, (_, i) =>
      utcDayString(i - 13),
    );
    expect(days).toEqual(expectedDays);

    // Only seeded days non-zero.
    for (const entry of result.queries_per_day_window) {
      const offset = Math.round(
        (Date.parse(entry.day + "T00:00:00Z") -
          Date.parse(utcDayString(0) + "T00:00:00Z")) /
          86_400_000,
      );
      if (seeded.has(offset)) {
        expect(entry.count).toBeGreaterThan(0);
      } else {
        expect(entry.count).toBe(0);
      }
    }
  });

  it("range: from/to spanning 10 days emits 10 rows on sparse data", async () => {
    const to = utcNoonOfDay(-2);
    const from = utcNoonOfDay(-11); // 10-day inclusive span: -11..-2
    // Seed 2 of the 10 days inside the range.
    await seedQueryLog(db, [
      { created_at: utcNoonOfDay(-3) },
      { created_at: utcNoonOfDay(-8) },
    ]);
    // Seed 1 outside the range to make sure the outer gap-fill ignores it.
    await seedQueryLog(db, [{ created_at: utcNoonOfDay(-15) }]);

    const result = await getAnalyticsSummary({ from, to }, 7);

    expect(result.queries_per_day_window).toHaveLength(10);
    const days = result.queries_per_day_window.map((r) => r.day);
    expect([...days].sort()).toEqual(days);
    // Range boundaries present
    expect(days[0]).toBe(utcDayString(-11));
    expect(days[days.length - 1]).toBe(utcDayString(-2));
    // Non-zero counts exactly on seeded days within the range
    const nonZero = result.queries_per_day_window
      .filter((r) => r.count > 0)
      .map((r) => r.day)
      .sort();
    expect(nonZero).toEqual([utcDayString(-8), utcDayString(-3)].sort());
  });

  it("sum-equals-total invariant: rolling per-day sum matches total_queries_window and excludes out-of-window rows", async () => {
    // Seed rows across the 14-day boundary. The today-20 row is outside
    // the window and must NOT contribute to either the sum-of-bars or
    // total_queries_window — this catches drift between the gap-fill
    // series bounds and the inner WHERE clause.
    await seedQueryLog(db, [
      { created_at: utcNoonOfDay(0) },
      { created_at: utcNoonOfDay(-3) },
      { created_at: utcNoonOfDay(-7) },
      { created_at: utcNoonOfDay(-13) },
      { created_at: utcNoonOfDay(-20) }, // outside 14-day window
    ]);

    const result = await getAnalyticsSummary({}, 14);

    // Gap-fill: bar count == window length, not the count of seeded days.
    expect(result.queries_per_day_window).toHaveLength(14);

    const sumOfBars = result.queries_per_day_window.reduce(
      (acc, r) => acc + r.count,
      0,
    );
    expect(sumOfBars).toBe(result.total_queries_window);
    // Exactly four rows fall inside the 14-day window.
    expect(sumOfBars).toBe(4);
  });

  it("cap: days=1000 clamps both queries_per_day_window AND total_queries_window to the shared 366-day rolling cap", async () => {
    // Seed two rows: one ~200 days back, one ~900 days back. Rolling-window
    // cap is symmetric across every windowed aggregate (summary totals,
    // latency, by-source, per-day, top/empty, tool counts) — they all share
    // buildDateWindow's ROLLING_WINDOW_CAP_DAYS. Previously only the
    // per-day series was capped, so total_queries_window saw both rows
    // while bars only showed one — a confusing inconsistency. Now both
    // sides clamp at 366 and the sum-invariant holds across the cap too.
    await seedQueryLog(db, [
      { created_at: utcNoonOfDay(-200) },
      { created_at: utcNoonOfDay(-900) },
    ]);

    const result = await getAnalyticsSummary({}, 1000);

    expect(result.queries_per_day_window).toHaveLength(366);
    // total_queries_window is now also capped — the 900-day row is outside
    // the 366-day rolling window and should not count toward it.
    expect(result.total_queries_window).toBe(1);

    // The most-recent day in the bar series is today; the oldest is today-365.
    const days = result.queries_per_day_window.map((r) => r.day);
    expect(days[0]).toBe(utcDayString(-365));
    expect(days[days.length - 1]).toBe(utcDayString(0));

    // The -200 row is inside both windows → bar count is 1; the -900 row is
    // outside the 366 cap so does not appear as a bar.
    const sumOfBars = days.reduce(
      (acc, _, i) => acc + result.queries_per_day_window[i].count,
      0,
    );
    expect(sumOfBars).toBe(1);
    // Sum-invariant holds in the cap regime too now that the cap is shared.
    expect(sumOfBars).toBe(result.total_queries_window);
  });

  // Regression guard for the range-mode sum-invariant. The rolling test
  // above already exercises this invariant on an aligned rolling window; the
  // interesting case is a user-chosen range with non-midnight from/to where
  // the outer series runs over `$from::date..$to::date` but the inner WHERE
  // uses full-timestamp comparison. Rows that straddle the range boundaries
  // at sub-day resolution must be accepted/rejected by BOTH sides in lock
  // step so sum-of-bars equals total_queries_window exactly.
  it("range sum-invariant: non-midnight from/to with straddle rows preserves sum-of-bars == total_queries_window", async () => {
    const from = new Date(`${utcDayString(-5)}T15:00:00.000Z`);
    const to = new Date(`${utcDayString(-2)}T18:00:00.000Z`);

    await seedQueryLog(db, [
      // Before `from` by 1 minute → must be excluded.
      {
        created_at: new Date(from.getTime() - 60_000),
        query_text: "before-from",
      },
      // After `from` by 1 minute → must be included.
      {
        created_at: new Date(from.getTime() + 60_000),
        query_text: "after-from",
      },
      // Before `to` by 1 minute → must be included.
      {
        created_at: new Date(to.getTime() - 60_000),
        query_text: "before-to",
      },
      // After `to` by 1 minute → must be excluded.
      {
        created_at: new Date(to.getTime() + 60_000),
        query_text: "after-to",
      },
    ]);

    const result = await getAnalyticsSummary({ from, to }, 7);

    // Inclusive day span: from::date == today-5, to::date == today-2 → 4 days.
    expect(result.queries_per_day_window).toHaveLength(4);
    for (const entry of result.queries_per_day_window) {
      expect(typeof entry.count).toBe("number");
      expect(Number.isFinite(entry.count)).toBe(true);
    }

    const sumOfBars = result.queries_per_day_window.reduce(
      (acc, r) => acc + r.count,
      0,
    );
    expect(result.total_queries_window).toBe(2);
    expect(sumOfBars).toBe(result.total_queries_window);
  });

  // Regression guard for the rolling sum-invariant drift that existed when
  // buildDateWindow used a NOW()-relative INTERVAL window but the per-day
  // series used UTC-midnight calendar days. At any NOW() != UTC midnight,
  // the inner WHERE would admit rows on partial UTC day `today-N` that the
  // outer UTC-midnight series did not emit, so the LEFT JOIN silently
  // dropped them; total_queries_window still counted them. After the fix,
  // buildDateWindow rolling mode also uses UTC-calendar-day bounds, so
  // sum-of-bars == total_queries_window EXACTLY for any seed-row timestamp.
  it("rolling UTC-day alignment: late-UTC-day row on today-N is excluded from both summary and bars", async () => {
    // Pre-fix drift scenario: with the old `created_at > NOW() - INTERVAL
    // '1 day' * 14` rolling window, a row at 14:00 UTC on today-14 passed
    // the inner WHERE for any NOW() earlier than 14:00 UTC (which is most
    // of the day), so `total_queries_window` counted it. But the per-day
    // series emitted UTC-midnight days today-13..today; the inner aggregate
    // bucketed the row on today-14, and the LEFT JOIN silently dropped it.
    // Result: `sum(queries_per_day_window) < total_queries_window` — the
    // sum-invariant violation this fix closes.
    //
    // Post-fix, buildDateWindow rolling mode also uses UTC-calendar-day
    // bounds (`created_at >= (NOW() AT TIME ZONE 'UTC')::date - 13`), so
    // the row is OUTSIDE both the summary WHERE AND the series; sum and
    // total both land at 0 and the invariant holds exactly.
    const driftingRow = new Date(`${utcDayString(-14)}T14:00:00.000Z`);
    await seedQueryLog(db, [{ created_at: driftingRow }]);

    const result = await getAnalyticsSummary({}, 14);

    expect(result.queries_per_day_window).toHaveLength(14);
    expect(result.total_queries_window).toBe(0);
    const sumOfBars = result.queries_per_day_window.reduce(
      (acc, r) => acc + r.count,
      0,
    );
    expect(sumOfBars).toBe(0);
    expect(sumOfBars).toBe(result.total_queries_window);
  });

  // Regression guard for range-mode series TZ coercion. When a session's
  // TimeZone GUC is non-UTC, `$from::date` coerces a timestamptz to the
  // session-local day, which can drop the series one day earlier than the
  // caller intended. The fix wraps the cast in `AT TIME ZONE 'UTC'` so the
  // series stays aligned with the UTC-normalized inner aggregate.
  it("range mode non-UTC session TZ: series stays on UTC calendar days", async () => {
    // Fixed range at UTC midnight so the regression is easy to see:
    // from = 2026-04-15 00:00 UTC → LA (UTC-7) sees 2026-04-14 17:00 → the
    // pre-fix `$from::date` would coerce this to 2026-04-14, shifting the
    // series one day earlier than intended.
    const from = new Date("2026-04-15T00:00:00.000Z");
    const to = new Date("2026-04-17T00:00:00.000Z");
    await seedQueryLog(db, [
      { created_at: new Date("2026-04-15T00:00:00.000Z") },
    ]);

    const prev = await db.query<{ TimeZone: string }>("SHOW TimeZone");
    const prevTz = prev.rows[0]?.TimeZone ?? "UTC";
    await db.query("SET TIME ZONE 'America/Los_Angeles'");
    try {
      const result = await getAnalyticsSummary({ from, to });

      // Inclusive day span: 2026-04-15, 2026-04-16, 2026-04-17 → 3 days.
      const days = result.queries_per_day_window.map((r) => r.day);
      expect(days).toEqual(["2026-04-15", "2026-04-16", "2026-04-17"]);
      expect(days).not.toContain("2026-04-14");

      const sumOfBars = result.queries_per_day_window.reduce(
        (acc, r) => acc + r.count,
        0,
      );
      expect(sumOfBars).toBe(result.total_queries_window);
      expect(sumOfBars).toBe(1);
    } finally {
      await db.query(`SET TIME ZONE '${prevTz}'`);
    }
  });

  // Production Postgres sessions often have `TimeZone` set to a non-UTC
  // value (e.g. America/Los_Angeles on RDS managed configs that inherit a
  // region default). Without an explicit `AT TIME ZONE 'UTC'` on the inner
  // `date_trunc`, the inner aggregate groups by the session-local day while
  // the outer `generate_series` emits UTC-midnight days — a silent mismatch
  // that drops bars for rows whose UTC day differs from the session-local
  // day at the time they were logged. PGlite defaults to UTC, which is why
  // the other tests pass; flipping the session TZ here reproduces the
  // production-only regression locally.
  it("non-UTC session TZ: per-day grouping stays in UTC regardless of TimeZone GUC", async () => {
    // Seed a row deliberately placed on a UTC/LA day boundary. 06:30 UTC
    // on day 0 is 23:30 on day -1 in America/Los_Angeles (PDT = UTC-7).
    // A naive `date_trunc('day', created_at)` in the LA session would
    // bucket this row on day -1; the UTC-normalized grouping MUST bucket
    // it on day 0 to stay aligned with the series.
    const row = new Date(`${utcDayString(0)}T06:30:00.000Z`);
    await seedQueryLog(db, [{ created_at: row }]);

    // Save and override session TZ. PGlite keeps the GUC until reset, so
    // always restore in a try/finally to avoid leaking into later tests.
    const prev = await db.query<{ TimeZone: string }>("SHOW TimeZone");
    const prevTz = prev.rows[0]?.TimeZone ?? "UTC";
    await db.query("SET TIME ZONE 'America/Los_Angeles'");
    try {
      const result = await getAnalyticsSummary({}, 7);

      expect(result.queries_per_day_window).toHaveLength(7);
      expect(result.total_queries_window).toBe(1);

      const sumOfBars = result.queries_per_day_window.reduce(
        (acc, r) => acc + r.count,
        0,
      );
      expect(sumOfBars).toBe(result.total_queries_window);

      // The row should land on today (UTC), not on yesterday (LA).
      const todayBar = result.queries_per_day_window.find(
        (r) => r.day === utcDayString(0),
      );
      expect(todayBar?.count).toBe(1);
    } finally {
      await db.query(`SET TIME ZONE '${prevTz}'`);
    }
  });
});
