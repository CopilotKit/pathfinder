/**
 * Route-level coverage for error logging on the 2026-07-28 (stateless) leg of
 * /mcp. The SDK's createMcpHandler catches factory and serving failures,
 * answers 500 or a 4xx, and reports the error only through its `onerror`
 * option. These tests boot the real app and check that the failure reaches
 * the server log: an internal failure at error level, and a client
 * rejection at warn level.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  afterEach,
  type MockInstance,
} from "vitest";
import http from "node:http";
import { readFileSync } from "node:fs";

const PACKAGE_VERSION: string = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version;

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

/** When set, the next modern createMcpServer call throws this message. */
const factoryFault = vi.hoisted(() => ({
  message: undefined as string | undefined,
}));

vi.mock("../mcp/server.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../mcp/server.js")>();
  return {
    ...real,
    createMcpServer: (
      ...args: Parameters<typeof real.createMcpServer>
    ): ReturnType<typeof real.createMcpServer> => {
      const message = factoryFault.message;
      if (message !== undefined) {
        factoryFault.message = undefined;
        throw new Error(message);
      }
      return real.createMcpServer(...args);
    },
  };
});

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

const MODERN_VERSION = "2026-07-28";

const CONFIG = {
  port: 0,
  databaseUrl: "pglite:///tmp/test-mcp-modern-onerror",
  openaiApiKey: "sk-test-not-used",
  githubToken: "",
  githubWebhookSecret: "",
  nodeEnv: "test",
  logLevel: "info",
  cloneDir: "/tmp/test-mcp-modern-onerror",
  slackBotToken: "",
  slackSigningSecret: "",
  discordBotToken: "",
  discordPublicKey: "",
  notionToken: "",
  mcpJwtSecret: "f".repeat(64),
  p2pTelemetryUrl: undefined,
  p2pTelemetryDisabled: true,
  packageVersion: PACKAGE_VERSION,
  modernProtocol: true,
};

const SERVER_CONFIG = {
  server: {
    name: "pathfinder-docs",
    version: PACKAGE_VERSION,
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

const META = {
  "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
  "io.modelcontextprotocol/clientInfo": { name: "onerror-test", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

const MODERN_HEADERS = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
  "MCP-Protocol-Version": MODERN_VERSION,
  "X-Forwarded-For": "198.51.100.9",
};

let running: InProcessServer | undefined;
let port = 0;
let errorSpy: MockInstance<typeof console.error>;
let warnSpy: MockInstance<typeof console.warn>;

/** POST one modern JSON-RPC body to /mcp; resolves with status and body. */
function modernPost(
  body: unknown,
  extra: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const raw = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          ...MODERN_HEADERS,
          ...extra,
          "Content-Length": String(Buffer.byteLength(raw)),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: data }),
        );
      },
    );
    req.on("error", reject);
    req.write(raw);
    req.end();
  });
}

/** Every console call's arguments joined into one string per call. */
function lines(spy: MockInstance<(...args: unknown[]) => void>): string[] {
  return spy.mock.calls.map((args) =>
    args.map((a) => (a instanceof Error ? a.stack : String(a))).join(" "),
  );
}

describe("/mcp modern leg: SDK-caught failures reach the log", () => {
  beforeAll(async () => {
    vi.mocked(getConfig).mockReturnValue(
      CONFIG as unknown as ReturnType<typeof getConfig>,
    );
    vi.mocked(getServerConfig).mockReturnValue(
      SERVER_CONFIG as unknown as ReturnType<typeof getServerConfig>,
    );
    vi.mocked(getAnalyticsConfig).mockReturnValue(undefined);
    vi.mocked(hasSearchTools).mockReturnValue(true);
    vi.mocked(hasKnowledgeTools).mockReturnValue(false);
    vi.mocked(hasCollectTools).mockReturnValue(false);
    vi.mocked(hasBashSemanticSearch).mockReturnValue(false);
    vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
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

  afterEach(() => {
    factoryFault.message = undefined;
    errorSpy.mockClear();
    warnSpy.mockClear();
  });

  it("a buildServer throw on a modern tools/list answers 500 and logs the error with its stack", async () => {
    factoryFault.message = "onerror-probe: factory exploded";
    const res = await modernPost(
      { jsonrpc: "2.0", id: 7, method: "tools/list", params: { _meta: META } },
      { "Mcp-Method": "tools/list" },
    );
    expect(res.status).toBe(500);
    // The fault fired: the factory was reached, so this is not a routing miss.
    expect(factoryFault.message).toBeUndefined();

    const logged = lines(errorSpy).filter((l) =>
      l.includes("onerror-probe: factory exploded"),
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("[mcp]");
    // The stack, not only the message, so the throw site is findable.
    expect(logged[0]).toMatch(/\n\s+at /);
  });

  it("a header-mismatch rejection logs at warn, not error", async () => {
    const res = await modernPost(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "search-docs", arguments: { query: "x" }, _meta: META },
      },
      { "Mcp-Method": "tools/list", "Mcp-Name": "search-docs" },
    );
    expect(res.status).toBe(400);

    const warned = lines(warnSpy).filter((l) =>
      l.includes("Rejected inbound request"),
    );
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("[mcp]");
    expect(
      lines(errorSpy).filter((l) => l.includes("Rejected inbound request")),
    ).toHaveLength(0);
  });
});
