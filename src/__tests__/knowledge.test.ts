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

// Mock the query layer. The search-mode path must look up FAQ metadata by the
// EXACT vector-result ids (getFaqChunksByIds), not by a relevance-blind
// indexed_at-ordered window. Search over-fetches candidates (effectiveLimit * 2)
// then resolves FAQ confidence/metadata by exact id, so a relevant hit can no
// longer be dropped just because its id falls outside a recency window.
vi.mock("../db/queries.js", () => ({
  getFaqChunks: vi.fn(),
  getFaqChunksByIds: vi.fn(),
  searchChunks: vi.fn(),
}));
vi.mock("../db/analytics.js", () => ({
  logQuery: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../config.js", () => ({
  getServerConfig: vi.fn().mockReturnValue({}),
  getAnalyticsConfig: vi.fn().mockReturnValue(undefined),
}));

import { registerKnowledgeTool } from "../mcp/tools/knowledge.js";
import {
  getFaqChunks,
  getFaqChunksByIds,
  searchChunks,
} from "../db/queries.js";

const mockGetFaqChunks = vi.mocked(getFaqChunks);
const mockGetFaqChunksByIds = vi.mocked(getFaqChunksByIds);
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
  default_limit: 2,
  max_limit: 100,
};

// ── Fix 3: relevance-blind FAQ window drop ─────────────────────────────────

describe("knowledge tool search mode — FAQ metadata fetched by result id", () => {
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    server = new McpServer({ name: "test-knowledge-byid", version: "1.0.0" });
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

  it("returns a high-similarity hit even when it is NOT among the most-recently-indexed FAQ rows", async () => {
    // limit defaults to 2. Top vector hit is id=9999 — a relevant chunk that a
    // relevance-blind indexed_at-DESC window would drop. The current path
    // resolves FAQ metadata by the EXACT result id instead, so the hit survives
    // regardless of how recently it was indexed.
    mockEmbed.mockResolvedValueOnce([0.1, 0.2, 0.3]);
    mockSearchChunks
      .mockResolvedValueOnce([makeChunkResult({ id: 9999, similarity: 0.97 })])
      .mockResolvedValueOnce([]);

    // The fix fetches metadata for EXACTLY the result ids.
    mockGetFaqChunksByIds.mockResolvedValueOnce([
      makeFaqResult({ id: 9999, confidence: 0.9, title: "Relevant Old FAQ" }),
    ]);

    const result = await client.callTool({
      name: "get-faq",
      arguments: { query: "how to auth" },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("Relevant Old FAQ");

    // It must look up by the exact result id, NOT use the windowed getFaqChunks.
    expect(mockGetFaqChunksByIds).toHaveBeenCalledTimes(1);
    const idsArg = mockGetFaqChunksByIds.mock.calls[0][0];
    expect(idsArg).toEqual([9999]);
    // The relevance-blind windowed getFaqChunks must NOT be used in search mode.
    expect(mockGetFaqChunks).not.toHaveBeenCalled();
  });

  it("preserves the confidence filter when merging by id", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks
      .mockResolvedValueOnce([
        makeChunkResult({ id: 10, similarity: 0.95 }),
        makeChunkResult({ id: 11, similarity: 0.9 }),
      ])
      .mockResolvedValueOnce([]);

    mockGetFaqChunksByIds.mockResolvedValueOnce([
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

  it("returns no results when none of the result ids have FAQ metadata", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks
      .mockResolvedValueOnce([makeChunkResult({ id: 99, similarity: 0.95 })])
      .mockResolvedValueOnce([]);
    mockGetFaqChunksByIds.mockResolvedValueOnce([]);

    const result = await client.callTool({
      name: "get-faq",
      arguments: { query: "unmatched" },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toBe("No FAQ results found.");
  });

  it("does not call getFaqChunksByIds when there are zero vector hits", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const result = await client.callTool({
      name: "get-faq",
      arguments: { query: "nothing" },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toBe("No FAQ results found.");
    // No ids to look up — skip the round-trip entirely.
    expect(mockGetFaqChunksByIds).not.toHaveBeenCalled();
  });

  // ── Fix: search-mode under-fill (slice-before-filter dropped below-confidence
  //    top-N hits with no backfill, returning fewer than `limit`) ────────────
  it("fills up to `limit` results by over-fetching when top-N hits are below confidence", async () => {
    // limit defaults to 2. The two HIGHEST-similarity hits (ids 1, 2) are
    // below the 0.7 confidence threshold; two MORE-confident hits (ids 3, 4)
    // exist just past the top-2 window. The old code sliced to the top-2
    // (ids 1, 2) BEFORE applying the confidence filter, dropped both, and
    // returned ZERO results. Over-fetching candidates first, filtering by
    // confidence, THEN slicing to `limit` must return 2 results.
    mockEmbed.mockResolvedValueOnce([0.1, 0.2, 0.3]);
    mockSearchChunks
      .mockResolvedValueOnce([
        makeChunkResult({ id: 1, similarity: 0.99 }),
        makeChunkResult({ id: 2, similarity: 0.98 }),
        makeChunkResult({ id: 3, similarity: 0.97 }),
        makeChunkResult({ id: 4, similarity: 0.96 }),
      ])
      .mockResolvedValueOnce([]);

    mockGetFaqChunksByIds.mockResolvedValueOnce([
      makeFaqResult({ id: 1, confidence: 0.2, title: "Low One" }),
      makeFaqResult({ id: 2, confidence: 0.3, title: "Low Two" }),
      makeFaqResult({ id: 3, confidence: 0.9, title: "Confident Three" }),
      makeFaqResult({ id: 4, confidence: 0.85, title: "Confident Four" }),
    ]);

    const result = await client.callTool({
      name: "get-faq",
      arguments: { query: "fill me up" },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    // Both confident-but-deeper hits must surface (2 == limit), not be dropped.
    expect(text).toContain("Confident Three");
    expect(text).toContain("Confident Four");
    expect(text).not.toContain("Low One");
    expect(text).not.toContain("Low Two");
    // Exactly `limit` Q&A blocks rendered.
    const qaBlocks = (text.match(/^Q&A \d+$/gm) ?? []).length;
    expect(qaBlocks).toBe(2);
  });

  it("still caps the final result count at `limit` when many confident hits exist", async () => {
    // All four hits are confident; the result must still be capped at limit=2.
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks
      .mockResolvedValueOnce([
        makeChunkResult({ id: 1, similarity: 0.99 }),
        makeChunkResult({ id: 2, similarity: 0.98 }),
        makeChunkResult({ id: 3, similarity: 0.97 }),
        makeChunkResult({ id: 4, similarity: 0.96 }),
      ])
      .mockResolvedValueOnce([]);

    mockGetFaqChunksByIds.mockResolvedValueOnce([
      makeFaqResult({ id: 1, confidence: 0.9, title: "Top One" }),
      makeFaqResult({ id: 2, confidence: 0.9, title: "Top Two" }),
      makeFaqResult({ id: 3, confidence: 0.9, title: "Top Three" }),
      makeFaqResult({ id: 4, confidence: 0.9, title: "Top Four" }),
    ]);

    const result = await client.callTool({
      name: "get-faq",
      arguments: { query: "cap me" },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    const qaBlocks = (text.match(/^Q&A \d+$/gm) ?? []).length;
    expect(qaBlocks).toBe(2);
    // The two highest-similarity confident hits win the cap.
    expect(text).toContain("Top One");
    expect(text).toContain("Top Two");
  });
});

// ── Fix 4: extractAnswer fallback ──────────────────────────────────────────

describe("knowledge tool — extractAnswer fallback handling", () => {
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    server = new McpServer({ name: "test-knowledge-answer", version: "1.0.0" });
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

  it("handles a leading 'A:' answer with no preceding newline", async () => {
    mockGetFaqChunks.mockResolvedValueOnce([
      makeFaqResult({
        // Content starts with the answer delimiter and no newline before it.
        content: "A: The answer with no preceding Q line.",
        title: "Direct answer",
        confidence: 0.9,
      }),
    ]);

    const result = await client.callTool({
      name: "get-faq",
      arguments: {},
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("ANSWER: The answer with no preceding Q line.");
    // The raw "A:" delimiter must not leak into the rendered answer.
    expect(text).not.toContain("ANSWER: A:");
  });

  it("logs a console.warn (with a chunk identifier) when the answer delimiter is absent (fallback)", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockGetFaqChunks.mockResolvedValueOnce([
      makeFaqResult({
        content: "Q: Only a question, no answer delimiter at all?",
        title: "No delimiter",
        // No source_url, so the identifier falls back to file_path.
        source_url: null,
        file_path: "C123:456:0",
        confidence: 0.9,
      }),
    ]);

    await client.callTool({ name: "get-faq", arguments: {} });

    // The fallback path must emit a console.warn (raised from console.debug) so
    // a malformed-content leak is visible at the default log level.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[knowledge] extractAnswer: no "A:" delimiter'),
    );
    // The warning includes a chunk identifier so the offending row is locatable.
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toContain("C123:456:0");

    debugSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
