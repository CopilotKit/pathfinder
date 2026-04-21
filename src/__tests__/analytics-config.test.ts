import { describe, it, expect } from "vitest";
import { AnalyticsConfigSchema, ServerConfigSchema } from "../types.js";

describe("AnalyticsConfigSchema", () => {
  it("accepts a fully specified config", () => {
    const result = AnalyticsConfigSchema.safeParse({
      enabled: true,
      log_queries: true,
      token: "secret-token-123",
      retention_days: 30,
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      enabled: true,
      log_queries: true,
      token: "secret-token-123",
      retention_days: 30,
    });
  });

  it("applies defaults for missing optional fields", () => {
    const result = AnalyticsConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      enabled: false,
      log_queries: true,
      retention_days: 90,
    });
  });

  it("rejects empty token string", () => {
    const result = AnalyticsConfigSchema.safeParse({
      enabled: true,
      token: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-positive retention_days", () => {
    const result = AnalyticsConfigSchema.safeParse({
      retention_days: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative retention_days", () => {
    const result = AnalyticsConfigSchema.safeParse({
      retention_days: -1,
    });
    expect(result.success).toBe(false);
  });

  // Single parametrized test replaces the two near-duplicate
  // "rejects non-integer / fractional retention_days" cases; covers
  // typical fractional inputs (whole.5, whole.7) and a floating-point
  // boundary near zero that an `n > 0 && n === Math.floor(n)` check
  // would have to reject.
  it.each([30.5, 30.7, 0.1, 1e-9])(
    "rejects fractional retention_days %s",
    (val) => {
      const result = AnalyticsConfigSchema.safeParse({
        retention_days: val,
      });
      expect(result.success).toBe(false);
    },
  );

  it("accepts very large retention_days", () => {
    const result = AnalyticsConfigSchema.safeParse({
      retention_days: 3650, // 10 years
    });
    expect(result.success).toBe(true);
  });
});

describe("ServerConfigSchema with analytics", () => {
  const minimalServerConfig = {
    server: { name: "test", version: "1.0.0" },
    sources: [
      {
        name: "s",
        type: "markdown",
        path: ".",
        file_patterns: ["**/*.md"],
        chunk: {},
      },
    ],
    tools: [
      { name: "bash", type: "bash", description: "bash", sources: ["s"] },
    ],
  };

  it("accepts config without analytics section", () => {
    const result = ServerConfigSchema.safeParse(minimalServerConfig);
    expect(result.success).toBe(true);
    expect(result.data!.analytics).toBeUndefined();
  });

  it("accepts config with analytics section", () => {
    const result = ServerConfigSchema.safeParse({
      ...minimalServerConfig,
      analytics: { enabled: true, token: "abc123" },
    });
    expect(result.success).toBe(true);
    expect(result.data!.analytics?.enabled).toBe(true);
    expect(result.data!.analytics?.token).toBe("abc123");
  });
});
