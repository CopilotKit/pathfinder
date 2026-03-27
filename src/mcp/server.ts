import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EmbeddingClient } from "../indexing/embeddings.js";
import { getConfig, getServerConfig } from "../config.js";
import { registerSearchDocsTool } from "./tools/search-docs.js";
import { registerSearchCodeTool } from "./tools/search-code.js";

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

    registerSearchDocsTool(server, embeddingClient);
    registerSearchCodeTool(server, embeddingClient);

    return server;
}
