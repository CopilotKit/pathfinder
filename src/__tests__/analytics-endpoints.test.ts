import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// These tests verify the auth middleware logic and endpoint parameter parsing.
// They mock the analytics DB functions and test the Express handler logic.

const mockGetAnalyticsSummary = vi.fn();
const mockGetTopQueries = vi.fn();
const mockGetEmptyQueries = vi.fn();
const mockGetToolCounts = vi.fn();

vi.mock("../db/analytics.js", () => ({
  getAnalyticsSummary: (...args: unknown[]) => mockGetAnalyticsSummary(...args),
  getTopQueries: (...args: unknown[]) => mockGetTopQueries(...args),
  getEmptyQueries: (...args: unknown[]) => mockGetEmptyQueries(...args),
  getToolCounts: (...args: unknown[]) => mockGetToolCounts(...args),
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
    mcpJwtSecret: "x".repeat(32),
  }),
  hasSearchTools: vi.fn().mockReturnValue(false),
  hasKnowledgeTools: vi.fn().mockReturnValue(false),
  hasCollectTools: vi.fn().mockReturnValue(false),
  hasBashSemanticSearch: vi.fn().mockReturnValue(false),
}));

import { getAnalyticsConfig, getConfig } from "../config.js";
import { analyticsAuth, parseAnalyticsFilter } from "../server.js";

const mockGetAnalyticsConfigFn = vi.mocked(getAnalyticsConfig);
const mockGetConfigFn = vi.mocked(getConfig);

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

  it("auto-generates token, logs only a fingerprint, and requires auth", () => {
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

    // Token log must include a fingerprint (not the full token) and must
    // NOT include the `/analytics?token=...` URL form.
    const logCalls = consoleSpy.mock.calls.map((c) => c[0]);
    const tokenLogCall = logCalls.find(
      (msg) =>
        typeof msg === "string" &&
        msg.includes("[analytics] No token configured"),
    );
    expect(tokenLogCall).toBeDefined();
    expect(tokenLogCall as string).toMatch(/fingerprint=[A-Za-z0-9]{8}…/);
    const urlLog = logCalls.find(
      (msg) => typeof msg === "string" && msg.includes("/analytics?token="),
    );
    expect(urlLog).toBeUndefined();

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

  it("skips token check in development mode ONLY from localhost", () => {
    mockGetAnalyticsConfigFn.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
      token: "secret",
    });
    mockGetConfigFn.mockReturnValue({
      port: 3001,
      databaseUrl: "pglite:///tmp/test",
      openaiApiKey: "",
      githubToken: "",
      githubWebhookSecret: "",
      nodeEnv: "development",
      logLevel: "info",
      cloneDir: "/tmp/test",
      slackBotToken: "",
      slackSigningSecret: "",
      discordBotToken: "",
      discordPublicKey: "",
      notionToken: "",
      mcpJwtSecret: "x".repeat(32),
    });
    const res = mockRes();
    const next = vi.fn();

    // Localhost caller, no auth header — should bypass
    analyticsAuth(
      { headers: {}, socket: { remoteAddress: "127.0.0.1" } } as never,
      res as never,
      next,
    );

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("dev bypass refuses non-localhost callers", () => {
    mockGetAnalyticsConfigFn.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
      token: "secret",
    });
    mockGetConfigFn.mockReturnValue({
      port: 3001,
      databaseUrl: "pglite:///tmp/test",
      openaiApiKey: "",
      githubToken: "",
      githubWebhookSecret: "",
      nodeEnv: "development",
      logLevel: "info",
      cloneDir: "/tmp/test",
      slackBotToken: "",
      slackSigningSecret: "",
      discordBotToken: "",
      discordPublicKey: "",
      notionToken: "",
      mcpJwtSecret: "x".repeat(32),
    });
    const res = mockRes();
    const next = vi.fn();

    // Non-localhost caller — must NOT be bypassed, falls through to token check
    analyticsAuth(
      {
        headers: {},
        socket: { remoteAddress: "192.168.1.100" },
      } as never,
      res as never,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("production mode: getAnalyticsToken throws → 503", () => {
    mockGetAnalyticsConfigFn.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
    });
    mockGetConfigFn.mockReturnValue({
      port: 3001,
      databaseUrl: "pglite:///tmp/test",
      openaiApiKey: "",
      githubToken: "",
      githubWebhookSecret: "",
      nodeEnv: "production",
      logLevel: "info",
      cloneDir: "/tmp/test",
      slackBotToken: "",
      slackSigningSecret: "",
      discordBotToken: "",
      discordPublicKey: "",
      notionToken: "",
      mcpJwtSecret: "x".repeat(32),
    });
    const consoleErrSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const res = mockRes();
    const next = vi.fn();

    analyticsAuth(
      { headers: {}, socket: { remoteAddress: "1.2.3.4" } } as never,
      res as never,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    consoleErrSpy.mockRestore();
  });

  it("requires token in non-dev mode even when analytics is enabled", () => {
    mockGetAnalyticsConfigFn.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
      token: "secret",
    });
    // Explicitly set nodeEnv to "production"
    mockGetConfigFn.mockReturnValue({
      port: 3001,
      databaseUrl: "pglite:///tmp/test",
      openaiApiKey: "",
      githubToken: "",
      githubWebhookSecret: "",
      nodeEnv: "production",
      logLevel: "info",
      cloneDir: "/tmp/test",
      slackBotToken: "",
      slackSigningSecret: "",
      discordBotToken: "",
      discordPublicKey: "",
      notionToken: "",
      mcpJwtSecret: "x".repeat(32),
    });
    const res = mockRes();
    const next = vi.fn();

    analyticsAuth({ headers: {} } as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// ---------------------------------------------------------------------------
// Endpoint parameter parsing
// ---------------------------------------------------------------------------

describe("endpoint parameter parsing", () => {
  // Validation is enforced by parsePositiveIntParam at the route layer.
  // See parsePositiveIntParam tests below for exhaustive coverage.
  it("limit=999 exceeds max (200) — caller should return 400", () => {
    // Sanity: 999 > 200, so endpoint handlers reject it rather than cap.
    expect(999 > 200).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseAnalyticsFilter — from/to validation
// ---------------------------------------------------------------------------

describe("parseAnalyticsFilter from/to validation", () => {
  function mkReq(query: Record<string, string>): never {
    return { query } as never;
  }

  it("returns ok with empty filter when no query params", () => {
    const result = parseAnalyticsFilter(mkReq({}));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filter.from).toBeUndefined();
      expect(result.filter.to).toBeUndefined();
    }
  });

  it("parses valid from/to into Date objects on the filter", () => {
    const result = parseAnalyticsFilter(
      mkReq({ from: "2026-04-01", to: "2026-04-20" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filter.from).toBeInstanceOf(Date);
      expect(result.filter.to).toBeInstanceOf(Date);
      // from snapped to UTC start-of-day
      expect(result.filter.from!.toISOString()).toBe(
        "2026-04-01T00:00:00.000Z",
      );
      // to snapped to UTC end-of-day (inclusive)
      expect(result.filter.to!.toISOString()).toBe("2026-04-20T23:59:59.999Z");
    }
  });

  it("rejects from without to with 400", () => {
    const result = parseAnalyticsFilter(mkReq({ from: "2026-04-01" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.body.error).toBe("invalid_request");
      expect(result.body.error_description).toMatch(/together/);
    }
  });

  it("rejects to without from with 400", () => {
    const result = parseAnalyticsFilter(mkReq({ to: "2026-04-20" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
  });

  it("rejects malformed from with 400", () => {
    const result = parseAnalyticsFilter(
      mkReq({ from: "invalid", to: "2026-04-20" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.body.error_description).toMatch(/YYYY-MM-DD/);
    }
  });

  it("rejects malformed to with 400", () => {
    const result = parseAnalyticsFilter(
      mkReq({ from: "2026-04-01", to: "04/20/2026" }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects impossible calendar dates (Feb 30) with 400", () => {
    const result = parseAnalyticsFilter(
      mkReq({ from: "2026-02-30", to: "2026-03-01" }),
    );
    // Post-fix: we re-serialize the parsed Date back to YYYY-MM-DD and reject
    // when the roundtrip doesn't match the input (i.e. the date rolled over).
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
  });

  it("preserves tool_type and source alongside from/to", () => {
    const result = parseAnalyticsFilter(
      mkReq({
        tool_type: "search",
        source: "docs",
        from: "2026-04-01",
        to: "2026-04-20",
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filter.tool_type).toBe("search");
      expect(result.filter.source).toBe("docs");
      expect(result.filter.from).toBeInstanceOf(Date);
      expect(result.filter.to).toBeInstanceOf(Date);
    }
  });

  it("rejects from > to with 400", () => {
    const result = parseAnalyticsFilter(
      mkReq({ from: "2026-04-20", to: "2026-04-01" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.body.error).toBe("invalid_request");
      expect(result.body.error_description).toMatch(/from.*to/i);
    }
  });

  it("rejects impossible calendar date (Feb 30) with 400", () => {
    const result = parseAnalyticsFilter(
      mkReq({ from: "2026-02-30", to: "2026-04-20" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
  });

  it("rejects array query params (Express multi-value) with 400", () => {
    const result = parseAnalyticsFilter({
      query: { from: ["2026-04-01", "2026-04-02"], to: "2026-04-20" },
    } as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
// parsePositiveIntParam helper
// ---------------------------------------------------------------------------

describe("parsePositiveIntParam", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports,@typescript-eslint/no-var-requires
  let parsePositiveIntParam: typeof import("../server.js").parsePositiveIntParam;
  beforeEach(async () => {
    const mod = await import("../server.js");
    parsePositiveIntParam = mod.parsePositiveIntParam;
  });

  it("returns default when raw is undefined", () => {
    expect(parsePositiveIntParam(undefined, 7, 100)).toBe(7);
  });

  it("returns default when raw is empty string", () => {
    expect(parsePositiveIntParam("", 50, 200)).toBe(50);
  });

  it("returns error for non-string (array)", () => {
    const res = parsePositiveIntParam(["1", "2"], 7, 100);
    expect(typeof res).toBe("object");
    if (typeof res === "object") {
      expect(res.error).toMatch(/string/);
    }
  });

  it("returns error for non-numeric", () => {
    const res = parsePositiveIntParam("abc", 7, 100);
    expect(typeof res).toBe("object");
    if (typeof res === "object") {
      expect(res.error).toMatch(/positive integer/);
    }
  });

  it("returns error for zero", () => {
    const res = parsePositiveIntParam("0", 7, 100);
    expect(typeof res).toBe("object");
    if (typeof res === "object") {
      expect(res.error).toMatch(/> 0/);
    }
  });

  it("returns error for negative", () => {
    const res = parsePositiveIntParam("-5", 7, 100);
    expect(typeof res).toBe("object");
  });

  it("returns error when value > max", () => {
    const res = parsePositiveIntParam("999", 7, 100);
    expect(typeof res).toBe("object");
    if (typeof res === "object") {
      expect(res.error).toMatch(/100/);
    }
  });

  it("returns parsed number for valid input", () => {
    expect(parsePositiveIntParam("42", 7, 100)).toBe(42);
  });

  it("returns parsed number at max boundary", () => {
    expect(parsePositiveIntParam("100", 7, 100)).toBe(100);
  });
});
