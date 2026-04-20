import type { Request, Response, RequestHandler } from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bearerMiddleware } from "./oauth/handlers.js";
import type { IpSessionLimiter } from "./ip-limiter.js";
import type { WorkspaceManager } from "./workspace.js";

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
   * late binding in server.ts.
   */
  workspaceManager:
    | WorkspaceManager
    | undefined
    | (() => WorkspaceManager | undefined);
}

function resolve<T>(value: T | (() => T)): T {
  return typeof value === "function" ? (value as () => T)() : value;
}

function clientIp(req: Request): string {
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
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
    const ip = clientIp(req);
    const ipLimiter = resolve(deps.ipLimiter);
    const workspaceManager = resolve(deps.workspaceManager);

    try {
      // Create transport. sessionId is assigned in the constructor.
      const transport = new SSEServerTransport("/messages", res);
      const sessionId = transport.sessionId;

      // IP rate limit — same counter as /mcp.
      if (ipLimiter && !ipLimiter.tryAdd(ip, sessionId)) {
        console.warn(
          `[mcp] IP rate limit exceeded for ${ip}, rejecting SSE session`,
        );
        res.status(429).json({ error: "Too many sessions from this IP" });
        return;
      }

      sseTransports[sessionId] = transport;
      sessionLastActivity[sessionId] = Date.now();
      workspaceManager?.ensureSession(sessionId);

      // Wire cleanup before connect() so a start() failure still fires it.
      const cleanup = () => {
        if (sseTransports[sessionId]) {
          delete sseTransports[sessionId];
          delete sessionLastActivity[sessionId];
          ipLimiter?.remove(sessionId);
          workspaceManager?.cleanup(sessionId);
          console.log(
            `[mcp] SSE session ${sessionId.slice(0, 8)} closed (${Object.keys(sseTransports).length} active)`,
          );
        }
      };
      transport.onclose = cleanup;
      res.on("close", cleanup);

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
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const transport = sseTransports[sessionId];
    if (!transport) {
      res.status(404).json({ error: "Session not found" });
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
 */
export function reapIdleSseSessions(opts: {
  sseTransports: Record<string, { close: () => Promise<void> | void }>;
  sessionLastActivity: Record<string, number>;
  ttlMs: number;
  now?: number;
}): string[] {
  const { sseTransports, sessionLastActivity, ttlMs } = opts;
  const now = opts.now ?? Date.now();
  const reaped: string[] = [];
  for (const sid of Object.keys(sseTransports)) {
    const last = sessionLastActivity[sid] ?? 0;
    if (now - last > ttlMs) {
      const transport = sseTransports[sid];
      try {
        void transport.close();
      } catch (e) {
        console.error(`[mcp] SSE close failed for ${sid.slice(0, 8)}:`, e);
      }
      delete sseTransports[sid];
      delete sessionLastActivity[sid];
      reaped.push(sid);
    }
  }
  return reaped;
}
