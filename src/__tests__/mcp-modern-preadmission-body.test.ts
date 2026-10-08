/**
 * The modern /mcp leg must refuse a rate-limited client before it reads that
 * client's request body. When express.json does not parse a POST /mcp body (a
 * non-JSON or missing Content-Type), era classification reads the stream, up
 * to the SDK's 4 MiB limit. A request that is modern from its headers alone
 * (a 2026-07-28 or later MCP-Protocol-Version) spends its modern token before
 * that read, so a rate-limited IP gets its 429 without the read, and
 * concurrent requests cannot all start a read on the same last token. A
 * request with no modern header meets the modern limiter only after the read,
 * and only if it classifies as modern; legacy traffic is never charged. (A
 * header-modern request whose body classifies as legacy is charged early.)
 * The per-IP cap on concurrent reads, which also covers header-less
 * requests, is tested in mcp-body-read-cap.test.ts.
 *
 * Boots the real app in-process with PATHFINDER_MODERN_PROTOCOL on.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import net from "node:net";

// rpm 1 refills one token per minute, so a drained bucket stays empty for
// the whole file: no test depends on refill timing.
const LIMITS = vi.hoisted(() => ({ rpm: 1, burst: 3 }));
const BURST = LIMITS.burst;

vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  getConfig: vi.fn().mockReturnValue({
    port: 0,
    databaseUrl: "pglite://memory://",
    openaiApiKey: "",
    githubToken: "",
    githubWebhookSecret: "",
    nodeEnv: "test",
    logLevel: "info",
    cloneDir: "/tmp/test-mcp-modern-preadmission-body",
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
      name: "pathfinder-modern-preadmission-body",
      version: "0.0.0",
      max_sessions_per_ip: 50,
      session_ttl_minutes: 30,
      allowlist: ["203.0.113.9"],
      trust_proxy: true,
      modern_rpm_per_ip: LIMITS.rpm,
      modern_burst_per_ip: LIMITS.burst,
      modern_max_inflight: 10,
      modern_request_timeout_ms: 5000,
    },
    sources: [],
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
  "io.modelcontextprotocol/clientInfo": { name: "preadmit-test", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

const TOOLS_LIST = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
  params: { _meta: META },
};

const MODERN_LIST_HEADERS = {
  "MCP-Protocol-Version": "2026-07-28",
  "Mcp-Method": "tools/list",
};

const LEGACY_INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "preadmit-test-legacy", version: "0.0.0" },
  },
};

/** Size the oversized body claims; the client sends only the first chunk. */
const BIG_BODY_BYTES = 3 * 1024 * 1024;
const FIRST_CHUNK_BYTES = 64 * 1024;
/** How long the client waits for an answer while it holds the rest back. */
const ANSWER_WAIT_MS = 1500;

let running: InProcessServer | undefined;
let port = 0;
let nextIp = 1;

function freshIp(): string {
  return `198.51.100.${nextIp++}`;
}

/**
 * Request headers for one POST /mcp. A header given as null is left out, so a
 * test can send a request with no Content-Type.
 */
function requestHeaders(
  ip: string,
  headers: Record<string, string | null>,
): Record<string, string> {
  const merged: Record<string, string | null> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "X-Forwarded-For": ip,
    ...headers,
  };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) if (v !== null) out[k] = v;
  return out;
}

function post(
  ip: string,
  body: string | Buffer,
  headers: Record<string, string | null>,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: requestHeaders(ip, headers),
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
    req.end(body);
  });
}

/** Spend the IP's whole modern bucket, and check the next request is a 429. */
async function exhaust(ip: string): Promise<void> {
  const statuses: number[] = [];
  for (let i = 0; i < BURST + 1; i++) {
    statuses.push(
      (await post(ip, JSON.stringify(TOOLS_LIST), MODERN_LIST_HEADERS)).status,
    );
  }
  expect(statuses).toEqual([...Array<number>(BURST).fill(200), 429]);
}

/**
 * POST a body that declares BIG_BODY_BYTES, send only the first
 * FIRST_CHUNK_BYTES, and wait ANSWER_WAIT_MS for the response. "timeout"
 * means the server was still waiting to read the rest of the body.
 */
function postHeldBigBody(
  ip: string,
  headers: Record<string, string | null> = { "Content-Type": "text/plain" },
): Promise<HttpResult | "timeout"> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: HttpResult | "timeout") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(v);
    };
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: requestHeaders(ip, {
          "Content-Length": String(BIG_BODY_BYTES),
          ...MODERN_LIST_HEADERS,
          ...headers,
        }),
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () =>
          finish({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: data,
          }),
        );
      },
    );
    // The server may close the connection while the body is unsent.
    req.on("error", () => {});
    const timer = setTimeout(() => finish("timeout"), ANSWER_WAIT_MS);
    req.write(Buffer.alloc(FIRST_CHUNK_BYTES, 0x20));
  });
}

/** Check a response is the modern 429, with matching Retry-After values. */
function expectModernRateLimited(res: HttpResult): void {
  expect(res.status).toBe(429);
  const parsed: unknown = JSON.parse(res.body);
  expect(parsed).toMatchObject({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32005 },
  });
  const seconds = Number(res.headers["retry-after"]);
  expect(seconds).toBeGreaterThanOrEqual(1);
  expect(parsed).toMatchObject({
    error: { data: { retryAfterSeconds: seconds } },
  });
}

describe("/mcp modern leg: rate limit runs before the body is read", () => {
  beforeAll(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
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

  it("answers 429 to a rate-limited IP's unparsed modern body without waiting for the body", async () => {
    const ip = freshIp();
    await exhaust(ip);
    const res = await postHeldBigBody(ip);
    expect(res).not.toBe("timeout");
    if (res === "timeout") return;
    expectModernRateLimited(res);
  });

  it("answers 429 early to a modern request with no Content-Type", async () => {
    const ip = freshIp();
    await exhaust(ip);
    const res = await postHeldBigBody(ip, { "Content-Type": null });
    expect(res).not.toBe("timeout");
    if (res === "timeout") return;
    expectModernRateLimited(res);
  });

  it("still reads the body for an IP with tokens left", async () => {
    // A fresh IP is not refused early: the classifier waits for the body.
    const res = await postHeldBigBody(freshIp());
    expect(res).toBe("timeout");
  });

  it("does not refuse an allowlisted IP early", async () => {
    const ip = "203.0.113.9";
    for (let i = 0; i < BURST + 1; i++) {
      expect(
        (await post(ip, JSON.stringify(TOOLS_LIST), MODERN_LIST_HEADERS))
          .status,
      ).toBe(200);
    }
    expect(await postHeldBigBody(ip)).toBe("timeout");
  });

  it("spends exactly one token on an unparsed modern request", async () => {
    // One token left. The early check spends it, the SDK answers the
    // text/plain modern body with its 415, and admission after the read
    // does not spend a second token (that would turn the 415 into a 429).
    // The bucket is then empty, so the next request is a 429.
    const ip = freshIp();
    for (let i = 0; i < BURST - 1; i++) {
      expect(
        (await post(ip, JSON.stringify(TOOLS_LIST), MODERN_LIST_HEADERS))
          .status,
      ).toBe(200);
    }
    const unparsed = await post(ip, JSON.stringify(TOOLS_LIST), {
      ...MODERN_LIST_HEADERS,
      "Content-Type": "text/plain",
    });
    expect(unparsed.status).toBe(415);
    expect(
      (await post(ip, JSON.stringify(TOOLS_LIST), MODERN_LIST_HEADERS)).status,
    ).toBe(429);
  });

  it("lets only as many concurrent unparsed modern reads start as the IP has tokens", async () => {
    // A fresh IP holds BURST tokens. BURST + 2 held bodies sent at once:
    // BURST of them spend a token and wait for their body, the other 2 get
    // their 429 at once.
    const ip = freshIp();
    const results = await Promise.all(
      Array.from({ length: BURST + 2 }, () => postHeldBigBody(ip)),
    );
    const waiting = results.filter((r) => r === "timeout");
    const refused = results.filter((r) => r !== "timeout");
    expect(waiting).toHaveLength(BURST);
    expect(refused).toHaveLength(2);
    for (const r of refused) expectModernRateLimited(r);
  });

  it.each([
    ["1 MiB", 1024 * 1024],
    ["3 MiB", 3 * 1024 * 1024],
  ])(
    "delivers the early 429 to a client that sends a %s body in full",
    async (_label, bytes) => {
      // The client writes the whole body without waiting for an answer. The
      // 429 and its Retry-After must reach it every time: no ECONNRESET or
      // EPIPE in place of the answer.
      const ip = freshIp();
      await exhaust(ip);
      const body = Buffer.alloc(bytes, 0x20);
      for (let i = 0; i < 5; i++) {
        const viaHttp = await post(ip, body, {
          ...MODERN_LIST_HEADERS,
          "Content-Type": "text/plain",
        });
        expectModernRateLimited(viaHttp);
        const viaFetch = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers: requestHeaders(ip, {
            ...MODERN_LIST_HEADERS,
            "Content-Type": "text/plain",
          }),
          body: new Uint8Array(body),
        });
        expectModernRateLimited({
          status: viaFetch.status,
          headers: Object.fromEntries(viaFetch.headers),
          body: await viaFetch.text(),
        });
      }
    },
  );

  it("closes the connection when a refused body runs past the discard limit", async () => {
    // The refused body is discarded only up to the SDK's 4 MiB body limit.
    // A client that keeps sending after that has its socket closed, so a
    // refused request cannot make the server read without bound. A raw
    // socket is used: Node's http client stops writing the body by itself
    // once it has the response.
    const ip = freshIp();
    await exhaust(ip);
    const declared = 64 * 1024 * 1024;
    const chunk = Buffer.alloc(256 * 1024, 0x20);
    const { written, answer } = await new Promise<{
      written: number;
      answer: string;
    }>((resolve) => {
      let sent = 0;
      let done = false;
      let received = "";
      const socket = net.connect(port, "127.0.0.1");
      const stop = () => {
        if (done) return;
        done = true;
        socket.destroy();
        resolve({ written: sent, answer: received });
      };
      const pump = () => {
        while (!done && sent < declared) {
          sent += chunk.length;
          if (!socket.write(chunk)) {
            socket.once("drain", pump);
            return;
          }
        }
        if (sent >= declared) stop();
      };
      socket.on("connect", () => {
        const head = Object.entries(
          requestHeaders(ip, {
            ...MODERN_LIST_HEADERS,
            "Content-Type": "text/plain",
            "Content-Length": String(declared),
          }),
        )
          .map(([k, v]) => `${k}: ${v}\r\n`)
          .join("");
        socket.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n${head}\r\n`);
        pump();
      });
      socket.on("data", (d: Buffer) => (received += d.toString("latin1")));
      socket.on("error", stop);
      socket.on("close", stop);
    });
    expect(answer.startsWith("HTTP/1.1 429")).toBe(true);
    expect(written).toBeLessThan(declared / 2);
  });

  it.each([["application/json; charset"], ["APPLICATION/JSON ; x"]])(
    "serves a legacy initialize sent as %s from a rate-limited IP",
    async (contentType) => {
      // express.json leaves these bodies unparsed, but the SDK reads them as
      // JSON. The request is legacy: the modern limiter must not see it.
      const ip = freshIp();
      await exhaust(ip);
      const res = await post(ip, JSON.stringify(LEGACY_INITIALIZE), {
        "Content-Type": contentType,
      });
      expect(res.status).toBe(200);
      expect(res.headers["mcp-session-id"]).toBeDefined();
    },
  );

  it.each([["text/plain"], [null]])(
    "answers a legacy unparsed body (Content-Type %s) from a rate-limited IP as it does from a fresh IP",
    async (contentType) => {
      const headers = { "Content-Type": contentType };
      const body = JSON.stringify(LEGACY_INITIALIZE);
      const fresh = await post(freshIp(), body, headers);
      const ip = freshIp();
      await exhaust(ip);
      const limited = await post(ip, body, headers);
      expect(fresh.status).not.toBe(429);
      expect(limited.status).toBe(fresh.status);
      expect(limited.body).toBe(fresh.body);
    },
  );

  it("serves a legacy JSON request from a rate-limited IP", async () => {
    const ip = freshIp();
    await exhaust(ip);
    const res = await post(ip, JSON.stringify(LEGACY_INITIALIZE), {});
    expect(res.status).toBe(200);
    expect(res.headers["mcp-session-id"]).toBeDefined();
  });
});
