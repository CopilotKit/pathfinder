import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EmbeddingClient } from '../indexing/embeddings.js';
import { getConfig, getServerConfig } from '../config.js';
import { registerSearchTool } from './tools/search.js';
import { registerCollectTool } from './tools/collect.js';

/**
 * Creates a new McpServer instance with all tools registered.
 * Each call returns a fresh server — suitable for stateless per-request usage.
 */
export function createMcpServer(): McpServer {
    const cfg = getConfig();
    const serverCfg = getServerConfig();

    const embeddingClient = new EmbeddingClient(
        cfg.openaiApiKey,
        serverCfg.embedding.model,
        serverCfg.embedding.dimensions,
    );

    const server = new McpServer({
        name: serverCfg.server.name,
        version: serverCfg.server.version,
    });

    for (const tool of serverCfg.tools) {
        const toolType = tool.type;
        switch (toolType) {
            case 'collect':
                registerCollectTool(server, tool);
                break;
            case 'search':
                registerSearchTool(server, embeddingClient, tool);
                break;
            default: {
                const _exhaustive: never = toolType;
                throw new Error(`Unknown tool type "${_exhaustive}" for tool "${(tool as any).name}"`);
            }
        }
    }

    return server;
}
