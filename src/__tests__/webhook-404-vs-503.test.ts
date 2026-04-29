/**
 * R3 #2 — distinguish 404 (no sources of that type configured) from 503
 * (sources exist but handler isn't attached yet because startup is still
 * in progress).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import http from "node:http";

const mockGetConfig = vi.fn();
const mockGetServerConfig = vi.fn();
const mockGetAnalyticsConfig = vi.fn();

vi.mock("../config.js", () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
  getServerConfig: (...args: unknown[]) => mockGetServerConfig(...args),
  getAnalyticsConfig: (...args: unknown[]) => mockGetAnalyticsConfig(...args),
  hasSearchTools: vi.fn().mockReturnValue(false),
  hasKnowledgeTools: vi.fn().mockReturnValue(false),
  hasCollectTools: vi.fn().mockReturnValue(false),
  hasBashSemanticSearch: vi.fn().mockReturnValue(false),
}));

beforeEach(() => {
  mockGetConfig.mockReturnValue({
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
    p2pTelemetryUrl: undefined,
    p2pTelemetryDisabled: false,
    packageVersion: "test",
  });
  mockGetServerConfig.mockReturnValue({
    server: { name: "pathfinder-test", version: "0.0.0" },
    sources: [],
    tools: [],
  });
  mockGetAnalyticsConfig.mockReturnValue(undefined);
});

describe("classifyWebhookUnavailable (R3 #2)", () => {
  it("returns 404 not-configured when no sources of that type exist", async () => {
    const { classifyWebhookUnavailable } = await import("../server.js");
    mockGetServerConfig.mockReturnValue({
      server: { name: "t", version: "0.0.0" },
      sources: [{ name: "docs", type: "website" }],
      tools: [],
    });
    const r = classifyWebhookUnavailable({ sourceType: "github" });
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/not configured/i);
  });

  it("returns 503 still-initializing when sources exist but handler not ready", async () => {
    const { classifyWebhookUnavailable } = await import("../server.js");
    mockGetServerConfig.mockReturnValue({
      server: { name: "t", version: "0.0.0" },
      sources: [{ name: "repo", type: "github" }],
      tools: [],
    });
    const r = classifyWebhookUnavailable({ sourceType: "github" });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/initializing/i);
  });

  it("works for slack and discord source types", async () => {
    const { classifyWebhookUnavailable } = await import("../server.js");
    mockGetServerConfig.mockReturnValue({
      server: { name: "t", version: "0.0.0" },
      sources: [{ name: "s", type: "slack" }],
      tools: [],
    });
    expect(classifyWebhookUnavailable({ sourceType: "slack" }).status).toBe(
      503,
    );
    expect(classifyWebhookUnavailable({ sourceType: "discord" }).status).toBe(
      404,
    );
  });
});
