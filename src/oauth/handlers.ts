// OAuth 2.1 ceremonial flow handlers for the Pathfinder MCP server.
//
// Anonymous OAuth: we run the full RFC 6749 / RFC 7636 (PKCE) / RFC 7591
// (dynamic registration) / RFC 8414 (AS metadata) / RFC 9728 (protected
// resource metadata) ceremony, and issue a JWT with sub: "anonymous". The
// /authorize GET now renders a server-side consent screen (signed nonce
// over the bound set; POSTed back to /authorize/consent) instead of
// auto-approving — a phishing-resistance hardening. The /mcp endpoint
// uses opportunistic bearer auth so existing unauthenticated clients keep
// working.

import type { Request, Response, NextFunction } from "express";
import { createHash, timingSafeEqual } from "node:crypto";

import { getConfig } from "../config.js";
import { clientStore, codeStore, ClientCapError } from "./store.js";
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
import {
  validateRedirectUri,
  validateRedirectUris,
} from "./redirect-uri-policy.js";
import { signConsentNonce } from "./consent-nonce.js";
import { renderConsentHtml } from "./consent-template.js";
import { oauthClientIp, isTrustingProxyForOauth } from "./trusted-client-ip.js";
import { oauthLog } from "./observability.js";

const TOKEN_TTL_SEC = 3600;
const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 3600; // 30 days
const CODE_TTL_MS = 600_000;
const TOKEN_SCOPE = "mcp";

function originOf(req: Request): string {
  // Same trust-proxy gate that guards `oauthClientIp`. If the deployment is
  // NOT configured to trust the upstream proxy, `X-Forwarded-Proto` is an
  // attacker-controlled header — honoring it would let a remote client flip
  // the discovery `resource`, AS `issuer`, and JWT `iss`/`aud` from `http://`
  // to `https://` (or to whatever scheme they choose), spoofing the protected
  // resource URL that clients use to fetch metadata and validate audiences.
  // When we don't trust the proxy, derive the scheme from the actual socket
  // (TLS-terminated → https) and fall back to Express's `req.protocol`, which
  // in unparenthesized form is what Express itself uses when XFP is untrusted.
  let proto: string;
  if (isTrustingProxyForOauth()) {
    proto =
      (req.headers["x-forwarded-proto"] as string) ||
      (req as unknown as { protocol?: string }).protocol ||
      "http";
  } else {
    const socketEncrypted = (req.socket as unknown as { encrypted?: boolean })
      ?.encrypted;
    proto = socketEncrypted
      ? "https"
      : ((req as unknown as { protocol?: string }).protocol ?? "http");
  }
  const host = req.headers.host ?? `localhost:${getConfig().port}`;
  return `${proto}://${host}`;
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
  const ip = oauthClientIp(req);
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

  const ip = oauthClientIp(req);
  console.log(
    `[oauth] register body=${JSON.stringify(req.body)} headers.origin=${req.headers.origin} headers.user-agent=${req.headers["user-agent"]}`,
  );

  const body = (req.body ?? {}) as {
    redirect_uris?: unknown;
    client_name?: unknown;
    token_endpoint_auth_method?: unknown;
    grant_types?: unknown;
    response_types?: unknown;
    scope?: unknown;
  };
  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === "string")
    : [];
  const clientName =
    typeof body.client_name === "string" ? body.client_name : "";

  // Apply redirect_uri policy BEFORE registration so a non-compliant client
  // never makes it into the store (and never consumes a per-IP/total slot).
  const policy = validateRedirectUris(redirectUris);
  if (!policy.ok) {
    oauthLog.registerRejected({
      reason: policy.reason,
      ip,
      index: policy.index,
    });
    res.status(400).json({
      error: "invalid_redirect_uri",
      error_description: `uri[${policy.index}]: ${policy.reason}`,
    });
    return;
  }

  // Honor the client's requested auth method if it's one we support; default to none
  const supportedAuthMethods = new Set([
    "client_secret_basic",
    "client_secret_post",
    "none",
  ]);
  const requestedAuthMethod =
    typeof body.token_endpoint_auth_method === "string" &&
    supportedAuthMethods.has(body.token_endpoint_auth_method)
      ? body.token_endpoint_auth_method
      : "none";

  let client;
  try {
    client = clientStore.register({
      redirect_uris: redirectUris,
      client_name: clientName,
      ip,
    });
  } catch (err) {
    if (err instanceof ClientCapError) {
      oauthLog.capOverflow({ scope: err.scope, ip });
      res.setHeader("Retry-After", "3600");
      res.status(err.scope === "per_ip" ? 429 : 503).json({
        error: "registration_rate_limited",
        error_description: `Client registration cap reached (${err.scope}).`,
      });
      return;
    }
    throw err;
  }

  oauthLog.register({ client_id: client.client_id, ip });
  console.log(
    `[oauth] register client_id=${client.client_id} ip=${ip}`,
  );
  res.status(201).json({
    client_id: client.client_id,
    client_secret: client.client_secret,
    client_id_issued_at: client.client_id_issued_at,
    client_secret_issued_at: client.client_secret_issued_at,
    client_secret_expires_at: client.client_secret_expires_at,
    redirect_uris: client.redirect_uris,
    // Echo the stored (truncated) name, not the raw input — keeps the wire
    // response in lockstep with what the server actually persisted.
    client_name: client.client_name,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: requestedAuthMethod,
    scope: TOKEN_SCOPE,
  });
}

// ──────────────────────────────────────────────────────────────────────
// /authorize — RFC 6749 with PKCE (S256 only), renders consent screen
// ──────────────────────────────────────────────────────────────────────

export function authorizeHandler(req: Request, res: Response): void {
  if (!enforceLimit(authorizeLimiter, req, res)) return;

  console.log(
    `[oauth] authorize query=${JSON.stringify(req.query)} ip=${oauthClientIp(req)}`,
  );

  const q = (req.query ?? {}) as Record<string, string | undefined>;
  const response_type = q.response_type;
  const client_id = q.client_id;
  const redirect_uri = q.redirect_uri;
  const code_challenge = q.code_challenge;
  const code_challenge_method = q.code_challenge_method;
  const state = q.state;
  const resource = q.resource;

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
      `[oauth] authorize unknown client_id=${client_id} ip=${oauthClientIp(req)}`,
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

  // Defense in depth: re-run the policy even though the URI was already
  // checked at /register. The policy can be tightened over time, and a
  // pre-existing registration must not get a free pass.
  const policy = validateRedirectUri(redirect_uri);
  if (!policy.ok) {
    oauthLog.registerRejected({
      reason: policy.reason,
      ip: oauthClientIp(req),
      client_id,
    });
    res.status(400).json({
      error: "invalid_redirect_uri",
      error_description: `redirect_uri rejected: ${policy.reason}`,
    });
    return;
  }

  // Liveness is bumped only on successful consent (POST /authorize/consent) and on successful token grants; an unauthenticated GET is not proof of life.

  const redirectHostname = new URL(redirect_uri).hostname;
  const ip = oauthClientIp(req);
  const exp = Date.now() + 10 * 60 * 1000;
  const nonce = signConsentNonce(
    {
      client_id,
      redirect_uri,
      state: state ?? "",
      code_challenge,
      code_challenge_method,
      response_type,
      scope: TOKEN_SCOPE,
      resource: resource ?? "",
      exp,
    },
    getConfig().oauthConsentHmacKeys,
  );

  const html = renderConsentHtml({
    clientName: client.client_name,
    clientId: client_id,
    redirectUri: redirect_uri,
    redirectUriHostname: redirectHostname,
    scope: TOKEN_SCOPE,
    state: state ?? "",
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method,
    responseType: response_type,
    resource: resource ?? "",
    nonce,
  });

  oauthLog.consentMinted({ client_id, ip, host: redirectHostname });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // Phishing-defense headers: the consent screen is the user's last line of
  // defense against UI-redress, so we forbid framing entirely and lock the
  // page down via CSP (no scripts, no external resources, inline-style only).
  // Referrer-Policy keeps the URL — which carries client_id + state — out of
  // any link the user might click off-page.
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  res.setHeader("Referrer-Policy", "no-referrer");
  res.status(200).send(html);
}

// ──────────────────────────────────────────────────────────────────────
// /token — RFC 6749 authorization_code grant with PKCE verification
// ──────────────────────────────────────────────────────────────────────

function issueTokenPair(
  origin: string,
  client_id: string,
  secret: string,
  resource?: string,
): { access_token: string; refresh_token: string } {
  const iat = Math.floor(Date.now() / 1000);
  const aud = resource || origin;
  const access_token = signJWT(
    {
      iss: origin,
      aud,
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
      aud,
      sub: "anonymous",
      client_id,
      iat,
      exp: iat + REFRESH_TOKEN_TTL_SEC,
      typ: "refresh",
      scope: TOKEN_SCOPE,
      resource,
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
    `[oauth] token request grant_type=${body.grant_type} code=${String(body.code).slice(0, 8)} client_id=${body.client_id} redirect_uri=${body.redirect_uri} ip=${oauthClientIp(req)}`,
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
        `[oauth] refresh invalid/expired token ip=${oauthClientIp(req)} client=${client_id}`,
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

    const storedResource =
      typeof payload.resource === "string" ? payload.resource : undefined;
    const tokens = issueTokenPair(origin, client_id, secret, storedResource);
    // Liveness: refresh-grant is one of the paths the eviction policy looks
    // at, so bump lastUsedAt on success.
    clientStore.touch(client_id);
    console.log(
      `[oauth] token refreshed client_id=${client_id} ip=${oauthClientIp(req)}`,
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
      `[oauth] token unknown/expired code ip=${oauthClientIp(req)} client=${client_id}`,
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
      `[oauth] token PKCE failure ip=${oauthClientIp(req)} client=${client_id}`,
    );
    return;
  }

  const tokens = issueTokenPair(origin, client_id, secret, record.resource);
  const aud = record.resource || origin;
  // Liveness: auth-code grant is the other path the eviction policy looks
  // at; bump lastUsedAt on success.
  clientStore.touch(client_id);
  console.log(
    `[oauth] token issued client_id=${client_id} aud=${aud} exp_in=${TOKEN_TTL_SEC}s`,
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
    // Verify signature + expiry without strict aud check
    const payload = verifyJWT(token, getConfig().mcpJwtSecret);
    // Accept aud matching origin with or without trailing slash (RFC 8707 resource)
    const origin = originOf(req);
    const validAuds = new Set([origin, `${origin}/`]);
    if (typeof payload.aud !== "string" || !validAuds.has(payload.aud)) {
      throw new InvalidAudience();
    }
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

function unauthorizedWithDiscovery(req: Request, res: Response): void {
  const origin = originOf(req);
  const resourceMetadata = `${origin}/.well-known/oauth-protected-resource`;
  res.setHeader(
    "WWW-Authenticate",
    `Bearer realm="mcp", resource_metadata="${resourceMetadata}", scope="${TOKEN_SCOPE}"`,
  );
  res.status(401).json({ error: "invalid_token" });
}
