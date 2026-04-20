import { describe, it, expect } from "vitest";
import {
  signJWT,
  verifyJWT,
  InvalidSignature,
  TokenExpired,
  InvalidAudience,
  MalformedToken,
} from "../oauth/jwt.js";

const SECRET = "a".repeat(32);
const OTHER_SECRET = "b".repeat(32);

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

describe("signJWT / verifyJWT", () => {
  it("signJWT returns 3 dot-separated base64url segments", () => {
    const token = signJWT(
      { sub: "anonymous", iat: nowSec(), exp: nowSec() + 3600 },
      SECRET,
    );
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    for (const seg of parts) {
      expect(seg).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("header contains alg: HS256 and typ: JWT", () => {
    const token = signJWT(
      { sub: "x", iat: nowSec(), exp: nowSec() + 60 },
      SECRET,
    );
    const headerB64 = token.split(".")[0];
    const pad = "=".repeat((4 - (headerB64.length % 4)) % 4);
    const header = JSON.parse(
      Buffer.from(
        headerB64.replace(/-/g, "+").replace(/_/g, "/") + pad,
        "base64",
      ).toString("utf8"),
    );
    expect(header.alg).toBe("HS256");
    expect(header.typ).toBe("JWT");
  });

  it("verifyJWT returns decoded payload", () => {
    const payload = {
      sub: "anonymous",
      client_id: "abc",
      iat: nowSec(),
      exp: nowSec() + 3600,
    };
    const token = signJWT(payload, SECRET);
    const decoded = verifyJWT(token, SECRET);
    expect(decoded.sub).toBe("anonymous");
    expect(decoded.client_id).toBe("abc");
  });

  it("throws InvalidSignature when secret differs", () => {
    const token = signJWT(
      { sub: "x", iat: nowSec(), exp: nowSec() + 60 },
      SECRET,
    );
    expect(() => verifyJWT(token, OTHER_SECRET)).toThrow(InvalidSignature);
  });

  it("throws TokenExpired when exp < now", () => {
    const token = signJWT(
      { sub: "x", iat: nowSec() - 100, exp: nowSec() - 50 },
      SECRET,
    );
    expect(() => verifyJWT(token, SECRET)).toThrow(TokenExpired);
  });

  it("throws InvalidAudience when aud mismatch", () => {
    const token = signJWT(
      {
        sub: "x",
        aud: "https://a.example",
        iat: nowSec(),
        exp: nowSec() + 60,
      },
      SECRET,
    );
    expect(() =>
      verifyJWT(token, SECRET, { aud: "https://b.example" }),
    ).toThrow(InvalidAudience);
  });

  it("accepts matching aud", () => {
    const token = signJWT(
      {
        sub: "x",
        aud: "https://a.example",
        iat: nowSec(),
        exp: nowSec() + 60,
      },
      SECRET,
    );
    expect(() =>
      verifyJWT(token, SECRET, { aud: "https://a.example" }),
    ).not.toThrow();
  });

  it("throws MalformedToken for non-3-segment input", () => {
    expect(() => verifyJWT("only.two", SECRET)).toThrow(MalformedToken);
    expect(() => verifyJWT("one", SECRET)).toThrow(MalformedToken);
    expect(() => verifyJWT("a.b.c.d", SECRET)).toThrow(MalformedToken);
  });

  it("throws MalformedToken for empty string", () => {
    expect(() => verifyJWT("", SECRET)).toThrow(MalformedToken);
  });

  it("throws MalformedToken for invalid base64url payload", () => {
    // Valid header, gibberish payload
    expect(() => verifyJWT("aaa.!!!.bbb", SECRET)).toThrow(MalformedToken);
  });

  it("base64url round-trip handles + / = characters", () => {
    // A payload whose JSON, when base64-encoded, contains + / = in standard base64.
    // Force this by using content that b64-encodes with padding and special chars.
    const payload = {
      sub: "\u00ff\u00fe\u00fd",
      data: "??>>//++==",
      iat: nowSec(),
      exp: nowSec() + 60,
    };
    const token = signJWT(payload, SECRET);
    expect(token).not.toContain("+");
    expect(token).not.toContain("/");
    expect(token).not.toContain("=");
    const decoded = verifyJWT(token, SECRET);
    expect(decoded.sub).toBe(payload.sub);
    expect(decoded.data).toBe(payload.data);
  });

  it("honors clockSkewSec for recently expired tokens", () => {
    const token = signJWT(
      { sub: "x", iat: nowSec() - 100, exp: nowSec() - 10 },
      SECRET,
    );
    // Default skew is 30s — 10s expired should still verify
    expect(() => verifyJWT(token, SECRET)).not.toThrow();
    // With 0 skew it should throw
    expect(() => verifyJWT(token, SECRET, { clockSkewSec: 0 })).toThrow(
      TokenExpired,
    );
  });
});
