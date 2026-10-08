import { describe, it, expect, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseReportDays,
  reportPathArgFrom,
  categorizeQuery,
  categorizeQueries,
  topNQueries,
  reportWindow,
  reportTitle,
  renderMarkdown,
  type AnalyticsBundle,
  exploreBreakdown,
  searchVsExploreSplit,
  markdownToNotionBlocks,
  batchBlocks,
  NOTION_RICH_TEXT_LIMIT,
  NOTION_MAX_BLOCKS_PER_REQUEST,
  CATEGORY_TAXONOMY,
  publishNotionWithClient,
  run,
  assertValidSummary,
  buildObservations,
  buildSuccessDigest,
  clientsHeadline,
  fetchBundle,
  parseSharedClientIds,
  sanitizeCell,
  makePostSlack,
  makeFetchJson,
  type NotionClientLike,
  type RunDeps,
  type EmptyQuery,
  type AnalyticsSummary,
} from "./weekly-search-report.js";
import {
  SUMMARY_FIXTURE,
  QUERIES_FIXTURE,
  EMPTY_QUERIES_FIXTURE,
  TOOL_BREAKDOWN_FIXTURE,
} from "./fixtures.js";

// ── Test harness for run() ────────────────────────────────────────────────────
//
// run() takes injected fetch/notion/slack so the fail-loud paths are exercised
// WITHOUT the network. Each fake records whether/how it was called so we can
// assert the exact fail-loud contract: on any fetch failure, exit is non-zero,
// Slack is attempted, and Notion is NEVER called.

interface Recorder {
  deps: RunDeps;
  notionCalls: Array<{ title: string; markdown: string }>;
  slackCalls: string[];
  successCalls: string[];
  exitCodes: number[];
  fetchedPaths: string[];
  writtenReports: Array<{ path: string; markdown: string }>;
}

function makeRecorder(
  overrides: Partial<{
    token: string;
    fetchJson: RunDeps["fetchJson"];
    publishNotion: RunDeps["publishNotion"];
    writeReport: RunDeps["writeReport"];
  }> = {},
): Recorder {
  const notionCalls: Array<{ title: string; markdown: string }> = [];
  const slackCalls: string[] = [];
  const successCalls: string[] = [];
  const exitCodes: number[] = [];
  const fetchedPaths: string[] = [];
  const writtenReports: Array<{ path: string; markdown: string }> = [];

  const deps: RunDeps = {
    env: {
      PATHFINDER_ANALYTICS_TOKEN: overrides.token ?? "tok-123",
      NOTION_TOKEN: "notion-tok",
      NOTION_PARENT_PAGE_ID: "parent-123",
      SLACK_WEBHOOK: "https://slack.example/webhook",
      ANALYTICS_BASE_URL: "https://mcp.example",
      REPORT_DAYS: "7",
    },
    argv: ["node", "script"],
    fetchJson:
      overrides.fetchJson ??
      (async <T>(path: string): Promise<T> => {
        fetchedPaths.push(path);
        if (path.includes("/summary")) return SUMMARY_FIXTURE as unknown as T;
        if (path.includes("/tool-breakdown"))
          return TOOL_BREAKDOWN_FIXTURE as unknown as T;
        if (path.includes("/empty-queries"))
          return EMPTY_QUERIES_FIXTURE as unknown as T;
        if (path.includes("/queries")) return QUERIES_FIXTURE as unknown as T;
        throw new Error(`unexpected path ${path}`);
      }),
    publishNotion:
      overrides.publishNotion ??
      (async (title: string, markdown: string) => {
        notionCalls.push({ title, markdown });
        return "https://notion.example/page";
      }),
    postSlack: async (text: string) => {
      slackCalls.push(text);
    },
    postSuccess: async (text: string) => {
      successCalls.push(text);
    },
    writeReport:
      overrides.writeReport ??
      ((path: string, markdown: string) => {
        writtenReports.push({ path, markdown });
        // Default does the REAL write so the on-disk --report test still
        // exercises mkdir + writeFileSync; override to simulate a write failure.
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, markdown, "utf-8");
      }),
    exit: (code: number) => {
      exitCodes.push(code);
      // Throw to abort the run the way process.exit would terminate it, so the
      // code after a fail-loud exit() does not keep running in the test.
      throw new Error(`__EXIT__${code}`);
    },
    log: () => {},
    error: () => {},
  };

  return {
    deps,
    notionCalls,
    slackCalls,
    successCalls,
    exitCodes,
    fetchedPaths,
    writtenReports,
  };
}

async function runCatchingExit(deps: RunDeps): Promise<void> {
  try {
    await run(deps);
  } catch (err) {
    if (!String(err).includes("__EXIT__")) throw err;
  }
}

// ── FAIL-LOUD regression tests (the 2026-06-21 silent-error-page failure) ─────

describe("fail-loud: missing token", () => {
  it("exits non-zero, attempts Slack, and NEVER publishes Notion when the token is missing", async () => {
    const rec = makeRecorder({ token: "" });
    await runCatchingExit(rec.deps);

    expect(rec.exitCodes).toContain(1);
    // Slack alert attempted with a greppable failure reason.
    expect(rec.slackCalls.length).toBeGreaterThan(0);
    expect(rec.slackCalls[0]).toMatch(/FAILED/i);
    // The anti-pattern being removed: NO degraded/error Notion page.
    expect(rec.notionCalls).toHaveLength(0);
  });

  it("does not even attempt a fetch when the token is missing", async () => {
    const rec = makeRecorder({ token: "" });
    await runCatchingExit(rec.deps);
    expect(rec.fetchedPaths).toHaveLength(0);
  });
});

describe("fail-loud: a required endpoint returns non-2xx", () => {
  it("exits non-zero, attempts Slack, and NEVER publishes Notion on a 500", async () => {
    const rec = makeRecorder({
      fetchJson: async <T>(path: string): Promise<T> => {
        if (path.includes("/tool-breakdown")) {
          throw new Error(
            "Analytics fetch failed: 500 Internal Server Error for /api/analytics/tool-breakdown",
          );
        }
        if (path.includes("/summary")) return SUMMARY_FIXTURE as unknown as T;
        if (path.includes("/empty-queries"))
          return EMPTY_QUERIES_FIXTURE as unknown as T;
        if (path.includes("/queries")) return QUERIES_FIXTURE as unknown as T;
        throw new Error(`unexpected path ${path}`);
      },
    });
    await runCatchingExit(rec.deps);

    expect(rec.exitCodes).toContain(1);
    expect(rec.slackCalls.length).toBeGreaterThan(0);
    expect(rec.slackCalls[0]).toMatch(/FAILED/i);
    expect(rec.notionCalls).toHaveLength(0);
  });
});

describe("fail-loud: malformed payload", () => {
  it("exits non-zero, attempts Slack, and NEVER publishes Notion when summary is malformed", async () => {
    const rec = makeRecorder({
      fetchJson: async <T>(path: string): Promise<T> => {
        if (path.includes("/summary")) {
          // Missing required numeric fields → malformed.
          return { not: "a summary" } as unknown as T;
        }
        if (path.includes("/tool-breakdown"))
          return TOOL_BREAKDOWN_FIXTURE as unknown as T;
        if (path.includes("/empty-queries"))
          return EMPTY_QUERIES_FIXTURE as unknown as T;
        if (path.includes("/queries")) return QUERIES_FIXTURE as unknown as T;
        throw new Error(`unexpected path ${path}`);
      },
    });
    await runCatchingExit(rec.deps);

    expect(rec.exitCodes).toContain(1);
    expect(rec.slackCalls.length).toBeGreaterThan(0);
    expect(rec.notionCalls).toHaveLength(0);
  });

  it("treats a non-array /queries payload as malformed", async () => {
    const rec = makeRecorder({
      fetchJson: async <T>(path: string): Promise<T> => {
        if (path.includes("/summary")) return SUMMARY_FIXTURE as unknown as T;
        if (path.includes("/tool-breakdown"))
          return TOOL_BREAKDOWN_FIXTURE as unknown as T;
        if (path.includes("/empty-queries"))
          return EMPTY_QUERIES_FIXTURE as unknown as T;
        if (path.includes("/queries")) return { oops: true } as unknown as T; // not an array
        throw new Error(`unexpected path ${path}`);
      },
    });
    await runCatchingExit(rec.deps);
    expect(rec.exitCodes).toContain(1);
    expect(rec.notionCalls).toHaveLength(0);
  });

  it("throws when a queries_per_day_window row is missing count", () => {
    const bad = {
      ...SUMMARY_FIXTURE,
      queries_per_day_window: [{ day: "2026-06-15" }], // missing count
    };
    expect(() => assertValidSummary(bad)).toThrow(/queries_per_day_window/);
  });

  it("exits non-zero and NEVER publishes Notion when a /tool-breakdown row is missing count", async () => {
    const rec = makeRecorder({
      fetchJson: async <T>(path: string): Promise<T> => {
        if (path.includes("/summary")) return SUMMARY_FIXTURE as unknown as T;
        if (path.includes("/tool-breakdown"))
          return [{ tool_name: "search-docs" }] as unknown as T; // missing count
        if (path.includes("/empty-queries"))
          return EMPTY_QUERIES_FIXTURE as unknown as T;
        if (path.includes("/queries")) return QUERIES_FIXTURE as unknown as T;
        throw new Error(`unexpected path ${path}`);
      },
    });
    await runCatchingExit(rec.deps);
    expect(rec.exitCodes).toContain(1);
    expect(rec.slackCalls.length).toBeGreaterThan(0);
    expect(rec.notionCalls).toHaveLength(0);
  });
});

describe("fail-loud: Notion publish failure after a successful fetch", () => {
  it("exits non-zero and attempts Slack when publishNotion throws", async () => {
    const rec = makeRecorder({
      publishNotion: async () => {
        throw new Error("Notion 502");
      },
    });
    await runCatchingExit(rec.deps);
    expect(rec.exitCodes).toContain(1);
    expect(rec.slackCalls.length).toBeGreaterThan(0);
  });
});

describe("fail-loud: --report artifact write failure", () => {
  it("exits non-zero, attempts Slack, and NEVER publishes Notion when the --report write throws", async () => {
    const rec = makeRecorder({
      writeReport: () => {
        throw new Error("EACCES: permission denied writing /tmp/x.md");
      },
    });
    rec.deps.argv = ["node", "script", "--report", "/tmp/x.md"];
    await runCatchingExit(rec.deps);

    expect(rec.exitCodes).toContain(1);
    // Slack alert attempted with a greppable failure reason.
    expect(rec.slackCalls.length).toBeGreaterThan(0);
    expect(rec.slackCalls[0]).toMatch(/FAILED/i);
    // The whole point of fail-loud symmetry: a write failure must NOT continue
    // on to publish a Notion page.
    expect(rec.notionCalls).toHaveLength(0);
  });
});

// ── Happy path: a full successful run publishes exactly one Notion page ───────

describe("happy path", () => {
  it("fetches all four endpoints and publishes one Notion page (no Slack, no non-zero exit)", async () => {
    const rec = makeRecorder();
    await runCatchingExit(rec.deps);

    expect(rec.fetchedPaths.some((p) => p.includes("/summary"))).toBe(true);
    expect(rec.fetchedPaths.some((p) => p.includes("/queries"))).toBe(true);
    expect(rec.fetchedPaths.some((p) => p.includes("/empty-queries"))).toBe(
      true,
    );
    expect(rec.fetchedPaths.some((p) => p.includes("/tool-breakdown"))).toBe(
      true,
    );
    expect(rec.notionCalls).toHaveLength(1);
    expect(rec.slackCalls).toHaveLength(0);
    expect(rec.exitCodes).not.toContain(1);
    // The title is window-accurate: a true Mon–Sun calendar-week run renders
    // "Week of <Monday>", otherwise "N days ending <end>". run() uses the real
    // run-instant, so accept either valid form rather than assuming the day.
    expect(rec.notionCalls[0].title).toMatch(
      /^Pathfinder Search Query Report — (Week of \d{4}-\d{2}-\d{2}|\d+ days ending \d{4}-\d{2}-\d{2})$/,
    );
  });

  it("writes the rendered markdown to disk when --report <path> is supplied", async () => {
    const { mkdtempSync, existsSync, readFileSync, rmSync } =
      await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "weekly-report-"));
    const reportPath = join(dir, "weekly.md");
    try {
      const rec = makeRecorder();
      rec.deps.argv = ["node", "script", "--report", reportPath];
      await runCatchingExit(rec.deps);
      expect(existsSync(reportPath)).toBe(true);
      const md = readFileSync(reportPath, "utf-8");
      expect(md).toContain("Pathfinder Search Query Report");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── success ping → #engr (digest with a [report] mrkdwn link) ────────────────--
//
// On a fully successful run, AFTER publishNotion returns the page url, the
// script posts ONE success digest to the SEPARATE #engr webhook (postSuccess),
// while the FAILURE poster (postSlack → #oss-alerts) is never touched. The
// digest carries the headline numbers and renders the Notion link as an
// `<url|report>` mrkdwn hyperlink (a "[report]" link, NOT a bare url).

describe("success ping → #engr", () => {
  it("posts exactly one success digest with the headline numbers and a <url|report> mrkdwn link; never touches the failure poster", async () => {
    const rec = makeRecorder();
    await runCatchingExit(rec.deps);

    // Exactly one success ping; the failure poster is untouched.
    expect(rec.successCalls).toHaveLength(1);
    expect(rec.slackCalls).toHaveLength(0);
    expect(rec.exitCodes).not.toContain(1);

    const msg = rec.successCalls[0];
    // Headline numbers from SUMMARY_FIXTURE (1234 tool calls, 87 IPs, 7.8% empty).
    expect(msg).toContain("1234");
    expect(msg).toContain("87");
    expect(msg).toContain("7.8%");
    // Top category for the fixture is Agents/CoAgents/AG-UI (CoAgents 50 + ag-ui 25).
    expect(msg).toContain("Agents/CoAgents/AG-UI");
    // The link is rendered as an <url|report> mrkdwn hyperlink, NOT a bare url.
    expect(msg).toContain("https://notion.example/page");
    expect(msg).toContain("|report>");
    expect(msg).toContain("<https://notion.example/page|report>");
    expect(msg).not.toContain(" https://notion.example/page ");
  });

  it("does NOT post a success ping and DOES post the failure alert on a fetch failure (fail-loud unchanged)", async () => {
    const rec = makeRecorder({
      fetchJson: async <T>(path: string): Promise<T> => {
        if (path.includes("/tool-breakdown")) {
          throw new Error(
            "Analytics fetch failed: 500 Internal Server Error for /api/analytics/tool-breakdown",
          );
        }
        if (path.includes("/summary")) return SUMMARY_FIXTURE as unknown as T;
        if (path.includes("/empty-queries"))
          return EMPTY_QUERIES_FIXTURE as unknown as T;
        if (path.includes("/queries")) return QUERIES_FIXTURE as unknown as T;
        throw new Error(`unexpected path ${path}`);
      },
    });
    await runCatchingExit(rec.deps);

    // Fail-loud: failure poster fires, success poster does not.
    expect(rec.successCalls).toHaveLength(0);
    expect(rec.slackCalls.length).toBeGreaterThan(0);
    expect(rec.slackCalls[0]).toMatch(/FAILED/i);
    expect(rec.exitCodes).toContain(1);
  });

  it("posts a no-link '(report published)' digest when publishNotion returns null", async () => {
    const rec = makeRecorder({ publishNotion: async () => null });
    await runCatchingExit(rec.deps);

    expect(rec.successCalls).toHaveLength(1);
    expect(rec.slackCalls).toHaveLength(0);
    const msg = rec.successCalls[0];
    expect(msg).toContain("(report published)");
    expect(msg).not.toContain("|report>");
  });

  it("the success poster no-ops (never throws) when its webhook env is unset", async () => {
    // The success poster mirrors makePostSlack: an unset webhook is a logged
    // no-op, never a throw. Posting must resolve without error.
    const post = makePostSlack("");
    await expect(post("anything")).resolves.toBeUndefined();
  });
});

// ── parseReportDays ───────────────────────────────────────────────────────────

describe("parseReportDays", () => {
  it("defaults to 7 when unset or empty", () => {
    expect(parseReportDays(undefined)).toBe(7);
    expect(parseReportDays("")).toBe(7);
  });

  it("parses a valid positive integer", () => {
    expect(parseReportDays("14")).toBe(14);
  });

  it("falls back to 7 on junk / fractional / non-positive", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseReportDays("7.5")).toBe(7);
    expect(parseReportDays("-3")).toBe(7);
    expect(parseReportDays("0")).toBe(7);
    expect(parseReportDays("abc")).toBe(7);
    warn.mockRestore();
  });
});

// ── reportPathArgFrom ───────────────────────────────────────────────────────--

describe("reportPathArgFrom", () => {
  it("returns the resolved path for a normal value", () => {
    const r = reportPathArgFrom(["node", "s", "--report", "/tmp/x.md"]);
    expect(r).not.toBeNull();
    expect(r!.endsWith("/tmp/x.md")).toBe(true);
  });

  it("returns null when --report is absent or followed by a flag", () => {
    expect(reportPathArgFrom(["node", "s"])).toBeNull();
    expect(reportPathArgFrom(["node", "s", "--report"])).toBeNull();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(reportPathArgFrom(["node", "s", "--report", "--dry"])).toBeNull();
    warn.mockRestore();
  });
});

// ── reportWindow / reportTitle ────────────────────────────────────────────────
//
// reportWindow is the single source of truth for the data window; it must match
// the server's buildDateWindow (src/db/analytics.ts) for a ?days=N rolling
// request EXACTLY: an inclusive N-UTC-calendar-day window [today-(N-1) .. today].
// end = UTC date of `now`; start = end - (days - 1). A "calendar week" is only a
// true Mon(start)–Sun(end) span.

describe("reportWindow", () => {
  it("derives an inclusive N-calendar-day window: start = end - (days - 1), not now - days", () => {
    // 2026-06-21 is a Sunday. days=7 → start = 06-21 - 6 = Mon 06-15.
    const w7 = reportWindow(new Date("2026-06-21T09:07:00Z"), 7);
    expect(w7.end).toBe("2026-06-21");
    expect(w7.start).toBe("2026-06-15");
    expect(w7.isCalendarWeek).toBe(true);

    // days=14 → start = 06-21 - 13 = 06-08 (NOT 06-07, the now-days off-by-one).
    const w14 = reportWindow(new Date("2026-06-21T09:07:00Z"), 14);
    expect(w14.end).toBe("2026-06-21");
    expect(w14.start).toBe("2026-06-08");
    expect(w14.isCalendarWeek).toBe(false);
  });

  it("treats a NON-Sunday 7-day run as NOT a calendar week", () => {
    // 2026-06-22 is a Monday → a 7-day window ending here is Tue..Mon, not Mon..Sun.
    const w = reportWindow(new Date("2026-06-22T09:07:00Z"), 7);
    expect(w.end).toBe("2026-06-22");
    expect(w.start).toBe("2026-06-16");
    expect(w.isCalendarWeek).toBe(false);
  });
});

describe("reportTitle", () => {
  it("formats the title with the Monday of the window for a true Mon–Sun week", () => {
    expect(reportTitle(new Date("2026-06-21T09:07:00Z"), 7)).toBe(
      "Pathfinder Search Query Report — Week of 2026-06-15",
    );
  });

  it("uses the explicit N-days-ending framing for a non-7-day window", () => {
    const title = reportTitle(new Date("2026-06-21T09:07:00Z"), 14);
    expect(title).not.toContain("Week of");
    expect(title).toBe(
      "Pathfinder Search Query Report — 14 days ending 2026-06-21",
    );
  });

  it("uses the N-days-ending framing for a 7-day run on a NON-Sunday (not a calendar week)", () => {
    // 2026-06-22 is a Monday — a 7-day window here is not Mon–Sun.
    const title = reportTitle(new Date("2026-06-22T09:07:00Z"), 7);
    expect(title).not.toContain("Week of");
    expect(title).toBe(
      "Pathfinder Search Query Report — 7 days ending 2026-06-22",
    );
  });
});

describe("renderMarkdown window banner", () => {
  const bundle: AnalyticsBundle = {
    summary: SUMMARY_FIXTURE,
    queries: QUERIES_FIXTURE,
    emptyQueries: EMPTY_QUERIES_FIXTURE,
    toolBreakdown: TOOL_BREAKDOWN_FIXTURE,
  };

  it("renders a calendar-week banner+title for the default 7-day window on a Sunday", () => {
    const md = renderMarkdown(bundle, new Date("2026-06-21T09:07:00Z"), 7);
    // Banner shows the true Mon–Sun calendar span and the (week of <Monday>) tag.
    expect(md).toContain("Window: 7 days (2026-06-15 – 2026-06-21)");
    expect(md).toContain("(week of 2026-06-15)");
    // The H1 title agrees: the canonical "Week of <Monday>" phrasing.
    expect(md).toContain(
      "# Pathfinder Search Query Report — Week of 2026-06-15",
    );
  });

  it("renders the corrected (off-by-one-free) span for a 14-day window — start = end - 13", () => {
    const md = renderMarkdown(bundle, new Date("2026-06-21T09:07:00Z"), 14);
    // start = 06-21 - 13 = 06-08 (NOT 06-07 from the old now-days math).
    expect(md).toContain("Window: 14 days (2026-06-08 – 2026-06-21)");
    expect(md).not.toContain("2026-06-07");
    // Neither banner nor title claims a week.
    expect(md).not.toContain("week of");
    expect(md).not.toContain("Week of");
    expect(md).toContain(
      "# Pathfinder Search Query Report — 14 days ending 2026-06-21",
    );
  });

  it("does NOT print 'Week of' for a 7-day run on a NON-Sunday (not a calendar week)", () => {
    // 2026-06-22 is a Monday: the 7-day window ending here is Tue..Mon, not Mon..Sun.
    const md = renderMarkdown(bundle, new Date("2026-06-22T09:07:00Z"), 7);
    expect(md).toContain("Window: 7 days (2026-06-16 – 2026-06-22)");
    expect(md).not.toContain("week of");
    expect(md).not.toContain("Week of");
    // It renders the N-day-ending form instead.
    expect(md).toContain(
      "# Pathfinder Search Query Report — 7 days ending 2026-06-22",
    );
  });
});

// ── categorization (deterministic taxonomy bucketing) ─────────────────────────

describe("categorizeQuery", () => {
  it("buckets known phrases into their taxonomy category", () => {
    expect(categorizeQuery("how to use CoAgents with LangGraph")).toBe(
      "Agents/CoAgents/AG-UI",
    );
    expect(categorizeQuery("CopilotKit runtime backend setup")).toBe(
      "Runtime/Backend",
    );
    expect(categorizeQuery("useCopilotAction frontend tool example")).toBe(
      "Actions/Frontend tools",
    );
    expect(categorizeQuery("how to theme the chat ui with css")).toBe(
      "Theming/CSS",
    );
    expect(categorizeQuery("v2 migration useCopilotChat hook")).toBe(
      "v2 Migration/Hooks",
    );
    expect(categorizeQuery("human in the loop interrupt approval")).toBe(
      "Human-in-the-loop",
    );
    expect(categorizeQuery("MCP middleware configuration")).toBe(
      "MCP/Middleware",
    );
    expect(categorizeQuery("generative ui rendering custom component")).toBe(
      "Generative UI/Rendering",
    );
    expect(categorizeQuery("streaming events tool call output")).toBe(
      "Streaming/Events",
    );
    expect(categorizeQuery("getting started quickstart install")).toBe(
      "Getting started/Setup",
    );
  });

  it("falls back to Other for an unmatched query", () => {
    expect(categorizeQuery("something completely unrelated and weird")).toBe(
      "Other",
    );
  });

  it("is case-insensitive", () => {
    expect(categorizeQuery("COAGENTS langgraph")).toBe("Agents/CoAgents/AG-UI");
  });

  it("every taxonomy bucket name is a valid category (Other always present)", () => {
    const names = CATEGORY_TAXONOMY.map((c) => c.category);
    expect(names).toContain("Other");
  });
});

describe("categorizeQueries (aggregation by frequency-weighted count)", () => {
  it("sums query counts into their categories, sorted by count desc", () => {
    const cats = categorizeQueries(QUERIES_FIXTURE);
    // Highest single category in the fixture should appear first.
    expect(cats.length).toBeGreaterThan(0);
    for (let i = 1; i < cats.length; i++) {
      expect(cats[i - 1].count).toBeGreaterThanOrEqual(cats[i].count);
    }
    // The unrelated query (count 3) lands in Other.
    const other = cats.find((c) => c.category === "Other");
    expect(other).toBeDefined();
    expect(other!.count).toBe(3);
  });
});

// ── topNQueries (top-20 ordering by frequency) ────────────────────────────────

describe("topNQueries", () => {
  it("returns queries sorted by count desc, capped at N", () => {
    const top = topNQueries(QUERIES_FIXTURE, 5);
    expect(top).toHaveLength(5);
    for (let i = 1; i < top.length; i++) {
      expect(top[i - 1].count).toBeGreaterThanOrEqual(top[i].count);
    }
    expect(top[0].query_text).toBe("how to use CoAgents with LangGraph");
  });

  it("does not mutate the input array", () => {
    const copy = [...QUERIES_FIXTURE];
    topNQueries(QUERIES_FIXTURE, 3);
    expect(QUERIES_FIXTURE).toEqual(copy);
  });
});

// ── tool breakdown helpers ────────────────────────────────────────────────────

describe("exploreBreakdown / searchVsExploreSplit", () => {
  it("extracts only explore-* rows for the explore breakdown", () => {
    const explore = exploreBreakdown(TOOL_BREAKDOWN_FIXTURE);
    expect(explore.map((r) => r.tool_name)).toEqual([
      "explore-bash",
      "explore-grep",
    ]);
  });

  it("splits total counts into search vs explore by name prefix", () => {
    const split = searchVsExploreSplit(TOOL_BREAKDOWN_FIXTURE);
    // search-docs 700 + search-code 300 + search-ag-ui-docs 120 = 1120
    expect(split.search).toBe(1120);
    // explore-bash 80 + explore-grep 34 = 114
    expect(split.explore).toBe(114);
  });
});

// ── cell rendering safety (nullable source_name + sanitizeCell hardening) ─────

describe("cell rendering safety", () => {
  it("renders a null source_name as a safe cell, not the literal string 'null'", () => {
    const emptyQueries: EmptyQuery[] = [
      {
        query_text: "some query with no source",
        tool_name: "search-docs",
        source_name: null,
        count: 7,
        last_seen: "2026-06-21T10:00:00Z",
      },
    ];
    const bundle: AnalyticsBundle = {
      summary: SUMMARY_FIXTURE,
      queries: QUERIES_FIXTURE,
      emptyQueries,
      toolBreakdown: TOOL_BREAKDOWN_FIXTURE,
    };
    const md = renderMarkdown(bundle, new Date("2026-06-21T09:07:00Z"), 7);
    // The NULL source must NOT publish the literal text "null" into the cell.
    expect(md).not.toContain("| null |");
    // The query row is still rendered (with an empty/(none) source cell).
    expect(md).toContain("some query with no source");
  });

  it("sanitizeCell neutralizes \\r and \\r\\n (no raw carriage returns survive)", () => {
    const out = sanitizeCell("a\r\nb\rc");
    expect(out).not.toContain("\r");
    expect(out).not.toContain("\n");
  });

  it("sanitizeCell escapes pipes in a source-style value", () => {
    expect(sanitizeCell("foo|bar")).toBe("foo\\|bar");
  });

  it("buildObservations does not split an empty-query observation across lines on a newline in query_text", () => {
    const emptyQueries: EmptyQuery[] = [
      {
        query_text: "line one\nline two",
        tool_name: "search-docs",
        source_name: "claude-code",
        count: 99,
        last_seen: "2026-06-21T10:00:00Z",
      },
    ];
    const bundle: AnalyticsBundle = {
      summary: SUMMARY_FIXTURE,
      queries: QUERIES_FIXTURE,
      emptyQueries,
      toolBreakdown: TOOL_BREAKDOWN_FIXTURE,
    };
    const obs = buildObservations(bundle);
    const emptyObs = obs.find((o) =>
      o.includes("Highest-frequency empty query"),
    );
    expect(emptyObs).toBeDefined();
    // A newline in query_text must not split the single observation into 2 lines.
    expect(emptyObs!).not.toContain("\n");
  });

  // ── A2: observation bullets must render a literal pipe, never `\|` ──────────
  //
  // Observations become Notion bulleted_list_item blocks, whose block path does
  // NOT unescape `\|` (only the table-cell path does). So a `|` in an
  // observation's source text must NOT be markdown-pipe-escaped, or the Notion
  // bullet shows the literal backslash. The bullet must carry a real `|`.
  it("renders a literal pipe (not \\|) in an observation bullet block when query_text contains a pipe", () => {
    const emptyQueries: EmptyQuery[] = [
      {
        query_text: "a | b pipe query",
        tool_name: "search-docs",
        source_name: "claude-code",
        count: 99,
        last_seen: "2026-06-21T10:00:00Z",
      },
    ];
    const bundle: AnalyticsBundle = {
      summary: SUMMARY_FIXTURE,
      queries: QUERIES_FIXTURE,
      emptyQueries,
      toolBreakdown: TOOL_BREAKDOWN_FIXTURE,
    };
    const md = renderMarkdown(bundle, new Date("2026-06-21T09:07:00Z"), 7);
    const blocks = markdownToNotionBlocks(md);
    const bullet = blocks.find(
      (b) =>
        b.type === "bulleted_list_item" &&
        blockText(b).includes("Highest-frequency empty query"),
    );
    expect(bullet).toBeDefined();
    // The produced Notion bullet must carry a real pipe, never the escaped form.
    expect(blockText(bullet!)).toContain("a | b");
    expect(blockText(bullet!)).not.toContain("\\|");
  });

  // ── A5: the Top-20 table must escape tool_name like every other text cell ──
  it("escapes a pipe in a Top-20 row tool_name so the row cannot be corrupted", () => {
    const queries = [
      {
        query_text: "frequent query",
        tool_name: "search|weird",
        count: 9999,
        avg_result_count: null,
        avg_top_score: null,
      },
    ];
    const bundle: AnalyticsBundle = {
      summary: SUMMARY_FIXTURE,
      queries,
      emptyQueries: EMPTY_QUERIES_FIXTURE,
      toolBreakdown: TOOL_BREAKDOWN_FIXTURE,
    };
    const md = renderMarkdown(bundle, new Date("2026-06-21T09:07:00Z"), 7);
    // The raw tool_name pipe must be escaped in the markdown table source so it
    // does not split the row into an extra column.
    expect(md).toContain("search\\|weird");
    expect(md).not.toContain("| search|weird |");
    // And the rendered Notion table cell unescapes back to a literal pipe.
    const table = markdownToNotionBlocks(md).find(
      (b) =>
        b.type === "table" &&
        ((b as any).table.children[0].table_row.cells[0][0]?.text?.content ??
          "") === "Query",
    ) as any;
    expect(table).toBeDefined();
    const toolCell = table.table.children[1].table_row.cells[1]
      .map((rt: any) => rt.text.content)
      .join("");
    expect(toolCell).toBe("search|weird");
  });
});

// ── markdownToNotionBlocks / batchBlocks (reused renderer parity) ──────────────

function blockText(block: any): string {
  const rich = block[block.type]?.rich_text ?? [];
  return rich.map((r: any) => r.text.content).join("");
}

function firstCellText(row: any): string {
  return row.table_row.cells[0].map((r: any) => r.text.content).join("");
}

describe("markdownToNotionBlocks", () => {
  it("maps headings and bullets to native block types and drops the leading title H1", () => {
    const md = [
      "# Pathfinder Search Query Report — Week of 2026-06-15",
      "",
      "## Summary",
      "- Total tool calls: 5",
      "### Sub",
      "plain prose",
    ].join("\n");
    const blocks = markdownToNotionBlocks(md);
    expect(blocks.some((b) => b.type === "heading_1")).toBe(false);
    expect(blocks.map((b) => b.type)).toEqual([
      "heading_2",
      "bulleted_list_item",
      "heading_3",
      "paragraph",
    ]);
    expect(blockText(blocks[0])).toBe("Summary");
  });

  it("splits a line over the 2000-char cap across rich_text objects", () => {
    const longLine = "x".repeat(NOTION_RICH_TEXT_LIMIT * 2 + 5);
    const blocks = markdownToNotionBlocks(longLine);
    const rich = (blocks[0] as any).paragraph.rich_text;
    expect(rich.length).toBeGreaterThan(1);
    for (const r of rich) {
      expect(r.text.content.length).toBeLessThanOrEqual(NOTION_RICH_TEXT_LIMIT);
    }
    expect(rich.map((r: any) => r.text.content).join("")).toBe(longLine);
  });

  it("renders a markdown table as a native Notion table block (not pipe-text paragraphs)", () => {
    const md = [
      "## Activity by day",
      "| Day | Tool calls |",
      "| --- | --- |",
      "| 2026-06-15 | 12 |",
      "| 2026-06-16 | 8 |",
    ].join("\n");
    const blocks = markdownToNotionBlocks(md);

    // No paragraph block should carry the raw pipe text.
    expect(
      blocks.some((b) => b.type === "paragraph" && blockText(b).includes("|")),
    ).toBe(false);

    const table = blocks.find((b) => b.type === "table") as any;
    expect(table).toBeDefined();
    expect(table.table.table_width).toBe(2);
    expect(table.table.has_column_header).toBe(true);
    // header + 2 data rows (separator row dropped).
    const rows = table.table.children;
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.type).toBe("table_row");
      expect(r.table_row.cells.length).toBe(2);
    }
    const cellText = (row: any, col: number): string =>
      row.table_row.cells[col].map((rt: any) => rt.text.content).join("");
    expect(cellText(rows[0], 0)).toBe("Day");
    expect(cellText(rows[0], 1)).toBe("Tool calls");
    expect(cellText(rows[1], 0)).toBe("2026-06-15");
    expect(cellText(rows[1], 1)).toBe("12");
    expect(cellText(rows[2], 0)).toBe("2026-06-16");
    expect(cellText(rows[2], 1)).toBe("8");
  });

  it("unescapes markdown-escaped pipes in table cells", () => {
    const md = ["| Query | Count |", "| --- | --- |", "| a \\| b | 3 |"].join(
      "\n",
    );
    const table = markdownToNotionBlocks(md).find(
      (b) => b.type === "table",
    ) as any;
    const content = table.table.children[1].table_row.cells[0][0].text.content;
    expect(content).toBe("a | b");
  });

  it("caps a table at 99 data rows (100 children with header) and appends a truncation note", () => {
    const lines = ["| Day | Count |", "| --- | --- |"];
    for (let i = 0; i < 150; i++) lines.push(`| d${i} | ${i} |`);
    const blocks = markdownToNotionBlocks(lines.join("\n"));
    const table = blocks.find((b) => b.type === "table") as any;
    // header + 99 data rows = Notion's 100-children cap
    expect(table.table.children.length).toBe(100);
    const note = blocks.find(
      (b) => b.type === "paragraph" && blockText(b).includes("truncated"),
    );
    expect(note).toBeDefined();
    expect(blockText(note!)).toBe("(table truncated to first 99 rows of 150)");
  });

  function tableOf(dataRows: number): string {
    const lines = ["| Day | Count |", "| --- | --- |"];
    for (let i = 0; i < dataRows; i++) lines.push(`| d${i} | ${i} |`);
    return lines.join("\n");
  }

  it("keeps a table of exactly 99 data rows whole, with no truncation note", () => {
    const blocks = markdownToNotionBlocks(tableOf(99));
    const tables = blocks.filter((b) => b.type === "table") as any[];
    expect(tables).toHaveLength(1);
    expect(tables[0].table.children.length).toBe(100);
    expect(firstCellText(tables[0].table.children[99])).toBe("d98");
    expect(blocks.some((b) => blockText(b).includes("truncated"))).toBe(false);
  });

  it("truncates a table of exactly 100 data rows to 99 and notes it", () => {
    const blocks = markdownToNotionBlocks(tableOf(100));
    const tables = blocks.filter((b) => b.type === "table") as any[];
    expect(tables).toHaveLength(1);
    expect(tables[0].table.children.length).toBe(100);
    const notes = blocks.filter((b) => blockText(b).includes("truncated"));
    expect(notes.map(blockText)).toEqual([
      "(table truncated to first 99 rows of 100)",
    ]);
  });
});

describe("publishNotionWithClient: Notion 100-children cap", () => {
  // Notion rejects any single request whose children array (at any nesting
  // level, including a table block's table_row children) exceeds 100 entries.
  function maxChildren(node: unknown): number {
    if (Array.isArray(node)) {
      return node.reduce((m: number, n) => Math.max(m, maxChildren(n)), 0);
    }
    if (node === null || typeof node !== "object") return 0;
    let max = 0;
    for (const [key, value] of Object.entries(node)) {
      if (key === "children" && Array.isArray(value)) {
        max = Math.max(max, value.length);
      }
      max = Math.max(max, maxChildren(value));
    }
    return max;
  }

  it("never sends a request with more than 100 children for a max-size table", async () => {
    const lines = ["# Title", "| Day | Count |", "| --- | --- |"];
    for (let i = 0; i < 150; i++) lines.push(`| d${i} | ${i} |`);
    const requests: unknown[] = [];
    const client: NotionClientLike = {
      pages: {
        create: async (args) => {
          requests.push(args);
          return { id: "page-cap", url: "https://notion.example/page-cap" };
        },
        update: async () => ({}),
      },
      blocks: {
        children: {
          append: async (args) => {
            requests.push(args);
            return {};
          },
        },
      },
    };
    await publishNotionWithClient(client, "parent", "Title", lines.join("\n"));
    expect(requests.length).toBeGreaterThan(0);
    for (const req of requests) {
      expect(maxChildren(req)).toBeLessThanOrEqual(
        NOTION_MAX_BLOCKS_PER_REQUEST,
      );
    }
    // The table must actually be sent, full to the cap: header + 99 rows.
    const sent = requests.flatMap(
      (req) => (req as { children?: any[] }).children ?? [],
    );
    const tables = sent.filter((b) => b.type === "table");
    expect(tables).toHaveLength(1);
    expect(tables[0].table.children.length).toBe(100);
    expect(firstCellText(tables[0].table.children[0])).toBe("Day");
    expect(
      sent.filter((b) => blockText(b).includes("truncated")).map(blockText),
    ).toEqual(["(table truncated to first 99 rows of 150)"]);
  });
});

describe("batchBlocks", () => {
  it("splits >100 blocks into batches of at most 100", () => {
    expect(NOTION_MAX_BLOCKS_PER_REQUEST).toBe(100);
    const blocks = Array.from({ length: 250 }, (_, i) => ({ id: i }));
    const batches = batchBlocks(blocks, NOTION_MAX_BLOCKS_PER_REQUEST);
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(batches.flat()).toEqual(blocks);
  });
});

// ── Notion publish: partial-page archive on multi-batch append failure ────────
//
// Notion has no transactional multi-batch create: the page is created with the
// first 100-block batch, then remaining batches are appended. If an append
// throws, the page already exists, so a degraded/orphaned page would be left
// behind while the run reports failure — violating the "never publish a degraded
// page" promise. publishNotionWithClient must best-effort archive that partial
// page, then re-throw the original append error so run() still fails loud.

describe("publishNotionWithClient: archive partial page on append failure", () => {
  // A markdown report large enough to span >100 blocks (forces multi-batch:
  // each non-blank line becomes one block).
  const multiBatchMarkdown = [
    "# Title (dropped — duplicates page title)",
    ...Array.from({ length: 150 }, (_, i) => `- bullet ${i}`),
  ].join("\n");

  function makeFakeClient(): {
    client: NotionClientLike;
    createCalls: number;
    appendCalls: number;
    archiveCalls: Array<{ page_id: string; archived: boolean }>;
  } {
    const archiveCalls: Array<{ page_id: string; archived: boolean }> = [];
    let createCalls = 0;
    let appendCalls = 0;
    const client: NotionClientLike = {
      pages: {
        create: async () => {
          createCalls += 1;
          return { id: "page-abc", url: "https://notion.example/page-abc" };
        },
        update: async (args) => {
          archiveCalls.push({
            page_id: args.page_id,
            archived: args.archived,
          });
          return {};
        },
      },
      blocks: {
        children: {
          append: async () => {
            appendCalls += 1;
            // First append (the 2nd batch overall) throws.
            throw new Error("Notion 502 on append batch");
          },
        },
      },
    };
    return {
      client,
      get createCalls() {
        return createCalls;
      },
      get appendCalls() {
        return appendCalls;
      },
      archiveCalls,
    };
  }

  it("re-throws the original append error AND archives the just-created partial page", async () => {
    const fake = makeFakeClient();
    await expect(
      publishNotionWithClient(
        fake.client,
        "parent-123",
        "My Report Title",
        multiBatchMarkdown,
      ),
    ).rejects.toThrow("Notion 502 on append batch");

    // The page was created and an append was attempted (multi-batch).
    expect(fake.createCalls).toBe(1);
    expect(fake.appendCalls).toBe(1);
    // The partial page must have been archived best-effort.
    expect(fake.archiveCalls).toEqual([
      { page_id: "page-abc", archived: true },
    ]);
  });

  it("returns the page url on the happy path and never archives", async () => {
    const archiveCalls: Array<{ page_id: string; archived: boolean }> = [];
    const client: NotionClientLike = {
      pages: {
        create: async () => ({
          id: "page-ok",
          url: "https://notion.example/page-ok",
        }),
        update: async (args) => {
          archiveCalls.push({
            page_id: args.page_id,
            archived: args.archived,
          });
          return {};
        },
      },
      blocks: {
        children: {
          append: async () => ({}),
        },
      },
    };
    const url = await publishNotionWithClient(
      client,
      "parent-123",
      "My Report Title",
      multiBatchMarkdown,
    );
    expect(url).toBe("https://notion.example/page-ok");
    expect(archiveCalls).toEqual([]);
  });

  it("re-throws the original append error even when the archive attempt itself fails", async () => {
    const client: NotionClientLike = {
      pages: {
        create: async () => ({ id: "page-xyz", url: null }),
        update: async () => {
          throw new Error("archive also failed");
        },
      },
      blocks: {
        children: {
          append: async () => {
            throw new Error("original append error");
          },
        },
      },
    };
    await expect(
      publishNotionWithClient(
        client,
        "parent-123",
        "My Report Title",
        multiBatchMarkdown,
      ),
    ).rejects.toThrow("original append error");
  });
});

describe("header metrics: unique clients and protocol mix", () => {
  const mk = (summary: AnalyticsSummary): AnalyticsBundle => ({
    summary,
    queries: QUERIES_FIXTURE,
    emptyQueries: EMPTY_QUERIES_FIXTURE,
    toolBreakdown: TOOL_BREAKDOWN_FIXTURE,
  });
  const now = new Date("2026-06-21T09:07:00Z");

  it("renders the clients headline, then Legacy sessions, then Protocol mix", () => {
    const md = renderMarkdown(mk(SUMMARY_FIXTURE), now, 7);
    expect(md).toContain(
      "- Total tool calls: 1234\n" +
        "- 61 unique clients (87 unique IPs)\n" +
        "- Legacy sessions: 142\n" +
        "- Protocol mix: legacy 75.0% / modern 25.0% (400 of 1234 calls classified); " +
        "transport: streamable_http 90.0% / sse 10.0% (400 of 1234 calls classified)\n",
    );
  });

  it("keeps the Protocol mix line as one intact bullet through the Notion block conversion", () => {
    const md = renderMarkdown(mk(SUMMARY_FIXTURE), now, 7);
    const line =
      "Protocol mix: legacy 75.0% / modern 25.0% (400 of 1234 calls classified); " +
      "transport: streamable_http 90.0% / sse 10.0% (400 of 1234 calls classified)";
    const bullets = markdownToNotionBlocks(md).filter(
      (b) =>
        b.type === "bulleted_list_item" &&
        blockText(b).startsWith("Protocol mix:"),
    );
    expect(bullets).toHaveLength(1);
    expect(blockText(bullets[0])).toBe(line);
  });

  it("renders n/a when the server omits the unique-client and protocol-mix fields", () => {
    const old: AnalyticsSummary = { ...SUMMARY_FIXTURE };
    delete old.unique_client_count_window;
    delete old.legacy_query_count_window;
    delete old.modern_query_count_window;
    delete old.streamable_http_query_count_window;
    delete old.sse_query_count_window;
    const md = renderMarkdown(mk(old), now, 7);
    expect(md).toContain("- 87 unique IPs (unique clients not reported)\n");
    expect(md).toContain(
      "- Protocol mix: legacy n/a / modern n/a; transport: streamable_http n/a / sse n/a\n",
    );
  });

  it("renders 0 of N classified for a present pair whose sum is 0, unlike an absent pair", () => {
    const zero = renderMarkdown(
      mk({
        ...SUMMARY_FIXTURE,
        legacy_query_count_window: 0,
        modern_query_count_window: 0,
      }),
      now,
      7,
    );
    expect(zero).toContain(
      "- Protocol mix: legacy n/a / modern n/a (0 of 1234 calls classified); " +
        "transport: streamable_http 90.0% / sse 10.0% (400 of 1234 calls classified)\n",
    );
    const absent: AnalyticsSummary = { ...SUMMARY_FIXTURE };
    delete absent.legacy_query_count_window;
    delete absent.modern_query_count_window;
    const absentMd = renderMarkdown(mk(absent), now, 7);
    expect(absentMd).toContain("- Protocol mix: legacy n/a / modern n/a; ");
    expect(absentMd).not.toContain("(0 of 1234 calls classified)");
  });

  it("assertValidSummary rejects a present non-number optional field and accepts its absence", () => {
    expect(() =>
      assertValidSummary({
        ...SUMMARY_FIXTURE,
        unique_client_count_window: "7",
      }),
    ).toThrow(/unique_client_count_window/);
    expect(() =>
      assertValidSummary({ ...SUMMARY_FIXTURE, sse_query_count_window: NaN }),
    ).toThrow(/sse_query_count_window/);
    const { unique_client_count_window: _omit, ...rest } = SUMMARY_FIXTURE;
    expect(() => assertValidSummary(rest)).not.toThrow();
  });

  it("a JSON null in an optional field is treated as absent and does not abort the run", async () => {
    const nullSummary = {
      ...SUMMARY_FIXTURE,
      unique_client_count_window: null,
      legacy_query_count_window: null,
      modern_query_count_window: null,
      streamable_http_query_count_window: null,
      sse_query_count_window: null,
    };
    const rec = makeRecorder({
      fetchJson: async <T>(path: string): Promise<T> => {
        if (path.includes("/summary")) return nullSummary as unknown as T;
        if (path.includes("/tool-breakdown"))
          return TOOL_BREAKDOWN_FIXTURE as unknown as T;
        if (path.includes("/empty-queries"))
          return EMPTY_QUERIES_FIXTURE as unknown as T;
        if (path.includes("/queries")) return QUERIES_FIXTURE as unknown as T;
        throw new Error(`unexpected path ${path}`);
      },
    });
    await runCatchingExit(rec.deps);
    expect(rec.exitCodes).toEqual([]);
    expect(rec.slackCalls).toEqual([]);
    expect(rec.notionCalls).toHaveLength(1);
    const md = rec.notionCalls[0].markdown;
    expect(md).toContain("- 87 unique IPs (unique clients not reported)\n");
    expect(md).toContain(
      "- Protocol mix: legacy n/a / modern n/a; transport: streamable_http n/a / sse n/a\n",
    );
  });

  it("assertValidSummary rejects a negative or infinite optional count", () => {
    expect(() =>
      assertValidSummary({ ...SUMMARY_FIXTURE, legacy_query_count_window: -5 }),
    ).toThrow(/legacy_query_count_window/);
    expect(() =>
      assertValidSummary({
        ...SUMMARY_FIXTURE,
        unique_client_count_window: -1,
      }),
    ).toThrow(/unique_client_count_window/);
    expect(() =>
      assertValidSummary({
        ...SUMMARY_FIXTURE,
        sse_query_count_window: Infinity,
      }),
    ).toThrow(/sse_query_count_window/);
  });

  it("assertValidSummary accepts a zero optional count", () => {
    for (const k of [
      "unique_client_count_window",
      "legacy_query_count_window",
      "modern_query_count_window",
      "streamable_http_query_count_window",
      "sse_query_count_window",
    ] as const) {
      expect(() =>
        assertValidSummary({ ...SUMMARY_FIXTURE, [k]: 0 }),
      ).not.toThrow();
    }
  });

  it("assertValidSummary rejects a fractional optional count", () => {
    expect(() =>
      assertValidSummary({
        ...SUMMARY_FIXTURE,
        legacy_query_count_window: 2.5,
      }),
    ).toThrow(/legacy_query_count_window/);
    expect(() =>
      assertValidSummary({
        ...SUMMARY_FIXTURE,
        unique_client_count_window: 0.5,
      }),
    ).toThrow(/unique_client_count_window/);
  });

  it("assertValidSummary does not change the caller's object", () => {
    const input = {
      ...SUMMARY_FIXTURE,
      unique_client_count_window: null,
      legacy_query_count_window: null,
      modern_query_count_window: null,
    };
    const before = structuredClone(input);
    assertValidSummary(input);
    expect(input).toEqual(before);
    expect(Object.keys(input)).toEqual(Object.keys(before));
  });

  it("marks a pair whose sum exceeds the window total as inconsistent, without clamping", () => {
    const md = renderMarkdown(
      mk({
        ...SUMMARY_FIXTURE,
        total_queries_window: 400,
        legacy_query_count_window: 300,
        modern_query_count_window: 200,
      }),
      now,
      7,
    );
    expect(md).toContain(
      "- Protocol mix: legacy n/a / modern n/a (inconsistent: 500 of 400 calls classified); " +
        "transport: streamable_http 90.0% / sse 10.0% (400 of 400 calls classified)\n",
    );
  });

  it("marks a pair with one side present and the other absent as partial", () => {
    const half: AnalyticsSummary = { ...SUMMARY_FIXTURE };
    delete half.modern_query_count_window;
    const md = renderMarkdown(mk(half), now, 7);
    expect(md).toContain(
      "- Protocol mix: legacy n/a / modern n/a (partial: modern not reported); " +
        "transport: streamable_http 90.0% / sse 10.0% (400 of 1234 calls classified)\n",
    );
    const nullSide = renderMarkdown(
      mk({
        ...SUMMARY_FIXTURE,
        streamable_http_query_count_window: null,
      }),
      now,
      7,
    );
    expect(nullSide).toContain(
      "transport: streamable_http n/a / sse n/a (partial: streamable_http not reported)\n",
    );
  });

  it("ignores a malformed summary field the report does not read instead of aborting the run", async () => {
    // The server may send counts the report does not use. Only the fields in
    // the report's own summary type are validated.
    const summary = {
      ...SUMMARY_FIXTURE,
      not_a_report_field_window: "garbage",
      another_unread_count_window: -1,
    };
    const rec = makeRecorder({
      fetchJson: async <T>(path: string): Promise<T> => {
        if (path.includes("/summary")) return summary as unknown as T;
        if (path.includes("/tool-breakdown"))
          return TOOL_BREAKDOWN_FIXTURE as unknown as T;
        if (path.includes("/empty-queries"))
          return EMPTY_QUERIES_FIXTURE as unknown as T;
        if (path.includes("/queries")) return QUERIES_FIXTURE as unknown as T;
        throw new Error(`unexpected path ${path}`);
      },
    });
    await runCatchingExit(rec.deps);
    expect(rec.exitCodes).toEqual([]);
    expect(rec.slackCalls).toEqual([]);
    expect(rec.notionCalls).toHaveLength(1);
  });

  it("renders 0.0% / 100.0% when one side of a pair is zero", () => {
    const md = renderMarkdown(
      mk({ ...SUMMARY_FIXTURE, legacy_query_count_window: 0 }),
      now,
      7,
    );
    expect(md).toContain(
      "- Protocol mix: legacy 0.0% / modern 100.0% (100 of 1234 calls classified); " +
        "transport: streamable_http 90.0% / sse 10.0% (400 of 1234 calls classified)\n",
    );
  });
});

describe("headline switch: unique clients, legacy sessions, shared client ids", () => {
  const mk = (summary: AnalyticsSummary): AnalyticsBundle => ({
    summary,
    queries: QUERIES_FIXTURE,
    emptyQueries: EMPTY_QUERIES_FIXTURE,
    toolBreakdown: TOOL_BREAKDOWN_FIXTURE,
  });
  const now = new Date("2026-06-21T09:07:00Z");

  it("formats the headline as 'N unique clients (M unique IPs)'", () => {
    expect(clientsHeadline(SUMMARY_FIXTURE)).toBe(
      "61 unique clients (87 unique IPs)",
    );
    expect(
      clientsHeadline({ ...SUMMARY_FIXTURE, unique_client_count_window: 0 }),
    ).toBe("0 unique clients (87 unique IPs)");
  });

  it("uses the headline in the observations and the #engr digest, with no sessions wording", () => {
    const obs = buildObservations(mk(SUMMARY_FIXTURE));
    expect(obs).toContain("61 unique clients (87 unique IPs).");
    expect(obs.join("\n")).not.toMatch(/sessions/);
    expect(buildSuccessDigest(mk(SUMMARY_FIXTURE), null)).toContain(
      " · 61 unique clients (87 unique IPs) · ",
    );
  });

  it("no longer prints a 'Unique sessions' line", () => {
    const md = renderMarkdown(mk(SUMMARY_FIXTURE), now, 7);
    expect(md).not.toContain("Unique sessions");
    expect(md).not.toContain("- Unique IPs:");
    expect(md).not.toContain("- Unique clients:");
  });

  it("hides the Legacy sessions line when K = 0", () => {
    const md = renderMarkdown(
      mk({ ...SUMMARY_FIXTURE, unique_session_count_window: 0 }),
      now,
      7,
    );
    expect(md).not.toContain("Legacy sessions");
    expect(md).toContain(
      "- 61 unique clients (87 unique IPs)\n- Protocol mix: ",
    );
  });

  it("prints the Legacy sessions line when K > 0", () => {
    const md = renderMarkdown(
      mk({ ...SUMMARY_FIXTURE, unique_session_count_window: 1 }),
      now,
      7,
    );
    expect(md).toContain("- Legacy sessions: 1\n");
  });

  it("parseSharedClientIds trims, drops empties and dedupes", () => {
    expect(parseSharedClientIds(undefined)).toEqual([]);
    expect(parseSharedClientIds("")).toEqual([]);
    expect(parseSharedClientIds(" a , b,,a ,")).toEqual(["a", "b"]);
  });

  it("parseSharedClientIds accepts commas, newlines and CRLF alike", () => {
    const want = ["id-a", "id-b", "id-c"];
    expect(parseSharedClientIds("id-a,id-b,id-c")).toEqual(want);
    expect(parseSharedClientIds("id-a\nid-b\nid-c\n")).toEqual(want);
    expect(parseSharedClientIds("id-a\r\nid-b\r\n\r\nid-c\r\n")).toEqual(want);
    expect(parseSharedClientIds(" id-a ,\n id-b\r\n,id-c,\nid-a\n")).toEqual(
      want,
    );
  });

  function bundleFetch(summary: object, paths: string[]): RunDeps["fetchJson"] {
    return async <T>(path: string): Promise<T> => {
      paths.push(path);
      if (path.includes("/summary")) return summary as unknown as T;
      if (path.includes("/tool-breakdown"))
        return TOOL_BREAKDOWN_FIXTURE as unknown as T;
      if (path.includes("/empty-queries"))
        return EMPTY_QUERIES_FIXTURE as unknown as T;
      if (path.includes("/queries")) return QUERIES_FIXTURE as unknown as T;
      if (path.includes("/relay-exclusions")) return [] as unknown as T;
      throw new Error(`unexpected path ${path}`);
    };
  }

  it("sends no shared_client_ids param when the list is empty", async () => {
    const paths: string[] = [];
    await fetchBundle({ fetchJson: bundleFetch(SUMMARY_FIXTURE, paths) }, 7);
    expect(paths[0]).toBe("/api/analytics/summary?days=7");
  });

  it("sends the list to /summary and accepts the server's confirmation", async () => {
    const paths: string[] = [];
    const bundle = await fetchBundle(
      {
        fetchJson: bundleFetch(
          { ...SUMMARY_FIXTURE, shared_client_ids_applied: 2 },
          paths,
        ),
      },
      7,
      ["id-a", "id-b"],
    );
    expect(paths[0]).toBe(
      "/api/analytics/summary?days=7&shared_client_ids=id-a%2Cid-b",
    );
    expect(bundle.summary.unique_client_count_window).toBe(61);
  });

  it("fails loud when the server does not confirm the shared ids (older deployment)", async () => {
    await expect(
      fetchBundle({ fetchJson: bundleFetch(SUMMARY_FIXTURE, []) }, 7, ["id-a"]),
    ).rejects.toThrow(
      /did not apply shared_client_ids \(sent 1, server applied none\)/,
    );
  });

  it("fails loud when the server applies a different number of shared ids", async () => {
    await expect(
      fetchBundle(
        {
          fetchJson: bundleFetch(
            { ...SUMMARY_FIXTURE, shared_client_ids_applied: 1 },
            [],
          ),
        },
        7,
        ["id-a", "id-b"],
      ),
    ).rejects.toThrow(
      /did not apply shared_client_ids \(sent 2, server applied 1\)/,
    );
  });

  it("the real entry point sends SHARED_CLIENT_IDS from the environment to /summary", async () => {
    // Spawn the script as the workflow does, against a local analytics server
    // that records each request and never confirms the ids. This covers the
    // process.env wiring in buildRealDeps, which the injected-deps tests skip.
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(req.url ?? "");
      if ((req.url ?? "").startsWith("/api/analytics/summary")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(SUMMARY_FIXTURE));
        return;
      }
      // Any later endpoint fails, so the script can never reach Notion.
      res.writeHead(500);
      res.end();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    try {
      const tsx = fileURLToPath(
        new URL("../../node_modules/.bin/tsx", import.meta.url),
      );
      const script = fileURLToPath(
        new URL("./weekly-search-report.ts", import.meta.url),
      );
      const child = spawn(tsx, [script], {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          PATHFINDER_ANALYTICS_TOKEN: "tok-entry",
          ANALYTICS_BASE_URL: `http://127.0.0.1:${port}`,
          SHARED_CLIENT_IDS: "id-a",
          REPORT_DAYS: "7",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const code = await new Promise<number | null>((done) =>
        child.on("close", done),
      );
      expect(seen[0]).toBe(
        "/api/analytics/summary?days=7&shared_client_ids=id-a",
      );
      expect(stderr).toMatch(
        /did not apply shared_client_ids \(sent 1, server applied none\)/,
      );
      expect(code).toBe(1);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 30_000);

  it.each([
    ["one id per line (LF)", "id-a\nid-b\n"],
    ["one id per line (CRLF)", "id-a\r\nid-b\r\n"],
  ])(
    "run() sends a %s secret as two ids and succeeds when the server applies 2",
    async (_label, raw) => {
      const paths: string[] = [];
      const rec = makeRecorder({
        fetchJson: bundleFetch(
          { ...SUMMARY_FIXTURE, shared_client_ids_applied: 2 },
          paths,
        ),
      });
      rec.deps.env.SHARED_CLIENT_IDS = raw;
      await runCatchingExit(rec.deps);
      expect(paths[0]).toBe(
        "/api/analytics/summary?days=7&shared_client_ids=id-a%2Cid-b",
      );
      expect(rec.exitCodes).toEqual([]);
      expect(rec.notionCalls).toHaveLength(1);
    },
  );

  it("run() reads SHARED_CLIENT_IDS from env and fails loud without a confirmation", async () => {
    const paths: string[] = [];
    const rec = makeRecorder({
      fetchJson: bundleFetch(SUMMARY_FIXTURE, paths),
    });
    rec.deps.env.SHARED_CLIENT_IDS = "id-a";
    await runCatchingExit(rec.deps);
    expect(paths[0]).toContain("&shared_client_ids=id-a");
    expect(rec.exitCodes).toEqual([1]);
    expect(rec.notionCalls).toHaveLength(0);
    expect(rec.slackCalls[0]).toMatch(/shared_client_ids/);
  });
});

describe("shared client ids never reach logs or alerts", () => {
  const IDS = "test-id-alpha,test-id-beta";
  const leaks = (text: string): string[] =>
    ["test-id-alpha", "test-id-beta", encodeURIComponent(IDS)].filter((n) =>
      text.includes(n),
    );

  async function listen500OnSummary(): Promise<{
    server: Server;
    baseUrl: string;
    seen: string[];
  }> {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(req.url ?? "");
      const status = req.url?.startsWith("/api/analytics/summary") ? 500 : 200;
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(status === 500 ? "boom" : "[]");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    return { server, baseUrl: `http://127.0.0.1:${port}`, seen };
  }

  it("run() with the real fetch gives a sealed error when /summary returns 500", async () => {
    const { server, baseUrl, seen } = await listen500OnSummary();
    try {
      const errors: string[] = [];
      const rec = makeRecorder({ fetchJson: makeFetchJson(baseUrl, "tok") });
      rec.deps.env.SHARED_CLIENT_IDS = IDS;
      rec.deps.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      };
      await runCatchingExit(rec.deps);

      // The request itself still carries the real list.
      expect(seen[0]).toBe(
        `/api/analytics/summary?days=7&shared_client_ids=${encodeURIComponent(IDS)}`,
      );
      // Still fails loud.
      expect(rec.exitCodes).toEqual([1]);
      expect(rec.notionCalls).toHaveLength(0);
      expect(rec.slackCalls).toHaveLength(1);
      // But the message is sealed: no id, raw or encoded, reaches stderr or Slack.
      expect(errors).toEqual([
        "[weekly-report] FAILED: Analytics fetch failed: 500 for /api/analytics/summary (details withheld: the request carries shared_client_ids)",
      ]);
      const text = [...errors, ...rec.slackCalls].join("\n");
      expect(leaks(text)).toEqual([]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  /**
   * Run the real run() with the real makeFetchJson(base) and the real
   * makePostSlack against a local webhook that records each posted text.
   * Returns everything that left the process: stderr, stdout and Slack.
   */
  async function runAgainst(
    base: string,
    ids: string = IDS,
  ): Promise<{
    exitCodes: number[];
    notionCalls: number;
    errors: string[];
    logs: string[];
    slack: string[];
    text: string;
  }> {
    const slack: string[] = [];
    const hook = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString("utf-8")));
      req.on("end", () => {
        slack.push((JSON.parse(body) as { text: string }).text);
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
    const { port } = hook.address() as AddressInfo;
    const errors: string[] = [];
    const logs: string[] = [];
    try {
      const rec = makeRecorder({ fetchJson: makeFetchJson(base, "tok") });
      rec.deps.env.SHARED_CLIENT_IDS = ids;
      rec.deps.postSlack = makePostSlack(`http://127.0.0.1:${port}/hook`);
      rec.deps.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      };
      rec.deps.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      };
      await runCatchingExit(rec.deps);
      return {
        exitCodes: rec.exitCodes,
        notionCalls: rec.notionCalls.length,
        errors,
        logs,
        slack,
        text: [...errors, ...logs, ...slack].join("\n"),
      };
    } finally {
      await new Promise<void>((r) => hook.close(() => r()));
    }
  }

  // When fetch() itself throws (a base URL with no scheme, or an empty one),
  // undici's message carries the whole URL, ids included.
  for (const base of ["mcp.copilotkit.ai", ""]) {
    it(`run() with the real fetch gives a sealed error when fetch() throws (base ${JSON.stringify(base)})`, async () => {
      const out = await runAgainst(base);
      // Still fails loud, with the real reason.
      expect(out.exitCodes).toEqual([1]);
      expect(out.notionCalls).toBe(0);
      expect(out.slack).toHaveLength(1);
      expect(out.errors).toEqual([
        "[weekly-report] FAILED: Analytics fetch failed: TypeError for /api/analytics/summary (details withheld: the request carries shared_client_ids)",
      ]);
      // No id, raw or encoded, reaches stderr, stdout or Slack.
      expect(leaks(out.text)).toEqual([]);
    });
  }

  it("makeFetchJson seals a thrown fetch: fixed message, no cause chain", async () => {
    const fetchJson = makeFetchJson("mcp.copilotkit.ai", "tok");
    const path = `/api/analytics/summary?days=7&shared_client_ids=${encodeURIComponent(IDS)}`;
    const err: unknown = await fetchJson(path).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    // Only the sealed error: undici's error (its message holds the URL) is not
    // kept as a cause.
    expect((err as Error).cause).toBeUndefined();
    expect((err as Error).message).toBe(
      "Analytics fetch failed: TypeError for /api/analytics/summary (details withheld: the request carries shared_client_ids)",
    );
  });

  it("run() with the real fetch gives a sealed error when a 500 body echoes the URL", async () => {
    const server = createServer((req, res) => {
      const url = req.url ?? "";
      const status = url.startsWith("/api/analytics/summary") ? 500 : 200;
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(
        status === 500
          ? `bad request ${url} (decoded: ${decodeURIComponent(url)})`
          : "[]",
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      const out = await runAgainst(`http://127.0.0.1:${port}`);
      expect(out.exitCodes).toEqual([1]);
      expect(out.notionCalls).toBe(0);
      expect(out.slack).toHaveLength(1);
      expect(out.errors).toEqual([
        "[weekly-report] FAILED: Analytics fetch failed: 500 for /api/analytics/summary (details withheld: the request carries shared_client_ids)",
      ]);
      expect(leaks(out.text)).toEqual([]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  // Every error path of a /summary request that carries the ids must give one
  // fixed message: the endpoint path, the status or the error class, and a
  // "details withheld" note. Nothing else may reach stderr, stdout or Slack,
  // whatever the server or the runtime puts in its text, and in any encoding.
  const WITHHELD = "(details withheld: the request carries shared_client_ids)";
  const sealed = (detail: string): string =>
    `Analytics fetch failed: ${detail} for /api/analytics/summary ${WITHHELD}`;

  interface SealedRow {
    name: string;
    /** Base URL; null means the local server below. */
    base: string | null;
    status?: number;
    /** HTTP reason phrase; built from the id list when it is a function. */
    reason?: (ids: string) => string;
    /** Response body for /summary, built from the request URL and id list. */
    body?: (url: string, ids: string) => string;
    /** The status or error class that the sealed message must name. */
    detail: string;
  }

  const SEALED_ROWS: SealedRow[] = [
    {
      name: "fetch throws (no scheme)",
      base: "mcp.copilotkit.ai",
      detail: "TypeError",
    },
    { name: "fetch throws (empty base)", base: "", detail: "TypeError" },
    {
      name: "400 body echoes the raw URL",
      base: null,
      status: 400,
      body: (url) => `bad request ${url}`,
      detail: "400",
    },
    {
      name: "401 body echoes the decoded ids",
      base: null,
      status: 401,
      body: (url) => `denied: ${decodeURIComponent(url)}`,
      detail: "401",
    },
    {
      name: "500 body echoes the '+' form",
      base: null,
      status: 500,
      body: (_url, ids) =>
        `bad ids ${new URLSearchParams({ shared_client_ids: ids }).toString()}`,
      detail: "500",
    },
    {
      name: "502 body echoes JSON-escaped and lowercase %xx forms",
      base: null,
      status: 502,
      body: (_url, ids) =>
        `<!channel> ${JSON.stringify(ids)} ${encodeURIComponent(ids).replace(
          /%[0-9A-F]{2}/g,
          (m) => m.toLowerCase(),
        )} Internal error at api layer`,
      detail: "502",
    },
    {
      name: "500 reason phrase carries an id",
      base: null,
      status: 500,
      reason: (ids) => `bad ${ids.split(",")[0]}`,
      body: () => "",
      detail: "500",
    },
    {
      name: "200 non-JSON body echoes the ids",
      base: null,
      status: 200,
      body: (_url, ids) => `x ${ids}`,
      detail: "SyntaxError",
    },
    {
      name: "200 empty body",
      base: null,
      status: 200,
      body: () => "",
      detail: "SyntaxError",
    },
  ];

  const SEALED_ID_SETS = [
    "test-id-alpha,test-id-beta",
    "a,longer-id-zz",
    'sek ret,q"uote',
  ];

  for (const row of SEALED_ROWS) {
    for (const ids of SEALED_ID_SETS) {
      it(`sealed error: ${row.name} (ids ${JSON.stringify(ids)})`, async () => {
        let server: Server | undefined;
        let base = row.base ?? "";
        if (row.base === null) {
          server = createServer((req, res) => {
            const url = req.url ?? "";
            if (!url.startsWith("/api/analytics/summary")) {
              res.writeHead(200, { "content-type": "application/json" });
              res.end("[]");
              return;
            }
            const headers = { "content-type": "text/plain" };
            const status = row.status ?? 500;
            if (row.reason) res.writeHead(status, row.reason(ids), headers);
            else res.writeHead(status, headers);
            res.end(row.body ? row.body(url, ids) : "");
          });
          await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
          const { port } = server.address() as AddressInfo;
          base = `http://127.0.0.1:${port}`;
        }
        try {
          const out = await runAgainst(base, ids);
          const message = sealed(row.detail);
          expect({
            exitCodes: out.exitCodes,
            notionCalls: out.notionCalls,
            stderr: out.errors,
            stdout: out.logs,
            slack: out.slack,
          }).toEqual({
            exitCodes: [1],
            notionCalls: 0,
            stderr: [`[weekly-report] FAILED: ${message}`],
            stdout: [],
            slack: [`Pathfinder weekly search report FAILED: ${message}`],
          });
        } finally {
          if (server) {
            const s = server;
            await new Promise<void>((r) => s.close(() => r()));
          }
        }
      });
    }
  }

  // A 2xx summary whose shared_client_ids_applied is not a count (a server
  // that echoes the list) must not put the ids in the failure message.
  for (const [name, applied] of [
    ["a string", "test-id-alpha,test-id-beta"],
    ["an array", ["test-id-alpha", "test-id-beta"]],
  ] as const) {
    it(`a non-count shared_client_ids_applied (${name}) is not echoed`, async () => {
      const server = createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            (req.url ?? "").startsWith("/api/analytics/summary")
              ? { ...SUMMARY_FIXTURE, shared_client_ids_applied: applied }
              : [],
          ),
        );
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const { port } = server.address() as AddressInfo;
      try {
        const out = await runAgainst(`http://127.0.0.1:${port}`);
        expect(out.exitCodes).toEqual([1]);
        expect(out.notionCalls).toBe(0);
        expect(out.errors).toEqual([
          "[weekly-report] FAILED: summary did not apply shared_client_ids (sent 2, server applied invalid)",
        ]);
        expect(leaks(out.text)).toEqual([]);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });
  }

  it("a request without the ids keeps the full error text", async () => {
    const server = createServer((req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("boom");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      const out = await runAgainst(`http://127.0.0.1:${port}`, "");
      expect(out.errors).toEqual([
        "[weekly-report] FAILED: Analytics fetch failed: 500 Internal Server Error for /api/analytics/summary?days=7 — boom",
      ]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
