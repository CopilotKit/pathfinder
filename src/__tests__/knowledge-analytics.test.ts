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
  getServerConfig: vi.fn(),
  getAnalyticsConfig: vi.fn(),
}));

import { registerKnowledgeTool } from "../mcp/tools/knowledge.js";
import {
  getFaqChunks,
  getFaqChunksByIds,
  searchChunks,
} from "../db/queries.js";
import { logQuery } from "../db/analytics.js";
import { getAnalyticsConfig } from "../config.js";

const mockGetFaqChunks = vi.mocked(getFaqChunks);
const mockGetFaqChunksByIds = vi.mocked(getFaqChunksByIds);
const mockSearchChunks = vi.mocked(searchChunks);
const mockLogQuery = vi.mocked(logQuery);
const mockGetAnalyticsConfig = vi.mocked(getAnalyticsConfig);
const mockEmbed = vi.fn();

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
    registerKnowledgeTool(
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

  it("logs browse-mode query when analytics enabled", async () => {
    mockGetAnalyticsConfig.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
    });
    mockGetFaqChunks.mockResolvedValueOnce([]);
    mockLogQuery.mockResolvedValueOnce(undefined);

    await client.callTool({ name: "faq", arguments: {} });
    await new Promise((r) => setTimeout(r, 10));

    expect(mockLogQuery).toHaveBeenCalledTimes(1);
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
    mockGetFaqChunks.mockResolvedValueOnce([]);
    mockLogQuery.mockResolvedValueOnce(undefined);

    await client.callTool({
      name: "faq",
      arguments: { query: "how to deploy" },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(mockLogQuery).toHaveBeenCalledTimes(1);
    const [entry] = mockLogQuery.mock.calls[0];
    expect(entry.query_text).toBe("how to deploy");
  });

  it("always logs even when analytics config is absent (logging is unconditional)", async () => {
    mockGetAnalyticsConfig.mockReturnValue(undefined);
    mockGetFaqChunks.mockResolvedValueOnce([]);
    mockLogQuery.mockResolvedValueOnce(undefined);

    await client.callTool({ name: "faq", arguments: {} });
    await new Promise((r) => setTimeout(r, 10));

    expect(mockLogQuery).toHaveBeenCalledTimes(1);
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
  // blanking the low-confidence card and the Avg Cosine column for this tool
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
      await new Promise((r) => setTimeout(r, 10));
      expect(mockLogQuery).toHaveBeenCalledTimes(1);
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
