import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterAll,
} from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SearchToolConfig, ChunkResult } from "../types.js";

// Mock dependencies
vi.mock("../db/queries.js", () => ({
  searchChunks: vi.fn(),
  textSearchChunks: vi.fn(),
  hybridSearchChunks: vi.fn(),
}));
vi.mock("../db/analytics.js", () => ({
  logQuery: vi.fn(),
}));
vi.mock("../config.js", () => ({
  getServerConfig: vi.fn(),
  getAnalyticsConfig: vi.fn(),
}));

import { registerSearchTool } from "../mcp/tools/search.js";
import { searchChunks } from "../db/queries.js";
import { logQuery } from "../db/analytics.js";
import { getAnalyticsConfig } from "../config.js";

const mockSearchChunks = vi.mocked(searchChunks);
const mockLogQuery = vi.mocked(logQuery);
const mockGetAnalyticsConfig = vi.mocked(getAnalyticsConfig);
const mockEmbed = vi.fn();

function makeChunkResult(overrides: Partial<ChunkResult> = {}): ChunkResult {
  return {
    id: 1,
    source_name: "docs",
    source_url: null,
    title: "Title",
    content: "Content",
    repo_url: null,
    file_path: "f.md",
    start_line: null,
    end_line: null,
    language: null,
    similarity: 0.9,
    ...overrides,
  };
}

const toolConfig: SearchToolConfig = {
  name: "search-docs",
  type: "search",
  description: "Search",
  source: "docs",
  default_limit: 5,
  max_limit: 20,
  result_format: "docs",
  search_mode: "vector",
};

describe("search tool analytics instrumentation", () => {
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    server = new McpServer({ name: "test", version: "1.0.0" });
    registerSearchTool(
      server as never,
      { embed: mockEmbed } as never,
      toolConfig,
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it("logs query when analytics is enabled", async () => {
    mockGetAnalyticsConfig.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
    });
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([makeChunkResult()]);
    mockLogQuery.mockResolvedValueOnce(undefined);

    await client.callTool({
      name: "search-docs",
      arguments: { query: "test" },
    });

    // logQuery is fire-and-forget, give it a tick
    await new Promise((r) => setTimeout(r, 10));

    expect(mockLogQuery).toHaveBeenCalledTimes(1);
    const [entry, logText] = mockLogQuery.mock.calls[0];
    expect(entry.tool_name).toBe("search-docs");
    expect(entry.query_text).toBe("test");
    expect(entry.result_count).toBe(1);
    expect(entry.top_score).toBeCloseTo(0.9);
    expect(entry.latency_ms).toBeGreaterThanOrEqual(0);
    expect(entry.source_name).toBe("docs");
    expect(logText).toBe(true);
  });

  it("always logs even when analytics is disabled (logging is unconditional)", async () => {
    mockGetAnalyticsConfig.mockReturnValue({
      enabled: false,
      log_queries: true,
      retention_days: 90,
    });
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([makeChunkResult()]);
    mockLogQuery.mockResolvedValueOnce(undefined);

    await client.callTool({
      name: "search-docs",
      arguments: { query: "test" },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(mockLogQuery).toHaveBeenCalledTimes(1);
  });

  it("always logs even when analytics config is absent", async () => {
    mockGetAnalyticsConfig.mockReturnValue(undefined);
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([makeChunkResult()]);
    mockLogQuery.mockResolvedValueOnce(undefined);

    await client.callTool({
      name: "search-docs",
      arguments: { query: "test" },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(mockLogQuery).toHaveBeenCalledTimes(1);
    // Defaults to logging full query text when config absent
    const [, logText] = mockLogQuery.mock.calls[0];
    expect(logText).toBe(true);
  });

  it("passes log_queries: false to logQuery when configured", async () => {
    mockGetAnalyticsConfig.mockReturnValue({
      enabled: true,
      log_queries: false,
      retention_days: 90,
    });
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([makeChunkResult()]);
    mockLogQuery.mockResolvedValueOnce(undefined);

    await client.callTool({
      name: "search-docs",
      arguments: { query: "secret" },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(mockLogQuery).toHaveBeenCalledTimes(1);
    const [, logText] = mockLogQuery.mock.calls[0];
    expect(logText).toBe(false);
  });

  it("does not fail the search when logQuery throws", async () => {
    mockGetAnalyticsConfig.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
    });
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([makeChunkResult()]);
    mockLogQuery.mockRejectedValueOnce(new Error("db down"));

    const result = await client.callTool({
      name: "search-docs",
      arguments: { query: "test" },
    });

    // Search still returns results despite analytics failure
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("Title");
  });

  it("logs null top_score when no results", async () => {
    mockGetAnalyticsConfig.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
    });
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([]);
    mockLogQuery.mockResolvedValueOnce(undefined);

    await client.callTool({
      name: "search-docs",
      arguments: { query: "nothing" },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(mockLogQuery).toHaveBeenCalledTimes(1);
    const [entry] = mockLogQuery.mock.calls[0];
    expect(entry.result_count).toBe(0);
    expect(entry.top_score).toBeNull();
  });

  it("computes correct top_score from multiple results", async () => {
    mockGetAnalyticsConfig.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
    });
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([
      makeChunkResult({ similarity: 0.5 }),
      makeChunkResult({ similarity: 0.95 }),
      makeChunkResult({ similarity: 0.7 }),
    ]);
    mockLogQuery.mockResolvedValueOnce(undefined);

    await client.callTool({
      name: "search-docs",
      arguments: { query: "multi" },
    });
    await new Promise((r) => setTimeout(r, 10));

    const [entry] = mockLogQuery.mock.calls[0];
    expect(entry.top_score).toBeCloseTo(0.95);
  });
});
