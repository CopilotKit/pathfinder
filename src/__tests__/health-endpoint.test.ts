import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "node:http";

// Mock config so hasSearchTools() returns true (exercising the DB code path).
vi.mock("../config.js", () => ({
  getServerConfig: vi.fn().mockReturnValue({
    server: { name: "test-server" },
  }),
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
  // Force the /health handler down the DB-probing branch so we exercise
  // the 503 error-response code path.
  hasSearchTools: vi.fn().mockReturnValue(true),
  hasKnowledgeTools: vi.fn().mockReturnValue(false),
  hasCollectTools: vi.fn().mockReturnValue(false),
  hasBashSemanticSearch: vi.fn().mockReturnValue(false),
}));

import { registerHealthRoute } from "../server.js";

// The exact sensitive message a failing DB driver might produce. The /health
// 503 body must NOT expose any of the substrings asserted below.
const SENSITIVE_MESSAGE =
  "connection to database failed: postgresql://user:secret@10.0.0.5:5432/db";

// ---------------------------------------------------------------------------
// Helper: make HTTP requests to the test server (same pattern as
// analytics-server.test.ts — we intentionally don't pull in supertest).
// ---------------------------------------------------------------------------

function request(
  server: http.Server,
  method: string,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      { hostname: "127.0.0.1", port: addr.port, path, method },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("GET /health — 503 body must not leak DB error details", () => {
  let server: http.Server;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // /health logs the full error server-side. Swallow it so failing-path
    // tests don't pollute test output — we assert separately that it IS
    // logged (so operators still get the detail).
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleErrorSpy.mockRestore();
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  function startApp(
    getIndexStats: () => Promise<unknown>,
  ): Promise<void> {
    return new Promise((resolve) => {
      const app = express();
      registerHealthRoute(app, {
        getIndexStats: getIndexStats as never,
      });
      server = app.listen(0, () => resolve());
    });
  }

  it("returns 503 with a sanitized body when the DB health check throws", async () => {
    const err = new Error(SENSITIVE_MESSAGE);
    await startApp(() => Promise.reject(err));

    const res = await request(server, "GET", "/health");

    expect(res.status).toBe(503);

    const body = JSON.parse(res.body);

    // Shape assertions — the sanitized body exposes only these fields.
    expect(body.status).toBe("degraded");
    expect(body.server).toBe("test-server");
    expect(typeof body.uptime_seconds).toBe("number");
    expect(typeof body.started_at).toBe("string");
    expect(body.index).toBe("unavailable");

    // Sensitive-content assertions — verify against the RAW response body
    // (not just the parsed JSON) so we catch leaks in any field, including
    // a stray `error`, `details`, `cause`, stack, etc.
    const rawBody = res.body;
    const forbiddenSubstrings = [
      "postgres", // matches "postgres", "postgresql", "postgres://"
      "password",
      "secret",
      "10.0.0.5",
      "5432",
      SENSITIVE_MESSAGE,
      "connection to database failed",
    ];
    for (const needle of forbiddenSubstrings) {
      expect(
        rawBody.toLowerCase(),
        `/health 503 body must not contain "${needle}" — got: ${rawBody}`,
      ).not.toContain(needle.toLowerCase());
    }

    // Operators still need the detail — confirm we logged the full error
    // server-side. This pins the "log server-side, sanitize client-side"
    // contract so a future refactor can't silently drop the log.
    expect(consoleErrorSpy).toHaveBeenCalled();
    const loggedArgs: unknown[] = consoleErrorSpy.mock.calls.flat();
    const sawFullError = loggedArgs.some(
      (arg: unknown) =>
        arg instanceof Error && arg.message === SENSITIVE_MESSAGE,
    );
    expect(
      sawFullError,
      "Expected the full error (with sensitive message) to be logged via console.error",
    ).toBe(true);
  });

  it("does not expose any 'error' / 'details' / 'cause' field on 503", async () => {
    // Defense-in-depth: even if someone later adds an `error` field that
    // happens not to contain the exact strings above, any freeform
    // error-derived field is a leak risk on an unauthenticated endpoint.
    // Pin the response shape explicitly.
    await startApp(() => Promise.reject(new Error("anything at all")));

    const res = await request(server, "GET", "/health");
    expect(res.status).toBe(503);

    const body = JSON.parse(res.body);
    expect(body).not.toHaveProperty("error");
    expect(body).not.toHaveProperty("details");
    expect(body).not.toHaveProperty("cause");
    expect(body).not.toHaveProperty("stack");
    expect(body).not.toHaveProperty("message");

    // Exact allowlist — fail loudly if a new field sneaks in.
    expect(Object.keys(body).sort()).toEqual(
      ["index", "server", "started_at", "status", "uptime_seconds"].sort(),
    );
  });

  it("handles non-Error rejections (e.g. string throws) without leaking them", async () => {
    // DB drivers sometimes reject with non-Error values. The pre-fix code
    // would stringify these with `String(err)` into the response body —
    // same leak class. Verify the sanitized body still holds.
    await startApp(() =>
      Promise.reject(
        `internal: postgresql://admin:hunter2@db.internal:5432/prod`,
      ),
    );

    const res = await request(server, "GET", "/health");
    expect(res.status).toBe(503);

    const rawBody = res.body.toLowerCase();
    expect(rawBody).not.toContain("postgres");
    expect(rawBody).not.toContain("hunter2");
    expect(rawBody).not.toContain("db.internal");
    expect(rawBody).not.toContain("5432");
  });
});
