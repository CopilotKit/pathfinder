/**
 * Route-level coverage for the 2026-07-28 (stateless) protocol on /mcp. Boots
 * the real app in-process with startInProcessServer() and drives POST, GET and
 * DELETE /mcp over HTTP, so a request that the server does not route to the
 * modern handler fails a test. Request shapes follow the modern curl probe.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
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

const MODERN_VERSION = "2026-07-28";
const FIXED_IP = "198.51.100.7";

function configFor(modernProtocol: boolean) {
  return {
    port: 0,
    databaseUrl: "pglite:///tmp/test-mcp-modern-routes",
    openaiApiKey: "sk-test-not-used",
    githubToken: "",
    githubWebhookSecret: "",
    nodeEnv: "test",
    logLevel: "info",
    cloneDir: "/tmp/test-mcp-modern-routes",
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
    {
      name: "explore-docs",
      type: "bash",
      description: "Explore docs.",
      sources: ["docs"],
      bash: { session_state: true },
    },
    {
      name: "submit-feedback",
      type: "collect",
      description: "Submit feedback.",
      response: "Thanks.",
      schema: { rating: { type: "enum", values: ["helpful", "not_helpful"] } },
    },
  ],
};

const META = {
  "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
  "io.modelcontextprotocol/clientInfo": {
    name: "route-test-modern",
    version: "0",
  },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function modernBody(
  method: string,
  id: number,
  params: Record<string, unknown> = {},
) {
  return { jsonrpc: "2.0", id, method, params: { ...params, _meta: META } };
}

function toolCall(id: number, name: string, args: Record<string, unknown>) {
  return modernBody("tools/call", id, { name, arguments: args });
}

const MODERN_HEADERS = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
  "MCP-Protocol-Version": MODERN_VERSION,
  "X-Forwarded-For": FIXED_IP,
};

const LEGACY_INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "route-test-legacy", version: "0.0.0" },
  },
};

let running: InProcessServer | undefined;
let port = 0;
let logSpy: MockInstance<typeof console.log> | undefined;

type HttpResult = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
};

/** Send one request to /mcp with exactly the given headers and raw body. */
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

/** A modern POST. `extra` adds to or overrides the modern headers. */
function modernPost(
  body: unknown,
  extra: Record<string, string> = {},
): Promise<HttpResult> {
  return send("POST", { ...MODERN_HEADERS, ...extra }, JSON.stringify(body));
}

function modernCall(id: number, name: string, args: Record<string, unknown>) {
  return modernPost(toolCall(id, name, args), {
    "Mcp-Method": "tools/call",
    "Mcp-Name": name,
  });
}

function json(res: HttpResult): Record<string, any> {
  return JSON.parse(res.body);
}

async function legacyInitialize(): Promise<string> {
  const res = await send(
    "POST",
    {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "X-Forwarded-For": FIXED_IP,
    },
    JSON.stringify(LEGACY_INITIALIZE),
  );
  const sid = res.headers["mcp-session-id"];
  if (res.status !== 200 || typeof sid !== "string") {
    throw new Error(`legacy initialize failed: ${res.status} ${res.body}`);
  }
  return sid;
}

function legacyPost(sid: string, body: unknown): Promise<HttpResult> {
  return send(
    "POST",
    {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "Mcp-Session-Id": sid,
      "X-Forwarded-For": FIXED_IP,
    },
    JSON.stringify(body),
  );
}

/**
 * A Content-Type whose media type is application/json but whose parameter is
 * malformed. express.json does not parse it (req.body stays undefined), while
 * the SDK's isJsonContentType accepts it, so the transport reads the body from
 * the request stream itself.
 */
const UNPARSED_JSON_TYPE = "application/json; charset";

/**
 * A legacy session tools/call search sent with UNPARSED_JSON_TYPE. Must answer
 * the same 200 result whether the modern switch is on or off.
 */
async function expectLegacyUnparsedJsonCallWorks(): Promise<void> {
  const sid = await legacyInitialize();
  try {
    const res = await send(
      "POST",
      {
        Accept: "application/json, text/event-stream",
        "Content-Type": UNPARSED_JSON_TYPE,
        "Mcp-Session-Id": sid,
        "X-Forwarded-For": FIXED_IP,
      },
      JSON.stringify({
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: { name: "search-docs", arguments: { query: "install" } },
      }),
    );
    expect(res.status).toBe(200);
    const body = json(res);
    expect(body.id).toBe(21);
    expect(body.error).toBeUndefined();
    expect(Array.isArray(body.result.content)).toBe(true);
  } finally {
    await send("DELETE", {
      "Mcp-Session-Id": sid,
      "X-Forwarded-For": FIXED_IP,
    });
  }
}

async function boot(modernProtocol: boolean) {
  vi.mocked(getConfig).mockReturnValue(
    configFor(modernProtocol) as unknown as ReturnType<typeof getConfig>,
  );
  vi.mocked(getServerConfig).mockReturnValue(
    SERVER_CONFIG as unknown as ReturnType<typeof getServerConfig>,
  );
  // restoreAllMocks() in shutdown() may reset these, so set them on every boot.
  vi.mocked(getAnalyticsConfig).mockReturnValue(undefined);
  vi.mocked(hasSearchTools).mockReturnValue(true);
  vi.mocked(hasKnowledgeTools).mockReturnValue(false);
  vi.mocked(hasCollectTools).mockReturnValue(true);
  vi.mocked(hasBashSemanticSearch).mockReturnValue(false);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
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

describe("/mcp routes: modern protocol on", () => {
  beforeAll(() => boot(true));
  afterAll(shutdown);

  it("server/discover answers 200 with the supported versions and serverInfo in _meta", async () => {
    const res = await modernPost(modernBody("server/discover", 1), {
      "Mcp-Method": "server/discover",
    });
    expect(res.status).toBe(200);
    const body = json(res);
    expect(body.result.supportedVersions).toContain(MODERN_VERSION);
    expect(body.result._meta["io.modelcontextprotocol/serverInfo"]).toEqual({
      name: "pathfinder-docs",
      version: PACKAGE_VERSION,
    });
    expect(body.result.serverInfo).toBeUndefined();
    expect(res.headers["mcp-session-id"]).toBeUndefined();
  });

  it("tools/list carries the cache hints on the result, not on a tool entry", async () => {
    const res = await modernPost(modernBody("tools/list", 2), {
      "Mcp-Method": "tools/list",
    });
    expect(res.status).toBe(200);
    const result = json(res).result;
    expect(result.ttlMs).toBe(3600000);
    expect(result.cacheScope).toBe("public");
    expect(result.tools.length).toBeGreaterThan(0);
    for (const tool of result.tools) {
      expect(tool).not.toHaveProperty("ttlMs");
      expect(tool).not.toHaveProperty("cacheScope");
    }
    expect(res.headers["mcp-session-id"]).toBeUndefined();
  });

  it("a modern tools/call search works with no session and sets no Mcp-Session-Id", async () => {
    const res = await modernCall(3, "search-docs", { query: "install" });
    expect(res.status).toBe(200);
    const body = json(res);
    expect(body.error).toBeUndefined();
    expect(Array.isArray(body.result.content)).toBe(true);
    expect(res.headers["mcp-session-id"]).toBeUndefined();
  });

  it("a header mismatch (body tools/call, Mcp-Method tools/list) answers 400 with -32020", async () => {
    const res = await modernPost(toolCall(4, "search-docs", { query: "x" }), {
      "Mcp-Method": "tools/list",
      "Mcp-Name": "search-docs",
    });
    expect(res.status).toBe(400);
    expect(json(res).error.code).toBe(-32020);
  });

  it("an unknown method answers 404 with -32601", async () => {
    const res = await modernPost(modernBody("no/such", 5), {
      "Mcp-Method": "no/such",
    });
    expect(res.status).toBe(404);
    expect(json(res).error.code).toBe(-32601);
  });

  it("an unknown tool answers 200 with -32602", async () => {
    const res = await modernCall(6, "no-such-tool", {});
    expect(res.status).toBe(200);
    expect(json(res).error.code).toBe(-32602);
  });

  it("GET with no session answers 405", async () => {
    const res = await send("GET", {
      Accept: "text/event-stream",
      "MCP-Protocol-Version": MODERN_VERSION,
      "X-Forwarded-For": FIXED_IP,
    });
    expect(res.status).toBe(405);
  });

  // Legacy regression guard: DELETE stays on the legacy route, which answers
  // 400 "Missing session ID" when no session header is sent (unchanged from P3).
  it("DELETE with no session keeps the legacy 400 Missing session ID", async () => {
    const res = await send("DELETE", MODERN_HEADERS);
    expect(res.status).toBe(400);
    expect(json(res).error.code).toBe(-32000);
    expect(json(res).error.message).toBe("Missing session ID");
  });

  it("a modern body with Content-Type text/plain answers 415", async () => {
    const res = await send(
      "POST",
      {
        ...MODERN_HEADERS,
        "Content-Type": "text/plain",
        "Mcp-Method": "tools/list",
      },
      JSON.stringify(modernBody("tools/list", 7)),
    );
    expect(res.status).toBe(415);
  });

  it("a modern body with no Content-Type answers 415", async () => {
    const { "Content-Type": _drop, ...noType } = MODERN_HEADERS;
    const res = await send(
      "POST",
      { ...noType, "Mcp-Method": "tools/list" },
      JSON.stringify(modernBody("tools/list", 8)),
    );
    expect(res.status).toBe(415);
  });

  it("a default (auto) JSON response has no X-Accel-Buffering header", async () => {
    const res = await modernPost(modernBody("tools/list", 9), {
      "Mcp-Method": "tools/list",
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["x-accel-buffering"]).toBeUndefined();
  });

  it("a legacy initialize then tools/list session flow still works", async () => {
    const sid = await legacyInitialize();
    try {
      const list = await legacyPost(sid, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      });
      expect(list.status).toBe(200);
      const body = json(list);
      expect(body.id).toBe(2);
      expect(body.result.tools.length).toBeGreaterThan(0);
    } finally {
      await send("DELETE", {
        "Mcp-Session-Id": sid,
        "X-Forwarded-For": FIXED_IP,
      });
    }
  });

  // express.json skips this Content-Type, so the classifier reads the body
  // from the request stream. The legacy transport and the modern handler must
  // still get that body, not an empty, already-read stream.
  it("a legacy session tools/call with a JSON Content-Type express.json skips still answers 200", async () => {
    await expectLegacyUnparsedJsonCallWorks();
  });

  it("a modern tools/call with a JSON Content-Type express.json skips answers 200", async () => {
    const res = await modernCall(22, "search-docs", { query: "install" });
    const viaUnparsed = await send(
      "POST",
      {
        ...MODERN_HEADERS,
        "Content-Type": UNPARSED_JSON_TYPE,
        "Mcp-Method": "tools/call",
        "Mcp-Name": "search-docs",
      },
      JSON.stringify(toolCall(22, "search-docs", { query: "install" })),
    );
    expect(viaUnparsed.status).toBe(200);
    expect(json(viaUnparsed)).toEqual(json(res));
  });

  it("served skill.md does not claim cd persists unconditionally", async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/.well-known/skills/default/skill.md`,
    );
    expect(res.status).toBe(200);
    const cdLine = (await res.text())
      .split("\n")
      .find((l) => l.startsWith("- `cd "));
    expect(cdLine).toBeDefined();
    expect(cdLine).not.toMatch(/persists across calls\)$/);
    expect(cdLine).toContain("only on 2025-era (session) connections");
    expect(cdLine).toContain(
      "on 2026-07-28 connections it does not persist, so use absolute paths or `cd X && <cmd>`",
    );
  });
});

describe("/mcp routes: modern protocol off", () => {
  beforeAll(() => boot(false));
  afterAll(shutdown);

  it("a legacy session tools/call with a JSON Content-Type express.json skips answers 200 (control)", async () => {
    await expectLegacyUnparsedJsonCallWorks();
  });

  it("server/discover answers 400 with -32000 (the legacy no-session answer)", async () => {
    const res = await modernPost(modernBody("server/discover", 1), {
      "Mcp-Method": "server/discover",
    });
    expect(res.status).toBe(400);
    expect(json(res).error.code).toBe(-32000);
  });
});

// Owned by 6.2c. The legacy assertions are the positive control and pass now;
// the modern assertions stay RED until the modern leg writes the same
// per-tool log line as the legacy one.
describe("per-tool log parity", () => {
  beforeAll(() => boot(true));
  afterAll(shutdown);

  beforeEach(() => {
    logSpy?.mockClear();
  });

  function linesFor(tool: string): string[] {
    return (logSpy?.mock.calls ?? [])
      .map((args: unknown[]) => args.map(String).join(" "))
      .filter((l) => l.startsWith(`[mcp] ${tool}(`));
  }

  const CASES: Array<[string, string, Record<string, unknown>]> = [
    ["search-docs", "search-docs", { query: "q1", limit: 2 }],
    ["explore-docs", "bash tool", { command: "ls /" }],
    ["submit-feedback", "collect tool", { rating: "helpful" }],
  ];

  it.each(CASES)(
    "%s (%s): the modern call writes one line identical to the legacy line",
    async (tool, _label, args) => {
      const sid = await legacyInitialize();
      let legacyLines: string[];
      try {
        logSpy?.mockClear();
        const legacy = await legacyPost(sid, {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: tool, arguments: args },
        });
        expect(legacy.status).toBe(200);
        legacyLines = linesFor(tool);
      } finally {
        await send("DELETE", {
          "Mcp-Session-Id": sid,
          "X-Forwarded-For": FIXED_IP,
        });
      }
      // Positive control: the legacy leg writes exactly one such line.
      expect(legacyLines).toHaveLength(1);
      expect(legacyLines[0]).toContain(`[${FIXED_IP}]`);

      logSpy?.mockClear();
      const modern = await modernCall(4, tool, args);
      expect(modern.status).toBe(200);
      expect(linesFor(tool)).toEqual(legacyLines);
    },
  );
});

// logMcpCall runs on the modern leg before SDK validation, with no session,
// so client text must not be able to start a new log line on either leg.
describe("per-tool log line: client text cannot forge lines", () => {
  beforeAll(() => boot(true));
  afterAll(shutdown);

  beforeEach(() => {
    logSpy?.mockClear();
  });

  /** Every physical line that the captured console.log calls wrote. */
  function physicalLines(): string[] {
    return (logSpy?.mock.calls ?? [])
      .map((args: unknown[]) => args.map(String).join(" "))
      .flatMap((l) => l.split(/\r\n|\r|\n|\u0085|\u2028|\u2029/));
  }

  const FORGED_QUERY = "x\nFAKE LINE\r\nFAKE LINE 2\u2028FAKE LINE 3";

  async function legacyToolCall(args: Record<string, unknown>) {
    const sid = await legacyInitialize();
    try {
      logSpy?.mockClear();
      return await legacyPost(sid, {
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: { name: "search-docs", arguments: args },
      });
    } finally {
      await send("DELETE", {
        "Mcp-Session-Id": sid,
        "X-Forwarded-For": FIXED_IP,
      });
    }
  }

  it("modern leg: a CR/LF query does not start a FAKE LINE", async () => {
    await modernCall(32, "search-docs", { query: FORGED_QUERY });
    const lines = physicalLines();
    expect(lines.some((l) => l.startsWith("[mcp] search-docs("))).toBe(true);
    expect(lines.filter((l) => l.startsWith("FAKE LINE"))).toEqual([]);
  });

  it("modern leg: a CR/LF limit does not start a FAKE LINE", async () => {
    await modernCall(33, "search-docs", {
      query: "q",
      limit: "2\nFAKE LINE",
    });
    const lines = physicalLines();
    expect(lines.some((l) => l.startsWith("[mcp] search-docs("))).toBe(true);
    expect(lines.filter((l) => l.startsWith("FAKE LINE"))).toEqual([]);
  });

  it("modern leg: a CR/LF tool name does not start a FAKE LINE", async () => {
    await modernPost(toolCall(34, "nope\nFAKE LINE", { query: "q" }));
    expect(physicalLines().filter((l) => l.startsWith("FAKE LINE"))).toEqual(
      [],
    );
  });

  it("legacy session leg: a CR/LF query does not start a FAKE LINE", async () => {
    await legacyToolCall({ query: FORGED_QUERY });
    const lines = physicalLines();
    expect(lines.some((l) => l.startsWith("[mcp] search-docs("))).toBe(true);
    expect(lines.filter((l) => l.startsWith("FAKE LINE"))).toEqual([]);
  });

  it("an ordinary query logs the exact legacy line on both legs", async () => {
    const expected = `[mcp] search-docs("install guide" limit=3) [${FIXED_IP}]`;
    const args = { query: "install guide", limit: 3 };

    const legacy = await legacyToolCall(args);
    expect(legacy.status).toBe(200);
    expect(
      physicalLines().filter((l) => l.startsWith("[mcp] search-docs(")),
    ).toEqual([expected]);

    logSpy?.mockClear();
    const modern = await modernCall(35, "search-docs", args);
    expect(modern.status).toBe(200);
    expect(
      physicalLines().filter((l) => l.startsWith("[mcp] search-docs(")),
    ).toEqual([expected]);
  });

  // JSON.stringify escapes "\n" but keeps U+2028, U+2029, NEL (U+0085), the
  // other C1 controls and DEL raw, so the collect and bash branches need the
  // same treatment. Each row must leave one all-printable-ASCII [mcp] line.
  const STRINGIFY_ROWS: Array<[string, string, string]> = [
    ["U+2028", "\u2028", "\u2028"],
    ["NEL", "\u0085", "\u0085"],
    ["LF", "\n", "\n"],
    ["DEL and C1", "\u007f\u009b", "\u0085"],
  ];

  function expectOneCleanLine(tool: string): void {
    const lines = physicalLines();
    expect(lines.filter((l) => l.startsWith("FAKE"))).toEqual([]);
    const mcp = lines.filter((l) => l.startsWith(`[mcp] ${tool}(`));
    expect(mcp).toHaveLength(1);
    expect(mcp[0]).toMatch(/^[\x20-\x7e]*$/);
  }

  it.each(STRINGIFY_ROWS)(
    "collect branch (modern): %s in the data cannot forge a line",
    async (_label, ctl, brk) => {
      await modernCall(36, "submit-feedback", {
        rating: `helpful${ctl}${brk}FAKE LINE`,
      });
      expectOneCleanLine("submit-feedback");
    },
  );

  it.each(STRINGIFY_ROWS)(
    "bash branch (modern): %s in the command cannot forge a line",
    async (_label, ctl, brk) => {
      await modernCall(37, "explore-docs", {
        command: `ls /${ctl}${brk}FAKE LINE`,
      });
      expectOneCleanLine("explore-docs");
    },
  );

  it("bash branch (legacy session): U+2028 cannot forge a line", async () => {
    const sid = await legacyInitialize();
    try {
      logSpy?.mockClear();
      await legacyPost(sid, {
        jsonrpc: "2.0",
        id: 38,
        method: "tools/call",
        params: {
          name: "explore-docs",
          arguments: { command: "ls /\u2028FAKE LINE" },
        },
      });
    } finally {
      await send("DELETE", {
        "Mcp-Session-Id": sid,
        "X-Forwarded-For": FIXED_IP,
      });
    }
    expectOneCleanLine("explore-docs");
  });

  // trust_proxy is on in this harness, so req.ip comes from X-Forwarded-For.
  // Node sends and accepts the latin-1 byte 0x85 (NEL) in a header value.
  it("the client ip (X-Forwarded-For with NEL) cannot forge a line", async () => {
    await modernPost(toolCall(39, "search-docs", { query: "q" }), {
      "Mcp-Method": "tools/call",
      "Mcp-Name": "search-docs",
      "X-Forwarded-For": "198.51.100.9\u0085FAKE_LINE",
    });
    expectOneCleanLine("search-docs");
  });

  it("ordinary collect and bash args log the exact legacy line", async () => {
    await modernCall(40, "submit-feedback", { rating: "helpful" });
    expect(
      physicalLines().filter((l) => l.startsWith("[mcp] submit-feedback(")),
    ).toEqual([`[mcp] submit-feedback({"rating":"helpful"}) [${FIXED_IP}]`]);

    logSpy?.mockClear();
    await modernCall(41, "explore-docs", { command: "ls /" });
    expect(
      physicalLines().filter((l) => l.startsWith("[mcp] explore-docs(")),
    ).toEqual([`[mcp] explore-docs("ls /") [${FIXED_IP}]`]);
  });
});
