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
}));

import { registerSearchTool } from "../mcp/tools/search.js";
import { searchChunks } from "../db/queries.js";

const mockSearchChunks = vi.mocked(searchChunks);
const mockEmbed = vi.fn();

function makeChunkResult(overrides: Partial<ChunkResult> = {}): ChunkResult {
  return {
    id: 1,
    source_name: "docs",
    source_url: "https://docs.example.com/getting-started",
    title: "Getting Started",
    content: "This is the getting started guide.",
    repo_url: "https://github.com/org/repo",
    file_path: "docs/getting-started.md",
    start_line: null,
    end_line: null,
    language: null,
    similarity: 0.95,
    ...overrides,
  };
}

const baseToolConfig: SearchToolConfig = {
  name: "search-docs",
  type: "search",
  description: "Search the documentation.",
  source: "docs",
  default_limit: 5,
  max_limit: 20,
  result_format: "docs",
  search_mode: "vector",
};

// ── Full MCP protocol tests ────────────────────────────────────────────────

describe("search tool via MCP protocol (docs format)", () => {
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    server = new McpServer({ name: "test", version: "1.0.0" });
    const embeddingClient = { embed: mockEmbed };
    registerSearchTool(
      server as never,
      embeddingClient as never,
      baseToolConfig,
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

  it("lists the search tool with correct name and description", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "search-docs");
    expect(tool).toBeDefined();
    expect(tool!.description).toBe("Search the documentation.");
  });

  it("returns formatted docs results for a valid query", async () => {
    const embedding = [0.1, 0.2, 0.3];
    mockEmbed.mockResolvedValueOnce(embedding);
    mockSearchChunks.mockResolvedValueOnce([
      makeChunkResult({
        title: "Guide",
        content: "Hello world",
        source_url: "https://docs.example.com/guide",
      }),
    ]);

    const result = await client.callTool({
      name: "search-docs",
      arguments: { query: "hello" },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("SNIPPET 1");
    expect(text).toContain("TITLE: Guide");
    expect(text).toContain("SOURCE: https://docs.example.com/guide");
    expect(text).toContain("CONTENT:");
    expect(text).toContain("Hello world");

    expect(mockEmbed).toHaveBeenCalledWith("hello");
    expect(mockSearchChunks).toHaveBeenCalledWith(
      embedding,
      5,
      "docs",
      undefined,
    );
  });

  it("uses provided limit instead of default", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([]);

    await client.callTool({
      name: "search-docs",
      arguments: { query: "test", limit: 10 },
    });

    expect(mockSearchChunks).toHaveBeenCalledWith([0.1], 10, "docs", undefined);
  });

  it("passes version filter when provided", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([]);

    await client.callTool({
      name: "search-docs",
      arguments: { query: "test", version: "v2.0" },
    });

    expect(mockSearchChunks).toHaveBeenCalledWith([0.1], 5, "docs", "v2.0");
  });

  it('returns "No results found." when no results match', async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([]);

    const result = await client.callTool({
      name: "search-docs",
      arguments: { query: "nonexistent topic" },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toBe("No results found.");
  });

  it("filters results by min_score when provided", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([
      makeChunkResult({ similarity: 0.9, title: "High" }),
      makeChunkResult({ similarity: 0.3, title: "Low" }),
    ]);

    const result = await client.callTool({
      name: "search-docs",
      arguments: { query: "test", min_score: 0.5 },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("High");
    expect(text).not.toContain("Low");
  });

  it("returns error response on embedding failure", async () => {
    mockEmbed.mockRejectedValueOnce(new Error("API rate limit"));

    const result = await client.callTool({
      name: "search-docs",
      arguments: { query: "test" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toBe("Error: Search failed. Please try again later.");
  });

  it("returns error response on search failure", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockRejectedValueOnce(new Error("DB connection lost"));

    const result = await client.callTool({
      name: "search-docs",
      arguments: { query: "test" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toBe("Error: Search failed. Please try again later.");
  });

  it("handles non-Error thrown values in catch", async () => {
    mockEmbed.mockRejectedValueOnce("raw string error");

    const result = await client.callTool({
      name: "search-docs",
      arguments: { query: "test" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toBe("Error: Search failed. Please try again later.");
  });

  it("formats multiple results with numbered snippets and separators", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([
      makeChunkResult({ title: "First", content: "First content" }),
      makeChunkResult({ title: "Second", content: "Second content" }),
    ]);

    const result = await client.callTool({
      name: "search-docs",
      arguments: { query: "test" },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("SNIPPET 1");
    expect(text).toContain("SNIPPET 2");
    expect(text).toContain("---");
  });

  it("uses file_path as TITLE fallback when title is null", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([
      makeChunkResult({ title: null, file_path: "docs/readme.md" }),
    ]);

    const result = await client.callTool({
      name: "search-docs",
      arguments: { query: "test" },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("TITLE: docs/readme.md");
  });

  it("uses file_path as SOURCE fallback when source_url is null", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([
      makeChunkResult({ source_url: null, file_path: "docs/readme.md" }),
    ]);

    const result = await client.callTool({
      name: "search-docs",
      arguments: { query: "test" },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("SOURCE: docs/readme.md");
  });
});

// ── Code format tests ────────────────────────────────────────────────────────

describe("search tool via MCP protocol (code format)", () => {
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    server = new McpServer({ name: "test-code", version: "1.0.0" });
    const embeddingClient = { embed: mockEmbed };
    const codeConfig: SearchToolConfig = {
      ...baseToolConfig,
      name: "search-code",
      result_format: "code",
      source: "code",
    };
    registerSearchTool(server as never, embeddingClient as never, codeConfig);

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

  it("formats results with REPOSITORY and PATH fields", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([
      makeChunkResult({
        repo_url: "https://github.com/org/repo",
        file_path: "src/main.ts",
        content: "function hello() {}",
      }),
    ]);

    const result = await client.callTool({
      name: "search-code",
      arguments: { query: "hello function" },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("REPOSITORY: https://github.com/org/repo");
    expect(text).toContain("PATH: src/main.ts");
    expect(text).toContain("function hello() {}");
    // Code format should NOT have TITLE
    expect(text).not.toContain("TITLE:");
  });
});

// ── Raw format tests ─────────────────────────────────────────────────────────

describe("search tool via MCP protocol (raw format)", () => {
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    server = new McpServer({ name: "test-raw", version: "1.0.0" });
    const embeddingClient = { embed: mockEmbed };
    const rawConfig: SearchToolConfig = {
      ...baseToolConfig,
      name: "search-raw",
      result_format: "raw",
      source: "raw",
    };
    registerSearchTool(server as never, embeddingClient as never, rawConfig);

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

  it("formats results with SOURCE and CONTENT only", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([
      makeChunkResult({
        source_url: "https://example.com/page",
        content: "Raw content here",
      }),
    ]);

    const result = await client.callTool({
      name: "search-raw",
      arguments: { query: "raw" },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("SOURCE: https://example.com/page");
    expect(text).toContain("Raw content here");
    // Raw format should NOT have TITLE or REPOSITORY
    expect(text).not.toContain("TITLE:");
    expect(text).not.toContain("REPOSITORY:");
  });
});

// ── min_score from config tests ─────────────────────────────────────────────

describe("search tool config-level min_score", () => {
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    server = new McpServer({ name: "test-minscore", version: "1.0.0" });
    const embeddingClient = { embed: mockEmbed };
    const configWithMinScore: SearchToolConfig = {
      ...baseToolConfig,
      name: "search-filtered",
      min_score: 0.6,
    };
    registerSearchTool(
      server as never,
      embeddingClient as never,
      configWithMinScore,
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

  it("applies config-level min_score when request min_score is not provided", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([
      makeChunkResult({ similarity: 0.9, title: "High" }),
      makeChunkResult({ similarity: 0.4, title: "Low" }),
    ]);

    const result = await client.callTool({
      name: "search-filtered",
      arguments: { query: "test" },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("High");
    expect(text).not.toContain("Low");
  });

  it("request min_score overrides config-level min_score", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([
      makeChunkResult({ similarity: 0.9, title: "High" }),
      makeChunkResult({ similarity: 0.4, title: "Medium" }),
      makeChunkResult({ similarity: 0.1, title: "Low" }),
    ]);

    const result = await client.callTool({
      name: "search-filtered",
      arguments: { query: "test", min_score: 0.3 },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("High");
    expect(text).toContain("Medium");
    expect(text).not.toContain("Low");
  });
});
