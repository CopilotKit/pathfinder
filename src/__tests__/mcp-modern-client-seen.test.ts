/**
 * Route-level coverage for the `pathfinder.client.seen` emit on the modern
 * (2026-07-28, stateless) leg of /mcp. Boots the real app in-process and
 * points p2pTelemetryUrl at a node:http sink that the test starts, so the real
 * P2PTelemetry, ClientSeenDeduper and fetch run end to end. Nothing here
 * mocks them. Each describe boots its own server from a fresh module graph,
 * because modernProtocol and trust_proxy are read at startup.
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

const state = vi.hoisted(() => ({
  modernProtocol: true,
  trustProxy: false,
  p2pTelemetryUrl: undefined as string | undefined,
  modernBurst: undefined as number | undefined,
  modernMaxInflight: undefined as number | undefined,
  collectTool: false,
  bootNo: 0,
}));

/**
 * Lets a test keep a modern collect call in flight: insertCollectedData for
 * the note "hold" calls entered() and then waits on gate.
 */
const hold = vi.hoisted(() => ({
  entered: undefined as (() => void) | undefined,
  gate: undefined as Promise<void> | undefined,
}));

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
  }),
}));

const JWT_SECRET = "e".repeat(64);

vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  getConfig: vi.fn(() => ({
    port: 0,
    databaseUrl: `pglite:///tmp/test-mcp-modern-client-seen-${state.bootNo}`,
    openaiApiKey: "",
    githubToken: "",
    githubWebhookSecret: "",
    nodeEnv: "test",
    logLevel: "info",
    cloneDir: `/tmp/test-mcp-modern-client-seen-${state.bootNo}`,
    slackBotToken: "",
    slackSigningSecret: "",
    discordBotToken: "",
    discordPublicKey: "",
    notionToken: "",
    mcpJwtSecret: "e".repeat(64),
    p2pTelemetryUrl: state.p2pTelemetryUrl,
    p2pTelemetryDisabled: false,
    modernProtocol: state.modernProtocol,
    packageVersion: "test",
  })),
  getServerConfig: vi.fn(() => ({
    server: {
      name: "pathfinder-modern-client-seen",
      version: "0.0.0",
      max_sessions_per_ip: 50,
      session_ttl_minutes: 30,
      allowlist: [],
      trust_proxy: state.trustProxy,
      ...(state.modernBurst !== undefined && {
        modern_burst_per_ip: state.modernBurst,
      }),
      ...(state.modernMaxInflight !== undefined && {
        modern_max_inflight: state.modernMaxInflight,
      }),
    },
    sources: [],
    ...(state.collectTool && {
      // The collect tool needs the database, and schema init needs dimensions.
      embedding: { provider: "openai", model: "test", dimensions: 3 },
    }),
    tools: state.collectTool
      ? [
          {
            name: "collect-note",
            type: "collect",
            description: "Collect a note",
            response: "noted",
            schema: { note: { type: "string", required: true } },
          },
        ]
      : [],
  })),
  getAnalyticsConfig: vi.fn().mockReturnValue(undefined),
  hasSearchTools: vi.fn().mockReturnValue(false),
  hasKnowledgeTools: vi.fn().mockReturnValue(false),
  hasCollectTools: vi.fn(() => state.collectTool),
  hasBashSemanticSearch: vi.fn().mockReturnValue(false),
}));

import { signJWT } from "../oauth/jwt.js";

type SinkEvent = {
  event: string;
  properties: Record<string, unknown>;
};

type HttpResult = { status: number; body: string };

const SETTLE_MS = 300;
const POLL_TIMEOUT_MS = 3000;

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": {
    name: "client-seen-test",
    version: "0",
  },
  "io.modelcontextprotocol/clientCapabilities": {},
};
const MODERN_TOOLS_LIST = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
  params: { _meta: META },
};
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "client-seen-test", version: "0.0.0" },
  },
};

/** An in-process telemetry sink that records every POSTed event. */
class Sink {
  readonly events: SinkEvent[] = [];
  private readonly server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        this.events.push(JSON.parse(data) as SinkEvent);
      } catch {
        // A malformed body is recorded as nothing; the tests then fail on counts.
      }
      res.statusCode = 200;
      res.end("ok");
    });
  });
  url = "";

  async start(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server.listen(0, "127.0.0.1", resolve),
    );
    const addr = this.server.address();
    if (addr === null || typeof addr === "string") {
      throw new Error("sink has no TCP address");
    }
    this.url = `http://127.0.0.1:${addr.port}/telemetry`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  seen(ua?: string): SinkEvent[] {
    return this.events.filter(
      (e) =>
        e.event === "pathfinder.client.seen" &&
        (ua === undefined || e.properties.user_agent === ua),
    );
  }

  created(ua: string): SinkEvent[] {
    return this.events.filter(
      (e) =>
        e.event === "pathfinder.session.created" &&
        e.properties.user_agent === ua,
    );
  }
}

type Booted = {
  port: number;
  sink: Sink;
  stop: () => Promise<void>;
};

/** Boot the real app from a fresh module graph with the given startup flags. */
async function boot(opts: {
  modernProtocol: boolean;
  trustProxy: boolean;
  modernBurst?: number;
  modernMaxInflight?: number;
  collectTool?: boolean;
}): Promise<Booted> {
  const sink = new Sink();
  await sink.start();
  state.modernProtocol = opts.modernProtocol;
  state.trustProxy = opts.trustProxy;
  state.modernBurst = opts.modernBurst;
  state.modernMaxInflight = opts.modernMaxInflight;
  state.collectTool = opts.collectTool ?? false;
  state.p2pTelemetryUrl = sink.url;
  state.bootNo += 1;
  vi.resetModules();
  const { startInProcessServer } = await import("./helpers/inProcessServer.js");
  const running = await startInProcessServer();
  return {
    port: Number(new URL(running.baseUrl).port),
    sink,
    stop: async () => {
      try {
        await running.stop();
      } finally {
        await sink.stop();
      }
    },
  };
}

function post(
  port: number,
  headers: Record<string, string>,
  body: unknown,
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
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: data }),
        );
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function modernList(
  port: number,
  ua: string,
  extra: Record<string, string> = {},
): Promise<HttpResult> {
  return post(
    port,
    {
      "User-Agent": ua,
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/list",
      ...extra,
    },
    MODERN_TOOLS_LIST,
  );
}

function legacyInitialize(port: number, ua: string): Promise<HttpResult> {
  return post(port, { "User-Agent": ua }, INITIALIZE);
}

function bearerFor(port: number): string {
  const origin = `http://127.0.0.1:${port}`;
  const iat = Math.floor(Date.now() / 1000);
  return signJWT(
    {
      iss: origin,
      aud: origin,
      sub: "anonymous",
      client_id: "client-seen-test-client",
      iat,
      exp: iat + 600,
    },
    JWT_SECRET,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function payloadFor(
  clientIp: string | RegExp,
  userAgent: string,
  authenticated: boolean,
) {
  return {
    client_ip:
      typeof clientIp === "string" ? clientIp : expect.stringMatching(clientIp),
    user_agent: userAgent,
    transport: "streamable_http",
    protocol_era: "modern",
    authenticated,
  };
}

const LOOPBACK = /^(::ffff:)?127\.0\.0\.1$/;

let logSpy: MockInstance<typeof console.log> | undefined;
let warnSpy: MockInstance<typeof console.warn> | undefined;
let errorSpy: MockInstance<typeof console.error> | undefined;

function silenceConsole(): void {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
}

function restoreConsole(): void {
  logSpy?.mockRestore();
  warnSpy?.mockRestore();
  errorSpy?.mockRestore();
}

describe("pathfinder.client.seen: modernProtocol on, trust_proxy off", () => {
  let app: Booted;

  beforeAll(async () => {
    silenceConsole();
    app = await boot({ modernProtocol: true, trustProxy: false });
  });

  afterAll(async () => {
    try {
      await app?.stop();
    } finally {
      restoreConsole();
    }
  });

  it("emits one event for repeated requests from the same ip + user agent, and one more for a new user agent", async () => {
    const uaA = "seen-test-A";
    const uaB = "seen-test-B";
    await modernList(app.port, uaA);
    await modernList(app.port, uaA);
    await modernList(app.port, uaB);

    await expect
      .poll(() => app.sink.seen(uaA).length, { timeout: POLL_TIMEOUT_MS })
      .toBe(1);
    await expect
      .poll(() => app.sink.seen(uaB).length, { timeout: POLL_TIMEOUT_MS })
      .toBe(1);
    await sleep(SETTLE_MS);

    // Exactly one per key: the repeat of A did not emit again.
    expect(app.sink.seen(uaA)).toHaveLength(1);
    expect(app.sink.seen(uaB)).toHaveLength(1);
    expect(app.sink.seen(uaA)[0].properties).toEqual(
      payloadFor(LOOPBACK, uaA, false),
    );
    expect(app.sink.seen(uaB)[0].properties).toEqual(
      payloadFor(LOOPBACK, uaB, false),
    );
    // No session id prefix: the modern leg has no session.
    expect(app.sink.seen(uaA)[0].properties).not.toHaveProperty(
      "session_id_prefix",
    );
  });

  it("caps the user agent at 256 chars for the dedup key and the payload", async () => {
    // Two oversized UAs that share their first 256 chars and differ after.
    // A raw-header key would treat them as two clients (two outbound POSTs,
    // two multi-KB map keys); the capped key treats them as one.
    const prefix = "seen-test-long-".padEnd(256, "x");
    const uaLong1 = prefix + "1".repeat(4000);
    const uaLong2 = prefix + "2".repeat(4000);
    await modernList(app.port, uaLong1);
    await modernList(app.port, uaLong2);

    const long = () =>
      app.sink
        .seen()
        .filter((e) => String(e.properties.user_agent).startsWith(prefix));
    await expect
      .poll(() => long().length, { timeout: POLL_TIMEOUT_MS })
      .toBeGreaterThan(0);
    await sleep(SETTLE_MS);

    // One event for both requests, carrying the capped user agent.
    expect(long().map((e) => String(e.properties.user_agent).length)).toEqual([
      256,
    ]);
    expect(long()[0].properties).toEqual(payloadFor(LOOPBACK, prefix, false));
  });

  it("sets authenticated true for a modern request that carries a valid bearer", async () => {
    const ua = "seen-test-bearer";
    await modernList(app.port, ua, {
      Authorization: `Bearer ${bearerFor(app.port)}`,
    });

    await expect
      .poll(() => app.sink.seen(ua).length, { timeout: POLL_TIMEOUT_MS })
      .toBe(1);
    expect(app.sink.seen(ua)[0].properties).toEqual(
      payloadFor(LOOPBACK, ua, true),
    );
    // The unauthenticated events from the earlier test stay false.
    for (const e of app.sink
      .seen()
      .filter((e) => e.properties.user_agent !== ua)) {
      expect(e.properties.authenticated).toBe(false);
    }
  });

  it("a legacy initialize emits session.created and no client.seen", async () => {
    const ua = "seen-test-legacy";
    const res = await legacyInitialize(app.port, ua);
    expect(res.status).toBe(200);

    await expect
      .poll(() => app.sink.created(ua).length, { timeout: POLL_TIMEOUT_MS })
      .toBe(1);
    await sleep(SETTLE_MS);
    expect(app.sink.seen(ua)).toHaveLength(0);
  });

  it("uses the socket address as client_ip when trust_proxy is false, ignoring X-Forwarded-For", async () => {
    const ua = "seen-test-xff-untrusted";
    await modernList(app.port, ua, { "X-Forwarded-For": "198.51.100.9" });

    await expect
      .poll(() => app.sink.seen(ua).length, { timeout: POLL_TIMEOUT_MS })
      .toBe(1);
    const props = app.sink.seen(ua)[0].properties;
    expect(props.client_ip).not.toBe("198.51.100.9");
    expect(props.client_ip).toMatch(LOOPBACK);
  });
});

describe("pathfinder.client.seen: modernProtocol on, trust_proxy on", () => {
  let app: Booted;

  beforeAll(async () => {
    silenceConsole();
    app = await boot({ modernProtocol: true, trustProxy: true });
  });

  afterAll(async () => {
    try {
      await app?.stop();
    } finally {
      restoreConsole();
    }
  });

  it("uses the X-Forwarded-For address as client_ip when trust_proxy is true", async () => {
    const ua = "seen-test-xff-trusted";
    await modernList(app.port, ua, { "X-Forwarded-For": "198.51.100.9" });

    await expect
      .poll(() => app.sink.seen(ua).length, { timeout: POLL_TIMEOUT_MS })
      .toBe(1);
    expect(app.sink.seen(ua)[0].properties).toEqual(
      payloadFor("198.51.100.9", ua, false),
    );
  });
});

describe("pathfinder.client.seen: modernProtocol off", () => {
  let app: Booted;

  beforeAll(async () => {
    silenceConsole();
    app = await boot({ modernProtocol: false, trustProxy: false });
  });

  afterAll(async () => {
    try {
      await app?.stop();
    } finally {
      restoreConsole();
    }
  });

  it("sends no client.seen for a modern-shaped request", async () => {
    const modernUa = "seen-test-off-modern";
    const sentinelUa = "seen-test-off-sentinel";
    await modernList(app.port, modernUa);
    // The sentinel proves the sink and emit path work in this boot: its
    // session.created arrives, so a client.seen would have had time to arrive.
    await legacyInitialize(app.port, sentinelUa);

    await expect
      .poll(() => app.sink.created(sentinelUa).length, {
        timeout: POLL_TIMEOUT_MS,
      })
      .toBe(1);
    await sleep(SETTLE_MS);
    expect(app.sink.seen()).toHaveLength(0);
  });
});

describe("pathfinder.client.seen: a request rejected with 429", () => {
  let app: Booted;

  beforeAll(async () => {
    silenceConsole();
    // Burst 1: the second modern request from an IP is rate limited.
    app = await boot({
      modernProtocol: true,
      trustProxy: true,
      modernBurst: 1,
    });
  });

  afterAll(async () => {
    try {
      await app?.stop();
    } finally {
      restoreConsole();
    }
  });

  it("sends no client.seen and writes no per-tool log line", async () => {
    const ip = "198.51.100.77";
    const admittedUa = "seen-test-429-admitted";
    const limitedUa = "seen-test-429-limited";
    const admitted = await modernList(app.port, admittedUa, {
      "X-Forwarded-For": ip,
    });
    // This boot has no tools, so the admitted request reaches the handler and
    // gets its -32601 answer, not a limiter rejection.
    expect(admitted.status).toBe(404);
    expect(JSON.parse(admitted.body).error.code).toBe(-32601);
    // A new user agent, so a client.seen sent before the limiter would not be
    // removed by the deduper.
    const limited = await modernList(app.port, limitedUa, {
      "X-Forwarded-For": ip,
    });
    expect(limited.status).toBe(429);

    // Positive control: the admitted request was seen and logged.
    await expect
      .poll(() => app.sink.seen(admittedUa).length, {
        timeout: POLL_TIMEOUT_MS,
      })
      .toBe(1);
    await sleep(SETTLE_MS);
    expect(app.sink.seen(limitedUa)).toHaveLength(0);
    const toolLines = (logSpy?.mock.calls ?? [])
      .map((args) => String(args[0]))
      .filter((line) => line === `[mcp] tools/list [${ip}]`);
    expect(toolLines).toHaveLength(1);
  });
});

describe("pathfinder.client.seen: a request rejected with 503", () => {
  let app: Booted;

  beforeAll(async () => {
    silenceConsole();
    // Ceiling 1: while one modern request is held in flight, the next one
    // answers 503.
    app = await boot({
      modernProtocol: true,
      trustProxy: true,
      modernMaxInflight: 1,
      collectTool: true,
    });
  });

  afterAll(async () => {
    try {
      await app?.stop();
    } finally {
      restoreConsole();
    }
  });

  it("sends no client.seen and writes no per-tool log line", async () => {
    const heldIp = "198.51.100.88";
    const overIp = "198.51.100.89";
    const heldUa = "seen-test-503-held";
    const overUa = "seen-test-503-over";
    let release: (() => void) | undefined;
    hold.gate = new Promise<void>((resolve) => (release = resolve));
    const entered = new Promise<void>((resolve) => (hold.entered = resolve));
    let held: Promise<HttpResult> | undefined;
    try {
      held = post(
        app.port,
        {
          "User-Agent": heldUa,
          "X-Forwarded-For": heldIp,
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/call",
          "Mcp-Name": "collect-note",
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "collect-note",
            arguments: { note: "hold" },
            _meta: META,
          },
        },
      );
      // The held request must be admitted and reach the tool handler.
      const reached = await Promise.race([
        entered.then(() => "entered"),
        sleep(POLL_TIMEOUT_MS).then(() => "timeout"),
      ]);
      expect(reached).toBe("entered");

      // A different IP and user agent, so neither the rate limiter nor the
      // deduper can be what keeps a client.seen from being sent.
      const over = await modernList(app.port, overUa, {
        "X-Forwarded-For": overIp,
      });
      expect(over.status).toBe(503);
    } finally {
      release?.();
    }
    expect((await held)?.status).toBe(200);

    // Positive control: the admitted request was seen and logged.
    await expect
      .poll(() => app.sink.seen(heldUa).length, { timeout: POLL_TIMEOUT_MS })
      .toBe(1);
    await sleep(SETTLE_MS);
    expect(app.sink.seen(overUa)).toHaveLength(0);
    const lines = (logSpy?.mock.calls ?? []).map((args) => String(args[0]));
    expect(lines).toContain(`[mcp] collect-note({"note":"hold"}) [${heldIp}]`);
    expect(lines).not.toContain(`[mcp] tools/list [${overIp}]`);
  });
});
