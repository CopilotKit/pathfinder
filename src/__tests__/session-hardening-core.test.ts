/**
 * Session hardening core tests:
 * - getTotalSessionCount / isAtGlobalCapacity
 * - reapIdleStreamableSessions with two-tier TTL
 * - reapIdleStreamableSessions backward compat (flat ttlMs)
 * - handleSessionInitAccept lazy workspace (no ensureSession)
 * - createMcpServer accepts onToolCall callback
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetConfig = vi.fn();
const mockGetServerConfig = vi.fn();
const mockGetAnalyticsConfig = vi.fn();

vi.mock("../config.js", () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
  getServerConfig: (...args: unknown[]) => mockGetServerConfig(...args),
  getAnalyticsConfig: (...args: unknown[]) => mockGetAnalyticsConfig(...args),
  hasSearchTools: vi.fn().mockReturnValue(false),
  hasKnowledgeTools: vi.fn().mockReturnValue(false),
  hasCollectTools: vi.fn().mockReturnValue(false),
  hasBashSemanticSearch: vi.fn().mockReturnValue(false),
}));

beforeEach(() => {
  mockGetConfig.mockReturnValue({
    port: 0,
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
    mcpJwtSecret: "e".repeat(64),
    p2pTelemetryUrl: undefined,
    p2pTelemetryDisabled: false,
    packageVersion: "test",
  });
  mockGetServerConfig.mockReturnValue({
    server: { name: "pathfinder-test", version: "0.0.0" },
    sources: [],
    tools: [],
  });
  mockGetAnalyticsConfig.mockReturnValue(undefined);
});

// ---------------------------------------------------------------------------
// getTotalSessionCount
// ---------------------------------------------------------------------------

describe("getTotalSessionCount", () => {
  it("sums both maps", async () => {
    const { getTotalSessionCount } = await import("../server.js");
    const t = { a: {}, b: {} };
    const s = { c: {} };
    expect(getTotalSessionCount(t, s)).toBe(3);
  });

  it("returns 0 for empty maps", async () => {
    const { getTotalSessionCount } = await import("../server.js");
    expect(getTotalSessionCount({}, {})).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isAtGlobalCapacity
// ---------------------------------------------------------------------------

describe("isAtGlobalCapacity", () => {
  it("returns false when maxSessions is undefined (cap disabled)", async () => {
    const { isAtGlobalCapacity } = await import("../server.js");
    expect(isAtGlobalCapacity({ a: {} }, { b: {} }, undefined)).toBe(false);
  });

  it("returns true when total >= maxSessions", async () => {
    const { isAtGlobalCapacity } = await import("../server.js");
    expect(isAtGlobalCapacity({ a: {}, b: {} }, { c: {} }, 3)).toBe(true);
    expect(isAtGlobalCapacity({ a: {}, b: {} }, { c: {}, d: {} }, 3)).toBe(
      true,
    );
  });

  it("returns false when total < maxSessions", async () => {
    const { isAtGlobalCapacity } = await import("../server.js");
    expect(isAtGlobalCapacity({ a: {} }, { b: {} }, 5)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reapIdleStreamableSessions — two-tier TTL
// ---------------------------------------------------------------------------

describe("reapIdleStreamableSessions (two-tier TTL)", () => {
  it("unused sessions are reaped at the shorter unused TTL", async () => {
    const { reapIdleStreamableSessions } = await import("../server.js");
    const now = Date.now();
    const closeCalls: string[] = [];
    const transports: Record<string, { close: () => Promise<void> }> = {
      "unused-sid": {
        close: async () => {
          closeCalls.push("unused-sid");
        },
      },
    };
    const sessionLastActivity: Record<string, number> = {
      "unused-sid": now - 16 * 60 * 1000, // 16 min ago
    };
    const sessionHasBeenUsed: Record<string, boolean> = {};

    const reaped = reapIdleStreamableSessions({
      transports,
      sessionLastActivity,
      usedTtlMs: 30 * 60 * 1000,
      unusedTtlMs: 15 * 60 * 1000,
      sessionHasBeenUsed,
      now,
    });

    expect(reaped).toEqual(["unused-sid"]);
    expect(transports["unused-sid"]).toBeUndefined();
    expect(sessionLastActivity["unused-sid"]).toBeUndefined();
  });

  it("used sessions survive the short unused TTL but get reaped at the long TTL", async () => {
    const { reapIdleStreamableSessions } = await import("../server.js");
    const now = Date.now();
    const transports: Record<string, { close: () => Promise<void> }> = {
      "used-sid": { close: async () => {} },
    };
    const sessionLastActivity: Record<string, number> = {
      "used-sid": now - 20 * 60 * 1000, // 20 min ago
    };
    const sessionHasBeenUsed: Record<string, boolean> = {
      "used-sid": true,
    };

    // First reap: used session survives because 20m < 30m used TTL
    const reaped1 = reapIdleStreamableSessions({
      transports,
      sessionLastActivity,
      usedTtlMs: 30 * 60 * 1000,
      unusedTtlMs: 15 * 60 * 1000,
      sessionHasBeenUsed,
      now,
    });
    expect(reaped1).toEqual([]);
    expect(transports["used-sid"]).toBeDefined();

    // Now age the session past the used TTL
    sessionLastActivity["used-sid"] = now - 31 * 60 * 1000;
    const reaped2 = reapIdleStreamableSessions({
      transports,
      sessionLastActivity,
      usedTtlMs: 30 * 60 * 1000,
      unusedTtlMs: 15 * 60 * 1000,
      sessionHasBeenUsed,
      now,
    });
    expect(reaped2).toEqual(["used-sid"]);
  });

  it("cleans up sessionHasBeenUsed entry when reaping", async () => {
    const { reapIdleStreamableSessions } = await import("../server.js");
    const now = Date.now();
    const sessionHasBeenUsed: Record<string, boolean> = {
      "stale-sid": true,
    };
    const transports: Record<string, { close: () => Promise<void> }> = {
      "stale-sid": { close: async () => {} },
    };
    const sessionLastActivity: Record<string, number> = {
      "stale-sid": now - 31 * 60 * 1000,
    };

    reapIdleStreamableSessions({
      transports,
      sessionLastActivity,
      usedTtlMs: 30 * 60 * 1000,
      unusedTtlMs: 15 * 60 * 1000,
      sessionHasBeenUsed,
      now,
    });

    expect(sessionHasBeenUsed["stale-sid"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// reapIdleStreamableSessions — backward compat (flat ttlMs)
// ---------------------------------------------------------------------------

describe("reapIdleStreamableSessions (backward compat: flat ttlMs)", () => {
  it("still works with only ttlMs (no usedTtlMs/unusedTtlMs)", async () => {
    const { reapIdleStreamableSessions } = await import("../server.js");
    const now = Date.now();
    const transports: Record<string, { close: () => Promise<void> }> = {
      "flat-sid": { close: async () => {} },
    };
    const sessionLastActivity: Record<string, number> = {
      "flat-sid": now - 31 * 60 * 1000,
    };

    const reaped = reapIdleStreamableSessions({
      transports,
      sessionLastActivity,
      ttlMs: 30 * 60 * 1000,
      now,
    });
    expect(reaped).toEqual(["flat-sid"]);
  });

  it("does not reap sessions within the flat TTL", async () => {
    const { reapIdleStreamableSessions } = await import("../server.js");
    const now = Date.now();
    const transports: Record<string, { close: () => Promise<void> }> = {
      "fresh-sid": { close: async () => {} },
    };
    const sessionLastActivity: Record<string, number> = {
      "fresh-sid": now - 5 * 60 * 1000, // 5 min ago
    };

    const reaped = reapIdleStreamableSessions({
      transports,
      sessionLastActivity,
      ttlMs: 30 * 60 * 1000,
      now,
    });
    expect(reaped).toEqual([]);
    expect(transports["fresh-sid"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// handleSessionInitAccept — lazy workspace
// ---------------------------------------------------------------------------

describe("handleSessionInitAccept (lazy workspace)", () => {
  it("does NOT call ensureSession", async () => {
    const { handleSessionInitAccept } = await import("../server.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const ensureCalls: string[] = [];
      const sid = "lazy-test-sid";
      const result = handleSessionInitAccept({
        transport: { close: async () => {} },
        sid,
        ip: "1.1.1.1",
        transports: { [sid]: {} },
        sessionLastActivity: { [sid]: Date.now() },
        workspaceManager: {
          ensureSession: (s: string) => {
            ensureCalls.push(s);
          },
        },
      });

      expect(result).toBe(true);
      expect(ensureCalls).toEqual([]);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("always returns true (no rollback path)", async () => {
    const { handleSessionInitAccept } = await import("../server.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const sid = "always-true-sid";
      const result = handleSessionInitAccept({
        transport: { close: async () => {} },
        sid,
        ip: "1.1.1.1",
        transports: { [sid]: {} },
        sessionLastActivity: { [sid]: Date.now() },
      });

      expect(result).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// createMcpServer — onToolCall hooks param
// ---------------------------------------------------------------------------

describe("createMcpServer (onToolCall hooks)", () => {
  it("accepts a hooks param with onToolCall without throwing", async () => {
    const { createMcpServer } = await import("../mcp/server.js");

    // createMcpServer should accept the hooks param. Since there are no
    // tools configured in the mock config, it just creates an empty server.
    const calls: string[] = [];
    const server = createMcpServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        onToolCall: () => {
          calls.push("called");
        },
      },
    );

    // The server should be created successfully.
    expect(server).toBeDefined();
    expect(typeof server.connect).toBe("function");
  });
});
