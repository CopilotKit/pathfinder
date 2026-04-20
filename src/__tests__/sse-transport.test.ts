import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
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
});
