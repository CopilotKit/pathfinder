// createMcpServer's `era` option. A modern (2026-07-28) server carries the
// tools/list cache hints on the tools/list RESULT object (beside `tools`, never
// on a tool entry) and builds its bash tools with `era: "modern"`. A legacy
// server (no opts, or `era: "legacy"`) is unchanged: its tools/list JSON must
// equal the JSON captured before the `era` option existed.
//
// Legacy runs over InMemoryTransport with a real v2 Client; the raw JSON-RPC
// response is captured from the server transport's `send`, so the assertions
// read the wire envelope, not the client's parsed view.
//
// Modern does NOT run over InMemoryTransport: a server attached with
// `server.connect(InMemoryTransport)` never offers 2026-07-28, so a v2 Client
// pinned to it fails at connect ("the server did not offer pinned protocol
// version 2026-07-28 via server/discover"). The modern assertions instead read
// the real modern HTTP wire from the SDK's `createMcpHandler({ legacy:
// "reject" })`, the handler the modern route serves through.
import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Bash } from "just-bash";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { JSONRPCMessage } from "@modelcontextprotocol/client";

vi.mock("../config.js", () => ({
  getConfig: vi.fn(),
  getServerConfig: vi.fn(),
  getAnalyticsConfig: vi.fn(),
}));
vi.mock("../indexing/embeddings.js", () => ({
  createEmbeddingProvider: vi.fn(() => ({
    embed: vi.fn(),
    embedBatch: vi.fn(),
  })),
}));

import { createMcpServer } from "../mcp/server.js";
import { MODERN_CD_HINT, MODERN_FS_NOTE } from "../mcp/tools/bash.js";
import { getConfig, getServerConfig } from "../config.js";
import { ServerConfigSchema } from "../types.js";
import { baseConfig } from "./helpers/mcpServerFixtures.js";

const serverConfig = ServerConfigSchema.parse({
  server: { name: "pathfinder-docs", version: "1.4.0" },
  embedding: {
    provider: "openai",
    model: "text-embedding-3-small",
    dimensions: 1536,
  },
  sources: [
    {
      name: "pathfinder-docs",
      type: "html",
      repo: "https://github.com/CopilotKit/pathfinder.git",
      path: "docs/",
      base_url: "https://pathfinder.copilotkit.dev/",
      file_patterns: ["**/*.html"],
      chunk: { target_tokens: 600, overlap_tokens: 50 },
    },
  ],
  tools: [
    {
      name: "search-docs",
      type: "search",
      description: "Search docs.",
      source: "pathfinder-docs",
      default_limit: 5,
      max_limit: 20,
      result_format: "docs",
    },
    {
      name: "explore-docs",
      type: "bash",
      description: "Explore docs.",
      sources: ["pathfinder-docs"],
      bash: { session_state: true, virtual_files: true },
    },
    {
      name: "submit-feedback",
      type: "collect",
      description: "Submit feedback.",
      response: "Thanks.",
      schema: {
        rating: { type: "enum", values: ["helpful", "not_helpful"] },
      },
    },
  ],
});

// sha256 and length of JSON.stringify(result) for the legacy tools/list
// response of the config above, captured from createMcpServer BEFORE the
// `era` option was added (HEAD 468334a).
const PRE_CHANGE_LEGACY_TOOLS_LIST = {
  sha256: "4ab47a36183a1252bd4600b944fcb5fac98a96043fc3b7beb6ad961949c67517",
  length: 1494,
};

type Era = "legacy" | "modern" | undefined;

interface Harness {
  client: Client;
  server: McpServer;
  sent: JSONRPCMessage[];
}

async function connectLegacy(build: () => McpServer): Promise<Harness> {
  const server = build();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const sent: JSONRPCMessage[] = [];
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = (message, options) => {
    sent.push(message);
    return send(message, options);
  };
  await server.connect(serverTransport);
  const client = new Client(
    { name: "era-test", version: "0.0.0" },
    { versionNegotiation: { mode: "legacy" } },
  );
  await client.connect(clientTransport);
  return { client, server, sent };
}

function buildServer(era: Era): McpServer {
  const bash = new Map([["explore-docs", new Bash()]]);
  return era === undefined
    ? createMcpServer(bash)
    : createMcpServer(
        bash,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { era },
      );
}

/** The raw tools/list `result` object the server sent on the wire. */
async function rawToolsListResult(
  h: Harness,
): Promise<Record<string, unknown>> {
  const before = h.sent.length;
  await h.client.listTools();
  const responses = h.sent
    .slice(before)
    .filter(
      (m): m is JSONRPCMessage & { result: Record<string, unknown> } =>
        "result" in m &&
        typeof m.result === "object" &&
        m.result !== null &&
        "tools" in m.result,
    );
  expect(responses).toHaveLength(1);
  return responses[0].result;
}

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "era-test", version: "0.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

/** The raw tools/list `result` object a modern (2026-07-28) request gets. */
async function modernToolsListResult(
  build: () => McpServer,
): Promise<Record<string, unknown>> {
  const handler = createMcpHandler(build, { legacy: "reject" });
  try {
    const res = await handler.fetch(
      new Request("http://local.test/mcp", {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/list",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: { _meta: MODERN_META },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("result" in body) ||
      typeof body.result !== "object" ||
      body.result === null
    ) {
      throw new Error(`modern tools/list has no result: ${String(body)}`);
    }
    return { ...body.result };
  } finally {
    await handler.close();
  }
}

function fingerprint(result: Record<string, unknown>): {
  sha256: string;
  length: number;
} {
  const json = JSON.stringify(result);
  return {
    sha256: createHash("sha256").update(json).digest("hex"),
    length: json.length,
  };
}

function toolEntries(
  result: Record<string, unknown>,
): Record<string, unknown>[] {
  const tools = result.tools;
  if (!Array.isArray(tools)) throw new Error("tools/list result has no tools");
  return tools;
}

describe("createMcpServer era option", () => {
  let harness: Harness | undefined;

  beforeEach(() => {
    vi.mocked(getConfig).mockReturnValue({ ...baseConfig });
    vi.mocked(getServerConfig).mockReturnValue(serverConfig);
  });

  afterEach(async () => {
    await harness?.client.close();
    await harness?.server.close();
    harness = undefined;
  });

  it("modern: tools/list result carries ttlMs 3600000 and cacheScope public beside tools", async () => {
    const result = await modernToolsListResult(() => buildServer("modern"));
    expect(result.ttlMs).toBe(3600000);
    expect(result.cacheScope).toBe("public");
    for (const tool of toolEntries(result)) {
      expect(tool).not.toHaveProperty("ttlMs");
      expect(tool).not.toHaveProperty("cacheScope");
    }
  });

  it("modern: the bash tool is built with era modern (cd hint in its description)", async () => {
    const result = await modernToolsListResult(() => buildServer("modern"));
    const bash = toolEntries(result).find((t) => t.name === "explore-docs");
    expect(bash?.description).toBe(
      `Explore docs.\n\n${MODERN_CD_HINT}\n\n${MODERN_FS_NOTE}`,
    );
  });

  it("control: the same modern request to a server built without era gets the SDK defaults", async () => {
    const result = await modernToolsListResult(() => buildServer(undefined));
    expect(result.ttlMs).toBe(0);
    expect(result.cacheScope).toBe("private");
  });

  it("legacy (no opts): tools/list JSON equals the pre-change JSON", async () => {
    harness = await connectLegacy(() => buildServer(undefined));
    const result = await rawToolsListResult(harness);
    expect(fingerprint(result)).toEqual(PRE_CHANGE_LEGACY_TOOLS_LIST);
    expect(result).not.toHaveProperty("ttlMs");
    expect(result).not.toHaveProperty("cacheScope");
  });

  it("legacy (era legacy): tools/list JSON equals the pre-change JSON", async () => {
    harness = await connectLegacy(() => buildServer("legacy"));
    const result = await rawToolsListResult(harness);
    expect(fingerprint(result)).toEqual(PRE_CHANGE_LEGACY_TOOLS_LIST);
  });
});
