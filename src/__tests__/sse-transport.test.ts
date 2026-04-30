import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

// Stable JWT secret for bearer middleware tests.
vi.mock("../config.js", () => ({
  getConfig: vi.fn().mockReturnValue({
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
  }),
  getServerConfig: vi.fn().mockReturnValue({
    server: { name: "pathfinder-test", version: "0.0.0" },
    sources: [],
    tools: [],
  }),
  getAnalyticsConfig: vi.fn(),
  hasSearchTools: vi.fn().mockReturnValue(false),
  hasKnowledgeTools: vi.fn().mockReturnValue(false),
  hasCollectTools: vi.fn().mockReturnValue(false),
  hasBashSemanticSearch: vi.fn().mockReturnValue(false),
}));

import { IpSessionLimiter } from "../ip-limiter.js";
import { createSseHandlers, type SseHandlerDeps } from "../sse-handlers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(overrides: Partial<SseHandlerDeps> = {}): {
  app: express.Express;
  deps: SseHandlerDeps;
} {
  const sseTransports: SseHandlerDeps["sseTransports"] = {};
  const sessionLastActivity: SseHandlerDeps["sessionLastActivity"] = {};
  const deps: SseHandlerDeps = {
    sseTransports,
    sessionLastActivity,
    ipLimiter: new IpSessionLimiter(20),
    createMcpServer: () => {
      // Minimal stub: a "server" with a connect() that registers transport handlers.
      return {
        connect: vi.fn(async (transport: unknown) => {
          // Mimic SDK behavior: invoke transport.start() if present.
          const t = transport as { start?: () => Promise<void> };
          if (t.start) await t.start();
        }),
      } as unknown as ReturnType<SseHandlerDeps["createMcpServer"]>;
    },
    workspaceManager: undefined,
    ...overrides,
  };

  const app = express();
  app.use(express.json());
  const { getHandler, postHandler } = createSseHandlers(deps);
  app.get("/sse", getHandler);
  app.post("/messages", postHandler);
  return { app, deps };
}

function startServer(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function baseUrlOf(server: Server): string {
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SSE transport routes", () => {
  let server: Server | undefined;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    await closeServer(server);
    server = undefined;
  });

  it("GET /sse returns 200 with text/event-stream Content-Type and writes an endpoint event", async () => {
    const { app } = buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);

    const res = await fetch(`${url}/sse`, {
      headers: { Accept: "text/event-stream" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    // Read a small portion of the stream to confirm the SDK emitted the
    // "event: endpoint" line, then close the connection.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (let i = 0; i < 5; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("event: endpoint")) break;
    }
    await reader.cancel();

    expect(buffer).toContain("event: endpoint");
    expect(buffer).toMatch(/data: \/messages\?sessionId=[0-9a-f-]+/);
  });

  it("GET /sse registers the session in sseTransports and sessionLastActivity", async () => {
    const { app, deps } = buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);

    const res = await fetch(`${url}/sse`, {
      headers: { Accept: "text/event-stream" },
    });

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // Wait until we see the endpoint event so session is registered.
    while (!buffer.includes("event: endpoint")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }

    const match = buffer.match(/sessionId=([0-9a-f-]+)/);
    expect(match).not.toBeNull();
    const sid = match![1];

    expect(deps.sseTransports[sid]).toBeDefined();
    expect(deps.sessionLastActivity[sid]).toBeGreaterThan(0);

    await reader.cancel();
  });

  it("GET /sse returns 401 with an invalid Bearer token (via bearerMiddleware)", async () => {
    const { app } = buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);

    const res = await fetch(`${url}/sse`, {
      headers: {
        Accept: "text/event-stream",
        Authorization: "Bearer this.is.not.a.jwt",
      },
    });

    expect(res.status).toBe(401);
  });

  it("GET /sse returns 200 with no Authorization header (opportunistic auth)", async () => {
    const { app } = buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);

    const res = await fetch(`${url}/sse`);
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });

  it("POST /messages with bogus sessionId returns 404", async () => {
    const { app } = buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);

    const res = await fetch(`${url}/messages?sessionId=${randomUUID()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });

    expect(res.status).toBe(404);
  });

  it("POST /messages without a sessionId query param returns 404", async () => {
    const { app } = buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);

    const res = await fetch(`${url}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });

    expect(res.status).toBe(404);
  });

  it("GET /sse then POST /messages forwards the message to the session transport", async () => {
    const { app, deps } = buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);

    const sseRes = await fetch(`${url}/sse`, {
      headers: { Accept: "text/event-stream" },
    });
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!buffer.includes("event: endpoint")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    const sid = buffer.match(/sessionId=([0-9a-f-]+)/)![1];

    // Spy on the transport's handlePostMessage.
    const transport = deps.sseTransports[sid];
    expect(transport).toBeDefined();
    const spy = vi
      .spyOn(transport, "handlePostMessage")
      .mockImplementation(async (_req, res) => {
        res.writeHead(202).end();
      });

    const activityBefore = deps.sessionLastActivity[sid];
    // Ensure clock tick so activity timestamp advances.
    await new Promise((r) => setTimeout(r, 5));

    const postRes = await fetch(`${url}/messages?sessionId=${sid}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });

    expect(postRes.status).toBe(202);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(deps.sessionLastActivity[sid]).toBeGreaterThanOrEqual(
      activityBefore,
    );

    await reader.cancel();
  });

  it("GET /sse enforces IP rate limit via ipLimiter", async () => {
    // IpSessionLimiter capped at 1; second concurrent GET from same IP should 429.
    const limiter = new IpSessionLimiter(1);
    const { app } = buildApp({ ipLimiter: limiter });
    server = await startServer(app);
    const url = baseUrlOf(server);

    const first = await fetch(`${url}/sse`);
    expect(first.status).toBe(200);
    // Do not close first — keep the session active so the counter stays at 1.

    const second = await fetch(`${url}/sse`);
    expect(second.status).toBe(429);

    await first.body?.cancel();
    await second.body?.cancel();
  });

  it("GET /sse 429 rejection returns a descriptive JSON body + Retry-After header", async () => {
    const limiter = new IpSessionLimiter(1);
    const { app } = buildApp({ ipLimiter: limiter });
    server = await startServer(app);
    const url = baseUrlOf(server);

    const first = await fetch(`${url}/sse`);
    expect(first.status).toBe(200);

    const second = await fetch(`${url}/sse`);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBeTruthy();
    const body = (await second.json()) as Record<string, unknown>;
    expect(body.error).toBe("rate_limited");
    expect(typeof body.reason).toBe("string");
    expect(body.limit).toBe(1);
    expect(typeof body.currentCount).toBe("number");
    expect((body.currentCount as number) >= 1).toBe(true);
    expect(typeof body.retryAfterSeconds).toBe("number");
    expect(body.contact).toBe("oss@copilotkit.ai");

    await first.body?.cancel();
  });

  it("GET /sse bypasses the limit for allowlisted IPs (loopback 127.0.0.1)", async () => {
    // The test client connects from 127.0.0.1, so allowlist that and cap at 1.
    const limiter = new IpSessionLimiter(1, {
      allowlist: ["127.0.0.0/8"],
    });
    const { app } = buildApp({ ipLimiter: limiter });
    server = await startServer(app);
    const url = baseUrlOf(server);

    // Open more sessions than the cap; all should succeed because allowlisted.
    const first = await fetch(`${url}/sse`);
    expect(first.status).toBe(200);
    const second = await fetch(`${url}/sse`);
    expect(second.status).toBe(200);
    const third = await fetch(`${url}/sse`);
    expect(third.status).toBe(200);

    await first.body?.cancel();
    await second.body?.cancel();
    await third.body?.cancel();
  });

  it("GET /sse with trust_proxy=false ignores X-Forwarded-For (limiter sees socket IP, not spoofed header)", async () => {
    // Cap at 1 and allowlist ONLY the spoofed IP an attacker might send via
    // XFF. With trust_proxy=false the limiter must key off the socket peer
    // (127.0.0.1) and treat the allowlist check against the socket as well
    // — so sending XFF: 203.0.113.7 can't pretend to be the allowlisted IP.
    const limiter = new IpSessionLimiter(1, {
      allowlist: ["203.0.113.7"],
    });
    const { app } = buildApp({ ipLimiter: limiter, trustProxy: false });
    server = await startServer(app);
    const url = baseUrlOf(server);

    // First request: succeeds (capacity available).
    const first = await fetch(`${url}/sse`, {
      headers: { "X-Forwarded-For": "203.0.113.7" },
    });
    expect(first.status).toBe(200);

    // Second request — same socket IP (127.0.0.1) — must be rate-limited.
    // If clientIp wrongly honored XFF, it would see "203.0.113.7",
    // find it allowlisted, and return 200 — which is the vulnerability.
    const second = await fetch(`${url}/sse`, {
      headers: { "X-Forwarded-For": "203.0.113.7" },
    });
    expect(second.status).toBe(429);

    await first.body?.cancel();
    await second.body?.cancel();
  });

  it("GET /sse with trust_proxy=false — spoofed X-Forwarded-For does not bypass allowlist", async () => {
    // Allowlist 203.0.113.7 and cap at 1. Attacker sends XFF=203.0.113.7
    // from the test client. If the handler honored XFF, it would see the
    // allowlisted IP and skip the counter entirely — then a SECOND request
    // with the same spoof should also succeed (allowlisted bypass). With
    // trust_proxy=false, the handler must see the socket (loopback, NOT
    // on the allowlist) and rate-limit the second request with 429.
    const limiter = new IpSessionLimiter(1, {
      allowlist: ["203.0.113.7"],
    });
    const { app } = buildApp({
      ipLimiter: limiter,
      trustProxy: false,
    });
    server = await startServer(app);
    const url = baseUrlOf(server);

    const first = await fetch(`${url}/sse`, {
      headers: { "X-Forwarded-For": "203.0.113.7" },
    });
    expect(first.status).toBe(200);

    // Second spoofed request — MUST be rejected. If we honored XFF, this
    // would return 200 (allowlist bypass), which is the vulnerability.
    const second = await fetch(`${url}/sse`, {
      headers: { "X-Forwarded-For": "203.0.113.7" },
    });
    expect(second.status).toBe(429);

    // The spoofed IP must NOT have been tracked in the limiter's counters
    // (allowlisted IPs are never tracked; non-allowlisted IPs keyed by XFF
    // would show up here if clientIp was broken).
    expect(limiter.getSessionCount("203.0.113.7")).toBe(0);

    await first.body?.cancel();
    await second.body?.cancel();
  });

  it("closing the SSE stream removes the session from sseTransports", async () => {
    const { app, deps } = buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);

    const res = await fetch(`${url}/sse`, {
      headers: { Accept: "text/event-stream" },
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!buffer.includes("event: endpoint")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    const sid = buffer.match(/sessionId=([0-9a-f-]+)/)![1];
    expect(deps.sseTransports[sid]).toBeDefined();

    // Cancel the reader to close the client side of the stream.
    await reader.cancel();

    // Wait briefly for server-side 'close' event to propagate.
    await new Promise((r) => setTimeout(r, 50));
    expect(deps.sseTransports[sid]).toBeUndefined();
  });

  it("emits pathfinder.session.created on a successful SSE connect", async () => {
    const emitMock = vi.fn();
    const { app } = buildApp({
      p2pTelemetry: {
        isEnabled: () => true,
        emit: emitMock,
      } as unknown as SseHandlerDeps["p2pTelemetry"],
    });
    server = await startServer(app);
    const url = baseUrlOf(server);

    const res = await fetch(`${url}/sse`, {
      headers: { Accept: "text/event-stream", "User-Agent": "TestClient/1.0" },
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!buffer.includes("event: endpoint")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    const sid = buffer.match(/sessionId=([0-9a-f-]+)/)![1];

    expect(emitMock).toHaveBeenCalledTimes(1);
    const [eventName, props] = emitMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(eventName).toBe("pathfinder.session.created");
    expect(props.transport).toBe("sse");
    expect(props.session_id_prefix).toBe(sid.slice(0, 8));
    expect(props.user_agent).toBe("TestClient/1.0");
    expect(props.authenticated).toBe(false);
    expect(typeof props.client_ip).toBe("string");

    await reader.cancel();
  });

  it("does not emit pathfinder.session.created when telemetry is disabled", async () => {
    const emitMock = vi.fn();
    const { app } = buildApp({
      p2pTelemetry: {
        isEnabled: () => false,
        emit: emitMock,
      } as unknown as SseHandlerDeps["p2pTelemetry"],
    });
    server = await startServer(app);
    const url = baseUrlOf(server);

    const res = await fetch(`${url}/sse`, {
      headers: { Accept: "text/event-stream" },
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!buffer.includes("event: endpoint")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    expect(emitMock).not.toHaveBeenCalled();
    await reader.cancel();
  });

  it("does not emit pathfinder.session.created when the IP rate limit rejects", async () => {
    const emitMock = vi.fn();
    // Limiter with cap 1 — first connect succeeds (and emits), second is
    // rejected (must not emit).
    const limiter = new IpSessionLimiter(1);
    const { app } = buildApp({
      ipLimiter: limiter,
      p2pTelemetry: {
        isEnabled: () => true,
        emit: emitMock,
      } as unknown as SseHandlerDeps["p2pTelemetry"],
    });
    server = await startServer(app);
    const url = baseUrlOf(server);

    const res1 = await fetch(`${url}/sse`, {
      headers: { Accept: "text/event-stream" },
    });
    const reader1 = res1.body!.getReader();
    const decoder = new TextDecoder();
    let buffer1 = "";
    while (!buffer1.includes("event: endpoint")) {
      const { value, done } = await reader1.read();
      if (done) break;
      buffer1 += decoder.decode(value, { stream: true });
    }

    const res2 = await fetch(`${url}/sse`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(res2.status).toBe(429);
    await res2.body?.cancel();

    // Exactly one emit — for the accepted session, not the rejected one.
    expect(emitMock).toHaveBeenCalledTimes(1);

    await reader1.cancel();
  });
});

describe("reapIdleSseSessions", () => {
  it("removes SSE sessions whose last activity exceeds TTL", async () => {
    const { reapIdleSseSessions } = await import("../sse-handlers.js");

    const sseTransports: Record<string, { close: () => Promise<void> }> = {};
    const sessionLastActivity: Record<string, number> = {};

    const closed: string[] = [];
    const now = Date.now();
    // Fresh session (recent activity) — should not be reaped
    sseTransports["fresh"] = {
      close: async () => {
        closed.push("fresh");
      },
    };
    sessionLastActivity["fresh"] = now - 1000;
    // Stale session — should be reaped
    sseTransports["stale"] = {
      close: async () => {
        closed.push("stale");
      },
    };
    sessionLastActivity["stale"] = now - 10 * 60 * 1000;

    const reaped = reapIdleSseSessions({
      sseTransports: sseTransports as unknown as Parameters<
        typeof reapIdleSseSessions
      >[0]["sseTransports"],
      sessionLastActivity,
      ttlMs: 5 * 60 * 1000,
      now,
    });

    expect(reaped).toEqual(["stale"]);
    expect(sseTransports["stale"]).toBeUndefined();
    expect(sseTransports["fresh"]).toBeDefined();
  });

  it("logs async transport.close() rejections instead of leaving them unhandled", async () => {
    const { reapIdleSseSessions } = await import("../sse-handlers.js");

    const consoleErrSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    // Capture any unhandled rejections during the test so we can fail if
    // the reaper leaks one.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      const sseTransports: Record<string, { close: () => Promise<void> }> = {};
      const sessionLastActivity: Record<string, number> = {};
      const now = Date.now();

      sseTransports["stale-async-reject"] = {
        // Returns a rejected promise — only caught if the reaper attaches .catch
        close: () => Promise.reject(new Error("boom-async")),
      };
      sessionLastActivity["stale-async-reject"] = now - 10 * 60 * 1000;

      reapIdleSseSessions({
        sseTransports: sseTransports as unknown as Parameters<
          typeof reapIdleSseSessions
        >[0]["sseTransports"],
        sessionLastActivity,
        ttlMs: 5 * 60 * 1000,
        now,
      });

      // Allow microtasks to flush so the rejection lands.
      await new Promise((r) => setTimeout(r, 10));

      const loggedBoom = consoleErrSpy.mock.calls.some((call) =>
        call.some(
          (arg) =>
            (typeof arg === "string" && arg.includes("boom-async")) ||
            (arg instanceof Error && arg.message === "boom-async"),
        ),
      );
      expect(loggedBoom).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      consoleErrSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Round 2 — hardening tests for pre-check ordering, error-path cleanup, and
// per-step cleanup resilience. These mirror the /mcp path's patterns.
// ---------------------------------------------------------------------------

describe("SSE transport hardening (Round 2)", () => {
  let server: Server | undefined;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    await closeServer(server);
    server = undefined;
  });

  it("429 pre-check does NOT call ipLimiter.tryAdd (transport not constructed on rejection)", async () => {
    // Use cap=1 and a priming request (not a preload) so we exercise the
    // actual socket IP the handler sees — dual-stack listeners often report
    // 127.0.0.1 as ::ffff:127.0.0.1, which would mismatch a hardcoded
    // "127.0.0.1" preload.
    const limiter = new IpSessionLimiter(1);
    const { app, deps } = buildApp({ ipLimiter: limiter });

    server = await startServer(app);
    const url = baseUrlOf(server);

    // Prime the counter by making a real request that succeeds.
    const first = await fetch(`${url}/sse`);
    expect(first.status).toBe(200);

    // NOW spy on tryAdd — the second request (at cap) should 429 via the
    // pre-check without ever calling tryAdd.
    const tryAddSpy = vi.spyOn(limiter, "tryAdd");

    const res = await fetch(`${url}/sse`);
    expect(res.status).toBe(429);

    // tryAdd must not have been called on the rejected path. If the handler
    // constructs a transport first and THEN calls tryAdd, we'd see a call.
    expect(tryAddSpy).not.toHaveBeenCalled();

    // The transport map should still hold only the primed session, not a
    // stray entry from a constructed-but-never-connected transport.
    expect(Object.keys(deps.sseTransports).length).toBe(1);

    await first.body?.cancel();
    await res.body?.cancel();
  });

  it("429 log message mirrors /mcp format: includes (currentCount/limit)", async () => {
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});

    // Cap at 1 — prime the limiter with a real request (avoids hardcoding
    // the loopback IP form the server sees, which varies by dual-stack).
    const limiter = new IpSessionLimiter(1);
    const { app } = buildApp({ ipLimiter: limiter });

    server = await startServer(app);
    const url = baseUrlOf(server);

    const first = await fetch(`${url}/sse`);
    expect(first.status).toBe(200);

    const res = await fetch(`${url}/sse`);
    expect(res.status).toBe(429);
    await first.body?.cancel();
    await res.body?.cancel();

    const warnCalls = consoleWarnSpy.mock.calls.map((c) => c[0]);
    const rateLog = warnCalls.find(
      (m) =>
        typeof m === "string" &&
        m.includes("IP rate limit exceeded") &&
        m.includes("rejecting SSE"),
    );
    expect(rateLog).toBeDefined();
    // /mcp format: `... for ${ip} (${currentCount}/${limit}), rejecting ...`
    expect(rateLog as string).toMatch(/\(\d+\/\d+\)/);

    consoleWarnSpy.mockRestore();
  });

  it("does not call ensureSession eagerly (lazy workspace allocation)", async () => {
    // After session hardening, ensureSession is no longer called eagerly
    // during session creation. Workspace allocation is lazy — the bash tool
    // handlers call workspace.ensureSession(sid) per-operation.
    const limiter = new IpSessionLimiter(2);
    const ensureSessionSpy = vi.fn();
    const workspaceManager = {
      ensureSession: ensureSessionSpy,
      cleanup: vi.fn(),
      cleanupAll: vi.fn(),
    };
    const { app } = buildApp({
      ipLimiter: limiter,
      workspaceManager,
    });

    server = await startServer(app);
    const url = baseUrlOf(server);

    const res = await fetch(`${url}/sse`).catch((err) => ({
      ok: false,
      status: 0,
      err,
    }));
    if ("body" in res && res.body) {
      await (res.body as ReadableStream).cancel().catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 20));

    // ensureSession should NOT have been called
    expect(ensureSessionSpy).not.toHaveBeenCalled();
  });

  it("reaper invokes ipLimiter.remove and workspaceManager.cleanup for reaped SSE sessions (ownership fix)", async () => {
    // R2 finding 1: the reaper schedules transport.close() via microtask, then
    // synchronously deletes sseTransports[sid] BEFORE close runs. When onclose
    // eventually fires, the handler's cleanup() guard (`if sseTransports[sid]`)
    // sees the entry already gone and bails — skipping ipLimiter.remove and
    // workspaceManager.cleanup permanently. The reaper must own cleanup for
    // the server-timeout path.
    const { reapIdleSseSessions } = await import("../sse-handlers.js");

    const limiter = new IpSessionLimiter(5);
    // Manually insert a counter entry so we can observe reaper-driven cleanup.
    limiter.tryAdd("203.0.113.1", "stale-sid");
    expect(limiter.getSessionCount("203.0.113.1")).toBe(1);

    const workspaceCleanup = vi.fn();
    const workspaceManager = {
      ensureSession: vi.fn(),
      cleanup: workspaceCleanup,
      cleanupAll: vi.fn(),
    };

    const sseTransports: Record<string, { close: () => Promise<void> }> = {};
    const sessionLastActivity: Record<string, number> = {};

    // transport.close resolves asynchronously so the race is observable.
    sseTransports["stale-sid"] = {
      close: () => new Promise((resolve) => setTimeout(resolve, 5)),
    };
    sessionLastActivity["stale-sid"] = Date.now() - 10 * 60 * 1000;

    const reaped = reapIdleSseSessions({
      sseTransports: sseTransports as unknown as Parameters<
        typeof reapIdleSseSessions
      >[0]["sseTransports"],
      sessionLastActivity,
      ttlMs: 5 * 60 * 1000,
      ipLimiter: limiter,
      workspaceManager: workspaceManager as unknown as Parameters<
        typeof reapIdleSseSessions
      >[0]["workspaceManager"],
    });

    expect(reaped).toEqual(["stale-sid"]);
    // The reaper must inline-clean counters + workspace BEFORE returning, even
    // though transport.close() is async. Otherwise the cleanup leaks.
    expect(limiter.getSessionCount("203.0.113.1")).toBe(0);
    expect(workspaceCleanup).toHaveBeenCalledWith("stale-sid");

    // Let the async close resolve to avoid open-handle warnings.
    await new Promise((r) => setTimeout(r, 20));
  });

  it("cleanup closure re-resolves workspaceManager getter lazily (late-binding fix)", async () => {
    // R2 finding 2: sseGet resolves the getters ONCE at the top of the handler
    // and the cleanup closure captures those locals. If the workspaceManager
    // instance gets swapped out between request-entry and session-close
    // (config reload, late startServer() binding, etc.), cleanup should use
    // the CURRENT instance — otherwise it routes cleanup to a stale manager
    // whose session map has nothing to clean, leaking real workspace state.
    const limiter = new IpSessionLimiter(5);

    const staleCleanup = vi.fn();
    const freshCleanup = vi.fn();
    let current:
      | {
          ensureSession: () => void;
          cleanup: (sid: string) => void;
          cleanupAll: () => void;
        }
      | undefined = {
      ensureSession: () => {},
      cleanup: staleCleanup,
      cleanupAll: () => {},
    };

    const { app, deps } = buildApp({
      ipLimiter: limiter,
      // Getter returns the CURRENT workspace instance. The handler's top-of-
      // function resolve snapshots the initial one; cleanup's re-resolve
      // must see whatever `current` points at when close fires. The dep
      // type admits a getter form directly, so no cast needed.
      workspaceManager: () => current,
    });

    server = await startServer(app);
    const url = baseUrlOf(server);

    const res = await fetch(`${url}/sse`, {
      headers: { Accept: "text/event-stream" },
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!buffer.includes("event: endpoint")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    const sid = buffer.match(/sessionId=([0-9a-f-]+)/)![1];
    expect(deps.sseTransports[sid]).toBeDefined();

    // Swap the "current" workspace manager AFTER handler entry but BEFORE
    // close. A stale capture would still call staleCleanup; a lazy re-resolve
    // routes to freshCleanup.
    current = {
      ensureSession: () => {},
      cleanup: freshCleanup,
      cleanupAll: () => {},
    };

    await reader.cancel();
    await new Promise((r) => setTimeout(r, 60));

    expect(freshCleanup).toHaveBeenCalledWith(sid);
    expect(staleCleanup).not.toHaveBeenCalled();
  });

  it("POST /messages returns a descriptive reason + log for missing sessionId", async () => {
    // R2 finding 3: /messages 404 branches previously returned no reason code
    // and emitted no log. Operators debugging reaper/client races couldn't
    // tell "client never sent a sessionId" from "session was reaped".
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const { app } = buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);

    const res = await fetch(`${url}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reason).toBe("missing-session-id");

    const logged = consoleWarnSpy.mock.calls.some((call) =>
      call.some(
        (arg) =>
          typeof arg === "string" &&
          arg.includes("missing-session-id") &&
          arg.includes("/messages"),
      ),
    );
    expect(logged).toBe(true);
    consoleWarnSpy.mockRestore();
  });

  it("POST /messages returns a descriptive reason + log for unknown sessionId", async () => {
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const { app } = buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);

    const bogus = randomUUID();
    const res = await fetch(`${url}/messages?sessionId=${bogus}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reason).toBe("unknown-session-id");

    const logged = consoleWarnSpy.mock.calls.some((call) =>
      call.some(
        (arg) =>
          typeof arg === "string" &&
          arg.includes("unknown-session-id") &&
          arg.includes(bogus.slice(0, 8)),
      ),
    );
    expect(logged).toBe(true);
    consoleWarnSpy.mockRestore();
  });

  it("429 Retry-After header is clamped to the same ceiling as the JSON body", async () => {
    // R2 finding 4: oversized retryAfterSeconds (e.g. SESSION_TTL of 30
    // minutes) must be clamped to the shared ceiling (300s) BEFORE being
    // written to the header. The JSON body clamps via buildRateLimitPayload;
    // the header was previously unclamped, so clients saw conflicting
    // hints (header: 1800, body: 300).
    const limiter = new IpSessionLimiter(1);
    const { app } = buildApp({
      ipLimiter: limiter,
      rateLimitRetryAfterSeconds: 1800,
    });
    server = await startServer(app);
    const url = baseUrlOf(server);

    const first = await fetch(`${url}/sse`);
    expect(first.status).toBe(200);

    const second = await fetch(`${url}/sse`);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("300");
    const body = (await second.json()) as Record<string, unknown>;
    expect(body.retryAfterSeconds).toBe(300);

    await first.body?.cancel();
  });

  it("cleanup is per-step resilient: a failing ipLimiter.remove still lets workspace.cleanup run", async () => {
    const consoleErrSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const limiter = new IpSessionLimiter(5);
    const workspaceCleanup = vi.fn();
    const workspaceManager = {
      ensureSession: vi.fn(),
      cleanup: workspaceCleanup,
      cleanupAll: vi.fn(),
    };

    // Wrap limiter.remove so it throws once. Per-step try/catch in cleanup
    // must prevent this throw from skipping workspaceManager.cleanup.
    const origRemove = limiter.remove.bind(limiter);
    vi.spyOn(limiter, "remove").mockImplementation((sid: string) => {
      origRemove(sid);
      throw new Error("limiter-remove-boom");
    });

    const { app, deps } = buildApp({
      ipLimiter: limiter,
      workspaceManager,
    });

    server = await startServer(app);
    const url = baseUrlOf(server);

    const res = await fetch(`${url}/sse`, {
      headers: { Accept: "text/event-stream" },
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!buffer.includes("event: endpoint")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    const sid = buffer.match(/sessionId=([0-9a-f-]+)/)![1];
    expect(deps.sseTransports[sid]).toBeDefined();

    await reader.cancel();

    // Wait for server-side close → cleanup.
    await new Promise((r) => setTimeout(r, 60));

    // The throw inside limiter.remove must not have skipped workspace.cleanup.
    expect(workspaceCleanup).toHaveBeenCalledWith(sid);
    consoleErrSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Round 3 — sessionStateManager plumbing, pre-register-before-onclose
// ordering, and disconnect-before-setup recovery.
// ---------------------------------------------------------------------------

describe("SSE transport hardening (Round 3)", () => {
  let server: Server | undefined;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    await closeServer(server);
    server = undefined;
  });

  it("SSE cleanup closure invokes sessionStateManager.cleanup when the client disconnects", async () => {
    // R3 finding 2: /mcp cleans up sessionStateManager on transport.onclose
    // but the SSE handler did not. SSE sessions using bash tools with
    // `session_state: true` leaked per-session shell state indefinitely
    // until server restart. The handler's client-disconnect cleanup closure
    // must call sessionStateManager.cleanup(sid).
    const sessionStateCleanup = vi.fn();
    const { app, deps } = buildApp({
      sessionStateManager: { cleanup: sessionStateCleanup },
    });
    server = await startServer(app);
    const url = baseUrlOf(server);

    const res = await fetch(`${url}/sse`, {
      headers: { Accept: "text/event-stream" },
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!buffer.includes("event: endpoint")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    const sid = buffer.match(/sessionId=([0-9a-f-]+)/)![1];
    expect(deps.sseTransports[sid]).toBeDefined();

    // Close the client side to trigger the handler's cleanup closure.
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 60));

    expect(sessionStateCleanup).toHaveBeenCalledWith(sid);
  });

  it("SSE cleanup closure re-resolves sessionStateManager lazily (late-binding fix)", async () => {
    // Same late-binding concern as workspaceManager: cleanup must re-resolve
    // the sessionStateManager getter when close fires, not snapshot it at
    // handler entry. server.ts late-binds the sessionStateManager instance
    // the same way it does workspaceManager.
    const staleCleanup = vi.fn();
    const freshCleanup = vi.fn();
    let current: { cleanup: (sid: string) => void } | undefined = {
      cleanup: staleCleanup,
    };
    const { app, deps } = buildApp({
      sessionStateManager: () => current,
    });
    server = await startServer(app);
    const url = baseUrlOf(server);

    const res = await fetch(`${url}/sse`, {
      headers: { Accept: "text/event-stream" },
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!buffer.includes("event: endpoint")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    const sid = buffer.match(/sessionId=([0-9a-f-]+)/)![1];
    expect(deps.sseTransports[sid]).toBeDefined();

    // Swap the "current" manager AFTER handler entry, BEFORE close.
    current = { cleanup: freshCleanup };

    await reader.cancel();
    await new Promise((r) => setTimeout(r, 60));

    expect(freshCleanup).toHaveBeenCalledWith(sid);
    expect(staleCleanup).not.toHaveBeenCalled();
  });

  it("sessionStateManager.cleanup throw does not skip ipLimiter.remove or workspaceManager.cleanup", async () => {
    // Per-step try/catch: a failing sessionStateManager.cleanup must not
    // short-circuit the rest of the cleanup chain, mirroring the /mcp
    // handler's behavior and the existing Round 2 assertion for
    // ipLimiter.remove throwing.
    const consoleErrSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const limiter = new IpSessionLimiter(5);
    const workspaceCleanup = vi.fn();
    const workspaceManager = {
      ensureSession: vi.fn(),
      cleanup: workspaceCleanup,
      cleanupAll: vi.fn(),
    };
    const sessionStateManager = {
      cleanup: vi.fn(() => {
        throw new Error("session-state-boom");
      }),
    };
    const { app, deps } = buildApp({
      ipLimiter: limiter,
      workspaceManager,
      sessionStateManager,
    });
    server = await startServer(app);
    const url = baseUrlOf(server);

    const res = await fetch(`${url}/sse`, {
      headers: { Accept: "text/event-stream" },
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!buffer.includes("event: endpoint")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    const sid = buffer.match(/sessionId=([0-9a-f-]+)/)![1];
    expect(deps.sseTransports[sid]).toBeDefined();

    await reader.cancel();
    await new Promise((r) => setTimeout(r, 60));

    expect(sessionStateManager.cleanup).toHaveBeenCalledWith(sid);
    // limiter.remove would already have run before sessionState.cleanup in
    // the chain, but workspaceManager.cleanup runs AFTER session state in
    // our ordering — so asserting workspaceManager is the important check.
    // Actually in current ordering sessionState is last; both earlier steps
    // must still have run. Check both.
    expect(workspaceCleanup).toHaveBeenCalledWith(sid);
    expect(limiter.getSessionCount("127.0.0.1")).toBe(0);
    expect(limiter.getSessionCount("::ffff:127.0.0.1")).toBe(0);

    consoleErrSpy.mockRestore();
  });

  it("reaper invokes sessionStateManager.cleanup for reaped SSE sessions", async () => {
    // R3 finding 2: the reaper must own sessionState cleanup for the
    // server-timeout path, same as it owns ipLimiter.remove and
    // workspaceManager.cleanup. Without this, any SSE session that's idle-
    // reaped while holding bash shell state leaks that state forever.
    const { reapIdleSseSessions } = await import("../sse-handlers.js");

    const sessionStateCleanup = vi.fn();
    const sseTransports: Record<string, { close: () => Promise<void> }> = {};
    const sessionLastActivity: Record<string, number> = {};

    sseTransports["stale-sid"] = {
      close: async () => {},
    };
    sessionLastActivity["stale-sid"] = Date.now() - 10 * 60 * 1000;

    const reaped = reapIdleSseSessions({
      sseTransports: sseTransports as unknown as Parameters<
        typeof reapIdleSseSessions
      >[0]["sseTransports"],
      sessionLastActivity,
      ttlMs: 5 * 60 * 1000,
      sessionStateManager: { cleanup: sessionStateCleanup },
    });

    expect(reaped).toEqual(["stale-sid"]);
    expect(sessionStateCleanup).toHaveBeenCalledWith("stale-sid");

    // Let the scheduled close microtask resolve.
    await new Promise((r) => setTimeout(r, 10));
  });

  it("reaper continues cleanup chain when sessionStateManager.cleanup throws", async () => {
    const { reapIdleSseSessions } = await import("../sse-handlers.js");
    const consoleErrSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const limiterRemove = vi.fn();
    const workspaceCleanup = vi.fn();
    const sessionStateCleanup = vi.fn(() => {
      throw new Error("session-state-boom");
    });

    const sseTransports: Record<string, { close: () => Promise<void> }> = {};
    const sessionLastActivity: Record<string, number> = {};

    sseTransports["stale-sid"] = {
      close: async () => {},
    };
    sessionLastActivity["stale-sid"] = Date.now() - 10 * 60 * 1000;

    reapIdleSseSessions({
      sseTransports: sseTransports as unknown as Parameters<
        typeof reapIdleSseSessions
      >[0]["sseTransports"],
      sessionLastActivity,
      ttlMs: 5 * 60 * 1000,
      ipLimiter: { remove: limiterRemove },
      workspaceManager: { cleanup: workspaceCleanup },
      sessionStateManager: { cleanup: sessionStateCleanup },
    });

    // All three must have been attempted despite the throw in one of them.
    expect(limiterRemove).toHaveBeenCalledWith("stale-sid");
    expect(workspaceCleanup).toHaveBeenCalledWith("stale-sid");
    expect(sessionStateCleanup).toHaveBeenCalledWith("stale-sid");

    await new Promise((r) => setTimeout(r, 10));
    consoleErrSpy.mockRestore();
  });

  it("aborts early when res is already destroyed before tryAdd runs (no counter/workspace leak)", async () => {
    // R3 finding 1: if the client disconnects in the narrow window between
    // `new SSEServerTransport(...)` and `res.on("close", cleanup)`, the
    // res 'close' event has already passed — a listener registered AFTER
    // the event will never fire. Without an active post-wiring check, the
    // handler would proceed to ipLimiter.tryAdd + workspaceManager.ensureSession
    // against a dead response and leak both counters permanently.
    //
    // Drive the handler directly with a pre-destroyed mock response. Avoids
    // racing the real socket close event and makes the leak window
    // deterministic.
    const limiter = new IpSessionLimiter(5);
    const ensureSession = vi.fn();
    const workspaceCleanup = vi.fn();
    const tryAddSpy = vi.spyOn(limiter, "tryAdd");

    const { getHandler } = createSseHandlers({
      sseTransports: {},
      sessionLastActivity: {},
      ipLimiter: limiter,
      workspaceManager: { ensureSession, cleanup: workspaceCleanup },
      createMcpServer: () =>
        ({
          connect: vi.fn(async () => {}),
        }) as unknown as ReturnType<SseHandlerDeps["createMcpServer"]>,
    });
    // The handler array is [bearerMiddleware, sseGet]; we want to invoke
    // sseGet directly (bypass auth) since the mock req isn't fully formed.
    const sseGet = getHandler[1] as (
      req: unknown,
      res: unknown,
      next: unknown,
    ) => Promise<void>;

    // Minimal Request stub — enough for clientIp + transport constructor.
    const req = {
      ip: "127.0.0.1",
      socket: { remoteAddress: "127.0.0.1" },
      connection: { remoteAddress: "127.0.0.1" },
      headers: {},
      query: {},
      on: vi.fn(),
      once: vi.fn(),
    };

    // Response stub that reports destroyed=true post-construction. The
    // SSEServerTransport constructor inspects `res` but doesn't fail fast
    // on a destroyed socket; it's the handler's job to observe the state.
    // Also capture writes/statuses to prove no 200/500 payload lands.
    const closeListeners: Array<() => void> = [];
    const res = {
      destroyed: true,
      writableEnded: false,
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
      writeHead: vi.fn().mockReturnThis(),
      write: vi.fn(),
      end: vi.fn(),
      on: (event: string, cb: () => void) => {
        if (event === "close") closeListeners.push(cb);
        return res;
      },
      once: vi.fn(),
      emit: vi.fn(),
    };

    await sseGet(req, res, undefined);

    // The early-abort path must skip tryAdd and ensureSession entirely.
    expect(tryAddSpy).not.toHaveBeenCalled();
    expect(ensureSession).not.toHaveBeenCalled();
    // The counter must be zero — no leak from a session we never owned.
    expect(limiter.getSessionCount("127.0.0.1")).toBe(0);
    expect(limiter.getSessionCount("::ffff:127.0.0.1")).toBe(0);
  });

  it("registers sessionId in sseTransports BEFORE wiring res.on('close') — disconnect mid-setup still tears down", async () => {
    // R3 finding 1 (continued): the ordering fix. Even without an explicit
    // post-wiring destroyed check, the handler should pre-register into
    // sseTransports so the cleanup closure's guard passes when onclose
    // eventually fires. If someone reverted the ordering and put
    // `res.on("close", cleanup)` BEFORE `sseTransports[sid] = transport`,
    // a synchronous close firing between the two would no-op cleanup and
    // leak a counter entry.
    //
    // Assert the invariant via the live handler: after a successful session
    // the sessionId is present in the map at the moment onclose fires.
    // We observe this by wrapping cleanup indirectly — assert that after
    // the stream opens, the map entry exists.
    const { app, deps } = buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);

    const res = await fetch(`${url}/sse`, {
      headers: { Accept: "text/event-stream" },
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!buffer.includes("event: endpoint")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    const sid = buffer.match(/sessionId=([0-9a-f-]+)/)![1];

    // Invariant: the session is registered in the map by the time the
    // endpoint event is emitted (which happens inside server.connect()
    // AFTER the ordering-sensitive pre-registration window).
    expect(deps.sseTransports[sid]).toBeDefined();

    await reader.cancel();
    await new Promise((r) => setTimeout(r, 60));

    // And it's torn down after close — proving the onclose guard saw the
    // entry and ran.
    expect(deps.sseTransports[sid]).toBeUndefined();
  });
});

describe("SSE transport hardening (Round 4)", () => {
  let server: Server | undefined;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    await closeServer(server);
    server = undefined;
  });

  it("/sse race-fallback calls transport.close() on the rejected transport", async () => {
    // R4 finding 1: /sse race-fallback wrote a 429 body and deleted map
    // entries but never called transport.close(). The SDK's
    // SSEServerTransport may hold timers, listeners, and file handles — all
    // leaked per rejected race. Mirror /mcp race-fallback: schedule
    // transport.close() on a microtask and log any async rejection.
    //
    // To exercise the race path deterministically, inject a limiter whose
    // pre-check passes (under cap) but whose tryAdd() returns false — this
    // is the race window between pre-check and atomic tryAdd.
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const consoleErrSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const raceLimiter = {
      isAllowlisted: vi.fn().mockReturnValue(false),
      getSessionCount: vi.fn().mockReturnValue(0),
      getMax: vi.fn().mockReturnValue(5),
      // tryAdd returns false → triggers race-fallback.
      tryAdd: vi.fn().mockReturnValue(false),
      remove: vi.fn(),
    } as unknown as IpSessionLimiter;

    // Spy on SSEServerTransport.close via prototype — every transport
    // constructed in-handler will share this prototype method.
    const { SSEServerTransport } =
      await import("@modelcontextprotocol/sdk/server/sse.js");
    const closeSpy = vi
      .spyOn(SSEServerTransport.prototype, "close")
      .mockImplementation(async function () {
        // No-op: the real close() writes to res which may already be ended.
      });

    const { app, deps } = buildApp({ ipLimiter: raceLimiter });
    server = await startServer(app);
    const url = baseUrlOf(server);

    const res = await fetch(`${url}/sse`);
    expect(res.status).toBe(429);
    await res.body?.cancel();

    // Wait a tick so the microtask-scheduled close() runs.
    await new Promise((r) => setTimeout(r, 30));

    // The transport constructed in-handler must have had close() called
    // exactly once as part of the race-fallback teardown.
    expect(closeSpy).toHaveBeenCalledTimes(1);

    // Map entries must be cleared (they were registered pre-race-fallback).
    expect(Object.keys(deps.sseTransports).length).toBe(0);
    expect(Object.keys(deps.sessionLastActivity).length).toBe(0);

    closeSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrSpy.mockRestore();
  });

  it("/sse race-fallback logs async transport.close() rejections instead of leaving them unhandled", async () => {
    // Mirrors the /mcp race-fallback: transport.close() is scheduled on a
    // microtask with a .catch() handler so an async rejection lands in
    // console.error instead of surfacing as an unhandled rejection.
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const consoleErrSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const raceLimiter = {
      isAllowlisted: vi.fn().mockReturnValue(false),
      getSessionCount: vi.fn().mockReturnValue(0),
      getMax: vi.fn().mockReturnValue(5),
      tryAdd: vi.fn().mockReturnValue(false),
      remove: vi.fn(),
    } as unknown as IpSessionLimiter;

    const { SSEServerTransport } =
      await import("@modelcontextprotocol/sdk/server/sse.js");
    const closeSpy = vi
      .spyOn(SSEServerTransport.prototype, "close")
      .mockImplementation(async function () {
        throw new Error("close-boom");
      });

    const { app } = buildApp({ ipLimiter: raceLimiter });
    server = await startServer(app);
    const url = baseUrlOf(server);

    const res = await fetch(`${url}/sse`);
    expect(res.status).toBe(429);
    await res.body?.cancel();

    // Wait for microtask + async rejection handler to fire.
    await new Promise((r) => setTimeout(r, 30));

    const errCalls = consoleErrSpy.mock.calls.map((c) => String(c[0]));
    const hit = errCalls.find(
      (m) => m.includes("SSE race-fallback") && m.includes("transport.close"),
    );
    expect(hit).toBeDefined();

    closeSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrSpy.mockRestore();
  });

  it("/sse lazy workspace: ensureSession is NOT called eagerly during session creation", async () => {
    // After session hardening, ensureSession is no longer called eagerly.
    // Workspace allocation is lazy per bash tool operation.
    const limiter = new IpSessionLimiter(3);
    const ensureSessionSpy = vi.fn();
    const workspaceManager = {
      ensureSession: ensureSessionSpy,
      cleanup: vi.fn(),
    };

    const { app } = buildApp({
      ipLimiter: limiter,
      workspaceManager,
    });
    server = await startServer(app);
    const url = baseUrlOf(server);

    const res = await fetch(`${url}/sse`);
    // Session should be created successfully — SSE stream starts
    // (status 200 or stream starts, not 503).
    if ("body" in res && res.body) {
      await (res.body as ReadableStream).cancel().catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 30));

    // ensureSession should NOT have been called
    expect(ensureSessionSpy).not.toHaveBeenCalled();
  });

  it("disconnect between registration and tryAdd: cleanup.remove tolerates unknown sid", async () => {
    // R4 finding 3: handler registers sseTransports[sid] BEFORE calling
    // ipLimiter.tryAdd. If the client disconnects in that window, the
    // res.on('close') cleanup closure fires with a populated map entry and
    // calls ipLimiter.remove(sid) — but tryAdd never ran, so the sid was
    // never associated with an IP. The limiter's remove() must no-op on an
    // unknown sid rather than throw, and the counter must remain consistent.
    const limiter = new IpSessionLimiter(3);

    // Prime the limiter for a different, legitimately-added sid so we can
    // assert the cleanup path for the unknown sid doesn't disturb it.
    limiter.tryAdd("203.0.113.99", "some-other-sid");
    expect(limiter.getSessionCount("203.0.113.99")).toBe(1);

    // The unknown sid path — this is what the cleanup closure hits when
    // the disconnect fires post-registration but pre-tryAdd.
    expect(() => limiter.remove("never-added-sid")).not.toThrow();

    // Counter for the legitimately-added sid must not have been disturbed.
    expect(limiter.getSessionCount("203.0.113.99")).toBe(1);
  });
});
