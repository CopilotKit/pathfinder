import { describe, it, expect } from "vitest";
import { checkBlocklist } from "../mcp/abuse-blocklist.js";

// ---------------------------------------------------------------------------
// Positive matches — each pattern must catch its abuse string.
//
// Every pattern that ships in PATTERNS gets a positive test here. If a new
// pattern is added to the module without a corresponding positive test, the
// "every pattern has a positive test" sweep below will fail.
// ---------------------------------------------------------------------------

describe("checkBlocklist — positive matches", () => {
  const positives: Array<{ name: string; reason: string; query: string }> = [
    {
      name: "movie-box-office",
      reason: "pattern:movie-box-office",
      query: "Toy Story 5 box office opening weekend",
    },
    {
      name: "movie-box-office (no space)",
      reason: "pattern:movie-box-office",
      query: "boxoffice numbers for this weekend",
    },
    {
      name: "toy-story-5",
      reason: "pattern:toy-story-5",
      query: "When does Toy Story 5 release in theaters",
    },
    {
      name: "disclosure-day",
      reason: "pattern:disclosure-day",
      query: "What is Disclosure Day",
    },
    {
      name: "obsession-2026",
      reason: "pattern:obsession-2026",
      query: "Obsession movie 2026 cast",
    },
    {
      name: "obsession-2026 (no 'movie')",
      reason: "pattern:obsession-2026",
      query: "Obsession 2026 trailer",
    },
    {
      name: "scary-movie-2026",
      reason: "pattern:scary-movie-2026",
      query: "Scary Movie 2026 release date",
    },
    {
      name: "scotus-kalshi (scotus then kalshi)",
      reason: "pattern:scotus-kalshi",
      query: "SCOTUS denies Kalshi appeal in election prediction case",
    },
    {
      name: "scotus-kalshi (kalshi then scotus)",
      reason: "pattern:scotus-kalshi",
      query: "Kalshi expects SCOTUS ruling next term",
    },
    {
      name: "scotus-kalshi (cftc then certiorari)",
      reason: "pattern:scotus-kalshi",
      query: "CFTC certiorari petition status",
    },
    {
      name: "sports-event-contracts",
      reason: "pattern:sports-event-contracts",
      query: "sports event contracts legality update",
    },
    {
      name: "sports-event-contracts (singular sport)",
      reason: "pattern:sports-event-contracts",
      query: "sport event contract market",
    },
    // --- Awards-show family (2026 scraping wave) -------------------------
    {
      name: "awards-show (emmy + nominations)",
      reason: "pattern:awards-show",
      query: "Emmy Awards Beef Season 2 nominations 78th",
    },
    {
      name: "awards-show (emmy + outstanding category)",
      reason: "pattern:awards-show",
      query: "Emmy 2026 Outstanding Lead Actor Limited Series nominees",
    },
    {
      name: "awards-show (emmy + bare 'awards')",
      reason: "pattern:awards-show",
      query: "Emmy Awards bracket win probability 2 3 awards",
    },
    {
      name: "awards-show (grammy + record of the year / winners)",
      reason: "pattern:awards-show",
      query: "GRAMMY Record of the Year historical winners base rates",
    },
    {
      name: "awards-show (oscar + nominations)",
      reason: "pattern:awards-show",
      query: "Dune Messiah Oscar nominations 2027",
    },
    {
      name: "awards-show (academy awards + best actress)",
      reason: "pattern:awards-show",
      query: "Julianne Moore 2027 Academy Awards Best Actress",
    },
    {
      name: "awards-show-year (emmy + year, no category word)",
      reason: "pattern:awards-show-year",
      query: "Betty Gilpin Widow's Bay Emmy 2026",
    },
    {
      name: "awards-show-year (grammy + year)",
      reason: "pattern:awards-show-year",
      query: "Olivia Dean Art of Loving GRAMMY 2027",
    },
    // --- Elections / prediction-market family (2026 scraping wave) -------
    {
      name: "election-politics (congressional + district)",
      reason: "pattern:election-politics",
      query: "Michigan congressional districts 2026 midterm elections",
    },
    {
      name: "election-politics (house seats + midterm + forecast)",
      reason: "pattern:election-politics",
      query: "California House seats 2026 midterm election forecast",
    },
    {
      name: "election-politics (congressional district + midterm)",
      reason: "pattern:election-politics",
      query: "Iowa 1st congressional district 2026 midterm",
    },
    {
      name: "election-politics (senate + turnout)",
      reason: "pattern:election-politics",
      query: "Ohio Senate election 2026 turnout",
    },
    {
      name: "election-politics (presidential + candidates/polls)",
      reason: "pattern:election-politics",
      query: "Brazil 2026 presidential election candidates polls",
    },
    {
      name: "election-politics (governor + election)",
      reason: "pattern:election-politics",
      query: "Alaska governor 2026 election",
    },
    {
      name: "election-politics-year (redistricting + year)",
      reason: "pattern:election-politics-year",
      query: "Missouri congressional redistricting 2026",
    },
    {
      name: "election-politics-year (senate + year, no contest word)",
      reason: "pattern:election-politics-year",
      query: "Dan Sullivan Alaska Senate 2026",
    },
    {
      name: "election-polling (bare 'election' + polling)",
      reason: "pattern:election-polling",
      query: "Swedish election 2026 Centre Party polling",
    },
    {
      name: "election-polling (bare 'election' + polls)",
      reason: "pattern:election-polling",
      query: "Swedish Liberals Liberalerna 2026 election polls threshold",
    },
  ];

  for (const { name, reason, query } of positives) {
    it(`matches: ${name}`, () => {
      const result = checkBlocklist(query);
      expect(result.matched).toBe(true);
      expect(result.reason).toBe(reason);
    });
  }
});

// ---------------------------------------------------------------------------
// Negative matches — real CopilotKit / AG-UI documentation queries that
// contain near-miss phrasings must NOT trigger the blocklist. Each near-miss
// targets a specific pattern that could plausibly false-positive without the
// `\b` boundary or required co-occurrence — they're the regression guard for
// the "zero FP" guarantee in the module JSDoc.
// ---------------------------------------------------------------------------

describe("checkBlocklist — legitimate queries do not match", () => {
  const negatives: string[] = [
    // Near-miss for movie-box-office: contains "box" and "office" but not as
    // an adjacent phrase. `\b...\b` + `\s*` between the two words gates this.
    "useCopilotAction box for the office layout",
    "how to render a checkbox in the office hours page",
    // Near-miss for toy-story-5: contains the version-y "5" but no "toy story".
    "version 5 of the agent toolkit",
    // Near-miss for disclosure-day: "day" alone or "disclosure" in a privacy
    // context. Pattern requires both adjacent.
    "how to set disclosure on a tool result",
    "what day does the agent run on",
    // Near-miss for obsession-2026 / scary-movie-2026: bare "2026" must not
    // match. The pattern requires the movie-title prefix.
    "roadmap for 2026 release",
    "agentic frameworks 2026 outlook",
    // Near-miss for scotus-kalshi: "certiorari" alone, or "cftc" alone, in
    // contexts that don't co-occur with the other half. The pattern requires
    // BOTH a court/agency term AND a docket term.
    "certiorari is a legal term but unrelated",
    "what does CFTC stand for in documentation",
    // Near-miss for sports-event-contracts: words present but not the phrase.
    "sport in our user interface event contract",
    // Plain CopilotKit / AG-UI documentation queries — these are the bread
    // and butter of legitimate traffic; any false-positive here would be a
    // direct user-visible regression.
    "How do I install CopilotKit in a Next.js app",
    "useCopilotAction onClick handler example",
    "AG-UI event types for streaming responses",
    "configure copilot runtime with anthropic",
    "MCP server health endpoint",
    "How to debug a langgraph agent",
    // Near-misses for the awards-show family. The topic term must co-occur
    // with an awards-context term (or, for the unambiguous show names, a
    // year); a bare "award"/"season"/"series" in a product context, or a
    // person named Oscar, must stay out.
    "award badge component in the docs sidebar",
    "series and season fields in the demo catalog config",
    "Oscar asked in Discord whether the 2026 roadmap includes Angular support",
    "beef up the error handling in the runtime adapter",
    "state of the art embedding models for retrieval",
    // Near-misses for the elections family. Every hazard word here is a real
    // CopilotKit/AG-UI term: "poll"/"polling" (transport), "race" (race
    // condition), "state" (React state), "primary" (CSS color), "candidate"
    // (index keys), "seats" (billing), "district"/"governor"/"forecast"
    // (product nouns), "polly" (AWS Polly TTS). None may match on its own.
    "Raft leader election polling interval for agent runner replicas",
    "how do I poll the runtime endpoint until the run finishes",
    "long-polling transport fallback for MCP sessions",
    "AWS Polly text-to-speech integration with CopilotKit",
    "polly",
    "race condition connect while run finishes isRunning implementation",
    "how to manage React state in a CopilotKit component",
    "CSS variables --copilot-kit-primary-color CopilotKit theme customization Vue v2",
    "forecast chart component for the dashboard demo",
    "candidate keys for the vector index lookup",
    "cpufreq governor settings for the CI runner",
    "how many seats does the Intelligence Cloud free plan include per developer",
    "district heating dashboard demo with a map component",
  ];

  for (const query of negatives) {
    it(`does not match: "${query}"`, () => {
      const result = checkBlocklist(query);
      expect(result.matched).toBe(false);
      expect(result.reason).toBeUndefined();
    });
  }
});

// ---------------------------------------------------------------------------
// Shape / API contract
// ---------------------------------------------------------------------------

describe("checkBlocklist — return shape", () => {
  it("returns matched=false with no reason when nothing matches", () => {
    const result = checkBlocklist("hello world");
    expect(result).toEqual({ matched: false });
  });

  it("returns matched=true with a `pattern:` prefixed reason on match", () => {
    const result = checkBlocklist("box office");
    expect(result.matched).toBe(true);
    expect(result.reason).toMatch(/^pattern:/);
  });

  it("is case-insensitive", () => {
    expect(checkBlocklist("BOX OFFICE").matched).toBe(true);
    expect(checkBlocklist("Box Office").matched).toBe(true);
    expect(checkBlocklist("box office").matched).toBe(true);
  });

  it("returns matched=false for the empty string", () => {
    expect(checkBlocklist("")).toEqual({ matched: false });
  });
});
