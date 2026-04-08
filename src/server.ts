import express, { Request, Response } from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { Bash } from "just-bash";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./mcp/server.js";
import { buildBashFilesMap, rebuildBashInstance } from "./mcp/tools/bash-fs.js";
import { initializeSchema, closePool } from "./db/client.js";
import { getIndexStats, getAllChunksForLlms, getFaqChunks } from "./db/queries.js";
import { getConfig, getServerConfig, hasSearchTools, hasKnowledgeTools, hasCollectTools, hasBashSemanticSearch } from "./config.js";
import type { SlackSourceConfig } from "./types.js";
import { IndexingOrchestrator } from "./indexing/orchestrator.js";

import { createWebhookHandler } from "./webhooks/github.js";
import { createSlackWebhookHandler } from "./webhooks/slack.js";
import { SessionStateManager } from "./mcp/tools/bash-session.js";
import { BashTelemetry } from "./mcp/tools/bash-telemetry.js";
import { insertCollectedData } from "./db/queries.js";
import { IpSessionLimiter } from "./ip-limiter.js";
import { WorkspaceManager } from "./workspace.js";
import { generateLlmsTxt, generateLlmsFullTxt } from "./llms-txt.js";
import { generateFaqTxt } from "./faq-txt.js";
import { generateSkillMd } from "./skill-md.js";

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
    res.setHeader('Link', '</llms.txt>; rel="llms-txt", </faq.txt>; rel="faq"');
    next();
});

// ---------------------------------------------------------------------------
// Webhook endpoint — registered BEFORE express.json() so the handler receives
// a raw Buffer for HMAC signature verification.
//
// The handler is wired to the real orchestrator during start().  Until then,
// requests receive 503 (server still initializing).
// ---------------------------------------------------------------------------

let webhookHandler: ((req: Request, res: Response) => Promise<void>) | null = null;
let slackWebhookHandler: ((req: Request, res: Response) => Promise<void>) | null = null;
let orchestratorRef: IndexingOrchestrator | null = null;
const startedAt = new Date();
const bashInstances = new Map<string, Bash>();
const sessionStateManager = new SessionStateManager();
let bashTelemetry: BashTelemetry | undefined;
let telemetryFlushInterval: ReturnType<typeof setInterval> | undefined;

async function refreshBashInstances(sourceNames: string[], logPrefix = "webhook"): Promise<void> {
    const serverCfg = getServerConfig();
    const bashTools = serverCfg.tools.filter(t => t.type === 'bash');
    const searchToolNames = serverCfg.tools.filter(t => t.type === 'search').map(t => t.name);

    for (const tool of bashTools) {
        const affected = tool.sources.some(s => sourceNames.includes(s));
        if (!affected) continue;

        const toolSources = serverCfg.sources.filter(s => tool.sources.includes(s.name));
        const virtualFiles = tool.bash?.virtual_files === true;
        const { bash, fileCount } = await rebuildBashInstance(toolSources, {
            virtualFiles,
            searchToolNames: virtualFiles ? searchToolNames : undefined,
            cloneDir: getConfig().cloneDir,
        });
        bashInstances.set(tool.name, bash);
        console.log(`[${logPrefix}] Refreshed bash tool "${tool.name}": ${fileCount} files`);
    }
}

app.post("/webhooks/github", express.raw({ type: "application/json" }), async (req: Request, res: Response) => {
    const handler = webhookHandler;
    if (!handler) {
        res.status(503).json({ error: "Server still initializing" });
        return;
    }
    try {
        await handler(req, res);
        // Schedule bash refresh after reindexing. The orchestrator runs async,
        // so we use a delay heuristic — TODO: replace with event-based notification.
        const serverCfg = getServerConfig();
        const bashTools = serverCfg.tools.filter(t => t.type === 'bash');
        if (bashTools.length > 0) {
            const REFRESH_DELAY_MS = 30_000;
            setTimeout(() => {
                refreshBashInstances(
                    serverCfg.sources.map(s => s.name),
                ).catch(err => console.error('[webhook] Bash refresh failed:', err));
            }, REFRESH_DELAY_MS);
        }
    } catch (err) {
        console.error("[webhook] Handler error:", err);
        if (!res.headersSent) {
            res.status(500).json({ error: "Internal webhook handler error" });
        }
    }
});

// Slack webhook endpoint — also before express.json() for raw body signature verification
app.post("/webhooks/slack", express.raw({ type: "application/json" }), async (req: Request, res: Response) => {
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
});

// JSON parser for all other routes
app.use(express.json());

// ---------------------------------------------------------------------------
// OAuth discovery stubs — tell MCP clients that no auth is required.
// Newer Claude Code versions probe these before connecting.
// ---------------------------------------------------------------------------

// Return resource metadata with no authorization servers — signals "no auth required"
// per RFC 9728. Newer Claude Code versions probe this before connecting.
app.get("/.well-known/oauth-protected-resource", (req: Request, res: Response) => {
    const host = req.headers.host || `localhost:${getConfig().port}`;
    const proto = req.headers["x-forwarded-proto"] || "http";
    res.json({
        resource: `${proto}://${host}`,
    });
});

app.get("/.well-known/oauth-authorization-server", (_req: Request, res: Response) => {
    res.status(404).json({ error: "No authorization server — this resource does not require authentication" });
});

app.post("/register", (_req: Request, res: Response) => {
    res.status(404).json({ error: "No authorization server — this resource does not require authentication" });
});

// ---------------------------------------------------------------------------
// MCP endpoint — session-based (initialize once, then tool calls reuse session)
// ---------------------------------------------------------------------------

const transports: Record<string, StreamableHTTPServerTransport> = {};
const sessionLastActivity: Record<string, number> = {};
let SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes default, overridden by config
let ipLimiter: IpSessionLimiter | undefined;
let workspaceManager: WorkspaceManager | undefined;

// Reap idle sessions every 5 minutes
setInterval(() => {
    const now = Date.now();
    let reaped = 0;
    for (const sid of Object.keys(sessionLastActivity)) {
        if (now - sessionLastActivity[sid] > SESSION_TTL_MS) {
            delete transports[sid];
            delete sessionLastActivity[sid];
            try { sessionStateManager.cleanup(sid); } catch (e) { console.error(`[mcp] Session state cleanup failed for ${sid.slice(0, 8)}:`, e); }
            try { ipLimiter?.remove(sid); } catch (e) { console.error(`[mcp] IP limiter cleanup failed:`, e); }
            try { workspaceManager?.cleanup(sid); } catch (e) { console.error(`[mcp] Workspace cleanup failed for ${sid.slice(0, 8)}:`, e); }
            reaped++;
        }
    }
    if (reaped > 0) {
        console.log(`[mcp] Reaped ${reaped} idle sessions (${Object.keys(transports).length} active)`);
    }
}, 5 * 60 * 1000);

function clientIp(req: Request): string {
    return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
        || req.socket.remoteAddress
        || "unknown";
}

app.post("/mcp", async (req: Request, res: Response) => {
    try {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        const ip = clientIp(req);

        // Existing session — route to its transport
        if (sessionId && transports[sessionId]) {
            sessionLastActivity[sessionId] = Date.now();
            const method = req.body?.method as string | undefined;
            if (method === 'tools/call') {
                const params = req.body?.params as Record<string, unknown> | undefined;
                const toolName = params?.name ?? 'unknown';
                const args = params?.arguments as Record<string, unknown> | undefined;
                const toolCfg = getServerConfig().tools.find(t => t.name === toolName);
                if (toolCfg?.type === 'collect') {
                    try {
                        const dataPreview = JSON.stringify(args ?? {}).slice(0, 200);
                        console.log(`[mcp] ${toolName}(${dataPreview}) [${ip}]`);
                    } catch {
                        console.log(`[mcp] ${toolName}(<unserializable>) [${ip}]`);
                    }
                } else if (toolCfg?.type === 'bash') {
                    const cmd = args?.command ?? '';
                    console.log(`[mcp] ${toolName}(${JSON.stringify(cmd).slice(0, 200)}) [${ip}]`);
                } else {
                    const query = args?.query ?? '';
                    const limit = args?.limit;
                    const extra = limit ? ` limit=${limit}` : '';
                    console.log(`[mcp] ${toolName}("${query}"${extra}) [${ip}]`);
                }
            } else if (method === 'tools/list') {
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
                        console.warn(`[mcp] IP rate limit exceeded for ${ip}, closing session ${sid.slice(0, 8)}`);
                        delete transports[sid];
                        delete sessionLastActivity[sid];
                        transport.close?.();
                        return;
                    }
                    workspaceManager?.ensureSession(sid);
                    console.log(`[mcp] New session ${sid.slice(0, 8)} (${Object.keys(transports).length} active) [${ip}]`);
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
                    console.log(`[mcp] Session ${sid.slice(0, 8)} closed (${Object.keys(transports).length} active)`);
                }
            };
            const server = createMcpServer(bashInstances, sessionStateManager, () => transport.sessionId ?? undefined, bashTelemetry, workspaceManager);
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
    const uptime = Math.floor((Date.now() - startedAt.getTime()) / 1000);
    const needsDb = hasSearchTools() || hasKnowledgeTools() || hasCollectTools() || hasBashSemanticSearch();

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

app.get('/llms.txt', async (_req: Request, res: Response) => {
    try {
        if (!cachedLlmsTxt) {
            const chunks = await getAllChunksForLlms();
            cachedLlmsTxt = generateLlmsTxt(chunks, getServerConfig().server.name);
        }
        res.type('text/plain').send(cachedLlmsTxt);
    } catch (err) {
        console.error("[llms.txt] Generation failed:", err);
        res.status(503).type('text/plain').send('# Service unavailable\nIndex not ready.');
    }
});

app.get('/llms-full.txt', async (_req: Request, res: Response) => {
    try {
        if (!cachedLlmsFullTxt) {
            const chunks = await getAllChunksForLlms();
            cachedLlmsFullTxt = generateLlmsFullTxt(chunks);
        }
        res.type('text/plain').send(cachedLlmsFullTxt);
    } catch (err) {
        console.error("[llms-full.txt] Generation failed:", err);
        res.status(503).type('text/plain').send('Service unavailable — index not ready.');
    }
});

app.get('/faq.txt', async (_req: Request, res: Response) => {
    try {
        if (!cachedFaqTxt) {
            const serverCfg = getServerConfig();
            // Find FAQ sources: sources with category === 'faq'
            const faqSources = serverCfg.sources
                .filter(s => ('category' in s) && s.category === 'faq')
                .map(s => ({
                    name: s.name,
                    confidenceThreshold: s.type === 'slack' ? (s as SlackSourceConfig).confidence_threshold : 0.7,
                }));

            if (faqSources.length === 0) {
                cachedFaqTxt = generateFaqTxt([], serverCfg.server.name, []);
            } else {
                // Fetch FAQ chunks per source with its confidence threshold
                const allChunks = [];
                for (const src of faqSources) {
                    try {
                        const chunks = await getFaqChunks([src.name], src.confidenceThreshold);
                        allChunks.push(...chunks);
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        console.error(`[faq.txt] Failed to fetch chunks for source "${src.name}": ${msg}`);
                    }
                }
                cachedFaqTxt = generateFaqTxt(allChunks, serverCfg.server.name, faqSources);
            }
        }
        res.type('text/plain').send(cachedFaqTxt);
    } catch (err) {
        console.error("[faq.txt] Generation failed:", err);
        res.status(503).type('text/plain').send('# Service unavailable\nFAQ index not ready.');
    }
});

// ---------------------------------------------------------------------------
// skill.md — dynamically generated from server config
// ---------------------------------------------------------------------------

app.get('/.well-known/skills/default/skill.md', (_req: Request, res: Response) => {
    try {
        res.type('text/markdown').send(generateSkillMd(getServerConfig()));
    } catch (err) {
        console.error('[skill.md] Generation failed:', err);
        res.status(500).type('text/plain').send('Error generating skill.md');
    }
});

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
    console.log(`[startup] IP rate limit: ${maxSessionsPerIp} sessions/IP, TTL: ${serverCfg.server.session_ttl_minutes ?? 30}m`);

    // Initialize workspace manager if any bash tool has workspace enabled
    const hasBashWorkspace = serverCfg.tools.some(t => t.type === 'bash' && t.bash?.workspace === true);
    const workspaceDir = process.env.WORKSPACE_DIR ?? '/tmp/pathfinder-workspaces';
    if (hasBashWorkspace) {
        workspaceManager = new WorkspaceManager(workspaceDir);
        console.log(`[startup] Workspace manager enabled (dir: ${workspaceDir})`);
    }

    const needsDb = hasSearchTools() || hasKnowledgeTools() || hasCollectTools() || hasBashSemanticSearch();

    if (needsDb) {
        console.log("[startup] Initializing database schema...");
        await initializeSchema();
        console.log("[startup] Database schema ready.");

        // Set up bash telemetry with periodic flush
        bashTelemetry = new BashTelemetry(insertCollectedData);
        telemetryFlushInterval = setInterval(() => {
            bashTelemetry?.flush().catch(err =>
                console.error('[telemetry] Periodic flush failed:', err instanceof Error ? err.message : String(err)),
            );
        }, 60_000);
        console.log("[startup] Bash telemetry enabled (60s flush interval).");
    }

    // Log active sources from config
    const sourceNames = serverCfg.sources.map(s => `${s.name} (${s.type})`);
    console.log(`[startup] Active sources: ${sourceNames.join(', ')}`);

    // Build shared Bash instances for bash tools. The filesystem is shared;
    // per-session CWD tracking is handled at the tool registration layer.
    const bashTools = serverCfg.tools.filter(t => t.type === 'bash');
    const searchToolNames = serverCfg.tools.filter(t => t.type === 'search').map(t => t.name);
    for (const tool of bashTools) {
        const toolSources = serverCfg.sources.filter(s => tool.sources.includes(s.name));
        const virtualFiles = tool.bash?.virtual_files === true;
        const filesMap = await buildBashFilesMap(toolSources, {
            virtualFiles,
            searchToolNames: virtualFiles ? searchToolNames : undefined,
            cloneDir: cfg.cloneDir,
        });
        bashInstances.set(tool.name, new Bash({ files: filesMap, cwd: '/' }));
        console.log(`[startup] Bash tool "${tool.name}": ${Object.keys(filesMap).length} files loaded`);
    }

    // Indexing and webhooks only needed when search tools are configured
    if (hasSearchTools() || hasKnowledgeTools()) {
        const orchestrator = new IndexingOrchestrator();
        orchestratorRef = orchestrator;
        webhookHandler = createWebhookHandler(orchestrator);

        // Wire up Slack webhook if any slack sources are configured
        const hasSlackSources = serverCfg.sources.some(s => s.type === 'slack');
        if (hasSlackSources) {
            slackWebhookHandler = createSlackWebhookHandler(orchestrator);
            console.log('[startup] Slack webhook handler enabled');
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

        orchestrator.checkAndIndex().catch((err) => {
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
            console.error(`[startup] Port ${port} is already in use. Set PORT env var to use a different port.`);
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
        if (telemetryFlushInterval) clearInterval(telemetryFlushInterval);
        try { await bashTelemetry?.flush(); } catch (e) { console.error('[shutdown] Telemetry flush failed:', e); }
        try { workspaceManager?.cleanupAll(); } catch (e) { console.error('[shutdown] Workspace cleanup failed:', e); }
        try { await closePool(); } catch (e) { console.error('[shutdown] DB pool close failed:', e); }
        process.exit(0);
    }

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
}
