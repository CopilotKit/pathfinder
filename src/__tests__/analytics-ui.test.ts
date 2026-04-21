import { describe, it, expect, afterEach, vi } from "vitest";
import { JSDOM, VirtualConsole } from "jsdom";
import fs from "node:fs";
import path from "node:path";

/**
 * Integration test for the analytics dashboard UI (docs/analytics.html).
 *
 * These tests load the real analytics.html into jsdom, stub window.fetch so
 * each endpoint returns a configurable canned payload keyed by the query
 * string, and exercise the date-range preset clicks end-to-end.
 *
 * They would have failed against the pre-fix code because:
 *   - Bug 1: clicking "Last 30 days" did not update the stat cards / charts —
 *     the summary + tool-counts endpoints were only sent `days=30` but the
 *     server didn't read it, so the dashboard always rendered 7-day data for
 *     those sections while tables updated.
 *   - Bug 2: clicking "Today" sent `days=1`, which on the server means
 *     "last 24 hours" — not actually today.
 *
 * The UI assertions here verify the *outbound* URLs the client sends (i.e.
 * what the client is asking the server for). Combined with the backend SQL
 * tests in analytics.test.ts — which confirm those params actually change
 * the date window — the two together catch the full regression.
 */

// Chart.js is a global <script src> in the HTML. jsdom won't execute external
// CDN scripts, so we stub a minimal Chart constructor on the window before
// the inline script runs. The real chart rendering is not under test here —
// only the data flow into it.
function installChartStub(win: Window & typeof globalThis): {
  instances: Array<{ type: string; data: unknown; options: unknown }>;
} {
  const instances: Array<{ type: string; data: unknown; options: unknown }> =
    [];
  class ChartStub {
    type: string;
    data: unknown;
    options: unknown;
    destroyed = false;
    constructor(
      _ctx: unknown,
      cfg: { type: string; data: unknown; options: unknown },
    ) {
      this.type = cfg.type;
      this.data = cfg.data;
      this.options = cfg.options;
      instances.push({
        type: this.type,
        data: this.data,
        options: this.options,
      });
    }
    destroy() {
      this.destroyed = true;
    }
  }
  Object.assign(win, { Chart: ChartStub });
  return { instances };
}

/**
 * Build a fetch stub that:
 *  - records every URL called
 *  - returns a per-path response from `handlers` (function of query-string)
 *
 * Unmocked paths throw instead of returning 404. A 404 leaks into the
 * page's #error element and silently turns what should be a hard test
 * failure into a soft one (the test body's positive assertions still
 * pass because the element exists). Throwing forces missing handlers
 * to surface immediately in the test run.
 */
/**
 * Flush two rounds of microtasks. Double-`await setTimeout(r, 0)` is
 * needed because the dashboard's load() chain does an auth-mode fetch
 * that then triggers the real data fetches; a single flush covers only
 * the first hop. Named helper makes intent explicit at call sites.
 */
async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function buildFetchStub(handlers: Record<string, (qs: string) => unknown>) {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (url: string | URL) => {
    const u = typeof url === "string" ? url : url.toString();
    calls.push(u);
    const [path, qs = ""] = u.split("?");
    const handler = handlers[path];
    if (!handler) {
      throw new Error(
        `unmocked fetch path in analytics-ui test: ${u} (add to handlers)`,
      );
    }
    const body = handler(qs);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { fetchFn, calls };
}

async function loadDashboard(
  handlers: Record<string, (qs: string) => unknown>,
): Promise<{
  dom: JSDOM;
  calls: string[];
  chartInstances: Array<{ type: string; data: unknown; options: unknown }>;
}> {
  const html = fs.readFileSync(
    path.join(process.cwd(), "docs", "analytics.html"),
    "utf8",
  );
  // Swallow jsdom's "Could not load script" noise for the Chart.js CDN include.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", () => {});
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://localhost/analytics",
    pretendToBeVisual: true,
    virtualConsole,
  });

  const win = dom.window as unknown as Window & typeof globalThis;
  // jsdom creates its own Date constructor on window; vitest's fake timers
  // only patch the test-context global. Forward our (possibly faked) Date into
  // the jsdom window so `new Date()` inside dashboard code is deterministic.
  Object.assign(win, { Date: globalThis.Date });
  const { instances } = installChartStub(win);
  const { fetchFn, calls } = buildFetchStub(handlers);
  Object.assign(win, { fetch: fetchFn });

  // Pull out the inline <script> and execute in the window.
  const scriptEl = dom.window.document.querySelector("script:not([src])");
  if (!scriptEl) throw new Error("inline script not found in analytics.html");
  const code = scriptEl.textContent ?? "";
  dom.window.eval(code);

  // Init runs async (auth-mode check → load). Flush microtasks.
  await flushAsync();

  return { dom, calls, chartInstances: instances };
}

function canned(daysReturned: number, totalQueries: number) {
  const today = new Date();
  const dayOffset = (n: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const perDay = Array.from({ length: daysReturned }, (_, i) => ({
    day: dayOffset(daysReturned - 1 - i),
    count: 10 + i,
  }));
  return {
    summary: {
      total_queries: totalQueries,
      total_queries_window: 500,
      empty_result_rate_window: 0.1,
      empty_result_count_window: 50,
      avg_latency_ms_window: 100,
      p95_latency_ms_window: 300,
      queries_per_day_window: perDay,
      queries_by_source: [{ source_name: "docs", count: totalQueries }],
    },
    toolCounts: [{ tool_type: "search", count: totalQueries }],
    queries: [],
    emptyQueries: [],
  };
}

/**
 * Parse the query string returned by window.fetch calls. Returns a map of
 * key → value (last-wins). Accepts the raw QS without the leading '?'.
 */
function parseQS(qs: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!qs) return out;
  for (const pair of qs.split("&")) {
    if (!pair) continue;
    const [k, v = ""] = pair.split("=");
    out[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return out;
}

function todayUTC(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------

describe("analytics dashboard UI — date preset wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clicking 'Last 30 days' sends days=30 to ALL four endpoints (not just tables)", async () => {
    // Per-endpoint handlers return a payload whose stat-card value varies
    // by the `days` param so we can tell if the stat cards rendered fresh
    // data or stale 7-day data.
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": (qs: string) => {
        const p = parseQS(qs);
        const days = p.days ? parseInt(p.days, 10) : 7;
        return canned(days, days === 30 ? 9999 : 1111).summary;
      },
      "/api/analytics/tool-counts": (qs: string) => {
        const p = parseQS(qs);
        const days = p.days ? parseInt(p.days, 10) : 7;
        return canned(days, days === 30 ? 9999 : 1111).toolCounts;
      },
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };

    const { dom, calls, chartInstances } = await loadDashboard(endpoints);

    // Initial load happens with defaults (days=7).
    const initialCalls = calls.slice();
    expect(
      initialCalls.some((u) => u.startsWith("/api/analytics/summary")),
    ).toBe(true);

    // Open the date popover.
    const datePill = dom.window.document.getElementById("datePill");
    expect(datePill).not.toBeNull();
    datePill!.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    // Click the "Last 30 days" preset.
    const presets = Array.from(
      dom.window.document.querySelectorAll(".preset[data-days]"),
    );
    const thirty = presets.find(
      (el) => el.getAttribute("data-days") === "30",
    ) as HTMLElement | undefined;
    expect(thirty).toBeDefined();
    thirty!.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    // Let the reload resolve.
    await flushAsync();

    // Collect only the URLs issued AFTER the preset click.
    const afterClick = calls.slice(initialCalls.length);

    const summaryCall = afterClick.find((u) =>
      u.startsWith("/api/analytics/summary"),
    );
    const toolCountsCall = afterClick.find((u) =>
      u.startsWith("/api/analytics/tool-counts"),
    );
    const queriesCall = afterClick.find((u) =>
      u.startsWith("/api/analytics/queries"),
    );
    const emptyCall = afterClick.find((u) =>
      u.startsWith("/api/analytics/empty-queries"),
    );

    // Every endpoint must be refetched with days=30 — not just queries/empty.
    expect(summaryCall).toBeDefined();
    expect(toolCountsCall).toBeDefined();
    expect(queriesCall).toBeDefined();
    expect(emptyCall).toBeDefined();

    expect(parseQS(summaryCall!.split("?")[1] ?? "")).toMatchObject({
      days: "30",
    });
    expect(parseQS(toolCountsCall!.split("?")[1] ?? "")).toMatchObject({
      days: "30",
    });
    expect(parseQS(queriesCall!.split("?")[1] ?? "")).toMatchObject({
      days: "30",
    });
    expect(parseQS(emptyCall!.split("?")[1] ?? "")).toMatchObject({
      days: "30",
    });

    // Stat card "Total Queries" must reflect the 30-day value (9999),
    // not the default 7-day value (1111).
    const statsHtml = dom.window.document.getElementById("stats")!.innerHTML;
    expect(statsHtml).toContain("9,999");
    expect(statsHtml).not.toContain("1,111");

    // Daily bar chart should be re-rendered with one bar per day in the
    // mocked queries_per_day_window. Assert against the mock shape rather
    // than a hardcoded 30 so the test doesn't drift if the canned payload
    // width ever changes.
    const lastBarChart = [...chartInstances]
      .reverse()
      .find((c) => c.type === "bar");
    expect(lastBarChart).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const labels = (lastBarChart as any).data.labels as string[];
    const mockedSummary = canned(30, 9999).summary;
    expect(labels).toHaveLength(mockedSummary.queries_per_day_window.length);
  });

  it("clicking 'Today' sends from=<today>&to=<today> (both equal, UTC), not days=1", async () => {
    // Freeze Date so "today" is deterministic across timezones and midnight
    // rollovers. toFake:["Date"] keeps setTimeout real so the flush-microtask
    // pattern below (`await setTimeout(r, 0)`) still advances normally.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-20T10:00:00.000Z"));
    try {
      const endpoints = {
        "/api/analytics/auth-mode": () => ({ dev: true }),
        "/api/analytics/summary": (qs: string) => {
          const p = parseQS(qs);
          // Return a distinguishing value when the `from`/`to` range is used.
          const usingRange = Boolean(p.from && p.to);
          return canned(1, usingRange ? 4242 : 1111).summary;
        },
        "/api/analytics/tool-counts": () => canned(1, 0).toolCounts,
        "/api/analytics/queries": () => [],
        "/api/analytics/empty-queries": () => [],
      };

      const { dom, calls } = await loadDashboard(endpoints);
      const initial = calls.slice();

      // Open popover.
      const datePill = dom.window.document.getElementById("datePill")!;
      datePill.dispatchEvent(
        new dom.window.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
        }),
      );

      // Click "Today" preset. The preset row carries a stable
      // `data-preset="today"` attribute — match on that instead of text
      // content so a future label rename (e.g. "Today only") doesn't
      // silently break the test.
      const todayPreset = dom.window.document.querySelector(
        '.preset[data-preset="today"]',
      ) as HTMLElement | null;
      expect(todayPreset).not.toBeNull();
      todayPreset!.dispatchEvent(
        new dom.window.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
        }),
      );

      await flushAsync();

      const after = calls.slice(initial.length);
      const summaryCall = after.find((u) =>
        u.startsWith("/api/analytics/summary"),
      );
      expect(summaryCall).toBeDefined();
      const qs = parseQS(summaryCall!.split("?")[1] ?? "");

      // With frozen Date, today is exactly 2026-04-20 in UTC.
      const today = "2026-04-20";
      expect(today).toBe(todayUTC());
      // from and to must both be present AND equal to today's date.
      expect(qs.from).toBe(today);
      expect(qs.to).toBe(today);
      // days= must NOT be sent — "Today" uses explicit range, not rolling window.
      expect(qs.days).toBeUndefined();

      // Every endpoint must send the explicit range.
      for (const p of [
        "/api/analytics/summary",
        "/api/analytics/tool-counts",
        "/api/analytics/queries",
        "/api/analytics/empty-queries",
      ]) {
        const call = after.find((u) => u.startsWith(p));
        expect(call, p + " should be refetched").toBeDefined();
        const q = parseQS(call!.split("?")[1] ?? "");
        expect(q.from, p + " from=today").toBe(today);
        expect(q.to, p + " to=today").toBe(today);
        expect(q.days, p + " should not send days").toBeUndefined();
      }

      // Stat card must show the range-using payload, not the default 7-day one.
      const statsHtml = dom.window.document.getElementById("stats")!.innerHTML;
      expect(statsHtml).toContain("4,242");

      // Pill label must say "Today" — not the formatted date.
      const pillLabel = dom.window.document
        .querySelector("#datePill .date-value")
        ?.textContent?.trim();
      expect(pillLabel).toBe("Today");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clicking 'Last 7 days' AFTER 'Today' switches back to days=7 and updates stats", async () => {
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": (qs: string) => {
        const p = parseQS(qs);
        if (p.from && p.to) return canned(1, 4242).summary;
        const days = p.days ? parseInt(p.days, 10) : 7;
        return canned(days, days === 7 ? 7777 : 1111).summary;
      },
      "/api/analytics/tool-counts": () => canned(1, 0).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };

    const { dom, calls } = await loadDashboard(endpoints);

    // Today first.
    dom.window.document
      .getElementById("datePill")!
      .dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    const todayPreset = dom.window.document.querySelector(
      '.preset[data-preset="today"]',
    ) as HTMLElement;
    todayPreset.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flushAsync();

    // Snapshot of fetches so far.
    const beforeSwitch = calls.length;

    // Then switch to Last 7 days.
    dom.window.document
      .getElementById("datePill")!
      .dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    const seven = Array.from(
      dom.window.document.querySelectorAll(".preset[data-days]"),
    ).find((el) => el.getAttribute("data-days") === "7") as HTMLElement;
    seven.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flushAsync();

    const after = calls.slice(beforeSwitch);
    const summaryCall = after.find((u) =>
      u.startsWith("/api/analytics/summary"),
    );
    expect(summaryCall).toBeDefined();
    const qs = parseQS(summaryCall!.split("?")[1] ?? "");
    expect(qs.days).toBe("7");
    expect(qs.from).toBeUndefined();
    expect(qs.to).toBeUndefined();

    const statsHtml = dom.window.document.getElementById("stats")!.innerHTML;
    expect(statsHtml).toContain("7,777");
  });
});

// ---------------------------------------------------------------------------

describe("analytics dashboard UI — dynamic window labels", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeEndpoints() {
    return {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": (qs: string) => {
        const p = parseQS(qs);
        const days = p.days ? parseInt(p.days, 10) : 7;
        return canned(days, 1234).summary;
      },
      "/api/analytics/tool-counts": () => canned(1, 0).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };
  }

  async function clickPresetByDays(dom: JSDOM, days: number) {
    dom.window.document
      .getElementById("datePill")!
      .dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    const preset = Array.from(
      dom.window.document.querySelectorAll(".preset[data-days]"),
    ).find((el) => el.getAttribute("data-days") === String(days)) as
      | HTMLElement
      | undefined;
    preset!.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flushAsync();
  }

  async function clickToday(dom: JSDOM) {
    dom.window.document
      .getElementById("datePill")!
      .dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    const todayPreset = dom.window.document.querySelector(
      '.preset[data-preset="today"]',
    ) as HTMLElement | null;
    todayPreset!.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flushAsync();
  }

  it("default load shows 'Last 7 days' window label on stat cards, chart title, and table headers", async () => {
    const { dom } = await loadDashboard(makeEndpoints());
    const doc = dom.window.document;

    // Stat card labels (first four stat cards carry the window label).
    const statsHtml = doc.getElementById("stats")!.innerHTML;
    expect(statsHtml).toContain("Queries (Last 7 days)");
    expect(statsHtml).toContain("Empty Result Rate (Last 7 days)");
    expect(statsHtml).toContain("Avg Latency (Last 7 days)");
    expect(statsHtml).toContain("P95 Latency (Last 7 days)");
    expect(statsHtml).toContain("Empty Queries (Last 7 days)");
    // And the "(7d)" literal must be gone from stat card labels.
    expect(statsHtml).not.toContain("(7d)");

    // Daily chart title.
    const dailyTitle = doc.getElementById("dailyChartTitle")!.textContent;
    expect(dailyTitle).toBe("Queries per Day (Last 7 days)");

    // Top queries table h2.
    const topQueriesTitle = doc.getElementById("topQueriesTitle")!.textContent;
    expect(topQueriesTitle).toBe("Top Queries (Last 7 days)");

    // Empty queries table h2 (contains the warning span, so check textContent).
    const emptyTitle = doc
      .getElementById("emptyQueriesTitle")!
      .textContent!.trim();
    expect(emptyTitle.startsWith("Empty Result Queries (Last 7 days)")).toBe(
      true,
    );
  });

  it("switching to 'Last 30 days' updates every label to 'Last 30 days'", async () => {
    const { dom } = await loadDashboard(makeEndpoints());
    await clickPresetByDays(dom, 30);

    const doc = dom.window.document;
    const statsHtml = doc.getElementById("stats")!.innerHTML;
    expect(statsHtml).toContain("Queries (Last 30 days)");
    expect(statsHtml).toContain("Empty Result Rate (Last 30 days)");
    expect(statsHtml).toContain("Avg Latency (Last 30 days)");
    expect(statsHtml).toContain("P95 Latency (Last 30 days)");
    expect(statsHtml).toContain("Empty Queries (Last 30 days)");
    expect(statsHtml).not.toContain("Last 7 days");
    expect(statsHtml).not.toContain("(7d)");

    expect(doc.getElementById("dailyChartTitle")!.textContent).toBe(
      "Queries per Day (Last 30 days)",
    );
    expect(doc.getElementById("topQueriesTitle")!.textContent).toBe(
      "Top Queries (Last 30 days)",
    );
    const emptyTitle = doc
      .getElementById("emptyQueriesTitle")!
      .textContent!.trim();
    expect(emptyTitle.startsWith("Empty Result Queries (Last 30 days)")).toBe(
      true,
    );
  });

  it("switching to 'Today' updates every label to 'Today'", async () => {
    const { dom } = await loadDashboard(makeEndpoints());
    await clickToday(dom);

    const doc = dom.window.document;
    const statsHtml = doc.getElementById("stats")!.innerHTML;
    expect(statsHtml).toContain("Queries (Today)");
    expect(statsHtml).toContain("Empty Result Rate (Today)");
    expect(statsHtml).toContain("Avg Latency (Today)");
    expect(statsHtml).toContain("P95 Latency (Today)");
    expect(statsHtml).toContain("Empty Queries (Today)");

    expect(doc.getElementById("dailyChartTitle")!.textContent).toBe(
      "Queries per Day (Today)",
    );
    expect(doc.getElementById("topQueriesTitle")!.textContent).toBe(
      "Top Queries (Today)",
    );
    const emptyTitle = doc
      .getElementById("emptyQueriesTitle")!
      .textContent!.trim();
    expect(emptyTitle.startsWith("Empty Result Queries (Today)")).toBe(true);
  });

  it("switching to 'Last 90 days' updates every label to 'Last 90 days'", async () => {
    const { dom } = await loadDashboard(makeEndpoints());
    await clickPresetByDays(dom, 90);

    const doc = dom.window.document;
    const statsHtml = doc.getElementById("stats")!.innerHTML;
    expect(statsHtml).toContain("Queries (Last 90 days)");
    expect(doc.getElementById("dailyChartTitle")!.textContent).toBe(
      "Queries per Day (Last 90 days)",
    );
    expect(doc.getElementById("topQueriesTitle")!.textContent).toBe(
      "Top Queries (Last 90 days)",
    );
  });
});

// ---------------------------------------------------------------------------
// Daily bar chart: clicking a bar should drill down to from=to=that-day.
// This exercises the onClick handler wired on the daily chart instance so
// the chart is interactive, not just informational.
// ---------------------------------------------------------------------------

describe("analytics dashboard UI — daily bar click drills down", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("invoking the daily-bar onClick with elements[0].index triggers a reload with from=to=<day>", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-20T10:00:00.000Z"));
    try {
      const endpoints = {
        "/api/analytics/auth-mode": () => ({ dev: true }),
        "/api/analytics/summary": () => canned(3, 500).summary,
        "/api/analytics/tool-counts": () => canned(3, 500).toolCounts,
        "/api/analytics/queries": () => [],
        "/api/analytics/empty-queries": () => [],
      };

      const { dom, calls, chartInstances } = await loadDashboard(endpoints);
      const initialCount = calls.length;

      // Grab the most recent bar chart instance — that's the daily chart.
      const barChart = [...chartInstances]
        .reverse()
        .find((c) => c.type === "bar") as
        | (typeof chartInstances)[number]
        | undefined;
      expect(barChart).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const labels = (barChart as any).data.labels as string[];
      expect(labels.length).toBeGreaterThan(0);
      const targetDay = labels[0];
      expect(/^\d{4}-\d{2}-\d{2}$/.test(targetDay)).toBe(true);

      // Invoke the chart's onClick directly — jsdom can't synthesize the
      // Chart.js-style click event, so we call the handler the same way
      // Chart.js does internally.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const onClick = (barChart as any).options.onClick as (
        evt: unknown,
        elements: Array<{ index: number }>,
      ) => void;
      expect(typeof onClick).toBe("function");
      onClick({}, [{ index: 0 }]);

      await flushAsync();

      const after = calls.slice(initialCount);
      const summaryCall = after.find((u) =>
        u.startsWith("/api/analytics/summary"),
      );
      expect(summaryCall).toBeDefined();
      const qs = parseQS(summaryCall!.split("?")[1] ?? "");
      expect(qs.from).toBe(targetDay);
      expect(qs.to).toBe(targetDay);
      expect(qs.days).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Custom-range popover: typing dates + clicking Apply should send those
// explicit dates on all four endpoints.
// ---------------------------------------------------------------------------

describe("analytics dashboard UI — custom-range apply", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("typing from/to + clicking Apply sends those explicit dates to every endpoint", async () => {
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": () => canned(3, 100).summary,
      "/api/analytics/tool-counts": () => canned(3, 100).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };

    const { dom, calls } = await loadDashboard(endpoints);
    const initialCount = calls.length;

    // Open popover, then click the Custom preset to reveal the inputs.
    const datePill = dom.window.document.getElementById("datePill")!;
    datePill.dispatchEvent(
      new dom.window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      }),
    );
    const customPreset = dom.window.document.querySelector(
      ".preset[data-custom]",
    ) as HTMLElement | null;
    expect(customPreset).not.toBeNull();
    customPreset!.dispatchEvent(
      new dom.window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      }),
    );

    // Fill both inputs. Use dispatchEvent('input') so draft state updates
    // the way real user typing would.
    const fromEl = dom.window.document.getElementById(
      "dateFromInput",
    ) as HTMLInputElement;
    const toEl = dom.window.document.getElementById(
      "dateToInput",
    ) as HTMLInputElement;
    expect(fromEl).not.toBeNull();
    expect(toEl).not.toBeNull();
    fromEl.value = "2026-04-05";
    fromEl.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    toEl.value = "2026-04-15";
    toEl.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    // Click Apply.
    const applyBtn = dom.window.document.getElementById("dateApplyBtn")!;
    applyBtn.dispatchEvent(
      new dom.window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      }),
    );

    await flushAsync();

    const after = calls.slice(initialCount);
    for (const p of [
      "/api/analytics/summary",
      "/api/analytics/tool-counts",
      "/api/analytics/queries",
      "/api/analytics/empty-queries",
    ]) {
      const call = after.find((u) => u.startsWith(p));
      expect(call, p + " should be refetched on Apply").toBeDefined();
      const qs = parseQS(call!.split("?")[1] ?? "");
      expect(qs.from, p + " from").toBe("2026-04-05");
      expect(qs.to, p + " to").toBe("2026-04-15");
      expect(qs.days, p + " should not send days").toBeUndefined();
    }
  });
});

describe("analytics dashboard UI — HTML escaping", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("escapes double quotes in source_name so the data-source attribute stays well-formed", async () => {
    // A source_name containing a literal `"` must not break out of the
    // data-source="..." attribute. The old esc() used a div.textContent
    // round-trip that escaped <, >, & but NOT " — a malicious or
    // unexpected source name could inject attributes or markup via the
    // source-filter pill. Verify the DOM we build contains exactly one
    // pill element (no injection) and the attribute decodes cleanly.
    const malicious = 'weird" onclick="steal()" x="';
    const total = 42;
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": () => ({
        total_queries: total,
        total_queries_window: total,
        empty_result_rate_window: 0,
        empty_result_count_window: 0,
        avg_latency_ms_window: 0,
        p95_latency_ms_window: 0,
        queries_per_day_window: [],
        queries_by_source: [{ source_name: malicious, count: total }],
      }),
      "/api/analytics/tool-counts": () => [],
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };

    const { dom } = await loadDashboard(endpoints);

    // The source filter pills live in #filters. Exactly one real source
    // pill plus one "All Sources" pill should exist — any injected
    // element from a broken escape would show up as an extra child.
    const sourcePills = dom.window.document.querySelectorAll(
      '.pill[data-source], .pill[data-source-all]',
    );
    expect(sourcePills.length).toBe(2);

    // The malicious source_name must round-trip losslessly through the
    // attribute — getAttribute() decodes HTML entities back to the raw
    // string. If the `"` wasn't escaped, parsing would have truncated
    // the attribute at the first quote.
    const real = Array.from(sourcePills).find((el) =>
      el.hasAttribute("data-source"),
    );
    expect(real).toBeDefined();
    expect(real!.getAttribute("data-source")).toBe(malicious);

    // No stray onclick attribute should have leaked into the pill.
    expect(real!.hasAttribute("onclick")).toBe(false);
  });
});

describe("analytics dashboard UI — unfilteredSourcesCache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Shared summary builder: the server narrows queries_by_source based on
  // active filters (like the real /api/analytics/summary handler does).
  // Without the client-side cache, applying a filter would make the
  // source-filter pills collapse down to just the filtered sources and
  // leave the user unable to switch back to the other sources without a
  // full reload.
  const FULL_SOURCES = [
    { source_name: "docs", count: 30 },
    { source_name: "api", count: 20 },
    { source_name: "blog", count: 10 },
  ];

  function summaryHandlerFor(total: number) {
    return (qs: string) => {
      const params = new URLSearchParams(qs);
      const source = params.get("source");
      const toolType = params.get("tool_type");
      // Narrow the by-source list when filters are active, the way a
      // real server would. When source is set, return just that source;
      // when tool_type is set (alone or with source), return a subset.
      let bySource;
      if (source) {
        bySource = FULL_SOURCES.filter((s) => s.source_name === source);
      } else if (toolType) {
        // tool_type alone returns only the sources that actually have
        // that tool — simulate by returning just the first one.
        bySource = FULL_SOURCES.slice(0, 1);
      } else {
        bySource = FULL_SOURCES.slice();
      }
      return {
        total_queries: total,
        total_queries_window: total,
        empty_result_rate_window: 0,
        empty_result_count_window: 0,
        avg_latency_ms_window: 100,
        p95_latency_ms_window: 200,
        queries_per_day_window: [],
        queries_by_source: bySource,
      };
    };
  }

  function buildEndpoints(total: number = 60) {
    return {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": summaryHandlerFor(total),
      "/api/analytics/tool-counts": () => [
        { tool_type: "search", count: total },
        { tool_type: "explore", count: total / 2 },
      ],
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };
  }

  function sourcePillNames(dom: JSDOM): string[] {
    const pills = dom.window.document.querySelectorAll(
      ".pill[data-source]",
    ) as NodeListOf<HTMLElement>;
    return Array.from(pills).map((p) => p.getAttribute("data-source") ?? "");
  }

  it("renders all unfiltered sources as pills on initial load", async () => {
    const { dom } = await loadDashboard(buildEndpoints());
    expect(sourcePillNames(dom).sort()).toEqual(
      ["api", "blog", "docs"].sort(),
    );
  });

  it("preserves all sources in pills after applying a tool_type filter", async () => {
    const { dom } = await loadDashboard(buildEndpoints());
    // Click the explore tool pill — this applies tool_type=explore
    // which narrows the server's queries_by_source response, but the
    // unfilteredSourcesCache (populated on the initial unfiltered load)
    // should keep the full pill set visible so the user can still pick
    // any source to cross-filter.
    const explorePill = dom.window.document.querySelector(
      '.pill[data-tool="explore"]',
    ) as HTMLElement | null;
    expect(explorePill).not.toBeNull();
    explorePill!.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flushAsync();

    expect(sourcePillNames(dom).sort()).toEqual(
      ["api", "blog", "docs"].sort(),
    );
  });

  it("invalidates the cache when a source filter is applied so pills reflect the filtered response", async () => {
    // Source-filter clicks explicitly drop the cache (see analytics.html
    // — "Clearing/changing the source filter means the next fetch may
    // return a narrower set of sources in summary"). The next fetch's
    // narrower response re-seeds what pills render.
    const { dom } = await loadDashboard(buildEndpoints());
    expect(sourcePillNames(dom).length).toBe(3);

    const docsPill = dom.window.document.querySelector(
      '.pill[data-source="docs"]',
    ) as HTMLElement | null;
    expect(docsPill).not.toBeNull();
    docsPill!.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flushAsync();

    // Only the filtered source remains — cache was dropped and the
    // narrower summary response re-seeded the pill list.
    expect(sourcePillNames(dom)).toEqual(["docs"]);
  });

  it("invalidates the cache when the date preset changes so the next load reseeds from a fresh unfiltered fetch", async () => {
    // Start with the full set.
    const { dom } = await loadDashboard(buildEndpoints());
    expect(sourcePillNames(dom).length).toBe(3);

    // Apply tool_type=explore — the cache retains the full set behind
    // this narrowed view.
    const explorePill = dom.window.document.querySelector(
      '.pill[data-tool="explore"]',
    ) as HTMLElement | null;
    explorePill!.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flushAsync();
    expect(sourcePillNames(dom).length).toBe(3);

    // Changing the date preset should invalidate the cache — sources
    // counted under the old window are not the right snapshot for the
    // new window. The next fetch still carries tool_type=explore though,
    // so the narrow-by-tool response is what repopulates the pills.
    dom.window.document
      .getElementById("datePill")!
      .dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    const thirty = dom.window.document.querySelector(
      '.preset[data-days="30"]',
    ) as HTMLElement | null;
    expect(thirty).not.toBeNull();
    thirty!.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flushAsync();

    // The tool_type filter is still active, so the server returns a
    // narrowed by-source list (our handler returns [FULL_SOURCES[0]]
    // when tool_type is set). The cache was invalidated on the preset
    // change, so the pills now reflect that narrowed response rather
    // than the stale cache — exactly the "fresh fetch on date change"
    // contract.
    expect(sourcePillNames(dom)).toEqual(["docs"]);
  });
});
