// Contract test: pins the `inputSchema` that `tools/list` advertises for the
// four tools configured below (search-docs, ask-docs, explore-docs,
// submit-feedback), one config shape each. Clients build their tool-call
// arguments from this schema, so a change to any field is a wire change.
// The server sends JSON Schema 2020-12 with no `additionalProperties`.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { Bash } from "just-bash";
import type { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

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
import { getConfig, getServerConfig } from "../config.js";
import { ServerConfigSchema } from "../types.js";
import { baseConfig } from "./helpers/mcpServerFixtures.js";

const SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";

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
        tool_name: {
          type: "string",
          description: "Which search tool was used",
          required: true,
        },
        query: {
          type: "string",
          description: "The original search query",
          required: true,
        },
        rating: {
          type: "enum",
          values: ["helpful", "not_helpful"],
          description: "Whether the results were helpful",
          required: true,
        },
        comment: {
          type: "string",
          description:
            "What was tried, what failed/worked, what info was missing",
          required: true,
        },
      },
    },
  ],
};

const MIN_SCORE_DESCRIPTION =
  "Minimum cosine similarity, 0-1. (The cosine scale itself runs -1 to 1; " +
  "this floor is capped at 0 because anything at or below 0 is already " +
  "unrelated.) Excludes every result whose measured semantic relevance falls " +
  "below this floor. In hybrid mode a keyword match that never appeared " +
  "among the vector candidates has no measured cosine, so it has nothing to " +
  "compare against and is returned ungated. Ignored in keyword mode, which " +
  "produces no comparable score.";

const EXPECTED_INPUT_SCHEMAS: Record<string, Record<string, unknown>> = {
  "search-docs": {
    $schema: SCHEMA_2020_12,
    type: "object",
    properties: {
      query: { type: "string", description: "The search query" },
      limit: {
        description: "Maximum number of results (default: 5)",
        default: 5,
        type: "number",
        minimum: 1,
        maximum: 20,
      },
      min_score: {
        description: MIN_SCORE_DESCRIPTION,
        type: "number",
        minimum: 0,
        maximum: 1,
      },
      version: {
        description: "Filter results to a specific documentation version",
        type: "string",
      },
    },
    required: ["query"],
  },
  "ask-docs": {
    $schema: SCHEMA_2020_12,
    type: "object",
    properties: {
      query: {
        description: "Search query. Omit for full FAQ listing.",
        type: "string",
      },
      limit: {
        description: "Maximum results to return (default: 5)",
        type: "number",
        minimum: 1,
        maximum: 20,
      },
      min_confidence: {
        description: "Override minimum confidence threshold (default: 0)",
        type: "number",
        minimum: 0,
        maximum: 1,
      },
    },
  },
  "explore-docs": {
    $schema: SCHEMA_2020_12,
    type: "object",
    properties: {
      command: {
        type: "string",
        description:
          "Bash command to execute (e.g., find, grep, cat, head, ls)",
      },
    },
    required: ["command"],
  },
  "submit-feedback": {
    $schema: SCHEMA_2020_12,
    type: "object",
    properties: {
      tool_name: { type: "string", description: "Which search tool was used" },
      query: { type: "string", description: "The original search query" },
      rating: {
        type: "string",
        enum: ["helpful", "not_helpful"],
        description: "Whether the results were helpful",
      },
      comment: {
        type: "string",
        description:
          "What was tried, what failed/worked, what info was missing",
      },
    },
    required: ["tool_name", "query", "rating", "comment"],
  },
};

describe("tools/list inputSchema contract", () => {
  let server: McpServer | undefined;
  let client: Client | undefined;
  let advertised: Map<string, Record<string, unknown>>;

  beforeAll(async () => {
    vi.mocked(getConfig).mockReturnValue({ ...baseConfig, openaiApiKey: "k" });
    vi.mocked(getServerConfig).mockReturnValue(
      ServerConfigSchema.parse(serverConfig),
    );

    const bashInstances = new Map([
      ["explore-docs", new Bash({ files: {}, cwd: "/" })],
    ]);
    server = createMcpServer(bashInstances);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "contract-client", version: "1.0.0" });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    advertised = new Map(
      tools.map((t) => [t.name, t.inputSchema as Record<string, unknown>]),
    );
  });

  afterAll(async () => {
    try {
      await client?.close();
    } finally {
      await server?.close();
    }
  });

  it("advertises exactly the four configured tools", () => {
    expect([...advertised.keys()].sort()).toEqual(
      Object.keys(EXPECTED_INPUT_SCHEMAS).sort(),
    );
  });

  it.each(Object.entries(EXPECTED_INPUT_SCHEMAS))(
    "%s advertises the pinned inputSchema",
    (name, expected) => {
      const schema = advertised.get(name);
      // toStrictEqual: an extra or missing key anywhere fails, including
      // `additionalProperties`, which the v2 server does not send.
      expect(schema).toStrictEqual(expected);
      expect(schema).not.toHaveProperty("additionalProperties");
    },
  );
});
