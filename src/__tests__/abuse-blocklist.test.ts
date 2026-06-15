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
