/**
 * R3 #10 — /messages 500 catch logs the session-id prefix but no client IP.
 * Sibling 404 branches (missing-session-id / unknown-session-id) already
 * log `ip=${clientIp(...)}`; the 500 catch is an outlier and loses the
 * signal at the exact point an operator is most likely to want it. This
 * test drives the catch and asserts the log line carries `ip=`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSseHandlers } from "../sse-handlers.js";
import type { Request, Response } from "express";
import type { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

describe("/messages handlePostMessage 500 log includes client IP (R3 #10)", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  interface TestRes {
    _status: number | undefined;
  }
  function makeRes(): Response & TestRes {
    const state: TestRes = { _status: undefined };
    const res = {
      headersSent: false,
      status(code: number) {
        state._status = code;
        return res;
      },
      json() {
        return res;
      },
      get _status() {
        return state._status;
      },
    };
    return res as unknown as Response & TestRes;
  }

  it("logs ip= when handlePostMessage rejects", async () => {
    // Seed a fake transport keyed under sessionId="abcdef1234567890" so
    // the handler passes the "unknown session" guard and reaches the try
    // block. The transport's handlePostMessage throws to hit the catch.
    const sessionId = "abcdef1234567890";
    const fakeTransport = {
      handlePostMessage: () => {
        throw new Error("post boom");
      },
    } as unknown as SSEServerTransport;
    const sseTransports: Record<string, SSEServerTransport> = {
      [sessionId]: fakeTransport,
    };
    const handlers = createSseHandlers({
      sseTransports,
      sessionLastActivity: {},
      ipLimiter: undefined,
      workspaceManager: undefined,
      createMcpServer: () => ({}) as never,
      trustProxy: false,
    });
    const req = {
      socket: { remoteAddress: "127.0.0.1" },
      ip: "127.0.0.1",
      headers: {},
      query: { sessionId },
      body: {},
    } as unknown as Request;
    const res = makeRes();

    // postHandler is [bearerMiddleware, messagesPost] — skip bearer.
    const messagesPost = handlers.postHandler[1];
    await (messagesPost as (req: Request, res: Response) => Promise<void>)(
      req,
      res,
    );

    const joined = consoleErrorSpy.mock.calls.flat().map(String).join(" ");
    expect(joined).toMatch(/\[mcp\] SSE handlePostMessage failed/);
    expect(joined).toMatch(/ip=/);
  });
});
