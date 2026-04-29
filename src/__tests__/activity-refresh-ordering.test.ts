/**
 * R4-3 — sessionLastActivity must be refreshed AFTER the transport handler
 * returns successfully, not BEFORE it runs. Pre-refresh let a consistently-
 * throwing transport keep bumping its stamp every failed call and evade the
 * idle reaper (which treats recent activity as "session is healthy").
 *
 * This file covers both refresh sites: the /mcp existing-session path in
 * server.ts and the /messages POST in sse-handlers.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const mockGetConfig = vi.fn();
const mockGetServerConfig = vi.fn();
const mockGetAnalyticsConfig = vi.fn();

vi.mock("../config.js", () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
  getServerConfig: (...args: unknown[]) => mockGetServerConfig(...args),
  getAnalyticsConfig: (...args: unknown[]) => mockGetAnalyticsConfig(...args),
  hasSearchTools: vi.fn().mockReturnValue(false),
  hasKnowledgeTools: vi.fn().mockReturnValue(false),
  hasCollectTools: vi.fn().mockReturnValue(false),
  hasBashSemanticSearch: vi.fn().mockReturnValue(false),
}));

beforeEach(() => {
  mockGetConfig.mockReturnValue({
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
  });
  mockGetServerConfig.mockReturnValue({
    server: { name: "pathfinder-test", version: "0.0.0" },
    sources: [],
    tools: [],
  });
  mockGetAnalyticsConfig.mockReturnValue(undefined);
});

describe("handleExistingSessionRequest refresh ordering (R4-3)", () => {
  it("does not bump sessionLastActivity when the handler throws", async () => {
    const { handleExistingSessionRequest } = await import("../server.js");
    const sessionLastActivity: Record<string, number> = { sid1: 1000 };
    const transport = {
      handleRequest: vi.fn(async () => {
        throw new Error("transport-boom");
      }),
    };
    const before = sessionLastActivity["sid1"];
    await expect(
      handleExistingSessionRequest({
        sid: "sid1",
        transport,
        req: { body: {} } as unknown as Request,
        res: {} as unknown as Response,
        sessionLastActivity,
        now: () => 5000,
      }),
    ).rejects.toThrow("transport-boom");
    // MUST remain at the pre-request value. A consistently-throwing
    // transport otherwise bumps its stamp every call and the idle reaper
    // never notices it.
    expect(sessionLastActivity["sid1"]).toBe(before);
  });

  it("bumps sessionLastActivity after a successful handler call", async () => {
    const { handleExistingSessionRequest } = await import("../server.js");
    const sessionLastActivity: Record<string, number> = { sid1: 1000 };
    const transport = { handleRequest: vi.fn(async () => {}) };
    await handleExistingSessionRequest({
      sid: "sid1",
      transport,
      req: { body: {} } as unknown as Request,
      res: {} as unknown as Response,
      sessionLastActivity,
      now: () => 5000,
    });
    expect(sessionLastActivity["sid1"]).toBe(5000);
  });
});

describe("SSE /messages refresh ordering (R4-3)", () => {
  it("does not bump sessionLastActivity when handlePostMessage throws", async () => {
    const { createSseHandlers } = await import("../sse-handlers.js");
    const sessionLastActivity: Record<string, number> = { sid1: 1000 };
    const transport = {
      handlePostMessage: vi.fn(async () => {
        throw new Error("post-boom");
      }),
    };
    const { postHandler } = createSseHandlers({
      sseTransports: { sid1: transport } as unknown as Parameters<
        typeof createSseHandlers
      >[0]["sseTransports"],
      sessionLastActivity,
      ipLimiter: undefined,
      workspaceManager: undefined,
      createMcpServer: () => ({}) as never,
    });
    const req = {
      query: { sessionId: "sid1" },
      body: {},
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as Request;
    const res = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response;
    const next = vi.fn();
    const messagesPost = postHandler[postHandler.length - 1];
    await (
      messagesPost as unknown as (
        r: Request,
        s: Response,
        n: () => void,
      ) => Promise<void>
    )(req, res, next);
    expect(sessionLastActivity["sid1"]).toBe(1000);
  });
});
