/**
 * Route-level coverage: on the legacy POST /mcp initialize path, a throw from
 * createMcpServer must roll the session back like any other init failure.
 * The route takes the per-IP limiter slot and commits the session maps
 * before it builds the server. Before the fix, the createMcpServer call ran
 * outside the rollback `try`, so each throw answered 500 but kept its slot
 * until the idle reaper ran. After max_sessions_per_ip failed initializes,
 * the next initialize from that IP got 429.
 *
 * Boots the real app in-process and drives /mcp over HTTP. createMcpServer
 * is wrapped so that it throws while `fault.active` is true.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const CAP = 20;

const state = vi.hoisted(() => ({ cloneDir: "" }));
const fault = vi.hoisted(() => ({ active: false }));

vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  getConfig: vi.fn(() => ({
    port: 0,
    databaseUrl: "pglite://memory://",
    openaiApiKey: "",
    githubToken: "",
    githubWebhookSecret: "",
    nodeEnv: "test",
    logLevel: "info",
    cloneDir: state.cloneDir,
    slackBotToken: "",
    slackSigningSecret: "",
    discordBotToken: "",
    discordPublicKey: "",
    notionToken: "",
    mcpJwtSecret: "f".repeat(64),
    p2pTelemetryDisabled: true,
    packageVersion: "test",
  })),
  getServerConfig: vi.fn().mockReturnValue({
    server: {
      name: "pathfinder-init-factory-throw-slot",
      version: "0.0.0",
      max_sessions_per_ip: CAP,
      session_ttl_minutes: 30,
      allowlist: [],
      trust_proxy: false,
    },
    sources: [],
    tools: [],
  }),
  getAnalyticsConfig: vi.fn().mockReturnValue(undefined),
  hasSearchTools: vi.fn().mockReturnValue(false),
  hasKnowledgeTools: vi.fn().mockReturnValue(false),
  hasCollectTools: vi.fn().mockReturnValue(false),
  hasBashSemanticSearch: vi.fn().mockReturnValue(false),
}));

vi.mock("../mcp/server.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../mcp/server.js")>();
  return {
    ...real,
    createMcpServer: (
      ...args: Parameters<typeof real.createMcpServer>
    ): ReturnType<typeof real.createMcpServer> => {
      if (fault.active) throw new Error("injected createMcpServer failure");
      return real.createMcpServer(...args);
    },
  };
});

import type { InProcessServer } from "./helpers/inProcessServer.js";

const ACCEPT_BOTH = "application/json, text/event-stream";
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "init-factory-throw-test", version: "0.0.0" },
  },
};
const FAILED_ATTEMPTS = 30;

let running: InProcessServer | undefined;
let port = 0;

type HttpResult = { status: number; headers: http.IncomingHttpHeaders };

function mcpRequest(
  method: "POST" | "DELETE",
  headers: Record<string, string>,
  body?: unknown,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/mcp",
        method,
        headers: {
          ...(payload ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
      },
      (res) => {
        res.resume();
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("POST /mcp: a createMcpServer throw during initialize frees the per-IP slot", () => {
  beforeAll(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    state.cloneDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pathfinder-init-factory-throw-"),
    );
    const { startInProcessServer } =
      await import("./helpers/inProcessServer.js");
    running = await startInProcessServer();
    port = Number(new URL(running.baseUrl).port);
  });

  afterAll(async () => {
    fault.active = false;
    try {
      await running?.stop();
    } finally {
      running = undefined;
      if (state.cloneDir) {
        fs.rmSync(state.cloneDir, { recursive: true, force: true });
      }
      vi.restoreAllMocks();
    }
  });

  it("answers 500 to every failed initialize, never 429, and leaves the full cap available", async () => {
    fault.active = true;
    const statuses: number[] = [];
    for (let i = 0; i < FAILED_ATTEMPTS; i++) {
      const res = await mcpRequest("POST", { Accept: ACCEPT_BOTH }, INITIALIZE);
      statuses.push(res.status);
    }
    fault.active = false;
    expect(statuses).toEqual(Array(FAILED_ATTEMPTS).fill(500));

    // Back at baseline: exactly CAP valid initializes from this IP succeed
    // and the next one gets 429.
    const sids: string[] = [];
    for (let i = 0; i < CAP; i++) {
      const ok = await mcpRequest("POST", { Accept: ACCEPT_BOTH }, INITIALIZE);
      expect(ok.status).toBe(200);
      sids.push(String(ok.headers["mcp-session-id"]));
    }
    const over = await mcpRequest("POST", { Accept: ACCEPT_BOTH }, INITIALIZE);
    expect(over.status).toBe(429);

    for (const sid of sids) {
      const del = await mcpRequest("DELETE", {
        Accept: ACCEPT_BOTH,
        "Mcp-Session-Id": sid,
      });
      expect(del.status).toBe(200);
    }
  });
});
