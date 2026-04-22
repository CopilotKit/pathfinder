/**
 * analyticsAuth: 503 misconfiguration message differentiation by env.
 *
 * In production the operator is expected to set ANALYTICS_TOKEN explicitly;
 * if the auth middleware can't resolve a token we must surface that plainly.
 * In non-prod environments auto-generation is the normal path and the
 * production-flavored message would be misleading — so the 503 response body
 * must differ so operators can tell the two failure modes apart.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "node:http";

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
  });
  mockGetServerConfig.mockReturnValue({
    server: { name: "pathfinder-test", version: "0.0.0" },
    sources: [],
    tools: [],
  });
  mockGetAnalyticsConfig.mockReturnValue(undefined);
});

describe("analyticsAuth 503 message prod vs non-prod", () => {
  let server: http.Server | undefined;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    consoleErrSpy.mockRestore();
    if (server?.listening) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    server = undefined;
  });

  async function buildAndStart(): Promise<http.Server> {
    const { registerAnalyticsRoutes, __resetAnalyticsTokenForTesting } =
      await import("../server.js");
    __resetAnalyticsTokenForTesting();
    const app = express();
    app.use(express.json());
    registerAnalyticsRoutes(app);
    return await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
  }

  function request(
    s: http.Server,
    path: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const addr = s.address() as { port: number };
      const req = http.request(
        { hostname: "127.0.0.1", port: addr.port, path, headers },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () =>
            resolve({ status: res.statusCode!, body: body.toString() }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("mentions production when NODE_ENV=production and no token configured", async () => {
    mockGetConfig.mockReturnValue({
      port: 0,
      databaseUrl: "",
      openaiApiKey: "",
      githubToken: "",
      githubWebhookSecret: "",
      nodeEnv: "production",
      logLevel: "info",
      cloneDir: "",
      slackBotToken: "",
      slackSigningSecret: "",
      discordBotToken: "",
      discordPublicKey: "",
      notionToken: "",
      mcpJwtSecret: "e".repeat(64),
    });
    mockGetAnalyticsConfig.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
    });

    server = await buildAndStart();
    const res = await request(server, "/api/analytics/summary", {
      Authorization: "Bearer whatever",
    });

    expect(res.status).toBe(503);
    const body = JSON.parse(res.body) as Record<string, string>;
    expect(body.error).toBe("misconfigured");
    // Production message must mention production explicitly so the operator
    // knows to set ANALYTICS_TOKEN.
    expect(body.error_description).toMatch(/production/i);
  });

  it("dev-bypass is disabled when trust_proxy=true even if the socket peer is loopback (R2 #4)", async () => {
    // Threat model: with trust_proxy=true AND NODE_ENV=development AND the
    // server sitting behind a local reverse proxy (Docker sidecar, ngrok,
    // localhost tunnel), every request's socket peer is 127.0.0.1 — the
    // pre-fix dev bypass would unlock analytics for the entire public
    // internet. Fail-closed: when trust_proxy=true we never grant the dev
    // bypass, and the request flows into the token-required path (which
    // without a Bearer token returns 401).
    mockGetConfig.mockReturnValue({
      port: 0,
      databaseUrl: "",
      openaiApiKey: "",
      githubToken: "",
      githubWebhookSecret: "",
      nodeEnv: "development",
      logLevel: "info",
      cloneDir: "",
      slackBotToken: "",
      slackSigningSecret: "",
      discordBotToken: "",
      discordPublicKey: "",
      notionToken: "",
      mcpJwtSecret: "e".repeat(64),
    });
    mockGetAnalyticsConfig.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
    });

    const { __setTrustProxyForTesting } = await import("../server.js");
    __setTrustProxyForTesting(true);
    try {
      server = await buildAndStart();
      // No Authorization header. Pre-fix: dev bypass on loopback -> 200/404.
      // Post-fix: dev bypass refused under trust_proxy=true -> 401 because
      // no Bearer token was supplied.
      const res = await request(server, "/api/analytics/summary", {});
      expect(res.status).toBe(401);
    } finally {
      __setTrustProxyForTesting(false);
    }
  });

  it("does NOT mention production in non-prod 503s (different diagnostic message)", async () => {
    // Non-prod scenario: in non-production environments, the
    // "Analytics requires ANALYTICS_TOKEN in production" message is
    // misleading because auto-generation IS the expected dev path. Drive
    // the "no token available" fallback branch (getAnalyticsToken returns
    // undefined) in a non-prod nodeEnv and assert the 503 message is not
    // the production one.
    let call = 0;
    mockGetAnalyticsConfig.mockImplementation(() => {
      call += 1;
      if (call === 1) {
        return {
          enabled: true,
          log_queries: true,
          retention_days: 90,
        };
      }
      throw new Error("downstream token failure");
    });

    // Use nodeEnv=staging to skip BOTH the production-requires-token branch
    // AND the dev-localhost bypass (bypass only fires on NODE_ENV=development).
    mockGetConfig.mockReturnValue({
      port: 0,
      databaseUrl: "",
      openaiApiKey: "",
      githubToken: "",
      githubWebhookSecret: "",
      nodeEnv: "staging",
      logLevel: "info",
      cloneDir: "",
      slackBotToken: "",
      slackSigningSecret: "",
      discordBotToken: "",
      discordPublicKey: "",
      notionToken: "",
      mcpJwtSecret: "e".repeat(64),
    });

    server = await buildAndStart();

    const res = await request(server, "/api/analytics/summary", {
      Authorization: "Bearer whatever",
    });

    expect(res.status).toBe(503);
    const body = JSON.parse(res.body) as Record<string, string>;
    expect(body.error).toBe("misconfigured");
    // Non-prod message must NOT mention production — that'd be misleading.
    expect(body.error_description).not.toMatch(/production/i);
  });

  // R4-16: the dev-bypass gate is `nodeEnv === "development" && isLocalhostReq`.
  // Both halves are load-bearing: "test", "staging", or an unset env must NOT
  // unlock the bypass, and production must always require a Bearer token even
  // from loopback. Lock the full NODE_ENV truth table so a future refactor
  // can't silently widen the gate by substring / prefix / .startsWith match.
  describe("dev-bypass gate — NODE_ENV truth table (R4-16)", () => {
    function cfgWithNodeEnv(nodeEnv: string) {
      return {
        port: 0,
        databaseUrl: "",
        openaiApiKey: "",
        githubToken: "",
        githubWebhookSecret: "",
        nodeEnv,
        logLevel: "info",
        cloneDir: "",
        slackBotToken: "",
        slackSigningSecret: "",
        discordBotToken: "",
        discordPublicKey: "",
        notionToken: "",
        mcpJwtSecret: "e".repeat(64),
      };
    }

    it("NODE_ENV=development + loopback grants the dev-bypass (no Bearer required)", async () => {
      mockGetConfig.mockReturnValue(cfgWithNodeEnv("development"));
      mockGetAnalyticsConfig.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
      });

      server = await buildAndStart();
      // No Authorization header. The bypass MUST fire, so the response
      // cannot be 401. It may be 200/404/500 depending on downstream
      // handler resolution in the test harness — we only assert the gate
      // did not short-circuit to 401.
      const res = await request(server, "/api/analytics/summary", {});
      expect(res.status).not.toBe(401);
    });

    it("NODE_ENV=production + loopback still requires a Bearer token (no bypass)", async () => {
      mockGetConfig.mockReturnValue(cfgWithNodeEnv("production"));
      mockGetAnalyticsConfig.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "production-token-value",
      });

      server = await buildAndStart();
      const res = await request(server, "/api/analytics/summary", {});
      expect(res.status).toBe(401);
    });

    it("NODE_ENV=test + loopback does NOT grant dev-bypass (only the literal 'development' does)", async () => {
      mockGetConfig.mockReturnValue(cfgWithNodeEnv("test"));
      mockGetAnalyticsConfig.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "test-token-value",
      });

      server = await buildAndStart();
      const res = await request(server, "/api/analytics/summary", {});
      // "test" must not unlock the bypass even though it's non-production.
      expect(res.status).toBe(401);
    });

    it("NODE_ENV=staging + loopback does NOT grant dev-bypass", async () => {
      mockGetConfig.mockReturnValue(cfgWithNodeEnv("staging"));
      mockGetAnalyticsConfig.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "staging-token-value",
      });

      server = await buildAndStart();
      const res = await request(server, "/api/analytics/summary", {});
      expect(res.status).toBe(401);
    });

    it("NODE_ENV='' (empty string) + loopback does NOT grant dev-bypass — only the literal 'development' does", async () => {
      // Defense-in-depth: config.ts defaults `process.env.NODE_ENV || 'development'`
      // so in practice an unset env resolves to 'development' at load. But if
      // a caller injects a cfg with an explicitly empty string, the gate must
      // still fail closed.
      mockGetConfig.mockReturnValue(cfgWithNodeEnv(""));
      mockGetAnalyticsConfig.mockReturnValue({
        enabled: true,
        log_queries: true,
        retention_days: 90,
        token: "any-token-value",
      });

      server = await buildAndStart();
      const res = await request(server, "/api/analytics/summary", {});
      expect(res.status).toBe(401);
    });
  });
});
