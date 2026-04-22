/**
 * R3 #14 — isLocalhostReq swallowed ipaddr.parse failures in a bare
 * `catch {}`, so an address that doesn't parse (e.g. a corrupt socket
 * peer, a test harness providing "" or a garbage value) returns false
 * silently. In production, a persistent parse failure on the auth-mode
 * path would make the analytics dev-bypass stop working with zero log
 * signal — an operator would have to bisect through the handler to see
 * that the parse was the root cause.
 *
 * Fix: add a debug-level log on the parse failure so the reason is
 * visible without widening the return contract (still returns false).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { __isLocalhostReqForTesting } from "../server.js";
import type { Request } from "express";

describe("isLocalhostReq parse-failure debug log (R3 #14)", () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });
  afterEach(() => {
    debugSpy.mockRestore();
  });

  function makeReq(remoteAddress: string): Request {
    return {
      socket: { remoteAddress },
      ip: remoteAddress,
    } as unknown as Request;
  }

  it("returns false and emits a debug log when ipaddr.parse throws", () => {
    // "not-an-ip" is syntactically invalid, so ipaddr.parse will throw.
    const result = __isLocalhostReqForTesting(makeReq("not-an-ip"));
    expect(result).toBe(false);
    const joined = debugSpy.mock.calls.flat().map(String).join(" ");
    expect(joined).toMatch(/isLocalhostReq|parse/);
    expect(joined).toContain("not-an-ip");
  });

  it("does NOT emit a debug log on empty remote address (handled by early return)", () => {
    const result = __isLocalhostReqForTesting(makeReq(""));
    expect(result).toBe(false);
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("returns true for 127.0.0.1 without emitting a parse-failure log", () => {
    const result = __isLocalhostReqForTesting(makeReq("127.0.0.1"));
    expect(result).toBe(true);
    expect(debugSpy).not.toHaveBeenCalled();
  });
});
