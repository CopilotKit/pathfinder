import { describe, it, expect } from "vitest";
import { ServerConfigSchema, IndexingConfigSchema } from "../types.js";

// Regression coverage for issue #88: a docs-compliant minimal RAG config
// using local embeddings should validate WITHOUT forcing cron-scheduling
// (`indexing`) fields or an explicit per-source `chunk` object.
//
// This exercises the REAL parse surface — ServerConfigSchema, the same
// schema config.ts/validate.ts run YAML through — not a hand-rolled fake.

describe("minimal RAG config (issue #88)", () => {
  // The docs-compliant config from the issue, focused on the three
  // reported schema blockers: a `local` embedding provider, one source
  // with NO `chunk`, a search tool, and NO top-level `indexing` block.
  // (The issue's crash log lists exactly five errors — sources.0.chunk,
  // embedding.provider, and the three indexing fields — and none about
  // search-tool limits, so this config supplies the search-tool limit /
  // format fields to keep the test pinned to the three claims under fix.)
  const minimalIssue88Config = {
    server: { name: "tech-ecosystem", version: "1.13.3" },
    embedding: {
      provider: "local",
      model: "Xenova/all-MiniLM-L6-v2",
      dimensions: 384,
    },
    sources: [
      {
        name: "docs",
        type: "code",
        path: "/app/docs",
        file_patterns: ["**/*"],
      },
    ],
    tools: [
      {
        name: "search-docs",
        type: "search",
        description: "Search the docs",
        source: "docs",
        default_limit: 5,
        max_limit: 20,
        result_format: "docs",
      },
    ],
  };

  it("accepts a local-embedding config with no chunk and no indexing block", () => {
    const result = ServerConfigSchema.safeParse(minimalIssue88Config);
    if (!result.success) {
      // Surface the exact failing issues so red/green output is legible.
      console.error(JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });

  it("defaults indexing fields when the indexing block is omitted", () => {
    const result = ServerConfigSchema.parse(minimalIssue88Config);
    expect(result.indexing).toEqual({
      auto_reindex: false,
      reindex_hour_utc: 3,
      stale_threshold_hours: 24,
    });
  });

  it("IndexingConfigSchema parses an empty object via defaults", () => {
    const result = IndexingConfigSchema.parse({});
    expect(result).toEqual({
      auto_reindex: false,
      reindex_hour_utc: 3,
      stale_threshold_hours: 24,
    });
  });

  it("REGRESSION: a full explicit config still validates unchanged", () => {
    const fullConfig = {
      server: { name: "full", version: "1.0.0" },
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
      },
      indexing: {
        auto_reindex: true,
        reindex_hour_utc: 5,
        stale_threshold_hours: 48,
      },
      sources: [
        {
          name: "docs",
          type: "markdown",
          path: "./docs",
          file_patterns: ["**/*.md"],
          chunk: { target_tokens: 512, overlap_tokens: 64 },
        },
      ],
      tools: [
        {
          name: "search-docs",
          type: "search",
          description: "Search the docs",
          source: "docs",
          default_limit: 5,
          max_limit: 20,
          result_format: "docs",
        },
      ],
    };
    const result = ServerConfigSchema.parse(fullConfig);
    expect(result.indexing).toEqual({
      auto_reindex: true,
      reindex_hour_utc: 5,
      stale_threshold_hours: 48,
    });
    expect(result.embedding).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
    });
    // Explicit per-source chunk must be preserved untouched.
    const src = result.sources[0];
    expect(src.chunk).toEqual({ target_tokens: 512, overlap_tokens: 64 });
  });
});
