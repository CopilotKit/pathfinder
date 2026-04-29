import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Bash } from "just-bash";

// ---------------------------------------------------------------------------
// Mocks — registered BEFORE importing server.js so vi.mock hoisting sees the
// factories. We mock bash-fs so we can make `rebuildBashInstance` succeed or
// throw on demand, and we mock config.js so refreshBashInstances() sees a
// deterministic tool/source set without spinning up the full server.
// ---------------------------------------------------------------------------

const { rebuildBashInstanceMock } = vi.hoisted(() => ({
  rebuildBashInstanceMock: vi.fn(),
}));

vi.mock("../mcp/tools/bash-fs.js", () => ({
  rebuildBashInstance: rebuildBashInstanceMock,
  // buildBashFilesMap is imported at the top of server.ts but not exercised
  // on the refresh path; provide a stub so the import doesn't blow up.
  buildBashFilesMap: vi.fn().mockResolvedValue({}),
}));

vi.mock("../config.js", () => ({
  getServerConfig: vi.fn().mockReturnValue({
    server: { name: "test-server" },
    sources: [
      {
        name: "src-a",
        type: "markdown",
        path: "/tmp/a",
        file_patterns: ["**/*.md"],
        chunk: { target_tokens: 600, overlap_tokens: 50 },
      },
      {
        name: "src-b",
        type: "markdown",
        path: "/tmp/b",
        file_patterns: ["**/*.md"],
        chunk: { target_tokens: 600, overlap_tokens: 50 },
      },
      {
        name: "src-c",
        type: "markdown",
        path: "/tmp/c",
        file_patterns: ["**/*.md"],
        chunk: { target_tokens: 600, overlap_tokens: 50 },
      },
    ],
    tools: [
      { type: "bash", name: "tool-a", sources: ["src-a"] },
      { type: "bash", name: "tool-b", sources: ["src-b"] },
      { type: "bash", name: "tool-c", sources: ["src-c"] },
    ],
  }),
  getAnalyticsConfig: vi.fn(),
  getConfig: vi.fn().mockReturnValue({
    port: 3001,
    databaseUrl: "pglite:///tmp/test",
    openaiApiKey: "",
    githubToken: "",
    githubWebhookSecret: "",
    nodeEnv: "test",
    logLevel: "info",
    cloneDir: "/tmp/test",
    slackBotToken: "",
    slackSigningSecret: "",
    discordBotToken: "",
    discordPublicKey: "",
    notionToken: "",
    mcpJwtSecret: "x".repeat(32),
    p2pTelemetryUrl: undefined,
    p2pTelemetryDisabled: false,
    packageVersion: "test",
  }),
  hasSearchTools: vi.fn().mockReturnValue(false),
  hasKnowledgeTools: vi.fn().mockReturnValue(false),
  hasCollectTools: vi.fn().mockReturnValue(false),
  hasBashSemanticSearch: vi.fn().mockReturnValue(false),
}));

// Import AFTER mocks are in place.
import {
  refreshBashInstances,
  __getBashInstancesForTesting,
  __setBashInstanceForTesting,
  __clearBashInstancesForTesting,
} from "../server.js";

function emptyBash(): Bash {
  return new Bash({ files: {}, cwd: "/" });
}

describe("refreshBashInstances — atomic all-or-nothing semantics", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    rebuildBashInstanceMock.mockReset();
    __clearBashInstancesForTesting();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  it("rolls back completely when one tool rebuild throws mid-iteration", async () => {
    // Seed `bashInstances` with three "old" Bash objects so we can assert
    // identity preservation (no tool got swapped to a new instance).
    const oldA = emptyBash();
    const oldB = emptyBash();
    const oldC = emptyBash();
    __setBashInstanceForTesting("tool-a", oldA);
    __setBashInstanceForTesting("tool-b", oldB);
    __setBashInstanceForTesting("tool-c", oldC);

    // tool-a and tool-c rebuild fine. tool-b throws — simulating a network
    // failure, ENOSPC, embedding error, etc.
    rebuildBashInstanceMock.mockImplementation(
      async (sources: Array<{ name: string }>) => {
        const sourceName = sources[0]?.name;
        if (sourceName === "src-b") {
          throw new Error("simulated rebuild failure for src-b");
        }
        return { bash: emptyBash(), fileCount: 42 };
      },
    );

    await expect(
      refreshBashInstances(["src-a", "src-b", "src-c"], "test"),
    ).rejects.toThrow("simulated rebuild failure for src-b");

    // Every live instance must be untouched — same object identity as before.
    const live = __getBashInstancesForTesting();
    expect(live.get("tool-a")).toBe(oldA);
    expect(live.get("tool-b")).toBe(oldB);
    expect(live.get("tool-c")).toBe(oldC);

    // The failure log must identify the failing tool and the triggering
    // source(s) so monitors and `.catch(...)` callers can act on it.
    const errorCalls = consoleErrorSpy.mock.calls
      .map((c: unknown[]) => c.map(String).join(" "))
      .join("\n");
    expect(errorCalls).toContain("tool-b");
    expect(errorCalls).toContain("src-a");
    expect(errorCalls).toContain("src-b");
    expect(errorCalls).toContain("src-c");
    expect(errorCalls).toContain("[test]");
  });

  it("atomically updates every affected tool when all rebuilds succeed", async () => {
    const oldA = emptyBash();
    const oldB = emptyBash();
    const oldC = emptyBash();
    __setBashInstanceForTesting("tool-a", oldA);
    __setBashInstanceForTesting("tool-b", oldB);
    __setBashInstanceForTesting("tool-c", oldC);

    const newA = emptyBash();
    const newB = emptyBash();
    const newC = emptyBash();
    rebuildBashInstanceMock.mockImplementation(
      async (sources: Array<{ name: string }>) => {
        const sourceName = sources[0]?.name;
        if (sourceName === "src-a") return { bash: newA, fileCount: 1 };
        if (sourceName === "src-b") return { bash: newB, fileCount: 2 };
        if (sourceName === "src-c") return { bash: newC, fileCount: 3 };
        throw new Error(`unexpected source: ${sourceName}`);
      },
    );

    await refreshBashInstances(["src-a", "src-b", "src-c"], "test");

    const live = __getBashInstancesForTesting();
    expect(live.get("tool-a")).toBe(newA);
    expect(live.get("tool-b")).toBe(newB);
    expect(live.get("tool-c")).toBe(newC);
  });

  it("leaves unaffected tools untouched on partial source-set refresh", async () => {
    // Seed all three tools with "old" instances.
    const oldA = emptyBash();
    const oldB = emptyBash();
    const oldC = emptyBash();
    __setBashInstanceForTesting("tool-a", oldA);
    __setBashInstanceForTesting("tool-b", oldB);
    __setBashInstanceForTesting("tool-c", oldC);

    const newA = emptyBash();
    rebuildBashInstanceMock.mockImplementation(
      async (sources: Array<{ name: string }>) => {
        const sourceName = sources[0]?.name;
        if (sourceName === "src-a") return { bash: newA, fileCount: 1 };
        throw new Error(`unexpected source: ${sourceName}`);
      },
    );

    // Refresh triggered by src-a only — tool-b/tool-c should stay on their
    // old instances since they aren't affected.
    await refreshBashInstances(["src-a"], "test");

    const live = __getBashInstancesForTesting();
    expect(live.get("tool-a")).toBe(newA);
    expect(live.get("tool-b")).toBe(oldB);
    expect(live.get("tool-c")).toBe(oldC);
  });

  it("rolls back even when the failure is on the LAST affected tool", async () => {
    // Guards against a naive implementation that updates entries as it
    // iterates and only "commits" at the end — such a bug would leak
    // tool-a and tool-b's new instances into `bashInstances` even though
    // tool-c blew up.
    const oldA = emptyBash();
    const oldB = emptyBash();
    const oldC = emptyBash();
    __setBashInstanceForTesting("tool-a", oldA);
    __setBashInstanceForTesting("tool-b", oldB);
    __setBashInstanceForTesting("tool-c", oldC);

    rebuildBashInstanceMock.mockImplementation(
      async (sources: Array<{ name: string }>) => {
        const sourceName = sources[0]?.name;
        if (sourceName === "src-c") {
          throw new Error("boom on last tool");
        }
        return { bash: emptyBash(), fileCount: 0 };
      },
    );

    await expect(
      refreshBashInstances(["src-a", "src-b", "src-c"], "test"),
    ).rejects.toThrow("boom on last tool");

    const live = __getBashInstancesForTesting();
    expect(live.get("tool-a")).toBe(oldA);
    expect(live.get("tool-b")).toBe(oldB);
    expect(live.get("tool-c")).toBe(oldC);
  });
});
