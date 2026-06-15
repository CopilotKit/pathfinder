// GET /api/search endpoint tests + the atlas-harvest END-TO-END proof.
//
// Two suites:
//
//   1. ROUTE — the live `GET /api/search` lexical RAG-corpus probe the
//      rag-dedup gate (src/atlas/rag-dedup.ts) drives via
//      AtlasHttpClient.search. Auth (the shared ANALYTICS_TOKEN bearer, same
//      as the ratification routes), param validation (text required; limit
//      default/over-max per the parseLimitOrError convention; optional
//      `source` with empty-is-absent), and the exact `{ hits: [...] }` wire
//      shape the client's fail-loud contract expects — including `hits: []`
//      (the key MUST be present) on an empty result.
//
//   2. E2E — the point of the route: the FULL harvest pipeline (runHarvest →
//      aggregate → classify → canonicalize → rag-dedup → validate → upsert)
//      driven against the LIVE server over real HTTP with a REAL
//      AtlasHttpClient. Before this route existed every probe 404'd and the
//      run aborted after MAX_CONSECUTIVE_PROBE_FAILURES (5) — so the suite
//      seeds ≥5 fragments to prove the live route prevents exactly that
//      abort, asserts the overlapping candidate carries the
//      `rag-corpus-overlap:` annotation (validated_against + fused_from
//      evidence), and that all rows landed as `pending` atlas_seed_entries.
//
// Harness mirrors atlas-ratification-endpoints.test.ts (PGlite +
// __setPoolForTesting; raw http.request; bearer auth via mocked
// getAnalyticsConfig + __resetAnalyticsTokenForTesting) — extended with the
// `chunks` table (generateSchema needs the PGlite vector extension; tsv is
// set explicitly on insert because PGlite skips the PL/pgSQL trigger).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { vector } from "@electric-sql/pglite/vector";
import pgvector from "pgvector";
import { __setPoolForTesting, __resetPoolForTesting } from "../db/client.js";
import { generateSchema, generatePostSchemaMigration } from "../db/schema.js";
import { listPendingAtlasSeedCandidates } from "../db/atlas.js";
import { AtlasHttpClient } from "../atlas/client.js";
import { runHarvest } from "../atlas/harvest-cli.js";
import { RAG_CORPUS_OVERLAP_REF_PREFIX } from "../atlas/canonicalize.js";
import type { CandidateFragment } from "../atlas/types.js";
import type { ValidationContext } from "../atlas/validate.js";

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
      oauthConsentHmacKeys: ["a".repeat(64)],
      p2pTelemetryUrl: undefined,
      p2pTelemetryDisabled: false,
      packageVersion: "test",
      slackWebhookUrl: "",
    })),
  };
});

import { getAnalyticsConfig, getConfig } from "../config.js";
import {
  __resetAnalyticsTokenForTesting,
  registerAtlasRatificationRoutes,
} from "../server.js";

const mockGetAnalyticsConfig = vi.mocked(getAnalyticsConfig);
const mockGetConfig = vi.mocked(getConfig);
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
  oauthConsentHmacKeys: ["a".repeat(64)],
  p2pTelemetryUrl: undefined,
  p2pTelemetryDisabled: false,
  packageVersion: "test",
  slackWebhookUrl: "",
};

// Tiny embedding dimension — the search under test is LEXICAL (tsvector);
// the vector column only needs to satisfy the NOT NULL schema constraint.
const TEST_EMBEDDING_DIMS = 3;

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

// Full schema (chunks + atlas tables): the chunks table needs the vector
// extension; the tsv trigger is PL/pgSQL and intentionally NOT applied —
// inserts below set tsv explicitly (mirroring INSERT_CHUNK_SQL's derivation).
async function newSearchTestDb(): Promise<PGlite> {
  const db = new PGlite({ extensions: { vector } });
  await db.waitReady;
  await db.exec(generateSchema(TEST_EMBEDDING_DIMS));
  await db.exec(generatePostSchemaMigration());
  return db;
}

interface TestChunk {
  source_name: string;
  source_url?: string | null;
  title?: string | null;
  content: string;
  file_path: string;
  chunk_index?: number;
}

async function insertChunk(db: PGlite, chunk: TestChunk): Promise<void> {
  await db.query(
    `INSERT INTO chunks
         (source_name, source_url, title, content, embedding, repo_url,
          file_path, chunk_index, tsv)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_tsvector('english', $4))`,
    [
      chunk.source_name,
      chunk.source_url ?? null,
      chunk.title ?? null,
      chunk.content,
      pgvector.toSql(new Array(TEST_EMBEDDING_DIMS).fill(0)),
      null,
      chunk.file_path,
      chunk.chunk_index ?? 0,
    ],
  );
}

function request(
  server: http.Server,
  method: string,
  path_: string,
  opts: { headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const address = server.address();
    if (!address || typeof address === "string") {
      reject(new Error("server is not listening on a TCP port"));
      return;
    }
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        path: path_,
        method,
        headers: { ...opts.headers },
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

function authHeaders(): Record<string, string> {
  return { Authorization: "Bearer secret" };
}

function searchPath(params: Record<string, string>): string {
  const qs = new URLSearchParams(params).toString();
  return `/api/search${qs ? `?${qs}` : ""}`;
}

describe("GET /api/search endpoint", () => {
  let db: PGlite;
  let server: http.Server | undefined;

  beforeAll(async () => {
    db = await newSearchTestDb();
    __setPoolForTesting(poolFromPglite(db));
  });

  afterAll(async () => {
    await closeServer(server);
    server = undefined;
    __resetPoolForTesting();
    await db.close();
  });

  beforeEach(async () => {
    await closeServer(server);
    server = undefined;
    mockGetAnalyticsConfig.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
      token: "secret",
    });
    mockGetConfig.mockReturnValue(DEFAULT_TEST_CONFIG);
    __resetAnalyticsTokenForTesting();
    await db.query("DELETE FROM chunks");
  });

  it("401s a request with no bearer token", async () => {
    server = await startServer();
    const res = await request(server, "GET", searchPath({ text: "anything" }));
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ error: "unauthorized" });
  });

  it("401s a request with a wrong bearer token", async () => {
    server = await startServer();
    const res = await request(server, "GET", searchPath({ text: "anything" }), {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ error: "unauthorized" });
  });

  it("401s a same-length wrong bearer token (timingSafeEqual branch)", async () => {
    // "secreX" is 6 bytes like the configured "secret" — this passes the
    // length-mismatch shortcut and exercises the timingSafeEqual comparison
    // itself, which the wrong-token test above (11 bytes) never reaches.
    server = await startServer();
    const res = await request(server, "GET", searchPath({ text: "anything" }), {
      headers: { Authorization: "Bearer secreX" },
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ error: "unauthorized" });
  });

  it("400s when text is missing", async () => {
    server = await startServer();
    const res = await request(server, "GET", "/api/search", {
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      error: "atlas_search_text_required",
      error_description: "text is required",
    });
  });

  it("400s when text is empty/whitespace-only", async () => {
    server = await startServer();
    const res = await request(server, "GET", searchPath({ text: "   " }), {
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({
      error: "atlas_search_text_required",
    });
  });

  it("400s an over-max limit per the parseLimitOrError convention", async () => {
    server = await startServer();
    const res = await request(
      server,
      "GET",
      searchPath({ text: "anything", limit: "201" }),
      { headers: authHeaders() },
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({
      error: "invalid_request",
      error_description: "limit must be <= 200",
    });
  });

  it("400s a non-numeric limit", async () => {
    server = await startServer();
    const res = await request(
      server,
      "GET",
      searchPath({ text: "anything", limit: "abc" }),
      { headers: authHeaders() },
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: "invalid_request" });
  });

  it("accepts the boundary limit=200 and rejects limit=0", async () => {
    server = await startServer();

    const atMax = await request(
      server,
      "GET",
      searchPath({ text: "anything", limit: "200" }),
      { headers: authHeaders() },
    );
    expect(atMax.status).toBe(200);
    expect(JSON.parse(atMax.body)).toEqual({ hits: [] });

    const zero = await request(
      server,
      "GET",
      searchPath({ text: "anything", limit: "0" }),
      { headers: authHeaders() },
    );
    expect(zero.status).toBe(400);
    expect(JSON.parse(zero.body)).toMatchObject({
      error: "invalid_request",
      error_description: "limit must be > 0",
    });
  });

  // Duplicated query params: Express parses `?source=a&source=b` as an array.
  // The route must reject the non-string shape with the module's rejectArray
  // envelope instead of silently dropping the filter (wrong results) or
  // misdescribing the request as missing `text`. Note searchPath/URLSearchParams
  // cannot produce a duplicated key — these use literal paths.
  it("400s an array-shaped source param instead of silently dropping the filter", async () => {
    await insertChunk(db, {
      source_name: "docs",
      source_url: "https://example.test/docs-page",
      title: "Docs page",
      content: "The runtime drains the tool queue before the terminal message.",
      file_path: "docs/runtime.md",
    });
    await insertChunk(db, {
      source_name: "code",
      source_url: "https://example.test/code-page",
      title: "Code page",
      content: "The runtime drains the tool queue before the terminal message.",
      file_path: "src/runtime.ts",
    });
    server = await startServer();
    const res = await request(
      server,
      "GET",
      "/api/search?text=runtime&source=docs&source=code",
      { headers: authHeaders() },
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({
      error: "invalid_request",
      error_description: "source must be a single string value",
    });
  });

  it("400s an array-shaped text param with the must-be-single-string envelope", async () => {
    server = await startServer();
    const res = await request(server, "GET", "/api/search?text=a&text=b", {
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({
      error: "invalid_request",
      error_description: "text must be a single string value",
    });
  });

  it("400s an array-shaped limit param (parsePositiveIntParam pin)", async () => {
    server = await startServer();
    const res = await request(
      server,
      "GET",
      "/api/search?text=a&limit=1&limit=2",
      { headers: authHeaders() },
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({
      error: "invalid_request",
      error_description: "limit must be a string",
    });
  });

  it("applies an explicit limit and defaults when absent", async () => {
    // Seed MORE matching rows than the default limit so the default is
    // pinned exactly: 51 matches must come back as exactly 50 hits (any
    // smaller seed would pass for ANY default ≥ seed size).
    for (let i = 0; i < 51; i++) {
      await insertChunk(db, {
        source_name: "docs",
        source_url: `https://example.test/doc-${i}`,
        title: `Drain doc ${i}`,
        content:
          "The runtime drains the tool queue before the terminal message.",
        file_path: `docs/drain-${i}.md`,
      });
    }
    server = await startServer();

    // No limit → the parseLimitOrError default of exactly 50.
    const all = await request(
      server,
      "GET",
      searchPath({ text: "runtime drains the tool queue" }),
      { headers: authHeaders() },
    );
    expect(all.status).toBe(200);
    expect(JSON.parse(all.body).hits).toHaveLength(50);

    // Explicit limit caps the result set.
    const limited = await request(
      server,
      "GET",
      searchPath({ text: "runtime drains the tool queue", limit: "2" }),
      { headers: authHeaders() },
    );
    expect(limited.status).toBe(200);
    expect(JSON.parse(limited.body).hits).toHaveLength(2);
  });

  it("returns the exact hit shape, including null sourceUrl/title", async () => {
    await insertChunk(db, {
      source_name: "docs",
      source_url: null,
      title: null,
      content: "Webhook deliveries are recorded with a decision and reason.",
      file_path: "docs/webhooks.md",
    });
    server = await startServer();

    const res = await request(
      server,
      "GET",
      searchPath({ text: "webhook deliveries recorded decision" }),
      { headers: authHeaders() },
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.hits)).toBe(true);
    expect(body.hits).toHaveLength(1);
    // EXACT shape — the client contract fields and nothing extra.
    expect(body.hits[0]).toEqual({
      id: expect.any(Number),
      content: "Webhook deliveries are recorded with a decision and reason.",
      sourceUrl: null,
      title: null,
      sourceName: "docs",
      score: expect.any(Number),
    });
  });

  it("filters by source, and an empty source param counts as absent", async () => {
    await insertChunk(db, {
      source_name: "docs",
      source_url: "https://example.test/docs-page",
      title: "Docs page",
      content: "Reindexing diffs the state token to reindex incrementally.",
      file_path: "docs/reindex.md",
    });
    await insertChunk(db, {
      source_name: "code",
      source_url: "https://example.test/code-page",
      title: "Code page",
      content: "Reindexing diffs the state token to reindex incrementally.",
      file_path: "src/reindex.ts",
    });
    server = await startServer();

    const filtered = await request(
      server,
      "GET",
      searchPath({ text: "reindexing diffs the state token", source: "docs" }),
      { headers: authHeaders() },
    );
    expect(filtered.status).toBe(200);
    const filteredHits = JSON.parse(filtered.body).hits;
    expect(filteredHits).toHaveLength(1);
    expect(filteredHits[0].sourceName).toBe("docs");

    // Empty source = absent (the module's empty-is-absent rule) → both hits.
    const unfiltered = await request(
      server,
      "GET",
      searchPath({ text: "reindexing diffs the state token", source: "" }),
      { headers: authHeaders() },
    );
    expect(unfiltered.status).toBe(200);
    expect(JSON.parse(unfiltered.body).hits).toHaveLength(2);
  });

  it("500s with the probe-failure envelope when the DB query throws", async () => {
    server = await startServer();
    // Swap in a pool whose query always throws; the route's catch is the
    // client's probe-failure semantics (counts toward the fail-fast streak).
    __setPoolForTesting({
      query: () => {
        throw new Error("boom");
      },
      connect: async () => ({
        query: () => {
          throw new Error("boom");
        },
        release: () => {},
      }),
      end: async () => {},
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await request(
        server,
        "GET",
        searchPath({ text: "anything" }),
        { headers: authHeaders() },
      );
      expect(res.status).toBe(500);
      // 500s in this module carry `error` only — no error_description (the
      // {error, error_description} pair is the 400/409/503 convention).
      expect(JSON.parse(res.body)).toEqual({
        error: "Failed to search atlas corpus",
      });
    } finally {
      errSpy.mockRestore();
      // Restore the real PGlite-backed pool for the rest of the suite.
      __setPoolForTesting(poolFromPglite(db));
    }
  });

  it("returns { hits: [] } (key PRESENT) when nothing matches", async () => {
    server = await startServer();
    const res = await request(
      server,
      "GET",
      searchPath({ text: "zyzzogeton absolutely unmatched phrase" }),
      { headers: authHeaders() },
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    // The client fail-louds on a 200 without a `hits` array — the key must be
    // an explicit empty array, never missing.
    expect(body).toEqual({ hits: [] });
  });
});

// ── E2E: full harvest pipeline against the LIVE server ─────────────────────────

// Fragment fixture mirroring atlas-harvest-cli.test.ts — distinct
// subsystem/claimSlugHint per fragment so canonicalize emits one candidate
// per fragment (no fusion). Every body is long enough to clear rag-dedup's
// MIN_CANDIDATE_TOKENS floor so EVERY candidate actually probes the route.
function fragment(over: Partial<CandidateFragment> = {}): CandidateFragment {
  return {
    sourcetype: "github-pr",
    subsystem: "runtime",
    claimSlugHint: "tools-before-stream",
    source_name: "atlas",
    repo_url: "https://github.com/CopilotKit/pathfinder",
    ref: "main",
    title: "Runtime drains the tool queue before the terminal message",
    content:
      "The runtime drains the tool queue before emitting the terminal " +
      "assistant message so partial tool state never leaks to the client.",
    provenance: {
      source: "github-pr",
      url: "https://github.com/CopilotKit/pathfinder/pull/42",
      date: "2026-06-01",
      classification: {
        sensitivity: "public",
        knowledge_type: "operational",
        audience: "all-staff",
        validation_status: "unverified",
        confidence: "high",
        provenance_class: "primary",
        freshness: { as_of: "2026-06-01" },
      },
    },
    evidence: [{ kind: "changed_file", path: "src/runtime/stream.ts" }],
    needsReview: false,
    validationTargets: [],
    ...over,
  };
}

function seedRunDir(
  runsDir: string,
  runId: string,
  fragments: CandidateFragment[],
): void {
  const dir = path.join(runsDir, runId, "fragments");
  fs.mkdirSync(dir, { recursive: true });
  fragments.forEach((f, i) => {
    fs.writeFileSync(
      path.join(dir, `${String(i).padStart(4, "0")}.json`),
      `${JSON.stringify(f, null, 2)}\n`,
      "utf-8",
    );
  });
}

describe("atlas harvest E2E — full pipeline against the live /api/search route", () => {
  let db: PGlite;
  let server: http.Server | undefined;
  let runsDir: string;
  let checkoutDir: string;

  // The candidate the seeded corpus chunk verbatim-overlaps. The chunk body
  // below is a SUPERSET of `${title}\n${content}` so token containment is
  // ~1.0 (≥ the 0.8 default) AND plainto_tsquery's AND-of-lexemes matches.
  const OVERLAP_TITLE =
    "Runtime drains the tool queue before the terminal message";
  const OVERLAP_CONTENT =
    "The runtime drains the tool queue before emitting the terminal " +
    "assistant message so partial tool state never leaks to the client.";
  const OVERLAP_CHUNK_URL = "https://example.test/corpus/runtime-drain";

  beforeAll(async () => {
    db = await newSearchTestDb();
    __setPoolForTesting(poolFromPglite(db));
    runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-search-e2e-runs-"));
    checkoutDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "atlas-search-e2e-co-"),
    );
  });

  afterAll(async () => {
    await closeServer(server);
    server = undefined;
    __resetPoolForTesting();
    await db.close();
    fs.rmSync(runsDir, { recursive: true, force: true });
    fs.rmSync(checkoutDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await closeServer(server);
    server = undefined;
    mockGetAnalyticsConfig.mockReturnValue({
      enabled: true,
      log_queries: true,
      retention_days: 90,
      token: "secret",
    });
    mockGetConfig.mockReturnValue(DEFAULT_TEST_CONFIG);
    __resetAnalyticsTokenForTesting();
    await db.query("DELETE FROM chunks");
    await db.query("DELETE FROM atlas_seed_entries");
  });

  it("runs end-to-end: ≥5 candidates probe the live route (no fail-fast abort), the overlap is annotated, rows land pending", async () => {
    // (b) Corpus: one chunk verbatim-overlapping the first candidate, plus a
    // non-overlapping chunk so the corpus is not a single-row toy.
    await insertChunk(db, {
      source_name: "docs",
      source_url: OVERLAP_CHUNK_URL,
      title: "Runtime streaming order",
      content: `${OVERLAP_TITLE}. ${OVERLAP_CONTENT} This passage was already indexed by the generic RAG corpus.`,
      file_path: "docs/runtime-streaming.md",
    });
    await insertChunk(db, {
      source_name: "docs",
      source_url: "https://example.test/corpus/unrelated",
      title: "Unrelated corpus passage",
      content:
        "Completely unrelated prose about quarterly accounting exports and " +
        "spreadsheet reconciliation cadence for the finance team.",
      file_path: "docs/unrelated.md",
    });

    // (c) ≥5 fragments → ≥5 distinct canonical candidates. Five matters: with
    // the route absent every probe 404s and rag-dedup aborts at exactly
    // MAX_CONSECUTIVE_PROBE_FAILURES (5) — this corpus proves the live route
    // prevents that abort.
    const runId = "e2e-live-search";
    seedRunDir(runsDir, runId, [
      fragment(), // the overlapping candidate
      fragment({
        subsystem: "indexer",
        claimSlugHint: "incremental-reindex",
        title: "Indexer reindexes only changed sources",
        content:
          "The indexer diffs the persisted state token against the current " +
          "head so only changed sources are reindexed incrementally.",
      }),
      fragment({
        subsystem: "server",
        claimSlugHint: "bearer-auth-shared",
        title: "Privileged surfaces share one bearer token",
        content:
          "Analytics, atlas ratification, and admin ops all authenticate " +
          "with the same configured analytics bearer token on the server.",
      }),
      fragment({
        subsystem: "client",
        claimSlugHint: "fail-loud-hits",
        title: "The atlas client fails loud on a malformed search body",
        content:
          "A two hundred response without a hits array means the probe " +
          "endpoint is broken or misrouted, so the client throws loudly.",
      }),
      fragment({
        subsystem: "db",
        claimSlugHint: "lexical-tsvector-search",
        title: "Text search ranks chunks with tsvector relevance",
        content:
          "Full text keyword search uses plainto tsquery parsing and ranks " +
          "matching chunk rows by term frequency relevance scores.",
      }),
    ]);

    // (a)+(d) Boot the live server and drive the FULL pipeline over real HTTP
    // with a REAL AtlasHttpClient — the same client/probe production uses.
    server = await startServer();
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server is not listening on a TCP port");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const validationContext: ValidationContext = {
      checkoutDir,
      featureRegistry: { categories: [] },
    };

    // Spy on console.error across the run: rag-dedup SWALLOWS per-candidate
    // probe failures ("[rag-dedup] search probe failed for candidate ...;
    // passing through un-annotated") and a swallowed failure also passes the
    // not-annotated assertions below. With 1 proven success the consecutive-
    // failure streak resets, so ≤4 swallowed failures would otherwise be
    // indistinguishable from 5 successes — assert zero such lines. The regex
    // guard covers the PROBE-stage swallow only; an "overlap annotation
    // failed for candidate ..." swallow is NOT matched here (it is indirectly
    // covered by the validated_against assertion on the overlapping candidate).
    const errSpy = vi.spyOn(console, "error");
    let probeFailureLines: unknown[][] = [];
    const result = await runHarvest({
      runId,
      runsDir,
      upsert: true,
      ragClient: new AtlasHttpClient({ baseUrl, token: "secret" }),
      validationContext,
    }).finally(() => {
      // Capture-then-restore even if the run throws — mockRestore CLEARS
      // mock.calls, so the lines must be snapshotted before restoring.
      probeFailureLines = errSpy.mock.calls.filter(
        (call) =>
          typeof call[0] === "string" &&
          /\[rag-dedup\] search probe failed/.test(call[0]),
      );
      errSpy.mockRestore();
    });
    expect(probeFailureLines).toEqual([]);

    // (e) The run COMPLETED — no consecutive-probe-failure abort — and every
    // fragment flowed through to an upserted candidate.
    expect(result.fragmentCount).toBe(5);
    expect(result.candidateCount).toBe(5);
    expect(result.upsertedCount).toBe(5);

    const pending = await listPendingAtlasSeedCandidates();
    expect(pending).toHaveLength(5);
    // listPendingAtlasSeedCandidates already filters status = 'pending', so
    // asserting on the returned rows' status is tautological — count the
    // pending rows directly in the DB instead.
    const pendingCount = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM atlas_seed_entries WHERE status = 'pending'",
    );
    expect(pendingCount.rows[0].n).toBe(5);

    // The overlapping candidate carries the rag-corpus-overlap annotation in
    // BOTH provenance.validated_against and the fused_from evidence ref,
    // pointing at the seeded corpus chunk's source_url.
    const overlapping = pending.find(
      (p) => p.canonicalKey === "github-pr:runtime:tools-before-stream",
    );
    expect(overlapping).toBeDefined();
    const marker = `${RAG_CORPUS_OVERLAP_REF_PREFIX}${OVERLAP_CHUNK_URL}`;
    const provenance = overlapping!.provenance as {
      validated_against?: string;
    };
    expect(provenance.validated_against).toContain(marker);
    const evidence = overlapping!.evidence as Array<{
      kind?: string;
      ref?: string;
    }>;
    expect(evidence).toContainEqual({ kind: "fused_from", ref: marker });

    // The four non-overlapping candidates are NOT annotated (their probes
    // succeeded with no verbatim corpus hit — successes, not swallowed 404s).
    for (const row of pending) {
      if (row.canonicalKey === "github-pr:runtime:tools-before-stream") {
        continue;
      }
      const prov = row.provenance as { validated_against?: string };
      expect(prov.validated_against ?? "").not.toContain(
        RAG_CORPUS_OVERLAP_REF_PREFIX,
      );
    }
  });
});
