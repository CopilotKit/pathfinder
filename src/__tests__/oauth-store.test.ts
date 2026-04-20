import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { ClientStore, CodeStore } from "../oauth/store.js";

describe("ClientStore", () => {
  let store: ClientStore;
  beforeEach(() => {
    store = new ClientStore();
  });

  it("register returns client_id, client_id_issued_at, and echoes redirect_uris", () => {
    const result = store.register({
      redirect_uris: ["https://example.com/cb"],
    });
    expect(result.client_id).toBeDefined();
    expect(typeof result.client_id).toBe("string");
    expect(result.client_id_issued_at).toBeTypeOf("number");
    expect(result.redirect_uris).toEqual(["https://example.com/cb"]);
  });

  it("get(client_id) returns registered client", () => {
    const { client_id } = store.register({
      redirect_uris: ["https://example.com/cb"],
    });
    const fetched = store.get(client_id);
    expect(fetched).toBeDefined();
    expect(fetched?.redirect_uris).toEqual(["https://example.com/cb"]);
  });

  it("two registers return distinct UUIDs", () => {
    const a = store.register({ redirect_uris: [] });
    const b = store.register({ redirect_uris: [] });
    expect(a.client_id).not.toBe(b.client_id);
  });

  it("get returns undefined for unknown client", () => {
    expect(store.get("nope")).toBeUndefined();
  });

  it("accepts empty redirect_uris array", () => {
    const r = store.register({ redirect_uris: [] });
    expect(r.redirect_uris).toEqual([]);
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
