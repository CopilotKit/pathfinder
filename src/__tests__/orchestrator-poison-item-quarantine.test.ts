import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Regression for the ten-day `code`-source wedge on mcp.copilotkit.ai.
//
// C1 (orchestrator-state-token-hold.test.ts) deliberately refuses to advance
// the state token past a failed item, so the failure is RETRIED rather than
// skipped. That is right for a transient failure — and catastrophic for a
// permanent one: one file that fails every single run freezes the ENTIRE
// source. Production sat at commit 0d0ea901 for ten days, serving stale
// source-code search results, because one chunk of one file was too large for
// the embedding model and therefore failed identically on every retry.
//
// The invariant added here: retries are BOUNDED. After MAX_ITEM_ATTEMPTS
// consecutive runs in which the SAME item fails, that item is quarantined —
// it stops holding the state token hostage, the rest of the source indexes,
// and the quarantine is recorded (and surfaced to operators) so the skip is
// loud rather than silent. Quarantined items are still re-attempted on every
// subsequent run; a later success clears the record.
//
// The negative assertion matters just as much: a TRANSIENT failure must still
// hold the token and retry. Quarantining on the first error would trade a
// wedge for silent data loss.

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
    getCurrentStateToken: vi.fn().mockResolvedValue("token-2"),
  })),
}));

import { IndexingOrchestrator } from "../indexing/orchestrator.js";
import { computeSourceConfigFingerprint } from "../indexing/source-fingerprint.js";
import type { IndexState, SourceConfig } from "../types.js";

const DOCS_SOURCE_FINGERPRINT = computeSourceConfigFingerprint({
  name: "docs",
  type: "markdown",
  path: "/tmp/docs",
  file_patterns: ["**/*.md"],
  chunk: {},
} as SourceConfig);

/** The poison item, mirroring production's threads-state-lab.ts. */
const POISON = "packages/web-inspector/dev/threads-state-lab.ts";

/**
 * A stateful stand-in for the index_state row. The wedge only shows up ACROSS
 * runs, so the fake must persist what each run writes and feed it back to the
 * next run's getIndexState — a per-call mockResolvedValue cannot express it.
 */
function installStatefulIndexState(initial: IndexState): { row: IndexState } {
  const holder = { row: { ...initial } };
  mockGetIndexState.mockImplementation(async () => ({ ...holder.row }));
  mockUpsertIndexState.mockImplementation(async (state: IndexState) => {
    holder.row = { ...state };
  });
  return holder;
}

async function runSourceReindex(
  orchestrator: IndexingOrchestrator,
): Promise<void> {
  const done = new Promise<void>((resolve) => {
    orchestrator.onReindexComplete = () => resolve();
  });
  orchestrator.queueSourceReindex("docs");
  await Promise.race([
    done,
    (async () => {
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 50));
        if (!orchestrator.isIndexing()) return;
      }
    })(),
  ]);
  await new Promise((r) => setTimeout(r, 50));
}

describe("IndexingOrchestrator: a permanently failing item must not wedge the source", () => {
  let orchestrator: IndexingOrchestrator;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    orchestrator = new IndexingOrchestrator();
    mockIndexItems.mockResolvedValue({ failedIds: [] });
    mockRemoveItems.mockResolvedValue({ failedIds: [] });
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  it("quarantines an item that fails every run, and the source recovers", async () => {
    const holder = installStatefulIndexState({
      source_type: "markdown",
      source_key: "docs",
      last_commit_sha: "token-1",
      config_fingerprint: DOCS_SOURCE_FINGERPRINT,
      last_indexed_at: new Date(),
      status: "idle",
      error_message: null,
    });

    mockIncrementalAcquire.mockResolvedValue({
      items: [
        { id: "docs/ok.md", content: "a" },
        { id: POISON, content: "b" },
      ],
      removedIds: [],
      stateToken: "token-2",
    });
    // The poison item fails identically on EVERY run — exactly production.
    mockIndexItems.mockResolvedValue({
      failedIds: [POISON],
      failures: [
        {
          id: POISON,
          error: "400 Invalid 'input[2]': maximum input length is 8192 tokens.",
        },
      ],
    });

    // Runs 1 and 2: the failure is still presumed transient, so the token is
    // held and the source stays errored. That is the C1 behaviour, preserved.
    await runSourceReindex(orchestrator);
    expect(holder.row.last_commit_sha).toBe("token-1");
    expect(holder.row.status).toBe("error");

    await runSourceReindex(orchestrator);
    expect(holder.row.last_commit_sha).toBe("token-1");
    expect(holder.row.status).toBe("error");

    // Run 3: the same item has now failed MAX_ITEM_ATTEMPTS consecutive runs.
    // It is quarantined, the token advances, and the source recovers so the
    // other 99.9% of the repo stops going stale.
    await runSourceReindex(orchestrator);
    expect(holder.row.last_commit_sha).toBe("token-2");
    expect(holder.row.status).toBe("idle");

    // The skip must be LOUD and recorded, not silent.
    const failures = holder.row.item_failures ?? {};
    expect(Object.keys(failures)).toContain(POISON);
    expect(failures[POISON]?.quarantined).toBe(true);
    expect(failures[POISON]?.attempts).toBeGreaterThanOrEqual(3);
    expect(failures[POISON]?.last_error).toContain("8192 tokens");

    const loggedQuarantine = errSpy.mock.calls
      .map((c: unknown[]) => c.join(" "))
      .some((line: string) => /quarantin/i.test(line) && line.includes(POISON));
    expect(loggedQuarantine).toBe(true);
  });

  it("does NOT quarantine a TRANSIENT failure — it holds the token and retries", async () => {
    // The negative assertion. Quarantining on the first error would trade the
    // wedge for silent data loss.
    const holder = installStatefulIndexState({
      source_type: "markdown",
      source_key: "docs",
      last_commit_sha: "token-1",
      config_fingerprint: DOCS_SOURCE_FINGERPRINT,
      last_indexed_at: new Date(),
      status: "idle",
      error_message: null,
    });

    mockIncrementalAcquire.mockResolvedValue({
      items: [{ id: "docs/flaky.md", content: "a" }],
      removedIds: [],
      stateToken: "token-2",
    });

    // Run 1: a one-off network blip.
    mockIndexItems.mockResolvedValueOnce({
      failedIds: ["docs/flaky.md"],
      failures: [{ id: "docs/flaky.md", error: "ECONNRESET" }],
    });
    await runSourceReindex(orchestrator);
    expect(holder.row.last_commit_sha).toBe("token-1");
    expect(holder.row.status).toBe("error");
    expect(
      holder.row.item_failures?.["docs/flaky.md"]?.quarantined ?? false,
    ).toBe(false);

    // Run 2: it succeeds. The token advances and the failure record clears —
    // the item must NOT carry a stale strike into the future.
    mockIndexItems.mockResolvedValue({ failedIds: [], failures: [] });
    await runSourceReindex(orchestrator);
    expect(holder.row.last_commit_sha).toBe("token-2");
    expect(holder.row.status).toBe("idle");
    expect(holder.row.item_failures?.["docs/flaky.md"]).toBeUndefined();
  });

  it("clears a quarantine once the item finally indexes", async () => {
    const holder = installStatefulIndexState({
      source_type: "markdown",
      source_key: "docs",
      last_commit_sha: "token-1",
      config_fingerprint: DOCS_SOURCE_FINGERPRINT,
      last_indexed_at: new Date(),
      status: "idle",
      error_message: null,
      item_failures: {
        [POISON]: {
          attempts: 5,
          first_failed_at: new Date("2026-09-01T18:31:05.344Z").toISOString(),
          last_error: "maximum input length is 8192 tokens",
          quarantined: true,
        },
      },
    });

    mockIncrementalAcquire.mockResolvedValue({
      items: [{ id: POISON, content: "b" }],
      removedIds: [],
      stateToken: "token-2",
    });
    mockIndexItems.mockResolvedValue({ failedIds: [], failures: [] });

    await runSourceReindex(orchestrator);

    expect(holder.row.last_commit_sha).toBe("token-2");
    expect(holder.row.status).toBe("idle");
    expect(holder.row.item_failures?.[POISON]).toBeUndefined();
  });
});
