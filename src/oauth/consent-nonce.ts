// Consent-nonce HMAC plumbing.
//
// The authorize → consent → token flow is stateless on the server side; the
// consent screen hands back a signed blob that names the exact OAuth params
// the user approved. Any drift between mint-time and redeem-time params
// MUST invalidate the nonce, otherwise an attacker who controls the second
// request can swap parameters (audience, redirect_uri, scope, …) under a
// user's previously-approved consent.
//
// Design:
// - HMAC-SHA256 over a canonical, length-prefixed encoding of the bound
//   set. Length prefixes prevent boundary-ambiguity attacks where two
//   distinct payloads would otherwise share a concatenated byte stream.
// - Wire format: `b64url(payload_json) + "." + b64url(mac)`. The payload
//   is JSON so the server (and audits) can inspect it without re-deriving
//   field order from a positional encoding; the MAC is what enforces
//   integrity.
// - Multi-key verify for rotation: signer uses `keys[0]` (the new primary);
//   verifier accepts any key in the list, so freshly-rotated deploys can
//   still honor nonces minted under the previous key until they expire.
// - MAC-then-exp ordering: verify the MAC BEFORE checking expiry. Checking
//   expiry first would leak an oracle ("this byte-string parses but is
//   expired" vs "this byte-string is gibberish"); after the MAC check, an
//   attacker who can't forge a MAC learns nothing from the expiry result.
// - Constant-time MAC compare via `crypto.timingSafeEqual`.
//
// Bound set (order is part of the canonical encoding and MUST NOT change
// without invalidating all in-flight nonces):
//   client_id, redirect_uri, state, code_challenge,
//   code_challenge_method, response_type, scope, resource, exp
//
// - `response_type` + `code_challenge_method` are bound to prevent a
//   param-downgrade swap (e.g. PKCE method dropped to plain at redeem).
// - `resource` is bound because handlers.ts threads it through to the
//   issued JWT's `aud` claim — without binding it here, an attacker could
//   redeem a consent for a different audience.
// - `exp` is unix-MILLISECONDS (not seconds) for parity with `Date.now()`.

import { createHmac, timingSafeEqual } from "node:crypto";

const FIELDS = [
  "client_id",
  "redirect_uri",
  "state",
  "code_challenge",
  "code_challenge_method",
  "response_type",
  "scope",
  "resource",
  "exp",
] as const;

export interface ConsentNoncePayload {
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  response_type: string;
  scope: string;
  resource: string;
  exp: number; // unix milliseconds
}

export type VerifyResult =
  | { ok: true; payload: ConsentNoncePayload }
  | { ok: false; reason: "format" | "hmac" | "expired" };

/**
 * Canonical length-prefixed encoding of the bound set.
 *
 * For each field in `FIELDS` order, append:
 *   - 4 bytes: big-endian uint32 of the UTF-8 byte length of the value
 *   - N bytes: the UTF-8 bytes of the value
 *
 * `exp` is encoded as its decimal ASCII representation.
 *
 * The length prefix is what makes the encoding unambiguous: without it,
 * the pair (client_id="ab", redirect_uri="c") and (client_id="a",
 * redirect_uri="bc") would concatenate to the same byte stream. The MAC
 * would then collide and an attacker could shift bytes across the field
 * boundary undetected.
 */
function canonicalBytes(p: ConsentNoncePayload): Buffer {
  const parts: Buffer[] = [];
  for (const f of FIELDS) {
    const raw = f === "exp" ? String(p.exp) : (p[f] as string);
    const v = typeof raw === "string" ? raw : "";
    const valBuf = Buffer.from(v, "utf8");
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(valBuf.length, 0);
    parts.push(lenBuf, valBuf);
  }
  return Buffer.concat(parts);
}

/**
 * Test-only export of the internal canonical encoder.
 *
 * Tests pin the exact wire layout (length-prefixed, big-endian uint32
 * lengths, FIELDS order) so a regression that removed the length prefix —
 * or reordered the fields — is caught directly, not only via MAC
 * inequality on inputs that already differ byte-for-byte.
 *
 * NOT part of the public API. Do not import from production code.
 */
export const __testOnly_canonicalBytes = canonicalBytes;

function macWith(key: string, p: ConsentNoncePayload): Buffer {
  return createHmac("sha256", key).update(canonicalBytes(p)).digest();
}

/**
 * Sign a consent-nonce payload. The signer always uses `keys[0]` (the
 * current primary). Multi-key lists exist for the verifier's benefit —
 * during rotation, callers prepend the new primary so any nonces minted
 * before the rotation still verify against the (now-second) old key.
 */
export function signConsentNonce(
  p: ConsentNoncePayload,
  keys: string[],
): string {
  if (keys.length === 0) throw new Error("signConsentNonce: empty key set");
  const mac = macWith(keys[0]!, p);
  const payloadB64 = Buffer.from(JSON.stringify(p), "utf8").toString(
    "base64url",
  );
  return `${payloadB64}.${mac.toString("base64url")}`;
}

/**
 * Verify a consent nonce.
 *
 * Order of checks (deliberate):
 *  1. Structural format: `payload.mac` shape, base64url-decodable JSON,
 *     all bound fields present with the right primitive type.
 *  2. MAC: try every key in `keys`. Constant-time compare per attempt.
 *  3. Expiry: only AFTER a successful MAC. Returning "expired" before MAC
 *     would let an attacker probe the format/expiry layer without ever
 *     producing a valid MAC.
 *
 * `now` is injectable for tests; defaults to `Date.now`.
 */
export function verifyConsentNonce(
  token: string,
  keys: string[],
  now: () => number = Date.now,
): VerifyResult {
  if (typeof token !== "string") return { ok: false, reason: "format" };
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1)
    return { ok: false, reason: "format" };
  const payloadB64 = token.slice(0, dot);
  const macB64 = token.slice(dot + 1);
  if (payloadB64.length === 0 || macB64.length === 0) {
    return { ok: false, reason: "format" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "format" };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { ok: false, reason: "format" };
  }
  const obj = parsed as Record<string, unknown>;
  for (const f of FIELDS) {
    if (f === "exp") {
      if (typeof obj.exp !== "number" || !Number.isFinite(obj.exp)) {
        return { ok: false, reason: "format" };
      }
    } else if (typeof obj[f] !== "string") {
      return { ok: false, reason: "format" };
    }
  }
  const p: ConsentNoncePayload = {
    client_id: obj.client_id as string,
    redirect_uri: obj.redirect_uri as string,
    state: obj.state as string,
    code_challenge: obj.code_challenge as string,
    code_challenge_method: obj.code_challenge_method as string,
    response_type: obj.response_type as string,
    scope: obj.scope as string,
    resource: obj.resource as string,
    exp: obj.exp as number,
  };

  let given: Buffer;
  try {
    given = Buffer.from(macB64, "base64url");
  } catch {
    return { ok: false, reason: "format" };
  }
  if (given.length === 0) return { ok: false, reason: "format" };

  let matched = false;
  for (const k of keys) {
    const expected = macWith(k, p);
    if (expected.length === given.length && timingSafeEqual(expected, given)) {
      matched = true;
      break;
    }
  }
  if (!matched) return { ok: false, reason: "hmac" };

  if (p.exp <= now()) return { ok: false, reason: "expired" };
  return { ok: true, payload: p };
}
