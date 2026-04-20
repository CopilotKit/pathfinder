import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express, { Request, Response } from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

// Stable JWT secret so bearerMiddleware doesn't explode at import time.
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
    server: { name: "pathfinder-concurrency", version: "0.0.0" },
    sources: [],
    tools: [],
  }),
  getAnalyticsConfig: vi.fn(),
  hasSearchTools: vi.fn().mockReturnValue(false),
  hasKnowledgeTools: vi.fn().mockReturnValue(false),
  hasCollectTools: vi.fn().mockReturnValue(false),
  hasBashSemanticSearch: vi.fn().mockReturnValue(false),
}));

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { IpSessionLimiter } from "../ip-limiter.js";
import { createSseHandlers, type SseHandlerDeps } from "../sse-handlers.js";
import { createMcpServer } from "../mcp/server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestApp {
  app: express.Express;
  sseTransports: Record<string, SSEServerTransport>;
  sessionLastActivity: Record<string, number>;
  mcpTransports: Record<string, StreamableHTTPServerTransport>;
}

function buildApp(): TestApp {
  const sseTransports: SseHandlerDeps["sseTransports"] = {};
  const sessionLastActivity: SseHandlerDeps["sessionLastActivity"] = {};
  const mcpTransports: Record<string, StreamableHTTPServerTransport> = {};

  const deps: SseHandlerDeps = {
    sseTransports,
    sessionLastActivity,
    ipLimiter: new IpSessionLimiter(100),
    // Stub McpServer: just call transport.start() on connect — this is enough
    // to make SSEServerTransport emit its endpoint event.
    createMcpServer: () => {
      return {
        connect: vi.fn(async (transport: unknown) => {
          const t = transport as { start?: () => Promise<void> };
          if (t.start) await t.start();
        }),
      } as unknown as ReturnType<SseHandlerDeps["createMcpServer"]>;
    },
    workspaceManager: undefined,
  };

  const app = express();
  app.use(express.json());
  const { getHandler, postHandler } = createSseHandlers(deps);
  app.get("/sse", getHandler);
  app.post("/messages", postHandler);

  // Minimal /mcp POST handler that mirrors server.ts's shared-map behavior.
  // Only implements the initialize path, which is enough to prove
  // sessionLastActivity is shared across /mcp and /sse.
  app.post("/mcp", async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && mcpTransports[sessionId]) {
        sessionLastActivity[sessionId] = Date.now();
        await mcpTransports[sessionId].handleRequest(req, res, req.body);
        return;
      }
      if (!sessionId && isInitializeRequest(req.body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            mcpTransports[sid] = transport;
            sessionLastActivity[sid] = Date.now();
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && mcpTransports[sid]) {
            delete mcpTransports[sid];
            delete sessionLastActivity[sid];
          }
        };
        const server = createMcpServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "No valid session" },
        id: null,
      });
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: "mcp handler failed" });
      }
      throw err;
    }
  });

  return { app, sseTransports, sessionLastActivity, mcpTransports };
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
 * Open an SSE stream and wait for the endpoint event. Returns the sessionId,
 * the reader, and the accumulated buffer so the caller can continue reading.
 */
async function openSseSession(baseUrl: string): Promise<{
  sessionId: string;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  decoder: TextDecoder;
  buffer: string;
  response: Response;
}> {
  const response = await fetch(`${baseUrl}/sse`, {
    headers: { Accept: "text/event-stream" },
  });
  if (response.status !== 200) {
    throw new Error(`/sse returned ${response.status}`);
  }
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!buffer.includes("event: endpoint")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("SSE stream closed before endpoint event");
    buffer += decoder.decode(value, { stream: true });
  }
  const match = buffer.match(/sessionId=([0-9a-f-]+)/);
  if (!match) throw new Error("no sessionId in endpoint event");
  return {
    sessionId: match[1],
    reader,
    decoder,
    buffer,
    response: response as unknown as Response,
  };
}

/**
 * Read from an SSE reader until predicate matches or timeout elapses.
 * Returns the buffer state and whether the predicate matched.
 */
async function readUntilOrTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  initialBuffer: string,
  predicate: (buf: string) => boolean,
  timeoutMs: number,
): Promise<{ buffer: string; matched: boolean }> {
  let buffer = initialBuffer;
  if (predicate(buffer)) return { buffer, matched: true };
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const remaining = timeoutMs - (Date.now() - start);
    const readPromise = reader.read();
    const timeoutPromise = new Promise<{ timedOut: true }>((resolve) =>
      setTimeout(() => resolve({ timedOut: true }), remaining),
    );
    const result = (await Promise.race([readPromise, timeoutPromise])) as
      | { timedOut: true }
      | { done: boolean; value?: Uint8Array };
    if ("timedOut" in result) return { buffer, matched: false };
    if ("done" in result) {
      if (result.done) return { buffer, matched: predicate(buffer) };
      if (result.value) {
        buffer += decoder.decode(result.value, { stream: true });
        if (predicate(buffer)) return { buffer, matched: true };
      }
    }
  }
  return { buffer, matched: predicate(buffer) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SSE concurrency and session isolation", () => {
  let server: Server | undefined;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrSpy.mockRestore();
    await closeServer(server);
    server = undefined;
  });

  it("two simultaneous SSE sessions receive distinct session IDs", async () => {
    const { app } = buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);

    const [a, b] = await Promise.all([
      openSseSession(url),
      openSseSession(url),
    ]);

    expect(a.sessionId).toMatch(/^[0-9a-f-]+$/);
    expect(b.sessionId).toMatch(/^[0-9a-f-]+$/);
    expect(a.sessionId).not.toBe(b.sessionId);

    await a.reader.cancel();
    await b.reader.cancel();
  });

  it("POST /messages routes only to the matching session's stream", async () => {
    const { app, sseTransports } = buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);

    const a = await openSseSession(url);
    const b = await openSseSession(url);
    expect(a.sessionId).not.toBe(b.sessionId);

    // Spy on each transport's handlePostMessage so we can emit a synthetic
    // message on the correct stream without engaging the real McpServer
    // (which is stubbed). The real handlePostMessage would forward to the
    // McpServer → transport.send() pair; we mimic that by writing a unique
    // event onto the matching response stream.
    const transportA = sseTransports[a.sessionId];
    const transportB = sseTransports[b.sessionId];
    expect(transportA).toBeDefined();
    expect(transportB).toBeDefined();

    const uniqueMarker = `concurrency-marker-${randomUUID()}`;

    vi.spyOn(transportA, "handlePostMessage").mockImplementation(
      async (_req, res) => {
        // Emit a message event on stream A only.
        await transportA.send({
          jsonrpc: "2.0",
          id: 42,
          result: { marker: uniqueMarker },
        });
        res.writeHead(202).end();
      },
    );
    // Leave transportB unmocked-but-not-called — if it fires, we fail.
    const spyB = vi
      .spyOn(transportB, "handlePostMessage")
      .mockImplementation(async (_req, res) => {
        res.writeHead(202).end();
      });

    // POST initialize to A's /messages endpoint.
    const postRes = await fetch(`${url}/messages?sessionId=${a.sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 42,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "concurrency-test", version: "0.0.0" },
        },
      }),
    });
    expect(postRes.status).toBe(202);

    // Stream A should see the unique marker.
    const aResult = await readUntilOrTimeout(
      a.reader,
      a.decoder,
      a.buffer,
      (buf) => buf.includes(uniqueMarker),
      2000,
    );
    expect(aResult.matched).toBe(true);
    expect(aResult.buffer).toContain(uniqueMarker);

    // Stream B must NOT see the marker within a reasonable window.
    const bResult = await readUntilOrTimeout(
      b.reader,
      b.decoder,
      b.buffer,
      (buf) => buf.includes(uniqueMarker),
      300,
    );
    expect(bResult.matched).toBe(false);
    expect(bResult.buffer).not.toContain(uniqueMarker);

    // And B's handler was never invoked.
    expect(spyB).not.toHaveBeenCalled();

    await a.reader.cancel();
    await b.reader.cancel();
  });

  it("sessionLastActivity is shared across /mcp and /sse (2 distinct entries)", async () => {
    const { app, sessionLastActivity, mcpTransports, sseTransports } =
      buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);

    // 1. Create an /mcp session via initialize.
    const initRes = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "concurrency-mcp", version: "0.0.0" },
        },
      }),
    });
    expect([200, 202]).toContain(initRes.status);
    // Drain body so we don't leak connections.
    await initRes.body?.cancel();

    const mcpKeys = Object.keys(mcpTransports);
    expect(mcpKeys.length).toBe(1);
    const mcpSid = mcpKeys[0];

    // 2. Open an /sse session.
    const sse = await openSseSession(url);
    const sseSid = sse.sessionId;

    expect(sseSid).not.toBe(mcpSid);

    // 3. Verify the shared map holds exactly 2 entries, keyed by both sids.
    const keys = Object.keys(sessionLastActivity).sort();
    expect(keys.length).toBe(2);
    expect(keys).toEqual([mcpSid, sseSid].sort());
    expect(Object.keys(sseTransports)).toEqual([sseSid]);
    expect(Object.keys(mcpTransports)).toEqual([mcpSid]);

    await sse.reader.cancel();
  });

  it("10 concurrent SSE sessions each receive unique IDs and clean up on close", async () => {
    const { app, sseTransports, sessionLastActivity } = buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);

    const N = 10;
    const sessions = await Promise.all(
      Array.from({ length: N }, () => openSseSession(url)),
    );

    // All session IDs unique.
    const ids = sessions.map((s) => s.sessionId);
    expect(new Set(ids).size).toBe(N);

    // All endpoint events observed (openSseSession already asserts this).
    for (const s of sessions) {
      expect(s.buffer).toContain("event: endpoint");
      expect(s.buffer).toMatch(/data: \/messages\?sessionId=[0-9a-f-]+/);
    }

    // Server-side state reflects all N.
    expect(Object.keys(sseTransports).length).toBe(N);
    expect(Object.keys(sessionLastActivity).length).toBe(N);
    for (const id of ids) {
      expect(sseTransports[id]).toBeDefined();
      expect(sessionLastActivity[id]).toBeGreaterThan(0);
    }

    // Close all cleanly.
    await Promise.all(sessions.map((s) => s.reader.cancel()));

    // Wait for server-side 'close' events to propagate.
    const deadline = Date.now() + 2000;
    while (Object.keys(sseTransports).length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(Object.keys(sseTransports).length).toBe(0);
    expect(Object.keys(sessionLastActivity).length).toBe(0);
  });
});
