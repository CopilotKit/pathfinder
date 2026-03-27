import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EmbeddingClient } from "../../indexing/embeddings.js";
import { searchChunks } from "../../db/queries.js";
import type { ChunkResult } from "../../types.js";

export const searchDocsInputSchema = {
    query: z.string().describe("The search query"),
    limit: z.number().min(1).max(20).default(5).optional()
        .describe("Maximum number of relevant document chunks to retrieve"),
};

function formatResults(results: ChunkResult[]): string {
    if (results.length === 0) {
        return "No results found.";
    }

    return results
        .map((result, index) => {
            const snippetNum = index + 1;
            return [
                `SNIPPET ${snippetNum}`,
                `TITLE: ${result.title}`,
                `SOURCE: ${result.source_url}`,
                `CONTENT:`,
                result.content,
            ].join("\n");
        })
        .join("\n\n---\n\n");
}

export function registerSearchDocsTool(
    server: McpServer,
    embeddingClient: EmbeddingClient,
): void {
    server.tool(
        "search-docs",
        "Search the server's documentation to retrieve relevant information. This is a semantic search, so prefer performing multiple queries with different phrases instead of a single long query, until you find all the context you need.",
        searchDocsInputSchema,
        async ({ query, limit }) => {
            const effectiveLimit = limit ?? 5;

            try {
                const embedding = await embeddingClient.embed(query);
                const results = await searchChunks(embedding, effectiveLimit);

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: formatResults(results),
                        },
                    ],
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.error(`[search-docs] Error: ${message}`);

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Error searching documentation: ${message}`,
                        },
                    ],
                    isError: true,
                };
            }
        },
    );
}
