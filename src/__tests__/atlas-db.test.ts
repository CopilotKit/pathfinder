import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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
      changedOnOrBefore: new Date("2026-01-01T12:00:00Z"),
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
      "2026-01-02T00:00:00.000Z",
    );
    expect(
      await listRemovedAtlasContentIds(
        "atlas",
        { changedAfter: new Date("2026-01-01T12:00:00Z") },
      ),
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
