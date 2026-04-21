import { describe, it, expect } from "vitest";
import type { Request } from "express";
import { clientIp } from "../ip-util.js";

/**
 * Minimal Request-shaped object. We construct the exact surface area clientIp
 * reads (ip, socket.remoteAddress, headers) so we don't have to stand up a
 * full Express stack — these tests verify the contract, not the Express
 * proxy-trust machinery itself.
 */
function makeReq(opts: {
  ip?: string;
  remoteAddress?: string;
  xff?: string;
}): Request {
  const headers: Record<string, string> = {};
  if (opts.xff !== undefined) headers["x-forwarded-for"] = opts.xff;
  return {
    ip: opts.ip,
    socket: {
      remoteAddress: opts.remoteAddress,
    } as unknown as Request["socket"],
    headers,
  } as unknown as Request;
}

describe("clientIp", () => {
  describe("trustProxy=false (default, hardened)", () => {
    it("returns socket.remoteAddress and IGNORES X-Forwarded-For (spoof defense)", () => {
      // This is the security-critical case: an attacker sends
      // `X-Forwarded-For: 160.79.106.35` trying to impersonate the
      // allowlisted Anthropic crawler. The helper MUST return the socket
      // address, not the header.
      const req = makeReq({
        xff: "160.79.106.35",
        remoteAddress: "203.0.113.99",
        // Express would populate `ip` from the XFF chain if it were
        // configured to trust a proxy — but trustProxy=false, so we
        // refuse to consult `req.ip` at all.
        ip: "160.79.106.35",
      });
      expect(clientIp(req, false)).toBe("203.0.113.99");
    });

    it("returns socket.remoteAddress when no X-Forwarded-For is present", () => {
      const req = makeReq({ remoteAddress: "198.51.100.7" });
      expect(clientIp(req, false)).toBe("198.51.100.7");
    });

    it("returns 'unknown' when socket.remoteAddress is missing", () => {
      const req = makeReq({ xff: "1.2.3.4" });
      expect(clientIp(req, false)).toBe("unknown");
    });

    it("treats empty-string socket.remoteAddress as 'unknown' (post-disconnect / HTTP/2 edge)", () => {
      // `??` does not coalesce "" — if socket.remoteAddress is the empty
      // string (observed after abrupt disconnects, in some HTTP/2 upgrade
      // paths, and in test mocks), the rate limiter would bucket every
      // such caller into a single "" counter, letting one client DoS every
      // other client in that state. Force the empty string to fall
      // through to "unknown" instead.
      const req = makeReq({ remoteAddress: "", xff: "1.2.3.4" });
      expect(clientIp(req, false)).toBe("unknown");
    });

    it("returns 'unknown' when socket.remoteAddress is the empty string and no XFF is present", () => {
      const req = makeReq({ remoteAddress: "" });
      expect(clientIp(req, false)).toBe("unknown");
    });
  });

  describe("trustProxy=true (behind a trusted reverse proxy)", () => {
    it("returns req.ip (Express populates this from the configured trust chain)", () => {
      // When Express is configured with `app.set('trust proxy', true)` the
      // framework itself walks the XFF chain and assigns the result to
      // `req.ip`. We rely on that — we do NOT re-parse XFF ourselves.
      const req = makeReq({
        ip: "160.79.106.35",
        xff: "160.79.106.35",
        remoteAddress: "10.0.0.1",
      });
      expect(clientIp(req, true)).toBe("160.79.106.35");
    });

    it("falls back to socket.remoteAddress when req.ip is unset", () => {
      // Defensive: if req.ip is somehow undefined even with trustProxy=true
      // (e.g. test harness shortcut), don't crash — return the socket.
      const req = makeReq({ remoteAddress: "10.0.0.2" });
      expect(clientIp(req, true)).toBe("10.0.0.2");
    });

    it("returns 'unknown' when both req.ip and socket.remoteAddress are missing", () => {
      const req = makeReq({});
      expect(clientIp(req, true)).toBe("unknown");
    });

    it("falls through to socket.remoteAddress when req.ip is the empty string", () => {
      // If Express somehow left req.ip as "" (rather than undefined), `??`
      // would preserve it and the limiter would then key every such
      // request into a single "" counter. Treat "" the same as undefined
      // and keep walking the fallback chain.
      const req = makeReq({ ip: "", remoteAddress: "5.6.7.8" });
      expect(clientIp(req, true)).toBe("5.6.7.8");
    });

    it("returns 'unknown' when req.ip and socket.remoteAddress are both the empty string", () => {
      const req = makeReq({ ip: "", remoteAddress: "" });
      expect(clientIp(req, true)).toBe("unknown");
    });
  });
});
