import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";

// Use a stable secret so the handlers and our verifier both agree.
// `oauthConsentHmacKeys` MUST be present — the consent screen rendered by
// GET /authorize signs an HMAC nonce over the bound set, and POST
// /authorize/consent re-verifies it on the way back. Without this key,
// signConsentNonce throws and /authorize 500s.
vi.mock("../config.js", () => ({
  getConfig: vi.fn().mockReturnValue({
    port: 0,
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
    mcpJwtSecret: "e".repeat(64),
    oauthConsentHmacKeys: ["c".repeat(64)],
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
  type AuthContext,
} from "../oauth/handlers.js";
import { consentHandler } from "../oauth/consent-handler.js";
import { clientStore } from "../oauth/store.js";
import { setTrustingProxy } from "../oauth/trusted-client-ip.js";
import {
  registerLimiter,
  authorizeLimiter,
  tokenLimiter,
  consentLimiter,
} from "../oauth/rate-limiter.js";

function base64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  return b
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * Pull every `<input type="hidden" name="…" value="…">` out of the consent
 * screen HTML. Values are HTML-attribute encoded by `escHtml` in the
 * template, so we reverse the same five entities here. This is precisely
 * the shape a real browser submission would round-trip (sans the visible
 * `decision` button name, which the test supplies).
 */
function extractFormFields(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<input\s+type="hidden"\s+name="([^"]+)"\s+value="([^"]*)"\s*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out[m[1]!] = m[2]!
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }
  return out;
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.get("/.well-known/oauth-protected-resource", protectedResourceHandler);
  app.get(
    "/.well-known/oauth-authorization-server",
    authorizationServerHandler,
  );
  app.post("/register", registerHandler);
  app.get("/authorize", authorizeHandler);
  // The consent screen POSTs here; the e2e suite exercises both decisions.
  app.post("/authorize/consent", consentHandler);
  app.post("/token", tokenHandler);
  app.post("/revoke", revocationHandler);

  // Stub /mcp that echoes req.auth
  app.post(
    "/mcp",
    bearerMiddleware,
    (req: express.Request & { auth?: AuthContext }, res) => {
      res.json({ echoed_auth: req.auth ?? null });
    },
  );

  // Force the deterministic fail-safe so XFF-spoof scenarios reach their
  // intended assertion. The e2e harness inherits process-global state
  // from other test files; without this call `oauthClientIp` could fall
  // back to a trusting accessor and the cap-bypass test would mis-route
  // its IPs through XFF.
  setTrustingProxy(() => false);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

beforeEach(() => {
  // Reset rate-limiter buckets — registerLimiter is 10/min from the same
  // socket peer, and the e2e tests below hammer /register from 127.0.0.1
  // for the cap scenarios. Without a wipe the 11th call gets a generic
  // 429 from the rate limiter before our per-IP cap (or total cap) is
  // ever exercised.
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
  // Reset the client store between tests so per-IP / total caps are
  // measured against a clean baseline.
  const cs = clientStore as unknown as {
    clients: Map<string, unknown>;
    byIp: Map<string, Set<string>>;
    clientIpOf: Map<string, string>;
  };
  cs.clients.clear();
  cs.byIp.clear();
  cs.clientIpOf.clear();
  // Reset the deterministic trust-proxy fail-safe in case a previous test
  // (or another file under the same fork) flipped it.
  setTrustingProxy(() => false);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe("OAuth 2.1 end-to-end ceremonial flow", () => {
  it("completes register → authorize → consent (approve) → token → /mcp with Bearer", async () => {
    // 1. POST /register
    const registerRes = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [`${baseUrl}/cb`],
      }),
    });
    expect(registerRes.status).toBe(201);
    const { client_id } = (await registerRes.json()) as { client_id: string };
    expect(client_id).toBeTruthy();

    // 2. Generate PKCE pair
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());

    // 3. GET /authorize — now renders the consent HTML (200), not a 302.
    const authorizeUrl = new URL(`${baseUrl}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", client_id);
    authorizeUrl.searchParams.set("redirect_uri", `${baseUrl}/cb`);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", "abc");
    const authRes = await fetch(authorizeUrl.toString(), {
      redirect: "manual",
    });
    expect(authRes.status).toBe(200);
    expect(authRes.headers.get("content-type")).toMatch(/text\/html/);
    const html = await authRes.text();
    // Sanity-check shape — the consent form must include the hidden bound
    // set and the POST action our handler expects.
    expect(html).toMatch(
      /<form\s+method="POST"\s+action="\/authorize\/consent"/,
    );
    const hidden = extractFormFields(html);
    expect(hidden.nonce).toBeTruthy();
    expect(hidden.client_id).toBe(client_id);
    expect(hidden.redirect_uri).toBe(`${baseUrl}/cb`);
    expect(hidden.state).toBe("abc");
    expect(hidden.code_challenge).toBe(challenge);
    expect(hidden.code_challenge_method).toBe("S256");
    expect(hidden.response_type).toBe("code");
    expect(hidden.scope).toBe("mcp");

    // 3b. POST /authorize/consent with decision=approve — every hidden field
    // round-trips verbatim, plus the user's button click.
    const consentForm = new URLSearchParams();
    for (const [k, v] of Object.entries(hidden)) {
      consentForm.set(k, v);
    }
    consentForm.set("decision", "approve");
    const consentRes = await fetch(`${baseUrl}/authorize/consent`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: consentForm.toString(),
      redirect: "manual",
    });
    expect(consentRes.status).toBe(302);
    const location = consentRes.headers.get("location");
    expect(location).toBeTruthy();
    const redirected = new URL(location!);
    const code = redirected.searchParams.get("code");
    expect(code).toBeTruthy();
    expect(redirected.searchParams.get("state")).toBe("abc");
    // No error parameter on the approve branch.
    expect(redirected.searchParams.get("error")).toBeNull();

    // 4. POST /token (form-encoded)
    const form = new URLSearchParams();
    form.set("grant_type", "authorization_code");
    form.set("code", code!);
    form.set("code_verifier", verifier);
    form.set("client_id", client_id);
    form.set("redirect_uri", `${baseUrl}/cb`);
    const tokenRes = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = (await tokenRes.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
      refresh_token: string;
      scope: string;
    };
    expect(tokenBody.access_token).toBeTruthy();
    expect(tokenBody.token_type).toBe("Bearer");
    expect(tokenBody.expires_in).toBe(3600);
    expect(tokenBody.refresh_token).toBeTruthy();
    expect(tokenBody.scope).toBe("mcp");

    // 5. POST /mcp with Bearer — should attach req.auth
    const mcpRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenBody.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(mcpRes.status).toBe(200);
    const mcpBody = (await mcpRes.json()) as {
      echoed_auth: { sub: string; client_id: string } | null;
    };
    expect(mcpBody.echoed_auth).toEqual({ sub: "anonymous", client_id });

    // 6. Exchange refresh_token for a new access_token
    const refreshForm = new URLSearchParams();
    refreshForm.set("grant_type", "refresh_token");
    refreshForm.set("refresh_token", tokenBody.refresh_token);
    refreshForm.set("client_id", client_id);
    const refreshRes = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: refreshForm.toString(),
    });
    expect(refreshRes.status).toBe(200);
    const refreshBody = (await refreshRes.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
      refresh_token: string;
      scope: string;
    };
    expect(refreshBody.access_token).toBeTruthy();
    expect(refreshBody.refresh_token).toBeTruthy();
    expect(refreshBody.scope).toBe("mcp");

    // The refreshed access_token should also authenticate /mcp
    const mcp2 = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${refreshBody.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(mcp2.status).toBe(200);
  });

  it("AS metadata advertises refresh_token grant and revocation_endpoint", async () => {
    const res = await fetch(
      `${baseUrl}/.well-known/oauth-authorization-server`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      grant_types_supported: string[];
      revocation_endpoint: string;
      scopes_supported: string[];
      response_modes_supported: string[];
      token_endpoint_auth_methods_supported: string[];
    };
    expect(body.grant_types_supported).toContain("refresh_token");
    expect(body.revocation_endpoint).toBe(`${baseUrl}/revoke`);
    expect(body.scopes_supported).toContain("mcp");
    expect(body.response_modes_supported).toContain("query");
    expect(body.token_endpoint_auth_methods_supported).toEqual(
      expect.arrayContaining([
        "client_secret_basic",
        "client_secret_post",
        "none",
      ]),
    );
  });

  it("/revoke always returns 200 regardless of token", async () => {
    const res = await fetch(`${baseUrl}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "token=some-random-token",
    });
    expect(res.status).toBe(200);
  });

  it("/mcp succeeds with no Authorization header (opportunistic)", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      echoed_auth: unknown;
    };
    expect(body.echoed_auth).toBeNull();
  });

  it("/mcp returns 401 + WWW-Authenticate on garbage token", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer garbage.token.here",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    const www = res.headers.get("www-authenticate");
    expect(www).toContain('Bearer realm="mcp"');
    // RFC 9728: discovery URL advertised on WWW-Authenticate so the client
    // can fetch the protected-resource metadata document. The
    // `error="invalid_token"` code now lives in the JSON response body.
    expect(www).toContain("resource_metadata=");
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("invalid_token");
  });

  // ──────────────────────────────────────────────────────────────────
  // Consent flow — deny branch
  // ──────────────────────────────────────────────────────────────────

  it("deny branch redirects to redirect_uri with error=access_denied&state", async () => {
    // Register, render the consent screen, then POST decision=deny. The
    // deny redirect MUST land on the nonce-bound redirect_uri with
    // `error=access_denied` and the original `state` — and MUST NOT carry
    // a `code` parameter.
    const registerRes = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [`${baseUrl}/cb`] }),
    });
    expect(registerRes.status).toBe(201);
    const { client_id } = (await registerRes.json()) as { client_id: string };

    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());

    const authorizeUrl = new URL(`${baseUrl}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", client_id);
    authorizeUrl.searchParams.set("redirect_uri", `${baseUrl}/cb`);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", "deny-state");
    const authRes = await fetch(authorizeUrl.toString(), {
      redirect: "manual",
    });
    expect(authRes.status).toBe(200);
    const html = await authRes.text();
    const hidden = extractFormFields(html);

    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(hidden)) form.set(k, v);
    form.set("decision", "deny");
    const consentRes = await fetch(`${baseUrl}/authorize/consent`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      redirect: "manual",
    });
    expect(consentRes.status).toBe(302);
    const location = consentRes.headers.get("location");
    expect(location).toBeTruthy();
    const u = new URL(location!);
    // Nonce-bound URI wins — host + path must match the registration.
    expect(`${u.protocol}//${u.host}${u.pathname}`).toBe(`${baseUrl}/cb`);
    expect(u.searchParams.get("error")).toBe("access_denied");
    expect(u.searchParams.get("state")).toBe("deny-state");
    expect(u.searchParams.get("code")).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────
  // Register — redirect_uri policy (defense in depth)
  // ──────────────────────────────────────────────────────────────────

  it("POST /register rejects an RFC1918 redirect_uri → 400 invalid_redirect_uri", async () => {
    const res = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://10.0.0.5/cb"] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      error_description?: string;
    };
    expect(body.error).toBe("invalid_redirect_uri");
    // The handler echoes the policy reason in error_description; this is
    // exactly what T10 wires.
    expect(body.error_description).toMatch(/private_address/);
  });

  it("POST /register rejects a javascript: redirect_uri → 400 invalid_redirect_uri", async () => {
    const res = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["javascript:alert(1)//evil"],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_redirect_uri");
  });

  // ──────────────────────────────────────────────────────────────────
  // Register — caps (per-IP 429, total 503)
  // ──────────────────────────────────────────────────────────────────

  it("POST /register per-IP cap → 429 + Retry-After: 3600", async () => {
    // The e2e harness shares one socket peer (127.0.0.1), so by squeezing
    // `maxPerIp` we can trip the per-IP cap with a small number of calls
    // and prove that ClientCapError("per_ip") maps to 429 + Retry-After.
    // The rate-limiter buckets are wiped in beforeEach so its own 10/min
    // window doesn't pre-empt us with a generic 429.
    (clientStore as unknown as { maxPerIp: number }).maxPerIp = 2;
    try {
      for (let i = 0; i < 2; i++) {
        const ok = await fetch(`${baseUrl}/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ redirect_uris: [`${baseUrl}/cb`] }),
        });
        expect(ok.status).toBe(201);
      }
      const overflow = await fetch(`${baseUrl}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [`${baseUrl}/cb`] }),
      });
      expect(overflow.status).toBe(429);
      expect(overflow.headers.get("retry-after")).toBe("3600");
      const body = (await overflow.json()) as { error: string };
      expect(body.error).toBe("registration_rate_limited");
    } finally {
      (clientStore as unknown as { maxPerIp: number }).maxPerIp = 100;
    }
  });

  it("POST /register total cap → 503 + Retry-After: 3600", async () => {
    // Squeeze `maxTotal` so the second register from any IP trips the
    // total-cap branch. We keep `maxPerIp` permissive here so the per-IP
    // guard doesn't fire first.
    (clientStore as unknown as { maxTotal: number }).maxTotal = 1;
    try {
      const first = await fetch(`${baseUrl}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [`${baseUrl}/cb`] }),
      });
      expect(first.status).toBe(201);
      const overflow = await fetch(`${baseUrl}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [`${baseUrl}/cb`] }),
      });
      expect(overflow.status).toBe(503);
      expect(overflow.headers.get("retry-after")).toBe("3600");
      const body = (await overflow.json()) as { error: string };
      expect(body.error).toBe("registration_rate_limited");
    } finally {
      (clientStore as unknown as { maxTotal: number }).maxTotal = 10_000;
    }
  });

  it("X-Forwarded-For spoof does NOT bypass per-IP cap under trustProxy=false", async () => {
    // beforeEach already pinned `setTrustingProxy(() => false)`. Spoof the
    // XFF header on every request — the resolver MUST ignore it and bucket
    // all three calls under the loopback socket peer. The third call must
    // trip the per-IP cap=2 even though XFF rotates per request.
    (clientStore as unknown as { maxPerIp: number }).maxPerIp = 2;
    try {
      const statuses: number[] = [];
      const xffs = ["1.1.1.1", "2.2.2.2", "8.8.8.8"];
      for (const xff of xffs) {
        const res = await fetch(`${baseUrl}/register`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": xff,
          },
          body: JSON.stringify({ redirect_uris: [`${baseUrl}/cb`] }),
        });
        statuses.push(res.status);
      }
      expect(statuses[0]).toBe(201);
      expect(statuses[1]).toBe(201);
      // If XFF were honored, the third call would bucket under 8.8.8.8 and
      // 201 through. The cap MUST still fire because the resolver ignores
      // the spoofed header.
      expect(statuses[2]).toBe(429);
    } finally {
      (clientStore as unknown as { maxPerIp: number }).maxPerIp = 100;
    }
  });
});
