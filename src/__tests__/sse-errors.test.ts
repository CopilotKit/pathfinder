import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

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
// Helpers (mirror sse-transport.test.ts)
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

describe("SSE error paths and malformed input", () => {
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
  });

  it("POST /messages with no sessionId query param returns 404 (handler rejects missing session before any transport lookup)", async () => {
    const { app } = buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);

    const res = await fetch(`${url}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  it("POST /messages?sessionId= (empty value) returns 404 (empty string fails the truthy-sessionId guard)", async () => {
    const { app } = buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);

    const res = await fetch(`${url}/messages?sessionId=`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  it("POST /messages with malformed JSON body is short-circuited by express.json() with a 400 before reaching the handler", async () => {
    const { app } = buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);

    const res = await fetch(`${url}/messages?sessionId=does-not-matter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{invalid",
    });

    // express.json() middleware throws SyntaxError which express translates
    // to a 400. Default express error handler produces plain text.
    expect(res.status).toBe(400);
  });

  it("POST /messages with empty object body for unknown session still returns 404 (session miss wins over body-shape check)", async () => {
    const { app } = buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);

    // No live session; we want to exercise the missing-session path with a
    // syntactically valid but JSON-RPC-empty body to prove the handler does
    // not attempt to validate body shape before looking up the session.
    const res = await fetch(`${url}/messages?sessionId=no-such-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(404);
  });

  it("POST /messages with empty {} body is forwarded to the transport (which surfaces a JSON-RPC error via SSE, not an HTTP 4xx)", async () => {
    const { app, deps } = buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);

    // Open a real session first.
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

    // Spy on the transport so we can confirm the handler forwards the body
    // through to the MCP SDK (where a JSON-RPC error would be emitted over
    // SSE in a real session). We simulate the SDK's 202-accept behavior.
    const transport = deps.sseTransports[sid];
    const spy = vi
      .spyOn(transport, "handlePostMessage")
      .mockImplementation(async (_req, res, body) => {
        // The SDK validates body shape here; for an empty {} it would emit
        // a JSON-RPC error object over the SSE stream and respond 202 on
        // the POST side. We assert the handler passed {} through unchanged.
        expect(body).toEqual({});
        res.writeHead(202).end();
      });

    const postRes = await fetch(`${url}/messages?sessionId=${sid}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(postRes.status).toBe(202);
    expect(spy).toHaveBeenCalledTimes(1);

    await reader.cancel();
  });

  it("POST /messages with wrong Content-Type (text/plain) for a live session is still forwarded to the transport; express.json() skips non-json bodies so req.body is undefined", async () => {
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

    const transport = deps.sseTransports[sid];
    let receivedBody: unknown = "never-called";
    const spy = vi
      .spyOn(transport, "handlePostMessage")
      .mockImplementation(async (_req, res, body) => {
        receivedBody = body;
        res.writeHead(202).end();
      });

    const postRes = await fetch(`${url}/messages?sessionId=${sid}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    await postRes.arrayBuffer();

    // express.json() only parses application/json. With text/plain and no
    // text parser registered, express leaves req.body === undefined. The
    // handler forwards it to the transport unchanged, so the SDK sees
    // `undefined` as the message body — the handler does not reject based
    // on Content-Type.
    expect(postRes.status).toBe(202);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(receivedBody).toBeUndefined();

    await reader.cancel();
  });

  it("POST /messages after the SSE stream was closed returns 404 (session was cleaned up on close)", async () => {
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
    expect(deps.sseTransports[sid]).toBeDefined();

    // Close the stream and wait for server-side cleanup.
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 50));
    expect(deps.sseTransports[sid]).toBeUndefined();

    const postRes = await fetch(`${url}/messages?sessionId=${sid}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });

    expect(postRes.status).toBe(404);
  });

  it("GET /sse with Accept: application/json still opens an SSE stream (handler does not inspect Accept — SDK forces text/event-stream Content-Type)", async () => {
    const { app } = buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);

    const res = await fetch(`${url}/sse`, {
      headers: { Accept: "application/json" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    await res.body?.cancel();
  });
});
