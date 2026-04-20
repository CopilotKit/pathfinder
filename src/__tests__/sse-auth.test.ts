import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// Stable JWT secret for bearer middleware tests. The mock factory is hoisted
// to the top of the file, so it cannot reference local consts — inline the
// secret in the factory and re-derive it below for test code.
vi.mock("../config.js", () => ({
  getConfig: vi.fn().mockReturnValue({
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
  }),
  getServerConfig: vi.fn().mockReturnValue({
    server: { name: "pathfinder-test", version: "0.0.0" },
    sources: [],
    tools: [],
  }),
  getAnalyticsConfig: vi.fn(),
  hasSearchTools: vi.fn().mockReturnValue(false),
  hasKnowledgeTools: vi.fn().mockReturnValue(false),
  hasCollectTools: vi.fn().mockReturnValue(false),
  hasBashSemanticSearch: vi.fn().mockReturnValue(false),
}));

import { IpSessionLimiter } from "../ip-limiter.js";
import { createSseHandlers, type SseHandlerDeps } from "../sse-handlers.js";
import { signJWT } from "../oauth/jwt.js";

const TEST_JWT_SECRET = "e".repeat(64);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(overrides: Partial<SseHandlerDeps> = {}): {
  app: express.Express;
  deps: SseHandlerDeps;
} {
  const sseTransports: SseHandlerDeps["sseTransports"] = {};
  const sessionLastActivity: SseHandlerDeps["sessionLastActivity"] = {};
  const deps: SseHandlerDeps = {
    sseTransports,
    sessionLastActivity,
    ipLimiter: new IpSessionLimiter(20),
    createMcpServer: () => {
      return {
        connect: vi.fn(async (transport: unknown) => {
          const t = transport as { start?: () => Promise<void> };
          if (t.start) await t.start();
        }),
      } as unknown as ReturnType<SseHandlerDeps["createMcpServer"]>;
    },
    workspaceManager: undefined,
    ...overrides,
  };

  const app = express();
  app.use(express.json());
  const { getHandler, postHandler } = createSseHandlers(deps);
  app.get("/sse", getHandler);
  app.post("/messages", postHandler);
  return { app, deps };
}

function startServer(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function baseUrlOf(server: Server): string {
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

function mintToken(params: {
  aud: string;
  exp?: number;
  iat?: number;
  secret?: string;
  sub?: string;
  client_id?: string;
}): string {
  const now = Math.floor(Date.now() / 1000);
  return signJWT(
    {
      sub: params.sub ?? "anonymous",
      iss: params.aud,
      aud: params.aud,
      client_id: params.client_id ?? "test-client",
      iat: params.iat ?? now,
      exp: params.exp ?? now + 3600,
    },
    params.secret ?? TEST_JWT_SECRET,
  );
}

async function drainUntilEndpoint(
  res: Response,
): Promise<{ buffer: string; sid: string | undefined }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!buffer.includes("event: endpoint")) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  const match = buffer.match(/sessionId=([0-9a-f-]+)/);
  return { buffer, sid: match?.[1] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SSE bearer auth", () => {
  let server: Server | undefined;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    await closeServer(server);
    server = undefined;
  });

  it("accepts a valid Bearer token and opens an SSE stream (200 + event-stream)", async () => {
    const { app, deps } = buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);
    const token = mintToken({ aud: url });

    const res = await fetch(`${url}/sse`, {
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${token}`,
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    const { buffer, sid } = await drainUntilEndpoint(res);
    expect(buffer).toContain("event: endpoint");
    expect(sid).toBeDefined();
    // Session actually registered — indirect proof that handler ran past
    // the bearer middleware (which is what populates req.auth).
    expect(deps.sseTransports[sid!]).toBeDefined();
  });

  it("rejects an expired Bearer token with 401 + WWW-Authenticate: Bearer", async () => {
    const { app } = buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);
    const nowSec = Math.floor(Date.now() / 1000);
    const token = mintToken({
      aud: url,
      iat: nowSec - 7200,
      // exp well past the 30s clock-skew allowance
      exp: nowSec - 3600,
    });

    const res = await fetch(`${url}/sse`, {
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${token}`,
      },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer /);
    await res.body?.cancel();
  });

  it("rejects a Bearer token signed with the wrong secret with 401", async () => {
    const { app } = buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);
    const token = mintToken({
      aud: url,
      secret: "w".repeat(64), // wrong secret
    });

    const res = await fetch(`${url}/sse`, {
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${token}`,
      },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer /);
    await res.body?.cancel();
  });

  it("rejects a Bearer token with wrong audience with 401", async () => {
    const { app } = buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);
    const token = mintToken({ aud: "https://other.example" });

    const res = await fetch(`${url}/sse`, {
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${token}`,
      },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer /);
    await res.body?.cancel();
  });

  it("treats a malformed Authorization header (no space after Bearer) as missing — 200", async () => {
    const { app } = buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);

    const res = await fetch(`${url}/sse`, {
      headers: {
        Accept: "text/event-stream",
        // No space between scheme and token — not a well-formed Bearer header.
        Authorization: "Bearersecret",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    await res.body?.cancel();
  });

  it("rejects an empty token after Bearer with 401", async () => {
    const { app } = buildApp();
    server = await startServer(app);
    const url = baseUrlOf(server);

    const res = await fetch(`${url}/sse`, {
      headers: {
        Accept: "text/event-stream",
        Authorization: "Bearer ",
      },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer /);
    await res.body?.cancel();
  });
});
