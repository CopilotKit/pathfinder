import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Regression: a change to a source's CRAWL CONFIGURATION (walk root,
// file_patterns, url_derivation) must be picked up by a reindex.
//
// Before the fix, the acquisition branch keyed ONLY on "are there new
// commits". Widening file_patterns leaves the commit sha untouched, so the
// orchestrator took incrementalAcquire, which diffed HEAD against itself,
// walked nothing, wrote zero rows — and still reported success. Observed in
// production: PR #159 widened the docs crawl to include 184 reference .mdx
// files; a source-scoped reindex returned 202, index_state.last_indexed
// advanced, and zero rows were written.
//
// These tests drive the REAL FileDataProvider against a REAL git clone (a
// local bare "origin" so no network is involved) through the REAL
// orchestrator. Only the DB and the embedding/chunking pipeline are faked.

const h = vi.hoisted(() => ({
  // Mutable server config — tests swap `sources` between runs to simulate a
  // config-only change (same commit, different crawl scope).
  sources: [] as Record<string, unknown>[],
  cloneDir: "",
  repoUrl: "",
  // In-memory index_state, keyed "type:key". Round-trips through the
  // orchestrator exactly as the real table would.
  indexStates: new Map<string, Record<string, unknown>>(),
  // In-memory set of item ids currently "in the index", for stale detection.
  indexed: new Set<string>(),
  // Every item id handed to the pipeline, per run.
  indexedThisRun: [] as string[],
}));

vi.mock("../config.js", () => ({
  getConfig: () => ({
    databaseUrl: "postgresql://test",
    openaiApiKey: "test-key",
    githubToken: "",
    githubWebhookSecret: "",
    port: 3001,
    nodeEnv: "test",
    logLevel: "info",
    cloneDir: h.cloneDir,
    slackBotToken: "",
    slackSigningSecret: "",
    discordBotToken: "",
    notionToken: "",
  }),
  getServerConfig: () => ({
    server: { name: "test", version: "1.0" },
    sources: h.sources,
    tools: [
      {
        name: "search",
        type: "search",
        description: "Search",
        source: "docs",
        default_limit: 5,
        max_limit: 20,
        result_format: "docs",
      },
    ],
    embedding: {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
    },
    indexing: {
      auto_reindex: false,
      reindex_hour_utc: 3,
      stale_threshold_hours: 24,
    },
  }),
  getIndexableSourceNames: () => new Set(["docs"]),
  getAnalyticsConfig: () => undefined,
}));

vi.mock("../db/queries.js", () => ({
  getIndexState: async (type: string, key: string) =>
    h.indexStates.get(`${type}:${key}`) ?? null,
  upsertIndexState: async (state: Record<string, unknown>) => {
    h.indexStates.set(`${state.source_type}:${state.source_key}`, {
      ...state,
    });
  },
  getIndexedItemIds: async () => new Set(h.indexed),
  cleanupOldWebhookDeliveries: vi.fn().mockResolvedValue(0),
}));

vi.mock("../db/analytics.js", () => ({
  cleanupOldQueryLogs: vi.fn().mockResolvedValue(0),
}));

vi.mock("../db/atlas.js", () => ({
  markAtlasCachePagesStaleForSources: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../indexing/embeddings.js", () => {
  class MockEmbeddingProvider {
    embed = vi.fn().mockResolvedValue([0.1, 0.2]);
    embedBatch = vi.fn().mockResolvedValue([[0.1, 0.2]]);
  }
  return {
    EmbeddingClient: MockEmbeddingProvider,
    createEmbeddingProvider: () => new MockEmbeddingProvider(),
  };
});

vi.mock("../indexing/pipeline.js", () => ({
  IndexingPipeline: class MockIndexingPipeline {
    async indexItems(items: { id: string }[]) {
      for (const item of items) {
        h.indexed.add(item.id);
        h.indexedThisRun.push(item.id);
      }
      return { failedIds: [] };
    }
    async removeItems(ids: string[]) {
      for (const id of ids) h.indexed.delete(id);
      return { failedIds: [] };
    }
  },
}));

import { IndexingOrchestrator } from "../indexing/orchestrator.js";
import { FileDataProvider } from "../indexing/providers/file.js";

function git(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t.test", "-c", "user.name=T", ...args],
    { cwd, encoding: "utf8" },
  );
}

/** Drive one source-reindex job to completion. */
async function runSourceReindex(
  orchestrator: IndexingOrchestrator,
): Promise<void> {
  h.indexedThisRun = [];
  orchestrator.queueSourceReindex("docs");
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 25));
    if (!orchestrator.isIndexing()) break;
  }
  await new Promise((r) => setTimeout(r, 25));
}

const MD_ONLY = ["**/*.md"];
const MD_AND_MDX = ["**/*.md", "**/*.mdx"];

function docsSource(filePatterns: string[]): Record<string, unknown> {
  return {
    name: "docs",
    type: "markdown",
    repo: h.repoUrl,
    path: "content",
    file_patterns: filePatterns,
    chunk: {},
  };
}

describe("reindex honors a source config change (same commit sha)", () => {
  let tmp: string;
  let orchestrator: IndexingOrchestrator;
  let fullSpy: ReturnType<typeof vi.spyOn>;
  let incSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pf-cfghash-"));
    const originDir = path.join(tmp, "origin");
    const workDir = path.join(tmp, "work");
    h.cloneDir = path.join(tmp, "clones");
    fs.mkdirSync(originDir, { recursive: true });
    fs.mkdirSync(h.cloneDir, { recursive: true });

    // Bare origin so `git pull` in ensureRepo succeeds with no network.
    git(originDir, ["init", "--bare", "--initial-branch=main", "testrepo.git"]);
    const originUrl = `file://${path.join(originDir, "testrepo.git")}`;
    git(tmp, ["clone", originUrl, workDir]);
    fs.mkdirSync(path.join(workDir, "content", "reference"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(workDir, "content", "guide.md"),
      "# Guide\n\nSome prose that is long enough to carry real semantic value for the chunker.\n",
    );
    fs.writeFileSync(
      path.join(workDir, "content", "reference", "api.mdx"),
      "# API Reference\n\nGenerated reference prose with enough substance to be indexed.\n",
    );
    git(workDir, ["add", "-A"]);
    git(workDir, ["commit", "-m", "seed"]);
    git(workDir, ["push", "origin", "HEAD:main"]);

    h.repoUrl = originUrl;
    h.sources = [docsSource(MD_ONLY)];
    h.indexStates.clear();
    h.indexed.clear();
    h.indexedThisRun = [];

    fullSpy = vi.spyOn(FileDataProvider.prototype, "fullAcquire");
    incSpy = vi.spyOn(FileDataProvider.prototype, "incrementalAcquire");

    orchestrator = new IndexingOrchestrator();
  });

  afterEach(() => {
    fullSpy.mockRestore();
    incSpy.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("indexes newly-in-scope files after file_patterns widens", async () => {
    // Run 1 — narrow scope. Establishes index_state at the current sha.
    await runSourceReindex(orchestrator);
    expect(h.indexedThisRun).toEqual(["content/guide.md"]);
    const shaAfterFirstRun = h.indexStates.get("markdown:docs")
      ?.last_commit_sha as string;
    expect(shaAfterFirstRun).toBeTruthy();

    // Config-only change: widen the crawl to include .mdx. NO new commits.
    h.sources = [docsSource(MD_AND_MDX)];

    // Run 2 — the reindex an operator would trigger after shipping the config.
    await runSourceReindex(orchestrator);

    expect(h.indexedThisRun).toContain("content/reference/api.mdx");
    expect(h.indexed.has("content/reference/api.mdx")).toBe(true);
    // The commit sha is unchanged — the walk was driven by the config change.
    expect(h.indexStates.get("markdown:docs")?.last_commit_sha).toBe(
      shaAfterFirstRun,
    );
  });

  it("still takes the INCREMENTAL path when the config is unchanged", async () => {
    await runSourceReindex(orchestrator);
    expect(fullSpy).toHaveBeenCalledTimes(1); // first run: no prior state
    fullSpy.mockClear();
    incSpy.mockClear();

    // Same config, same commit: must NOT full-walk.
    await runSourceReindex(orchestrator);

    expect(incSpy).toHaveBeenCalledTimes(1);
    expect(fullSpy).not.toHaveBeenCalled();
    expect(h.indexedThisRun).toEqual([]);
  });

  it("full-walks once when the stored fingerprint is absent, then goes incremental", async () => {
    await runSourceReindex(orchestrator);
    // Simulate a row written by a pre-upgrade deploy: sha present, fingerprint
    // NULL. The first run after the upgrade must full-walk, and must persist a
    // fingerprint so the run AFTER that goes incremental (no boot-storm).
    const row = h.indexStates.get("markdown:docs")!;
    delete row.config_fingerprint;
    fullSpy.mockClear();
    incSpy.mockClear();

    await runSourceReindex(orchestrator);
    expect(fullSpy).toHaveBeenCalledTimes(1);
    expect(incSpy).not.toHaveBeenCalled();

    fullSpy.mockClear();
    incSpy.mockClear();
    await runSourceReindex(orchestrator);
    expect(incSpy).toHaveBeenCalledTimes(1);
    expect(fullSpy).not.toHaveBeenCalled();
  });
});
