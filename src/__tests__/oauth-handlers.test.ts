import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";

// Mock the config module because handlers import it for origin derivation,
// JWT secret, server port, AND the consent-nonce HMAC keys (T02/T11).
vi.mock("../config.js", () => ({
  getConfig: vi.fn().mockReturnValue({
    port: 3001,
    databaseUrl: "pglite:///tmp/test",
    openaiApiKey: "",
    githubToken: "",
    githubWebhookSecret: "",
    nodeEnv: "test",
    logLevel: "info",
    cloneDir: "/tmp/test",
    slackBotToken: "",
    slackSigningSecret: "",
    discordBotToken: "",
    discordPublicKey: "",
    notionToken: "",
    mcpJwtSecret: "a".repeat(64),
    oauthConsentHmacKeys: ["a".repeat(64)],
    p2pTelemetryUrl: undefined,
    p2pTelemetryDisabled: false,
    packageVersion: "test",
  }),
  getServerConfig: vi.fn(),
  getAnalyticsConfig: vi.fn(),
  hasSearchTools: vi.fn().mockReturnValue(false),
  hasKnowledgeTools: vi.fn().mockReturnValue(false),
  hasCollectTools: vi.fn().mockReturnValue(false),
  hasBashSemanticSearch: vi.fn().mockReturnValue(false),
}));

import {
  protectedResourceHandler,
  authorizationServerHandler,
  registerHandler,
  authorizeHandler,
  tokenHandler,
  revocationHandler,
  bearerMiddleware,
} from "../oauth/handlers.js";
import { clientStore, codeStore } from "../oauth/store.js";
import { signJWT } from "../oauth/jwt.js";
import { setTrustingProxy } from "../oauth/trusted-client-ip.js";
import {
  registerLimiter,
  authorizeLimiter,
  tokenLimiter,
  consentLimiter,
} from "../oauth/rate-limiter.js";

function mockReq(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    headers: {
      host: "mcp.example.com",
      "x-forwarded-proto": "https",
      "x-forwarded-for": "1.2.3.4",
    },
    query: {},
    body: {},
    socket: { remoteAddress: "1.2.3.4" },
    ...overrides,
  };
}

function mockRes() {
  const json = vi.fn();
  const send = vi.fn();
  const redirect = vi.fn();
  const setHeader = vi.fn();
  const status = vi.fn().mockImplementation(() => ({ json, send }));
  return {
    json,
    send,
    redirect,
    setHeader,
    status,
    get statusCode() {
      return status.mock.calls.at(-1)?.[0];
    },
  };
}

// Reset singleton store state between tests by clearing internal maps.
// Since we don't want to export them, we use the module's exports and
// re-register for each test.

beforeEach(() => {
  // Reset stores — cast is safe; tests own the module
  const cs = clientStore as unknown as {
    clients: Map<string, unknown>;
    byIp: Map<string, Set<string>>;
    clientIpOf: Map<string, string>;
  };
  cs.clients.clear();
  cs.byIp.clear();
  cs.clientIpOf.clear();
  const cds = codeStore as unknown as { codes: Map<string, unknown> };
  cds.codes.clear();
  // Reset rate-limiter buckets so per-IP windows don't leak across tests.
  (
    registerLimiter as unknown as { buckets: Map<string, unknown> }
  ).buckets.clear();
  (
    authorizeLimiter as unknown as { buckets: Map<string, unknown> }
  ).buckets.clear();
  (
    tokenLimiter as unknown as { buckets: Map<string, unknown> }
  ).buckets.clear();
  (
    consentLimiter as unknown as { buckets: Map<string, unknown> }
  ).buckets.clear();
  // OAuth handlers consult `oauthClientIp(req)` AND `originOf` (via
  // `isTrustingProxyForOauth`) — both gated on the injected trustProxy
  // accessor. The bulk of this file's tests assert HTTPS metadata derived
  // from an `x-forwarded-proto: https` mock header, so the default for the
  // suite is `() => true` (i.e. trust the proxy). The two tests that need
  // the hardened path (`X-Forwarded-For under trustProxy=false`, and the
  // new `originOf ignores x-forwarded-proto when trustProxy=false`)
  // explicitly flip this back to `() => false` and rely on the afterEach
  // restore.
  setTrustingProxy(() => true);
});

afterEach(() => {
  setTrustingProxy(() => true);
});

describe("protectedResourceHandler", () => {
  it("returns resource + authorization_servers derived from host/proto", () => {
    const req = mockReq();
    const res = mockRes();
    protectedResourceHandler(req as never, res as never);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: "https://mcp.example.com",
        authorization_servers: ["https://mcp.example.com"],
        bearer_methods_supported: ["header"],
      }),
    );
  });

  it("falls back to http and request host when x-forwarded-proto missing", () => {
    const req = mockReq({
      headers: { host: "localhost:3001" },
    });
    const res = mockRes();
    protectedResourceHandler(req as never, res as never);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: "http://localhost:3001",
      }),
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// originOf — X-Forwarded-Proto trust-proxy gating
// ──────────────────────────────────────────────────────────────────────
//
// `originOf` is private to handlers.ts but every metadata/token path runs
// through it. We exercise the gate via the public surface
// (`protectedResourceHandler`) so the assertions ride on the same code path
// real clients hit. The headline finding is that an attacker who can speak
// directly to a non-proxied deployment must NOT be able to flip the
// discovery `resource` URL (and downstream JWT `iss`/`aud`) from http to
// https by sending `x-forwarded-proto: https`.

describe("originOf — XFP gating", () => {
  it("ignores x-forwarded-proto when trustProxy=false", () => {
    setTrustingProxy(() => false);
    const req = mockReq({
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
      },
      socket: { remoteAddress: "1.2.3.4" },
    });
    const res = mockRes();
    protectedResourceHandler(req as never, res as never);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: "http://mcp.example.com",
        authorization_servers: ["http://mcp.example.com"],
      }),
    );
  });

  it("honors x-forwarded-proto when trustProxy=true", () => {
    setTrustingProxy(() => true);
    const req = mockReq({
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
      },
      socket: { remoteAddress: "1.2.3.4" },
    });
    const res = mockRes();
    protectedResourceHandler(req as never, res as never);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: "https://mcp.example.com",
        authorization_servers: ["https://mcp.example.com"],
      }),
    );
  });

  it("uses https when the socket is TLS-encrypted, even with trustProxy=false", () => {
    // Direct TLS termination at this process (no upstream proxy) — the
    // socket's `encrypted` flag is the source of truth, not XFP.
    setTrustingProxy(() => false);
    const req = mockReq({
      headers: { host: "mcp.example.com" },
      socket: { remoteAddress: "1.2.3.4", encrypted: true },
    });
    const res = mockRes();
    protectedResourceHandler(req as never, res as never);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: "https://mcp.example.com",
      }),
    );
  });
});

describe("authorizationServerHandler", () => {
  it("returns complete AS metadata", () => {
    const req = mockReq();
    const res = mockRes();
    authorizationServerHandler(req as never, res as never);
    const body = res.json.mock.calls[0][0];
    expect(body.issuer).toBe("https://mcp.example.com");
    expect(body.authorization_endpoint).toBe(
      "https://mcp.example.com/authorize",
    );
    expect(body.token_endpoint).toBe("https://mcp.example.com/token");
    expect(body.registration_endpoint).toBe("https://mcp.example.com/register");
    expect(body.revocation_endpoint).toBe("https://mcp.example.com/revoke");
    expect(body.response_types_supported).toContain("code");
    expect(body.response_modes_supported).toContain("query");
    expect(body.grant_types_supported).toContain("authorization_code");
    expect(body.grant_types_supported).toContain("refresh_token");
    expect(body.code_challenge_methods_supported).toContain("S256");
    expect(body.code_challenge_methods_supported).not.toContain("plain");
    expect(body.token_endpoint_auth_methods_supported).toEqual(
      expect.arrayContaining([
        "client_secret_basic",
        "client_secret_post",
        "none",
      ]),
    );
    expect(body.scopes_supported).toContain("mcp");
  });
});

describe("registerHandler", () => {
  it("valid body returns 201 with UUID client_id, echoes redirect_uris", () => {
    const req = mockReq({
      body: { redirect_uris: ["https://claude.ai/cb"] },
    });
    const res = mockRes();
    registerHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(201);
    const body = res.json.mock.calls[0][0];
    expect(body.client_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(body.redirect_uris).toEqual(["https://claude.ai/cb"]);
  });

  it("returns client_secret + secret metadata + updated grant_types", () => {
    const req = mockReq({
      body: {
        redirect_uris: ["https://claude.ai/cb"],
        client_name: "Claude",
        token_endpoint_auth_method: "client_secret_basic",
      },
    });
    const res = mockRes();
    registerHandler(req as never, res as never);
    const body = res.json.mock.calls[0][0];
    expect(body.client_secret).toBeDefined();
    expect(typeof body.client_secret).toBe("string");
    expect(body.client_secret_issued_at).toBe(body.client_id_issued_at);
    expect(body.client_secret_expires_at).toBe(0);
    expect(body.client_name).toBe("Claude");
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(body.response_types).toEqual(["code"]);
    // Handler echoes the requested auth method (was previously hardcoded to client_secret_basic)
    expect(body.token_endpoint_auth_method).toBe("client_secret_basic");
  });

  it("echoes empty client_name when not provided", () => {
    const req = mockReq({
      body: { redirect_uris: ["https://claude.ai/cb"] },
    });
    const res = mockRes();
    registerHandler(req as never, res as never);
    const body = res.json.mock.calls[0][0];
    expect(body.client_name).toBe("");
  });

  it("rejects empty redirect_uris array (policy: at least one URI required)", () => {
    // T10 wired `validateRedirectUris` at /register, which rejects an empty
    // list with `reason: "empty"`. The pre-T10 behavior of accepting `[]`
    // and 201-ing is gone; clients MUST supply at least one redirect_uri.
    const req = mockReq({ body: { redirect_uris: [] } });
    const res = mockRes();
    registerHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toBe("invalid_redirect_uri");
  });

  it("rejects missing redirect_uris (treated as empty list)", () => {
    const req = mockReq({ body: {} });
    const res = mockRes();
    registerHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toBe("invalid_redirect_uri");
  });

  it("returns 429 + Retry-After when rate limited", () => {
    // Hammer the limiter from the same socket IP. registerLimiter is 10/min
    // (rate-limiter.ts:46) so the 11th call from the same IP trips the cap.
    for (let i = 0; i < 10; i++) {
      const res = mockRes();
      registerHandler(
        mockReq({
          body: { redirect_uris: ["https://claude.ai/cb"] },
        }) as never,
        res as never,
      );
    }
    const res = mockRes();
    registerHandler(
      mockReq({
        body: { redirect_uris: ["https://claude.ai/cb"] },
      }) as never,
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Retry-After",
      expect.any(String),
    );
  });

  it("truncates client_name longer than 80 chars in the echoed response", () => {
    // T07 stores `client_name.slice(0, 80)`; T10 echoes the STORED name in the
    // wire response (defense-in-depth against echo-vs-store divergence). A 200
    // char input must come back at exactly 80 chars.
    const longName = "x".repeat(200);
    const req = mockReq({
      body: {
        redirect_uris: ["https://claude.ai/cb"],
        client_name: longName,
      },
    });
    const res = mockRes();
    registerHandler(req as never, res as never);
    const body = res.json.mock.calls[0][0];
    expect(body.client_name.length).toBe(80);
    expect(body.client_name).toBe("x".repeat(80));
  });
});

// ──────────────────────────────────────────────────────────────────────
// Register — redirect_uri policy + per-IP / total cap
// ──────────────────────────────────────────────────────────────────────

describe("registerHandler — policy + cap", () => {
  it("rejects redirect_uri with private IP → 400 invalid_redirect_uri", () => {
    const req = mockReq({
      body: { redirect_uris: ["https://10.0.0.5/cb"] },
      socket: { remoteAddress: "5.5.5.1" },
    });
    const res = mockRes();
    registerHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.error).toBe("invalid_redirect_uri");
    expect(body.error_description).toMatch(/private_address/);
  });

  it("rejects http://example.com → 400 invalid_redirect_uri (scheme)", () => {
    const req = mockReq({
      body: { redirect_uris: ["http://example.com/cb"] },
      socket: { remoteAddress: "5.5.5.2" },
    });
    const res = mockRes();
    registerHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.error).toBe("invalid_redirect_uri");
    expect(body.error_description).toMatch(/scheme/);
  });

  it("accepts https + loopback", () => {
    // Two separate registrations: one https-anywhere, one http-loopback.
    const r1 = mockReq({
      body: { redirect_uris: ["https://claude.ai/cb"] },
      socket: { remoteAddress: "5.5.5.3" },
    });
    const res1 = mockRes();
    registerHandler(r1 as never, res1 as never);
    expect(res1.status).toHaveBeenCalledWith(201);

    const r2 = mockReq({
      body: { redirect_uris: ["http://localhost:8080/cb"] },
      socket: { remoteAddress: "5.5.5.4" },
    });
    const res2 = mockRes();
    registerHandler(r2 as never, res2 as never);
    expect(res2.status).toHaveBeenCalledWith(201);
  });

  it("per-IP cap → 429 with Retry-After: 3600", () => {
    // Squeeze the per-IP cap down so we can trip it without hammering the
    // store. Same socket IP across calls; rate-limiter buckets were cleared
    // in beforeEach so the 10/min register limiter doesn't pre-empt us.
    (clientStore as unknown as { maxPerIp: number }).maxPerIp = 2;
    try {
      const ip = "6.6.6.6";
      for (let i = 0; i < 2; i++) {
        const res = mockRes();
        registerHandler(
          mockReq({
            body: { redirect_uris: ["https://claude.ai/cb"] },
            socket: { remoteAddress: ip },
          }) as never,
          res as never,
        );
        expect(res.status).toHaveBeenCalledWith(201);
      }
      const res = mockRes();
      registerHandler(
        mockReq({
          body: { redirect_uris: ["https://claude.ai/cb"] },
          socket: { remoteAddress: ip },
        }) as never,
        res as never,
      );
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "3600");
      expect(res.json.mock.calls[0][0].error).toBe("registration_rate_limited");
    } finally {
      // Restore the production cap for downstream tests.
      (clientStore as unknown as { maxPerIp: number }).maxPerIp = 100;
    }
  });

  it("total cap → 503 with Retry-After: 3600", () => {
    // Drop maxTotal to a single slot, then register from one IP and try to
    // register from a different IP. The per-IP guard is set high so we
    // exercise the *total* branch deterministically.
    (clientStore as unknown as { maxTotal: number }).maxTotal = 1;
    try {
      const first = mockRes();
      registerHandler(
        mockReq({
          body: { redirect_uris: ["https://claude.ai/cb"] },
          socket: { remoteAddress: "7.7.7.1" },
        }) as never,
        first as never,
      );
      expect(first.status).toHaveBeenCalledWith(201);

      const second = mockRes();
      registerHandler(
        mockReq({
          body: { redirect_uris: ["https://claude.ai/cb"] },
          socket: { remoteAddress: "7.7.7.2" },
        }) as never,
        second as never,
      );
      expect(second.status).toHaveBeenCalledWith(503);
      expect(second.setHeader).toHaveBeenCalledWith("Retry-After", "3600");
      expect(second.json.mock.calls[0][0].error).toBe(
        "registration_rate_limited",
      );
    } finally {
      (clientStore as unknown as { maxTotal: number }).maxTotal = 10_000;
    }
  });

  it("X-Forwarded-For under trustProxy=false does NOT bypass per-IP cap", () => {
    // Spoofed XFF must be ignored. Explicitly flip trustProxy to false for
    // this test (the suite default is true, so XFF would normally be
    // honored). With trustProxy=false `oauthClientIp` resolves to
    // `req.socket.remoteAddress`, so three registers from the same socket
    // all bucket to the same IP and the third trips per-IP cap=2 — even
    // though XFF rotates per call.
    setTrustingProxy(() => false);
    (clientStore as unknown as { maxPerIp: number }).maxPerIp = 2;
    try {
      const socketIp = "8.8.8.10";
      const xffs = ["1.1.1.1", "2.2.2.2", "3.3.3.3"];
      const statuses: number[] = [];
      for (const xff of xffs) {
        const res = mockRes();
        registerHandler(
          mockReq({
            body: { redirect_uris: ["https://claude.ai/cb"] },
            headers: {
              host: "mcp.example.com",
              "x-forwarded-proto": "https",
              "x-forwarded-for": xff,
            },
            socket: { remoteAddress: socketIp },
          }) as never,
          res as never,
        );
        statuses.push(
          (res.status as unknown as { mock: { calls: number[][] } }).mock
            .calls[0][0],
        );
      }
      expect(statuses[0]).toBe(201);
      expect(statuses[1]).toBe(201);
      // Third register from the same socket IP must hit the per-IP cap.
      expect(statuses[2]).toBe(429);
    } finally {
      (clientStore as unknown as { maxPerIp: number }).maxPerIp = 100;
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Authorize — consent screen (T11)
// ──────────────────────────────────────────────────────────────────────
//
// Per the new flow (T11), GET /authorize NO LONGER auto-issues an
// authorization code via res.redirect(...). It renders an HMAC-bound
// consent screen with status 200 + text/html. The code is minted on the
// POST /authorize/consent handler (exercised in oauth-consent-handler
// and oauth-e2e tests).

describe("authorizeHandler", () => {
  it("renders consent HTML (200 text/html) on the happy path", () => {
    const client = clientStore.register({
      redirect_uris: ["https://claude.ai/cb"],
      client_name: "Claude",
      ip: "9.9.9.1",
    });
    const req = mockReq({
      query: {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "https://claude.ai/cb",
        code_challenge: "abc123xyz",
        code_challenge_method: "S256",
        state: "xyz",
      },
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "9.9.9.1",
      },
      socket: { remoteAddress: "9.9.9.1" },
    });
    const res = mockRes();
    authorizeHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "text/html; charset=utf-8",
    );
    // Body should be the consent HTML — quick smoke check on shape.
    expect(res.send).toHaveBeenCalled();
    const html = res.send.mock.calls[0][0] as string;
    expect(html).toMatch(/<!doctype html>/i);
    expect(html).toMatch(
      /<form\s+method="POST"\s+action="\/authorize\/consent"/,
    );
    // No code-bearing redirect anymore.
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("returns 400 on missing required params", () => {
    const req = mockReq({
      query: { response_type: "code" },
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "9.9.9.2",
      },
      socket: { remoteAddress: "9.9.9.2" },
    });
    const res = mockRes();
    authorizeHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.error).toBe("invalid_request");
  });

  it("rejects response_type other than code", () => {
    const client = clientStore.register({
      redirect_uris: ["https://claude.ai/cb"],
      ip: "9.9.9.3",
    });
    const req = mockReq({
      query: {
        response_type: "token",
        client_id: client.client_id,
        redirect_uri: "https://claude.ai/cb",
        code_challenge: "abc",
        code_challenge_method: "S256",
      },
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "9.9.9.3",
      },
      socket: { remoteAddress: "9.9.9.3" },
    });
    const res = mockRes();
    authorizeHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toBe("unsupported_response_type");
  });

  it("rejects code_challenge_method other than S256", () => {
    const client = clientStore.register({
      redirect_uris: ["https://claude.ai/cb"],
      ip: "9.9.9.4",
    });
    const req = mockReq({
      query: {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "https://claude.ai/cb",
        code_challenge: "abc",
        code_challenge_method: "plain",
      },
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "9.9.9.4",
      },
      socket: { remoteAddress: "9.9.9.4" },
    });
    const res = mockRes();
    authorizeHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toBe("invalid_request");
  });

  it("returns 400 unauthorized_client for unknown client_id", () => {
    const req = mockReq({
      query: {
        response_type: "code",
        client_id: "unknown",
        redirect_uri: "https://claude.ai/cb",
        code_challenge: "abc",
        code_challenge_method: "S256",
      },
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "9.9.9.5",
      },
      socket: { remoteAddress: "9.9.9.5" },
    });
    const res = mockRes();
    authorizeHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toBe("unauthorized_client");
  });

  it("returns 400 invalid_redirect_uri when redirect_uri not registered", () => {
    const client = clientStore.register({
      redirect_uris: ["https://claude.ai/cb"],
      ip: "9.9.9.6",
    });
    const req = mockReq({
      query: {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "https://evil.example/cb",
        code_challenge: "abc",
        code_challenge_method: "S256",
      },
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "9.9.9.6",
      },
      socket: { remoteAddress: "9.9.9.6" },
    });
    const res = mockRes();
    authorizeHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toBe("invalid_redirect_uri");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Authorize — consent (additional T14 coverage)
// ──────────────────────────────────────────────────────────────────────

describe("authorizeHandler — consent", () => {
  it("response is 200 text/html and contains client_name in the body", () => {
    const client = clientStore.register({
      redirect_uris: ["https://claude.ai/cb"],
      client_name: "Acme MCP Client",
      ip: "9.9.10.1",
    });
    const req = mockReq({
      query: {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "https://claude.ai/cb",
        code_challenge: "ch",
        code_challenge_method: "S256",
        state: "s",
      },
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "9.9.10.1",
      },
      socket: { remoteAddress: "9.9.10.1" },
    });
    const res = mockRes();
    authorizeHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "text/html; charset=utf-8",
    );
    const html = res.send.mock.calls[0][0] as string;
    expect(html).toContain("Acme MCP Client");
    // The bound set must round-trip via hidden fields so POST /authorize/consent
    // can re-verify the HMAC nonce.
    expect(html).toMatch(/name="nonce"\s+value="[^"]+"/);
    expect(html).toMatch(/name="client_id"\s+value="[^"]+"/);
    expect(html).toMatch(/name="redirect_uri"\s+value="[^"]+"/);
    expect(html).toMatch(/name="code_challenge"\s+value="[^"]+"/);
  });

  it("does NOT touch the client (liveness only fires post-consent)", () => {
    // Anonymous GET /authorize must not bump `lastUsedAt` — a passing stranger
    // can hit this endpoint with any client_id and would otherwise be able to
    // keep arbitrary clients alive against TTL eviction. Liveness fires only
    // on successful consent (POST /authorize/consent) and successful token
    // grants.
    const client = clientStore.register({
      redirect_uris: ["https://claude.ai/cb"],
      client_name: "Claude",
      ip: "9.9.11.1",
    });
    const touchSpy = vi.spyOn(clientStore, "touch");
    const req = mockReq({
      query: {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "https://claude.ai/cb",
        code_challenge: "ch",
        code_challenge_method: "S256",
        state: "s",
      },
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "9.9.11.1",
      },
      socket: { remoteAddress: "9.9.11.1" },
    });
    const res = mockRes();
    authorizeHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(touchSpy).not.toHaveBeenCalled();
    touchSpy.mockRestore();
  });

  it("sets X-Frame-Options DENY, CSP frame-ancestors 'none', and Referrer-Policy no-referrer", () => {
    // The consent page is the user's last line of defense against UI-redress
    // phishing; clickjacking must be impossible. We assert each header is set
    // explicitly so a regression that drops one is caught.
    const client = clientStore.register({
      redirect_uris: ["https://claude.ai/cb"],
      client_name: "Claude",
      ip: "9.9.11.2",
    });
    const req = mockReq({
      query: {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "https://claude.ai/cb",
        code_challenge: "ch",
        code_challenge_method: "S256",
        state: "s",
      },
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "9.9.11.2",
      },
      socket: { remoteAddress: "9.9.11.2" },
    });
    const res = mockRes();
    authorizeHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.setHeader).toHaveBeenCalledWith("X-Frame-Options", "DENY");
    expect(res.setHeader).toHaveBeenCalledWith(
      "Referrer-Policy",
      "no-referrer",
    );
    // CSP must include frame-ancestors 'none' (clickjacking) and form-action
    // 'self' (locks the Approve POST destination to our origin).
    const cspCall = (
      res.setHeader as unknown as {
        mock: { calls: [string, string][] };
      }
    ).mock.calls.find(([h]) => h === "Content-Security-Policy");
    expect(cspCall).toBeDefined();
    const csp = cspCall![1];
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  it("returns 400 if redirect_uri fails policy (defense-in-depth re-check)", () => {
    // A client whose redirect_uri list contains a policy-violating entry
    // shouldn't exist after T10 (registration would 400). But the policy
    // can be tightened over time, and existing registrations must not get
    // a free pass at /authorize. We simulate by inserting a record directly
    // into the singleton store, bypassing `register`'s policy check.
    const directlyInjected = {
      client_id: "legacy-bad",
      client_secret: "x",
      client_id_issued_at: 0,
      client_secret_issued_at: 0,
      client_secret_expires_at: 0,
      redirect_uris: ["http://example.com/cb"],
      client_name: "Legacy",
      registeredAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    (clientStore as unknown as { clients: Map<string, unknown> }).clients.set(
      "legacy-bad",
      directlyInjected,
    );

    const req = mockReq({
      query: {
        response_type: "code",
        client_id: "legacy-bad",
        redirect_uri: "http://example.com/cb",
        code_challenge: "abc",
        code_challenge_method: "S256",
      },
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "9.9.10.2",
      },
      socket: { remoteAddress: "9.9.10.2" },
    });
    const res = mockRes();
    authorizeHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toBe("invalid_redirect_uri");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Token
// ──────────────────────────────────────────────────────────────────────

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function pkcePair() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

describe("tokenHandler", () => {
  it("returns 400 unsupported_grant_type for unrecognized grant_type", () => {
    const req = mockReq({
      body: { grant_type: "client_credentials" },
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "8.8.8.1",
      },
    });
    const res = mockRes();
    tokenHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toBe("unsupported_grant_type");
  });

  it("returns 400 invalid_request on missing fields", () => {
    const req = mockReq({
      body: { grant_type: "authorization_code" },
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "8.8.8.2",
      },
    });
    const res = mockRes();
    tokenHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toBe("invalid_request");
  });

  it("returns 400 invalid_grant for unknown code", () => {
    const req = mockReq({
      body: {
        grant_type: "authorization_code",
        code: "nope",
        code_verifier: "v",
        client_id: "c",
        redirect_uri: "https://x.example/cb",
      },
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "8.8.8.3",
      },
    });
    const res = mockRes();
    tokenHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toBe("invalid_grant");
  });

  it("returns 400 invalid_grant on PKCE mismatch", () => {
    const client = clientStore.register({
      redirect_uris: ["https://x.example/cb"],
      ip: "8.8.8.4",
    });
    const { challenge } = pkcePair();
    const { code } = codeStore.issue({
      clientId: client.client_id,
      codeChallenge: challenge,
      redirectUri: "https://x.example/cb",
      ttlMs: 600_000,
    });
    const req = mockReq({
      body: {
        grant_type: "authorization_code",
        code,
        code_verifier: "wrong-verifier-not-matching",
        client_id: client.client_id,
        redirect_uri: "https://x.example/cb",
      },
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "8.8.8.4",
      },
    });
    const res = mockRes();
    tokenHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toBeTruthy();
  });

  it("issues JWT on valid PKCE (RFC 7636 fixture)", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    const client = clientStore.register({
      redirect_uris: ["https://x.example/cb"],
      ip: "8.8.8.5",
    });
    const { code } = codeStore.issue({
      clientId: client.client_id,
      codeChallenge: challenge,
      redirectUri: "https://x.example/cb",
      ttlMs: 600_000,
    });
    const req = mockReq({
      body: {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: client.client_id,
        redirect_uri: "https://x.example/cb",
      },
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "8.8.8.5",
      },
    });
    const res = mockRes();
    tokenHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.access_token).toBeDefined();
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(3600);
    expect(body.refresh_token).toBeDefined();
    expect(typeof body.refresh_token).toBe("string");
    expect(body.scope).toBe("mcp");
  });

  it("decoded JWT contains expected claims with exp - iat === 3600", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    const client = clientStore.register({
      redirect_uris: ["https://x.example/cb"],
      ip: "8.8.8.6",
    });
    const { code } = codeStore.issue({
      clientId: client.client_id,
      codeChallenge: challenge,
      redirectUri: "https://x.example/cb",
      ttlMs: 600_000,
    });
    const req = mockReq({
      body: {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: client.client_id,
        redirect_uri: "https://x.example/cb",
      },
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "8.8.8.6",
      },
    });
    const res = mockRes();
    tokenHandler(req as never, res as never);
    const body = res.json.mock.calls[0][0];
    const [, payloadB64] = (body.access_token as string).split(".");
    const pad = "=".repeat((4 - (payloadB64.length % 4)) % 4);
    const payload = JSON.parse(
      Buffer.from(
        payloadB64.replace(/-/g, "+").replace(/_/g, "/") + pad,
        "base64",
      ).toString("utf8"),
    );
    expect(payload.sub).toBe("anonymous");
    expect(payload.aud).toBe("https://mcp.example.com");
    expect(payload.iss).toBe("https://mcp.example.com");
    expect(payload.client_id).toBe(client.client_id);
    expect(payload.exp - payload.iat).toBe(3600);
  });

  it("returns 400 invalid_grant on redirect_uri mismatch", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    const client = clientStore.register({
      redirect_uris: ["https://x.example/cb"],
      ip: "8.8.8.7",
    });
    const { code } = codeStore.issue({
      clientId: client.client_id,
      codeChallenge: challenge,
      redirectUri: "https://x.example/cb",
      ttlMs: 600_000,
    });
    const req = mockReq({
      body: {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: client.client_id,
        redirect_uri: "https://different.example/cb",
      },
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "8.8.8.7",
      },
    });
    const res = mockRes();
    tokenHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toBe("invalid_grant");
  });

  it("code is one-time use (second call fails)", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    const client = clientStore.register({
      redirect_uris: ["https://x.example/cb"],
      ip: "8.8.8.8",
    });
    const { code } = codeStore.issue({
      clientId: client.client_id,
      codeChallenge: challenge,
      redirectUri: "https://x.example/cb",
      ttlMs: 600_000,
    });
    const body = {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: "https://x.example/cb",
    };
    const headers = {
      host: "mcp.example.com",
      "x-forwarded-proto": "https",
      "x-forwarded-for": "8.8.8.8",
    };
    const first = mockRes();
    tokenHandler(mockReq({ body, headers }) as never, first as never);
    expect(first.status).toHaveBeenCalledWith(200);

    const second = mockRes();
    tokenHandler(mockReq({ body, headers }) as never, second as never);
    expect(second.status).toHaveBeenCalledWith(400);
    expect(second.json.mock.calls[0][0].error).toBe("invalid_grant");
  });

  it("access_token payload includes scope: 'mcp'", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    const client = clientStore.register({
      redirect_uris: ["https://x.example/cb"],
      ip: "8.8.8.10",
    });
    const { code } = codeStore.issue({
      clientId: client.client_id,
      codeChallenge: challenge,
      redirectUri: "https://x.example/cb",
      ttlMs: 600_000,
    });
    const req = mockReq({
      body: {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: client.client_id,
        redirect_uri: "https://x.example/cb",
      },
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "8.8.8.10",
      },
    });
    const res = mockRes();
    tokenHandler(req as never, res as never);
    const body = res.json.mock.calls[0][0];
    const [, payloadB64] = (body.access_token as string).split(".");
    const pad = "=".repeat((4 - (payloadB64.length % 4)) % 4);
    const payload = JSON.parse(
      Buffer.from(
        payloadB64.replace(/-/g, "+").replace(/_/g, "/") + pad,
        "base64",
      ).toString("utf8"),
    );
    expect(payload.scope).toBe("mcp");
  });

  it("auth-code grant bumps client lastUsedAt via clientStore.touch", () => {
    // Both grant branches must call clientStore.touch(client_id) so the
    // eviction policy's "used recently" measure stays current. We verify by
    // spying on the touch method.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    const client = clientStore.register({
      redirect_uris: ["https://x.example/cb"],
      ip: "8.8.8.11",
    });
    const { code } = codeStore.issue({
      clientId: client.client_id,
      codeChallenge: challenge,
      redirectUri: "https://x.example/cb",
      ttlMs: 600_000,
    });
    const touchSpy = vi.spyOn(clientStore, "touch");
    const req = mockReq({
      body: {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: client.client_id,
        redirect_uri: "https://x.example/cb",
      },
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "8.8.8.11",
      },
    });
    const res = mockRes();
    tokenHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(touchSpy).toHaveBeenCalledWith(client.client_id);
    touchSpy.mockRestore();
  });

  it("accepts form-encoded bodies (Express urlencoded parser)", () => {
    // The Express urlencoded parser produces req.body the same shape as JSON,
    // so this exercises the same code path. We document that here.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    const client = clientStore.register({
      redirect_uris: ["https://x.example/cb"],
      ip: "8.8.8.9",
    });
    const { code } = codeStore.issue({
      clientId: client.client_id,
      codeChallenge: challenge,
      redirectUri: "https://x.example/cb",
      ttlMs: 600_000,
    });
    const req = mockReq({
      body: {
        // Express urlencoded would produce this same object
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: client.client_id,
        redirect_uri: "https://x.example/cb",
      },
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "8.8.8.9",
        "content-type": "application/x-www-form-urlencoded",
      },
    });
    const res = mockRes();
    tokenHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Refresh token grant
// ──────────────────────────────────────────────────────────────────────

function issueInitialTokens(clientXForwardedFor: string): {
  client_id: string;
  refresh_token: string;
  access_token: string;
} {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  const client = clientStore.register({
    redirect_uris: ["https://x.example/cb"],
    ip: clientXForwardedFor,
  });
  const { code } = codeStore.issue({
    clientId: client.client_id,
    codeChallenge: challenge,
    redirectUri: "https://x.example/cb",
    ttlMs: 600_000,
  });
  const req = mockReq({
    body: {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: "https://x.example/cb",
    },
    headers: {
      host: "mcp.example.com",
      "x-forwarded-proto": "https",
      "x-forwarded-for": clientXForwardedFor,
    },
  });
  const res = mockRes();
  tokenHandler(req as never, res as never);
  const body = res.json.mock.calls[0][0];
  return {
    client_id: client.client_id,
    refresh_token: body.refresh_token,
    access_token: body.access_token,
  };
}

describe("tokenHandler — refresh_token grant", () => {
  it("exchanges a valid refresh_token for a new access+refresh pair", () => {
    const initial = issueInitialTokens("7.7.7.1");
    const req = mockReq({
      body: {
        grant_type: "refresh_token",
        refresh_token: initial.refresh_token,
        client_id: initial.client_id,
      },
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "7.7.7.2",
      },
    });
    const res = mockRes();
    tokenHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.access_token).toBeDefined();
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(3600);
    expect(body.refresh_token).toBeDefined();
    expect(body.scope).toBe("mcp");
  });

  it("returns 400 invalid_request on missing refresh_token or client_id", () => {
    const req = mockReq({
      body: { grant_type: "refresh_token" },
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "7.7.7.3",
      },
    });
    const res = mockRes();
    tokenHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toBe("invalid_request");
  });

  it("returns 400 invalid_grant on garbage refresh token", () => {
    const req = mockReq({
      body: {
        grant_type: "refresh_token",
        refresh_token: "not.a.valid.jwt",
        client_id: "anything",
      },
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "7.7.7.4",
      },
    });
    const res = mockRes();
    tokenHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toBe("invalid_grant");
  });

  it("returns 400 invalid_grant when access_token is presented as refresh_token (missing typ)", () => {
    const initial = issueInitialTokens("7.7.7.5");
    const req = mockReq({
      body: {
        grant_type: "refresh_token",
        refresh_token: initial.access_token, // access token has no typ:"refresh"
        client_id: initial.client_id,
      },
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "7.7.7.6",
      },
    });
    const res = mockRes();
    tokenHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toBe("invalid_grant");
  });

  it("returns 400 invalid_grant when client_id does not match the refresh token", () => {
    const initial = issueInitialTokens("7.7.7.7");
    const req = mockReq({
      body: {
        grant_type: "refresh_token",
        refresh_token: initial.refresh_token,
        client_id: "some-other-client",
      },
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "7.7.7.8",
      },
    });
    const res = mockRes();
    tokenHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toBe("invalid_grant");
  });

  it("refresh-token grant bumps client lastUsedAt via clientStore.touch", () => {
    const initial = issueInitialTokens("7.7.7.9");
    const touchSpy = vi.spyOn(clientStore, "touch");
    const req = mockReq({
      body: {
        grant_type: "refresh_token",
        refresh_token: initial.refresh_token,
        client_id: initial.client_id,
      },
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "7.7.7.10",
      },
    });
    const res = mockRes();
    tokenHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(touchSpy).toHaveBeenCalledWith(initial.client_id);
    touchSpy.mockRestore();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Revocation
// ──────────────────────────────────────────────────────────────────────

describe("revocationHandler", () => {
  it("returns 200 for any request body (RFC 7009 always-ack)", () => {
    const req = mockReq({ body: { token: "whatever" } });
    const res = mockRes();
    revocationHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalled();
  });

  it("returns 200 when no body is sent", () => {
    const req = mockReq();
    const res = mockRes();
    revocationHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Bearer middleware
// ──────────────────────────────────────────────────────────────────────

describe("bearerMiddleware", () => {
  it("calls next() when no Authorization header (opportunistic)", () => {
    const req = mockReq({ headers: { host: "mcp.example.com" } });
    const res = mockRes();
    const next = vi.fn();
    bearerMiddleware(req as never, res as never, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("calls next() when Authorization header lacks Bearer prefix", () => {
    const req = mockReq({
      headers: { host: "mcp.example.com", authorization: "Basic abc" },
    });
    const res = mockRes();
    const next = vi.fn();
    bearerMiddleware(req as never, res as never, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("attaches req.auth and calls next on valid JWT", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signJWT(
      {
        sub: "anonymous",
        iss: "https://mcp.example.com",
        aud: "https://mcp.example.com",
        client_id: "cli-1",
        iat: now,
        exp: now + 3600,
      },
      "a".repeat(64),
    );
    const req = mockReq({
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        authorization: `Bearer ${token}`,
      },
    });
    const res = mockRes();
    const next = vi.fn();
    bearerMiddleware(req as never, res as never, next);
    expect(next).toHaveBeenCalled();
    expect((req as { auth?: { sub: string; client_id: string } }).auth).toEqual(
      { sub: "anonymous", client_id: "cli-1" },
    );
  });

  it("returns 401 + WWW-Authenticate on expired token", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signJWT(
      {
        sub: "x",
        aud: "https://mcp.example.com",
        iat: now - 7200,
        exp: now - 3600,
      },
      "a".repeat(64),
    );
    const req = mockReq({
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        authorization: `Bearer ${token}`,
      },
    });
    const res = mockRes();
    const next = vi.fn();
    bearerMiddleware(req as never, res as never, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.setHeader).toHaveBeenCalledWith(
      "WWW-Authenticate",
      expect.stringContaining('Bearer realm="mcp"'),
    );
    // RFC 9728: `WWW-Authenticate` advertises `resource_metadata=` so
    // clients can discover the protected-resource document. Per RFC 6750
    // §3.1, when a Bearer token is present-but-invalid the `error=`
    // attribute MUST also be in the `WWW-Authenticate` header (it is
    // additionally returned in the JSON body).
    expect(res.setHeader).toHaveBeenCalledWith(
      "WWW-Authenticate",
      expect.stringContaining("resource_metadata="),
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      "WWW-Authenticate",
      expect.stringContaining('error="invalid_token"'),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 on wrong-signature token", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signJWT(
      { sub: "x", iat: now, exp: now + 3600 },
      "wrong-secret-xxxxxxxxxxxxxxxx",
    );
    const req = mockReq({
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        authorization: `Bearer ${token}`,
      },
    });
    const res = mockRes();
    const next = vi.fn();
    bearerMiddleware(req as never, res as never, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 on aud mismatch", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signJWT(
      {
        sub: "x",
        aud: "https://other.example",
        iat: now,
        exp: now + 3600,
      },
      "a".repeat(64),
    );
    const req = mockReq({
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        authorization: `Bearer ${token}`,
      },
    });
    const res = mockRes();
    const next = vi.fn();
    bearerMiddleware(req as never, res as never, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 on empty Bearer token", () => {
    const req = mockReq({
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        authorization: "Bearer ",
      },
    });
    const res = mockRes();
    const next = vi.fn();
    bearerMiddleware(req as never, res as never, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────
  // RFC 9728 — every Bearer 401 must include `resource_metadata=` on
  // `WWW-Authenticate` so clients can discover the protected-resource
  // metadata document. The helper at handlers.ts:626 constructs the URL
  // from `originOf(req)` + "/.well-known/oauth-protected-resource"; tests
  // mirror that construction to detect drift.
  // ──────────────────────────────────────────────────────────────────────
  describe("RFC 9728 resource_metadata discovery on 401", () => {
    const expectedResourceMetadata =
      "https://mcp.example.com/.well-known/oauth-protected-resource";

    function assertDiscoveryHeader(
      res: ReturnType<typeof mockRes>,
      next: ReturnType<typeof vi.fn>,
    ): void {
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
      expect(res.setHeader).toHaveBeenCalledWith(
        "WWW-Authenticate",
        expect.stringContaining("Bearer"),
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        "WWW-Authenticate",
        expect.stringContaining(
          `resource_metadata="${expectedResourceMetadata}"`,
        ),
      );
      // RFC 6750 §3.1 — when a Bearer token is present-but-invalid the
      // `error=` attribute MUST appear in `WWW-Authenticate`.
      expect(res.setHeader).toHaveBeenCalledWith(
        "WWW-Authenticate",
        expect.stringContaining('error="invalid_token"'),
      );
    }

    it("empty Bearer token → 401 + resource_metadata", () => {
      const req = mockReq({
        headers: {
          host: "mcp.example.com",
          "x-forwarded-proto": "https",
          authorization: "Bearer ",
        },
      });
      const res = mockRes();
      const next = vi.fn();
      bearerMiddleware(req as never, res as never, next);
      assertDiscoveryHeader(res, next);
    });

    it("invalid signature → 401 + resource_metadata", () => {
      const now = Math.floor(Date.now() / 1000);
      const token = signJWT(
        {
          sub: "x",
          aud: "https://mcp.example.com",
          iat: now,
          exp: now + 3600,
        },
        "wrong-secret-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      );
      const req = mockReq({
        headers: {
          host: "mcp.example.com",
          "x-forwarded-proto": "https",
          authorization: `Bearer ${token}`,
        },
      });
      const res = mockRes();
      const next = vi.fn();
      bearerMiddleware(req as never, res as never, next);
      assertDiscoveryHeader(res, next);
    });

    it("expired token → 401 + resource_metadata", () => {
      const now = Math.floor(Date.now() / 1000);
      const token = signJWT(
        {
          sub: "x",
          aud: "https://mcp.example.com",
          iat: now - 7200,
          exp: now - 3600,
        },
        "a".repeat(64),
      );
      const req = mockReq({
        headers: {
          host: "mcp.example.com",
          "x-forwarded-proto": "https",
          authorization: `Bearer ${token}`,
        },
      });
      const res = mockRes();
      const next = vi.fn();
      bearerMiddleware(req as never, res as never, next);
      assertDiscoveryHeader(res, next);
    });

    it("aud mismatch → 401 + resource_metadata", () => {
      const now = Math.floor(Date.now() / 1000);
      const token = signJWT(
        {
          sub: "x",
          aud: "https://other.example",
          iat: now,
          exp: now + 3600,
        },
        "a".repeat(64),
      );
      const req = mockReq({
        headers: {
          host: "mcp.example.com",
          "x-forwarded-proto": "https",
          authorization: `Bearer ${token}`,
        },
      });
      const res = mockRes();
      const next = vi.fn();
      bearerMiddleware(req as never, res as never, next);
      assertDiscoveryHeader(res, next);
    });
  });
});

// Keep module-level state from leaking across files
afterEach(() => {
  vi.restoreAllMocks();
});
