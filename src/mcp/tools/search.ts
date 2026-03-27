import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EmbeddingClient } from '../../indexing/embeddings.js';
import type { ToolConfig, ChunkResult } from '../../types.js';
import { searchChunks } from '../../db/queries.js';

function formatDocsResults(results: ChunkResult[]): string {
    if (results.length === 0) return "No results found.";
    return results.map((r, i) => [
        `SNIPPET ${i + 1}`,
        `TITLE: ${r.title || r.file_path}`,
        `SOURCE: ${r.source_url || r.file_path}`,
        `CONTENT:`,
        r.content,
    ].join('\n')).join('\n\n---\n\n');
}

function formatCodeResults(results: ChunkResult[]): string {
    if (results.length === 0) return "No results found.";
    return results.map((r, i) => [
        `SNIPPET ${i + 1}`,
        `REPOSITORY: ${r.repo_url}`,
        `PATH: ${r.file_path}`,
        `CONTENT:`,
        r.content,
    ].join('\n')).join('\n\n---\n\n');
}

function formatRawResults(results: ChunkResult[]): string {
    if (results.length === 0) return "No results found.";
    return results.map((r, i) => [
        `SNIPPET ${i + 1}`,
        `SOURCE: ${r.source_url || r.file_path}`,
        `CONTENT:`,
        r.content,
    ].join('\n')).join('\n\n---\n\n');
}

function formatResults(results: ChunkResult[], format: string): string {
    switch (format) {
        case 'docs': return formatDocsResults(results);
        case 'code': return formatCodeResults(results);
        default: return formatRawResults(results);
    }
}

export function registerSearchTool(
    server: McpServer,
    embeddingClient: EmbeddingClient,
    toolConfig: ToolConfig,
): void {
    const inputSchema = {
        query: z.string().describe("The search query"),
        limit: z.number().min(1).max(toolConfig.max_limit)
            .default(toolConfig.default_limit).optional()
            .describe(`Maximum number of results (default: ${toolConfig.default_limit})`),
    };

    server.tool(
        toolConfig.name,
        toolConfig.description,
        inputSchema,
        async ({ query, limit }) => {
            const effectiveLimit = limit ?? toolConfig.default_limit;
            try {
                const embedding = await embeddingClient.embed(query);
                const results = await searchChunks(embedding, effectiveLimit, toolConfig.source);
                return {
                    content: [{ type: "text" as const, text: formatResults(results, toolConfig.result_format) }],
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.error(`[${toolConfig.name}] Error: ${message}`);
                return {
                    content: [{ type: "text" as const, text: `Error: ${message}` }],
                    isError: true,
                };
            }
        },
    );
}
