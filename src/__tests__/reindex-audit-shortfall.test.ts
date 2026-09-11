/**
 * End-to-end proof for the post-reindex shortfall audit.
 *
 * Models the real failure that ran undetected for months: a `.mdx` page whose
 * prose lives entirely in an excluded snippet, so the file is walked, matched,
 * read, stripped to nothing, and chunks to ZERO. The chunker returns `[]`, the
 * pipeline writes nothing, and the file silently vanishes from the index.
 *
 * The chunker and the pipeline here are REAL — only the database and the disk
 * walk are faked — so the test exercises the actual drop path rather than a
 * hand-built "db is smaller" fixture.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockGetConfig,
  mockGetServerConfig,
  mockWalkSourceFiles,
  indexedChunks,
} = vi.hoisted(() => ({
  mockGetConfig: vi.fn(),
  mockGetServerConfig: vi.fn(),
  mockWalkSourceFiles: vi.fn(),
  // source_name → file_path → chunk count. Stands in for the chunks table.
  indexedChunks: new Map<string, Map<string, number>>(),
}));

function chunkTable(source: string): Map<string, number> {
  let t = indexedChunks.get(source);
  if (!t) {
    t = new Map();
    indexedChunks.set(source, t);
  }
  return t;
}

vi.mock("../config.js", () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
  getServerConfig: (...args: unknown[]) => mockGetServerConfig(...args),
}));

vi.mock("../indexing/utils.js", () => ({
  walkSourceFiles: (...args: unknown[]) => mockWalkSourceFiles(...args),
}));

// A tiny in-memory stand-in for the chunks table, shared by the pipeline
// (writer) and the audit (reader) so the audit sees exactly what the pipeline
// actually persisted.
vi.mock("../db/queries.js", () => ({
  replaceChunksForFile: async (
    source: string,
    filePath: string,
    chunks: unknown[],
  ) => {
    const t = chunkTable(source);
    // Mirrors the real delete+insert: an empty array deletes the row and
    // inserts nothing, so the file disappears from `SELECT DISTINCT file_path`.
    if (chunks.length === 0) t.delete(filePath);
    else t.set(filePath, chunks.length);
  },
  deleteChunksByFile: async (source: string, filePath: string) => {
    chunkTable(source).delete(filePath);
  },
  getIndexedItemIds: async (source: string) =>
    new Set(chunkTable(source).keys()),
}));

import { IndexingPipeline } from "../indexing/pipeline.js";
import { runReindexAudit, resetAuditCache } from "../indexing/reindex-audit.js";
import type { SourceConfig } from "../types.js";
import type { ContentItem } from "../indexing/providers/types.js";
import type { EmbeddingProvider } from "../indexing/embeddings.js";

const sourceConfig: SourceConfig = {
  name: "docs",
  type: "markdown",
  path: "/repo/docs",
  file_patterns: ["**/*.mdx"],
  chunk: {},
};

function appConfig() {
  return {
    databaseUrl: "postgresql://test",
    openaiApiKey: "test-key",
    githubToken: "",
    cloneDir: "/tmp/test",
    slackWebhookUrl: "",
  };
}

/** A prose page: real markdown, chunks to something. */
function prosePage(n: number): string {
  return `---\ntitle: Page ${n}\n---\n\n# Page ${n}\n\nReal prose for page ${n}.\n`;
}

/**
 * A pure-JSX stub: the visible prose lives in an excluded snippet component, so
 * after MDX stripping there is nothing left. This is the 130-file case.
 */
function jsxStubPage(n: number): string {
  return `---\ntitle: Stub ${n}\n---\n\n<Snippet file="shared/intro.mdx" />\n<ComponentDemo name="demo-${n}" />\n`;
}

const embeddingProvider: EmbeddingProvider = {
  embed: async () => [0.1, 0.2, 0.3],
  embedBatch: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
};

/**
 * Index 40 pages, `stubEvery`-th of which is a pure-JSX stub. Returns the disk
 * file set. `config` lets a test exercise a per-source tolerance override.
 */
async function indexCorpus(
  stubEvery: number,
  config: SourceConfig = sourceConfig,
): Promise<Set<string>> {
  const pipeline = new IndexingPipeline(embeddingProvider, config);
  const items: ContentItem[] = [];
  const disk = new Set<string>();
  for (let n = 0; n < 40; n++) {
    const isStub = n % stubEvery === 0;
    const id = `page-${n}.mdx`;
    disk.add(id);
    items.push({ id, content: isStub ? jsxStubPage(n) : prosePage(n) });
  }
  const { failedIds } = await pipeline.indexItems(items, "sha-1");
  expect(failedIds).toEqual([]);
  return disk;
}

describe("post-reindex shortfall audit (zero-chunk files)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    indexedChunks.clear();
    resetAuditCache();
    mockGetConfig.mockReturnValue(appConfig());
    mockGetServerConfig.mockReturnValue({ sources: [sourceConfig] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports a db_has_fewer finding when pure-JSX stubs chunk to zero", async () => {
    const disk = await indexCorpus(5); // 8 of 40 → a 20% shortfall
    mockWalkSourceFiles.mockResolvedValue(disk);

    // Precondition: the pipeline really did drop the stubs (the bug's mechanism).
    const indexed = chunkTable("docs");
    expect(disk.size).toBe(40);
    expect(indexed.size).toBe(32);

    const findings = await runReindexAudit(["docs"]);

    const shortfall = findings.find(
      (f) => f.check === "count_divergence" && f.direction === "db_has_fewer",
    );
    expect(shortfall).toBeDefined();
    expect(shortfall!.source).toBe("docs");
    expect(shortfall!.count).toBe(8);
    // The finding names the files, so the operator can open one and see why.
    expect(shortfall!.samples).toEqual(
      expect.arrayContaining(["page-0.mdx", "page-5.mdx"]),
    );
    expect(shortfall!.samples.length).toBeLessThanOrEqual(10);
  });

  // ── Negative assertion: the new check must not become noise ─────────────
  //
  // Every source drops SOME files legitimately. If a normal reindex of a
  // healthy source emits a finding, operators mute the audit and the next real
  // shrink goes unseen — which is how the shortfall direction got suppressed in
  // the first place. A healthy source must stay silent.
  it("does NOT report a shortfall for a source skipping a normal share of files", async () => {
    // 1 empty page out of 40 → 2.5%, inside the 5% default tolerance.
    const disk = await indexCorpus(40);
    mockWalkSourceFiles.mockResolvedValue(disk);
    expect(chunkTable("docs").size).toBe(39);

    const findings = await runReindexAudit(["docs"]);

    expect(findings).toEqual([]);
  });

  it("reports that same small shortfall once the source sets unindexed_tolerance: 0", async () => {
    // A source known to index everything it walks opts into a zero baseline,
    // and the audit then flags the very first regression.
    const strict = { ...sourceConfig, unindexed_tolerance: 0 };
    mockGetServerConfig.mockReturnValue({ sources: [strict] });

    const disk = await indexCorpus(40, strict);
    mockWalkSourceFiles.mockResolvedValue(disk);

    const findings = await runReindexAudit(["docs"]);

    const shortfall = findings.find((f) => f.direction === "db_has_fewer");
    expect(shortfall).toBeDefined();
    expect(shortfall!.count).toBe(1);
    expect(shortfall!.samples).toEqual(["page-0.mdx"]);
  });
});
