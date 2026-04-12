import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all external dependencies before importing orchestrator
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
    slackBotToken: "xoxb-test",
    slackSigningSecret: "test-secret",
  }),
  getServerConfig: vi.fn().mockReturnValue({
    server: { name: "test", version: "1.0" },
    sources: [
      {
        name: "slack-support",
        type: "slack",
        channels: ["C001"],
        confidence_threshold: 0.7,
        trigger_emoji: "pathfinder",
        min_thread_replies: 2,
        chunk: {},
      },
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
        source: "slack-support",
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
  getIndexableSourceNames: vi
    .fn()
    .mockReturnValue(new Set(["slack-support", "docs"])),
}));

vi.mock("../db/queries.js", () => ({
  getIndexState: vi.fn().mockResolvedValue(null),
  upsertIndexState: vi.fn().mockResolvedValue(undefined),
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

vi.mock("../indexing/pipeline.js", () => {
  return {
    IndexingPipeline: class MockIndexingPipeline {
      indexItems = vi.fn().mockResolvedValue(undefined);
      removeItems = vi.fn().mockResolvedValue(undefined);
    },
  };
});

vi.mock("../indexing/providers/index.js", () => ({
  getProvider: vi.fn().mockReturnValue(() => ({
    fullAcquire: vi.fn().mockResolvedValue({
      items: [],
      removedIds: [],
      stateToken: "test-token",
    }),
    incrementalAcquire: vi.fn().mockResolvedValue({
      items: [],
      removedIds: [],
      stateToken: "test-token",
    }),
    getCurrentStateToken: vi.fn().mockResolvedValue("test-token"),
  })),
}));

import { IndexingOrchestrator } from "../indexing/orchestrator.js";

describe("IndexingOrchestrator.queueSourceReindex", () => {
  let orchestrator: IndexingOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    orchestrator = new IndexingOrchestrator();
  });

  it("queues and executes a source-reindex job", async () => {
    const completeSpy = vi.fn();
    orchestrator.onReindexComplete = completeSpy;

    orchestrator.queueSourceReindex("slack-support");

    // Poll until drain completes (up to 5 seconds)
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (completeSpy.mock.calls.length > 0) break;
    }

    expect(completeSpy).toHaveBeenCalledWith(["slack-support"]);
  });

  it("skips unknown source names gracefully", async () => {
    const completeSpy = vi.fn();
    orchestrator.onReindexComplete = completeSpy;

    orchestrator.queueSourceReindex("nonexistent");

    await new Promise((resolve) => setTimeout(resolve, 500));

    // Should not call onReindexComplete for unknown sources
    // (the job executes but returns early)
    expect(completeSpy).not.toHaveBeenCalled();
  });
});
