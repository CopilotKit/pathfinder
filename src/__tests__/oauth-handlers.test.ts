import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";

// Mock the config module because handlers import it for origin derivation,
// JWT secret, and server port.
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
  const cs = clientStore as unknown as { clients: Map<string, unknown> };
  cs.clients.clear();
  const cds = codeStore as unknown as { codes: Map<string, unknown> };
  cds.codes.clear();
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
      body: { redirect_uris: [] },
    });
    const res = mockRes();
    registerHandler(req as never, res as never);
    const body = res.json.mock.calls[0][0];
    expect(body.client_name).toBe("");
  });

  it("accepts missing redirect_uris as empty array", () => {
    const req = mockReq({ body: {} });
    const res = mockRes();
    registerHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(201);
    const body = res.json.mock.calls[0][0];
    expect(body.redirect_uris).toEqual([]);
  });

  it("returns 429 + Retry-After when rate limited", () => {
    for (let i = 0; i < 10; i++) {
      const res = mockRes();
      registerHandler(mockReq({ body: {} }) as never, res as never);
    }
    const res = mockRes();
    registerHandler(mockReq({ body: {} }) as never, res as never);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Retry-After",
      expect.any(String),
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// Authorize
// ──────────────────────────────────────────────────────────────────────

describe("authorizeHandler", () => {
  beforeEach(() => {
    // Rate limiter isolation — use a new IP per test to avoid register-test bleed
  });

  it("redirects with code + state on happy path", () => {
    const client = clientStore.register({
      redirect_uris: ["https://claude.ai/cb"],
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
    });
    const res = mockRes();
    authorizeHandler(req as never, res as never);
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringMatching(
        /^https:\/\/claude\.ai\/cb\?code=[0-9a-f-]+&state=xyz$/,
      ),
    );
  });

  it("returns 400 on missing required params", () => {
    const req = mockReq({
      query: { response_type: "code" },
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "9.9.9.2",
      },
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
    });
    const res = mockRes();
    authorizeHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toBe("unsupported_response_type");
  });

  it("rejects code_challenge_method other than S256", () => {
    const client = clientStore.register({
      redirect_uris: ["https://claude.ai/cb"],
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
    });
    const res = mockRes();
    authorizeHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toBe("unauthorized_client");
  });

  it("returns 400 invalid_redirect_uri when redirect_uri not registered", () => {
    const client = clientStore.register({
      redirect_uris: ["https://claude.ai/cb"],
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
    });
    const res = mockRes();
    authorizeHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toBe("invalid_redirect_uri");
  });

  it("accepts redirect_uri when client has empty registered list", () => {
    const client = clientStore.register({ redirect_uris: [] });
    const req = mockReq({
      query: {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "https://anywhere.example/cb",
        code_challenge: "abc",
        code_challenge_method: "S256",
      },
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "9.9.9.7",
      },
    });
    const res = mockRes();
    authorizeHandler(req as never, res as never);
    expect(res.redirect).toHaveBeenCalled();
  });

  it("stores code in codeStore for later consumption", () => {
    const client = clientStore.register({
      redirect_uris: ["https://claude.ai/cb"],
    });
    const req = mockReq({
      query: {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "https://claude.ai/cb",
        code_challenge: "ch",
        code_challenge_method: "S256",
      },
      headers: {
        host: "mcp.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "9.9.9.8",
      },
    });
    const res = mockRes();
    authorizeHandler(req as never, res as never);
    const redirectArg = res.redirect.mock.calls[0][0] as string;
    const url = new URL(redirectArg);
    const code = url.searchParams.get("code")!;
    const consumed = codeStore.consume(code);
    expect(consumed?.clientId).toBe(client.client_id);
    expect(consumed?.codeChallenge).toBe("ch");
    expect(consumed?.redirectUri).toBe("https://claude.ai/cb");
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

  it("accepts form-encoded bodies (Express urlencoded parser)", () => {
    // The Express urlencoded parser produces req.body the same shape as JSON,
    // so this exercises the same code path. We document that here.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    const client = clientStore.register({
      redirect_uris: ["https://x.example/cb"],
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
});

// Keep module-level state from leaking across files
afterEach(() => {
  vi.restoreAllMocks();
});
