import { describe, it, expect } from "vitest";
import {
  JSONRPC_CAPACITY_CODE,
  JSONRPC_RATE_LIMIT_CODE,
  buildCapacityPayload,
} from "../rate-limit-response.js";

describe("JSONRPC_CAPACITY_CODE", () => {
  it("is -32006", () => {
    expect(JSONRPC_CAPACITY_CODE).toBe(-32006);
  });

  it("is distinct from the rate-limit code (-32005)", () => {
    expect(JSONRPC_CAPACITY_CODE).not.toBe(JSONRPC_RATE_LIMIT_CODE);
  });

  it("lives in the JSON-RPC server-error range (-32000..-32099)", () => {
    expect(JSONRPC_CAPACITY_CODE).toBeGreaterThanOrEqual(-32099);
    expect(JSONRPC_CAPACITY_CODE).toBeLessThanOrEqual(-32000);
  });
});

describe("buildCapacityPayload", () => {
  it("returns correct fields for normal inputs", () => {
    const payload = buildCapacityPayload({
      totalSessions: 500,
      maxSessions: 500,
      retryAfterSeconds: 30,
    });

    expect(payload.error).toBe("capacity_exceeded");
    expect(payload.reason).toBe("server-capacity");
    expect(payload.totalSessions).toBe(500);
    expect(payload.maxSessions).toBe(500);
    expect(payload.retryAfterSeconds).toBe(30);
    expect(payload.contact).toBe("oss@copilotkit.ai");
  });

  it("clamps retryAfterSeconds via the shared clamper (999 -> 300)", () => {
    const payload = buildCapacityPayload({
      totalSessions: 100,
      maxSessions: 100,
      retryAfterSeconds: 999,
    });
    expect(payload.retryAfterSeconds).toBe(300);
  });

  it("defaults NaN retryAfterSeconds to 60 via the shared clamper", () => {
    const payload = buildCapacityPayload({
      totalSessions: 100,
      maxSessions: 100,
      retryAfterSeconds: Number.NaN,
    });
    expect(payload.retryAfterSeconds).toBe(60);
  });

  it("defaults negative retryAfterSeconds to 60", () => {
    const payload = buildCapacityPayload({
      totalSessions: 100,
      maxSessions: 100,
      retryAfterSeconds: -10,
    });
    expect(payload.retryAfterSeconds).toBe(60);
  });

  it("passes through a within-bounds value unchanged", () => {
    const payload = buildCapacityPayload({
      totalSessions: 200,
      maxSessions: 500,
      retryAfterSeconds: 120,
    });
    expect(payload.retryAfterSeconds).toBe(120);
  });
});
