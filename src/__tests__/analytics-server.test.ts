import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { Request, Response } from "express";
import http from "node:http";
import path from "node:path";

const mockGetAnalyticsSummary = vi.fn();
const mockGetTopQueries = vi.fn();
const mockGetEmptyQueries = vi.fn();

vi.mock("../db/analytics.js", () => ({
  getAnalyticsSummary: (...args: unknown[]) => mockGetAnalyticsSummary(...args),
  getTopQueries: (...args: unknown[]) => mockGetTopQueries(...args),
  getEmptyQueries: (...args: unknown[]) => mockGetEmptyQueries(...args),
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
import { analyticsAuth, parseAnalyticsFilter } from "../server.js";

const mockGetAnalyticsConfigFn = vi.mocked(getAnalyticsConfig);

// ---------------------------------------------------------------------------
// Build a minimal Express app that mirrors the analytics routes from server.ts
// so we can test actual HTTP request/response behavior.
// ---------------------------------------------------------------------------

function buildTestApp() {
  const app = express();
  app.use(express.json());

  // Resolve docs/analytics.html from the repo root. Vitest runs from the
  // repo root, so process.cwd() is stable regardless of whether __dirname
  // points into src/__tests__ (source tree) or dist/__tests__ (built).
  const analyticsHtmlPath = path.join(process.cwd(), "docs", "analytics.html");

  // Dashboard HTML route — mirrors server.ts /analytics
  app.get("/analytics", (_req: Request, res: Response) => {
    if (!getAnalyticsConfig()?.enabled) {
      res.status(404).json({ error: "Analytics not enabled" });
      return;
    }
    // `dotfiles: "allow"` is required so the file serves from paths that
    // contain a dot-prefixed segment (e.g. git worktrees under `.claude/`).
    // Without it, Express's `send` returns 404 for any path containing a
    // dotfile component, which is unrelated to the actual file's existence.
    res.sendFile(analyticsHtmlPath, { dotfiles: "allow" });
  });

  // API routes with analyticsAuth middleware — mirror the real handlers
  // so we exercise parseAnalyticsFilter (from/to validation) end-to-end.
  app.get(
    "/api/analytics/summary",
    analyticsAuth,
    async (req: Request, res: Response) => {
      try {
        const parsed = parseAnalyticsFilter(req);
        if (!parsed.ok) {
          res.status(parsed.status).json(parsed.body);
          return;
        }
        const days = parseInt(req.query.days as string) || 7;
        const summary = await mockGetAnalyticsSummary(parsed.filter, days);
        res.json(summary);
      } catch (err) {
        res.status(500).json({ error: "Failed to fetch analytics summary" });
      }
    },
  );

  app.get(
    "/api/analytics/queries",
    analyticsAuth,
    async (req: Request, res: Response) => {
      try {
        const parsed = parseAnalyticsFilter(req);
        if (!parsed.ok) {
          res.status(parsed.status).json(parsed.body);
          return;
        }
        const days = parseInt(req.query.days as string) || 7;
        const limit = parseInt(req.query.limit as string) || 50;
        const queries = await mockGetTopQueries(
          days,
          Math.min(limit, 200),
          parsed.filter,
        );
        res.json(queries);
      } catch (err) {
        res.status(500).json({ error: "Failed to fetch top queries" });
      }
    },
  );

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
    it("auto-generated token works for API requests when no token configured", async () => {
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
      });
      mockGetAnalyticsSummary.mockResolvedValue({ total_queries: 0 });

      await startApp();

      // First request without auth — should get 401 and trigger token generation
      const res1 = await request(server, "GET", "/api/analytics/summary");
      expect(res1.status).toBe(401);

      // Extract the auto-generated token from console.log
      const logCalls = consoleSpy.mock.calls.map((c: unknown[]) => c[0]);
      const tokenLog = logCalls.find(
        (msg: unknown) =>
          typeof msg === "string" &&
          msg.includes("[analytics] No token configured"),
      );
      expect(tokenLog).toBeDefined();
      const autoToken = (tokenLog as string).match(
        /auto-generated token: (\S+)/,
      )![1];

      // Second request with the auto-generated token should succeed
      const res2 = await request(server, "GET", "/api/analytics/summary", {
        Authorization: `Bearer ${autoToken}`,
      });
      expect(res2.status).toBe(200);
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

    it("caps limit at 200", async () => {
      mockGetAnalyticsConfigFn.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "tok",
      });
      mockGetTopQueries.mockResolvedValue([]);

      await startApp();
      await request(server, "GET", "/api/analytics/queries?limit=999", {
        Authorization: "Bearer tok",
      });

      expect(mockGetTopQueries).toHaveBeenCalledWith(7, 200, {});
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

    it("does not pass `days` to DB when from/to range is active", async () => {
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
        "/api/analytics/summary?from=2026-04-01&to=2026-04-20&days=30",
        { Authorization: "Bearer tok" },
      );

      // `days` still reaches the DB layer as a fallback (default 7), but the
      // explicit from/to range takes precedence inside buildDateWindow.
      const [filterArg] = mockGetAnalyticsSummary.mock.calls[0];
      expect(filterArg.from).toBeInstanceOf(Date);
      expect(filterArg.to).toBeInstanceOf(Date);
    });
  });
});
