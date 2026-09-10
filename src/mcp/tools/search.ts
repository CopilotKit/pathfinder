import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EmbeddingProvider } from "../../indexing/embeddings.js";
import type { SearchToolConfig, ChunkResult } from "../../types.js";
import {
  searchChunks,
  textSearchChunks,
  hybridSearchChunks,
  isBelowCosineFloor,
} from "../../db/queries.js";
import { maxCosineScore, topCosineScore } from "../../relevance.js";
import { logQuery } from "../../db/analytics.js";
import { getAnalyticsConfig } from "../../config.js";
import { checkBlocklist } from "../abuse-blocklist.js";
import { formatEmptyResult } from "../empty-result.js";
import { oauthLog } from "../../oauth/observability.js";

function formatDocsResults(results: ChunkResult[], sources: string[]): string {
  if (results.length === 0) return formatEmptyResult(sources);
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

function formatCodeResults(results: ChunkResult[], sources: string[]): string {
  if (results.length === 0) return formatEmptyResult(sources);
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

function formatRawResults(results: ChunkResult[], sources: string[]): string {
  if (results.length === 0) return formatEmptyResult(sources);
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

// `sources` is the tool's configured source list, used ONLY to build the
// empty-result scope hint (see src/mcp/empty-result.ts). Non-empty results
// are formatted exactly as before.
function formatResults(
  results: ChunkResult[],
  format: string,
  sources: string[],
): string {
  switch (format) {
    case "docs":
      return formatDocsResults(results, sources);
    case "code":
      return formatCodeResults(results, sources);
    default:
      return formatRawResults(results, sources);
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
        "Minimum cosine similarity, 0-1. (The cosine scale itself runs -1 to " +
          "1; this floor is capped at 0 because anything at or below 0 is " +
          "already unrelated.) Excludes every result whose measured semantic " +
          "relevance falls below this floor. In hybrid mode a keyword match " +
          "that never appeared among the vector candidates has no measured " +
          "cosine, so it has nothing to compare against and is returned " +
          "ungated. Ignored in keyword mode, which produces no comparable " +
          "score.",
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
        // Best cosine this request MEASURED, captured before `minScore` removes
        // anything. `min_score` is a DELIVERY contract (do not hand the caller a
        // chunk we proved is below the floor); `query_log.top_score` is a
        // MEASUREMENT (how well did the index answer this query). Reducing the
        // score over the post-floor set conflated the two and censored the
        // metric — see maxCosineScore in src/relevance.ts for what that cost.
        //
        // A mutable holder rather than a bare `let`: the hybrid retriever writes
        // it from inside an observer callback, and TypeScript's control-flow
        // narrowing deliberately ignores assignments made in nested functions,
        // so a `let` would still read as `null` at the log site below.
        const measured: { topCosine: number | null } = { topCosine: null };

        switch (searchMode) {
          case "keyword": {
            results = await textSearchChunks(
              query,
              effectiveLimit,
              toolConfig.source,
              version,
            );
            // ts_rank scores are not on the cosine similarity scale, so
            // min_score filtering is not applied in keyword mode — and no
            // cosine is measured anywhere in this request, which is why
            // `measured.topCosine` stays null and the logged score is NULL.
            break;
          }
          case "hybrid": {
            const embedding = await embeddingClient.embed(query);
            // hybridSearchChunks evaluates the cosine floor on the vector
            // candidates and applies the verdict to BOTH lists before the RRF
            // merge, so a condemned chunk cannot re-enter on its keyword rank.
            // The floor is applied in there, so the pre-floor reading has to
            // come back out through the observer — by the time the fused rows
            // arrive here the sub-floor cosines are gone.
            results = await hybridSearchChunks(
              embedding,
              query,
              effectiveLimit,
              toolConfig.source,
              version,
              minScore,
              (topCosine) => {
                measured.topCosine = topCosine;
              },
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
            // Measure BEFORE the floor, for the same reason hybrid mode reports
            // its pre-floor reading: this is the last point at which a sub-floor
            // cosine is still in hand.
            measured.topCosine = topCosineScore(results);
            // Filtering AFTER the DB LIMIT loses no qualifying row, so this mode
            // does not over-fetch the way hybrid and knowledge do (2x
            // candidates). It is NOT the "suffix cut" it used to be described
            // as, though — that stopped being true when a corrupt distance began
            // reading as a NULL cosine instead of 0:
            //
            //   * searchChunks orders by `embedding <=> $1` ASCENDING, and
            //     Postgres sorts a NaN float8 above every finite one, so a
            //     zero-norm indexed row (whose distance is NaN) lands strictly
            //     LAST in the window;
            //   * isBelowCosineFloor never excludes a NULL cosine — unknown
            //     relevance is not bad relevance — so that trailing row SURVIVES
            //     while lower-cosine finite rows ahead of it are cut. The
            //     deletion is therefore mid-array, and the response can come
            //     back shorter than `limit`.
            //
            // What still holds is the part that matters: a NULL-cosine row can
            // only enter the window after every finite row has, so if one is
            // present the whole matching population is already in hand and there
            // is nothing past the LIMIT to over-fetch. And when the window stops
            // short of the NULL-cosine rows it IS a pure descending-cosine
            // prefix, so the next row out ranks below one already rejected and
            // could not clear the floor either. Pinned in
            // src/__tests__/min-score-logging.test.ts against real pgvector.
            if (minScore != null) {
              results = results.filter((r) => !isBelowCosineFloor(r, minScore));
            }
            break;
          }
        }

        // Fire-and-forget analytics logging (always captures, regardless of analytics.enabled)
        const logQueries = getAnalyticsConfig()?.log_queries ?? true;
        const latencyMs = Date.now() - startMs;
        // Persist the best COSINE similarity, never `similarity`. In hybrid
        // mode `similarity` has been overwritten with the RRF fusion score
        // (ceiling ≈ 0.033) and in keyword mode it is a ts_rank — neither is
        // comparable to the cosine scale the low-confidence threshold and
        // the dashboard's Avg Cosine column are defined on. Keyword mode
        // therefore logs NULL here, which analytics reads as "no score", not
        // "a low score". See topCosineScore.
        //
        // The pre-floor measurement is combined with the cosine still on the
        // returned rows rather than replacing it: the two agree in production
        // (survivors are a subset of what was measured), and the returned-row
        // term keeps a retriever that reports no measurement from degrading the
        // score to NULL. NULL is thereby reserved for its one honest meaning —
        // no cosine was computed anywhere in this request — instead of also
        // covering "every candidate we measured fell below the caller's floor".
        // See maxCosineScore.
        const topScore = maxCosineScore(
          measured.topCosine,
          topCosineScore(results),
        );
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
              text: formatResults(results, toolConfig.result_format, [
                toolConfig.source,
              ]),
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
