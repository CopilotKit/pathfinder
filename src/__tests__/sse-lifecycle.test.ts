import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// Stable JWT secret for bearer middleware — mirrors sse-transport.test.ts.
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
  }),
  getServerConfig: vi.fn().mockReturnValue({
    server: { name: "pathfinder-lifecycle-test", version: "0.0.0" },
    sources: [],
    tools: [],
  }),
  getAnalyticsConfig: vi.fn(),
  hasSearchTools: vi.fn().mockReturnValue(false),
  hasKnowledgeTools: vi.fn().mockReturnValue(false),
  hasCollectTools: vi.fn().mockReturnValue(false),
  hasBashSemanticSearch: vi.fn().mockReturnValue(false),
}));

import type { SseHandlerDeps } from "../sse-handlers.js";
import { createSseHandlers, reapIdleSseSessions } from "../sse-handlers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal stand-in for IpSessionLimiter that records acquire/release calls so
 * tests can assert ref-count behavior without relying on the production map
 * internals. Matches the subset of the IpSessionLimiter API that
 * sse-handlers.ts consumes (tryAdd / remove).
 */
class FakeIpLimiter {
  public added: Array<{ ip: string; sessionId: string }> = [];
  public removed: string[] = [];
  private capacity: number;
  private used = 0;

  constructor(capacity = 100) {
    this.capacity = capacity;
  }

  tryAdd(ip: string, sessionId: string): boolean {
    if (this.used >= this.capacity) return false;
    this.used++;
    this.added.push({ ip, sessionId });
    return true;
  }

  remove(sessionId: string): void {
    this.removed.push(sessionId);
    if (this.used > 0) this.used--;
  }

  getSessionCount(_ip: string): number {
    return this.used;
  }

  getMax(): number {
    return this.capacity;
  }

  count(): number {
    return this.used;
  }
}

function buildApp(overrides: Partial<SseHandlerDeps> = {}): {
  app: express.Express;
  deps: SseHandlerDeps;
  limiter: FakeIpLimiter;
} {
  const sseTransports: SseHandlerDeps["sseTransports"] = {};
  const sessionLastActivity: SseHandlerDeps["sessionLastActivity"] = {};
  const limiter = new FakeIpLimiter(100);
  const deps: SseHandlerDeps = {
    sseTransports,
    sessionLastActivity,
    ipLimiter: limiter as unknown as SseHandlerDeps["ipLimiter"],
    createMcpServer: () => {
      return {
        connect: vi.fn(async (transport: unknown) => {
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
  return { app, deps, limiter };
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

/**
 * Open an SSE connection against the test server and wait until the endpoint
 * event (with sessionId) is observed, returning the session id and the open
 * reader so the caller can close it.
 */
async function openSseSession(url: string): Promise<{
  sid: string;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  res: Response;
}> {
  const res = await fetch(`${url}/sse`, {
    headers: { Accept: "text/event-stream" },
  });
  if (res.status !== 200) {
    throw new Error(`openSseSession: GET /sse returned ${res.status}`);
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!buffer.includes("event: endpoint")) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  const match = buffer.match(/sessionId=([0-9a-f-]+)/);
  if (!match) throw new Error("openSseSession: no sessionId in endpoint event");
  return { sid: match[1], reader, res };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SSE session lifecycle", () => {
  let server: Server | undefined;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    await closeServer(server);
    server = undefined;
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 1. Reaper removes idle sessions past TTL
  // -------------------------------------------------------------------------
  it("reapIdleSseSessions removes idle sessions past SESSION_TTL_MS and closes their transport", () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    vi.setSystemTime(t0);

    const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes — mirrors server.ts default

    const closed: string[] = [];
    const sseTransports: Record<string, { close: () => Promise<void> | void }> =
      {
        idle: {
          close: vi.fn(() => {
            closed.push("idle");
          }) as unknown as () => Promise<void>,
        },
        fresh: {
          close: vi.fn(() => {
            closed.push("fresh");
          }) as unknown as () => Promise<void>,
        },
      };
    const sessionLastActivity: Record<string, number> = {
      idle: t0,
      fresh: t0,
    };

    // Fast-forward past TTL; only bump "fresh" to simulate recent activity.
    vi.advanceTimersByTime(SESSION_TTL_MS + 1_000);
    sessionLastActivity["fresh"] = Date.now();

    const reaped = reapIdleSseSessions({
      sseTransports,
      sessionLastActivity,
      ttlMs: SESSION_TTL_MS,
    });

    expect(reaped).toEqual(["idle"]);
    expect(sseTransports["idle"]).toBeUndefined();
    expect(sessionLastActivity["idle"]).toBeUndefined();
    // Fresh session survives.
    expect(sseTransports["fresh"]).toBeDefined();
    expect(sessionLastActivity["fresh"]).toBeDefined();
    // The idle transport's close() was invoked; the fresh one was not.
    expect(closed).toEqual(["idle"]);
  });

  // -------------------------------------------------------------------------
  // 2. Activity timestamp updates on /messages POST
  // -------------------------------------------------------------------------
  it("POST /messages updates sessionLastActivity for the addressed session", async () => {
    const { app, deps } = buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);

    const { sid, reader } = await openSseSession(url);
    expect(deps.sessionLastActivity[sid]).toBeGreaterThan(0);
    const before = deps.sessionLastActivity[sid];

    // Spy on the real SDK transport's handlePostMessage so the HTTP round
    // trip doesn't hang on protocol-level validation.
    const transport = deps.sseTransports[sid];
    vi.spyOn(transport, "handlePostMessage").mockImplementation(
      async (_req, res) => {
        res.writeHead(202).end();
      },
    );

    // Ensure wall-clock advances at least 1ms past the registration time.
    await new Promise((r) => setTimeout(r, 5));

    const postRes = await fetch(`${url}/messages?sessionId=${sid}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(postRes.status).toBe(202);

    const after = deps.sessionLastActivity[sid];
    expect(after).toBeGreaterThan(before);

    await reader.cancel();
  });

  // -------------------------------------------------------------------------
  // 3. Stream close cleans up (map entry removed + IP limiter decremented)
  // -------------------------------------------------------------------------
  it("client disconnect removes the session from sseTransports and decrements the IP limiter", async () => {
    const { app, deps, limiter } = buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);

    const { sid, reader } = await openSseSession(url);

    // Session is registered and counted by the limiter.
    expect(deps.sseTransports[sid]).toBeDefined();
    expect(deps.sessionLastActivity[sid]).toBeDefined();
    expect(limiter.added.map((a) => a.sessionId)).toContain(sid);
    expect(limiter.count()).toBe(1);

    // Simulate client disconnect.
    await reader.cancel();

    // Wait for the server-side 'close' event to propagate and run cleanup.
    await new Promise((r) => setTimeout(r, 50));

    expect(deps.sseTransports[sid]).toBeUndefined();
    expect(deps.sessionLastActivity[sid]).toBeUndefined();
    expect(limiter.removed).toContain(sid);
    expect(limiter.count()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 4. IP limiter decrement on session end (explicit ipLimiter.remove call)
  // -------------------------------------------------------------------------
  it("closing a session invokes ipLimiter.remove(sessionId) exactly once", async () => {
    const { app, limiter } = buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);

    const { sid, reader } = await openSseSession(url);
    expect(limiter.removed).not.toContain(sid);

    await reader.cancel();
    await new Promise((r) => setTimeout(r, 50));

    const removalsForSid = limiter.removed.filter((s) => s === sid);
    // At minimum once — the onclose/res.close cleanup hooks may dedupe via
    // the sseTransports presence check, so we expect exactly one release.
    expect(removalsForSid.length).toBe(1);
  });
});
