import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { __setPoolForTesting, __resetPoolForTesting } from "../db/client.js";
import { getFaqChunks } from "../db/queries.js";

// Behavioral (real in-process PGlite) test for the getFaqChunks browse LIMIT.
//
// The browse listing documents "most-recent N across all queried sources". The
// fix replaced a `source_name`-leading ORDER BY with `ORDER BY indexed_at DESC,
// id DESC` so a global LIMIT is not consumed entirely by the alphabetically-
// first source — starving more-recent rows from later sources to zero. A mock
// pool can only echo a hand-picked row and so cannot exercise ORDER BY / LIMIT
// semantics; only a real engine proves the ordering. We construct the adversarial
// case: the alphabetically-LATER source ("slack-support") holds the most-recent
// rows, the alphabetically-FIRST source ("discord-faq") holds older rows, and a
// small LIMIT must return the globally-most-recent rows regardless of source.

// Minimal chunks DDL — only the columns getFaqChunks selects. indexed_at drives
// the recency ordering under test.
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
  sourceName: string,
  filePath: string,
  indexedAtIso: string,
): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO chunks (source_name, content, file_path, metadata, indexed_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      sourceName,
      "Q: x\n\nA: y",
      filePath,
      JSON.stringify({ confidence: 0.9 }),
      indexedAtIso,
    ],
  );
  return rows[0].id;
}

describe("getFaqChunks browse ordering (PGlite integration)", () => {
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

  it("returns the globally-most-recent rows across sources under a small LIMIT (not starved by the alphabetically-first source)", async () => {
    // "discord-faq" sorts alphabetically BEFORE "slack-support". Make its rows
    // the OLDEST so a source_name-leading ORDER BY would (wrongly) return them
    // first and starve the more-recent slack-support rows under a small LIMIT.
    await insertChunk(db, "discord-faq", "d-old-1.md", "2024-01-01T00:00:00Z");
    await insertChunk(db, "discord-faq", "d-old-2.md", "2024-01-02T00:00:00Z");
    // "slack-support" holds the two globally-most-recent rows.
    await insertChunk(
      db,
      "slack-support",
      "s-new-1.md",
      "2024-06-01T00:00:00Z",
    );
    await insertChunk(
      db,
      "slack-support",
      "s-new-2.md",
      "2024-06-02T00:00:00Z",
    );

    const rows = await getFaqChunks(["discord-faq", "slack-support"], 0.5, 2);

    // With global-recency ordering, the two returned rows are the most-recent
    // overall — both from the alphabetically-LATER source. A source_name-leading
    // ORDER BY would instead return the two discord-faq rows.
    expect(rows).toHaveLength(2);
    const paths = rows.map((r) => r.file_path);
    expect(paths).toEqual(["s-new-2.md", "s-new-1.md"]);
    // Sanity: the older alphabetically-first source is NOT in the limited result.
    expect(paths).not.toContain("d-old-1.md");
    expect(paths).not.toContain("d-old-2.md");
  });

  it("orders the full multi-source result by global recency, then id DESC", async () => {
    // Interleave recency across sources to prove the ordering is global, not
    // grouped by source. id DESC is the deterministic tie-breaker for equal
    // indexed_at.
    const tie = "2024-03-03T00:00:00Z";
    await insertChunk(db, "slack-support", "newest.md", "2024-09-09T00:00:00Z");
    await insertChunk(db, "discord-faq", "mid.md", "2024-05-05T00:00:00Z");
    const tieEarlyId = await insertChunk(db, "discord-faq", "tie-a.md", tie);
    const tieLateId = await insertChunk(db, "slack-support", "tie-b.md", tie);
    await insertChunk(db, "slack-support", "oldest.md", "2024-01-01T00:00:00Z");

    const rows = await getFaqChunks(["discord-faq", "slack-support"], 0.5);
    const paths = rows.map((r) => r.file_path);

    // Newest first, oldest last; the two equal-indexed_at rows are ordered by
    // id DESC (tie-b inserted after tie-a → higher id → comes first).
    expect(tieLateId).toBeGreaterThan(tieEarlyId);
    expect(paths).toEqual([
      "newest.md",
      "mid.md",
      "tie-b.md",
      "tie-a.md",
      "oldest.md",
    ]);
  });
});
