/**
 * StartedServer.stop(): what it closes, and how startInProcessServer() uses
 * it on a failure.
 *
 * stop() must close the server even when the bind has not finished yet, so
 * a late bind cannot leave a listening server behind. startServer() calls
 * app.listen(port) with no host, and Node binds that synchronously, so the
 * server is already listening when startServer() resolves. To get a bind
 * that is still pending when stop() runs, the first test adds the host
 * "localhost" to that one listen() call. Node then looks the host up with
 * dns.lookup() before it binds. That test calls startServer() directly, not
 * startInProcessServer(), because the helper waits for "listening".
 */
import dns from "node:dns";
import net from "node:net";
import { describe, it, expect, vi, afterAll, afterEach } from "vitest";

vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  getConfig: vi.fn().mockReturnValue({
    port: 0,
    databaseUrl: "pglite:///tmp/test-started-server-stop",
    openaiApiKey: "",
    githubToken: "",
    githubWebhookSecret: "",
    nodeEnv: "test",
    logLevel: "info",
    cloneDir: "/tmp/test-started-server-stop",
    slackBotToken: "",
    slackSigningSecret: "",
    discordBotToken: "",
    discordPublicKey: "",
    notionToken: "",
    mcpJwtSecret: "f".repeat(64),
    p2pTelemetryUrl: undefined,
    p2pTelemetryDisabled: true,
    packageVersion: "test",
  }),
  getServerConfig: vi.fn().mockReturnValue({
    server: {
      name: "pathfinder-started-server-stop",
      version: "0.0.0",
      max_sessions_per_ip: 50,
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

import { startServer } from "../server.js";
import { startInProcessServer } from "./helpers/inProcessServer.js";

/** Make the next listen() on any server bind to "localhost", so it is pending. */
function deferNextBindToLocalhost(): void {
  const realListen = net.Server.prototype.listen;
  vi.spyOn(net.Server.prototype, "listen").mockImplementationOnce(function (
    this: net.Server,
    ...args: unknown[]
  ): net.Server {
    const [port, ...rest] = args;
    return Reflect.apply(realListen, this, [port, "localhost", ...rest]);
  });
}

/**
 * Resolve once the next dns.lookup("localhost") has called back and the
 * work that callback scheduled (a bind, then a nextTick "listening") has run.
 */
function nextLocalhostLookupSettled(): Promise<void> {
  const realLookup = dns.lookup;
  return new Promise((resolve) => {
    const spy = vi.spyOn(dns, "lookup").mockImplementation(((
      ...args: unknown[]
    ) => {
      const last = args.length - 1;
      const callback = args[last];
      if (args[0] === "localhost" && typeof callback === "function") {
        spy.mockRestore();
        args[last] = (...result: unknown[]) => {
          Reflect.apply(callback, undefined, result);
          setImmediate(resolve);
        };
      }
      return Reflect.apply(realLookup, dns, args);
    }) as typeof dns.lookup);
  });
}

/** Close `server` for real if a test left it listening. */
async function closeIfListening(server: net.Server): Promise<void> {
  if (server.listening) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("StartedServer.stop()", () => {
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("closes a server whose bind is still pending, so it never listens", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const lookupSettled = nextLocalhostLookupSettled();
    deferNextBindToLocalhost();
    const started = await startServer({ port: 0 });
    vi.mocked(net.Server.prototype.listen).mockRestore();
    let listened = false;
    started.server.on("listening", () => (listened = true));
    try {
      expect(started.server.listening).toBe(false);
      await started.stop();
      // Wait for the pending lookup to call back. A bind that stop() did not
      // cancel happens in that callback.
      await lookupSettled;
      expect(listened).toBe(false);
      expect(started.server.listening).toBe(false);
    } finally {
      await closeIfListening(started.server);
    }
  });
});

describe("startInProcessServer() failure path", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Spy on listen() to capture the server that startServer() creates. */
  function captureServer(): () => net.Server {
    let captured: net.Server | undefined;
    const realListen = net.Server.prototype.listen;
    vi.spyOn(net.Server.prototype, "listen").mockImplementationOnce(function (
      this: net.Server,
      ...args: unknown[]
    ): net.Server {
      captured = this;
      return Reflect.apply(realListen, this, args);
    });
    return () => {
      if (!captured) throw new Error("startServer() did not call listen()");
      return captured;
    };
  }

  it("calls stop() and rethrows the original error", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const baseSigterm = process.listenerCount("SIGTERM");
    const server = captureServer();
    vi.spyOn(net.Server.prototype, "address").mockReturnValueOnce(null);
    try {
      await expect(startInProcessServer()).rejects.toThrow(
        "expected a TCP address, got null",
      );
      // stop() ran: the listener is closed and the signal listener is gone.
      expect(server().listening).toBe(false);
      expect(process.listenerCount("SIGTERM")).toBe(baseSigterm);
    } finally {
      await closeIfListening(server());
    }
  });

  it("keeps the original error when stop() also fails", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const server = captureServer();
    vi.spyOn(net.Server.prototype, "address").mockReturnValueOnce(null);
    const closeErr = new Error("close failed");
    vi.spyOn(net.Server.prototype, "close").mockImplementationOnce(function (
      this: net.Server,
      callback?: (err?: Error) => void,
    ): net.Server {
      callback?.(closeErr);
      return this;
    });
    try {
      const err: unknown = await startInProcessServer().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AggregateError);
      if (!(err instanceof AggregateError)) return;
      expect(err.errors).toHaveLength(2);
      expect(String(err.errors[0])).toContain(
        "expected a TCP address, got null",
      );
      expect(err.errors[1]).toBe(closeErr);
      expect(err.cause).toBe(err.errors[0]);
    } finally {
      vi.mocked(net.Server.prototype.close).mockRestore();
      await closeIfListening(server());
    }
  });
});
