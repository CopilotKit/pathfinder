/**
 * Empty-result scope hint.
 *
 * An empty result used to be the bare string "No results found." — which
 * teaches the caller nothing. Two distinct audiences receive it:
 *
 *  1. Off-topic callers. Production analytics traced the off-topic volume on
 *     mcp.copilotkit.ai to a single misconfigured agent that has this server
 *     registered as a general-purpose search tool. It is teachable, not
 *     evasive: telling it what this tool actually indexes is the cheap fix.
 *  2. Real users hitting a genuine documentation gap — the MAJORITY of the
 *     empty-result population. They deserve something actionable too.
 *
 * The hint is therefore UNCONDITIONAL on empty: no classification, no
 * scoring, no branching on query content. That is the whole point — a
 * classifier would need a threshold, and measured score distributions show
 * no threshold separates the two populations, so any gate would mislabel
 * legitimate users. An unconditional hint has zero false-positive surface.
 *
 * The payload mirrors the shape the abuse blocklist returns on its blocked
 * path (`results` / `domain` / `hint`, serialized as a text chunk) so callers
 * see one consistent structure. It deliberately does NOT set `blocked` —
 * that flag keeps meaning "matched the regex blocklist". The discriminator
 * here follows the existing `reason` convention instead.
 */

export const NO_RESULTS_REASON = "no_results";

export type EmptyResultPayload = {
  results: never[];
  reason: typeof NO_RESULTS_REASON;
  domain: string;
  hint: string;
};

/**
 * Build the empty-result payload for a tool.
 *
 * `sources` is the tool's configured source list (a search tool's single
 * `source`, or a knowledge tool's `sources`), so the domain string is derived
 * from config rather than hard-coded to any one deployment's subject matter.
 */
export function emptyResultPayload(sources: string[]): EmptyResultPayload {
  const domain = sources.join(", ");
  return {
    results: [],
    reason: NO_RESULTS_REASON,
    domain,
    hint:
      `No indexed content matched. This tool only searches this server's indexed sources (${domain}) — ` +
      `see the tool description for what they cover; it is not a general-purpose web search. ` +
      `If your question is within that scope, try rephrasing it with different or more specific terms. ` +
      `If it falls outside that scope, use a web search instead.`,
  };
}

/**
 * The serialized empty-result payload, ready to emit as an MCP `text` chunk.
 * MCP tools return text content, so the JSON-shaped payload is stringified —
 * the calling LLM still sees the structured fields. Same approach as the
 * blocked path in src/mcp/tools/search.ts.
 */
export function formatEmptyResult(sources: string[]): string {
  return JSON.stringify(emptyResultPayload(sources));
}
