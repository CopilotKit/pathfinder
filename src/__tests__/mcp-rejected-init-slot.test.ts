/**
 * Route-level coverage: a legacy POST /mcp initialize that the transport
 * rejects (406 for a bad Accept header, 400 for a body that passes
 * isInitializeRequest but is not a valid JSON-RPC message) must leave nothing
 * behind:
 * - no transport map entry and no per-IP limiter slot. Before that fix, each
 *   rejected initialize held its slot until the idle reaper ran, so a client
 *   retrying in a loop locked itself out with 429s.
 * - no `pathfinder.session.created` telemetry event and no "New session" log
 *   line. Once the slot was freed, a looping client could otherwise send an
 *   unbounded number of events for sessions that never existed.
 *
 * Boots the real app in-process, drives /mcp over HTTP and points
 * p2pTelemetryUrl at a node:http sink that the test starts, so the real
 * P2PTelemetry and fetch run end to end. The per-IP cap is 2, so three
 * rejected initializes are enough to show a slot leak.
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
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({
  cloneDir: "",
  p2pTelemetryUrl: undefined as string | undefined,
}));

vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  getConfig: vi.fn(() => ({
    port: 0,
    databaseUrl: "pglite://memory://",
    openaiApiKey: "",
    githubToken: "",
    githubWebhookSecret: "",
    nodeEnv: "test",
    logLevel: "info",
    cloneDir: state.cloneDir,
    slackBotToken: "",
    slackSigningSecret: "",
    discordBotToken: "",
    discordPublicKey: "",
    notionToken: "",
    mcpJwtSecret: "f".repeat(64),
    p2pTelemetryUrl: state.p2pTelemetryUrl,
    p2pTelemetryDisabled: false,
    packageVersion: "test",
  })),
  getServerConfig: vi.fn().mockReturnValue({
    server: {
      name: "pathfinder-rejected-init-slot",
      version: "0.0.0",
      max_sessions_per_ip: 2,
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

import type { InProcessServer } from "./helpers/inProcessServer.js";

const ACCEPT_BOTH = "application/json, text/event-stream";
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "rejected-init-test", version: "0.0.0" },
  },
};
const REJECT_ATTEMPTS = 10;
const SETTLE_MS = 300;
const POLL_TIMEOUT_MS = 3000;

type SinkEvent = { event: string; properties: Record<string, unknown> };

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

  created(ua: string): SinkEvent[] {
    return this.events.filter(
      (e) =>
        e.event === "pathfinder.session.created" &&
        e.properties.user_agent === ua,
    );
  }
}

let running: InProcessServer | undefined;
let sink: Sink | undefined;
let port = 0;
let logSpy: MockInstance<typeof console.log> | undefined;

type HttpResult = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
};

function mcpRequest(
  method: "POST" | "DELETE",
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** How many "[mcp] New session" lines were logged so far. */
function newSessionLogCount(): number {
  return (logSpy?.mock.calls ?? []).filter((args) =>
    String(args[0]).startsWith("[mcp] New session "),
  ).length;
}

async function deleteSession(sid: string): Promise<void> {
  const del = await mcpRequest("DELETE", {
    Accept: ACCEPT_BOTH,
    "Mcp-Session-Id": sid,
  });
  expect(del.status).toBe(200);
}

const REJECTED_CASES: ReadonlyArray<{
  name: string;
  status: number;
  headers: Record<string, string>;
  body: unknown;
}> = [
  {
    name: "406 (Accept without text/event-stream)",
    status: 406,
    headers: { Accept: "application/json" },
    body: INITIALIZE,
  },
  {
    name: "400 (initialize body that is not a JSON-RPC message)",
    status: 400,
    headers: { Accept: ACCEPT_BOTH },
    // Passes isInitializeRequest (method + params) but fails the SDK's
    // JSONRPCMessageSchema (no jsonrpc/id), so the transport answers 400.
    body: { method: INITIALIZE.method, params: INITIALIZE.params },
  },
];

describe("POST /mcp: a rejected legacy initialize leaves nothing behind", () => {
  beforeAll(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    state.cloneDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pathfinder-rejected-init-"),
    );
    sink = new Sink();
    await sink.start();
    state.p2pTelemetryUrl = sink.url;
    const { startInProcessServer } =
      await import("./helpers/inProcessServer.js");
    running = await startInProcessServer();
    port = Number(new URL(running.baseUrl).port);
  });

  afterAll(async () => {
    try {
      await running?.stop();
      await sink?.stop();
    } finally {
      running = undefined;
      sink = undefined;
      if (state.cloneDir) {
        fs.rmSync(state.cloneDir, { recursive: true, force: true });
      }
      vi.restoreAllMocks();
    }
  });

  it.each(REJECTED_CASES)(
    "$name: repeated rejects hold no slot, so the full per-IP cap stays available",
    async ({ status, headers, body }) => {
      // Three rejected initializes from the same IP: one more than the cap.
      for (let i = 0; i < 3; i++) {
        const res = await mcpRequest("POST", headers, body);
        expect(res.status).toBe(status);
        expect(res.headers["mcp-session-id"]).toBeUndefined();
      }

      // The cap is 2. If no rejected initialize kept a slot, exactly two valid
      // initializes from the same IP succeed and the third gets a 429.
      const sids: string[] = [];
      for (let i = 0; i < 2; i++) {
        const ok = await mcpRequest(
          "POST",
          { Accept: ACCEPT_BOTH },
          INITIALIZE,
        );
        expect(ok.status).toBe(200);
        const sid = ok.headers["mcp-session-id"];
        expect(typeof sid).toBe("string");
        sids.push(String(sid));
      }
      const over = await mcpRequest(
        "POST",
        { Accept: ACCEPT_BOTH },
        INITIALIZE,
      );
      expect(over.status).toBe(429);

      // Free the valid sessions so the next case starts from zero.
      for (const sid of sids) await deleteSession(sid);
    },
  );

  it.each(REJECTED_CASES)(
    "$name: rejects emit no session.created and log no New session; a valid initialize emits exactly one of each",
    async ({ status, headers, body }) => {
      const rejectedUa = `rejected-init-${status}`;
      const acceptedUa = `accepted-init-${status}`;
      const logsBefore = newSessionLogCount();

      for (let i = 0; i < REJECT_ATTEMPTS; i++) {
        const res = await mcpRequest(
          "POST",
          { ...headers, "User-Agent": rejectedUa },
          body,
        );
        expect(res.status).toBe(status);
      }
      const logsAfterRejects = newSessionLogCount();

      const ok = await mcpRequest(
        "POST",
        { Accept: ACCEPT_BOTH, "User-Agent": acceptedUa },
        INITIALIZE,
      );
      expect(ok.status).toBe(200);
      const sid = String(ok.headers["mcp-session-id"]);
      const logsAfterAccept = newSessionLogCount();

      // The accepted event proves the sink and emit path work in this boot,
      // so events for the earlier rejects would have had time to arrive.
      await expect
        .poll(() => sink?.created(acceptedUa).length, {
          timeout: POLL_TIMEOUT_MS,
        })
        .toBe(1);
      await sleep(SETTLE_MS);
      expect(sink?.created(acceptedUa)).toHaveLength(1);
      expect(sink?.created(rejectedUa)).toHaveLength(0);
      expect(logsAfterRejects).toBe(logsBefore);
      expect(logsAfterAccept).toBe(logsBefore + 1);

      await deleteSession(sid);
    },
  );
});
