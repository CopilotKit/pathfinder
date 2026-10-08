import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { generateDimensionCheckQuery, generateSchema } from "../db/schema.js";

// Absolute, so the test does not depend on the working directory.
// The fixture config declares embedding.dimensions: 1536.
const FIXTURE_CONFIG = fileURLToPath(
  new URL("../../fixtures/breeze-api/pathfinder.yaml", import.meta.url),
);

type DimensionRow = { dimensions: number | null };

/** A pgvector literal with `n` components. */
function vectorLiteral(n: number): string {
  return `[${Array.from({ length: n }, () => "0.1").join(",")}]`;
}

/**
 * Create chunks with generateSchema, then change the embedding column to
 * `columnType`. The HNSW index cannot exist on an unsized or non-vector
 * column, so it is replaced with a plain index of the same name; the
 * startup DDL (CREATE INDEX IF NOT EXISTS) then leaves it alone.
 */
async function seedChunks(
  db: PGlite,
  columnType: string,
  rowDimensions: (number | null)[] = [],
): Promise<void> {
  await db.exec(generateSchema(3));
  await db.exec(`
DROP INDEX idx_chunks_embedding;
ALTER TABLE chunks ALTER COLUMN embedding TYPE ${columnType} USING NULL;
CREATE INDEX idx_chunks_embedding ON chunks (id);
`);
  // A null entry inserts a row with a NULL embedding (a legacy column that
  // lost its NOT NULL constraint). Rows are inserted in order, so a null
  // first entry is the row a bare LIMIT 1 returns.
  if (rowDimensions.includes(null)) {
    await db.exec("ALTER TABLE chunks ALTER COLUMN embedding DROP NOT NULL;");
  }
  for (const [i, n] of rowDimensions.entries()) {
    await db.query(
      `INSERT INTO chunks (source_name, content, embedding, file_path, chunk_index)
       VALUES ('s', 'c', $1, 'f', $2)`,
      [n === null ? null : vectorLiteral(n), i],
    );
  }
}

describe("generateDimensionCheckQuery", { timeout: 30_000 }, () => {
  it("reads the declared vector dimension even when chunks is empty", async () => {
    const db = new PGlite({ extensions: { vector } });
    try {
      await db.exec(generateSchema(8));
      const res = await db.query<DimensionRow>(generateDimensionCheckQuery());
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0].dimensions).toBe(8);
    } finally {
      await db.close();
    }
  });

  it("returns no rows when the chunks table does not exist", async () => {
    const db = new PGlite({ extensions: { vector } });
    try {
      const res = await db.query(generateDimensionCheckQuery());
      expect(res.rows).toHaveLength(0);
    } finally {
      await db.close();
    }
  });

  it("returns a null dimension for an unsized vector column", async () => {
    const db = new PGlite({ extensions: { vector } });
    try {
      await seedChunks(db, "vector");
      const res = await db.query<DimensionRow>(generateDimensionCheckQuery());
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0].dimensions).toBeNull();
    } finally {
      await db.close();
    }
  });

  it("does not read a typmod from a non-vector column as a dimension", async () => {
    const db = new PGlite({ extensions: { vector } });
    try {
      await seedChunks(db, "varchar(10)");
      const res = await db.query<DimensionRow>(generateDimensionCheckQuery());
      expect(res.rows).toHaveLength(1);
      // varchar(10) has atttypmod 14; that is not a vector dimension.
      expect(res.rows[0].dimensions).toBeNull();
    } finally {
      await db.close();
    }
  });
});

describe("initializeSchema dimension check", { timeout: 30_000 }, () => {
  let dir: string;
  const savedEnv = { ...process.env };

  /** Replace the database at `dir` with a freshly seeded one. */
  async function seed(fn: (db: PGlite) => Promise<unknown>): Promise<void> {
    rmSync(dir, { recursive: true, force: true });
    const db = new PGlite({ dataDir: dir, extensions: { vector } });
    try {
      await fn(db);
    } finally {
      await db.close();
    }
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pf-dim-"));
    vi.resetModules();
    process.env.DATABASE_URL = `pglite://${dir}`;
    process.env.OPENAI_API_KEY = "test-key";
    process.env.PATHFINDER_CONFIG = FIXTURE_CONFIG;
  });

  afterEach(async () => {
    const { closePool } = await import("../db/client.js");
    await closePool();
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails fast on an empty table whose declared dimension does not match", async () => {
    await seed((db) => db.exec(generateSchema(8)));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { initializeSchema } = await import("../db/client.js");
    const err = await initializeSchema().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain(
      "Embedding dimension mismatch: database=8, config=1536",
    );
    // The remediation must name something that exists; there is no
    // `pathfinder reindex` command.
    expect(message).not.toContain("reindex --force");
    expect(message).toContain("DROP TABLE chunks, index_state");
    expect(message).toContain("pathfinder serve");
    expect(errSpy).toHaveBeenCalled();
    expect(String(errSpy.mock.calls[0][0])).not.toContain("reindex --force");
  });

  it("starts when the declared dimension matches", async () => {
    await seed((db) => db.exec(generateSchema(1536)));
    const { initializeSchema } = await import("../db/client.js");
    await expect(initializeSchema()).resolves.toBeUndefined();
  });

  it("fails fast on a populated table whose declared dimension does not match", async () => {
    await seed(async (db) => {
      await db.exec(generateSchema(8));
      await db.query(
        `INSERT INTO chunks (source_name, content, embedding, file_path, chunk_index)
         VALUES ('s', 'c', $1, 'f', 0)`,
        [vectorLiteral(8)],
      );
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { initializeSchema } = await import("../db/client.js");
    await expect(initializeSchema()).rejects.toThrow(
      "Embedding dimension mismatch: database=8, config=1536",
    );
  });

  it("fails fast on an unsized vector column whose stored rows do not match", async () => {
    await seed((db) => seedChunks(db, "vector", [3]));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { initializeSchema } = await import("../db/client.js");
    await expect(initializeSchema()).rejects.toThrow(
      "Embedding dimension mismatch: database=3, config=1536",
    );
  });

  it("starts on an unsized vector column whose stored rows match", async () => {
    await seed((db) => seedChunks(db, "vector", [1536]));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { initializeSchema } = await import("../db/client.js");
    await expect(initializeSchema()).resolves.toBeUndefined();
    const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((w) => w.includes("Dimension check"))).toBe(false);
  });

  it("logs that the check could not run on an empty unsized vector column", async () => {
    await seed((db) => seedChunks(db, "vector"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { initializeSchema } = await import("../db/client.js");
    await expect(initializeSchema()).resolves.toBeUndefined();
    const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(
      warnings.some(
        (w) =>
          w.includes("Dimension check NOT performed") &&
          w.includes("no declared dimension") &&
          w.includes("no rows"),
      ),
    ).toBe(true);
  });

  it("starts on an unsized vector column whose first row has a NULL embedding and the rest match", async () => {
    await seed((db) => seedChunks(db, "vector", [null, 1536]));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { initializeSchema } = await import("../db/client.js");
    await expect(initializeSchema()).resolves.toBeUndefined();
    const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((w) => w.includes("Dimension check"))).toBe(false);
  });

  it("fails fast on an unsized vector column whose first row is NULL and the rest do not match", async () => {
    await seed((db) => seedChunks(db, "vector", [null, 3]));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { initializeSchema } = await import("../db/client.js");
    await expect(initializeSchema()).rejects.toThrow(
      "Embedding dimension mismatch: database=3, config=1536",
    );
  });

  it("logs that the check could not run when every stored embedding is NULL", async () => {
    await seed((db) => seedChunks(db, "vector", [null]));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { initializeSchema } = await import("../db/client.js");
    await expect(initializeSchema()).resolves.toBeUndefined();
    const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(
      warnings.some(
        (w) =>
          w.includes("Dimension check NOT performed") &&
          w.includes("no declared dimension") &&
          w.includes("no rows"),
      ),
    ).toBe(true);
  });

  it("fails fast with a clear error on a non-vector column", async () => {
    // initializePGlite's DDL fails on a varchar embedding column before the
    // check runs, so call the check directly. On Postgres the check runs
    // before the DDL (initializeSchema), which is where this case matters.
    const db = new PGlite({ extensions: { vector } });
    try {
      await seedChunks(db, "varchar(10)");
      const pool = {
        query: (text: string, params?: unknown[]) => db.query(text, params),
      } as unknown as pg.Pool;
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { checkDimensionMismatch } = await import("../db/client.js");
      const err = await checkDimensionMismatch(pool, 1536).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      expect(message).toContain(
        "chunks.embedding has type character varying(10), expected vector(1536)",
      );
      expect(message).toContain("DROP TABLE chunks, index_state");
      expect(errSpy).toHaveBeenCalled();
    } finally {
      await db.close();
    }
  });
});
