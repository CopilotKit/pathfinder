/**
 * Pattern-based blocklist for the known abuse cluster observed on
 * mcp.copilotkit.ai. These patterns have ZERO overlap with CopilotKit, AG-UI,
 * MCP, or React-agentic-framework documentation. Any match is, by definition,
 * off-topic for this server's index.
 *
 * Background: production analytics (v1.15.1+ query_log) traced a high-volume
 * off-topic empty-query cluster to Anthropic's `Claude-User` shared egress
 * pool (`160.79.106.32/29`). That same pool also serves ~46k legit
 * Claude-User sessions/7d, so an IP-level block would harm real traffic. A
 * surgical pattern-based block catches the abuse with zero false-positives
 * on legitimate documentation queries.
 *
 * Long-term defense lives in the scope classifier (see Notion follow-ups);
 * this list is the immediate-stop-bleeding bridge. New patterns added here
 * MUST come with both a positive test (matches the abuse string) AND a
 * negative test (a real CopilotKit/AG-UI query that contains a near-miss
 * phrase does NOT match), so the zero-FP guarantee is pinned by CI.
 */

export type BlocklistMatch = { matched: boolean; reason?: string };

const PATTERNS: { name: string; regex: RegExp }[] = [
  // Movie box-office news (e.g. "Toy Story 5 box office opening weekend").
  // `\b` boundaries + `\s*` between the two words so "box office" and
  // "boxoffice" both match while "box for the office layout" does not (the
  // negative test for this is in the test file).
  { name: "movie-box-office", regex: /\bbox\s*office\b/i },
  { name: "toy-story-5", regex: /\btoy\s*story\s*5\b/i },
  { name: "disclosure-day", regex: /\bdisclosure\s*day\b/i },
  { name: "obsession-2026", regex: /\bobsession\s*(?:movie\s*)?2026\b/i },
  { name: "scary-movie-2026", regex: /\bscary\s*movie\s*2026\b/i },
  // SCOTUS / CFTC + Kalshi / certiorari co-occurrence. Either ordering
  // matches via the `|`-joined alternation. Each side requires both a
  // court/agency term AND a docket term so legitimate documentation
  // mentioning "certiorari" or "SCOTUS" in isolation (unlikely in CopilotKit
  // docs, but defensive) doesn't false-positive.
  {
    name: "scotus-kalshi",
    regex:
      /\b(?:scotus|cftc)\b.*\b(?:kalshi|certiorari)\b|\b(?:kalshi|certiorari)\b.*\b(?:scotus|cftc)\b/i,
  },
  {
    name: "sports-event-contracts",
    regex: /\bsports?\s*event\s*contracts?\b/i,
  },
];

/**
 * Check a query against the abuse blocklist. Returns `{ matched: true,
 * reason: "pattern:<name>" }` on the first matching pattern, or
 * `{ matched: false }` otherwise. The `pattern:` prefix on the reason
 * is intentional so future non-pattern reasons (classifier verdict,
 * reputation system) carry a different prefix and are greppable.
 */
export function checkBlocklist(query: string): BlocklistMatch {
  for (const { name, regex } of PATTERNS) {
    if (regex.test(query)) return { matched: true, reason: `pattern:${name}` };
  }
  return { matched: false };
}
