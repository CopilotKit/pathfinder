/**
 * An ad-hoc REPLAY HARNESS must not impersonate demand on the operator-facing
 * analytics surfaces.
 *
 * BACKGROUND (measured on production query_log, full 90-day retention, read
 * 2026-09-12). User-Agent `Python-urllib/3.9` accounts for 258 rows out of
 * 22,238 — ONE IP, ONE 55-second burst at 2026-09-10 15:30 UTC, 257 of them in
 * a single session. That is the largest session in retention by 3.3x: the
 * biggest legitimate session is 77 rows over 6 minutes. The IP is a CopilotKit
 * engineer's workstation and `Python-urllib/3.9` is what the macOS system
 * `python3` (3.9.6) sends, so this is a hand-run script, not a user and not an
 * attacker.
 *
 * What makes it a MACHINE RELAY in the sense of {@link MachineRelayRule} is
 * what it sends: 206 of its 258 distinct query texts are VERBATIM copies of
 * queries other clients had already logged. It re-fires other people's text
 * into the tools. In a 7-day window that was 252 of 1,258 Top Queries rows
 * (20%), it double-counted 20 real queries, and — because a replayed copy can
 * retrieve results where the original did not — it made genuinely empty
 * queries look answered.
 *
 * The rule is IDENTITY-shaped and deliberately User-Agent-ONLY. No MCP client
 * library speaks stdlib urllib (the official Python MCP SDK uses httpx), so
 * this User-Agent is always a hand-rolled script; the source CIDR is omitted
 * because it is a residential dynamic address. The decisive NEGATIVE
 * assertions below are that `python-httpx` traffic and the 7,520-char
 * legitimate query both survive — a UA-only rule must not become a rule about
 * "Python-ish clients" or about query shape.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { __setPoolForTesting, __resetPoolForTesting } from "../db/client.js";
import {
  getAnalyticsSummary,
  getEmptyQueries,
  getToolCounts,
  getTopQueries,
  getRelayExclusions,
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

/** The shipped rule: User-Agent only, no CIDR. */
const HARNESS_RULE: MachineRelayRule = {
  name: "adhoc-python-replay-harness",
  reason:
    "Ad-hoc Python replay harness (macOS system python3, stdlib urllib) — refires a corpus of previously-logged queries in bulk",
  user_agent: "Python-urllib/3.9",
};

/** The workstation the production burst came from. */
const HARNESS_IP = "75.172.71.26";
const HARNESS_UA = "Python-urllib/3.9";

/**
 * A query the harness REPLAYED: a real client asked it first, the harness
 * re-fired it later. Its real count is 1, not 2.
 */
const REPLAYED_QUERY = "CopilotChat v2 theming custom colors dark mode";

/** A query that exists ONLY because the harness invented it for the corpus. */
const HARNESS_ONLY_QUERY =
  "AgentRunner connect stop isRunning run contract InMemoryAgentRunner";

/**
 * A query a real client ran and got NOTHING for. The harness replayed it and
 * got results, which promoted a genuine documentation gap into Top Queries.
 */
const GENUINE_GAP_QUERY = "copilotkit offline mode";

/**
 * The 7,520-char legitimate query — the measured production maximum. Pinned
 * here as the content-shape negative: if this exclusion ever stops being about
 * identity, this row disappears and this suite fails.
 */
const LONG_LEGIT_QUERY =
  "CopilotKit runtime throws GraphQLError on streaming, see https://github.com/CopilotKit/CopilotKit/issues/1 — full trace: " +
  "at Runtime.handleRequest (dist/index.js:1:1) ".repeat(164);

/**
 * A REAL Python MCP client. The official Python MCP SDK uses httpx, which is
 * why the rule pins urllib rather than anything "Python". 173 such rows exist
 * in production retention and none of them may be touched.
 */
const HTTPX_QUERY = "langgraph agent state sync python sdk";

const SHORT_LEGIT = "how do I install copilotkit";

interface Row {
  toolName: string;
  queryText: string;
  resultCount: number;
  sessionId: string;
  clientIp: string;
  userAgent: string;
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
      row.toolName === "search-docs" ? "docs" : "code",
      row.sessionId,
      "user",
      row.clientIp,
      row.userAgent,
    ],
  );
}

async function seed(db: PGlite): Promise<void> {
  // ── Legitimate traffic: 4 IPs, 4 sessions, 5 rows ────────────────────────
  await insertRow(db, {
    toolName: "search-docs",
    queryText: SHORT_LEGIT,
    resultCount: 5,
    sessionId: "legit-short",
    clientIp: "3.4.5.6",
    userAgent: "Claude-User",
  });
  await insertRow(db, {
    toolName: "search-docs",
    queryText: REPLAYED_QUERY,
    resultCount: 4,
    sessionId: "legit-replayed-origin",
    clientIp: "3.4.5.6",
    userAgent: "Cursor/3.16.17 (darwin arm64)",
  });
  await insertRow(db, {
    toolName: "search-docs",
    queryText: LONG_LEGIT_QUERY,
    resultCount: 4,
    sessionId: "legit-long",
    clientIp: "9.9.9.9",
    userAgent: "Claude-User",
  });
  await insertRow(db, {
    toolName: "search-code",
    queryText: HTTPX_QUERY,
    resultCount: 3,
    sessionId: "legit-httpx",
    clientIp: "8.8.8.8",
    userAgent: "python-httpx/0.28.1",
  });
  // A real documentation gap: a human asked, nothing came back.
  await insertRow(db, {
    toolName: "search-docs",
    queryText: GENUINE_GAP_QUERY,
    resultCount: 0,
    sessionId: "legit-gap",
    clientIp: "7.7.7.7",
    userAgent: "claude-code/2.1.220 (cli)",
  });

  // ── The harness burst: one IP, one session, many distinct texts ──────────
  await insertRow(db, {
    toolName: "search-docs",
    queryText: REPLAYED_QUERY,
    resultCount: 4,
    sessionId: "harness-burst",
    clientIp: HARNESS_IP,
    userAgent: HARNESS_UA,
  });
  await insertRow(db, {
    toolName: "search-code",
    queryText: HARNESS_ONLY_QUERY,
    resultCount: 5,
    sessionId: "harness-burst",
    clientIp: HARNESS_IP,
    userAgent: HARNESS_UA,
  });
  // The replay that answered a query the real client got nothing for.
  await insertRow(db, {
    toolName: "search-docs",
    queryText: GENUINE_GAP_QUERY,
    resultCount: 6,
    sessionId: "harness-burst",
    clientIp: HARNESS_IP,
    userAgent: HARNESS_UA,
  });
  // The harness also produced its own zero-result rows, which read as gaps.
  await insertRow(db, {
    toolName: "search-ag-ui-code",
    queryText: "AG-UI 0.0.53 ImageInputContent InputContentUrlSource",
    resultCount: 0,
    sessionId: "harness-burst",
    clientIp: HARNESS_IP,
    userAgent: HARNESS_UA,
  });
  // The probe row from a second, one-off session a minute earlier.
  await insertRow(db, {
    toolName: "search-docs",
    queryText: "useHumanInTheLoop respond resolve status executing",
    resultCount: 5,
    sessionId: "harness-probe",
    clientIp: HARNESS_IP,
    userAgent: HARNESS_UA,
  });
}

function texts(rows: Array<{ query_text: string }>): string[] {
  return rows.map((r) => r.query_text);
}

describe("ad-hoc replay-harness exclusion from operator-facing analytics", () => {
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
    __setMachineRelayRulesForTesting([HARNESS_RULE]);
    await seed(db);
  });

  // ── The pollution ────────────────────────────────────────────────────────

  it("keeps harness-invented queries out of Top Queries", async () => {
    const top = await getTopQueries(7, 200);
    expect(texts(top)).not.toContain(HARNESS_ONLY_QUERY);
  });

  it("does not let a replay inflate the count of a real query", async () => {
    const top = await getTopQueries(7, 200);
    const replayed = top.find((q) => q.query_text === REPLAYED_QUERY);
    // One real client asked once. Without the rule this reads as 2.
    expect(replayed?.count).toBe(1);
  });

  it("does not let a replay hide a genuine documentation gap", async () => {
    // The human got zero results; the harness's copy got six. Top Queries
    // admits a query on `bool_or(result_count > 0)`, so the replay was
    // promoting the gap into the "answered" panel and out of the gap report.
    const top = await getTopQueries(7, 200);
    expect(texts(top)).not.toContain(GENUINE_GAP_QUERY);
    const empty = await getEmptyQueries(7, 200);
    expect(texts(empty)).toContain(GENUINE_GAP_QUERY);
  });

  it("keeps harness zero-result rows out of the Empty-Result panel", async () => {
    const empty = await getEmptyQueries(7, 200);
    expect(texts(empty).some((t) => t.includes("ImageInputContent"))).toBe(
      false,
    );
  });

  it("keeps the burst out of the summary counts", async () => {
    const s = await getAnalyticsSummary({}, 7);
    expect(s.total_queries_window).toBe(5);
    // 4 legitimate IPs: 3.4.5.6, 9.9.9.9, 8.8.8.8, 7.7.7.7.
    expect(s.unique_ip_count_window).toBe(4);
    // The burst's 2 sessions were the largest single-actor session inflation
    // in production retention.
    expect(s.unique_session_count_window).toBe(5);
  });

  it("keeps the burst out of the tool counts", async () => {
    const counts = await getToolCounts(7, {});
    expect(counts.reduce((a, c) => a + c.count, 0)).toBe(5);
  });

  // ── Negative assertions: legitimate traffic SURVIVES ─────────────────────

  it("does NOT exclude the real Python MCP client (httpx)", async () => {
    const top = await getTopQueries(7, 200);
    expect(texts(top)).toContain(HTTPX_QUERY);
  });

  it("does NOT exclude the 7,520-char legitimate query", async () => {
    expect(LONG_LEGIT_QUERY.length).toBeGreaterThanOrEqual(7500);
    const top = await getTopQueries(7, 200);
    expect(texts(top)).toContain(LONG_LEGIT_QUERY);
  });

  it("does NOT exclude ordinary short legitimate queries", async () => {
    const top = await getTopQueries(7, 200);
    expect(texts(top)).toContain(SHORT_LEGIT);
  });

  it("does NOT exclude other clients that share the harness IP", async () => {
    // The workstation also runs curl and a real MCP client from the same
    // address. The rule is the User-Agent, so those rows stay.
    await insertRow(db, {
      toolName: "search-docs",
      queryText: "same workstation, real client",
      resultCount: 4,
      sessionId: "workstation-real",
      clientIp: HARNESS_IP,
      userAgent: "codex-mcp-client/0.154.0",
    });
    const top = await getTopQueries(7, 200);
    expect(texts(top)).toContain("same workstation, real client");
  });

  it("does NOT exclude a different Python-urllib version", async () => {
    // The rule is an exact User-Agent match, not a "Python-ish" heuristic.
    await insertRow(db, {
      toolName: "search-docs",
      queryText: "some other python script",
      resultCount: 4,
      sessionId: "other-python",
      clientIp: "5.5.5.5",
      userAgent: "Python-urllib/3.12",
    });
    const top = await getTopQueries(7, 200);
    expect(texts(top)).toContain("some other python script");
  });

  // ── Operator visibility ─────────────────────────────────────────────────

  it("attributes every excluded row to the named rule", async () => {
    const rows = await getRelayExclusions(7, {});
    const rule = rows.find((r) => r.name === "adhoc-python-replay-harness");
    expect(rule?.kind).toBe("fingerprint");
    expect(rule?.count).toBe(5);
    expect(rule?.reason).toContain("replay harness");
    expect(rule?.last_seen).toBeTruthy();
  });

  it("lets an operator read the excluded rows back via request_source=relay", async () => {
    const relayOnly = await getTopQueries(7, 200, { request_source: "relay" });
    expect(texts(relayOnly)).toContain(HARNESS_ONLY_QUERY);
    expect(texts(relayOnly)).not.toContain(SHORT_LEGIT);
    expect(texts(relayOnly)).not.toContain(HTTPX_QUERY);
  });

  // ── Convergence on the header ────────────────────────────────────────────

  it("excludes NOTHING when the rule is not declared", async () => {
    // The red half of red-green, in-suite: drop the rule and the burst is
    // back in Top Queries with the replay inflating the real query to 2.
    __setMachineRelayRulesForTesting([]);
    const top = await getTopQueries(7, 200);
    expect(texts(top)).toContain(HARNESS_ONLY_QUERY);
    expect(top.find((q) => q.query_text === REPLAYED_QUERY)?.count).toBe(2);
    expect(texts(top)).toContain(GENUINE_GAP_QUERY);
  });
});
