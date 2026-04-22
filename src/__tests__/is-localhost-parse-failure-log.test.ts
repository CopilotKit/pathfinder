/**
 * R3 #14 — isLocalhostReq swallowed ipaddr.parse failures in a bare
 * `catch {}`, so an address that doesn't parse (e.g. a corrupt socket
 * peer, a test harness providing "" or a garbage value) returns false
 * silently. In production, a persistent parse failure on the auth-mode
 * path would make the analytics dev-bypass stop working with zero log
 * signal — an operator would have to bisect through the handler to see
 * that the parse was the root cause.
 *
 * Fix: add a warn-level log on the parse failure so the reason is
 * visible without widening the return contract (still returns false).
 * Warn (not debug) because this path only fires on malformed peer
 * addresses, which is rare enough that warn isn't spammy and is visible
 * in production log aggregators that filter out debug.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { __isLocalhostReqForTesting } from "../server.js";
import type { Request } from "express";

describe("isLocalhostReq parse-failure warn log (R3 #14)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  function makeReq(remoteAddress: string): Request {
    return {
      socket: { remoteAddress },
      ip: remoteAddress,
    } as unknown as Request;
  }

  it("returns false and emits a warn log when ipaddr.parse throws", () => {
    // "not-an-ip" is syntactically invalid, so ipaddr.parse will throw.
    const result = __isLocalhostReqForTesting(makeReq("not-an-ip"));
    expect(result).toBe(false);
    const joined = warnSpy.mock.calls.flat().map(String).join(" ");
    expect(joined).toMatch(/isLocalhostReq|parse/);
    expect(joined).toContain("not-an-ip");
  });

  it("does NOT emit a warn log on empty remote address (handled by early return)", () => {
    const result = __isLocalhostReqForTesting(makeReq(""));
    expect(result).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns true for 127.0.0.1 without emitting a parse-failure log", () => {
    const result = __isLocalhostReqForTesting(makeReq("127.0.0.1"));
    expect(result).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
