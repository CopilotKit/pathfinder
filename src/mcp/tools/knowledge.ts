import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EmbeddingProvider } from "../../indexing/embeddings.js";
import type {
  KnowledgeToolConfig,
  FaqChunkResult,
  ChunkResult,
} from "../../types.js";
import {
  getFaqChunks,
  getFaqChunksByIds,
  searchChunks,
} from "../../db/queries.js";
import { logQuery } from "../../db/analytics.js";
import { getAnalyticsConfig } from "../../config.js";

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
        `ANSWER: ${extractAnswer(r.content, r.source_url || r.file_path)}`,
        `SOURCE: ${r.source_url || r.file_path}`,
        `CONFIDENCE: ${r.confidence.toFixed(2)}`,
      ].join("\n"),
    )
    .join("\n\n");
}

/**
 * Extract the answer portion from Q&A content format "Q: ...\n\nA: ...".
 *
 * Also handles content that begins directly with the answer delimiter
 * ("A: ..." with no preceding Q line / newline). When no delimiter is present
 * at all, falls back to returning the full content (which may include the raw
 * "Q:" text) and emits a `console.warn` so the leak is visible at the default
 * log level (debug is suppressed in production). `chunkId` (a file_path or
 * source_url) is included in the warning so the offending row is locatable.
 */
function extractAnswer(content: string, chunkId?: string): string {
  // Prefer a delimiter on its own line ("...\nA: ..."), but also accept a
  // leading "A:" at the very start of the content (no preceding newline).
  const match = content.match(/(?:^|\n)A:\s*([\s\S]*)/);
  if (match) return match[1].trim();
  // Fallback: no answer delimiter found — return the full blob (leaks the Q:
  // text + delimiters) and warn so we can spot malformed Q&A content.
  console.warn(
    `[knowledge] extractAnswer: no "A:" delimiter found${chunkId ? ` for ${chunkId}` : ""}; returning full content (len=${content.length})`,
  );
  return content;
}

/**
 * Register a knowledge tool on the MCP server.
 * Supports two modes: browse (no query) and search (with query).
 */
export function registerKnowledgeTool(
  server: McpServer,
  embeddingClient: EmbeddingProvider,
  toolConfig: KnowledgeToolConfig,
  options?: {
    onToolCall?: () => void;
    // Per-session accessors resolved at call time — see registerSearchTool for
    // the rationale. getSessionId persists session_id; getRequestSource
    // persists the X-Pathfinder-Source origin tag on each query_log row.
    getSessionId?: () => string | undefined;
    getRequestSource?: () => string | undefined;
  },
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
      options?.onToolCall?.();
      const effectiveLimit = limit ?? toolConfig.default_limit;
      const effectiveConfidence = min_confidence ?? toolConfig.min_confidence;
      const startMs = Date.now();

      try {
        if (!query || query.trim() === "") {
          // Browse mode: return the most-recent N FAQ entries above confidence
          // (effectiveLimit caps the listing — getFaqChunks orders by
          // indexed_at DESC and applies the LIMIT, so this is NOT "all" above
          // confidence when more than `limit` qualify).
          const chunks = await getFaqChunks(
            toolConfig.sources,
            effectiveConfidence,
            effectiveLimit,
          );

          // Fire-and-forget analytics logging
          const analyticsConfig = getAnalyticsConfig();
          logQuery(
            {
              tool_name: toolConfig.name,
              query_text: "<browse>",
              result_count: chunks.length,
              top_score: null,
              latency_ms: Date.now() - startMs,
              source_name: toolConfig.sources.join(","),
              session_id: options?.getSessionId?.() ?? null,
              request_source: options?.getRequestSource?.() ?? null,
            },
            analyticsConfig?.log_queries ?? true,
          ).catch((err) => {
            console.error(
              `[analytics] Failed to log query: ${err instanceof Error ? err.message : String(err)}`,
            );
          });

          return {
            content: [
              { type: "text" as const, text: formatFaqResults(chunks) },
            ],
          };
        } else {
          // Search mode: embed query, search each source, merge, filter by confidence
          const embedding = await embeddingClient.embed(query);

          // Over-fetch candidates per source so the confidence filter has a
          // backfill pool. Fetching only `effectiveLimit` and slicing the top-N
          // BEFORE filtering by confidence dropped below-confidence top-N hits
          // with nothing to replace them, returning fewer than `limit` results
          // even when more-confident hits existed just past the window. Pulling
          // `effectiveLimit * 2` (mirrors candidateLimit = limit*2 in
          // hybridSearchChunks), filtering, THEN slicing to `effectiveLimit`
          // reaches `limit` whenever enough qualifying FAQ entries exist.
          const candidateLimit = effectiveLimit * 2;

          // Search each source independently and merge
          const allResults: ChunkResult[] = [];
          for (const sourceName of toolConfig.sources) {
            const results = await searchChunks(
              embedding,
              candidateLimit,
              sourceName,
            );
            allResults.push(...results);
          }

          // Sort the full candidate pool by similarity descending.
          allResults.sort((a, b) => b.similarity - a.similarity);

          // Fetch FAQ metadata (with confidence) for EXACTLY the candidate ids.
          // Looking up by id (vs an indexed_at-DESC top-N window) keeps every
          // ranked hit so a relevant high-similarity hit is never dropped just
          // because it falls outside a recency window. Skip the round-trip when
          // there are no candidates to look up.
          const faqChunks =
            allResults.length > 0
              ? await getFaqChunksByIds(allResults.map((r) => r.id))
              : [];
          const faqById = new Map(faqChunks.map((c) => [c.id, c]));

          // Merge: keep candidates that have FAQ metadata and meet the
          // confidence threshold (preserving similarity order), THEN slice to
          // `effectiveLimit`. Filtering before the slice is what lets a
          // below-confidence top-N hit be backfilled by a more-confident
          // deeper hit instead of leaving the result set short.
          const qualifying: FaqChunkResult[] = [];
          for (const result of allResults) {
            const faqChunk = faqById.get(result.id);
            if (faqChunk && faqChunk.confidence >= effectiveConfidence) {
              qualifying.push({
                ...faqChunk,
                similarity: result.similarity,
              });
            }
          }
          const mergedResults = qualifying.slice(0, effectiveLimit);

          // Fire-and-forget analytics logging
          const analyticsConfig = getAnalyticsConfig();
          const topScore =
            mergedResults.length > 0
              ? Math.max(...mergedResults.map((r) => r.similarity))
              : null;
          logQuery(
            {
              tool_name: toolConfig.name,
              query_text: query,
              result_count: mergedResults.length,
              top_score: topScore,
              latency_ms: Date.now() - startMs,
              source_name: toolConfig.sources.join(","),
              session_id: options?.getSessionId?.() ?? null,
              request_source: options?.getRequestSource?.() ?? null,
            },
            analyticsConfig?.log_queries ?? true,
          ).catch((err) => {
            console.error(
              `[analytics] Failed to log query: ${err instanceof Error ? err.message : String(err)}`,
            );
          });

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
