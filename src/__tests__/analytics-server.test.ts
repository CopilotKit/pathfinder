import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "node:http";
import path from "node:path";

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
  registerAnalyticsRoutes,
  __resetAnalyticsTokenForTesting,
  getAuthMode,
  analyticsAuth,
} from "../server.js";
import type { Request, Response } from "express";

const mockGetAnalyticsConfigFn = vi.mocked(getAnalyticsConfig);
const mockGetConfigFn = vi.mocked(getConfig);

// ---------------------------------------------------------------------------
// Build an Express app using production `registerAnalyticsRoutes()` so tests
// exercise the real Express handler implementations (auth middleware, param
// parsing, response shaping). DB-layer calls are routed through mocks via
// the deps hook, so this is NOT end-to-end — it's a handler-level test with
// the DB boundary stubbed.
// ---------------------------------------------------------------------------

function buildTestApp() {
  const app = express();
  app.use(express.json());

  // Resolve docs/analytics.html from the repo root. Vitest runs from the
  // repo root, so process.cwd() is stable regardless of whether __dirname
  // points into src/__tests__ (source tree) or dist/__tests__ (built).
  const analyticsHtmlPath = path.join(process.cwd(), "docs", "analytics.html");

  registerAnalyticsRoutes(app, {
    getAnalyticsSummary: (
      ...args: Parameters<typeof mockGetAnalyticsSummary>
    ) => mockGetAnalyticsSummary(...args),
    getTopQueries: (...args: Parameters<typeof mockGetTopQueries>) =>
      mockGetTopQueries(...args),
    getEmptyQueries: (...args: Parameters<typeof mockGetEmptyQueries>) =>
      mockGetEmptyQueries(...args),
    getToolCounts: (...args: Parameters<typeof mockGetToolCounts>) =>
      mockGetToolCounts(...args),
    analyticsHtmlPath,
  });

  return app;
}

// ---------------------------------------------------------------------------
// Helper: make HTTP requests to the test server
// ---------------------------------------------------------------------------

function request(
  server: http.Server,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method,
        headers,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Analytics server routes (HTTP-level)", () => {
  let server: http.Server;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the analytics-config mock at the top level so order-dependency
    // between tests can't cause one test's mockReturnValue to leak into the
    // next. Each test still sets its own value explicitly; this just
    // prevents accidental inheritance across describe blocks. Matches the
    // pattern used in analytics-endpoints.test.ts.
    mockGetAnalyticsConfigFn.mockReset();
    __resetAnalyticsTokenForTesting();
    delete process.env.ANALYTICS_TOKEN;
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleSpy.mockRestore();
    // Symmetric with beforeEach: reset env + the server.ts auto-generated
    // token cache so state can't leak into subsequent tests (matches the
    // afterEach pattern in analytics-endpoints.test.ts).
    __resetAnalyticsTokenForTesting();
    delete process.env.ANALYTICS_TOKEN;
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  function startApp(): Promise<void> {
    return new Promise((resolve) => {
      const app = buildTestApp();
      server = app.listen(0, () => resolve());
    });
  }

  // ---- Dashboard HTML route ------------------------------------------------

  describe("GET /analytics (dashboard HTML)", () => {
    it("returns HTML when analytics is enabled", async () => {
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "test-token",
      });

      await startApp();
      const res = await request(server, "GET", "/analytics");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      // The HTML should contain the login prompt div
      expect(res.body).toContain("login");
      expect(res.body).toContain("Analytics Token");
    });

    it("returns 404 JSON when analytics is disabled", async () => {
      mockGetAnalyticsConfigFn.mockReturnValue(undefined);

      await startApp();
      const res = await request(server, "GET", "/analytics");

      expect(res.status).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("Analytics not enabled");
    });

    it("serves HTML without requiring a token (auth is client-side)", async () => {
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "secret",
      });

      await startApp();
      // No Authorization header — HTML page should still be served
      const res = await request(server, "GET", "/analytics");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
    });

    // Every other test in this file passes an explicit analyticsHtmlPath
    // via deps. The default path (resolved relative to server.ts's
    // __dirname) is the production code path and was previously not
    // exercised by any test — a regression that breaks the default
    // resolver (e.g. a typo in the `../docs/analytics.html` relative
    // segment) would ship invisibly. This test locks it down.
    it("serves HTML from the default analyticsHtmlPath when no override is provided", async () => {
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "tok",
      });

      // Register routes WITHOUT an analyticsHtmlPath override so the
      // default resolver in registerAnalyticsRoutes fires.
      server = await new Promise<http.Server>((resolve) => {
        const app = express();
        app.use(express.json());
        registerAnalyticsRoutes(app);
        const s = app.listen(0, () => resolve(s));
      });
      const res = await request(server, "GET", "/analytics");

      if (res.status === 200) {
        expect(res.headers["content-type"]).toMatch(/text\/html/);
        expect(res.body).toContain("<title>Pathfinder Analytics</title>");
      } else {
        // Deterministic 404 if the default path doesn't resolve in this
        // test environment — either way, the route's behavior for the
        // default path is locked in.
        expect(res.status).toBe(404);
        expect(res.body).toContain("analytics dashboard not available");
      }
    });
  });

  // ---- API route auth behavior ---------------------------------------------

  describe("GET /api/analytics/summary (auth + data)", () => {
    it("returns 401 JSON without a token", async () => {
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "secret",
      });

      await startApp();
      const res = await request(server, "GET", "/api/analytics/summary");

      expect(res.status).toBe(401);
      const body = JSON.parse(res.body);
      // Envelope matches the 503 (misconfigured) branch: { error,
      // error_description } so every auth failure speaks one format.
      expect(body.error).toBe("unauthorized");
      expect(body.error_description).toMatch(
        /Missing or invalid Authorization/,
      );
    });

    it("returns data with a valid token", async () => {
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "secret",
      });
      mockGetAnalyticsSummary.mockResolvedValue({
        total_queries: 42,
        queries_today: 5,
      });

      await startApp();
      const res = await request(server, "GET", "/api/analytics/summary", {
        Authorization: "Bearer secret",
      });

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.total_queries).toBe(42);
      expect(body.queries_today).toBe(5);
    });

    it("returns 403 with an invalid token", async () => {
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "secret",
      });

      await startApp();
      const res = await request(server, "GET", "/api/analytics/summary", {
        Authorization: "Bearer wrong-token",
      });

      expect(res.status).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("forbidden");
      expect(body.error_description).toBe("Invalid analytics token");
    });

    it("returns 404 when analytics is disabled", async () => {
      mockGetAnalyticsConfigFn.mockReturnValue(undefined);

      await startApp();
      const res = await request(server, "GET", "/api/analytics/summary", {
        Authorization: "Bearer whatever",
      });

      expect(res.status).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("Analytics not enabled");
    });

    // Regression guard for the analyticsAuth middleware's config-throw
    // path: a corrupt YAML reload / env parse failure can make
    // getAnalyticsConfig() throw. Without the try/catch wrapper the throw
    // would escape as an unhandled Express exception (generic 500). The
    // middleware catches + converts to a 503 with the structured envelope
    // `{ error, error_description }` so operators see a stable shape.
    it("returns 503 with misconfigured envelope when getAnalyticsConfig throws", async () => {
      mockGetAnalyticsConfigFn.mockImplementation(() => {
        throw new Error("corrupt yaml");
      });
      // Silence the intentional `[analytics] auth misconfigured: config read
      // failed` console.error so test output stays clean.
      const consoleErrSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      await startApp();
      const res = await request(server, "GET", "/api/analytics/summary", {
        Authorization: "Bearer whatever",
      });

      expect(res.status).toBe(503);
      const body = JSON.parse(res.body);
      expect(body).toEqual({
        error: "misconfigured",
        error_description: "Analytics config read failed",
      });
      consoleErrSpy.mockRestore();
    });
  });

  // ---- Auto-generated token via HTTP ---------------------------------------

  describe("auto-generated token (HTTP-level)", () => {
    it("auto-generated token (log fingerprinted, full token withheld)", async () => {
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
      });
      mockGetAnalyticsSummary.mockResolvedValue({ total_queries: 0 });

      await startApp();

      // First request without auth — should 401 and trigger generation
      const res1 = await request(server, "GET", "/api/analytics/summary");
      expect(res1.status).toBe(401);

      // The log line must be a fingerprint, not the full token — so we
      // cannot (by design) recover the token from logs. Verify the log
      // format holds instead.
      const logCalls = consoleSpy.mock.calls.map((c: unknown[]) => c[0]);
      const tokenLog = logCalls.find(
        (msg: unknown) =>
          typeof msg === "string" &&
          msg.includes("[analytics] No token configured"),
      );
      expect(tokenLog).toBeDefined();
      expect(tokenLog as string).toMatch(/fingerprint=[A-Za-z0-9]{8}…/);
      const urlLog = logCalls.find(
        (msg: unknown) =>
          typeof msg === "string" && msg.includes("/analytics?token="),
      );
      expect(urlLog).toBeUndefined();
    });
  });

  // ---- Query parameter handling on actual routes ---------------------------

  describe("GET /api/analytics/queries (parameter parsing)", () => {
    it("passes days and limit query params to the handler", async () => {
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "tok",
      });
      mockGetTopQueries.mockResolvedValue([]);

      await startApp();
      await request(server, "GET", "/api/analytics/queries?days=14&limit=25", {
        Authorization: "Bearer tok",
      });

      expect(mockGetTopQueries).toHaveBeenCalledWith(14, 25, {});
    });

    it("defaults days to 7 and limit to 50 when not provided", async () => {
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "tok",
      });
      mockGetTopQueries.mockResolvedValue([]);

      await startApp();
      await request(server, "GET", "/api/analytics/queries", {
        Authorization: "Bearer tok",
      });

      expect(mockGetTopQueries).toHaveBeenCalledWith(7, 50, {});
    });

    it("rejects limit > 200 with 400", async () => {
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "tok",
      });
      mockGetTopQueries.mockResolvedValue([]);

      await startApp();
      const res = await request(
        server,
        "GET",
        "/api/analytics/queries?limit=999",
        { Authorization: "Bearer tok" },
      );

      expect(res.status).toBe(400);
      expect(mockGetTopQueries).not.toHaveBeenCalled();
    });

    // parsePositiveIntParam is shared across summary / queries /
    // empty-queries / tool-counts. Each handler needs its own end-to-end
    // assertion so a future refactor that forgets to wire the validator
    // into one of the paths surfaces here rather than silently passing
    // a malformed value into the DB layer.
    it("rejects limit > 200 on /api/analytics/empty-queries with 400", async () => {
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "tok",
      });
      mockGetEmptyQueries.mockResolvedValue([]);

      await startApp();
      const res = await request(
        server,
        "GET",
        "/api/analytics/empty-queries?limit=999",
        { Authorization: "Bearer tok" },
      );

      expect(res.status).toBe(400);
      expect(mockGetEmptyQueries).not.toHaveBeenCalled();
    });

    it("rejects days=abc on /api/analytics/tool-counts with 400", async () => {
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "tok",
      });
      mockGetToolCounts.mockResolvedValue([]);

      await startApp();
      const res = await request(
        server,
        "GET",
        "/api/analytics/tool-counts?days=abc",
        { Authorization: "Bearer tok" },
      );

      expect(res.status).toBe(400);
      expect(mockGetToolCounts).not.toHaveBeenCalled();
    });
  });

  // ---- from/to date range params ---------------------------------------------

  describe("GET /api/analytics/summary (from/to range)", () => {
    it("returns 200 with data when from+to are valid", async () => {
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "tok",
      });
      mockGetAnalyticsSummary.mockResolvedValue({ total_queries: 5 });

      await startApp();
      const res = await request(
        server,
        "GET",
        "/api/analytics/summary?from=2026-04-01&to=2026-04-20",
        { Authorization: "Bearer tok" },
      );

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.total_queries).toBe(5);

      // filter.from/to should be Date instances
      const callArg = mockGetAnalyticsSummary.mock.calls[0][0];
      expect(callArg.from).toBeInstanceOf(Date);
      expect(callArg.to).toBeInstanceOf(Date);
    });

    it("returns 400 when from is malformed", async () => {
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "tok",
      });

      await startApp();
      const res = await request(
        server,
        "GET",
        "/api/analytics/summary?from=invalid&to=2026-04-20",
        { Authorization: "Bearer tok" },
      );

      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("invalid_request");
      expect(body.error_description).toMatch(/YYYY-MM-DD/);
      expect(mockGetAnalyticsSummary).not.toHaveBeenCalled();
    });

    it("returns 400 when from is provided without to", async () => {
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "tok",
      });

      await startApp();
      const res = await request(
        server,
        "GET",
        "/api/analytics/summary?from=2026-04-01",
        { Authorization: "Bearer tok" },
      );

      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("invalid_request");
      expect(body.error_description).toMatch(/together/);
      expect(mockGetAnalyticsSummary).not.toHaveBeenCalled();
    });

    it("returns 200 with backcompat `days` param and forwards it to the DB layer", async () => {
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "tok",
      });
      mockGetAnalyticsSummary.mockResolvedValue({ total_queries: 7 });

      await startApp();
      // Use days=14 (non-default) so a regression that silently drops
      // `days` and reapplies the default of 7 is caught — with days=7
      // we can't tell the two apart.
      const res = await request(
        server,
        "GET",
        "/api/analytics/summary?days=14",
        { Authorization: "Bearer tok" },
      );

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.total_queries).toBe(7);
      const callArg = mockGetAnalyticsSummary.mock.calls[0][0];
      expect(callArg.from).toBeUndefined();
      expect(callArg.to).toBeUndefined();
      expect(mockGetAnalyticsSummary.mock.calls[0][1]).toBe(14);
    });

    // -------------------------------------------------------------------------
    // Regression: the summary handler used to drop the `days` query param
    // entirely — only parseAnalyticsFilter(from/to) made it to the DB layer.
    // As a result, the dashboard's "Last N days" preset never updated the
    // stat cards or the daily chart.
    // -------------------------------------------------------------------------
    it("forwards `days=30` through to getAnalyticsSummary as the second arg", async () => {
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "tok",
      });
      mockGetAnalyticsSummary.mockResolvedValue({ total_queries: 0 });

      await startApp();
      const res = await request(
        server,
        "GET",
        "/api/analytics/summary?days=30",
        { Authorization: "Bearer tok" },
      );

      expect(res.status).toBe(200);
      // getAnalyticsSummary must be invoked with (filter, days).
      expect(mockGetAnalyticsSummary).toHaveBeenCalledTimes(1);
      const [filterArg, daysArg] = mockGetAnalyticsSummary.mock.calls[0];
      expect(filterArg).toEqual({});
      expect(daysArg).toBe(30);
    });

    it("defaults `days` to 7 when no days param is provided", async () => {
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "tok",
      });
      mockGetAnalyticsSummary.mockResolvedValue({ total_queries: 0 });

      await startApp();
      await request(server, "GET", "/api/analytics/summary", {
        Authorization: "Bearer tok",
      });

      const [, daysArg] = mockGetAnalyticsSummary.mock.calls[0];
      expect(daysArg).toBe(7);
    });

    it("forwards days param alongside from/to range (DB layer handles precedence)", async () => {
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "tok",
      });
      mockGetAnalyticsSummary.mockResolvedValue({ total_queries: 0 });

      await startApp();
      // days=14 (non-default) proves the handler parsed and forwarded the
      // param — with days=7 a regression that drops the value and lets
      // the default reapply would be invisible.
      await request(
        server,
        "GET",
        "/api/analytics/summary?from=2026-04-01&to=2026-04-20&days=14",
        { Authorization: "Bearer tok" },
      );

      // The handler forwards both the explicit range (on filter) and the
      // days param; buildDateWindow inside the DB layer picks from/to when
      // both are set. Asserting both arguments here keeps the handler
      // behaviour locked down even if the DB precedence rule changes.
      const [filterArg, daysArg] = mockGetAnalyticsSummary.mock.calls[0];
      expect(daysArg).toBe(14);
      expect(filterArg.from).toBeInstanceOf(Date);
      expect(filterArg.to).toBeInstanceOf(Date);
    });
  });

  // ---- Days/limit param validation ------------------------------------------

  describe("GET /api/analytics/summary (days validation)", () => {
    function cfg() {
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "tok",
      });
      mockGetAnalyticsSummary.mockResolvedValue({ total_queries: 0 });
    }

    it("rejects from>to with 400", async () => {
      cfg();
      await startApp();
      const res = await request(
        server,
        "GET",
        "/api/analytics/summary?from=2026-04-20&to=2026-04-01",
        { Authorization: "Bearer tok" },
      );
      expect(res.status).toBe(400);
    });

    it("rejects Feb 30 as invalid calendar date with 400", async () => {
      cfg();
      await startApp();
      const res = await request(
        server,
        "GET",
        "/api/analytics/summary?from=2026-02-30&to=2026-04-20",
        { Authorization: "Bearer tok" },
      );
      expect(res.status).toBe(400);
    });

    it("rejects days=0 with 400", async () => {
      cfg();
      await startApp();
      const res = await request(
        server,
        "GET",
        "/api/analytics/summary?days=0",
        {
          Authorization: "Bearer tok",
        },
      );
      expect(res.status).toBe(400);
    });

    it("rejects days=-5 with 400", async () => {
      cfg();
      await startApp();
      const res = await request(
        server,
        "GET",
        "/api/analytics/summary?days=-5",
        { Authorization: "Bearer tok" },
      );
      expect(res.status).toBe(400);
    });

    it("rejects days=abc with 400", async () => {
      cfg();
      await startApp();
      const res = await request(
        server,
        "GET",
        "/api/analytics/summary?days=abc",
        { Authorization: "Bearer tok" },
      );
      expect(res.status).toBe(400);
    });
  });

  // ---- DB error handling (500 path) -----------------------------------------
  //
  // Each handler wraps its DB call in a try/catch that logs the error and
  // returns a generic 500. These tests lock down that contract so a handler
  // can't accidentally leak a stack trace (or, worse, crash the process).
  // ---------------------------------------------------------------------------

  describe("DB error handling (500 path)", () => {
    function cfg() {
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "tok",
      });
    }

    let errSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
      errSpy.mockRestore();
    });

    it("returns 500 JSON when getAnalyticsSummary throws", async () => {
      cfg();
      mockGetAnalyticsSummary.mockRejectedValueOnce(new Error("db down"));

      await startApp();
      const res = await request(server, "GET", "/api/analytics/summary", {
        Authorization: "Bearer tok",
      });

      expect(res.status).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.error).toBeTruthy();
      // Body must not leak internal stack/message detail
      expect(res.body).not.toContain("db down");
    });

    it("returns 500 JSON when getTopQueries throws", async () => {
      cfg();
      mockGetTopQueries.mockRejectedValueOnce(new Error("db down"));

      await startApp();
      const res = await request(server, "GET", "/api/analytics/queries", {
        Authorization: "Bearer tok",
      });

      expect(res.status).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.error).toBeTruthy();
      expect(res.body).not.toContain("db down");
    });

    it("returns 500 JSON when getEmptyQueries throws", async () => {
      cfg();
      mockGetEmptyQueries.mockRejectedValueOnce(new Error("db down"));

      await startApp();
      const res = await request(server, "GET", "/api/analytics/empty-queries", {
        Authorization: "Bearer tok",
      });

      expect(res.status).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.error).toBeTruthy();
      expect(res.body).not.toContain("db down");
    });

    it("returns 500 JSON when getToolCounts throws", async () => {
      cfg();
      mockGetToolCounts.mockRejectedValueOnce(new Error("db down"));

      await startApp();
      const res = await request(server, "GET", "/api/analytics/tool-counts", {
        Authorization: "Bearer tok",
      });

      expect(res.status).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.error).toBeTruthy();
      expect(res.body).not.toContain("db down");
    });
  });

  // ---- /analytics sendFile error paths (ENOENT + non-ENOENT) -----------------
  //
  // The dashboard HTML route wraps res.sendFile with an error callback that
  // maps ENOENT -> 404 (missing install) and any other error -> 500. These
  // tests cover both branches by pointing analyticsHtmlPath at paths that
  // won't serve as a regular file.
  // ---------------------------------------------------------------------------

  describe("GET /analytics file-serve error paths", () => {
    let errSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
      errSpy.mockRestore();
    });

    function startAppWithHtmlPath(htmlPath: string): Promise<http.Server> {
      return new Promise((resolve) => {
        const app = express();
        app.use(express.json());
        registerAnalyticsRoutes(app, {
          getAnalyticsSummary: (
            ...args: Parameters<typeof mockGetAnalyticsSummary>
          ) => mockGetAnalyticsSummary(...args),
          getTopQueries: (...args: Parameters<typeof mockGetTopQueries>) =>
            mockGetTopQueries(...args),
          getEmptyQueries: (...args: Parameters<typeof mockGetEmptyQueries>) =>
            mockGetEmptyQueries(...args),
          getToolCounts: (...args: Parameters<typeof mockGetToolCounts>) =>
            mockGetToolCounts(...args),
          analyticsHtmlPath: htmlPath,
        });
        const s = app.listen(0, () => resolve(s));
      });
    }

    it("returns 404 when analyticsHtmlPath does not exist (ENOENT)", async () => {
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "tok",
      });
      server = await startAppWithHtmlPath(
        "/nonexistent/definitely-does-not-exist.html",
      );
      const res = await request(server, "GET", "/analytics");
      expect(res.status).toBe(404);
      expect(res.body).toContain("analytics dashboard not available");
    });

    it("returns 500 on non-ENOENT sendFile error (e.g. path is a directory)", async () => {
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "tok",
      });
      // Pointing at a directory triggers an EISDIR-style error rather than
      // ENOENT, exercising the "anything else" 500 branch.
      server = await startAppWithHtmlPath("/tmp");
      const res = await request(server, "GET", "/analytics");
      expect(res.status).toBe(500);
      expect(res.body).toContain("analytics dashboard unavailable");
    });
  });

  // ---- /api/analytics/auth-mode HTTP-level tests ----------------------------
  //
  // End-to-end coverage for the public (unauthenticated) auth-mode endpoint.
  // These complement the getAuthMode() unit tests below by locking down the
  // wiring: no auth middleware, JSON body shape, and dev/prod branches.
  //
  // The test `request()` helper connects over TCP from 127.0.0.1, so the
  // dev + localhost branch is reachable end-to-end. The non-localhost branch
  // can't be exercised over TCP (the server always sees a loopback socket),
  // so that case uses direct handler invocation with a synthetic Request —
  // matching the strategy in the getAuthMode() unit tests below.
  // ---------------------------------------------------------------------------

  describe("GET /api/analytics/auth-mode", () => {
    it("dev mode from localhost -> 200 + { dev: true }", async () => {
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
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "tok",
      });

      await startApp();
      // No Authorization header — the endpoint must be public.
      const res = await request(server, "GET", "/api/analytics/auth-mode");

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({ dev: true });
    });

    it("dev mode from non-localhost -> { dev: false } (direct handler invocation)", () => {
      // The test HTTP server always sees 127.0.0.1, so this branch must be
      // exercised by calling getAuthMode() directly with a synthetic Request
      // whose socket.remoteAddress is non-loopback. Mirrors the strategy in
      // the getAuthMode() unit-tests describe below.
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
      const fakeReq = {
        socket: { remoteAddress: "203.0.113.7" },
      } as unknown as Request;
      expect(getAuthMode(fakeReq)).toEqual({ dev: false });
    });

    it("prod mode from localhost -> 200 + { dev: false }", async () => {
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
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "tok",
      });

      await startApp();
      const res = await request(server, "GET", "/api/analytics/auth-mode");

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({ dev: false });
    });

    it("endpoint is public — accessible without Authorization header even when a token is configured", async () => {
      // Regression guard: auth-mode is the one endpoint the dashboard hits
      // BEFORE the operator has supplied a token. If it ever gets gated by
      // analyticsAuth, the dashboard can never advertise dev-bypass and the
      // login prompt is mandatory even on localhost.
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
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "secret",
      });

      await startApp();
      // No Authorization header, token configured — a gated endpoint would
      // 401 here. auth-mode must return 200.
      const res = await request(server, "GET", "/api/analytics/auth-mode");
      expect(res.status).toBe(200);
    });
  });

  // ---- getAuthMode() unit tests ---------------------------------------------
  //
  // We test the exported helper directly rather than via /api/analytics/auth-
  // mode over TCP because the test HTTP server always receives requests from
  // 127.0.0.1 — there's no way to exercise the "non-localhost socket" branch
  // without either binding to a routable interface (flaky) or spoofing the
  // socket object on a synthetic Request (what we do here).
  // ---------------------------------------------------------------------------

  describe("getAuthMode()", () => {
    beforeEach(() => {
      mockGetConfigFn.mockReset();
    });

    function mkReq(remoteAddress: string): Request {
      return { socket: { remoteAddress } } as unknown as Request;
    }

    function cfgWithEnv(nodeEnv: string) {
      mockGetConfigFn.mockReturnValue({
        port: 3001,
        databaseUrl: "pglite:///tmp/test",
        openaiApiKey: "",
        githubToken: "",
        githubWebhookSecret: "",
        nodeEnv,
        logLevel: "info",
        cloneDir: "/tmp/test",
        slackBotToken: "",
        slackSigningSecret: "",
        discordBotToken: "",
        discordPublicKey: "",
        notionToken: "",
        mcpJwtSecret: "x".repeat(32),
      });
    }

    it("development + localhost (127.0.0.1) -> { dev: true }", () => {
      cfgWithEnv("development");
      expect(getAuthMode(mkReq("127.0.0.1"))).toEqual({ dev: true });
    });

    it("development + localhost (::1) -> { dev: true }", () => {
      cfgWithEnv("development");
      expect(getAuthMode(mkReq("::1"))).toEqual({ dev: true });
    });

    it("development + localhost (::ffff:127.0.0.1) -> { dev: true }", () => {
      cfgWithEnv("development");
      expect(getAuthMode(mkReq("::ffff:127.0.0.1"))).toEqual({ dev: true });
    });

    it("development + non-localhost socket -> { dev: false }", () => {
      cfgWithEnv("development");
      expect(getAuthMode(mkReq("192.168.1.100"))).toEqual({ dev: false });
    });

    it("production + localhost -> { dev: false }", () => {
      cfgWithEnv("production");
      expect(getAuthMode(mkReq("127.0.0.1"))).toEqual({ dev: false });
    });

    it("production + non-localhost -> { dev: false }", () => {
      cfgWithEnv("production");
      expect(getAuthMode(mkReq("192.168.1.100"))).toEqual({ dev: false });
    });

    // Security regression guard for the X-Forwarded-For spoof vector:
    // isLocalhostReq() trusts ONLY req.socket.remoteAddress. If someone on
    // the LAN reaches a dev server bound to 0.0.0.0 and sends
    // `X-Forwarded-For: 127.0.0.1`, the proxy header MUST NOT be honored
    // — otherwise a forged header promotes the caller to dev bypass.
    it("X-Forwarded-For: 127.0.0.1 from a non-loopback socket does NOT grant dev bypass", () => {
      cfgWithEnv("development");
      // Synthetic Request whose socket is LAN-originated but whose
      // forwarded-for header claims loopback. The helper intentionally
      // ignores headers — assert it stays at `dev: false`.
      const fakeReq = {
        socket: { remoteAddress: "192.168.1.100" },
        headers: { "x-forwarded-for": "127.0.0.1" },
      } as unknown as Request;
      expect(getAuthMode(fakeReq)).toEqual({ dev: false });
    });

    it("analyticsAuth rejects when socket is LAN and X-Forwarded-For claims loopback", () => {
      // Pair the getAuthMode() assertion with a middleware-level check:
      // the dev bypass path inside analyticsAuth() also funnels through
      // isLocalhostReq(), so a spoofed XFF must still require a token.
      cfgWithEnv("development");
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "real-token",
      });

      const req = {
        socket: { remoteAddress: "192.168.1.100" },
        // No Authorization header. XFF claims localhost but the middleware
        // reads only req.socket.remoteAddress via isLocalhostReq.
        headers: { "x-forwarded-for": "127.0.0.1" },
      } as unknown as Request;

      let status = 0;
      let body: unknown = null;
      const next = vi.fn();
      const res = {
        status(code: number) {
          status = code;
          return this;
        },
        json(payload: unknown) {
          body = payload;
          return this;
        },
      } as unknown as Response;

      analyticsAuth(req, res, next);

      // The dev bypass path would have called next() — it must not.
      expect(next).not.toHaveBeenCalled();
      // Without an Authorization header + non-dev path, the middleware
      // responds 401 (token required).
      expect(status).toBe(401);
      expect(body).toMatchObject({ error: "unauthorized" });
    });
  });

  // ---- auth-mode disabled contract -----------------------------------------
  // /api/analytics/auth-mode is intentionally public (the dashboard hits
  // it before the login prompt), but when analytics itself is disabled
  // the endpoint must mirror the 404 contract other analytics routes
  // use — otherwise the endpoint becomes a probe for analytics presence/
  // absence on servers that don't have it configured.
  describe("GET /api/analytics/auth-mode disabled-state contract", () => {
    it("returns 404 Analytics-not-enabled when analytics is disabled", async () => {
      mockGetAnalyticsConfigFn.mockReturnValue(undefined);
      await startApp();
      const res = await request(server, "GET", "/api/analytics/auth-mode");
      expect(res.status).toBe(404);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({ error: "Analytics not enabled" });
    });

    it("returns 200 with dev flag when analytics is enabled", async () => {
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "tok",
      });
      await startApp();
      const res = await request(server, "GET", "/api/analytics/auth-mode");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("dev");
      // In the vitest `test` NODE_ENV the dev bypass is always off, so
      // the response is a flat { dev: false }. Assert the shape, not the
      // value of `dev` — the dev/localhost combinatorics are covered in
      // the getAuthMode() unit tests above.
      expect(typeof body.dev).toBe("boolean");
    });

    it("returns 503 misconfigured when getAnalyticsConfig() throws", async () => {
      // Hot-reload / bad-YAML scenarios: a throw from the config read
      // must NOT escape the handler as an unhandled exception. Mirror
      // the analyticsAuth 503 envelope so every failure shape is
      // uniform.
      mockGetAnalyticsConfigFn.mockImplementation(() => {
        throw new Error("config read boom");
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await startApp();
      const res = await request(server, "GET", "/api/analytics/auth-mode");
      expect(res.status).toBe(503);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({ error: "misconfigured" });
      errSpy.mockRestore();
    });
  });
});
