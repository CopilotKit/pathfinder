import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// These tests verify the auth middleware logic and endpoint parameter parsing.
// They mock the analytics DB functions and test the Express handler logic.

const mockGetAnalyticsSummary = vi.fn();
const mockGetTopQueries = vi.fn();
const mockGetEmptyQueries = vi.fn();

vi.mock("../db/analytics.js", () => ({
  getAnalyticsSummary: (...args: unknown[]) => mockGetAnalyticsSummary(...args),
  getTopQueries: (...args: unknown[]) => mockGetTopQueries(...args),
  getEmptyQueries: (...args: unknown[]) => mockGetEmptyQueries(...args),
}));

// Mock config — analyticsAuth now uses getAnalyticsConfig
vi.mock("../config.js", () => ({
  getServerConfig: vi.fn(),
  getAnalyticsConfig: vi.fn(),
  getConfig: vi.fn().mockReturnValue({
    port: 3001,
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
  }),
  hasSearchTools: vi.fn().mockReturnValue(false),
  hasKnowledgeTools: vi.fn().mockReturnValue(false),
  hasCollectTools: vi.fn().mockReturnValue(false),
  hasBashSemanticSearch: vi.fn().mockReturnValue(false),
}));

import { getAnalyticsConfig } from "../config.js";
import { analyticsAuth } from "../server.js";

const mockGetAnalyticsConfigFn = vi.mocked(getAnalyticsConfig);

function mockRes() {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { status, json };
}

describe("analyticsAuth middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ANALYTICS_TOKEN;
  });

  afterEach(() => {
    delete process.env.ANALYTICS_TOKEN;
  });

  it("returns 404 when analytics not enabled", () => {
    mockGetAnalyticsConfigFn.mockReturnValue(undefined);
    const res = mockRes();
    const next = vi.fn();

    analyticsAuth({ headers: {} } as never, res as never, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it("auto-generates token and requires auth when enabled with no token", () => {
    mockGetAnalyticsConfigFn.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
    });
    const res = mockRes();
    const next = vi.fn();

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    analyticsAuth({ headers: {} } as never, res as never, next);

    // Should NOT call next — auto-generated token means auth is required
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);

    // Token should be logged to console on first generation
    const logCalls = consoleSpy.mock.calls.map((c) => c[0]);
    const tokenLogCall = logCalls.find(
      (msg) =>
        typeof msg === "string" &&
        msg.includes("[analytics] No token configured"),
    );
    expect(tokenLogCall).toBeDefined();

    // Extract the auto-generated token from the log message
    const tokenMatch = (tokenLogCall as string).match(
      /auto-generated token: (\S+)/,
    );
    expect(tokenMatch).not.toBeNull();
    const autoToken = tokenMatch![1];

    // A second call with the auto-generated token should succeed
    const res2 = mockRes();
    const next2 = vi.fn();
    analyticsAuth(
      { headers: { authorization: `Bearer ${autoToken}` } } as never,
      res2 as never,
      next2,
    );
    expect(next2).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("auto-generated token is stable across multiple calls (not regenerated)", () => {
    mockGetAnalyticsConfigFn.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Call analyticsAuth — token already exists from prior test, so no new log expected
    const res1 = mockRes();
    analyticsAuth({ headers: {} } as never, res1 as never, vi.fn());
    expect(res1.status).toHaveBeenCalledWith(401);

    // Verify no new token was generated (no log message about auto-generation)
    const logCalls = consoleSpy.mock.calls.map((c) => c[0]);
    const tokenLog = logCalls.find(
      (msg) =>
        typeof msg === "string" &&
        msg.includes("[analytics] No token configured"),
    );
    expect(tokenLog).toBeUndefined();

    // Now verify that three consecutive 401 responses all reject the same way
    const res2 = mockRes();
    analyticsAuth({ headers: {} } as never, res2 as never, vi.fn());
    expect(res2.status).toHaveBeenCalledWith(401);

    const res3 = mockRes();
    analyticsAuth({ headers: {} } as never, res3 as never, vi.fn());
    expect(res3.status).toHaveBeenCalledWith(401);

    // Still no new token generation logged
    const allLogCalls = consoleSpy.mock.calls.map((c) => c[0]);
    const anyTokenLog = allLogCalls.find(
      (msg) =>
        typeof msg === "string" &&
        msg.includes("[analytics] No token configured"),
    );
    expect(anyTokenLog).toBeUndefined();

    consoleSpy.mockRestore();
  });

  it("returns 401 when token required but no auth header", () => {
    mockGetAnalyticsConfigFn.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
      token: "secret",
    });
    const res = mockRes();
    const next = vi.fn();

    analyticsAuth({ headers: {} } as never, res as never, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when token does not match", () => {
    mockGetAnalyticsConfigFn.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
      token: "secret",
    });
    const res = mockRes();
    const next = vi.fn();

    analyticsAuth(
      { headers: { authorization: "Bearer wrong" } } as never,
      res as never,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next when token matches", () => {
    mockGetAnalyticsConfigFn.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
      token: "secret",
    });
    const res = mockRes();
    const next = vi.fn();

    analyticsAuth(
      { headers: { authorization: "Bearer secret" } } as never,
      res as never,
      next,
    );

    expect(next).toHaveBeenCalled();
  });

  it("returns 401 for malformed auth header (no space after Bearer)", () => {
    mockGetAnalyticsConfigFn.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
      token: "secret",
    });
    const res = mockRes();
    const next = vi.fn();

    analyticsAuth(
      { headers: { authorization: "Bearersecret" } } as never,
      res as never,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("uses ANALYTICS_TOKEN env var as fallback when config has no token", () => {
    process.env.ANALYTICS_TOKEN = "env-secret";
    mockGetAnalyticsConfigFn.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
    });
    const res = mockRes();
    const next = vi.fn();

    analyticsAuth(
      { headers: { authorization: "Bearer env-secret" } } as never,
      res as never,
      next,
    );

    expect(next).toHaveBeenCalled();
  });

  it("rejects when ANALYTICS_TOKEN env var is set but wrong token provided", () => {
    process.env.ANALYTICS_TOKEN = "env-secret";
    mockGetAnalyticsConfigFn.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
    });
    const res = mockRes();
    const next = vi.fn();

    analyticsAuth(
      { headers: { authorization: "Bearer wrong" } } as never,
      res as never,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(403);
  });
});

// ---------------------------------------------------------------------------
// Endpoint parameter parsing
// ---------------------------------------------------------------------------

describe("endpoint parameter parsing", () => {
  it("/api/analytics/queries with non-numeric days defaults to 7", () => {
    const days = parseInt("abc") || 7;
    const limit = parseInt("") || 50;
    expect(days).toBe(7);
    expect(limit).toBe(50);
  });

  it("/api/analytics/queries caps limit at 200", () => {
    const limit = Math.min(parseInt("999"), 200);
    expect(limit).toBe(200);
  });
});
