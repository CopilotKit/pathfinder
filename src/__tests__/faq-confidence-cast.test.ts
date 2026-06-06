import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { __setPoolForTesting, __resetPoolForTesting } from "../db/client.js";
import { getFaqChunks, getFaqChunksByIds } from "../db/queries.js";

// Integration test (real in-process PGlite) for the getFaqChunksByIds
// confidence-cast guard. A single FAQ row whose metadata.confidence is
// non-numeric text (e.g. "high") must NOT fail the whole id lookup with
// `invalid input syntax for type double precision` — the malformed row should
// degrade to 0.0 confidence while every other row in the id set still returns.
//
// Mock-pool unit tests can only assert the SQL string; the actual cast crash
// only reproduces against a real Postgres engine, so we run the query
// end-to-end here.

// Minimal chunks DDL — only the columns getFaqChunksByIds selects (no pgvector
// extension / embedding column needed, since the by-id lookup never touches the
// vector).
const CHUNKS_DDL = `
  CREATE TABLE chunks (
    id          SERIAL PRIMARY KEY,
    source_name TEXT NOT NULL,
    source_url  TEXT,
    title       TEXT,
    content     TEXT NOT NULL,
    repo_url    TEXT,
    file_path   TEXT NOT NULL,
    start_line  INT,
    end_line    INT,
    language    TEXT,
    metadata    JSONB NOT NULL DEFAULT '{}',
    indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

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

async function insertChunk(
  db: PGlite,
  filePath: string,
  metadata: Record<string, unknown>,
): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO chunks (source_name, content, file_path, metadata)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    ["slack-faq", "Q: x\n\nA: y", filePath, JSON.stringify(metadata)],
  );
  return rows[0].id;
}

describe("getFaqChunksByIds confidence-cast guard (PGlite integration)", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.waitReady;
    await db.exec(CHUNKS_DDL);
    __setPoolForTesting(poolFromPglite(db));
  });

  afterAll(async () => {
    __resetPoolForTesting();
    await db.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM chunks");
  });

  it("does not crash when one row in the id set has a non-numeric confidence", async () => {
    const goodId = await insertChunk(db, "good.md", { confidence: 0.85 });
    const badId = await insertChunk(db, "bad.md", { confidence: "high" });

    // The whole lookup must succeed (not reject with "invalid input syntax for
    // type double precision").
    const rows = await getFaqChunksByIds([goodId, badId]);

    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((r) => [r.id, r]));
    // The well-formed numeric row keeps its value.
    expect(byId.get(goodId)!.confidence).toBe(0.85);
    // The malformed row degrades to 0.0 rather than crashing the query.
    expect(byId.get(badId)!.confidence).toBe(0.0);
  });

  it("treats a missing confidence key as 0.0", async () => {
    const id = await insertChunk(db, "nometa.md", { channel: "C1" });
    const rows = await getFaqChunksByIds([id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].confidence).toBe(0.0);
  });
});

// getFaqChunks (the browse listing) has the same UNGUARDED confidence cast in
// BOTH its projection and its WHERE clause. Unlike getFaqChunksByIds, it filters
// `metadata ? 'confidence'` — but a row whose `confidence` KEY EXISTS yet holds
// non-numeric text (e.g. "high") still passes that key check and then crashes
// the `(metadata->>'confidence')::float` cast with "invalid input syntax for
// type double precision", taking down the WHOLE browse listing. Both casts must
// be jsonb_typeof-guarded like getFaqChunksByIds so one bad row degrades to 0.0
// instead of rejecting every entry.
describe("getFaqChunks confidence-cast guard (PGlite integration)", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.waitReady;
    await db.exec(CHUNKS_DDL);
    __setPoolForTesting(poolFromPglite(db));
  });

  afterAll(async () => {
    __resetPoolForTesting();
    await db.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM chunks");
  });

  it("does not crash the browse listing when a row has a non-numeric confidence", async () => {
    // Both rows have the `confidence` key (so both pass `metadata ? 'confidence'`),
    // but one is the string "high". The WHERE cast would crash the whole query.
    await insertChunk(db, "good.md", { confidence: 0.85 });
    await insertChunk(db, "bad.md", { confidence: "high" });

    // The listing must succeed (not reject with "invalid input syntax for type
    // double precision"). The malformed row degrades to 0.0 confidence and is
    // filtered out by the minConfidence threshold; the good row survives.
    const rows = await getFaqChunks(["slack-faq"], 0.5);

    const byPath = new Map(rows.map((r) => [r.file_path, r]));
    expect(byPath.has("good.md")).toBe(true);
    expect(byPath.get("good.md")!.confidence).toBe(0.85);
    // The "high" row degrades to 0.0 < 0.5, so it's excluded — but crucially the
    // query did not crash.
    expect(byPath.has("bad.md")).toBe(false);
  });

  it("includes a degraded-to-0.0 row when the confidence threshold is 0", async () => {
    await insertChunk(db, "bad.md", { confidence: "high" });
    // threshold 0 admits the degraded 0.0 row; the point is the query runs.
    const rows = await getFaqChunks(["slack-faq"], 0);
    const bad = rows.find((r) => r.file_path === "bad.md");
    expect(bad).toBeDefined();
    expect(bad!.confidence).toBe(0.0);
  });
});
