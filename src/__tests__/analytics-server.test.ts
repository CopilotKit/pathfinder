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

import { getAnalyticsConfig } from "../config.js";
import {
  registerAnalyticsRoutes,
  __resetAnalyticsTokenForTesting,
} from "../server.js";

const mockGetAnalyticsConfigFn = vi.mocked(getAnalyticsConfig);

// ---------------------------------------------------------------------------
// Build an Express app using the production registerAnalyticsRoutes() so
// tests exercise the real handler implementations end-to-end. DB-layer calls
// are routed through our mocks via the deps hook.
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
    __resetAnalyticsTokenForTesting();
    delete process.env.ANALYTICS_TOKEN;
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleSpy.mockRestore();
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
      expect(body.error).toMatch(/Missing or invalid Authorization/);
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
      expect(body.error).toBe("Invalid analytics token");
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

    it("returns 200 with backcompat `days` param", async () => {
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "tok",
      });
      mockGetAnalyticsSummary.mockResolvedValue({ total_queries: 7 });

      await startApp();
      const res = await request(
        server,
        "GET",
        "/api/analytics/summary?days=7",
        { Authorization: "Bearer tok" },
      );

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.total_queries).toBe(7);
      const callArg = mockGetAnalyticsSummary.mock.calls[0][0];
      expect(callArg.from).toBeUndefined();
      expect(callArg.to).toBeUndefined();
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
      await request(
        server,
        "GET",
        "/api/analytics/summary?from=2026-04-01&to=2026-04-20&days=7",
        { Authorization: "Bearer tok" },
      );

      // The handler forwards both the explicit range (on filter) and the
      // days param; buildDateWindow inside the DB layer picks from/to when
      // both are set. Asserting both arguments here keeps the handler
      // behaviour locked down even if the DB precedence rule changes.
      const [filterArg, daysArg] = mockGetAnalyticsSummary.mock.calls[0];
      expect(daysArg).toBe(7);
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
      const res = await request(
        server,
        "GET",
        "/api/analytics/empty-queries",
        { Authorization: "Bearer tok" },
      );

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
});
