import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request } from "express";

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
import {
  analyticsAuth,
  parseAnalyticsFilter,
  __resetAnalyticsTokenForTesting,
  MAX_DAYS,
} from "../server.js";

const mockGetAnalyticsConfigFn = vi.mocked(getAnalyticsConfig);
const mockGetConfigFn = vi.mocked(getConfig);

const DEFAULT_TEST_CONFIG = {
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
};

function mockRes() {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { status, json };
}

// File-level reset so env state (ANALYTICS_TOKEN) and the server.ts
// auto-generated token cache can't leak between describes — later
// parseAnalyticsFilter / parsePositiveIntParam suites would otherwise
// inherit whatever the middleware tests left behind.
beforeEach(() => {
  mockGetAnalyticsConfigFn.mockReset();
  mockGetConfigFn.mockReset();
  mockGetConfigFn.mockReturnValue(DEFAULT_TEST_CONFIG);
  __resetAnalyticsTokenForTesting();
  delete process.env.ANALYTICS_TOKEN;
});

afterEach(() => {
  delete process.env.ANALYTICS_TOKEN;
  __resetAnalyticsTokenForTesting();
});

describe("analyticsAuth middleware", () => {
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

    // Bootstrap the auto-generated token by making one call FIRST (with
    // its log suppressed), then verify subsequent calls don't regenerate.
    // beforeEach resets the cached token, so this test must create it
    // explicitly rather than rely on prior-test side effects.
    const bootstrapSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    analyticsAuth({ headers: {} } as never, mockRes() as never, vi.fn());
    bootstrapSpy.mockRestore();

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Token already exists from bootstrap — no new generation log expected
    const res1 = mockRes();
    analyticsAuth({ headers: {} } as never, res1 as never, vi.fn());
    expect(res1.status).toHaveBeenCalledWith(401);

    const logCalls = consoleSpy.mock.calls.map((c) => c[0]);
    const tokenLog = logCalls.find(
      (msg) =>
        typeof msg === "string" &&
        msg.includes("[analytics] No token configured"),
    );
    expect(tokenLog).toBeUndefined();

    // Three consecutive 401 responses all reject the same way, no regen
    const res2 = mockRes();
    analyticsAuth({ headers: {} } as never, res2 as never, vi.fn());
    expect(res2.status).toHaveBeenCalledWith(401);

    const res3 = mockRes();
    analyticsAuth({ headers: {} } as never, res3 as never, vi.fn());
    expect(res3.status).toHaveBeenCalledWith(401);

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

  it("returns 403 when same-length token differs by one char (exercises timing-safe path)", () => {
    // With different-length tokens the short-circuit path in analyticsAuth
    // rejects before timingSafeEqual runs. Using a same-length 'secrit'
    // ensures timingSafeEqual is actually invoked — exercising the real
    // constant-time comparison rather than only the length guard.
    mockGetAnalyticsConfigFn.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
      token: "secret",
    });
    const res = mockRes();
    const next = vi.fn();

    analyticsAuth(
      { headers: { authorization: "Bearer secrit" } } as never,
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
// parseAnalyticsFilter — from/to validation
// ---------------------------------------------------------------------------

describe("parseAnalyticsFilter from/to validation", () => {
  // Returning Partial<Request> (not `never`) so the typed `{query}` shape
  // is explicit; parseAnalyticsFilter only reads `.query`, so a Partial is
  // safe here. Call sites cast to Request to satisfy the signature.
  function mkReq(query: Record<string, string>): Partial<Request> {
    return { query };
  }

  it("returns ok with empty filter when no query params", () => {
    const result = parseAnalyticsFilter(mkReq({}) as Request);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filter.from).toBeUndefined();
      expect(result.filter.to).toBeUndefined();
    }
  });

  it("parses valid from/to into Date objects on the filter", () => {
    const result = parseAnalyticsFilter(
      mkReq({ from: "2026-04-01", to: "2026-04-20" }) as Request,
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
    const result = parseAnalyticsFilter(
      mkReq({ from: "2026-04-01" }) as Request,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.body.error).toBe("invalid_request");
      expect(result.body.error_description).toMatch(/together/);
    }
  });

  it("rejects to without from with 400", () => {
    const result = parseAnalyticsFilter(mkReq({ to: "2026-04-20" }) as Request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
  });

  it("rejects malformed from with 400", () => {
    const result = parseAnalyticsFilter(
      mkReq({ from: "invalid", to: "2026-04-20" }) as Request,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.body.error_description).toMatch(/YYYY-MM-DD/);
    }
  });

  it("rejects malformed to with 400", () => {
    const result = parseAnalyticsFilter(
      mkReq({ from: "2026-04-01", to: "04/20/2026" }) as Request,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects from=Feb30 even when to is a valid calendar date", () => {
    // Feb 30 as `from` rolls forward to March 2 under `new Date()` — we
    // detect that via the YYYY-MM-DD roundtrip check.
    const result = parseAnalyticsFilter(
      mkReq({ from: "2026-02-30", to: "2026-03-01" }) as Request,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
  });

  it("rejects empty tool_type with 400 so it doesn't become an unbounded LIKE wildcard", () => {
    // `?tool_type=` from a blank select is almost certainly a client bug:
    // if the empty value landed on the filter, buildFilterClauses would
    // build `tool_name LIKE '' || '-%'` — matching every tool_name — which
    // is not "show everything" intent. Returning 400 surfaces the client
    // bug instead of silently dropping the param.
    const result = parseAnalyticsFilter(mkReq({ tool_type: "" }) as Request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.body.error).toBe("invalid_request");
      expect(result.body.error_description).toBe(
        "tool_type must be a non-empty string",
      );
    }
  });

  it("rejects empty source with 400 so it doesn't mask the no-filter case", () => {
    const result = parseAnalyticsFilter(mkReq({ source: "" }) as Request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.body.error).toBe("invalid_request");
      expect(result.body.error_description).toBe(
        "source must be a non-empty string",
      );
    }
  });

  it("rejects empty tool_type even when a sibling filter is valid (no cross-field bleed)", () => {
    // Regression guard: the empty-string rejection must fire even when
    // another filter is populated. Mix tool_type="" with source="docs" to
    // lock down per-field semantics — tool_type="" trips the 400 first.
    const result = parseAnalyticsFilter(
      mkReq({ tool_type: "", source: "docs" }) as Request,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.body.error).toBe("invalid_request");
      expect(result.body.error_description).toBe(
        "tool_type must be a non-empty string",
      );
    }
  });

  it("preserves tool_type and source alongside from/to", () => {
    const result = parseAnalyticsFilter(
      mkReq({
        tool_type: "search",
        source: "docs",
        from: "2026-04-01",
        to: "2026-04-20",
      }) as Request,
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
      mkReq({ from: "2026-04-20", to: "2026-04-01" }) as Request,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.body.error).toBe("invalid_request");
      expect(result.body.error_description).toMatch(/from.*to/i);
    }
  });

  it("rejects from=Feb30 with a far-future to (roundtrip check)", () => {
    // Second scenario: the wider range proves the rejection is driven by
    // the calendar-date roundtrip check, not by any range-length logic.
    const result = parseAnalyticsFilter(
      mkReq({ from: "2026-02-30", to: "2026-04-20" }) as Request,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
  });

  // Calendar-shape (YYYY-MM-DD) but not a real date. `new Date()` yields
  // Invalid Date on these; if parseAnalyticsFilter then calls `.toISOString()`
  // on the NaN timestamp, RangeError escapes and becomes a 500. Every one of
  // these must surface as a clean 400 with the `invalid_request` envelope.
  it.each([
    ["2025-13-01", "invalid month"],
    ["2025-01-32", "day past 31"],
    ["2025-00-15", "month zero"],
    ["2025-04-00", "day zero"],
  ])("rejects calendar-invalid `from=%s` (%s) with 400, not 500", (from) => {
    const result = parseAnalyticsFilter(
      mkReq({ from, to: "2025-12-31" }) as Request,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.body.error).toBe("invalid_request");
    }
  });

  it.each([
    ["2025-13-01", "invalid month"],
    ["2025-01-32", "day past 31"],
    ["2025-00-15", "month zero"],
    ["2025-04-00", "day zero"],
  ])("rejects calendar-invalid `to=%s` (%s) with 400, not 500", (to) => {
    const result = parseAnalyticsFilter(
      mkReq({ from: "2025-01-01", to }) as Request,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.body.error).toBe("invalid_request");
    }
  });

  // Express parses repeated query-string keys as arrays (e.g.
  // `?from=a&from=b`). Every filter param must reject that shape up front
  // with the same `invalid_request` envelope, regardless of which one tripped.
  it.each([
    ["from", { from: ["2026-04-01", "2026-04-02"], to: "2026-04-20" }],
    ["to", { from: "2026-04-01", to: ["2026-04-20", "2026-04-21"] }],
    ["days", { days: ["7", "14"] }],
    ["limit", { limit: ["10", "20"] }],
    ["tool_type", { tool_type: ["search", "collect"] }],
    ["source", { source: ["docs", "api"] }],
  ])(
    "rejects array query param `%s` (Express multi-value) with 400",
    (_name, query) => {
      const result = parseAnalyticsFilter({ query } as never);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(400);
        expect(result.body.error).toBe("invalid_request");
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Range-width cap. The server caps from/to span at MAX_DAYS so a client
  // can't request `from=1970-01-01&to=9999-12-31` and force a scan across
  // the entire table.
  //
  // Important implementation detail: `from` is snapped to UTC start-of-day
  // and `to` is snapped to UTC end-of-day (23:59:59.999). So a range that
  // covers N calendar days has (to-from) ≈ N*86400000 - 1 ms, and
  // Math.ceil((to-from)/86400000) = N. We test both sides of the boundary.
  // ---------------------------------------------------------------------------
  describe("parseAnalyticsFilter range-width cap", () => {
    // Helper that generates a YYYY-MM-DD string N calendar days after
    // `from`. N=0 returns `from` itself.
    function addDaysUTC(from: string, n: number): string {
      const d = new Date(from + "T00:00:00.000Z");
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    }

    it("accepts a range that spans exactly MAX_DAYS calendar days", () => {
      // A range of from..from+(MAX_DAYS-1) days spans MAX_DAYS calendar
      // days at UTC-start..UTC-end-of-day resolution. Import MAX_DAYS from
      // server.ts instead of hardcoding the numeric so tests don't drift
      // if the cap is ever retuned.
      const from = "1970-01-01";
      const to = addDaysUTC(from, MAX_DAYS - 1);
      const result = parseAnalyticsFilter(mkReq({ from, to }) as Request);
      expect(result.ok).toBe(true);
      // Boundary values must also be populated onto filter.from/to as the
      // expected UTC Date instances — this pins the ISO-string → Date
      // conversion (from at UTC-start-of-day, to at UTC-end-of-day).
      // Pre-this-assertion, a subtle bug that accepted the range but set
      // the wrong date bounds (e.g. local-time midnight, or a missed
      // 23:59:59.999 suffix) would slip past this block.
      if (result.ok) {
        expect(result.filter.from!.toISOString()).toBe(from + "T00:00:00.000Z");
        expect(result.filter.to!.toISOString()).toBe(to + "T23:59:59.999Z");
      }
    });

    it("rejects a range that spans MAX_DAYS + 1 calendar days with 400", () => {
      const from = "1970-01-01";
      const to = addDaysUTC(from, MAX_DAYS); // (MAX_DAYS+1)-day span
      const result = parseAnalyticsFilter(mkReq({ from, to }) as Request);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(400);
        expect(result.body.error).toBe("invalid_request");
        expect(result.body.error_description).toMatch(/range.*<=/i);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// parsePositiveIntParam helper
// ---------------------------------------------------------------------------

describe("parsePositiveIntParam", () => {
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

  // R4-10: strict `/^\d+$/` guard before Number.parseInt so these inputs
  // cannot be silently coerced by parseInt's permissive grammar.
  it("rejects decimal strings (would parseInt-truncate to a positive int)", () => {
    const res = parsePositiveIntParam("1.5", 7, 100);
    expect(typeof res).toBe("object");
    if (typeof res === "object") {
      expect(res.error).toMatch(/positive integer/);
    }
  });

  it("rejects scientific notation (would parseInt to 1)", () => {
    const res = parsePositiveIntParam("1e3", 7, 100);
    expect(typeof res).toBe("object");
    if (typeof res === "object") {
      expect(res.error).toMatch(/positive integer/);
    }
  });

  it("rejects leading whitespace (would parseInt after implicit trim)", () => {
    const res = parsePositiveIntParam(" 123", 7, 100);
    expect(typeof res).toBe("object");
    if (typeof res === "object") {
      expect(res.error).toMatch(/positive integer/);
    }
  });

  it("rejects mixed alphanumeric (would parseInt to leading digit run)", () => {
    const res = parsePositiveIntParam("123abc", 7, 100);
    expect(typeof res).toBe("object");
    if (typeof res === "object") {
      expect(res.error).toMatch(/positive integer/);
    }
  });
});
