import type { Bash } from 'just-bash';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EmbeddingClient } from '../indexing/embeddings.js';
import { getConfig, getServerConfig } from '../config.js';
import { registerSearchTool } from './tools/search.js';
import { registerCollectTool } from './tools/collect.js';
import { registerBashTool } from './tools/bash.js';
import { SessionStateManager } from './tools/bash-session.js';

/**
 * Creates a new McpServer instance with all tools registered.
 * Each MCP session gets its own server instance. Bash tools share
 * a common filesystem but get per-session CWD tracking when enabled.
 */
export function createMcpServer(
    bashInstances?: Map<string, Bash>,
    sessionStateManager?: SessionStateManager,
    getSessionId?: () => string | undefined,
): McpServer {
    const cfg = getConfig();
    const serverCfg = getServerConfig();

    // Lazily created — only when a RAG tool needs it
    let embeddingClient: EmbeddingClient | null = null;
    function getEmbeddingClient(): EmbeddingClient {
        if (!embeddingClient) {
            if (!serverCfg.embedding) {
                throw new Error('embedding config is required for search tools');
            }
            embeddingClient = new EmbeddingClient(
                cfg.openaiApiKey,
                serverCfg.embedding.model,
                serverCfg.embedding.dimensions,
            );
        }
        return embeddingClient;
    }

    const server = new McpServer({
        name: serverCfg.server.name,
        version: serverCfg.server.version,
    });

    for (const tool of serverCfg.tools) {
        switch (tool.type) {
            case 'collect':
                registerCollectTool(server, tool);
                break;
            case 'search':
                registerSearchTool(server, getEmbeddingClient(), tool);
                break;
            case 'bash': {
                const bash = bashInstances?.get(tool.name);
                if (!bash) {
                    throw new Error(`Bash tool "${tool.name}" is configured but no Bash instance was created.`);
                }
                const getSessionState = (sessionStateManager && getSessionId)
                    ? () => {
                        const sid = getSessionId();
                        return sid ? sessionStateManager.getOrCreate(sid) : undefined;
                    }
                    : undefined;
                const grepStrategy = tool.bash?.grep_strategy;
                const needsEmbedding = grepStrategy === 'vector' || grepStrategy === 'hybrid';
                const searchToolNames = serverCfg.tools.filter(t => t.type === 'search').map(t => t.name);
                registerBashTool(server, tool, bash, {
                    getSessionState,
                    embeddingClient: needsEmbedding ? getEmbeddingClient() : undefined,
                    searchToolNames,
                });
                break;
            }
            default: {
                const _exhaustive: never = tool;
                throw new Error(`Unknown tool type: ${(_exhaustive as { type: string }).type}`);
            }
        }
    }

    return server;
}
