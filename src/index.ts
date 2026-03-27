import express, { Request, Response } from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./mcp/server.js";
import { initializeSchema, getPool } from "./db/client.js";
import { getIndexStats } from "./db/queries.js";
import { getConfig, getServerConfig } from "./config.js";
import { IndexingOrchestrator } from "./indexing/orchestrator.js";

import { createWebhookHandler } from "./webhooks/github.js";

const app = express();
app.use(
    cors({
        origin: "*",
        exposedHeaders: ["Mcp-Session-Id"],
    }),
);

// ---------------------------------------------------------------------------
// Webhook endpoint — registered BEFORE express.json() so the handler receives
// a raw Buffer for HMAC signature verification.
//
// The handler is wired to the real orchestrator during start().  Until then,
// requests receive 503 (server still initializing).
// ---------------------------------------------------------------------------

let webhookHandler: ((req: Request, res: Response) => Promise<void>) | null = null;
let orchestratorRef: IndexingOrchestrator | null = null;
const startedAt = new Date();

app.post("/webhooks/github", express.raw({ type: "application/json" }), async (req: Request, res: Response) => {
    const handler = webhookHandler;
    if (!handler) {
        res.status(503).json({ error: "Server still initializing" });
        return;
    }
    try {
        await handler(req, res);
    } catch (err) {
        console.error("[webhook] Handler error:", err);
        if (!res.headersSent) {
            res.status(500).json({ error: "Internal webhook handler error" });
        }
    }
});

// JSON parser for all other routes
app.use(express.json());

// ---------------------------------------------------------------------------
// MCP endpoint — session-based (initialize once, then tool calls reuse session)
// ---------------------------------------------------------------------------

const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post("/mcp", async (req: Request, res: Response) => {
    try {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        // Existing session — route to its transport
        if (sessionId && transports[sessionId]) {
            await transports[sessionId].handleRequest(req, res, req.body);
            return;
        }

        // New session — must be an initialize request
        if (!sessionId && isInitializeRequest(req.body)) {
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (sid) => {
                    console.log(`[MCP] Session initialized: ${sid.slice(0, 8)}...`);
                    transports[sid] = transport;
                },
            });
            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid && transports[sid]) {
                    console.log(`[MCP] Session closed: ${sid.slice(0, 8)}...`);
                    delete transports[sid];
                }
            };
            const server = createMcpServer();
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
            return;
        }

        // Invalid request
        res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: No valid session. Send an initialize request first." },
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

// SSE stream for server-initiated notifications
app.get("/mcp", async (req: Request, res: Response) => {
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

// Session termination
app.delete("/mcp", async (req: Request, res: Response) => {
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
// Health check
// ---------------------------------------------------------------------------

app.get("/health", async (_req: Request, res: Response) => {
    try {
        const stats = await getIndexStats();
        const uptime = Math.floor((Date.now() - startedAt.getTime()) / 1000);

        res.json({
            status: "ok",
            server: getServerConfig().server.name,
            uptime_seconds: uptime,
            started_at: startedAt.toISOString(),
            indexing: (orchestratorRef as IndexingOrchestrator | null)?.isIndexing() ?? false,
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
        // Fall back to basic health if DB is unavailable
        res.json({
            status: "ok",
            server: getServerConfig().server.name,
            uptime_seconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
            index: "unavailable",
        });
    }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function start(): Promise<void> {
    const cfg = getConfig();
    const serverCfg = getServerConfig();

    console.log("[startup] Initializing database schema...");
    await initializeSchema();
    console.log("[startup] Database schema ready.");

    // Log active sources from config
    const sourceNames = serverCfg.sources.map(s => `${s.name} (${s.type})`);
    console.log(`[startup] Active sources: ${sourceNames.join(', ')}`);

    // Wire the webhook handler and health endpoint with the real orchestrator
    const orchestrator = new IndexingOrchestrator();
    orchestratorRef = orchestrator;
    webhookHandler = createWebhookHandler(orchestrator);

    // Fire-and-forget startup indexing check
    orchestrator.checkAndIndex().catch((err) => {
        console.error("[startup] Initial index check failed:", err);
    });

    // Start the nightly reindex scheduler
    orchestrator.startNightlyReindex();

    const serverName = serverCfg.server.name;
    app.listen(cfg.port, () => {
        console.log(`[${serverName}] Running at http://localhost:${cfg.port}/mcp`);
        console.log(`[health] http://localhost:${cfg.port}/health`);
    });
}

start().catch((err) => {
    console.error("[startup] Fatal error:", err);
    process.exit(1);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
    console.log(`\n[shutdown] Received ${signal}, shutting down...`);
    try {
        await getPool().end();
    } catch (err) {
        // Only log if the pool was actually initialized
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('DATABASE_URL')) {
            console.error("[shutdown] Error closing pool:", err);
        }
    }
    process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
