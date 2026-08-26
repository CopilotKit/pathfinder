import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterAll,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SearchToolConfig, ChunkResult } from "../types.js";

// -----------------------------------------------------------------------------
// Scale integrity of query_log.top_score.
//
// Retrieval produces two numbers per result on two different scales:
// `similarity` (a per-retriever RANKING score) and `cosine_similarity` (a 0-1
// RELEVANCE score). Persisting the former broke every score-based analytic:
// in hybrid mode `similarity` is a Reciprocal Rank Fusion score whose ceiling
// is 2/(RRF_K+1) ≈ 0.0328, so a perfect match logged ~0.016 against a 0.5
// low-confidence threshold and EVERY scored query was flagged.
//
// These tests pin the invariant that keeps the two scales from being confused
// again, at three levels: the reducer, the live tool -> logQuery path (driven
// through the REAL rrfMerge), and the SQL readers against real Postgres.
// -----------------------------------------------------------------------------

vi.mock("../db/analytics.js", async () => {
  const actual =
    await vi.importActual<typeof import("../db/analytics.js")>(
      "../db/analytics.js",
    );
  return { ...actual, logQuery: vi.fn().mockResolvedValue(undefined) };
});
vi.mock("../config.js", () => ({
  getServerConfig: vi.fn().mockReturnValue({}),
  getAnalyticsConfig: vi.fn().mockReturnValue({ log_queries: true }),
}));

import { rrfMerge, RRF_K } from "../db/queries.js";
import {
  topCosineScore,
  COSINE_SCORE_KIND,
  COSINE_SCORE_MAX,
} from "../relevance.js";
import {
  LOW_CONFIDENCE_SCORE_THRESHOLD,
  logQuery,
  getAnalyticsSummary,
  getTopQueries,
} from "../db/analytics.js";
import { generatePostSchemaMigration } from "../db/schema.js";
import { __setPoolForTesting, __resetPoolForTesting } from "../db/client.js";
import { registerSearchTool } from "../mcp/tools/search.js";

const mockLogQuery = vi.mocked(logQuery);

/** Highest score the RRF ranking scale can ever produce: rank 1 in BOTH lists. */
const MAX_RRF_SCORE = 2 / (RRF_K + 1);

function makeChunk(
  id: number,
  cosine: number | null,
  overrides: Partial<ChunkResult> = {},
): ChunkResult {
  return {
    id,
    source_name: "docs",
    source_url: `https://docs.example.com/${id}`,
    title: `Doc ${id}`,
    content: `Content ${id}`,
    repo_url: null,
    file_path: `docs/${id}.md`,
    start_line: null,
    end_line: null,
    language: null,
    // A vector row's ranking score IS its cosine; a keyword row's is a ts_rank.
    similarity: cosine ?? 0.04,
    cosine_similarity: cosine,
    ...overrides,
  };
}

// ── The scale invariant itself ───────────────────────────────────────────────

describe("low-confidence threshold and the metric it is compared against", () => {
  it("is derived from the cosine scale, not hard-coded onto it", () => {
    expect(LOW_CONFIDENCE_SCORE_THRESHOLD).toBe(COSINE_SCORE_MAX * 0.5);
    expect(LOW_CONFIDENCE_SCORE_THRESHOLD).toBeGreaterThan(0);
    expect(LOW_CONFIDENCE_SCORE_THRESHOLD).toBeLessThanOrEqual(
      COSINE_SCORE_MAX,
    );
  });

  it("sits far above the RRF ranking ceiling, so an RRF score can never be a valid input", () => {
    // This is the arithmetic of the original bug stated as an assertion: the
    // best possible RRF score (rank 1 in both retrievers) is still an order of
    // magnitude below the threshold. Any metric bounded by MAX_RRF_SCORE would
    // classify 100% of scored queries as low-confidence, so the threshold and
    // a fusion score cannot legally share a column.
    expect(MAX_RRF_SCORE).toBeLessThan(LOW_CONFIDENCE_SCORE_THRESHOLD / 10);
  });
});

// ── The reducer ──────────────────────────────────────────────────────────────

describe("topCosineScore", () => {
  it("returns the highest cosine, ignoring the ranking score", () => {
    const results = [
      makeChunk(1, 0.42, { similarity: 0.0328 }),
      makeChunk(2, 0.81, { similarity: 0.0164 }),
    ];
    expect(topCosineScore(results)).toBeCloseTo(0.81);
  });

  it("returns null for an empty result set", () => {
    expect(topCosineScore([])).toBeNull();
  });

  it("returns null when every row is keyword-only (no comparable score)", () => {
    expect(topCosineScore([makeChunk(1, null), makeChunk(2, null)])).toBeNull();
  });

  it("skips keyword-only rows rather than treating them as zero", () => {
    // A null must not be coerced to 0 — that would drag a genuinely good
    // result set below the low-confidence threshold.
    const best = topCosineScore([makeChunk(1, null), makeChunk(2, 0.77)]);
    expect(best).toBeCloseTo(0.77);
  });

  it("ignores a non-finite cosine rather than propagating NaN", () => {
    const results = [makeChunk(1, NaN), makeChunk(2, 0.6)];
    expect(topCosineScore(results)).toBeCloseTo(0.6);
  });
});

// ── rrfMerge carries the relevance score through the fusion ──────────────────

describe("rrfMerge preserves cosine_similarity", () => {
  it("overwrites similarity with the RRF score but keeps the cosine intact", () => {
    const vector = [makeChunk(1, 0.88), makeChunk(2, 0.71)];
    const keyword = [makeChunk(3, null), makeChunk(1, null)];

    const merged = rrfMerge(vector, keyword, 10);
    const byId = new Map(merged.map((r) => [r.id, r]));

    // Ranking scale: every fused score is bounded by the RRF ceiling.
    for (const r of merged) {
      expect(r.similarity).toBeLessThanOrEqual(MAX_RRF_SCORE);
    }
    // Relevance scale: untouched by the fusion.
    expect(byId.get(1)!.cosine_similarity).toBeCloseTo(0.88);
    expect(byId.get(2)!.cosine_similarity).toBeCloseTo(0.71);
    // A keyword-only hit has no comparable score and must stay null, not
    // inherit the fused rank score.
    expect(byId.get(3)!.cosine_similarity).toBeNull();
  });

  it("keeps the vector row's cosine when a chunk appears in both lists", () => {
    const merged = rrfMerge([makeChunk(7, 0.93)], [makeChunk(7, null)], 10);
    expect(merged).toHaveLength(1);
    expect(merged[0].cosine_similarity).toBeCloseTo(0.93);
    expect(merged[0].similarity).toBeCloseTo(MAX_RRF_SCORE);
  });
});

// ── The live hybrid tool -> logQuery path ────────────────────────────────────

const hybridToolConfig: SearchToolConfig = {
  name: "search-docs",
  type: "search",
  description: "Search the docs",
  source: "docs",
  default_limit: 5,
  max_limit: 20,
  result_format: "docs",
  search_mode: "hybrid",
};

/**
 * Drive the REAL registered search tool in hybrid mode over the REAL rrfMerge
 * and return what it persisted to query_log. `hybridSearchChunks` is stubbed
 * only to inject a deterministic candidate set — the fusion, the reduction to
 * top_score, and the write boundary are all production code.
 */
async function runHybridSearch(
  vector: ChunkResult[],
  keyword: ChunkResult[],
): Promise<{ topScore: number | null; results: ChunkResult[] }> {
  const fused = rrfMerge(vector, keyword, 5);

  const queries = await import("../db/queries.js");
  const spy = vi.spyOn(queries, "hybridSearchChunks").mockResolvedValue(fused);

  const server = new McpServer({ name: "t", version: "1.0.0" });
  registerSearchTool(
    server,
    { embed: vi.fn().mockResolvedValue([0.1, 0.2]), embedBatch: vi.fn() },
    hybridToolConfig,
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.server.connect(serverTransport),
  ]);

  await client.callTool({
    name: "search-docs",
    arguments: { query: "useCopilotAction" },
  });
  await client.close();
  spy.mockRestore();

  const entry = mockLogQuery.mock.calls.at(-1)![0];
  return { topScore: entry.top_score, results: fused };
}

describe("hybrid search logs a relevance score, not a rank score", () => {
  beforeEach(() => {
    mockLogQuery.mockClear();
  });

  it("persists the best cosine even though the returned rows are RRF-ranked", async () => {
    const { topScore, results } = await runHybridSearch(
      [makeChunk(1, 0.87), makeChunk(2, 0.63)],
      [makeChunk(3, null), makeChunk(1, null)],
    );

    // The rows the caller ranks by are still on the RRF scale...
    expect(Math.max(...results.map((r) => r.similarity))).toBeLessThanOrEqual(
      MAX_RRF_SCORE,
    );
    // ...but what we PERSIST is the cosine.
    expect(topScore).toBeCloseTo(0.87);
    expect(topScore!).toBeGreaterThan(MAX_RRF_SCORE);
  });

  it("DISCRIMINATES between an excellent match and a poor one", async () => {
    // The regression that matters. Under the old `Math.max(...similarity)`
    // both of these log ~0.0164 — identical, and both below the threshold —
    // so the metric carries no information. Reintroducing that scale mismatch
    // fails this test on both the equality and the classification.
    const excellent = await runHybridSearch(
      [makeChunk(1, 0.87)],
      [makeChunk(1, null)],
    );
    const poor = await runHybridSearch(
      [makeChunk(9, 0.21)],
      [makeChunk(9, null)],
    );

    expect(excellent.topScore).not.toBeCloseTo(poor.topScore!);
    expect(excellent.topScore!).toBeGreaterThan(LOW_CONFIDENCE_SCORE_THRESHOLD);
    expect(poor.topScore!).toBeLessThan(LOW_CONFIDENCE_SCORE_THRESHOLD);
  });

  it("logs a null score when only keyword-only hits came back", async () => {
    // No comparable score exists, so we record its absence rather than
    // inventing one. The analytics layer reads NULL as "no score", never as a
    // low score, so this does not manufacture a false content-gap signal.
    const { topScore } = await runHybridSearch(
      [],
      [makeChunk(3, null), makeChunk(4, null)],
    );
    expect(topScore).toBeNull();
  });
});

// ── The SQL readers, against real Postgres ───────────────────────────────────

const QUERY_LOG_DDL_MARKER =
  "-- Analytics: query_log table for tracking tool usage";

function extractQueryLogDdl(): string {
  const full = generatePostSchemaMigration();
  const idx = full.indexOf(QUERY_LOG_DDL_MARKER);
  if (idx < 0) {
    throw new Error(
      `Could not locate "${QUERY_LOG_DDL_MARKER}" in generatePostSchemaMigration(); ` +
        `schema.ts may have been refactored — update the marker.`,
    );
  }
  return full.slice(idx);
}

function poolFromPglite(db: PGlite) {
  return {
    query: (text: string, params?: unknown[]) => db.query(text, params),
    connect: async () => ({
      query: (text: string, params?: unknown[]) => db.query(text, params),
      release: () => {},
    }),
    end: async () => db.close(),
  };
}

describe("score-based readers fence off rows of unknown scale (PGlite)", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.waitReady;
    await db.exec(extractQueryLogDdl());
    __setPoolForTesting(poolFromPglite(db));
  });

  afterAll(async () => {
    __resetPoolForTesting();
    await db.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM query_log");
  });

  /** A row as written BEFORE score_kind existed: an RRF value, no scale tag. */
  async function seedLegacyRrfRow(queryText: string): Promise<void> {
    await db.query(
      `INSERT INTO query_log
        (tool_name, query_text, result_count, top_score, score_kind,
         latency_ms, source_name, session_id, request_source)
       VALUES ($1, $2, 5, 0.0164, NULL, 40, 'docs', 'sess-1', 'user')`,
      ["search-docs", queryText],
    );
  }

  it("logQuery tags a present score with its scale and leaves an absent one untagged", async () => {
    const actual =
      await vi.importActual<typeof import("../db/analytics.js")>(
        "../db/analytics.js",
      );
    await actual.logQuery({
      tool_name: "search-docs",
      query_text: "scored",
      result_count: 3,
      top_score: 0.72,
      latency_ms: 10,
      source_name: "docs",
      session_id: null,
    });
    await actual.logQuery({
      tool_name: "search-docs",
      query_text: "unscored",
      result_count: 3,
      top_score: null,
      latency_ms: 10,
      source_name: "docs",
      session_id: null,
    });

    const { rows } = await db.query<{
      query_text: string;
      score_kind: string | null;
    }>("SELECT query_text, score_kind FROM query_log ORDER BY id");
    expect(rows).toEqual([
      { query_text: "scored", score_kind: COSINE_SCORE_KIND },
      { query_text: "unscored", score_kind: null },
    ]);
  });

  it("does NOT count a legacy RRF-scaled row as low confidence", async () => {
    // 0.0164 < 0.5 numerically, but it is not a cosine. Counting it would
    // reproduce the 100%-false-positive signal this change removes.
    await seedLegacyRrfRow("legacy hybrid query");

    const summary = await getAnalyticsSummary({}, 7);
    expect(summary.total_queries_window).toBe(1);
    expect(summary.low_confidence_count_window).toBe(0);
    expect(summary.low_confidence_rate_window).toBe(0);
  });

  it("counts a genuinely weak cosine row, and spares a strong one", async () => {
    const actual =
      await vi.importActual<typeof import("../db/analytics.js")>(
        "../db/analytics.js",
      );
    await actual.logQuery({
      tool_name: "search-docs",
      query_text: "weak match",
      result_count: 4,
      top_score: 0.21,
      latency_ms: 10,
      source_name: "docs",
      session_id: null,
    });
    await actual.logQuery({
      tool_name: "search-docs",
      query_text: "strong match",
      result_count: 4,
      top_score: 0.87,
      latency_ms: 10,
      source_name: "docs",
      session_id: null,
    });

    const summary = await getAnalyticsSummary({}, 7);
    expect(summary.total_queries_window).toBe(2);
    expect(summary.low_confidence_count_window).toBe(1);
    expect(summary.low_confidence_rate_window).toBeCloseTo(0.5);
  });

  it("excludes legacy rows from the dashboard's Avg Cosine column", async () => {
    // Mixing an RRF 0.0164 into the mean would render a number that is neither
    // a cosine nor a rank score. The column reads "—" instead.
    await seedLegacyRrfRow("legacy hybrid query");
    const [legacy] = await getTopQueries(7, 10);
    expect(legacy.query_text).toBe("legacy hybrid query");
    expect(legacy.count).toBe(1);
    expect(legacy.avg_top_score).toBeNull();
  });

  it("averages only the cosine-scaled rows when both kinds share a query", async () => {
    const actual =
      await vi.importActual<typeof import("../db/analytics.js")>(
        "../db/analytics.js",
      );
    await seedLegacyRrfRow("mixed history");
    await actual.logQuery({
      tool_name: "search-docs",
      query_text: "mixed history",
      result_count: 5,
      top_score: 0.8,
      latency_ms: 10,
      source_name: "docs",
      session_id: null,
    });

    const [row] = await getTopQueries(7, 10);
    expect(row.count).toBe(2);
    // 0.8 alone — NOT (0.8 + 0.0164) / 2.
    expect(row.avg_top_score!).toBeCloseTo(0.8);
  });
});
