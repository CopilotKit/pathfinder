import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import http from "node:http";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return {
    ...actual,
    getConfig: vi.fn(() => ({
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
      p2pTelemetryUrl: undefined,
      p2pTelemetryDisabled: false,
      packageVersion: "test",
      slackWebhookUrl: "",
    })),
    // Admin ops now reuse the shared admin-access bearer token
    // (ANALYTICS_TOKEN) via bearerTokenAuth. Mock getAnalyticsConfig so the
    // shared auth resolves a token. requireAnalyticsEnabled is false for the
    // admin surface, so the `enabled` flag does not gate access.
    getAnalyticsConfig: vi.fn(() => ({
      enabled: true,
      log_queries: true,
      retention_days: 90,
      token: ADMIN_TOKEN,
    })),
    // Source validation for the reindex op reads getServerConfig().sources.
    getServerConfig: vi.fn(() => ({
      server: { name: "test-server" },
      sources: [{ type: "code", name: "code", repo: "https://x/y" }],
      tools: [],
    })),
  };
});

import { getAnalyticsConfig } from "../config.js";
import type { IndexStats } from "../db/queries.js";
import {
  __setAtlasOrchestratorForTesting,
  __resetAnalyticsTokenForTesting,
  registerAdminOpsRoutes,
} from "../server.js";

const ADMIN_TOKEN = "test-admin-token-1234567890";
const mockGetAnalyticsConfig = vi.mocked(getAnalyticsConfig);

function request(
  server: http.Server,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const address = server.address();
    if (!address || typeof address === "string") {
      reject(new Error("server is not listening on a TCP port"));
      return;
    }
    const body =
      opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        path,
        method,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(body
            ? { "Content-Length": Buffer.byteLength(body).toString() }
            : {}),
          ...opts.headers,
        },
      },
      (res) => {
        let responseBody = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          responseBody += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: responseBody });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function startServer(): Promise<http.Server> {
  const app = express();
  app.use(express.json());
  registerAdminOpsRoutes(app);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return server;
}

async function closeServer(s: http.Server | undefined): Promise<void> {
  if (!s || !s.listening) return;
  await new Promise<void>((resolve, reject) => {
    s.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("admin ops control surface", () => {
  let server: http.Server | undefined;
  const prevAnalyticsTokenEnv = process.env.ANALYTICS_TOKEN;

  beforeEach(() => {
    // The shared admin-access token resolves from analytics config (or the
    // ANALYTICS_TOKEN env var). Clear the env so the mocked config is the
    // sole token source and reset the cached auto-generated token.
    delete process.env.ANALYTICS_TOKEN;
    mockGetAnalyticsConfig.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
      token: ADMIN_TOKEN,
    });
    __resetAnalyticsTokenForTesting();
    __setAtlasOrchestratorForTesting(null);
  });

  afterEach(async () => {
    await closeServer(server);
    server = undefined;
    __setAtlasOrchestratorForTesting(null);
    __resetAnalyticsTokenForTesting();
    if (prevAnalyticsTokenEnv === undefined) delete process.env.ANALYTICS_TOKEN;
    else process.env.ANALYTICS_TOKEN = prevAnalyticsTokenEnv;
    vi.restoreAllMocks();
  });

  it("returns 503 (fail-closed) when no admin-access token is configured", async () => {
    // No analytics.token, no ANALYTICS_TOKEN env, analytics not enabled → the
    // shared auth cannot resolve a token and fails closed with 503.
    mockGetAnalyticsConfig.mockReturnValue({
      enabled: false,
      log_queries: false,
      retention_days: 90,
    });
    __resetAnalyticsTokenForTesting();
    server = await startServer();
    const res = await request(server, "POST", "/admin/index-stats", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: {},
    });
    expect(res.status).toBe(503);
  });

  it("returns 401 on a missing Authorization header when enabled", async () => {
    server = await startServer();
    const res = await request(server, "POST", "/admin/index-stats", {
      body: {},
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 on an invalid token when enabled", async () => {
    server = await startServer();
    const res = await request(server, "POST", "/admin/index-stats", {
      headers: { Authorization: "Bearer wrong-token-of-some-other-length" },
      body: {},
    });
    expect(res.status).toBe(401);
  });

  it("dispatches reindex {scope:full} → queueFullReindex()", async () => {
    const queueFullReindex = vi.fn();
    const queueSourceReindex = vi.fn();
    const queueIncrementalReindex = vi.fn();
    __setAtlasOrchestratorForTesting({
      queueFullReindex,
      queueSourceReindex,
      queueIncrementalReindex,
    });
    server = await startServer();

    const res = await request(server, "POST", "/admin/reindex", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: { scope: "full" },
    });
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toMatchObject({ queued: "full" });
    expect(queueFullReindex).toHaveBeenCalledTimes(1);
    expect(queueSourceReindex).not.toHaveBeenCalled();
    expect(queueIncrementalReindex).not.toHaveBeenCalled();
  });

  it("dispatches reindex {scope:source, source} → queueSourceReindex(name)", async () => {
    const queueSourceReindex = vi.fn();
    __setAtlasOrchestratorForTesting({
      queueFullReindex: vi.fn(),
      queueSourceReindex,
      queueIncrementalReindex: vi.fn(),
    });
    server = await startServer();

    const res = await request(server, "POST", "/admin/reindex", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: { scope: "source", source: "code" },
    });
    expect(res.status).toBe(202);
    expect(queueSourceReindex).toHaveBeenCalledWith("code");
  });

  it("dispatches reindex {scope:repo, repo} → queueIncrementalReindex(url)", async () => {
    const queueIncrementalReindex = vi.fn();
    __setAtlasOrchestratorForTesting({
      queueFullReindex: vi.fn(),
      queueSourceReindex: vi.fn(),
      queueIncrementalReindex,
    });
    server = await startServer();

    // Use the repo configured in the getServerConfig mock above.
    const res = await request(server, "POST", "/admin/reindex", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: { scope: "repo", repo: "https://x/y" },
    });
    expect(res.status).toBe(202);
    expect(queueIncrementalReindex).toHaveBeenCalledWith("https://x/y");
  });

  it("returns 400 unknown_source when reindex scope=source names an unconfigured source", async () => {
    const queueSourceReindex = vi.fn();
    __setAtlasOrchestratorForTesting({
      queueFullReindex: vi.fn(),
      queueSourceReindex,
      queueIncrementalReindex: vi.fn(),
    });
    server = await startServer();

    const res = await request(server, "POST", "/admin/reindex", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: { scope: "source", source: "does-not-exist" },
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: "unknown_source" });
    expect(queueSourceReindex).not.toHaveBeenCalled();
  });

  it("returns 400 unknown_repo when reindex scope=repo names an unconfigured repo", async () => {
    const queueIncrementalReindex = vi.fn();
    __setAtlasOrchestratorForTesting({
      queueFullReindex: vi.fn(),
      queueSourceReindex: vi.fn(),
      queueIncrementalReindex,
    });
    server = await startServer();

    const res = await request(server, "POST", "/admin/reindex", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: { scope: "repo", repo: "https://github.com/foo/bar" },
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: "unknown_repo" });
    expect(queueIncrementalReindex).not.toHaveBeenCalled();
  });

  it("returns 500 admin_op_failed without leaking err.message when an op handler throws", async () => {
    // Force the reindex handler to throw by injecting an orchestrator whose
    // queueFullReindex throws with a sensitive-looking message.
    __setAtlasOrchestratorForTesting({
      queueFullReindex: () => {
        throw new Error("postgres://secret:pw@db:5432/leak");
      },
      queueSourceReindex: vi.fn(),
      queueIncrementalReindex: vi.fn(),
    });
    server = await startServer();

    const res = await request(server, "POST", "/admin/reindex", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: { scope: "full" },
    });
    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("admin_op_failed");
    expect(res.body).not.toContain("postgres://");
    expect(res.body).not.toContain("secret");
  });

  it("returns 400 on a malformed reindex body (missing scope)", async () => {
    server = await startServer();
    const res = await request(server, "POST", "/admin/reindex", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: { nope: true },
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when reindex scope=source but source is missing", async () => {
    __setAtlasOrchestratorForTesting({
      queueFullReindex: vi.fn(),
      queueSourceReindex: vi.fn(),
      queueIncrementalReindex: vi.fn(),
    });
    server = await startServer();
    const res = await request(server, "POST", "/admin/reindex", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: { scope: "source" },
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 on an unknown op", async () => {
    server = await startServer();
    const res = await request(server, "POST", "/admin/does-not-exist", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: {},
    });
    expect(res.status).toBe(404);
  });

  it("index-stats returns 503 index_unavailable without leaking DB detail when getIndexStats throws", async () => {
    // Deterministically exercise the failure path by injecting a getIndexStats
    // that throws with a sensitive-looking message. The response must be the
    // sanitized shape and must not echo the underlying error.
    const app = express();
    app.use(express.json());
    registerAdminOpsRoutes(app, {
      getIndexStats: async () => {
        throw new Error("postgres://secret:pw@db:5432/internal");
      },
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));

    const res = await request(server, "POST", "/admin/index-stats", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: {},
    });
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: "index_unavailable" });
    expect(res.body).not.toContain("postgres://");
    expect(res.body).not.toContain("secret");
  });

  it("index-stats returns the expected shape with injected stats", async () => {
    const app = express();
    app.use(express.json());
    const stats: IndexStats = {
      totalChunks: 42,
      bySource: [{ source_name: "code", count: 42 }],
      indexedRepos: 1,
      indexStates: [
        {
          source_type: "github",
          source_key: "code",
          status: "idle",
          last_indexed_at: new Date("2026-01-01T00:00:00.000Z"),
          last_commit_sha: "abcdef1234567890",
          error_message: null,
        },
      ],
    };
    registerAdminOpsRoutes(app, {
      getIndexStats: async () => stats,
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));

    const res = await request(server, "POST", "/admin/index-stats", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: {},
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total_chunks).toBe(42);
    expect(body.sources).toEqual([
      {
        type: "github",
        key: "code",
        status: "idle",
        last_indexed: "2026-01-01T00:00:00.000Z",
        commit: "abcdef12",
        error: null,
      },
    ]);
  });
});
