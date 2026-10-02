// Contract test: `tools/call` ENFORCES the inputSchema that `tools/list`
// advertises, for the 4 tools search-docs, ask-docs, explore-docs and
// submit-feedback. tools-list-input-schema.contract.test.ts pins what is
// advertised; this file pins that a call outside it is rejected before the
// handler reaches the embedding provider, the DB, or the bash exec.
//
// The constraints below are a fixed copy of the pinned schemas in
// tools-list-input-schema.contract.test.ts. They are not read from the live
// `tools/list` response: if a bound were dropped from the source, a live read
// would drop the matching case too, and nothing would go red.
//
// Error shape on SDK v2: a CallToolResult with `isError: true` and the text
// "Input validation error: Invalid arguments for tool <tool>: <field>: <issue>".
// It is not a JSON-RPC error: `callTool` resolves, it does not reject.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { Mock } from "vitest";
import { Bash } from "just-bash";
import type { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mockQueriesModule } from "./helpers/queriesMock.js";

const { mockEmbed } = vi.hoisted(() => ({ mockEmbed: vi.fn() }));

vi.mock("../config.js", () => ({
  getConfig: vi.fn(),
  getServerConfig: vi.fn(),
  getAnalyticsConfig: vi.fn(),
}));
vi.mock("../indexing/embeddings.js", () => ({
  createEmbeddingProvider: vi.fn(() => ({
    embed: mockEmbed,
    embedBatch: vi.fn(),
  })),
}));
vi.mock("../db/queries.js", async (importOriginal) =>
  mockQueriesModule(importOriginal, {
    searchChunks: vi.fn(),
    textSearchChunks: vi.fn(),
    hybridSearchChunks: vi.fn(),
    getFaqChunks: vi.fn(),
    getFaqChunksByIds: vi.fn(),
    insertCollectedData: vi.fn(),
  }),
);
vi.mock("../db/analytics.js", () => ({
  logQuery: vi.fn(),
}));

import { createMcpServer } from "../mcp/server.js";
import { getConfig, getServerConfig } from "../config.js";
import {
  searchChunks,
  textSearchChunks,
  hybridSearchChunks,
  getFaqChunks,
  getFaqChunksByIds,
  insertCollectedData,
} from "../db/queries.js";
import { logQuery } from "../db/analytics.js";
import { ServerConfigSchema } from "../types.js";
import { baseConfig } from "./helpers/mcpServerFixtures.js";

const serverConfig = {
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
      name: "ask-docs",
      type: "knowledge",
      description: "Ask docs.",
      sources: ["pathfinder-docs"],
      min_confidence: 0.0,
      default_limit: 5,
      max_limit: 20,
    },
    {
      name: "explore-docs",
      type: "bash",
      description: "Explore docs.",
      sources: ["pathfinder-docs"],
      bash: {
        session_state: true,
        grep_strategy: "hybrid",
        virtual_files: true,
      },
    },
    {
      name: "submit-feedback",
      type: "collect",
      description: "Submit feedback.",
      response: "Feedback recorded. Thank you.",
      schema: {
        tool_name: { type: "string", description: "Tool", required: true },
        query: { type: "string", description: "Query", required: true },
        rating: {
          type: "enum",
          values: ["helpful", "not_helpful"],
          description: "Rating",
          required: true,
        },
        comment: { type: "string", description: "Comment", required: true },
      },
    },
  ],
};

type PropSpec = {
  type: "string" | "number";
  minimum?: number;
  maximum?: number;
  enum?: string[];
};

type ToolSpec = {
  properties: Record<string, PropSpec>;
  required: string[];
  valid: Record<string, unknown>;
  // Every double the handler can reach. None may be called on a rejected call.
  downstream: () => Mock[];
  // The double a valid call must reach (positive control).
  reached: () => Mock;
};

const bash = new Bash({ files: { "/docs/a.md": "hello" }, cwd: "/" });
const bashExec = vi.spyOn(bash, "exec");

// Fixed copy of the pinned inputSchema constraints (types, bounds, enum,
// required). None of the 4 schemas declares an integer, so there are no
// non-integer cases.
const TOOLS: Record<string, ToolSpec> = {
  "search-docs": {
    properties: {
      query: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 20 },
      min_score: { type: "number", minimum: 0, maximum: 1 },
      version: { type: "string" },
    },
    required: ["query"],
    valid: { query: "how to install", limit: 5, min_score: 0.5 },
    downstream: () => [
      mockEmbed,
      vi.mocked(searchChunks),
      vi.mocked(textSearchChunks),
      vi.mocked(hybridSearchChunks),
      vi.mocked(logQuery),
    ],
    reached: () => vi.mocked(searchChunks),
  },
  "ask-docs": {
    properties: {
      query: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 20 },
      min_confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: [],
    valid: { query: "how to install", limit: 5, min_confidence: 0.5 },
    downstream: () => [
      mockEmbed,
      vi.mocked(searchChunks),
      vi.mocked(getFaqChunks),
      vi.mocked(getFaqChunksByIds),
      vi.mocked(logQuery),
    ],
    reached: () => vi.mocked(searchChunks),
  },
  "explore-docs": {
    properties: { command: { type: "string" } },
    required: ["command"],
    valid: { command: "ls /docs" },
    downstream: () => [
      bashExec as unknown as Mock,
      mockEmbed,
      vi.mocked(searchChunks),
      vi.mocked(textSearchChunks),
      vi.mocked(hybridSearchChunks),
    ],
    reached: () => bashExec as unknown as Mock,
  },
  "submit-feedback": {
    properties: {
      tool_name: { type: "string" },
      query: { type: "string" },
      rating: { type: "string", enum: ["helpful", "not_helpful"] },
      comment: { type: "string" },
    },
    required: ["tool_name", "query", "rating", "comment"],
    valid: {
      tool_name: "search-docs",
      query: "how to install",
      rating: "helpful",
      comment: "worked",
    },
    downstream: () => [vi.mocked(insertCollectedData)],
    reached: () => vi.mocked(insertCollectedData),
  },
};

type InvalidCase = {
  tool: string;
  label: string;
  field: string;
  args: Record<string, unknown>;
};

function outOfRange(bound: number, dir: -1 | 1, spec: PropSpec): number {
  // A property bounded to exactly [0, 1] is a fraction; step by 0.5 rather than 1.
  const fractional = spec.minimum === 0 && spec.maximum === 1;
  return bound + dir * (fractional ? 0.5 : 1);
}

function invalidCases(): InvalidCase[] {
  const cases: InvalidCase[] = [];
  for (const [tool, spec] of Object.entries(TOOLS)) {
    const withField = (field: string, value: unknown) => ({
      ...spec.valid,
      [field]: value,
    });
    for (const field of spec.required) {
      const { [field]: _omitted, ...rest } = spec.valid;
      cases.push({ tool, label: `missing ${field}`, field, args: rest });
    }
    for (const [field, prop] of Object.entries(spec.properties)) {
      const wrong = prop.type === "string" ? 5 : "five";
      cases.push({
        tool,
        label: `${field} wrong type (${JSON.stringify(wrong)})`,
        field,
        args: withField(field, wrong),
      });
      if (prop.minimum !== undefined) {
        const v = outOfRange(prop.minimum, -1, prop);
        cases.push({
          tool,
          label: `${field} below minimum (${v})`,
          field,
          args: withField(field, v),
        });
      }
      if (prop.maximum !== undefined) {
        const v = outOfRange(prop.maximum, 1, prop);
        cases.push({
          tool,
          label: `${field} above maximum (${v})`,
          field,
          args: withField(field, v),
        });
      }
      if (prop.enum) {
        cases.push({
          tool,
          label: `${field} not in enum ("meh")`,
          field,
          args: withField(field, "meh"),
        });
      }
    }
  }
  return cases;
}

function resetDoubles(): void {
  vi.clearAllMocks();
  mockEmbed.mockResolvedValue(new Array(1536).fill(0));
  vi.mocked(searchChunks).mockResolvedValue([]);
  vi.mocked(textSearchChunks).mockResolvedValue([]);
  vi.mocked(hybridSearchChunks).mockResolvedValue([]);
  vi.mocked(getFaqChunks).mockResolvedValue([]);
  vi.mocked(getFaqChunksByIds).mockResolvedValue([]);
  vi.mocked(insertCollectedData).mockResolvedValue(undefined);
  vi.mocked(logQuery).mockResolvedValue(undefined);
}

function resultText(result: { content?: unknown }): string {
  const content = (result.content ?? []) as Array<{
    type: string;
    text?: string;
  }>;
  return content.map((c) => c.text ?? "").join("\n");
}

describe("tools/call enforces the advertised inputSchema", () => {
  let server: McpServer;
  let client: Client;

  beforeAll(async () => {
    vi.mocked(getConfig).mockReturnValue({ ...baseConfig, openaiApiKey: "k" });
    vi.mocked(getServerConfig).mockReturnValue(
      ServerConfigSchema.parse(serverConfig),
    );
    server = createMcpServer(new Map([["explore-docs", bash]]));
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "validation-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    try {
      await client?.close();
    } finally {
      await server?.close();
    }
  });

  it.each(Object.keys(TOOLS))(
    "%s: valid args reach the downstream double (positive control)",
    async (tool) => {
      resetDoubles();
      const result = await client.callTool({
        name: tool,
        arguments: TOOLS[tool].valid,
      });
      expect(result.isError, resultText(result)).toBeFalsy();
      expect(TOOLS[tool].reached()).toHaveBeenCalled();
    },
  );

  it.each(invalidCases().map((c) => [c.tool, c.label, c] as const))(
    "%s: rejects %s before any downstream call",
    async (_tool, _label, c) => {
      resetDoubles();
      const result = await client.callTool({
        name: c.tool,
        arguments: c.args,
      });
      const text = resultText(result);
      expect(result.isError).toBe(true);
      expect(text).toContain("Input validation error");
      expect(text).toContain(`Invalid arguments for tool ${c.tool}:`);
      // The SDK prefixes each issue with its path: "<field>: <issue>".
      expect(text).toMatch(new RegExp(`(?:^|[\\s,])${c.field}: `));
      for (const double of TOOLS[c.tool].downstream()) {
        expect(double).not.toHaveBeenCalled();
      }
    },
  );
});
