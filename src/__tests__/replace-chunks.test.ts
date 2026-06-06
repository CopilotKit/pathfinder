import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Chunk } from "../types.js";

// Mock the db client to intercept the pooled-client lifecycle. replaceChunksForFile
// must acquire a single client via pool.connect() and run BEGIN → DELETE → INSERT…
// → COMMIT (or ROLLBACK on failure) on THAT client, mirroring upsertChunks. This
// follows the faq-queries.test.ts pattern of mocking ../db/client.js.

const clientQuery = vi.fn();
const clientRelease = vi.fn();
const connect = vi.fn(async () => ({
  query: clientQuery,
  release: clientRelease,
}));

vi.mock("../db/client.js", () => ({
  getPool: () => ({ connect }),
}));

// Import AFTER mocking so queries.ts binds to the mocked getPool.
import { replaceChunksForFile } from "../db/queries.js";

function mkChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    source_name: "docs",
    source_url: null,
    title: "T",
    content: "body",
    embedding: [0.1, 0.2, 0.3],
    repo_url: null,
    file_path: "docs/a.md",
    start_line: null,
    end_line: null,
    language: null,
    chunk_index: 0,
    metadata: {},
    commit_sha: "sha",
    version: null,
    ...overrides,
  };
}

describe("replaceChunksForFile (atomic delete + insert)", () => {
  beforeEach(() => {
    clientQuery.mockReset();
    clientRelease.mockReset();
    connect.mockClear();
    clientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("runs DELETE then INSERTs inside a single BEGIN/COMMIT on one client", async () => {
    await replaceChunksForFile("docs", "docs/a.md", [
      mkChunk({ chunk_index: 0 }),
      mkChunk({ chunk_index: 1 }),
    ]);

    // One client acquired and released.
    expect(connect).toHaveBeenCalledTimes(1);
    expect(clientRelease).toHaveBeenCalledTimes(1);

    const issued = clientQuery.mock.calls.map((c) => String(c[0]));
    expect(issued[0]).toBe("BEGIN");
    // DELETE is scoped to the (source_name, file_path) pair and runs before any insert.
    expect(issued[1]).toContain("DELETE FROM chunks");
    expect(clientQuery.mock.calls[1][1]).toEqual(["docs", "docs/a.md"]);
    // Two inserts for two chunks.
    const insertCount = issued.filter((s) =>
      s.includes("INSERT INTO chunks"),
    ).length;
    expect(insertCount).toBe(2);
    // Commits, never rolls back, on the happy path.
    expect(issued).toContain("COMMIT");
    expect(issued).not.toContain("ROLLBACK");
  });

  it("ROLLS BACK and rethrows when an INSERT fails, leaving pre-existing chunks intact", async () => {
    // BEGIN ok, DELETE ok, first INSERT throws.
    clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // DELETE
      .mockRejectedValueOnce(new Error("insert exploded")) // INSERT #1
      .mockResolvedValue({ rows: [] }); // ROLLBACK

    await expect(
      replaceChunksForFile("docs", "docs/a.md", [mkChunk()]),
    ).rejects.toThrow("insert exploded");

    const issued = clientQuery.mock.calls.map((c) => String(c[0]));
    // The transaction must be rolled back (NOT committed) so the DELETE never
    // becomes durable — the file's PRE-EXISTING chunks survive intact, not zero.
    expect(issued).toContain("ROLLBACK");
    expect(issued).not.toContain("COMMIT");
    // Client is always released even on the error path.
    expect(clientRelease).toHaveBeenCalledTimes(1);
  });

  it("performs a delete-only transaction when given an empty chunk array", async () => {
    await replaceChunksForFile("docs", "docs/gone.md", []);

    const issued = clientQuery.mock.calls.map((c) => String(c[0]));
    expect(issued[0]).toBe("BEGIN");
    expect(issued[1]).toContain("DELETE FROM chunks");
    expect(issued.some((s) => s.includes("INSERT INTO chunks"))).toBe(false);
    expect(issued).toContain("COMMIT");
  });
});
