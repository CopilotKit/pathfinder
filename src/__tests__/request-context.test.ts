import { describe, it, expect, expectTypeOf, vi, afterEach } from "vitest";
import type { Request } from "express";
import type { AuthContext } from "../oauth/handlers.js";
import {
  requestContext,
  requestSourceFromHeaders,
  handshakeFromInitialize,
  handshakeOf,
  recordHandshake,
  handshakeFor,
  analyticsContextFields,
  safeLogToken,
  cleanClientString,
  __resetRateLimitedWarnForTesting,
  type SessionAnalyticsContext,
} from "../request-context.js";
import {
  REQUEST_CONTEXT_FIELD_MAX_LEN,
  type QueryLogEntry,
} from "../db/analytics.js";
import { setTrustingProxy } from "../oauth/trusted-client-ip.js";
import { requestSourceFromHeaders as viaServer } from "../server.js";

function mkReq(
  headers: Record<string, string | string[]> = {},
  auth?: AuthContext,
): Request & { auth?: AuthContext } {
  return {
    headers,
    ip: "203.0.113.9",
    socket: { remoteAddress: "198.51.100.1" },
    ...(auth ? { auth } : {}),
  } as unknown as Request & { auth?: AuthContext };
}

describe("requestContext", () => {
  it("returns null authClientId when there is no auth", () => {
    expect(requestContext(mkReq()).authClientId).toBeNull();
  });

  it("returns null authClientId for an empty-string client_id", () => {
    const req = mkReq({}, { sub: "anonymous", client_id: "" });
    expect(requestContext(req).authClientId).toBeNull();
  });

  it("returns the client_id when present", () => {
    const req = mkReq({}, { sub: "anonymous", client_id: "abc" });
    expect(requestContext(req).authClientId).toBe("abc");
  });

  it("never reassigns or mutates req.auth", () => {
    const auth: AuthContext = { sub: "anonymous", client_id: "" };
    const req = mkReq({}, auth);
    requestContext(req);
    expect(req.auth).toBe(auth);
    expect(req.auth).toEqual({ sub: "anonymous", client_id: "" });
  });

  it("uses the first user-agent when the header is an array", () => {
    const req = mkReq({ "user-agent": ["ua-one", "ua-two"] });
    expect(requestContext(req).userAgent).toBe("ua-one");
  });

  it("passes a string user-agent through and leaves absent undefined", () => {
    expect(requestContext(mkReq({ "user-agent": "curl/8" })).userAgent).toBe(
      "curl/8",
    );
    expect(requestContext(mkReq()).userAgent).toBeUndefined();
  });

  it("resolves the request source from X-Pathfinder-Source", () => {
    expect(
      requestContext(mkReq({ "x-pathfinder-source": "synthetic" }))
        .requestSource,
    ).toBe("synthetic");
    expect(requestContext(mkReq()).requestSource).toBe("user");
  });

  describe("ip through the trust-proxy accessor", () => {
    // mkReq models Express behind a proxy: req.ip is what Express resolved
    // from X-Forwarded-For, socket.remoteAddress is the proxy (TCP peer).
    const proxied = () =>
      mkReq({ "x-forwarded-for": "203.0.113.9, 198.51.100.1" });

    afterEach(() => {
      // Back to the fail-safe no-trust accessor (XFF ignored). This file
      // never boots the server, so there is no bootstrap accessor to restore.
      setTrustingProxy(() => false);
    });

    it("untrusted: uses the socket peer and ignores X-Forwarded-For", () => {
      setTrustingProxy(() => false);
      expect(requestContext(proxied()).ip).toBe("198.51.100.1");
    });

    it("trusted: honours the X-Forwarded-For client (req.ip), not the socket peer", () => {
      setTrustingProxy(() => true);
      expect(requestContext(proxied()).ip).toBe("203.0.113.9");
    });

    it("reads the accessor on every call, not once", () => {
      let trust = false;
      setTrustingProxy(() => trust);
      expect(requestContext(proxied()).ip).toBe("198.51.100.1");
      trust = true;
      expect(requestContext(proxied()).ip).toBe("203.0.113.9");
    });
  });
});

describe("safeLogToken", () => {
  it("passes printable ASCII (0x20-0x7e) through unchanged", () => {
    const printable = Array.from({ length: 0x7f - 0x20 }, (_, i) =>
      String.fromCharCode(0x20 + i),
    ).join("");
    expect(safeLogToken(printable)).toBe(printable);
  });

  it("replaces C0 controls, including newline and ESC", () => {
    expect(safeLogToken("a\x00b\x1fc\nd\x1b[31m")).toBe("a?b?c?d?[31m");
  });

  it("replaces DEL (0x7f)", () => {
    expect(safeLogToken("a\x7fb")).toBe("a?b");
  });

  it("replaces C1 controls (0x80-0x9f)", () => {
    expect(safeLogToken("a\x80b\x85c\x9bd\x9fe")).toBe("a?b?c?d?e");
  });

  it("replaces non-ASCII, including a right-to-left override", () => {
    expect(safeLogToken("caf\u00e9")).toBe("caf?");
    expect(safeLogToken("x\u202ey")).toBe("x?y");
    expect(safeLogToken("\u00a0")).toBe("?");
  });
});

describe("requestSourceFromHeaders re-export", () => {
  it("is the same function from server.ts", () => {
    expect(viaServer).toBe(requestSourceFromHeaders);
    expect(viaServer(mkReq({ "x-pathfinder-source": "analysis" }))).toBe(
      "analysis",
    );
  });
});

describe("SessionAnalyticsContext", () => {
  it("has the shared contract shape (compile-time)", () => {
    expectTypeOf<keyof SessionAnalyticsContext>().toEqualTypeOf<
      | "transport"
      | "protocol_era"
      | "protocol_version"
      | "client_name"
      | "auth_client_id"
    >();
  });
});

describe("analyticsContextFields", () => {
  const ctx: SessionAnalyticsContext = {
    transport: "sse",
    protocol_era: "legacy",
    protocol_version: "2025-03-26",
    client_name: "c",
    auth_client_id: "a",
  };
  const NULLS = {
    transport: null,
    protocol_era: null,
    protocol_version: null,
    client_name: null,
    auth_client_id: null,
  };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    __resetRateLimitedWarnForTesting();
  });

  it("maps the accessor's context onto the five fields", () => {
    expect(analyticsContextFields(() => ctx)).toEqual(ctx);
  });

  it("gives nulls for an absent accessor or an undefined context", () => {
    expect(analyticsContextFields(undefined)).toEqual(NULLS);
    expect(analyticsContextFields(() => undefined)).toEqual(NULLS);
  });

  it("gives nulls and warns once per interval, with the error class but not the error text", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const boom = () => {
        throw new TypeError("client-bytes-\x1b[31m");
      };
      expect(analyticsContextFields(boom)).toEqual(NULLS);
      expect(analyticsContextFields(boom)).toEqual(NULLS);
      expect(analyticsContextFields(boom)).toEqual(NULLS);
      expect(warn).toHaveBeenCalledTimes(1);
      const first = String(warn.mock.calls[0][0]);
      expect(first).toMatch(/^\[analytics\]/);
      expect(first).toContain("TypeError");
      expect(first).not.toContain("client-bytes");
      expect(first).not.toContain("suppressed");

      // Still inside the interval: counted, not logged.
      vi.advanceTimersByTime(59_000);
      expect(analyticsContextFields(boom)).toEqual(NULLS);
      expect(warn).toHaveBeenCalledTimes(1);

      // After the interval the next failure logs again, with the count of
      // the three failures it held back.
      vi.advanceTimersByTime(1_000);
      expect(analyticsContextFields(boom)).toEqual(NULLS);
      expect(warn).toHaveBeenCalledTimes(2);
      const second = String(warn.mock.calls[1][0]);
      expect(second).toMatch(/^\[analytics\]/);
      expect(second).toContain("TypeError");
      expect(second).toContain("suppressed 3");
      expect(second).not.toContain("client-bytes");
    } finally {
      warn.mockRestore();
    }
  });

  it("names a non-Error throw by its type", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        analyticsContextFields(() => {
          throw "client-bytes";
        }),
      ).toEqual(NULLS);
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain("string");
      expect(line).not.toContain("client-bytes");
    } finally {
      warn.mockRestore();
    }
  });

  describe("never throws, whatever the accessor throws", () => {
    function expectNullsAndWarn(getCtx: () => SessionAnalyticsContext) {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        let fields: unknown;
        expect(() => {
          fields = analyticsContextFields(getCtx);
        }).not.toThrow();
        expect(fields).toEqual(NULLS);
        expect(warn).toHaveBeenCalledTimes(1);
        const line = String(warn.mock.calls[0][0]);
        expect(line).toMatch(/^\[analytics\]/);
        expect(line).toContain("Error");
        expect(line).not.toContain("client-bytes");
      } finally {
        warn.mockRestore();
      }
    }

    it("an Error whose constructor is undefined", () => {
      expectNullsAndWarn(() => {
        const e = new Error("client-bytes");
        Object.defineProperty(e, "constructor", { value: undefined });
        throw e;
      });
    });

    it("an Error whose static name is a number", () => {
      class NumberNamed extends Error {}
      Object.defineProperty(NumberNamed, "name", { value: 42 });
      expectNullsAndWarn(() => {
        throw new NumberNamed("client-bytes");
      });
    });

    it("an Error whose constructor getter throws", () => {
      expectNullsAndWarn(() => {
        const e = new Error("client-bytes");
        Object.defineProperty(e, "constructor", {
          get() {
            throw new Error("getter boom");
          },
        });
        throw e;
      });
    });

    it("a context whose property getters throw", () => {
      const hostile = {} as SessionAnalyticsContext;
      for (const key of Object.keys(ctx)) {
        Object.defineProperty(hostile, key, {
          get() {
            throw new RangeError("client-bytes");
          },
        });
      }
      expectNullsAndWarn(() => hostile);
    });
  });

  it("returns exactly QueryLogEntry's five context fields (compile-time)", () => {
    type Fields = ReturnType<typeof analyticsContextFields>;
    expectTypeOf<keyof Fields>().toEqualTypeOf<keyof SessionAnalyticsContext>();
    expectTypeOf<Fields>().toExtend<Partial<QueryLogEntry>>();
  });
});

describe("cleanClientString", () => {
  const inputs: unknown[] = [
    "a\u0000b",
    "\u0000",
    "  x  ",
    "   ",
    "\u0085x",
    "\ud83d",
    "x\ude00y",
    "\ud83d\u0000\ude00",
    "a".repeat(63) + " b",
    "a".repeat(63) + "\u{1F600}b",
    "c".repeat(200),
    7,
    {},
    null,
    undefined,
  ];

  it("is idempotent for every hostile input", () => {
    for (const v of inputs) {
      const once = cleanClientString(v, REQUEST_CONTEXT_FIELD_MAX_LEN);
      expect(cleanClientString(once, REQUEST_CONTEXT_FIELD_MAX_LEN)).toBe(once);
    }
  });

  it("returns null for non-strings and empty results", () => {
    for (const v of [
      7,
      {},
      null,
      undefined,
      "",
      "   ",
      "\u0000\u0007",
      "\ud83d",
    ]) {
      expect(cleanClientString(v, REQUEST_CONTEXT_FIELD_MAX_LEN)).toBeNull();
    }
  });

  it("trims whitespace left by the cap", () => {
    expect(
      cleanClientString("a".repeat(63) + " b", REQUEST_CONTEXT_FIELD_MAX_LEN),
    ).toBe("a".repeat(63));
  });

  it("with overflow 'null' returns null over the cap, never a prefix", () => {
    expect(cleanClientString("abcd", 3, "null")).toBeNull();
    expect(cleanClientString("abc", 3, "null")).toBe("abc");
    expect(cleanClientString(" abc ", 3, "null")).toBe("abc");
  });

  it("keeps every stored value safe for safeLogToken (no control survives)", () => {
    const out = cleanClientString(
      "\u0001a\u001fb\u007fc\u009fd",
      REQUEST_CONTEXT_FIELD_MAX_LEN,
    );
    expect(out).toBe("abcd");
    expect(safeLogToken(out ?? "")).toBe("abcd");
  });
});

describe("initialize handshake", () => {
  const init = (params: Record<string, unknown>) => ({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      capabilities: {},
      protocolVersion: "2025-06-18",
      clientInfo: { name: "claude-code", version: "1" },
      ...params,
    },
  });

  it("parses a valid initialize", () => {
    expect(handshakeFromInitialize(init({}))).toEqual({
      protocolVersion: "2025-06-18",
      clientName: "claude-code",
    });
  });

  it("returns nulls for a non-initialize message", () => {
    const msg = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
    expect(handshakeFromInitialize(msg)).toEqual({
      protocolVersion: null,
      clientName: null,
    });
    expect(handshakeFromInitialize(undefined)).toEqual({
      protocolVersion: null,
      clientName: null,
    });
  });

  it("returns nulls when clientInfo has the wrong type (not a valid initialize)", () => {
    const r = handshakeFromInitialize(
      init({ clientInfo: { name: 42, version: "1" } }),
    );
    expect(r).toEqual({ protocolVersion: null, clientName: null });
  });

  it("ignores empty strings", () => {
    const r = handshakeFromInitialize(
      init({ protocolVersion: "", clientInfo: { name: "", version: "1" } }),
    );
    expect(r).toEqual({ protocolVersion: null, clientName: null });
  });

  it("truncates both fields to REQUEST_CONTEXT_FIELD_MAX_LEN, keeping the prefix", () => {
    // No character repeats within any 36-character run, and neither a
    // wrong-end slice (shift 44) nor an off-by-one (shift 1) is a multiple
    // of 36, so either gives a different string, not just the same length.
    const long = "0123456789abcdefghijklmnopqrstuvwxyz".repeat(3);
    expect(long.length).toBeGreaterThan(REQUEST_CONTEXT_FIELD_MAX_LEN);
    const r = handshakeFromInitialize(
      init({
        protocolVersion: long,
        clientInfo: { name: `n${long}`, version: "1" },
      }),
    );
    expect(r.protocolVersion).toBe(
      long.slice(0, REQUEST_CONTEXT_FIELD_MAX_LEN),
    );
    expect(r.clientName).toBe(
      `n${long}`.slice(0, REQUEST_CONTEXT_FIELD_MAX_LEN),
    );
  });

  it("keeps a value of exactly REQUEST_CONTEXT_FIELD_MAX_LEN intact and cuts one longer", () => {
    const exact = "0123456789abcdefghijklmnopqrstuvwxyz"
      .repeat(2)
      .slice(0, REQUEST_CONTEXT_FIELD_MAX_LEN);
    expect(handshakeFromInitialize(init({ protocolVersion: exact }))).toEqual({
      protocolVersion: exact,
      clientName: "claude-code",
    });
    expect(
      handshakeFromInitialize(init({ protocolVersion: `${exact}Z` }))
        .protocolVersion,
    ).toBe(exact);
  });

  it("records then looks up by key", () => {
    const key = {};
    expect(recordHandshake(key, handshakeFromInitialize(init({})))).toBe(true);
    expect(handshakeFor(key)).toEqual({
      protocolVersion: "2025-06-18",
      clientName: "claude-code",
    });
  });

  it("recordHandshake keeps the first record for a key", () => {
    const key = {};
    recordHandshake(key, { protocolVersion: "2024-11-05", clientName: "a" });
    expect(
      recordHandshake(key, { protocolVersion: "2025-06-18", clientName: "b" }),
    ).toBe(false);
    expect(handshakeFor(key)).toEqual({
      protocolVersion: "2024-11-05",
      clientName: "a",
    });
  });

  it("handshakeOf(undefined) is all nulls", () => {
    expect(handshakeOf(undefined)).toEqual({
      protocolVersion: null,
      clientName: null,
    });
  });

  it("handshakeFor(undefined) is undefined", () => {
    expect(handshakeFor(undefined)).toBeUndefined();
  });
});
