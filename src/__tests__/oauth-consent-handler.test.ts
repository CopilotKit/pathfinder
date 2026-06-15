import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock config — the consent handler reads getConfig().oauthConsentHmacKeys
// to verify the signed nonce. Use a stable key so tests can sign payloads
// with the same value via the real signConsentNonce.
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

import { consentHandler } from "../oauth/consent-handler.js";
import {
  signConsentNonce,
  type ConsentNoncePayload,
} from "../oauth/consent-nonce.js";
import { clientStore, codeStore } from "../oauth/store.js";
import { setTrustingProxy } from "../oauth/trusted-client-ip.js";
import { consentLimiter } from "../oauth/rate-limiter.js";

const KEY = "a".repeat(64);
const TOKEN_SCOPE = "mcp";

function mockReq(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    headers: {
      host: "mcp.example.com",
      "x-forwarded-proto": "https",
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

function basePayload(
  over: Partial<ConsentNoncePayload> = {},
): ConsentNoncePayload {
  return {
    client_id: "cid",
    redirect_uri: "https://legitimate.example/cb",
    state: "state-abc",
    code_challenge: "cc",
    code_challenge_method: "S256",
    response_type: "code",
    scope: TOKEN_SCOPE,
    resource: "",
    exp: Date.now() + 600_000,
    ...over,
  };
}

function bodyFor(p: ConsentNoncePayload, nonce: string, decision: string) {
  return {
    nonce,
    client_id: p.client_id,
    redirect_uri: p.redirect_uri,
    state: p.state,
    code_challenge: p.code_challenge,
    code_challenge_method: p.code_challenge_method,
    response_type: p.response_type,
    scope: p.scope,
    resource: p.resource,
    decision,
  };
}

function resetClientStore() {
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
}

function registerKnownClient(client_id: string, redirect_uri: string) {
  // ClientStore.register generates its own client_id, so we poke the
  // internal Map directly with the bound id from our payload — fast and
  // keeps tests deterministic.
  const cs = clientStore as unknown as {
    clients: Map<string, unknown>;
    byIp: Map<string, Set<string>>;
    clientIpOf: Map<string, string>;
  };
  const now = Date.now();
  cs.clients.set(client_id, {
    client_id,
    client_secret: "s",
    client_id_issued_at: Math.floor(now / 1000),
    client_secret_issued_at: Math.floor(now / 1000),
    client_secret_expires_at: 0,
    redirect_uris: [redirect_uri],
    client_name: "Test App",
    registeredAt: now,
    lastUsedAt: now,
  });
  cs.clientIpOf.set(client_id, "1.2.3.4");
  let set = cs.byIp.get("1.2.3.4");
  if (!set) {
    set = new Set();
    cs.byIp.set("1.2.3.4", set);
  }
  set.add(client_id);
}

beforeEach(() => {
  resetClientStore();
  // Reset rate-limiter buckets so per-IP windows don't leak across tests
  // (or across files under fork reuse).
  (
    consentLimiter as unknown as { buckets: Map<string, unknown> }
  ).buckets.clear();
  setTrustingProxy(() => false);
});

afterEach(() => {
  setTrustingProxy(() => false);
});

describe("consentHandler — approve", () => {
  it("approve happy path → 302 to nonce-bound redirect_uri with code + state", () => {
    const p = basePayload();
    registerKnownClient(p.client_id, p.redirect_uri);
    const nonce = signConsentNonce(p, [KEY]);
    const req = mockReq({ body: bodyFor(p, nonce, "approve") });
    const res = mockRes();

    consentHandler(req as never, res as never);

    expect(res.redirect).toHaveBeenCalledTimes(1);
    const target = new URL(res.redirect.mock.calls[0]![0] as string);
    expect(target.hostname).toBe("legitimate.example");
    expect(target.pathname).toBe("/cb");
    expect(target.searchParams.get("state")).toBe("state-abc");
    expect(target.searchParams.get("code")).toBeTruthy();
  });

  it("approve touches the client (lastUsedAt bumped)", () => {
    // Use fake timers so we deterministically observe a strictly-later
    // `lastUsedAt` than the registration timestamp without burning CPU
    // and without flaking on slow runners.
    vi.useFakeTimers();
    try {
      const baseMs = new Date(2026, 0, 1, 0, 0, 0).getTime();
      vi.setSystemTime(new Date(baseMs));
      const p = basePayload({ exp: baseMs + 600_000 });
      registerKnownClient(p.client_id, p.redirect_uri);
      const cs = clientStore as unknown as {
        clients: Map<string, { lastUsedAt: number }>;
      };
      const beforeTs = cs.clients.get(p.client_id)!.lastUsedAt;
      expect(beforeTs).toBe(baseMs);
      // Advance the clock so consentHandler -> clientStore.touch() observes
      // a strictly-later Date.now().
      vi.setSystemTime(new Date(baseMs + 5));
      const nonce = signConsentNonce(p, [KEY]);
      const req = mockReq({ body: bodyFor(p, nonce, "approve") });
      const res = mockRes();
      consentHandler(req as never, res as never);
      expect(cs.clients.get(p.client_id)!.lastUsedAt).toBe(baseMs + 5);
      expect(cs.clients.get(p.client_id)!.lastUsedAt).toBeGreaterThan(beforeTs);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("consentHandler — deny", () => {
  it("deny → 302 to nonce-bound redirect_uri with error=access_denied + state", () => {
    const p = basePayload();
    registerKnownClient(p.client_id, p.redirect_uri);
    const nonce = signConsentNonce(p, [KEY]);
    const req = mockReq({ body: bodyFor(p, nonce, "deny") });
    const res = mockRes();

    consentHandler(req as never, res as never);

    expect(res.redirect).toHaveBeenCalledTimes(1);
    const target = new URL(res.redirect.mock.calls[0]![0] as string);
    expect(target.hostname).toBe("legitimate.example");
    expect(target.searchParams.get("error")).toBe("access_denied");
    expect(target.searchParams.get("state")).toBe("state-abc");
    expect(target.searchParams.get("code")).toBeNull();
  });

  it("deny redirects to NONCE-BOUND redirect_uri even when form body matches (positive proof)", () => {
    // Sign a nonce naming the legitimate URI; submit a form body that
    // ALSO names the legitimate URI (otherwise step 3 fires first). The
    // assertion is on the hostname the handler actually redirects to,
    // proving that the deny branch reads p.redirect_uri (not body).
    const p = basePayload({ redirect_uri: "https://legitimate.example/cb" });
    registerKnownClient(p.client_id, p.redirect_uri);
    const nonce = signConsentNonce(p, [KEY]);
    const req = mockReq({ body: bodyFor(p, nonce, "deny") });
    const res = mockRes();

    consentHandler(req as never, res as never);

    expect(res.redirect).toHaveBeenCalledTimes(1);
    const target = new URL(res.redirect.mock.calls[0]![0] as string);
    expect(target.hostname).toBe("legitimate.example");
  });

  it("tampered form-body redirect_uri (different from nonce payload) → 400, NO redirect to tampered URI", () => {
    // Negative proof: body.redirect_uri differs from payload.redirect_uri,
    // step (3) fires before the decision branch is even reached, so the
    // handler 400s and does NOT redirect anywhere — and crucially does
    // not redirect to the attacker-controlled body URI.
    const p = basePayload({ redirect_uri: "https://legitimate.example/cb" });
    registerKnownClient(p.client_id, p.redirect_uri);
    const nonce = signConsentNonce(p, [KEY]);
    const body = bodyFor(p, nonce, "deny");
    body.redirect_uri = "https://attacker.example/cb";
    const req = mockReq({ body });
    const res = mockRes();

    consentHandler(req as never, res as never);

    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe("consentHandler — field mismatch (step 3)", () => {
  it("client_id swap in form body → 400 invalid_request field_mismatch", () => {
    const p = basePayload();
    registerKnownClient(p.client_id, p.redirect_uri);
    const nonce = signConsentNonce(p, [KEY]);
    const body = bodyFor(p, nonce, "approve");
    body.client_id = "other";
    const req = mockReq({ body });
    const res = mockRes();
    consentHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("state tampered → 400, no redirect (proves step 3 gates ALL flow incl. deny)", () => {
    const p = basePayload();
    registerKnownClient(p.client_id, p.redirect_uri);
    const nonce = signConsentNonce(p, [KEY]);
    const body = bodyFor(p, nonce, "deny");
    body.state = "tampered";
    const req = mockReq({ body });
    const res = mockRes();
    consentHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.redirect).not.toHaveBeenCalled();
  });
});

describe("consentHandler — nonce failures", () => {
  it("forged MAC → 400 with reason hmac", () => {
    const p = basePayload();
    registerKnownClient(p.client_id, p.redirect_uri);
    const goodNonce = signConsentNonce(p, [KEY]);
    // Replace MAC half with garbage of the same length.
    const [payloadB64] = goodNonce.split(".");
    const forged = `${payloadB64}.${Buffer.from("x".repeat(32)).toString("base64url")}`;
    const req = mockReq({ body: bodyFor(p, forged, "approve") });
    const res = mockRes();
    consentHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    const arg = res.status.mock.results[0]!.value.json.mock.calls[0]![0];
    expect(String(arg.error_description)).toContain("hmac");
  });

  it("expired nonce → 400 with reason expired", () => {
    const p = basePayload({ exp: Date.now() - 1 });
    registerKnownClient(p.client_id, p.redirect_uri);
    const nonce = signConsentNonce(p, [KEY]);
    const req = mockReq({ body: bodyFor(p, nonce, "approve") });
    const res = mockRes();
    consentHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    const arg = res.status.mock.results[0]!.value.json.mock.calls[0]![0];
    expect(String(arg.error_description)).toContain("expired");
  });

  it("malformed nonce token → 400 with reason format", () => {
    const p = basePayload();
    registerKnownClient(p.client_id, p.redirect_uri);
    const req = mockReq({ body: bodyFor(p, "not-a-token", "approve") });
    const res = mockRes();
    consentHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe("consentHandler — client + policy", () => {
  it("unknown client_id (deleted between sign and consent) → 400 unauthorized_client + logs consent_stale_client", () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const p = basePayload({ client_id: "nonexistent" });
    const nonce = signConsentNonce(p, [KEY]);
    const req = mockReq({ body: bodyFor(p, nonce, "approve") });
    const res = mockRes();
    consentHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    const arg = res.status.mock.results[0]!.value.json.mock.calls[0]![0];
    expect(arg.error).toBe("unauthorized_client");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[oauth\] consent_stale_client .*client_id=nonexistent/,
      ),
    );
    warnSpy.mockRestore();
  });

  it("scope mismatch (post-MAC) → 400 invalid_scope + logs consent_scope_mismatch", () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    // Sign a payload whose scope is NOT the supported value. Step 3
    // requires the form body to equal the payload, so the body carries
    // the same bogus scope — the mismatch surfaces at step 6a.
    const p = basePayload({ scope: "bogus" });
    registerKnownClient(p.client_id, p.redirect_uri);
    const nonce = signConsentNonce(p, [KEY]);
    const req = mockReq({ body: bodyFor(p, nonce, "approve") });
    const res = mockRes();
    consentHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    const arg = res.status.mock.results[0]!.value.json.mock.calls[0]![0];
    expect(arg.error).toBe("invalid_scope");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[oauth\] consent_scope_mismatch .*scope=bogus/),
    );
    warnSpy.mockRestore();
  });

  it("unsupported response_type or code_challenge_method → 400 + logs consent_param_unsupported", () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const p = basePayload({ code_challenge_method: "plain" });
    registerKnownClient(p.client_id, p.redirect_uri);
    const nonce = signConsentNonce(p, [KEY]);
    const req = mockReq({ body: bodyFor(p, nonce, "approve") });
    const res = mockRes();
    consentHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    const arg = res.status.mock.results[0]!.value.json.mock.calls[0]![0];
    expect(arg.error).toBe("invalid_request");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[oauth\] consent_param_unsupported .*code_challenge_method=plain/,
      ),
    );
    warnSpy.mockRestore();
  });

  it("redirect_uri no longer in client's registered list → 400 invalid_redirect_uri", () => {
    const p = basePayload();
    // Register client with a DIFFERENT redirect_uri so the nonce-bound
    // URI isn't on the list.
    registerKnownClient(p.client_id, "https://other.example/cb");
    const nonce = signConsentNonce(p, [KEY]);
    const req = mockReq({ body: bodyFor(p, nonce, "approve") });
    const res = mockRes();
    consentHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    const arg = res.status.mock.results[0]!.value.json.mock.calls[0]![0];
    expect(arg.error).toBe("invalid_redirect_uri");
  });
});

describe("consentHandler — invalid decision", () => {
  it("decision value neither approve nor deny → 400 + logs consent_unknown_decision", () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const p = basePayload();
    registerKnownClient(p.client_id, p.redirect_uri);
    const nonce = signConsentNonce(p, [KEY]);
    const req = mockReq({ body: bodyFor(p, nonce, "maybe") });
    const res = mockRes();
    consentHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.redirect).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[oauth\] consent_unknown_decision .*decision=maybe/,
      ),
    );
    warnSpy.mockRestore();
  });

  it("missing decision → 400", () => {
    const p = basePayload();
    registerKnownClient(p.client_id, p.redirect_uri);
    const nonce = signConsentNonce(p, [KEY]);
    const body = bodyFor(p, nonce, "approve") as Record<string, unknown>;
    delete body.decision;
    const req = mockReq({ body });
    const res = mockRes();
    consentHandler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.redirect).not.toHaveBeenCalled();
  });
});

describe("consentHandler — rate limit", () => {
  it("exceeding consentLimiter (30/min) → 429 with Retry-After + logs rate_limited endpoint=consent", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const p = basePayload();
    registerKnownClient(p.client_id, p.redirect_uri);
    const nonce = signConsentNonce(p, [KEY]);

    // Burn through the limiter from a single IP.
    let last: ReturnType<typeof mockRes> | undefined;
    for (let i = 0; i < 31; i++) {
      const req = mockReq({
        body: bodyFor(p, nonce, "approve"),
        socket: { remoteAddress: "9.9.9.9" },
      });
      last = mockRes();
      consentHandler(req as never, last as never);
    }
    expect(last!.status).toHaveBeenCalledWith(429);
    expect(last!.setHeader).toHaveBeenCalledWith(
      "Retry-After",
      expect.any(String),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[oauth\] rate_limited .*endpoint=consent/),
    );
    warnSpy.mockRestore();
  });
});
