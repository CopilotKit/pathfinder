import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the db client to intercept pool.query calls
const mockQuery = vi.fn();
vi.mock("../db/client.js", () => ({
  getPool: () => ({ query: mockQuery }),
}));

// Import AFTER mocking
import { getFaqChunks } from "../db/queries.js";

describe("getFaqChunks", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("returns empty array for empty sourceNames", async () => {
    const result = await getFaqChunks([], 0.7);
    expect(result).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("queries with correct source names and confidence threshold", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getFaqChunks(["slack-support", "slack-general"], 0.8);

    expect(mockQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("source_name IN ($1, $2)");
    // The confidence comparison is jsonb_typeof-guarded so a non-numeric
    // confidence (e.g. "high") degrades to 0.0 instead of crashing the cast.
    expect(sql).toContain("jsonb_typeof(metadata->'confidence') = 'number'");
    expect(sql).toContain("(metadata->>'confidence')::float");
    expect(sql).toContain(">= $3");
    expect(params).toEqual(["slack-support", "slack-general", 0.8]);
  });

  it("applies LIMIT when provided", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getFaqChunks(["slack-support"], 0.7, 10);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("LIMIT $3");
    expect(params).toEqual(["slack-support", 0.7, 10]);
  });

  it("maps rows to FaqChunkResult correctly", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 42,
          source_name: "slack-support",
          source_url: "https://slack.com/archives/C123/p456",
          title: "How to configure headers?",
          content:
            "Q: How to configure headers?\n\nA: Use the headers property...",
          repo_url: null,
          file_path: "C123:456:0",
          start_line: null,
          end_line: null,
          language: null,
          similarity: "0",
          metadata: { channel: "C123", confidence: 0.85 },
          confidence: "0.85",
        },
      ],
    });

    const results = await getFaqChunks(["slack-support"], 0.7);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(42);
    expect(results[0].confidence).toBe(0.85);
    expect(results[0].metadata).toEqual({ channel: "C123", confidence: 0.85 });
    expect(results[0].source_name).toBe("slack-support");
  });

  it("orders by indexed_at DESC then id DESC (global recency, NOT source-grouped)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getFaqChunks(["slack-support"], 0.5);

    const [sql] = mockQuery.mock.calls[0];
    // Global-recency ordering: source_name must NOT be the leading ORDER BY key.
    // With source_name leading, a global LIMIT across multiple browse sources is
    // consumed entirely by the alphabetically-first source, starving later
    // sources to zero regardless of recency. The browse path documents
    // "most-recent N across all sources", which requires indexed_at to lead.
    expect(sql).toContain("ORDER BY indexed_at DESC, id DESC");
    expect(sql).not.toMatch(/ORDER BY\s+source_name/);
  });

  // NOTE: the behavioral proof that a small LIMIT returns the globally-most-
  // recent rows across sources (rather than being starved by the alphabetically
  // -first source) lives in faq-browse-ordering.test.ts, which runs the query
  // end-to-end against a real PGlite engine. A mock pool can only echo a hand-
  // picked row, so it cannot actually exercise ORDER BY / LIMIT semantics.
});
