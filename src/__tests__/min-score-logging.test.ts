import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import pgvector from "pgvector";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SearchToolConfig } from "../types.js";

// -----------------------------------------------------------------------------
// What `query_log.top_score` MEASURES vs what `min_score` DELIVERS.
//
// `min_score` is a delivery contract: do not hand the caller a chunk we proved
// is below the floor. `top_score` is a measurement: how well did the index
// answer this query. Reducing the score over the POST-floor result set conflates
// the two, and with `min_score: 0.3` shipped on all four production search tools
// the consequences are structural:
//
//   * a near-miss (best chunk at 0.25) logged `top_score: NULL`, which the
//     analytics layer reads as "no score" — indistinguishable from a query that
//     matched nothing at all, and invisible to the low-confidence card whose
//     whole job is to surface content gaps that measure badly;
//   * `avg_top_score` (the dashboard's "Avg Cosine") averaged only survivors, so
//     it was floored at 0.3 by construction and could never report the readings
//     that matter most.
//
// These tests drive the REAL registered tool over REAL pgvector and the REAL
// analytics writer, against an index whose best match is deliberately BELOW the
// floor, and assert on the row that actually lands in query_log.
// -----------------------------------------------------------------------------

vi.mock("../config.js", () => ({
  getServerConfig: vi.fn().mockReturnValue({}),
  getAnalyticsConfig: vi.fn().mockReturnValue({ log_queries: true }),
}));

import { searchChunks, isBelowCosineFloor } from "../db/queries.js";
import { getTopQueries } from "../db/analytics.js";
import {
  generateSchema,
  generatePostSchemaMigration,
  generateTsvTriggerDdl,
} from "../db/schema.js";
import { __setPoolForTesting, __resetPoolForTesting } from "../db/client.js";
import { registerSearchTool } from "../mcp/tools/search.js";

/** Three dims is enough to place a seed at any chosen cosine from [1, 0, 0]. */
const DIMS = 3;
const QUERY_EMBEDDING = [1, 0, 0];

/** The floor every production search tool ships with (deploy/copilotkit-docs.yaml). */
const PRODUCTION_MIN_SCORE = 0.3;

/**
 * Unit vector in the x/y plane whose cosine against {@link QUERY_EMBEDDING} is
 * exactly `cosine`. Lets a seed be placed at a chosen point on the scale rather
 * than at whatever an arbitrary vector happens to produce.
 */
function atCosine(cosine: number): number[] {
  return [cosine, Math.sqrt(1 - cosine * cosine), 0];
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

/** The keyword half of the fusion matches on these words. */
const QUERY_TEXT = "gradient descent tuning";

interface QueryLogRow {
  query_text: string;
  result_count: number;
  top_score: number | null;
  score_kind: string | null;
}

describe("min_score gates delivery without censoring the measurement", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite({ extensions: { vector } });
    await db.waitReady;
    await db.exec(generateSchema(DIMS));
    await db.exec(generatePostSchemaMigration());
    await db.exec(generateTsvTriggerDdl());
    __setPoolForTesting(poolFromPglite(db));

    // `nearmiss`: every chunk is measurably below the production floor, and the
    // best one also satisfies the tsquery so the keyword half of the hybrid
    // fusion sees it too. This is the shape the floor was never able to report.
    const seeds: Array<[string, string, number[]]> = [
      ["nearmiss", `${QUERY_TEXT} for beginners`, atCosine(0.25)],
      ["nearmiss", `${QUERY_TEXT} advanced notes`, atCosine(0.1)],
      // `ordering`: spans the floor AND carries a degenerate zero-norm row, for
      // which pgvector's `<=>` is NaN. Used to measure where such a row lands in
      // the distance ordering.
      ["ordering", `${QUERY_TEXT} excellent match`, atCosine(0.9)],
      ["ordering", `${QUERY_TEXT} weak match`, atCosine(0.25)],
      ["ordering", `${QUERY_TEXT} degenerate row`, [0, 0, 0]],
    ];
    // `gap`: the shape that floors the dashboard's Avg Cosine. Every row the
    // vector half measures is below the floor and none of them satisfy the
    // tsquery; the only keyword match sits OUTSIDE the vector candidate window
    // (candidateLimit = default_limit * 2 = 10), so it has no measured cosine,
    // enters the fusion ungated, and is returned. The query therefore has
    // result_count > 0 — it reaches the Top Queries panel — while the best thing
    // the index actually held for it measured 0.25.
    for (let i = 0; i < 10; i++) {
      await db.query(
        `INSERT INTO chunks (source_name, content, embedding, file_path, chunk_index)
         VALUES ('gap', $1, $2, $3, 0)`,
        [
          `alpha beta unrelated prose number ${i}`,
          pgvector.toSql(atCosine(0.25 - i * 0.01)),
          `gap/filler-${i}.md`,
        ],
      );
    }
    await db.query(
      `INSERT INTO chunks (source_name, content, embedding, file_path, chunk_index)
       VALUES ('gap', $1, $2, 'gap/keyword-only.md', 0)`,
      [`${QUERY_TEXT} mentioned in passing`, pgvector.toSql(atCosine(0.05))],
    );
    for (const [source, content, embedding] of seeds) {
      await db.query(
        `INSERT INTO chunks (source_name, content, embedding, file_path, chunk_index)
         VALUES ($1, $2, $3, $4, 0)`,
        [source, content, pgvector.toSql(embedding), `${source}/${content}.md`],
      );
    }
  });

  afterAll(async () => {
    __resetPoolForTesting();
    await db.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM query_log");
  });

  function toolConfig(
    source: string,
    searchMode: "hybrid" | "vector",
  ): SearchToolConfig {
    return {
      name: `search-${source}-${searchMode}`,
      type: "search",
      description: `Search ${source}`,
      source,
      default_limit: 5,
      max_limit: 20,
      result_format: "docs",
      search_mode: searchMode,
      min_score: PRODUCTION_MIN_SCORE,
    };
  }

  /**
   * Drive the real registered search tool end to end: real embedding vector,
   * real searchChunks/hybridSearchChunks against pgvector, real rrfMerge, real
   * `logQuery` INSERT. Returns the snippet count the caller was handed and the
   * query_log row that was persisted for the same call.
   */
  async function runSearch(
    config: SearchToolConfig,
  ): Promise<{ snippetText: string; row: QueryLogRow }> {
    const server = new McpServer({ name: "t", version: "1.0.0" });
    registerSearchTool(
      server,
      {
        embed: vi.fn().mockResolvedValue(QUERY_EMBEDDING),
        embedBatch: vi.fn(),
      },
      config,
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "1.0.0" });
    await Promise.all([
      client.connect(clientTransport),
      server.server.connect(serverTransport),
    ]);
    const response = await client.callTool({
      name: config.name,
      arguments: { query: QUERY_TEXT },
    });
    await client.close();

    // `logQuery` is fire-and-forget on the tool path, so the INSERT can land
    // after callTool resolves. Poll rather than sleep.
    const before = await countRows();
    const row = await waitForRow(before === 0 ? 1 : before);
    const content = response.content as Array<{ type: string; text: string }>;
    return { snippetText: content[0].text, row };
  }

  async function countRows(): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM query_log",
    );
    return rows[0].n;
  }

  async function waitForRow(minCount: number): Promise<QueryLogRow> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const { rows } = await db.query<QueryLogRow>(
        `SELECT query_text, result_count, top_score, score_kind
           FROM query_log ORDER BY id DESC LIMIT 1`,
      );
      if (rows.length >= 1 && (await countRows()) >= minCount) return rows[0];
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("query_log row never appeared");
  }

  it("logs the MEASURED cosine for a hybrid near-miss, and returns nothing", async () => {
    // The measurement, taken independently of the tool: the best chunk in this
    // index sits at 0.25 — below the 0.3 floor, well inside the scale.
    const measured = await searchChunks(QUERY_EMBEDDING, 10, "nearmiss");
    expect(measured[0].cosine_similarity).toBeCloseTo(0.25, 4);
    expect(isBelowCosineFloor(measured[0], PRODUCTION_MIN_SCORE)).toBe(true);

    const { snippetText, row } = await runSearch(toolConfig("nearmiss", "hybrid"));

    // Delivery still honours the caller's floor — nothing measured below it
    // reaches the caller, including via its keyword rank.
    expect(snippetText).toBe("No results found.");
    expect(row.result_count).toBe(0);
    // ...and the measurement survives. NULL here would be a lie: it is what a
    // query that matched NOTHING logs, and the analytics layer reads it as "no
    // score" rather than as the content gap this actually is.
    expect(row.top_score).not.toBeNull();
    expect(row.top_score!).toBeCloseTo(0.25, 4);
    expect(row.score_kind).toBe("cosine");
  });

  it("logs the MEASURED cosine for a vector-mode near-miss too", async () => {
    const { snippetText, row } = await runSearch(toolConfig("nearmiss", "vector"));
    expect(snippetText).toBe("No results found.");
    expect(row.result_count).toBe(0);
    expect(row.top_score!).toBeCloseTo(0.25, 4);
  });

  it("still logs NULL when nothing was measured at all", async () => {
    // The distinction the fix exists to preserve. `empty` has no chunks, so no
    // cosine was computed anywhere in the request — that is a genuine absence of
    // a reading, and it must stay distinguishable from a sub-floor one.
    const { row } = await runSearch(toolConfig("empty", "hybrid"));
    expect(row.result_count).toBe(0);
    expect(row.top_score).toBeNull();
    expect(row.score_kind).toBeNull();
  });

  it("lets the dashboard's Avg Cosine report below the floor", async () => {
    // `avg_top_score` averaging survivors instead of measurements floored the
    // column at min_score: no amount of genuinely poor retrieval could move it
    // under 0.3, which is precisely the range an operator needs to see.
    const first = await runSearch(toolConfig("gap", "hybrid"));
    // The query DID return something — an ungated keyword-only hit — so it is
    // present in Top Queries (which requires result_count > 0). What it returned
    // carries no cosine of its own; the reading belongs to the vector half.
    expect(first.row.result_count).toBe(1);
    await runSearch(toolConfig("gap", "hybrid"));

    const top = await getTopQueries(7, 10);
    const entry = top.find((q) => q.query_text === QUERY_TEXT);
    expect(entry).toBeDefined();
    expect(entry!.avg_top_score).not.toBeNull();
    expect(entry!.avg_top_score!).toBeLessThan(PRODUCTION_MIN_SCORE);
    expect(entry!.avg_top_score!).toBeCloseTo(0.25, 4);
  });
});

// ── Where a null-cosine row lands in the distance ordering ───────────────────

describe("the vector-mode floor cut cannot hide a passing row past the LIMIT", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite({ extensions: { vector } });
    await db.waitReady;
    await db.exec(generateSchema(DIMS));
    await db.exec(generatePostSchemaMigration());
    __setPoolForTesting(poolFromPglite(db));
    const seeds: Array<[string, number[]]> = [
      ["strong.md", atCosine(0.9)],
      ["mid.md", atCosine(0.6)],
      ["weak.md", atCosine(0.25)],
      ["degenerate.md", [0, 0, 0]],
    ];
    for (const [file, embedding] of seeds) {
      await db.query(
        `INSERT INTO chunks (source_name, content, embedding, file_path, chunk_index)
         VALUES ('ordering', $1, $2, $3, 0)`,
        [`content of ${file}`, pgvector.toSql(embedding), file],
      );
    }
  });

  afterAll(async () => {
    __resetPoolForTesting();
    await db.close();
  });

  it("orders a null-cosine (NaN distance) row strictly LAST", async () => {
    // The measurement the vector-mode comment depends on. `ORDER BY embedding
    // <=> $1` is ascending, and Postgres sorts NaN above every finite float8, so
    // a degenerate row can only enter the LIMIT window after every finite row
    // has. That is what keeps the floor cut safe: a null-cosine row survives the
    // filter (its relevance is unknown, not bad) and can therefore leave a hole
    // mid-array, but it can never displace a row that would have passed.
    const all = await searchChunks(QUERY_EMBEDDING, 10, "ordering");
    expect(all.map((r) => r.file_path)).toEqual([
      "strong.md",
      "mid.md",
      "weak.md",
      "degenerate.md",
    ]);
    expect(all.at(-1)!.cosine_similarity).toBeNull();
  });

  it("returns a short result set, but only when the whole index is in the window", async () => {
    // limit=4 pulls every row, so the degenerate row is present and the floor
    // cut deletes `weak.md` from the MIDDLE of the array — 3 rows back for a
    // limit of 4. The comment used to call this a "suffix cut", which it is not.
    const window = await searchChunks(QUERY_EMBEDDING, 4, "ordering");
    const kept = window.filter((r) => !isBelowCosineFloor(r, 0.3));
    expect(kept.map((r) => r.file_path)).toEqual([
      "strong.md",
      "mid.md",
      "degenerate.md",
    ]);
    expect(kept.length).toBeLessThan(4);
    // But nothing was lost: the degenerate row is only in the window because
    // the finite population was exhausted, so there is no row past the LIMIT to
    // over-fetch. Every finite row is accounted for.
    expect(window.filter((r) => r.cosine_similarity !== null)).toHaveLength(3);
  });

  it("keeps the cut a true suffix whenever a row DOES sit past the LIMIT", async () => {
    // limit=3 stops before the degenerate row, so the window is a pure
    // descending-cosine prefix and the floor removes a genuine suffix. The row
    // just past the LIMIT is the degenerate one, which could not have cleared
    // the floor either — it carries no cosine to compare.
    const window = await searchChunks(QUERY_EMBEDDING, 3, "ordering");
    expect(window.every((r) => r.cosine_similarity !== null)).toBe(true);
    const kept = window.filter((r) => !isBelowCosineFloor(r, 0.3));
    expect(kept.map((r) => r.file_path)).toEqual(["strong.md", "mid.md"]);
  });
});
