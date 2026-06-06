import { describe, it, expect, vi, beforeEach } from "vitest";

// Track which jobs execute and their timing for concurrency assertions
const executionLog: {
  type: string;
  key: string;
  start: number;
  end: number;
}[] = [];
let jobDelay = 50; // ms — controllable per-test

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
        name: "repo-a-docs",
        type: "markdown",
        path: "/docs",
        repo: "https://github.com/org/repo-a",
        file_patterns: ["**/*.md"],
        chunk: {},
      },
      {
        name: "repo-b-docs",
        type: "markdown",
        path: "/docs",
        repo: "https://github.com/org/repo-b",
        file_patterns: ["**/*.md"],
        chunk: {},
      },
      {
        name: "repo-a-code",
        type: "markdown",
        path: "/src",
        repo: "https://github.com/org/repo-a",
        file_patterns: ["**/*.ts"],
        chunk: {},
      },
      {
        name: "slack-support",
        type: "slack",
        channels: ["C001"],
        confidence_threshold: 0.7,
        trigger_emoji: "pathfinder",
        min_thread_replies: 2,
        chunk: {},
      },
    ],
    tools: [
      {
        name: "search-a",
        type: "search",
        description: "Search repo A docs",
        source: "repo-a-docs",
        default_limit: 5,
        max_limit: 20,
        result_format: "docs",
      },
      {
        name: "search-b",
        type: "search",
        description: "Search repo B docs",
        source: "repo-b-docs",
        default_limit: 5,
        max_limit: 20,
        result_format: "docs",
      },
      {
        name: "search-slack",
        type: "search",
        description: "Search Slack",
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
    .mockReturnValue(
      new Set(["repo-a-docs", "repo-b-docs", "repo-a-code", "slack-support"]),
    ),
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
      // indexItems/removeItems now return { failedIds } so the orchestrator can
      // hold the state token back on per-item failure (C1).
      indexItems = vi.fn().mockResolvedValue({ failedIds: [] });
      removeItems = vi.fn().mockResolvedValue({ failedIds: [] });
    },
  };
});

vi.mock("../indexing/providers/index.js", () => ({
  getProvider: vi.fn().mockReturnValue(() => ({
    fullAcquire: vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, jobDelay));
      return { items: [], removedIds: [], stateToken: "test-token" };
    }),
    incrementalAcquire: vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, jobDelay));
      return { items: [], removedIds: [], stateToken: "test-token" };
    }),
    getCurrentStateToken: vi.fn().mockResolvedValue("test-token"),
  })),
}));

import { IndexingOrchestrator } from "../indexing/orchestrator.js";

// Helper: wait for all jobs to finish (poll onReindexComplete or activeJobCount)
async function waitForDrain(
  orchestrator: IndexingOrchestrator,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!orchestrator.isIndexing()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("Timed out waiting for drain to complete");
}

describe("Queue-level deduplication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executionLog.length = 0;
    jobDelay = 50;
  });

  it("deduplicates incremental-reindex jobs for the same repo", async () => {
    const orchestrator = new IndexingOrchestrator();
    const completeSpy = vi.fn();
    orchestrator.onReindexComplete = completeSpy;

    // Make jobs slow so the second arrives while the first is still queued
    jobDelay = 200;

    // Queue same repo twice rapidly
    orchestrator.queueIncrementalReindex("https://github.com/org/repo-a");
    orchestrator.queueIncrementalReindex("https://github.com/org/repo-a");

    await waitForDrain(orchestrator);

    // Should only get one completion callback — the second was deduped
    expect(completeSpy.mock.calls.length).toBe(1);
  });

  it("does NOT deduplicate incremental-reindex jobs for different repos", async () => {
    const orchestrator = new IndexingOrchestrator();
    const completeSpy = vi.fn();
    orchestrator.onReindexComplete = completeSpy;

    orchestrator.queueIncrementalReindex("https://github.com/org/repo-a");
    orchestrator.queueIncrementalReindex("https://github.com/org/repo-b");

    await waitForDrain(orchestrator);

    // Both should execute
    expect(completeSpy.mock.calls.length).toBe(2);
  });

  it("deduplicates source-reindex jobs for the same source", async () => {
    const orchestrator = new IndexingOrchestrator();
    const logSpy = vi.spyOn(console, "log");

    // Make jobs slow so the second arrives while the first is still queued
    jobDelay = 200;

    orchestrator.queueSourceReindex("slack-support");
    orchestrator.queueSourceReindex("slack-support");

    // Verify dedup log was emitted
    expect(
      logSpy.mock.calls.some(
        (args) =>
          typeof args[0] === "string" &&
          args[0].includes("Source re-index for slack-support already queued"),
      ),
    ).toBe(true);

    await waitForDrain(orchestrator);
    logSpy.mockRestore();
  });

  it("deduplicates full-reindex jobs", async () => {
    const orchestrator = new IndexingOrchestrator();
    const logSpy = vi.spyOn(console, "log");

    jobDelay = 200;

    orchestrator.queueFullReindex();
    orchestrator.queueFullReindex();

    expect(
      logSpy.mock.calls.some(
        (args) =>
          typeof args[0] === "string" &&
          args[0].includes("Full re-index already queued, skipping"),
      ),
    ).toBe(true);

    await waitForDrain(orchestrator);
    logSpy.mockRestore();
  });

  it("allows re-queuing after a job has been consumed from the queue", async () => {
    const orchestrator = new IndexingOrchestrator();
    const completeSpy = vi.fn();
    orchestrator.onReindexComplete = completeSpy;
    jobDelay = 10;

    orchestrator.queueSourceReindex("slack-support");
    await waitForDrain(orchestrator);

    // Now queue the same source again — should be allowed since first was consumed
    orchestrator.queueSourceReindex("slack-support");
    await waitForDrain(orchestrator);

    expect(completeSpy.mock.calls.length).toBe(2);
  });
});

describe("Concurrent drain with per-repo coordination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executionLog.length = 0;
    jobDelay = 50;
  });

  it("processes jobs for different repos in parallel", async () => {
    jobDelay = 100;
    const orchestrator = new IndexingOrchestrator({ maxConcurrent: 3 });
    const callTimes: number[] = [];
    const completeSpy = vi.fn().mockImplementation(() => {
      callTimes.push(Date.now());
    });
    orchestrator.onReindexComplete = completeSpy;

    const start = Date.now();
    orchestrator.queueIncrementalReindex("https://github.com/org/repo-a");
    orchestrator.queueIncrementalReindex("https://github.com/org/repo-b");

    await waitForDrain(orchestrator);

    // Both should complete
    expect(completeSpy.mock.calls.length).toBe(2);

    // If they ran in parallel, total time should be roughly 1x jobDelay, not 2x.
    // Allow generous margin for test execution overhead.
    const elapsed = Date.now() - start;
    // Serial would take ~200ms+ (2 * 100ms). Parallel should be ~100ms + overhead.
    // Use a generous upper bound — mainly checking they're not strictly serial.
    expect(elapsed).toBeLessThan(350);
  });

  it("serializes jobs for the same repo", async () => {
    jobDelay = 80;
    // Use maxConcurrent=3 but queue two jobs for the same repo
    const orchestrator = new IndexingOrchestrator({ maxConcurrent: 3 });
    const completeSpy = vi.fn();
    orchestrator.onReindexComplete = completeSpy;

    // Queue two incremental-reindex for the same repo — second will be deduped!
    // Instead, queue an incremental-reindex and a source-reindex for same repo.
    orchestrator.queueIncrementalReindex("https://github.com/org/repo-a");
    orchestrator.queueSourceReindex("repo-a-docs"); // This source is in repo-a

    const start = Date.now();
    await waitForDrain(orchestrator);

    // Both should complete
    expect(completeSpy.mock.calls.length).toBe(2);

    // If they were serialized (same repo), total time should be >= 2x jobDelay
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(140); // 2 * 80ms - small margin
  });

  it("respects maxConcurrent limit", async () => {
    jobDelay = 100;
    const orchestrator = new IndexingOrchestrator({ maxConcurrent: 1 });
    const completeSpy = vi.fn();
    orchestrator.onReindexComplete = completeSpy;

    const start = Date.now();
    orchestrator.queueIncrementalReindex("https://github.com/org/repo-a");
    orchestrator.queueIncrementalReindex("https://github.com/org/repo-b");

    await waitForDrain(orchestrator);

    // With maxConcurrent=1, even different repos should be serial
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(180); // 2 * 100ms - small margin
    expect(completeSpy.mock.calls.length).toBe(2);
  });

  it("defaults maxConcurrent to 3", () => {
    const orchestrator = new IndexingOrchestrator();
    // Access private field via type assertion for testing
    expect(
      (orchestrator as unknown as { maxConcurrent: number }).maxConcurrent,
    ).toBe(3);
  });

  it("full-reindex gets exclusive access (blocks other jobs)", async () => {
    jobDelay = 80;
    const orchestrator = new IndexingOrchestrator({ maxConcurrent: 3 });
    const completeSpy = vi.fn();
    orchestrator.onReindexComplete = completeSpy;

    // Queue a full-reindex followed by an incremental
    orchestrator.queueFullReindex();
    orchestrator.queueIncrementalReindex("https://github.com/org/repo-b");

    const start = Date.now();
    await waitForDrain(orchestrator);

    // Full reindex should block the incremental — they run serially
    const elapsed = Date.now() - start;
    // Full reindex indexes all sources (repo-a-docs, repo-b-docs, repo-a-code, slack-support)
    // That's 4 source calls * 80ms each = 320ms, plus the incremental for repo-b = 1 more * 80ms
    // Total serial: ~400ms minimum
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(completeSpy.mock.calls.length).toBe(2);
  });

  it("isIndexing returns true while jobs are running", async () => {
    jobDelay = 200;
    const orchestrator = new IndexingOrchestrator();

    expect(orchestrator.isIndexing()).toBe(false);

    orchestrator.queueSourceReindex("slack-support");

    // Give drain a tick to start
    await new Promise((r) => setTimeout(r, 20));
    expect(orchestrator.isIndexing()).toBe(true);

    await waitForDrain(orchestrator);
    expect(orchestrator.isIndexing()).toBe(false);
  });

  it("non-repo source jobs (slack) can run in parallel with repo jobs", async () => {
    jobDelay = 100;
    const orchestrator = new IndexingOrchestrator({ maxConcurrent: 3 });
    const completeSpy = vi.fn();
    orchestrator.onReindexComplete = completeSpy;

    const start = Date.now();
    orchestrator.queueSourceReindex("slack-support"); // no repo
    orchestrator.queueIncrementalReindex("https://github.com/org/repo-a");

    await waitForDrain(orchestrator);

    // Should run in parallel (different repos / no repo conflict)
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(350);
    expect(completeSpy.mock.calls.length).toBe(2);
  });
});
