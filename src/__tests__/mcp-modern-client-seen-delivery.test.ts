/**
 * Route-level coverage for what happens to `pathfinder.client.seen` when the
 * telemetry sink does not accept the POST. Boots the real app in-process with
 * p2pTelemetryUrl pointed at a node:http sink that this test starts, so the
 * server.ts wiring, P2PTelemetry, ClientSeenDeduper and the real global fetch
 * all run. Nothing in that path is mocked.
 *
 * Only Date is faked (timers stay real), so the test can step past the
 * failure backoff and the 24h dedup TTL without waiting for them. The fake
 * Date is installed before boot, so the deduper and the telemetry warn
 * limiter both read it. The one other change is a longer send timeout (see
 * the p2p-telemetry mock below).
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
import { TELEMETRY_FAILURE_BACKOFF_MS as BACKOFF_MS } from "../p2p-telemetry.js";

const state = vi.hoisted(() => ({
  p2pTelemetryUrl: undefined as string | undefined,
  /**
   * Send timeout for the app's P2PTelemetry. The late-failure test holds a
   * send open across two requests; the 3 s default could abort it first,
   * and then the test would not test a late failure.
   */
  sendTimeoutMs: 60_000,
}));

// The real P2PTelemetry, with only the send timeout raised.
vi.mock("../p2p-telemetry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../p2p-telemetry.js")>();
  class P2PTelemetry extends actual.P2PTelemetry {
    constructor(opts: ConstructorParameters<typeof actual.P2PTelemetry>[0]) {
      super({ ...opts, timeoutMs: state.sendTimeoutMs });
    }
  }
  return { ...actual, P2PTelemetry };
});

vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  getConfig: vi.fn(() => ({
    port: 0,
    databaseUrl: "pglite:///tmp/test-mcp-modern-client-seen-delivery",
    openaiApiKey: "",
    githubToken: "",
    githubWebhookSecret: "",
    nodeEnv: "test",
    logLevel: "info",
    cloneDir: "/tmp/test-mcp-modern-client-seen-delivery",
    slackBotToken: "",
    slackSigningSecret: "",
    discordBotToken: "",
    discordPublicKey: "",
    notionToken: "",
    mcpJwtSecret: "f".repeat(64),
    p2pTelemetryUrl: state.p2pTelemetryUrl,
    p2pTelemetryDisabled: false,
    modernProtocol: true,
    packageVersion: "test",
  })),
  getServerConfig: vi.fn(() => ({
    server: {
      name: "pathfinder-modern-client-seen-delivery",
      version: "0.0.0",
      max_sessions_per_ip: 50,
      session_ttl_minutes: 30,
      allowlist: [],
      trust_proxy: false,
    },
    sources: [],
    tools: [],
  })),
  getAnalyticsConfig: vi.fn().mockReturnValue(undefined),
  hasSearchTools: vi.fn().mockReturnValue(false),
  hasKnowledgeTools: vi.fn().mockReturnValue(false),
  hasCollectTools: vi.fn().mockReturnValue(false),
  hasBashSemanticSearch: vi.fn().mockReturnValue(false),
}));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SETTLE_MS = 300;
const POLL_TIMEOUT_MS = 3000;

const MODERN_TOOLS_LIST = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
  params: {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": {
        name: "client-seen-delivery-test",
        version: "0",
      },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
};

type SinkRequest = {
  method: string;
  path: string;
  event?: string;
  userAgent?: string;
};

/** How the sink answers one request. */
type Responder = (
  r: SinkRequest,
  res: http.ServerResponse,
) => void | Promise<void>;

/**
 * An in-process telemetry sink. It records every request (method, path and,
 * for a JSON body, the event and user agent) and answers with `respond`.
 */
class Sink {
  readonly requests: SinkRequest[] = [];
  respond: Responder = (_r, res) => {
    res.statusCode = 200;
    res.end("ok");
  };
  private readonly server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const r: SinkRequest = { method: req.method ?? "", path: req.url ?? "" };
      try {
        const body = JSON.parse(data) as {
          event: string;
          properties: { user_agent?: string };
        };
        r.event = body.event;
        r.userAgent = body.properties.user_agent;
      } catch {
        // A bodyless request (a followed redirect) has no event.
      }
      this.requests.push(r);
      void this.respond(r, res);
    });
  });
  url = "";
  host = "";

  async start(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server.listen(0, "127.0.0.1", resolve),
    );
    const addr = this.server.address();
    if (addr === null || typeof addr === "string") {
      throw new Error("sink has no TCP address");
    }
    this.host = `127.0.0.1:${addr.port}`;
    this.url = `http://${this.host}/telemetry`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** client.seen POSTs that carried this user agent. */
  seen(ua: string): SinkRequest[] {
    return this.requests.filter(
      (r) =>
        r.method === "POST" &&
        r.event === "pathfinder.client.seen" &&
        r.userAgent === ua,
    );
  }
}

function status(code: number, headers: Record<string, string> = {}) {
  return (_r: SinkRequest, res: http.ServerResponse) => {
    res.statusCode = code;
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.end("x");
  };
}

function modernList(port: number, ua: string): Promise<number> {
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
          "User-Agent": ua,
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/list",
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.write(JSON.stringify(MODERN_TOOLS_LIST));
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Move the faked wall clock forward. Real timers are not touched. */
function advance(ms: number): void {
  vi.setSystemTime(new Date(Date.now() + ms));
}

let warnSpy: MockInstance<typeof console.warn>;
let logSpy: MockInstance<typeof console.log>;
let errorSpy: MockInstance<typeof console.error>;

function sendFailedWarnings(): string[] {
  return warnSpy.mock.calls
    .map((args) => args.map(String).join(" "))
    .filter((line) => line.includes("[p2p-telemetry] send failed"));
}

describe("pathfinder.client.seen when the sink does not accept the event", () => {
  let port: number;
  let sink: Sink;
  let stopServer: () => Promise<void>;

  beforeAll(async () => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    sink = new Sink();
    await sink.start();
    state.p2pTelemetryUrl = sink.url;
    vi.resetModules();
    const { startInProcessServer } =
      await import("./helpers/inProcessServer.js");
    const running = await startInProcessServer();
    port = Number(new URL(running.baseUrl).port);
    stopServer = running.stop;
  });

  afterAll(async () => {
    try {
      await stopServer?.();
      await sink?.stop();
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("during an outage sends at most one POST per client per backoff window, and logs one warning naming the event and the sink", async () => {
    // Start a fresh warning window, clear of anything logged before.
    advance(BACKOFF_MS + MINUTE);
    const before = sendFailedWarnings().length;
    sink.respond = status(500);
    const ua = "delivery-outage-A";
    for (let i = 0; i < 5; i++) {
      expect(await modernList(port, ua)).toBe(404);
      // Give each failed send time to finish before the next request.
      await sleep(SETTLE_MS);
    }
    // Two more clients in the same window: one POST each, no new warning.
    await modernList(port, "delivery-outage-B");
    await modernList(port, "delivery-outage-C");
    await expect
      .poll(() => sink.seen("delivery-outage-C").length, {
        timeout: POLL_TIMEOUT_MS,
      })
      .toBe(1);
    await sleep(SETTLE_MS);

    expect(sink.seen(ua)).toHaveLength(1);
    expect(sink.seen("delivery-outage-B")).toHaveLength(1);
    const warnings = sendFailedWarnings().slice(before);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("pathfinder.client.seen");
    expect(warnings[0]).toContain(sink.host);
    expect(warnings[0]).toContain("HTTP 500");
  });

  it("retries a failed client once the backoff has passed, then dedupes a 200 for the full TTL", async () => {
    const ua = "delivery-retry";
    sink.respond = status(500);
    await modernList(port, ua);
    await expect
      .poll(() => sink.seen(ua).length, { timeout: POLL_TIMEOUT_MS })
      .toBe(1);
    await sleep(SETTLE_MS);

    // Still inside the backoff: no new POST.
    advance(BACKOFF_MS - MINUTE);
    await modernList(port, ua);
    await sleep(SETTLE_MS);
    expect(sink.seen(ua)).toHaveLength(1);

    // Past the backoff, the sink is back: the client is retried and delivered.
    sink.respond = status(200);
    advance(2 * MINUTE);
    await modernList(port, ua);
    await expect
      .poll(() => sink.seen(ua).length, { timeout: POLL_TIMEOUT_MS })
      .toBe(2);
    await sleep(SETTLE_MS);

    // A delivered event holds the key for the 24h TTL, not the backoff.
    await modernList(port, ua);
    advance(23 * HOUR);
    await modernList(port, ua);
    await sleep(SETTLE_MS);
    expect(sink.seen(ua)).toHaveLength(2);
  });

  it("treats a 302 from the sink as a failure and does not follow it", async () => {
    advance(BACKOFF_MS + MINUTE);
    const before = sendFailedWarnings().length;
    const ua = "delivery-redirect";
    sink.respond = (r, res) =>
      r.method === "POST"
        ? status(302, { Location: "/landed" })(r, res)
        : status(200)(r, res);
    await modernList(port, ua);
    await expect
      .poll(() => sink.seen(ua).length, { timeout: POLL_TIMEOUT_MS })
      .toBe(1);
    await sleep(SETTLE_MS);

    // fetch did not turn the POST into a bodyless GET on /landed.
    expect(sink.requests.filter((r) => r.path === "/landed")).toHaveLength(0);
    const warnings = sendFailedWarnings().slice(before);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("HTTP 302");

    // Because the 302 was a failure, the client is retried after the backoff.
    sink.respond = status(200);
    advance(BACKOFF_MS + MINUTE);
    await modernList(port, ua);
    await expect
      .poll(() => sink.seen(ua).length, { timeout: POLL_TIMEOUT_MS })
      .toBe(2);
  });

  it("follows a 307 from the sink and delivers the event to the new location", async () => {
    advance(BACKOFF_MS + MINUTE);
    const before = sendFailedWarnings().length;
    const ua = "delivery-307";
    sink.respond = (r, res) =>
      r.path === "/telemetry"
        ? status(307, { Location: "/moved" })(r, res)
        : status(200)(r, res);
    await modernList(port, ua);
    await expect
      .poll(() => sink.seen(ua).map((r) => r.path), {
        timeout: POLL_TIMEOUT_MS,
      })
      .toEqual(["/telemetry", "/moved"]);
    await sleep(SETTLE_MS);
    expect(sendFailedWarnings().slice(before)).toEqual([]);

    // Delivered, so the client is held for the TTL, not the backoff.
    sink.respond = status(200);
    advance(BACKOFF_MS + MINUTE);
    await modernList(port, ua);
    await sleep(SETTLE_MS);
    expect(sink.seen(ua)).toHaveLength(2);
  });

  it("a late failure of an old send does not erase a newer delivered record", async () => {
    const ua = "delivery-late-failure";
    const before = sendFailedWarnings().length;
    let releaseFirst: (() => void) | undefined;
    const firstHeld = new Promise<void>((r) => (releaseFirst = r));
    sink.respond = async (r, res) => {
      if (r.userAgent === ua && sink.seen(ua).length === 1) {
        // Hold the first send, then fail it.
        await firstHeld;
        status(500)(r, res);
        return;
      }
      status(200)(r, res);
    };

    // Send 1 is in flight (held by the sink).
    await modernList(port, ua);
    await expect
      .poll(() => sink.seen(ua).length, { timeout: POLL_TIMEOUT_MS })
      .toBe(1);

    // The TTL runs out while send 1 is still in flight, so send 2 goes out
    // and is delivered.
    advance(24 * HOUR + MINUTE);
    await modernList(port, ua);
    await expect
      .poll(() => sink.seen(ua).length, { timeout: POLL_TIMEOUT_MS })
      .toBe(2);
    await sleep(SETTLE_MS);
    // Send 1 is still in flight: it has not failed (or timed out) yet.
    expect(sendFailedWarnings().slice(before)).toEqual([]);

    // Send 1 now fails with the 500. The warning is logged just before
    // onFailure runs claim.fail(), so once it is seen, the late fail() has
    // run. (The last warning was more than one window ago, so it is logged.)
    releaseFirst?.();
    await expect
      .poll(() => sendFailedWarnings().slice(before), {
        timeout: POLL_TIMEOUT_MS,
      })
      .toEqual([expect.stringContaining("HTTP 500")]);
    // That fail() must not have touched send 2's record.
    await modernList(port, ua);
    // Past the failure backoff, still well inside send 2's 24h TTL.
    advance(BACKOFF_MS + MINUTE);
    await modernList(port, ua);
    await sleep(SETTLE_MS);
    expect(sink.seen(ua)).toHaveLength(2);
  });
});
