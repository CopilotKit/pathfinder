import type { Bash } from "just-bash";
import { McpServer } from "@modelcontextprotocol/server";
import { createEmbeddingProvider } from "../indexing/embeddings.js";
import type { EmbeddingProvider } from "../indexing/embeddings.js";
import { getConfig, getServerConfig } from "../config.js";
import { registerSearchTool } from "./tools/search.js";
import { registerCollectTool } from "./tools/collect.js";
import { registerKnowledgeTool } from "./tools/knowledge.js";
import { registerBashTool } from "./tools/bash.js";
import { SessionStateManager } from "./tools/bash-session.js";
import type { BashTelemetry } from "./tools/bash-telemetry.js";
import type { WorkspaceManager } from "../workspace.js";
import type { SessionAnalyticsContext } from "../request-context.js";
import type { EmbeddingConfig } from "../types.js";

// One embedding provider per process, shared by every McpServer instance.
// Lazily created — only when a RAG tool needs it. Memoised by the `embedding`
// config object (identity) and the OpenAI key, so a config reload, which
// yields a new object, gets a new provider.
let sharedEmbedding: {
  embedding: EmbeddingConfig;
  openaiApiKey: string | undefined;
  provider: EmbeddingProvider;
} | null = null;

function getSharedEmbeddingProvider(
  embedding: EmbeddingConfig | undefined,
  openaiApiKey: string | undefined,
): EmbeddingProvider {
  if (!embedding) {
    throw new Error("embedding config is required for search tools");
  }
  if (
    sharedEmbedding?.embedding !== embedding ||
    sharedEmbedding.openaiApiKey !== openaiApiKey
  ) {
    sharedEmbedding = {
      embedding,
      openaiApiKey,
      provider: createEmbeddingProvider(embedding, openaiApiKey),
    };
  }
  return sharedEmbedding.provider;
}

/**
 * Creates a new McpServer instance with all tools registered.
 * Each MCP session gets its own server instance. Each bash tool gets its own
 * virtual filesystem instance, shared across all MCP sessions for that tool.
 */
export function createMcpServer(
  bashInstances?: Map<string, Bash>,
  sessionStateManager?: SessionStateManager,
  getSessionId?: () => string | undefined,
  telemetry?: BashTelemetry,
  workspace?: WorkspaceManager,
  hooks?: { onToolCall?: () => void },
  // Accessor for the per-session request-origin tag (user|synthetic|analysis)
  // captured from the X-Pathfinder-Source header on the MCP init request.
  // Threaded into the RAG tool handlers so each query_log row records who
  // originated the traffic. Optional so existing callers/tests keep compiling;
  // when absent the writer defaults the column to 'user'.
  getRequestSource?: () => string | undefined,
  // Per-session client IP / User-Agent accessors captured at MCP init.
  // Threaded the same way as getRequestSource so each query_log row carries
  // IP + UA without a session-id join against an external system. Both
  // optional; absent values persist as NULL in the new columns.
  getClientIp?: () => string | undefined,
  getUserAgent?: () => string | undefined,
  // Per-session analytics context (see SessionAnalyticsContext), read on
  // every logged tool call. Threaded the same way as the accessors above into
  // the search and knowledge handlers so each query_log row carries it.
  // Optional; absent values persist as NULL.
  getAnalyticsContext?: () => SessionAnalyticsContext | undefined,
  // Protocol era of the connection this server serves. "modern" (2026-07-28,
  // stateless) adds the tools/list cache hints and builds bash tools with
  // `era: "modern"`. Absent or "legacy" builds the server exactly as before.
  // trackWork, when given, receives the promise of every tool call this
  // server runs (see ModernServerContext.trackWork). signal, when given, is
  // the request's deadline signal (ModernServerContext.signal); bash tools
  // pass it to exec. Legacy callers omit both.
  opts?: {
    era?: "legacy" | "modern";
    trackWork?: (work: Promise<unknown>) => void;
    signal?: AbortSignal;
  },
): McpServer {
  const cfg = getConfig();
  const serverCfg = getServerConfig();

  const getEmbeddingProvider = (): EmbeddingProvider =>
    getSharedEmbeddingProvider(
      serverCfg.embedding,
      cfg.openaiApiKey || undefined,
    );

  const modern = opts?.era === "modern";
  const info = {
    name: serverCfg.server.name,
    version: serverCfg.server.version,
  };
  const server = modern
    ? new McpServer(info, {
        cacheHints: { "tools/list": { cacheScope: "public", ttlMs: 3600000 } },
      })
    : new McpServer(info);

  const trackWork = opts?.trackWork;
  if (trackWork) {
    // Report each tool callback's result to trackWork. Every tool below is
    // registered through server.registerTool, so wrapping it on this one
    // instance covers them all without changing the register functions.
    const registerTool: unknown = server.registerTool;
    if (typeof registerTool !== "function") {
      throw new Error("McpServer.registerTool is not a function");
    }
    Reflect.set(server, "registerTool", (...args: unknown[]): unknown => {
      const cb = args[2];
      if (typeof cb === "function") {
        args[2] = (...cbArgs: unknown[]): Promise<unknown> => {
          const work = Promise.resolve().then(() =>
            Reflect.apply(cb, undefined, cbArgs),
          );
          trackWork(work);
          return work;
        };
      }
      return Reflect.apply(registerTool, server, args);
    });
  }

  for (const tool of serverCfg.tools) {
    switch (tool.type) {
      case "collect":
        registerCollectTool(server, tool, { onToolCall: hooks?.onToolCall });
        break;
      case "search":
        registerSearchTool(server, getEmbeddingProvider(), tool, {
          onToolCall: hooks?.onToolCall,
          getSessionId,
          getRequestSource,
          getClientIp,
          getUserAgent,
          getAnalyticsContext,
        });
        break;
      case "bash": {
        const bash = bashInstances?.get(tool.name);
        if (!bash) {
          throw new Error(
            `Bash tool "${tool.name}" is configured but no Bash instance was created.`,
          );
        }
        const getSessionState =
          sessionStateManager && getSessionId
            ? () => {
                const sid = getSessionId();
                return sid ? sessionStateManager.getOrCreate(sid) : undefined;
              }
            : undefined;
        const grepStrategy = tool.bash?.grep_strategy;
        const needsEmbedding =
          grepStrategy === "vector" || grepStrategy === "hybrid";
        const searchToolNames = serverCfg.tools
          .filter((t) => t.type === "search")
          .map((t) => t.name);
        const needsWorkspace = tool.bash?.workspace === true;
        registerBashTool(server, tool, bash, {
          getSessionState,
          embeddingClient: needsEmbedding ? getEmbeddingProvider() : undefined,
          searchToolNames,
          telemetry,
          workspace: needsWorkspace ? workspace : undefined,
          getSessionId: needsWorkspace ? getSessionId : undefined,
          onToolCall: hooks?.onToolCall,
          ...(modern ? { era: "modern" as const } : {}),
          ...(opts?.signal ? { signal: opts.signal } : {}),
        });
        break;
      }
      case "knowledge":
        registerKnowledgeTool(server, getEmbeddingProvider(), tool, {
          onToolCall: hooks?.onToolCall,
          getSessionId,
          getRequestSource,
          getClientIp,
          getUserAgent,
          getAnalyticsContext,
        });
        break;
      default: {
        const _exhaustive: never = tool;
        throw new Error(
          `Unknown tool type: ${(_exhaustive as { type: string }).type}`,
        );
      }
    }
  }

  return server;
}
