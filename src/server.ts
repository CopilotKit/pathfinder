import express, { Request, Response } from "express";
import cors from "cors";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Bash } from "just-bash";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./mcp/server.js";
import { createSseHandlers, reapIdleSseSessions } from "./sse-handlers.js";
import { buildBashFilesMap, rebuildBashInstance } from "./mcp/tools/bash-fs.js";
import { initializeSchema, closePool } from "./db/client.js";
import {
  getIndexStats,
  getAllChunksForLlms,
  getFaqChunks,
} from "./db/queries.js";
import {
  getConfig,
  getServerConfig,
  getAnalyticsConfig,
  hasSearchTools,
  hasKnowledgeTools,
  hasCollectTools,
  hasBashSemanticSearch,
} from "./config.js";
import { isSlackSourceConfig, isDiscordSourceConfig } from "./types.js";
import { IndexingOrchestrator } from "./indexing/orchestrator.js";

import { createWebhookHandler } from "./webhooks/github.js";
import { createSlackWebhookHandler } from "./webhooks/slack.js";
import { createDiscordWebhookHandler } from "./webhooks/discord.js";
import { SessionStateManager } from "./mcp/tools/bash-session.js";
import { BashTelemetry } from "./mcp/tools/bash-telemetry.js";
import { insertCollectedData } from "./db/queries.js";
import { IpSessionLimiter } from "./ip-limiter.js";
import {
  protectedResourceHandler,
  authorizationServerHandler,
  registerHandler,
  authorizeHandler,
  tokenHandler,
  revocationHandler,
  bearerMiddleware,
} from "./oauth/handlers.js";
import { WorkspaceManager } from "./workspace.js";
import { generateLlmsTxt, generateLlmsFullTxt } from "./llms-txt.js";
import { generateFaqTxt } from "./faq-txt.js";
import { generateSkillMd } from "./skill-md.js";
import {
  getAnalyticsSummary,
  getTopQueries,
  getEmptyQueries,
  getToolCounts,
} from "./db/analytics.js";
import type { AnalyticsFilter } from "./db/analytics.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ServerOptions {
  port?: number;
  configPath?: string;
}

const app = express();
app.use(
  cors({
    origin: "*",
    exposedHeaders: ["Mcp-Session-Id"],
  }),
);

// Advertise llms.txt via Link header on all responses
app.use((_req, res, next) => {
  res.setHeader("Link", '</llms.txt>; rel="llms-txt", </faq.txt>; rel="faq"');
  next();
});

// ---------------------------------------------------------------------------
// Webhook endpoint — registered BEFORE express.json() so the handler receives
// a raw Buffer for HMAC signature verification.
//
// The handler is wired to the real orchestrator during start().  Until then,
// requests receive 503 (server still initializing).
// ---------------------------------------------------------------------------

let webhookHandler: ((req: Request, res: Response) => Promise<void>) | null =
  null;
let slackWebhookHandler:
  | ((req: Request, res: Response) => Promise<void>)
  | null = null;
let discordWebhookHandler:
  | ((req: Request, res: Response) => Promise<void>)
  | null = null;
let orchestratorRef: IndexingOrchestrator | null = null;
const startedAt = new Date();
const bashInstances = new Map<string, Bash>();
const sessionStateManager = new SessionStateManager();
let bashTelemetry: BashTelemetry | undefined;
let telemetryFlushInterval: ReturnType<typeof setInterval> | undefined;

async function refreshBashInstances(
  sourceNames: string[],
  logPrefix = "webhook",
): Promise<void> {
  const serverCfg = getServerConfig();
  const bashTools = serverCfg.tools.filter((t) => t.type === "bash");
  const searchToolNames = serverCfg.tools
    .filter((t) => t.type === "search")
    .map((t) => t.name);

  for (const tool of bashTools) {
    const affected = tool.sources.some((s) => sourceNames.includes(s));
    if (!affected) continue;

    const toolSources = serverCfg.sources.filter((s) =>
      tool.sources.includes(s.name),
    );
    const virtualFiles = tool.bash?.virtual_files === true;
    const { bash, fileCount } = await rebuildBashInstance(toolSources, {
      virtualFiles,
      searchToolNames: virtualFiles ? searchToolNames : undefined,
      cloneDir: getConfig().cloneDir,
    });
    bashInstances.set(tool.name, bash);
    console.log(
      `[${logPrefix}] Refreshed bash tool "${tool.name}": ${fileCount} files`,
    );
  }
}

app.post(
  "/webhooks/github",
  express.raw({ type: "application/json" }),
  async (req: Request, res: Response) => {
    const handler = webhookHandler;
    if (!handler) {
      res.status(503).json({ error: "Server still initializing" });
      return;
    }
    try {
      await handler(req, res);
      // Schedule bash refresh after webhook-triggered reindex. This path
      // uses a delay heuristic rather than orchestrator.onReindexComplete
      // because that callback only fires on scheduled/nightly reindex, not
      // per-webhook — the webhook handler reindexes inline via the
      // orchestrator's handler path without going through the completion
      // callback. Unifying the two notification paths is a larger refactor.
      const serverCfg = getServerConfig();
      const bashTools = serverCfg.tools.filter((t) => t.type === "bash");
      if (bashTools.length > 0) {
        const REFRESH_DELAY_MS = 30_000;
        setTimeout(() => {
          refreshBashInstances(serverCfg.sources.map((s) => s.name)).catch(
            (err) => console.error("[webhook] Bash refresh failed:", err),
          );
        }, REFRESH_DELAY_MS);
      }
    } catch (err) {
      console.error("[webhook] Handler error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal webhook handler error" });
      }
    }
  },
);

// Slack webhook endpoint — also before express.json() for raw body signature verification
app.post(
  "/webhooks/slack",
  express.raw({ type: "application/json" }),
  async (req: Request, res: Response) => {
    const handler = slackWebhookHandler;
    if (!handler) {
      res.status(503).json({ error: "Server still initializing" });
      return;
    }
    try {
      await handler(req, res);
    } catch (err) {
      console.error("[slack-webhook] Handler error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal webhook handler error" });
      }
    }
  },
);

// Discord webhook endpoint — also before express.json() for raw body signature verification
app.post(
  "/webhooks/discord",
  express.raw({ type: "application/json" }),
  async (req: Request, res: Response) => {
    const handler = discordWebhookHandler;
    if (!handler) {
      res.status(503).json({ error: "Server still initializing" });
      return;
    }
    try {
      await handler(req, res);
    } catch (err) {
      console.error("[discord-webhook] Handler error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal webhook handler error" });
      }
    }
  },
);

// JSON parser for all other routes
app.use(express.json());
// Form-encoded parser for OAuth /token POSTs
app.use(express.urlencoded({ extended: false }));

// DEBUG: opt-in trace for requests from claude.ai IPs to diagnose auth flow.
// Gated behind PATHFINDER_TRACE_CLAUDE_AI=1 so production logs stay clean —
// the hardcoded IP prefixes are here purely to help reproduce a specific
// auth-flow bug and should not fire in general deployments.
if (process.env.PATHFINDER_TRACE_CLAUDE_AI === "1") {
  app.use((req, _res, next) => {
    const ip =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      "unknown";
    if (
      ip.startsWith("160.79.106") ||
      ip.startsWith("104.192.205") ||
      (req.headers["user-agent"] as string | undefined)?.includes(
        "python-httpx",
      )
    ) {
      console.log(
        `[trace] ${req.method} ${req.path} ip=${ip} ua=${req.headers["user-agent"]} auth=${req.headers.authorization ? "bearer" : "none"}`,
      );
    }
    next();
  });
}

// ---------------------------------------------------------------------------
// OAuth 2.1 ceremonial flow — RFC-compliant endpoints with auto-approval.
// Opportunistic bearer auth on /mcp lets existing unauthenticated clients
// keep working while claude.ai-style clients can complete the OAuth handshake.
// ---------------------------------------------------------------------------

app.get("/.well-known/oauth-protected-resource", protectedResourceHandler);
app.get("/.well-known/oauth-authorization-server", authorizationServerHandler);
app.post("/register", registerHandler);
app.get("/authorize", authorizeHandler);
app.post("/token", tokenHandler);
app.post("/revoke", revocationHandler);

// ---------------------------------------------------------------------------
// MCP endpoint — session-based (initialize once, then tool calls reuse session)
// ---------------------------------------------------------------------------

const transports: Record<string, StreamableHTTPServerTransport> = {};
const sseTransports: Record<string, SSEServerTransport> = {};
const sessionLastActivity: Record<string, number> = {};
let SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes default, overridden by config
let ipLimiter: IpSessionLimiter | undefined;
let workspaceManager: WorkspaceManager | undefined;

// Session reaper tick — started from startServer() so importing this module
// (including from tests) doesn't leak a 5-minute setInterval into the loop.
function reapIdleSessionsTick(): void {
  const now = Date.now();
  let reaped = 0;
  for (const sid of Object.keys(sessionLastActivity)) {
    // Skip SSE-owned sessions — they're reaped by reapIdleSseSessions below.
    if (sseTransports[sid]) continue;
    if (now - sessionLastActivity[sid] > SESSION_TTL_MS) {
      delete transports[sid];
      delete sessionLastActivity[sid];
      try {
        sessionStateManager.cleanup(sid);
      } catch (e) {
        console.error(
          `[mcp] Session state cleanup failed for ${sid.slice(0, 8)}:`,
          e,
        );
      }
      try {
        ipLimiter?.remove(sid);
      } catch (e) {
        console.error(`[mcp] IP limiter cleanup failed:`, e);
      }
      try {
        workspaceManager?.cleanup(sid);
      } catch (e) {
        console.error(
          `[mcp] Workspace cleanup failed for ${sid.slice(0, 8)}:`,
          e,
        );
      }
      reaped++;
    }
  }
  if (reaped > 0) {
    console.log(
      `[mcp] Reaped ${reaped} idle sessions (${Object.keys(transports).length} active)`,
    );
  }

  // Reap idle SSE sessions. reapIdleSseSessions closes the transport (which
  // triggers our onclose → removes from sseTransports, ipLimiter, workspace)
  // and also defensively clears the maps itself.
  const reapedSse = reapIdleSseSessions({
    sseTransports,
    sessionLastActivity,
    ttlMs: SESSION_TTL_MS,
    now,
  });
  for (const sid of reapedSse) {
    try {
      ipLimiter?.remove(sid);
    } catch (e) {
      console.error(`[mcp] SSE IP limiter cleanup failed:`, e);
    }
    try {
      workspaceManager?.cleanup(sid);
    } catch (e) {
      console.error(
        `[mcp] SSE workspace cleanup failed for ${sid.slice(0, 8)}:`,
        e,
      );
    }
  }
  if (reapedSse.length > 0) {
    console.log(
      `[mcp] Reaped ${reapedSse.length} idle SSE sessions (${Object.keys(sseTransports).length} SSE active)`,
    );
  }
}

let sessionReaperInterval: ReturnType<typeof setInterval> | undefined;

function clientIp(req: Request): string {
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

app.post("/mcp", bearerMiddleware, async (req: Request, res: Response) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const ip = clientIp(req);

    // Existing session — route to its transport
    if (sessionId && transports[sessionId]) {
      sessionLastActivity[sessionId] = Date.now();
      const method = req.body?.method as string | undefined;
      if (method === "tools/call") {
        const params = req.body?.params as Record<string, unknown> | undefined;
        const toolName = params?.name ?? "unknown";
        const args = params?.arguments as Record<string, unknown> | undefined;
        const toolCfg = getServerConfig().tools.find(
          (t) => t.name === toolName,
        );
        if (toolCfg?.type === "collect") {
          try {
            const dataPreview = JSON.stringify(args ?? {}).slice(0, 200);
            console.log(`[mcp] ${toolName}(${dataPreview}) [${ip}]`);
          } catch {
            console.log(`[mcp] ${toolName}(<unserializable>) [${ip}]`);
          }
        } else if (toolCfg?.type === "bash") {
          const cmd = args?.command ?? "";
          console.log(
            `[mcp] ${toolName}(${JSON.stringify(cmd).slice(0, 200)}) [${ip}]`,
          );
        } else {
          const query = args?.query ?? "";
          const limit = args?.limit;
          const extra = limit ? ` limit=${limit}` : "";
          console.log(`[mcp] ${toolName}("${query}"${extra}) [${ip}]`);
        }
      } else if (method === "tools/list") {
        console.log(`[mcp] tools/list [${ip}]`);
      }
      await transports[sessionId].handleRequest(req, res, req.body);
      return;
    }

    // New session — must be an initialize request
    if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
          sessionLastActivity[sid] = Date.now();
          if (ipLimiter && !ipLimiter.tryAdd(ip, sid)) {
            // Rate limit exceeded — tear down immediately
            console.warn(
              `[mcp] IP rate limit exceeded for ${ip}, closing session ${sid.slice(0, 8)}`,
            );
            delete transports[sid];
            delete sessionLastActivity[sid];
            // transport.close() is async on some transports; log rather
            // than ignore so a close failure doesn't silently leak.
            Promise.resolve(transport.close?.()).catch((err) => {
              console.error(
                `[mcp] transport close failed for ${sid.slice(0, 8)}:`,
                err,
              );
            });
            return;
          }
          workspaceManager?.ensureSession(sid);
          console.log(
            `[mcp] New session ${sid.slice(0, 8)} (${Object.keys(transports).length} active) [${ip}]`,
          );
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          delete transports[sid];
          delete sessionLastActivity[sid];
          sessionStateManager.cleanup(sid);
          ipLimiter?.remove(sid);
          workspaceManager?.cleanup(sid);
          console.log(
            `[mcp] Session ${sid.slice(0, 8)} closed (${Object.keys(transports).length} active)`,
          );
        }
      };
      const server = createMcpServer(
        bashInstances,
        sessionStateManager,
        () => transport.sessionId ?? undefined,
        bashTelemetry,
        workspaceManager,
      );
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Invalid request
    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message:
          "Bad Request: No valid session. Send an initialize request first.",
      },
      id: null,
    });
  } catch (error) {
    console.error("[MCP] Error handling POST request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// SSE stream for server-initiated notifications.
// Returns 405 when no valid session — the SDK interprets this as
// "server doesn't offer SSE at GET" which is the expected no-auth path.
// Returning 400 instead would cause the SDK to throw and trigger auth flow.
app.get("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res);
  } else {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method Not Allowed" },
      id: null,
    });
  }
});

// Session termination
app.delete("/mcp", bearerMiddleware, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid or missing session ID" },
      id: null,
    });
  }
});

// ---------------------------------------------------------------------------
// Legacy SSE transport — /sse (GET, opens stream) + /messages (POST, client→server)
//
// Claude.ai's web connector and older MCP clients probe /sse before falling
// back to Streamable HTTP. Hidden showcase docs point users at
// https://mcp.copilotkit.ai/sse, so we serve both transports side-by-side.
// ---------------------------------------------------------------------------

const sseHandlers = createSseHandlers({
  sseTransports,
  sessionLastActivity,
  ipLimiter: () => ipLimiter,
  workspaceManager: () => workspaceManager,
  createMcpServer: () => {
    let transportRef: SSEServerTransport | undefined;
    // The handler creates the transport first, then calls createMcpServer()
    // and connect(transport). We need the sessionId late-bound so bash tools
    // can discover it via getSessionId().
    const server = createMcpServer(
      bashInstances,
      sessionStateManager,
      () => transportRef?.sessionId,
      bashTelemetry,
      workspaceManager,
    );
    // Intercept connect() so we can capture the transport reference for
    // the getSessionId closure above.
    const origConnect = server.connect.bind(server);
    server.connect = async (t) => {
      transportRef = t as SSEServerTransport;
      return origConnect(t);
    };
    return server;
  },
});

app.get("/sse", ...sseHandlers.getHandler);
app.post("/messages", ...sseHandlers.postHandler);

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get("/health", async (_req: Request, res: Response) => {
  const uptime = Math.floor((Date.now() - startedAt.getTime()) / 1000);
  const needsDb =
    hasSearchTools() ||
    hasKnowledgeTools() ||
    hasCollectTools() ||
    hasBashSemanticSearch();

  if (!needsDb) {
    res.json({
      status: "ok",
      server: getServerConfig().server.name,
      uptime_seconds: uptime,
      started_at: startedAt.toISOString(),
      indexing: false,
      index: "not_configured",
    });
    return;
  }

  try {
    const stats = await getIndexStats();
    res.json({
      status: "ok",
      server: getServerConfig().server.name,
      uptime_seconds: uptime,
      started_at: startedAt.toISOString(),
      indexing:
        (orchestratorRef as IndexingOrchestrator | null)?.isIndexing() ?? false,
      index: {
        total_chunks: stats.totalChunks,
        by_source: stats.bySource,
        indexed_repos: stats.indexedRepos,
        sources: stats.indexStates.map((s) => ({
          type: s.source_type,
          key: s.source_key,
          status: s.status,
          last_indexed: s.last_indexed_at,
          commit: s.last_commit_sha?.slice(0, 8) ?? null,
          error: s.error_message ?? null,
        })),
      },
    });
  } catch (err) {
    console.error("[health] Database unavailable:", err);
    res.status(503).json({
      status: "degraded",
      server: getServerConfig().server.name,
      uptime_seconds: uptime,
      started_at: startedAt.toISOString(),
      index: "unavailable",
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// ---------------------------------------------------------------------------
// llms.txt and llms-full.txt — cached, invalidated on reindex
// ---------------------------------------------------------------------------

let cachedLlmsTxt: string | null = null;
let cachedLlmsFullTxt: string | null = null;
let cachedFaqTxt: string | null = null;

app.get("/llms.txt", async (_req: Request, res: Response) => {
  try {
    if (!cachedLlmsTxt) {
      const chunks = await getAllChunksForLlms();
      cachedLlmsTxt = generateLlmsTxt(chunks, getServerConfig().server.name);
    }
    res.type("text/plain").send(cachedLlmsTxt);
  } catch (err) {
    console.error("[llms.txt] Generation failed:", err);
    res
      .status(503)
      .type("text/plain")
      .send("# Service unavailable\nIndex not ready.");
  }
});

app.get("/llms-full.txt", async (_req: Request, res: Response) => {
  try {
    if (!cachedLlmsFullTxt) {
      const chunks = await getAllChunksForLlms();
      cachedLlmsFullTxt = generateLlmsFullTxt(chunks);
    }
    res.type("text/plain").send(cachedLlmsFullTxt);
  } catch (err) {
    console.error("[llms-full.txt] Generation failed:", err);
    res
      .status(503)
      .type("text/plain")
      .send("Service unavailable — index not ready.");
  }
});

app.get("/faq.txt", async (_req: Request, res: Response) => {
  try {
    if (!cachedFaqTxt) {
      const serverCfg = getServerConfig();
      // Find FAQ sources: sources with category === 'faq'
      const faqSources = serverCfg.sources
        .filter((s) => "category" in s && s.category === "faq")
        .map((s) => ({
          name: s.name,
          confidenceThreshold: isSlackSourceConfig(s)
            ? s.confidence_threshold
            : isDiscordSourceConfig(s)
              ? s.confidence_threshold
              : 0.7,
        }));

      if (faqSources.length === 0) {
        cachedFaqTxt = generateFaqTxt([], serverCfg.server.name, []);
      } else {
        // Fetch FAQ chunks per source with its confidence threshold
        const allChunks = [];
        for (const src of faqSources) {
          try {
            const chunks = await getFaqChunks(
              [src.name],
              src.confidenceThreshold,
            );
            allChunks.push(...chunks);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(
              `[faq.txt] Failed to fetch chunks for source "${src.name}": ${msg}`,
            );
          }
        }
        cachedFaqTxt = generateFaqTxt(
          allChunks,
          serverCfg.server.name,
          faqSources,
        );
      }
    }
    res.type("text/plain").send(cachedFaqTxt);
  } catch (err) {
    console.error("[faq.txt] Generation failed:", err);
    res
      .status(503)
      .type("text/plain")
      .send("# Service unavailable\nFAQ index not ready.");
  }
});

// ---------------------------------------------------------------------------
// skill.md — dynamically generated from server config
// ---------------------------------------------------------------------------

app.get(
  "/.well-known/skills/default/skill.md",
  (_req: Request, res: Response) => {
    try {
      res.type("text/markdown").send(generateSkillMd(getServerConfig()));
    } catch (err) {
      console.error("[skill.md] Generation failed:", err);
      res.status(500).type("text/plain").send("Error generating skill.md");
    }
  },
);

// ---------------------------------------------------------------------------
// Analytics API — protected by token auth
// ---------------------------------------------------------------------------

/**
 * Analytics auth middleware — exported so tests can import and test the real
 * code instead of reimplementing the logic in test doubles.
 */
let autoGeneratedAnalyticsToken: string | null = null;

/**
 * Test-only: reset the module-level auto-generated analytics token. Tests
 * that depend on "no token yet" semantics must call this in `beforeEach`
 * because the token persists across test cases otherwise (mockReset on the
 * config hook is not enough — the token is cached here).
 */
export function __resetAnalyticsTokenForTesting(): void {
  autoGeneratedAnalyticsToken = null;
}

const LOCALHOST_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Return true if the request originated from a loopback interface. Trusts
 * ONLY `req.socket.remoteAddress` (not `X-Forwarded-For` — that's client-
 * controlled and would let anyone forge "I'm localhost").
 */
function isLocalhostReq(req: Request): boolean {
  const addr = req.socket?.remoteAddress ?? "";
  return LOCALHOST_IPS.has(addr);
}

/**
 * Short fingerprint for logging so we can correlate sessions without
 * disclosing the full token in server logs.
 */
function tokenFingerprint(token: string): string {
  return token.slice(0, 8) + "…";
}

function getAnalyticsToken(): string | undefined {
  const analyticsCfg = getAnalyticsConfig();
  const configured = analyticsCfg?.token || process.env.ANALYTICS_TOKEN;
  if (configured) return configured;

  // Production must never auto-generate — an operator-supplied token is
  // required so the dashboard isn't accidentally exposed.
  if (analyticsCfg?.enabled && getConfig().nodeEnv === "production") {
    throw new Error(
      "ANALYTICS_TOKEN required in production (set analytics.token in config or ANALYTICS_TOKEN env var)",
    );
  }

  // Auto-generate a token when analytics is enabled but no token is configured
  if (analyticsCfg?.enabled && !autoGeneratedAnalyticsToken) {
    autoGeneratedAnalyticsToken =
      randomUUID().replace(/-/g, "") +
      randomUUID().replace(/-/g, "").slice(0, 16);
    // Log only a short fingerprint, not the full token. Operators needing
    // the full token should set ANALYTICS_TOKEN explicitly.
    console.log(
      `[analytics] No token configured — auto-generated token fingerprint=${tokenFingerprint(
        autoGeneratedAnalyticsToken,
      )}`,
    );
  }
  return autoGeneratedAnalyticsToken ?? undefined;
}

export function analyticsAuth(
  req: Request,
  res: Response,
  next: express.NextFunction,
): void {
  const analyticsCfg = getAnalyticsConfig();
  const config = getConfig();

  if (!analyticsCfg?.enabled) {
    res.status(404).json({ error: "Analytics not enabled" });
    return;
  }

  // Skip token check in development mode — but only from localhost. A dev
  // server bound to 0.0.0.0 must not become an unauthenticated analytics
  // endpoint for anyone on the LAN.
  if (config.nodeEnv === "development" && isLocalhostReq(req)) {
    next();
    return;
  }

  let token: string | undefined;
  try {
    token = getAnalyticsToken();
  } catch (err) {
    console.error(
      `[analytics] auth misconfigured: ${err instanceof Error ? err.message : String(err)}`,
    );
    res.status(503).json({ error: "misconfigured" });
    return;
  }

  if (!token) {
    // Should not happen — getAnalyticsToken auto-generates or throws.
    // Fail closed rather than silently bypassing auth.
    console.error("[analytics] auth misconfigured: no token available");
    res.status(503).json({ error: "misconfigured" });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({
      error: "Missing or invalid Authorization header. Use: Bearer <token>",
    });
    return;
  }

  const provided = authHeader.slice(7);
  // Constant-time comparison so an attacker can't infer the token from
  // response-time differences. Buffers must be the same length; mismatched
  // lengths fail fast.
  const providedBuf = Buffer.from(provided, "utf8");
  const tokenBuf = Buffer.from(token, "utf8");
  if (
    providedBuf.length !== tokenBuf.length ||
    !timingSafeEqual(providedBuf, tokenBuf)
  ) {
    res.status(403).json({ error: "Invalid analytics token" });
    return;
  }

  next();
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Result of parsing analytics filter query params.
 *
 * When `error` is set, the caller should respond with HTTP 400 using the
 * supplied `{error, error_description}` body. Otherwise `filter` is safe to
 * pass through to the DB layer.
 */
export type AnalyticsFilterParseResult =
  | { ok: true; filter: AnalyticsFilter }
  | {
      ok: false;
      status: 400;
      body: { error: string; error_description: string };
    };

export function parseAnalyticsFilter(req: Request): AnalyticsFilterParseResult {
  const filter: AnalyticsFilter = {};

  // Defense-in-depth: Express parses `?from=a&from=b` as an array, and
  // nested-object parsers can yield objects. Reject any non-string shape
  // for every filter name up front so downstream casts (and the positive-
  // int parser for days/limit) can assume string-or-undefined. The list
  // includes `days` and `limit` even though parsePositiveIntParam has its
  // own array guard — rejecting here returns a consistent 400 envelope
  // (`{ error: "invalid_request", error_description: "..." }`) regardless
  // of which endpoint the request hit.
  const rejectArray = (
    name: string,
  ): AnalyticsFilterParseResult | undefined => {
    const v = req.query[name];
    if (v !== undefined && typeof v !== "string") {
      return {
        ok: false,
        status: 400,
        body: {
          error: "invalid_request",
          error_description: `${name} must be a single string value`,
        },
      };
    }
    return undefined;
  };
  for (const name of ["from", "to", "tool_type", "source", "days", "limit"]) {
    const err = rejectArray(name);
    if (err) return err;
  }

  // After the array rejection above, these are narrowed to string | undefined.
  // Use a typeof check (not `as string` casts) so future changes to rejectArray
  // surface as real type errors instead of silently hiding a bad narrowing.
  // Reject empty strings too: an empty filter value is almost certainly a
  // client bug (e.g. `?tool_type=` from a blank select) and would otherwise
  // pass through to LIKE as an unbounded wildcard match.
  if (
    typeof req.query.tool_type === "string" &&
    req.query.tool_type.length > 0
  ) {
    filter.tool_type = req.query.tool_type;
  }
  if (typeof req.query.source === "string" && req.query.source.length > 0) {
    filter.source = req.query.source;
  }

  const fromRaw =
    typeof req.query.from === "string" ? req.query.from : undefined;
  const toRaw = typeof req.query.to === "string" ? req.query.to : undefined;

  // Both or neither — half-specified ranges are a client bug.
  if ((fromRaw && !toRaw) || (!fromRaw && toRaw)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "invalid_request",
        error_description: "from/to must be provided together",
      },
    };
  }

  if (fromRaw && toRaw) {
    if (!ISO_DATE_RE.test(fromRaw) || !ISO_DATE_RE.test(toRaw)) {
      return {
        ok: false,
        status: 400,
        body: {
          error: "invalid_request",
          error_description: "from/to must be YYYY-MM-DD",
        },
      };
    }
    // Parse as UTC start-of-day / end-of-day so the inclusive range
    // covers both endpoints regardless of client time zone.
    //
    // No explicit isNaN check here: the YYYY-MM-DD regex above already
    // ensures fromRaw/toRaw are well-formed, and the roundtrip check below
    // catches any calendar-invalid date (Feb 30 etc.) that `new Date()`
    // silently rolls forward.
    const from = new Date(fromRaw + "T00:00:00.000Z");
    const to = new Date(toRaw + "T23:59:59.999Z");
    // Reject calendar-invalid dates (e.g. 2026-02-30 which `new Date()`
    // silently rolls forward to March 2). Re-serialize the parsed Date back
    // to YYYY-MM-DD in UTC and require it to match the original input.
    const fromRoundtrip = from.toISOString().slice(0, 10);
    const toRoundtrip = to.toISOString().slice(0, 10);
    if (fromRoundtrip !== fromRaw || toRoundtrip !== toRaw) {
      return {
        ok: false,
        status: 400,
        body: {
          error: "invalid_request",
          error_description: "from/to must be a valid calendar date",
        },
      };
    }
    // Reject ranges where from > to — clients should swap before sending.
    if (from.getTime() > to.getTime()) {
      return {
        ok: false,
        status: 400,
        body: {
          error: "invalid_request",
          error_description: "from must be <= to",
        },
      };
    }
    filter.from = from;
    filter.to = to;
  }

  return { ok: true, filter };
}

/**
 * Parse a query parameter as a positive integer. Returns the default when the
 * value is absent, or an error object describing why it was rejected. The
 * error object carries a human-readable `error` field that callers can embed
 * in an HTTP 400 response body.
 */
export function parsePositiveIntParam(
  raw: unknown,
  defaultValue: number,
  max: number,
): number | { error: string } {
  if (raw === undefined || raw === null || raw === "") return defaultValue;
  if (typeof raw !== "string") return { error: "must be a string" };
  if (!/^\d+$/.test(raw)) return { error: "must be a positive integer" };
  const n = parseInt(raw, 10);
  if (n <= 0) return { error: "must be > 0" };
  if (n > max) return { error: `must be <= ${max}` };
  return n;
}

const MAX_DAYS = 100000;
const MAX_LIMIT = 200;

/**
 * Result envelope matching {@link AnalyticsFilterParseResult} so day/limit
 * parse errors emit the same `{error, error_description}` body shape as
 * from/to validation. The older signature took (req, res) and wrote the
 * 400 inline — callers now check `ok` and forward `status`/`body` on
 * failure, keeping the error surface uniform across all parsers.
 */
type NumberParseResult =
  | { ok: true; value: number }
  | {
      ok: false;
      status: 400;
      body: { error: string; error_description: string };
    };

function parseDaysOrError(req: Request): NumberParseResult {
  const result = parsePositiveIntParam(req.query.days, 7, MAX_DAYS);
  if (typeof result === "object") {
    return {
      ok: false,
      status: 400,
      body: {
        error: "invalid_request",
        error_description: `days ${result.error}`,
      },
    };
  }
  return { ok: true, value: result };
}

function parseLimitOrError(req: Request): NumberParseResult {
  const result = parsePositiveIntParam(req.query.limit, 50, MAX_LIMIT);
  if (typeof result === "object") {
    return {
      ok: false,
      status: 400,
      body: {
        error: "invalid_request",
        error_description: `limit ${result.error}`,
      },
    };
  }
  return { ok: true, value: result };
}

/**
 * Dependency hooks so tests can mount the real analytics routes without
 * needing a full DB. Defaults resolve to the production implementations.
 */
export interface AnalyticsRouteDeps {
  getAnalyticsSummary?: typeof getAnalyticsSummary;
  getTopQueries?: typeof getTopQueries;
  getEmptyQueries?: typeof getEmptyQueries;
  getToolCounts?: typeof getToolCounts;
  analyticsHtmlPath?: string;
}

/**
 * Register the public analytics routes on an Express app. Split out so tests
 * can mount the real handlers against a test DB (via `deps`) instead of
 * reimplementing the logic in a test double.
 */
export function registerAnalyticsRoutes(
  app: express.Express,
  deps: AnalyticsRouteDeps = {},
): void {
  const _getAnalyticsSummary = deps.getAnalyticsSummary ?? getAnalyticsSummary;
  const _getTopQueries = deps.getTopQueries ?? getTopQueries;
  const _getEmptyQueries = deps.getEmptyQueries ?? getEmptyQueries;
  const _getToolCounts = deps.getToolCounts ?? getToolCounts;
  const _analyticsHtmlPath =
    deps.analyticsHtmlPath ?? path.resolve(__dirname, "../docs/analytics.html");

  app.get(
    "/api/analytics/summary",
    analyticsAuth,
    async (req: Request, res: Response) => {
      try {
        const parsed = parseAnalyticsFilter(req);
        if (!parsed.ok) {
          res.status(parsed.status).json(parsed.body);
          return;
        }
        const daysParsed = parseDaysOrError(req);
        if (!daysParsed.ok) {
          res.status(daysParsed.status).json(daysParsed.body);
          return;
        }
        const summary = await _getAnalyticsSummary(
          parsed.filter,
          daysParsed.value,
        );
        res.json(summary);
      } catch (err) {
        console.error("[analytics] Summary query failed:", err);
        res.status(500).json({ error: "Failed to fetch analytics summary" });
      }
    },
  );

  app.get(
    "/api/analytics/queries",
    analyticsAuth,
    async (req: Request, res: Response) => {
      try {
        const parsed = parseAnalyticsFilter(req);
        if (!parsed.ok) {
          res.status(parsed.status).json(parsed.body);
          return;
        }
        const daysParsed = parseDaysOrError(req);
        if (!daysParsed.ok) {
          res.status(daysParsed.status).json(daysParsed.body);
          return;
        }
        const limitParsed = parseLimitOrError(req);
        if (!limitParsed.ok) {
          res.status(limitParsed.status).json(limitParsed.body);
          return;
        }
        const queries = await _getTopQueries(
          daysParsed.value,
          limitParsed.value,
          parsed.filter,
        );
        res.json(queries);
      } catch (err) {
        console.error("[analytics] Top queries failed:", err);
        res.status(500).json({ error: "Failed to fetch top queries" });
      }
    },
  );

  app.get(
    "/api/analytics/empty-queries",
    analyticsAuth,
    async (req: Request, res: Response) => {
      try {
        const parsed = parseAnalyticsFilter(req);
        if (!parsed.ok) {
          res.status(parsed.status).json(parsed.body);
          return;
        }
        const daysParsed = parseDaysOrError(req);
        if (!daysParsed.ok) {
          res.status(daysParsed.status).json(daysParsed.body);
          return;
        }
        const limitParsed = parseLimitOrError(req);
        if (!limitParsed.ok) {
          res.status(limitParsed.status).json(limitParsed.body);
          return;
        }
        const queries = await _getEmptyQueries(
          daysParsed.value,
          limitParsed.value,
          parsed.filter,
        );
        res.json(queries);
      } catch (err) {
        console.error("[analytics] Empty queries failed:", err);
        res.status(500).json({ error: "Failed to fetch empty queries" });
      }
    },
  );

  app.get(
    "/api/analytics/tool-counts",
    analyticsAuth,
    async (req: Request, res: Response) => {
      try {
        const parsed = parseAnalyticsFilter(req);
        if (!parsed.ok) {
          res.status(parsed.status).json(parsed.body);
          return;
        }
        const daysParsed = parseDaysOrError(req);
        if (!daysParsed.ok) {
          res.status(daysParsed.status).json(daysParsed.body);
          return;
        }
        const counts = await _getToolCounts(daysParsed.value, parsed.filter);
        res.json(counts);
      } catch (err) {
        console.error("[analytics] Tool counts failed:", err);
        res.status(500).json({ error: "Failed to fetch tool counts" });
      }
    },
  );

  app.get("/api/analytics/auth-mode", (req: Request, res: Response) => {
    const config = getConfig();
    // Only advertise dev bypass for localhost callers — otherwise a dev
    // server bound to 0.0.0.0 would invite unauthenticated dashboard access
    // from the LAN.
    const dev = config.nodeEnv === "development" && isLocalhostReq(req);
    res.json({ dev });
  });

  app.get("/analytics", (_req: Request, res: Response) => {
    if (!getAnalyticsConfig()?.enabled) {
      res.status(404).json({ error: "Analytics not enabled" });
      return;
    }
    // `dotfiles: "allow"` is required so the file serves from paths that
    // contain a dot-prefixed segment (e.g. git worktrees under `.claude/`).
    // Without it, Express's `send` returns 404 for any path with a dotfile
    // component, regardless of whether the file itself exists.
    //
    // The error callback turns a missing file (ENOENT — can happen if the
    // package was installed without docs/analytics.html) into a clean 404
    // JSON response instead of letting Express's default handler hang / 500.
    res.sendFile(_analyticsHtmlPath, { dotfiles: "allow" }, (err) => {
      if (!err) return;
      if (res.headersSent) {
        // The response already started streaming; we can't change status
        // or body. Log so a mid-stream failure is visible rather than
        // silently dropped.
        console.error("[analytics] sendFile failed mid-stream:", err);
        return;
      }
      // Type-guarded access to Node's errno code — sendFile can reject with
      // errors that don't carry one, so check before using.
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as NodeJS.ErrnoException).code
          : undefined;
      if (code === "ENOENT") {
        res.status(404).json({ error: "analytics dashboard not available" });
        return;
      }
      console.error("[analytics] sendFile failed:", err);
      res.status(500).json({ error: "analytics dashboard unavailable" });
    });
  });
}

// Wire the analytics routes onto the top-level app at import time so the
// production server exposes them on listen(). Tests that want to mount the
// real handlers can call registerAnalyticsRoutes() on their own app.
registerAnalyticsRoutes(app);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

export async function startServer(options?: ServerOptions): Promise<void> {
  if (options?.configPath) {
    process.env.PATHFINDER_CONFIG = options.configPath;
  }

  const cfg = getConfig();
  const serverCfg = getServerConfig();

  const port = options?.port ?? cfg.port;

  // Configure session TTL and IP rate limiter from config
  const maxSessionsPerIp = serverCfg.server.max_sessions_per_ip ?? 20;
  SESSION_TTL_MS = (serverCfg.server.session_ttl_minutes ?? 30) * 60 * 1000;
  ipLimiter = new IpSessionLimiter(maxSessionsPerIp);

  // Start the idle-session reaper. Running it from here (rather than at
  // module import) keeps test imports free of leaked timers.
  if (!sessionReaperInterval) {
    sessionReaperInterval = setInterval(reapIdleSessionsTick, 5 * 60 * 1000);
  }
  console.log(
    `[startup] IP rate limit: ${maxSessionsPerIp} sessions/IP, TTL: ${serverCfg.server.session_ttl_minutes ?? 30}m`,
  );

  // Initialize workspace manager if any bash tool has workspace enabled
  const hasBashWorkspace = serverCfg.tools.some(
    (t) => t.type === "bash" && t.bash?.workspace === true,
  );
  const workspaceDir =
    process.env.WORKSPACE_DIR ?? "/tmp/pathfinder-workspaces";
  if (hasBashWorkspace) {
    workspaceManager = new WorkspaceManager(workspaceDir);
    console.log(`[startup] Workspace manager enabled (dir: ${workspaceDir})`);
  }

  const needsDb =
    hasSearchTools() ||
    hasKnowledgeTools() ||
    hasCollectTools() ||
    hasBashSemanticSearch();

  if (needsDb) {
    console.log("[startup] Initializing database schema...");
    await initializeSchema();
    console.log("[startup] Database schema ready.");

    // Set up bash telemetry with periodic flush
    bashTelemetry = new BashTelemetry(insertCollectedData);
    telemetryFlushInterval = setInterval(() => {
      bashTelemetry
        ?.flush()
        .catch((err) =>
          console.error(
            "[telemetry] Periodic flush failed:",
            err instanceof Error ? err.message : String(err),
          ),
        );
    }, 60_000);
    console.log("[startup] Bash telemetry enabled (60s flush interval).");
  }

  // Log active sources from config
  const sourceNames = serverCfg.sources.map((s) => `${s.name} (${s.type})`);
  console.log(`[startup] Active sources: ${sourceNames.join(", ")}`);

  // Build shared Bash instances for bash tools. The filesystem is shared;
  // per-session CWD tracking is handled at the tool registration layer.
  const bashTools = serverCfg.tools.filter((t) => t.type === "bash");
  const searchToolNames = serverCfg.tools
    .filter((t) => t.type === "search")
    .map((t) => t.name);
  for (const tool of bashTools) {
    const toolSources = serverCfg.sources.filter((s) =>
      tool.sources.includes(s.name),
    );
    const virtualFiles = tool.bash?.virtual_files === true;
    const filesMap = await buildBashFilesMap(toolSources, {
      virtualFiles,
      searchToolNames: virtualFiles ? searchToolNames : undefined,
      cloneDir: cfg.cloneDir,
    });
    bashInstances.set(tool.name, new Bash({ files: filesMap, cwd: "/" }));
    console.log(
      `[startup] Bash tool "${tool.name}": ${Object.keys(filesMap).length} files loaded`,
    );
  }

  // Indexing and webhooks only needed when search tools are configured
  if (hasSearchTools() || hasKnowledgeTools()) {
    const orchestrator = new IndexingOrchestrator();
    orchestratorRef = orchestrator;
    webhookHandler = createWebhookHandler(orchestrator);

    // Wire up Slack webhook if any slack sources are configured
    const hasSlackSources = serverCfg.sources.some((s) => s.type === "slack");
    if (hasSlackSources) {
      slackWebhookHandler = createSlackWebhookHandler(orchestrator);
      console.log("[startup] Slack webhook handler enabled");
    }

    // Wire up Discord webhook if any discord sources are configured
    const hasDiscordSources = serverCfg.sources.some(
      (s) => s.type === "discord",
    );
    if (hasDiscordSources) {
      discordWebhookHandler = createDiscordWebhookHandler(orchestrator);
      console.log("[startup] Discord webhook handler enabled");
    }

    orchestrator.onReindexComplete = (sourceNames) => {
      // Invalidate caches so next request regenerates
      cachedLlmsTxt = null;
      cachedLlmsFullTxt = null;
      cachedFaqTxt = null;
      refreshBashInstances(sourceNames, "reindex").catch((err) => {
        console.error("[reindex] Bash refresh failed:", err);
      });
    };

    orchestrator
      .checkAndIndex()
      .then(() => {
        // Always refresh bash instances after startup index check.
        // The initial bash build (above) runs before repos are cloned,
        // so the filesystem may be empty. If checkAndIndex skipped
        // reindexing (DB already current), onReindexComplete won't fire
        // and the bash filesystem would stay empty without this.
        const allSourceNames = serverCfg.sources.map((s) => s.name);
        return refreshBashInstances(allSourceNames, "startup-refresh");
      })
      .catch((err) => {
        console.error("[startup] Initial index check failed:", err);
      });

    orchestrator.startNightlyReindex();
  } else {
    console.log("[startup] No search tools configured — skipping indexing");
  }

  const serverName = serverCfg.server.name;
  const server = app.listen(port, () => {
    console.log(`[${serverName}] Running at http://localhost:${port}/mcp`);
    console.log(`[health] http://localhost:${port}/health`);
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[startup] Port ${port} is already in use. Set PORT env var to use a different port.`,
      );
    } else {
      console.error(`[startup] Server error:`, err);
    }
    process.exit(1);
  });

  // -------------------------------------------------------------------
  // Graceful shutdown
  // -------------------------------------------------------------------

  async function shutdown(signal: string): Promise<void> {
    console.log(`\n[shutdown] Received ${signal}, shutting down...`);
    if (telemetryFlushInterval) {
      clearInterval(telemetryFlushInterval);
      telemetryFlushInterval = undefined;
    }
    if (sessionReaperInterval) {
      clearInterval(sessionReaperInterval);
      sessionReaperInterval = undefined;
    }
    try {
      await bashTelemetry?.flush();
    } catch (e) {
      console.error("[shutdown] Telemetry flush failed:", e);
    }
    // Close all open SSE transports so hanging streams don't block exit.
    for (const sid of Object.keys(sseTransports)) {
      try {
        await sseTransports[sid].close();
      } catch (e) {
        console.error(
          `[shutdown] SSE transport close failed for ${sid.slice(0, 8)}:`,
          e,
        );
      }
      delete sseTransports[sid];
    }
    try {
      workspaceManager?.cleanupAll();
    } catch (e) {
      console.error("[shutdown] Workspace cleanup failed:", e);
    }
    try {
      await closePool();
    } catch (e) {
      console.error("[shutdown] DB pool close failed:", e);
    }
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
