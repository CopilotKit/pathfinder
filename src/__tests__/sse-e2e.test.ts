import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// Stable JWT secret so bearerMiddleware doesn't explode at import time.
vi.mock("../config.js", () => ({
  getConfig: vi.fn().mockReturnValue({
    port: 0,
    databaseUrl: "pglite:///tmp/test",
    openaiApiKey: "",
    githubToken: "",
    githubWebhookSecret: "",
    nodeEnv: "test",
    logLevel: "info",
    cloneDir: "/tmp/test",
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
    server: { name: "pathfinder-e2e", version: "0.0.0" },
    sources: [],
    tools: [],
  }),
  getAnalyticsConfig: vi.fn(),
  hasSearchTools: vi.fn().mockReturnValue(false),
  hasKnowledgeTools: vi.fn().mockReturnValue(false),
  hasCollectTools: vi.fn().mockReturnValue(false),
  hasBashSemanticSearch: vi.fn().mockReturnValue(false),
}));

import { IpSessionLimiter } from "../ip-limiter.js";
import { createSseHandlers } from "../sse-handlers.js";
import { createMcpServer } from "../mcp/server.js";

describe("SSE transport e2e (initialize handshake over /sse + /messages)", () => {
  let server: Server | undefined;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleSpy.mockRestore();
    if (server?.listening) {
      await new Promise<void>((resolve, reject) =>
        server!.close((err) => (err ? reject(err) : resolve())),
      );
    }
    server = undefined;
  });

  it("completes MCP initialize handshake over /sse + /messages", async () => {
    const app = express();
    app.use(express.json());
    const { getHandler, postHandler } = createSseHandlers({
      sseTransports: {},
      sessionLastActivity: {},
      ipLimiter: new IpSessionLimiter(20),
      createMcpServer: () => createMcpServer(),
      workspaceManager: undefined,
    });
    app.get("/sse", getHandler);
    app.post("/messages", postHandler);

    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    // 1. Open /sse and read the "endpoint" event to extract messages URL.
    const sseRes = await fetch(`${baseUrl}/sse`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(sseRes.status).toBe(200);
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();

    let buffer = "";
    async function readUntil(pred: (buf: string) => boolean): Promise<void> {
      while (!pred(buffer)) {
        const { value, done } = await reader.read();
        if (done) throw new Error("SSE stream closed prematurely");
        buffer += decoder.decode(value, { stream: true });
      }
    }

    await readUntil((b) => b.includes("event: endpoint"));
    const endpointMatch = buffer.match(
      /data: (\/messages\?sessionId=[0-9a-f-]+)/,
    );
    expect(endpointMatch).not.toBeNull();
    const endpoint = endpointMatch![1];

    // 2. POST initialize via /messages.
    const initRes = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.0" },
        },
      }),
    });
    expect(initRes.status).toBe(202);

    // 3. Read the initialize response from the SSE stream.
    await readUntil(
      (b) => b.includes("event: message") && b.includes('"id":1'),
    );
    // Extract the JSON-RPC response from the SSE frame.
    const msgMatch = buffer.match(/event: message\s*\ndata: (.+)/);
    expect(msgMatch).not.toBeNull();
    const response = JSON.parse(msgMatch![1]);
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    expect(response.result).toBeDefined();
    expect(response.result.protocolVersion).toBeDefined();
    expect(response.result.serverInfo?.name).toBe("pathfinder-e2e");

    await reader.cancel();
  });
});
