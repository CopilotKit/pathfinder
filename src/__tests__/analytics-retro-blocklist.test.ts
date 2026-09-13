/**
 * Off-topic rows logged BEFORE the abuse blocklist learned their pattern must
 * not keep surfacing as documentation gaps.
 *
 * BACKGROUND (measured on production query_log, 7-day window ending
 * 2026-09-13T09:44Z — the window of the weekly Notion report published that
 * morning). The empty-result list held 49 grouped rows. Nineteen of them were
 * prediction-market scraping: Emmy/Grammy/Academy-Awards nominations, US
 * midterm/redistricting queries, a Swedish election polling query. Every one
 * of those 19 matches the CURRENT `checkBlocklist` patterns, and every one of
 * them has `blocked = false` in the DB because its LAST occurrence predates
 * 2026-09-10T16:40Z — the first production fire of the awards/election
 * families (`#156`). The blocklist runs PRE-EMBEDDING at request time, so it
 * can only ever flag rows written after it shipped; the flag is a record of
 * what the server knew THEN.
 *
 * Zero post-deploy off-topic rows were found unblocked, and the existing
 * `blocked = false` predicate in `getEmptyQueries` was verified present and
 * working. So this is not a missing exclusion and not a pattern gap: it is
 * history being reported under stale knowledge.
 *
 * The fix re-judges the empty-result list against the CURRENT patterns at READ
 * time. It is a bounded regex pass over an already-grouped, already-LIMITed
 * row set, so the cost is negligible next to the SQL that produced the rows.
 * It deliberately does NOT touch:
 *   - the summary counts (`empty_result_count_window`), which already include
 *     write-time-blocked rows — the established precedent is that only the
 *     LIST is filtered; and
 *   - `getBlockedQueries`, which must stay the write-time truth of what the
 *     blocklist actually short-circuited, not a retroactive re-scoring.
 *
 * The NEGATIVE half matters more than the positive half: the same production
 * window carried ~10 genuine documentation gaps (`pendingInterrupts`,
 * `CopilotChatUserMessage`, `useHumanInTheLoop`, ...). Silently dropping those
 * would be far worse than the noise this removes, so every one of them is
 * pinned here.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { __setPoolForTesting, __resetPoolForTesting } from "../db/client.js";
import {
  getAnalyticsSummary,
  getBlockedQueries,
  getEmptyQueries,
} from "../db/analytics.js";
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

/**
 * Verbatim off-topic `query_text` values from the 2026-09-13 report window,
 * all logged with `blocked = false` because they predate the patterns.
 */
export const STALE_OFFTOPIC = [
  "Missouri congressional redistricting 2026",
  "Beef Emmy Awards 2026 nominations",
  "Emmy Awards 2026 Widow's Bay nominations",
  "Widow's Bay Emmy Awards 2026",
  "Dune Messiah Oscar nominations 2027",
  "Emmy 2026 Outstanding supporting actress comedy series nominees",
  "Emmy Awards 2026 Beef nominations winners",
  "Emmy Awards 2026 Lead Actress Limited Series nominees",
  "Emmy Awards Beef Season 2 nominations 78th",
  "GRAMMY Record of the Year historical winners base rates",
  "Iowa 1st congressional district 2026 midterm",
  "Julianne Moore 2027 Academy Awards Best Actress",
  "Michigan House districts 2026 midterm",
  "Swedish election 2026 Green Party polls",
  "The Pitt Emmy nominations 2026",
  "Academy Awards Best Actress frontrunner prediction",
  "Beef Netflix Emmy Awards 2026 Season 2 nominations",
  "California House seats Democrats 2026 midterm elections",
  // From the 30-day window the bi-weekly gap analysis reads.
  "Brazil 2026 presidential election Lula polls",
  "Brazilian 2026 presidential election polling Augusto Cury third place",
];

/**
 * Verbatim GENUINE zero-result developer queries from the SAME production
 * window. These are the documentation gaps the report exists to surface.
 */
export const REAL_GAPS = [
  "CopilotKit v2 useInterrupt human in the loop AG-UI resume interrupt resolve pendingInterrupts",
  "useInterrupt resolve resume pendingInterrupts RunFinished interrupt outcome runAgent resume",
  "CopilotChatUserMessage copyButton slot props CopyButton component onClick v2 message toolbar",
  "CopilotChatAssistantMessage CopyButton copyButton slot implementation",
  "useHumanInTheLoop respond status executing complete renderAndWaitForResponse",
  "useHumanInTheLoop unmount unregister tool call response completion",
  "useHumanInTheLoop React render executing respond call exactly once Promise rejection status complete",
  "useRenderTool renderer toolCallId provide result respond resolve specific tool invocation",
  "CopilotKit React v2 subscribe AG-UI custom events hook useCoAgent event subscription customEvent",
  "injectA2UITool agents generate_a2ui tool external agent nested subagent AG-UI forwarded tools",
];

/**
 * NEAR-MISS legitimate queries: real software vocabulary that brushes against
 * the awards/election families. None may be dropped.
 */
export const NEAR_MISS_GAPS = [
  "Raft leader election polling interval configuration",
  "best practices for primary key candidate selection in the index",
  "useCoAgent state race condition on first render",
];

interface Row {
  queryText: string;
  blocked?: boolean;
  blockReason?: string | null;
  resultCount?: number;
}

async function insertRow(db: PGlite, row: Row): Promise<void> {
  const resultCount = row.resultCount ?? 0;
  await db.query(
    `INSERT INTO query_log
      (tool_name, query_text, result_count, top_score, score_kind, latency_ms,
       source_name, session_id, request_source, client_ip, user_agent,
       blocked, block_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      "search-docs",
      row.queryText,
      resultCount,
      resultCount > 0 ? 0.4 : null,
      resultCount > 0 ? "cosine" : null,
      25,
      "docs",
      "s-1",
      "user",
      "160.79.106.34",
      "Claude-User",
      row.blocked ?? false,
      row.blockReason ?? null,
    ],
  );
}

async function seed(db: PGlite): Promise<void> {
  for (const q of STALE_OFFTOPIC) await insertRow(db, { queryText: q });
  for (const q of REAL_GAPS) await insertRow(db, { queryText: q });
  for (const q of NEAR_MISS_GAPS) await insertRow(db, { queryText: q });
  // A row the blocklist DID catch at write time: already excluded today, and
  // it must stay visible in the blocked-queries panel.
  await insertRow(db, {
    queryText: "Emmy Awards 2026 red carpet winners",
    blocked: true,
    blockReason: "pattern:awards-show",
  });
  // A legitimate query that DID retrieve results — the empty list must not
  // grow a row it never had.
  await insertRow(db, {
    queryText: "how do I install copilotkit",
    resultCount: 5,
  });
}

function texts(rows: Array<{ query_text: string }>): string[] {
  return rows.map((r) => r.query_text);
}

describe("empty-result reporting re-judges history against current patterns", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.waitReady;
    await db.exec(extractAnalyticsDdl());
    __setPoolForTesting(poolFromPglite(db));
  });

  afterAll(async () => {
    __resetPoolForTesting();
    await db.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM query_log");
    await seed(db);
  });

  it("drops every stale off-topic row from the Empty-Result list", async () => {
    const rows = texts(await getEmptyQueries(30, 200));
    for (const q of STALE_OFFTOPIC) expect(rows).not.toContain(q);
  });

  it("keeps every genuine documentation gap", async () => {
    const rows = texts(await getEmptyQueries(30, 200));
    for (const q of REAL_GAPS) expect(rows).toContain(q);
    expect(rows).toHaveLength(REAL_GAPS.length + NEAR_MISS_GAPS.length);
  });

  it("keeps near-miss legitimate queries that brush the award/election families", async () => {
    const rows = texts(await getEmptyQueries(30, 200));
    for (const q of NEAR_MISS_GAPS) expect(rows).toContain(q);
  });

  it("never promotes a non-empty query into the empty list", async () => {
    const rows = texts(await getEmptyQueries(30, 200));
    expect(rows).not.toContain("how do I install copilotkit");
  });

  it("honours the caller's limit AFTER the retroactive drop", async () => {
    const rows = await getEmptyQueries(30, 5);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(STALE_OFFTOPIC).not.toContain(r.query_text);
  });

  it("leaves getBlockedQueries as the write-time record", async () => {
    const blocked = await getBlockedQueries(30);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].block_reason).toBe("pattern:awards-show");
    expect(blocked[0].hits).toBe(1);
    expect(blocked[0].sample_queries).toEqual([
      "Emmy Awards 2026 red carpet winners",
    ]);
  });

  it("leaves the summary counts untouched", async () => {
    const summary = await getAnalyticsSummary(30);
    // Every seeded row except the one non-empty query is empty, and the
    // summary counts write-time-blocked rows too (existing precedent).
    const expectedEmpty =
      STALE_OFFTOPIC.length + REAL_GAPS.length + NEAR_MISS_GAPS.length + 1;
    expect(summary.empty_result_count_window).toBe(expectedEmpty);
  });
});
