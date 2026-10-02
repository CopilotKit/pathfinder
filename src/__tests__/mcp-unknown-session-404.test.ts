/**
 * Unknown or expired Mcp-Session-Id must answer 404 (JSON-RPC -32001) so
 * clients re-initialize. These tests cover the helpers server.ts exports for
 * that: the request classifier, the 404 writer, and the live-transport lookup.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Response } from "express";

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
  getAnalyticsConfig: vi.fn().mockReturnValue(undefined),
  hasSearchTools: vi.fn().mockReturnValue(false),
  hasKnowledgeTools: vi.fn().mockReturnValue(false),
  hasCollectTools: vi.fn().mockReturnValue(false),
  hasBashSemanticSearch: vi.fn().mockReturnValue(false),
}));

type Method = "POST" | "GET" | "DELETE";
const METHODS: Method[] = ["POST", "GET", "DELETE"];
const SID = "deadbeef-0000-4000-8000-000000000000";

describe("classifyMcpSessionRequest", () => {
  it.each(METHODS)(
    "routes %s with a known session id (initialize or not)",
    async (method) => {
      const { classifyMcpSessionRequest } = await import("../server.js");
      for (const isInitialize of [false, true]) {
        expect(
          classifyMcpSessionRequest({
            method,
            sessionId: SID,
            hasTransport: true,
            isInitialize,
          }),
        ).toBe("route");
      }
    },
  );

  it("starts a new session for POST initialize with an unknown (stale) session id", async () => {
    const { classifyMcpSessionRequest } = await import("../server.js");
    expect(
      classifyMcpSessionRequest({
        method: "POST",
        sessionId: SID,
        hasTransport: false,
        isInitialize: true,
      }),
    ).toBe("new-session");
  });

  it.each(METHODS)(
    "reports unknown-session for %s with an unknown id and no initialize",
    async (method) => {
      const { classifyMcpSessionRequest } = await import("../server.js");
      expect(
        classifyMcpSessionRequest({
          method,
          sessionId: SID,
          hasTransport: false,
          isInitialize: false,
        }),
      ).toBe("unknown-session");
    },
  );

  it("starts a new session for POST initialize with no session id", async () => {
    const { classifyMcpSessionRequest } = await import("../server.js");
    expect(
      classifyMcpSessionRequest({
        method: "POST",
        sessionId: undefined,
        hasTransport: false,
        isInitialize: true,
      }),
    ).toBe("new-session");
  });

  it.each(METHODS)(
    "reports no-session for %s with no session id and no initialize",
    async (method) => {
      const { classifyMcpSessionRequest } = await import("../server.js");
      expect(
        classifyMcpSessionRequest({
          method,
          sessionId: undefined,
          hasTransport: false,
          isInitialize: false,
        }),
      ).toBe("no-session");
    },
  );
});

describe("writeUnknownSession404", () => {
  const NOT_FOUND_BODY = {
    jsonrpc: "2.0",
    error: { code: -32001, message: "Session not found" },
    id: null,
  };
  let warn: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  /** The value Date.now() returns. Each test starts a new 404 window at T0. */
  const T0 = 1_800_000_000_000;
  let clock = T0;

  function fakeRes() {
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    return { res: { status } as unknown as Response, status, json };
  }

  /**
   * The writer's options for a body-less unknown-session request. The test
   * that no session id or ip bytes are logged drives the real route, in
   * mcp-unknown-session-404-routes.test.ts.
   */
  function unknownReq(method: Method) {
    return { method };
  }

  /** Every string written to console.warn/log/error since the last reset. */
  function consoleOutput(): string[] {
    return [warn, log, error].flatMap((spy) =>
      spy.mock.calls.map((args: unknown[]) => args.map(String).join(" ")),
    );
  }

  beforeEach(async () => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
    clock = T0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    warn.mockClear();
    log.mockClear();
    error.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends 404 with the exact JSON-RPC body and writes no per-request log line", async () => {
    const { writeUnknownSession404 } = await import("../server.js");
    const { res, status, json } = fakeRes();
    writeUnknownSession404(res, unknownReq("GET"));
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith(NOT_FOUND_BODY);
    expect(consoleOutput()).toEqual([]);
  });

  it.each([
    [{ jsonrpc: "2.0", id: 42, method: "tools/list" }, 42],
    [{ jsonrpc: "2.0", id: "abc", method: "tools/list" }, "abc"],
    [{ jsonrpc: "2.0", id: 0, method: "tools/list" }, 0],
    [{ jsonrpc: "2.0", method: "notifications/initialized" }, null],
    [{ jsonrpc: "2.0", id: null, method: "tools/list" }, null],
    [{ jsonrpc: "2.0", id: { x: 1 }, method: "tools/list" }, null],
    [[{ jsonrpc: "2.0", id: 7, method: "tools/list" }], null],
    ["not json", null],
    [undefined, null],
  ])(
    "POST body %j gets response id %j",
    async (body: unknown, expectedId: string | number | null) => {
      const { writeUnknownSession404 } = await import("../server.js");
      const { res, json } = fakeRes();
      writeUnknownSession404(res, { method: "POST", body });
      expect(json).toHaveBeenCalledWith({ ...NOT_FOUND_BODY, id: expectedId });
    },
  );
});

describe("getLiveTransport", () => {
  it("returns the transport registered under a session id", async () => {
    const { getLiveTransport } = await import("../server.js");
    const transport = { handleRequest: vi.fn() };
    expect(getLiveTransport({ [SID]: transport }, SID)).toBe(transport);
  });

  it("returns undefined for a missing or empty session id", async () => {
    const { getLiveTransport } = await import("../server.js");
    expect(getLiveTransport({}, undefined)).toBeUndefined();
    expect(getLiveTransport({}, "")).toBeUndefined();
    expect(getLiveTransport({}, SID)).toBeUndefined();
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "does not treat the inherited key %s as a live session",
    async (sid) => {
      const { getLiveTransport, classifyMcpSessionRequest } =
        await import("../server.js");
      const transports: Record<string, { handleRequest: () => void }> = {};
      expect(getLiveTransport(transports, sid)).toBeUndefined();
      for (const method of METHODS) {
        expect(
          classifyMcpSessionRequest({
            method,
            sessionId: sid,
            hasTransport: !!getLiveTransport(transports, sid),
            isInitialize: false,
          }),
        ).toBe("unknown-session");
      }
    },
  );
});
