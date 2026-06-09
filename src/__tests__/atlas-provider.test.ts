import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { __setPoolForTesting, __resetPoolForTesting } from "../db/client.js";
import { generatePostSchemaMigration } from "../db/schema.js";
import * as atlasDb from "../db/atlas.js";
import {
  approveAtlasSeedEntry,
  getAtlasStateToken,
  markAtlasCachePageStale,
  rejectAtlasSeedEntry,
  upsertAtlasCachePage,
  upsertAtlasSeedCandidate,
} from "../db/atlas.js";
import { AtlasDataProvider } from "../indexing/providers/atlas.js";
import { getProvider } from "../indexing/providers/index.js";
import type { AtlasSourceConfig, SourceConfig } from "../types.js";

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

const atlasConfig: AtlasSourceConfig = {
  type: "atlas",
  name: "atlas",
  chunk: { target_tokens: 500 },
  cache_namespace: "default",
};

describe("AtlasDataProvider", () => {
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

  it("requires an atlas source config", () => {
    expect(
      () =>
        new AtlasDataProvider(
          {
            type: "markdown",
            name: "docs",
            chunk: { target_tokens: 500 },
            path: ".",
            file_patterns: ["*.md"],
          } as SourceConfig,
          { cloneDir: "/tmp" },
        ),
    ).toThrow("AtlasDataProvider requires an atlas source config");
  });

  it("acquires approved seed entries and fresh cache pages as ContentItems", async () => {
    await upsertAtlasSeedCandidate({
      canonicalKey: "runtime:why",
      sourceName: "atlas",
      repoUrl: "https://github.com/CopilotKit/pathfinder",
      ref: "main",
      subsystem: "runtime",
      title: "Runtime why",
      content: "Approved seed rationale",
      provenance: { source: "pr" },
      evidence: [{ url: "https://example.test/pr/1" }],
    });
    await approveAtlasSeedEntry("runtime:why", "reviewer");
    await upsertAtlasSeedCandidate({
      canonicalKey: "runtime:pending",
      sourceName: "atlas",
      title: "Pending",
      content: "Pending content",
      provenance: {},
      evidence: [],
    });
    await upsertAtlasCachePage({
      pageKey: "runtime/overview",
      sourceName: "atlas",
      title: "Runtime overview",
      content: "Generated cache page",
      contentHash: "cache-hash",
      generatedSeedIds: [1],
    });
    await upsertAtlasCachePage({
      pageKey: "runtime/stale",
      sourceName: "atlas",
      title: "Runtime stale",
      content: "Stale cache page",
      contentHash: "stale-hash",
    });
    await markAtlasCachePageStale("runtime/stale", "seed changed");

    const provider = new AtlasDataProvider(atlasConfig, { cloneDir: "/tmp" });
    const result = await provider.fullAcquire();

    expect(result.removedIds).toEqual(["atlas-cache:runtime/stale"]);
    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.id)).toEqual([
      "atlas-seed:runtime:why",
      "atlas-cache:runtime/overview",
    ]);
    expect(result.items[0]).toMatchObject({
      title: "Runtime why",
      content: "Approved seed rationale",
      sourceUrl: "atlas://seed/runtime%3Awhy",
      metadata: {
        atlas_kind: "seed",
        atlas_key: "runtime:why",
        source_name: "atlas",
        repo_url: "https://github.com/CopilotKit/pathfinder",
        ref: "main",
        subsystem: "runtime",
      },
    });
    expect(result.items[1]).toMatchObject({
      title: "Runtime overview",
      content: "Generated cache page",
      sourceUrl: "atlas://cache/runtime%2Foverview",
      metadata: {
        atlas_kind: "cache",
        atlas_page_key: "runtime/overview",
        source_name: "atlas",
        content_hash: "cache-hash",
      },
    });
    expect(result.stateToken).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("incrementally acquires only entries changed after the state token", async () => {
    await upsertAtlasSeedCandidate({
      canonicalKey: "old",
      sourceName: "atlas",
      title: "Old",
      content: "Old content",
      provenance: {},
      evidence: [],
    });
    await approveAtlasSeedEntry("old", "reviewer");
    await db.query(
      "UPDATE atlas_seed_entries SET updated_at = $2 WHERE canonical_key = $1",
      ["old", new Date("2026-01-01T00:00:00Z")],
    );

    const provider = new AtlasDataProvider(atlasConfig, { cloneDir: "/tmp" });
    const stateToken = await provider.getCurrentStateToken();
    expect(stateToken).toBe("2026-01-01T00:00:00.000000Z");

    await upsertAtlasSeedCandidate({
      canonicalKey: "new",
      sourceName: "atlas",
      title: "New",
      content: "New content",
      provenance: {},
      evidence: [],
    });
    await approveAtlasSeedEntry("new", "reviewer");
    await db.query(
      "UPDATE atlas_seed_entries SET updated_at = $2 WHERE canonical_key = $1",
      ["new", new Date("2026-01-02T00:00:00Z")],
    );

    const result = await provider.incrementalAcquire(stateToken ?? "");
    expect(result.items.map((item) => item.id)).toEqual(["atlas-seed:new"]);
  });

  it("enforces configured repository, ref, and subsystem filters", async () => {
    const runtime = await upsertAtlasSeedCandidate({
      canonicalKey: "runtime",
      sourceName: "atlas",
      repoUrl: "https://github.com/CopilotKit/pathfinder",
      ref: "main",
      subsystem: "runtime",
      title: "Runtime",
      content: "Runtime content",
      provenance: {},
      evidence: [],
    });
    await approveAtlasSeedEntry(runtime.canonicalKey, "reviewer");
    const docs = await upsertAtlasSeedCandidate({
      canonicalKey: "docs",
      sourceName: "atlas",
      repoUrl: "https://github.com/CopilotKit/pathfinder",
      ref: "main",
      subsystem: "docs",
      title: "Docs",
      content: "Docs content",
      provenance: {},
      evidence: [],
    });
    await approveAtlasSeedEntry(docs.canonicalKey, "reviewer");
    const otherRef = await upsertAtlasSeedCandidate({
      canonicalKey: "other-ref",
      sourceName: "atlas",
      repoUrl: "https://github.com/CopilotKit/pathfinder",
      ref: "release",
      subsystem: "runtime",
      title: "Other ref",
      content: "Other ref content",
      provenance: {},
      evidence: [],
    });
    await approveAtlasSeedEntry(otherRef.canonicalKey, "reviewer");
    await upsertAtlasCachePage({
      pageKey: "runtime/cache",
      sourceName: "atlas",
      title: "Runtime cache",
      content: "Runtime cache content",
      contentHash: "runtime-cache",
      generatedSeedIds: [runtime.id],
    });
    await upsertAtlasCachePage({
      pageKey: "docs/cache",
      sourceName: "atlas",
      title: "Docs cache",
      content: "Docs cache content",
      contentHash: "docs-cache",
      generatedSeedIds: [docs.id],
    });

    const provider = new AtlasDataProvider(
      {
        ...atlasConfig,
        repositories: [
          {
            repo_url: "https://github.com/CopilotKit/pathfinder",
            refs: ["main"],
            subsystems: ["runtime"],
          },
        ],
      },
      { cloneDir: "/tmp" },
    );

    const result = await provider.fullAcquire();

    expect(result.items.map((item) => item.id)).toEqual([
      "atlas-seed:runtime",
      "atlas-cache:runtime/cache",
    ]);
  });

  it("does not persist a state token newer than its bounded acquisition snapshot", async () => {
    await upsertAtlasSeedCandidate({
      canonicalKey: "included",
      sourceName: "atlas",
      title: "Included",
      content: "Included content",
      provenance: {},
      evidence: [],
    });
    await approveAtlasSeedEntry("included", "reviewer");
    await upsertAtlasSeedCandidate({
      canonicalKey: "future",
      sourceName: "atlas",
      title: "Future",
      content: "Future content",
      provenance: {},
      evidence: [],
    });
    await approveAtlasSeedEntry("future", "reviewer");
    await db.query(
      "UPDATE atlas_seed_entries SET updated_at = $2 WHERE canonical_key = $1",
      ["included", new Date("2026-01-01T00:00:00Z")],
    );
    await db.query(
      "UPDATE atlas_seed_entries SET updated_at = $2 WHERE canonical_key = $1",
      ["future", new Date("2026-01-02T00:00:00Z")],
    );

    const provider = new AtlasDataProvider(atlasConfig, { cloneDir: "/tmp" });
    const result = await provider.incrementalAcquire(
      "2025-12-31T00:00:00.000000Z",
    );

    expect(result.items.map((item) => item.id)).toEqual([
      "atlas-seed:included",
      "atlas-seed:future",
    ]);
    expect(result.stateToken).toBe("2026-01-02T00:00:00.000000Z");
  });

  it("bounds incremental acquisition to the token captured before listing rows", async () => {
    await upsertAtlasSeedCandidate({
      canonicalKey: "included",
      sourceName: "atlas",
      title: "Included",
      content: "Included content",
      provenance: {},
      evidence: [],
    });
    await approveAtlasSeedEntry("included", "reviewer");
    await db.query(
      "UPDATE atlas_seed_entries SET updated_at = $2 WHERE canonical_key = $1",
      ["included", new Date("2026-01-01T00:00:00Z")],
    );

    const provider = new AtlasDataProvider(atlasConfig, { cloneDir: "/tmp" });
    const capturedToken = "2026-01-01T00:00:00.000000Z";
    const lateToken = "2026-01-02T00:00:00.000000Z";
    const stateTokenSpy = vi
      .spyOn(atlasDb, "getAtlasStateToken")
      .mockImplementation(async () => {
        await upsertAtlasSeedCandidate({
          canonicalKey: "late",
          sourceName: "atlas",
          title: "Late",
          content: "Late content",
          provenance: {},
          evidence: [],
        });
        await approveAtlasSeedEntry("late", "reviewer");
        await db.query(
          "UPDATE atlas_seed_entries SET updated_at = $2 WHERE canonical_key = $1",
          ["late", new Date(lateToken)],
        );
        return capturedToken;
      });

    try {
      const result = await provider.incrementalAcquire(
        "2025-12-31T00:00:00.000000Z",
      );

      expect(stateTokenSpy).toHaveBeenCalledTimes(1);
      expect(result.items.map((item) => item.id)).toEqual([
        "atlas-seed:included",
      ]);
      expect(result.stateToken).toBe(capturedToken);
    } finally {
      stateTokenSpy.mockRestore();
    }

    expect(await getAtlasStateToken("atlas")).toBe(lateToken);

    const catchup = await provider.incrementalAcquire(capturedToken);
    expect(catchup.items.map((item) => item.id)).toEqual(["atlas-seed:late"]);
    expect(catchup.stateToken).toBe(lateToken);
  });

  it("incrementally removes stale cache pages and advances state token", async () => {
    await upsertAtlasCachePage({
      pageKey: "runtime/overview",
      sourceName: "atlas",
      title: "Runtime overview",
      content: "Generated cache page",
      contentHash: "cache-hash",
    });
    await db.query(
      "UPDATE atlas_cache_pages SET updated_at = $2 WHERE page_key = $1",
      ["runtime/overview", new Date("2026-01-01T00:00:00Z")],
    );

    const provider = new AtlasDataProvider(atlasConfig, { cloneDir: "/tmp" });
    const stateToken = await provider.getCurrentStateToken();
    expect(stateToken).toBe("2026-01-01T00:00:00.000000Z");

    await markAtlasCachePageStale("runtime/overview", "seed changed");
    await db.query(
      "UPDATE atlas_cache_pages SET updated_at = $2 WHERE page_key = $1",
      ["runtime/overview", new Date("2026-01-02T00:00:00Z")],
    );

    expect(await getAtlasStateToken("atlas")).toBe(
      "2026-01-02T00:00:00.000000Z",
    );

    const result = await provider.incrementalAcquire(stateToken ?? "");
    expect(result.items).toEqual([]);
    expect(result.removedIds).toEqual(["atlas-cache:runtime/overview"]);
    expect(result.stateToken).toBe("2026-01-02T00:00:00.000000Z");
  });

  it("incrementally removes rejected seeds and empty cache pages", async () => {
    const seed = await upsertAtlasSeedCandidate({
      canonicalKey: "seed-to-reject",
      sourceName: "atlas",
      title: "Seed to reject",
      content: "Seed content",
      provenance: {},
      evidence: [],
    });
    await rejectAtlasSeedEntry(seed.canonicalKey, "reviewer", "wrong");
    await upsertAtlasCachePage({
      pageKey: "runtime/empty",
      sourceName: "atlas",
      title: "Runtime empty",
      content: "",
      contentHash: "empty-hash",
      generatedSeedIds: [seed.id],
    });
    await db.query(
      "UPDATE atlas_seed_entries SET updated_at = $2 WHERE canonical_key = $1",
      ["seed-to-reject", new Date("2026-01-02T00:00:00Z")],
    );
    await db.query(
      "UPDATE atlas_cache_pages SET updated_at = $2 WHERE page_key = $1",
      ["runtime/empty", new Date("2026-01-03T00:00:00Z")],
    );

    const provider = new AtlasDataProvider(atlasConfig, { cloneDir: "/tmp" });
    const result = await provider.incrementalAcquire(
      "2026-01-01T00:00:00.000000Z",
    );

    expect(result.items).toEqual([]);
    expect(result.removedIds).toEqual([
      "atlas-seed:seed-to-reject",
      "atlas-cache:runtime/empty",
    ]);
    expect(result.stateToken).toBe("2026-01-03T00:00:00.000000Z");
  });

  it("provider registry resolves type atlas", () => {
    const factory = getProvider("atlas");
    const provider = factory(atlasConfig, { cloneDir: "/tmp" });
    expect(provider).toBeInstanceOf(AtlasDataProvider);
  });

  it("skips loudly when the current state token is null instead of running an empty window", async () => {
    // A null current token means the high-water read saw no rows (source empty
    // or unreadable). Carrying lastStateToken forward would build the window
    // `> T AND <= T`, which matches nothing — a silent no-op that masks a
    // possibly-failed high-water read. The pass must be skipped LOUDLY and the
    // guaranteed-empty acquire queries must NOT run.
    const stateTokenSpy = vi
      .spyOn(atlasDb, "getAtlasStateToken")
      .mockResolvedValue(null);
    const listSpy = vi.spyOn(atlasDb, "listIndexableAtlasContent");
    const removedSpy = vi.spyOn(atlasDb, "listRemovedAtlasContentIds");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const provider = new AtlasDataProvider(atlasConfig, { cloneDir: "/tmp" });
      const lastToken = "2026-01-01T00:00:00.000000Z";
      const result = await provider.incrementalAcquire(lastToken);

      expect(result).toEqual({
        items: [],
        removedIds: [],
        stateToken: lastToken,
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("state token was null"),
      );
      // Positive control: the state-token read MUST have fired. Without this a
      // broken ESM-binding interception (so the real impl ran instead of the
      // mock) would make the `.not.toHaveBeenCalled()` assertions below pass
      // vacuously and hide the regression.
      expect(stateTokenSpy).toHaveBeenCalled();
      // The empty-window acquire queries must never be issued.
      expect(listSpy).not.toHaveBeenCalled();
      expect(removedSpy).not.toHaveBeenCalled();
    } finally {
      stateTokenSpy.mockRestore();
      listSpy.mockRestore();
      removedSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("fails loud on a non-empty but unparseable lastStateToken instead of binding garbage", async () => {
    // A garbage checkpoint must never reach the `$N::timestamptz` bind. The
    // guard throws a context-bearing error (source name + offending token)
    // BEFORE any acquire query runs, so a corrupted checkpoint surfaces as a
    // loud failure rather than an Invalid-Date coercion or a Postgres parse
    // error with no source attribution.
    await upsertAtlasSeedCandidate({
      canonicalKey: "present",
      sourceName: "atlas",
      title: "Present",
      content: "Present content",
      provenance: {},
      evidence: [],
    });
    await approveAtlasSeedEntry("present", "reviewer");

    const provider = new AtlasDataProvider(atlasConfig, { cloneDir: "/tmp" });
    await expect(
      provider.incrementalAcquire("not-a-timestamp"),
    ).rejects.toThrow(/lastStateToken is not a valid microsecond state token/);
    await expect(
      provider.incrementalAcquire("not-a-timestamp"),
    ).rejects.toThrow(/"atlas"/);
  });

  it("fails loud on a JS-parseable but non-microsecond-format lastStateToken", async () => {
    // Strings like "2026" or "Jan 5 2026" satisfy `new Date(...)` but bind into
    // `$N::timestamptz` with different / locale-dependent semantics than the
    // fixed-width microsecond token getAtlasStateToken emits. The guard must
    // require the EXACT emitted shape so these loose values fail loud (with the
    // source name + offending token) instead of silently binding a different
    // instant.
    await upsertAtlasSeedCandidate({
      canonicalKey: "present",
      sourceName: "atlas",
      title: "Present",
      content: "Present content",
      provenance: {},
      evidence: [],
    });
    await approveAtlasSeedEntry("present", "reviewer");

    const provider = new AtlasDataProvider(atlasConfig, { cloneDir: "/tmp" });
    await expect(provider.incrementalAcquire("2026")).rejects.toThrow(
      /lastStateToken is not a valid microsecond state token/,
    );
    await expect(provider.incrementalAcquire("2026")).rejects.toThrow(
      /"atlas"/,
    );
    await expect(provider.incrementalAcquire("Jan 5 2026")).rejects.toThrow(
      /lastStateToken is not a valid microsecond state token/,
    );
  });

  it("fails loud on a corrupt lastStateToken even when the source is empty", async () => {
    // When the current state token is null (source empty/unreadable) the method
    // returns early. A corrupt checkpoint must STILL fail loud in that path,
    // otherwise garbage silently passes through and re-persists on every run of
    // an empty source. Validation runs BEFORE the null-token early return.
    const stateTokenSpy = vi
      .spyOn(atlasDb, "getAtlasStateToken")
      .mockResolvedValue(null);
    try {
      const provider = new AtlasDataProvider(atlasConfig, { cloneDir: "/tmp" });
      await expect(
        provider.incrementalAcquire("not-a-timestamp"),
      ).rejects.toThrow(
        /lastStateToken is not a valid microsecond state token/,
      );
      await expect(
        provider.incrementalAcquire("not-a-timestamp"),
      ).rejects.toThrow(/"atlas"/);
    } finally {
      stateTokenSpy.mockRestore();
    }
  });

  it("treats an empty lastStateToken as a first-run lower bound (no changedAfter)", async () => {
    // An empty checkpoint is the legitimate first-run signal: index everything
    // up to the current high-water mark with no `changedAfter` lower bound.
    await upsertAtlasSeedCandidate({
      canonicalKey: "first",
      sourceName: "atlas",
      title: "First",
      content: "First content",
      provenance: {},
      evidence: [],
    });
    await approveAtlasSeedEntry("first", "reviewer");
    await db.query(
      "UPDATE atlas_seed_entries SET updated_at = $2 WHERE canonical_key = $1",
      ["first", new Date("2026-01-01T00:00:00Z")],
    );

    const provider = new AtlasDataProvider(atlasConfig, { cloneDir: "/tmp" });
    const result = await provider.incrementalAcquire("");
    expect(result.items.map((item) => item.id)).toEqual(["atlas-seed:first"]);
    expect(result.stateToken).toBe("2026-01-01T00:00:00.000000Z");
  });
});
