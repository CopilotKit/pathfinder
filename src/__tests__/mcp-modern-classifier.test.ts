/**
 * Route-level coverage for failures of the era classifier on POST /mcp. With
 * the modern switch on, every POST is classified before it is routed, and the
 * classifier reads the request stream when express.json did not parse the
 * body. That read can fail: the body is over the SDK size limit, the client
 * aborts mid-body, or the probe Request cannot be built. Each failure must get
 * its own answer, not the generic outer-catch 500 and its error-level log.
 *
 * Boots the real app in-process and drives /mcp over real sockets.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import http from "node:http";
import net from "node:net";

vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  getConfig: vi.fn(),
  getServerConfig: vi.fn(),
  getAnalyticsConfig: vi.fn().mockReturnValue(undefined),
  hasSearchTools: vi.fn().mockReturnValue(true),
  hasKnowledgeTools: vi.fn().mockReturnValue(false),
  hasCollectTools: vi.fn().mockReturnValue(false),
  hasBashSemanticSearch: vi.fn().mockReturnValue(false),
}));

import {
  getConfig,
  getServerConfig,
  getAnalyticsConfig,
  hasSearchTools,
  hasKnowledgeTools,
  hasCollectTools,
  hasBashSemanticSearch,
} from "../config.js";
import {
  startInProcessServer,
  type InProcessServer,
} from "./helpers/inProcessServer.js";

const FIXED_IP = "198.51.100.9";
const OUTER_CATCH_LOG = "[MCP] Error handling POST request";
const CLASSIFIER_LOG = "[mcp] era classification failed";
/** Over the SDK's 4 MiB DEFAULT_MAX_REQUEST_BODY_SIZE. */
const OVERSIZED_BYTES = 5 * 1024 * 1024;

function configFor(modernProtocol: boolean) {
  return {
    port: 0,
    databaseUrl: "pglite:///tmp/test-mcp-modern-classifier",
    openaiApiKey: "sk-test-not-used",
    githubToken: "",
    githubWebhookSecret: "",
    nodeEnv: "test",
    logLevel: "info",
    cloneDir: "/tmp/test-mcp-modern-classifier",
    slackBotToken: "",
    slackSigningSecret: "",
    discordBotToken: "",
    discordPublicKey: "",
    notionToken: "",
    mcpJwtSecret: "e".repeat(64),
    p2pTelemetryUrl: undefined,
    p2pTelemetryDisabled: true,
    packageVersion: "test",
    modernProtocol,
  };
}

const SERVER_CONFIG = {
  server: {
    name: "pathfinder-modern-classifier",
    version: "0.0.0",
    max_sessions_per_ip: 50,
    session_ttl_minutes: 30,
    allowlist: [],
    trust_proxy: true,
  },
  embedding: {
    provider: "openai",
    model: "text-embedding-3-small",
    dimensions: 1536,
  },
  sources: [],
  tools: [
    {
      name: "search-docs",
      type: "search",
      description: "Search docs.",
      source: "docs",
      default_limit: 5,
      max_limit: 20,
      result_format: "docs",
      search_mode: "keyword",
    },
  ],
};

let running: InProcessServer | undefined;
let port = 0;

async function boot(modernProtocol: boolean) {
  vi.mocked(getConfig).mockReturnValue(
    configFor(modernProtocol) as unknown as ReturnType<typeof getConfig>,
  );
  vi.mocked(getServerConfig).mockReturnValue(
    SERVER_CONFIG as unknown as ReturnType<typeof getServerConfig>,
  );
  vi.mocked(getAnalyticsConfig).mockReturnValue(undefined);
  vi.mocked(hasSearchTools).mockReturnValue(true);
  vi.mocked(hasKnowledgeTools).mockReturnValue(false);
  vi.mocked(hasCollectTools).mockReturnValue(false);
  vi.mocked(hasBashSemanticSearch).mockReturnValue(false);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  running = await startInProcessServer();
  port = Number(new URL(running.baseUrl).port);
}

async function shutdown() {
  try {
    await running?.stop();
  } finally {
    running = undefined;
    vi.restoreAllMocks();
  }
}

/** Every console.error line so far, each call joined into one string. */
function errorLines(): string[] {
  return vi
    .mocked(console.error)
    .mock.calls.map((args: unknown[]) => args.map(String).join(" "));
}

type HttpResult = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
};

/**
 * POST a text/plain request that declares `bytes` bytes but sends only a
 * short prefix, then read the reply. A Content-Length over the SDK limit is
 * rejected before the body is read, so the prefix is enough, and the client
 * is not still writing when the server answers and closes the connection.
 */
async function postOversized(bytes: number): Promise<HttpResult> {
  const reply = await rawExchange(
    "POST /mcp HTTP/1.1\r\n" +
      "Host: 127.0.0.1\r\n" +
      "Accept: application/json, text/event-stream\r\n" +
      "Content-Type: text/plain\r\n" +
      `Content-Length: ${bytes}\r\n` +
      `X-Forwarded-For: ${FIXED_IP}\r\n\r\n` +
      "a".repeat(1024),
    { endOnReply: true },
  );
  const [head, ...rest] = reply.split("\r\n\r\n");
  const [statusLine, ...headerLines] = head.split("\r\n");
  const headers: http.IncomingHttpHeaders = {};
  for (const line of headerLines) {
    const i = line.indexOf(":");
    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return {
    status: Number(statusLine.split(" ")[1]),
    headers,
    body: rest.join("\r\n\r\n"),
  };
}

/**
 * Send raw bytes on a fresh socket and collect the reply until the server
 * closes. With `endOnReply`, stop once one complete reply with a
 * Content-Length body has arrived, so a server that keeps the socket open
 * waiting for the rest of a declared body does not hang the test.
 */
function rawExchange(
  request: string,
  opts: { endOnReply?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.write(request));
    let data = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(data);
    };
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      data += chunk;
      if (!opts.endOnReply) return;
      const split = data.indexOf("\r\n\r\n");
      if (split === -1) return;
      const m = /\r\ncontent-length:\s*(\d+)/i.exec(data.slice(0, split));
      if (m && Buffer.byteLength(data.slice(split + 4)) >= Number(m[1])) {
        finish();
      }
    });
    sock.on("end", finish);
    sock.on("close", finish);
    sock.on("error", (err) => (done ? undefined : reject(err)));
  });
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe(
  "/mcp classifier failures: modern protocol on",
  { timeout: 30_000 },
  () => {
    beforeAll(() => boot(true));
    afterAll(shutdown);
    beforeEach(() => {
      vi.mocked(console.error).mockClear();
    });

    it("an oversized text/plain body answers 413 JSON-RPC with connection: close, not a 500", async () => {
      const res = await postOversized(OVERSIZED_BYTES);
      expect(res.status).toBe(413);
      expect(res.headers["connection"]).toBe("close");
      const body = JSON.parse(res.body);
      expect(body.jsonrpc).toBe("2.0");
      expect(body.id).toBeNull();
      expect(body.error.code).toBe(-32000);
      expect(body.error.message).toContain("Payload Too Large");
      expect(errorLines().some((l) => l.includes(OUTER_CATCH_LOG))).toBe(false);
    });

    it("a client abort mid-body is quiet: no error-level log", async () => {
      await new Promise<void>((resolve, reject) => {
        const sock = net.connect(port, "127.0.0.1", () => {
          sock.write(
            "POST /mcp HTTP/1.1\r\n" +
              "Host: 127.0.0.1\r\n" +
              "Content-Type: text/plain\r\n" +
              "Content-Length: 1000\r\n" +
              `X-Forwarded-For: ${FIXED_IP}\r\n\r\n` +
              "partial",
            () => setTimeout(() => (sock.destroy(), resolve()), 100),
          );
        });
        sock.on("error", reject);
      });
      await settle(500);
      expect(errorLines()).toEqual([]);
    });

    it("any other classifier throw logs the classifier line and answers 500 echoing the id", async () => {
      // A Host with a space makes the probe's `new Request(url)` throw.
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 42,
        method: "tools/list",
      });
      const reply = await rawExchange(
        "POST /mcp HTTP/1.1\r\n" +
          "Host: bad host\r\n" +
          "Accept: application/json, text/event-stream\r\n" +
          "Content-Type: application/json\r\n" +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          `X-Forwarded-For: ${FIXED_IP}\r\n` +
          "Connection: close\r\n\r\n" +
          body,
        { endOnReply: true },
      );
      expect(reply.startsWith("HTTP/1.1 500")).toBe(true);
      const json = JSON.parse(reply.slice(reply.indexOf("\r\n\r\n") + 4));
      expect(json.id).toBe(42);
      expect(json.error.code).toBe(-32603);
      const lines = errorLines();
      expect(lines.some((l) => l.includes(CLASSIFIER_LOG))).toBe(true);
      expect(lines.some((l) => l.includes(OUTER_CATCH_LOG))).toBe(false);
    });
  },
);

describe(
  "/mcp classifier failures: modern protocol off (control)",
  { timeout: 30_000 },
  () => {
    beforeAll(() => boot(false));
    afterAll(shutdown);

    beforeEach(() => {
      vi.mocked(console.error).mockClear();
    });

    it("an oversized sessionless text/plain body keeps the legacy 400 no-session answer", async () => {
      const res = await postOversized(OVERSIZED_BYTES);
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe(-32000);
      expect(errorLines()).toEqual([]);
    });
  },
);
