/**
 * Route-level coverage for `related <path>` on the bash tool over /mcp. Boots
 * the real app in-process and drives modern (2026-07-28) and legacy
 * (2025-era session) tools/call requests over HTTP.
 *
 * A modern connection has no session cwd, so a relative path must resolve
 * from "/", the same as the modern bare `cd`. If it does not, the queried file
 * does not match its own vector hit and is listed as its own related result.
 *
 * Test doubles: the embedding provider (no network) and searchChunks (no
 * vectors in the test database), which returns the queried file and one
 * other file. The bash instance is preloaded with known files after boot.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Bash } from "just-bash";
import type { ChunkResult } from "../types.js";

function chunk(file_path: string, similarity: number): ChunkResult {
  return {
    id: 1,
    source_name: "",
    source_url: null,
    title: null,
    content: "",
    repo_url: null,
    file_path,
    start_line: null,
    end_line: null,
    language: null,
    similarity,
    cosine_similarity: similarity,
  };
}

vi.mock("../db/queries.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db/queries.js")>()),
  searchChunks: vi.fn(async () => [
    chunk("docs/x.mdx", 0.99),
    chunk("docs/y.mdx", 0.8),
  ]),
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
  getConfig: vi.fn().mockReturnValue({
    port: 0,
    databaseUrl: "pglite:///tmp/test-mcp-modern-bash-related",
    openaiApiKey: "sk-test-not-used",
    githubToken: "",
    githubWebhookSecret: "",
    nodeEnv: "test",
    logLevel: "info",
    cloneDir: "/tmp/test-mcp-modern-bash-related",
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
  method: "POST" | "DELETE",
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

const LEGACY_HEADERS = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
  "X-Forwarded-For": FIXED_IP,
};

async function legacyBash(command: string): Promise<HttpResult> {
  const init = await send(
    "POST",
    LEGACY_HEADERS,
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "route-test-legacy", version: "0.0.0" },
      },
    }),
  );
  const sid = init.headers["mcp-session-id"];
  if (init.status !== 200 || typeof sid !== "string") {
    throw new Error(`legacy initialize failed: ${init.status} ${init.body}`);
  }
  try {
    return await send(
      "POST",
      { ...LEGACY_HEADERS, "Mcp-Session-Id": sid },
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "explore-docs", arguments: { command } },
      }),
    );
  } finally {
    await send("DELETE", {
      "Mcp-Session-Id": sid,
      "X-Forwarded-For": FIXED_IP,
    });
  }
}

describe("/mcp bash `related`: relative path resolution", () => {
  beforeAll(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    running = await startInProcessServer();
    port = Number(new URL(running.baseUrl).port);
    __setBashInstanceForTesting(
      "explore-docs",
      new Bash({
        files: {
          "/docs/x.mdx": "# X\nThe queried page.",
          "/docs/y.mdx": "# Y\nA related page.",
        },
        cwd: "/",
      }),
    );
  });

  afterAll(async () => {
    try {
      await running?.stop();
    } finally {
      running = undefined;
      vi.restoreAllMocks();
    }
  });

  it("legacy (positive control): a relative path excludes the queried file", async () => {
    const res = await legacyBash("related docs/x.mdx");
    expect(res.status).toBe(200);
    const text = toolText(res);
    expect(text).toContain("Semantically related files for /docs/x.mdx:");
    expect(text).toContain("/docs/y.mdx");
    expect(text).not.toMatch(/\d\.\d\d {2}\/docs\/x\.mdx/);
  });

  it("modern: a relative path resolves from / and excludes the queried file", async () => {
    const res = await modernBash(3, "related docs/x.mdx");
    expect(res.status).toBe(200);
    const text = toolText(res);
    expect(text).toContain("Semantically related files for /docs/x.mdx:");
    expect(text).toContain("/docs/y.mdx");
    expect(text).not.toMatch(/\d\.\d\d {2}\/docs\/x\.mdx/);
  });

  it("modern: a dotted relative path is normalised the same way", async () => {
    const res = await modernBash(4, "related ./docs/../docs/x.mdx");
    expect(res.status).toBe(200);
    const text = toolText(res);
    expect(text).toContain("Semantically related files for /docs/x.mdx:");
    expect(text).not.toMatch(/\d\.\d\d {2}\/docs\/x\.mdx/);
  });

  it("modern: an absolute path is unchanged", async () => {
    const res = await modernBash(5, "related /docs/x.mdx");
    expect(res.status).toBe(200);
    const text = toolText(res);
    expect(text).toContain("Semantically related files for /docs/x.mdx:");
    expect(text).toContain("/docs/y.mdx");
    expect(text).not.toMatch(/\d\.\d\d {2}\/docs\/x\.mdx/);
  });
});
