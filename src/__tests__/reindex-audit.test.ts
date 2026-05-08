import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — variables created before vi.mock hoisting
// ---------------------------------------------------------------------------

const {
  mockGetConfig,
  mockGetServerConfig,
  mockGetIndexedItemIds,
  mockWalkSourceFiles,
} = vi.hoisted(() => ({
  mockGetConfig: vi.fn(),
  mockGetServerConfig: vi.fn(),
  mockGetIndexedItemIds: vi.fn(),
  mockWalkSourceFiles: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../config.js", () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
  getServerConfig: (...args: unknown[]) => mockGetServerConfig(...args),
}));

vi.mock("../db/queries.js", () => ({
  getIndexedItemIds: (...args: unknown[]) => mockGetIndexedItemIds(...args),
}));

vi.mock("../indexing/utils.js", () => ({
  walkSourceFiles: (...args: unknown[]) => mockWalkSourceFiles(...args),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks are wired)
// ---------------------------------------------------------------------------

import {
  runReindexAudit,
  type AuditFinding,
} from "../indexing/reindex-audit.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal file-source config for tests. */
function fileSource(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    type: "markdown",
    path: "/repo/docs",
    file_patterns: ["**/*.md"],
    chunk: {},
    ...overrides,
  };
}

/** Build a minimal server config with the given sources. */
function serverConfig(sources: Record<string, unknown>[]) {
  return {
    server: { name: "test", version: "1.0" },
    sources,
    tools: [],
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
  };
}

/** Build a minimal app config. */
function appConfig(
  overrides: Partial<{ slackWebhookUrl: string; cloneDir: string }> = {},
) {
  return {
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
    discordPublicKey: "",
    notionToken: "",
    mcpJwtSecret: "",
    p2pTelemetryUrl: undefined,
    p2pTelemetryDisabled: false,
    packageVersion: "1.0.0",
    slackWebhookUrl: "",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runReindexAudit", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: single markdown source, DB and disk in sync
    const src = fileSource("docs");
    mockGetServerConfig.mockReturnValue(serverConfig([src]));
    mockGetConfig.mockReturnValue(appConfig());
    mockGetIndexedItemIds.mockResolvedValue(new Set(["README.md"]));
    mockWalkSourceFiles.mockResolvedValue(new Set(["README.md"]));

    // Stub global fetch for Slack alert tests
    mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Check 1: Stale files ────────────────────────────────────────────────

  describe("stale_files check", () => {
    it("returns stale_files finding when DB has paths not on disk", async () => {
      mockGetIndexedItemIds.mockResolvedValue(
        new Set(["README.md", "old-file.md", "removed.md"]),
      );
      mockWalkSourceFiles.mockResolvedValue(new Set(["README.md"]));

      const findings = await runReindexAudit(["docs"]);

      const stale = findings.find((f) => f.check === "stale_files");
      expect(stale).toBeDefined();
      expect(stale!.source).toBe("docs");
      expect(stale!.count).toBe(2);
      expect(stale!.samples).toEqual(
        expect.arrayContaining(["old-file.md", "removed.md"]),
      );
    });

    it("returns no findings when DB and disk match exactly", async () => {
      const paths = new Set(["a.md", "b.md"]);
      mockGetIndexedItemIds.mockResolvedValue(new Set(paths));
      mockWalkSourceFiles.mockResolvedValue(new Set(paths));

      const findings = await runReindexAudit(["docs"]);

      const stale = findings.find((f) => f.check === "stale_files");
      expect(stale).toBeUndefined();
    });

    it("limits samples to 10 paths max", async () => {
      const dbPaths = new Set(
        Array.from({ length: 15 }, (_, i) => `stale-${i}.md`),
      );
      mockGetIndexedItemIds.mockResolvedValue(dbPaths);
      mockWalkSourceFiles.mockResolvedValue(new Set<string>());

      const findings = await runReindexAudit(["docs"]);

      const stale = findings.find((f) => f.check === "stale_files");
      expect(stale).toBeDefined();
      expect(stale!.count).toBe(15);
      expect(stale!.samples.length).toBeLessThanOrEqual(10);
    });

    it("skips audit when walk root does not exist (walkSourceFiles returns null)", async () => {
      mockWalkSourceFiles.mockResolvedValue(null);
      mockGetIndexedItemIds.mockResolvedValue(
        new Set(["README.md", "old.md", "stale.md"]),
      );

      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const findings = await runReindexAudit(["docs"]);

      expect(findings).toEqual([]);
      expect(mockGetIndexedItemIds).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("walk root not found"),
      );
      consoleSpy.mockRestore();
    });

    it("skips non-file sources (e.g., slack, notion)", async () => {
      mockGetServerConfig.mockReturnValue(
        serverConfig([
          {
            name: "slack-support",
            type: "slack",
            channels: ["C001"],
            confidence_threshold: 0.7,
            trigger_emoji: "pathfinder",
            min_thread_replies: 2,
            chunk: {},
          },
        ]),
      );

      const findings = await runReindexAudit(["slack-support"]);

      expect(findings).toEqual([]);
      expect(mockGetIndexedItemIds).not.toHaveBeenCalled();
      expect(mockWalkSourceFiles).not.toHaveBeenCalled();
    });
  });

  // ── Check 2: Scope leaks ──────────────────────────────────────────────

  describe("scope_leak check", () => {
    it("returns scope_leak finding when DB has paths outside config.path", async () => {
      const src = fileSource("docs", {
        repo: "https://github.com/org/repo.git",
        path: "docs",
      });
      mockGetServerConfig.mockReturnValue(serverConfig([src]));

      // DB has a file outside the "docs" prefix
      mockGetIndexedItemIds.mockResolvedValue(
        new Set(["docs/README.md", "src/index.ts", "lib/util.ts"]),
      );
      mockWalkSourceFiles.mockResolvedValue(new Set(["docs/README.md"]));

      const findings = await runReindexAudit(["docs"]);

      const leak = findings.find((f) => f.check === "scope_leak");
      expect(leak).toBeDefined();
      expect(leak!.source).toBe("docs");
      expect(leak!.count).toBe(2);
      expect(leak!.samples).toEqual(
        expect.arrayContaining(["src/index.ts", "lib/util.ts"]),
      );
    });

    it("skips scope check for local sources (no repo field)", async () => {
      const src = fileSource("local-docs", { path: "/absolute/path/docs" });
      mockGetServerConfig.mockReturnValue(serverConfig([src]));

      mockGetIndexedItemIds.mockResolvedValue(
        new Set(["README.md", "outside/file.md"]),
      );
      mockWalkSourceFiles.mockResolvedValue(
        new Set(["README.md", "outside/file.md"]),
      );

      const findings = await runReindexAudit(["local-docs"]);

      const leak = findings.find((f) => f.check === "scope_leak");
      expect(leak).toBeUndefined();
    });

    it("skips scope check when config.path is '.'", async () => {
      const src = fileSource("docs", {
        repo: "https://github.com/org/repo.git",
        path: ".",
      });
      mockGetServerConfig.mockReturnValue(serverConfig([src]));

      mockGetIndexedItemIds.mockResolvedValue(new Set(["anywhere/file.md"]));
      mockWalkSourceFiles.mockResolvedValue(new Set(["anywhere/file.md"]));

      const findings = await runReindexAudit(["docs"]);
      const leak = findings.find((f) => f.check === "scope_leak");
      expect(leak).toBeUndefined();
    });
  });

  // ── Check 3: Count divergence ─────────────────────────────────────────

  describe("count_divergence check", () => {
    it("returns count_divergence with direction db_has_more when DB > disk", async () => {
      mockGetIndexedItemIds.mockResolvedValue(
        new Set(["a.md", "b.md", "c.md"]),
      );
      mockWalkSourceFiles.mockResolvedValue(new Set(["a.md"]));

      const findings = await runReindexAudit(["docs"]);

      const divergence = findings.find((f) => f.check === "count_divergence");
      expect(divergence).toBeDefined();
      expect(divergence!.direction).toBe("db_has_more");
      expect(divergence!.count).toBe(2); // difference: 3 - 1
    });

    it("does not report divergence when disk > DB (db_has_fewer is expected from content filtering)", async () => {
      mockGetIndexedItemIds.mockResolvedValue(new Set(["a.md"]));
      mockWalkSourceFiles.mockResolvedValue(
        new Set(["a.md", "b.md", "c.md", "d.md"]),
      );

      const findings = await runReindexAudit(["docs"]);

      const divergence = findings.find((f) => f.check === "count_divergence");
      expect(divergence).toBeUndefined();
    });

    it("does not report divergence when counts match", async () => {
      const paths = new Set(["a.md", "b.md"]);
      mockGetIndexedItemIds.mockResolvedValue(new Set(paths));
      mockWalkSourceFiles.mockResolvedValue(new Set(paths));

      const findings = await runReindexAudit(["docs"]);

      const divergence = findings.find((f) => f.check === "count_divergence");
      expect(divergence).toBeUndefined();
    });
  });

  // ── Slack alerting ────────────────────────────────────────────────────

  describe("Slack alerting", () => {
    it("sends Slack alert when findings exist and webhookUrl is set", async () => {
      mockGetConfig.mockReturnValue(
        appConfig({ slackWebhookUrl: "https://hooks.slack.com/test" }),
      );
      // Create a stale-file scenario so findings are non-empty
      mockGetIndexedItemIds.mockResolvedValue(
        new Set(["README.md", "gone.md"]),
      );
      mockWalkSourceFiles.mockResolvedValue(new Set(["README.md"]));

      await runReindexAudit(["docs"]);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://hooks.slack.com/test",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
        }),
      );
    });

    it("does NOT send Slack alert when webhookUrl is empty", async () => {
      mockGetConfig.mockReturnValue(appConfig({ slackWebhookUrl: "" }));
      mockGetIndexedItemIds.mockResolvedValue(
        new Set(["README.md", "gone.md"]),
      );
      mockWalkSourceFiles.mockResolvedValue(new Set(["README.md"]));

      await runReindexAudit(["docs"]);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("logs error when Slack webhook returns non-ok response", async () => {
      mockGetConfig.mockReturnValue(
        appConfig({ slackWebhookUrl: "https://hooks.slack.com/test" }),
      );
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        text: () => Promise.resolve("invalid_token"),
      });
      mockGetIndexedItemIds.mockResolvedValue(
        new Set(["README.md", "gone.md"]),
      );
      mockWalkSourceFiles.mockResolvedValue(new Set(["README.md"]));

      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const findings = await runReindexAudit(["docs"]);

      expect(findings).toBeInstanceOf(Array);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Slack webhook returned 403"),
      );
      consoleSpy.mockRestore();
    });

    it("does NOT throw when Slack fetch fails", async () => {
      mockGetConfig.mockReturnValue(
        appConfig({ slackWebhookUrl: "https://hooks.slack.com/test" }),
      );
      mockFetch.mockRejectedValue(new Error("network error"));
      mockGetIndexedItemIds.mockResolvedValue(
        new Set(["README.md", "gone.md"]),
      );
      mockWalkSourceFiles.mockResolvedValue(new Set(["README.md"]));

      // Should not throw
      const findings = await runReindexAudit(["docs"]);
      expect(findings).toBeInstanceOf(Array);
    });

    it("does NOT send Slack alert when no findings", async () => {
      mockGetConfig.mockReturnValue(
        appConfig({ slackWebhookUrl: "https://hooks.slack.com/test" }),
      );
      // DB and disk match — no findings
      const paths = new Set(["README.md"]);
      mockGetIndexedItemIds.mockResolvedValue(new Set(paths));
      mockWalkSourceFiles.mockResolvedValue(new Set(paths));

      await runReindexAudit(["docs"]);

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ── Error handling ────────────────────────────────────────────────────

  describe("error handling", () => {
    it("returns empty array and does not throw when getIndexedItemIds fails", async () => {
      mockGetIndexedItemIds.mockRejectedValue(new Error("DB connection lost"));

      const findings = await runReindexAudit(["docs"]);

      expect(findings).toEqual([]);
    });

    it("returns empty array and does not throw when walkSourceFiles fails", async () => {
      mockWalkSourceFiles.mockRejectedValue(new Error("ENOENT: no such file"));

      const findings = await runReindexAudit(["docs"]);

      expect(findings).toEqual([]);
    });

    it("returns empty array for empty sourceNames", async () => {
      const findings = await runReindexAudit([]);

      expect(findings).toEqual([]);
      expect(mockGetIndexedItemIds).not.toHaveBeenCalled();
      expect(mockWalkSourceFiles).not.toHaveBeenCalled();
    });
  });

  // ── Integration: multiple sources ─────────────────────────────────────

  describe("multiple sources", () => {
    it("returns findings for each source independently", async () => {
      const docsSrc = fileSource("docs", { path: "/repo/docs" });
      const codeSrc = fileSource("code", {
        type: "code",
        path: "/repo/src",
        file_patterns: ["**/*.ts"],
      });
      mockGetServerConfig.mockReturnValue(serverConfig([docsSrc, codeSrc]));

      // docs: stale file
      mockGetIndexedItemIds.mockImplementation((sourceName: string) => {
        if (sourceName === "docs") {
          return Promise.resolve(new Set(["README.md", "old.md"]));
        }
        if (sourceName === "code") {
          return Promise.resolve(new Set(["index.ts"]));
        }
        return Promise.resolve(new Set());
      });

      mockWalkSourceFiles.mockImplementation(
        (sourceConfig: { name: string }) => {
          if (sourceConfig.name === "docs") {
            return Promise.resolve(new Set(["README.md"]));
          }
          if (sourceConfig.name === "code") {
            // disk has more files than DB
            return Promise.resolve(
              new Set(["index.ts", "util.ts", "types.ts"]),
            );
          }
          return Promise.resolve(new Set());
        },
      );

      const findings = await runReindexAudit(["docs", "code"]);

      // docs should have a stale_files finding
      const docsStale = findings.find(
        (f) => f.source === "docs" && f.check === "stale_files",
      );
      expect(docsStale).toBeDefined();
      expect(docsStale!.count).toBe(1);
      expect(docsStale!.samples).toContain("old.md");

      // code: disk > DB (db_has_fewer) is no longer reported — expected from content filtering
      const codeDivergence = findings.find(
        (f) => f.source === "code" && f.check === "count_divergence",
      );
      expect(codeDivergence).toBeUndefined();
    });
  });
});
