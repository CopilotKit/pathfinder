import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EmbeddingClient } from "../../indexing/embeddings.js";
import type {
  KnowledgeToolConfig,
  FaqChunkResult,
  ChunkResult,
} from "../../types.js";
import { getFaqChunks, searchChunks } from "../../db/queries.js";

/**
 * Format FAQ results in the standard QUESTION/ANSWER/SOURCE/CONFIDENCE format.
 */
export function formatFaqResults(results: FaqChunkResult[]): string {
  if (results.length === 0) return "No FAQ results found.";

  return results
    .map((r, i) =>
      [
        `Q&A ${i + 1}`,
        `QUESTION: ${r.title || "(untitled)"}`,
        `ANSWER: ${extractAnswer(r.content)}`,
        `SOURCE: ${r.source_url || r.file_path}`,
        `CONFIDENCE: ${r.confidence.toFixed(2)}`,
      ].join("\n"),
    )
    .join("\n\n");
}

/**
 * Extract the answer portion from Q&A content format "Q: ...\n\nA: ..."
 */
function extractAnswer(content: string): string {
  const match = content.match(/\nA:\s*([\s\S]*)/);
  if (match) return match[1].trim();
  // Fallback: return full content
  return content;
}

/**
 * Register a knowledge tool on the MCP server.
 * Supports two modes: browse (no query) and search (with query).
 */
export function registerKnowledgeTool(
  server: McpServer,
  embeddingClient: EmbeddingClient,
  toolConfig: KnowledgeToolConfig,
): void {
  const inputSchema = {
    query: z
      .string()
      .optional()
      .describe("Search query. Omit for full FAQ listing."),
    limit: z
      .number()
      .min(1)
      .max(toolConfig.max_limit)
      .optional()
      .describe(
        `Maximum results to return (default: ${toolConfig.default_limit})`,
      ),
    min_confidence: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        `Override minimum confidence threshold (default: ${toolConfig.min_confidence})`,
      ),
  };

  server.tool(
    toolConfig.name,
    toolConfig.description,
    inputSchema,
    async ({ query, limit, min_confidence }) => {
      const effectiveLimit = limit ?? toolConfig.default_limit;
      const effectiveConfidence = min_confidence ?? toolConfig.min_confidence;

      try {
        if (!query || query.trim() === "") {
          // Browse mode: return all FAQ entries above confidence
          const chunks = await getFaqChunks(
            toolConfig.sources,
            effectiveConfidence,
            effectiveLimit,
          );
          return {
            content: [
              { type: "text" as const, text: formatFaqResults(chunks) },
            ],
          };
        } else {
          // Search mode: embed query, search each source, merge, filter by confidence
          const embedding = await embeddingClient.embed(query);

          // Search each source independently and merge
          const allResults: ChunkResult[] = [];
          for (const sourceName of toolConfig.sources) {
            const results = await searchChunks(
              embedding,
              effectiveLimit,
              sourceName,
            );
            allResults.push(...results);
          }

          // Sort by similarity descending, take top N
          allResults.sort((a, b) => b.similarity - a.similarity);
          const topResults = allResults.slice(0, effectiveLimit);

          // Now get FAQ chunks (with confidence) for the same sources to cross-reference
          // Use a very low confidence threshold (0) to get all, then filter
          const faqChunks = await getFaqChunks(
            toolConfig.sources,
            0,
            effectiveLimit * 5,
          );
          const faqById = new Map(faqChunks.map((c) => [c.id, c]));

          // Merge: keep search results that have FAQ metadata and meet confidence threshold
          const mergedResults: FaqChunkResult[] = [];
          for (const result of topResults) {
            const faqChunk = faqById.get(result.id);
            if (faqChunk && faqChunk.confidence >= effectiveConfidence) {
              mergedResults.push({
                ...faqChunk,
                similarity: result.similarity,
              });
            }
          }

          return {
            content: [
              { type: "text" as const, text: formatFaqResults(mergedResults) },
            ],
          };
        }
      } catch (error) {
        console.error(`[${toolConfig.name}] Knowledge query failed:`, error);
        const detail = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: "text" as const, text: `Error querying FAQ: ${detail}` },
          ],
          isError: true,
        };
      }
    },
  );
}
