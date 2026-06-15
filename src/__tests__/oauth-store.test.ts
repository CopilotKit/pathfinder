import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { ClientStore, ClientCapError, CodeStore } from "../oauth/store.js";

describe("ClientStore", () => {
  let store: ClientStore;
  beforeEach(() => {
    store = new ClientStore();
  });

  it("register returns client_id, client_id_issued_at, and echoes redirect_uris", () => {
    const result = store.register({
      redirect_uris: ["https://example.com/cb"],
      ip: "1.1.1.1",
    });
    expect(result.client_id).toBeDefined();
    expect(typeof result.client_id).toBe("string");
    expect(result.client_id_issued_at).toBeTypeOf("number");
    expect(result.redirect_uris).toEqual(["https://example.com/cb"]);
  });

  it("register issues a client_secret with base64url encoding and secret metadata", () => {
    const result = store.register({ redirect_uris: [], ip: "1.1.1.1" });
    expect(result.client_secret).toBeDefined();
    expect(typeof result.client_secret).toBe("string");
    // base64url (no +/= chars); 32 bytes → 43 chars
    expect(result.client_secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(result.client_secret.length).toBeGreaterThanOrEqual(32);
    expect(result.client_secret_issued_at).toBe(result.client_id_issued_at);
    expect(result.client_secret_expires_at).toBe(0);
  });

  it("two registers issue distinct client_secrets", () => {
    const a = store.register({ redirect_uris: [], ip: "1.1.1.1" });
    const b = store.register({ redirect_uris: [], ip: "1.1.1.1" });
    expect(a.client_secret).not.toBe(b.client_secret);
  });

  it("get(client_id) returns registered client", () => {
    const { client_id } = store.register({
      redirect_uris: ["https://example.com/cb"],
      ip: "1.1.1.1",
    });
    const fetched = store.get(client_id);
    expect(fetched).toBeDefined();
    expect(fetched?.redirect_uris).toEqual(["https://example.com/cb"]);
  });

  it("two registers return distinct UUIDs", () => {
    const a = store.register({ redirect_uris: [], ip: "1.1.1.1" });
    const b = store.register({ redirect_uris: [], ip: "1.1.1.1" });
    expect(a.client_id).not.toBe(b.client_id);
  });

  it("get returns undefined for unknown client", () => {
    expect(store.get("nope")).toBeUndefined();
  });

  it("accepts empty redirect_uris array", () => {
    const r = store.register({ redirect_uris: [], ip: "1.1.1.1" });
    expect(r.redirect_uris).toEqual([]);
  });

  it("register persists client_name truncated to 80 chars", () => {
    const longName = "x".repeat(200);
    const r = store.register({
      redirect_uris: [],
      client_name: longName,
      ip: "1.1.1.1",
    });
    expect(r.client_name).toBe("x".repeat(80));
  });

  it("register sets registeredAt and lastUsedAt to now", () => {
    const before = Date.now();
    const r = store.register({ redirect_uris: [], ip: "1.1.1.1" });
    const after = Date.now();
    expect(r.registeredAt).toBeGreaterThanOrEqual(before);
    expect(r.registeredAt).toBeLessThanOrEqual(after);
    expect(r.lastUsedAt).toBe(r.registeredAt);
  });
});

describe("ClientStore — cap + eviction", () => {
  let store: ClientStore;
  beforeEach(() => {
    vi.useFakeTimers();
    store = new ClientStore();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("touch bumps lastUsedAt", () => {
    const { client_id } = store.register({
      redirect_uris: [],
      ip: "1.1.1.1",
    });
    const before = store.get(client_id)!.lastUsedAt;
    vi.advanceTimersByTime(5000);
    store.touch(client_id);
    expect(store.get(client_id)!.lastUsedAt).toBe(before + 5000);
  });

  it("touch is a no-op for unknown clients", () => {
    expect(() => store.touch("nope")).not.toThrow();
  });

  it("rejects with ClientCapError(per_ip) at 101st registration from same ip", () => {
    for (let i = 0; i < 100; i++) {
      store.register({ redirect_uris: [], ip: "1.1.1.1" });
    }
    let caught: unknown;
    try {
      store.register({ redirect_uris: [], ip: "1.1.1.1" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClientCapError);
    expect((caught as ClientCapError).scope).toBe("per_ip");
  });

  it("evicts ttl-stale clients on overflow then accepts new registration", () => {
    const small = new ClientStore({ maxTotal: 3, maxPerIp: 100 });
    const a = small.register({ redirect_uris: [], ip: "1.1.1.1" });
    // Bump `a.lastUsedAt` to mimic real usage so it crosses the 30d ttl gate.
    small.touch(a.client_id);
    vi.advanceTimersByTime(30 * 24 * 3600 * 1000 + 1);
    small.register({ redirect_uris: [], ip: "2.2.2.2" });
    small.register({ redirect_uris: [], ip: "3.3.3.3" });
    // Cap = 3, currently 3 (a + 2 fresh). Next register → sweep evicts stale `a`, succeeds.
    expect(() =>
      small.register({ redirect_uris: [], ip: "4.4.4.4" }),
    ).not.toThrow();
    expect(small.get(a.client_id)).toBeUndefined();
  });

  it("evicts never-used clients (registeredAt < now - 7d, lastUsedAt unchanged) on total-cap overflow", () => {
    const small = new ClientStore({ maxTotal: 3, maxPerIp: 100 });
    const a = small.register({ redirect_uris: [], ip: "1.1.1.1" });
    // NOTE: a.lastUsedAt === a.registeredAt (never touched). Advance 7d+1ms.
    vi.advanceTimersByTime(7 * 24 * 3600 * 1000 + 1);
    small.register({ redirect_uris: [], ip: "2.2.2.2" });
    small.register({ redirect_uris: [], ip: "3.3.3.3" });
    // Total at cap (3). Next register triggers sweep → evicts `a` (never-used + >7d).
    expect(() =>
      small.register({ redirect_uris: [], ip: "4.4.4.4" }),
    ).not.toThrow();
    expect(small.get(a.client_id)).toBeUndefined();
  });

  it("rejects with ClientCapError(total) when total cap exceeded even after sweep", () => {
    const small = new ClientStore({ maxTotal: 3, maxPerIp: 100 });
    small.register({ redirect_uris: [], ip: "a" });
    small.register({ redirect_uris: [], ip: "b" });
    small.register({ redirect_uris: [], ip: "c" });
    let caught: unknown;
    try {
      small.register({ redirect_uris: [], ip: "d" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClientCapError);
    expect((caught as ClientCapError).scope).toBe("total");
  });

  it("emits cap_evicted log when sweep removes any client", () => {
    const small = new ClientStore({ maxTotal: 2, maxPerIp: 100 });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = small.register({ redirect_uris: [], ip: "1.1.1.1" });
    small.touch(a.client_id);
    vi.advanceTimersByTime(30 * 24 * 3600 * 1000 + 1);
    small.register({ redirect_uris: [], ip: "2.2.2.2" });
    small.register({ redirect_uris: [], ip: "3.3.3.3" }); // triggers sweep
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[oauth\] cap_evicted ttl=1 unused=0/),
    );
    warnSpy.mockRestore();
  });
});

describe("CodeStore", () => {
  let store: CodeStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new CodeStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("issue returns code and expiresAt", () => {
    const result = store.issue({
      clientId: "c1",
      codeChallenge: "abc",
      redirectUri: "https://x.example/cb",
      ttlMs: 600_000,
    });
    expect(result.code).toBeDefined();
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it("consume returns record once, then undefined", () => {
    const { code } = store.issue({
      clientId: "c1",
      codeChallenge: "abc",
      redirectUri: "https://x.example/cb",
      ttlMs: 600_000,
    });
    const first = store.consume(code);
    expect(first).toBeDefined();
    expect(first?.clientId).toBe("c1");
    expect(first?.codeChallenge).toBe("abc");
    expect(first?.redirectUri).toBe("https://x.example/cb");

    const second = store.consume(code);
    expect(second).toBeUndefined();
  });

  it("returns undefined for expired codes", () => {
    const { code } = store.issue({
      clientId: "c1",
      codeChallenge: "abc",
      redirectUri: "https://x.example/cb",
      ttlMs: 1000,
    });
    vi.advanceTimersByTime(1500);
    const result = store.consume(code);
    expect(result).toBeUndefined();
  });

  it("returns undefined for unknown code", () => {
    expect(store.consume("notacode")).toBeUndefined();
  });

  it("issues distinct codes on repeat calls", () => {
    const a = store.issue({
      clientId: "c1",
      codeChallenge: "x",
      redirectUri: "https://x.example/cb",
      ttlMs: 600_000,
    });
    const b = store.issue({
      clientId: "c1",
      codeChallenge: "x",
      redirectUri: "https://x.example/cb",
      ttlMs: 600_000,
    });
    expect(a.code).not.toBe(b.code);
  });
});
