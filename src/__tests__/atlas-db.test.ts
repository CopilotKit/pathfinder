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
import {
  approveAtlasSeedEntry,
  clearAtlasCachePageStale,
  getAtlasStateToken,
  listIndexableAtlasContent,
  listRemovedAtlasContentIds,
  listPendingAtlasSeedCandidates,
  markAtlasCachePageStale,
  rejectAtlasSeedEntry,
  upsertAtlasCachePage,
  upsertAtlasSeedCandidate,
  __testing,
} from "../db/atlas.js";

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

describe("Atlas DB helpers", () => {
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

  it("upserts seed candidates idempotently and preserves approved rows", async () => {
    const first = await upsertAtlasSeedCandidate({
      canonicalKey: "repo:main:runtime",
      sourceName: "atlas",
      repoUrl: "https://github.com/CopilotKit/pathfinder",
      ref: "main",
      subsystem: "runtime",
      title: "Runtime shape",
      content: "Initial rationale",
      provenance: { from: "pr" },
      evidence: [{ url: "https://example.test/pr/1" }],
    });

    const updatedPending = await upsertAtlasSeedCandidate({
      canonicalKey: "repo:main:runtime",
      sourceName: "atlas",
      title: "Runtime shape v2",
      content: "Updated rationale",
      provenance: { from: "issue" },
      evidence: [],
    });

    expect(updatedPending.id).toBe(first.id);
    expect(updatedPending.title).toBe("Runtime shape v2");
    expect(updatedPending.content).toBe("Updated rationale");
    expect(updatedPending.status).toBe("pending");

    await approveAtlasSeedEntry("repo:main:runtime", "reviewer@example.test");
    const duplicateApproved = await upsertAtlasSeedCandidate({
      canonicalKey: "repo:main:runtime",
      sourceName: "atlas",
      title: "Should not overwrite",
      content: "Should not overwrite",
      provenance: { from: "duplicate" },
      evidence: [],
    });

    expect(duplicateApproved.title).toBe("Runtime shape v2");
    expect(duplicateApproved.content).toBe("Updated rationale");
    expect(duplicateApproved.status).toBe("approved");
    expect(duplicateApproved.approvedBy).toBe("reviewer@example.test");
  });

  it("enforces approve/reject status transitions", async () => {
    await upsertAtlasSeedCandidate({
      canonicalKey: "pending:one",
      sourceName: "atlas",
      title: "Pending one",
      content: "Candidate one",
      provenance: {},
      evidence: [],
    });
    await upsertAtlasSeedCandidate({
      canonicalKey: "pending:two",
      sourceName: "atlas",
      title: "Pending two",
      content: "Candidate two",
      provenance: {},
      evidence: [],
    });

    const approved = await approveAtlasSeedEntry("pending:one", "alice");
    expect(approved.status).toBe("approved");
    expect(approved.approvedBy).toBe("alice");
    expect(approved.approvedAt).toBeTruthy();

    await expect(
      rejectAtlasSeedEntry("pending:one", "bob", "stale"),
    ).rejects.toThrow("Cannot reject atlas seed entry");

    const rejected = await rejectAtlasSeedEntry("pending:two", "bob", "stale");
    expect(rejected.status).toBe("rejected");
    expect(rejected.rejectedBy).toBe("bob");
    expect(rejected.rejectionReason).toBe("stale");

    await expect(approveAtlasSeedEntry("pending:two", "alice")).rejects.toThrow(
      "Cannot approve atlas seed entry",
    );
  });

  it("lists pending seed candidates oldest first with source filtering", async () => {
    await upsertAtlasSeedCandidate({
      canonicalKey: "one",
      sourceName: "atlas-a",
      title: "One",
      content: "One content",
      provenance: {},
      evidence: [],
    });
    await upsertAtlasSeedCandidate({
      canonicalKey: "two",
      sourceName: "atlas-b",
      title: "Two",
      content: "Two content",
      provenance: {},
      evidence: [],
    });
    await upsertAtlasSeedCandidate({
      canonicalKey: "three",
      sourceName: "atlas-a",
      title: "Three",
      content: "Three content",
      provenance: {},
      evidence: [],
    });
    await approveAtlasSeedEntry("one", "reviewer");

    const allPending = await listPendingAtlasSeedCandidates();
    expect(allPending.map((row) => row.canonicalKey)).toEqual(["two", "three"]);

    const sourcePending = await listPendingAtlasSeedCandidates({
      sourceName: "atlas-a",
    });
    expect(sourcePending.map((row) => row.canonicalKey)).toEqual(["three"]);
  });

  it("upserts cache pages and marks/clears stale state", async () => {
    const page = await upsertAtlasCachePage({
      pageKey: "runtime/overview",
      sourceName: "atlas",
      title: "Runtime overview",
      content: "Generated page body",
      contentHash: "hash-1",
      generatedSeedIds: [1, 2],
      provenance: { generatedBy: "gardener" },
      generatedAt: new Date("2026-01-01T00:00:00Z"),
    });

    expect(page.stale).toBe(false);
    expect(page.content).toBe("Generated page body");
    expect(page.generatedSeedIds).toEqual([1, 2]);

    const stale = await markAtlasCachePageStale(
      "runtime/overview",
      "seed changed",
    );
    expect(stale.stale).toBe(true);
    expect(stale.staleReason).toBe("seed changed");

    const regenerated = await clearAtlasCachePageStale({
      pageKey: "runtime/overview",
      content: "Regenerated body",
      contentHash: "hash-2",
      generatedSeedIds: [3],
      provenance: { regeneratedBy: "gardener-v2" },
      generatedAt: new Date("2026-01-02T00:00:00Z"),
    });
    expect(regenerated.stale).toBe(false);
    expect(regenerated.staleReason).toBeNull();
    expect(regenerated.contentHash).toBe("hash-2");
    expect(regenerated.content).toBe("Regenerated body");
    expect(regenerated.generatedSeedIds).toEqual([3]);
    expect(regenerated.provenance).toMatchObject({
      generatedBy: "gardener",
      regeneratedBy: "gardener-v2",
    });
  });

  it("returns only approved seed entries and non-stale cache pages for indexing", async () => {
    const approved = await upsertAtlasSeedCandidate({
      canonicalKey: "approved",
      sourceName: "atlas",
      title: "Approved",
      content: "Approved content",
      provenance: {},
      evidence: [],
    });
    await approveAtlasSeedEntry(approved.canonicalKey, "reviewer");
    await upsertAtlasSeedCandidate({
      canonicalKey: "pending",
      sourceName: "atlas",
      title: "Pending",
      content: "Pending content",
      provenance: {},
      evidence: [],
    });
    await upsertAtlasCachePage({
      pageKey: "fresh",
      sourceName: "atlas",
      title: "Fresh page",
      content: "Fresh cache content",
      contentHash: "fresh-hash",
    });
    await upsertAtlasCachePage({
      pageKey: "stale",
      sourceName: "atlas",
      title: "Stale page",
      content: "Stale cache content",
      contentHash: "stale-hash",
    });
    await markAtlasCachePageStale("stale", "seed changed");

    const items = await listIndexableAtlasContent("atlas");

    expect(items.map((item) => `${item.kind}:${item.key}`)).toEqual([
      "seed:approved",
      "cache:fresh",
    ]);
  });

  it("filters indexable Atlas content by configured repositories", async () => {
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
    const otherRepo = await upsertAtlasSeedCandidate({
      canonicalKey: "other-repo",
      sourceName: "atlas",
      repoUrl: "https://github.com/CopilotKit/other",
      ref: "main",
      subsystem: "runtime",
      title: "Other repo",
      content: "Other repo content",
      provenance: {},
      evidence: [],
    });
    await approveAtlasSeedEntry(otherRepo.canonicalKey, "reviewer");
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

    const items = await listIndexableAtlasContent("atlas", {
      repositories: [
        {
          repoUrl: "https://github.com/CopilotKit/pathfinder",
          refs: ["main"],
          subsystems: ["runtime"],
        },
      ],
    });

    expect(items.map((item) => `${item.kind}:${item.key}`)).toEqual([
      "seed:runtime",
      "cache:runtime/cache",
    ]);
  });

  it("bounds Atlas acquisition queries to a captured high-water token", async () => {
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

    const items = await listIndexableAtlasContent("atlas", {
      changedOnOrBefore: "2026-01-01T12:00:00.000000Z",
    });

    expect(items.map((item) => item.key)).toEqual(["included"]);
  });

  it("surfaces stale cache pages as removals and includes them in state tokens", async () => {
    await upsertAtlasCachePage({
      pageKey: "fresh",
      sourceName: "atlas",
      title: "Fresh page",
      content: "Fresh cache content",
      contentHash: "fresh-hash",
    });
    await upsertAtlasCachePage({
      pageKey: "stale",
      sourceName: "atlas",
      title: "Stale page",
      content: "Stale cache content",
      contentHash: "stale-hash",
    });
    await db.query(
      "UPDATE atlas_cache_pages SET updated_at = $2 WHERE page_key = $1",
      ["fresh", new Date("2026-01-01T00:00:00Z")],
    );
    await markAtlasCachePageStale("stale", "seed changed");
    await db.query(
      "UPDATE atlas_cache_pages SET updated_at = $2 WHERE page_key = $1",
      ["stale", new Date("2026-01-02T00:00:00Z")],
    );

    expect(await getAtlasStateToken("atlas")).toBe(
      "2026-01-02T00:00:00.000000Z",
    );
    expect(
      await listRemovedAtlasContentIds("atlas", {
        changedAfter: "2026-01-01T12:00:00.000000Z",
      }),
    ).toEqual(["atlas-cache:stale"]);
  });

  it("surfaces rejected seeds and empty cache pages as removals with repository filters", async () => {
    const rejected = await upsertAtlasSeedCandidate({
      canonicalKey: "rejected",
      sourceName: "atlas",
      repoUrl: "https://github.com/CopilotKit/pathfinder",
      ref: "main",
      subsystem: "runtime",
      title: "Rejected",
      content: "Rejected content",
      provenance: {},
      evidence: [],
    });
    await rejectAtlasSeedEntry(rejected.canonicalKey, "reviewer", "wrong");
    const otherRepoRejected = await upsertAtlasSeedCandidate({
      canonicalKey: "other-rejected",
      sourceName: "atlas",
      repoUrl: "https://github.com/CopilotKit/other",
      ref: "main",
      subsystem: "runtime",
      title: "Other rejected",
      content: "Other rejected content",
      provenance: {},
      evidence: [],
    });
    await rejectAtlasSeedEntry(
      otherRepoRejected.canonicalKey,
      "reviewer",
      "wrong",
    );
    await upsertAtlasCachePage({
      pageKey: "runtime/empty",
      sourceName: "atlas",
      title: "Runtime empty",
      content: "",
      contentHash: "empty-hash",
      generatedSeedIds: [rejected.id],
    });
    await upsertAtlasCachePage({
      pageKey: "other/empty",
      sourceName: "atlas",
      title: "Other empty",
      content: "",
      contentHash: "other-empty-hash",
      generatedSeedIds: [otherRepoRejected.id],
    });

    const removedIds = await listRemovedAtlasContentIds("atlas", {
      repositories: [
        {
          repoUrl: "https://github.com/CopilotKit/pathfinder",
          refs: ["main"],
          subsystems: ["runtime"],
        },
      ],
    });

    expect(removedIds).toEqual([
      "atlas-seed:rejected",
      "atlas-cache:runtime/empty",
    ]);
  });
});

describe("Atlas row-mapper robustness", () => {
  it("throws a context-bearing error (not a bare SyntaxError) for a malformed JSON seed column", () => {
    expect(() =>
      __testing.mapSeedRow({
        id: 42,
        canonical_key: "runtime:why",
        source_name: "atlas",
        status: "approved",
        title: "Runtime why",
        content: "body",
        provenance: "{not valid json",
        evidence: "[]",
      }),
    ).toThrowError(/provenance of seed row id=42 key=runtime:why/);
  });

  it("attributes a malformed cache JSON column to its row identity", () => {
    expect(() =>
      __testing.mapCacheRow({
        id: 7,
        page_key: "runtime/overview",
        source_name: "atlas",
        title: "Runtime overview",
        content_hash: "hash-1",
        stale: false,
        generated_seed_ids: "[1, 2,",
        provenance: "{}",
      }),
    ).toThrowError(
      /generated_seed_ids of cache row id=7 key=runtime\/overview/,
    );
  });

  it("returns null and warns for an invalid timestamp instead of yielding Invalid Date", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = __testing.toDate("not-a-date", "approved_at of seed row 5");
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("invalid timestamp"),
    );
    warnSpy.mockRestore();
  });

  it("passes through valid timestamps unchanged", () => {
    const iso = "2026-01-01T00:00:00.000Z";
    const result = __testing.toDate(iso);
    expect(result).toBeInstanceOf(Date);
    expect(result?.toISOString()).toBe(iso);
  });
});

describe("Atlas state-token microsecond precision (no ceil)", () => {
  // The high-water mark comes from a TIMESTAMPTZ (microsecond precision). We
  // return it as raw microsecond text and the acquire queries bind it as a
  // `$N::timestamptz` text param, so the bounds compare at full microsecond
  // precision. There is no millisecond ceil and no JS Date in the bind path,
  // so a row whose true updated_at carries sub-millisecond digits (e.g.
  // .123456) is included EXACTLY by `<= token` and excluded EXACTLY by the next
  // run's `> token` — no drop, no double-fetch.
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

  // Bind-path proof — this is the DB-independent guarantee that microseconds
  // survive the SQL bind. It spies on the pool to capture the params handed to
  // the driver and asserts the microsecond TEXT token (not a truncating JS
  // Date) reaches the `$N::timestamptz` cast in the generated SQL.
  it("binds changedAfter/changedOnOrBefore as ::timestamptz TEXT params, not Date objects", async () => {
    const microToken = "2026-01-01T00:00:00.123456Z";
    const calls: { text: string; params: unknown[] }[] = [];
    __setPoolForTesting({
      query: (text: string, params?: unknown[]) => {
        calls.push({ text, params: params ?? [] });
        return Promise.resolve({ rows: [] });
      },
      connect: async () => ({
        query: () => Promise.resolve({ rows: [] }),
        release: () => {},
      }),
      end: async () => {},
    });
    try {
      await listIndexableAtlasContent("atlas", {
        changedAfter: microToken,
        changedOnOrBefore: microToken,
      });
    } finally {
      // Restore the PGlite-backed pool for the rest of the suite.
      __setPoolForTesting(poolFromPglite(db));
    }

    // Every emitted bound must be a ::timestamptz cast and the bound param must
    // be the raw microsecond text — never a Date that would truncate to ms.
    const boundCalls = calls.filter((c) => /updated_at\s*[<>]/.test(c.text));
    expect(boundCalls.length).toBeGreaterThan(0);
    for (const call of boundCalls) {
      expect(call.text).toContain("::timestamptz");
      expect(call.text).toMatch(/updated_at > \$\d+::timestamptz/);
      expect(call.text).toMatch(/updated_at <= \$\d+::timestamptz/);
      for (const param of call.params) {
        expect(param).not.toBeInstanceOf(Date);
      }
      expect(call.params).toContain(microToken);
    }
  });

  it("returns the raw microsecond high-water text as the state token", async () => {
    // Insert a sub-millisecond timestamp via a SQL literal (a JS Date insert
    // would truncate to ms before it ever reaches the column).
    await upsertAtlasSeedCandidate({
      canonicalKey: "micro",
      sourceName: "atlas",
      title: "Micro",
      content: "Micro content",
      provenance: {},
      evidence: [],
    });
    await approveAtlasSeedEntry("micro", "reviewer");
    await db.query(
      "UPDATE atlas_seed_entries SET updated_at = '2026-01-01T00:00:00.123456Z' WHERE canonical_key = $1",
      ["micro"],
    );

    expect(await getAtlasStateToken("atlas")).toBe(
      "2026-01-01T00:00:00.123456Z",
    );
  });

  it("includes the high-water row in run 1 and neither drops nor re-fetches it across run 2", async () => {
    // Run 1: a row sits exactly at the high-water mark with sub-ms digits.
    await upsertAtlasSeedCandidate({
      canonicalKey: "boundary",
      sourceName: "atlas",
      title: "Boundary",
      content: "Boundary content",
      provenance: {},
      evidence: [],
    });
    await approveAtlasSeedEntry("boundary", "reviewer");
    await db.query(
      "UPDATE atlas_seed_entries SET updated_at = '2026-01-01T00:00:00.123456Z' WHERE canonical_key = $1",
      ["boundary"],
    );

    const token1 = await getAtlasStateToken("atlas");
    expect(token1).toBe("2026-01-01T00:00:00.123456Z");

    // Run 1 window `<= token1` must INCLUDE the boundary row exactly.
    const run1 = await listIndexableAtlasContent("atlas", {
      changedOnOrBefore: token1!,
    });
    expect(run1.map((i) => i.key)).toEqual(["boundary"]);

    // A new row lands one microsecond after the run-1 high-water mark.
    await upsertAtlasSeedCandidate({
      canonicalKey: "after",
      sourceName: "atlas",
      title: "After",
      content: "After content",
      provenance: {},
      evidence: [],
    });
    await approveAtlasSeedEntry("after", "reviewer");
    await db.query(
      "UPDATE atlas_seed_entries SET updated_at = '2026-01-01T00:00:00.123457Z' WHERE canonical_key = $1",
      ["after"],
    );

    const token2 = await getAtlasStateToken("atlas");
    expect(token2).toBe("2026-01-01T00:00:00.123457Z");

    // Run 2 window `> token1 AND <= token2` must EXCLUDE the boundary row (no
    // double-fetch) and INCLUDE only the strictly-later row (no drop).
    const run2 = await listIndexableAtlasContent("atlas", {
      changedAfter: token1!,
      changedOnOrBefore: token2!,
    });
    expect(run2.map((i) => i.key)).toEqual(["after"]);
  });
});
