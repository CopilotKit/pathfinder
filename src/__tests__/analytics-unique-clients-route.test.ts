/**
 * GET /api/analytics/summary with `shared_client_ids`, end to end through the
 * real route handler and the real getAnalyticsSummary SQL on PGlite. Only the
 * config module is stubbed, so the route's bearer auth has a token.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import { PGlite } from "@electric-sql/pglite";

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

import { __setPoolForTesting, __resetPoolForTesting } from "../db/client.js";
import { generatePostSchemaMigration } from "../db/schema.js";
import {
  registerAnalyticsRoutes,
  __resetAnalyticsTokenForTesting,
  __setTrustProxyForTesting,
} from "../server.js";

const QUERY_LOG_DDL_MARKER =
  "-- Analytics: query_log table for tracking tool usage";

function extractAnalyticsDdl(): string {
  const full = generatePostSchemaMigration();
  const idx = full.indexOf(QUERY_LOG_DDL_MARKER);
  if (idx < 0) {
    throw new Error(`Could not locate "${QUERY_LOG_DDL_MARKER}" in schema`);
  }
  return full.slice(idx);
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

describe("GET /api/analytics/summary shared_client_ids (real SQL)", () => {
  let db: PGlite;
  let server: http.Server;

  beforeAll(async () => {
    db = new PGlite();
    await db.waitReady;
    await db.exec(extractAnalyticsDdl());
    __setPoolForTesting({
      query: (text: string, params?: unknown[]) => db.query(text, params),
      connect: async () => ({
        query: (text: string, params?: unknown[]) => db.query(text, params),
        release: () => {},
      }),
      end: async () => db.close(),
    });
    __resetAnalyticsTokenForTesting();
    __setTrustProxyForTesting(false);
    const app = express();
    registerAnalyticsRoutes(app);
    server = app.listen(0);
    await new Promise<void>((r) => server.once("listening", () => r()));
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    __resetPoolForTesting();
    await db.close();
  });

  it("counts a listed id with no usable IP as one client", async () => {
    for (const ip of [null, "unknown", ""]) {
      await db.query(
        `INSERT INTO query_log
          (tool_name, query_text, result_count, latency_ms, request_source,
           client_ip, user_agent, auth_client_id, transport, protocol_era)
         VALUES ('search-docs','q',1,25,'user',$1,'ua1','shared',
                 'streamable_http','modern')`,
        [ip],
      );
    }
    const unlisted = await httpGet(server, "/api/analytics/summary?days=7");
    const listed = await httpGet(
      server,
      "/api/analytics/summary?days=7&shared_client_ids=shared",
    );
    expect(unlisted.status).toBe(200);
    expect(listed.status).toBe(200);
    expect(JSON.parse(unlisted.body).unique_client_count_window).toBe(1);
    const body = JSON.parse(listed.body);
    expect(body.shared_client_ids_applied).toBe(1);
    expect(body.unique_client_count_window).toBe(1);
  });
});
