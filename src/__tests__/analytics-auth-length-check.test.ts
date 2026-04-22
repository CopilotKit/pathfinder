/**
 * R4-18 — analyticsAuth's timingSafeEqual comparison works today, but the
 * length check and the equality call are fused into a single boolean
 * expression (`len !== len || !timingSafeEqual(...)`). That's correct but
 * fragile: a future refactor that flips the || to && or reorders the
 * operands would crash with an ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH thrown
 * from timingSafeEqual (which REQUIRES same-length buffers). Split the
 * check into a dedicated early return so the contract is explicit and
 * self-documenting.
 *
 * This test asserts the observable behavior holds in both branches —
 * the split shouldn't change response shape or status.
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
  getAnalyticsConfig: vi
    .fn()
    .mockReturnValue({ enabled: true, token: "correct-token-1234" }),
  getConfig: vi.fn().mockReturnValue({ nodeEnv: "production" }),
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

function httpGet(
  server: http.Server,
  p: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path: p,
        method: "GET",
        headers,
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

describe("analyticsAuth length-check early return (R4-18)", () => {
  let server: http.Server;

  beforeEach(async () => {
    __resetAnalyticsTokenForTesting();
    __setTrustProxyForTesting(false);
    const app = express();
    app.use(express.json());
    registerAnalyticsRoutes(app, {
      getAnalyticsSummary: async () => ({ total: 0 }) as never,
      getTopQueries: async () => [],
      getEmptyQueries: async () => [],
      getToolCounts: async () => [],
    });
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("returns 403 for a token of DIFFERENT length without throwing", async () => {
    const res = await httpGet(server, "/api/analytics/summary", {
      Authorization: "Bearer x", // 1 char vs 18-char correct token
    });
    expect(res.status).toBe(403);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("forbidden");
  });

  it("returns 403 for a token of SAME length that differs byte-wise", async () => {
    // "correct-token-1234" is 18 chars; "zzzzzzzzzzzzzzzzzz" is also 18.
    const res = await httpGet(server, "/api/analytics/summary", {
      Authorization: "Bearer zzzzzzzzzzzzzzzzzz",
    });
    expect(res.status).toBe(403);
  });

  it("accepts the correct token", async () => {
    const res = await httpGet(server, "/api/analytics/summary", {
      Authorization: "Bearer correct-token-1234",
    });
    expect(res.status).toBe(200);
  });
});
