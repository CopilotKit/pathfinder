// OAuth 2.1 ceremonial flow handlers for the Pathfinder MCP server.
//
// Anonymous OAuth: we run the full RFC 6749 / RFC 7636 (PKCE) / RFC 7591
// (dynamic registration) / RFC 8414 (AS metadata) / RFC 9728 (protected
// resource metadata) ceremony, but auto-approve at /authorize and issue a
// JWT with sub: "anonymous". The /mcp endpoint uses opportunistic bearer
// auth so existing unauthenticated clients keep working.

import type { Request, Response, NextFunction } from "express";
import { createHash, timingSafeEqual } from "node:crypto";

import { getConfig } from "../config.js";
import { clientStore, codeStore } from "./store.js";
import {
  signJWT,
  verifyJWT,
  InvalidSignature,
  TokenExpired,
  InvalidAudience,
  MalformedToken,
} from "./jwt.js";
import {
  registerLimiter,
  authorizeLimiter,
  tokenLimiter,
  type OAuthRateLimiter,
} from "./rate-limiter.js";

const TOKEN_TTL_SEC = 3600;
const CODE_TTL_MS = 600_000;

function originOf(req: Request): string {
  const proto = (req.headers["x-forwarded-proto"] as string) || "http";
  const host = req.headers.host ?? `localhost:${getConfig().port}`;
  return `${proto}://${host}`;
}

function clientIp(req: Request): string {
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function enforceLimit(
  limiter: OAuthRateLimiter,
  req: Request,
  res: Response,
): boolean {
  const ip = clientIp(req);
  const result = limiter.check(ip);
  if (!result.ok) {
    res.setHeader("Retry-After", String(result.retryAfterSec ?? 60));
    res.status(429).json({
      error: "rate_limited",
      error_description: "Too many requests — slow down.",
    });
    console.warn(`[oauth] rate_limited ip=${ip}`);
    return false;
  }
  return true;
}

// ──────────────────────────────────────────────────────────────────────
// Metadata handlers
// ──────────────────────────────────────────────────────────────────────

export function protectedResourceHandler(req: Request, res: Response): void {
  const origin = originOf(req);
  res.json({
    resource: origin,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
  });
}

export function authorizationServerHandler(req: Request, res: Response): void {
  const origin = originOf(req);
  res.json({
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}

// ──────────────────────────────────────────────────────────────────────
// /register — RFC 7591 dynamic client registration
// ──────────────────────────────────────────────────────────────────────

export function registerHandler(req: Request, res: Response): void {
  if (!enforceLimit(registerLimiter, req, res)) return;

  const body = (req.body ?? {}) as { redirect_uris?: unknown };
  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === "string")
    : [];

  const client = clientStore.register({ redirect_uris: redirectUris });
  console.log(
    `[oauth] register client_id=${client.client_id} ip=${clientIp(req)}`,
  );
  res.status(201).json({
    client_id: client.client_id,
    client_id_issued_at: client.client_id_issued_at,
    redirect_uris: client.redirect_uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  });
}

// ──────────────────────────────────────────────────────────────────────
// /authorize — RFC 6749 with PKCE (S256 only), auto-approve
// ──────────────────────────────────────────────────────────────────────

export function authorizeHandler(req: Request, res: Response): void {
  if (!enforceLimit(authorizeLimiter, req, res)) return;

  const q = (req.query ?? {}) as Record<string, string | undefined>;
  const response_type = q.response_type;
  const client_id = q.client_id;
  const redirect_uri = q.redirect_uri;
  const code_challenge = q.code_challenge;
  const code_challenge_method = q.code_challenge_method;
  const state = q.state;

  if (!client_id || !redirect_uri || !code_challenge || !response_type) {
    res.status(400).json({
      error: "invalid_request",
      error_description:
        "Missing one or more required parameters: response_type, client_id, redirect_uri, code_challenge.",
    });
    return;
  }

  if (response_type !== "code") {
    res.status(400).json({
      error: "unsupported_response_type",
      error_description: "Only response_type=code is supported.",
    });
    return;
  }

  if (code_challenge_method !== "S256") {
    res.status(400).json({
      error: "invalid_request",
      error_description: "Only code_challenge_method=S256 is supported.",
    });
    return;
  }

  const client = clientStore.get(client_id);
  if (!client) {
    res.status(400).json({
      error: "unauthorized_client",
      error_description: "Unknown client_id.",
    });
    console.warn(
      `[oauth] authorize unknown client_id=${client_id} ip=${clientIp(req)}`,
    );
    return;
  }

  if (
    client.redirect_uris.length > 0 &&
    !client.redirect_uris.includes(redirect_uri)
  ) {
    res.status(400).json({
      error: "invalid_redirect_uri",
      error_description: "redirect_uri does not match any registered URI.",
    });
    return;
  }

  const { code } = codeStore.issue({
    clientId: client_id,
    codeChallenge: code_challenge,
    redirectUri: redirect_uri,
    ttlMs: CODE_TTL_MS,
  });

  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);

  console.log(
    `[oauth] authorize client_id=${client_id} code=${code.slice(0, 8)} ip=${clientIp(req)}`,
  );
  res.redirect(url.toString());
}

// ──────────────────────────────────────────────────────────────────────
// /token — RFC 6749 authorization_code grant with PKCE verification
// ──────────────────────────────────────────────────────────────────────

export function tokenHandler(req: Request, res: Response): void {
  if (!enforceLimit(tokenLimiter, req, res)) return;

  const body = (req.body ?? {}) as Record<string, string | undefined>;
  const grant_type = body.grant_type;

  if (grant_type !== "authorization_code") {
    res.status(400).json({
      error: "unsupported_grant_type",
      error_description: "Only authorization_code is supported.",
    });
    return;
  }

  const code = body.code;
  const verifier = body.code_verifier;
  const client_id = body.client_id;
  const redirect_uri = body.redirect_uri;

  if (!code || !verifier || !client_id || !redirect_uri) {
    res.status(400).json({
      error: "invalid_request",
      error_description:
        "Missing required fields: code, code_verifier, client_id, redirect_uri.",
    });
    return;
  }

  const record = codeStore.consume(code);
  if (!record) {
    res.status(400).json({
      error: "invalid_grant",
      error_description: "Unknown or expired authorization code.",
    });
    console.warn(
      `[oauth] token unknown/expired code ip=${clientIp(req)} client=${client_id}`,
    );
    return;
  }

  if (record.clientId !== client_id || record.redirectUri !== redirect_uri) {
    res.status(400).json({
      error: "invalid_grant",
      error_description: "client_id or redirect_uri does not match.",
    });
    return;
  }

  // Verify PKCE (S256): base64url(sha256(verifier)) === stored challenge
  const expectedChallenge = base64url(
    createHash("sha256").update(verifier).digest(),
  );
  const a = Buffer.from(expectedChallenge);
  const b = Buffer.from(record.codeChallenge);
  const pkceOk = a.length === b.length && timingSafeEqual(a, b);
  if (!pkceOk) {
    res.status(400).json({
      error: "invalid_grant",
      error_description: "PKCE verification failed.",
    });
    console.warn(
      `[oauth] token PKCE failure ip=${clientIp(req)} client=${client_id}`,
    );
    return;
  }

  const origin = originOf(req);
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + TOKEN_TTL_SEC;
  const token = signJWT(
    {
      iss: origin,
      aud: origin,
      sub: "anonymous",
      client_id,
      iat,
      exp,
    },
    getConfig().mcpJwtSecret,
  );

  console.log(
    `[oauth] token issued client_id=${client_id} ip=${clientIp(req)}`,
  );
  res.status(200).json({
    access_token: token,
    token_type: "Bearer",
    expires_in: TOKEN_TTL_SEC,
  });
}

// ──────────────────────────────────────────────────────────────────────
// Bearer middleware — opportunistic
// ──────────────────────────────────────────────────────────────────────

export interface AuthContext {
  sub: string;
  client_id: string;
}

export function bearerMiddleware(
  req: Request & { auth?: AuthContext },
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization;
  if (!header || typeof header !== "string") {
    next();
    return;
  }

  const trimmed = header.trim();
  if (!/^Bearer(\s|$)/i.test(trimmed)) {
    // Not a Bearer scheme — treat as if absent (opportunistic)
    next();
    return;
  }
  const token = trimmed.slice("Bearer".length).trim();
  if (!token) {
    unauthorized(res, "invalid_token");
    return;
  }

  try {
    const payload = verifyJWT(token, getConfig().mcpJwtSecret, {
      aud: originOf(req),
    });
    req.auth = {
      sub: payload.sub,
      client_id: (payload.client_id as string) ?? "",
    };
    next();
  } catch (err) {
    if (
      err instanceof InvalidSignature ||
      err instanceof TokenExpired ||
      err instanceof InvalidAudience ||
      err instanceof MalformedToken
    ) {
      unauthorized(res, "invalid_token");
      return;
    }
    // Unknown error — fail closed
    unauthorized(res, "invalid_token");
  }
}

function unauthorized(res: Response, error: string): void {
  res.setHeader("WWW-Authenticate", `Bearer realm="mcp", error="${error}"`);
  res.status(401).json({ error });
}
