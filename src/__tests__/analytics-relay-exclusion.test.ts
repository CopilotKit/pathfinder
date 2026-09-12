/**
 * Machine-relay traffic must not reach the operator-facing analytics
 * surfaces.
 *
 * BACKGROUND (measured on production query_log, 7-day window ending
 * 2026-09-12). A CopilotKit-owned Railway triage service forwards every new
 * GitHub issue body VERBATIM into `search-docs` + `search-code` within ~4s of
 * the issue being filed. Twenty-three SEO-spam issues were therefore amplified
 * into the MCP by our own automation: 46 of 1,318 rows, all from one IP
 * (152.55.178.126, inside Railway's 152.55.176.0/20) with User-Agent `node`.
 * Those blobs retrieve real content (cosine 0.33-0.43, 4 results), so nothing
 * in the empty-result path or the abuse blocklist ever saw them — they ranked
 * in Top Queries, and from there into the weekly Notion report (full
 * `query_text` rendered into a table cell) and the bi-weekly gap analysis
 * (un-truncated into an LLM prompt whose output is published).
 *
 * The rule under test is IDENTITY-shaped (User-Agent + source CIDR), never
 * content-shaped. The longest LEGITIMATE query in that same production window
 * was 7,520 characters — a length threshold would delete real operator signal,
 * which is why this suite pins a 7,520-char legitimate query as a NEGATIVE
 * assertion on every surface.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { __setPoolForTesting, __resetPoolForTesting } from "../db/client.js";
import {
  getAnalyticsSummary,
  getAtlasRetrievalMetrics,
  getEmptyQueries,
  getToolBreakdown,
  getToolCounts,
  getTopQueries,
  getRelayExclusions,
  normalizeRequestSource,
  RELAY_TAG_EXCLUSION_NAME,
  __setMachineRelayRulesForTesting,
} from "../db/analytics.js";
import type { MachineRelayRule } from "../types.js";
import { generatePostSchemaMigration } from "../db/schema.js";

const QUERY_LOG_DDL_MARKER =
  "-- Analytics: query_log table for tracking tool usage";

function extractAnalyticsDdl(): string {
  const full = generatePostSchemaMigration();
  const idx = full.indexOf(QUERY_LOG_DDL_MARKER);
  if (idx < 0) {
    throw new Error(`Could not locate "${QUERY_LOG_DDL_MARKER}" in schema`);
  }
  return full.slice(idx);
}

function poolFromPglite(db: PGlite) {
  return {
    query: (text: string, params?: unknown[]) => db.query(text, params),
    connect: async () => ({
      query: (text: string, params?: unknown[]) => db.query(text, params),
      release: () => {},
    }),
    end: async () => db.close(),
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

/** The production relay: Railway's 152.55.176.0/20, User-Agent `node`. */
const RELAY_IP = "152.55.178.126";
const RELAY_RULE: MachineRelayRule = {
  name: "github-issue-triage",
  reason:
    "CopilotKit GitHub-issue triage relay (Railway) forwards issue bodies verbatim",
  user_agent: "node",
  client_ip_cidr: "152.55.176.0/20",
};

/** SEO-spam body, ~3.3 KB with 13 live backlinks — the shape that shipped. */
const SPAM_BODY =
  "Why 1Rank.app Belongs in Your SEO Growth Stack. " +
  "Ranking on search engines is harder than ever. " +
  Array.from(
    { length: 13 },
    (_, i) => `Read more at https://1rank.app/blog/post-${i} and grow faster. `,
  ).join("") +
  "x".repeat(3300);

/**
 * The 7,520-char LEGITIMATE query: an operator pasting a long stack trace /
 * config dump into the docs search. Two links, not thirteen. This is the
 * measured production maximum and the decisive negative assertion — if a
 * future exclusion rule ever goes content-shaped, this row disappears from
 * the dashboard and this suite fails.
 */
const LONG_LEGIT_QUERY =
  "CopilotKit runtime throws GraphQLError on streaming, see https://github.com/CopilotKit/CopilotKit/issues/1 and https://docs.copilotkit.ai/troubleshooting — full trace: " +
  "at Runtime.handleRequest (dist/index.js:1:1) ".repeat(164);

/** A long legitimate PASTE with few links — the second content-shape control. */
const LONG_LEGIT_PASTE = "useCoAgent state sync issue: " + "y".repeat(3400);

const SHORT_LEGIT = "how do I install copilotkit";

interface Row {
  toolName: string;
  queryText: string;
  resultCount: number;
  sourceName: string | null;
  sessionId: string | null;
  clientIp: string | null;
  userAgent: string | null;
  requestSource?: string | null;
}

async function insertRow(db: PGlite, row: Row): Promise<void> {
  await db.query(
    `INSERT INTO query_log
      (tool_name, query_text, result_count, top_score, score_kind, latency_ms,
       source_name, session_id, request_source, client_ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      row.toolName,
      row.queryText,
      row.resultCount,
      row.resultCount > 0 ? 0.4 : null,
      row.resultCount > 0 ? "cosine" : null,
      25,
      row.sourceName,
      row.sessionId,
      row.requestSource === undefined ? "user" : row.requestSource,
      row.clientIp,
      row.userAgent,
    ],
  );
}

async function seed(db: PGlite): Promise<void> {
  // ── Legitimate traffic: 4 distinct clients, 4 IPs, 4 sessions ────────────
  for (let i = 0; i < 3; i++) {
    await insertRow(db, {
      toolName: "search-docs",
      queryText: SHORT_LEGIT,
      resultCount: 5,
      sourceName: "docs",
      sessionId: "legit-short",
      clientIp: "3.4.5.6",
      userAgent: "Claude-User",
    });
  }
  await insertRow(db, {
    toolName: "search-docs",
    queryText: LONG_LEGIT_QUERY,
    resultCount: 4,
    sourceName: "docs",
    sessionId: "legit-long",
    clientIp: "9.9.9.9",
    userAgent: "Claude-User",
  });
  await insertRow(db, {
    toolName: "search-code",
    queryText: LONG_LEGIT_PASTE,
    resultCount: 2,
    sourceName: "code",
    sessionId: "legit-paste",
    clientIp: "8.8.8.8",
    userAgent: "curl/8.4.0",
  });
  // `node` User-Agent, but OUTSIDE the declared relay CIDR: the rule is
  // UA *and* network, not UA alone.
  await insertRow(db, {
    toolName: "search-docs",
    queryText: "node sdk streaming example",
    resultCount: 3,
    sourceName: "docs",
    sessionId: "legit-node-elsewhere",
    clientIp: "54.176.234.134",
    userAgent: "node",
  });
  await insertRow(db, {
    toolName: "search-docs",
    queryText: "no hits for this one",
    resultCount: 0,
    sourceName: "docs",
    sessionId: "legit-empty",
    clientIp: "3.4.5.6",
    userAgent: "Claude-User",
  });

  // ── Relay traffic: one IP, UA `node`, a fresh session per issue ──────────
  for (let i = 0; i < 3; i++) {
    for (const tool of ["search-docs", "search-code"]) {
      await insertRow(db, {
        toolName: tool,
        queryText: SPAM_BODY,
        resultCount: 4,
        sourceName: tool === "search-docs" ? "docs" : "code",
        sessionId: `relay-issue-${i}`,
        clientIp: RELAY_IP,
        userAgent: "node",
      });
    }
  }
  // A relayed issue body that is NOT spam. Still not a user query.
  await insertRow(db, {
    toolName: "search-docs",
    queryText: "Bug: useCopilotAction does not fire on first render",
    resultCount: 4,
    sourceName: "docs",
    sessionId: "relay-issue-legit",
    clientIp: RELAY_IP,
    userAgent: "node",
  });
  // A relayed body that retrieved nothing — pollutes the empty-result panel.
  await insertRow(db, {
    toolName: "search-code",
    queryText: SPAM_BODY + " zagfro.com",
    resultCount: 0,
    sourceName: "code",
    sessionId: "relay-issue-empty",
    clientIp: RELAY_IP,
    userAgent: "node",
  });

  // ── Convergence row: the relay AFTER it starts sending the header ────────
  // `X-Pathfinder-Source: github-triage` normalizes to request_source
  // 'relay'. Different IP and User-Agent on purpose: once the relay declares
  // itself, the fingerprint rule is no longer what excludes it.
  await insertRow(db, {
    toolName: "search-docs",
    queryText: "Relayed issue body from a self-declaring relay",
    resultCount: 4,
    sourceName: "docs",
    sessionId: "relay-tagged",
    clientIp: "10.20.30.40",
    userAgent: "undici",
    requestSource: "relay",
  });
}

function texts(rows: Array<{ query_text: string }>): string[] {
  return rows.map((r) => r.query_text);
}

describe("machine-relay exclusion from operator-facing analytics", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.waitReady;
    await db.exec(extractAnalyticsDdl());
    __setPoolForTesting(poolFromPglite(db));
  });

  afterAll(async () => {
    __resetPoolForTesting();
    __setMachineRelayRulesForTesting(null);
    await db.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM query_log");
    __setMachineRelayRulesForTesting([RELAY_RULE]);
    await seed(db);
  });

  // ── The pollution ────────────────────────────────────────────────────────

  it("keeps relayed bodies out of Top Queries", async () => {
    const top = await getTopQueries(7, 200);
    expect(texts(top)).not.toContain(SPAM_BODY);
    expect(
      texts(top).some((t) => t.includes("useCopilotAction does not fire")),
    ).toBe(false);
  });

  it("keeps relayed bodies out of the Empty-Result panel", async () => {
    const empty = await getEmptyQueries(7, 200);
    expect(texts(empty).some((t) => t.includes("zagfro.com"))).toBe(false);
    expect(texts(empty)).toContain("no hits for this one");
  });

  it("keeps relay rows out of the summary counts", async () => {
    const s = await getAnalyticsSummary({}, 7);
    // 4 legitimate IPs: 3.4.5.6, 9.9.9.9, 8.8.8.8, 54.176.234.134.
    expect(s.unique_ip_count_window).toBe(4);
    // 5 legitimate sessions; the relay's per-issue sessions are the largest
    // single-actor session inflation in the production window.
    expect(s.unique_session_count_window).toBe(5);
    expect(s.total_queries_window).toBe(7);
  });

  it("keeps relay rows out of the tool counts and breakdown", async () => {
    const counts = await getToolCounts(7, {});
    const total = counts.reduce((a, c) => a + c.count, 0);
    expect(total).toBe(7);
    const breakdown = await getToolBreakdown(7, {});
    expect(breakdown.reduce((a, c) => a + c.count, 0)).toBe(7);
  });

  it("keeps relay rows out of the Atlas user-query denominator", async () => {
    const m = await getAtlasRetrievalMetrics(7, {});
    expect(m.total_user_queries_window).toBe(7);
  });

  // ── Negative assertions: legitimate traffic SURVIVES ─────────────────────

  it("does NOT exclude the 7,520-char legitimate query", async () => {
    expect(LONG_LEGIT_QUERY.length).toBeGreaterThanOrEqual(7500);
    const top = await getTopQueries(7, 200);
    expect(texts(top)).toContain(LONG_LEGIT_QUERY);
  });

  it("does NOT exclude a long legitimate paste with few links", async () => {
    const top = await getTopQueries(7, 200);
    expect(texts(top)).toContain(LONG_LEGIT_PASTE);
  });

  it("does NOT exclude ordinary short legitimate queries", async () => {
    const top = await getTopQueries(7, 200);
    expect(texts(top)).toContain(SHORT_LEGIT);
  });

  it("does NOT exclude a `node` client outside the declared relay CIDR", async () => {
    const top = await getTopQueries(7, 200);
    expect(texts(top)).toContain("node sdk streaming example");
  });

  // ── Operator visibility ─────────────────────────────────────────────────

  it("reports what was excluded, and why, one row per rule", async () => {
    const rows = await getRelayExclusions(7, {});
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));

    const fingerprint = byName["github-issue-triage"];
    expect(fingerprint.kind).toBe("fingerprint");
    // 6 spam + 1 relayed non-spam body + 1 relayed body with no results.
    expect(fingerprint.count).toBe(8);
    expect(fingerprint.reason).toContain("triage relay");
    expect(fingerprint.last_seen).toBeTruthy();

    const tagged = byName[RELAY_TAG_EXCLUSION_NAME];
    expect(tagged.kind).toBe("tag");
    expect(tagged.count).toBe(1);
  });

  it("still lists a declared rule that matched nothing", async () => {
    __setMachineRelayRulesForTesting([
      { name: "stale-rule", user_agent: "some-retired-relay" },
    ]);
    const rows = await getRelayExclusions(7, {});
    const stale = rows.find((r) => r.name === "stale-rule");
    expect(stale?.count).toBe(0);
  });

  it("lets an operator read the excluded rows back via request_source=relay", async () => {
    const relayOnly = await getTopQueries(7, 200, {
      request_source: "relay",
    });
    // Both halves of the audience: fingerprinted AND self-declared.
    expect(texts(relayOnly)).toContain(SPAM_BODY);
    expect(
      texts(relayOnly).some((t) => t.includes("self-declaring relay")),
    ).toBe(true);
    // And nothing legitimate leaks into the inspection view.
    expect(texts(relayOnly)).not.toContain(SHORT_LEGIT);
    expect(texts(relayOnly)).not.toContain(LONG_LEGIT_QUERY);
  });

  // ── Convergence on the header ────────────────────────────────────────────

  it("maps the relay's X-Pathfinder-Source value onto the relay audience", () => {
    expect(normalizeRequestSource("github-triage")).toBe("relay");
    expect(normalizeRequestSource(" GitHub-Triage ")).toBe("relay");
    expect(normalizeRequestSource("relay")).toBe("relay");
    // Still conservative for anything unrecognized.
    expect(normalizeRequestSource("something-else")).toBe("user");
  });

  it("excludes a self-declared relay even with NO fingerprint rule declared", async () => {
    __setMachineRelayRulesForTesting([]);
    const top = await getTopQueries(7, 200);
    expect(texts(top).some((t) => t.includes("self-declaring relay"))).toBe(
      false,
    );
    // This is the convergence contract: once the relay sends the header the
    // fingerprint rule can be deleted from config and the exclusion holds.
  });

  it("excludes NOTHING when no relay rules are declared", async () => {
    __setMachineRelayRulesForTesting([]);
    const top = await getTopQueries(7, 200);
    expect(texts(top)).toContain(SPAM_BODY);
  });
});
