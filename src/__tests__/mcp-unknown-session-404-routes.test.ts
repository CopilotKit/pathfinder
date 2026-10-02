/**
 * Route-level coverage for the unknown-session 404 on /mcp. Boots the real
 * app in-process with startInProcessServer() and drives POST/GET/DELETE /mcp over
 * HTTP, so deleting or inverting a route's 404 branch, or reverting the POST
 * initialize gate, fails a test. The helper-level tests live in
 * mcp-unknown-session-404.test.ts.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  type MockInstance,
} from "vitest";
import http from "node:http";
import net from "node:net";

vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  getConfig: vi.fn().mockReturnValue({
    port: 0,
    databaseUrl: "pglite:///tmp/test-mcp-unknown-session-404-routes",
    openaiApiKey: "",
    githubToken: "",
    githubWebhookSecret: "",
    nodeEnv: "test",
    logLevel: "info",
    cloneDir: "/tmp/test-mcp-unknown-session-404-routes",
    slackBotToken: "",
    slackSigningSecret: "",
    discordBotToken: "",
    discordPublicKey: "",
    notionToken: "",
    mcpJwtSecret: "e".repeat(64),
    p2pTelemetryUrl: undefined,
    p2pTelemetryDisabled: true,
    packageVersion: "test",
  }),
  getServerConfig: vi.fn().mockReturnValue({
    server: {
      name: "pathfinder-unknown-session-routes",
      version: "0.0.0",
      max_sessions_per_ip: 50,
      session_ttl_minutes: 30,
      allowlist: [],
      trust_proxy: false,
    },
    sources: [],
    tools: [],
  }),
  getAnalyticsConfig: vi.fn().mockReturnValue(undefined),
  hasSearchTools: vi.fn().mockReturnValue(false),
  hasKnowledgeTools: vi.fn().mockReturnValue(false),
  hasCollectTools: vi.fn().mockReturnValue(false),
  hasBashSemanticSearch: vi.fn().mockReturnValue(false),
}));

import type { Response } from "express";
import {
  __resetUnknownSession404CountsForTesting,
  flushUnknownSession404Counts,
  SESSION_REAPER_INTERVAL_MS,
  writeUnknownSession404,
} from "../server.js";
import {
  startInProcessServer,
  type InProcessServer,
} from "./helpers/inProcessServer.js";

type Method = "POST" | "GET" | "DELETE";
const METHODS: Method[] = ["POST", "GET", "DELETE"];
const SID = "deadbeef-0000-4000-8000-000000000000";

const PROTOTYPE_KEY_SIDS = [
  "constructor",
  "__proto__",
  "toString",
  "hasOwnProperty",
];

/** The 404 body. POST echoes a string or number request id; GET and DELETE carry no body, so their id is null. */
function notFoundBody(id: string | number | null) {
  return {
    jsonrpc: "2.0",
    error: { code: -32001, message: "Session not found" },
    id,
  };
}

/** The answer to a request with no (or an empty) session header. */
function noSessionBody(message: string) {
  return { jsonrpc: "2.0", error: { code: -32000, message }, id: null };
}

const NO_SESSION_ANSWERS = [
  [
    "POST",
    400,
    "Bad Request: No valid session. Send an initialize request first.",
  ],
  ["GET", 405, "Method Not Allowed"],
  ["DELETE", 400, "Missing session ID"],
] as const;

function expectedIdFor(method: Method): number | null {
  return method === "POST" ? TOOLS_LIST.id : null;
}

const TOOLS_LIST = { jsonrpc: "2.0", id: 1, method: "tools/list" };
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "route-test", version: "0.0.0" },
  },
};

let running: InProcessServer | undefined;
let port = 0;
let warnSpy: MockInstance<typeof console.warn> | undefined;
let logSpy: MockInstance<typeof console.log> | undefined;
let errorSpy: MockInstance<typeof console.error> | undefined;
/** The callback startServer() scheduled as the session reaper tick. */
let reaperTick: (() => void) | undefined;

type HttpResult = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
};

/** Send one request to /mcp and collect its status, headers and body. */
function mcpRequest(
  method: Method,
  headers: Record<string, string>,
  body?: unknown,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/mcp",
        method,
        headers: {
          Accept: "application/json, text/event-stream",
          ...(payload ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: data,
          }),
        );
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Resolve with the status as soon as the response headers arrive, then drop
 * the connection. A GET on a live session opens an SSE stream that never
 * ends, so mcpRequest() would hang on it.
 */
function mcpStatusOnly(
  method: Method,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/mcp",
        method,
        headers: {
          Accept: "application/json, text/event-stream",
          ...headers,
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.resume();
        req.destroy();
        resolve(status);
      },
    );
    req.on("error", (err: NodeJS.ErrnoException) => {
      // The destroy() above can surface as a reset after resolve(); ignore it.
      if (err.code !== "ECONNRESET") reject(err);
    });
    req.end();
  });
}

/**
 * Send one raw HTTP/1.1 request whose Mcp-Session-Id header carries `sid`
 * byte for byte (latin1), which http.request() refuses to do for control
 * characters. A POST carries bodyFor("POST") as its JSON body. Resolves with
 * the response status.
 */
function rawSessionRequest(method: Method, sid: string): Promise<number> {
  const body = bodyFor(method);
  const payload = body === undefined ? "" : JSON.stringify(body);
  const bodyHeaders = payload
    ? "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(payload)}\r\n`
    : "";
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        Buffer.from(
          `${method} /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
            "Accept: application/json, text/event-stream\r\n" +
            bodyHeaders +
            `Mcp-Session-Id: ${sid}\r\nConnection: close\r\n\r\n` +
            payload,
          "latin1",
        ),
      );
    });
    let data = "";
    socket.on("data", (chunk: Buffer) => (data += chunk.toString("latin1")));
    socket.on("end", () => {
      const m = /^HTTP\/1\.1 (\d{3}) /.exec(data);
      if (m) resolve(Number(m[1]));
      else reject(new Error(`no status line in ${JSON.stringify(data)}`));
    });
    socket.on("error", reject);
  });
}

/** Every string written to console.warn/log/error since their last clear. */
function consoleOutput(): string[] {
  return [warnSpy, logSpy, errorSpy].flatMap((spy) =>
    (spy?.mock.calls ?? []).map((args: unknown[]) =>
      args.map(String).join(" "),
    ),
  );
}

function unknownSessionLines(spy: MockInstance<typeof console.warn>): string[] {
  return spy.mock.calls
    .map((args) => String(args[0]))
    .filter((l) => l.startsWith("[mcp] 404 unknown-session-id"));
}

/**
 * Check that each 404 flush line reports a real elapsed window: an integer
 * number of seconds below 60, far below the 5 minute reaper period, since
 * every window here starts at boot or at a reset in the same test. Return
 * the lines with the number replaced by "N", so a test can compare the
 * counts exactly.
 */
function withWindowN(lines: string[]): string[] {
  return lines.map((line) => {
    const m = /^\[mcp\] 404 unknown-session-id window_s=(\d+) /.exec(line);
    if (!m) throw new Error(`no window_s field in ${JSON.stringify(line)}`);
    expect(Number(m[1])).toBeLessThan(60);
    return line.replace(/window_s=\d+/, "window_s=N");
  });
}

/** Initialize a new session and return its id. */
async function initializeSession(
  headers: Record<string, string> = {},
): Promise<{ res: HttpResult; sid: string | undefined }> {
  const res = await mcpRequest("POST", headers, INITIALIZE);
  const raw = res.headers["mcp-session-id"];
  return { res, sid: typeof raw === "string" ? raw : undefined };
}

function bodyFor(method: Method): unknown {
  return method === "POST" ? TOOLS_LIST : undefined;
}

describe("/mcp routes: unknown session id", () => {
  beforeAll(async () => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const realSetInterval = globalThis.setInterval;
    // Capture the reaper tick so a test can run it on demand.
    vi.spyOn(globalThis, "setInterval").mockImplementation(((
      ...args: Parameters<typeof setInterval>
    ) => {
      const [callback, ms] = args;
      if (ms === SESSION_REAPER_INTERVAL_MS && typeof callback === "function") {
        reaperTick = () => callback();
      }
      return realSetInterval(...args);
    }) as typeof setInterval);
    running = await startInProcessServer();
    port = Number(new URL(running.baseUrl).port);
  });

  afterAll(async () => {
    try {
      await running?.stop();
    } finally {
      running = undefined;
      vi.restoreAllMocks();
    }
  });

  beforeEach(() => {
    __resetUnknownSession404CountsForTesting();
  });

  it.each(METHODS)(
    "%s with an unknown session id returns 404 and the -32001 body",
    async (method) => {
      const res = await mcpRequest(
        method,
        { "Mcp-Session-Id": SID },
        bodyFor(method),
      );
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toEqual(notFoundBody(expectedIdFor(method)));
    },
  );

  describe.each(METHODS)("%s with a prototype-key session id", (method) => {
    it.each(PROTOTYPE_KEY_SIDS)("'%s' returns 404", async (sid) => {
      const res = await mcpRequest(
        method,
        { "Mcp-Session-Id": sid },
        bodyFor(method),
      );
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toEqual(notFoundBody(expectedIdFor(method)));
    });
  });

  it.each([
    ["a string id", "req-7", "req-7"],
    ["a number id", 42, 42],
    ["no id", undefined, null],
    ["a null id", null, null],
    ["an object id", { nested: 1 }, null],
  ] as const)(
    "POST 404 for an unknown session with %s answers with id %j",
    async (_label, id, expected) => {
      const body =
        id === undefined
          ? { jsonrpc: "2.0", method: "tools/list" }
          : { jsonrpc: "2.0", id, method: "tools/list" };
      const res = await mcpRequest("POST", { "Mcp-Session-Id": SID }, body);
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toEqual(notFoundBody(expected));
    },
  );

  it("a live session routes POST and GET, and DELETE tears it down", async () => {
    const { res: init, sid } = await initializeSession();
    expect(init.status).toBe(200);
    expect(typeof sid).toBe("string");
    let deleted = false;
    try {
      const live = { "Mcp-Session-Id": String(sid) };

      const list = await mcpRequest("POST", live, TOOLS_LIST);
      expect(list.status).toBe(200);
      expect(list.body).not.toContain("Session not found");
      // A 200 JSON-RPC reply with the request id and no "Session not found"
      // comes from the live transport, not the unknown-session 404.
      expect(JSON.parse(list.body)).toMatchObject({
        jsonrpc: "2.0",
        id: TOOLS_LIST.id,
      });

      // A live GET opens the SSE stream: 200, never the unknown-session 404.
      const getStatus = await mcpStatusOnly("GET", live);
      expect(getStatus).toBe(200);

      const del = await mcpRequest("DELETE", live);
      expect(del.status).toBe(200);
      deleted = true;

      // Once deleted, the id is unknown again.
      const after = await mcpRequest("POST", live, TOOLS_LIST);
      expect(after.status).toBe(404);
    } finally {
      if (!deleted && typeof sid === "string") {
        await mcpRequest("DELETE", { "Mcp-Session-Id": sid });
      }
    }
  });

  it("POST initialize with a stale session id starts a new session", async () => {
    const { res, sid: newSid } = await initializeSession({
      "Mcp-Session-Id": SID,
    });
    expect(res.status).toBe(200);
    let deleted = false;
    try {
      expect(typeof newSid).toBe("string");
      expect(newSid).not.toBe(SID);
      expect(res.body).not.toContain("Session not found");

      // The new session is live, and the stale id was not registered.
      const live = await mcpRequest(
        "POST",
        { "Mcp-Session-Id": String(newSid) },
        TOOLS_LIST,
      );
      expect(live.status).toBe(200);
      const stale = await mcpRequest(
        "POST",
        { "Mcp-Session-Id": SID },
        TOOLS_LIST,
      );
      expect(stale.status).toBe(404);
      expect(JSON.parse(stale.body)).toEqual(notFoundBody(TOOLS_LIST.id));

      // Tear the new session down through the real DELETE route.
      const del = await mcpRequest("DELETE", {
        "Mcp-Session-Id": String(newSid),
      });
      expect(del.status).toBe(200);
      deleted = true;
    } finally {
      if (!deleted && typeof newSid === "string") {
        await mcpRequest("DELETE", { "Mcp-Session-Id": newSid });
      }
    }
  });

  it("the flush writes one line with the per-method unknown-session 404 counts", async () => {
    const counts: Record<Method, number> = { POST: 3, GET: 2, DELETE: 1 };
    for (const method of METHODS) {
      for (let i = 0; i < counts[method]; i++) {
        const res = await mcpRequest(
          method,
          { "Mcp-Session-Id": `${SID}-${method}-${i}` },
          bodyFor(method),
        );
        expect(res.status).toBe(404);
      }
    }
    // A request with no session header is not an unknown-session 404.
    await mcpRequest("GET", {});

    const spy = warnSpy;
    if (!spy) throw new Error("console.warn spy not installed");
    spy.mockClear();
    flushUnknownSession404Counts();
    expect(withWindowN(unknownSessionLines(spy))).toEqual([
      "[mcp] 404 unknown-session-id window_s=N total=6 GET=2 POST=3 DELETE=1",
    ]);

    // The flush resets the counts, so a second flush writes nothing.
    spy.mockClear();
    flushUnknownSession404Counts();
    expect(spy).not.toHaveBeenCalled();
  });

  it("the reaper tick flushes the unknown-session 404 counts", async () => {
    const tick = reaperTick;
    const spy = warnSpy;
    if (!tick) throw new Error("reaper interval was not scheduled at boot");
    if (!spy) throw new Error("console.warn spy not installed");
    for (const method of METHODS) {
      const res = await mcpRequest(
        method,
        { "Mcp-Session-Id": SID },
        bodyFor(method),
      );
      expect(res.status).toBe(404);
    }
    spy.mockClear();
    tick();
    expect(withWindowN(unknownSessionLines(spy))).toEqual([
      "[mcp] 404 unknown-session-id window_s=N total=3 GET=1 POST=1 DELETE=1",
    ]);
  });

  it("logs no session id bytes or client ip, even for ids with newlines or control characters", async () => {
    const MARKER = "E1MARKERSID";
    // Node's HTTP parser answers 400 to a header value with LF, CR or a C0
    // control other than tab, so those never reach the route. Tab and
    // obs-text bytes (0x80-0xff) do, and get the unknown-session 404.
    const rejectedByParser = [
      `${MARKER}\n[mcp] forged line sid=x`,
      `${MARKER}\r\n folded`,
      `${MARKER}\u0001\u007fkey=value`,
      `${MARKER}\u001b[31mred`,
    ];
    const reachRoute = [`${MARKER}\tkey=value`, `${MARKER}\u00ff\u00fezz`];
    warnSpy?.mockClear();
    logSpy?.mockClear();
    errorSpy?.mockClear();
    for (const sid of rejectedByParser) {
      expect(await rawSessionRequest("GET", sid)).toBe(400);
    }
    for (const sid of reachRoute) {
      for (const method of METHODS) {
        expect(await rawSessionRequest(method, sid)).toBe(404);
      }
    }
    flushUnknownSession404Counts();

    const output = consoleOutput();
    expect(
      withWindowN(
        output.filter((l) => l.startsWith("[mcp] 404 unknown-session-id")),
      ),
    ).toEqual([
      "[mcp] 404 unknown-session-id window_s=N total=6 GET=2 POST=2 DELETE=2",
    ]);
    const joined = output.join("\n");
    for (const needle of [
      MARKER,
      "forged",
      "key=value",
      "folded",
      "127.0.0.1",
      "\t",
      "\r",
      "\u0001",
      "\u001b",
      "\u00ff",
    ]) {
      expect(joined).not.toContain(needle);
    }
  });

  it.each(NO_SESSION_ANSWERS)(
    "%s with no session header keeps its %i",
    async (method, status, message) => {
      const res = await mcpRequest(method, {}, bodyFor(method));
      expect(res.status).toBe(status);
      expect(JSON.parse(res.body)).toEqual(noSessionBody(message));
    },
  );

  // An empty header is falsy, so it is treated the same as no header.
  it.each(NO_SESSION_ANSWERS)(
    "%s with an empty session id is handled as no header (%i)",
    async (method, status, message) => {
      const res = await mcpRequest(
        method,
        { "Mcp-Session-Id": "" },
        bodyFor(method),
      );
      expect(res.status).toBe(status);
      expect(JSON.parse(res.body)).toEqual(noSessionBody(message));
    },
  );

  // POST and DELETE /mcp sit behind bearerMiddleware, which answers 401 to a
  // Bearer token that is present but invalid before the route looks at the
  // session id. GET /mcp has no auth middleware, so it reaches the 404.
  it.each([
    ["POST", 401],
    ["GET", 404],
    ["DELETE", 401],
  ] as const)(
    "%s with an invalid bearer token and an unknown session id answers %i",
    async (method, status) => {
      const res = await mcpRequest(
        method,
        { Authorization: "Bearer not-a-jwt", "Mcp-Session-Id": SID },
        bodyFor(method),
      );
      expect(res.status).toBe(status);
      const spy = warnSpy;
      if (!spy) throw new Error("console.warn spy not installed");
      spy.mockClear();
      flushUnknownSession404Counts();
      expect(withWindowN(unknownSessionLines(spy))).toEqual(
        status === 404
          ? [
              "[mcp] 404 unknown-session-id window_s=N total=1 GET=1 POST=0 DELETE=0",
            ]
          : [],
      );
    },
  );
});

// Self-contained: boots its own server, so it passes when run alone. It runs
// after the suite above has stopped its server, so one server runs at a time.
describe("teardown hygiene", () => {
  it("stop() removes its signal listeners, clears its intervals and writes the pending 404 counts", async () => {
    const baseSigint = process.listenerCount("SIGINT");
    const baseSigterm = process.listenerCount("SIGTERM");
    const created: unknown[] = [];
    const cleared = new Set<unknown>();
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Both spies stay in place until after stop(), so intervals created after
    // boot (by fire-and-forget boot work or by requests) are recorded too.
    vi.spyOn(globalThis, "setInterval").mockImplementation(((
      ...args: Parameters<typeof setInterval>
    ) => {
      const h = realSetInterval(...args);
      created.push(h);
      return h;
    }) as typeof setInterval);
    vi.spyOn(globalThis, "clearInterval").mockImplementation(((
      h: Parameters<typeof clearInterval>[0],
    ) => {
      cleared.add(h);
      realClearInterval(h);
    }) as typeof clearInterval);
    try {
      __resetUnknownSession404CountsForTesting();
      const server = await startInProcessServer();
      try {
        expect(process.listenerCount("SIGINT")).toBe(baseSigint + 1);
        expect(process.listenerCount("SIGTERM")).toBe(baseSigterm + 1);
        expect(created.length).toBeGreaterThan(0);
        // Leave unflushed unknown-session 404 counts for stop() to write.
        port = Number(new URL(server.baseUrl).port);
        expect(
          (await mcpRequest("GET", { "Mcp-Session-Id": `${SID}-stop-1` }))
            .status,
        ).toBe(404);
        expect(
          (await mcpRequest("DELETE", { "Mcp-Session-Id": `${SID}-stop-2` }))
            .status,
        ).toBe(404);
        warn.mockClear();
      } finally {
        await server.stop();
      }
      expect(withWindowN(unknownSessionLines(warn))).toEqual([
        "[mcp] 404 unknown-session-id window_s=N total=2 GET=1 POST=0 DELETE=1",
      ]);
      expect(process.listenerCount("SIGINT")).toBe(baseSigint);
      expect(process.listenerCount("SIGTERM")).toBe(baseSigterm);
      expect(created.filter((h) => !cleared.has(h))).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("boot starts a new 404 window and drops the counts from before boot", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Start a window 1000 s ago and leave one count in it, before boot.
      const realNow = Date.now.bind(Date);
      const nowSpy = vi
        .spyOn(Date, "now")
        .mockImplementation(() => realNow() - 1_000_000);
      __resetUnknownSession404CountsForTesting();
      nowSpy.mockRestore();
      const fakeRes = { status: () => fakeRes, json: () => fakeRes };
      writeUnknownSession404(fakeRes as unknown as Response, {
        method: "POST",
      });

      const server = await startInProcessServer();
      try {
        port = Number(new URL(server.baseUrl).port);
        expect(
          (await mcpRequest("GET", { "Mcp-Session-Id": `${SID}-boot` })).status,
        ).toBe(404);
        warn.mockClear();
        flushUnknownSession404Counts();
        // withWindowN() also checks that window_s is far below 1000.
        expect(withWindowN(unknownSessionLines(warn))).toEqual([
          "[mcp] 404 unknown-session-id window_s=N total=1 GET=1 POST=0 DELETE=0",
        ]);
      } finally {
        await server.stop();
      }
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("stop() closes a connection that still has a response in flight", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    let stream: http.ClientRequest | undefined;
    try {
      __resetUnknownSession404CountsForTesting();
      const server = await startInProcessServer();
      let stopped = false;
      try {
        port = Number(new URL(server.baseUrl).port);
        const { sid } = await initializeSession();
        if (typeof sid !== "string") throw new Error("no session id");
        // A live GET opens an SSE stream that never ends on its own. Its
        // connection is not idle, so server.close() alone waits for it.
        const res = await new Promise<http.IncomingMessage>(
          (resolve, reject) => {
            stream = http.request(
              {
                hostname: "127.0.0.1",
                port,
                path: "/mcp",
                method: "GET",
                headers: {
                  Accept: "text/event-stream",
                  "Mcp-Session-Id": sid,
                },
              },
              resolve,
            );
            stream.on("error", reject);
            stream.end();
          },
        );
        expect(res.statusCode).toBe(200);
        // When stop() cuts the stream, the response emits "aborted" as an
        // error and then "close". The cut is the expected outcome here.
        stream?.removeAllListeners("error");
        stream?.on("error", () => {});
        let aborted = false;
        res.on("error", () => (aborted = true));
        const streamClosed = new Promise<void>((resolve) =>
          res.on("close", () => resolve()),
        );

        const outcome = await Promise.race([
          server.stop().then(() => "stopped" as const),
          new Promise<"timed out">((resolve) =>
            setTimeout(() => resolve("timed out"), 2000),
          ),
        ]);
        stopped = outcome === "stopped";
        expect(outcome).toBe("stopped");
        await streamClosed;
        expect(aborted).toBe(true);
      } finally {
        if (!stopped) {
          stream?.destroy();
          await server.stop();
        }
      }
    } finally {
      stream?.destroy();
      vi.restoreAllMocks();
    }
  });

  it("shutdown() writes the pending 404 counts before it exits", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const before = new Set(process.listeners("SIGTERM"));
    let exitSpy: MockInstance<typeof process.exit> | undefined;
    try {
      __resetUnknownSession404CountsForTesting();
      const server = await startInProcessServer();
      try {
        // The SIGTERM listener that this boot added calls shutdown().
        const added = process
          .listeners("SIGTERM")
          .filter((l) => !before.has(l));
        expect(added).toHaveLength(1);
        port = Number(new URL(server.baseUrl).port);
        for (const method of ["POST", "DELETE"] as const) {
          const res = await mcpRequest(
            method,
            { "Mcp-Session-Id": `${SID}-shutdown` },
            bodyFor(method),
          );
          expect(res.status).toBe(404);
        }
        // shutdown() ends with process.exit(0). Stub it in this test only.
        let onExit: (
          code: number | string | null | undefined,
        ) => void = () => {};
        const exited = new Promise<number | string | null | undefined>(
          (resolve) => (onExit = resolve),
        );
        exitSpy = vi
          .spyOn(process, "exit")
          .mockImplementation(((code) => onExit(code)) as typeof process.exit);
        warn.mockClear();
        added[0]("SIGTERM");
        expect(await exited).toBe(0);
        // Checked before stop(), which flushes too.
        expect(withWindowN(unknownSessionLines(warn))).toEqual([
          "[mcp] 404 unknown-session-id window_s=N total=2 GET=0 POST=1 DELETE=1",
        ]);
      } finally {
        exitSpy?.mockRestore();
        await server.stop();
      }
    } finally {
      vi.restoreAllMocks();
    }
  });
});
