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
}));

import { registerSearchTool } from "../mcp/tools/search.js";
import { searchChunks } from "../db/queries.js";
import { logQuery } from "../db/analytics.js";
import { getServerConfig } from "../config.js";

const mockSearchChunks = vi.mocked(searchChunks);
const mockLogQuery = vi.mocked(logQuery);
const mockGetServerConfig = vi.mocked(getServerConfig);
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
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    client = new Client({ name: "tc", version: "1.0.0" });
    await client.connect(ct);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it("logs query when analytics is enabled", async () => {
    mockGetServerConfig.mockReturnValue({
      analytics: { enabled: true, log_queries: true, retention_days: 90 },
    } as never);
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

  it("does not log when analytics is disabled", async () => {
    mockGetServerConfig.mockReturnValue({
      analytics: { enabled: false, log_queries: true, retention_days: 90 },
    } as never);
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([]);

    await client.callTool({
      name: "search-docs",
      arguments: { query: "test" },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(mockLogQuery).not.toHaveBeenCalled();
  });

  it("does not log when analytics config is absent", async () => {
    mockGetServerConfig.mockReturnValue({} as never);
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([]);

    await client.callTool({
      name: "search-docs",
      arguments: { query: "test" },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(mockLogQuery).not.toHaveBeenCalled();
  });

  it("passes log_queries: false to logQuery when configured", async () => {
    mockGetServerConfig.mockReturnValue({
      analytics: { enabled: true, log_queries: false, retention_days: 90 },
    } as never);
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
    mockGetServerConfig.mockReturnValue({
      analytics: { enabled: true, log_queries: true, retention_days: 90 },
    } as never);
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([makeChunkResult()]);
    mockLogQuery.mockRejectedValueOnce(new Error("DB write failed"));

    const result = await client.callTool({
      name: "search-docs",
      arguments: { query: "test" },
    });
    expect(result.isError).toBeFalsy();
  });

  it("logs null top_score when no results", async () => {
    mockGetServerConfig.mockReturnValue({
      analytics: { enabled: true, log_queries: true, retention_days: 90 },
    } as never);
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([]);
    mockLogQuery.mockResolvedValueOnce(undefined);

    await client.callTool({
      name: "search-docs",
      arguments: { query: "nothing" },
    });
    await new Promise((r) => setTimeout(r, 10));

    const [entry] = mockLogQuery.mock.calls[0];
    expect(entry.result_count).toBe(0);
    expect(entry.top_score).toBeNull();
  });

  it("does not log analytics when search itself fails", async () => {
    mockGetServerConfig.mockReturnValue({
      analytics: { enabled: true, log_queries: true, retention_days: 90 },
    } as never);
    mockEmbed.mockRejectedValueOnce(new Error("API error"));

    const result = await client.callTool({
      name: "search-docs",
      arguments: { query: "test" },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(result.isError).toBe(true);
    expect(mockLogQuery).not.toHaveBeenCalled();
  });

  it("computes correct top_score from multiple results", async () => {
    mockGetServerConfig.mockReturnValue({
      analytics: { enabled: true, log_queries: true, retention_days: 90 },
    } as never);
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([
      makeChunkResult({ similarity: 0.7 }),
      makeChunkResult({ id: 2, similarity: 0.95 }),
      makeChunkResult({ id: 3, similarity: 0.6 }),
    ]);
    mockLogQuery.mockResolvedValueOnce(undefined);

    await client.callTool({
      name: "search-docs",
      arguments: { query: "test" },
    });
    await new Promise((r) => setTimeout(r, 10));

    const [entry] = mockLogQuery.mock.calls[0];
    expect(entry.top_score).toBeCloseTo(0.95);
    expect(entry.result_count).toBe(3);
  });
});
