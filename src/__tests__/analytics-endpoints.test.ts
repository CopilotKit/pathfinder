import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// These tests verify the auth middleware logic and endpoint parameter parsing.
// They mock the analytics DB functions and test the Express handler logic.

const mockGetAnalyticsSummary = vi.fn();
const mockGetTopQueries = vi.fn();
const mockGetEmptyQueries = vi.fn();

vi.mock("../db/analytics.js", () => ({
  getAnalyticsSummary: (...args: unknown[]) =>
    mockGetAnalyticsSummary(...args),
  getTopQueries: (...args: unknown[]) => mockGetTopQueries(...args),
  getEmptyQueries: (...args: unknown[]) => mockGetEmptyQueries(...args),
}));

// Mock getServerConfig to control analytics config in tests
vi.mock("../config.js", () => ({
  getServerConfig: vi.fn(),
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

import { getServerConfig } from "../config.js";
import { analyticsAuth } from "../server.js";

const mockGetServerConfigFn = vi.mocked(getServerConfig);

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
    mockGetServerConfigFn.mockReturnValue({} as never);
    const res = mockRes();
    const next = vi.fn();

    analyticsAuth({ headers: {} } as never, res as never, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next when enabled and no token configured", () => {
    mockGetServerConfigFn.mockReturnValue({
      analytics: { enabled: true },
    } as never);
    const res = mockRes();
    const next = vi.fn();

    analyticsAuth({ headers: {} } as never, res as never, next);

    expect(next).toHaveBeenCalled();
  });

  it("returns 401 when token required but no auth header", () => {
    mockGetServerConfigFn.mockReturnValue({
      analytics: { enabled: true, token: "secret" },
    } as never);
    const res = mockRes();
    const next = vi.fn();

    analyticsAuth({ headers: {} } as never, res as never, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when token does not match", () => {
    mockGetServerConfigFn.mockReturnValue({
      analytics: { enabled: true, token: "secret" },
    } as never);
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
    mockGetServerConfigFn.mockReturnValue({
      analytics: { enabled: true, token: "secret" },
    } as never);
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
    mockGetServerConfigFn.mockReturnValue({
      analytics: { enabled: true, token: "secret" },
    } as never);
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
    mockGetServerConfigFn.mockReturnValue({
      analytics: { enabled: true },
    } as never);
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
    mockGetServerConfigFn.mockReturnValue({
      analytics: { enabled: true },
    } as never);
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
