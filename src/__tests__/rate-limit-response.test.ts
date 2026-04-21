import { describe, it, expect } from "vitest";
import {
  JSONRPC_RATE_LIMIT_CODE,
  buildRateLimitPayload,
  clampRetryAfterSeconds,
  jsonRpcRateLimitError,
} from "../rate-limit-response.js";

describe("buildRateLimitPayload", () => {
  it("returns a fully-populated rejection payload", () => {
    const payload = buildRateLimitPayload({
      limit: 20,
      currentCount: 20,
      retryAfterSeconds: 60,
    });

    expect(payload.error).toBe("rate_limited");
    expect(typeof payload.reason).toBe("string");
    expect(payload.reason.length).toBeGreaterThan(0);
    expect(payload.limit).toBe(20);
    expect(payload.currentCount).toBe(20);
    expect(payload.retryAfterSeconds).toBe(60);
    expect(payload.contact).toBe("oss@copilotkit.ai");
  });

  it("reason mentions the per-IP limit", () => {
    const { reason } = buildRateLimitPayload({
      limit: 5,
      currentCount: 5,
      retryAfterSeconds: 30,
    });
    expect(reason).toMatch(/IP/);
    expect(reason).toContain("5");
  });

  describe("retryAfterSeconds clamp", () => {
    it("clamps a too-large value (1800) down to the 300s upper bound", () => {
      const payload = buildRateLimitPayload({
        limit: 20,
        currentCount: 20,
        retryAfterSeconds: 1800,
      });
      expect(payload.retryAfterSeconds).toBe(300);
    });

    it("defaults NaN to 60", () => {
      const payload = buildRateLimitPayload({
        limit: 20,
        currentCount: 20,
        retryAfterSeconds: Number.NaN,
      });
      expect(payload.retryAfterSeconds).toBe(60);
    });

    it("defaults negative values to 60", () => {
      const payload = buildRateLimitPayload({
        limit: 20,
        currentCount: 20,
        retryAfterSeconds: -5,
      });
      expect(payload.retryAfterSeconds).toBe(60);
    });

    it("defaults zero to 60", () => {
      const payload = buildRateLimitPayload({
        limit: 20,
        currentCount: 20,
        retryAfterSeconds: 0,
      });
      expect(payload.retryAfterSeconds).toBe(60);
    });

    it("defaults Infinity to 60", () => {
      const payload = buildRateLimitPayload({
        limit: 20,
        currentCount: 20,
        retryAfterSeconds: Number.POSITIVE_INFINITY,
      });
      expect(payload.retryAfterSeconds).toBe(60);
    });

    it("passes 1 through unchanged (lower bound is inclusive)", () => {
      const payload = buildRateLimitPayload({
        limit: 20,
        currentCount: 20,
        retryAfterSeconds: 1,
      });
      expect(payload.retryAfterSeconds).toBe(1);
    });

    it("passes 120 through unchanged (within bounds)", () => {
      const payload = buildRateLimitPayload({
        limit: 20,
        currentCount: 20,
        retryAfterSeconds: 120,
      });
      expect(payload.retryAfterSeconds).toBe(120);
    });

    it("floors fractional values to whole seconds", () => {
      // 42.4 is compatible with either floor OR round-to-nearest, so
      // include 42.6 to disambiguate: Math.floor(42.6) === 42, whereas
      // Math.round(42.6) === 43. The floor semantics is authoritative.
      const low = buildRateLimitPayload({
        limit: 20,
        currentCount: 20,
        retryAfterSeconds: 42.4,
      });
      expect(low.retryAfterSeconds).toBe(42);

      const high = buildRateLimitPayload({
        limit: 20,
        currentCount: 20,
        retryAfterSeconds: 42.6,
      });
      expect(high.retryAfterSeconds).toBe(42);
    });

    it("clamps positive sub-second values up to the 1s minimum", () => {
      // 0.5 is > 0 so it does NOT take the default branch. Math.floor(0.5)
      // is 0, which is below RETRY_AFTER_MIN_SECONDS (1), so it clamps UP
      // to 1. This anchors the documented behavior.
      const payload = buildRateLimitPayload({
        limit: 20,
        currentCount: 20,
        retryAfterSeconds: 0.5,
      });
      expect(payload.retryAfterSeconds).toBe(1);
    });
  });

  describe("clampRetryAfterSeconds contract for header callers", () => {
    // CONTRACT: HTTP callers (src/server.ts, src/sse-handlers.ts) MUST use
    // the `retryAfterSeconds` field returned by buildRateLimitPayload (or
    // call clampRetryAfterSeconds directly) when setting the HTTP
    // `Retry-After` header. They MUST NOT pass the raw, unclamped input to
    // the header, otherwise the header value (e.g. 1800) will disagree
    // with the JSON body value (e.g. 300), violating the module's
    // single-sanitized-integer guarantee.
    it("exposes clampRetryAfterSeconds for direct use by header callers", () => {
      expect(typeof clampRetryAfterSeconds).toBe("function");
      expect(clampRetryAfterSeconds(1800)).toBe(300);
      expect(clampRetryAfterSeconds(120)).toBe(120);
      expect(clampRetryAfterSeconds(Number.NaN)).toBe(60);
    });

    it("buildRateLimitPayload with retryAfterSeconds=1800 returns 300 (MAX), which is what callers must use for the Retry-After header", () => {
      const payload = buildRateLimitPayload({
        limit: 20,
        currentCount: 20,
        retryAfterSeconds: 1800,
      });
      // The JSON body carries 300.
      expect(payload.retryAfterSeconds).toBe(300);
      // clampRetryAfterSeconds applied directly to the same raw input
      // produces the same 300. Callers MUST use this value (not the raw
      // 1800) when setting the HTTP Retry-After header, to keep header
      // and body in lockstep.
      expect(clampRetryAfterSeconds(1800)).toBe(payload.retryAfterSeconds);
    });
  });

  describe("reason clarity", () => {
    it("embeds the clamped retry window into the reason string", () => {
      const { reason, retryAfterSeconds } = buildRateLimitPayload({
        limit: 20,
        currentCount: 20,
        retryAfterSeconds: 1800,
      });
      expect(retryAfterSeconds).toBe(300);
      expect(reason).toContain("300");
      expect(reason).toMatch(/retry/i);
    });

    it("reflects the clamped value in the reason even when defaulted from bad input", () => {
      const { reason, retryAfterSeconds } = buildRateLimitPayload({
        limit: 20,
        currentCount: 20,
        retryAfterSeconds: Number.NaN,
      });
      expect(retryAfterSeconds).toBe(60);
      expect(reason).toContain("60");
    });
  });
});

describe("jsonRpcRateLimitError", () => {
  it("produces a JSON-RPC 2.0 error frame with the rate-limit code", () => {
    const frame = jsonRpcRateLimitError("req-1", {
      limit: 20,
      currentCount: 20,
      retryAfterSeconds: 60,
    });
    expect(frame.jsonrpc).toBe("2.0");
    expect(frame.id).toBe("req-1");
    expect(frame.error.code).toBe(JSONRPC_RATE_LIMIT_CODE);
    expect(frame.error.message).toMatch(/rate/i);
    expect(frame.error.data).toMatchObject({
      error: "rate_limited",
      limit: 20,
      currentCount: 20,
      retryAfterSeconds: 60,
      contact: "oss@copilotkit.ai",
    });
  });

  it("accepts null id for initialize requests without an id echo", () => {
    const frame = jsonRpcRateLimitError(null, {
      limit: 1,
      currentCount: 1,
      retryAfterSeconds: 60,
    });
    expect(frame.id).toBeNull();
  });

  it("uses -32000 server-error range for the rate-limit code", () => {
    expect(JSONRPC_RATE_LIMIT_CODE).toBeGreaterThanOrEqual(-32099);
    expect(JSONRPC_RATE_LIMIT_CODE).toBeLessThanOrEqual(-32000);
  });

  it("reflects the clamped retryAfterSeconds in the error data payload", () => {
    const frame = jsonRpcRateLimitError("req-2", {
      limit: 20,
      currentCount: 20,
      retryAfterSeconds: 1800,
    });
    expect(frame.error.data.retryAfterSeconds).toBe(300);
    expect(frame.error.data.reason).toContain("300");
  });
});
