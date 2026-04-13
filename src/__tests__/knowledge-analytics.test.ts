import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterAll,
} from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { KnowledgeToolConfig } from "../types.js";

vi.mock("../db/queries.js", () => ({
  getFaqChunks: vi.fn(),
  searchChunks: vi.fn(),
}));
vi.mock("../db/analytics.js", () => ({
  logQuery: vi.fn(),
}));
vi.mock("../config.js", () => ({
  getServerConfig: vi.fn(),
  getAnalyticsConfig: vi.fn(),
}));

import { registerKnowledgeTool } from "../mcp/tools/knowledge.js";
import { getFaqChunks, searchChunks } from "../db/queries.js";
import { logQuery } from "../db/analytics.js";
import { getAnalyticsConfig } from "../config.js";

const mockGetFaqChunks = vi.mocked(getFaqChunks);
const mockSearchChunks = vi.mocked(searchChunks);
const mockLogQuery = vi.mocked(logQuery);
const mockGetAnalyticsConfig = vi.mocked(getAnalyticsConfig);
const mockEmbed = vi.fn();

const toolConfig: KnowledgeToolConfig = {
  name: "faq",
  type: "knowledge",
  description: "FAQ",
  sources: ["slack-faq"],
  min_confidence: 0.7,
  default_limit: 20,
  max_limit: 100,
};

describe("knowledge tool analytics instrumentation", () => {
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    server = new McpServer({ name: "test", version: "1.0.0" });
    registerKnowledgeTool(
      server as never,
      { embed: mockEmbed } as never,
      toolConfig,
    );
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    client = new Client({ name: "tc", version: "1.0.0" });
    await client.connect(ct);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it("logs browse-mode query when analytics enabled", async () => {
    mockGetAnalyticsConfig.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
    });
    mockGetFaqChunks.mockResolvedValueOnce([]);
    mockLogQuery.mockResolvedValueOnce(undefined);

    await client.callTool({ name: "faq", arguments: {} });
    await new Promise((r) => setTimeout(r, 10));

    expect(mockLogQuery).toHaveBeenCalledTimes(1);
    const [entry] = mockLogQuery.mock.calls[0];
    expect(entry.query_text).toBe("<browse>");
    expect(entry.tool_name).toBe("faq");
  });

  it("logs search-mode query with actual query text", async () => {
    mockGetAnalyticsConfig.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
    });
    mockEmbed.mockResolvedValueOnce([0.1]);
    mockSearchChunks.mockResolvedValueOnce([]);
    mockGetFaqChunks.mockResolvedValueOnce([]);
    mockLogQuery.mockResolvedValueOnce(undefined);

    await client.callTool({
      name: "faq",
      arguments: { query: "how to deploy" },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(mockLogQuery).toHaveBeenCalledTimes(1);
    const [entry] = mockLogQuery.mock.calls[0];
    expect(entry.query_text).toBe("how to deploy");
  });

  it("always logs even when analytics config is absent (logging is unconditional)", async () => {
    mockGetAnalyticsConfig.mockReturnValue(undefined);
    mockGetFaqChunks.mockResolvedValueOnce([]);
    mockLogQuery.mockResolvedValueOnce(undefined);

    await client.callTool({ name: "faq", arguments: {} });
    await new Promise((r) => setTimeout(r, 10));

    expect(mockLogQuery).toHaveBeenCalledTimes(1);
    const [, logText] = mockLogQuery.mock.calls[0];
    expect(logText).toBe(true);
  });
});
