import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import type { Server } from "node:http";
import {
  McpServer,
  MissingRequiredClientCapabilityError,
  UnsupportedProtocolVersionError,
} from "@modelcontextprotocol/server";
import { z } from "zod-v4";
import {
  createModernMcpRoute,
  logModernMcpError,
  type ModernServerContext,
} from "../modern-mcp.js";
import type { AuthContext } from "../oauth/handlers.js";

type PReq = Request & { auth?: AuthContext };

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "p4-unit-cli", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

const MODERN_HEADERS = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
  "MCP-Protocol-Version": "2026-07-28",
};

/** Contexts the factory received, in order. */
const factoryCalls: ModernServerContext[] = [];
/** One entry per POST: the classifier's answer. */
const classified: boolean[] = [];
/** Errors the route's onerror received, in order. */
const reportedErrors: Error[] = [];
/** When set, the next factory call throws an Error with this message. */
let factoryThrow: string | undefined;

function buildServer(ctx: ModernServerContext): McpServer {
  factoryCalls.push(ctx);
  if (factoryThrow !== undefined) {
    const message = factoryThrow;
    factoryThrow = undefined;
    throw new Error(message);
  }
  const server = new McpServer({ name: "modern-unit", version: "0.0.1" });
  server.registerTool(
    "whoami",
    { description: "echo the auth info the tool sees", inputSchema: {} },
    async (_args, toolCtx) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ authInfo: toolCtx.http?.authInfo ?? null }),
        },
      ],
    }),
  );
  server.registerTool(
    "echo",
    { description: "echo", inputSchema: { q: z.string() } },
    async (args) => ({ content: [{ type: "text", text: args.q }] }),
  );
  return server;
}

// The opportunistic bearer, shaped like Pathfinder's: it sets AuthContext,
// not the SDK's AuthInfo.
function fakeBearer(req: PReq, _res: Response, next: NextFunction): void {
  const h = req.headers.authorization;
  if (typeof h === "string" && /^Bearer\s+good-/i.test(h)) {
    const sub = h.trim().slice("Bearer".length).trim().slice("good-".length);
    req.auth = { sub, client_id: `cid-${sub}` };
  }
  next();
}

let server: Server;
let url: string;

beforeAll(async () => {
  const route = createModernMcpRoute({
    buildServer,
    onerror: (e) => reportedErrors.push(e),
    requestTimeoutMs: 60000,
  });
  const app = express();
  app.use(express.json());
  app.post("/mcp", fakeBearer, async (req: PReq, res: Response) => {
    const modern = await route.isModern(req);
    classified.push(modern);
    if (!modern) {
      res.status(299).json({ leg: "legacy" });
      return;
    }
    await route.handle(req, res);
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("test server has no TCP address");
  }
  url = `http://127.0.0.1:${addr.port}/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  factoryCalls.length = 0;
  classified.length = 0;
  reportedErrors.length = 0;
  factoryThrow = undefined;
  vi.restoreAllMocks();
});

async function callTool(
  name: string,
  args: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<globalThis.Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      ...MODERN_HEADERS,
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
      ...extraHeaders,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args, _meta: META },
    }),
  });
}

async function toolText(res: globalThis.Response): Promise<string> {
  const ct = res.headers.get("content-type") ?? "";
  const raw = await res.text();
  const json = ct.includes("text/event-stream")
    ? raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice("data:".length).trim())
        .join("")
    : raw;
  const msg: unknown = JSON.parse(json);
  const result: unknown =
    typeof msg === "object" && msg !== null
      ? Reflect.get(msg, "result")
      : undefined;
  const content: unknown =
    typeof result === "object" && result !== null
      ? Reflect.get(result, "content")
      : undefined;
  const first: unknown = Array.isArray(content) ? content[0] : undefined;
  const text: unknown =
    typeof first === "object" && first !== null
      ? Reflect.get(first, "text")
      : undefined;
  if (typeof text !== "string") throw new Error(`no tool text in ${raw}`);
  return text;
}

function authInfoOf(seen: unknown): unknown {
  if (typeof seen !== "object" || seen === null) {
    throw new Error("tool output is not an object");
  }
  return Reflect.get(seen, "authInfo");
}

describe("createModernMcpRoute: era classifier", () => {
  it("classifies a modern tools/call body as modern (catches a missing await)", async () => {
    const res = await callTool("echo", { q: "hi" });
    expect(classified).toEqual([true]);
    expect(res.status).toBe(200);
    expect(await toolText(res)).toBe("hi");
  });

  it("classifies a legacy initialize as legacy", async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "legacy-cli", version: "1" },
        },
      }),
    });
    expect(classified).toEqual([false]);
    expect(res.status).toBe(299);
    expect(factoryCalls).toHaveLength(0);
  });

  // R2-A6: a body that is not one JSON-RPC message goes to the legacy leg
  // unless the request claims 2026-07-28.
  async function classifyRaw(
    body: string,
    headers: Record<string, string>,
  ): Promise<boolean | undefined> {
    await fetch(url, { method: "POST", headers, body });
    return classified.at(-1);
  }
  const LEGACY_JSON = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };

  it("classifies {} and [] with no modern claim as legacy", async () => {
    expect(await classifyRaw("{}", LEGACY_JSON)).toBe(false);
    expect(await classifyRaw("[]", LEGACY_JSON)).toBe(false);
    expect(
      await classifyRaw("{}", {
        ...LEGACY_JSON,
        "MCP-Protocol-Version": "2025-06-18",
      }),
    ).toBe(false);
  });

  it("keeps {} with a modern MCP-Protocol-Version header on the modern leg", async () => {
    expect(await classifyRaw("{}", MODERN_HEADERS)).toBe(true);
  });

  it("keeps a batch with a 2026-07-28 element on the modern leg", async () => {
    const element = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { _meta: META },
    };
    expect(await classifyRaw(JSON.stringify([element]), LEGACY_JSON)).toBe(
      true,
    );
  });
});

describe("createModernMcpRoute: authInfo spread order", () => {
  it("a tool sees sdkAuthInfo, not the raw req.auth", async () => {
    const res = await callTool(
      "whoami",
      {},
      {
        Authorization: "Bearer good-alice",
      },
    );
    expect(res.status).toBe(200);
    const seen: unknown = JSON.parse(await toolText(res));
    expect(authInfoOf(seen)).toEqual({
      token: "good-alice",
      clientId: "cid-alice",
      scopes: ["mcp"],
      extra: { sub: "alice" },
    });
    expect(authInfoOf(seen)).not.toHaveProperty("client_id");
    expect(authInfoOf(seen)).not.toHaveProperty("sub");
  });

  it("an anonymous call gives the tool no authInfo", async () => {
    const res = await callTool("whoami", {});
    const seen: unknown = JSON.parse(await toolText(res));
    expect(authInfoOf(seen)).toBeNull();
  });
});

describe("createModernMcpRoute: factory context", () => {
  it("passes ip, UA, requestSource, authClientId, protocolVersion and clientName", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await callTool(
      "echo",
      { q: "x" },
      {
        Authorization: "Bearer good-bob",
        "User-Agent": "p4-unit-ua/1",
        "X-Pathfinder-Source": "synthetic",
      },
    );
    expect(res.status).toBe(200);
    expect(factoryCalls).toHaveLength(1);
    const ctx = factoryCalls[0];
    expect(ctx.ip).toMatch(/127\.0\.0\.1/);
    expect(ctx.userAgent).toBe("p4-unit-ua/1");
    expect(ctx.requestSource).toBe("synthetic");
    expect(ctx.authClientId).toBe("cid-bob");
    expect(ctx.protocolVersion).toBe("2026-07-28");
    expect(ctx.clientName).toBe("p4-unit-cli");
    expect(ctx.sdkAuthInfo?.clientId).toBe("cid-bob");
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain(
      `[mcp] modern tools/call protocol=2026-07-28 client=p4-unit-cli [${ctx.ip}]`,
    );
  });

  it("an anonymous call gives null authClientId and no sdkAuthInfo", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await callTool("echo", { q: "anon" });
    expect(res.status).toBe(200);
    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0].authClientId).toBeNull();
    expect(factoryCalls[0].sdkAuthInfo).toBeUndefined();
  });

  it("cleans control characters from clientName in the context and the log", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...MODERN_HEADERS,
        "Mcp-Method": "tools/call",
        "Mcp-Name": "echo",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "echo",
          arguments: { q: "y" },
          _meta: {
            ...META,
            "io.modelcontextprotocol/clientInfo": {
              name: "evil\u0007\ncli",
              version: "0",
            },
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(factoryCalls[0].clientName).toBe("evilcli");
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("client=evilcli ["))).toBe(true);
  });
});

describe("createModernMcpRoute: onerror", () => {
  it("a buildServer throw answers 500 and hands the factory error to onerror", async () => {
    factoryThrow = "unit-probe: factory exploded";
    const res = await callTool("echo", { q: "boom" });
    expect(res.status).toBe(500);
    expect(factoryCalls).toHaveLength(1);
    expect(reportedErrors.map((e) => e.message)).toEqual([
      "unit-probe: factory exploded",
    ]);
  });
});

describe("logModernMcpError", () => {
  function spies() {
    return {
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
  }

  it.each([
    "Rejected inbound request (header-mismatch): Mcp-Method does not match",
    "Rejected 2025-era request on a modern-only endpoint (x): y",
    "Unsupported Media Type: Content-Type must be application/json",
  ])("logs a client rejection at warn: %s", (message) => {
    const { warn, error } = spies();
    logModernMcpError(new Error(message));
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toBe(
      `[mcp] modern request rejected: ${message}`,
    );
  });

  it("does not let a client forge a log line through the rejection message", () => {
    const { warn } = spies();
    logModernMcpError(
      new Error(
        "Rejected inbound request (header-mismatch): the body names method tools/list\nFAKE LINE\r\u2028more",
      ),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(
      line
        .split(/\r\n|\r|\n|\u2028|\u2029/)
        .some((l) => l.startsWith("FAKE LINE")),
    ).toBe(false);
    expect(line).toContain("tools/list?FAKE LINE");
  });

  it("logs an unsupported protocol version at warn", () => {
    const { warn, error } = spies();
    logModernMcpError(
      new UnsupportedProtocolVersionError({
        supported: ["2026-07-28"],
        requested: "2099-01-01",
      }),
    );
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("logs a missing client capability at warn", () => {
    const { warn, error } = spies();
    logModernMcpError(
      new MissingRequiredClientCapabilityError({
        requiredCapabilities: { sampling: {} },
      }),
    );
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("logs any other failure at error, with the stack", () => {
    const { warn, error } = spies();
    const e = new Error("db pool gone");
    logModernMcpError(e);
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toBe("[mcp] modern handler error:");
    expect(error.mock.calls[0][1]).toBe(e.stack);
  });
});

describe("createModernMcpRoute: concurrent-request isolation", () => {
  // Three overlapping requests must each see only their own context. A
  // barrier holds every request until all three have arrived, then releases
  // them together, so each handle() starts before any factory or tool runs.
  // A shared "current ctx" in place of als.run would hand the last caller's
  // sdkAuthInfo to every tool.
  const N = 3;
  let cServer: Server;
  let cUrl: string;
  let arrived = 0;
  let release: () => void = () => {};
  let gate: Promise<void> = Promise.resolve();

  beforeAll(async () => {
    const route = createModernMcpRoute({
      buildServer,
      onerror: (e) => reportedErrors.push(e),
      requestTimeoutMs: 60000,
    });
    const app = express();
    app.use(express.json());
    app.post("/mcp", fakeBearer, async (req: PReq, res: Response) => {
      arrived += 1;
      if (arrived === N) release();
      await gate;
      await route.handle(req, res);
    });
    await new Promise<void>((resolve) => {
      cServer = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = cServer.address();
    if (addr === null || typeof addr === "string") {
      throw new Error("concurrency test server has no TCP address");
    }
    cUrl = `http://127.0.0.1:${addr.port}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => cServer.close(() => resolve()));
  });

  function whoamiAt(auth: string | null): Promise<globalThis.Response> {
    return fetch(cUrl, {
      method: "POST",
      headers: {
        ...MODERN_HEADERS,
        "Mcp-Method": "tools/call",
        "Mcp-Name": "whoami",
        ...(auth === null ? {} : { Authorization: auth }),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "whoami", arguments: {}, _meta: META },
      }),
    });
  }

  it("alice, bob and an anonymous caller each see only their own authInfo", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    arrived = 0;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const [alice, bob, anon] = await Promise.all([
      whoamiAt("Bearer good-alice"),
      whoamiAt("Bearer good-bob"),
      whoamiAt(null),
    ]);
    expect(arrived).toBe(N);
    expect(authInfoOf(JSON.parse(await toolText(alice)))).toEqual({
      token: "good-alice",
      clientId: "cid-alice",
      scopes: ["mcp"],
      extra: { sub: "alice" },
    });
    expect(authInfoOf(JSON.parse(await toolText(bob)))).toEqual({
      token: "good-bob",
      clientId: "cid-bob",
      scopes: ["mcp"],
      extra: { sub: "bob" },
    });
    expect(authInfoOf(JSON.parse(await toolText(anon)))).toBeNull();
    // The factory saw three distinct contexts, one per caller.
    expect(factoryCalls.map((c) => c.authClientId).sort()).toEqual([
      "cid-alice",
      "cid-bob",
      null,
    ]);
  });
});
