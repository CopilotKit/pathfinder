import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveJwtSecret, resetJwtSecretCache } from "../oauth/secret.js";

describe("resolveJwtSecret", () => {
  const savedSecret = process.env.MCP_JWT_SECRET;

  beforeEach(() => {
    resetJwtSecretCache();
    delete process.env.MCP_JWT_SECRET;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetJwtSecretCache();
    if (savedSecret === undefined) {
      delete process.env.MCP_JWT_SECRET;
    } else {
      process.env.MCP_JWT_SECRET = savedSecret;
    }
  });

  it("development + env unset → generates 32-byte hex and warns", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const secret = resolveJwtSecret({ nodeEnv: "development" });
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("same call twice returns same string (cached)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = resolveJwtSecret({ nodeEnv: "development" });
    const b = resolveJwtSecret({ nodeEnv: "development" });
    expect(a).toBe(b);
  });

  it("production + env unset → throws", () => {
    expect(() => resolveJwtSecret({ nodeEnv: "production" })).toThrow(
      /MCP_JWT_SECRET/,
    );
  });

  it("production + env set → returns env value, no warning", () => {
    process.env.MCP_JWT_SECRET = "x".repeat(64);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const secret = resolveJwtSecret({ nodeEnv: "production" });
    expect(secret).toBe("x".repeat(64));
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("rejects secret < 16 bytes in development", () => {
    process.env.MCP_JWT_SECRET = "short";
    expect(() => resolveJwtSecret({ nodeEnv: "development" })).toThrow(
      /at least 16/,
    );
  });

  it("rejects secret < 16 bytes in production", () => {
    process.env.MCP_JWT_SECRET = "short";
    expect(() => resolveJwtSecret({ nodeEnv: "production" })).toThrow(
      /at least 16/,
    );
  });
});
