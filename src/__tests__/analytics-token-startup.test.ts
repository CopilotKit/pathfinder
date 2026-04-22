/**
 * R4-8 — assertAnalyticsTokenConfigured.
 *
 * When analytics is enabled AND nodeEnv=production AND no token is configured
 * (via analytics.token config or ANALYTICS_TOKEN env var), the server MUST
 * fail loudly at startup instead of auto-generating a process-ephemeral
 * token. Multi-replica deployments with per-replica auto-generated tokens
 * caused dashboards to intermittently 401 when their session landed on a
 * different replica than the one that minted the token.
 */
import { describe, it, expect } from "vitest";

describe("assertAnalyticsTokenConfigured (R4-8)", () => {
  it("throws when analytics.enabled && production && no token anywhere", async () => {
    const { assertAnalyticsTokenConfigured } = await import("../server.js");
    expect(() =>
      assertAnalyticsTokenConfigured({
        nodeEnv: "production",
        analyticsEnabled: true,
        configuredToken: undefined,
        envToken: undefined,
      }),
    ).toThrow(/ANALYTICS_TOKEN/);
  });

  it("passes when configured via analytics.token", async () => {
    const { assertAnalyticsTokenConfigured } = await import("../server.js");
    expect(() =>
      assertAnalyticsTokenConfigured({
        nodeEnv: "production",
        analyticsEnabled: true,
        configuredToken: "abc123",
        envToken: undefined,
      }),
    ).not.toThrow();
  });

  it("passes when ANALYTICS_TOKEN env var is set", async () => {
    const { assertAnalyticsTokenConfigured } = await import("../server.js");
    expect(() =>
      assertAnalyticsTokenConfigured({
        nodeEnv: "production",
        analyticsEnabled: true,
        configuredToken: undefined,
        envToken: "env-secret",
      }),
    ).not.toThrow();
  });

  it("passes when analytics is disabled in production (nothing to auth)", async () => {
    const { assertAnalyticsTokenConfigured } = await import("../server.js");
    expect(() =>
      assertAnalyticsTokenConfigured({
        nodeEnv: "production",
        analyticsEnabled: false,
        configuredToken: undefined,
        envToken: undefined,
      }),
    ).not.toThrow();
  });

  it("passes in development without a token (auto-generation still allowed)", async () => {
    const { assertAnalyticsTokenConfigured } = await import("../server.js");
    expect(() =>
      assertAnalyticsTokenConfigured({
        nodeEnv: "development",
        analyticsEnabled: true,
        configuredToken: undefined,
        envToken: undefined,
      }),
    ).not.toThrow();
  });

  it("treats empty-string tokens as not configured (production fail)", async () => {
    const { assertAnalyticsTokenConfigured } = await import("../server.js");
    expect(() =>
      assertAnalyticsTokenConfigured({
        nodeEnv: "production",
        analyticsEnabled: true,
        configuredToken: "",
        envToken: "",
      }),
    ).toThrow(/ANALYTICS_TOKEN/);
  });
});
