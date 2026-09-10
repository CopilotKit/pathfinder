import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  SearchToolConfig,
  KnowledgeToolConfig,
  ChunkResult,
} from "../types.js";

// Empty results used to return the bare string "No results found." (and
// "No FAQ results found." on the knowledge path), which teaches the caller
// nothing: neither an off-topic caller (that this server is domain-scoped)
// nor a real user who hit a genuine documentation gap. Every empty response
// must now carry the same `domain` + `hint` payload shape the abuse
// blocklist already returns on its blocked path.
vi.mock("../db/queries.js", () => ({
  searchChunks: vi.fn(),
  textSearchChunks: vi.fn(),
  hybridSearchChunks: vi.fn(),
  getFaqChunks: vi.fn(),
  getFaqChunksByIds: vi.fn(),
}));
vi.mock("../db/analytics.js", () => ({
  logQuery: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../config.js", () => ({
  getServerConfig: vi.fn().mockReturnValue({}),
  getAnalyticsConfig: vi.fn().mockReturnValue(undefined),
}));

import { registerSearchTool } from "../mcp/tools/search.js";
import { registerKnowledgeTool } from "../mcp/tools/knowledge.js";
import {
  searchChunks,
  textSearchChunks,
  hybridSearchChunks,
  getFaqChunks,
  getFaqChunksByIds,
} from "../db/queries.js";

const mockSearchChunks = vi.mocked(searchChunks);
const mockTextSearchChunks = vi.mocked(textSearchChunks);
const mockHybridSearchChunks = vi.mocked(hybridSearchChunks);
const mockGetFaqChunks = vi.mocked(getFaqChunks);
const mockGetFaqChunksByIds = vi.mocked(getFaqChunksByIds);
const mockEmbed = vi.fn();

function searchConfig(
  overrides: Partial<SearchToolConfig> = {},
): SearchToolConfig {
  return {
    name: "search-docs",
    type: "search",
    description: "Search the documentation.",
    source: "docs",
    default_limit: 5,
    max_limit: 20,
    result_format: "docs",
    search_mode: "vector",
    ...overrides,
  };
}

const knowledgeConfig: KnowledgeToolConfig = {
  name: "get-faq",
  type: "knowledge",
  description: "Browse or search the FAQ.",
  sources: ["slack-support", "discord-support"],
  min_confidence: 0.7,
  default_limit: 2,
  max_limit: 10,
};

function textOf(result: unknown): string {
  return (result as { content: Array<{ type: string; text: string }> })
    .content[0].text;
}

type EmptyPayload = {
  results: unknown[];
  reason: string;
  domain: string;
  hint: string;
};

/**
 * Every empty-result payload must parse as JSON and carry the scope hint.
 * `domain` is derived from the tool's configured source(s); the hint must
 * name that domain, must not accuse the caller of being off-topic (most
 * recipients are legitimate users hitting a docs gap), and must point an
 * out-of-scope caller at a web search instead.
 */
function expectScopeHint(text: string, domain: string): EmptyPayload {
  expect(text).not.toBe("No results found.");
  expect(text).not.toBe("No FAQ results found.");
  const payload = JSON.parse(text) as EmptyPayload;
  expect(payload.results).toEqual([]);
  expect(payload.reason).toBe("no_results");
  expect(payload.domain).toBe(domain);
  expect(typeof payload.hint).toBe("string");
  expect(payload.hint).toContain(domain);
  expect(payload.hint.toLowerCase()).toContain("web search");
  // Not the blocked path — `blocked` stays reserved for a blocklist match.
  expect(payload).not.toHaveProperty("blocked");
  return payload;
}

async function connect(register: (server: McpServer) => void): Promise<Client> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  register(server);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("search tool: empty results carry a scope hint", () => {
  let docsClient: Client;
  let codeClient: Client;
  let rawClient: Client;
  let keywordClient: Client;
  let hybridClient: Client;

  beforeAll(async () => {
    const embeddingClient = { embed: mockEmbed };
    docsClient = await connect((s) =>
      registerSearchTool(s as never, embeddingClient as never, searchConfig()),
    );
    codeClient = await connect((s) =>
      registerSearchTool(
        s as never,
        embeddingClient as never,
        searchConfig({
          name: "search-code",
          source: "code",
          result_format: "code",
        }),
      ),
    );
    rawClient = await connect((s) =>
      registerSearchTool(
        s as never,
        embeddingClient as never,
        searchConfig({
          name: "search-raw",
          source: "notes",
          result_format: "raw",
        }),
      ),
    );
    keywordClient = await connect((s) =>
      registerSearchTool(
        s as never,
        embeddingClient as never,
        searchConfig({
          name: "search-keyword",
          source: "docs",
          search_mode: "keyword",
        }),
      ),
    );
    hybridClient = await connect((s) =>
      registerSearchTool(
        s as never,
        embeddingClient as never,
        searchConfig({
          name: "search-hybrid",
          source: "ag-ui-docs",
          search_mode: "hybrid",
        }),
      ),
    );
  });

  it("docs format: empty vector search returns the domain + hint payload", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([]);

    const result = await docsClient.callTool({
      name: "search-docs",
      arguments: { query: "how do I configure the sidebar theme" },
    });

    expect(result.isError).toBeFalsy();
    expectScopeHint(textOf(result), "docs");
  });

  it("code format: empty vector search returns the domain + hint payload", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([]);

    const result = await codeClient.callTool({
      name: "search-code",
      arguments: { query: "nonexistent symbol" },
    });

    expectScopeHint(textOf(result), "code");
  });

  it("raw format: empty vector search returns the domain + hint payload", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([]);

    const result = await rawClient.callTool({
      name: "search-raw",
      arguments: { query: "nothing here" },
    });

    expectScopeHint(textOf(result), "notes");
  });

  it("keyword mode: empty results carry the hint too", async () => {
    mockTextSearchChunks.mockResolvedValueOnce([]);

    const result = await keywordClient.callTool({
      name: "search-keyword",
      arguments: { query: "nothing here" },
    });

    expectScopeHint(textOf(result), "docs");
  });

  it("hybrid mode: empty results carry the hint too", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockHybridSearchChunks.mockResolvedValueOnce([]);

    const result = await hybridClient.callTool({
      name: "search-hybrid",
      arguments: { query: "nothing here" },
    });

    expectScopeHint(textOf(result), "ag-ui-docs");
  });

  it("min_score filtering down to zero results also carries the hint", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    const lowScoreHit: ChunkResult = {
      id: 1,
      source_name: "docs",
      source_url: "https://docs.example.com/x",
      title: "X",
      content: "content",
      repo_url: null,
      file_path: "docs/x.md",
      start_line: null,
      end_line: null,
      language: null,
      similarity: 0.05,
    };
    mockSearchChunks.mockResolvedValueOnce([lowScoreHit]);

    const result = await docsClient.callTool({
      name: "search-docs",
      arguments: { query: "barely related", min_score: 0.9 },
    });

    expectScopeHint(textOf(result), "docs");
  });

  it("non-empty results are unchanged (no hint payload)", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([
      {
        id: 1,
        source_name: "docs",
        source_url: "https://docs.example.com/x",
        title: "Getting Started",
        content: "the content",
        repo_url: null,
        file_path: "docs/x.md",
        start_line: null,
        end_line: null,
        language: null,
        similarity: 0.9,
      },
    ]);

    const result = await docsClient.callTool({
      name: "search-docs",
      arguments: { query: "getting started" },
    });

    const text = textOf(result);
    expect(text).toContain("SNIPPET 1");
    expect(text).not.toContain("no_results");
  });
});

describe("knowledge tool: empty results carry a scope hint", () => {
  let client: Client;
  const domain = "slack-support, discord-support";

  beforeAll(async () => {
    client = await connect((s) =>
      registerKnowledgeTool(
        s as never,
        { embed: mockEmbed } as never,
        knowledgeConfig,
      ),
    );
  });

  it("browse mode: empty FAQ listing returns the domain + hint payload", async () => {
    mockGetFaqChunks.mockResolvedValueOnce([]);

    const result = await client.callTool({ name: "get-faq", arguments: {} });

    expect(result.isError).toBeFalsy();
    expectScopeHint(textOf(result), domain);
  });

  it("search mode: zero vector hits return the domain + hint payload", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const result = await client.callTool({
      name: "get-faq",
      arguments: { query: "how do I rotate an api key" },
    });

    expectScopeHint(textOf(result), domain);
  });

  it("search mode: hits filtered out by confidence return the hint payload", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks
      .mockResolvedValueOnce([
        {
          id: 7,
          source_name: "slack-support",
          source_url: null,
          title: null,
          content: "Q: x\n\nA: y",
          repo_url: null,
          file_path: "C1:1:0",
          start_line: null,
          end_line: null,
          language: null,
          similarity: 0.9,
        },
      ])
      .mockResolvedValueOnce([]);
    mockGetFaqChunksByIds.mockResolvedValueOnce([]);

    const result = await client.callTool({
      name: "get-faq",
      arguments: { query: "low confidence" },
    });

    expectScopeHint(textOf(result), domain);
  });
});
