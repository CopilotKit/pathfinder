import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EmbeddingClient } from "../../indexing/embeddings.js";
import { searchChunks } from "../../db/queries.js";
import type { ChunkResult } from "../../types.js";
import { getServerConfig } from "../../config.js";

function buildSearchCodeInputSchema() {
    const serverCfg = getServerConfig();
    const repos = [...new Set(serverCfg.sources.map(s => s.repo))] as [string, ...string[]];
    return {
        query: z.string().describe("The search query"),
        repo: z.enum(repos).optional()
            .describe("Specific repository to search in (format: org-name/repo-name). If not specified, searches all repositories."),
        limit: z.number().min(1).max(20).default(10).optional()
            .describe("Maximum number of relevant code chunks to retrieve"),
    };
}

export const searchCodeInputSchema = buildSearchCodeInputSchema();

function formatResults(results: ChunkResult[]): string {
    if (results.length === 0) {
        return "No results found.";
    }

    return results
        .map((result, index) => {
            const snippetNum = index + 1;
            return [
                `SNIPPET ${snippetNum}`,
                `REPOSITORY: ${result.repo_url}`,
                `PATH: ${result.file_path}`,
                `CONTENT:`,
                result.content,
            ].join("\n");
        })
        .join("\n\n---\n\n");
}

export function registerSearchCodeTool(
    server: McpServer,
    embeddingClient: EmbeddingClient,
): void {
    server.tool(
        "search-code",
        "Search the server's indexed codebase to find relevant code snippets and implementations. Use this tool when you need to understand how something is implemented, find code examples, or locate specific functionality in the codebase. This is a semantic search, so prefer performing multiple queries with different phrases instead of a single long query, until you find all the context you need.",
        searchCodeInputSchema,
        async ({ query, repo, limit }) => {
            const effectiveLimit = limit ?? 10;
            const repoUrl: string | undefined = repo;

            try {
                const embedding = await embeddingClient.embed(query);
                const results = await searchChunks(embedding, effectiveLimit, repoUrl);

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
                console.error(`[search-code] Error: ${message}`);

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Error searching code: ${message}`,
                        },
                    ],
                    isError: true,
                };
            }
        },
    );
}
