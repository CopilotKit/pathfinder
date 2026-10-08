/**
 * POST /mcp caps how many request bodies one IP can have in era
 * classification at once. When express.json does not parse a body (a
 * non-JSON or missing Content-Type), the classifier reads the stream, up to
 * the SDK's 4 MiB limit. The early per-IP rate limit runs only for a request
 * whose MCP-Protocol-Version header claims the modern revision, so a client
 * that leaves the header out used to get every read started. The cap applies
 * to every such read, with or without the header: an IP over it gets a 429
 * with Retry-After and its body is discarded, never buffered. The slot is
 * freed when the read ends, fails, or the client goes away.
 *
 * Boots the real app in-process with PATHFINDER_MODERN_PROTOCOL on.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import net from "node:net";
import diagnosticsChannel from "node:diagnostics_channel";
import {
  ConcurrentReadCap,
  MAX_CONCURRENT_BODY_READS_PER_IP,
} from "../modern-rate-limit.js";

// rpm 1 refills one token per minute, so a drained bucket stays empty for
// the whole file.
const LIMITS = vi.hoisted(() => ({ rpm: 1, burst: 3 }));
const CAP = MAX_CONCURRENT_BODY_READS_PER_IP;
/** In server.allowlist below: exempt from the read cap, like the limiter. */
const ALLOWLISTED_IP = "203.0.113.7";

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
    cloneDir: "/tmp/test-mcp-body-read-cap",
    slackBotToken: "",
    slackSigningSecret: "",
    discordBotToken: "",
    discordPublicKey: "",
    notionToken: "",
    mcpJwtSecret: "f".repeat(64),
    p2pTelemetryUrl: undefined,
    p2pTelemetryDisabled: true,
    packageVersion: "test",
    modernProtocol: true,
  }),
  getServerConfig: vi.fn().mockReturnValue({
    server: {
      name: "pathfinder-body-read-cap",
      version: "0.0.0",
      max_sessions_per_ip: 50,
      session_ttl_minutes: 30,
      allowlist: ["203.0.113.7"],
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

const TOOLS_LIST = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
  params: {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "cap-test", version: "0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
};

const MODERN_LIST_HEADERS = {
  "MCP-Protocol-Version": "2026-07-28",
  "Mcp-Method": "tools/list",
};

/** A modern envelope padded with spaces to BIG_BODY_BYTES (still JSON). */
const BIG_BODY_BYTES = 3 * 1024 * 1024;
const BIG_BODY = Buffer.alloc(BIG_BODY_BYTES, 0x20);
BIG_BODY.write(JSON.stringify(TOOLS_LIST));
const FIRST_CHUNK_BYTES = 64 * 1024;
/** How long a client waits for an early answer before it sends the rest. */
const EARLY_ANSWER_WAIT_MS = 300;
/** How long a client then waits for an answer while it holds the last byte. */
const ANSWER_WAIT_MS = 1500;

let running: InProcessServer | undefined;
let port = 0;
let nextIp = 1;

function freshIp(): string {
  return `198.51.100.${nextIp++}`;
}

function requestHeaders(
  ip: string,
  headers: Record<string, string>,
): Record<string, string> {
  return {
    Accept: "application/json, text/event-stream",
    "Content-Type": "text/plain",
    "X-Forwarded-For": ip,
    ...headers,
  };
}

function post(
  ip: string,
  body: string | Buffer,
  headers: Record<string, string>,
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

interface HeldRead {
  /** The answer, or "pending" when the server was still reading the body. */
  result: Promise<HttpResult | "pending">;
  /** Close the client socket mid-body. */
  abort(): void;
}

/**
 * POST BIG_BODY with no answer expected until the body ends. The client
 * sends the first chunk, and when no answer comes within EARLY_ANSWER_WAIT_MS
 * it sends everything but the last byte and holds. "pending" means the
 * server was still reading the body after ANSWER_WAIT_MS.
 */
function holdRead(ip: string, headers: Record<string, string> = {}): HeldRead {
  let req: http.ClientRequest | undefined;
  const result = new Promise<HttpResult | "pending">((resolve) => {
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = (v: HttpResult | "pending") => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      req?.destroy();
      resolve(v);
    };
    req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: requestHeaders(ip, {
          "Content-Length": String(BIG_BODY_BYTES),
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
    req.on("error", () => finish("pending"));
    req.write(BIG_BODY.subarray(0, FIRST_CHUNK_BYTES));
    timers.push(
      setTimeout(() => {
        if (settled) return;
        req?.write(BIG_BODY.subarray(FIRST_CHUNK_BYTES, BIG_BODY_BYTES - 1));
        timers.push(setTimeout(() => finish("pending"), ANSWER_WAIT_MS));
      }, EARLY_ANSWER_WAIT_MS),
    );
  });
  return { result, abort: () => req?.destroy() };
}

/** Check a response is the 429 with matching Retry-After values. */
function expectRateLimited(res: HttpResult | "pending"): void {
  expect(res).not.toBe("pending");
  if (res === "pending") return;
  expect(res.status).toBe(429);
  const seconds = Number(res.headers["retry-after"]);
  expect(seconds).toBeGreaterThanOrEqual(1);
  expect(JSON.parse(res.body)).toMatchObject({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32005, data: { retryAfterSeconds: seconds } },
  });
}

/** Give the server time to see the closed client sockets. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 200));
}

/**
 * Open CAP + 1 held reads from `ip`: exactly CAP must be read and one
 * refused. More refusals mean a slot from an earlier request leaked.
 */
async function expectFullCapAvailable(ip: string): Promise<void> {
  const results = await Promise.all(
    Array.from({ length: CAP + 1 }, () => holdRead(ip).result),
  );
  expect(results.filter((r) => r === "pending")).toHaveLength(CAP);
  const refused = results.filter((r) => r !== "pending");
  expect(refused).toHaveLength(1);
  for (const r of refused) expectRateLimited(r);
}

describe("ConcurrentReadCap", () => {
  it("admits up to the cap per IP and counts back to zero", () => {
    const cap = new ConcurrentReadCap(2);
    const a = cap.tryAcquire("10.0.0.1");
    const b = cap.tryAcquire("::ffff:10.0.0.1");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(cap.tryAcquire("10.0.0.1")).toBeUndefined();
    expect(cap.tryAcquire("10.0.0.2")).toBeDefined();
    a?.();
    a?.();
    expect(cap.inFlight("10.0.0.1")).toBe(1);
    b?.();
    expect(cap.inFlight("10.0.0.1")).toBe(0);
    expect(cap.trackedIps).toBe(1);
  });

  it("rejects a cap below 1", () => {
    expect(() => new ConcurrentReadCap(0)).toThrow(TypeError);
  });
});

describe("/mcp: per-IP cap on concurrent unparsed body reads", () => {
  const sockets = new Set<net.Socket>();
  const onRequest = (msg: unknown) => {
    const socket: unknown =
      typeof msg === "object" && msg !== null
        ? Reflect.get(msg, "socket")
        : undefined;
    if (socket instanceof net.Socket) sockets.add(socket);
  };

  beforeAll(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    diagnosticsChannel.subscribe("http.server.request.start", onRequest);
    running = await startInProcessServer();
    port = Number(new URL(running.baseUrl).port);
  });

  afterAll(async () => {
    diagnosticsChannel.unsubscribe("http.server.request.start", onRequest);
    try {
      await running?.stop();
    } finally {
      running = undefined;
      vi.restoreAllMocks();
    }
  });

  it("reads at most CAP of 20 concurrent header-less 3 MiB bodies from one IP", async () => {
    const ip = freshIp();
    sockets.clear();
    global.gc?.();
    const before = process.memoryUsage();
    const reads = Array.from({ length: 20 }, () => holdRead(ip));
    // Sample while every read is still held open.
    await new Promise((r) =>
      setTimeout(r, EARLY_ANSWER_WAIT_MS + ANSWER_WAIT_MS / 2),
    );
    const during = process.memoryUsage();
    let bytesRead = 0;
    for (const s of sockets) bytesRead += s.bytesRead;
    const results = await Promise.all(reads.map((r) => r.result));
    const pending = results.filter((r) => r === "pending");
    const refused = results.filter((r) => r !== "pending");
    const mib = (n: number) => (n / 1024 / 1024).toFixed(1);
    process.stdout.write(
      `[body-read-cap proof] 20 header-less 3 MiB POSTs: read=${pending.length} ` +
        `refused=${refused.length} serverBytesRead=${mib(bytesRead)}MiB ` +
        `heapUsedDelta=${mib(during.heapUsed - before.heapUsed)}MiB ` +
        `arrayBuffersDelta=${mib(during.arrayBuffers - before.arrayBuffers)}MiB\n`,
    );
    expect(pending).toHaveLength(CAP);
    expect(refused).toHaveLength(20 - CAP);
    for (const r of refused) expectRateLimited(r);
    // Refused clients stop after the first chunk, so the server read at most
    // CAP bodies plus one first chunk per refused request.
    expect(bytesRead).toBeLessThan(
      CAP * BIG_BODY_BYTES + 20 * FIRST_CHUNK_BYTES + 64 * 1024,
    );
  });

  it("does not cap an allowlisted IP, and still caps the others", async () => {
    const other = freshIp();
    const [allowlisted, capped] = await Promise.all([
      Promise.all(
        Array.from({ length: CAP + 2 }, () => holdRead(ALLOWLISTED_IP).result),
      ),
      Promise.all(
        Array.from({ length: CAP + 2 }, () => holdRead(other).result),
      ),
    ]);
    const count429 = (rs: (HttpResult | "pending")[]) =>
      rs.filter((r) => r !== "pending" && r.status === 429).length;
    process.stdout.write(
      `[body-read-cap allowlist] ${CAP + 2} concurrent reads: ` +
        `allowlisted 429s=${count429(allowlisted)} other 429s=${count429(capped)}\n`,
    );
    expect(allowlisted.every((r) => r === "pending")).toBe(true);
    expect(capped.filter((r) => r === "pending")).toHaveLength(CAP);
    expect(count429(capped)).toBe(2);
  });

  it("does not hold another IP's reads against this one", async () => {
    const a = freshIp();
    const held = Array.from({ length: CAP }, () => holdRead(a));
    const other = await holdRead(freshIp()).result;
    expect(other).toBe("pending");
    expect(
      (await Promise.all(held.map((h) => h.result))).every(
        (r) => r === "pending",
      ),
    ).toBe(true);
  });

  it("frees the slot when the client aborts mid-body", async () => {
    const ip = freshIp();
    for (let round = 0; round < 3; round++) {
      const held = Array.from({ length: CAP }, () => holdRead(ip));
      await new Promise((r) => setTimeout(r, EARLY_ANSWER_WAIT_MS + 100));
      for (const h of held) h.abort();
      await Promise.all(held.map((h) => h.result));
      await settle();
    }
    await expectFullCapAvailable(ip);
  });

  it("frees the slot when the read fails (413 on an oversized body)", async () => {
    const ip = freshIp();
    const oversized = Buffer.alloc(5 * 1024 * 1024, 0x20);
    const outcomes: (number | "reset")[] = [];
    for (let i = 0; i < CAP + 1; i++) {
      // The 413 closes the connection; the client may see it or a reset.
      outcomes.push(
        await post(ip, oversized, {}).then(
          (res) => res.status,
          () => "reset" as const,
        ),
      );
    }
    for (const o of outcomes) expect([413, "reset"]).toContain(o);
    process.stdout.write(
      `[body-read-cap 413] outcomes=${outcomes.join(",")}\n`,
    );
    await settle();
    await expectFullCapAvailable(ip);
  });

  it("frees the slot when the read completes", async () => {
    const ip = freshIp();
    for (let i = 0; i < CAP + 2; i++) {
      // A non-JSON body is read in full, classified legacy, and answered by
      // the legacy transport (never the modern limiter's 429).
      const res = await post(ip, "not json", {});
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).not.toBe(429);
    }
    await expectFullCapAvailable(ip);
  });

  it("frees the slot when the header-based early rate limit answers 429", async () => {
    const ip = freshIp();
    for (let i = 0; i < LIMITS.burst; i++) {
      expect(
        (
          await post(ip, JSON.stringify(TOOLS_LIST), {
            ...MODERN_LIST_HEADERS,
            "Content-Type": "application/json",
          })
        ).status,
      ).toBe(200);
    }
    const refused = await Promise.all(
      Array.from(
        { length: CAP + 2 },
        () => holdRead(ip, MODERN_LIST_HEADERS).result,
      ),
    );
    for (const r of refused) expectRateLimited(r);
    await settle();
    // The drained IP's header-less reads are not rate limited, only capped.
    await expectFullCapAvailable(ip);
  });
});
