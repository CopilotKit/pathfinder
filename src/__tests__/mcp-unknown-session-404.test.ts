/**
 * Unknown or expired Mcp-Session-Id must answer 404 (JSON-RPC -32001) so
 * clients re-initialize. These tests cover the helpers server.ts exports for
 * that: the request classifier, the 404 writer with its per-method counter
 * flush, and the live-transport lookup.
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

describe("writeUnknownSession404 and flushUnknownSession404Counts", () => {
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
    const { flushUnknownSession404Counts } = await import("../server.js");
    flushUnknownSession404Counts();
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

  it("counts every unknown-session 404 in the flush window, with no per-id state", async () => {
    const { writeUnknownSession404, flushUnknownSession404Counts } =
      await import("../server.js");
    for (let i = 0; i < 60; i++) {
      const { res, status } = fakeRes();
      writeUnknownSession404(res, unknownReq("GET"));
      expect(status).toHaveBeenCalledWith(404);
    }
    const { res, status, json } = fakeRes();
    writeUnknownSession404(res, unknownReq("POST"));
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(NOT_FOUND_BODY);

    flushUnknownSession404Counts();
    expect(consoleOutput()).toEqual([
      "[mcp] 404 unknown-session-id window_s=0 total=61 GET=60 POST=1 DELETE=0",
    ]);
  });

  it("counts each method separately", async () => {
    const { writeUnknownSession404, flushUnknownSession404Counts } =
      await import("../server.js");
    const plan: Record<Method, number> = { GET: 2, POST: 3, DELETE: 4 };
    for (const method of METHODS) {
      for (let i = 0; i < plan[method]; i++) {
        writeUnknownSession404(fakeRes().res, unknownReq(method));
      }
    }
    flushUnknownSession404Counts();
    expect(consoleOutput()).toEqual([
      "[mcp] 404 unknown-session-id window_s=0 total=9 GET=2 POST=3 DELETE=4",
    ]);
  });

  it("resets the counts on flush and emits nothing when the count is 0", async () => {
    const { writeUnknownSession404, flushUnknownSession404Counts } =
      await import("../server.js");
    flushUnknownSession404Counts();
    expect(consoleOutput()).toEqual([]);

    writeUnknownSession404(fakeRes().res, unknownReq("DELETE"));
    flushUnknownSession404Counts();
    expect(consoleOutput()).toEqual([
      "[mcp] 404 unknown-session-id window_s=0 total=1 GET=0 POST=0 DELETE=1",
    ]);

    flushUnknownSession404Counts();
    expect(consoleOutput()).toHaveLength(1);

    writeUnknownSession404(fakeRes().res, unknownReq("GET"));
    flushUnknownSession404Counts();
    expect(consoleOutput()).toEqual([
      "[mcp] 404 unknown-session-id window_s=0 total=1 GET=0 POST=0 DELETE=1",
      "[mcp] 404 unknown-session-id window_s=0 total=1 GET=1 POST=0 DELETE=0",
    ]);
  });

  it("reports the whole seconds since the last reset, not the reaper period", async () => {
    const { writeUnknownSession404, flushUnknownSession404Counts } =
      await import("../server.js");
    // A partial window, as on shutdown() or stop().
    writeUnknownSession404(fakeRes().res, unknownReq("GET"));
    clock = T0 + 137_400;
    flushUnknownSession404Counts();

    // An empty flush writes nothing but still starts a new window.
    clock = T0 + 200_000;
    flushUnknownSession404Counts();

    writeUnknownSession404(fakeRes().res, unknownReq("POST"));
    clock = T0 + 211_600;
    flushUnknownSession404Counts();
    expect(consoleOutput()).toEqual([
      "[mcp] 404 unknown-session-id window_s=137 total=1 GET=1 POST=0 DELETE=0",
      "[mcp] 404 unknown-session-id window_s=12 total=1 GET=0 POST=1 DELETE=0",
    ]);
  });
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
