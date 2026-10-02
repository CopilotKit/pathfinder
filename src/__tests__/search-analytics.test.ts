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
import type { SearchToolConfig } from "../types.js";
import { chunkResultFactory } from "./helpers/chunkFixtures.js";
import { mockQueriesModule } from "./helpers/queriesMock.js";

// Embed double for the provider createMcpServer builds through
// createEmbeddingProvider (mocked below). The registerSearchTool suites inject
// embeddingDouble / mockEmbed instead.
const { mockEmbedH } = vi.hoisted(() => ({ mockEmbedH: vi.fn() }));

// Mock dependencies. The retrievers are stubbed; everything else in
// ../db/queries.js stays real, so an export the tool handler needs (such as
// `isBelowCosineFloor`) cannot go missing from the double. See
// ./helpers/queriesMock.ts.
vi.mock("../db/queries.js", async (importOriginal) =>
  mockQueriesModule(importOriginal, {
    searchChunks: vi.fn(),
    textSearchChunks: vi.fn(),
    hybridSearchChunks: vi.fn(),
  }),
);
vi.mock("../db/analytics.js", () => ({
  logQuery: vi.fn(),
}));
vi.mock("../config.js", () => ({
  getConfig: vi.fn(),
  getServerConfig: vi.fn(),
  getAnalyticsConfig: vi.fn(),
}));
vi.mock("../indexing/embeddings.js", () => ({
  createEmbeddingProvider: vi.fn(() => ({ embed: mockEmbedH })),
}));

import {
  __resetRateLimitedWarnForTesting,
  type SessionAnalyticsContext,
} from "../request-context.js";
import {
  baseConfig,
  createMcpServerWith,
  expectSettledCallCount,
} from "./helpers/mcpServerFixtures.js";
import { registerSearchTool } from "../mcp/tools/search.js";
import { searchChunks } from "../db/queries.js";
import { logQuery } from "../db/analytics.js";
import { getAnalyticsConfig, getConfig, getServerConfig } from "../config.js";
import { ServerConfigSchema } from "../types.js";
import type { EmbeddingProvider } from "../indexing/embeddings.js";

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

// Shared factory, with this suite's own titles/paths. The cosine is derived
// from `similarity` in one place (see ./helpers/chunkFixtures.ts) so a fixture
// here cannot drift into a row searchChunks could not return.
const makeChunkResult = chunkResultFactory({
  source_url: null,
  title: "Title",
  content: "Content",
  file_path: "f.md",
});

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
    registerSearchTool(server, embeddingDouble, toolConfig);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  beforeEach(() => {
    vi.resetAllMocks();
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

    // logQuery is fire-and-forget; wait until it has been called.
    await expectSettledCallCount(mockLogQuery, 1);
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
    await expectSettledCallCount(mockLogQuery, 1);
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
    await expectSettledCallCount(mockLogQuery, 1);
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
    await expectSettledCallCount(mockLogQuery, 1);
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
    await expectSettledCallCount(mockLogQuery, 1);
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
    await expectSettledCallCount(mockLogQuery, 1);
    const [entry] = mockLogQuery.mock.calls[0];
    expect(entry.top_score).toBeCloseTo(0.95);
  });

  it("logs null session_id / request_source when no accessors are wired", async () => {
    // The default registration (no options) must still produce a valid row —
    // the writer defaults a null request_source to 'user', and session_id
    // stays null when there's no session context to thread.
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
    await expectSettledCallCount(mockLogQuery, 1);
    const [entry] = mockLogQuery.mock.calls[0];
    expect(entry.session_id).toBeNull();
    expect(entry.request_source).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// session_id + request_source threading from the MCP session context
//
// Regression for the observability gap: session_id was hardcoded null on every
// query_log row and there was no request-origin tag at all. The tool handler
// must thread both through from the accessors createMcpServer passes in
// (getSessionId from the transport, getRequestSource from X-Pathfinder-Source).
// ---------------------------------------------------------------------------

describe("search tool threads session_id and request_source into logQuery", () => {
  let client: Client;
  let server: McpServer;
  let currentSessionId: string | undefined;
  let currentRequestSource: string | undefined;

  beforeAll(async () => {
    server = new McpServer({ name: "test", version: "1.0.0" });
    registerSearchTool(server, embeddingDouble, toolConfig, {
      // Late-bound accessors, mirroring how server.ts wires the real ones:
      // the session id isn't known until the transport connects, and the
      // request source is captured from the init request header.
      getSessionId: () => currentSessionId,
      getRequestSource: () => currentRequestSource,
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  beforeEach(() => {
    vi.resetAllMocks();
    mockGetAnalyticsConfig.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
    });
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it("persists the resolved session_id (not null)", async () => {
    currentSessionId = "mcp-session-abc";
    currentRequestSource = "user";
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([makeChunkResult()]);
    mockLogQuery.mockResolvedValueOnce(undefined);

    await client.callTool({ name: "search-docs", arguments: { query: "q" } });
    await expectSettledCallCount(mockLogQuery, 1);
    const [entry] = mockLogQuery.mock.calls[0];
    expect(entry.session_id).toBe("mcp-session-abc");
  });

  it("persists the resolved request_source tag", async () => {
    currentSessionId = "mcp-session-xyz";
    currentRequestSource = "synthetic";
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([makeChunkResult()]);
    mockLogQuery.mockResolvedValueOnce(undefined);

    await client.callTool({ name: "search-docs", arguments: { query: "q" } });
    await expectSettledCallCount(mockLogQuery, 1);
    const [entry] = mockLogQuery.mock.calls[0];
    expect(entry.request_source).toBe("synthetic");
  });
});

describe("search tool threads the session analytics context into logQuery", () => {
  const ctx: SessionAnalyticsContext = {
    transport: "sse",
    protocol_era: "legacy",
    protocol_version: "2025-03-26",
    client_name: "ctx-client",
    auth_client_id: "client-123",
  };
  const NULL_CONTEXT_FIELDS = {
    transport: null,
    protocol_era: null,
    protocol_version: null,
    client_name: null,
    auth_client_id: null,
  };
  let withCtxClient: Client;
  let withCtxServer: McpServer;
  let noCtxClient: Client;
  let noCtxServer: McpServer;
  let accessorCalls = 0;
  let currentCtx: SessionAnalyticsContext | undefined = ctx;
  let accessorThrows = false;
  /** A named class, so the tests can check the warning names it. */
  class AccessorBoom extends Error {}
  const ACCESSOR_WARNING = "[analytics] getAnalyticsContext threw AccessorBoom";

  async function connect(
    options?: Parameters<typeof registerSearchTool>[3],
  ): Promise<{ client: Client; server: McpServer }> {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerSearchTool(server, embeddingDouble, toolConfig, options);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
    return { client, server };
  }

  beforeAll(async () => {
    ({ client: withCtxClient, server: withCtxServer } = await connect({
      getAnalyticsContext: () => {
        accessorCalls++;
        if (accessorThrows) throw new AccessorBoom("accessor boom");
        return currentCtx;
      },
    }));
    ({ client: noCtxClient, server: noCtxServer } = await connect());
  });

  beforeEach(() => {
    vi.resetAllMocks();
    accessorCalls = 0;
    currentCtx = ctx;
    accessorThrows = false;
    // The accessor warning is rate-limited per process; start each test with
    // a clear limiter so a throwing test can see its own warning.
    __resetRateLimitedWarnForTesting();
    mockGetAnalyticsConfig.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
    });
    mockLogQuery.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await withCtxClient.close();
    await withCtxServer.close();
    await noCtxClient.close();
    await noCtxServer.close();
  });

  it("normal path carries the 5 context values", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([makeChunkResult()]);

    await withCtxClient.callTool({
      name: "search-docs",
      arguments: { query: "q" },
    });
    await expectSettledCallCount(mockLogQuery, 1);
    const [entry] = mockLogQuery.mock.calls[0];
    expect(entry).toMatchObject(ctx);
    expect(accessorCalls).toBe(1);
  });

  it("blocked path carries the 5 context values", async () => {
    await withCtxClient.callTool({
      name: "search-docs",
      arguments: { query: "toy story 5 box office" },
    });
    await expectSettledCallCount(mockLogQuery, 1);
    const [entry] = mockLogQuery.mock.calls[0];
    expect(entry.blocked).toBe(true);
    expect(entry).toMatchObject(ctx);
    expect(accessorCalls).toBe(1);
  });

  it("an accessor returning undefined gives null for each field", async () => {
    currentCtx = undefined;
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([makeChunkResult()]);

    await withCtxClient.callTool({
      name: "search-docs",
      arguments: { query: "q" },
    });
    await expectSettledCallCount(mockLogQuery, 1);
    const [entry] = mockLogQuery.mock.calls[0];
    expect(entry).toMatchObject(NULL_CONTEXT_FIELDS);
    // The nulls come from reading the accessor, not from skipping it.
    expect(accessorCalls).toBe(1);
  });

  it("a throwing accessor still returns the search results, with null context fields", async () => {
    accessorThrows = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mockEmbed.mockResolvedValueOnce([0.1]);
      mockSearchChunks.mockResolvedValueOnce([makeChunkResult()]);

      const result = await withCtxClient.callTool({
        name: "search-docs",
        arguments: { query: "q" },
      });
      await expectSettledCallCount(mockLogQuery, 1);

      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).not.toMatch(/Search failed/);
      const [entry] = mockLogQuery.mock.calls[0];
      expect(entry).toMatchObject(NULL_CONTEXT_FIELDS);
      // The nulls come from the accessor throwing, and the failure is logged.
      expect(accessorCalls).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(ACCESSOR_WARNING),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("a throwing accessor still returns the blocked payload, with null context fields", async () => {
    accessorThrows = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await withCtxClient.callTool({
        name: "search-docs",
        arguments: { query: "toy story 5 box office" },
      });
      await expectSettledCallCount(mockLogQuery, 1);

      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(JSON.parse(text)).toMatchObject({ blocked: true });
      const [entry] = mockLogQuery.mock.calls[0];
      expect(entry.blocked).toBe(true);
      expect(entry).toMatchObject(NULL_CONTEXT_FIELDS);
      // The nulls come from the accessor throwing, and the failure is logged.
      expect(accessorCalls).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(ACCESSOR_WARNING),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("absent accessor gives null for each field on the normal path", async () => {
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([makeChunkResult()]);

    await noCtxClient.callTool({
      name: "search-docs",
      arguments: { query: "q" },
    });
    await expectSettledCallCount(mockLogQuery, 1);
    const [entry] = mockLogQuery.mock.calls[0];
    expect(entry).toMatchObject(NULL_CONTEXT_FIELDS);
  });

  it("absent accessor gives null for each field on the blocked path", async () => {
    await noCtxClient.callTool({
      name: "search-docs",
      arguments: { query: "toy story 5 box office" },
    });
    await expectSettledCallCount(mockLogQuery, 1);
    const [entry] = mockLogQuery.mock.calls[0];
    expect(entry.blocked).toBe(true);
    expect(entry).toMatchObject(NULL_CONTEXT_FIELDS);
  });
});

describe("createMcpServer threads getAnalyticsContext to the search tool", () => {
  it("a search call's logQuery payload carries the context values", async () => {
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
        sources: [
          {
            name: "docs",
            type: "markdown",
            path: "docs",
            file_patterns: ["**/*.md"],
          },
        ],
        tools: [toolConfig],
      }),
    );
    mockGetAnalyticsConfig.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
    });
    mockEmbedH.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([makeChunkResult()]);
    mockLogQuery.mockResolvedValueOnce(undefined);

    const server = createMcpServerWith({ getAnalyticsContext: () => ctx });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
    try {
      await client.callTool({ name: "search-docs", arguments: { query: "q" } });
      await expectSettledCallCount(mockLogQuery, 1);
      const [entry] = mockLogQuery.mock.calls[0];
      expect(entry).toMatchObject(ctx);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
