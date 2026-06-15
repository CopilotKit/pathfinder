import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EmbeddingProvider } from "../../indexing/embeddings.js";
import type { SearchToolConfig, ChunkResult } from "../../types.js";
import {
  searchChunks,
  textSearchChunks,
  hybridSearchChunks,
} from "../../db/queries.js";
import { logQuery } from "../../db/analytics.js";
import { getAnalyticsConfig } from "../../config.js";
import { checkBlocklist } from "../abuse-blocklist.js";
import { oauthLog } from "../../oauth/observability.js";

function formatDocsResults(results: ChunkResult[]): string {
  if (results.length === 0) return "No results found.";
  return results
    .map((r, i) =>
      [
        `SNIPPET ${i + 1}`,
        `TITLE: ${r.title || r.file_path}`,
        `SOURCE: ${r.source_url || r.file_path}`,
        `CONTENT:`,
        r.content,
      ].join("\n"),
    )
    .join("\n\n---\n\n");
}

function formatCodeResults(results: ChunkResult[]): string {
  if (results.length === 0) return "No results found.";
  return results
    .map((r, i) =>
      [
        `SNIPPET ${i + 1}`,
        `REPOSITORY: ${r.repo_url}`,
        `PATH: ${r.file_path}`,
        `CONTENT:`,
        r.content,
      ].join("\n"),
    )
    .join("\n\n---\n\n");
}

function formatRawResults(results: ChunkResult[]): string {
  if (results.length === 0) return "No results found.";
  return results
    .map((r, i) =>
      [
        `SNIPPET ${i + 1}`,
        `SOURCE: ${r.source_url || r.file_path}`,
        `CONTENT:`,
        r.content,
      ].join("\n"),
    )
    .join("\n\n---\n\n");
}

function formatResults(results: ChunkResult[], format: string): string {
  switch (format) {
    case "docs":
      return formatDocsResults(results);
    case "code":
      return formatCodeResults(results);
    default:
      return formatRawResults(results);
  }
}

export function registerSearchTool(
  server: McpServer,
  embeddingClient: EmbeddingProvider,
  toolConfig: SearchToolConfig,
  options?: {
    onToolCall?: () => void;
    // Per-session accessors resolved at call time (the MCP session id isn't
    // known until the transport connects). getSessionId persists a real
    // session_id on each query_log row; getRequestSource persists the
    // X-Pathfinder-Source origin tag. Both optional so older callers/tests
    // keep working — the analytics writer defaults a missing source to 'user'.
    getSessionId?: () => string | undefined;
    getRequestSource?: () => string | undefined;
    // Per-session client IP / User-Agent captured at MCP init. Same pattern
    // as getRequestSource — closed over for the lifetime of the session so
    // every tool call records the attribution from the init request. Both
    // optional; absent values land in query_log as NULL.
    getClientIp?: () => string | undefined;
    getUserAgent?: () => string | undefined;
  },
): void {
  const inputSchema = {
    query: z.string().describe("The search query"),
    limit: z
      .number()
      .min(1)
      .max(toolConfig.max_limit)
      .default(toolConfig.default_limit)
      .optional()
      .describe(
        `Maximum number of results (default: ${toolConfig.default_limit})`,
      ),
    min_score: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        "Minimum similarity score (0-1). Results below this threshold are filtered out.",
      ),
    version: z
      .string()
      .optional()
      .describe("Filter results to a specific documentation version"),
  };

  server.tool(
    toolConfig.name,
    toolConfig.description,
    inputSchema,
    async ({ query, limit, min_score, version }) => {
      options?.onToolCall?.();
      const effectiveLimit = limit ?? toolConfig.default_limit;
      const searchMode = toolConfig.search_mode ?? "vector";
      const startMs = Date.now();

      // Abuse blocklist short-circuit. Runs BEFORE the embedding call so a
      // blocked query never costs an embedding round-trip. The blocked row is
      // still logged (with blocked=true + block_reason) so abuse volume is
      // visible on the analytics surface; the structured response teaches the
      // calling LLM what's actually in scope. See src/mcp/abuse-blocklist.ts.
      const blocked = checkBlocklist(query);
      if (blocked.matched) {
        const logQueries = getAnalyticsConfig()?.log_queries ?? true;
        const sessionClientIp = options?.getClientIp?.();
        logQuery(
          {
            tool_name: toolConfig.name,
            query_text: query,
            result_count: 0,
            top_score: null,
            latency_ms: Date.now() - startMs,
            source_name: toolConfig.source,
            session_id: options?.getSessionId?.() ?? null,
            request_source: options?.getRequestSource?.() ?? null,
            client_ip: sessionClientIp ?? null,
            user_agent: options?.getUserAgent?.() ?? null,
            blocked: true,
            block_reason: blocked.reason ?? null,
          },
          logQueries,
        ).catch((err) => {
          console.error(
            `[analytics] Failed to log blocked query: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
        // Observability hook. `ip` defaults to empty string when unavailable
        // so the log line shape stays stable; `reason` is the pattern tag.
        oauthLog.searchBlocked({
          ip: sessionClientIp ?? "",
          reason: blocked.reason ?? "unknown",
          tool: toolConfig.name,
        });
        // Structured tool response. MCP tools return text content, so the
        // JSON-shaped payload is serialized and emitted as a `text` chunk —
        // the calling LLM still sees the structured fields (`blocked`,
        // `domain`, `hint`) and can act on them. Keeping a TEXT shape avoids
        // depending on MCP content-type extensions that vary across clients.
        const payload = {
          results: [],
          blocked: true,
          domain: "CopilotKit + AG-UI documentation",
          hint: "This query is off-topic for this MCP server's index (CopilotKit, AG-UI, agentic-frameworks documentation only). For general questions outside this domain, use a web search instead of this tool.",
        };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(payload),
            },
          ],
        };
      }

      try {
        let results: ChunkResult[];
        const minScore = min_score ?? toolConfig.min_score;

        switch (searchMode) {
          case "keyword": {
            results = await textSearchChunks(
              query,
              effectiveLimit,
              toolConfig.source,
              version,
            );
            // ts_rank scores are not on the cosine similarity scale,
            // so min_score filtering is not applied in keyword mode.
            break;
          }
          case "hybrid": {
            const embedding = await embeddingClient.embed(query);
            // hybridSearchChunks applies min_score to vector candidates
            // before RRF merge, preserving semantic quality floor.
            results = await hybridSearchChunks(
              embedding,
              query,
              effectiveLimit,
              toolConfig.source,
              version,
              minScore,
            );
            break;
          }
          case "vector":
          default: {
            const embedding = await embeddingClient.embed(query);
            results = await searchChunks(
              embedding,
              effectiveLimit,
              toolConfig.source,
              version,
            );
            if (minScore != null) {
              results = results.filter((r) => r.similarity >= minScore);
            }
            break;
          }
        }

        // Fire-and-forget analytics logging (always captures, regardless of analytics.enabled)
        const logQueries = getAnalyticsConfig()?.log_queries ?? true;
        const latencyMs = Date.now() - startMs;
        const topScore =
          results.length > 0
            ? Math.max(...results.map((r) => r.similarity))
            : null;
        logQuery(
          {
            tool_name: toolConfig.name,
            query_text: query,
            result_count: results.length,
            top_score: topScore,
            latency_ms: latencyMs,
            source_name: toolConfig.source,
            session_id: options?.getSessionId?.() ?? null,
            request_source: options?.getRequestSource?.() ?? null,
            client_ip: options?.getClientIp?.() ?? null,
            user_agent: options?.getUserAgent?.() ?? null,
            blocked: false,
            block_reason: null,
          },
          logQueries,
        ).catch((err) => {
          console.error(
            `[analytics] Failed to log query: ${err instanceof Error ? err.message : String(err)}`,
          );
        });

        return {
          content: [
            {
              type: "text" as const,
              text: formatResults(results, toolConfig.result_format),
            },
          ],
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[${toolConfig.name}] Error: ${detail}`);
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: Search failed. Please try again later.",
            },
          ],
          isError: true,
        };
      }
    },
  );
}
