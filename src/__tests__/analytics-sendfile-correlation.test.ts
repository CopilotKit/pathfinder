/**
 * R3 #8 — when /analytics sendFile fails with a non-ENOENT error, the 500
 * body is "analytics dashboard unavailable" with no correlation ID. An
 * operator who gets a user report ("the dashboard is broken") has no way
 * to grep logs for THIS failure — only the generic string that every
 * failure shares. Inject a correlation ID into both the log line and the
 * response body so operators can match them 1:1.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "node:http";
import path from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";

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

import { registerAnalyticsRoutes } from "../server.js";

function httpGet(
  server: http.Server,
  p: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      { hostname: "127.0.0.1", port: addr.port, path: p, method: "GET" },
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

describe("/analytics sendFile 500 correlation ID (R3 #8)", () => {
  let server: http.Server;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let htmlPath: string;

  beforeEach(async () => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = express();
    // Point sendFile at an empty directory so sendFile fails with
    // EISDIR (which is NOT ENOENT, so it hits the 500 branch).
    htmlPath = path.join(tmpdir(), `pf-test-${Date.now()}`);
    writeFileSync(htmlPath, ""); // placeholder; we'll delete then test
    registerAnalyticsRoutes(app, { analyticsHtmlPath: tmpdir() });
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  });

  afterEach(async () => {
    consoleErrorSpy.mockRestore();
    try {
      unlinkSync(htmlPath);
    } catch {
      /* already gone */
    }
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("returns a correlation ID in the 500 body and logs it", async () => {
    const res = await httpGet(server, "/analytics");
    // Expect 500 because sendFile on a directory (tmpdir) fails with
    // EISDIR, which is not ENOENT, so we hit the 500 branch.
    expect(res.status).toBe(500);
    const body = JSON.parse(res.body) as {
      error: string;
      correlationId?: string;
    };
    expect(body.error).toMatch(/unavailable/);
    expect(body.correlationId).toBeTruthy();
    expect(typeof body.correlationId).toBe("string");
    expect(body.correlationId!.length).toBeGreaterThan(4);

    // The same correlation ID must appear in the log line so an
    // operator can grep from a user-reported ID to the failing stack.
    const joined = consoleErrorSpy.mock.calls.flat().map(String).join(" ");
    expect(joined).toContain(body.correlationId!);
  });
});
