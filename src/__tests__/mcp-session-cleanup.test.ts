import { describe, it, expect, vi } from "vitest";

// We import the mocked config before server to keep parity with the other
// analytics-suite test files that mock config.js at the module level.
vi.mock("../config.js", () => ({
  getServerConfig: vi.fn(),
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
  }),
  hasSearchTools: vi.fn().mockReturnValue(false),
  hasKnowledgeTools: vi.fn().mockReturnValue(false),
  hasCollectTools: vi.fn().mockReturnValue(false),
  hasBashSemanticSearch: vi.fn().mockReturnValue(false),
}));

// Parallel mock of the analytics DB layer — server.ts imports it at the
// top level, so leaving it unmocked would drag in pg.
vi.mock("../db/analytics.js", () => ({
  getAnalyticsSummary: vi.fn(),
  getTopQueries: vi.fn(),
  getEmptyQueries: vi.fn(),
  getToolCounts: vi.fn(),
  getLogQueryFailureCount: () => 0,
}));

import { cleanupPartialMcpSession } from "../server.js";

/**
 * Unit coverage for {@link cleanupPartialMcpSession}. This helper was
 * extracted from the onsessioninitialized try/catch in `startServer()` so
 * the stale-session-leak path could be locked down without spinning up an
 * MCP transport. The behavior under test:
 *
 *   - transports[sid] is deleted (ghost session removed from the routing
 *     map).
 *   - sessionLastActivity[sid] is deleted (no phantom entry for the
 *     reaper to trip over).
 *   - ipLimiter.remove(sid) is called so the per-IP quota reflects
 *     reality — without this, retries from the same IP eventually hit
 *     the cap on a session that never actually came up.
 *   - transport.close() is invoked so the client gets a clean
 *     disconnect instead of a dangling stream.
 *   - Throws from ipLimiter.remove MUST NOT propagate — the cleanup must
 *     still null out the session maps, which is the invariant the onclose
 *     handler relies on.
 *
 * Pre-fix (R15-1), `ensureSession` throwing left `transports[sid]` and
 * `sessionLastActivity[sid]` populated; a retry then hit the ghost and
 * misbehaved. These tests would all have failed in that state.
 */
describe("cleanupPartialMcpSession", () => {
  function makeStubTransport() {
    const close = vi.fn().mockResolvedValue(undefined);
    return { close };
  }

  function makeStubLimiter() {
    const remove = vi.fn();
    return { remove };
  }

  it("deletes transports[sid] and sessionLastActivity[sid]", () => {
    const transports: Record<string, { close?: () => unknown }> = {
      SID_X: { close: () => undefined },
      OTHER: { close: () => undefined },
    };
    const sessionLastActivity: Record<string, number> = {
      SID_X: Date.now(),
      OTHER: Date.now(),
    };
    const transport = makeStubTransport();

    cleanupPartialMcpSession("SID_X", {
      transports,
      sessionLastActivity,
      transport,
    });

    // Target session removed.
    expect(transports).not.toHaveProperty("SID_X");
    expect(sessionLastActivity).not.toHaveProperty("SID_X");
    // Sibling untouched — cleanup must not collaterally clear unrelated
    // sessions.
    expect(transports.OTHER).toBeDefined();
    expect(sessionLastActivity.OTHER).toBeDefined();
  });

  it("calls ipLimiter.remove(sid) once", () => {
    const transport = makeStubTransport();
    const limiter = makeStubLimiter();
    cleanupPartialMcpSession("SID_Y", {
      transports: { SID_Y: { close: () => undefined } },
      sessionLastActivity: { SID_Y: 0 },
      ipLimiter: limiter,
      transport,
    });
    expect(limiter.remove).toHaveBeenCalledExactlyOnceWith("SID_Y");
  });

  it("calls transport.close() exactly once", () => {
    const transport = makeStubTransport();
    cleanupPartialMcpSession("SID_Z", {
      transports: { SID_Z: { close: () => undefined } },
      sessionLastActivity: { SID_Z: 0 },
      transport,
    });
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it("still deletes session state when ipLimiter.remove throws", () => {
    const transport = makeStubTransport();
    const limiter = {
      remove: vi.fn(() => {
        throw new Error("limiter-kaboom");
      }),
    };
    const transports: Record<string, { close?: () => unknown }> = {
      SID_T: { close: () => undefined },
    };
    const sessionLastActivity: Record<string, number> = { SID_T: 0 };
    // Silence the expected console.error so the test output stays clean.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() =>
      cleanupPartialMcpSession("SID_T", {
        transports,
        sessionLastActivity,
        ipLimiter: limiter,
        transport,
      }),
    ).not.toThrow();

    // Session state still removed despite the ipLimiter throw — this
    // invariant is what the onclose handler depends on; without it, a
    // double-cleanup would skip session-state manager cleanup entirely.
    expect(transports).not.toHaveProperty("SID_T");
    expect(sessionLastActivity).not.toHaveProperty("SID_T");
    expect(limiter.remove).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("tolerates a transport whose close() rejects (does not throw out of the call)", async () => {
    const transport = {
      close: vi.fn().mockRejectedValue(new Error("close-kaboom")),
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    cleanupPartialMcpSession("SID_C", {
      transports: { SID_C: { close: () => undefined } },
      sessionLastActivity: { SID_C: 0 },
      transport,
    });
    // Flush the microtask queue so the catch on the close() promise runs.
    await Promise.resolve();
    await Promise.resolve();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("is a no-op on a sid that never existed (idempotent)", () => {
    // Defensive: if cleanup is called twice (e.g. onclose firing after
    // cleanupPartialMcpSession already handled the partial session), the
    // second call must not throw or log spuriously.
    const transports: Record<string, { close?: () => unknown }> = {};
    const sessionLastActivity: Record<string, number> = {};
    const transport = makeStubTransport();
    expect(() =>
      cleanupPartialMcpSession("GHOST", {
        transports,
        sessionLastActivity,
        transport,
      }),
    ).not.toThrow();
    // transport.close() is still called — that's expected: the caller
    // owns the transport and is asking for it to be closed. The maps
    // simply have nothing to delete.
    expect(transport.close).toHaveBeenCalledTimes(1);
  });
});
