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
const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 3600; // 30 days
const CODE_TTL_MS = 600_000;
const TOKEN_SCOPE = "mcp";

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
    revocation_endpoint: `${origin}/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
      "none",
    ],
    scopes_supported: [TOKEN_SCOPE],
  });
}

// ──────────────────────────────────────────────────────────────────────
// /register — RFC 7591 dynamic client registration
// ──────────────────────────────────────────────────────────────────────

export function registerHandler(req: Request, res: Response): void {
  if (!enforceLimit(registerLimiter, req, res)) return;

  console.log(
    `[oauth] register body=${JSON.stringify(req.body)} headers.origin=${req.headers.origin} headers.user-agent=${req.headers["user-agent"]}`,
  );

  const body = (req.body ?? {}) as {
    redirect_uris?: unknown;
    client_name?: unknown;
  };
  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === "string")
    : [];
  const clientName =
    typeof body.client_name === "string" ? body.client_name : "";

  const client = clientStore.register({ redirect_uris: redirectUris });
  console.log(
    `[oauth] register client_id=${client.client_id} ip=${clientIp(req)}`,
  );
  res.status(201).json({
    client_id: client.client_id,
    client_secret: client.client_secret,
    client_id_issued_at: client.client_id_issued_at,
    client_secret_issued_at: client.client_secret_issued_at,
    client_secret_expires_at: client.client_secret_expires_at,
    redirect_uris: client.redirect_uris,
    client_name: clientName,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_basic",
  });
}

// ──────────────────────────────────────────────────────────────────────
// /authorize — RFC 6749 with PKCE (S256 only), auto-approve
// ──────────────────────────────────────────────────────────────────────

export function authorizeHandler(req: Request, res: Response): void {
  if (!enforceLimit(authorizeLimiter, req, res)) return;

  console.log(
    `[oauth] authorize query=${JSON.stringify(req.query)} ip=${clientIp(req)}`,
  );

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

function issueTokenPair(
  origin: string,
  client_id: string,
  secret: string,
): { access_token: string; refresh_token: string } {
  const iat = Math.floor(Date.now() / 1000);
  const access_token = signJWT(
    {
      iss: origin,
      aud: origin,
      sub: "anonymous",
      client_id,
      iat,
      exp: iat + TOKEN_TTL_SEC,
      scope: TOKEN_SCOPE,
    },
    secret,
  );
  const refresh_token = signJWT(
    {
      iss: origin,
      aud: origin,
      sub: "anonymous",
      client_id,
      iat,
      exp: iat + REFRESH_TOKEN_TTL_SEC,
      typ: "refresh",
      scope: TOKEN_SCOPE,
    },
    secret,
  );
  return { access_token, refresh_token };
}

export function tokenHandler(req: Request, res: Response): void {
  if (!enforceLimit(tokenLimiter, req, res)) return;

  const body = (req.body ?? {}) as Record<string, string | undefined>;
  const grant_type = body.grant_type;

  console.log(
    `[oauth] token request grant_type=${body.grant_type} code=${String(body.code).slice(0, 8)} client_id=${body.client_id} redirect_uri=${body.redirect_uri} ip=${clientIp(req)}`,
  );

  if (grant_type !== "authorization_code" && grant_type !== "refresh_token") {
    res.status(400).json({
      error: "unsupported_grant_type",
      error_description:
        "Only authorization_code and refresh_token are supported.",
    });
    return;
  }

  const origin = originOf(req);
  const secret = getConfig().mcpJwtSecret;

  if (grant_type === "refresh_token") {
    const refresh_token = body.refresh_token;
    const client_id = body.client_id;
    if (!refresh_token || !client_id) {
      res.status(400).json({
        error: "invalid_request",
        error_description: "Missing required fields: refresh_token, client_id.",
      });
      return;
    }

    let payload;
    try {
      payload = verifyJWT(refresh_token, secret, { aud: origin });
    } catch {
      res.status(400).json({
        error: "invalid_grant",
        error_description: "Invalid or expired refresh token.",
      });
      console.warn(
        `[oauth] refresh invalid/expired token ip=${clientIp(req)} client=${client_id}`,
      );
      return;
    }

    if (payload.typ !== "refresh" || payload.client_id !== client_id) {
      res.status(400).json({
        error: "invalid_grant",
        error_description: "Refresh token does not match the provided client.",
      });
      return;
    }

    const tokens = issueTokenPair(origin, client_id, secret);
    console.log(
      `[oauth] token refreshed client_id=${client_id} ip=${clientIp(req)}`,
    );
    res.status(200).json({
      access_token: tokens.access_token,
      token_type: "Bearer",
      expires_in: TOKEN_TTL_SEC,
      refresh_token: tokens.refresh_token,
      scope: TOKEN_SCOPE,
    });
    return;
  }

  // authorization_code grant
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

  const tokens = issueTokenPair(origin, client_id, secret);
  console.log(
    `[oauth] token issued client_id=${client_id} aud=${origin} exp_in=${TOKEN_TTL_SEC}s`,
  );
  res.status(200).json({
    access_token: tokens.access_token,
    token_type: "Bearer",
    expires_in: TOKEN_TTL_SEC,
    refresh_token: tokens.refresh_token,
    scope: TOKEN_SCOPE,
  });
}

// ──────────────────────────────────────────────────────────────────────
// /revoke — RFC 7009 token revocation
// ──────────────────────────────────────────────────────────────────────

export function revocationHandler(_req: Request, res: Response): void {
  // RFC 7009: always return 200 regardless of token validity/existence.
  // We don't maintain a revocation list (tokens are short-lived); just ack.
  res.status(200).send();
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
  console.log(
    `[oauth] /mcp auth_header=${req.headers.authorization ? "bearer" : "none"} method=${req.method} path=${req.path}`,
  );

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
