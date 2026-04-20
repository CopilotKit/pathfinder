// Hand-rolled HS256 JWT using node:crypto — no external deps.
// Isolated here so we can swap for `jose` later if asymmetric keys are needed.

import { createHmac, timingSafeEqual } from "node:crypto";

export class InvalidSignature extends Error {
  constructor() {
    super("Invalid JWT signature");
    this.name = "InvalidSignature";
  }
}

export class TokenExpired extends Error {
  constructor() {
    super("JWT token expired");
    this.name = "TokenExpired";
  }
}

export class InvalidAudience extends Error {
  constructor() {
    super("JWT audience mismatch");
    this.name = "InvalidAudience";
  }
}

export class MalformedToken extends Error {
  constructor(reason?: string) {
    super(`Malformed JWT${reason ? `: ${reason}` : ""}`);
    this.name = "MalformedToken";
  }
}

export interface JWTPayload {
  sub: string;
  iat: number;
  exp: number;
  aud?: string;
  iss?: string;
  client_id?: string;
  [key: string]: unknown;
}

export interface VerifyOptions {
  aud?: string;
  clockSkewSec?: number;
}

function base64urlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64urlDecodeToBuffer(input: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) {
    throw new MalformedToken("invalid base64url characters");
  }
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  return Buffer.from(b64 + pad, "base64");
}

function base64urlDecodeJson(input: string): unknown {
  const buf = base64urlDecodeToBuffer(input);
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new MalformedToken("invalid JSON");
  }
}

const HEADER = { alg: "HS256", typ: "JWT" };
const HEADER_B64 = base64urlEncode(JSON.stringify(HEADER));

function sign(data: string, secret: string): string {
  const mac = createHmac("sha256", secret).update(data).digest();
  return base64urlEncode(mac);
}

export function signJWT(payload: JWTPayload, secret: string): string {
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${HEADER_B64}.${payloadB64}`;
  const sig = sign(signingInput, secret);
  return `${signingInput}.${sig}`;
}

export function verifyJWT(
  token: string,
  secret: string,
  opts: VerifyOptions = {},
): JWTPayload {
  if (!token || typeof token !== "string") {
    throw new MalformedToken("empty token");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new MalformedToken(`expected 3 segments, got ${parts.length}`);
  }
  const [headerB64, payloadB64, sigB64] = parts;
  if (!headerB64 || !payloadB64 || !sigB64) {
    throw new MalformedToken("empty segment");
  }

  // Verify header
  const header = base64urlDecodeJson(headerB64) as {
    alg?: string;
    typ?: string;
  };
  if (header.alg !== "HS256") {
    throw new MalformedToken(`unsupported alg: ${header.alg}`);
  }

  // Verify signature (timing-safe)
  const expectedSigBuf = base64urlDecodeToBuffer(
    sign(`${headerB64}.${payloadB64}`, secret),
  );
  const presentedSigBuf = base64urlDecodeToBuffer(sigB64);
  if (
    expectedSigBuf.length !== presentedSigBuf.length ||
    !timingSafeEqual(expectedSigBuf, presentedSigBuf)
  ) {
    throw new InvalidSignature();
  }

  const payload = base64urlDecodeJson(payloadB64) as JWTPayload;
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof payload.exp !== "number"
  ) {
    throw new MalformedToken("missing or invalid exp claim");
  }

  const clockSkewSec = opts.clockSkewSec ?? 30;
  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.exp + clockSkewSec < nowSec) {
    throw new TokenExpired();
  }

  if (opts.aud && payload.aud !== opts.aud) {
    throw new InvalidAudience();
  }

  return payload;
}
