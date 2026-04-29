import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock config module so we can throw from getConfig() deterministically. The
// module factory reads mock state via closures so per-test overrides work.
const configState: {
  throwFrom: "getConfig" | "getServerConfig" | null;
  error: Error;
} = {
  throwFrom: null,
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
        allowlist: [],
        trust_proxy: false,
      },
      sources: [],
      tools: [],
    };
  }),
  getAnalyticsConfig: vi.fn(),
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
});
