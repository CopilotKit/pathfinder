/**
 * POST /mcp initialize captures the session analytics context through
 * requestContext(): a real initialize + tools/call through the app produces a
 * logQuery() call (mocked here) whose entry is stamped streamable_http /
 * legacy / <sent version> / <sent clientInfo.name>, with auth_client_id from
 * the bearer token.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  afterEach,
} from "vitest";

const JWT_SECRET = "e".repeat(64);

vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  getConfig: vi.fn().mockReturnValue({
    port: 0,
    databaseUrl: "pglite:///tmp/test-mcp-init-analytics",
    openaiApiKey: "k",
    githubToken: "",
    githubWebhookSecret: "",
    nodeEnv: "test",
    logLevel: "info",
    cloneDir: "/tmp/test-mcp-init-analytics",
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
    server: {
      name: "pathfinder-init-analytics",
      version: "0.0.0",
      max_sessions_per_ip: 50,
      session_ttl_minutes: 30,
      allowlist: [],
      trust_proxy: false,
    },
    sources: [],
    embedding: { provider: "openai", model: "m", dimensions: 1 },
    tools: [
      {
        name: "faq",
        type: "knowledge",
        description: "FAQ",
        sources: ["slack-faq"],
        min_confidence: 0.7,
        default_limit: 20,
        max_limit: 100,
      },
    ],
  }),
  getAnalyticsConfig: vi.fn().mockReturnValue({
    enabled: true,
    log_queries: true,
    retention_days: 90,
  }),
  hasSearchTools: vi.fn().mockReturnValue(false),
  hasKnowledgeTools: vi.fn().mockReturnValue(false),
  hasCollectTools: vi.fn().mockReturnValue(false),
  hasBashSemanticSearch: vi.fn().mockReturnValue(false),
}));
vi.mock("../db/queries.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db/queries.js")>()),
  getFaqChunks: vi.fn().mockResolvedValue([]),
  getFaqChunksByIds: vi.fn().mockResolvedValue([]),
  searchChunks: vi.fn().mockResolvedValue([]),
}));
vi.mock("../db/analytics.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db/analytics.js")>()),
  logQuery: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../indexing/embeddings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../indexing/embeddings.js")>()),
  createEmbeddingProvider: vi.fn(() => ({ embed: vi.fn() })),
}));

import { startInProcessServer } from "./helpers/inProcessServer.js";
import type { InProcessServer } from "./helpers/inProcessServer.js";
import { logQuery } from "../db/analytics.js";
import { signJWT } from "../oauth/jwt.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const mockLogQuery = vi.mocked(logQuery);

let running: InProcessServer | undefined;
let baseUrl = "";
let origin = "";

function bearer(client_id: string | undefined): string {
  const iat = Math.floor(Date.now() / 1000);
  return signJWT(
    {
      iss: origin,
      aud: origin,
      sub: "anonymous",
      ...(client_id === undefined ? {} : { client_id }),
      iat,
      exp: iat + 600,
    },
    JWT_SECRET,
  );
}

const SETTLE_MS = 50;

/**
 * Wait for the fire-and-forget logQuery instead of sleeping a fixed time:
 * poll until at least `n` calls arrive, then wait SETTLE_MS and require
 * exactly `n`. A duplicate call that is already present, or that lands
 * within the settle window, fails as a count mismatch, not a test timeout.
 */
async function waitForLogQueryCalls(n: number): Promise<void> {
  await vi.waitFor(
    () => expect(mockLogQuery.mock.calls.length).toBeGreaterThanOrEqual(n),
    { timeout: 2000, interval: 5 },
  );
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  expect(mockLogQuery).toHaveBeenCalledTimes(n);
}

/**
 * Run `body`, then `cleanup`. If `body` throws, cleanup still runs and the
 * body's error is rethrown even when cleanup also fails, so a failed close
 * never hides the original assertion. If only cleanup fails, its error is
 * thrown.
 */
async function withCleanup(
  body: () => Promise<void>,
  cleanup: () => Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (err) {
    try {
      await cleanup();
    } catch {
      // The body's error is the one to report.
    }
    throw err;
  }
  await cleanup();
}

async function initAndCall(opts: {
  token?: string;
  protocolVersion?: string;
  clientName?: string;
  extraHeaders?: Record<string, string>;
}): Promise<void> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...opts.extraHeaders,
  };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const initRes = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: opts.protocolVersion ?? "2025-03-26",
        capabilities: {},
        clientInfo: { name: opts.clientName ?? "probe-client", version: "1" },
      },
    }),
  });
  await initRes.text();
  const sid = initRes.headers.get("mcp-session-id");
  await withCleanup(
    async () => {
      expect(initRes.status).toBe(200);
      expect(sid).toBeTruthy();
      const sessHeaders = { ...headers, "mcp-session-id": sid! };
      const note = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: sessHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      });
      await note.text();
      const call = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: sessHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "faq", arguments: {} },
        }),
      });
      expect(call.status).toBe(200);
      await call.text();
      await waitForLogQueryCalls(1);
    },
    async () => {
      if (!sid) return;
      const del = await fetch(`${baseUrl}/mcp`, {
        method: "DELETE",
        headers: { ...headers, "mcp-session-id": sid },
      });
      await del.text();
      expect(del.status).toBe(200);
    },
  );
}

describe("POST /mcp initialize stamps the session analytics context", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    running = await startInProcessServer();
    baseUrl = running.baseUrl;
    // The bearer JWT aud must match this origin, so it is set only after
    // the OS-assigned port is known.
    origin = running.baseUrl;
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
    mockLogQuery.mockClear();
    logSpy.mockClear();
  });

  it("logs streamable_http / legacy / sent version / sent client name and the auth client id", async () => {
    await initAndCall({
      token: bearer("client-abc"),
      protocolVersion: "2025-03-26",
      clientName: "probe-client",
    });
    expect(mockLogQuery).toHaveBeenCalledTimes(1);
    expect(mockLogQuery.mock.calls[0][0]).toMatchObject({
      transport: "streamable_http",
      protocol_era: "legacy",
      protocol_version: "2025-03-26",
      client_name: "probe-client",
      auth_client_id: "client-abc",
    });
  });

  // The extra headers go on every request in the session, so this does not
  // show that the values are read from the init request alone.
  it("still passes request_source, client_ip and user_agent from the session's requests to logQuery", async () => {
    await initAndCall({
      token: bearer("client-ctx"),
      extraHeaders: {
        "user-agent": "ctx-probe/1.0",
        "x-pathfinder-source": "synthetic",
        // trust_proxy is false, so this must NOT become client_ip.
        "x-forwarded-for": "203.0.113.77",
      },
    });
    expect(mockLogQuery).toHaveBeenCalledTimes(1);
    const entry = mockLogQuery.mock.calls[0][0];
    expect(entry).toMatchObject({
      request_source: "synthetic",
      user_agent: "ctx-probe/1.0",
      auth_client_id: "client-ctx",
      transport: "streamable_http",
    });
    expect(entry.client_ip).toMatch(/^(::ffff:127\.0\.0\.1|127\.0\.0\.1|::1)$/);
  });

  it("auth_client_id is null when the token's client_id is empty", async () => {
    await initAndCall({ token: bearer("") });
    expect(mockLogQuery).toHaveBeenCalledTimes(1);
    expect(mockLogQuery.mock.calls[0][0]).toMatchObject({
      transport: "streamable_http",
      auth_client_id: null,
    });
  });

  it("auth_client_id is null when there is no token", async () => {
    await initAndCall({});
    expect(mockLogQuery).toHaveBeenCalledTimes(1);
    expect(mockLogQuery.mock.calls[0][0]).toMatchObject({
      transport: "streamable_http",
      protocol_era: "legacy",
      auth_client_id: null,
    });
  });

  it("logs the initialize line with version and client, control characters stripped", async () => {
    await initAndCall({
      protocolVersion: "2025-06-18",
      clientName: "evil\nname\x1b[31m",
    });
    const lines = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((l: string) => l.startsWith("[mcp] initialize "));
    expect(lines).toHaveLength(1);
    // Control characters are removed, as in the stored client_name, so no
    // client byte outside printable ASCII reaches the log.
    expect(lines[0]).not.toMatch(/[^\x20-\x7e]/);
    expect(lines[0]).toMatch(
      /^\[mcp\] initialize protocol=2025-06-18 client=evilname\[31m \[[^\]]+\]$/,
    );
  });

  it("stores the protocol version the client requested, even when unsupported", async () => {
    await initAndCall({ protocolVersion: "1999-01-01" });
    expect(mockLogQuery).toHaveBeenCalledTimes(1);
    expect(mockLogQuery.mock.calls[0][0]).toMatchObject({
      transport: "streamable_http",
      protocol_version: "1999-01-01",
    });
  });

  it("does not log the initialize line when server.connect fails", async () => {
    const connectSpy = vi
      .spyOn(McpServer.prototype, "connect")
      .mockRejectedValueOnce(new Error("injected connect failure"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "connect-fails", version: "1" },
          },
        }),
      });
      expect(res.status).toBe(500);
      await res.text();
      expect(connectSpy).toHaveBeenCalledTimes(1);
      const lines = logSpy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .filter((l: string) => l.startsWith("[mcp] initialize "));
      expect(lines).toHaveLength(0);
    } finally {
      connectSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("does not log or record an initialize the transport answers with a 4xx", async () => {
    // The transport requires both application/json and text/event-stream
    // in Accept, so this initialize connects but is answered 406.
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "rejected-406", version: "1" },
        },
      }),
    });
    await res.text();
    expect(res.status).toBe(406);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    // Give any stray fire-and-forget write time to land before checking.
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const lines = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((l: string) => l.startsWith("[mcp] initialize "));
    expect(lines).toHaveLength(0);
    expect(mockLogQuery).not.toHaveBeenCalled();
  });

  it("strips control characters from protocolVersion in the initialize line", async () => {
    await initAndCall({
      protocolVersion: "2025\n[mcp] forged\x1b[31m",
      clientName: "ok",
    });
    const lines = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((l: string) => l.includes("[mcp] initialize "));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/[^\x20-\x7e]/);
    expect(lines[0]).toContain("protocol=2025[mcp] forged[31m client=ok ");
    expect(
      logSpy.mock.calls.filter((c: unknown[]) =>
        String(c[0]).startsWith("[mcp] forged"),
      ),
    ).toHaveLength(0);
  });
});
