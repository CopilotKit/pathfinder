import { describe, it, expect, vi } from "vitest";
import express from "express";
import type { Request, Response } from "express";
import http from "node:http";

// Mock config so importing server.ts doesn't blow up.
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
    mcpJwtSecret: "x".repeat(32),
  }),
  getServerConfig: vi.fn().mockReturnValue({
    server: { name: "test", version: "0.0.0" },
    sources: [],
    tools: [],
  }),
  getAnalyticsConfig: vi.fn(),
  hasSearchTools: vi.fn().mockReturnValue(false),
  hasKnowledgeTools: vi.fn().mockReturnValue(false),
  hasCollectTools: vi.fn().mockReturnValue(false),
  hasBashSemanticSearch: vi.fn().mockReturnValue(false),
}));

import { assertWebhookRawBodyOrder } from "../server.js";

// ---------------------------------------------------------------------------
// R4-7: middleware-ordering guard for /webhooks/* routes.
//
// The production /webhooks/{github,slack,discord} routes all mount
// express.raw BEFORE the handler so req.body arrives as a Buffer for
// HMAC signature verification. A refactor that (accidentally) places
// express.json earlier in the stack would silently swap Buffer -> object
// and every signature check would 401. These tests verify the runtime
// guard fires a loud 500 on that exact misconfiguration.
// ---------------------------------------------------------------------------

function startServer(app: express.Express): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function post(
  server: http.Server,
  path: string,
  body: string,
  contentType = "application/json",
): Promise<{ status: number; body: string }> {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method: "POST",
        headers: {
          "Content-Type": contentType,
          "Content-Length": Buffer.byteLength(body).toString(),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("assertWebhookRawBodyOrder runtime guard (R4-7)", () => {
  it("passes through when express.raw ran first (req.body is a Buffer)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const app = express();
      let receivedType = "";
      app.post(
        "/webhooks/github",
        express.raw({ type: "application/json" }),
        assertWebhookRawBodyOrder("webhook"),
        (req: Request, res: Response) => {
          receivedType = Buffer.isBuffer(req.body) ? "buffer" : typeof req.body;
          res.status(200).json({ ok: true });
        },
      );
      const server = await startServer(app);
      try {
        const resp = await post(server, "/webhooks/github", '{"x":1}');
        expect(resp.status).toBe(200);
        expect(receivedType).toBe("buffer");
      } finally {
        await stopServer(server);
      }
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does NOT log 'middleware misconfigured' when content-type mismatch makes express.raw skip", async () => {
    // Regression: before this guard distinguished cases, a webhook request
    // arriving with Content-Type: text/plain caused express.raw (configured
    // with type: "application/json") to skip parsing. req.body stayed as
    // the Express default {} and the guard fired "middleware misconfigured"
    // — but NOTHING was misconfigured; the client just used the wrong
    // content-type. The guard should return 415 quietly instead.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const app = express();
      app.post(
        "/webhooks/github",
        express.raw({ type: "application/json" }),
        assertWebhookRawBodyOrder("webhook"),
        (_req: Request, res: Response) => {
          // Should never reach the handler — request is rejected at the guard.
          res.status(200).json({ ok: true });
        },
      );
      const server = await startServer(app);
      try {
        const resp = await post(
          server,
          "/webhooks/github",
          "hello",
          "text/plain",
        );
        expect(resp.status).toBe(415);
        // No "middleware misconfigured" / "middleware ordering bug" log.
        const misconfigCalls = errorSpy.mock.calls.filter((args: unknown[]) =>
          String(args[0] ?? "").includes("middleware"),
        );
        expect(misconfigCalls.length).toBe(0);
      } finally {
        await stopServer(server);
      }
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("returns 500 with a loud log when express.json ran first (req.body is object)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const app = express();
      // DELIBERATELY WRONG ORDER: json before raw. Express uses the first
      // matching body parser, so req.body will be the parsed object. The
      // guard must refuse.
      app.use(express.json());
      app.post(
        "/webhooks/github",
        express.raw({ type: "application/json" }),
        assertWebhookRawBodyOrder("webhook"),
        (_req: Request, res: Response) => {
          // Should never run.
          res.status(200).json({ ok: true });
        },
      );
      const server = await startServer(app);
      try {
        const resp = await post(server, "/webhooks/github", '{"x":1}');
        expect(resp.status).toBe(500);
        expect(resp.body).toContain("misconfigured");
        // Verify the loud log fired.
        const loudCalls = errorSpy.mock.calls.filter((args: unknown[]) =>
          String(args[0] ?? "").includes("middleware ordering bug"),
        );
        expect(loudCalls.length).toBeGreaterThanOrEqual(1);
      } finally {
        await stopServer(server);
      }
    } finally {
      errorSpy.mockRestore();
    }
  });
});
