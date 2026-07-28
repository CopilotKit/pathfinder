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
import { makeChunkResult, makeKeywordResult } from "./helpers/chunkFixtures.js";
import { mockQueriesModule } from "./helpers/queriesMock.js";

// The real module, with only the three retrievers stubbed. Listing the stubs by
// hand (the shape this used to have) silently omitted `isBelowCosineFloor`,
// which src/mcp/tools/search.ts imports — so no `min_score` case could be added
// to this suite without an opaque "no such export on the mock" failure. See
// ./helpers/queriesMock.ts.
vi.mock("../db/queries.js", async (importOriginal) =>
  mockQueriesModule(importOriginal, {
    searchChunks: vi.fn(),
    textSearchChunks: vi.fn(),
    hybridSearchChunks: vi.fn(),
  }),
);
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
import { logQuery } from "../db/analytics.js";

const mockSearchChunks = vi.mocked(searchChunks);
const mockTextSearchChunks = vi.mocked(textSearchChunks);
const mockHybridSearchChunks = vi.mocked(hybridSearchChunks);
const mockLogQuery = vi.mocked(logQuery);
const mockEmbed = vi.fn();

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
      // onCosineMeasured: the observer through which the retriever reports the
      // best cosine it measured BEFORE the floor was applied, so query_log's
      // top_score records a measurement rather than a summary of the survivors.
      // See maxCosineScore in src/relevance.ts.
      expect.any(Function),
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
      expect.any(Function), // onCosineMeasured — see the test above
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
    // Drop the throwing embed implementation one of the tests below installs,
    // so it cannot leak into the vector-mode block that runs after this one.
    mockEmbed.mockReset();
    await client.close();
    await server.close();
  });

  it("calls textSearchChunks without embedding", async () => {
    mockTextSearchChunks.mockResolvedValueOnce([
      makeKeywordResult({ title: "Keyword Result" }),
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

  it("neither forwards min_score to textSearchChunks nor filters the rows on it", async () => {
    // What "min_score is ignored in keyword mode" can actually be OBSERVED to
    // mean — the previous version of this test asserted something unfalsifiable.
    // A keyword row carries `cosine_similarity: null` by contract (see
    // makeKeywordResult) and `isBelowCosineFloor` never excludes a null cosine,
    // so NO keyword row is excludable by the floor and "it was not excluded"
    // holds no matter what the handler does. Two things here are falsifiable:
    //
    //   1. the floor never reaches the retriever at all. `toHaveBeenCalledWith`
    //      is an exact argument-list match, so threading `min_score` through as
    //      a 5th argument fails it; and
    //   2. the row survives even though its RANKING score (0.01, a ts_rank) is
    //      two orders of magnitude under the requested floor — which is what
    //      fails if anyone ever "applies" min_score in keyword mode by
    //      comparing it against `similarity`, the one field it would fit.
    mockTextSearchChunks.mockResolvedValueOnce([
      makeKeywordResult({ similarity: 0.01, title: "Low Rank" }),
    ]);

    const result = await client.callTool({
      name: "search-keyword",
      arguments: { query: "test", min_score: 0.9 },
    });

    expect(mockTextSearchChunks).toHaveBeenCalledWith(
      "test",
      5,
      "docs",
      undefined,
    );
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("Low Rank");
    // And what gets recorded is the ABSENCE of a relevance score, not the
    // ts_rank: no cosine was measured anywhere in a keyword-only request, and
    // logging 0.01 here would read as a catastrophically bad cosine.
    expect(mockLogQuery.mock.calls[0][0].top_score).toBeNull();
  });

  it("keyword mode succeeds even when the embedding client throws", async () => {
    // The claim needs an embedding client that WOULD fail. Left unconfigured
    // (as this test was), `mockEmbed` resolves `undefined` and never throws, so
    // "keyword mode does not embed" and "keyword mode embeds successfully" are
    // indistinguishable and the test passes either way. Throwing synchronously
    // makes any embed call on this path a hard failure.
    mockEmbed.mockImplementation(() => {
      throw new Error("embedding provider unavailable");
    });
    mockTextSearchChunks.mockResolvedValueOnce([
      makeKeywordResult({ title: "Found it" }),
    ]);

    const result = await client.callTool({
      name: "search-keyword",
      arguments: { query: "error code 42" },
    });

    expect(result.isError).toBeFalsy();
    expect(mockEmbed).not.toHaveBeenCalled();
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("Found it");
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

  it("applies min_score through the real cosine-floor predicate", async () => {
    // The case this suite could not express until the queries mock spread the
    // real module: `isBelowCosineFloor` lives in ../db/queries.js and the
    // handler calls it, so under the old hand-listed mock this test died on
    // vitest's "No 'isBelowCosineFloor' export is defined on the mock" instead
    // of exercising the floor. See ./helpers/queriesMock.ts.
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([
      makeChunkResult({ similarity: 0.8, title: "Above" }),
      makeChunkResult({ similarity: 0.2, title: "Below" }),
      // A degenerate vector row: pgvector's `<=>` is NaN for a zero-norm
      // embedding, so the cosine is null while the ranking score survives.
      makeChunkResult({
        similarity: 0.9,
        cosine_similarity: null,
        title: "Unmeasured",
      }),
    ]);

    const result = await client.callTool({
      name: "search-default",
      arguments: { query: "test", min_score: 0.5 },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("Above");
    expect(text).not.toContain("Below");
    // Unknown relevance is not sub-floor relevance, so the floor keeps it.
    expect(text).toContain("Unmeasured");
    // And the score recorded is the best COSINE (0.8), not the best RANKING
    // score — the degenerate row carries `similarity: 0.9` with no cosine at
    // all, so a handler reading the wrong field would log 0.9 here.
    expect(mockLogQuery.mock.calls[0][0].top_score).toBeCloseTo(0.8);
  });
});
