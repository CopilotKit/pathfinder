import type { Request, Response, RequestHandler } from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bearerMiddleware } from "./oauth/handlers.js";
import type { IpSessionLimiter } from "./ip-limiter.js";
import {
  buildRateLimitPayload,
  clampRetryAfterSeconds,
} from "./rate-limit-response.js";
import type { WorkspaceManager } from "./workspace.js";
import { clientIp } from "./ip-util.js";

/**
 * Minimal structural shape of WorkspaceManager that sse-handlers actually
 * uses. Widening to a structural type (rather than the concrete class)
 * lets tests pass stubs without casts.
 *
 * `ensureSession` return type is intentionally typed as `unknown` because
 * the handler never consumes it — the real class returns a path string,
 * test stubs return void. Typing the call-site as fire-and-forget keeps
 * both callable as drop-in replacements.
 */
export interface WorkspaceManagerLike {
  ensureSession: (sessionId: string) => unknown;
  cleanup: (sessionId: string) => void;
}

// Type-level assertion: the real WorkspaceManager must satisfy the
// structural shape. Using a function signature guarantees structural
// compatibility without needing a cast. If the real class renames or
// drops one of these methods, this line fails at compile time.
type _WorkspaceManagerIsLike = WorkspaceManager extends WorkspaceManagerLike
  ? true
  : never;
const _workspaceManagerIsLike: _WorkspaceManagerIsLike = true;
void _workspaceManagerIsLike;

/**
 * Minimal structural shape of SessionStateManager that sse-handlers needs.
 * Only `cleanup` is called here — the full class lives in
 * mcp/tools/bash-session.ts but we don't import it to keep this module
 * decoupled and to let tests inject lightweight stubs.
 */
export interface SessionStateManagerLike {
  cleanup: (sessionId: string) => void;
}

/**
 * Dependencies for the SSE endpoint handlers.
 *
 * State is injected (not module-scoped) so tests can exercise handlers against
 * isolated maps without poisoning shared server.ts state.
 */
export interface SseHandlerDeps {
  sseTransports: Record<string, SSEServerTransport>;
  sessionLastActivity: Record<string, number>;
  /**
   * IP rate limiter. Accepts either a direct instance or a getter to support
   * late binding in server.ts (the limiter is constructed during startServer()).
   */
  ipLimiter:
    | IpSessionLimiter
    | undefined
    | (() => IpSessionLimiter | undefined);
  createMcpServer: () => McpServer;
  /**
   * Workspace manager. Accepts either a direct instance or a getter to support
   * late binding in server.ts. Uses the structural `WorkspaceManagerLike`
   * shape so tests can pass minimal stubs.
   */
  workspaceManager:
    | WorkspaceManagerLike
    | undefined
    | (() => WorkspaceManagerLike | undefined);
  /**
   * Session state manager (bash tool per-session shell state). Optional.
   * Accepts either a direct instance or a getter for late binding, matching
   * the other managers. When present, cleanup() is called from the SSE
   * handler's client-disconnect closure AND from reapIdleSseSessions so
   * per-session shell state doesn't leak when SSE sessions end.
   */
  sessionStateManager?:
    | SessionStateManagerLike
    | (() => SessionStateManagerLike | undefined);
  /**
   * Retry-After hint surfaced in rate-limit rejections. Optional — defaults
   * to 60 seconds. Server.ts injects something derived from session TTL.
   */
  rateLimitRetryAfterSeconds?: number | (() => number);
  /**
   * Whether Express is configured to trust a reverse proxy's
   * `X-Forwarded-For` header. Controls how `clientIp` resolves the caller:
   * when true, we read `req.ip` (populated by Express from the XFF chain);
   * when false, we ignore XFF and use the socket peer address so a client
   * cannot spoof an allowlisted IP. Defaults to `false` when omitted.
   *
   * Accepts either a direct value or a getter for late binding — server.ts
   * reads config during startServer() which runs after this handler
   * factory is called.
   */
  trustProxy?: boolean | (() => boolean);
}

function resolve<T>(value: T | (() => T)): T {
  return typeof value === "function" ? (value as () => T)() : value;
}

/**
 * Create the /sse (GET) and /messages (POST) handler pair for the legacy
 * MCP SSE transport. Bearer auth is enforced via the same bearerMiddleware
 * used by /mcp (opportunistic — missing/invalid bearer behaves like /mcp).
 *
 * The returned handlers include bearerMiddleware in their middleware chain so
 * that callers only need to register a single handler per route.
 */
export function createSseHandlers(deps: SseHandlerDeps): {
  getHandler: RequestHandler[];
  postHandler: RequestHandler[];
} {
  const { sseTransports, sessionLastActivity, createMcpServer } = deps;

  const sseGet: RequestHandler = async (req: Request, res: Response) => {
    try {
      // Resolve late-bound deps inside the try block so a getter throw (e.g.
      // a config reload mid-request) is caught by the handler's own 500 path
      // instead of escaping to Express's default error handler.
      const trustProxy = resolve(deps.trustProxy ?? false) ?? false;
      const ip = clientIp(req, trustProxy);
      const ipLimiter = resolve(deps.ipLimiter);
      const workspaceManager = resolve(deps.workspaceManager);

      // Pre-check BEFORE constructing the transport. Mirrors the /mcp path's
      // pattern: on a rate-limit rejection we should emit a descriptive
      // payload + 429 and skip all transport/MCP-server wiring. The previous
      // flow built the transport first, which burned a sessionId on every
      // rejected request and exposed a race where the transport could
      // accumulate state before we knew we'd reject.
      if (
        ipLimiter &&
        !ipLimiter.isAllowlisted(ip) &&
        ipLimiter.getSessionCount(ip) >= ipLimiter.getMax()
      ) {
        const currentCount = ipLimiter.getSessionCount(ip);
        const limit = ipLimiter.getMax();
        console.warn(
          `[mcp] IP rate limit exceeded for ${ip} (${currentCount}/${limit}), rejecting SSE session`,
        );
        // Clamp once so the Retry-After header agrees with the JSON body.
        // buildRateLimitPayload also clamps defensively, but the header is
        // the authoritative signal for standards-compliant clients — it
        // must carry the same sanitized integer as the body.
        const retryAfterSeconds = clampRetryAfterSeconds(
          resolve(deps.rateLimitRetryAfterSeconds ?? 60) ?? 60,
        );
        const payload = buildRateLimitPayload({
          limit,
          currentCount,
          retryAfterSeconds,
        });
        res.setHeader("Retry-After", String(retryAfterSeconds));
        res.status(429).json(payload);
        return;
      }

      // Create transport. sessionId is assigned in the constructor.
      const transport = new SSEServerTransport("/messages", res);
      const sessionId = transport.sessionId;

      // Cleanup closure — idempotent via the `sseTransports[sessionId]`
      // guard below.
      //
      // Ownership split:
      //   - CLIENT-DISCONNECT path: this closure runs via onclose /
      //     res.on("close"), sees the session still in the map, and owns
      //     the full cleanup (ipLimiter.remove + workspaceManager.cleanup +
      //     sessionStateManager.cleanup + map deletion).
      //   - SERVER-TIMEOUT path: reapIdleSseSessions deletes the map entry
      //     AND calls the cleanup chain inline BEFORE invoking
      //     transport.close(). When the SDK later fires onclose, this
      //     closure's guard sees the entry already gone and short-circuits
      //     — no double-cleanup.
      //
      // The guard is the handshake. Do not weaken it.
      //
      // Per-step try/catch mirrors the /mcp path so a throw from one step
      // doesn't skip the others (e.g. ipLimiter.remove throwing must not
      // prevent workspaceManager.cleanup or sessionStateManager.cleanup
      // from running).
      //
      // The closure re-resolves ipLimiter / workspaceManager /
      // sessionStateManager from deps on every invocation. Capturing the
      // top-of-handler locals was a bug: if the handler factory was
      // registered at module load (before startServer constructed the real
      // instances), those captured locals stayed `undefined` for the entire
      // lifetime of the session, silently dropping cleanup. Re-resolving
      // picks up whatever the caller has wired up by the time the session
      // actually closes.
      const cleanup = () => {
        if (sseTransports[sessionId]) {
          delete sseTransports[sessionId];
          delete sessionLastActivity[sessionId];
          try {
            resolve(deps.ipLimiter)?.remove(sessionId);
          } catch (e) {
            console.error(`[mcp] SSE IP limiter cleanup failed:`, e);
          }
          try {
            resolve(deps.workspaceManager)?.cleanup(sessionId);
          } catch (e) {
            console.error(
              `[mcp] SSE workspace cleanup failed for ${sessionId.slice(0, 8)}:`,
              e,
            );
          }
          try {
            resolve(deps.sessionStateManager)?.cleanup(sessionId);
          } catch (e) {
            console.error(
              `[mcp] SSE session state cleanup failed for ${sessionId.slice(0, 8)}:`,
              e,
            );
          }
          console.log(
            `[mcp] SSE session ${sessionId.slice(0, 8)} closed (${Object.keys(sseTransports).length} active)`,
          );
        }
      };

      // Register in the map BEFORE wiring onclose handlers. If a close
      // event fires between handler wiring and tryAdd/ensureSession below,
      // cleanup()'s guard must see a valid map entry so it can drive the
      // full teardown — otherwise cleanup no-ops and the subsequent steps
      // run against a dead response, leaking ipLimiter counters and
      // workspace allocations that nothing will tear down.
      sseTransports[sessionId] = transport;
      sessionLastActivity[sessionId] = Date.now();

      transport.onclose = cleanup;
      res.on("close", cleanup);

      // Recovery for the narrow window between transport construction and
      // the `res.on("close")` registration above: if the client already
      // disconnected (socket destroyed or response ended), neither onclose
      // nor the res 'close' listener will ever fire — the event already
      // passed. Actively invoke cleanup so the map entry we just
      // registered is released, and bail before doing any more work. This
      // prevents ipLimiter.tryAdd and workspaceManager.ensureSession from
      // running against a response we can no longer write to.
      if (res.destroyed || res.writableEnded) {
        cleanup();
        return;
      }

      // Race-fallback: the pre-check above should have caught overflow, but
      // two concurrent /sse requests from the same IP could still slip one
      // through between pre-check and counter increment. tryAdd returning
      // false here means the second request lost the race — reject with
      // 429 + payload, same shape as the pre-check.
      if (ipLimiter && !ipLimiter.tryAdd(ip, sessionId)) {
        const currentCount = ipLimiter.getSessionCount(ip);
        const limit = ipLimiter.getMax();
        console.warn(
          `[mcp] IP rate limit exceeded for ${ip} (${currentCount}/${limit}), rejecting SSE session (race fallback)`,
        );
        // Same clamp as the pre-check path so header and body agree.
        const retryAfterSeconds = clampRetryAfterSeconds(
          resolve(deps.rateLimitRetryAfterSeconds ?? 60) ?? 60,
        );
        const payload = buildRateLimitPayload({
          limit,
          currentCount,
          retryAfterSeconds,
        });
        // Clean up the map entries we pre-registered. The transport was
        // never connected, so onclose will NOT drive a clean tear-down —
        // which is exactly why we must call transport.close() explicitly
        // below. SSEServerTransport holds timers/listeners/file handles
        // from its constructor; skipping close leaks them per rejected race.
        delete sseTransports[sessionId];
        delete sessionLastActivity[sessionId];
        res.setHeader("Retry-After", String(retryAfterSeconds));
        res.status(429).json(payload);
        // Mirror the /mcp race-fallback pattern in server.ts: schedule
        // transport.close() on a microtask so sync throws AND async
        // rejections are both logged instead of surfacing as unhandled.
        Promise.resolve()
          .then(() => transport.close())
          .catch((e) =>
            console.error(
              `[mcp] SSE race-fallback transport.close rejected for ${sessionId.slice(0, 8)}:`,
              e,
            ),
          );
        return;
      }

      // Wrap ensureSession in try/catch so a synchronous throw (ENOSPC,
      // EACCES, corrupted workspace, etc.) runs the full rollback chain
      // inline instead of relying on the outer catch + res.on('close') to
      // eventually clean up. Without this, ipLimiter.tryAdd above already
      // incremented the counter AND we registered map entries — the outer
      // catch writes 500 but there's no guarantee the close listener
      // actually fires on an unconnected transport, so counters + workspace
      // state leak against the IP's cap until TTL reap (30m default).
      //
      // Semantics mirror handleSessionInitAccept in server.ts: rollback
      // clears ipLimiter + sessionStateManager + map entries, closes the
      // transport on a microtask, and writes a structured 503 body when
      // headers haven't been sent. workspaceManager.cleanup is NOT called
      // here because ensureSession threw — nothing to clean.
      try {
        workspaceManager?.ensureSession(sessionId);
      } catch (ensureErr) {
        console.error(
          `[mcp] SSE workspaceManager.ensureSession failed for ${sessionId.slice(0, 8)} [${ip}]; rolling back session:`,
          ensureErr,
        );
        // Per-step try/catch so a rollback step failure doesn't mask the
        // original ensureSession error or skip subsequent steps.
        try {
          resolve(deps.ipLimiter)?.remove(sessionId);
        } catch (e) {
          console.error(
            `[mcp] SSE ensureSession-rollback ipLimiter.remove failed for ${sessionId.slice(0, 8)}:`,
            e,
          );
        }
        try {
          resolve(deps.sessionStateManager)?.cleanup(sessionId);
        } catch (e) {
          console.error(
            `[mcp] SSE ensureSession-rollback sessionState.cleanup failed for ${sessionId.slice(0, 8)}:`,
            e,
          );
        }
        // Delete map entries BEFORE scheduling close so the onclose guard
        // (`if sseTransports[sessionId]`) short-circuits when the SDK
        // eventually fires onclose for the now-closed transport.
        delete sseTransports[sessionId];
        delete sessionLastActivity[sessionId];
        Promise.resolve()
          .then(() => transport.close())
          .catch((e) =>
            console.error(
              `[mcp] SSE ensureSession-rollback transport.close rejected for ${sessionId.slice(0, 8)}:`,
              e,
            ),
          );
        if (!res.headersSent) {
          res.status(503).json({
            error: "workspace_unavailable",
            reason: "Failed to initialize session workspace. Please try again.",
          });
        }
        return;
      }

      // Attach a per-session MCP server. createMcpServer().connect() calls
      // transport.start() internally which writes SSE headers + the
      // "endpoint" event to the response stream.
      const server = createMcpServer();
      await server.connect(transport);

      console.log(
        `[mcp] New SSE session ${sessionId.slice(0, 8)} (${Object.keys(sseTransports).length} active) [${ip}]`,
      );
    } catch (err) {
      console.error("[mcp] SSE connection error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to establish SSE session" });
      }
    }
  };

  const messagesPost: RequestHandler = async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      // Log the reason so operators debugging reaper/client races can see
      // WHY /messages returned 404 without stitching timestamps across
      // client + server logs. Tag the request origin so the signal is
      // useful even without a session id to scope to.
      const trustProxy = resolve(deps.trustProxy ?? false) ?? false;
      const ip = clientIp(req, trustProxy);
      console.warn(`[mcp] /messages 404 reason=missing-session-id ip=${ip}`);
      res.status(404).json({
        error: "Session not found",
        reason: "missing-session-id",
      });
      return;
    }
    const transport = sseTransports[sessionId];
    if (!transport) {
      const trustProxy = resolve(deps.trustProxy ?? false) ?? false;
      const ip = clientIp(req, trustProxy);
      console.warn(
        `[mcp] /messages 404 reason=unknown-session-id ip=${ip} sid=${sessionId.slice(0, 8)}`,
      );
      res.status(404).json({
        error: "Session not found",
        reason: "unknown-session-id",
      });
      return;
    }
    sessionLastActivity[sessionId] = Date.now();
    try {
      await transport.handlePostMessage(req, res, req.body);
    } catch (err) {
      console.error(
        `[mcp] SSE handlePostMessage failed for session ${sessionId.slice(0, 8)}:`,
        err,
      );
      if (!res.headersSent) {
        res.status(500).json({ error: "Message handling failed" });
      }
    }
  };

  return {
    getHandler: [bearerMiddleware, sseGet],
    postHandler: [bearerMiddleware, messagesPost],
  };
}

/**
 * Reap idle SSE sessions. Pure function for testability — server.ts calls
 * this from its periodic reaper alongside the existing Streamable-HTTP reaper.
 *
 * Cleanup ownership — the reaper is the authoritative cleaner for the
 * server-timeout path:
 *
 *   1. Delete map entries FIRST (synchronous). This turns the handler's
 *      `if (sseTransports[sessionId])` guard into a short-circuit when
 *      onclose eventually fires, avoiding double-cleanup.
 *   2. Call ipLimiter.remove + workspaceManager.cleanup +
 *      sessionStateManager.cleanup INLINE — the reaper owns this work.
 *      Prior design relied on transport.close() firing onclose synchronously,
 *      but we wrap close in a microtask to capture async rejections; between
 *      the microtask scheduling and the actual close, the handler's guard is
 *      already false (map entry deleted), so onclose runs and no-ops. That
 *      left ipLimiter counters, workspace sessions, AND per-session shell
 *      state leaking on every reaped session.
 *   3. Schedule transport.close() on a microtask so sync throws AND async
 *      rejections are both logged instead of surfacing as unhandled.
 *
 * The client-disconnect path continues to be owned by the handler's cleanup
 * closure (see sseGet above): res.on("close") / transport.onclose fire,
 * the guard still sees the session registered, and the closure does the
 * full cleanup chain.
 */
export function reapIdleSseSessions(opts: {
  sseTransports: Record<string, { close: () => Promise<void> | void }>;
  sessionLastActivity: Record<string, number>;
  ttlMs: number;
  now?: number;
  /**
   * IP rate limiter — optional. When present the reaper calls
   * `remove(sid)` inline so counters stay correct even if the transport's
   * close() path skips the handler's cleanup closure.
   */
  ipLimiter?: { remove: (sessionId: string) => void };
  /**
   * Workspace manager — optional. When present the reaper calls
   * `cleanup(sid)` inline so per-session workspace state is released even
   * if the handler's onclose chain no-ops.
   */
  workspaceManager?: { cleanup: (sessionId: string) => void };
  /**
   * Session state manager (bash tool per-session shell state) — optional.
   * When present the reaper calls `cleanup(sid)` inline so SSE sessions
   * using bash tools with `session_state: true` don't leak shell state
   * when idle-reaped. Mirrors the /mcp reaper behavior in server.ts.
   */
  sessionStateManager?: { cleanup: (sessionId: string) => void };
}): string[] {
  const {
    sseTransports,
    sessionLastActivity,
    ttlMs,
    ipLimiter,
    workspaceManager,
    sessionStateManager,
  } = opts;
  const now = opts.now ?? Date.now();
  const reaped: string[] = [];
  for (const sid of Object.keys(sseTransports)) {
    const last = sessionLastActivity[sid] ?? 0;
    if (now - last > ttlMs) {
      const transport = sseTransports[sid];
      // Delete map entries FIRST so the handler's onclose guard
      // short-circuits when close() eventually fires its callback.
      delete sseTransports[sid];
      delete sessionLastActivity[sid];
      // Inline cleanup — the reaper owns this for the server-timeout path.
      // Per-step try/catch so a failure in one step doesn't skip the others.
      try {
        ipLimiter?.remove(sid);
      } catch (e) {
        console.error(
          `[mcp] SSE reaper ipLimiter.remove failed for ${sid.slice(0, 8)}:`,
          e,
        );
      }
      try {
        workspaceManager?.cleanup(sid);
      } catch (e) {
        console.error(
          `[mcp] SSE reaper workspace.cleanup failed for ${sid.slice(0, 8)}:`,
          e,
        );
      }
      try {
        sessionStateManager?.cleanup(sid);
      } catch (e) {
        console.error(
          `[mcp] SSE reaper sessionState.cleanup failed for ${sid.slice(0, 8)}:`,
          e,
        );
      }
      // Promise.resolve + .catch attaches a rejection handler even when
      // transport.close() returns a bare rejected Promise. A plain
      // `void transport.close()` only catches synchronous throws; an async
      // rejection would otherwise surface as an unhandled rejection.
      Promise.resolve()
        .then(() => transport.close())
        .catch((e) =>
          console.error(`[mcp] SSE close failed for ${sid.slice(0, 8)}:`, e),
        );
      reaped.push(sid);
    }
  }
  return reaped;
}
