import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { __setPoolForTesting, __resetPoolForTesting } from "../db/client.js";
import { generatePostSchemaMigration } from "../db/schema.js";
import {
  approveAtlasSeedEntry,
  listIndexableAtlasContent,
  markAtlasCachePagesStaleForSources,
  upsertAtlasCachePage,
  upsertAtlasSeedCandidate,
} from "../db/atlas.js";
import { gardenAtlasCachePages } from "../indexing/atlas-gardener.js";

const ATLAS_DDL_MARKER = "-- Atlas durable seed knowledge.";

function extractAtlasDdl(): string {
  const sql = generatePostSchemaMigration();
  const idx = sql.indexOf(ATLAS_DDL_MARKER);
  if (idx < 0) {
    throw new Error(`Could not locate "${ATLAS_DDL_MARKER}" in schema SQL`);
  }
  return sql.slice(idx);
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

describe("Atlas cache staleness and gardening", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.waitReady;
    await db.exec(extractAtlasDdl());
    __setPoolForTesting(poolFromPglite(db));
  });

  afterAll(async () => {
    __resetPoolForTesting();
    await db.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM atlas_cache_pages");
    await db.query("DELETE FROM atlas_seed_entries");
  });

  it("marks cache pages stale for affected seed sources without deleting seed", async () => {
    const seed = await upsertAtlasSeedCandidate({
      canonicalKey: "docs:runtime",
      sourceName: "docs",
      title: "Runtime rationale",
      content: "Runtime rationale seed",
      provenance: {},
      evidence: [],
    });
    await approveAtlasSeedEntry(seed.canonicalKey, "reviewer");
    await upsertAtlasCachePage({
      pageKey: "runtime/overview",
      sourceName: "atlas",
      title: "Runtime overview",
      content: "Generated runtime overview",
      contentHash: "hash-1",
      generatedSeedIds: [seed.id],
    });

    const marked = await markAtlasCachePagesStaleForSources(
      ["docs"],
      "source docs reindexed",
    );

    expect(marked).toBe(1);
    const indexable = await listIndexableAtlasContent("docs");
    expect(indexable.map((item) => `${item.kind}:${item.key}`)).toEqual([
      "seed:docs:runtime",
    ]);
    const cacheProjection = await listIndexableAtlasContent("atlas");
    expect(cacheProjection).toEqual([]);

    const { rows } = await db.query<{ status: string }>(
      "SELECT status FROM atlas_seed_entries WHERE canonical_key = $1",
      [seed.canonicalKey],
    );
    expect(rows[0]?.status).toBe("approved");
  });

  it("regenerates stale cache pages and clears stale state on success", async () => {
    await upsertAtlasCachePage({
      pageKey: "runtime/overview",
      sourceName: "atlas",
      title: "Runtime overview",
      content: "Old generated content",
      contentHash: "hash-old",
    });
    await markAtlasCachePagesStaleForSources(["atlas"], "manual refresh");

    const summary = await gardenAtlasCachePages({
      sourceName: "atlas",
      generatePage: async (page) => ({
        content: `Regenerated: ${page.title}`,
        generatedSeedIds: [42, 43],
        provenance: { generatedBy: "test-gardener" },
      }),
    });

    expect(summary).toEqual({ regenerated: 1, failed: 0 });
    const items = await listIndexableAtlasContent("atlas");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "cache",
      key: "runtime/overview",
      content: "Regenerated: Runtime overview",
      cachePage: {
        generatedSeedIds: [42, 43],
        provenance: { generatedBy: "test-gardener" },
      },
    });
  });

  it("keeps failed cache pages stale and records the error reason", async () => {
    await upsertAtlasCachePage({
      pageKey: "runtime/overview",
      sourceName: "atlas",
      title: "Runtime overview",
      content: "Old generated content",
      contentHash: "hash-old",
    });
    await markAtlasCachePagesStaleForSources(["atlas"], "manual refresh");

    const summary = await gardenAtlasCachePages({
      sourceName: "atlas",
      generatePage: async () => {
        throw new Error("generator unavailable");
      },
    });

    expect(summary).toEqual({ regenerated: 0, failed: 1 });
    const indexable = await listIndexableAtlasContent("atlas");
    expect(indexable).toEqual([]);
    const { rows } = await db.query<{
      stale: boolean;
      error_message: string | null;
    }>(
      "SELECT stale, error_message FROM atlas_cache_pages WHERE page_key = $1",
      ["runtime/overview"],
    );
    expect(rows[0]?.stale).toBe(true);
    expect(rows[0]?.error_message).toBe("generator unavailable");
  });
});
