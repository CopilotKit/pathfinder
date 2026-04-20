import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";

// Use a stable secret so the handlers and our verifier both agree.
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
  bearerMiddleware,
  type AuthContext,
} from "../oauth/handlers.js";

function base64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  return b
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
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
  app.post("/token", tokenHandler);

  // Stub /mcp that echoes req.auth
  app.post(
    "/mcp",
    bearerMiddleware,
    (req: express.Request & { auth?: AuthContext }, res) => {
      res.json({ echoed_auth: req.auth ?? null });
    },
  );

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe("OAuth 2.1 end-to-end ceremonial flow", () => {
  it("completes register → authorize → token → /mcp with Bearer", async () => {
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

    // 3. GET /authorize
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
    expect(authRes.status).toBe(302);
    const location = authRes.headers.get("location");
    expect(location).toBeTruthy();
    const redirected = new URL(location!);
    const code = redirected.searchParams.get("code");
    expect(code).toBeTruthy();
    expect(redirected.searchParams.get("state")).toBe("abc");

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
    };
    expect(tokenBody.access_token).toBeTruthy();
    expect(tokenBody.token_type).toBe("Bearer");
    expect(tokenBody.expires_in).toBe(3600);

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
    expect(www).toContain('error="invalid_token"');
  });
});
