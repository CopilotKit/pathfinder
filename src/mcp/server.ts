import type { Bash } from "just-bash";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
): McpServer {
  const cfg = getConfig();
  const serverCfg = getServerConfig();

  // Lazily created — only when a RAG tool needs it
  let embeddingProvider: EmbeddingProvider | null = null;
  function getEmbeddingProvider(): EmbeddingProvider {
    if (!embeddingProvider) {
      if (!serverCfg.embedding) {
        throw new Error("embedding config is required for search tools");
      }
      embeddingProvider = createEmbeddingProvider(
        serverCfg.embedding,
        cfg.openaiApiKey || undefined,
      );
    }
    return embeddingProvider;
  }

  const server = new McpServer({
    name: serverCfg.server.name,
    version: serverCfg.server.version,
  });

  for (const tool of serverCfg.tools) {
    switch (tool.type) {
      case "collect":
        registerCollectTool(server, tool, { onToolCall: hooks?.onToolCall });
        break;
      case "search":
        registerSearchTool(server, getEmbeddingProvider(), tool, {
          onToolCall: hooks?.onToolCall,
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
        });
        break;
      }
      case "knowledge":
        registerKnowledgeTool(server, getEmbeddingProvider(), tool, {
          onToolCall: hooks?.onToolCall,
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
