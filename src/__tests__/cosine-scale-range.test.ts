import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import pgvector from "pgvector";
import type { ChunkResult } from "../types.js";

// -----------------------------------------------------------------------------
// The cosine RELEVANCE scale, measured rather than assumed.
//
// The contract used to document `cosine_similarity` as [0, 1]. It never was:
// searchChunks SELECTs `1 - (embedding <=> $1)`, and pgvector's `<=>` under
// vector_cosine_ops is cosine DISTANCE in [0, 2], so the reachable range is
// [-1, 1]. Two things followed from getting the bound wrong:
//
//   * the low-confidence threshold was justified as "the midpoint of the
//     scale" when COSINE_SCORE_MAX is the maximum, not the midpoint; and
//   * a corrupt (non-finite) similarity was coerced to 0, which on a [-1, 1]
//     scale is a LEGITIMATE reading (orthogonal) — so a degenerate row was
//     persisted as a real score AND counted as a false low-confidence hit.
//
// These tests measure the bound against real pgvector and pin both halves of
// the invariant: what the range is, and that a corrupt value stays outside it
// entirely (null) rather than landing on a legal point inside it.
// -----------------------------------------------------------------------------

vi.mock("../config.js", () => ({
  getServerConfig: vi.fn().mockReturnValue({}),
  getAnalyticsConfig: vi.fn().mockReturnValue({ log_queries: true }),
}));

import {
  COSINE_SCORE_MIN,
  COSINE_SCORE_MAX,
  COSINE_SCORE_ORTHOGONAL,
  topCosineScore,
} from "../relevance.js";
import {
  LOW_CONFIDENCE_SCORE_THRESHOLD,
  logQuery,
  getAnalyticsSummary,
} from "../db/analytics.js";
import {
  searchChunks,
  getFaqChunks,
  getFaqChunksByIds,
} from "../db/queries.js";
import { generateSchema, generatePostSchemaMigration } from "../db/schema.js";
import { __setPoolForTesting, __resetPoolForTesting } from "../db/client.js";

/** Three dims is enough to build aligned / orthogonal / opposed embeddings. */
const DIMS = 3;

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

// ── The scale constants ──────────────────────────────────────────────────────

describe("the cosine scale constants describe the range pgvector produces", () => {
  it("spans [-1, 1] with orthogonality at its midpoint", () => {
    expect(COSINE_SCORE_MIN).toBe(-1);
    expect(COSINE_SCORE_MAX).toBe(1);
    expect(COSINE_SCORE_ORTHOGONAL).toBe(
      (COSINE_SCORE_MIN + COSINE_SCORE_MAX) / 2,
    );
  });

  it("puts the low-confidence threshold in the usable half, not at the midpoint", () => {
    // The VALUE, as a literal. Restating `analytics.ts`'s own expression is not
    // enough on its own: it holds for any constants at all, so raising
    // COSINE_SCORE_MAX to 2 would slide the threshold to 1.0 — flagging almost
    // every query as low-confidence — with this test still green. An anchor is
    // needed somewhere, and here is where the scale itself is anchored (the
    // -1 / 1 bounds above are pinned as literals for the same reason).
    expect(LOW_CONFIDENCE_SCORE_THRESHOLD).toBe(0.5);
    // The DERIVATION: the midpoint of [orthogonal, perfect]. The midpoint of the
    // FULL range is orthogonality itself — a threshold there would flag
    // essentially nothing, because a hit below 0 barely occurs and everything
    // at or under 0 is already definitionally irrelevant. Behaviourally the
    // derivation and the literal 0.5 are indistinguishable today (recorded as
    // the one surviving mutant in mutants.json); what these two assertions
    // together forbid is the pair drifting apart onto different scales.
    expect(LOW_CONFIDENCE_SCORE_THRESHOLD).toBe(
      (COSINE_SCORE_ORTHOGONAL + COSINE_SCORE_MAX) / 2,
    );
    expect(LOW_CONFIDENCE_SCORE_THRESHOLD).toBeGreaterThan(
      COSINE_SCORE_ORTHOGONAL,
    );
    expect(LOW_CONFIDENCE_SCORE_THRESHOLD).toBeLessThan(COSINE_SCORE_MAX);
  });
});

// ── The measured range, over a real pgvector index ───────────────────────────

describe("searchChunks against a real pgvector index (PGlite)", () => {
  let db: PGlite;
  /** file_path -> chunk id, so tests can pick a specific seeded row back out. */
  const ids = new Map<string, number>();

  beforeAll(async () => {
    db = new PGlite({ extensions: { vector } });
    await db.waitReady;
    await db.exec(generateSchema(DIMS));
    await db.exec(generatePostSchemaMigration());
    __setPoolForTesting(poolFromPglite(db));

    // Four rows spanning the whole scale relative to the query [1, 0, 0]:
    // aligned (+1), orthogonal (0), opposed (-1), and a DEGENERATE zero-norm
    // embedding for which pgvector's cosine distance is NaN.
    const seeds: Array<[string, number[]]> = [
      ["aligned.md", [1, 0, 0]],
      ["orthogonal.md", [0, 1, 0]],
      ["opposed.md", [-1, 0, 0]],
      ["zero.md", [0, 0, 0]],
    ];
    for (const [file, embedding] of seeds) {
      const { rows } = await db.query<{ id: number }>(
        `INSERT INTO chunks (source_name, content, embedding, file_path, chunk_index)
         VALUES ('docs', $1, $2, $3, 0) RETURNING id`,
        [`content of ${file}`, pgvector.toSql(embedding), file],
      );
      ids.set(file, rows[0].id);
    }
    // One row carrying FAQ confidence metadata, so the browse reader
    // (getFaqChunks) has something to return. `RETURNING id` is load-bearing:
    // without it this row's id never entered `ids`, so the by-id reader
    // (getFaqChunksByIds) was handed only the four non-FAQ rows and the test
    // below asserted the FAQ contract on a set that contained no FAQ row.
    const { rows: faqRows } = await db.query<{ id: number }>(
      `INSERT INTO chunks (source_name, content, embedding, file_path, chunk_index, metadata)
       VALUES ('docs', 'a frequently asked question', $1, 'faq.md', 0,
               '{"confidence": 0.9}'::jsonb) RETURNING id`,
      [pgvector.toSql([1, 0, 0])],
    );
    ids.set("faq.md", faqRows[0].id);
  });

  afterAll(async () => {
    __resetPoolForTesting();
    await db.close();
  });

  async function search(): Promise<Map<string, ChunkResult>> {
    const results = await searchChunks([1, 0, 0], 10, "docs");
    return new Map(results.map((r) => [r.file_path, r]));
  }

  it("reaches COSINE_SCORE_MIN — a negative cosine is a real, reachable reading", async () => {
    const byFile = await search();
    const opposed = byFile.get("opposed.md")!;
    // The measurement that refutes the old [0, 1] claim. Asserting the exact
    // bound (not merely "< 0") is deliberate: it fails both if the range is
    // narrowed back to [0, 1] and if the SELECT stops being `1 - distance`.
    expect(opposed.cosine_similarity).toBe(-1);
    expect(opposed.cosine_similarity).toBe(COSINE_SCORE_MIN);
    expect(opposed.cosine_similarity!).toBeLessThan(COSINE_SCORE_ORTHOGONAL);
  });

  it("keeps every row inside [COSINE_SCORE_MIN, COSINE_SCORE_MAX]", async () => {
    const byFile = await search();
    expect(byFile.get("aligned.md")!.cosine_similarity).toBe(COSINE_SCORE_MAX);
    for (const r of byFile.values()) {
      if (r.cosine_similarity === null) continue;
      expect(r.cosine_similarity).toBeGreaterThanOrEqual(COSINE_SCORE_MIN);
      expect(r.cosine_similarity).toBeLessThanOrEqual(COSINE_SCORE_MAX);
    }
  });

  it("reports a corrupt (non-finite) similarity as null, not as an orthogonal 0", async () => {
    const byFile = await search();
    const corrupt = byFile.get("zero.md")!;
    const orthogonal = byFile.get("orthogonal.md")!;

    // The distinguishability the whole fix turns on: a zero-norm embedding
    // yields NaN, and 0 is a LEGITIMATE cosine, so the two must not collapse
    // onto the same value.
    expect(corrupt.cosine_similarity).toBeNull();
    expect(orthogonal.cosine_similarity).toBe(COSINE_SCORE_ORTHOGONAL);
    expect(corrupt.cosine_similarity).not.toBe(orthogonal.cosine_similarity);
  });

  it("does not let a corrupt row read as a low-confidence score", async () => {
    const byFile = await search();
    // A result set whose only row is corrupt has NO score — reducing it must
    // yield null, which analytics reads as "no score", never as a low one.
    // Coerced to 0 (the old behaviour) this reduced to 0 and tripped the
    // threshold, manufacturing the exact content-gap signal it exists to find.
    expect(topCosineScore([byFile.get("zero.md")!])).toBeNull();
    // A genuinely orthogonal row DOES score, and IS low confidence.
    const orthogonalTop = topCosineScore([byFile.get("orthogonal.md")!]);
    expect(orthogonalTop).toBe(COSINE_SCORE_ORTHOGONAL);
    expect(orthogonalTop!).toBeLessThan(LOW_CONFIDENCE_SCORE_THRESHOLD);
  });

  it("counts a negative cosine as low confidence but a corrupt NULL as no score", async () => {
    // End of the line: what the two cases do to the dashboard. Both come back
    // from the same reducer; only one is a reading.
    const byFile = await search();
    const actual =
      await vi.importActual<typeof import("../db/analytics.js")>(
        "../db/analytics.js",
      );
    await db.query("DELETE FROM query_log");
    const cases: Array<[string, ChunkResult[]]> = [
      ["pointed away", [byFile.get("opposed.md")!]],
      ["degenerate row", [byFile.get("zero.md")!]],
    ];
    for (const [text, rows] of cases) {
      await actual.logQuery({
        tool_name: "search-docs",
        query_text: text,
        result_count: rows.length,
        top_score: topCosineScore(rows),
        latency_ms: 10,
        source_name: "docs",
        session_id: null,
      });
    }

    const summary = await getAnalyticsSummary({}, 7);
    expect(summary.total_queries_window).toBe(2);
    // Only the -1 row. The corrupt row logged a NULL top_score, and NULL is
    // excluded from the low-confidence FILTER.
    expect(summary.low_confidence_count_window).toBe(1);
  });

  it("gives FAQ rows an explicit null cosine — they compare no embedding at all", async () => {
    // BOTH FAQ readers: getFaqChunksByIds (the knowledge tool's search path)
    // and getFaqChunks (its browse path). Neither selects a real similarity.
    const byIds = await getFaqChunksByIds([...ids.values()]);
    const browsed = await getFaqChunks(["docs"], 0.5);

    // Each reader has to have actually SEEN the FAQ row. Asserting only on the
    // combined list let the by-id half return four non-FAQ rows and still look
    // like it had exercised the FAQ contract.
    expect(byIds.map((r) => r.file_path)).toContain("faq.md");
    expect(browsed.map((r) => r.file_path)).toContain("faq.md");

    const faq = [...byIds, ...browsed];
    // Every seeded row by id, plus the one confident FAQ row from browse.
    expect(faq).toHaveLength(ids.size + 1);
    for (const row of faq) {
      // Present-and-null, not absent: `0.0 AS similarity` is a placeholder, so
      // an absent key would let these rows silently inherit "unknown" instead
      // of declaring they carry no relevance score.
      expect(Object.hasOwn(row, "cosine_similarity")).toBe(true);
      expect(row.cosine_similarity).toBeNull();
    }
    expect(topCosineScore(faq)).toBeNull();
  });
});

// ── The DB-value coercion itself ─────────────────────────────────────────────

describe("cosine coercion distinguishes absence and corruption from a real 0", () => {
  /** Minimal pool that hands searchChunks one row with the given similarity. */
  function poolReturning(similarity: unknown) {
    return {
      query: async () => ({
        rows: [
          {
            id: 1,
            source_name: "docs",
            source_url: null,
            title: null,
            content: "x",
            repo_url: null,
            file_path: "a.md",
            start_line: null,
            end_line: null,
            language: null,
            similarity,
          },
        ],
      }),
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release: () => {},
      }),
      end: async () => {},
    };
  }

  async function cosineFor(similarity: unknown): Promise<number | null> {
    __setPoolForTesting(poolReturning(similarity));
    try {
      const [r] = await searchChunks([0.1, 0.2, 0.3], 5);
      return r.cosine_similarity;
    } finally {
      __resetPoolForTesting();
    }
  }

  it("maps a non-finite value to null", async () => {
    // node-postgres hands back float8 NaN as the string "NaN".
    expect(await cosineFor("NaN")).toBeNull();
    expect(await cosineFor(NaN)).toBeNull();
    expect(await cosineFor("not-a-number")).toBeNull();
    expect(await cosineFor(Infinity)).toBeNull();
  });

  it("maps an absent/empty value to null rather than riding Number()'s 0", async () => {
    // Number(null) and Number("") are both 0 — the coercion `toFiniteNumber`
    // uses for the RANKING score. An absent column is an absent score.
    expect(await cosineFor(null)).toBeNull();
    expect(await cosineFor(undefined)).toBeNull();
    expect(await cosineFor("")).toBeNull();
  });

  it("preserves a genuine 0 and a genuine negative", async () => {
    expect(await cosineFor("0")).toBe(0);
    expect(await cosineFor(0)).toBe(0);
    expect(await cosineFor("-0.42")).toBeCloseTo(-0.42);
  });
});

// ── The invariant is enforced by the type, not by convention ─────────────────

describe("ChunkResult.cosine_similarity is required", () => {
  it("does not compile without it", () => {
    const base = {
      id: 1,
      source_name: "docs",
      source_url: null,
      title: null,
      content: "x",
      repo_url: null,
      file_path: "a.md",
      start_line: null,
      end_line: null,
      language: null,
      similarity: 0.5,
    };
    // The guard for symptom 5: a retriever that FORGETS the field must not
    // compile. `@ts-expect-error` is itself an error when there is nothing to
    // suppress, so making the field optional again fails `npm run build` —
    // which is the only place this invariant can be checked, since a missing
    // field is invisible at runtime.
    // @ts-expect-error cosine_similarity is REQUIRED (nullable is the opt-out)
    const forgotten: ChunkResult = base;
    // Nullable IS the sanctioned opt-out, and stays legal.
    const declared: ChunkResult = { ...base, cosine_similarity: null };

    expect(forgotten.cosine_similarity).toBeUndefined();
    expect(declared.cosine_similarity).toBeNull();
    expect(topCosineScore([declared])).toBeNull();
  });
});
