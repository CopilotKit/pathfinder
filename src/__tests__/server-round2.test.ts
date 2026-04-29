/**
 * Round-2 hardening tests for src/server.ts:
 * - Streamable-HTTP session reaper (closes transports, handles stuck sessions).
 * - /mcp init race fallback (inline map deletion + JSON-RPC error frame).
 * - Shutdown helper (closes both streamable + SSE transports).
 * - Retry-After header clamping parity for the /mcp pre-check path.
 *
 * These cover behavior owned by server.ts; see sse-transport.test.ts for the
 * /sse side of the Round-2 changes and analytics-auth.test.ts for the
 * analytics 503 message differentiation coverage.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type express from "express";

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

// Baseline config that individual tests may override.
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
// Streamable-HTTP session reaper
// ---------------------------------------------------------------------------

describe("reapIdleStreamableSessions (exported for testing)", () => {
  it("calls transport.close() on reaped sessions (prevents listener/timer leaks)", async () => {
    const { reapIdleStreamableSessions } = await import("../server.js");

    const closed: string[] = [];
    const transports: Record<string, { close: () => void | Promise<void> }> = {
      stale: {
        close: () => {
          closed.push("stale");
        },
      },
      fresh: {
        close: () => {
          closed.push("fresh");
        },
      },
    };
    const sessionLastActivity: Record<string, number> = {
      stale: Date.now() - 10 * 60 * 1000,
      fresh: Date.now() - 1000,
    };

    const reaped = reapIdleStreamableSessions({
      transports: transports as unknown as Parameters<
        typeof reapIdleStreamableSessions
      >[0]["transports"],
      sessionLastActivity,
      ttlMs: 5 * 60 * 1000,
      now: Date.now(),
    });

    expect(reaped).toEqual(["stale"]);
    // close() runs on a microtask (Promise.resolve wrapper); flush the queue
    // so the callback observes the call before asserting.
    await new Promise((r) => setTimeout(r, 10));
    // Transport.close() MUST run for reaped sessions; otherwise listeners /
    // timers inside the transport leak until process exit.
    expect(closed).toEqual(["stale"]);
    expect(transports["stale"]).toBeUndefined();
    expect(transports["fresh"]).toBeDefined();
  });

  it("reaps sessions whose last-activity entry is undefined (stuck-session bug)", async () => {
    const { reapIdleStreamableSessions } = await import("../server.js");

    // Missing/undefined sessionLastActivity[sid] triggers
    // `now - undefined === NaN`, and `NaN > ttlMs` is always false — so the
    // pre-fix reaper silently skipped these sessions forever. Defensive fix:
    // coalesce undefined to 0.
    const closed: string[] = [];
    const transports: Record<string, { close: () => void }> = {
      "no-activity": {
        close: () => {
          closed.push("no-activity");
        },
      },
    };
    const sessionLastActivity: Record<string, number> = {};

    const reaped = reapIdleStreamableSessions({
      transports: transports as unknown as Parameters<
        typeof reapIdleStreamableSessions
      >[0]["transports"],
      sessionLastActivity,
      ttlMs: 5 * 60 * 1000,
      now: Date.now(),
    });

    expect(reaped).toEqual(["no-activity"]);
    await new Promise((r) => setTimeout(r, 10));
    expect(closed).toEqual(["no-activity"]);
    expect(transports["no-activity"]).toBeUndefined();
  });

  it("logs async transport.close() rejections instead of leaving them unhandled", async () => {
    const { reapIdleStreamableSessions } = await import("../server.js");

    const consoleErrSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const transports: Record<string, { close: () => Promise<void> }> = {
        stale: {
          close: () => Promise.reject(new Error("streamable-close-boom")),
        },
      };
      const sessionLastActivity: Record<string, number> = {
        stale: Date.now() - 10 * 60 * 1000,
      };

      const reaped = reapIdleStreamableSessions({
        transports: transports as unknown as Parameters<
          typeof reapIdleStreamableSessions
        >[0]["transports"],
        sessionLastActivity,
        ttlMs: 5 * 60 * 1000,
        now: Date.now(),
      });
      expect(reaped).toEqual(["stale"]);

      await new Promise((r) => setTimeout(r, 10));

      const sawBoom = consoleErrSpy.mock.calls.some((call) =>
        call.some(
          (arg) =>
            (typeof arg === "string" &&
              arg.includes("streamable-close-boom")) ||
            (arg instanceof Error && arg.message === "streamable-close-boom"),
        ),
      );
      expect(sawBoom).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      consoleErrSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// /mcp race fallback handler
// ---------------------------------------------------------------------------

describe("handleSessionInitRaceFallback", () => {
  it("removes transports[sid] and sessionLastActivity[sid] INLINE (not awaiting onclose)", async () => {
    const { handleSessionInitRaceFallback } = await import("../server.js");

    const transports: Record<string, { close: () => Promise<void> }> = {};
    const sessionLastActivity: Record<string, number> = {};
    const sid = "race-sid";
    const closed: string[] = [];
    const transport = {
      close: async () => {
        closed.push(sid);
      },
      send: vi.fn(),
    };
    // Pretend the onsessioninitialized callback already registered the sid.
    transports[sid] = transport;
    sessionLastActivity[sid] = Date.now();

    handleSessionInitRaceFallback({
      transport: transport as unknown as Parameters<
        typeof handleSessionInitRaceFallback
      >[0]["transport"],
      sid,
      ip: "1.2.3.4",
      transports: transports as unknown as Parameters<
        typeof handleSessionInitRaceFallback
      >[0]["transports"],
      sessionLastActivity,
      limit: 10,
      currentCount: 11,
      retryAfterSeconds: 60,
    });

    // Maps cleared synchronously — we do NOT rely on onclose firing later.
    expect(transports[sid]).toBeUndefined();
    expect(sessionLastActivity[sid]).toBeUndefined();

    // Allow microtasks so close() promise settles if any.
    await new Promise((r) => setTimeout(r, 10));
  });

  it("closes the transport and logs a diagnostic warn without calling transport.send (pinned fallback contract)", async () => {
    const { handleSessionInitRaceFallback } = await import("../server.js");

    const transports: Record<string, { close: () => Promise<void> }> = {};
    const sessionLastActivity: Record<string, number> = {};
    const sid = "race-sid-2";
    const sendCalls: unknown[] = [];
    let closedAt: number | undefined;
    let sentAt: number | undefined;

    const transport = {
      close: async () => {
        closedAt = Date.now();
      },
      send: async (msg: unknown) => {
        sentAt = Date.now();
        sendCalls.push(msg);
      },
    };
    transports[sid] = transport;
    sessionLastActivity[sid] = Date.now();

    // Silence warn/error — the fallback will log.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    handleSessionInitRaceFallback({
      transport: transport as unknown as Parameters<
        typeof handleSessionInitRaceFallback
      >[0]["transport"],
      sid,
      ip: "1.2.3.4",
      transports: transports as unknown as Parameters<
        typeof handleSessionInitRaceFallback
      >[0]["transports"],
      sessionLastActivity,
      limit: 10,
      currentCount: 11,
      retryAfterSeconds: 60,
    });

    // Allow send/close microtasks to flush.
    await new Promise((r) => setTimeout(r, 20));

    // Pinned contract (R3 #24 / R4-15): the fallback MUST take the
    // "silent-disconnect + loud warn" path because the MCP SDK lifecycle
    // rejects transport.send() inside onsessioninitialized (send() throws
    // "Not connected" — the stream controller isn't wired yet). The JSDoc
    // on handleSessionInitRaceFallback in src/server.ts documents this as
    // intentional. Prior to this commit the test accepted EITHER branch,
    // which is a contract-less assertion: the code has always taken the
    // fallback, so the "happy path" branch was unreachable dead validation.
    // If a future SDK change unlocks transport.send() here, that's a
    // separate diff — update the contract AND the test together.

    // (1) transport.send must NOT be called.
    expect(sendCalls.length).toBe(0);
    expect(sentAt).toBeUndefined();
    // (2) transport.close WAS called.
    expect(closedAt).toBeDefined();
    // (3) A diagnostic warn fired with the sid prefix so operators can
    //     correlate the silent disconnect with a rate-limit trip.
    const warnCalls = warnSpy.mock.calls.map((c) => c[0]);
    const rejectedLog = warnCalls.find(
      (m) =>
        typeof m === "string" &&
        m.includes("race fallback") &&
        m.includes(sid.slice(0, 8)),
    );
    expect(rejectedLog).toBeDefined();

    warnSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("includes the clamped retry-after value in the warn log so operators see the retry hint (R2 #2)", async () => {
    const { handleSessionInitRaceFallback } = await import("../server.js");

    const transports: Record<string, { close: () => Promise<void> }> = {};
    const sessionLastActivity: Record<string, number> = {};
    const sid = "race-sid-retry-log";
    const transport = {
      close: async () => {},
      send: vi.fn(),
    };
    transports[sid] = transport;
    sessionLastActivity[sid] = Date.now();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Pass an intentionally huge retry-after (mirrors the real site which
    // derives from SESSION_TTL_MS/1000 = 1800). The log must carry the
    // CLAMPED value (300 = 5m ceiling) so ops see a retry hint that matches
    // what clients receive, not the pre-clamp seed value.
    handleSessionInitRaceFallback({
      transport: transport as unknown as Parameters<
        typeof handleSessionInitRaceFallback
      >[0]["transport"],
      sid,
      ip: "1.2.3.4",
      transports: transports as unknown as Parameters<
        typeof handleSessionInitRaceFallback
      >[0]["transports"],
      sessionLastActivity,
      limit: 10,
      currentCount: 11,
      retryAfterSeconds: 1800,
    });

    await new Promise((r) => setTimeout(r, 10));

    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0] ?? ""));
    const logged = warnCalls.find(
      (m) => m.includes("race fallback") && m.includes(sid.slice(0, 8)),
    );
    expect(logged).toBeDefined();
    // Must carry the CLAMPED value (300), not the pre-clamp 1800. Include
    // "retry" marker so we know this is the retry hint, not some other
    // integer in the log line.
    expect(logged!).toMatch(/retry[^0-9]*300/i);
    expect(logged!).not.toMatch(/1800/);

    warnSpy.mockRestore();
    errSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// /mcp pre-check Retry-After header clamp parity (R2 #1)
// ---------------------------------------------------------------------------

describe("write429RateLimited (helper used by /mcp pre-check)", () => {
  it("clamps the Retry-After header to the same ceiling as the JSON body (R2 #1)", async () => {
    const { write429RateLimited } = await import("../server.js");

    const headers: Record<string, string> = {};
    let bodyWritten: Record<string, unknown> | undefined;
    let statusWritten: number | undefined;
    const res = {
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
      status: (code: number) => {
        statusWritten = code;
        return res;
      },
      json: (body: Record<string, unknown>) => {
        bodyWritten = body;
        return res;
      },
    };

    // Seed with the raw SESSION_TTL_MS-derived hint (30m -> 1800s). Pre-clamp
    // this would flow into the header unchanged while the JSON body got
    // clamped to 300 via buildRateLimitPayload -> the two values disagreed.
    write429RateLimited(res as unknown as express.Response, {
      id: 42,
      limit: 10,
      currentCount: 11,
      retryAfterSeconds: 1800,
    });

    expect(statusWritten).toBe(429);
    expect(headers["Retry-After"]).toBe("300");
    const data = (bodyWritten?.error as { data?: Record<string, unknown> })
      ?.data;
    expect(data?.retryAfterSeconds).toBe(300);
    // Header and body agree — the whole point of this finding.
    expect(headers["Retry-After"]).toBe(String(data?.retryAfterSeconds));
  });
});

// ---------------------------------------------------------------------------
// onsessioninitialized accept-handler: ensureSession throw rolls back state
// (R2 #5)
// ---------------------------------------------------------------------------

describe("handleSessionInitAccept (ensureSession failure rollback)", () => {
  it("rolls back ipLimiter + clears maps + closes transport when ensureSession throws (no IP-quota leak)", async () => {
    const { handleSessionInitAccept } = await import("../server.js");

    const consoleErrSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const sid = "ensure-boom-sid";
      const ip = "9.9.9.9";
      const transports: Record<string, unknown> = {};
      const sessionLastActivity: Record<string, number> = {};
      transports[sid] = { fake: true };
      sessionLastActivity[sid] = Date.now();

      const removedSids: string[] = [];
      const ipLimiter = {
        remove: (s: string) => {
          removedSids.push(s);
        },
      };
      const workspaceManager = {
        ensureSession: () => {
          throw new Error("ensure-boom");
        },
      };
      const closedSids: string[] = [];
      const transport = {
        close: async () => {
          closedSids.push(sid);
        },
      };

      handleSessionInitAccept({
        transport,
        sid,
        ip,
        transports,
        sessionLastActivity,
        ipLimiter,
        workspaceManager,
      });

      // Synchronous: maps cleared, ipLimiter rolled back (no TTL leak).
      expect(transports[sid]).toBeUndefined();
      expect(sessionLastActivity[sid]).toBeUndefined();
      expect(removedSids).toEqual([sid]);

      // Microtask: transport.close() completes.
      await new Promise((r) => setTimeout(r, 10));
      expect(closedSids).toEqual([sid]);

      const sawBoom = consoleErrSpy.mock.calls.some((c) =>
        c.some(
          (arg) =>
            (typeof arg === "string" && arg.includes("ensure-boom")) ||
            (arg instanceof Error && arg.message === "ensure-boom"),
        ),
      );
      expect(sawBoom).toBe(true);
    } finally {
      consoleErrSpy.mockRestore();
    }
  });

  it("happy path: ensureSession succeeds and maps stay populated", async () => {
    const { handleSessionInitAccept } = await import("../server.js");

    const sid = "ensure-ok-sid";
    const transports: Record<string, unknown> = { [sid]: { fake: true } };
    const sessionLastActivity: Record<string, number> = { [sid]: Date.now() };

    const ensureCalls: string[] = [];
    handleSessionInitAccept({
      transport: { close: async () => {} },
      sid,
      ip: "1.1.1.1",
      transports,
      sessionLastActivity,
      ipLimiter: {
        remove: () => {
          // must NOT be called on the happy path
          throw new Error("remove should not be called");
        },
      },
      workspaceManager: {
        ensureSession: (s: string) => {
          ensureCalls.push(s);
        },
      },
    });

    expect(ensureCalls).toEqual([sid]);
    expect(transports[sid]).toBeDefined();
    expect(sessionLastActivity[sid]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// R3 #1: reapIdleSessionsTick plumbs ipLimiter/workspaceManager/
// sessionStateManager into the SSE reaper so cleanup stays with the reaper
// (not a post-reap loop in server.ts).
// ---------------------------------------------------------------------------

describe("reapIdleSessionsTick (R3 #1: SSE reaper dep plumbing)", () => {
  it("passes ipLimiter.remove, workspaceManager.cleanup, and sessionStateManager.cleanup into the SSE reaper for each reaped sid", async () => {
    const { reapIdleSessionsTickForTesting } = await import("../server.js");

    const sseTransports: Record<string, { close: () => Promise<void> | void }> =
      {
        "sse-stale": {
          close: async () => {},
        },
      };
    const transports: Record<string, { close: () => Promise<void> | void }> =
      {};
    const sessionLastActivity: Record<string, number> = {
      "sse-stale": Date.now() - 10 * 60 * 1000,
    };

    const removedSids: string[] = [];
    const cleanedWorkspaceSids: string[] = [];
    const cleanedSessionStateSids: string[] = [];

    reapIdleSessionsTickForTesting({
      transports: transports as unknown as Parameters<
        typeof reapIdleSessionsTickForTesting
      >[0]["transports"],
      sseTransports: sseTransports as unknown as Parameters<
        typeof reapIdleSessionsTickForTesting
      >[0]["sseTransports"],
      sessionLastActivity,
      ttlMs: 5 * 60 * 1000,
      now: Date.now(),
      ipLimiter: {
        remove: (sid: string) => {
          removedSids.push(sid);
        },
      },
      workspaceManager: {
        cleanup: (sid: string) => {
          cleanedWorkspaceSids.push(sid);
        },
      },
      sessionStateManager: {
        cleanup: (sid: string) => {
          cleanedSessionStateSids.push(sid);
        },
      },
    });

    // Each cleanup dep got the reaped sid once.
    expect(removedSids).toEqual(["sse-stale"]);
    expect(cleanedWorkspaceSids).toEqual(["sse-stale"]);
    expect(cleanedSessionStateSids).toEqual(["sse-stale"]);
    // Map entry gone (reaper deletes inline).
    expect(sseTransports["sse-stale"]).toBeUndefined();
  });

  it("emits a per-sid cleanup summary log for each reaped streamable session (R4-6)", async () => {
    const { reapIdleSessionsTickForTesting } = await import("../server.js");

    const transports: Record<string, { close: () => Promise<void> | void }> = {
      "stale-a": { close: async () => {} },
      "stale-b": { close: async () => {} },
    };
    const sseTransports: Record<string, { close: () => Promise<void> | void }> =
      {};
    const sessionLastActivity: Record<string, number> = {
      "stale-a": Date.now() - 10 * 60 * 1000,
      "stale-b": Date.now() - 10 * 60 * 1000,
    };

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      reapIdleSessionsTickForTesting({
        transports,
        sseTransports,
        sessionLastActivity,
        ttlMs: 5 * 60 * 1000,
        now: Date.now(),
        ipLimiter: { remove: () => {} },
        workspaceManager: {
          cleanup: (sid: string) => {
            if (sid === "stale-b") throw new Error("workspace-boom");
          },
        },
        sessionStateManager: { cleanup: () => {} },
      });

      const summaryLines = logSpy.mock.calls
        .map((c) => c.join(" "))
        .filter((line) => line.includes("Reap cleanup"));
      // One summary line per reaped streamable sid.
      expect(summaryLines.length).toBe(2);
      const summaryForA = summaryLines.find((l) => l.includes("stale-a"));
      const summaryForB = summaryLines.find((l) => l.includes("stale-b"));
      expect(summaryForA).toBeDefined();
      expect(summaryForB).toBeDefined();
      // The stale-a row reports ok for every step; stale-b reports workspace=throw.
      expect(summaryForA).toMatch(/state=ok/);
      expect(summaryForA).toMatch(/ipLimiter=ok/);
      expect(summaryForA).toMatch(/workspace=ok/);
      expect(summaryForB).toMatch(/workspace=(throw|failed|err)/);
      // The aggregate log still fires.
      const aggregate = logSpy.mock.calls
        .map((c) => c.join(" "))
        .find((line) => line.includes("Reaped 2 idle sessions"));
      expect(aggregate).toBeDefined();
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// R3 #2 + H2: handleSessionInitAccept returns false on rollback; includes
// sessionStateManager cleanup in the rollback chain.
// ---------------------------------------------------------------------------

describe("handleSessionInitAccept (R3 #2 rollback signaling + H2 sessionStateManager)", () => {
  it("returns false when ensureSession throws so caller can skip server.connect/handleRequest", async () => {
    const { handleSessionInitAccept } = await import("../server.js");

    const consoleErrSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const sid = "r3-rollback-sid";
      const transports: Record<string, unknown> = { [sid]: { fake: true } };
      const sessionLastActivity: Record<string, number> = {
        [sid]: Date.now(),
      };

      const result = handleSessionInitAccept({
        transport: { close: async () => {} },
        sid,
        ip: "9.9.9.9",
        transports,
        sessionLastActivity,
        ipLimiter: { remove: () => {} },
        workspaceManager: {
          ensureSession: () => {
            throw new Error("ensure-r3-boom");
          },
        },
      });

      expect(result).toBe(false);
    } finally {
      consoleErrSpy.mockRestore();
    }
  });

  it("returns true on the happy path (caller proceeds to server.connect/handleRequest)", async () => {
    const { handleSessionInitAccept } = await import("../server.js");

    const sid = "r3-ok-sid";
    const transports: Record<string, unknown> = { [sid]: { fake: true } };
    const sessionLastActivity: Record<string, number> = { [sid]: Date.now() };

    const result = handleSessionInitAccept({
      transport: { close: async () => {} },
      sid,
      ip: "1.1.1.1",
      transports,
      sessionLastActivity,
      ipLimiter: { remove: () => {} },
      workspaceManager: {
        ensureSession: () => {},
      },
    });

    expect(result).toBe(true);
  });

  it("H2: rollback also invokes sessionStateManager.cleanup(sid) when provided", async () => {
    const { handleSessionInitAccept } = await import("../server.js");

    const consoleErrSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const sid = "r3-sstate-sid";
      const transports: Record<string, unknown> = { [sid]: { fake: true } };
      const sessionLastActivity: Record<string, number> = {
        [sid]: Date.now(),
      };

      const cleanedSessionStateSids: string[] = [];
      handleSessionInitAccept({
        transport: { close: async () => {} },
        sid,
        ip: "9.9.9.9",
        transports,
        sessionLastActivity,
        ipLimiter: { remove: () => {} },
        workspaceManager: {
          ensureSession: () => {
            throw new Error("ensure-r3-state-boom");
          },
        },
        sessionStateManager: {
          cleanup: (s: string) => {
            cleanedSessionStateSids.push(s);
          },
        },
      });

      expect(cleanedSessionStateSids).toEqual([sid]);
    } finally {
      consoleErrSpy.mockRestore();
    }
  });

  it("H2: a throw from sessionStateManager.cleanup does not mask the rollback (maps still cleared, transport still closed)", async () => {
    const { handleSessionInitAccept } = await import("../server.js");

    const consoleErrSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const sid = "r3-sstate-throw-sid";
      const transports: Record<string, unknown> = { [sid]: { fake: true } };
      const sessionLastActivity: Record<string, number> = {
        [sid]: Date.now(),
      };

      const closedSids: string[] = [];
      const result = handleSessionInitAccept({
        transport: {
          close: async () => {
            closedSids.push(sid);
          },
        },
        sid,
        ip: "9.9.9.9",
        transports,
        sessionLastActivity,
        ipLimiter: { remove: () => {} },
        workspaceManager: {
          ensureSession: () => {
            throw new Error("ensure-boom");
          },
        },
        sessionStateManager: {
          cleanup: () => {
            throw new Error("sstate-cleanup-boom");
          },
        },
      });

      expect(result).toBe(false);
      expect(transports[sid]).toBeUndefined();
      expect(sessionLastActivity[sid]).toBeUndefined();
      await new Promise((r) => setTimeout(r, 10));
      expect(closedSids).toEqual([sid]);
      const sawSstateBoom = consoleErrSpy.mock.calls.some((c) =>
        c.some(
          (arg) =>
            (typeof arg === "string" && arg.includes("sstate-cleanup-boom")) ||
            (arg instanceof Error && arg.message === "sstate-cleanup-boom"),
        ),
      );
      expect(sawSstateBoom).toBe(true);
    } finally {
      consoleErrSpy.mockRestore();
    }
  });

  it("R3 #2: writes a 503 response body on rollback when res is provided and headers not yet sent", async () => {
    const { handleSessionInitAccept } = await import("../server.js");

    const consoleErrSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const sid = "r3-503-sid";
      const transports: Record<string, unknown> = { [sid]: { fake: true } };
      const sessionLastActivity: Record<string, number> = {
        [sid]: Date.now(),
      };

      let statusWritten: number | undefined;
      let bodyWritten: Record<string, unknown> | undefined;
      const res = {
        headersSent: false,
        status: (c: number) => {
          statusWritten = c;
          return res;
        },
        json: (b: Record<string, unknown>) => {
          bodyWritten = b;
          return res;
        },
      };

      handleSessionInitAccept({
        transport: { close: async () => {} },
        sid,
        ip: "9.9.9.9",
        transports,
        sessionLastActivity,
        ipLimiter: { remove: () => {} },
        workspaceManager: {
          ensureSession: () => {
            throw new Error("ensure-503-boom");
          },
        },
        res: res as unknown as Parameters<
          typeof handleSessionInitAccept
        >[0]["res"],
      });

      expect(statusWritten).toBe(503);
      expect(bodyWritten).toBeDefined();
      const err = (bodyWritten as Record<string, unknown>).error as
        | Record<string, unknown>
        | undefined;
      // JSON-RPC shape: error.code/message. A plain string also acceptable —
      // just verify the client gets a structured signal.
      expect(
        typeof (bodyWritten as Record<string, unknown>).error !== "undefined",
      ).toBe(true);
      void err;
    } finally {
      consoleErrSpy.mockRestore();
    }
  });

  it("R3 #2: does NOT write a response body on rollback when headersSent is already true", async () => {
    const { handleSessionInitAccept } = await import("../server.js");

    const consoleErrSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const sid = "r3-hs-sent-sid";
      const transports: Record<string, unknown> = { [sid]: { fake: true } };
      const sessionLastActivity: Record<string, number> = {
        [sid]: Date.now(),
      };

      let statusCalled = false;
      let jsonCalled = false;
      const res = {
        headersSent: true,
        status: () => {
          statusCalled = true;
          return res;
        },
        json: () => {
          jsonCalled = true;
          return res;
        },
      };

      handleSessionInitAccept({
        transport: { close: async () => {} },
        sid,
        ip: "9.9.9.9",
        transports,
        sessionLastActivity,
        ipLimiter: { remove: () => {} },
        workspaceManager: {
          ensureSession: () => {
            throw new Error("ensure-hs-boom");
          },
        },
        res: res as unknown as Parameters<
          typeof handleSessionInitAccept
        >[0]["res"],
      });

      expect(statusCalled).toBe(false);
      expect(jsonCalled).toBe(false);
    } finally {
      consoleErrSpy.mockRestore();
    }
  });

  it("R4-17: still runs rollback side effects (map delete, ipLimiter.remove, close) when headersSent is true", async () => {
    const { handleSessionInitAccept } = await import("../server.js");

    const consoleErrSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const sid = "r4-17-sid";
      const transports: Record<string, unknown> = {
        [sid]: { fake: true },
        other: { fake: true },
      };
      const sessionLastActivity: Record<string, number> = {
        [sid]: Date.now(),
        other: Date.now(),
      };

      let ipLimiterRemovedSid: string | undefined;
      let closeCalled = false;

      const res = {
        headersSent: true,
        status: () => res,
        json: () => res,
      };

      handleSessionInitAccept({
        transport: {
          close: async () => {
            closeCalled = true;
          },
        },
        sid,
        ip: "9.9.9.9",
        transports,
        sessionLastActivity,
        ipLimiter: {
          remove: (s: string) => {
            ipLimiterRemovedSid = s;
          },
        },
        workspaceManager: {
          ensureSession: () => {
            throw new Error("ensure-hs-boom");
          },
        },
        res: res as unknown as Parameters<
          typeof handleSessionInitAccept
        >[0]["res"],
      });

      // Allow the microtask-scheduled transport.close() to run.
      await new Promise((r) => setImmediate(r));

      // Side effects that MUST run even when the body couldn't be written:
      expect(transports[sid]).toBeUndefined();
      expect(sessionLastActivity[sid]).toBeUndefined();
      expect(ipLimiterRemovedSid).toBe(sid);
      expect(closeCalled).toBe(true);
      // And unrelated entries untouched.
      expect(transports.other).toBeDefined();
      expect(sessionLastActivity.other).toBeDefined();
    } finally {
      consoleErrSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// R3 #3 (H1): onclose cleanup is suppressed for sids rejected by race fallback
// or ensureSession rollback — those paths already cleaned up inline and a
// second round of "Session closed" logs / cleanup calls pollutes operator
// visibility and risks double-free.
// ---------------------------------------------------------------------------

describe("rejected-sid suppression (R3 #3 / H1)", () => {
  it("markSessionRejected(sid) + onclose path skips cleanup chain", async () => {
    const serverMod = await import("../server.js");
    const markSessionRejected = (
      serverMod as unknown as {
        markSessionRejectedForTesting?: (sid: string) => void;
      }
    ).markSessionRejectedForTesting;
    const wasRejected = (
      serverMod as unknown as {
        wasSessionRejectedForTesting?: (sid: string) => boolean;
      }
    ).wasSessionRejectedForTesting;

    expect(typeof markSessionRejected).toBe("function");
    expect(typeof wasRejected).toBe("function");
    markSessionRejected!("rej-sid");
    expect(wasRejected!("rej-sid")).toBe(true);
    expect(wasRejected!("other-sid")).toBe(false);
  });

  it("handleSessionInitRaceFallback marks the sid as rejected", async () => {
    const serverMod = await import("../server.js");
    const { handleSessionInitRaceFallback } = serverMod;
    const wasRejected = (
      serverMod as unknown as {
        wasSessionRejectedForTesting?: (sid: string) => boolean;
      }
    ).wasSessionRejectedForTesting;
    expect(typeof wasRejected).toBe("function");

    const sid = "race-marks-rejected";
    const transports: Record<string, { close: () => Promise<void> }> = {};
    const sessionLastActivity: Record<string, number> = {};
    const transport = {
      close: async () => {},
    };
    transports[sid] = transport;
    sessionLastActivity[sid] = Date.now();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      handleSessionInitRaceFallback({
        transport: transport as unknown as Parameters<
          typeof handleSessionInitRaceFallback
        >[0]["transport"],
        sid,
        ip: "1.2.3.4",
        transports: transports as unknown as Parameters<
          typeof handleSessionInitRaceFallback
        >[0]["transports"],
        sessionLastActivity,
        limit: 10,
        currentCount: 11,
        retryAfterSeconds: 60,
      });
      expect(wasRejected!(sid)).toBe(true);
    } finally {
      warnSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("handleSessionInitAccept rollback marks the sid as rejected", async () => {
    const serverMod = await import("../server.js");
    const { handleSessionInitAccept } = serverMod;
    const wasRejected = (
      serverMod as unknown as {
        wasSessionRejectedForTesting?: (sid: string) => boolean;
      }
    ).wasSessionRejectedForTesting;
    expect(typeof wasRejected).toBe("function");

    const sid = "accept-rollback-marks-rejected";
    const transports: Record<string, unknown> = { [sid]: { fake: true } };
    const sessionLastActivity: Record<string, number> = { [sid]: Date.now() };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      handleSessionInitAccept({
        transport: { close: async () => {} },
        sid,
        ip: "9.9.9.9",
        transports,
        sessionLastActivity,
        ipLimiter: { remove: () => {} },
        workspaceManager: {
          ensureSession: () => {
            throw new Error("ensure-mark-boom");
          },
        },
      });
      expect(wasRejected!(sid)).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// R4 #1: rejectedSids leak on inline-rollback paths.
//
// The race-fallback and accept-rollback helpers seed rejectedSids so that
// IF transport.onclose were wired, it could suppress double-cleanup. But the
// outer POST /mcp route wires `transport.onclose` AFTER both early-return
// paths — in the tryAdd-fail and accept-rollback flows no handler is ever
// attached. The marker leaked forever under rate-limit hammering / workspace
// failures. Fix: drain inline once cleanup is done.
// ---------------------------------------------------------------------------

describe("rejectedSids inline-rollback drain (R4 #1)", () => {
  it("drainRejectedSidForInlineRollback removes the marker so the Set cannot leak", async () => {
    const serverMod = await import("../server.js");
    const { handleSessionInitRaceFallback } = serverMod;
    const wasRejected = (
      serverMod as unknown as {
        wasSessionRejectedForTesting?: (sid: string) => boolean;
      }
    ).wasSessionRejectedForTesting;
    const drain = (
      serverMod as unknown as {
        drainRejectedSidForInlineRollback?: (sid: string) => void;
      }
    ).drainRejectedSidForInlineRollback;

    expect(typeof drain).toBe("function");
    expect(typeof wasRejected).toBe("function");

    const sid = "sync-race-leak";
    const transports: Record<string, { close: () => Promise<void> }> = {};
    const sessionLastActivity: Record<string, number> = {};
    transports[sid] = { close: async () => {} };
    sessionLastActivity[sid] = Date.now();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      handleSessionInitRaceFallback({
        transport: transports[sid] as unknown as Parameters<
          typeof handleSessionInitRaceFallback
        >[0]["transport"],
        sid,
        ip: "1.2.3.4",
        transports: transports as unknown as Parameters<
          typeof handleSessionInitRaceFallback
        >[0]["transports"],
        sessionLastActivity,
        limit: 1,
        currentCount: 2,
        retryAfterSeconds: 60,
      });
      expect(wasRejected!(sid)).toBe(true);
      drain!(sid);
      expect(wasRejected!(sid)).toBe(false);
    } finally {
      warnSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("drainRejectedSidForInlineRollback also clears markers left by handleSessionInitAccept rollback", async () => {
    const serverMod = await import("../server.js");
    const { handleSessionInitAccept } = serverMod;
    const wasRejected = (
      serverMod as unknown as {
        wasSessionRejectedForTesting?: (sid: string) => boolean;
      }
    ).wasSessionRejectedForTesting;
    const drain = (
      serverMod as unknown as {
        drainRejectedSidForInlineRollback?: (sid: string) => void;
      }
    ).drainRejectedSidForInlineRollback;

    expect(typeof drain).toBe("function");
    expect(typeof wasRejected).toBe("function");

    const sid = "accept-rollback-leak";
    const transports: Record<string, unknown> = { [sid]: { fake: true } };
    const sessionLastActivity: Record<string, number> = { [sid]: Date.now() };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      handleSessionInitAccept({
        transport: { close: async () => {} },
        sid,
        ip: "9.9.9.9",
        transports,
        sessionLastActivity,
        ipLimiter: { remove: () => {} },
        workspaceManager: {
          ensureSession: () => {
            throw new Error("ensure-drain-boom");
          },
        },
      });
      expect(wasRejected!(sid)).toBe(true);
      drain!(sid);
      expect(wasRejected!(sid)).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// R4 #2: completeInitRequestSafely guards the outer /mcp handler against
// residual handleRequest throws after the onsessioninitialized race-fallback
// closed the transport mid-flight. Without this wrapper the SDK's closed-
// transport throw escaped into the outer catch-all and produced a 500 write
// on top of the 429 the fallback already streamed.
// ---------------------------------------------------------------------------

describe("completeInitRequestSafely (R4 #2)", () => {
  it("returns normally when handleRequest resolves and initOutcome stays unrejected", async () => {
    const serverMod = await import("../server.js");
    const fn = (
      serverMod as unknown as {
        completeInitRequestSafely?: (
          transport: { handleRequest: (...args: unknown[]) => Promise<void> },
          req: unknown,
          res: unknown,
          body: unknown,
          initOutcome: { rejected: boolean },
        ) => Promise<void>;
      }
    ).completeInitRequestSafely;
    expect(typeof fn).toBe("function");

    let called = 0;
    const transport = {
      handleRequest: async () => {
        called++;
      },
    };
    const initOutcome = { rejected: false };

    await fn!(transport, {}, {}, {}, initOutcome);
    expect(called).toBe(1);
  });

  it("swallows handleRequest throws when the race-fallback marked initOutcome.rejected", async () => {
    const serverMod = await import("../server.js");
    const fn = (
      serverMod as unknown as {
        completeInitRequestSafely?: (
          transport: { handleRequest: (...args: unknown[]) => Promise<void> },
          req: unknown,
          res: unknown,
          body: unknown,
          initOutcome: { rejected: boolean },
        ) => Promise<void>;
      }
    ).completeInitRequestSafely;
    expect(typeof fn).toBe("function");

    const transport = {
      handleRequest: async () => {
        throw new Error("closed-transport-boom");
      },
    };
    const initOutcome = { rejected: true };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        fn!(transport, {}, { headersSent: true }, {}, initOutcome),
      ).resolves.toBeUndefined();
      const suppressed = warnSpy.mock.calls.some((c) =>
        c.some(
          (arg) =>
            typeof arg === "string" &&
            arg.toLowerCase().includes("suppressed") &&
            arg.toLowerCase().includes("rejected"),
        ),
      );
      expect(suppressed).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("re-throws handleRequest errors when the session was NOT race-rejected", async () => {
    const serverMod = await import("../server.js");
    const fn = (
      serverMod as unknown as {
        completeInitRequestSafely?: (
          transport: { handleRequest: (...args: unknown[]) => Promise<void> },
          req: unknown,
          res: unknown,
          body: unknown,
          initOutcome: { rejected: boolean },
        ) => Promise<void>;
      }
    ).completeInitRequestSafely;
    expect(typeof fn).toBe("function");

    const transport = {
      handleRequest: async () => {
        throw new Error("real-bug");
      },
    };
    const initOutcome = { rejected: false };

    await expect(
      fn!(transport, {}, { headersSent: false }, {}, initOutcome),
    ).rejects.toThrow("real-bug");
  });
});

// ---------------------------------------------------------------------------
// R4 #4: Retry-After TTL helper — single source of truth for the
// Math.max(1, Math.round(SESSION_TTL_MS / 1000)) expression that used to be
// duplicated across the /mcp init paths.
// ---------------------------------------------------------------------------

describe("retryAfterSecondsFromTtl (R4 #4)", () => {
  it("exposes the TTL-derived Retry-After seconds as a positive integer", async () => {
    const serverMod = await import("../server.js");
    const fn = (
      serverMod as unknown as {
        retryAfterSecondsFromTtl?: () => number;
      }
    ).retryAfterSecondsFromTtl;

    expect(typeof fn).toBe("function");
    const secs = fn!();
    expect(Number.isInteger(secs)).toBe(true);
    expect(secs).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// R3 #5: write429RateLimited guards against headersSent
// ---------------------------------------------------------------------------

describe("write429RateLimited (R3 #5: headersSent guard)", () => {
  it("bails without throwing and does not call setHeader/status/json when headersSent is true", async () => {
    const { write429RateLimited } = await import("../server.js");

    let setHeaderCalled = false;
    let statusCalled = false;
    let jsonCalled = false;
    const res = {
      headersSent: true,
      setHeader: () => {
        setHeaderCalled = true;
      },
      status: () => {
        statusCalled = true;
        return res;
      },
      json: () => {
        jsonCalled = true;
        return res;
      },
    };

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Must not throw.
      expect(() =>
        write429RateLimited(res as unknown as express.Response, {
          id: 1,
          limit: 10,
          currentCount: 11,
          retryAfterSeconds: 60,
        }),
      ).not.toThrow();
      expect(setHeaderCalled).toBe(false);
      expect(statusCalled).toBe(false);
      expect(jsonCalled).toBe(false);
      // A diagnostic log line is emitted so operators can correlate.
      const logged = errSpy.mock.calls.some((c) =>
        c.some(
          (arg) =>
            typeof arg === "string" &&
            arg.includes("headers sent") &&
            arg.toLowerCase().includes("429"),
        ),
      );
      expect(logged).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Shutdown helper: closes both streamable-HTTP and SSE transports (R2 #6)
// ---------------------------------------------------------------------------

describe("closeAllSessions (shutdown helper)", () => {
  it("runs streamable + sse close batches in parallel, not sequentially (R3 #11)", async () => {
    const { closeAllSessions } = await import("../server.js");

    const SLOW_MS = 80;
    const transports: Record<string, { close: () => Promise<void> | void }> = {
      "s-slow": {
        close: () => new Promise((r) => setTimeout(r, SLOW_MS)),
      },
    };
    const sseTransports: Record<string, { close: () => Promise<void> | void }> =
      {
        "e-slow": {
          close: () => new Promise((r) => setTimeout(r, SLOW_MS)),
        },
      };

    const start = Date.now();
    await closeAllSessions({
      transports: transports as unknown as Parameters<
        typeof closeAllSessions
      >[0]["transports"],
      sseTransports: sseTransports as unknown as Parameters<
        typeof closeAllSessions
      >[0]["sseTransports"],
    });
    const elapsed = Date.now() - start;

    // Sequential would be ~2*SLOW_MS, parallel ~SLOW_MS. Leave headroom for
    // Node timer jitter: anything under 1.5*SLOW_MS proves parallelism.
    expect(elapsed).toBeLessThan(SLOW_MS * 1.5);
    expect(Object.keys(transports)).toEqual([]);
    expect(Object.keys(sseTransports)).toEqual([]);
  });

  it("closes every streamable-HTTP transport and every SSE transport and clears the maps", async () => {
    const { closeAllSessions } = await import("../server.js");

    const closedStreamable: string[] = [];
    const closedSse: string[] = [];
    const transports: Record<string, { close: () => Promise<void> | void }> = {
      "s-1": {
        close: () => {
          closedStreamable.push("s-1");
        },
      },
      "s-2": {
        close: async () => {
          closedStreamable.push("s-2");
        },
      },
    };
    const sseTransports: Record<string, { close: () => Promise<void> | void }> =
      {
        "e-1": {
          close: async () => {
            closedSse.push("e-1");
          },
        },
      };

    await closeAllSessions({
      transports: transports as unknown as Parameters<
        typeof closeAllSessions
      >[0]["transports"],
      sseTransports: sseTransports as unknown as Parameters<
        typeof closeAllSessions
      >[0]["sseTransports"],
    });

    expect(closedStreamable.sort()).toEqual(["s-1", "s-2"]);
    expect(closedSse).toEqual(["e-1"]);
    expect(Object.keys(transports)).toEqual([]);
    expect(Object.keys(sseTransports)).toEqual([]);
  });

  it("continues closing other transports when one close() rejects and logs the failure", async () => {
    const { closeAllSessions } = await import("../server.js");

    const consoleErrSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const closedOk: string[] = [];
      const transports: Record<string, { close: () => Promise<void> | void }> =
        {
          "bad-1": {
            close: async () => {
              throw new Error("streamable-shutdown-boom");
            },
          },
          "good-1": {
            close: async () => {
              closedOk.push("good-1");
            },
          },
        };
      const sseTransports: Record<
        string,
        { close: () => Promise<void> | void }
      > = {
        "bad-sse": {
          close: async () => {
            throw new Error("sse-shutdown-boom");
          },
        },
      };

      await closeAllSessions({
        transports: transports as unknown as Parameters<
          typeof closeAllSessions
        >[0]["transports"],
        sseTransports: sseTransports as unknown as Parameters<
          typeof closeAllSessions
        >[0]["sseTransports"],
      });

      expect(closedOk).toEqual(["good-1"]);
      expect(Object.keys(transports)).toEqual([]);
      expect(Object.keys(sseTransports)).toEqual([]);
      const sawStreamableBoom = consoleErrSpy.mock.calls.some((c) =>
        c.some(
          (arg) =>
            (typeof arg === "string" &&
              arg.includes("streamable-shutdown-boom")) ||
            (arg instanceof Error &&
              arg.message === "streamable-shutdown-boom"),
        ),
      );
      const sawSseBoom = consoleErrSpy.mock.calls.some((c) =>
        c.some(
          (arg) =>
            (typeof arg === "string" && arg.includes("sse-shutdown-boom")) ||
            (arg instanceof Error && arg.message === "sse-shutdown-boom"),
        ),
      );
      expect(sawStreamableBoom).toBe(true);
      expect(sawSseBoom).toBe(true);
    } finally {
      consoleErrSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// runStartupIndexAndBashRefresh (R3 #5): distinguishable log prefixes for
// index-check failure vs bash-refresh failure on startup.
// ---------------------------------------------------------------------------

describe("runStartupIndexAndBashRefresh (R3 #5)", () => {
  it("logs '[startup] Initial index check failed:' when checkAndIndex rejects", async () => {
    const { runStartupIndexAndBashRefresh } = await import("../server.js");

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runStartupIndexAndBashRefresh(
        {
          checkAndIndex: async () => {
            throw new Error("index-boom");
          },
        },
        [],
      );
      const lines = errSpy.mock.calls.map((c) => c.join(" "));
      const indexLine = lines.find((l) =>
        l.includes("[startup] Initial index check failed:"),
      );
      const refreshLine = lines.find((l) =>
        l.includes("[startup] Bash refresh after index check failed:"),
      );
      expect(indexLine).toBeDefined();
      expect(refreshLine).toBeUndefined();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("logs '[startup] Bash refresh after index check failed:' when refresh rejects (NOT the index prefix)", async () => {
    // Stub getServerConfig to return a bash tool so refreshBashInstances
    // reaches its rebuild path, then force rebuildBashInstance to throw.
    mockGetServerConfig.mockReturnValue({
      server: { name: "t", version: "0" },
      sources: [{ name: "src-a", type: "github", repo: "x/y" }],
      tools: [
        {
          name: "bash",
          type: "bash",
          sources: ["src-a"],
          bash: { virtual_files: false },
        },
      ],
    });
    const bashFs = await import("../mcp/tools/bash-fs.js");
    const rebuildSpy = vi
      .spyOn(bashFs, "rebuildBashInstance")
      .mockRejectedValueOnce(new Error("refresh-boom"));

    const { runStartupIndexAndBashRefresh } = await import("../server.js");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runStartupIndexAndBashRefresh(
        {
          checkAndIndex: async () => {
            /* resolves */
          },
        },
        [{ name: "src-a" }],
      );
      const lines = errSpy.mock.calls.map((c) => c.join(" "));
      const indexLine = lines.find((l) =>
        l.includes("[startup] Initial index check failed:"),
      );
      const refreshLine = lines.find((l) =>
        l.includes("[startup] Bash refresh after index check failed:"),
      );
      expect(refreshLine).toBeDefined();
      expect(indexLine).toBeUndefined();
    } finally {
      errSpy.mockRestore();
      rebuildSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// rollbackSessionAfterConnectFailure (Z-1): fires when server.connect /
// completeInitRequestSafely throws AFTER handleSessionInitAccept committed
// maps + ipLimiter counter + onclose wiring. Must (a) tear down the session
// exactly once and (b) not double-cleanup via the wired onclose handler.
// ---------------------------------------------------------------------------

describe("rollbackSessionAfterConnectFailure (Z-1)", () => {
  /**
   * Build a fake transport whose `close()` invokes `transport.onclose` to
   * model the MCP SDK behavior that stream teardown notifies the wired
   * listener. The fix detaches onclose before close() runs, so onclose
   * (assigned to the original handler) must NOT be invoked when the rollback
   * runs — or if it is, it must be a neutralized no-op.
   */
  function makeTransport(sid: string) {
    const transport: {
      sessionId: string;
      onclose?: () => void;
      close: () => Promise<void>;
      closeCalls: number;
    } = {
      sessionId: sid,
      closeCalls: 0,
      close: async () => {
        transport.closeCalls++;
        if (typeof transport.onclose === "function") transport.onclose();
      },
    };
    return transport;
  }

  it("runs the cleanup chain exactly once even though transport.close() triggers the wired onclose", async () => {
    const { rollbackSessionAfterConnectFailure, __rejectedSidsForTesting } =
      await import("../server.js");

    const sid = "sid-double-cleanup";
    const transport = makeTransport(sid);
    const transports: Record<string, unknown> = { [sid]: transport };
    const sessionLastActivity: Record<string, number> = { [sid]: Date.now() };

    const cleanupCalls = { state: 0, ipLimiter: 0, workspace: 0 };
    const ipLimiter = {
      remove: (_sid: string) => {
        cleanupCalls.ipLimiter++;
      },
    };
    const sessionStateManager = {
      cleanup: (_sid: string) => {
        cleanupCalls.state++;
      },
    };
    const workspaceManager = {
      cleanup: (_sid: string) => {
        cleanupCalls.workspace++;
      },
    };

    // Simulate the production onclose handler: it runs application cleanup
    // UNLESS rejectedSids contains the sid (the suppression branch). The
    // rollback helper seeds that marker before invoking close(), so a prod-
    // faithful onclose short-circuits while still performing any SDK-
    // internal teardown it wants. This test replaces that SDK teardown with
    // a trackable side-effect (priorOncloseFired) to assert the wrapper
    // still forwards the invocation.
    let priorOncloseFired = 0;
    transport.onclose = () => {
      priorOncloseFired++;
      if (__rejectedSidsForTesting?.().has(sid)) return;
      // Not rejected — fall through to "real" cleanup. Should NOT run here
      // because the rollback helper seeds rejectedSids before close().
      sessionStateManager.cleanup(sid);
      ipLimiter.remove(sid);
      workspaceManager.cleanup(sid);
    };

    rollbackSessionAfterConnectFailure({
      transport,
      sid,
      transports,
      sessionLastActivity,
      ipLimiter,
      sessionStateManager,
      workspaceManager,
    });

    // Allow microtask-scheduled close() to run.
    await new Promise((r) => setImmediate(r));

    // Cleanup ran exactly once (from the inline rollback chain; the prior
    // onclose short-circuited via the rejectedSids guard).
    expect(cleanupCalls.state).toBe(1);
    expect(cleanupCalls.ipLimiter).toBe(1);
    expect(cleanupCalls.workspace).toBe(1);
    // The prior onclose was STILL invoked by the wrapper, so any SDK-internal
    // bookkeeping it was doing still runs. This is the regression fix: the
    // previous `transport.onclose = () => {}` neutralizer swallowed the
    // invocation entirely, skipping SDK bookkeeping as well.
    expect(priorOncloseFired).toBe(1);
    expect(transport.closeCalls).toBe(1);
    expect(transports[sid]).toBeUndefined();
    expect(sessionLastActivity[sid]).toBeUndefined();
  });

  it("deletes transports[sid] and sessionLastActivity[sid] synchronously", async () => {
    const { rollbackSessionAfterConnectFailure } = await import("../server.js");

    const sid = "sid-del";
    const transport = makeTransport(sid);
    const transports: Record<string, unknown> = { [sid]: transport, other: {} };
    const sessionLastActivity: Record<string, number> = {
      [sid]: 1,
      other: 2,
    };

    rollbackSessionAfterConnectFailure({
      transport,
      sid,
      transports,
      sessionLastActivity,
    });

    expect(transports[sid]).toBeUndefined();
    expect(sessionLastActivity[sid]).toBeUndefined();
    expect(transports.other).toBeDefined();
    expect(sessionLastActivity.other).toBe(2);
  });

  it("invokes a pre-existing transport.onclose (preserves SDK-internal bookkeeping)", async () => {
    // Regression: earlier fix replaced transport.onclose with a bare `() => {}`
    // no-op, which silently clobbered any SDK-internal onclose wiring (the
    // MCP SDK StreamableHTTPServerTransport attaches onclose listeners for
    // its own bookkeeping). The wrapper must forward the invocation so SDK
    // state teardown still happens even while our cleanup branch skips.
    const { rollbackSessionAfterConnectFailure } = await import("../server.js");

    const sid = "sid-prior-onclose";
    const transport = makeTransport(sid);
    const transports: Record<string, unknown> = { [sid]: transport };
    const sessionLastActivity: Record<string, number> = { [sid]: Date.now() };

    // Simulate an SDK-attached onclose (e.g. request-queue drain) that does
    // NOT know about rejectedSids — it just wants to be told the transport
    // closed.
    let sdkOncloseFired = 0;
    transport.onclose = () => {
      sdkOncloseFired++;
    };

    rollbackSessionAfterConnectFailure({
      transport,
      sid,
      transports,
      sessionLastActivity,
    });
    await new Promise((r) => setImmediate(r));

    expect(sdkOncloseFired).toBe(1);
  });

  it("tolerates a null transport.onclose (no prior handler attached)", async () => {
    const { rollbackSessionAfterConnectFailure } = await import("../server.js");

    const sid = "sid-no-prior";
    const transport = makeTransport(sid);
    // Explicitly no onclose.
    transport.onclose = undefined as unknown as (() => void) | undefined;
    const transports: Record<string, unknown> = { [sid]: transport };
    const sessionLastActivity: Record<string, number> = { [sid]: Date.now() };

    // Must not throw.
    rollbackSessionAfterConnectFailure({
      transport,
      sid,
      transports,
      sessionLastActivity,
    });
    await new Promise((r) => setImmediate(r));
    expect(transport.closeCalls).toBe(1);
  });

  it("continues cleanup even if an earlier cleanup step throws", async () => {
    const { rollbackSessionAfterConnectFailure } = await import("../server.js");

    const sid = "sid-throwy";
    const transport = makeTransport(sid);
    const transports: Record<string, unknown> = { [sid]: transport };
    const sessionLastActivity: Record<string, number> = { [sid]: Date.now() };

    let ipLimiterCalled = false;
    let workspaceCalled = false;
    const ipLimiter = {
      remove: (_sid: string) => {
        ipLimiterCalled = true;
      },
    };
    const sessionStateManager = {
      cleanup: (_sid: string) => {
        throw new Error("state-boom");
      },
    };
    const workspaceManager = {
      cleanup: (_sid: string) => {
        workspaceCalled = true;
      },
    };

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      rollbackSessionAfterConnectFailure({
        transport,
        sid,
        transports,
        sessionLastActivity,
        ipLimiter,
        sessionStateManager,
        workspaceManager,
      });
      await new Promise((r) => setImmediate(r));
      expect(ipLimiterCalled).toBe(true);
      expect(workspaceCalled).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});
