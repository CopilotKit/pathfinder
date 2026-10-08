/**
 * Route-level coverage for the admission limits on modern (2026-07-28) /mcp
 * requests: the per-IP token bucket answers 429 and the in-flight ceiling
 * answers 503. The limits are set through the three `server.modern_*` config
 * keys to values far from the defaults (120 rpm, burst 60, 200 in flight), so
 * a passing test proves the keys are wired and not only the defaults.
 *
 * Boots the real app in-process. The test doubles are the collect tool's
 * insertCollectedData, which a test can hold open to keep a request in flight,
 * and a wrapper on the modern route's classifier, which can wait for the
 * client to close before it returns (see CLOSE_BEFORE_ADMIT).
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  type MockInstance,
} from "vitest";
import http from "node:http";
import { once } from "node:events";
import type { Request } from "express";

const RPM = 30;
const BURST = 3;
const MAX_INFLIGHT = 1;
/**
 * server.modern_request_timeout_ms in this file. Long enough that the held
 * requests in the other ceiling tests stay inside it, short enough that the
 * deadline test does not take long.
 */
const DEADLINE_MS = 1500;
/**
 * How far short of DEADLINE_MS the server's logged deadline time may read.
 * See the deadline test for the measurements behind this value.
 */
const TIMER_CLOCK_SLACK_MS = 5;
/** In `server.allowlist`; no other test uses this address. */
const ALLOWLISTED_IP = "203.0.113.7";

/** Resolves when a held insertCollectedData call starts; set per test. */
const hold: {
  entered: (() => void) | undefined;
  gate: Promise<void> | undefined;
} = { entered: undefined, gate: undefined };

/** Resolves when a never-settling insertCollectedData call starts; set per test. */
const hang: { entered: (() => void) | undefined } = { entered: undefined };

vi.mock("../db/queries.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db/queries.js")>()),
  insertCollectedData: vi.fn(async (_tool: string, data: unknown) => {
    const note =
      typeof data === "object" && data !== null
        ? Reflect.get(data, "note")
        : undefined;
    if (note === "hold") {
      hold.entered?.();
      await hold.gate;
    }
    if (note === "hang") {
      // A tool call that never settles (like bash `sleep 999999`).
      hang.entered?.();
      await new Promise<never>(() => {});
    }
  }),
}));

/**
 * A request with this header makes the wrapped isModern wait until the
 * response has closed (the client went away) before it answers. The route
 * then admits a request whose response is already closed, which is the case
 * where a "finish" or "close" listener attached after admission never fires.
 */
const CLOSE_BEFORE_ADMIT = "x-test-close-before-admit";

/**
 * A request with this header makes the wrapped handle() throw, after the
 * route has admitted the request and taken its ceiling slot.
 */
const THROW_IN_HANDLE = "x-test-throw-in-handle";

/** Resolves when the wrapped isModern starts waiting for the close; set per test. */
const closeWait: { waiting: (() => void) | undefined } = {
  waiting: undefined,
};

vi.mock("../modern-mcp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../modern-mcp.js")>();
  return {
    ...actual,
    createModernMcpRoute: (
      deps: Parameters<typeof actual.createModernMcpRoute>[0],
    ) => {
      const route = actual.createModernMcpRoute(deps);
      return {
        ...route,
        async isModern(req: Request): Promise<boolean> {
          const modern = await route.isModern(req);
          const res = req.res;
          if (req.headers[CLOSE_BEFORE_ADMIT] !== undefined && res) {
            if (!res.closed) {
              closeWait.waiting?.();
              await Promise.race([
                once(res, "close"),
                new Promise((r) => setTimeout(r, 2000)),
              ]);
            }
            // Let any other close handlers run before admission.
            await new Promise((r) => setImmediate(r));
          }
          return modern;
        },
        async handle(...args: Parameters<typeof route.handle>): Promise<void> {
          if (args[0].headers[THROW_IN_HANDLE] !== undefined) {
            throw new Error("test: handle threw after admission");
          }
          return route.handle(...args);
        },
      };
    },
  };
});

vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  getConfig: vi.fn().mockReturnValue({
    port: 0,
    // In-memory PGlite: two runs of this file at the same time (for example
    // two repeat loops) must not open one shared data directory.
    databaseUrl: "pglite://memory://",
    openaiApiKey: "",
    githubToken: "",
    githubWebhookSecret: "",
    nodeEnv: "test",
    logLevel: "info",
    cloneDir: "/tmp/test-mcp-modern-limits",
    slackBotToken: "",
    slackSigningSecret: "",
    discordBotToken: "",
    discordPublicKey: "",
    notionToken: "",
    mcpJwtSecret: "e".repeat(64),
    p2pTelemetryUrl: undefined,
    p2pTelemetryDisabled: true,
    packageVersion: "test",
    modernProtocol: true,
  }),
  getServerConfig: vi.fn().mockReturnValue({
    server: {
      name: "pathfinder-modern-limits",
      version: "0.0.0",
      max_sessions_per_ip: 50,
      session_ttl_minutes: 30,
      allowlist: ["203.0.113.7"],
      trust_proxy: true,
      modern_rpm_per_ip: 30,
      modern_burst_per_ip: 3,
      modern_max_inflight: 1,
      modern_request_timeout_ms: 1500,
    },
    sources: [],
    // The collect tool needs the database, and schema init needs dimensions.
    embedding: { provider: "openai", model: "test", dimensions: 3 },
    tools: [
      {
        name: "collect-note",
        type: "collect",
        description: "Collect a note",
        response: "noted",
        schema: { note: { type: "string", required: true } },
      },
    ],
  }),
  getAnalyticsConfig: vi.fn().mockReturnValue(undefined),
  hasSearchTools: vi.fn().mockReturnValue(false),
  hasKnowledgeTools: vi.fn().mockReturnValue(false),
  hasCollectTools: vi.fn().mockReturnValue(true),
  hasBashSemanticSearch: vi.fn().mockReturnValue(false),
}));

import {
  startInProcessServer,
  type InProcessServer,
} from "./helpers/inProcessServer.js";

type HttpResult = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
};

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "limits-test", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

const MODERN_HEADERS = {
  "MCP-Protocol-Version": "2026-07-28",
};

const TOOLS_LIST = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
  params: { _meta: META },
};

function collectCall(note: string) {
  return {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "collect-note", arguments: { note }, _meta: META },
  };
}

const LEGACY_INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "limits-test-legacy", version: "0.0.0" },
  },
};

let running: InProcessServer | undefined;
let port = 0;
let nextIp = 1;

/** A fresh client IP per test (trust_proxy is on), so each test has its own bucket. */
function freshIp(): string {
  return `198.51.100.${nextIp++}`;
}

/** POST /mcp with the given client IP (via X-Forwarded-For) and extra headers. */
function post(
  ip: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "X-Forwarded-For": ip,
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
    req.write(payload);
    req.end();
  });
}

const modernListHeaders = { ...MODERN_HEADERS, "Mcp-Method": "tools/list" };

function modernList(ip: string): Promise<HttpResult> {
  return post(ip, TOOLS_LIST, modernListHeaders);
}

function modernCollect(ip: string, note: string): Promise<HttpResult> {
  return post(ip, collectCall(note), {
    ...MODERN_HEADERS,
    "Mcp-Method": "tools/call",
    "Mcp-Name": "collect-note",
  });
}

const LISTEN = {
  jsonrpc: "2.0",
  id: 3,
  method: "subscriptions/listen",
  params: { notifications: { toolsListChanged: true }, _meta: META },
};

/**
 * Open a modern subscriptions/listen stream and resolve once its response
 * headers arrive. The stream stays open until close() is called.
 */
function openListen(ip: string): Promise<{
  status: number;
  contentType: string;
  isOpen: () => boolean;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "X-Forwarded-For": ip,
          ...MODERN_HEADERS,
          "Mcp-Method": "subscriptions/listen",
        },
      },
      (res) => {
        let open = true;
        res.on("close", () => (open = false));
        res.resume();
        resolve({
          status: res.statusCode ?? 0,
          contentType: String(res.headers["content-type"] ?? ""),
          isOpen: () => open,
          close: () => req.destroy(),
        });
      },
    );
    // close() destroys the socket, which makes the client side error.
    req.on("error", (e) => reject(e));
    req.write(JSON.stringify(LISTEN));
    req.end();
  });
}

/** Resolve "entered" once `signal` fires, or "timeout" after `ms`. */
function raceTimeout(signal: Promise<void>, ms: number): Promise<string> {
  return Promise.race([
    signal.then(() => "entered"),
    new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), ms)),
  ]);
}

/** Send a modern collect call, and destroy the socket once `until` settles. */
function abortedCollect(
  ip: string,
  note: string,
  extra: Record<string, string>,
  until: Promise<unknown>,
): Promise<void> {
  const payload = JSON.stringify(collectCall(note));
  const req = http.request({
    hostname: "127.0.0.1",
    port,
    path: "/mcp",
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "X-Forwarded-For": ip,
      ...MODERN_HEADERS,
      "Mcp-Method": "tools/call",
      "Mcp-Name": "collect-note",
      ...extra,
    },
  });
  // The abort makes the client side error; that is the point of the test.
  req.on("error", () => {});
  req.write(payload);
  req.end();
  return until.then(() => {
    req.destroy();
  });
}

/**
 * Assert the JSON-RPC error body of a 429 or 503: it echoes the request id,
 * carries the given error code, and its data.retryAfterSeconds equals the
 * Retry-After header (header and body must not disagree).
 */
function expectJsonRpcRejection(
  res: HttpResult | undefined,
  id: number,
  code: number,
): void {
  const body: unknown = JSON.parse(res?.body ?? "");
  expect(body).toMatchObject({ jsonrpc: "2.0", id, error: { code } });
  const header = Number(res?.headers["retry-after"]);
  expect(Number.isInteger(header) && header >= 1).toBe(true);
  expect(body).toMatchObject({
    error: { data: { retryAfterSeconds: header } },
  });
}

let logSpy: MockInstance<typeof console.log> | undefined;
let warnSpy: MockInstance<typeof console.warn> | undefined;

/**
 * The per-tool log lines (logMcpCall) written for one client IP. The modern
 * handler's own "[mcp] modern <method> ..." line is left out.
 */
function mcpLogLines(ip: string): string[] {
  return (logSpy?.mock.calls ?? [])
    .map((args) => String(args[0]))
    .filter(
      (line) =>
        line.startsWith("[mcp] ") &&
        !line.startsWith("[mcp] modern ") &&
        line.endsWith(`[${ip}]`),
    );
}

describe("/mcp routes: modern admission limits", () => {
  beforeAll(async () => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
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

  it("config keys are the values this file assumes", () => {
    // Guard: the limits below are only meaningful if they differ from defaults.
    expect(BURST).not.toBe(60);
    expect(RPM).not.toBe(120);
    expect(MAX_INFLIGHT).not.toBe(200);
    expect(DEADLINE_MS).not.toBe(60000);
  });

  describe("per-IP rate limit", () => {
    it("admits burst requests, then answers 429 with a Retry-After that matches rpm 30", async () => {
      const ip = freshIp();
      const statuses: number[] = [];
      let last: HttpResult | undefined;
      for (let i = 0; i < BURST + 1; i++) {
        last = await modernList(ip);
        statuses.push(last.status);
      }
      expect(statuses).toEqual([200, 200, 200, 429]);
      // rpm 30 refills one token per 2 s. The default rpm 120 would say 1.
      expect(last?.headers["retry-after"]).toBe("2");
      expect(last?.headers["mcp-session-id"]).toBeUndefined();
      // JSON-RPC body: echoes the request id, -32005, and the same retry
      // delay as the header.
      expectJsonRpcRejection(last, TOOLS_LIST.id, -32005);
    });

    it("does not limit an allowlisted IP past the burst", async () => {
      // server.ts passes server.allowlist to the modern limiter. Without it,
      // an allowlisted partner IP would get 429 after the burst.
      const statuses: number[] = [];
      for (let i = 0; i < BURST * 2 + 1; i++) {
        statuses.push((await modernList(ALLOWLISTED_IP)).status);
      }
      expect(statuses).toEqual(Array(BURST * 2 + 1).fill(200));
    });

    it("keeps limiting after the first 429", async () => {
      const ip = freshIp();
      for (let i = 0; i < BURST; i++) await modernList(ip);
      const first = await modernList(ip);
      const second = await modernList(ip);
      expect([first.status, second.status]).toEqual([429, 429]);
    });

    it("limits each IP on its own", async () => {
      const a = freshIp();
      const b = freshIp();
      for (let i = 0; i < BURST; i++) await modernList(a);
      expect((await modernList(a)).status).toBe(429);
      expect((await modernList(b)).status).toBe(200);
    });

    it("does not limit a legacy initialize from an IP whose modern bucket is empty", async () => {
      const ip = freshIp();
      for (let i = 0; i < BURST; i++) await modernList(ip);
      expect((await modernList(ip)).status).toBe(429);

      const legacy = await post(ip, LEGACY_INITIALIZE, {});
      expect(legacy.status).toBe(200);
      expect(typeof legacy.headers["mcp-session-id"]).toBe("string");
      // Close the session so it does not outlive the test.
      const sid = String(legacy.headers["mcp-session-id"]);
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/mcp",
            method: "DELETE",
            headers: { "Mcp-Session-Id": sid, "X-Forwarded-For": ip },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve());
          },
        );
        req.on("error", reject);
        req.end();
      });
    });
  });

  describe("in-flight ceiling", () => {
    it("answers 503 with Retry-After 1 over the ceiling, and admits again once the held request finishes", async () => {
      const ip = freshIp();
      let release: (() => void) | undefined;
      hold.gate = new Promise<void>((resolve) => (release = resolve));
      const entered = new Promise<void>((resolve) => (hold.entered = resolve));
      let held: Promise<HttpResult> | undefined;
      try {
        held = modernCollect(ip, "hold");
        // The held request must be admitted and reach the tool handler.
        expect(await raceTimeout(entered, 2000)).toBe("entered");

        const over = await modernList(ip);
        expect(over.status).toBe(503);
        expect(over.headers["retry-after"]).toBe("1");
        expect(over.headers["mcp-session-id"]).toBeUndefined();
        // JSON-RPC body: echoes the request id, -32006 (not the rate-limit
        // code), and the same retry delay as the header.
        expectJsonRpcRejection(over, TOOLS_LIST.id, -32006);
        // The 503 is not logged as a call. The held request's line is the
        // positive control: the log path works for this IP.
        expect(mcpLogLines(ip)).toEqual([
          `[mcp] collect-note({"note":"hold"}) [${ip}]`,
        ]);
      } finally {
        release?.();
      }

      const heldRes = await held;
      expect(heldRes?.status).toBe(200);

      // The slot was released: the next request is admitted.
      const after = await modernList(ip);
      expect(after.status).toBe(200);
    });

    it("keeps the slot after the client aborts a held request, until the handler returns", async () => {
      // The ceiling bounds handler work, not open responses. A client that
      // aborts a request must not free the slot while the tool still runs:
      // abort-and-repeat would otherwise run any number of handlers at once.
      let release: (() => void) | undefined;
      hold.gate = new Promise<void>((resolve) => (release = resolve));
      const entered = new Promise<void>((resolve) => (hold.entered = resolve));
      try {
        const aborted = abortedCollect(freshIp(), "hold", {}, entered);
        expect(await raceTimeout(entered, 2000)).toBe("entered");
        // Control: while the request is held, the ceiling is full.
        expect((await modernList(freshIp())).status).toBe(503);
        await aborted;

        // Give the server time to see the close. The handler is still held,
        // so the slot is still taken.
        await new Promise((r) => setTimeout(r, 200));
        expect((await modernList(freshIp())).status).toBe(503);
      } finally {
        release?.();
      }

      // The handler returns once the tool settles; then the slot frees.
      await expect
        .poll(async () => (await modernList(freshIp())).status, {
          timeout: 2000,
        })
        .toBe(200);
    });

    it("does not count an open subscriptions/listen stream against the ceiling", async () => {
      // A listen stream is an open-ended SSE response. If it held a ceiling
      // slot, MAX_INFLIGHT (1) open streams would make every other modern
      // request answer 503 for as long as the streams stay open.
      const listen = await openListen(freshIp());
      try {
        // Positive control: the listen request was admitted and is streaming.
        expect(listen.status).toBe(200);
        expect(listen.contentType).toMatch(/text\/event-stream/);

        const other = await modernList(freshIp());
        expect(other.status).toBe(200);
      } finally {
        listen.close();
      }
    });

    it("releases the slot for a request whose response closed before admission", async () => {
      const ip = freshIp();
      const waiting = new Promise<void>(
        (resolve) => (closeWait.waiting = resolve),
      );
      // The socket is destroyed only once the server holds the request in
      // isModern, so the close lands before admission every time.
      await abortedCollect(
        ip,
        "closed-early",
        { [CLOSE_BEFORE_ADMIT]: "1" },
        waiting,
      );

      // The admitted request's response had already closed, so no later
      // "close" or "finish" event can release it. The slot must still free.
      await expect
        .poll(async () => (await modernList(freshIp())).status, {
          timeout: 2000,
        })
        .toBe(200);
      // Positive control: the closed request was admitted and reached the
      // per-tool log, so it did take the slot.
      expect(mcpLogLines(ip)).toEqual([
        `[mcp] collect-note({"note":"closed-early"}) [${ip}]`,
      ]);
    });

    // Slot lifecycle table: each exit path below must leave the single slot
    // free, checked by a tools/list from a fresh IP. Covered elsewhere in
    // this describe: normal finish (the first 503 test), client abort (held
    // until the handler returns), close before admission, open listen stream
    // (not counted), and the deadline (the last test).
    it("frees the slot when the handler throws after admission", async () => {
      const ip = freshIp();
      const thrown = await post(ip, collectCall("throws"), {
        ...MODERN_HEADERS,
        "Mcp-Method": "tools/call",
        "Mcp-Name": "collect-note",
        [THROW_IN_HANDLE]: "1",
      });
      // Positive control: the request was admitted (it reached the per-tool
      // log, which runs after the slot is taken) and the throw became a 500.
      expect(thrown.status).toBe(500);
      expect(mcpLogLines(ip)).toEqual([
        `[mcp] collect-note({"note":"throws"}) [${ip}]`,
      ]);

      expect((await modernList(freshIp())).status).toBe(200);
    });

    it("does not take a slot for a request rejected with 429", async () => {
      const ip = freshIp();
      for (let i = 0; i < BURST; i++) await modernList(ip);
      // Positive control: this request was rejected by the rate limit.
      expect((await modernList(ip)).status).toBe(429);

      expect((await modernList(freshIp())).status).toBe(200);
    });

    it("does not take a slot for a request rejected with 503, even after the slot frees", async () => {
      let release: (() => void) | undefined;
      hold.gate = new Promise<void>((resolve) => (release = resolve));
      const entered = new Promise<void>((resolve) => (hold.entered = resolve));
      let held: Promise<HttpResult> | undefined;
      try {
        held = modernCollect(freshIp(), "hold");
        expect(await raceTimeout(entered, 2000)).toBe("entered");
        // Positive control: this request was rejected by the ceiling.
        expect((await modernList(freshIp())).status).toBe(503);
      } finally {
        release?.();
      }
      expect((await held)?.status).toBe(200);

      // Wait past the release, so a rejected request that took the slot
      // late (for example by waiting for it) would already hold it.
      await new Promise((r) => setTimeout(r, 100));
      expect((await modernList(freshIp())).status).toBe(200);
    });

    it(
      "does not apply the deadline to an open subscriptions/listen stream",
      async () => {
        // A listen stream holds no slot (see above), so the deadline has no
        // slot to release, and a warn line saying it released one is false.
        const ip = freshIp();
        const listen = await openListen(ip);
        try {
          // Positive control: the listen request was admitted and is streaming.
          expect(listen.status).toBe(200);
          expect(listen.contentType).toMatch(/text\/event-stream/);
          await new Promise((r) => setTimeout(r, DEADLINE_MS + 500));
          // Still open past the deadline.
          expect(listen.isOpen()).toBe(true);
          const listenLines = (warnSpy?.mock.calls ?? [])
            .map((args) => String(args[0]))
            .filter(
              (line) =>
                line.includes("subscriptions/listen") &&
                line.includes("exceeded the"),
            );
          expect(listenLines).toEqual([]);
        } finally {
          listen.close();
        }
        // The test waits past the deadline on purpose, so it needs more than
        // the 5 s default under load.
      },
      DEADLINE_MS + 8000,
    );

    // Keep this test last: at a commit without the deadline, the
    // never-settling call holds the only slot for the rest of the file.
    it("frees the slot of a tool call that never settles once the request deadline passes, and logs it", async () => {
      const ip = freshIp();
      const entered = new Promise<void>((resolve) => (hang.entered = resolve));
      const start = Date.now();
      const aborted = abortedCollect(ip, "hang", {}, entered);
      // Positive control: the call was admitted and reached the tool.
      expect(await raceTimeout(entered, 2000)).toBe("entered");
      await aborted;
      // Before the deadline the never-settling call holds the slot (A2: an
      // abort does not free it).
      expect((await modernList(freshIp())).status).toBe(503);

      const waitMs = DEADLINE_MS + 200 - (Date.now() - start);
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
      await expect
        .poll(async () => (await modernList(freshIp())).status, {
          timeout: 3000,
        })
        .toBe(200);

      const deadlineLines = (warnSpy?.mock.calls ?? [])
        .map((args) => String(args[0]))
        .filter((line) => line.includes("exceeded the"));
      expect(deadlineLines).toHaveLength(1);
      expect(deadlineLines[0]).toMatch(
        new RegExp(
          `^\\[mcp\\] modern tools/call tool=collect-note exceeded the ${DEADLINE_MS}ms deadline after (\\d+)ms, releasing its slot \\[${ip.replace(/\./g, "\\.")}\\]$`,
        ),
      );
      // The logged time is Date.now() at expiry minus a Date.now() taken
      // before the request's work starts; the deadline timer is armed after
      // that. It can still read slightly under DEADLINE_MS: CI logged "after
      // 1499ms" (1 ms short). In 60 local runs under full CPU load the
      // logged time was 1500-1506 ms, never short. The cause of the 1 ms in
      // CI is not established; millisecond rounding is one candidate. The
      // slack of TIMER_CLOCK_SLACK_MS (1 ms observed, plus margin) lets a
      // deadline that logs up to that many ms early pass. A deadline that
      // fires earlier than that still fails here.
      const elapsed = Number(/after (\d+)ms/.exec(deadlineLines[0])?.[1]);
      expect(elapsed).toBeGreaterThanOrEqual(
        DEADLINE_MS - TIMER_CLOCK_SLACK_MS,
      );
    });
  });
});
