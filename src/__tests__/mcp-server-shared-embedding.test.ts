// createMcpServer builds one embedding provider per process, not one per
// server instance. The provider is memoised by the `embedding` config object
// and the OpenAI key, so a config reload (a new object) gets a new provider.
// It stays lazy: a config with no RAG tool creates no provider.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  getConfig: vi.fn(),
  getServerConfig: vi.fn(),
  getAnalyticsConfig: vi.fn(),
}));
vi.mock("../indexing/embeddings.js", () => ({
  createEmbeddingProvider: vi.fn(() => ({
    embed: vi.fn(),
    embedBatch: vi.fn(),
  })),
}));

import { createMcpServer } from "../mcp/server.js";
import { getConfig, getServerConfig } from "../config.js";
import { createEmbeddingProvider } from "../indexing/embeddings.js";
import { ServerConfigSchema } from "../types.js";
import type { ServerConfig } from "../types.js";
import { baseConfig } from "./helpers/mcpServerFixtures.js";

const source = {
  name: "docs",
  type: "html",
  repo: "https://github.com/CopilotKit/pathfinder.git",
  path: "docs/",
  base_url: "https://pathfinder.copilotkit.dev/",
  file_patterns: ["**/*.html"],
  chunk: { target_tokens: 600, overlap_tokens: 50 },
};

const searchTool = {
  name: "search-docs",
  type: "search",
  description: "Search docs.",
  source: "docs",
  default_limit: 5,
  max_limit: 20,
  result_format: "docs",
};

const collectTool = {
  name: "submit-feedback",
  type: "collect",
  description: "Feedback.",
  response: "Thanks.",
  schema: {
    rating: { type: "enum", values: ["helpful", "not_helpful"] },
  },
};

function ragConfig(): ServerConfig {
  return ServerConfigSchema.parse({
    server: { name: "pf", version: "1.0.0" },
    embedding: {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
    },
    sources: [source],
    tools: [searchTool],
  });
}

function collectOnlyConfig(): ServerConfig {
  return ServerConfigSchema.parse({
    server: { name: "pf", version: "1.0.0" },
    sources: [source],
    tools: [collectTool],
  });
}

const mockCreate = vi.mocked(createEmbeddingProvider);

describe("createMcpServer shared embedding provider", () => {
  beforeEach(() => {
    mockCreate.mockClear();
    vi.mocked(getConfig).mockReturnValue({ ...baseConfig, openaiApiKey: "k" });
  });

  it("creates the provider once for two servers with the same config", () => {
    const cfg = ragConfig();
    vi.mocked(getServerConfig).mockReturnValue(cfg);
    createMcpServer();
    createMcpServer();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith(cfg.embedding, "k");
  });

  it("creates a second provider when the embedding config object changes", () => {
    vi.mocked(getServerConfig).mockReturnValue(ragConfig());
    createMcpServer();
    const before = mockCreate.mock.calls.length;
    const reloaded = ragConfig();
    vi.mocked(getServerConfig).mockReturnValue(reloaded);
    createMcpServer();
    createMcpServer();
    expect(mockCreate.mock.calls.length).toBe(before + 1);
    expect(mockCreate).toHaveBeenLastCalledWith(reloaded.embedding, "k");
  });

  it("creates a second provider when the OpenAI key changes", () => {
    const cfg = ragConfig();
    vi.mocked(getServerConfig).mockReturnValue(cfg);
    createMcpServer();
    const before = mockCreate.mock.calls.length;
    vi.mocked(getConfig).mockReturnValue({ ...baseConfig, openaiApiKey: "k2" });
    createMcpServer();
    expect(mockCreate.mock.calls.length).toBe(before + 1);
    expect(mockCreate).toHaveBeenLastCalledWith(cfg.embedding, "k2");
  });

  it("creates no provider for a config with only collect tools", () => {
    vi.mocked(getServerConfig).mockReturnValue(collectOnlyConfig());
    createMcpServer();
    createMcpServer();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
