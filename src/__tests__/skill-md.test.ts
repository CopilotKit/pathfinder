import { describe, it, expect } from "vitest";
import { generateSkillMd } from "../skill-md.js";
import type { ServerConfig } from "../types.js";

function makeConfig(
  overrides: {
    tools?: ServerConfig["tools"];
    sources?: ServerConfig["sources"];
  } = {},
): ServerConfig {
  const defaultSources: ServerConfig["sources"] = [
    {
      name: "docs",
      type: "markdown",
      path: "/data/docs",
      file_patterns: ["*.mdx"],
      chunk: { target_tokens: 500 },
    },
  ];

  const defaultTools: ServerConfig["tools"] = [
    {
      name: "search_docs",
      type: "search",
      description: "Search docs",
      source: "docs",
      default_limit: 5,
      max_limit: 20,
      result_format: "docs",
      search_mode: "vector",
    },
    {
      name: "explore",
      type: "bash",
      description: "Explore filesystem",
      sources: ["docs"],
    },
    {
      name: "submit_feedback",
      type: "collect",
      description: "Submit feedback",
      response: "Thanks!",
      schema: {
        rating: { type: "number", required: true },
      },
    },
  ];

  return {
    server: { name: "Test Server", version: "1.0.0" },
    sources: overrides.sources ?? defaultSources,
    tools: overrides.tools ?? defaultTools,
    embedding: {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
    },
    indexing: {
      auto_reindex: true,
      reindex_hour_utc: 4,
      stale_threshold_hours: 24,
    },
  } as ServerConfig;
}

describe("skill.md generation", () => {
  it("includes all three tool sections when search, bash, and collect are present", () => {
    const result = generateSkillMd(makeConfig());

    expect(result).toContain("### Semantic Search");
    expect(result).toContain("**search_docs**");
    expect(result).toContain("### Filesystem Exploration");
    expect(result).toContain("**explore**");
    expect(result).toContain("### Data Collection");
    expect(result).toContain("**submit_feedback**");
  });

  it("omits Semantic Search section when config has bash-only tools", () => {
    const config = makeConfig({
      tools: [
        {
          name: "explore",
          type: "bash",
          description: "Explore filesystem",
          sources: ["docs"],
        },
      ],
    });
    const result = generateSkillMd(config);

    expect(result).not.toContain("### Semantic Search");
    expect(result).toContain("### Filesystem Exploration");
    expect(result).not.toContain("### Data Collection");
  });

  it("includes Workspace section and /workspace/ path when workspace is enabled", () => {
    const config = makeConfig({
      tools: [
        {
          name: "explore",
          type: "bash",
          description: "Explore filesystem",
          sources: ["docs"],
          bash: { workspace: true },
        },
      ],
    });
    const result = generateSkillMd(config);

    expect(result).toContain("#### Workspace");
    expect(result).toContain("/workspace/");
  });

  it("includes qmd command when grep_strategy is vector", () => {
    const config = makeConfig({
      tools: [
        {
          name: "explore",
          type: "bash",
          description: "Explore filesystem",
          sources: ["docs"],
          bash: { grep_strategy: "vector" },
        },
      ],
    });
    const result = generateSkillMd(config);

    expect(result).toContain("qmd");
    expect(result).toContain("semantic search via embeddings");
    // Also in the "When to Use" table
    expect(result).toContain("Semantic code search");
  });

  it("does not mention qmd when grep_strategy is memory", () => {
    const config = makeConfig({
      tools: [
        {
          name: "explore",
          type: "bash",
          description: "Explore filesystem",
          sources: ["docs"],
          bash: { grep_strategy: "memory" },
        },
      ],
    });
    const result = generateSkillMd(config);

    expect(result).not.toContain("qmd");
    expect(result).not.toContain("Semantic code search");
  });

  it("lists all sources by name and type", () => {
    const config = makeConfig({
      sources: [
        {
          name: "docs",
          type: "markdown",
          path: "/data/docs",
          file_patterns: ["*.mdx"],
          chunk: { target_tokens: 500 },
        },
        {
          name: "sdk",
          type: "code",
          path: "/data/sdk",
          file_patterns: ["*.ts"],
          chunk: { target_lines: 50 },
        },
        {
          name: "notes",
          type: "raw-text",
          path: "/data/notes",
          file_patterns: ["*.txt"],
          chunk: { target_tokens: 300 },
        },
      ],
    });
    const result = generateSkillMd(config);

    expect(result).toContain("## Sources");
    expect(result).toContain("- docs (markdown)");
    expect(result).toContain("- sdk (code)");
    expect(result).toContain("- notes (raw-text)");
  });
});
