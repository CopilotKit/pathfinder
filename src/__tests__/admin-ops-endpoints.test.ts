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
    // Source validation for the reindex op reads getServerConfig().sources.
    getServerConfig: vi.fn(() => ({
      server: { name: "test-server" },
      sources: [{ type: "github", name: "code", repo: "https://x/y" }],
      tools: [],
    })),
  };
});

import {
  __setAtlasOrchestratorForTesting,
  registerAdminOpsRoutes,
} from "../server.js";

const ADMIN_TOKEN = "test-admin-token-1234567890";

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
  const prevToken = process.env.PATHFINDER_ADMIN_TOKEN;

  beforeEach(() => {
    process.env.PATHFINDER_ADMIN_TOKEN = ADMIN_TOKEN;
    __setAtlasOrchestratorForTesting(null);
  });

  afterEach(async () => {
    await closeServer(server);
    server = undefined;
    __setAtlasOrchestratorForTesting(null);
    if (prevToken === undefined) delete process.env.PATHFINDER_ADMIN_TOKEN;
    else process.env.PATHFINDER_ADMIN_TOKEN = prevToken;
    vi.restoreAllMocks();
  });

  it("returns 503 (fail-closed) when PATHFINDER_ADMIN_TOKEN is unset", async () => {
    delete process.env.PATHFINDER_ADMIN_TOKEN;
    server = await startServer();
    const res = await request(server, "POST", "/admin/index-stats", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: {},
    });
    expect(res.status).toBe(503);
  });

  it("returns 503 (fail-closed) when PATHFINDER_ADMIN_TOKEN is empty", async () => {
    process.env.PATHFINDER_ADMIN_TOKEN = "";
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
    } as never);
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
    } as never);
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
    } as never);
    server = await startServer();

    const res = await request(server, "POST", "/admin/reindex", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: { scope: "repo", repo: "https://github.com/foo/bar" },
    });
    expect(res.status).toBe(202);
    expect(queueIncrementalReindex).toHaveBeenCalledWith(
      "https://github.com/foo/bar",
    );
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
    } as never);
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

  it("index-stats returns per-source index state shape", async () => {
    server = await startServer();
    const res = await request(server, "POST", "/admin/index-stats", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: {},
      // getIndexStats hits the DB; inject a fake via the registry deps below.
    });
    // index-stats uses an injectable getIndexStats; default impl reaches the
    // DB which is unavailable here, so it returns 503. The shape assertions
    // are exercised by the injected-deps variant below.
    expect([200, 503]).toContain(res.status);
  });

  it("index-stats returns the expected shape with injected stats", async () => {
    const app = express();
    app.use(express.json());
    registerAdminOpsRoutes(app, {
      getIndexStats: async () => ({
        totalChunks: 42,
        bySource: [{ source_name: "code", count: 42 }],
        indexedRepos: 1,
        indexStates: [
          {
            source_type: "github",
            source_key: "code",
            status: "indexed",
            last_indexed_at: "2026-01-01T00:00:00.000Z",
            last_commit_sha: "abcdef1234567890",
            error_message: null,
          },
        ] as never,
      }),
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
        status: "indexed",
        last_indexed: "2026-01-01T00:00:00.000Z",
        commit: "abcdef12",
        error: null,
      },
    ]);
  });
});
