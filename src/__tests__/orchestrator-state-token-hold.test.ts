import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression for C1 (silent data loss): when the pipeline reports that one or
// more items failed to index/remove, the orchestrator must NOT advance the
// index state token (last_commit_sha). Advancing it would leave the failed
// items behind the new token so the next incremental run never re-diffs them —
// permanent silent loss. Instead the orchestrator holds the prior token and
// marks the run errored so the next run reprocesses the failed items.
//
// These mocks let each test control what the pipeline's indexItems/removeItems
// return (the failedIds) and assert on what gets written to index_state.

const {
  mockGetIndexState,
  mockUpsertIndexState,
  mockIndexItems,
  mockRemoveItems,
  mockFullAcquire,
  mockIncrementalAcquire,
} = vi.hoisted(() => ({
  mockGetIndexState: vi.fn(),
  mockUpsertIndexState: vi.fn(),
  mockIndexItems: vi.fn(),
  mockRemoveItems: vi.fn(),
  mockFullAcquire: vi.fn(),
  mockIncrementalAcquire: vi.fn(),
}));

vi.mock("../config.js", () => ({
  getConfig: vi.fn().mockReturnValue({
    databaseUrl: "postgresql://test",
    openaiApiKey: "test-key",
    githubToken: "",
    githubWebhookSecret: "",
    port: 3001,
    nodeEnv: "test",
    logLevel: "info",
    cloneDir: "/tmp/test",
    slackBotToken: "",
    slackSigningSecret: "",
    discordBotToken: "",
    notionToken: "",
  }),
  getServerConfig: vi.fn().mockReturnValue({
    server: { name: "test", version: "1.0" },
    sources: [
      {
        name: "docs",
        type: "markdown",
        path: "/tmp/docs",
        file_patterns: ["**/*.md"],
        chunk: {},
      },
    ],
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
  getIndexableSourceNames: vi.fn().mockReturnValue(new Set(["docs"])),
  getAnalyticsConfig: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../db/queries.js", () => ({
  getIndexState: (...args: unknown[]) => mockGetIndexState(...args),
  upsertIndexState: (...args: unknown[]) => mockUpsertIndexState(...args),
  cleanupOldWebhookDeliveries: vi.fn().mockResolvedValue(0),
}));

vi.mock("../db/analytics.js", () => ({
  cleanupOldQueryLogs: vi.fn().mockResolvedValue(0),
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
    indexItems = mockIndexItems;
    removeItems = mockRemoveItems;
  },
}));

vi.mock("../indexing/providers/index.js", () => ({
  getProvider: vi.fn().mockReturnValue(() => ({
    fullAcquire: mockFullAcquire,
    incrementalAcquire: mockIncrementalAcquire,
    getCurrentStateToken: vi.fn().mockResolvedValue("new-token"),
  })),
}));

import { IndexingOrchestrator } from "../indexing/orchestrator.js";

/** Drive a source-reindex job to completion and return when drain settles. */
async function runSourceReindex(
  orchestrator: IndexingOrchestrator,
): Promise<void> {
  const done = new Promise<void>((resolve) => {
    orchestrator.onReindexComplete = () => resolve();
  });
  orchestrator.queueSourceReindex("docs");
  // The job resolves onReindexComplete only when affectedSourceNames is
  // non-empty (always true for "docs"); fall back to a bounded poll so a
  // path that returns early still lets the test proceed.
  await Promise.race([
    done,
    (async () => {
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 50));
        if (!orchestrator.isIndexing()) return;
      }
    })(),
  ]);
  // Give the final microtasks (status writes) a tick to flush.
  await new Promise((r) => setTimeout(r, 50));
}

describe("IndexingOrchestrator state-token hold on item failure (C1)", () => {
  let orchestrator: IndexingOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    orchestrator = new IndexingOrchestrator();
    // Prior indexed state with an OLD token; incremental path will be taken.
    mockGetIndexState.mockResolvedValue({
      source_type: "markdown",
      source_key: "docs",
      last_commit_sha: "old-token",
      last_indexed_at: new Date(),
      status: "idle",
      error_message: null,
    });
    mockIndexItems.mockResolvedValue({ failedIds: [] });
    mockRemoveItems.mockResolvedValue({ failedIds: [] });
  });

  it("does NOT advance the state token when an item fails to index", async () => {
    mockIncrementalAcquire.mockResolvedValue({
      items: [
        { id: "docs/ok.md", content: "a" },
        { id: "docs/bad.md", content: "b" },
      ],
      removedIds: [],
      stateToken: "new-token",
    });
    // One item failed.
    mockIndexItems.mockResolvedValue({ failedIds: ["docs/bad.md"] });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runSourceReindex(orchestrator);
    errSpy.mockRestore();

    // The success-path upsert (which would persist last_commit_sha:"new-token")
    // must NOT have been called.
    const advancedToNewToken = mockUpsertIndexState.mock.calls.some(
      (c) => c[0]?.last_commit_sha === "new-token",
    );
    expect(advancedToNewToken).toBe(false);

    // The run is marked errored while PRESERVING the prior token, so the next
    // incremental run re-diffs from "old-token" and reprocesses docs/bad.md.
    const errorWrite = mockUpsertIndexState.mock.calls
      .map((c) => c[0])
      .find((s) => s?.status === "error");
    expect(errorWrite).toBeDefined();
    expect(errorWrite.last_commit_sha).toBe("old-token");
  });

  it("does NOT advance the state token when a removal fails", async () => {
    mockIncrementalAcquire.mockResolvedValue({
      items: [],
      removedIds: ["docs/gone.md"],
      stateToken: "new-token",
    });
    mockRemoveItems.mockResolvedValue({ failedIds: ["docs/gone.md"] });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runSourceReindex(orchestrator);
    errSpy.mockRestore();

    const advancedToNewToken = mockUpsertIndexState.mock.calls.some(
      (c) => c[0]?.last_commit_sha === "new-token",
    );
    expect(advancedToNewToken).toBe(false);
  });

  it("ADVANCES the state token when every item indexes successfully", async () => {
    mockIncrementalAcquire.mockResolvedValue({
      items: [{ id: "docs/ok.md", content: "a" }],
      removedIds: ["docs/gone.md"],
      stateToken: "new-token",
    });
    mockIndexItems.mockResolvedValue({ failedIds: [] });
    mockRemoveItems.mockResolvedValue({ failedIds: [] });

    await runSourceReindex(orchestrator);

    const advanced = mockUpsertIndexState.mock.calls
      .map((c) => c[0])
      .find((s) => s?.last_commit_sha === "new-token");
    expect(advanced).toBeDefined();
    expect(advanced.status).toBe("idle");
  });
});
