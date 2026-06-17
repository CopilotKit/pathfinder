/**
 * R3 #7 — analytics error logs in the four handlers (summary / queries /
 * empty-queries / tool-counts) must include the client IP so operators can
 * correlate a 500 back to a specific caller. Without it, a single misbehaving
 * IP hammering a broken query shows up as an anonymous stream of errors and
 * the only mitigation is shutting the whole endpoint off.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "node:http";

vi.mock("../db/analytics.js", () => ({
  getAnalyticsSummary: vi.fn(),
  getTopQueries: vi.fn(),
  getEmptyQueries: vi.fn(),
  getToolCounts: vi.fn(),
}));

vi.mock("../config.js", () => ({
  getServerConfig: vi.fn().mockReturnValue({ sources: [], tools: [] }),
  getAnalyticsConfig: vi.fn().mockReturnValue({ enabled: true, token: "t" }),
  getConfig: vi.fn().mockReturnValue({ nodeEnv: "development" }),
  hasSearchTools: vi.fn().mockReturnValue(false),
  hasKnowledgeTools: vi.fn().mockReturnValue(false),
  hasCollectTools: vi.fn().mockReturnValue(false),
  hasBashSemanticSearch: vi.fn().mockReturnValue(false),
  assertDocumentPeerDepsForSources: vi.fn().mockResolvedValue(undefined),
}));

import {
  registerAnalyticsRoutes,
  __resetAnalyticsTokenForTesting,
  __setTrustProxyForTesting,
} from "../server.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  __setTrustProxyForTesting(false);
  registerAnalyticsRoutes(app, {
    getAnalyticsSummary: async () => {
      throw new Error("db boom");
    },
    getTopQueries: async () => {
      throw new Error("db boom");
    },
    getEmptyQueries: async () => {
      throw new Error("db boom");
    },
    getToolCounts: async () => {
      throw new Error("db boom");
    },
  });
  return app;
}

function httpGet(
  server: http.Server,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method: "GET",
        headers: { Authorization: "Bearer t" },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("analytics handler error logs include client IP (R3 #7)", () => {
  let server: http.Server;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    __resetAnalyticsTokenForTesting();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = buildApp();
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  });

  afterEach(async () => {
    consoleErrorSpy.mockRestore();
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function assertLogContainsIp(path: string) {
    const res = await httpGet(server, path);
    expect(res.status).toBe(500);
    const joined = consoleErrorSpy.mock.calls.flat().map(String).join(" ");
    expect(joined).toMatch(/ip=/);
  }

  it("includes ip= in /api/analytics/summary 500 error log", async () => {
    await assertLogContainsIp("/api/analytics/summary");
  });

  it("includes ip= in /api/analytics/queries 500 error log", async () => {
    await assertLogContainsIp("/api/analytics/queries");
  });

  it("includes ip= in /api/analytics/empty-queries 500 error log", async () => {
    await assertLogContainsIp("/api/analytics/empty-queries");
  });

  it("includes ip= in /api/analytics/tool-counts 500 error log", async () => {
    await assertLogContainsIp("/api/analytics/tool-counts");
  });
});
