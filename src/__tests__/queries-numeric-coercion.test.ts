import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the db client to intercept pool.query calls. Mirrors faq-queries.test.ts.
const mockQuery = vi.fn();
vi.mock("../db/client.js", () => ({
  getPool: () => ({ query: mockQuery }),
}));

// pgvector.toSql is called by searchChunks on the embedding param; stub it so
// the mapper-under-test runs without a real pgvector dependency.
vi.mock("pgvector", () => ({
  default: { toSql: (v: unknown) => v },
}));

import {
  searchChunks,
  getIndexStats,
  getWebhookDeliveryStats,
} from "../db/queries.js";

// These guards exist because node-postgres deserializes numeric columns as
// STRINGS, and Number() of a non-numeric string (e.g. "high") yields NaN — a
// NaN similarity corrupts sort order / top_score, and a string count leaks into
// the health-endpoint stats. (Number(null) and Number("") are 0, the desired
// default; only non-numeric strings reach the NaN→0 guard.) Both are coerced
// through a toFiniteNumber discipline (mirroring getAnalyticsSummary). These
// tests pin the value-level coercion the mock-pool FAQ tests don't probe.

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    source_name: "docs",
    source_url: null,
    title: null,
    content: "x",
    repo_url: null,
    file_path: "a.md",
    start_line: null,
    end_line: null,
    language: null,
    similarity: "0.42",
    ...overrides,
  };
}

describe("searchChunks similarity coercion", () => {
  beforeEach(() => mockQuery.mockReset());

  it("parses a string similarity into a finite number", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ similarity: "0.42" })] });
    const [r] = await searchChunks([0.1], 5);
    expect(r.similarity).toBe(0.42);
    expect(Number.isFinite(r.similarity)).toBe(true);
  });

  it("coerces a null/non-numeric similarity to 0 instead of NaN", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        row({ id: 1, similarity: null }),
        row({ id: 2, similarity: "not-a-number" }),
      ],
    });
    const results = await searchChunks([0.1], 5);
    // A NaN here would corrupt the downstream sort / top_score.
    expect(results[0].similarity).toBe(0);
    expect(results[1].similarity).toBe(0);
    expect(results.every((r) => Number.isFinite(r.similarity))).toBe(true);
  });
});

describe("getIndexStats numeric coercion", () => {
  beforeEach(() => mockQuery.mockReset());

  it("coerces string counts (node-postgres int-as-string) to finite numbers", async () => {
    // The four Promise.all queries resolve in order: total, by-source, repos,
    // index_state. node-postgres returns count(*)::int as a STRING.
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: "1234" }] }) // total
      .mockResolvedValueOnce({
        rows: [{ source_name: "docs", count: "42" }],
      }) // by source
      .mockResolvedValueOnce({ rows: [{ count: "7" }] }) // repos
      .mockResolvedValueOnce({ rows: [] }); // index_state

    const stats = await getIndexStats();

    expect(stats.totalChunks).toBe(1234);
    expect(typeof stats.totalChunks).toBe("number");
    expect(stats.indexedRepos).toBe(7);
    expect(stats.bySource[0].count).toBe(42);
    expect(typeof stats.bySource[0].count).toBe("number");
  });

  it("defaults a missing/non-numeric count to 0", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{}] }) // total — no count key
      .mockResolvedValueOnce({ rows: [] }) // by source
      .mockResolvedValueOnce({ rows: [{ count: null }] }) // repos — null
      .mockResolvedValueOnce({ rows: [] }); // index_state

    const stats = await getIndexStats();
    expect(stats.totalChunks).toBe(0);
    expect(stats.indexedRepos).toBe(0);
  });
});

describe("getWebhookDeliveryStats numeric coercion", () => {
  beforeEach(() => mockQuery.mockReset());

  it("coerces by_decision string counts (node-postgres int-as-string) to numbers", async () => {
    // The three Promise.all queries resolve in order: per-decision counts,
    // last delivery, error rows. node-postgres returns count(*)::int as a
    // STRING, so the per-decision map must coerce — by_decision is declared
    // Record<string, number> and serialized into the /health endpoint, so a
    // raw string ("accept": "5") is a user-facing type violation.
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { decision: "accept", count: "5" },
          { decision: "reject", count: "2" },
        ],
      }) // per-decision counts
      .mockResolvedValueOnce({ rows: [] }) // last delivery
      .mockResolvedValueOnce({ rows: [] }); // error rows

    const stats = await getWebhookDeliveryStats();

    // Every by_decision value must be a NUMBER, not the raw driver string.
    for (const [decision, count] of Object.entries(stats.by_decision)) {
      expect(typeof count).toBe("number");
      expect(Number.isFinite(count)).toBe(true);
      void decision;
    }
    expect(stats.by_decision.accept).toBe(5);
    expect(stats.by_decision.reject).toBe(2);
    // total_24h sums the same coerced counts.
    expect(stats.total_24h).toBe(7);
    expect(typeof stats.total_24h).toBe("number");
  });
});
