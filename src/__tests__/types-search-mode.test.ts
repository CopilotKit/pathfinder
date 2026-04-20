import { describe, it, expect } from "vitest";
import { SearchToolConfigSchema } from "../types.js";

describe("SearchToolConfigSchema search_mode", () => {
  const base = {
    name: "test",
    type: "search" as const,
    description: "test",
    source: "docs",
    default_limit: 5,
    max_limit: 20,
    result_format: "docs" as const,
  };

  it("defaults search_mode to vector when not specified", () => {
    const result = SearchToolConfigSchema.parse(base);
    expect(result.search_mode).toBe("vector");
  });

  it("accepts vector as search_mode", () => {
    const result = SearchToolConfigSchema.parse({
      ...base,
      search_mode: "vector",
    });
    expect(result.search_mode).toBe("vector");
  });

  it("accepts keyword as search_mode", () => {
    const result = SearchToolConfigSchema.parse({
      ...base,
      search_mode: "keyword",
    });
    expect(result.search_mode).toBe("keyword");
  });

  it("accepts hybrid as search_mode", () => {
    const result = SearchToolConfigSchema.parse({
      ...base,
      search_mode: "hybrid",
    });
    expect(result.search_mode).toBe("hybrid");
  });

  it("rejects invalid search_mode values", () => {
    expect(() =>
      SearchToolConfigSchema.parse({ ...base, search_mode: "bm25" }),
    ).toThrow();
  });

  it("existing config without search_mode parses successfully", () => {
    const result = SearchToolConfigSchema.parse({
      name: "search-docs",
      type: "search",
      description: "Search docs",
      source: "docs",
      default_limit: 5,
      max_limit: 20,
      result_format: "docs",
    });
    expect(result.search_mode).toBe("vector");
  });

  it("existing config with min_score and no search_mode still works", () => {
    const result = SearchToolConfigSchema.parse({
      name: "search-docs",
      type: "search",
      description: "Search docs",
      source: "docs",
      default_limit: 5,
      max_limit: 20,
      result_format: "docs",
      min_score: 0.7,
    });
    expect(result.search_mode).toBe("vector");
    expect(result.min_score).toBe(0.7);
  });
});
