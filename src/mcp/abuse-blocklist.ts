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

  // -------------------------------------------------------------------------
  // Awards-show scraping (Sept 2026 wave). The bot rotates show titles and
  // nominee names constantly ("Widow's Bay", "Beef", "The Pitt", ...), so
  // per-title regexes are a treadmill. Instead: require a SHOW NAME to
  // co-occur with an AWARDS-CONTEXT term. Both patterns use `(?=...)`
  // lookaheads over `[\s\S]*` so the two halves match in either order and
  // across newlines (indexed GitHub/Discord bodies are multi-line).
  // -------------------------------------------------------------------------
  {
    name: "awards-show",
    regex:
      /^(?=[\s\S]*\b(?:emmys?|grammys?|oscars?|academy\s+awards?|golden\s+globes?|tony\s+awards?|baftas?)\b)(?=[\s\S]*\b(?:awards?|nominations?|nominees?|nominated|winners?|wins|red\s+carpet|outstanding|best\s+(?:actor|actress|picture|director|album|song|new\s+artist|international\s+feature|(?:limited\s+)?series)|album\s+of\s+(?:the\s+)?year|record\s+of\s+the\s+year|song\s+of\s+the\s+year|ceremony|shortlists?|frontrunners?|contenders?|snubs?|lead\s+act(?:or|ress)|supporting\s+act(?:or|ress)|guest\s+act(?:or|ress)|limited\s+series|variety\s+series)\b)/i,
  },
  // Same show names paired with a bare 4-digit year ("Betty Gilpin Widow's
  // Bay Emmy 2026"), which carries no category word. `oscars?` is
  // deliberately EXCLUDED here: "Oscar" is a common given name, and
  // "Oscar ... 2026" in a Discord/GitHub body is a plausible legitimate
  // query. Oscar-flavoured abuse still gets caught by `awards-show` above,
  // which requires a real awards-context term.
  {
    name: "awards-show-year",
    regex:
      /^(?=[\s\S]*\b(?:emmys?|grammys?|academy\s+awards?|golden\s+globes?|tony\s+awards?|baftas?)\b)(?=[\s\S]*\b20\d\d\b)/i,
  },

  // -------------------------------------------------------------------------
  // US/international election + prediction-market scraping (Sept 2026 wave).
  // Same co-occurrence shape. The hazard list here is long because almost
  // every electoral word has a legitimate software meaning: "poll"/"polling"
  // (transport), "race" (race condition), "state" (React state), "primary"
  // (CSS color), "candidate" (index keys), "seat" (billing), "district",
  // "forecast", "turnout". NONE of them is blocked on its own — each only
  // counts as CONTEXT, and a match additionally requires a POLITICAL-DOMAIN
  // term that has no software meaning (presidential, congressional, senate,
  // midterm, redistricting, ...).
  // -------------------------------------------------------------------------
  {
    name: "election-politics",
    regex:
      /^(?=[\s\S]*\b(?:presidential|gubernatorial|governor|senate|senatorial|congressional|parliamentary|midterms?|redistricting|electorate|electoral\s+college|caucus|house\s+(?:seats?|districts?))\b)(?=[\s\S]*\b(?:elections?|primar(?:y|ies)|ballots?|turnout|votes?|voting|voters?|candidates?|polls?|polling|nominations?|incumbents?|seats?|districts?|races?|forecasts?|constituency)\b)/i,
  },
  // Political-domain term + a bare year ("Dan Sullivan Alaska Senate 2026",
  // "Missouri congressional redistricting 2026") — the bot's terse shape,
  // which carries no contest word at all.
  {
    name: "election-politics-year",
    regex:
      /^(?=[\s\S]*\b(?:presidential|gubernatorial|governor|senate|senatorial|congressional|parliamentary|midterms?|redistricting|electorate|electoral\s+college|caucus|house\s+(?:seats?|districts?))\b)(?=[\s\S]*\b20\d\d\b)/i,
  },
  // The bot also asks about national elections with no office word at all
  // ("Swedish election 2026 Centre Party polling"). Bare "election" + a
  // ballot-box term is the only signal left, so this pattern carves out the
  // one real software collision: Raft/consensus LEADER election, which
  // legitimately co-occurs with "polling". The negative lookbehind keeps
  // "Raft leader election polling interval" out of the blocklist.
  {
    name: "election-polling",
    regex:
      /^(?=[\s\S]*\b(?<!\bleader\s)elections?\b)(?=[\s\S]*\b(?:polls?|polling|turnout|ballots?|voters?|electorate|constituency|caucus)\b)/i,
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
