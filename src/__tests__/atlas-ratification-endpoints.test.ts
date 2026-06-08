import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import express from "express";
import http from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { __setPoolForTesting, __resetPoolForTesting } from "../db/client.js";
import { generatePostSchemaMigration } from "../db/schema.js";
import {
  approveAtlasSeedEntry,
  upsertAtlasSeedCandidate,
} from "../db/atlas.js";
import { AtlasDataProvider } from "../indexing/providers/atlas.js";
import type { AtlasSourceConfig } from "../types.js";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return {
    ...actual,
    getAnalyticsConfig: vi.fn(),
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
  };
});

import { getAnalyticsConfig, getConfig } from "../config.js";
import {
  __setAtlasOrchestratorForTesting,
  __resetAnalyticsTokenForTesting,
  registerAtlasRatificationRoutes,
} from "../server.js";

const mockGetAnalyticsConfig = vi.mocked(getAnalyticsConfig);
const mockGetConfig = vi.mocked(getConfig);
const ATLAS_DDL_MARKER = "-- Atlas durable seed knowledge.";
const DEFAULT_TEST_CONFIG = {
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
};

function extractAtlasDdl(): string {
  const sql = generatePostSchemaMigration();
  const idx = sql.indexOf(ATLAS_DDL_MARKER);
  if (idx < 0) {
    throw new Error(`Could not locate "${ATLAS_DDL_MARKER}" in schema SQL`);
  }
  return sql.slice(idx);
}

function poolFromPglite(db: PGlite) {
  return {
    query: (text: string, params?: unknown[]) => db.query(text, params),
    connect: async () => ({
      query: (text: string, params?: unknown[]) => db.query(text, params),
      release: () => {},
    }),
    end: async () => db.close(),
  };
}

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
  registerAtlasRatificationRoutes(app);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return server;
}

async function closeServer(
  serverToClose: http.Server | undefined,
): Promise<void> {
  if (!serverToClose || !serverToClose.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    serverToClose.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
const atlasConfig: AtlasSourceConfig = {
  type: "atlas",
  name: "atlas",
  chunk: { target_tokens: 500 },
  cache_namespace: "default",
};

describe("Atlas ratification endpoints", () => {
  let db: PGlite;
  let server: http.Server | undefined;

  beforeAll(async () => {
    db = new PGlite();
    await db.waitReady;
    await db.exec(extractAtlasDdl());
    __setPoolForTesting(poolFromPglite(db));
  });

  afterAll(async () => {
    await closeServer(server);
    server = undefined;
    __setAtlasOrchestratorForTesting(null);
    __resetPoolForTesting();
    await db.close();
  });

  beforeEach(async () => {
    await closeServer(server);
    server = undefined;
    __setAtlasOrchestratorForTesting(null);
    mockGetAnalyticsConfig.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
      token: "secret",
    });
    mockGetConfig.mockReturnValue(DEFAULT_TEST_CONFIG);
    __resetAnalyticsTokenForTesting();
    await db.query("DELETE FROM atlas_cache_pages");
    await db.query("DELETE FROM atlas_seed_entries");
  });
  it("requires auth before returning pending seed candidates", async () => {
    await upsertAtlasSeedCandidate({
      canonicalKey: "runtime:why",
      sourceName: "atlas",
      title: "Runtime why",
      content: "Pending rationale",
      provenance: {},
      evidence: [],
    });
    server = await startServer();

    const unauthorized = await request(server, "GET", "/api/atlas/candidates");
    expect(unauthorized.status).toBe(401);

    const authorized = await request(server, "GET", "/api/atlas/candidates", {
      headers: { Authorization: "Bearer secret" },
    });
    expect(authorized.status).toBe(200);
    const body = JSON.parse(authorized.body);
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]).toMatchObject({
      canonicalKey: "runtime:why",
      sourceName: "atlas",
      status: "pending",
    });
  });

  it("uses bearer auth even when analytics is disabled", async () => {
    mockGetAnalyticsConfig.mockReturnValue({
      enabled: false,
      log_queries: false,
      retention_days: 90,
      token: "secret",
    });
    await upsertAtlasSeedCandidate({
      canonicalKey: "runtime:analytics-disabled",
      sourceName: "atlas",
      title: "Analytics disabled",
      content: "Pending rationale while analytics is disabled",
      provenance: {},
      evidence: [],
    });
    server = await startServer();

    const unauthorized = await request(server, "GET", "/api/atlas/candidates");
    expect(unauthorized.status).toBe(401);

    const authorized = await request(server, "GET", "/api/atlas/candidates", {
      headers: { Authorization: "Bearer secret" },
    });
    expect(authorized.status).toBe(200);
    expect(JSON.parse(authorized.body).candidates).toHaveLength(1);
  });

  it("returns 503 when root config read fails before auth options are built", async () => {
    mockGetConfig.mockImplementation(() => {
      throw new Error("bad root config");
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    server = await startServer();

    const res = await request(server, "GET", "/api/atlas/candidates", {
      headers: { Authorization: "Bearer secret" },
    });

    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({
      error: "misconfigured",
      error_description: "Atlas ratification config read failed",
    });
    consoleSpy.mockRestore();
  });

  it("accepts opaque slash-bearing canonical keys in the request body", async () => {
    const canonicalKey = "github-pr:atlas:org/repo:42";
    await upsertAtlasSeedCandidate({
      canonicalKey,
      sourceName: "atlas",
      title: "Slash key",
      content: "Candidate with a slash-bearing key",
      provenance: {},
      evidence: [],
    });
    server = await startServer();

    const approved = await request(
      server,
      "POST",
      "/api/atlas/candidates/approve",
      {
        headers: {
          Authorization: "Bearer secret",
          "X-Atlas-Actor": "reviewer@example.test",
        },
        body: { canonicalKey },
      },
    );

    expect(approved.status).toBe(200);
    expect(JSON.parse(approved.body).candidate).toMatchObject({
      canonicalKey,
      status: "approved",
      approvedBy: "reviewer@example.test",
    });
  });

  it("approves without an orchestrator: logs loudly and reports reindexQueued:false", async () => {
    await upsertAtlasSeedCandidate({
      canonicalKey: "runtime:approve-no-orchestrator",
      sourceName: "atlas",
      title: "Approve without orchestrator",
      content: "Candidate approved while no orchestrator is wired",
      provenance: {},
      evidence: [],
    });
    __setAtlasOrchestratorForTesting(null);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    server = await startServer();

    const approved = await request(
      server,
      "POST",
      "/api/atlas/candidates/approve",
      {
        headers: {
          Authorization: "Bearer secret",
          "X-Atlas-Actor": "reviewer@example.test",
        },
        body: { canonicalKey: "runtime:approve-no-orchestrator" },
      },
    );

    expect(approved.status).toBe(200);
    const body = JSON.parse(approved.body);
    expect(body.reindexQueued).toBe(false);
    expect(body.candidate).toMatchObject({
      canonicalKey: "runtime:approve-no-orchestrator",
      status: "approved",
    });
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("reindex NOT queued"),
    );
    consoleSpy.mockRestore();
  });

  it("approves and rejects candidates with the authenticated actor", async () => {
    await upsertAtlasSeedCandidate({
      canonicalKey: "runtime:approve",
      sourceName: "atlas",
      title: "Approve me",
      content: "Candidate to approve",
      provenance: {},
      evidence: [],
    });
    await upsertAtlasSeedCandidate({
      canonicalKey: "runtime:reject",
      sourceName: "atlas",
      title: "Reject me",
      content: "Candidate to reject",
      provenance: {},
      evidence: [],
    });
    server = await startServer();

    const approved = await request(
      server,
      "POST",
      "/api/atlas/candidates/approve",
      {
        headers: {
          Authorization: "Bearer secret",
          "X-Atlas-Actor": "reviewer@example.test",
        },
        body: { canonicalKey: "runtime:approve" },
      },
    );
    expect(approved.status).toBe(200);
    expect(JSON.parse(approved.body).candidate).toMatchObject({
      canonicalKey: "runtime:approve",
      status: "approved",
      approvedBy: "reviewer@example.test",
    });

    const rejected = await request(
      server,
      "POST",
      "/api/atlas/candidates/reject",
      {
        headers: {
          Authorization: "Bearer secret",
          "X-Atlas-Actor": "reviewer@example.test",
        },
        body: { canonicalKey: "runtime:reject", reason: "incorrect inference" },
      },
    );
    expect(rejected.status).toBe(200);
    expect(JSON.parse(rejected.body).candidate).toMatchObject({
      canonicalKey: "runtime:reject",
      status: "rejected",
      rejectedBy: "reviewer@example.test",
      rejectionReason: "incorrect inference",
    });
  });

  it("queues the approved candidate source for reindexing", async () => {
    await upsertAtlasSeedCandidate({
      canonicalKey: "runtime:approve-reindex",
      sourceName: "atlas",
      title: "Approve and index",
      content: "Candidate to approve and index",
      provenance: {},
      evidence: [],
    });
    const queueSourceReindex = vi.fn();
    __setAtlasOrchestratorForTesting({
      queueFullReindex: vi.fn(),
      queueSourceReindex,
      queueIncrementalReindex: vi.fn(),
    });
    server = await startServer();

    const approved = await request(
      server,
      "POST",
      "/api/atlas/candidates/approve",
      {
        headers: {
          Authorization: "Bearer secret",
          "X-Atlas-Actor": "reviewer@example.test",
        },
        body: { canonicalKey: "runtime:approve-reindex" },
      },
    );

    expect(approved.status).toBe(200);
    expect(queueSourceReindex).toHaveBeenCalledWith("atlas");
  });

  it("keeps rejected candidates out of provider acquisition", async () => {
    await upsertAtlasSeedCandidate({
      canonicalKey: "runtime:approved",
      sourceName: "atlas",
      title: "Approved",
      content: "Approved rationale",
      provenance: {},
      evidence: [],
    });
    await upsertAtlasSeedCandidate({
      canonicalKey: "runtime:rejected",
      sourceName: "atlas",
      title: "Rejected",
      content: "Rejected rationale",
      provenance: {},
      evidence: [],
    });
    await approveAtlasSeedEntry("runtime:approved", "reviewer");
    server = await startServer();

    await request(server, "POST", "/api/atlas/candidates/reject", {
      headers: {
        Authorization: "Bearer secret",
        "X-Atlas-Actor": "reviewer",
      },
      body: { canonicalKey: "runtime:rejected", reason: "bad evidence" },
    });

    const provider = new AtlasDataProvider(atlasConfig, { cloneDir: "/tmp" });
    const result = await provider.fullAcquire();

    expect(result.items.map((item) => item.id)).toEqual([
      "atlas-seed:runtime:approved",
    ]);
  });
});
