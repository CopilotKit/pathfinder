/**
 * Legacy-parity table for /mcp. A 2025-era (legacy) request must get the same
 * answer whether PATHFINDER_MODERN_PROTOCOL (config.modernProtocol) is on or
 * off. The file boots the real app in-process twice, once with the switch off
 * and once with it on, sends every row to both over real HTTP, and compares
 * the status, the JSON-RPC error code, whether a result came back, and whether
 * an Mcp-Session-Id header was set.
 *
 * One row pins a difference that is intended and accepted (round-1 fix A5):
 * a sessionless initialize sent as "application/json; charset" answers 400
 * with the switch off and opens a session with the switch on. If a later
 * change narrows or widens that difference, the row fails.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
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
  hasCollectTools: vi.fn().mockReturnValue(true),
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

function configFor(modernProtocol: boolean) {
  return {
    port: 0,
    databaseUrl: "pglite:///tmp/test-mcp-legacy-parity",
    openaiApiKey: "sk-test-not-used",
    githubToken: "",
    githubWebhookSecret: "",
    nodeEnv: "test",
    logLevel: "info",
    cloneDir: "/tmp/test-mcp-legacy-parity",
    slackBotToken: "",
    slackSigningSecret: "",
    discordBotToken: "",
    discordPublicKey: "",
    notionToken: "",
    mcpJwtSecret: "e".repeat(64),
    p2pTelemetryUrl: undefined,
    p2pTelemetryDisabled: true,
    packageVersion: PACKAGE_VERSION,
    modernProtocol,
  };
}

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

const LEGACY_INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "legacy-parity", version: "0.0.0" },
  },
};

const TOOLS_LIST = { jsonrpc: "2.0", id: 2, method: "tools/list" };

const TOOLS_CALL = {
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "search-docs", arguments: { query: "install" } },
};

/** Legacy POST headers: no MCP-Protocol-Version, no Mcp-Method. */
const LEGACY_HEADERS = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
  "X-Forwarded-For": FIXED_IP,
};

/**
 * A JSON media type with a malformed parameter: express.json skips it, while
 * the SDK's isJsonContentType accepts it (see round-1 fix A5).
 */
const UNPARSED_JSON_TYPE = "application/json; charset";

let port = 0;

type HttpResult = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
};

function send(
  method: "POST" | "GET" | "DELETE",
  headers: Record<string, string>,
  rawBody?: string,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/mcp",
        method,
        headers:
          rawBody === undefined
            ? headers
            : {
                ...headers,
                "Content-Length": String(Buffer.byteLength(rawBody)),
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
    if (rawBody !== undefined) req.write(rawBody);
    req.end();
  });
}

function sessionIdOf(res: HttpResult): string | undefined {
  const sid = res.headers["mcp-session-id"];
  return typeof sid === "string" ? sid : undefined;
}

async function closeSession(sid: string | undefined): Promise<void> {
  if (sid === undefined) return;
  await send("DELETE", { "Mcp-Session-Id": sid, "X-Forwarded-For": FIXED_IP });
}

async function openSession(): Promise<string> {
  const res = await send(
    "POST",
    LEGACY_HEADERS,
    JSON.stringify(LEGACY_INITIALIZE),
  );
  const sid = sessionIdOf(res);
  if (res.status !== 200 || sid === undefined) {
    throw new Error(`legacy initialize failed: ${res.status} ${res.body}`);
  }
  return sid;
}

/** Send one request on a fresh legacy session, then close that session. */
async function onSession(body: unknown): Promise<HttpResult> {
  const sid = await openSession();
  try {
    return await send(
      "POST",
      { ...LEGACY_HEADERS, "Mcp-Session-Id": sid },
      JSON.stringify(body),
    );
  } finally {
    await closeSession(sid);
  }
}

/**
 * Send a raw body on a fresh legacy session, then close that session. With
 * `chunked`, the body is sent with Transfer-Encoding: chunked and no
 * Content-Length.
 */
async function onSessionRaw(
  rawBody: string,
  chunked = false,
): Promise<HttpResult> {
  const sid = await openSession();
  try {
    return await sendBody(rawBody, chunked, { "Mcp-Session-Id": sid });
  } finally {
    await closeSession(sid);
  }
}

/** POST /mcp with legacy headers and a raw body, optionally chunked. */
function sendBody(
  rawBody: string,
  chunked: boolean,
  extra: Record<string, string> = {},
): Promise<HttpResult> {
  if (!chunked) return send("POST", { ...LEGACY_HEADERS, ...extra }, rawBody);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          ...LEGACY_HEADERS,
          ...extra,
          "Transfer-Encoding": "chunked",
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
    if (rawBody !== "") req.write(rawBody);
    req.end();
  });
}

/** The part of an answer that must not depend on the switch. */
type Observed = {
  status: number;
  errorCode: number | null;
  hasResult: boolean;
  hasSessionId: boolean;
};

function observe(res: HttpResult): Observed {
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    parsed = undefined;
  }
  const obj =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  const error = obj.error;
  const code =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "code")
      : undefined;
  return {
    status: res.status,
    errorCode: typeof code === "number" ? code : null,
    hasResult: obj.result !== undefined,
    hasSessionId: sessionIdOf(res) !== undefined,
  };
}

type Row = { name: string; run: () => Promise<HttpResult> };

/** [label, raw body, send chunked] */
const BODY_SHAPES: ReadonlyArray<readonly [string, string, boolean]> = [
  ["an empty chunked application/json body", "", true],
  ["a literal {} body", "{}", false],
  ["an empty array body", "[]", false],
  [
    "a batch array of one tools/list request",
    JSON.stringify([TOOLS_LIST]),
    false,
  ],
  ["a body that is not valid JSON", '{"jsonrpc": "2.0", "id": 1,', false],
];

const ROWS: Row[] = [
  {
    name: "initialize with application/json opens a session",
    run: async () => {
      const res = await send(
        "POST",
        LEGACY_HEADERS,
        JSON.stringify(LEGACY_INITIALIZE),
      );
      await closeSession(sessionIdOf(res));
      return res;
    },
  },
  {
    name: "tools/list on an existing session",
    run: () => onSession(TOOLS_LIST),
  },
  {
    name: "tools/call on an existing session",
    run: () => onSession(TOOLS_CALL),
  },
  {
    name: "tools/call on an existing session with application/json; charset",
    run: async () => {
      const sid = await openSession();
      try {
        return await send(
          "POST",
          {
            ...LEGACY_HEADERS,
            "Content-Type": UNPARSED_JSON_TYPE,
            "Mcp-Session-Id": sid,
          },
          JSON.stringify(TOOLS_CALL),
        );
      } finally {
        await closeSession(sid);
      }
    },
  },
  {
    name: "tools/list with an unknown session id (404)",
    run: () =>
      send(
        "POST",
        { ...LEGACY_HEADERS, "Mcp-Session-Id": "no-such-session" },
        JSON.stringify(TOOLS_LIST),
      ),
  },
  {
    name: "tools/call with no session id (400)",
    run: () => send("POST", LEGACY_HEADERS, JSON.stringify(TOOLS_CALL)),
  },
  {
    name: "GET with no session (405)",
    run: () =>
      send("GET", { Accept: "text/event-stream", "X-Forwarded-For": FIXED_IP }),
  },
  {
    name: 'DELETE with no session (400 "Missing session ID")',
    run: () => send("DELETE", { "X-Forwarded-For": FIXED_IP }),
  },
  {
    name: "initialize with a text/plain body",
    run: async () => {
      const res = await send(
        "POST",
        { ...LEGACY_HEADERS, "Content-Type": "text/plain" },
        JSON.stringify(LEGACY_INITIALIZE),
      );
      await closeSession(sessionIdOf(res));
      return res;
    },
  },
  {
    name: "initialize with no Content-Type",
    run: async () => {
      const { "Content-Type": _drop, ...noType } = LEGACY_HEADERS;
      const res = await send("POST", noType, JSON.stringify(LEGACY_INITIALIZE));
      await closeSession(sessionIdOf(res));
      return res;
    },
  },
  {
    // Over express.json's 100 kB default, under the SDK's 4 MiB limit. The
    // over-4-MiB text/plain case is in mcp-modern-classifier.test.ts.
    name: "an oversized application/json initialize body",
    run: () =>
      send(
        "POST",
        LEGACY_HEADERS,
        JSON.stringify({
          ...LEGACY_INITIALIZE,
          params: { ...LEGACY_INITIALIZE.params, pad: "a".repeat(200_000) },
        }),
      ),
  },
  {
    // express.json turns an empty application/json body into {}. The
    // classifier must still send it to the legacy leg (Round 2, R2-A6).
    name: "an empty application/json body",
    run: () => send("POST", LEGACY_HEADERS, ""),
  },
  // Body shapes that are not one valid JSON-RPC message, each with no session
  // and on an existing session (Round 2, R2-A6 residuals).
  ...BODY_SHAPES.flatMap(([label, raw, chunked]): Row[] => [
    {
      name: `${label}, no session`,
      run: () => sendBody(raw, chunked),
    },
    {
      name: `${label}, on an existing session`,
      run: () => onSessionRaw(raw, chunked),
    },
  ]),
];

/**
 * ACCEPTED DIFFERENCE (round-1 fix A5, accepted in the Round 2 decisions and
 * documented in the PR body). With the switch on, the classifier parses a
 * body that express.json skipped and sets req.body, so the legacy transport
 * sees the initialize and opens a session. With the switch off, req.body
 * stays undefined and the legacy leg answers 400.
 */
async function sessionlessInitializeWithCharset(): Promise<HttpResult> {
  const res = await send(
    "POST",
    { ...LEGACY_HEADERS, "Content-Type": UNPARSED_JSON_TYPE },
    JSON.stringify(LEGACY_INITIALIZE),
  );
  await closeSession(sessionIdOf(res));
  return res;
}

async function boot(modernProtocol: boolean): Promise<InProcessServer> {
  vi.mocked(getConfig).mockReturnValue(
    configFor(modernProtocol) as unknown as ReturnType<typeof getConfig>,
  );
  vi.mocked(getServerConfig).mockReturnValue(
    SERVER_CONFIG as unknown as ReturnType<typeof getServerConfig>,
  );
  vi.mocked(getAnalyticsConfig).mockReturnValue(undefined);
  vi.mocked(hasSearchTools).mockReturnValue(true);
  vi.mocked(hasKnowledgeTools).mockReturnValue(false);
  vi.mocked(hasCollectTools).mockReturnValue(true);
  vi.mocked(hasBashSemanticSearch).mockReturnValue(false);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  const running = await startInProcessServer();
  port = Number(new URL(running.baseUrl).port);
  return running;
}

type Run = { rows: Observed[]; accepted: HttpResult };

/** Boot one server, send every row in order, stop the server. */
async function runAll(modernProtocol: boolean): Promise<Run> {
  const running = await boot(modernProtocol);
  try {
    const rows: Observed[] = [];
    for (const row of ROWS) rows.push(observe(await row.run()));
    const accepted = await sessionlessInitializeWithCharset();
    return { rows, accepted };
  } finally {
    try {
      await running.stop();
    } finally {
      vi.restoreAllMocks();
    }
  }
}

describe("/mcp legacy parity: switch off vs switch on", () => {
  let off: Run;
  let on: Run;

  // One in-process server at a time (see helpers/inProcessServer.ts).
  beforeAll(async () => {
    off = await runAll(false);
    on = await runAll(true);
  }, 60_000);

  it.each(ROWS.map((row, i) => [row.name, i] as const))(
    "%s: same answer with the switch on and off",
    (_name, i) => {
      expect(on.rows[i]).toEqual(off.rows[i]);
    },
  );

  it("pins the expected switch-off answers, so the table cannot pass on two equal failures", () => {
    const byName = (name: string) =>
      off.rows[ROWS.findIndex((r) => r.name === name)];
    expect(byName("initialize with application/json opens a session")).toEqual({
      status: 200,
      errorCode: null,
      hasResult: true,
      hasSessionId: true,
    });
    expect(byName("tools/call on an existing session")).toMatchObject({
      status: 200,
      errorCode: null,
      hasResult: true,
    });
    expect(byName("tools/list with an unknown session id (404)").status).toBe(
      404,
    );
    expect(byName("tools/call with no session id (400)").status).toBe(400);
    expect(byName("GET with no session (405)").status).toBe(405);
    expect(byName('DELETE with no session (400 "Missing session ID")')).toEqual(
      { status: 400, errorCode: -32000, hasResult: false, hasSessionId: false },
    );
    expect(byName("an empty application/json body")).toEqual({
      status: 400,
      errorCode: -32000,
      hasResult: false,
      hasSessionId: false,
    });
  });

  it("ACCEPTED DIFFERENCE (A5): a sessionless initialize with application/json; charset answers 400 with the switch off and opens a session with the switch on", () => {
    expect(observe(off.accepted)).toMatchObject({
      status: 400,
      hasSessionId: false,
    });
    expect(observe(on.accepted)).toEqual({
      status: 200,
      errorCode: null,
      hasResult: true,
      hasSessionId: true,
    });
  });
});
