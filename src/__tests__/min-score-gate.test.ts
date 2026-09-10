// What min_score actually gates.
//
// The floor is documented as "minimum cosine similarity", but retrieval
// carries TWO numbers per row on two scales: `similarity` (a per-retriever
// RANKING score) and `cosine_similarity` (the RELEVANCE score, on the [-1, 1]
// cosine scale or null). Only the latter may be compared against a threshold
// (see src/relevance.ts).
//
// The defect these tests pin is not the field the old gate read — on a freshly
// fetched vector row both fields hold the same cosine, so the arithmetic was
// right. It is that the gate was applied to ONE of the two candidate lists.
// A semantically weak chunk that also satisfied the tsquery was dropped from
// the vector list and then re-entered the fusion through the keyword list,
// carrying `cosine_similarity: null` — so it was returned below a floor we had
// already measured it to violate, AND reported as having no relevance score
// rather than a bad one. Every deployed tool runs `search_mode: hybrid` with
// `min_score: 0.3`, so that path is the production path.
//
// Everything here runs against a real PGlite + pgvector `chunks` table through
// the real searchChunks / textSearchChunks / hybridSearchChunks, and (for the
// vector mode gate) through the real registered MCP tool.

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import pgvector from "pgvector";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SearchToolConfig, ChunkResult } from "../types.js";

vi.mock("../db/analytics.js", () => ({
  logQuery: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, getAnalyticsConfig: vi.fn().mockReturnValue(undefined) };
});

import {
  searchChunks,
  hybridSearchChunks,
  isBelowCosineFloor,
} from "../db/queries.js";
import { generateSchema, generatePostSchemaMigration } from "../db/schema.js";
import { __setPoolForTesting, __resetPoolForTesting } from "../db/client.js";
import { registerSearchTool } from "../mcp/tools/search.js";

// Three dimensions is enough: every fixture embedding is a unit vector whose
// first component IS its cosine against the query, so a chunk's relevance is
// stated literally in the fixture instead of being an emergent property.
const DIMS = 3;
const QUERY_EMBEDDING = [1, 0, 0];

function unitVectorAtCosine(cosine: number): number[] {
  return [cosine, Math.sqrt(Math.max(0, 1 - cosine * cosine)), 0];
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

interface Fixture {
  /** Doubles as file_path and title so results are identifiable by name. */
  name: string;
  cosine: number;
  content: string;
}

let db: PGlite;

async function seed(fixtures: Fixture[]): Promise<void> {
  await db.query("DELETE FROM chunks");
  for (const f of fixtures) {
    // tsv is set explicitly: the trigger that maintains it is PL/pgSQL and is
    // not applied under PGlite. Mirrors INSERT_CHUNK_SQL's derivation.
    await db.query(
      `INSERT INTO chunks
           (source_name, source_url, title, content, embedding, repo_url,
            file_path, chunk_index, tsv)
       VALUES ('docs', NULL, $1, $2, $3, NULL, $1, 0,
               to_tsvector('english', $2))`,
      [f.name, f.content, pgvector.toSql(unitVectorAtCosine(f.cosine))],
    );
  }
}

const names = (rows: ChunkResult[]): string[] => rows.map((r) => r.file_path);

/**
 * Add a row whose embedding has zero norm. pgvector's `<=>` returns NaN for it,
 * so searchChunks maps its cosine to null (toCosineScoreOrNull) — the only shape
 * in which a vector row carries UNKNOWN rather than bad relevance.
 *
 * Shared by the two tests that need it. It used to be inlined in one of them,
 * which is how the ordering test below came to assert an invariant that only
 * held because the `beforeEach` re-seed kept this row out of its fixture.
 */
async function insertDegenerateRow(): Promise<void> {
  await db.query(
    `INSERT INTO chunks
         (source_name, source_url, title, content, embedding, repo_url,
          file_path, chunk_index, tsv)
     VALUES ('docs', NULL, $1, $2, $3, NULL, $1, 0,
             to_tsvector('english', $2))`,
    ["degenerate.md", "delta subject matter", pgvector.toSql([0, 0, 0])],
  );
}

beforeAll(async () => {
  db = new PGlite({ extensions: { vector } });
  await db.waitReady;
  await db.exec(generateSchema(DIMS));
  await db.exec(generatePostSchemaMigration());
  __setPoolForTesting(poolFromPglite(db));
});

afterAll(async () => {
  __resetPoolForTesting();
  await db.close();
});

// ── The predicate: which field the floor is compared against ─────────────────

describe("isBelowCosineFloor", () => {
  function row(overrides: Partial<ChunkResult>): ChunkResult {
    return {
      id: 1,
      source_name: "docs",
      source_url: null,
      title: "t",
      content: "c",
      repo_url: null,
      file_path: "t.md",
      start_line: null,
      end_line: null,
      language: null,
      similarity: 0,
      cosine_similarity: null,
      ...overrides,
    };
  }

  it("reads the RELEVANCE score, not the ranking score, when the two diverge", () => {
    // A fused row: `similarity` is an RRF score (ceiling ≈ 0.033) while the
    // cosine is excellent. Comparing the ranking score against a 0-1 cosine
    // floor would condemn a near-perfect match.
    const fused = row({ similarity: 0.0164, cosine_similarity: 0.87 });
    expect(isBelowCosineFloor(fused, 0.3)).toBe(false);
  });

  it("treats a missing cosine as unknown relevance, never as zero", () => {
    // A keyword row: `similarity` is a ts_rank and there is no cosine at all.
    // Defaulting the absent score to 0 would exclude every keyword-only hit
    // the moment any floor is set, silently turning hybrid search into vector
    // search.
    const keywordOnly = row({ similarity: 0.021, cosine_similarity: null });
    expect(isBelowCosineFloor(keywordOnly, 0.3)).toBe(false);
  });

  it("excludes a measured cosine strictly below the floor, and keeps one exactly on it", () => {
    expect(isBelowCosineFloor(row({ cosine_similarity: 0.29 }), 0.3)).toBe(
      true,
    );
    expect(isBelowCosineFloor(row({ cosine_similarity: 0.3 }), 0.3)).toBe(
      false,
    );
  });
});

// ── The hybrid gate, against a real index ────────────────────────────────────

describe("hybrid search min_score gate (PGlite + pgvector)", () => {
  it("keeps a vector-only chunk above the floor and drops one below it", async () => {
    // Also pins the SCALE the gate operates on. These thresholds are cosines;
    // if the floor were ever compared against an RRF fusion score (≈ 0.016 at
    // best) both 0.3 and 0.7 would empty the result set instead of separating
    // 0.6 from 1.0.
    await seed([
      { name: "strong.md", cosine: 1.0, content: "alpha subject matter" },
      { name: "middling.md", cosine: 0.6, content: "bravo subject matter" },
      { name: "weak.md", cosine: 0.2, content: "charlie subject matter" },
    ]);
    const noKeywordHits = "zzqqxx";

    const atLowFloor = await hybridSearchChunks(
      QUERY_EMBEDDING,
      noKeywordHits,
      5,
      "docs",
      undefined,
      0.3,
    );
    expect(names(atLowFloor).sort()).toEqual(["middling.md", "strong.md"]);

    const atHighFloor = await hybridSearchChunks(
      QUERY_EMBEDDING,
      noKeywordHits,
      5,
      "docs",
      undefined,
      0.7,
    );
    expect(names(atHighFloor)).toEqual(["strong.md"]);
  });

  it("does not let a chunk it measured below the floor back in on its keyword rank", async () => {
    // THE REGRESSION. `lexical-noise.md` has a cosine of 0.0 against the query
    // but is the strongest tsquery match in the corpus. Gating only the vector
    // list returned it anyway — below a 0.3 floor, and reported with
    // `cosine_similarity: null` so nothing downstream could even tell.
    await seed([
      { name: "relevant.md", cosine: 1.0, content: "widget configuration" },
      {
        name: "lexical-noise.md",
        cosine: 0.0,
        content: "widget widget widget unrelated boilerplate",
      },
    ]);

    const results = await hybridSearchChunks(
      QUERY_EMBEDDING,
      "widget",
      5,
      "docs",
      undefined,
      0.3,
    );

    expect(names(results)).toEqual(["relevant.md"]);
    // And nothing in the output is a measured-but-erased sub-floor score.
    for (const r of results) {
      expect(isBelowCosineFloor(r, 0.3)).toBe(false);
    }
  });

  it("returns a keyword hit whose cosine was never measured, ungated", async () => {
    // The documented residue, pinned so it is not "fixed" into a blanket
    // exclusion of keyword-only hits. `far.md` ranks 5th by cosine, outside
    // the 2x vector candidate window (limit 2 -> 4 candidates), so this
    // request never computes a cosine for it. Unknown relevance is not
    // sub-floor relevance, and hybrid search exists to surface exactly these.
    // Insertion order scrambled so the candidate window is decided by cosine
    // rank and not by id: seeded best-first, `far.md` would fall outside the
    // window either way and the test would not notice.
    //
    // The fixture is also built so the fused ranking is STRICT. With `kumquat`
    // in `far.md` alone, `far.md` and `v1.md` were both rank 1 in their
    // respective lists and scored an identical 1/(RRF_K+1) — an exact tie at the
    // top of a 5-row set truncated to 2, whose resolution is V8 sort stability
    // rather than anything this test means to assert. Mentioning `kumquat` twice
    // in `far.md` and once in `v1.md` makes `v1.md` a member of BOTH lists, so
    // it scores 1/61 + 1/62 and outranks `far.md`'s 1/61 outright, which in turn
    // outranks `v2.md`'s 1/62. The result order below is then exact.
    await seed([
      { name: "far.md", cosine: 0.1, content: "kumquat kumquat" },
      { name: "v1.md", cosine: 1.0, content: "alpha prose kumquat" },
      { name: "v6.md", cosine: 0.05, content: "echo prose" },
      { name: "v2.md", cosine: 0.9, content: "bravo prose" },
      { name: "v3.md", cosine: 0.8, content: "charlie prose" },
      { name: "v4.md", cosine: 0.7, content: "delta prose" },
    ]);

    const results = await hybridSearchChunks(
      QUERY_EMBEDDING,
      "kumquat",
      2,
      "docs",
      undefined,
      0.5,
    );

    // Exact and ordered: `far.md` is included on its own merits, not because a
    // tie happened to break its way.
    expect(names(results)).toEqual(["v1.md", "far.md"]);
    const far = results.find((r) => r.file_path === "far.md")!;
    expect(far.cosine_similarity).toBeNull();
    const v1 = results.find((r) => r.file_path === "v1.md")!;
    expect(v1.similarity).toBeGreaterThan(far.similarity);
  });
});

// ── The vector-mode gate, through the real MCP tool ──────────────────────────

const vectorToolConfig: SearchToolConfig = {
  name: "search-docs",
  type: "search",
  description: "Search the docs",
  source: "docs",
  default_limit: 5,
  max_limit: 20,
  result_format: "docs",
  search_mode: "vector",
};

async function callVectorSearch(
  args: Record<string, unknown>,
): Promise<string> {
  const server = new McpServer({ name: "t", version: "1.0.0" });
  registerSearchTool(
    server,
    { embed: vi.fn().mockResolvedValue(QUERY_EMBEDDING), embedBatch: vi.fn() },
    vectorToolConfig,
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.server.connect(serverTransport),
  ]);
  const res = await client.callTool({ name: "search-docs", arguments: args });
  await client.close();
  const [chunk] = res.content as { type: string; text: string }[];
  return chunk.text;
}

describe("vector search min_score gate (real tool, PGlite + pgvector)", () => {
  beforeEach(async () => {
    // Insertion order is deliberately NOT cosine order. Seeding best-first
    // makes id order and relevance order coincide, which lets a retriever that
    // has stopped sorting by embedding distance still look correct — the
    // ordering assertion below would pass against `ORDER BY id`.
    await seed([
      { name: "weak.md", cosine: 0.2, content: "charlie subject matter" },
      { name: "strong.md", cosine: 1.0, content: "alpha subject matter" },
      { name: "middling.md", cosine: 0.6, content: "bravo subject matter" },
    ]);
  });

  it("excludes results below the floor and keeps the rest", async () => {
    const text = await callVectorSearch({ query: "anything", min_score: 0.5 });
    expect(text).toContain("strong.md");
    expect(text).toContain("middling.md");
    expect(text).not.toContain("weak.md");
  });

  it("returns everything when no floor is supplied", async () => {
    const text = await callVectorSearch({ query: "anything" });
    expect(text).toContain("weak.md");
  });

  it("returns a row whose cosine could not be measured, instead of reading it as 0", async () => {
    // Where this floor and the [-1, 1] scale contract meet, and a deliberate
    // behaviour CHANGE rather than an obviously desirable one — pinned so it
    // cannot drift back silently either way.
    //
    // pgvector's `<=>` returns NaN for a zero-norm embedding, so searchChunks
    // maps the row's cosine to null (toCosineScoreOrNull), meaning UNKNOWN
    // relevance — and this predicate never excludes what it failed to measure.
    // The old gate read `similarity`, where the same NaN coerces to 0 and any
    // positive floor dropped the row; that only looked correct because
    // "corrupt" and "orthogonal" are the same number in that field. So a row
    // of unknown relevance now surfaces where it used to be filtered. It still
    // cannot pollute a score-based analytic: a null cosine never reaches
    // `query_log.top_score` (see topCosineScore).
    await insertDegenerateRow();

    const corrupt = (await searchChunks(QUERY_EMBEDDING, 10, "docs")).find(
      (r) => r.file_path === "degenerate.md",
    )!;
    expect(corrupt.cosine_similarity).toBeNull();
    expect(isBelowCosineFloor(corrupt, 0.5)).toBe(false);

    const text = await callVectorSearch({ query: "anything", min_score: 0.5 });
    expect(text).toContain("degenerate.md");
    // The floor still does its job on rows it DID measure.
    expect(text).not.toContain("weak.md");
  });

  it("orders measured rows by descending cosine and unmeasured ones strictly last, which is why the post-LIMIT cut loses nothing", async () => {
    // The gate runs in JS after `LIMIT`, with no over-fetch. That is only sound
    // because searchChunks orders by embedding distance. Two things were wrong
    // with the way this test used to establish it.
    //
    // First, the fixture. It ran against the three finite-cosine rows the
    // `beforeEach` seeds, and the row that refutes the naive form of the claim —
    // the zero-norm one the PRECEDING test inserts — was wiped by that re-seed
    // before this test could ever see it. So the invariant was pinned on the one
    // fixture where it holds unconditionally.
    //
    // Second, the assertion: `cosines.sort((a, b) => b! - a!)` over
    // `(number | null)[]`. That neither throws nor yields NaN — `null` coerces
    // to 0, so the comparator silently ranks an UNMEASURED row as exactly
    // orthogonal, which is the precise conflation this change exists to remove.
    // The assertion then "passes" by agreeing with the bug. (The
    // `nan-comparator-in-assertion` rule in scripts/check-test-shapes.mjs flags
    // the same shape for its sibling failure: an `undefined` element DOES make
    // the comparator NaN, `Array#sort` treats NaN as "equal", and the array
    // comes back untouched — true no matter what the retriever did.)
    //
    // So: seed the counterexample, and assert the two claims separately.
    await insertDegenerateRow();

    const rows = await searchChunks(QUERY_EMBEDDING, 4, "docs");
    const measured = rows.filter((r) => r.cosine_similarity !== null);
    const unmeasured = rows.filter((r) => r.cosine_similarity === null);

    // Pinned by name, so neither group is empty and neither claim below is
    // vacuous.
    expect(names(measured)).toEqual(["strong.md", "middling.md", "weak.md"]);
    expect(names(unmeasured)).toEqual(["degenerate.md"]);
    // 1. every unmeasured row trails every measured one.
    expect(names(rows)).toEqual([...names(measured), ...names(unmeasured)]);
    // 2. the measured prefix is STRICTLY descending. No comparator, so nothing
    //    to coerce, and a tie fails instead of passing.
    for (let i = 1; i < measured.length; i++) {
      expect(measured[i].cosine_similarity!).toBeLessThan(
        measured[i - 1].cosine_similarity!,
      );
    }

    // What that buys the handler: nothing an over-fetch would add could have
    // cleared the floor.
    const atLimit = await searchChunks(QUERY_EMBEDDING, 2, "docs");
    const overFetched = await searchChunks(QUERY_EMBEDDING, 4, "docs");
    expect(names(overFetched).slice(0, atLimit.length)).toEqual(names(atLimit));

    const beyondLimit = overFetched.slice(atLimit.length);
    expect(names(beyondLimit)).toEqual(["weak.md", "degenerate.md"]);
    // Every MEASURED row past the LIMIT is below the floor, so over-fetching
    // would surface nothing the filter would have kept. `degenerate.md` is not
    // below the floor — unknown relevance is not bad relevance — which is
    // exactly why the cut is not the pure "suffix" it was once described as; the
    // hole it leaves is mid-array. See min-score-logging.test.ts.
    const measuredBeyondLimit = beyondLimit.filter(
      (r) => r.cosine_similarity !== null,
    );
    expect(names(measuredBeyondLimit)).toEqual(["weak.md"]);
    for (const r of measuredBeyondLimit) {
      expect(isBelowCosineFloor(r, 0.7)).toBe(true);
    }
  });
});
