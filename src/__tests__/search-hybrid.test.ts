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

vi.mock("../db/queries.js", () => ({
  searchChunks: vi.fn(),
  textSearchChunks: vi.fn(),
  hybridSearchChunks: vi.fn(),
}));
vi.mock("../db/analytics.js", () => ({
  logQuery: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../config.js", () => ({
  getServerConfig: vi.fn().mockReturnValue({}),
  getAnalyticsConfig: vi.fn().mockReturnValue(undefined),
}));

import { registerSearchTool } from "../mcp/tools/search.js";
import {
  searchChunks,
  textSearchChunks,
  hybridSearchChunks,
} from "../db/queries.js";

const mockSearchChunks = vi.mocked(searchChunks);
const mockTextSearchChunks = vi.mocked(textSearchChunks);
const mockHybridSearchChunks = vi.mocked(hybridSearchChunks);
const mockEmbed = vi.fn();

function makeChunkResult(overrides: Partial<ChunkResult> = {}): ChunkResult {
  return {
    id: 1,
    source_name: "docs",
    source_url: "https://docs.example.com/page",
    title: "Test Page",
    content: "Test content.",
    repo_url: null,
    file_path: "docs/page.md",
    start_line: null,
    end_line: null,
    language: null,
    similarity: 0.9,
    ...overrides,
  };
}

// ── Hybrid mode tests ─────────────────────────────────────────────────────

describe("search tool hybrid mode", () => {
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    server = new McpServer({ name: "test-hybrid", version: "1.0.0" });
    const embeddingClient = { embed: mockEmbed };
    const hybridConfig: SearchToolConfig = {
      name: "search-hybrid",
      type: "search",
      description: "Hybrid search",
      source: "docs",
      default_limit: 5,
      max_limit: 20,
      result_format: "docs",
      search_mode: "hybrid",
    };
    registerSearchTool(server as never, embeddingClient as never, hybridConfig);

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

  it("calls hybridSearchChunks with embedding and query text", async () => {
    const embedding = [0.1, 0.2];
    mockEmbed.mockResolvedValueOnce(embedding);
    mockHybridSearchChunks.mockResolvedValueOnce([
      makeChunkResult({ title: "Hybrid Result" }),
    ]);

    const result = await client.callTool({
      name: "search-hybrid",
      arguments: { query: "test query" },
    });

    expect(mockEmbed).toHaveBeenCalledWith("test query");
    expect(mockHybridSearchChunks).toHaveBeenCalledWith(
      embedding,
      "test query",
      5, // default_limit
      "docs", // source
      undefined, // version
      undefined, // minScore (no config or request min_score)
    );
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("Hybrid Result");
  });

  it("passes min_score to hybridSearchChunks for vector candidate filtering", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockHybridSearchChunks.mockResolvedValueOnce([]);

    await client.callTool({
      name: "search-hybrid",
      arguments: { query: "test", min_score: 0.5 },
    });

    expect(mockHybridSearchChunks).toHaveBeenCalledWith(
      [0.1],
      "test",
      5,
      "docs",
      undefined,
      0.5,
    );
  });

  it("does not call searchChunks or textSearchChunks directly", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockHybridSearchChunks.mockResolvedValueOnce([]);

    await client.callTool({
      name: "search-hybrid",
      arguments: { query: "test" },
    });

    expect(mockSearchChunks).not.toHaveBeenCalled();
    expect(mockTextSearchChunks).not.toHaveBeenCalled();
  });

  it("returns error response when embedding fails in hybrid mode", async () => {
    mockEmbed.mockRejectedValueOnce(new Error("API key expired"));

    const result = await client.callTool({
      name: "search-hybrid",
      arguments: { query: "test" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("Error");
  });

  it("returns error response when hybridSearchChunks throws", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockHybridSearchChunks.mockRejectedValueOnce(
      new Error("DB connection lost"),
    );

    const result = await client.callTool({
      name: "search-hybrid",
      arguments: { query: "test" },
    });

    expect(result.isError).toBe(true);
  });
});

// ── Keyword mode tests ────────────────────────────────────────────────────

describe("search tool keyword mode", () => {
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    server = new McpServer({ name: "test-keyword", version: "1.0.0" });
    const embeddingClient = { embed: mockEmbed };
    const keywordConfig: SearchToolConfig = {
      name: "search-keyword",
      type: "search",
      description: "Keyword search",
      source: "docs",
      default_limit: 5,
      max_limit: 20,
      result_format: "docs",
      search_mode: "keyword",
    };
    registerSearchTool(
      server as never,
      embeddingClient as never,
      keywordConfig,
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

  it("calls textSearchChunks without embedding", async () => {
    mockTextSearchChunks.mockResolvedValueOnce([
      makeChunkResult({ title: "Keyword Result" }),
    ]);

    const result = await client.callTool({
      name: "search-keyword",
      arguments: { query: "ECONNREFUSED" },
    });

    expect(mockEmbed).not.toHaveBeenCalled();
    expect(mockTextSearchChunks).toHaveBeenCalledWith(
      "ECONNREFUSED",
      5,
      "docs",
      undefined,
    );
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("Keyword Result");
  });

  it("does not apply min_score filtering", async () => {
    mockTextSearchChunks.mockResolvedValueOnce([
      makeChunkResult({ similarity: 0.01, title: "Low Rank" }),
    ]);

    const result = await client.callTool({
      name: "search-keyword",
      arguments: { query: "test", min_score: 0.9 },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("Low Rank");
  });

  it("keyword mode succeeds even when embedding client would throw", async () => {
    mockTextSearchChunks.mockResolvedValueOnce([
      makeChunkResult({ title: "Found it" }),
    ]);

    const result = await client.callTool({
      name: "search-keyword",
      arguments: { query: "error code 42" },
    });

    expect(result.isError).toBeFalsy();
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it("keyword mode returns empty result for empty string query", async () => {
    mockTextSearchChunks.mockResolvedValueOnce([]);

    const result = await client.callTool({
      name: "search-keyword",
      arguments: { query: "" },
    });

    expect(result.isError).toBeFalsy();
  });
});

// ── Default (vector) mode still works ─────────────────────────────────────

describe("search tool default vector mode", () => {
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    server = new McpServer({ name: "test-default", version: "1.0.0" });
    const embeddingClient = { embed: mockEmbed };
    const defaultConfig: SearchToolConfig = {
      name: "search-default",
      type: "search",
      description: "Default search",
      source: "docs",
      default_limit: 5,
      max_limit: 20,
      result_format: "docs",
      search_mode: "vector",
    };
    registerSearchTool(
      server as never,
      embeddingClient as never,
      defaultConfig,
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

  it("calls searchChunks (vector) when search_mode is vector", async () => {
    const embedding = [0.1, 0.2];
    mockEmbed.mockResolvedValueOnce(embedding);
    mockSearchChunks.mockResolvedValueOnce([makeChunkResult()]);

    await client.callTool({
      name: "search-default",
      arguments: { query: "test" },
    });

    expect(mockSearchChunks).toHaveBeenCalledWith(
      embedding,
      5,
      "docs",
      undefined,
    );
    expect(mockHybridSearchChunks).not.toHaveBeenCalled();
    expect(mockTextSearchChunks).not.toHaveBeenCalled();
  });
});
