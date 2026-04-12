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
import type {
  KnowledgeToolConfig,
  FaqChunkResult,
  ChunkResult,
} from "../types.js";

vi.mock("../db/queries.js", () => ({
  getFaqChunks: vi.fn(),
  searchChunks: vi.fn(),
}));

import { registerKnowledgeTool } from "../mcp/tools/knowledge.js";
import { getFaqChunks, searchChunks } from "../db/queries.js";

const mockGetFaqChunks = vi.mocked(getFaqChunks);
const mockSearchChunks = vi.mocked(searchChunks);
const mockEmbed = vi.fn();

function makeFaqResult(
  overrides: Partial<FaqChunkResult> = {},
): FaqChunkResult {
  return {
    id: 1,
    source_name: "slack-support",
    source_url: "https://slack.com/archives/C123/p456",
    title: "How to configure headers?",
    content:
      "Q: How to configure headers?\n\nA: Use the headers property in the constructor.",
    repo_url: null,
    file_path: "C123:456:0",
    start_line: null,
    end_line: null,
    language: null,
    similarity: 0.0,
    metadata: { channel: "C123", confidence: 0.85 },
    confidence: 0.85,
    ...overrides,
  };
}

function makeChunkResult(overrides: Partial<ChunkResult> = {}): ChunkResult {
  return {
    id: 1,
    source_name: "slack-support",
    source_url: "https://slack.com/archives/C123/p456",
    title: "How to configure headers?",
    content: "Q: How to configure headers?\n\nA: Use the headers property.",
    repo_url: null,
    file_path: "C123:456:0",
    start_line: null,
    end_line: null,
    language: null,
    similarity: 0.92,
    ...overrides,
  };
}

const toolConfig: KnowledgeToolConfig = {
  name: "get-faq",
  type: "knowledge",
  description: "Get FAQ knowledge base entries.",
  sources: ["slack-support", "discord-faq"],
  min_confidence: 0.7,
  default_limit: 20,
  max_limit: 100,
};

// ── Browse mode (no query) ────────────────────────────────────────────────

describe("knowledge tool browse mode (no query)", () => {
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    server = new McpServer({ name: "test-knowledge", version: "1.0.0" });
    const embeddingClient = { embed: mockEmbed };
    registerKnowledgeTool(
      server as never,
      embeddingClient as never,
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

  it("lists the knowledge tool with correct name and description", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "get-faq");
    expect(tool).toBeDefined();
    expect(tool!.description).toBe("Get FAQ knowledge base entries.");
  });

  it("returns FAQ entries when called without a query", async () => {
    mockGetFaqChunks.mockResolvedValueOnce([
      makeFaqResult({ title: "How to authenticate?", confidence: 0.9 }),
      makeFaqResult({ id: 2, title: "How to paginate?", confidence: 0.8 }),
    ]);

    const result = await client.callTool({
      name: "get-faq",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("Q&A 1");
    expect(text).toContain("QUESTION: How to authenticate?");
    expect(text).toContain("Q&A 2");
    expect(text).toContain("QUESTION: How to paginate?");

    // Verify getFaqChunks called with config defaults
    expect(mockGetFaqChunks).toHaveBeenCalledWith(
      ["slack-support", "discord-faq"],
      0.7,
      20,
    );
    // Should NOT call embed or searchChunks in browse mode
    expect(mockEmbed).not.toHaveBeenCalled();
    expect(mockSearchChunks).not.toHaveBeenCalled();
  });

  it("treats empty string query as browse mode", async () => {
    mockGetFaqChunks.mockResolvedValueOnce([]);

    const result = await client.callTool({
      name: "get-faq",
      arguments: { query: "" },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toBe("No FAQ results found.");
    expect(mockGetFaqChunks).toHaveBeenCalled();
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it("treats whitespace-only query as browse mode", async () => {
    mockGetFaqChunks.mockResolvedValueOnce([]);

    await client.callTool({
      name: "get-faq",
      arguments: { query: "   " },
    });

    expect(mockGetFaqChunks).toHaveBeenCalled();
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it("uses provided limit in browse mode", async () => {
    mockGetFaqChunks.mockResolvedValueOnce([]);

    await client.callTool({
      name: "get-faq",
      arguments: { limit: 5 },
    });

    expect(mockGetFaqChunks).toHaveBeenCalledWith(
      ["slack-support", "discord-faq"],
      0.7,
      5,
    );
  });

  it("uses provided min_confidence in browse mode", async () => {
    mockGetFaqChunks.mockResolvedValueOnce([]);

    await client.callTool({
      name: "get-faq",
      arguments: { min_confidence: 0.9 },
    });

    expect(mockGetFaqChunks).toHaveBeenCalledWith(
      ["slack-support", "discord-faq"],
      0.9,
      20,
    );
  });
});

// ── Search mode (with query) ──────────────────────────────────────────────

describe("knowledge tool search mode (with query)", () => {
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    server = new McpServer({ name: "test-knowledge-search", version: "1.0.0" });
    const embeddingClient = { embed: mockEmbed };
    registerKnowledgeTool(
      server as never,
      embeddingClient as never,
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

  it("embeds query and searches each source then merges with FAQ data", async () => {
    const embedding = [0.1, 0.2, 0.3];
    mockEmbed.mockResolvedValueOnce(embedding);

    // searchChunks called once per source
    mockSearchChunks
      .mockResolvedValueOnce([makeChunkResult({ id: 10, similarity: 0.95 })])
      .mockResolvedValueOnce([makeChunkResult({ id: 20, similarity: 0.85 })]);

    // getFaqChunks returns FAQ metadata for cross-reference
    mockGetFaqChunks.mockResolvedValueOnce([
      makeFaqResult({ id: 10, confidence: 0.9, title: "Matched FAQ" }),
      makeFaqResult({ id: 20, confidence: 0.8, title: "Another FAQ" }),
    ]);

    const result = await client.callTool({
      name: "get-faq",
      arguments: { query: "how to auth" },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("Q&A 1");
    expect(text).toContain("Matched FAQ");
    expect(text).toContain("Q&A 2");

    expect(mockEmbed).toHaveBeenCalledWith("how to auth");
    // searchChunks called once for each source
    expect(mockSearchChunks).toHaveBeenCalledTimes(2);
    expect(mockSearchChunks).toHaveBeenCalledWith(
      embedding,
      20,
      "slack-support",
    );
    expect(mockSearchChunks).toHaveBeenCalledWith(embedding, 20, "discord-faq");
    // getFaqChunks called with confidence=0, limit=100 (effectiveLimit*5)
    expect(mockGetFaqChunks).toHaveBeenCalledWith(
      ["slack-support", "discord-faq"],
      0,
      100,
    );
  });

  it("filters out search results whose FAQ confidence is below threshold", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks
      .mockResolvedValueOnce([
        makeChunkResult({ id: 10, similarity: 0.95 }),
        makeChunkResult({ id: 11, similarity: 0.9 }),
      ])
      .mockResolvedValueOnce([]);

    mockGetFaqChunks.mockResolvedValueOnce([
      makeFaqResult({ id: 10, confidence: 0.9, title: "High Confidence" }),
      makeFaqResult({ id: 11, confidence: 0.3, title: "Low Confidence" }),
    ]);

    const result = await client.callTool({
      name: "get-faq",
      arguments: { query: "test" },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("High Confidence");
    expect(text).not.toContain("Low Confidence");
  });

  it("returns empty FAQ results when no search results have FAQ metadata", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks
      .mockResolvedValueOnce([makeChunkResult({ id: 99, similarity: 0.95 })])
      .mockResolvedValueOnce([]);

    // FAQ data does not include id=99
    mockGetFaqChunks.mockResolvedValueOnce([
      makeFaqResult({ id: 1, confidence: 0.9 }),
    ]);

    const result = await client.callTool({
      name: "get-faq",
      arguments: { query: "unmatched" },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toBe("No FAQ results found.");
  });

  it("sorts merged results by similarity descending", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    // source 1 returns lower similarity
    mockSearchChunks
      .mockResolvedValueOnce([makeChunkResult({ id: 10, similarity: 0.7 })])
      .mockResolvedValueOnce([makeChunkResult({ id: 20, similarity: 0.95 })]);

    mockGetFaqChunks.mockResolvedValueOnce([
      makeFaqResult({ id: 10, confidence: 0.9, title: "Lower Sim" }),
      makeFaqResult({ id: 20, confidence: 0.9, title: "Higher Sim" }),
    ]);

    const result = await client.callTool({
      name: "get-faq",
      arguments: { query: "test" },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    // Higher similarity should come first (Q&A 1)
    const higherIdx = text.indexOf("Higher Sim");
    const lowerIdx = text.indexOf("Lower Sim");
    expect(higherIdx).toBeLessThan(lowerIdx);
  });

  it("respects custom limit in search mode", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockGetFaqChunks.mockResolvedValueOnce([]);

    await client.callTool({
      name: "get-faq",
      arguments: { query: "test", limit: 3 },
    });

    // searchChunks should use limit=3
    expect(mockSearchChunks).toHaveBeenCalledWith(
      expect.anything(),
      3,
      "slack-support",
    );
    // getFaqChunks should use limit=15 (3*5)
    expect(mockGetFaqChunks).toHaveBeenCalledWith(
      ["slack-support", "discord-faq"],
      0,
      15,
    );
  });

  it("respects custom min_confidence in search mode", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks
      .mockResolvedValueOnce([makeChunkResult({ id: 10, similarity: 0.9 })])
      .mockResolvedValueOnce([]);

    mockGetFaqChunks.mockResolvedValueOnce([
      makeFaqResult({ id: 10, confidence: 0.85, title: "Borderline" }),
    ]);

    const result = await client.callTool({
      name: "get-faq",
      arguments: { query: "test", min_confidence: 0.9 },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    // 0.85 < 0.9, should be filtered out
    expect(text).toBe("No FAQ results found.");
  });
});

// ── Error handling ────────────────────────────────────────────────────────

describe("knowledge tool error handling", () => {
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    server = new McpServer({ name: "test-knowledge-errors", version: "1.0.0" });
    const embeddingClient = { embed: mockEmbed };
    registerKnowledgeTool(
      server as never,
      embeddingClient as never,
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

  it("returns error response on browse mode DB failure", async () => {
    mockGetFaqChunks.mockRejectedValueOnce(new Error("connection refused"));

    const result = await client.callTool({
      name: "get-faq",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("Error querying FAQ:");
    expect(text).toContain("connection refused");
  });

  it("returns error response on embedding failure in search mode", async () => {
    mockEmbed.mockRejectedValueOnce(new Error("API key invalid"));

    const result = await client.callTool({
      name: "get-faq",
      arguments: { query: "test" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("Error querying FAQ:");
    expect(text).toContain("API key invalid");
  });

  it("returns error response on searchChunks failure in search mode", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockRejectedValueOnce(new Error("query timeout"));

    const result = await client.callTool({
      name: "get-faq",
      arguments: { query: "test" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("Error querying FAQ:");
    expect(text).toContain("query timeout");
  });

  it("handles non-Error thrown values", async () => {
    mockGetFaqChunks.mockRejectedValueOnce("string error");

    const result = await client.callTool({
      name: "get-faq",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("string error");
  });
});
