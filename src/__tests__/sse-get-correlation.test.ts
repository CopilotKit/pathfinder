/**
 * R3 #9 — sseGet's outer catch block emits
 * `console.error("[mcp] SSE connection error:", err)` and a generic 500
 * body. Like /analytics sendFile, there's no shared ID between log and
 * response — an operator who gets "SSE session failed" from a user can't
 * find THIS session's failure in logs. Add a correlation ID to both.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSseHandlers } from "../sse-handlers.js";
import type { Request, Response } from "express";

describe("sseGet 500 catch correlation ID (R3 #9)", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  interface TestRes {
    _status: number | undefined;
    _json: unknown;
    _ended: boolean;
  }

  function makeRes(): Response & TestRes {
    const state: TestRes = {
      _status: undefined,
      _json: undefined,
      _ended: false,
    };
    const res = {
      headersSent: false,
      destroyed: false,
      writableEnded: false,
      status(code: number) {
        state._status = code;
        return res;
      },
      json(body: unknown) {
        state._json = body;
        state._ended = true;
        return res;
      },
      setHeader: vi.fn(),
      on: vi.fn(),
      get _status() {
        return state._status;
      },
      get _json() {
        return state._json;
      },
      get _ended() {
        return state._ended;
      },
    };
    return res as unknown as Response & TestRes;
  }

  it("emits a correlation ID in both the log line and the 500 response", async () => {
    const handlers = createSseHandlers({
      sseTransports: {},
      sessionLastActivity: {},
      ipLimiter: undefined,
      workspaceManager: undefined,
      // Force a throw from the SSE construction path — the simplest
      // trigger is making createMcpServer throw, which runs inside the
      // try block and lands in the outer catch.
      createMcpServer: () => {
        throw new Error("createMcpServer exploded");
      },
      trustProxy: false,
    });

    // Build a minimal Request that the handler will accept.
    const req = {
      socket: { remoteAddress: "127.0.0.1" },
      ip: "127.0.0.1",
      headers: {},
    } as unknown as Request;
    const res = makeRes();

    // createSseHandlers returns { getHandler: [auth, sseGet],
    // postHandler: [auth, messagesPost] }. We want sseGet only (skip
    // bearer middleware). The array is [auth, sseGet] — sseGet is at [1].
    const sseGet = handlers.getHandler[1];
    await (sseGet as (req: Request, res: Response) => Promise<void> | void)(
      req,
      res,
    );

    expect(res._status).toBe(500);
    const body = res._json as { error: string; correlationId?: string };
    expect(body.correlationId).toBeTruthy();
    const joined = consoleErrorSpy.mock.calls.flat().map(String).join(" ");
    expect(joined).toContain(body.correlationId!);
  });
});
