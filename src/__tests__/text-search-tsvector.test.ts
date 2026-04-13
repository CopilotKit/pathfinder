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
});
