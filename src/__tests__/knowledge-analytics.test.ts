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
  ChunkResult,
  FaqChunkResult,
} from "../types.js";

vi.mock("../db/queries.js", () => ({
  getFaqChunks: vi.fn(),
  getFaqChunksByIds: vi.fn(),
  searchChunks: vi.fn(),
}));
vi.mock("../db/analytics.js", () => ({
  logQuery: vi.fn(),
}));
vi.mock("../config.js", () => ({
  getConfig: vi.fn(),
  getServerConfig: vi.fn(),
  getAnalyticsConfig: vi.fn(),
}));
vi.mock("../indexing/embeddings.js", () => ({
  createEmbeddingProvider: vi.fn(() => ({ embed: vi.fn() })),
}));

import { registerKnowledgeTool } from "../mcp/tools/knowledge.js";
import {
  __resetRateLimitedWarnForTesting,
  type SessionAnalyticsContext,
} from "../request-context.js";
import {
  baseConfig,
  createMcpServerWith,
  expectSettledCallCount,
} from "./helpers/mcpServerFixtures.js";
import {
  getFaqChunks,
  getFaqChunksByIds,
  searchChunks,
} from "../db/queries.js";
import { logQuery } from "../db/analytics.js";
import { getAnalyticsConfig, getConfig, getServerConfig } from "../config.js";
import { ServerConfigSchema } from "../types.js";
import type { EmbeddingProvider } from "../indexing/embeddings.js";

const mockGetFaqChunks = vi.mocked(getFaqChunks);
const mockGetFaqChunksByIds = vi.mocked(getFaqChunksByIds);
const mockSearchChunks = vi.mocked(searchChunks);
const mockLogQuery = vi.mocked(logQuery);
const mockGetAnalyticsConfig = vi.mocked(getAnalyticsConfig);
const mockEmbed = vi.fn();
const embeddingDouble: EmbeddingProvider = {
  embed: mockEmbed,
  embedBatch: vi.fn(),
};
const mockGetConfig = vi.mocked(getConfig);
const mockGetServerConfig = vi.mocked(getServerConfig);

/**
 * A vector candidate as `searchChunks` really returns it: `similarity` and
 * `cosine_similarity` hold the SAME number, because in vector mode the ranking
 * score IS the cosine. `cosine` can be overridden to `null` to model the row
 * `toCosineScoreOrNull` produces for a corrupt (non-finite) distance.
 */
function candidate(
  id: number,
  similarity: number,
  cosine: number | null = similarity,
): ChunkResult {
  return {
    id,
    source_name: "slack-faq",
    source_url: `https://faq.example.com/${id}`,
    title: `Q${id}`,
    content: `Q: q${id}\n\nA: a${id}`,
    repo_url: null,
    file_path: `faq/${id}.md`,
    start_line: null,
    end_line: null,
    language: null,
    similarity,
    cosine_similarity: cosine,
  };
}

/**
 * FAQ metadata as `getFaqChunksByIds` really returns it. The `cosine_similarity:
 * null` is NOT incidental: that query SELECTs `0.0 AS similarity` and compares
 * no embedding, so it has no cosine of its own (see src/db/queries.ts). The
 * knowledge tool's search path is the only thing that puts a real cosine on
 * these rows, which is exactly why this fixture must not hand it one for free.
 */
function faqRow(id: number, confidence: number): FaqChunkResult {
  return {
    ...candidate(id, 0, null),
    metadata: { confidence },
    confidence,
  };
}

const toolConfig: KnowledgeToolConfig = {
  name: "faq",
  type: "knowledge",
  description: "FAQ",
  sources: ["slack-faq"],
  min_confidence: 0.7,
  default_limit: 20,
  max_limit: 100,
};

describe("knowledge tool analytics instrumentation", () => {
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    server = new McpServer({ name: "test", version: "1.0.0" });
    registerKnowledgeTool(server, embeddingDouble, toolConfig);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    client = new Client({ name: "tc", version: "1.0.0" });
    await client.connect(ct);
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it("logs browse-mode query when analytics enabled", async () => {
    mockGetAnalyticsConfig.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
    });
    mockGetFaqChunks.mockResolvedValueOnce([]);
    mockLogQuery.mockResolvedValueOnce(undefined);

    await client.callTool({ name: "faq", arguments: {} });
    await expectSettledCallCount(mockLogQuery, 1);
    const [entry] = mockLogQuery.mock.calls[0];
    expect(entry.query_text).toBe("<browse>");
    expect(entry.tool_name).toBe("faq");
  });

  it("logs search-mode query with actual query text", async () => {
    mockGetAnalyticsConfig.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
    });
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([]);
    mockLogQuery.mockResolvedValueOnce(undefined);

    await client.callTool({
      name: "faq",
      arguments: { query: "how to deploy" },
    });
    await expectSettledCallCount(mockLogQuery, 1);
    const [entry] = mockLogQuery.mock.calls[0];
    expect(entry.query_text).toBe("how to deploy");
  });

  it("always logs even when analytics config is absent (logging is unconditional)", async () => {
    mockGetAnalyticsConfig.mockReturnValue(undefined);
    mockGetFaqChunks.mockResolvedValueOnce([]);
    mockLogQuery.mockResolvedValueOnce(undefined);

    await client.callTool({ name: "faq", arguments: {} });
    await expectSettledCallCount(mockLogQuery, 1);
    const [, logText] = mockLogQuery.mock.calls[0];
    expect(logText).toBe(true);
  });

  // -------------------------------------------------------------------------
  // query_log.top_score on the knowledge SEARCH path.
  //
  // The knowledge tool is the ONLY tool that has to reconstruct the cosine
  // itself: the ranked candidates come from searchChunks (which carries a
  // cosine), but the rows it actually returns come from getFaqChunksByIds
  // (which carries none — it SELECTs `0.0 AS similarity` and compares no
  // embedding). The merge in src/mcp/tools/knowledge.ts copies the candidate's
  // cosine onto the FAQ row, and topCosineScore reduces over that field. Drop
  // either half and every knowledge query silently logs top_score = NULL,
  // blanking the low-confidence metric and the Avg Cosine column for this tool
  // while the tool's own output looks perfectly correct. Nothing else in the
  // suite reads top_score on this path, so these tests are the only thing
  // standing between that regression and production.
  // -------------------------------------------------------------------------
  describe("search-mode top_score", () => {
    beforeEach(() => {
      mockGetAnalyticsConfig.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
      });
      mockEmbed.mockResolvedValue([0.1]);
      mockLogQuery.mockResolvedValue(undefined);
    });

    /** Run a search-mode call and hand back the logged query_log entry. */
    async function callAndGetEntry(args: Record<string, unknown> = {}) {
      await client.callTool({
        name: "faq",
        arguments: { query: "how to deploy", ...args },
      });
      await expectSettledCallCount(mockLogQuery, 1);
      return mockLogQuery.mock.calls[0][0];
    }

    it("logs the best cosine across the merged rows, not NULL", async () => {
      mockSearchChunks.mockResolvedValueOnce([
        candidate(1, 0.42),
        candidate(2, 0.88),
      ]);
      mockGetFaqChunksByIds.mockResolvedValueOnce([
        faqRow(1, 0.9),
        faqRow(2, 0.95),
      ]);

      const entry = await callAndGetEntry();

      expect(entry.result_count).toBe(2);
      // The cosine has to survive the FAQ-metadata merge to get here.
      expect(entry.top_score).toBe(0.88);
    });

    it("skips a candidate whose cosine was unmeasurable instead of falling back to its ranking score", async () => {
      // Row 1 outranks row 2 but its cosine came back corrupt (pgvector
      // returns a non-finite distance for a zero-norm embedding, which
      // toCosineScoreOrNull maps to null). A reducer over `similarity` would
      // log 0.99; the contract says the best *cosine* is 0.55.
      mockSearchChunks.mockResolvedValueOnce([
        candidate(1, 0.99, null),
        candidate(2, 0.55),
      ]);
      mockGetFaqChunksByIds.mockResolvedValueOnce([
        faqRow(1, 0.9),
        faqRow(2, 0.9),
      ]);

      const entry = await callAndGetEntry();

      expect(entry.result_count).toBe(2);
      expect(entry.top_score).toBe(0.55);
    });

    it("logs NULL — not 0 — when no merged row carries a measurable cosine", async () => {
      // Absence of a score is not a low score: on the [-1, 1] cosine scale a
      // 0 fallback is indistinguishable from a genuine orthogonal hit and
      // would be counted as low-confidence traffic.
      mockSearchChunks.mockResolvedValueOnce([
        candidate(1, 0.8, null),
        candidate(2, 0.7, null),
      ]);
      mockGetFaqChunksByIds.mockResolvedValueOnce([
        faqRow(1, 0.9),
        faqRow(2, 0.9),
      ]);

      const entry = await callAndGetEntry();

      expect(entry.result_count).toBe(2);
      expect(entry.top_score).toBeNull();
    });

    it("ignores a candidate filtered out by the confidence threshold", async () => {
      // Row 1 has the best cosine but is dropped for low confidence, so it is
      // not part of what the caller was shown and must not be what we score.
      mockSearchChunks.mockResolvedValueOnce([
        candidate(1, 0.97),
        candidate(2, 0.61),
      ]);
      mockGetFaqChunksByIds.mockResolvedValueOnce([
        faqRow(1, 0.2), // below toolConfig.min_confidence (0.7)
        faqRow(2, 0.9),
      ]);

      const entry = await callAndGetEntry();

      expect(entry.result_count).toBe(1);
      expect(entry.top_score).toBe(0.61);
    });

    it("scores the returned slice, not the whole qualifying pool", async () => {
      // limit=1 keeps only row 1, whose cosine is unmeasurable. Row 2 has a
      // real cosine but was sliced off, so it never reached the caller and
      // must not be reported as this query's score.
      mockSearchChunks.mockResolvedValueOnce([
        candidate(1, 0.9, null),
        candidate(2, 0.8),
      ]);
      mockGetFaqChunksByIds.mockResolvedValueOnce([
        faqRow(1, 0.9),
        faqRow(2, 0.9),
      ]);

      const entry = await callAndGetEntry({ limit: 1 });

      expect(entry.result_count).toBe(1);
      expect(entry.top_score).toBeNull();
    });
  });
});

describe("knowledge tool session analytics context", () => {
  // Arbitrary values: the tool passes the context through unchanged.
  const ctx: SessionAnalyticsContext = {
    transport: "sse",
    protocol_era: "legacy",
    protocol_version: "2025-06-18",
    client_name: "claude-code",
    auth_client_id: "client-abc",
  };

  const NULL_FIELDS = {
    transport: null,
    protocol_era: null,
    protocol_version: null,
    client_name: null,
    auth_client_id: null,
  };

  async function connect(
    options?: Parameters<typeof registerKnowledgeTool>[3],
  ): Promise<{ client: Client; server: McpServer }> {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerKnowledgeTool(server, embeddingDouble, toolConfig, options);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "tc", version: "1.0.0" });
    await client.connect(ct);
    return { client, server };
  }

  /** Connect, run `body`, and always close the pair, even when it throws. */
  async function withConnected(
    options: Parameters<typeof registerKnowledgeTool>[3] | undefined,
    body: (client: Client) => Promise<void>,
  ): Promise<void> {
    const { client, server } = await connect(options);
    try {
      await body(client);
    } finally {
      await client.close();
      await server.close();
    }
  }

  const paths: Array<{
    name: string;
    args: { query?: string };
    arrange: () => void;
    // What the logged row must look like, so each case proves WHICH
    // logQuery call site wrote it, not just that some row carried the context.
    expected: {
      query_text: string;
      blocked: boolean;
      block_reason: string | null;
    };
  }> = [
    {
      // "box office" matches the movie-box-office blocklist pattern
      // (src/mcp/abuse-blocklist.ts), so the handler logs and returns before
      // any embed or retrieval. That is why nothing is arranged.
      name: "blocked",
      args: { query: "box office" },
      arrange: () => {},
      expected: {
        query_text: "box office",
        blocked: true,
        block_reason: "pattern:movie-box-office",
      },
    },
    {
      name: "browse",
      args: {},
      arrange: () => mockGetFaqChunks.mockResolvedValueOnce([]),
      expected: { query_text: "<browse>", blocked: false, block_reason: null },
    },
    {
      // One candidate with matching FAQ metadata, so the merge and slice run
      // before logQuery.
      name: "search",
      args: { query: "how to deploy" },
      arrange: () => {
        mockEmbed.mockResolvedValueOnce([0.1]);
        mockSearchChunks.mockResolvedValueOnce([candidate(1, 0.8)]);
        mockGetFaqChunksByIds.mockResolvedValueOnce([faqRow(1, 0.9)]);
      },
      expected: {
        query_text: "how to deploy",
        blocked: false,
        block_reason: null,
      },
    },
  ];

  /** A named class, so the tests can check the warning names it. */
  class AccessorBoom extends Error {}
  const ACCESSOR_WARNING = "[analytics] getAnalyticsContext threw AccessorBoom";

  beforeEach(() => {
    vi.resetAllMocks();
    // The accessor warning is rate-limited per process; start each test with
    // a clear limiter so a throwing test can see its own warning.
    __resetRateLimitedWarnForTesting();
    mockGetAnalyticsConfig.mockReturnValue(undefined);
    mockLogQuery.mockResolvedValue(undefined);
  });

  for (const p of paths) {
    it(`${p.name} path carries the analytics context when the accessor is given`, async () => {
      await withConnected(
        { getAnalyticsContext: () => ctx },
        async (client) => {
          p.arrange();
          await client.callTool({ name: "faq", arguments: p.args });
          await expectSettledCallCount(mockLogQuery, 1);
          const [entry] = mockLogQuery.mock.calls[0];
          expect(entry).toMatchObject(p.expected);
          expect(entry).toMatchObject(ctx);
        },
      );
    });

    it(`${p.name} path still succeeds with null fields when the accessor throws`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let accessorCalls = 0;
      try {
        await withConnected(
          {
            getAnalyticsContext: () => {
              accessorCalls++;
              throw new AccessorBoom("accessor boom");
            },
          },
          async (client) => {
            p.arrange();
            const result = await client.callTool({
              name: "faq",
              arguments: p.args,
            });
            await expectSettledCallCount(mockLogQuery, 1);

            expect(result.isError).toBeFalsy();
            const text = (result.content as Array<{ text: string }>)[0].text;
            expect(text).not.toMatch(/Error querying FAQ/);
            if (p.name === "blocked") {
              expect(JSON.parse(text)).toMatchObject({ blocked: true });
            }
            const [entry] = mockLogQuery.mock.calls[0];
            expect(entry).toMatchObject(p.expected);
            expect(entry).toMatchObject(NULL_FIELDS);
            // The nulls come from the accessor throwing, and the failure is
            // logged with the error's class name.
            expect(accessorCalls).toBe(1);
            expect(warn).toHaveBeenCalledWith(
              expect.stringContaining(ACCESSOR_WARNING),
            );
          },
        );
      } finally {
        warn.mockRestore();
      }
    });

    it(`${p.name} path writes null for all five fields when no accessor is given`, async () => {
      await withConnected(undefined, async (client) => {
        p.arrange();
        await client.callTool({ name: "faq", arguments: p.args });
        await expectSettledCallCount(mockLogQuery, 1);
        const [entry] = mockLogQuery.mock.calls[0];
        expect(entry).toMatchObject(p.expected);
        expect(entry).toMatchObject(NULL_FIELDS);
      });
    });

    it(`${p.name} path reads the context per call, not at registration`, async () => {
      // The SSE /messages handler (src/sse-handlers.ts) records the
      // handshake only after it accepts the initialize, and the context
      // changes after that. A context read at registration, or read once and
      // cached, would be stale. Two calls with different contexts on ONE
      // server prove each row reads it fresh.
      const secondCtx: SessionAnalyticsContext = {
        transport: "streamable_http",
        protocol_era: "modern",
        protocol_version: "2025-11-25",
        client_name: "second-client",
        auth_client_id: "client-second",
      };
      let currentCtx: SessionAnalyticsContext | undefined = undefined;
      let accessorCalls = 0;
      await withConnected(
        {
          getAnalyticsContext: () => {
            accessorCalls++;
            return currentCtx;
          },
        },
        async (client) => {
          expect(accessorCalls).toBe(0);

          currentCtx = ctx;
          p.arrange();
          await client.callTool({ name: "faq", arguments: p.args });
          await expectSettledCallCount(mockLogQuery, 1);

          currentCtx = secondCtx;
          p.arrange();
          await client.callTool({ name: "faq", arguments: p.args });
          await expectSettledCallCount(mockLogQuery, 2);

          const [first] = mockLogQuery.mock.calls[0];
          const [second] = mockLogQuery.mock.calls[1];
          expect(first).toMatchObject(p.expected);
          expect(first).toMatchObject(ctx);
          expect(second).toMatchObject(p.expected);
          expect(second).toMatchObject(secondCtx);
          expect(accessorCalls).toBe(2);
        },
      );
    });
  }

  it("writes nulls when the accessor returns undefined", async () => {
    let accessorCalls = 0;
    await withConnected(
      {
        getAnalyticsContext: () => {
          accessorCalls++;
          return undefined;
        },
      },
      async (client) => {
        mockGetFaqChunks.mockResolvedValueOnce([]);
        await client.callTool({ name: "faq", arguments: {} });
        await expectSettledCallCount(mockLogQuery, 1);
        const [entry] = mockLogQuery.mock.calls[0];
        expect(entry).toMatchObject(NULL_FIELDS);
        // The nulls come from reading the accessor, not from skipping it.
        expect(accessorCalls).toBe(1);
      },
    );
  });
});

describe("createMcpServer threads getAnalyticsContext to the knowledge tool", () => {
  it("a knowledge call's logQuery payload carries the context values", async () => {
    vi.resetAllMocks();
    const ctx: SessionAnalyticsContext = {
      transport: "streamable_http",
      protocol_era: "modern",
      protocol_version: "2025-11-25",
      client_name: "factory-client",
      auth_client_id: "client-factory",
    };
    mockGetConfig.mockReturnValue({ ...baseConfig, openaiApiKey: "k" });
    mockGetServerConfig.mockReturnValue(
      ServerConfigSchema.parse({
        server: { name: "test", version: "1.0.0" },
        embedding: { provider: "openai", model: "m", dimensions: 1 },
        sources: [{ name: "slack-faq", type: "slack", channels: ["C1"] }],
        tools: [toolConfig],
      }),
    );
    mockGetAnalyticsConfig.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
    });
    mockGetFaqChunks.mockResolvedValueOnce([]);
    mockLogQuery.mockResolvedValueOnce(undefined);

    const server = createMcpServerWith({ getAnalyticsContext: () => ctx });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
    try {
      await client.callTool({ name: "faq", arguments: {} });
      await expectSettledCallCount(mockLogQuery, 1);
      const [entry] = mockLogQuery.mock.calls[0];
      expect(entry).toMatchObject(ctx);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
