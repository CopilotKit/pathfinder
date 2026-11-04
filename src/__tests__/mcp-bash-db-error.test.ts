/**
 * Route-level coverage: a database fault in the bash tool `related` and `qmd`
 * commands must not reach the MCP client. Boots the real app in-process and
 * drives modern tools/call requests over HTTP.
 *
 * pg and pgvector errors can name tables, SQL and connection targets. When a
 * search fails outright, the client gets a generic message and a non-zero exit
 * code. When only the semantic half fails, the client gets the text-search
 * results, a generic warning and exit 0. In every case the server log keeps
 * the full error (same contract as the knowledge tool).
 *
 * Test doubles: the embedding provider (no network); searchChunks, which
 * always rejects with a realistic pgvector error; and textSearchChunks, which
 * rejects with the same error unless a test sets db.textSearchFails to false,
 * in which case it returns one row.
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
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Bash } from "just-bash";
import type { ChunkResult } from "../types.js";

const SECRET_DETAIL =
  "different vector dimensions 1536 and 3: SELECT c.id FROM chunks c " +
  "ORDER BY c.embedding <=> $1 LIMIT 10 (postgres://pathfinder@db.internal:5432/pathfinder)";

const db = vi.hoisted(() => ({ textSearchFails: true }));

// One private dir per run for the PGlite data and the clone dir, so parallel
// runs never share state. Created in beforeAll and removed in afterAll, so a
// skipped or filtered-out suite creates no dir. The mocked getConfig reads it
// lazily, at server start.
const tmp = vi.hoisted(() => ({ dir: "" }));

vi.mock("../db/queries.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db/queries.js")>()),
  searchChunks: vi.fn(async () => {
    throw new Error(SECRET_DETAIL);
  }),
  textSearchChunks: vi.fn(async (): Promise<ChunkResult[]> => {
    if (db.textSearchFails) throw new Error(SECRET_DETAIL);
    return [
      {
        id: 7,
        source_name: "docs",
        source_url: null,
        title: null,
        content: "useAgent hook",
        repo_url: null,
        file_path: "docs/x.mdx",
        start_line: 1,
        end_line: 1,
        language: null,
        similarity: 0,
        cosine_similarity: 0,
      },
    ];
  }),
}));

vi.mock("../indexing/embeddings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../indexing/embeddings.js")>()),
  createEmbeddingProvider: () => ({
    embed: async () => [0.1, 0.2, 0.3],
    embedBatch: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
  }),
}));

vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  getConfig: vi.fn(() => {
    if (!tmp.dir) throw new Error("getConfig called before beforeAll");
    return {
      port: 0,
      databaseUrl: `pglite://${tmp.dir}/db`,
      openaiApiKey: "sk-test-not-used",
      githubToken: "",
      githubWebhookSecret: "",
      nodeEnv: "test",
      logLevel: "info",
      cloneDir: `${tmp.dir}/clone`,
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
    };
  }),
  getServerConfig: vi.fn().mockReturnValue({
    server: {
      name: "pathfinder-docs",
      version: "0.0.0",
      max_sessions_per_ip: 50,
      session_ttl_minutes: 30,
      allowlist: [],
      trust_proxy: true,
    },
    embedding: { provider: "openai", model: "test", dimensions: 3 },
    sources: [],
    // The production shape: session_state on, hybrid grep (needs embeddings).
    tools: [
      {
        name: "explore-docs",
        type: "bash",
        description: "Explore docs.",
        sources: ["docs"],
        bash: { session_state: true, grep_strategy: "hybrid" },
      },
    ],
  }),
  getAnalyticsConfig: vi.fn().mockReturnValue(undefined),
  hasSearchTools: vi.fn().mockReturnValue(false),
  hasKnowledgeTools: vi.fn().mockReturnValue(false),
  hasCollectTools: vi.fn().mockReturnValue(false),
  hasBashSemanticSearch: vi.fn().mockReturnValue(true),
}));

import {
  startInProcessServer,
  type InProcessServer,
} from "./helpers/inProcessServer.js";
import { __setBashInstanceForTesting } from "../server.js";
import { closePool } from "../db/client.js";

const MODERN_VERSION = "2026-07-28";
const FIXED_IP = "198.51.100.9";

const META = {
  "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
  "io.modelcontextprotocol/clientInfo": {
    name: "route-test-modern",
    version: "0",
  },
  "io.modelcontextprotocol/clientCapabilities": {},
};

type HttpResult = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
};

let running: InProcessServer | undefined;
let port = 0;

function send(
  method: "POST",
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
        res.on("data", (c) => (data += c));
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

/** The text of the first content item of a JSON or SSE tools/call reply. */
function toolText(res: HttpResult): string {
  const payload = res.body.trim().startsWith("{")
    ? res.body
    : res.body
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
  const parsed: { result?: { content?: Array<{ text?: string }> } } =
    JSON.parse(payload);
  const text = parsed.result?.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error(`no tool text in reply: ${res.status} ${res.body}`);
  }
  return text;
}

function modernBash(id: number, command: string): Promise<HttpResult> {
  const body = {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "explore-docs",
      arguments: { command },
      _meta: META,
    },
  };
  return send(
    "POST",
    {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": MODERN_VERSION,
      "X-Forwarded-For": FIXED_IP,
      "Mcp-Method": "tools/call",
      "Mcp-Name": "explore-docs",
    },
    JSON.stringify(body),
  );
}

/** Every console.warn / console.error line, joined, for log assertions. */
function serverLog(): string {
  return [warnSpy, errorSpy]
    .flatMap((s) => s.mock.calls)
    .map((args) =>
      args
        .map((a: unknown) => (a instanceof Error ? a.message : String(a)))
        .join(" "),
    )
    .join("\n");
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

describe("/mcp bash: database errors stay server-side", () => {
  beforeAll(async () => {
    tmp.dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pathfinder-bash-db-error-"),
    );
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    running = await startInProcessServer();
    port = Number(new URL(running.baseUrl).port);
    __setBashInstanceForTesting(
      "explore-docs",
      new Bash({
        files: { "/docs/x.mdx": "# X\nThe queried page." },
        cwd: "/",
      }),
    );
  });

  afterEach(() => {
    warnSpy.mockClear();
    errorSpy.mockClear();
    db.textSearchFails = true;
  });

  afterAll(async () => {
    try {
      await running?.stop();
    } finally {
      running = undefined;
      try {
        // stop() leaves the DB pool open. Close the PGlite instance before
        // its data dir is deleted below.
        await closePool();
      } finally {
        if (tmp.dir) fs.rmSync(tmp.dir, { recursive: true, force: true });
        vi.restoreAllMocks();
      }
    }
  });

  it("related: the client sees a generic error, the log has the detail", async () => {
    const res = await modernBash(10, "related /docs/x.mdx");
    expect(res.status).toBe(200);
    const text = toolText(res);
    expect(text).toContain("related: error: search failed");
    expect(text).toContain("[exit code 1]");
    expect(text).not.toContain("vector dimensions");
    expect(text).not.toContain("chunks");
    expect(text).not.toContain("postgres://");
    expect(serverLog()).toContain(SECRET_DETAIL);
  });

  it("qmd, both searches fail: generic error, exit 2, log has the detail", async () => {
    const res = await modernBash(11, 'qmd "useAgent"');
    expect(res.status).toBe(200);
    const text = toolText(res);
    expect(text).toContain("grep: search unavailable");
    expect(text).toContain("[exit code 2]");
    expect(text).not.toContain("vector dimensions");
    expect(text).not.toContain("chunks");
    expect(text).not.toContain("postgres://");
    expect(serverLog()).toContain(SECRET_DETAIL);
  });

  it("qmd, semantic search fails: results plus a generic warning", async () => {
    db.textSearchFails = false;
    const res = await modernBash(12, 'qmd "useAgent"');
    expect(res.status).toBe(200);
    const text = toolText(res);
    expect(text).toContain("/docs/x.mdx:1:useAgent hook");
    expect(text).toContain("[warning: semantic search unavailable]");
    // A partial failure still succeeds: exit 0, which formatBashResult shows
    // by printing no exit-code line at all.
    expect(text).not.toContain("[exit code");
    expect(text).not.toContain("vector dimensions");
    expect(text).not.toContain("postgres://");
    expect(serverLog()).toContain(SECRET_DETAIL);
  });
});
