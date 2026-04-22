import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  __setPoolForTesting,
  __resetPoolForTesting,
} from "../db/client.js";
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

const QUERY_LOG_DDL_MARKER = "-- Analytics: query_log table for tracking tool usage";

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

  it("cap: days=1000 clamps queries_per_day_window to 366 rows while total_queries_window reflects the full window", async () => {
    // Seed two rows: one ~200 days back, one ~900 days back. The 900-day
    // row is inside the caller-requested 1000-day window (so it should
    // count toward total_queries_window) but outside the 366-day per-day
    // cap (so it should NOT appear as a bar).
    await seedQueryLog(db, [
      { created_at: utcNoonOfDay(-200) },
      { created_at: utcNoonOfDay(-900) },
    ]);

    const result = await getAnalyticsSummary({}, 1000);

    expect(result.queries_per_day_window).toHaveLength(366);
    // total_queries_window is not gap-fill-capped — it reflects the full
    // 1000-day window and so should see both seeded rows.
    expect(result.total_queries_window).toBe(2);

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
  });
});
