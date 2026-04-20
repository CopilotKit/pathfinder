import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (win as any).Chart = ChartStub;
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
  const { instances } = installChartStub(win);
  const { fetchFn, calls } = buildFetchStub(handlers);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (win as any).fetch = fetchFn;

  // Pull out the inline <script> and execute in the window.
  const scriptEl = dom.window.document.querySelector("script:not([src])");
  if (!scriptEl) throw new Error("inline script not found in analytics.html");
  const code = scriptEl.textContent ?? "";
  dom.window.eval(code);

  // Init runs async (auth-mode check → load). Flush microtasks.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

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
  beforeEach(() => {
    // Ensure no lingering preview mode or token from other tests.
    // jsdom gives a fresh window per test anyway, but be defensive.
  });
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
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

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

    // Daily bar chart should be re-rendered with 30 bars.
    const lastBarChart = [...chartInstances]
      .reverse()
      .find((c) => c.type === "bar");
    expect(lastBarChart).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const labels = (lastBarChart as any).data.labels as string[];
    expect(labels).toHaveLength(30);
  });

  it("clicking 'Today' sends from=<today>&to=<today> (both equal, UTC), not days=1", async () => {
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
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    // Click "Today" preset. data-days is whatever the UI chose — the test
    // only asserts on outbound fetches, which is what actually matters.
    const todayPreset = Array.from(
      dom.window.document.querySelectorAll(".preset"),
    ).find((el) => el.textContent?.trim().startsWith("Today")) as
      | HTMLElement
      | undefined;
    expect(todayPreset).toBeDefined();
    todayPreset!.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const after = calls.slice(initial.length);
    const summaryCall = after.find((u) =>
      u.startsWith("/api/analytics/summary"),
    );
    expect(summaryCall).toBeDefined();
    const qs = parseQS(summaryCall!.split("?")[1] ?? "");

    const today = todayUTC();
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
    const todayPreset = Array.from(
      dom.window.document.querySelectorAll(".preset"),
    ).find((el) => el.textContent?.trim().startsWith("Today")) as HTMLElement;
    todayPreset.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

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
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

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
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  async function clickToday(dom: JSDOM) {
    dom.window.document
      .getElementById("datePill")!
      .dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    const todayPreset = Array.from(
      dom.window.document.querySelectorAll(".preset"),
    ).find((el) => el.textContent?.trim().startsWith("Today")) as
      | HTMLElement
      | undefined;
    todayPreset!.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
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
