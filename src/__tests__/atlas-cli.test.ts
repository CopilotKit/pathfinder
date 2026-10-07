import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import fs from "fs";
import type { Server } from "node:http";
import path from "path";
import { pathToFileURL } from "url";
import express, { type Request, type Response } from "express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { isInitializeRequest, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod-v4";
import {
  ATLAS_REQUEST_SOURCE,
  buildFeedbackArguments,
  isAtlasCliEntrypoint,
  runAtlasCli,
} from "../atlas-cli.js";
import { runAtlasHarvestCli } from "../atlas/harvest-cli.js";
import { createModernMcpRoute } from "../modern-mcp.js";
import { requestSourceFromHeaders } from "../request-context.js";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// A real MCP server over HTTP, on both protocol eras.
//
// atlas talks to it through @modelcontextprotocol/client over real sockets.
// The modern leg is Pathfinder's own createModernMcpRoute; the legacy leg
// follows the /mcp POST handler in server.ts: a known session is routed, a
// session-less initialize opens a session, anything else gets the 400
// "No valid session" (which is also what a legacy-only server answers to the
// modern server/discover probe).
// ---------------------------------------------------------------------------

/** One entry per HTTP request the server received. */
interface RecordedRequest {
  httpMethod: string;
  rpcMethod: string | undefined;
  rpcId: unknown;
  toolName: string | undefined;
  toolArguments: unknown;
  /** Raw X-Pathfinder-Source header, exactly as it arrived. */
  sourceHeader: string | undefined;
  authorization: string | undefined;
  sessionId: string | undefined;
}

/** How the server-side request edge read the request source, per era. */
interface ServerSeenSource {
  era: "modern" | "legacy";
  requestSource: string;
}

interface TestMcpServer {
  url: string;
  requests: RecordedRequest[];
  serverSeenSources: ServerSeenSource[];
  /**
   * Hold the next POST for `rpcMethod`: the server does not answer it until
   * release() is called. `arrived` resolves when the request comes in.
   */
  holdNext(rpcMethod: string): { arrived: Promise<void>; release(): void };
  reset(): void;
  close(): Promise<void>;
}

function headerValue(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

function buildToolServer(): McpServer {
  const server = new McpServer({ name: "atlas-cli-test", version: "0.0.1" });
  server.registerTool(
    "atlas-search",
    {
      description: "Echo the search arguments.",
      inputSchema: {
        query: z.string(),
        limit: z.number().optional(),
        min_score: z.number().optional(),
      },
    },
    async (args) => ({
      content: [
        { type: "text" as const, text: `searched ${JSON.stringify(args)}` },
      ],
    }),
  );
  server.registerTool(
    "atlas_search",
    {
      description: "Second name, for --tool.",
      inputSchema: {
        query: z.string(),
        limit: z.number().optional(),
        min_score: z.number().optional(),
      },
    },
    async () => ({ content: [{ type: "text" as const, text: "json result" }] }),
  );
  server.registerTool(
    "submit-feedback",
    {
      description: "Record feedback.",
      inputSchema: {
        tool_name: z.string(),
        query: z.string(),
        rating: z.enum(["helpful", "not_helpful"]),
        comment: z.string(),
      },
    },
    async () => ({
      content: [
        { type: "text" as const, text: "Feedback recorded. Thank you." },
      ],
    }),
  );
  server.registerTool(
    "collect-feedback",
    {
      description: "A second feedback tool, for --tool.",
      inputSchema: {
        tool_name: z.string(),
        query: z.string(),
        rating: z.enum(["helpful", "not_helpful"]),
        comment: z.string(),
      },
    },
    async () => ({
      content: [{ type: "text" as const, text: "Feedback collected." }],
    }),
  );
  server.registerTool(
    "fails",
    { description: "Reports a tool error.", inputSchema: {} },
    async () => ({
      isError: true,
      content: [{ type: "text" as const, text: "search backend unavailable" }],
    }),
  );
  server.registerTool(
    "empty",
    { description: "Returns no content.", inputSchema: {} },
    async () => ({ content: [] }),
  );
  return server;
}

async function startTestMcpServer(opts: {
  modern: boolean;
}): Promise<TestMcpServer> {
  const requests: RecordedRequest[] = [];
  const serverSeenSources: ServerSeenSource[] = [];
  const sessions = new Map<string, NodeStreamableHTTPServerTransport>();
  let hold:
    { rpcMethod: string; arrive(): void; released: Promise<void> } | undefined;
  const modernRoute = opts.modern
    ? createModernMcpRoute({
        buildServer: (ctx) => {
          serverSeenSources.push({
            era: "modern",
            requestSource: ctx.requestSource,
          });
          return buildToolServer();
        },
        onerror: () => {},
        requestTimeoutMs: 60000,
      })
    : undefined;

  const app = express();
  app.use(express.json());
  app.use("/mcp", (req: Request, _res: Response, next) => {
    const body = (req.body ?? {}) as {
      method?: string;
      id?: unknown;
      params?: { name?: string; arguments?: unknown };
    };
    requests.push({
      httpMethod: req.method,
      rpcMethod: req.method === "POST" ? body.method : undefined,
      rpcId: req.method === "POST" ? body.id : undefined,
      toolName: body.method === "tools/call" ? body.params?.name : undefined,
      toolArguments:
        body.method === "tools/call" ? body.params?.arguments : undefined,
      sourceHeader: headerValue(req, "x-pathfinder-source"),
      authorization: headerValue(req, "authorization"),
      sessionId: headerValue(req, "mcp-session-id"),
    });
    const held = hold;
    if (req.method === "POST" && held && body.method === held.rpcMethod) {
      hold = undefined;
      held.arrive();
      held.released.then(() => next(), next);
      return;
    }
    next();
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    if (modernRoute && (await modernRoute.isModern(req))) {
      await modernRoute.handle(req, res);
      return;
    }
    const sid = headerValue(req, "mcp-session-id");
    const known = sid === undefined ? undefined : sessions.get(sid);
    if (known) {
      await known.handleRequest(req, res, req.body);
      return;
    }
    if (sid === undefined && isInitializeRequest(req.body)) {
      serverSeenSources.push({
        era: "legacy",
        requestSource: requestSourceFromHeaders(req),
      });
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
        },
      });
      await buildToolServer().connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }
    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message:
          "Bad Request: No valid session. Send an initialize request first.",
      },
      id: null,
    });
  });
  app.get("/mcp", (_req: Request, res: Response) => {
    res.status(405).end();
  });
  app.delete("/mcp", async (req: Request, res: Response) => {
    const sid = headerValue(req, "mcp-session-id");
    const transport = sid === undefined ? undefined : sessions.get(sid);
    if (!transport || sid === undefined) {
      res.status(404).end();
      return;
    }
    sessions.delete(sid);
    await transport.close();
    res.status(200).end();
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("test MCP server has no TCP address");
  }

  return {
    url: `http://127.0.0.1:${addr.port}/mcp`,
    requests,
    serverSeenSources,
    holdNext(rpcMethod) {
      let arrive = () => {};
      let release = () => {};
      const arrived = new Promise<void>((resolve) => {
        arrive = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      hold = { rpcMethod, arrive, released };
      return { arrived, release };
    },
    reset() {
      hold = undefined;
      requests.length = 0;
      serverSeenSources.length = 0;
    },
    async close() {
      for (const transport of sessions.values()) {
        await transport.close();
      }
      sessions.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// A raw legacy server that answers with exact bytes.
//
// It speaks just enough of the 2025 protocol to get past the handshake (it
// refuses the server/discover probe the way a legacy-only server does), then
// hands the tools/call request to the test, which writes the answer itself.
// This reaches cases the real SDK server never produces: a proxy that echoes
// the id as a string, HTTP errors with a body, error frames with no id.
// ---------------------------------------------------------------------------

interface RpcBody {
  method?: string;
  id?: unknown;
  params?: { protocolVersion?: string };
}

type RawHandler = (
  req: Request,
  res: Response,
  body: RpcBody,
) => void | Promise<void>;

interface RawLegacyServer {
  url: string;
  close(): Promise<void>;
}

async function startRawLegacyServer(handlers: {
  /** Answers every POST, before any handshake logic. */
  onEveryPost?: RawHandler;
  /** Answers the tools/call POST. */
  onToolsCall: RawHandler;
}): Promise<RawLegacyServer> {
  const app = express();
  app.use(express.json());
  app.post("/mcp", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as RpcBody;
    if (handlers.onEveryPost) {
      await handlers.onEveryPost(req, res, body);
      return;
    }
    if (body.method === "initialize") {
      res.setHeader("mcp-session-id", "raw-session");
      res.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: body.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "raw-legacy", version: "0.0.1" },
        },
      });
      return;
    }
    if (body.method === "tools/call") {
      await handlers.onToolsCall(req, res, body);
      return;
    }
    if (body.id === undefined) {
      // A notification (notifications/initialized).
      res.status(202).end();
      return;
    }
    // Anything else, the server/discover probe included.
    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message:
          "Bad Request: No valid session. Send an initialize request first.",
      },
      id: null,
    });
  });
  app.delete("/mcp", (_req: Request, res: Response) => {
    res.status(200).end();
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("raw legacy server has no TCP address");
  }

  return {
    url: `http://127.0.0.1:${addr.port}/mcp`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("atlas CLI", () => {
  const originalEnv = { ...process.env };
  let stdout = "";
  let stderr = "";
  const io = {
    stdout: (text: string) => {
      stdout += text;
    },
    stderr: (text: string) => {
      stderr += text;
    },
  };

  beforeEach(() => {
    // Run against a known-clean env so the default-URL/token assertions do not
    // go red on a machine/CI that exports ATLAS_MCP_URL / ATLAS_TOKEN. Tests
    // that exercise the env fallback set these explicitly.
    delete process.env.ATLAS_MCP_URL;
    delete process.env.ATLAS_TOKEN;
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    stdout = "";
    stderr = "";
  });

  it("exposes a first-party atlas bin", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"),
    ) as { bin?: Record<string, string> };

    expect(packageJson.bin?.atlas).toBe("dist/atlas-cli.js");
  });

  it("ships the MCP client as a runtime dependency", () => {
    // atlas ships in the package (bin above), so the client it imports must
    // install for consumers, not only in this repo's dev tree.
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies?.["@modelcontextprotocol/client"]).toBe(
      "^2.2.0",
    );
    expect(
      packageJson.devDependencies?.["@modelcontextprotocol/client"],
    ).toBeUndefined();
  });

  it("tags its traffic as user traffic", () => {
    expect(ATLAS_REQUEST_SOURCE).toBe("user");
  });

  it("uses the default Pathfinder URL when neither --url nor ATLAS_MCP_URL is set", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    const exitCode = await runAtlasCli(["search", "provider boundary"], io);

    expect(exitCode).toBe(1);
    expect(fetchMock).toHaveBeenCalled();
    const [firstUrl] = fetchMock.mock.calls[0] as [URL | string];
    expect(String(firstUrl)).toBe("https://mcp.pathfinder.copilotkit.dev/mcp");
  });

  describe.each([
    {
      era: "modern" as const,
      modern: true,
      // The probe finds the 2026-07-28 era: no session, one POST per call.
      expectedRpc: ["server/discover", "tools/call"],
      // The requests atlas must wait on with no time limit.
      slowRpc: ["server/discover", "tools/call"],
    },
    {
      era: "legacy" as const,
      modern: false,
      // The probe is refused, so the client falls back to the 2025
      // handshake, and atlas ends the session afterwards.
      expectedRpc: [
        "server/discover",
        "initialize",
        "notifications/initialized",
        "tools/call",
      ],
      slowRpc: ["server/discover", "initialize", "tools/call"],
    },
  ])("against a $era server", ({ era, modern, expectedRpc, slowRpc }) => {
    let mcp: TestMcpServer;

    beforeAll(async () => {
      mcp = await startTestMcpServer({ modern });
    });

    afterAll(async () => {
      await mcp.close();
    });

    beforeEach(() => {
      mcp.reset();
      // The modern route logs one line per request.
      vi.spyOn(console, "log").mockImplementation(() => {});
    });

    it(`speaks the ${era} protocol and prints the tool text`, async () => {
      const exitCode = await runAtlasCli(
        ["search", "ratification queue", "--url", mcp.url],
        io,
      );

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout).toBe('searched {"query":"ratification queue"}\n');
      const rpc = mcp.requests
        .map((r) => r.rpcMethod)
        .filter((m): m is string => m !== undefined);
      expect(rpc).toEqual(expectedRpc);
    });

    it("sends X-Pathfinder-Source on every request", async () => {
      const exitCode = await runAtlasCli(
        ["search", "ratification queue", "--url", mcp.url],
        io,
      );

      expect(exitCode).toBe(0);
      expect(mcp.requests.length).toBeGreaterThan(0);
      for (const request of mcp.requests) {
        expect(
          request.sourceHeader,
          `${request.httpMethod} ${request.rpcMethod ?? ""}`,
        ).toBe("user");
      }
      // The server's own request edge reads the tag as `user` (the modern
      // leg builds a server per request, so there is one entry per POST).
      expect(mcp.serverSeenSources.length).toBeGreaterThan(0);
      for (const seen of mcp.serverSeenSources) {
        expect(seen).toEqual({ era, requestSource: "user" });
      }
    });

    it("uses ATLAS_MCP_URL and ATLAS_TOKEN, sending the bearer on every request", async () => {
      process.env.ATLAS_MCP_URL = mcp.url;
      process.env.ATLAS_TOKEN = "secret-token";

      const exitCode = await runAtlasCli(["search", "provider boundary"], io);

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(mcp.requests.length).toBeGreaterThan(0);
      for (const request of mcp.requests) {
        expect(request.authorization).toBe("Bearer secret-token");
      }
    });

    it("sends the --token bearer on every request", async () => {
      const exitCode = await runAtlasCli(
        ["search", "provider boundary", "--url", mcp.url, "--token", "flag"],
        io,
      );

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(mcp.requests.length).toBeGreaterThan(0);
      for (const request of mcp.requests) {
        expect(request.authorization).toBe("Bearer flag");
      }
    });

    it("prefers --url and --token over ATLAS_MCP_URL and ATLAS_TOKEN", async () => {
      // Nothing listens on port 1, so the run fails if atlas uses the env URL.
      process.env.ATLAS_MCP_URL = "http://127.0.0.1:1/mcp";
      process.env.ATLAS_TOKEN = "env-token";

      const exitCode = await runAtlasCli(
        [
          "search",
          "provider boundary",
          "--url",
          mcp.url,
          "--token",
          "flag-token",
        ],
        io,
      );

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(mcp.requests.length).toBeGreaterThan(0);
      for (const request of mcp.requests) {
        expect(request.authorization).toBe("Bearer flag-token");
      }
    });

    it("defaults to the Atlas search tool configured in pathfinder.example.yaml", async () => {
      const exitCode = await runAtlasCli(
        ["search", "provider boundary", "--url", mcp.url],
        io,
      );

      expect(exitCode).toBe(0);
      const call = mcp.requests.find((r) => r.rpcMethod === "tools/call");
      expect(call?.toolName).toBe("atlas-search");
    });

    it("honors CLI options and prints the raw JSON-RPC frame with --json", async () => {
      const exitCode = await runAtlasCli(
        [
          "search",
          "ratification queue",
          "--url",
          mcp.url,
          "--tool",
          "atlas_search",
          "--limit",
          "4",
          "--min-score",
          "0.62",
          "--json",
        ],
        io,
      );

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      const call = mcp.requests.find((r) => r.rpcMethod === "tools/call");
      // The --json output is a contract: the tools/call response frame, keys
      // in the order result, jsonrpc, id, with id the request's own id.
      const printed = JSON.parse(stdout) as Record<string, unknown>;
      expect(Object.keys(printed)).toEqual(["result", "jsonrpc", "id"]);
      expect(printed.jsonrpc).toBe("2.0");
      expect(printed.id).toBe(call?.rpcId);
      expect(printed.result).toMatchObject({
        content: [{ type: "text", text: "json result" }],
      });
      if (era === "legacy") {
        // Byte-for-byte what atlas printed before the v2 client.
        expect(stdout).toBe(
          `${JSON.stringify(
            {
              result: { content: [{ type: "text", text: "json result" }] },
              jsonrpc: "2.0",
              id: 1,
            },
            null,
            2,
          )}\n`,
        );
      }
      expect(call?.toolName).toBe("atlas_search");
      expect(call?.toolArguments).toEqual({
        query: "ratification queue",
        limit: 4,
        min_score: 0.62,
      });
    });

    it.each(slowRpc)(
      "waits past the SDK's 60 s default for a slow %s answer",
      async (rpcMethod) => {
        // Before the v2 client, atlas put no time limit on any request. Fake
        // only setTimeout (the clock still runs, so zero-delay timers fire and
        // the real sockets keep working), and hold the answer until 61 s of
        // fake time have passed.
        vi.useFakeTimers({
          toFake: ["setTimeout", "clearTimeout"],
          shouldAdvanceTime: true,
        });
        const hold = mcp.holdNext(rpcMethod);
        const run = runAtlasCli(
          ["search", "ratification queue", "--url", mcp.url],
          io,
        );
        await hold.arrived;
        await vi.advanceTimersByTimeAsync(61_000);
        vi.useRealTimers();
        hold.release();
        const exitCode = await run;

        expect(stderr).toBe("");
        expect(exitCode).toBe(0);
        expect(stdout).toBe('searched {"query":"ratification queue"}\n');
        const rpc = mcp.requests
          .map((r) => r.rpcMethod)
          .filter((m): m is string => m !== undefined);
        expect(rpc).toEqual(expectedRpc);
      },
    );

    it("prints No results. when the tool returns no text", async () => {
      const exitCode = await runAtlasCli(
        ["search", "q", "--url", mcp.url, "--tool", "empty"],
        io,
      );

      expect(exitCode).toBe(0);
      expect(stdout).toBe("No results.\n");
    });

    it("treats a tool result with isError as a failure on stderr with exit 1", async () => {
      const exitCode = await runAtlasCli(
        ["search", "q", "--url", mcp.url, "--tool", "fails"],
        io,
      );

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toBe("error: search backend unavailable\n");
    });

    it("fails with exit 1 when the tool does not exist", async () => {
      const exitCode = await runAtlasCli(
        ["search", "q", "--url", mcp.url, "--tool", "no-such-tool"],
        io,
      );

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("no-such-tool");
    });

    it("submits feedback through the configured MCP feedback tool", async () => {
      const exitCode = await runAtlasCli(
        [
          "feedback",
          "provider boundary",
          "--rating",
          "not_helpful",
          "--comment",
          "Missing the retry semantics.",
          "--url",
          mcp.url,
        ],
        io,
      );

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout).toBe("Feedback recorded. Thank you.\n");
      const call = mcp.requests.find((r) => r.rpcMethod === "tools/call");
      expect(call?.toolName).toBe("submit-feedback");
      expect(call?.toolArguments).toEqual({
        tool_name: "atlas-search",
        query: "provider boundary",
        rating: "not_helpful",
        comment: "Missing the retry semantics.",
      });
      for (const request of mcp.requests) {
        expect(request.sourceHeader).toBe("user");
      }
    });

    it("maps --for to tool_name and honors --tool for the feedback tool name", async () => {
      const exitCode = await runAtlasCli(
        [
          "feedback",
          "provider boundary",
          "--rating",
          "helpful",
          "--comment",
          "Good.",
          "--for",
          "atlas_search",
          "--tool",
          "collect-feedback",
          "--url",
          mcp.url,
        ],
        io,
      );

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout).toBe("Feedback collected.\n");
      const call = mcp.requests.find((r) => r.rpcMethod === "tools/call");
      expect(call?.toolName).toBe("collect-feedback");
      expect(call?.toolArguments).toMatchObject({ tool_name: "atlas_search" });
    });

    it("treats a feedback tool result with isError as a failure on stderr with exit 1", async () => {
      const exitCode = await runAtlasCli(
        [
          "feedback",
          "provider boundary",
          "--rating",
          "helpful",
          "--comment",
          "Good.",
          "--tool",
          "fails",
          "--url",
          mcp.url,
        ],
        io,
      );

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toBe("error: search backend unavailable\n");
      const call = mcp.requests.find((r) => r.rpcMethod === "tools/call");
      expect(call?.toolName).toBe("fails");
    });

    if (era === "legacy") {
      it("ends the legacy session after the call, with the same session id", async () => {
        const exitCode = await runAtlasCli(
          ["search", "q", "--url", mcp.url],
          io,
        );

        expect(exitCode).toBe(0);
        const call = mcp.requests.find((r) => r.rpcMethod === "tools/call");
        const deletes = mcp.requests.filter((r) => r.httpMethod === "DELETE");
        expect(deletes).toHaveLength(1);
        expect(deletes[0].sessionId).toBeDefined();
        expect(deletes[0].sessionId).toBe(call?.sessionId);
        expect(deletes[0].sourceHeader).toBe("user");
      });

      it("ends the legacy session after a tool error too", async () => {
        const exitCode = await runAtlasCli(
          ["search", "q", "--url", mcp.url, "--tool", "fails"],
          io,
        );

        expect(exitCode).toBe(1);
        expect(
          mcp.requests.filter((r) => r.httpMethod === "DELETE"),
        ).toHaveLength(1);
      });
    } else {
      it("opens no session and sends no DELETE", async () => {
        const exitCode = await runAtlasCli(
          ["search", "q", "--url", mcp.url],
          io,
        );

        expect(exitCode).toBe(0);
        expect(mcp.requests.every((r) => r.sessionId === undefined)).toBe(true);
        expect(
          mcp.requests.filter((r) => r.httpMethod === "DELETE"),
        ).toHaveLength(0);
      });
    }
  });

  describe("against a raw legacy server", () => {
    let raw: RawLegacyServer | undefined;

    afterEach(async () => {
      await raw?.close();
      raw = undefined;
    });

    it("matches a tools/call answer whose id a proxy echoed as a string, with --json", async () => {
      raw = await startRawLegacyServer({
        onToolsCall: (_req, res, body) => {
          res.json({
            jsonrpc: "2.0",
            id: String(body.id),
            result: { content: [{ type: "text", text: "proxied" }] },
          });
        },
      });

      const exitCode = await runAtlasCli(
        ["search", "q", "--url", raw.url, "--json"],
        io,
      );

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      const printed = JSON.parse(stdout) as {
        result: { content: Array<{ text: string }> };
      };
      expect(printed.result.content[0].text).toBe("proxied");
    });
    const UNAUTHORIZED_BODY = JSON.stringify({
      error: "invalid_token",
      error_description: "bad token",
    });
    const answer401: RawHandler = (_req, res) => {
      res.status(401).type("application/json").send(UNAUTHORIZED_BODY);
    };

    it.each([
      ["every request", "with --token", ["--token", "bad"]],
      ["every request", "without a token", []],
      ["tools/call", "with --token", ["--token", "bad"]],
    ])(
      "reports HTTP 401 on %s %s with the status and body",
      async (scope, _label, tokenArgs) => {
        raw = await startRawLegacyServer(
          scope === "every request"
            ? { onEveryPost: answer401, onToolsCall: answer401 }
            : { onToolsCall: answer401 },
        );

        const exitCode = await runAtlasCli(
          ["search", "q", "--url", raw.url, ...tokenArgs],
          io,
        );

        expect(exitCode).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toBe(`error: HTTP 401: ${UNAUTHORIZED_BODY}\n`);
      },
    );

    it("reports a non-2xx tools/call answer with the status and body", async () => {
      raw = await startRawLegacyServer({
        onToolsCall: (_req, res) => {
          res.status(500).type("text/plain").send("boom detail");
        },
      });

      const exitCode = await runAtlasCli(["search", "q", "--url", raw.url], io);

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toBe("error: HTTP 500: boom detail\n");
    });
    it.each([
      ["with no id", {}],
      ["with id null", { id: null }],
    ])(
      "reports the server's message for a tools/call error frame %s",
      async (_label, idField) => {
        raw = await startRawLegacyServer({
          onToolsCall: (_req, res) => {
            res.json({
              jsonrpc: "2.0",
              ...idField,
              error: { code: -32603, message: "upstream exploded" },
            });
          },
        });

        const exitCode = await runAtlasCli(
          ["search", "q", "--url", raw.url],
          io,
        );

        expect(exitCode).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toBe("error: upstream exploded\n");
      },
    );

    it("gives up with exit 1 when tools/call gets no answer within 10 minutes", async () => {
      // A 202 with no body: the server accepts the call and never answers.
      let arrived!: () => void;
      const toolsCallArrived = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      raw = await startRawLegacyServer({
        onToolsCall: (_req, res) => {
          res.status(202).end();
          arrived();
        },
      });
      // Real time, so the check below does not wait on the faked clock.
      const realSetTimeout = globalThis.setTimeout;
      const settledWithin = <T>(promise: Promise<T>, ms: number) =>
        Promise.race([
          promise.then(() => true),
          new Promise<false>((resolve) =>
            realSetTimeout(() => resolve(false), ms),
          ),
        ]);
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout"],
        shouldAdvanceTime: true,
      });

      const run = runAtlasCli(["search", "q", "--url", raw.url], io);
      await toolsCallArrived;
      await vi.advanceTimersByTimeAsync(9 * 60_000);
      expect(await settledWithin(run, 200)).toBe(false);

      await vi.advanceTimersByTimeAsync(60_000 + 1_000);
      expect(await settledWithin(run, 2_000)).toBe(true);
      vi.useRealTimers();
      const exitCode = await run;

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toBe("error: no response from server within 10 minutes\n");
    });
  });

  it("requires --for when building feedback arguments", () => {
    expect(() =>
      buildFeedbackArguments("provider boundary", {
        for: undefined,
        rating: "helpful",
        comment: "Exactly what I needed.",
      }),
    ).toThrow("atlas: --for is required");
  });

  it.each([
    ["--limit", "not-a-number", "limit must be a positive integer"],
    ["--limit", "10abc", "limit must be a positive integer"],
    ["--limit", "-1", "limit must be a positive integer"],
    ["--limit", "0", "limit must be a positive integer"],
    ["--limit", "NaN", "limit must be a positive integer"],
    [
      "--min-score",
      "not-a-score",
      "min-score must be a finite number in [0, 1]",
    ],
    ["--min-score", "0.5abc", "min-score must be a finite number in [0, 1]"],
    ["--min-score", "2", "min-score must be a finite number in [0, 1]"],
    ["--min-score", "-0.1", "min-score must be a finite number in [0, 1]"],
    ["--min-score", "NaN", "min-score must be a finite number in [0, 1]"],
  ])(
    "rejects invalid %s value %s before calling MCP",
    async (option, value, expectedMessage) => {
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetchMock);

      const exitCode = await runAtlasCli(
        ["search", "provider boundary", option, value],
        {
          stdout: (text) => {
            stdout += text;
          },
          stderr: (text) => {
            stderr += text;
          },
        },
      );

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain(expectedMessage);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("returns an existing-style error for missing search query", async () => {
    const exitCode = await runAtlasCli(["search"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("error: missing required argument 'query'");
  });

  it.each([["sometimes"], ["yes"], ["HELPFUL"], [""]])(
    "rejects invalid feedback rating %s before calling MCP",
    async (rating) => {
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetchMock);

      const exitCode = await runAtlasCli(
        [
          "feedback",
          "provider boundary",
          "--rating",
          rating,
          "--comment",
          "Some comment.",
        ],
        {
          stdout: (text) => {
            stdout += text;
          },
          stderr: (text) => {
            stderr += text;
          },
        },
      );

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("rating must be one of: helpful, not_helpful");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("rejects an empty feedback comment before calling MCP", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const exitCode = await runAtlasCli(
      [
        "feedback",
        "provider boundary",
        "--rating",
        "helpful",
        "--comment",
        "   ",
      ],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("comment must not be empty");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires the rating and comment options for feedback", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const exitCode = await runAtlasCli(["feedback", "provider boundary"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("required option");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ships a prepublishOnly build guard", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.prepublishOnly).toBe("npm run build");
  });

  it("recognizes URL-escaped CLI entrypoint paths", () => {
    const entrypointPath = path.join(PROJECT_ROOT, "dist", "atlas cli.js");
    const nonNormalizedArgvPath = path.join(
      PROJECT_ROOT,
      "dist",
      "..",
      "dist",
      "atlas cli.js",
    );

    expect(
      isAtlasCliEntrypoint(
        pathToFileURL(entrypointPath).href,
        nonNormalizedArgvPath,
      ),
    ).toBe(true);
  });

  it("recognizes symlinked CLI entrypoint paths", () => {
    const tempDir = fs.mkdtempSync(path.join(PROJECT_ROOT, ".atlas-cli-"));

    try {
      const realEntrypointPath = path.join(tempDir, "dist", "atlas-cli.js");
      const symlinkPath = path.join(tempDir, "node_modules", ".bin", "atlas");
      fs.mkdirSync(path.dirname(realEntrypointPath), { recursive: true });
      fs.mkdirSync(path.dirname(symlinkPath), { recursive: true });
      fs.writeFileSync(realEntrypointPath, "", "utf-8");
      fs.symlinkSync(realEntrypointPath, symlinkPath);

      expect(
        isAtlasCliEntrypoint(
          pathToFileURL(realEntrypointPath).href,
          symlinkPath,
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("atlas CLI — harvest verb (driver mount)", () => {
  // The harvest driver (src/atlas/harvest-cli.ts) mounts as the `atlas harvest`
  // subcommand: the remaining argv is forwarded verbatim to
  // `runAtlasHarvestCli`, so `atlas harvest run --run-id ...` behaves exactly
  // like the old standalone driver invocation (exit codes, stderr via
  // formatCliError). These tests reach the harvest machinery through a cheap
  // observable — its own commander/validation error text surfacing through the
  // atlas binary — with no DB or network.
  let stdout = "";
  let stderr = "";
  const io = {
    stdout: (text: string) => {
      stdout += text;
    },
    stderr: (text: string) => {
      stderr += text;
    },
  };

  afterEach(() => {
    stdout = "";
    stderr = "";
  });

  it("lists the harvest verb in the top-level help", async () => {
    const exitCode = await runAtlasCli(["--help"], io);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("harvest");
  });

  it("forwards argv to the harvest driver — its missing --run-id error surfaces through atlas", async () => {
    const exitCode = await runAtlasCli(["harvest", "run"], io);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--run-id");
  });

  it("forwards option values intact — a parsed --run-id reaches the run command's own validation", async () => {
    const exitCode = await runAtlasCli(
      ["harvest", "run", "--run-id", "run-x"],
      io,
    );

    // --run-id parsed by the harvest driver (its commander requiredOption is
    // satisfied), so the failure is the NEXT gate: runCommand's own --checkout
    // requirement, proving the forwarded argv ordering survived the mount.
    expect(exitCode).toBe(1);
    expect(stderr).not.toContain("--run-id <id>");
    expect(stderr).toContain("--checkout");
  });

  describe("mount fidelity — mounted tail matches the standalone driver byte-for-byte", () => {
    // Parity harness: the SAME argv tail is fed to the mounted form
    // (`atlas harvest <tail>`) and to the standalone driver
    // (`runAtlasHarvestCli(<tail>)`); exit code, stdout, and stderr must all
    // be identical. This pins the mount contract: nothing in atlas-cli may
    // consume or reorder ANY token of the tail — including a LEADING `--`,
    // which a commander variadic `[args...]` would otherwise eat.
    async function runBoth(tail: string[]) {
      let mountedOut = "";
      let mountedErr = "";
      const mountedExit = await runAtlasCli(["harvest", ...tail], {
        stdout: (text: string) => {
          mountedOut += text;
        },
        stderr: (text: string) => {
          mountedErr += text;
        },
      });

      let standaloneOut = "";
      let standaloneErr = "";
      const standaloneExit = await runAtlasHarvestCli(tail, {
        stdout: (text: string) => {
          standaloneOut += text;
        },
        stderr: (text: string) => {
          standaloneErr += text;
        },
      });

      expect(mountedExit).toBe(standaloneExit);
      expect(mountedOut).toBe(standaloneOut);
      expect(mountedErr).toBe(standaloneErr);
      return {
        exitCode: standaloneExit,
        stdout: standaloneOut,
        stderr: standaloneErr,
      };
    }

    it("preserves a LEADING `--` — `harvest -- --help` is an unknown command, not help", async () => {
      const { exitCode, stderr } = await runBoth(["--", "--help"]);

      // Standalone, post-`--` tokens are operands: `--help` is an unknown
      // command (exit 1), NOT a help request.
      expect(exitCode).toBe(1);
      expect(stderr).toContain("unknown command");
    });

    it("preserves a LEADING `--` — `harvest -- run --run-id x` does NOT execute the run", async () => {
      const { exitCode, stderr } = await runBoth([
        "--",
        "run",
        "--run-id",
        "x",
      ]);

      // Standalone, `--run-id x` after `--` are inert operands, so the run
      // subcommand's requiredOption fails — the pipeline must NOT execute
      // (no `--checkout` gate is ever reached).
      expect(exitCode).toBe(1);
      expect(stderr).toContain("--run-id <id>");
      expect(stderr).not.toContain("--checkout");
    });

    it("preserves a post-verb `--` — `harvest run -- --run-id x` keeps the operands inert", async () => {
      const { exitCode, stderr } = await runBoth([
        "run",
        "--",
        "--run-id",
        "x",
      ]);

      expect(exitCode).toBe(1);
      expect(stderr).toContain("--run-id <id>");
    });

    it("forwards a value-bearing pre-verb flag — `harvest --runs-dir /x run …` matches standalone", async () => {
      const { exitCode, stderr } = await runBoth([
        "--runs-dir",
        "/x",
        "run",
        "--run-id",
        "y",
      ]);

      // The driver's program level declares no --runs-dir option, so both
      // forms reject it identically.
      expect(exitCode).toBe(1);
      expect(stderr).toContain("--runs-dir");
    });

    it("shows the driver's own help — `harvest --help` exits 0 with the atlas-harvest usage", async () => {
      const { exitCode, stdout } = await runBoth(["--help"]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Usage: atlas-harvest");
    });
  });
});
