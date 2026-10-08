/**
 * /messages looks up the session in a plain-object map. A session id that
 * names an Object.prototype member ("constructor", "__proto__",
 * "toString", ...) must not resolve to the inherited value. It must get
 * the same 404 unknown-session-id answer as any other unknown id, not a
 * 500 from calling handlePostMessage on a non-transport.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { RequestHandler } from "express";
import type { SSEServerTransport } from "@modelcontextprotocol/server-legacy/sse";
import { createSseHandlers } from "../sse-handlers.js";

describe("/messages with a prototype-member session id", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sseTransports: Record<string, SSEServerTransport> = {};
    const handlers = createSseHandlers({
      sseTransports,
      sessionLastActivity: {},
      ipLimiter: undefined,
      workspaceManager: undefined,
      // POST /messages never builds an MCP server; fail loudly if it does.
      createMcpServer: () => {
        throw new Error("createMcpServer must not be called by /messages");
      },
      trustProxy: false,
    });
    // postHandler is [bearerMiddleware, messagesPost]; mount only the
    // handler so the test needs no OAuth config.
    const messagesPost = handlers.postHandler[1] as RequestHandler;
    const app = express();
    app.use(express.json());
    app.post("/messages", messagesPost);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    if (server?.listening) {
      await new Promise<void>((resolve, reject) =>
        server!.close((err) => (err ? reject(err) : resolve())),
      );
    }
    server = undefined;
  });

  async function post(sessionId: string) {
    const res = await fetch(
      `${baseUrl}/messages?sessionId=${encodeURIComponent(sessionId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      },
    );
    return { status: res.status, body: (await res.json()) as unknown };
  }

  it.each([
    "constructor",
    "__proto__",
    "toString",
    "hasOwnProperty",
    "valueOf",
  ])("sessionId=%s answers 404 unknown-session-id", async (sid) => {
    const { status, body } = await post(sid);
    expect(status).toBe(404);
    expect(body).toEqual({
      error: "Session not found",
      reason: "unknown-session-id",
    });
  });

  it("matches the answer for an ordinary unknown id", async () => {
    const unknown = await post("does-not-exist");
    const proto = await post("constructor");
    expect(proto).toEqual(unknown);
  });
});
