import { describe, it, expect } from "vitest";
import {
  signConsentNonce,
  verifyConsentNonce,
  __testOnly_canonicalBytes,
  type ConsentNoncePayload,
} from "../oauth/consent-nonce.js";

const k1 = "a".repeat(64);
const k2 = "b".repeat(64);

function payload(over: Partial<ConsentNoncePayload> = {}): ConsentNoncePayload {
  return {
    client_id: "cid",
    redirect_uri: "https://example.com/cb",
    state: "s",
    code_challenge: "cc",
    code_challenge_method: "S256",
    response_type: "code",
    scope: "mcp",
    resource: "",
    exp: Date.now() + 600_000,
    ...over,
  };
}

function decodePayload(token: string): Record<string, unknown> {
  const b64 = token.split(".")[0]!;
  return JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
}

function reencode(
  decoded: Record<string, unknown>,
  originalToken: string,
): string {
  const mac = originalToken.split(".")[1]!;
  const b64 = Buffer.from(JSON.stringify(decoded), "utf8").toString(
    "base64url",
  );
  return `${b64}.${mac}`;
}

describe("consent nonce", () => {
  it("round-trips a valid payload", () => {
    const tok = signConsentNonce(payload(), [k1]);
    const r = verifyConsentNonce(tok, [k1]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.client_id).toBe("cid");
      expect(r.payload.redirect_uri).toBe("https://example.com/cb");
      expect(r.payload.scope).toBe("mcp");
    }
  });

  it("rejects tampered payload (any field flip → hmac fail)", () => {
    const tok = signConsentNonce(payload({ client_id: "a" }), [k1]);
    const decoded = decodePayload(tok);
    decoded.client_id = "b";
    const tampered = reencode(decoded, tok);
    const r = verifyConsentNonce(tampered, [k1]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("hmac");
  });

  it("rejects expired nonce", () => {
    const tok = signConsentNonce(payload({ exp: Date.now() - 1 }), [k1]);
    const r = verifyConsentNonce(tok, [k1]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expired");
  });

  it("rejects wrong key", () => {
    const tok = signConsentNonce(payload(), [k1]);
    const r = verifyConsentNonce(tok, [k2]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("hmac");
  });

  it("multi-key verify accepts old key (rotation)", () => {
    const tok = signConsentNonce(payload(), [k1]);
    const r = verifyConsentNonce(tok, [k2, k1]);
    expect(r.ok).toBe(true);
  });

  it("multi-key verify: signer uses keys[0] (new primary)", () => {
    // Sign with k2 first (primary), and verify still works when listed first.
    const tok = signConsentNonce(payload(), [k2, k1]);
    const r1 = verifyConsentNonce(tok, [k2]);
    expect(r1.ok).toBe(true);
    const r2 = verifyConsentNonce(tok, [k1]);
    expect(r2.ok).toBe(false); // wasn't signed with k1
  });

  it("rejects malformed format (no dot)", () => {
    const r = verifyConsentNonce("notatoken", [k1]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("format");
  });

  it("rejects empty payload half", () => {
    const r = verifyConsentNonce(".abc", [k1]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("format");
  });

  it("rejects empty mac half", () => {
    const r = verifyConsentNonce("abc.", [k1]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("format");
  });

  it("rejects unparseable JSON payload", () => {
    const garbage = Buffer.from("not json", "utf8").toString("base64url");
    const r = verifyConsentNonce(`${garbage}.YWJj`, [k1]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("format");
  });

  it("rejects payload missing required fields (format)", () => {
    // Build a valid-looking token but strip a required field.
    const tok = signConsentNonce(payload(), [k1]);
    const decoded = decodePayload(tok);
    delete decoded.scope;
    const tampered = reencode(decoded, tok);
    const r = verifyConsentNonce(tampered, [k1]);
    expect(r.ok).toBe(false);
    // Missing string field fails format check (before MAC).
    if (!r.ok) expect(r.reason).toBe("format");
  });

  it("rejects payload with non-numeric exp (format)", () => {
    const tok = signConsentNonce(payload(), [k1]);
    const decoded = decodePayload(tok);
    decoded.exp = "not a number";
    const tampered = reencode(decoded, tok);
    const r = verifyConsentNonce(tampered, [k1]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("format");
  });

  it("MAC-then-exp ordering: tampered MAC with valid exp → hmac, NOT expired", () => {
    // Future exp is fine; flip a payload byte so MAC fails. We must
    // get reason=hmac, not reason=expired (we must not leak expiry).
    const tok = signConsentNonce(payload({ exp: Date.now() + 60_000 }), [k1]);
    const decoded = decodePayload(tok);
    decoded.client_id = "different";
    const tampered = reencode(decoded, tok);
    const r = verifyConsentNonce(tampered, [k1]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("hmac");
  });

  it("MAC-then-exp ordering: garbage MAC with expired exp → hmac, NOT expired", () => {
    // Build a properly-shaped token but with a bogus MAC. With a now-1
    // exp, a verifier that checked exp first would return "expired" —
    // we must return "hmac" because the MAC fails.
    const validTok = signConsentNonce(payload({ exp: Date.now() - 1 }), [k1]);
    const bogusMac = Buffer.from("0".repeat(32), "utf8").toString("base64url");
    const tampered = `${validTok.split(".")[0]}.${bogusMac}`;
    const r = verifyConsentNonce(tampered, [k1]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("hmac");
  });

  it("response_type is part of the MAC", () => {
    const tok = signConsentNonce(payload({ response_type: "code" }), [k1]);
    const decoded = decodePayload(tok);
    decoded.response_type = "token";
    const tampered = reencode(decoded, tok);
    const r = verifyConsentNonce(tampered, [k1]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("hmac");
  });

  it("code_challenge_method is part of the MAC", () => {
    const tok = signConsentNonce(payload({ code_challenge_method: "S256" }), [
      k1,
    ]);
    const decoded = decodePayload(tok);
    decoded.code_challenge_method = "plain";
    const tampered = reencode(decoded, tok);
    const r = verifyConsentNonce(tampered, [k1]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("hmac");
  });

  it("resource is part of the MAC (aud-swap prevention)", () => {
    const tok = signConsentNonce(
      payload({ resource: "https://x.example/r1" }),
      [k1],
    );
    const decoded = decodePayload(tok);
    decoded.resource = "https://y.example/r2";
    const tampered = reencode(decoded, tok);
    const r = verifyConsentNonce(tampered, [k1]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("hmac");
  });

  it("redirect_uri is part of the MAC", () => {
    const tok = signConsentNonce(
      payload({ redirect_uri: "https://a.example/cb" }),
      [k1],
    );
    const decoded = decodePayload(tok);
    decoded.redirect_uri = "https://attacker.example/cb";
    const tampered = reencode(decoded, tok);
    const r = verifyConsentNonce(tampered, [k1]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("hmac");
  });

  it("state is part of the MAC", () => {
    const tok = signConsentNonce(payload({ state: "alpha" }), [k1]);
    const decoded = decodePayload(tok);
    decoded.state = "beta";
    const tampered = reencode(decoded, tok);
    const r = verifyConsentNonce(tampered, [k1]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("hmac");
  });

  it("scope is part of the MAC", () => {
    const tok = signConsentNonce(payload({ scope: "mcp" }), [k1]);
    const decoded = decodePayload(tok);
    decoded.scope = "mcp admin";
    const tampered = reencode(decoded, tok);
    const r = verifyConsentNonce(tampered, [k1]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("hmac");
  });

  it("exp is part of the MAC (cannot extend validity)", () => {
    const tok = signConsentNonce(payload({ exp: Date.now() + 1_000 }), [k1]);
    const decoded = decodePayload(tok);
    decoded.exp = Date.now() + 10_000_000;
    const tampered = reencode(decoded, tok);
    const r = verifyConsentNonce(tampered, [k1]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("hmac");
  });

  it("sign produces distinct MACs for distinct payloads", () => {
    // Sanity check: two payloads whose bytes already differ at index 1
    // (regardless of length-prefixing) produce different MACs. This
    // does NOT prove the length-prefix property — see the dedicated
    // length-prefix tests below for that.
    const p1 = payload({ client_id: "ab", redirect_uri: "https://c.example/" });
    const p2 = payload({ client_id: "a", redirect_uri: "https://bc.example/" });
    const tok1 = signConsentNonce(p1, [k1]);
    const tok2 = signConsentNonce(p2, [k1]);
    const mac1 = tok1.split(".")[1]!;
    const mac2 = tok2.split(".")[1]!;
    expect(mac1).not.toBe(mac2);
  });

  it("canonicalBytes prepends 4-byte big-endian length per field", () => {
    // Pin the exact wire layout. A regression that dropped the length
    // prefix, switched to little-endian, or reordered fields would
    // produce a different byte string and fail this assertion
    // directly — independent of MAC inequality on chosen inputs.
    const fixed: ConsentNoncePayload = {
      client_id: "cid",
      redirect_uri: "https://example.com/cb",
      state: "s",
      code_challenge: "cc",
      code_challenge_method: "S256",
      response_type: "code",
      scope: "mcp",
      resource: "",
      exp: 1_700_000_000_000,
    };
    const FIELDS_ORDER: Array<[string, string]> = [
      ["client_id", fixed.client_id],
      ["redirect_uri", fixed.redirect_uri],
      ["state", fixed.state],
      ["code_challenge", fixed.code_challenge],
      ["code_challenge_method", fixed.code_challenge_method],
      ["response_type", fixed.response_type],
      ["scope", fixed.scope],
      ["resource", fixed.resource],
      ["exp", String(fixed.exp)],
    ];
    const parts: Buffer[] = [];
    for (const [, v] of FIELDS_ORDER) {
      const valBuf = Buffer.from(v, "utf8");
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32BE(valBuf.length, 0);
      parts.push(lenBuf, valBuf);
    }
    const expected = Buffer.concat(parts);
    expect(__testOnly_canonicalBytes(fixed)).toEqual(expected);
  });

  it("length-prefix prevents field-boundary ambiguity", () => {
    // Construct two payloads whose NAIVE (no-prefix) byte concatenation
    // would be identical: shifting bytes across the client_id /
    // redirect_uri boundary yields the same raw stream. Without length
    // prefixes, the MACs would collide. With them, the prefix bytes
    // for client_id (2 vs 3) differ, so the canonical bytes — and
    // thus the MACs — MUST differ.
    const empty = {
      state: "",
      code_challenge: "",
      code_challenge_method: "",
      response_type: "",
      scope: "",
      resource: "",
    };
    const exp = 1_700_000_000_000;
    const a: ConsentNoncePayload = {
      client_id: "AB",
      redirect_uri: "CD",
      ...empty,
      exp,
    };
    const b: ConsentNoncePayload = {
      client_id: "ABC",
      redirect_uri: "D",
      ...empty,
      exp,
    };

    // Sanity: the naive (prefix-stripped) concatenation of all fields
    // IS identical between a and b — so this pair specifically
    // requires the length prefix to distinguish them.
    const naive = (p: ConsentNoncePayload): string =>
      p.client_id +
      p.redirect_uri +
      p.state +
      p.code_challenge +
      p.code_challenge_method +
      p.response_type +
      p.scope +
      p.resource +
      String(p.exp);
    expect(naive(a)).toBe(naive(b));

    // Canonical (length-prefixed) bytes MUST differ.
    expect(__testOnly_canonicalBytes(a)).not.toEqual(
      __testOnly_canonicalBytes(b),
    );

    // MACs MUST differ.
    const tokA = signConsentNonce(a, [k1]);
    const tokB = signConsentNonce(b, [k1]);
    expect(tokA.split(".")[1]).not.toBe(tokB.split(".")[1]);
  });

  it("injectable now() enforces expiry against fixed clock", () => {
    const tok = signConsentNonce(payload({ exp: 1_000 }), [k1]);
    const r1 = verifyConsentNonce(tok, [k1], () => 500);
    expect(r1.ok).toBe(true);
    const r2 = verifyConsentNonce(tok, [k1], () => 2_000);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("expired");
  });

  it("signConsentNonce throws on empty key set", () => {
    expect(() => signConsentNonce(payload(), [])).toThrow();
  });

  it("verifyConsentNonce rejects with empty key set (no MAC match)", () => {
    const tok = signConsentNonce(payload(), [k1]);
    const r = verifyConsentNonce(tok, []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("hmac");
  });
});
