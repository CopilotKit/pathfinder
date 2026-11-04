/**
 * The legacy /messages route logs client-controlled values: the `sessionId`
 * query parameter and, behind a trusting proxy, the X-Forwarded-For client
 * IP. A raw `%0a` in the sessionId made the unknown-session-id 404 log emit a
 * second, forged log line. Every such value must pass through safeLogToken,
 * so each log call stays one line of printable ASCII.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSseHandlers } from "../sse-handlers.js";
import type { Request, Response } from "express";
import type { SSEServerTransport } from "@modelcontextprotocol/server-legacy/sse";
import type { McpServer } from "@modelcontextprotocol/server";
import type { IpSessionLimiter } from "../ip-limiter.js";

const NON_PRINTABLE = /[^\x20-\x7e]/;

describe("/messages logs escape client-controlled values", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  function makeRes(): Response {
    const res = {
      headersSent: false,
      status() {
        return res;
      },
      json() {
        return res;
      },
    };
    return res as unknown as Response;
  }

  async function post(
    sessionId: unknown,
    ip: string,
    sseTransports: Record<string, SSEServerTransport> = {},
  ): Promise<void> {
    const handlers = createSseHandlers({
      sseTransports,
      sessionLastActivity: {},
      ipLimiter: undefined,
      workspaceManager: undefined,
      createMcpServer: () => {
        throw new Error("/messages never builds an MCP server");
      },
      trustProxy: true,
    });
    const req = {
      socket: { remoteAddress: "127.0.0.1" },
      ip,
      headers: {},
      query: { sessionId },
      body: {},
    } as unknown as Request;
    // postHandler is [bearerMiddleware, messagesPost] — skip bearer.
    const messagesPost = handlers.postHandler[1] as (
      req: Request,
      res: Response,
    ) => Promise<void>;
    await messagesPost(req, makeRes());
  }

  function firstArg(spy: ReturnType<typeof vi.spyOn>): string {
    expect(spy).toHaveBeenCalledTimes(1);
    return String(spy.mock.calls[0][0]);
  }

  it.each([
    ["LF", "x\nFORGED", "x?FORGED"],
    ["CRLF", "\r\n[mcp]X", "??[mcp]X"],
    ["ESC", "\x1b[31mRED", "?[31mRED"],
    ["NUL/DEL", "a\x00b\x7fc", "a?b?c"],
  ])(
    "unknown-session-id 404 keeps a %s sessionId on one escaped line",
    async (_label, sessionId, escaped) => {
      await post(sessionId, "203.0.113.9");
      const line = firstArg(warnSpy);
      expect(line).toMatch(/reason=unknown-session-id/);
      expect(line).not.toMatch(NON_PRINTABLE);
      expect(line).toContain(`sid=${escaped}`);
    },
  );

  it("escapes a proxy-supplied client IP on the 404 and 500 lines", async () => {
    const ip = "198.51.100.7\u0085x";
    await post(undefined, ip);
    const missing = firstArg(warnSpy);
    expect(missing).toMatch(/reason=missing-session-id/);
    expect(missing).not.toMatch(NON_PRINTABLE);
    expect(missing).toContain("ip=198.51.100.7?x");

    warnSpy.mockClear();
    await post("nope", ip);
    const unknown = firstArg(warnSpy);
    expect(unknown).not.toMatch(NON_PRINTABLE);
    expect(unknown).toContain("ip=198.51.100.7?x");

    const failing = {
      handlePostMessage: () => {
        throw new Error("post boom");
      },
    } as unknown as SSEServerTransport;
    await post("abcdef1234567890", ip, { abcdef1234567890: failing });
    const failed = firstArg(errorSpy);
    expect(failed).toMatch(/SSE handlePostMessage failed/);
    expect(failed).not.toMatch(NON_PRINTABLE);
    expect(failed).toContain("ip=198.51.100.7?x");
  });
});

/**
 * The /sse (GET) route logs the same client IP at three more sites: the
 * rate-limit pre-check, the tryAdd race fallback and the "New SSE session"
 * line. Each must stay one line of printable ASCII.
 */
describe("/sse logs escape the client IP", () => {
  const IP = "198.51.100.7\u0085x";
  const ESCAPED = "198.51.100.7?x";

  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  function makeRes(): Response {
    const res = {
      headersSent: false,
      destroyed: false,
      writableEnded: false,
      setHeader() {},
      on() {},
      end() {},
      status() {
        return res;
      },
      json() {
        return res;
      },
    };
    return res as unknown as Response;
  }

  /** An ipLimiter stub: `count` sessions in use, and tryAdd's answer. */
  type LimiterStub = Pick<
    IpSessionLimiter,
    "isAllowlisted" | "getSessionCount" | "getMax" | "tryAdd" | "remove"
  >;
  function limiter(count: number, tryAddResult: boolean): LimiterStub {
    return {
      isAllowlisted: () => false,
      getSessionCount: () => count,
      getMax: () => 1,
      tryAdd: () => tryAddResult,
      remove: () => {},
    };
  }

  async function get(ipLimiter: LimiterStub | undefined) {
    const server: Pick<McpServer, "connect"> = { connect: async () => {} };
    const handlers = createSseHandlers({
      sseTransports: {},
      sessionLastActivity: {},
      // sseGet calls only the LimiterStub members and server.connect.
      ipLimiter: ipLimiter as unknown as IpSessionLimiter | undefined,
      workspaceManager: undefined,
      createMcpServer: () => server as unknown as McpServer,
      trustProxy: true,
    });
    const req = {
      socket: { remoteAddress: "127.0.0.1" },
      ip: IP,
      headers: {},
      query: {},
    } as unknown as Request;
    // getHandler is [bearerMiddleware, sseGet] — skip bearer.
    const sseGet = handlers.getHandler[1] as (
      req: Request,
      res: Response,
    ) => Promise<void>;
    await sseGet(req, makeRes());
  }

  function onlyLine(spy: ReturnType<typeof vi.spyOn>, pattern: RegExp): string {
    const lines = spy.mock.calls
      .map((args: unknown[]) => String(args[0]))
      .filter((l: string) => pattern.test(l));
    expect(lines).toHaveLength(1);
    return lines[0];
  }

  it("escapes the IP on the rate-limit pre-check line", async () => {
    await get(limiter(1, true));
    const line = onlyLine(warnSpy, /rejecting SSE session$/);
    expect(line).not.toMatch(NON_PRINTABLE);
    expect(line).toContain(`exceeded for ${ESCAPED} (1/1)`);
  });

  it("escapes the IP on the race-fallback line", async () => {
    await get(limiter(0, false));
    const line = onlyLine(warnSpy, /\(race fallback\)$/);
    expect(line).not.toMatch(NON_PRINTABLE);
    expect(line).toContain(`exceeded for ${ESCAPED} (0/1)`);
  });

  it("escapes the IP on the New SSE session line", async () => {
    await get(undefined);
    const line = onlyLine(logSpy, /New SSE session/);
    expect(line).not.toMatch(NON_PRINTABLE);
    expect(line).toContain(`[${ESCAPED}]`);
  });
});
