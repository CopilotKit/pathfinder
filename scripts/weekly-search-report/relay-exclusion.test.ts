/**
 * End-to-end proof that machine-relay traffic cannot reach the two PUBLISHED
 * surfaces: the weekly Notion search report and the bi-weekly gap-analysis LLM
 * prompt.
 *
 * Both scripts read the analytics JSON API with its DEFAULT audience, so the
 * exclusion lives one layer down in src/db/analytics.ts. This suite wires the
 * real readers (against PGlite) to the real renderers, because "the DB layer
 * filters it" is a claim about a different file than the one that publishes
 * the spam.
 *
 * The concrete incident: 23 SEO-spam GitHub issues were forwarded verbatim
 * into search-docs/search-code by our own triage relay, ranked in Top Queries,
 * and were on course to be rendered as full `query_text` into a Notion table
 * (weekly report, cron `7 9 * * 0`) and fed un-truncated into an LLM prompt
 * whose output is also published (gap analysis, cron `0 4 1,15 * *`).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  __setPoolForTesting,
  __resetPoolForTesting,
} from "../../src/db/client.js";
import {
  getAnalyticsSummary,
  getEmptyQueries,
  getToolBreakdown,
  getTopQueries,
  __setMachineRelayRulesForTesting,
} from "../../src/db/analytics.js";
import type { MachineRelayRule } from "../../src/types.js";
import { generatePostSchemaMigration } from "../../src/db/schema.js";
import { fetchBundle, renderMarkdown } from "./weekly-search-report.js";
import type {
  AnalyticsBundle,
  AnalyticsSummary as ReportSummary,
  EmptyQuery as ReportEmptyQuery,
  TopQuery as ReportTopQuery,
  ToolBreakdownRow,
} from "./weekly-search-report.js";
import { buildLlmPrompt } from "../gap-analysis/monthly-gap-analysis.js";
import { clusterQueries, filterSynthetic } from "../gap-analysis/cluster.js";

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

const RELAY_RULE: MachineRelayRule = {
  name: "github-issue-triage",
  reason: "CopilotKit GitHub-issue triage relay (Railway) — forwards bodies",
  user_agent: "node",
  client_ip_cidr: "152.55.176.0/20",
};

/** The shipped shape: ~3.3 KB of marketing copy carrying 13 live backlinks. */
const SPAM_BODY =
  "Why 1Rank.app Belongs in Your SEO Growth Stack. " +
  Array.from(
    { length: 13 },
    (_, i) => `Read more at https://1rank.app/blog/post-${i} and grow faster. `,
  ).join("") +
  "x".repeat(3300);

/** 7,548 chars, two links: the measured production maximum for a REAL query. */
const LONG_LEGIT_QUERY =
  "CopilotKit runtime throws GraphQLError on streaming, see https://github.com/CopilotKit/CopilotKit/issues/1 and https://docs.copilotkit.ai/troubleshooting — full trace: " +
  "at Runtime.handleRequest (dist/index.js:1:1) ".repeat(164);

async function insertRow(
  db: PGlite,
  row: {
    tool: string;
    text: string;
    results: number;
    session: string;
    ip: string;
    ua: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO query_log
       (tool_name, query_text, result_count, top_score, score_kind, latency_ms,
        source_name, session_id, request_source, client_ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,25,'docs',$6,'user',$7,$8)`,
    [
      row.tool,
      row.text,
      row.results,
      row.results > 0 ? 0.4 : null,
      row.results > 0 ? "cosine" : null,
      row.session,
      row.ip,
      row.ua,
    ],
  );
}

async function bundle(): Promise<AnalyticsBundle> {
  return {
    summary: (await getAnalyticsSummary({}, 7)) as unknown as ReportSummary,
    queries: (await getTopQueries(7, 200)) as unknown as ReportTopQuery[],
    emptyQueries: (await getEmptyQueries(
      7,
      200,
    )) as unknown as ReportEmptyQuery[],
    toolBreakdown: (await getToolBreakdown(
      7,
      {},
    )) as unknown as ToolBreakdownRow[],
  };
}

describe("published reports exclude machine-relay traffic", () => {
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
    await insertRow(db, {
      tool: "search-docs",
      text: "how do I install copilotkit",
      results: 5,
      session: "legit-1",
      ip: "3.4.5.6",
      ua: "Claude-User",
    });
    await insertRow(db, {
      tool: "search-docs",
      text: LONG_LEGIT_QUERY,
      results: 4,
      session: "legit-2",
      ip: "9.9.9.9",
      ua: "Claude-User",
    });
    for (let i = 0; i < 3; i++) {
      await insertRow(db, {
        tool: "search-docs",
        text: SPAM_BODY,
        results: 4,
        session: `relay-${i}`,
        ip: "152.55.178.126",
        ua: "node",
      });
    }
  });

  it("renders no relayed body into the weekly Notion report", async () => {
    const md = renderMarkdown(
      await bundle(),
      new Date("2026-09-13T09:07:00Z"),
      7,
    );
    expect(md).not.toContain("1rank.app");
    expect(md).not.toContain("SEO Growth Stack");
  });

  it("still renders the 7,548-char legitimate query in the weekly report", async () => {
    expect(LONG_LEGIT_QUERY.length).toBeGreaterThanOrEqual(7500);
    const md = renderMarkdown(
      await bundle(),
      new Date("2026-09-13T09:07:00Z"),
      7,
    );
    expect(md).toContain("GraphQLError on streaming");
    expect(md).toContain("how do I install copilotkit");
  });

  it("puts no relayed body into the gap-analysis LLM prompt", async () => {
    const b = await bundle();
    const rows = filterSynthetic(b.queries).map((q) => ({
      query_text: q.query_text,
      tool_name: q.tool_name,
      count: q.count,
    }));
    const prompt = buildLlmPrompt(
      {
        total_queries_window: b.summary.total_queries_window,
        empty_result_count_window: b.summary.empty_result_count_window,
        empty_result_rate_window: b.summary.empty_result_rate_window,
        queries_by_source: b.summary.queries_by_source,
      } as never,
      {
        topClusters: clusterQueries(rows),
        emptyClusters: [],
        syntheticDropped: 0,
      },
    );
    expect(prompt).not.toContain("1rank.app");
    expect(prompt).toContain("GraphQLError on streaming");
  });
});

describe("weekly report provenance line", () => {
  const base = {
    summary: {
      total_queries_window: 10,
      unique_ip_count_window: 4,
      unique_session_count_window: 5,
      empty_result_count_window: 1,
      empty_result_rate_window: 0.1,
      low_confidence_count_window: 0,
      low_confidence_rate_window: 0,
      avg_latency_ms_window: 20,
      p95_latency_ms_window: 40,
      queries_by_source: [],
      queries_per_day_window: [],
      earliest_query_day: "2026-09-06",
    } as ReportSummary,
    queries: [] as ReportTopQuery[],
    emptyQueries: [] as ReportEmptyQuery[],
    toolBreakdown: [] as ToolBreakdownRow[],
  };

  it("states what was excluded and under which rule", () => {
    const md = renderMarkdown(
      {
        ...base,
        relayExclusions: [
          {
            name: "github-issue-triage",
            reason: "relay",
            kind: "fingerprint",
            count: 46,
            last_seen: null,
          },
          {
            name: "x-pathfinder-source",
            reason: null,
            kind: "tag",
            count: 4,
            last_seen: null,
          },
        ],
      },
      new Date("2026-09-13T09:07:00Z"),
      7,
    );
    expect(md).toContain("Excluded as machine-relay traffic: 50");
    expect(md).toContain("github-issue-triage: 46");
  });

  it("omits the line entirely when nothing was excluded", () => {
    const md = renderMarkdown(
      {
        ...base,
        relayExclusions: [
          {
            name: "github-issue-triage",
            reason: "relay",
            kind: "fingerprint",
            count: 0,
            last_seen: null,
          },
        ],
      },
      new Date("2026-09-13T09:07:00Z"),
      7,
    );
    expect(md).not.toContain("Excluded as machine-relay traffic");
  });

  it("still renders when the exclusions endpoint is absent", () => {
    const md = renderMarkdown(base, new Date("2026-09-13T09:07:00Z"), 7);
    expect(md).toContain("Header metrics");
    expect(md).not.toContain("Excluded as machine-relay traffic");
  });
});

describe("fetchBundle tolerance for the exclusions endpoint", () => {
  const summary = {
    total_queries_window: 1,
    unique_ip_count_window: 1,
    unique_session_count_window: 1,
    empty_result_count_window: 0,
    empty_result_rate_window: 0,
    low_confidence_count_window: 0,
    low_confidence_rate_window: 0,
    avg_latency_ms_window: 1,
    p95_latency_ms_window: 1,
    queries_by_source: [],
    queries_per_day_window: [],
  };

  it("still returns a bundle when /relay-exclusions 404s", async () => {
    const fetchJson = async <T>(path: string): Promise<T> => {
      if (path.startsWith("/api/analytics/relay-exclusions")) {
        throw new Error("404 Not Found");
      }
      if (path.startsWith("/api/analytics/summary")) {
        return summary as unknown as T;
      }
      return [] as unknown as T;
    };
    const b = await fetchBundle({ fetchJson }, 7);
    expect(b.relayExclusions).toBeUndefined();
    expect(b.summary.total_queries_window).toBe(1);
  });

  it("carries the exclusion rows through when the endpoint answers", async () => {
    const rows = [
      {
        name: "github-issue-triage",
        reason: "relay",
        kind: "fingerprint",
        count: 46,
        last_seen: null,
      },
    ];
    const fetchJson = async <T>(path: string): Promise<T> => {
      if (path.startsWith("/api/analytics/relay-exclusions")) {
        return rows as unknown as T;
      }
      if (path.startsWith("/api/analytics/summary")) {
        return summary as unknown as T;
      }
      return [] as unknown as T;
    };
    const b = await fetchBundle({ fetchJson }, 7);
    expect(b.relayExclusions).toEqual(rows);
  });
});
