/**
 * GET /sse + POST /messages capture the session analytics context through
 * requestContext(): auth id from the bearer token (transport and era are
 * fixed for SSE), protocol version and client name from the initialize
 * message POSTed to /messages. These tests send the same token on GET /sse
 * and on every POST /messages, so they do not show which request the auth
 * id is read from. User-Agent and source are sent on GET /sse only.
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
    databaseUrl: "pglite:///tmp/test-sse-analytics-context",
    openaiApiKey: "k",
    githubToken: "",
    githubWebhookSecret: "",
    nodeEnv: "test",
    logLevel: "info",
    cloneDir: "/tmp/test-sse-analytics-context",
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
      name: "pathfinder-sse-analytics",
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

interface SseSession {
  post: (body: unknown) => Promise<Response>;
  close: () => Promise<void>;
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
async function withCleanup<T>(
  body: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  let result: T;
  try {
    result = await body();
  } catch (err) {
    try {
      await cleanup();
    } catch {
      // The body's error is the one to report.
    }
    throw err;
  }
  await cleanup();
  return result;
}

async function openSse(
  token?: string,
  extraHeaders: Record<string, string> = {},
): Promise<SseSession> {
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
    ...extraHeaders,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const sseRes = await fetch(`${baseUrl}/sse`, { headers });
  // Every check runs inside the try, so a failed status check or a missing
  // endpoint event still cancels the open stream instead of leaking it.
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let endpoint: string;
  try {
    expect(sseRes.status).toBe(200);
    expect(sseRes.body).not.toBeNull();
    reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!buffer.includes("event: endpoint")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE stream closed prematurely");
      buffer += decoder.decode(value, { stream: true });
    }
    const m = buffer.match(/data: (\/messages\?sessionId=[0-9a-f-]+)/);
    expect(m).not.toBeNull();
    endpoint = m![1];
  } catch (err) {
    try {
      await (reader ? reader.cancel() : sseRes.body?.cancel());
    } catch {
      // The original error is the one to report.
    }
    throw err;
  }
  const open = reader;
  return {
    post: (body) =>
      fetch(`${baseUrl}${endpoint}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    close: async () => {
      await open.cancel();
    },
  };
}

async function sseInitAndCall(opts: {
  token?: string;
  protocolVersion?: string;
  clientName?: string;
  skipInit?: boolean;
  extraHeaders?: Record<string, string>;
}): Promise<void> {
  const s = await openSse(opts.token, opts.extraHeaders);
  await withCleanup(async () => {
    if (!opts.skipInit) {
      const init = await s.post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: opts.protocolVersion ?? "2024-11-05",
          capabilities: {},
          clientInfo: { name: opts.clientName ?? "sse-probe", version: "1" },
        },
      });
      expect(init.status).toBe(202);
      await init.text();
    }
    const call = await s.post({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "faq", arguments: {} },
    });
    expect(call.status).toBe(202);
    await call.text();
    // POST /messages answers 202 before the tool runs, so wait for the call.
    await waitForLogQueryCalls(1);
  }, s.close);
}

describe("GET /sse + POST /messages stamp the session analytics context", () => {
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

  it("logs sse / legacy / sent version / sent client name and the auth client id", async () => {
    await sseInitAndCall({
      token: bearer("client-abc"),
      protocolVersion: "2024-11-05",
      clientName: "sse-probe",
    });
    expect(mockLogQuery).toHaveBeenCalledTimes(1);
    expect(mockLogQuery.mock.calls[0][0]).toMatchObject({
      transport: "sse",
      protocol_era: "legacy",
      protocol_version: "2024-11-05",
      client_name: "sse-probe",
      auth_client_id: "client-abc",
    });
  });

  it("still passes request_source, client_ip and user_agent from GET /sse to logQuery", async () => {
    await sseInitAndCall({
      token: bearer("client-ctx"),
      extraHeaders: {
        "user-agent": "sse-ctx-probe/1.0",
        "x-pathfinder-source": "synthetic",
        // trust_proxy is false, so this must NOT become client_ip.
        "x-forwarded-for": "203.0.113.77",
      },
    });
    expect(mockLogQuery).toHaveBeenCalledTimes(1);
    const entry = mockLogQuery.mock.calls[0][0];
    expect(entry).toMatchObject({
      request_source: "synthetic",
      user_agent: "sse-ctx-probe/1.0",
      auth_client_id: "client-ctx",
      transport: "sse",
    });
    expect(entry.client_ip).toMatch(/^(::ffff:127\.0\.0\.1|127\.0\.0\.1|::1)$/);
  });

  it("auth_client_id is null when the token's client_id is empty", async () => {
    await sseInitAndCall({ token: bearer("") });
    expect(mockLogQuery).toHaveBeenCalledTimes(1);
    expect(mockLogQuery.mock.calls[0][0]).toMatchObject({
      transport: "sse",
      auth_client_id: null,
    });
  });

  it("auth_client_id is null with no token", async () => {
    await sseInitAndCall({});
    expect(mockLogQuery).toHaveBeenCalledTimes(1);
    expect(mockLogQuery.mock.calls[0][0]).toMatchObject({
      transport: "sse",
      protocol_era: "legacy",
      auth_client_id: null,
    });
  });

  it("version and client are null when no initialize was posted", async () => {
    await sseInitAndCall({ skipInit: true });
    expect(mockLogQuery).toHaveBeenCalledTimes(1);
    expect(mockLogQuery.mock.calls[0][0]).toMatchObject({
      transport: "sse",
      protocol_version: null,
      client_name: null,
    });
  });

  const initBody = (clientName: string, protocolVersion = "2024-11-05") => ({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: clientName, version: "1" },
    },
  });
  const faqCall = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "faq", arguments: {} },
  };
  const sseInitLines = (): string[] =>
    logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((l: string) => l.includes("[mcp] SSE initialize "));

  it("does not record or log an initialize the transport rejects", async () => {
    const s = await openSse();
    await withCleanup(async () => {
      // A valid initialize shape with no `jsonrpc` field: the transport
      // rejects it as an invalid JSON-RPC message with a 400.
      const { jsonrpc: _omit, ...rejected } = initBody("rejected-client");
      const bad = await s.post(rejected);
      expect(bad.status).toBe(400);
      await bad.text();
      const call = await s.post(faqCall);
      expect(call.status).toBe(202);
      await call.text();
      await waitForLogQueryCalls(1);
    }, s.close);
    expect(sseInitLines()).toHaveLength(0);
    expect(mockLogQuery).toHaveBeenCalledTimes(1);
    expect(mockLogQuery.mock.calls[0][0]).toMatchObject({
      transport: "sse",
      protocol_version: null,
      client_name: null,
    });
  });

  it("keeps the first accepted initialize; a later one does not overwrite it", async () => {
    const s = await openSse();
    await withCleanup(async () => {
      const first = await s.post(initBody("first-client", "2024-11-05"));
      expect(first.status).toBe(202);
      await first.text();
      const second = await s.post(initBody("second-client", "2025-03-26"));
      expect(second.status).toBe(202);
      await second.text();
      const call = await s.post(faqCall);
      expect(call.status).toBe(202);
      await call.text();
      await waitForLogQueryCalls(1);
    }, s.close);
    expect(mockLogQuery).toHaveBeenCalledTimes(1);
    expect(mockLogQuery.mock.calls[0][0]).toMatchObject({
      transport: "sse",
      protocol_version: "2024-11-05",
      client_name: "first-client",
    });
    const lines = sseInitLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("client=first-client");
  });

  it("stores the protocol version the client requested, even when unsupported", async () => {
    await sseInitAndCall({ protocolVersion: "1999-01-01" });
    expect(mockLogQuery).toHaveBeenCalledTimes(1);
    expect(mockLogQuery.mock.calls[0][0]).toMatchObject({
      transport: "sse",
      protocol_version: "1999-01-01",
    });
  });

  it("logs the SSE initialize line with control characters stripped", async () => {
    await sseInitAndCall({
      protocolVersion: "2024\n[mcp] forged\x1b[31m",
      clientName: "evil\nname",
    });
    const lines = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((l: string) => l.includes("[mcp] SSE initialize "));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/[^\x20-\x7e]/);
    expect(lines[0]).toMatch(
      /^\[mcp\] SSE initialize protocol=2024\[mcp\] forged\[31m client=evilname sid=[0-9a-f]{8} ip=\S+$/,
    );
    expect(
      logSpy.mock.calls.filter((c: unknown[]) =>
        String(c[0]).startsWith("[mcp] forged"),
      ),
    ).toHaveLength(0);
  });
});
