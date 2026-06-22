import { describe, it, expect, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
  sanitizeCell,
  makePostSlack,
  type NotionClientLike,
  type RunDeps,
  type EmptyQuery,
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

  it("caps a table at 100 data rows and appends a truncation note", () => {
    const lines = ["| Day | Count |", "| --- | --- |"];
    for (let i = 0; i < 150; i++) lines.push(`| d${i} | ${i} |`);
    const blocks = markdownToNotionBlocks(lines.join("\n"));
    const table = blocks.find((b) => b.type === "table") as any;
    // header + 100 data rows
    expect(table.table.children.length).toBe(101);
    const note = blocks.find(
      (b) => b.type === "paragraph" && blockText(b).includes("truncated"),
    );
    expect(note).toBeDefined();
    expect(blockText(note!)).toContain("150");
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
