import express, {
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
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
import {
  isSlackSourceConfig,
  isDiscordSourceConfig,
  type FaqChunkResult,
} from "./types.js";
import { IndexingOrchestrator } from "./indexing/orchestrator.js";

import { createWebhookHandler } from "./webhooks/github.js";
import { createSlackWebhookHandler } from "./webhooks/slack.js";
import { createDiscordWebhookHandler } from "./webhooks/discord.js";
import { SessionStateManager } from "./mcp/tools/bash-session.js";
import { BashTelemetry } from "./mcp/tools/bash-telemetry.js";
import { insertCollectedData } from "./db/queries.js";
import { IpSessionLimiter } from "./ip-limiter.js";
import {
  jsonRpcRateLimitError,
  clampRetryAfterSeconds,
} from "./rate-limit-response.js";
import { clientIp } from "./ip-util.js";
import ipaddr from "ipaddr.js";
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

/**
 * Webhook middleware-ordering assertion (R4-7).
 *
 * Every `/webhooks/*` route below MUST receive a `Buffer` body (parsed by
 * express.raw) because HMAC signature verification runs against the exact
 * bytes on the wire — an already-JSON-parsed object cannot be
 * re-serialized byte-for-byte (key ordering, whitespace, numeric
 * representation all diverge). If a future refactor ever places
 * `app.use(express.json())` BEFORE these routes, the JSON parser would
 * win, req.body would arrive as an object, and every signature check
 * would fail closed with a silent 401 — or worse, a handler that doesn't
 * verify signatures would accept forged payloads.
 *
 * This factory produces a per-route guard that asserts Buffer-typed body
 * at REQUEST time. We don't rely on app-setup-time ordering alone because
 * Express doesn't expose a stable "middleware inserted before route"
 * predicate, and re-ordering at module scope is the exact class of
 * refactor most likely to silently undo the invariant.
 */
export function assertWebhookRawBodyOrder(routeName: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!Buffer.isBuffer(req.body)) {
      console.error(
        `[${routeName}] middleware ordering bug: express.json ran before express.raw (req.body is ${typeof req.body}); HMAC verification cannot proceed — refusing request`,
      );
      res.status(500).json({
        error: "Webhook middleware misconfigured",
      });
      return;
    }
    next();
  };
}

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

// Pending webhook-triggered bash-refresh timers. Each webhook delivery
// schedules a setTimeout to refresh bash instances after a brief delay
// (post-reindex). Without tracking these handles, a shutdown() racing
// with an in-flight webhook would leave the timers armed and keep the
// Node event loop alive, delaying process exit. We add handles on
// scheduling, remove them on fire, and clear the entire set on shutdown.
const pendingBashRefreshTimers = new Set<ReturnType<typeof setTimeout>>();

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

/**
 * Test-only accessor to the live bash registry. Production code should
 * continue to use the module-local `bashInstances` closure reference.
 */
export function __getBashInstancesForTesting(): Map<string, Bash> {
  return bashInstances;
}

/**
 * Test-only reset of the bash registry. Lets tests preload known instances
 * and assert atomic swap / rollback semantics without spinning up a full
 * server.
 */
export function __setBashInstanceForTesting(name: string, bash: Bash): void {
  bashInstances.set(name, bash);
}

export function __clearBashInstancesForTesting(): void {
  bashInstances.clear();
}

/**
 * Startup helper (R3 #5): drive `orchestrator.checkAndIndex()` and, on
 * success, refresh the bash instances against every configured source. Each
 * phase has its own `.catch(...)` so failures surface under distinguishable
 * log prefixes — before this helper existed, both phases logged under
 * `[startup] Initial index check failed:`, so a bash-refresh failure was
 * indistinguishable from an indexing failure in the logs.
 *
 * Contract:
 *   - checkAndIndex rejection → log "[startup] Initial index check failed:"
 *     and skip the refresh (we don't want to drive a refresh against a
 *     half-indexed DB).
 *   - checkAndIndex resolves but refreshBashInstances rejects → log
 *     "[startup] Bash refresh after index check failed:" and keep running.
 *   - Returns a Promise so tests can await the chain; production callers
 *     use it fire-and-forget.
 *
 * Exported for tests.
 */
export function runStartupIndexAndBashRefresh(
  orchestrator: { checkAndIndex: () => Promise<unknown> },
  sources: Array<{ name: string }>,
): Promise<void> {
  return orchestrator
    .checkAndIndex()
    .then(() => {
      // Always refresh bash instances after startup index check.
      // The initial bash build runs before repos are cloned, so the
      // filesystem may be empty. If checkAndIndex skipped reindexing (DB
      // already current), onReindexComplete won't fire and the bash
      // filesystem would stay empty without this.
      const allSourceNames = sources.map((s) => s.name);
      return refreshBashInstances(allSourceNames, "startup-refresh").catch(
        (err) => {
          // Swallow the refresh error so it does NOT propagate to the outer
          // `.catch` (which would mis-label it as an index-check failure).
          console.error(
            "[startup] Bash refresh after index check failed:",
            err,
          );
        },
      );
    })
    .catch((err) => {
      console.error("[startup] Initial index check failed:", err);
    });
}


app.post(
  "/webhooks/github",
  express.raw({ type: "application/json" }),
  // Runtime guard: assert req.body is a Buffer. If a future refactor moves
  // express.json() above this route, the guard fires a loud 500 instead of
  // silently 401-ing every webhook delivery.
  assertWebhookRawBodyOrder("webhook"),
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
        // Track the timer handle so shutdown() can cancel any refresh
        // still pending. The self-delete in the callback keeps the Set
        // from accumulating stale handles after the timer fires.
        const handle: ReturnType<typeof setTimeout> = setTimeout(() => {
          pendingBashRefreshTimers.delete(handle);
          refreshBashInstances(serverCfg.sources.map((s) => s.name)).catch(
            (err) => console.error("[webhook] Bash refresh failed:", err),
          );
        }, REFRESH_DELAY_MS);
        pendingBashRefreshTimers.add(handle);
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
  assertWebhookRawBodyOrder("slack-webhook"),
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
  assertWebhookRawBodyOrder("discord-webhook"),
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
    // Route through the shared helper so tracing, rate limiting, and
    // analytics dev-bypass all agree on the resolved IP (and all share
    // the same X-Forwarded-For spoof protection when trust_proxy=false).
    const ip = clientIp(req, isTrustingProxy());
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

/**
 * Single source of truth for the pre-clamp Retry-After hint derived from
 * SESSION_TTL_MS. Each /mcp rate-limit rejection path (pre-check, sync-race
 * tryAdd fail, race-fallback inside onsessioninitialized) used to duplicate
 * `Math.max(1, Math.round(SESSION_TTL_MS / 1000))` inline — four copies
 * diverging silently whenever one got refactored. Centralising it here keeps
 * header + body in lockstep; final clamping still happens inside
 * `clampRetryAfterSeconds` so the documented ceiling (300s) is enforced
 * regardless of how large SESSION_TTL_MS grows.
 */
export function retryAfterSecondsFromTtl(): number {
  return Math.max(1, Math.round(SESSION_TTL_MS / 1000));
}

/**
 * Short-lived set of session IDs that were rejected mid-init (race fallback
 * from handleSessionInitRaceFallback, or ensureSession-throw rollback from
 * handleSessionInitAccept). Both rejection paths already ran the full cleanup
 * chain inline AND called transport.close(). The SDK then fires
 * transport.onclose asynchronously for the now-dead transport — without this
 * marker, onclose would re-run sessionStateManager.cleanup/ipLimiter.remove/
 * workspaceManager.cleanup for a sid that never became a real session AND
 * emit a misleading "Session X closed (N active)" log.
 *
 * We add on rejection, consult in onclose to branch, and drain in onclose so
 * the Set never grows unbounded. A sid never re-appears here because
 * onsessioninitialized fires exactly once per transport.
 */
const rejectedSids = new Set<string>();

/**
 * Test-only: mark a sid as rejected (so onclose suppresses its cleanup
 * chain). Production code calls this internally from the race-fallback /
 * accept-rollback paths; exported so tests can verify both the marker
 * machinery and the suppression behavior independently.
 */
export function markSessionRejectedForTesting(sid: string): void {
  rejectedSids.add(sid);
}

/**
 * Test-only: query whether a sid was marked rejected (for assertions in
 * server-round2.test.ts). Does not mutate.
 */
export function wasSessionRejectedForTesting(sid: string): boolean {
  return rejectedSids.has(sid);
}

/**
 * Test-only: clear the rejected-sids set. Tests that want isolation across
 * cases can reset this in beforeEach so stale state from one test can't
 * influence another.
 */
export function __resetRejectedSidsForTesting(): void {
  rejectedSids.clear();
}

/**
 * Drain the rejected-sid marker for paths that tore the session down inline
 * and early-return from the /mcp init handler WITHOUT ever wiring
 * `transport.onclose`. Those paths (sync-race tryAdd-fail +
 * handleSessionInitAccept ensureSession-throw rollback) still call
 * `rejectedSids.add(sid)` inside the helper so that if onclose WERE wired, it
 * would suppress double-cleanup. But when no onclose handler is attached, the
 * marker would otherwise accumulate forever under rate-limit hammering /
 * workspace-init failures.
 *
 * Calling this immediately before the early-return guarantees the Set stays
 * bounded without racing the SDK's async onclose. Exported so tests can
 * assert the drain happens deterministically instead of dragging in the full
 * Express handler.
 */
export function drainRejectedSidForInlineRollback(sid: string): void {
  rejectedSids.delete(sid);
}

/**
 * Pure reaper for the Streamable-HTTP transport map. Exported so tests can
 * drive it without spinning up the full server. Mirrors
 * `reapIdleSseSessions` in sse-handlers.ts.
 *
 * Behavior contract:
 * - Closes the transport via `transport.close()` so listeners/timers inside
 *   the transport don't leak. The promise is attached via Promise.resolve +
 *   `.catch` so async rejections land in `console.error` instead of the
 *   process's unhandled-rejection stream.
 * - Coalesces `sessionLastActivity[sid] ?? 0` before the age check. Without
 *   this, a session with no recorded activity ({@link SESSION_TTL_MS}
 *   arithmetic on `undefined`) evaluates to `NaN > ttlMs`, which is always
 *   false — the session would never be reaped.
 * - Deletes map entries itself. The caller is responsible for cross-map
 *   cleanup (ipLimiter, workspace, session state) because those dependencies
 *   don't belong in a pure reaper.
 */
export function reapIdleStreamableSessions(opts: {
  transports: Record<string, { close: () => Promise<void> | void }>;
  sessionLastActivity: Record<string, number>;
  ttlMs: number;
  now?: number;
}): string[] {
  const { transports, sessionLastActivity, ttlMs } = opts;
  const now = opts.now ?? Date.now();
  const reaped: string[] = [];
  for (const sid of Object.keys(transports)) {
    const last = sessionLastActivity[sid] ?? 0;
    if (now - last > ttlMs) {
      const transport = transports[sid];
      // Async rejections must land in console.error, not the unhandled-
      // rejection stream. `void transport.close()` only catches synchronous
      // throws.
      Promise.resolve()
        .then(() => transport.close())
        .catch((e) =>
          console.error(
            `[mcp] Streamable close failed for ${sid.slice(0, 8)}:`,
            e,
          ),
        );
      delete transports[sid];
      delete sessionLastActivity[sid];
      reaped.push(sid);
    }
  }
  return reaped;
}

/**
 * Parametric reaper tick — all dependencies injected so tests can drive this
 * without module-scope state. The production tick below closes over module
 * state and delegates here.
 *
 * SSE ownership (R3 #1): reapIdleSseSessions now owns the full cleanup chain
 * inline — ipLimiter.remove, workspaceManager.cleanup, AND
 * sessionStateManager.cleanup. This supersedes the earlier "onclose-driven
 * cleanup" model: the reaper schedules transport.close() on a microtask, so
 * by the time SDK-side onclose fires, the map entry has already been deleted
 * and the handler's onclose closure no-ops. Calling cleanup only from the
 * handler onclose would leave ipLimiter counters, workspace state, AND
 * per-session shell state leaking for every reaped SSE session. See
 * sse-handlers.ts reapIdleSseSessions JSDoc for the full contract; this
 * function is purely the plumbing that hands our module-scope deps to that
 * reaper.
 */
export function reapIdleSessionsTickForTesting(opts: {
  transports: Record<string, { close: () => Promise<void> | void }>;
  sseTransports: Record<string, { close: () => Promise<void> | void }>;
  sessionLastActivity: Record<string, number>;
  ttlMs: number;
  now?: number;
  ipLimiter?: { remove: (sid: string) => void };
  workspaceManager?: { cleanup: (sid: string) => void };
  sessionStateManager?: { cleanup: (sid: string) => void };
}): void {
  const now = opts.now ?? Date.now();
  // Filter out SSE-owned sessions — they're reaped by reapIdleSseSessions
  // below and share the sessionLastActivity map. Build a shallow snapshot
  // view so the pure reaper sees only streamable-HTTP entries.
  const streamableOnly: Record<string, { close: () => Promise<void> | void }> =
    {};
  for (const sid of Object.keys(opts.transports)) {
    if (!opts.sseTransports[sid]) streamableOnly[sid] = opts.transports[sid];
  }
  const reapedStreamable = reapIdleStreamableSessions({
    transports: streamableOnly,
    sessionLastActivity: opts.sessionLastActivity,
    ttlMs: opts.ttlMs,
    now,
  });
  for (const sid of reapedStreamable) {
    // Propagate the delete back to the canonical map. The reaper already
    // deleted from the snapshot.
    delete opts.transports[sid];

    // R4-6: per-step cleanup with a per-sid summary log so operators can
    // distinguish "all three steps ran cleanly" from "some threw" from
    // "dep wasn't injected". The aggregate log below still fires; this
    // replaces the earlier silent-success behavior.
    type StepResult = "ok" | "throw" | "skipped";
    let stateResult: StepResult = opts.sessionStateManager ? "ok" : "skipped";
    let ipLimiterResult: StepResult = opts.ipLimiter ? "ok" : "skipped";
    let workspaceResult: StepResult = opts.workspaceManager ? "ok" : "skipped";

    try {
      opts.sessionStateManager?.cleanup(sid);
    } catch (e) {
      stateResult = "throw";
      console.error(
        `[mcp] Session state cleanup failed for ${sid.slice(0, 8)}:`,
        e,
      );
    }
    try {
      opts.ipLimiter?.remove(sid);
    } catch (e) {
      ipLimiterResult = "throw";
      console.error(`[mcp] IP limiter cleanup failed:`, e);
    }
    try {
      opts.workspaceManager?.cleanup(sid);
    } catch (e) {
      workspaceResult = "throw";
      console.error(
        `[mcp] Workspace cleanup failed for ${sid.slice(0, 8)}:`,
        e,
      );
    }
    console.log(
      `[mcp] Reap cleanup sid=${sid.slice(0, 8)} state=${stateResult} ipLimiter=${ipLimiterResult} workspace=${workspaceResult}`,
    );
  }
  if (reapedStreamable.length > 0) {
    console.log(
      `[mcp] Reaped ${reapedStreamable.length} idle sessions (${Object.keys(opts.transports).length} active)`,
    );
  }

  // Reap idle SSE sessions. Ownership (see sse-handlers.ts
  // reapIdleSseSessions JSDoc): the reaper deletes map entries synchronously
  // AND runs the full cleanup chain (ipLimiter.remove, workspaceManager.
  // cleanup, sessionStateManager.cleanup) inline before scheduling
  // transport.close() on a microtask. We intentionally do NOT duplicate any
  // of those cleanup calls here — a single inline owner keeps state
  // transitions auditable and avoids double-free when onclose later fires
  // against an already-deleted map entry. This reverses the previous
  // "onclose-driven" model that was silently leaking per-session state for
  // every reaped SSE session (the close() microtask raced ahead of the
  // handler's `if (sseTransports[sid])` guard, so onclose saw a deleted
  // entry and no-opped — leaving limiter counters, workspace state, and
  // shell state stranded).
  const reapedSse = reapIdleSseSessions({
    sseTransports: opts.sseTransports,
    sessionLastActivity: opts.sessionLastActivity,
    ttlMs: opts.ttlMs,
    now,
    ipLimiter: opts.ipLimiter,
    workspaceManager: opts.workspaceManager,
    sessionStateManager: opts.sessionStateManager,
  });
  if (reapedSse.length > 0) {
    console.log(
      `[mcp] Reaped ${reapedSse.length} idle SSE sessions (${Object.keys(opts.sseTransports).length} SSE active)`,
    );
  }
}

// Session reaper tick — started from startServer() so importing this module
// (including from tests) doesn't leak a 5-minute setInterval into the loop.
// Thin closure over module state that delegates to the parametric form.
function reapIdleSessionsTick(): void {
  reapIdleSessionsTickForTesting({
    transports,
    sseTransports,
    sessionLastActivity,
    ttlMs: SESSION_TTL_MS,
    ipLimiter,
    workspaceManager,
    sessionStateManager,
  });
}

/**
 * Race-fallback handler for the /mcp `onsessioninitialized` callback. When
 * the IP limiter rejects inside onsessioninitialized (rare: the pre-check
 * above should have caught it, but two concurrent inits from the same IP
 * can still race between pre-check and counter increment), we must:
 *
 * 1. Best-effort emit a JSON-RPC error frame on the transport so the client
 *    sees a descriptive rejection reason instead of a silent disconnect.
 * 2. Close the transport.
 * 3. Delete transports[sid] / sessionLastActivity[sid] INLINE — we cannot
 *    rely on onclose firing for this sid since the transport is torn down
 *    mid-stream-setup.
 *
 * Asymmetry note (vs /sse race fallback in src/sse-handlers.ts):
 *   /sse race-fallback returns a 429 JSON body to the client — the SSE
 *   handler still has a response object in hand at that point. /mcp
 *   race-fallback, by contrast, fires inside the SDK's
 *   `onsessioninitialized` callback AFTER the transport has taken ownership
 *   of the response stream and BEFORE the stream controller is wired
 *   (`transport.send()` throws "Not connected"). We cannot write a JSON
 *   body here, so the losing client sees a silent TCP close. The loud
 *   `console.warn` below is the operator-side compensation.
 *
 *   If a future MCP SDK version exposes a way to emit a protocol-level
 *   error frame during onsessioninitialized, both transports can
 *   converge on the same "descriptive rejection" shape and this helper
 *   can stop being the quiet one. Until then the silent-disconnect is
 *   the documented SDK-imposed behavior — not a TODO, a constraint.
 *
 * Note on step 1: the MCP SDK's `StreamableHTTPServerTransport.send()`
 * requires a live SSE stream (see node_modules/.../webStandardStreamableHttp
 * where send throws "Not connected" without one). Inside
 * `onsessioninitialized`, the enclosing `handleRequest` call has not yet
 * wired the stream controller — `send()` would throw "Not connected" and
 * the rejected promise would surface as an unhandled rejection. Rather
 * than emit a JSON-RPC error the client can't possibly see, we accept the
 * silent-disconnect footgun as documented SDK behavior and compensate
 * with:
 *   - A loud `console.warn` that includes the sid prefix, IP, counter, AND
 *     the clamped retry-after hint so operators can correlate client
 *     disconnects with rate-limit trips and know how long clients were
 *     told to back off.
 *   - The outer pre-check catches the common case (non-race) with a proper
 *     429 + `Retry-After` + structured body, so this fallback path only
 *     fires for genuine concurrent-init races.
 *
 * Exported so tests can exercise this directly without driving the full
 * Express app + SDK lifecycle.
 */
export function handleSessionInitRaceFallback(opts: {
  transport: { close: () => Promise<void> | void };
  sid: string;
  ip: string;
  transports: Record<string, unknown>;
  sessionLastActivity: Record<string, number>;
  limit: number;
  currentCount: number;
  retryAfterSeconds: number;
}): void {
  const {
    transport,
    sid,
    ip,
    transports: tMap,
    sessionLastActivity: lastActivityMap,
    limit,
    currentCount,
  } = opts;
  // Clamp to the same ceiling the JSON body uses so the log hint matches
  // what clients would have received on the happy (pre-check) path.
  const retryAfterSeconds = clampRetryAfterSeconds(opts.retryAfterSeconds);
  // Loud log — this path is the "silent disconnect" case; the log is the
  // only signal operators get that a client was rejected. Shape mirrors
  // the pre-check log so both surfaces are greppable together, and carries
  // the retry-after hint so ops can correlate disconnects with the backoff
  // window.
  console.warn(
    `[mcp] IP rate limit exceeded for ${ip} (${currentCount}/${limit}), closing session ${sid.slice(0, 8)} (race fallback, retry-after: ${retryAfterSeconds}s)`,
  );
  // Close the transport. Async rejections land in console.error instead of
  // the unhandled-rejection stream.
  Promise.resolve()
    .then(() => transport.close())
    .catch((err) => {
      console.error(
        `[mcp] race-fallback close failed for ${sid.slice(0, 8)}:`,
        err,
      );
    });
  // Inline map deletion — do NOT wait for onclose. The onclose handler
  // tolerates already-deleted entries (see transport.onclose in the POST
  // /mcp route).
  delete tMap[sid];
  delete lastActivityMap[sid];
  // Mark sid as rejected so the SDK-scheduled transport.onclose (fires once
  // transport.close() resolves) suppresses its cleanup chain + misleading
  // "Session closed (N active)" log — the session was never opened, so the
  // counters should reflect the pre-increment rollback and nothing more.
  rejectedSids.add(sid);
}

/**
 * Write a 429 rate-limited response (JSON-RPC error frame + `Retry-After`
 * header) back to a caller whose /mcp init was rejected by the IP limiter
 * pre-check. Exported so tests can drive the header/body parity directly
 * without a full Express + SDK round-trip.
 *
 * Both the header and the JSON-body `retryAfterSeconds` flow through
 * `clampRetryAfterSeconds`, so a raw SESSION_TTL-derived seed (e.g. 1800s
 * from a 30-minute TTL) gets clamped to the documented ceiling (300s) on
 * BOTH surfaces. Prior to this refactor the header was set from the raw
 * input and the body was clamped in `buildRateLimitPayload`, producing a
 * mismatch (header: 1800, body: 300) that confused clients.
 */
export function write429RateLimited(
  res: Response,
  inputs: {
    id: string | number | null;
    limit: number;
    currentCount: number;
    retryAfterSeconds: number;
  },
): void {
  // Defensive guard: if a future refactor moves the pre-check after any write
  // has happened, res.setHeader() would throw "Cannot set headers after they
  // are sent" and escape as an unhandled error. Bail with a diagnostic log so
  // operators can correlate, rather than crashing the request handler.
  if (res.headersSent) {
    console.error(
      "[mcp] 429 after headers sent — cannot write rate-limit response body/header",
    );
    return;
  }
  const clamped = clampRetryAfterSeconds(inputs.retryAfterSeconds);
  const frame = jsonRpcRateLimitError(inputs.id, {
    limit: inputs.limit,
    currentCount: inputs.currentCount,
    retryAfterSeconds: clamped,
  });
  res.setHeader("Retry-After", String(clamped));
  res.status(429).json(frame);
}

/**
 * Post-accept handler for the /mcp `onsessioninitialized` callback. Extracted
 * from the callback so we can (a) wrap the workspaceManager.ensureSession
 * call in a try/catch that ROLLS BACK the ipLimiter counter and tears down
 * transport state if ensureSession throws, and (b) test that rollback in
 * isolation without driving a full SDK lifecycle.
 *
 * On ensureSession failure (ENOSPC, EACCES, corrupted workspace, DB error):
 *   - Log the failure with sid-prefix + ip so operators can diagnose.
 *   - Call ipLimiter.remove(sid) so the pre-increment doesn't leak and
 *     permanently count against this IP until TTL reap.
 *   - Delete transports[sid] / sessionLastActivity[sid] inline (same
 *     mid-init teardown reasoning as handleSessionInitRaceFallback).
 *   - Fire-and-forget transport.close() with Promise-wrapped error handling
 *     so async rejections land in console.error rather than
 *     unhandledRejection.
 *   - Do NOT emit a JSON-RPC error frame — the MCP SDK lifecycle constraint
 *     documented on handleSessionInitRaceFallback applies identically here
 *     (`transport.send()` would throw "Not connected").
 *
 * Exported for tests; production callers wire this up via the POST /mcp
 * onsessioninitialized callback.
 */
export function handleSessionInitAccept(opts: {
  transport: { close: () => Promise<void> | void; sessionId?: string };
  sid: string;
  ip: string;
  transports: Record<string, unknown>;
  sessionLastActivity: Record<string, number>;
  ipLimiter?: { remove: (sid: string) => void };
  workspaceManager?: { ensureSession: (sid: string) => void };
  /**
   * Session state manager (bash tool per-session shell state). Optional so
   * existing test fixtures keep working; the production caller always passes
   * the module-scope instance. Rollback clears it alongside the ipLimiter
   * counter so a subsequent ensureSession throw-path doesn't leak shell
   * state if the accept handler ever starts registering state before the
   * ensureSession call.
   */
  sessionStateManager?: { cleanup: (sid: string) => void };
  /**
   * Express response for the original /mcp init request. When provided AND
   * headers haven't been sent yet, rollback writes a structured 503 body so
   * the client sees a diagnostic error instead of a silent transport
   * teardown. When res.headersSent is already true we can't write (the SDK
   * may have begun streaming before the ensureSession throw — unlikely given
   * the order — so we fall back to just closing the transport). Optional to
   * preserve existing unit test call sites that don't care about the
   * response shape.
   */
  res?: {
    headersSent: boolean;
    status: (code: number) => { json: (body: unknown) => unknown };
  };
}): boolean {
  const {
    transport,
    sid,
    ip,
    transports: tMap,
    sessionLastActivity: lastActivityMap,
    ipLimiter: limiter,
    workspaceManager: workspace,
    sessionStateManager: sessionState,
    res,
  } = opts;
  try {
    workspace?.ensureSession(sid);
  } catch (err) {
    console.error(
      `[mcp] workspaceManager.ensureSession failed for ${sid.slice(0, 8)} [${ip}]; rolling back session:`,
      err,
    );
    // Roll back the ipLimiter counter — tryAdd incremented it immediately
    // before this function ran, and without this rollback the counter
    // would leak until SESSION_TTL reap. Guard the remove() call so a
    // rollback throw doesn't mask the original ensureSession error.
    try {
      limiter?.remove(sid);
    } catch (rollbackErr) {
      console.error(
        `[mcp] ipLimiter rollback failed for ${sid.slice(0, 8)}:`,
        rollbackErr,
      );
    }
    // sessionStateManager cleanup: currently a no-op because ensureSession
    // runs before any session state registration, but add it to the rollback
    // chain so a future reordering (e.g. registering shell state inside
    // accept-handler) can't leak per-session state. Per-step try/catch
    // matches the onclose / reaper pattern.
    try {
      sessionState?.cleanup(sid);
    } catch (rollbackErr) {
      console.error(
        `[mcp] sessionStateManager rollback failed for ${sid.slice(0, 8)}:`,
        rollbackErr,
      );
    }
    // Inline map deletion — do NOT wait for onclose (the transport may
    // never reach the wired-stream state after the mid-init failure).
    delete tMap[sid];
    delete lastActivityMap[sid];
    // Mark the sid as rejected so the transport.onclose handler (which the
    // SDK fires asynchronously once transport.close() completes) skips the
    // cleanup chain + the misleading "Session closed (N active)" log — all
    // of that work already ran inline above.
    rejectedSids.add(sid);
    // Fire-and-forget close; async rejections land in console.error.
    // Direct .close() (no optional chaining): callers always provide a
    // transport with .close(), and the optional chain obscured typing.
    Promise.resolve()
      .then(() => transport.close())
      .catch((closeErr) => {
        console.error(
          `[mcp] transport.close after ensureSession failure threw for ${sid.slice(0, 8)}:`,
          closeErr,
        );
      });
    // Client-visible rejection: write a 503 JSON body when we still own the
    // response stream. If headers were already sent (extremely unlikely at
    // this point — ensureSession runs before the SDK wires the stream — but
    // a paranoid guard prevents a throw from crashing the outer handler) we
    // can't write a body, so the caller gets whatever Express does by
    // default (empty response, eventual connection close).
    if (res && !res.headersSent) {
      res.status(503).json({
        jsonrpc: "2.0",
        error: {
          code: -32003,
          message: "Server unavailable: failed to initialize session workspace",
        },
        id: null,
      });
    }
    return false;
  }
  console.log(
    `[mcp] New session ${sid.slice(0, 8)} (${Object.keys(tMap).length} active) [${ip}]`,
  );
  return true;
}

/**
 * Rollback helper for the `server.connect(transport)` /
 * `completeInitRequestSafely` path in the /mcp POST initialize handler.
 *
 * Motivation (Z-1): after handleSessionInitAccept succeeds the handler has
 * already:
 *   - registered transports[preSid] + sessionLastActivity[preSid]
 *   - incremented the ipLimiter counter (tryAdd succeeded pre-accept)
 *   - ensureSession'd the workspace
 *   - wired transport.onclose to cleanup
 * It then calls `server.connect(transport)` followed by handleRequest via
 * completeInitRequestSafely. If EITHER throws (createMcpServer wiring bug,
 * bash-instance lookup failure, OOM during construction, closed-stream mid-
 * handleRequest without an onsessioninitialized race), NOTHING calls
 * transport.close() — so onclose never fires — and the session is stranded
 * against max_sessions_per_ip until the 30-minute TTL reaper cleans it.
 *
 * Design invariant: cleanup runs EXACTLY ONCE for this sid.
 *
 * The obvious "seed rejectedSids then close()" approach is unsound when the
 * onclose handler IS wired (our case): close() fires onclose, onclose reads
 * rejectedSids.has(sid), drains the marker, then runs the suppression branch
 * — but only if the marker is still present when onclose runs. If we drain
 * inline to keep the Set bounded regardless of whether onclose fires, the
 * later-firing onclose sees an empty Set and runs the cleanup chain a second
 * time. We avoid both horns by DETACHING transport.onclose before calling
 * close(). The inline rollback below is the sole owner of the cleanup chain;
 * any onclose invocation from the SDK lands on our neutralized handler and
 * is a no-op.
 *
 * Per-step try/catch on each cleanup mirrors the onclose + reaper +
 * handleSessionInitAccept rollback pattern: a throw from one step must not
 * skip the others. ipLimiter.remove in particular is load-bearing — a
 * rollback that bails before ipLimiter.remove leaks the counter against
 * this IP until TTL reap, which is the exact failure mode this helper
 * exists to prevent.
 *
 * Caller (the /mcp POST handler) wraps server.connect + handleRequest in a
 * try/catch, invokes this helper, then rethrows so the outer catch-all
 * writes the 500 body (preserving the pre-existing response behavior).
 *
 * Exported for tests.
 */
export function rollbackSessionAfterConnectFailure(opts: {
  transport: {
    close: () => Promise<void> | void;
    onclose?: (() => void) | null;
  };
  sid: string;
  transports: Record<string, unknown>;
  sessionLastActivity: Record<string, number>;
  ipLimiter?: { remove: (sid: string) => void };
  sessionStateManager?: { cleanup: (sid: string) => void };
  workspaceManager?: { cleanup: (sid: string) => void };
}): void {
  const {
    transport,
    sid,
    transports: tMap,
    sessionLastActivity: lastActivityMap,
    ipLimiter: limiter,
    sessionStateManager: sessionState,
    workspaceManager: workspace,
  } = opts;

  // Detach the wired onclose handler BEFORE we fire close(). The MCP SDK may
  // invoke onclose as part of stream teardown; replacing it with a no-op
  // (rather than deleting) keeps the property shape predictable for any
  // other SDK introspection and ensures a single cleanup run — ours, inline,
  // below — regardless of whether the SDK fires the listener.
  transport.onclose = () => {
    /* neutralized by rollbackSessionAfterConnectFailure */
  };

  delete tMap[sid];
  delete lastActivityMap[sid];

  try {
    limiter?.remove(sid);
  } catch (e) {
    console.error(
      `[mcp] ipLimiter rollback after connect-throw failed for ${sid.slice(0, 8)}:`,
      e,
    );
  }
  try {
    sessionState?.cleanup(sid);
  } catch (e) {
    console.error(
      `[mcp] sessionStateManager rollback after connect-throw failed for ${sid.slice(0, 8)}:`,
      e,
    );
  }
  try {
    workspace?.cleanup(sid);
  } catch (e) {
    console.error(
      `[mcp] workspaceManager rollback after connect-throw failed for ${sid.slice(0, 8)}:`,
      e,
    );
  }

  // Fire-and-forget close so async rejections land in console.error rather
  // than unhandledRejection. Matches handleSessionInitAccept's pattern.
  Promise.resolve()
    .then(() => transport.close())
    .catch((closeErr) => {
      console.error(
        `[mcp] transport.close after server.connect/handleRequest throw failed for ${sid.slice(0, 8)}:`,
        closeErr,
      );
    });
}

/**
 * Drive `transport.handleRequest(req, res, body)` with defensive handling
 * for the onsessioninitialized-race case. `onsessioninitialized` fires
 * INSIDE `handleRequest`, so when the defensive race-fallback inside that
 * callback closes the transport mid-flight the SDK's subsequent write
 * attempts can throw ("Not connected", "Cannot set headers after sent",
 * etc.). Before this helper existed the throw escaped to the outer `try`
 * in the /mcp handler and produced a 500 write on top of the 429 the
 * race-fallback had already streamed — a double response to the client.
 *
 * Contract:
 *   - Always awaits handleRequest.
 *   - If `initOutcome.rejected` is true when handleRequest throws, the throw
 *     is swallowed (the race-fallback already handled the response
 *     lifecycle) and a diagnostic `[mcp]` log records the suppression so
 *     operators can still correlate. Resolves to undefined.
 *   - If `initOutcome.rejected` is false, the throw is re-thrown so the
 *     outer handler's catch-all produces its standard 500 JSON-RPC error.
 *
 * Exported for tests so the try/catch branching can be covered without a
 * full Express+SDK round trip.
 */
export async function completeInitRequestSafely<TReq, TRes, TBody>(
  transport: {
    handleRequest: (req: TReq, res: TRes, body: TBody) => Promise<void>;
  },
  req: TReq,
  res: TRes,
  body: TBody,
  initOutcome: { rejected: boolean },
): Promise<void> {
  try {
    await transport.handleRequest(req, res, body);
  } catch (err) {
    if (initOutcome.rejected) {
      // Race-fallback already closed the transport and wrote its own
      // teardown path; the SDK's residual write attempt naturally throws
      // on a closed socket. Suppress the throw so the outer catch-all
      // doesn't pile a 500 on top of the 429.
      console.warn(
        "[mcp] handleRequest threw after race-fallback rejected session; suppressed:",
        err,
      );
      return;
    }
    throw err;
  }
}

/**
 * Shutdown helper: closes every open transport (both Streamable-HTTP and
 * legacy SSE), clears the backing maps, and logs per-transport failures.
 * Extracted from the graceful-shutdown handler so tests can verify the
 * close-and-clear semantics without starting the full server.
 *
 * Uses Promise.allSettled on each map so one slow/rejecting close doesn't
 * stall subsequent closes — keeping shutdown within the orchestrator's
 * kill-deadline even if a single transport misbehaves. Failures are logged
 * with the sid prefix so operators can correlate.
 */
export async function closeAllSessions(opts: {
  transports: Record<string, { close: () => Promise<void> | void }>;
  sseTransports: Record<string, { close: () => Promise<void> | void }>;
}): Promise<void> {
  const { transports: tMap, sseTransports: sseMap } = opts;

  const streamableSids = Object.keys(tMap);
  const sseSids = Object.keys(sseMap);

  // R3 #11: run the two close batches in parallel rather than sequentially.
  // Shutdown latency upper bound becomes max(streamableClose, sseClose)
  // instead of their sum, which matters when the orchestrator's kill-
  // deadline is tight and both maps are non-trivial. allSettled semantics
  // still isolate a single slow/rejecting close from the rest.
  const [streamableResults, sseResults] = await Promise.all([
    Promise.allSettled(
      streamableSids.map((sid) =>
        Promise.resolve().then(() => tMap[sid].close()),
      ),
    ),
    Promise.allSettled(
      sseSids.map((sid) => Promise.resolve().then(() => sseMap[sid].close())),
    ),
  ]);

  streamableResults.forEach((result, i) => {
    const sid = streamableSids[i];
    if (result.status === "rejected") {
      console.error(
        `[shutdown] Streamable-HTTP transport close failed for ${sid.slice(0, 8)}:`,
        result.reason,
      );
    }
    delete tMap[sid];
  });
  if (streamableSids.length > 0) {
    console.log(
      `[shutdown] Closed ${streamableSids.length} Streamable-HTTP transport${streamableSids.length === 1 ? "" : "s"}`,
    );
  }

  sseResults.forEach((result, i) => {
    const sid = sseSids[i];
    if (result.status === "rejected") {
      console.error(
        `[shutdown] SSE transport close failed for ${sid.slice(0, 8)}:`,
        result.reason,
      );
    }
    delete sseMap[sid];
  });
  if (sseSids.length > 0) {
    console.log(
      `[shutdown] Closed ${sseSids.length} SSE transport${sseSids.length === 1 ? "" : "s"}`,
    );
  }
}

let sessionReaperInterval: ReturnType<typeof setInterval> | undefined;

// Resolved during startServer() from server.trust_proxy in the loaded config.
// Read by every IP-extraction site (trace middleware, /mcp, SSE handlers)
// via `clientIp(req, trustProxy)`. Defaults to false: if startServer() hasn't
// run yet, or the config omits the flag, we IGNORE X-Forwarded-For and fall
// back to the socket address — matching the hardened, spoof-resistant
// default documented in types.ts.
// R4-14: widened to match the types.ts schema. Express's `app.set("trust
// proxy", …)` accepts boolean | number | string[] (list of CIDRs) so the
// config surface exposes all three. `clientIp` still takes a boolean — we
// derive it via `isTrustingProxy(trustProxy)` below.
let trustProxy: boolean | number | string[] = false;

/**
 * Reduce the widened `trust_proxy` config value to a boolean for `clientIp`
 * and the analytics-dev-bypass guard. Anything other than the literal `false`
 * (including `true`, a positive hop count, or any non-empty CIDR list) means
 * "we're honoring X-Forwarded-For in some form" — the spoof risk surface
 * is identical from `clientIp`'s perspective, so we collapse to a boolean.
 */
function isTrustingProxy(
  value: boolean | number | string[] = trustProxy,
): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (Array.isArray(value)) return value.length > 0;
  return false;
}

/**
 * Test-only accessor for the module-level trustProxy flag. The flag is set
 * by startServer() in production; tests that exercise isLocalhostReq and
 * analyticsAuth behavior under `trust_proxy=true` without booting the full
 * server use this setter to drive the exact code path. Always pair with a
 * reset to `false` in an afterEach / finally so other tests don't inherit
 * the stale value.
 */
export function __setTrustProxyForTesting(
  value: boolean | number | string[],
): void {
  trustProxy = value;
}

app.post("/mcp", bearerMiddleware, async (req: Request, res: Response) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const ip = clientIp(req, isTrustingProxy());

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
      // Pre-check the IP limiter BEFORE creating the transport. The previous
      // flow created the transport, let onsessioninitialized run, then
      // transport.close()'d — which produced a silent disconnect on the
      // client side with no indication of why. Checking up front lets us
      // write a structured JSON-RPC error + 429 response so the client
      // can surface the rate-limit reason, the cap, the current count,
      // and a retry-after hint. Allowlisted IPs skip the check entirely.
      if (
        ipLimiter &&
        !ipLimiter.isAllowlisted(ip) &&
        ipLimiter.getSessionCount(ip) >= ipLimiter.getMax()
      ) {
        const currentCount = ipLimiter.getSessionCount(ip);
        const limit = ipLimiter.getMax();
        const retryAfterSeconds = retryAfterSecondsFromTtl();
        console.warn(
          `[mcp] IP rate limit exceeded for ${ip} (${currentCount}/${limit}), rejecting /mcp init with JSON-RPC error`,
        );
        const reqId =
          (req.body as { id?: string | number | null } | undefined)?.id ?? null;
        // Header and JSON body flow through the same clampRetryAfterSeconds
        // call via write429RateLimited so the two values stay in lockstep.
        // Previously the header took the raw SESSION_TTL-derived seed while
        // the body was clamped, producing a 1800/300 mismatch.
        write429RateLimited(res, {
          id: reqId,
          limit,
          currentCount,
          retryAfterSeconds,
        });
        return;
      }

      // Pre-generate the session ID so we can run the ipLimiter.tryAdd +
      // workspaceManager.ensureSession work SYNCHRONOUSLY BEFORE
      // createMcpServer / server.connect / transport.handleRequest. The
      // previous design ran that work inside the SDK's
      // `onsessioninitialized` callback — which fires DURING handleRequest
      // — so an ensureSession throw rolled back inline but the outer
      // handler had no way to know, kept driving the now-torn-down
      // transport, and (a) spun up an MCP server instance that immediately
      // orphaned (finding H4) and (b) let the SDK attempt to write an init
      // response on a closed transport. With the sid pre-generated here,
      // `handleSessionInitAccept` returns a boolean and the outer handler
      // can SKIP createMcpServer + server.connect + handleRequest on
      // rollback.
      const preSid = randomUUID();
      // Flag captured by the onsessioninitialized closure so a race-fallback
      // triggered ASYNC from inside the SDK (pre-check beat this sid but a
      // concurrent request from the same IP won the atomic tryAdd — extremely
      // rare after the pre-check refactor) can still signal the outer
      // handler. The ensureSession rollback path now runs synchronously
      // BEFORE handleRequest and sets this directly.
      const initOutcome: { rejected: boolean } = { rejected: false };
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => preSid,
        onsessioninitialized: (sid) => {
          // Registration moved here intentionally — we can't populate
          // transports[sid] before the transport object exists, and the SDK
          // expects the sid-to-transport mapping to be live by the time it
          // dispatches subsequent messages for this session. tryAdd/
          // ensureSession already ran synchronously below, so by the time
          // this callback fires we've either (a) committed to the session
          // (happy path; just register the maps) or (b) already rolled back
          // (initOutcome.rejected=true; no-op here — the outer handler
          // will skip handleRequest).
          if (initOutcome.rejected) return;
          transports[sid] = transport;
          sessionLastActivity[sid] = Date.now();
          // Defensive: this branch is unreachable under Node's
          // single-threaded execution — the synchronous tryAdd below has
          // already counted this sid, so `getSessionCount(ip)` can be AT
          // MOST `getMax()`, never strictly greater. tryAdd itself rejects
          // at `>= getMax()`, meaning a successful tryAdd guarantees
          // post-increment <= max. The branch stays as defense-in-depth
          // against a future refactor that (a) introduces an async boundary
          // between tryAdd and this callback, or (b) admits a second
          // concurrent init from the same IP before this fires. `>` (not
          // `>=`) is required: `>=` would incorrectly fire on the NORMAL
          // last-allowed session (count exactly at cap after tryAdd) and
          // reject legitimate traffic.
          if (
            ipLimiter &&
            !ipLimiter.isAllowlisted(ip) &&
            ipLimiter.getSessionCount(ip) > ipLimiter.getMax()
          ) {
            handleSessionInitRaceFallback({
              transport,
              sid,
              ip,
              transports,
              sessionLastActivity,
              limit: ipLimiter.getMax(),
              currentCount: ipLimiter.getSessionCount(ip),
              retryAfterSeconds: retryAfterSecondsFromTtl(),
            });
            initOutcome.rejected = true;
          }
        },
      });

      // Synchronous pre-flight: tryAdd the sid to the ipLimiter and
      // ensureSession on the workspaceManager BEFORE spinning up the MCP
      // server. Either can reject this init.
      if (ipLimiter && !ipLimiter.tryAdd(ip, preSid)) {
        // Atomic tryAdd failed — another concurrent init from the same IP
        // beat us between the read-only pre-check and this increment.
        // Delegate to the shared race-fallback helper (inline map delete,
        // rejected-sid mark, loud log). Because the transport was just
        // constructed and hasn't been connected, transport.close() is the
        // only teardown needed.
        transports[preSid] = transport;
        sessionLastActivity[preSid] = Date.now();
        handleSessionInitRaceFallback({
          transport,
          sid: preSid,
          ip,
          transports,
          sessionLastActivity,
          limit: ipLimiter.getMax(),
          currentCount: ipLimiter.getSessionCount(ip),
          retryAfterSeconds: retryAfterSecondsFromTtl(),
        });
        // Write the structured 429 inline here — the race-fallback helper
        // can't write a body mid-SDK-lifecycle, but pre-connect we still
        // own the response.
        if (!res.headersSent) {
          write429RateLimited(res, {
            id:
              (req.body as { id?: string | number | null } | undefined)?.id ??
              null,
            limit: ipLimiter.getMax(),
            currentCount: ipLimiter.getSessionCount(ip),
            retryAfterSeconds: retryAfterSecondsFromTtl(),
          });
        }
        // The race-fallback + accept-rollback helpers intentionally seed
        // rejectedSids so that IF `transport.onclose` were wired, it would
        // suppress double-cleanup. But we early-return BEFORE wiring onclose
        // on this path, so nothing will ever consume the marker. Drain it
        // here to keep the Set bounded under rate-limit hammering.
        drainRejectedSidForInlineRollback(preSid);
        return;
      }
      // Register maps now so handleSessionInitAccept's rollback has
      // something to delete + sessionStateManager cleanup runs against a
      // live entry.
      transports[preSid] = transport;
      sessionLastActivity[preSid] = Date.now();
      const accepted = handleSessionInitAccept({
        transport,
        sid: preSid,
        ip,
        transports,
        sessionLastActivity,
        ipLimiter,
        workspaceManager,
        sessionStateManager,
        res,
      });
      if (!accepted) {
        // Rollback already tore down the transport + wrote the 503 body (if
        // headers weren't sent yet). Skip createMcpServer / server.connect /
        // transport.handleRequest entirely — the transport is closed and
        // creating an MCP server for it would immediately orphan. Drain the
        // rejected-sid marker here for the same reason documented in the
        // tryAdd-fail early return above: onclose never gets wired on this
        // path, so the Set would otherwise leak forever.
        drainRejectedSidForInlineRollback(preSid);
        return;
      }
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (!sid) return;
        // Rejected-sid suppression (R3 #3 / H1): if the race-fallback or the
        // ensureSession rollback already tore this session down inline, the
        // cleanup chain + counters are already consistent. Running the chain
        // again here would (a) emit a misleading "Session closed" log for a
        // session that was never opened, and (b) risk double-cleanup on
        // sessionStateManager/workspaceManager. Drain the marker here so the
        // Set doesn't grow unbounded.
        if (rejectedSids.has(sid)) {
          rejectedSids.delete(sid);
          console.log(
            `[mcp] Session ${sid.slice(0, 8)} rejected, cleanup skipped (already torn down inline)`,
          );
          return;
        }
        // Tolerate already-deleted entries: a benign race between a client
        // disconnect and the reaper can leave an entry missing from the
        // map. Run the cleanup chain regardless so ipLimiter/workspace
        // state for this sid is released.
        delete transports[sid];
        delete sessionLastActivity[sid];
        // Per-operation try/catch so a throw from one cleanup step
        // doesn't skip the others — this mirrors the reaper tick above
        // and prevents ipLimiter / workspace state from drifting when
        // sessionStateManager.cleanup throws (the original failure mode
        // leaked IP-limiter counters, eventually rejecting new sessions
        // from that IP).
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
        console.log(
          `[mcp] Session ${sid.slice(0, 8)} closed (${Object.keys(transports).length} active)`,
        );
      };
      const server = createMcpServer(
        bashInstances,
        sessionStateManager,
        () => transport.sessionId ?? undefined,
        bashTelemetry,
        workspaceManager,
      );
      // Z-1: server.connect(transport) can throw AFTER handleSessionInitAccept
      // committed maps + ipLimiter counter + ensureSession + onclose wiring.
      // Without an explicit rollback, the session is stranded against
      // max_sessions_per_ip until TTL reap because nothing calls
      // transport.close(), so onclose never fires. Wrap BOTH server.connect
      // and completeInitRequestSafely so the rollback chain runs regardless
      // of where the throw originates (connect wiring bug OR handleRequest
      // mid-flight throw that completeInitRequestSafely rethrows). Rethrow
      // into the outer catch-all so the 500 response behavior is preserved.
      try {
        await server.connect(transport);
        // completeInitRequestSafely swallows throws from handleRequest when
        // onsessioninitialized's defensive race-fallback closed the transport
        // mid-flight (initOutcome.rejected=true). The fallback already handled
        // the response lifecycle; a naked await here would bubble the closed-
        // transport throw into the outer catch-all and produce a 500 write on
        // top of the 429 the fallback already streamed.
        await completeInitRequestSafely(
          transport,
          req,
          res,
          req.body,
          initOutcome,
        );
      } catch (connectErr) {
        rollbackSessionAfterConnectFailure({
          transport,
          sid: preSid,
          transports,
          sessionLastActivity,
          ipLimiter,
          sessionStateManager,
          workspaceManager,
        });
        throw connectErr;
      }
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
//
// Intentionally NOT wrapped in `bearerMiddleware`. An unauthenticated
// client that probes GET /mcp without a Mcp-Session-Id expects a
// protocol-level 405 (Method Not Allowed); a 401 from bearer-auth would
// cause the MCP SDK to kick off its auth dance against the wrong endpoint.
// Authenticated GETs are gated by the Mcp-Session-Id — a session-scoped
// secret already established through the bearer-gated POST /mcp path, so
// there's no auth regression from skipping the middleware here.
app.get("/mcp", async (req: Request, res: Response) => {
  // Mirror POST /mcp's outer try/catch so a throw from handleRequest (stream
  // teardown mid-flight, transport bug) lands in a structured 500 rather
  // than escaping to Express's default error handler.
  try {
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
  } catch (error) {
    console.error("[MCP] Error handling GET request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Session termination
app.delete("/mcp", bearerMiddleware, async (req: Request, res: Response) => {
  // Mirror POST /mcp's outer try/catch — transport.handleRequest can throw
  // during teardown (closed stream, partial write) and we'd rather surface a
  // structured 500 than leak the throw.
  try {
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
  } catch (error) {
    console.error("[MCP] Error handling DELETE request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
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
  // Late-bound via getter: trustProxy is resolved inside startServer() from
  // the loaded config, after this handler factory has already been invoked
  // at module-load time. Collapse to boolean for the SSE handlers' clientIp
  // contract — the spoof-risk surface is identical whether we're trusting by
  // hop count, CIDR list, or a blanket `true`.
  trustProxy: () => isTrustingProxy(),
  rateLimitRetryAfterSeconds: () => retryAfterSecondsFromTtl(),
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

export interface HealthRouteDeps {
  getIndexStats?: typeof getIndexStats;
}

export function registerHealthRoute(
  app: express.Express,
  deps: HealthRouteDeps = {},
): void {
  const _getIndexStats = deps.getIndexStats ?? getIndexStats;

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
      const stats = await _getIndexStats();
      res.json({
        status: "ok",
        server: getServerConfig().server.name,
        uptime_seconds: uptime,
        started_at: startedAt.toISOString(),
        indexing:
          (orchestratorRef as IndexingOrchestrator | null)?.isIndexing() ??
          false,
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
      // Log the full error server-side for operators, but never surface
      // err.message in the response body: /health is unauthenticated and
      // probed by every load balancer, and errors from the DB driver can
      // contain DATABASE_URL fragments, table/schema names, and internal
      // host:port info. Keep the response body to fixed, sanitized fields.
      console.error("[health] Database unavailable:", err);
      res.status(503).json({
        status: "degraded",
        server: getServerConfig().server.name,
        uptime_seconds: uptime,
        started_at: startedAt.toISOString(),
        index: "unavailable",
      });
    }
  });
}

registerHealthRoute(app);

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

/**
 * Deps hook for the /faq.txt handler. Lets tests swap the DB + config
 * boundaries without reimplementing the handler. Mirrors the pattern used
 * by registerAnalyticsRoutes().
 */
export interface FaqRouteDeps {
  getFaqChunks?: typeof getFaqChunks;
  getServerConfig?: typeof getServerConfig;
}

/**
 * Reset the module-level /faq.txt cache. Test-only helper so suites can
 * assert the retry-on-partial-failure behaviour (second request must
 * re-enter the fetch path when the previous response was partial).
 */
export function __resetFaqCacheForTesting(): void {
  cachedFaqTxt = null;
}

/**
 * Register GET /faq.txt. Extracted so tests can mount the real handler
 * against stubbed deps; the production call site in module init passes no
 * deps and uses the imported getFaqChunks/getServerConfig.
 *
 * Partial-failure policy: if any per-source fetch throws, we serve the
 * partial result ONCE with `Cache-Control: no-store` and
 * `X-Partial-Sources: <failed names>` so operators/agents can detect the
 * gap, and we do NOT populate `cachedFaqTxt`. The next request re-enters
 * the fetch path. Previously the partial body was cached and served 200
 * OK until the next reindex invalidation — hours of silent gaps.
 */
export function registerFaqRoute(
  app: express.Express,
  deps: FaqRouteDeps = {},
): void {
  const _getFaqChunks = deps.getFaqChunks ?? getFaqChunks;
  const _getServerConfig = deps.getServerConfig ?? getServerConfig;

  app.get("/faq.txt", async (_req: Request, res: Response) => {
    try {
      if (cachedFaqTxt) {
        res.type("text/plain").send(cachedFaqTxt);
        return;
      }

      const serverCfg = _getServerConfig();
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
        res.type("text/plain").send(cachedFaqTxt);
        return;
      }

      // Fetch FAQ chunks per source. Track which sources failed so we can
      // refuse to cache a partial result.
      const allChunks: FaqChunkResult[] = [];
      const failedSources: string[] = [];
      for (const src of faqSources) {
        try {
          const chunks = await _getFaqChunks(
            [src.name],
            src.confidenceThreshold,
          );
          allChunks.push(...chunks);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `[faq.txt] Failed to fetch chunks for source "${src.name}": ${msg}`,
          );
          failedSources.push(src.name);
        }
      }

      const body = generateFaqTxt(allChunks, serverCfg.server.name, faqSources);

      if (failedSources.length > 0) {
        // Partial result — serve once, do NOT cache, surface the failure
        // via headers so downstream can alert / filter.
        res.setHeader("X-Partial-Sources", failedSources.join(","));
        res.setHeader("Cache-Control", "no-store");
        res.type("text/plain").send(body);
        return;
      }

      cachedFaqTxt = body;
      res.type("text/plain").send(cachedFaqTxt);
    } catch (err) {
      console.error("[faq.txt] Generation failed:", err);
      res
        .status(503)
        .type("text/plain")
        .send("# Service unavailable\nFAQ index not ready.");
    }
  });
}

registerFaqRoute(app);

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
// Analytics — /analytics (dashboard HTML) and /api/analytics/auth-mode are
// public (unauthenticated); every other /api/analytics/* route is gated by
// analyticsAuth below.
// ---------------------------------------------------------------------------

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

/**
 * R4-8 — startup-time guard for the production-analytics token.
 *
 * Previously `getAnalyticsToken()` would auto-generate a process-ephemeral
 * UUID when analytics was enabled without an explicit token. That token was
 * unique per replica, so in multi-replica deployments the dashboard could
 * authenticate against replica A and then hit replica B on the next request
 * and be rejected with 401 (replica B minted its own different UUID).
 *
 * The fix: at startup, when `analytics.enabled && nodeEnv === "production"`
 * and neither `analytics.token` nor the ANALYTICS_TOKEN env var is set, we
 * throw a clear error so operators discover the missing config BEFORE the
 * server starts serving. The existing runtime throw inside
 * `getAnalyticsToken()` remains as a defense-in-depth second check; this
 * assert just moves the discovery to process boot.
 *
 * Pure function so tests can drive every combination of
 * (nodeEnv × enabled × configuredToken × envToken) without booting the full
 * server.
 */
export function assertAnalyticsTokenConfigured(opts: {
  nodeEnv: string;
  analyticsEnabled: boolean;
  configuredToken: string | undefined;
  envToken: string | undefined;
}): void {
  if (!opts.analyticsEnabled) return;
  if (opts.nodeEnv !== "production") return;
  // Treat empty string same as undefined — `analytics.token: ""` in YAML
  // otherwise silently skips the guard.
  const hasConfigured =
    !!opts.configuredToken && opts.configuredToken.length > 0;
  const hasEnv = !!opts.envToken && opts.envToken.length > 0;
  if (hasConfigured || hasEnv) return;
  throw new Error(
    "ANALYTICS_TOKEN required in production (set analytics.token in config " +
      "or the ANALYTICS_TOKEN env var). Auto-generated tokens are " +
      "process-ephemeral and break multi-replica deployments — a dashboard " +
      "authenticated against one replica will 401 on another.",
  );
}

/**
 * Return true if the request originated from a loopback interface. Trusts
 * ONLY `req.socket.remoteAddress` (not `X-Forwarded-For` — that's client-
 * controlled and would let anyone forge "I'm localhost").
 *
 * Node's dual-stack sockets can report loopback in several forms:
 * - `127.0.0.1` (IPv4)
 * - `::1` (IPv6 loopback)
 * - `::ffff:127.0.0.1` (IPv4-mapped IPv6, common)
 * - `0:0:0:0:0:ffff:127.0.0.1` (same, unnormalized expanded form — seen in
 *   some test harnesses and older runtimes)
 *
 * Rather than hardcode every textual form, we parse the address via
 * ipaddr.js and compare against the canonical loopback ranges. Unparseable
 * addresses (empty string, "unknown", etc.) return false so a malformed
 * remote never accidentally counts as localhost.
 */
// 127.0.0.0/8 base address used by isLocalhostReq's IPv4 loopback match.
// Hoisted to a module-level constant so the per-request path doesn't re-parse
// the same literal on every call (cheap individually, but /mcp can receive
// it thousands of times/sec under load).
const LOOPBACK_IPV4_BASE = ipaddr.IPv4.parse("127.0.0.0");

function isLocalhostReq(req: Request): boolean {
  // Fail-closed when the server trusts forwarded headers. With
  // `trust_proxy=true` AND NODE_ENV=development AND a local reverse proxy
  // (Docker sidecar, ngrok, localhost tunnel, k8s sidecar), every request's
  // socket peer is 127.0.0.1 — so the dev bypass would effectively
  // unauthenticate analytics for the entire public internet. We refuse the
  // dev bypass entirely in that combo; operators who need it should drop
  // trust_proxy or bind the dev server directly without a fronting proxy.
  // A startup WARN is emitted from startServer() when both flags are set so
  // this behavior isn't silent.
  if (isTrustingProxy()) return false;
  const addr = req.socket?.remoteAddress ?? "";
  if (!addr) return false;
  try {
    let parsed = ipaddr.parse(addr);
    if (parsed.kind() === "ipv6") {
      const v6 = parsed as ipaddr.IPv6;
      if (v6.isIPv4MappedAddress()) parsed = v6.toIPv4Address();
    }
    if (parsed.kind() === "ipv4") {
      // 127.0.0.0/8 is the IPv4 loopback range.
      return (parsed as ipaddr.IPv4).match([LOOPBACK_IPV4_BASE, 8]);
    }
    // IPv6 loopback is exactly ::1.
    return (parsed as ipaddr.IPv6).toNormalizedString() === "0:0:0:0:0:0:0:1";
  } catch {
    return false;
  }
}

/**
 * Compute the auth-mode response body for `/api/analytics/auth-mode`.
 *
 * Dev bypass is advertised only when BOTH (a) NODE_ENV=development and
 * (b) the request came from a loopback interface. This means a dev server
 * bound to 0.0.0.0 won't advertise `dev: true` to LAN callers — so the
 * dashboard's client-side "skip the token prompt in dev" behaviour can't
 * accidentally expose analytics on a local network.
 *
 * Exported so tests can cover the four NODE_ENV × localhost combinations
 * in isolation without having to spoof req.socket.remoteAddress via TCP.
 */
export function getAuthMode(req: Request): { dev: boolean } {
  const config = getConfig();
  const dev = config.nodeEnv === "development" && isLocalhostReq(req);
  return { dev };
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
      )} — set ANALYTICS_TOKEN env var to use a stable value`,
    );
  }
  return autoGeneratedAnalyticsToken ?? undefined;
}

/**
 * Analytics auth middleware — exported so tests can import and exercise the
 * real code instead of reimplementing the logic in test doubles.
 */
export function analyticsAuth(
  req: Request,
  res: Response,
  next: express.NextFunction,
): void {
  // Mirror the getAnalyticsToken() pattern: a throw from the config read
  // (e.g. corrupt YAML on hot reload, env parse failure) would otherwise
  // escape the Express middleware as an unhandled exception. Convert it to
  // a 503 so callers see a stable error shape and operators get a
  // diagnostic log line.
  let analyticsCfg: ReturnType<typeof getAnalyticsConfig>;
  try {
    analyticsCfg = getAnalyticsConfig();
  } catch (err) {
    console.error(
      `[analytics] auth misconfigured: config read failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    res.status(503).json({
      error: "misconfigured",
      error_description: "Analytics config read failed",
    });
    return;
  }
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

  // Message is conditional on nodeEnv so non-prod operators don't get a
  // misleading "requires ANALYTICS_TOKEN in production" hint when the root
  // cause is something else (e.g. a downstream config-read failure). The
  // production copy still surfaces the concrete remediation step.
  const prodTokenMsg =
    "Analytics requires ANALYTICS_TOKEN in production (env var or analytics.token in config).";
  const nonProdTokenMsg =
    "Analytics token unavailable — check analytics config / logs.";
  const tokenDescription =
    config.nodeEnv === "production" ? prodTokenMsg : nonProdTokenMsg;

  let token: string | undefined;
  try {
    token = getAnalyticsToken();
  } catch (err) {
    console.error(
      `[analytics] auth misconfigured: ${err instanceof Error ? err.message : String(err)}`,
    );
    res.status(503).json({
      error: "misconfigured",
      error_description: tokenDescription,
    });
    return;
  }

  if (!token) {
    // Should not happen — getAnalyticsToken auto-generates or throws.
    // Fail closed rather than silently bypassing auth.
    console.error("[analytics] auth misconfigured: no token available");
    res.status(503).json({
      error: "misconfigured",
      error_description: tokenDescription,
    });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    // Match the 503 branch's envelope shape ({error, error_description})
    // so every failure surface speaks one format.
    res.status(401).json({
      error: "unauthorized",
      error_description:
        "Missing or invalid Authorization header. Use: Bearer <token>",
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
    res.status(403).json({
      error: "forbidden",
      error_description: "Invalid analytics token",
    });
    return;
  }

  next();
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Result of parsing analytics filter query params.
 *
 * When `ok` is `false`, the caller should respond with
 * `res.status(status).json(body)` — `body` carries
 * `{ error, error_description }`. When `ok` is `true`, `filter` is safe to
 * pass to the DB layer.
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
  // Reject empty strings with 400: an empty filter value is almost certainly
  // a client bug (e.g. `?tool_type=` from a blank select) and would otherwise
  // pass through to LIKE as an unbounded wildcard match. Returning 400 makes
  // the bug visible rather than silently dropping the param.
  if (typeof req.query.tool_type === "string") {
    if (req.query.tool_type.length === 0) {
      return {
        ok: false,
        status: 400,
        body: {
          error: "invalid_request",
          error_description: "tool_type must be a non-empty string",
        },
      };
    }
    filter.tool_type = req.query.tool_type;
  }
  if (typeof req.query.source === "string") {
    if (req.query.source.length === 0) {
      return {
        ok: false,
        status: 400,
        body: {
          error: "invalid_request",
          error_description: "source must be a non-empty string",
        },
      };
    }
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
    const from = new Date(fromRaw + "T00:00:00.000Z");
    const to = new Date(toRaw + "T23:59:59.999Z");
    // The regex only checks shape — it accepts calendar-nonsense like
    // 2025-13-01 or 2025-04-00 which `new Date()` turns into Invalid Date.
    // Calling `.toISOString()` on an Invalid Date throws RangeError and
    // escapes this parser as a 500. Guard before the roundtrip check so
    // both "invalid month/day" and "silent rollover" (Feb 30 -> Mar 2)
    // return a clean 400.
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return {
        ok: false,
        status: 400,
        body: {
          error: "invalid_request",
          error_description: "from/to must be a valid calendar date",
        },
      };
    }
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
    // Cap the range width. Without this, a client could send
    // from=1970-01-01&to=9999-12-31 and the DB would scan every row. Use
    // the same upper bound as the rolling `days` preset so both code paths
    // agree on "how much history is addressable".
    const rangeDays = Math.ceil(
      (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000),
    );
    if (rangeDays > MAX_DAYS) {
      return {
        ok: false,
        status: 400,
        body: {
          error: "invalid_request",
          error_description: `from/to range must be <= ${MAX_DAYS} days`,
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
 * value is absent. On invalid input, returns `{ error: string }` where
 * `error` is a human-readable phrase (e.g. "must be > 0"). The wrapper
 * functions `parseDaysOrError` / `parseLimitOrError` embed this string into
 * the `error_description` field of the 400 envelope (not a top-level
 * `error` field — that slot carries the machine-readable "invalid_request"
 * code).
 */
export function parsePositiveIntParam(
  raw: unknown,
  defaultValue: number,
  max: number,
): number | { error: string } {
  if (raw === undefined || raw === null || raw === "") return defaultValue;
  if (typeof raw !== "string") return { error: "must be a string" };
  // R4-10: STRICT /^\d+$/ guard BEFORE Number.parseInt. Without this, inputs
  // like "1.5", "1e3", " 123", and "123abc" would be silently coerced by
  // parseInt's permissive grammar (truncating at the first non-digit / after
  // implicit trim) and the function would return a plausible-looking
  // positive integer for gibberish input. See the dedicated test cases.
  if (!/^\d+$/.test(raw)) return { error: "must be a positive integer" };
  const n = Number.parseInt(raw, 10);
  if (n <= 0) return { error: "must be > 0" };
  if (n > max) return { error: `must be <= ${max}` };
  return n;
}

// Upper bound for the `days` query parameter. Kept at 100000 so the UI's
// "All time" preset (which sends days=ALL_TIME_DAYS=99999 — see
// docs/analytics.html) is comfortably under the cap. If you lower MAX_DAYS,
// make sure it stays >= 99999 or the "All time" preset will 400.
//
// Exported so tests can reference the constant directly instead of
// hardcoding the numeric literal (keeps one source of truth).
export const MAX_DAYS = 100000;
const MAX_LIMIT = 200;

/**
 * Result envelope matching {@link AnalyticsFilterParseResult} so day/limit
 * parse errors emit the same `{error, error_description}` body shape as
 * from/to validation. Callers check `ok` and forward `status`/`body` on
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
      // Parse outside the try/catch so the 500 error log below can read
      // `parsed.filter` and `daysParsed.value` for request-context logging.
      // Parsers don't throw — they return ok/error envelopes — so this keeps
      // the 500 branch reserved for DB-layer failures while still surfacing
      // exactly which filter/window blew up.
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
      try {
        const summary = await _getAnalyticsSummary(
          parsed.filter,
          daysParsed.value,
        );
        res.json(summary);
      } catch (err) {
        console.error(
          `[analytics] Summary query failed (filter=${JSON.stringify(parsed.filter)} days=${daysParsed.value}):`,
          err,
        );
        res.status(500).json({ error: "Failed to fetch analytics summary" });
      }
    },
  );

  app.get(
    "/api/analytics/queries",
    analyticsAuth,
    async (req: Request, res: Response) => {
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
      try {
        const queries = await _getTopQueries(
          daysParsed.value,
          limitParsed.value,
          parsed.filter,
        );
        res.json(queries);
      } catch (err) {
        console.error(
          `[analytics] Top queries failed (filter=${JSON.stringify(parsed.filter)} days=${daysParsed.value} limit=${limitParsed.value}):`,
          err,
        );
        res.status(500).json({ error: "Failed to fetch top queries" });
      }
    },
  );

  app.get(
    "/api/analytics/empty-queries",
    analyticsAuth,
    async (req: Request, res: Response) => {
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
      try {
        const queries = await _getEmptyQueries(
          daysParsed.value,
          limitParsed.value,
          parsed.filter,
        );
        res.json(queries);
      } catch (err) {
        console.error(
          `[analytics] Empty queries failed (filter=${JSON.stringify(parsed.filter)} days=${daysParsed.value} limit=${limitParsed.value}):`,
          err,
        );
        res.status(500).json({ error: "Failed to fetch empty queries" });
      }
    },
  );

  app.get(
    "/api/analytics/tool-counts",
    analyticsAuth,
    async (req: Request, res: Response) => {
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
      try {
        const counts = await _getToolCounts(daysParsed.value, parsed.filter);
        res.json(counts);
      } catch (err) {
        console.error(
          `[analytics] Tool counts failed (filter=${JSON.stringify(parsed.filter)} days=${daysParsed.value}):`,
          err,
        );
        res.status(500).json({ error: "Failed to fetch tool counts" });
      }
    },
  );

  app.get("/api/analytics/auth-mode", (req: Request, res: Response) => {
    res.json(getAuthMode(req));
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
        console.error(
          `[analytics] sendFile failed mid-stream path=${_analyticsHtmlPath}:`,
          err,
        );
        return;
      }
      // Type-guarded access to Node's errno code — sendFile can reject with
      // errors that don't carry one, so check before using.
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as NodeJS.ErrnoException).code
          : undefined;
      if (code === "ENOENT") {
        console.warn(
          `[analytics] dashboard HTML missing at ${_analyticsHtmlPath} — serving 404`,
        );
        res.status(404).json({ error: "analytics dashboard not available" });
        return;
      }
      console.error(
        `[analytics] sendFile failed path=${_analyticsHtmlPath}:`,
        err,
      );
      res.status(500).json({ error: "analytics dashboard unavailable" });
    });
  });
}

// R4-19: single surface — `registerAnalyticsRoutes` is the canonical way to
// mount the analytics routes. Production wires it up inside startServer()
// before app.listen(); tests that want the real handlers call it on their
// own app. Do NOT add a module-load-time side-effect call here: that created
// a second surface that (a) confused readers about which was canonical and
// (b) coupled mere module import (e.g. an unrelated re-export in a test
// fixture) to mutating the module-level app.

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

export async function startServer(options?: ServerOptions): Promise<void> {
  // Top-level try/catch around the entire startup sequence so synchronous
  // throws from getConfig/getServerConfig AND async failures from
  // initializeSchema/checkAndIndex carry a uniform '[startup] fatal:' log
  // prefix before propagating. Without this wrapper, failures escape as
  // bare rejections: index.ts' .catch prints them, but ops can't grep for
  // a single stable token to correlate startup-crash incidents across
  // deployments. Re-throw so callers (src/index.ts and its process.exit
  // path) keep their existing exit-code contract.
  try {
    return await startServerInner(options);
  } catch (err) {
    console.error("[startup] fatal:", err);
    throw err;
  }
}

async function startServerInner(options?: ServerOptions): Promise<void> {
  if (options?.configPath) {
    process.env.PATHFINDER_CONFIG = options.configPath;
  }

  const cfg = getConfig();
  const serverCfg = getServerConfig();

  const port = options?.port ?? cfg.port;

  // Configure proxy trust BEFORE anything reads req.ip. When enabled,
  // Express walks X-Forwarded-For and populates req.ip; when disabled,
  // XFF is ignored entirely (see src/ip-util.ts for the security rationale
  // — a blindly-trusted XFF lets any client claim an allowlisted IP and
  // bypass the per-IP session limiter).
  //
  // Security semantics of `app.set("trust proxy", true)`:
  //   Express's `trust proxy = true` does NOT set a hop count. It means
  //   Express trusts EVERY address in the X-Forwarded-For chain and uses
  //   the leftmost (client-supplied, potentially spoofable) entry as
  //   `req.ip`. This is ONLY safe when the fronting reverse proxy
  //   discards any client-supplied XFF header and sets its own trusted
  //   value before the request reaches us. See the cautionary warning in
  //   pathfinder.example.yaml next to `server.trust_proxy` and the Express
  //   "trust proxy" docs (https://expressjs.com/en/guide/behind-proxies.html).
  //   For tighter single-hop deployments, set a numeric hop count
  //   (e.g. `app.set('trust proxy', 1)`) instead.
  //
  // We ALWAYS call app.set here (both branches) so a re-entry with a
  // flipped config value doesn't leave Express's internal state stuck on
  // the previous value — the module-level `trustProxy` var and Express
  // must agree, always.
  trustProxy = serverCfg.server.trust_proxy ?? false;
  app.set("trust proxy", trustProxy);
  if (isTrustingProxy()) {
    // R4-14: print the configured value so operators can confirm the shape
    // (blanket boolean, hop count, or CIDR list) actually took effect.
    const rendered = Array.isArray(trustProxy)
      ? `[${trustProxy.join(", ")}]`
      : String(trustProxy);
    console.log(
      `[startup] trust_proxy=${rendered} — honoring X-Forwarded-For (reverse proxy must strip/rewrite this header)`,
    );
    if (cfg.nodeEnv === "development") {
      // Dev bypass and trust_proxy=true is an unsupported combination:
      // isLocalhostReq fails closed so the dev bypass is effectively
      // disabled, but operators should know the combo doesn't behave like
      // either flag would alone.
      console.warn(
        "[startup] trust_proxy=true + NODE_ENV=development is unsupported — analytics dev bypass is DISABLED to prevent exposing the dashboard via a fronting proxy",
      );
    }
  } else {
    // R3 #18: give operators a positive confirmation that the hardened
    // default is in effect. Without this, an operator who enabled
    // trust_proxy expecting it to take effect had to grep for the absence
    // of the truthy log above to infer the state — fragile.
    console.log(
      "[startup] trust_proxy=false — X-Forwarded-For ignored; client IP derived from socket (hardened default)",
    );
  }

  // R4-8 — refuse to start in production when analytics is enabled but no
  // stable token is configured. The runtime `getAnalyticsToken()` throw is
  // too late: the error only surfaces on the first /api/analytics request
  // AND — worse — a pre-R4-8 replica would auto-generate its own token and
  // silently start answering with an unshared secret. Fail loudly here so
  // the missing ANALYTICS_TOKEN is discovered at deploy time, not hours
  // later when the dashboard starts randomly 401-ing against the other
  // replicas.
  const analyticsCfg = getAnalyticsConfig();
  assertAnalyticsTokenConfigured({
    nodeEnv: cfg.nodeEnv,
    analyticsEnabled: !!analyticsCfg?.enabled,
    configuredToken: analyticsCfg?.token,
    envToken: process.env.ANALYTICS_TOKEN,
  });

  // Configure session TTL and IP rate limiter from config
  const maxSessionsPerIp = serverCfg.server.max_sessions_per_ip ?? 20;
  SESSION_TTL_MS = (serverCfg.server.session_ttl_minutes ?? 30) * 60 * 1000;
  const allowlist = serverCfg.server.allowlist ?? [];
  ipLimiter = new IpSessionLimiter(maxSessionsPerIp, { allowlist });
  if (allowlist.length > 0) {
    console.log(
      `[startup] IP allowlist: ${allowlist.length} entr${allowlist.length === 1 ? "y" : "ies"} (bypasses session cap)`,
    );
  }

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

    // Set up bash telemetry with periodic flush. Guard against double-init:
    // startup() isn't expected to run twice in a process lifetime, but a
    // stray re-entry would leak a second interval that shutdown() can't
    // clean up (only the most recent handle lives in the module slot). The
    // sessionReaperInterval init above uses the same defensive guard.
    bashTelemetry = new BashTelemetry(insertCollectedData);
    if (!telemetryFlushInterval) {
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
    }
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

    // R3 #5: use two distinct catches so an index-check failure and a
    // bash-refresh failure surface under distinguishable log prefixes.
    // Previously the combined `.then(refresh).catch(...)` mis-labeled
    // refresh failures as "[startup] Initial index check failed:" — an
    // operator reading logs couldn't tell which operation actually broke.
    runStartupIndexAndBashRefresh(orchestrator, serverCfg.sources);

    orchestrator.startNightlyReindex();
  } else {
    console.log("[startup] No search tools configured — skipping indexing");
  }

  // R4-19: explicit mount — the module-load side-effect was removed so this
  // is now the single call site for the production app.
  registerAnalyticsRoutes(app);

  const serverName = serverCfg.server.name;
  const server = app.listen(port, () => {
    console.log(`[${serverName}] Running at http://localhost:${port}/mcp`);
    console.log(`[health] http://localhost:${port}/health`);
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    // Bypassing the graceful shutdown path on a server-level error (previously
    // `process.exit(1)` inline) left telemetry unflushed, open transports
    // abandoned, and the DB pool not closed. Route through the existing
    // `shutdown` helper so the teardown sequence is consistent with
    // SIGINT/SIGTERM. `shutdown` is hoisted below (function declaration, not
    // a const) so the forward reference resolves.
    if (err.code === "EADDRINUSE") {
      console.error(
        `[startup] Port ${port} is already in use. Set PORT env var to use a different port.`,
      );
    } else {
      console.error(`[startup] Server error:`, err);
    }
    // shutdown() calls process.exit(0) on completion; wrap in catch so a
    // shutdown failure still terminates the process instead of hanging.
    shutdown(`server-error:${err.code ?? "unknown"}`).catch((shutdownErr) => {
      console.error("[startup] shutdown-on-error failed:", shutdownErr);
      process.exit(1);
    });
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
    // Cancel any webhook-triggered bash-refresh timers that haven't fired
    // yet — otherwise they can hold the event loop open past shutdown.
    if (pendingBashRefreshTimers.size > 0) {
      for (const handle of pendingBashRefreshTimers) clearTimeout(handle);
      pendingBashRefreshTimers.clear();
    }
    try {
      await bashTelemetry?.flush();
    } catch (e) {
      console.error("[shutdown] Telemetry flush failed:", e);
    }
    // Close all open transports (both Streamable-HTTP and legacy SSE) so
    // hanging streams don't block exit. Pre-R2 this loop only iterated
    // `sseTransports`, leaving Streamable-HTTP sessions open past shutdown.
    // closeAllSessions runs each map's closes in parallel via
    // Promise.allSettled so one slow/rejecting stream doesn't stall the
    // rest past the orchestrator's kill-deadline.
    try {
      await closeAllSessions({ transports, sseTransports });
    } catch (e) {
      console.error("[shutdown] closeAllSessions threw:", e);
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
