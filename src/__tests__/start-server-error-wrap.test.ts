import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock config module so we can throw from getConfig() deterministically. The
// module factory reads mock state via closures so per-test overrides work.
const configState: {
  throwFrom: "getConfig" | "getServerConfig" | null;
  error: Error;
  allowlist: string[];
} = {
  throwFrom: null,
  allowlist: [],
  error: new Error("synthetic config failure"),
};

vi.mock("../config.js", () => ({
  getConfig: vi.fn(() => {
    if (configState.throwFrom === "getConfig") throw configState.error;
    return {
      port: 0,
      databaseUrl: "pglite:///tmp/test-startserver-wrap",
      openaiApiKey: "",
      githubToken: "",
      githubWebhookSecret: "",
      nodeEnv: "test",
      logLevel: "info",
      cloneDir: "/tmp/test-startserver-wrap",
      slackBotToken: "",
      slackSigningSecret: "",
      discordBotToken: "",
      discordPublicKey: "",
      notionToken: "",
      mcpJwtSecret: "x".repeat(32),
      p2pTelemetryUrl: undefined,
      p2pTelemetryDisabled: false,
      packageVersion: "test",
    };
  }),
  getServerConfig: vi.fn(() => {
    if (configState.throwFrom === "getServerConfig") throw configState.error;
    return {
      server: {
        name: "test-server",
        version: "0.0.0",
        max_sessions_per_ip: 20,
        session_ttl_minutes: 30,
        allowlist: configState.allowlist,
        trust_proxy: false,
      },
      sources: [],
      tools: [],
    };
  }),
  getAnalyticsConfig: vi.fn(),
  assertDocumentPeerDepsForSources: vi.fn().mockResolvedValue(undefined),
  assertLocalEmbeddingDepForProvider: vi.fn().mockResolvedValue(undefined),
  hasSearchTools: vi.fn().mockReturnValue(false),
  hasKnowledgeTools: vi.fn().mockReturnValue(false),
  hasCollectTools: vi.fn().mockReturnValue(false),
  hasBashSemanticSearch: vi.fn().mockReturnValue(false),
}));

import { startServer } from "../server.js";

describe("startServer top-level error wrapping (R3 #4)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    configState.throwFrom = null;
    configState.allowlist = [];
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("logs '[startup] fatal:' and re-throws when getConfig throws", async () => {
    configState.throwFrom = "getConfig";
    configState.error = new Error("config.yaml not found");

    await expect(startServer()).rejects.toThrow("config.yaml not found");

    // At least one console.error call must carry the '[startup] fatal:'
    // prefix plus the underlying error — operators grep this prefix to
    // correlate startup failures in logs.
    const fatalCalls = errorSpy.mock.calls.filter((args: unknown[]) => {
      const msg = String(args[0] ?? "");
      return msg.includes("[startup] fatal:");
    });
    expect(fatalCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("logs '[startup] fatal:' and re-throws when getServerConfig throws", async () => {
    configState.throwFrom = "getServerConfig";
    configState.error = new Error("invalid YAML");

    await expect(startServer()).rejects.toThrow("invalid YAML");

    const fatalCalls = errorSpy.mock.calls.filter((args: unknown[]) => {
      const msg = String(args[0] ?? "");
      return msg.includes("[startup] fatal:");
    });
    expect(fatalCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("startup allowlist line names the session cap and the modern per-IP rate limit, not the in-flight ceiling", async () => {
    configState.allowlist = ["10.0.0.1"];
    // Abort boot right after the allowlist line so the test never reaches
    // database or listener setup.
    const logSpy = vi.spyOn(console, "log").mockImplementation((msg) => {
      if (String(msg).includes("[startup] IP allowlist:")) {
        throw new Error("stop-after-allowlist-line");
      }
    });
    try {
      await expect(startServer()).rejects.toThrow("stop-after-allowlist-line");
      const line = logSpy.mock.calls
        .map((args: unknown[]) => String(args[0] ?? ""))
        .find((m) => m.includes("[startup] IP allowlist:"));
      expect(line).toBeDefined();
      expect(line).toContain("1 entry");
      expect(line).toContain("max_sessions_per_ip");
      expect(line).toContain(
        "modern per-IP rate limit when PATHFINDER_MODERN_PROTOCOL is on",
      );
    } finally {
      logSpy.mockRestore();
    }
  });
});
