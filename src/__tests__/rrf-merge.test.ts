import { describe, it, expect } from "vitest";
import { rrfMerge, RRF_K } from "../db/queries.js";
import type { ChunkResult } from "../types.js";

function makeResult(id: number, similarity: number = 0.5): ChunkResult {
  return {
    id,
    source_name: "docs",
    source_url: null,
    title: `Result ${id}`,
    content: `Content for chunk ${id}`,
    repo_url: null,
    file_path: `docs/file-${id}.md`,
    start_line: null,
    end_line: null,
    language: null,
    similarity,
  };
}

describe("rrfMerge", () => {
  it("merges two disjoint result sets by RRF score", () => {
    const vectorResults = [makeResult(1), makeResult(2)];
    const keywordResults = [makeResult(3), makeResult(4)];

    const merged = rrfMerge(vectorResults, keywordResults, 4);

    expect(merged).toHaveLength(4);
    // All have single-term RRF scores; rank 1 items from each list tie
    const ids = merged.map((r) => r.id);
    expect(ids.slice(0, 2).sort()).toEqual([1, 3]);
    expect(ids.slice(2, 4).sort()).toEqual([2, 4]);
  });

  it("boosts documents appearing in both lists", () => {
    const vectorResults = [makeResult(1), makeResult(2)];
    const keywordResults = [makeResult(1), makeResult(3)];

    const merged = rrfMerge(vectorResults, keywordResults, 3);

    expect(merged).toHaveLength(3);
    expect(merged[0].id).toBe(1);
    expect(merged[0].similarity).toBeCloseTo(2 / (RRF_K + 1), 6);
  });

  it("respects the limit parameter", () => {
    const vectorResults = [makeResult(1), makeResult(2), makeResult(3)];
    const keywordResults = [makeResult(4), makeResult(5), makeResult(6)];

    const merged = rrfMerge(vectorResults, keywordResults, 2);

    expect(merged).toHaveLength(2);
  });

  it("handles empty vector results", () => {
    const keywordResults = [makeResult(1), makeResult(2)];

    const merged = rrfMerge([], keywordResults, 5);

    expect(merged).toHaveLength(2);
    expect(merged[0].id).toBe(1);
    expect(merged[0].similarity).toBeCloseTo(1 / (RRF_K + 1), 6);
  });

  it("handles empty keyword results", () => {
    const vectorResults = [makeResult(1), makeResult(2)];

    const merged = rrfMerge(vectorResults, [], 5);

    expect(merged).toHaveLength(2);
    expect(merged[0].id).toBe(1);
    expect(merged[0].similarity).toBeCloseTo(1 / (RRF_K + 1), 6);
  });

  it("handles both lists empty", () => {
    const merged = rrfMerge([], [], 5);
    expect(merged).toHaveLength(0);
  });

  it("sets similarity to RRF score on returned results", () => {
    const vectorResults = [makeResult(1, 0.95)];
    const keywordResults: ChunkResult[] = [];

    const merged = rrfMerge(vectorResults, keywordResults, 5);

    // Original similarity (0.95) is replaced with RRF score
    expect(merged[0].similarity).toBeCloseTo(1 / (RRF_K + 1), 6);
    expect(merged[0].similarity).not.toBe(0.95);
  });

  it("preserves result metadata from the vector result when doc appears in both", () => {
    const vectorResult = makeResult(1);
    vectorResult.title = "From Vector";
    const keywordResult = makeResult(1);
    keywordResult.title = "From Keyword";

    const merged = rrfMerge([vectorResult], [keywordResult], 5);

    expect(merged[0].title).toBe("From Vector");
  });

  it("handles duplicate chunk IDs within a single result list", () => {
    const vectorResults = [makeResult(1, 0.9), makeResult(1, 0.8)];
    const keywordResults = [makeResult(2)];

    const merged = rrfMerge(vectorResults, keywordResults, 5);
    expect(merged.length).toBeGreaterThan(0);
    expect(merged.find((r) => r.id === 2)).toBeDefined();
  });

  it("handles very large result sets efficiently", () => {
    const vectorResults = Array.from({ length: 1000 }, (_, i) =>
      makeResult(i, 0.5),
    );
    const keywordResults = Array.from({ length: 1000 }, (_, i) =>
      makeResult(i + 500, 0.3),
    );

    const merged = rrfMerge(vectorResults, keywordResults, 10);
    expect(merged).toHaveLength(10);
    // Items appearing in both lists (IDs 500-999) should rank higher
    expect(merged[0].id).toBeGreaterThanOrEqual(500);
    expect(merged[0].id).toBeLessThan(1000);
  });

  it("limit of 0 returns empty array", () => {
    const vectorResults = [makeResult(1)];
    const merged = rrfMerge(vectorResults, [], 0);
    expect(merged).toEqual([]);
  });
});
