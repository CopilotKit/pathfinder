import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the pool
const mockQuery = vi.fn();
vi.mock("../db/client.js", () => ({
  getPool: () => ({ query: mockQuery }),
}));

import { textSearchChunks } from "../db/queries.js";

describe("textSearchChunks (tsvector-based)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses plainto_tsquery for safe query parsing", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await textSearchChunks("test query", 10);

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("plainto_tsquery('english'");
    // Should NOT contain raw ILIKE
    expect(sql).not.toContain("ILIKE");
  });

  it("handles SQL injection attempt in query safely", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await textSearchChunks("'; DROP TABLE chunks; --", 10);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("plainto_tsquery");
    expect(params[0]).toBe("'; DROP TABLE chunks; --");
  });

  it("handles unicode/CJK queries", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await textSearchChunks("\u4F60\u597D\u4E16\u754C", 10);

    const [, params] = mockQuery.mock.calls[0];
    expect(params[0]).toBe("\u4F60\u597D\u4E16\u754C");
  });

  it("handles empty string query without error", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const results = await textSearchChunks("", 10);
    expect(results).toEqual([]);
  });

  it("handles stop-words-only query (may return no results)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const results = await textSearchChunks("the a an", 10);
    expect(results).toEqual([]);
  });

  it("passes sourceName filter when provided", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await textSearchChunks("test", 10, "docs");

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("source_name");
    expect(params).toContain("docs");
  });

  it("orders results by ts_rank descending", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await textSearchChunks("test", 10);

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("ORDER BY ts_rank");
    expect(sql).toContain("DESC");
  });

  // Every test above returns `rows: []`, so none of them exercises the row
  // mapping at all. These do.
  describe("row mapping", () => {
    beforeEach(() => {
      // mockReset, not the suite-level clearAllMocks: `clearAllMocks` only
      // clears recorded calls, so a `mockResolvedValueOnce` that its own test
      // never consumed (the empty-query cases return before touching the pool)
      // stays queued and would be handed to the first test here instead of the
      // rows it set up.
      mockQuery.mockReset();
    });

    /** A row shaped like what the ts_rank SELECT actually returns. */
    function dbRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 7,
        source_name: "docs",
        source_url: "https://docs.example.com/p",
        title: "Page",
        content: "body",
        repo_url: null,
        file_path: "docs/p.md",
        start_line: null,
        end_line: null,
        language: null,
        similarity: 0.0731,
        ...overrides,
      };
    }

    it("reports NO cosine for a keyword hit, on every row", async () => {
      // The whole point of the keyword path: ts_rank is not on the cosine
      // scale and no embedding was compared, so there is no relevance score to
      // report. Handing `similarity` through as `cosine_similarity` here is the
      // original bug — it puts a ts_rank into query_log.top_score, where it is
      // compared against a cosine threshold and averaged into "Avg Cosine".
      // The SELECT has no cosine column of its own, so nothing but this
      // mapping decides the value.
      mockQuery.mockResolvedValueOnce({
        rows: [dbRow({ id: 1 }), dbRow({ id: 2, similarity: 0.0102 })],
      });

      const results = await textSearchChunks("test", 10);

      expect(results).toHaveLength(2);
      for (const r of results) {
        expect(r.cosine_similarity).toBeNull();
      }
      // ...while the ts_rank still comes through as the RANKING score, so this
      // is not satisfied by simply dropping the score entirely.
      expect(results.map((r) => r.similarity)).toEqual([0.0731, 0.0102]);
    });

    it("keeps cosine null even when the ts_rank is unusable", async () => {
      // A non-numeric ts_rank is coerced to 0 for sort safety. That coercion
      // must not leak into the relevance field either — 0 on the cosine scale
      // means "orthogonal", a real reading, not "unknown".
      mockQuery.mockResolvedValueOnce({ rows: [dbRow({ similarity: "n/a" })] });

      const [result] = await textSearchChunks("test", 10);

      expect(result.similarity).toBe(0);
      expect(result.cosine_similarity).toBeNull();
    });
  });
});
