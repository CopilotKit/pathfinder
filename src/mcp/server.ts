import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EmbeddingClient } from "../indexing/embeddings.js";
import { getConfig } from "../config.js";
import { registerSearchDocsTool } from "./tools/search-docs.js";
import { registerSearchCodeTool } from "./tools/search-code.js";

/**
 * Creates a new McpServer instance with all tools registered.
 * Each call returns a fresh server — suitable for stateless per-request usage.
 */
export function createMcpServer(): McpServer {
    const cfg = getConfig();
    const embeddingClient = new EmbeddingClient(
        cfg.openaiApiKey,
        cfg.embeddingModel,
        cfg.embeddingDimensions,
    );

    const server = new McpServer({
        name: "copilotkit-docs-mcp",
        version: "1.0.0",
    });

    registerSearchDocsTool(server, embeddingClient);
    registerSearchCodeTool(server, embeddingClient);

    return server;
}
