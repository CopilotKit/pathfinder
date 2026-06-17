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
 * Flush two rounds of microtasks. Double-`await setTimeout(r, 0)` is
 * needed because the dashboard's load() chain does an auth-mode fetch
 * that then triggers the real data fetches; a single flush covers only
 * the first hop. Named helper makes intent explicit at call sites.
 */
async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * Handler response shape:
 *   - Bare value → JSON body, status 200.
 *   - { status, body } → custom HTTP status + body (for error-path tests).
 *   - { status, rawBody, contentType? } → raw string body with explicit
 *     content-type. Use this for non-JSON 5xx payloads to exercise the
 *     `res.json().catch(...)` branch in fetchJson.
 *   - Promise<either> → deferred response, useful for racing out-of-order
 *     load() responses.
 */
type HandlerResult =
  | unknown
  | { status: number; body: unknown }
  | { status: number; rawBody: string; contentType?: string }
  | Promise<
      | unknown
      | { status: number; body: unknown }
      | { status: number; rawBody: string; contentType?: string }
    >;

function isStatusBody(v: unknown): v is { status: number; body: unknown } {
  return (
    typeof v === "object" &&
    v !== null &&
    "status" in v &&
    typeof (v as { status: unknown }).status === "number" &&
    "body" in v
  );
}

function isStatusRawBody(
  v: unknown,
): v is { status: number; rawBody: string; contentType?: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    "status" in v &&
    typeof (v as { status: unknown }).status === "number" &&
    "rawBody" in v &&
    typeof (v as { rawBody: unknown }).rawBody === "string"
  );
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
function buildFetchStub(
  handlers: Record<string, (qs: string) => HandlerResult>,
) {
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
    // Await so handlers can return Promises (deferred responses) for
    // race-condition testing.
    const result = await handler(qs);
    if (isStatusRawBody(result)) {
      return new Response(result.rawBody, {
        status: result.status,
        headers: {
          "Content-Type": result.contentType ?? "text/plain",
        },
      });
    }
    if (isStatusBody(result)) {
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { fetchFn, calls };
}

async function loadDashboard(
  handlers: Record<string, (qs: string) => HandlerResult>,
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
      ".pill[data-source], .pill[data-source-all]",
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
    expect(sourcePillNames(dom).sort()).toEqual(["api", "blog", "docs"].sort());
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

    expect(sourcePillNames(dom).sort()).toEqual(["api", "blog", "docs"].sort());
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

// ---------------------------------------------------------------------------
// loadGeneration race guard: if the user clicks preset B before preset A's
// response resolves, A's stale payload must NOT clobber the UI with old data.
// ---------------------------------------------------------------------------

describe("analytics dashboard UI — loadGeneration race guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stale summary response from an earlier click is discarded (only the latest click's data renders)", async () => {
    // Deferred promise for the "Last 30 days" summary response so we can
    // force its resolution to happen after the "Last 7 days" click fires.
    let resolveThirty: ((v: unknown) => void) | null = null;
    const thirtyPending = new Promise((resolve) => {
      resolveThirty = resolve;
    });

    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": (qs: string) => {
        const p = parseQS(qs);
        const days = p.days ? parseInt(p.days, 10) : 7;
        if (days === 30) {
          // Return the pending promise; test will resolve it AFTER the
          // 7-day click has been dispatched, forcing out-of-order arrival.
          return thirtyPending.then(() => canned(30, 3000).summary);
        }
        if (days === 7) {
          return canned(7, 7777).summary;
        }
        return canned(days, 1111).summary;
      },
      "/api/analytics/tool-counts": () => canned(1, 0).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };

    const { dom } = await loadDashboard(endpoints);

    // Click "Last 30 days" — this fires a load() that will hang on the
    // deferred summary response.
    dom.window.document
      .getElementById("datePill")!
      .dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    const thirty = Array.from(
      dom.window.document.querySelectorAll(".preset[data-days]"),
    ).find((el) => el.getAttribute("data-days") === "30") as HTMLElement;
    thirty.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    // Click "Last 7 days" BEFORE 30's deferred promise resolves. This
    // bumps loadGeneration; 30's response will then be dropped when it
    // finally arrives.
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

    // Now let the 30-day response finally resolve (stale).
    resolveThirty!(undefined);

    // Flush microtasks so both pending summary responses settle.
    await flushAsync();
    await flushAsync();

    // Only preset B's (7-day) data should render; preset A's (30-day) is
    // discarded by the loadGeneration guard.
    const statsHtml = dom.window.document.getElementById("stats")!.innerHTML;
    expect(statsHtml).toContain("7,777");
    expect(statsHtml).not.toContain("3,000");
  });
});

// ---------------------------------------------------------------------------
// Dashboard error-banner path: a non-2xx from the summary endpoint should
// surface in #error, and a subsequent successful load should hide it again.
// ---------------------------------------------------------------------------

describe("analytics dashboard UI — error banner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows #error with 'Failed to load analytics' when the summary endpoint returns HTTP 500", async () => {
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": () => ({
        status: 500,
        body: { error: "internal", error_description: "db exploded" },
      }),
      "/api/analytics/tool-counts": () => canned(1, 0).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };
    // Swallow the [analytics] load() console.error — it's intentional and
    // the test assertion lives on the banner, not on the log.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { dom } = await loadDashboard(endpoints);
    // One extra flush in case the catch block's rendering lands after
    // the default loadDashboard flush.
    await flushAsync();

    const errorEl = dom.window.document.getElementById("error")!;
    expect(errorEl.style.display).toBe("block");
    expect(errorEl.textContent).toContain("Failed to load analytics");
    errSpy.mockRestore();
  });

  it("hides #error on a subsequent successful load", async () => {
    let failNext = true;
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": () => {
        if (failNext) {
          failNext = false;
          return {
            status: 500,
            body: { error: "internal", error_description: "transient" },
          };
        }
        return canned(7, 8888).summary;
      },
      "/api/analytics/tool-counts": () => canned(1, 0).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { dom } = await loadDashboard(endpoints);
    await flushAsync();

    // First load failed — banner is visible.
    const errorEl = dom.window.document.getElementById("error")!;
    expect(errorEl.style.display).toBe("block");

    // Trigger a fresh load. On the failure path #filters stays hidden so
    // there's no datePill to click — invoke the dashboard's global load()
    // directly instead, which is what any user-initiated retry funnels
    // through in the happy path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (dom.window as any).load();
    await flushAsync();

    // Second load succeeded — banner hidden, stats rendered.
    expect(errorEl.style.display).toBe("none");
    const statsHtml = dom.window.document.getElementById("stats")!.innerHTML;
    expect(statsHtml).toContain("8,888");
    errSpy.mockRestore();
  });

  // fetchJson's fallback branch at docs/analytics.html — when a non-2xx
  // response body isn't valid JSON, the JSON.parse catch logs + returns
  // `{}`, and the error message falls back to the raw text body (capped
  // at 200 chars) rather than a bare "HTTP <status>". Verify the raw
  // body surfaces through to the error banner so operators get a real
  // clue about what the upstream returned.
  it("shows #error with raw body text when the summary endpoint returns non-JSON 500", async () => {
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": () => ({
        status: 500,
        rawBody: "<html><body>Internal Server Error</body></html>",
        contentType: "text/html",
      }),
      "/api/analytics/tool-counts": () => canned(1, 0).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };
    // Swallow the intentional console.error from load()'s catch + the
    // fetchJson parse-fail log, since the test assertion lives on the
    // banner, not the logs.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { dom } = await loadDashboard(endpoints);
    await flushAsync();

    const errorEl = dom.window.document.getElementById("error")!;
    expect(errorEl.style.display).toBe("block");
    // Raw body surfaces through — "Internal Server Error" is the useful
    // signal, not the generic "HTTP 500".
    expect(errorEl.textContent).toContain("Internal Server Error");
    errSpy.mockRestore();
  });

  // Empty body with non-2xx status falls all the way through to the
  // "HTTP <status>" marker since there's nothing else to surface.
  it("shows #error with 'HTTP 500' marker when the body is empty", async () => {
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": () => ({
        status: 500,
        rawBody: "",
        contentType: "text/plain",
      }),
      "/api/analytics/tool-counts": () => canned(1, 0).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { dom } = await loadDashboard(endpoints);
    await flushAsync();

    const errorEl = dom.window.document.getElementById("error")!;
    expect(errorEl.style.display).toBe("block");
    expect(errorEl.textContent).toContain("HTTP 500");
    errSpy.mockRestore();
  });

  it("shows #error with String(err) fallback when the summary handler rejects with a non-Error", async () => {
    // load()'s catch uses `err && err.message ? err.message : String(err)`
    // so a non-Error throw (a plain string, undefined, etc.) degrades
    // gracefully to String(err) instead of rendering "undefined". This
    // locks down that fallback — pre-fix, interpolating `err.message`
    // directly would surface "Failed to load analytics: undefined" for
    // any non-Error reject.
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      // Reject with a plain string. The handler returns a pre-rejected
      // Promise so buildFetchStub's `await handler(qs)` propagates it out
      // through fetchFn, tripping load()'s catch rather than fetchJson's.
      "/api/analytics/summary": () => Promise.reject("network down"),
      "/api/analytics/tool-counts": () => canned(1, 0).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { dom } = await loadDashboard(endpoints);
    await flushAsync();

    const errorEl = dom.window.document.getElementById("error")!;
    expect(errorEl.style.display).toBe("block");
    expect(errorEl.textContent).toContain("Failed to load analytics");
    expect(errorEl.textContent).toContain("network down");
    errSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// fetchJson 401/403 auth-failure path: token must be wiped, login modal
// must be shown, and the server-supplied error_description must render in
// the login error slot. This exercises the pre-fetchJson-body branch.
// ---------------------------------------------------------------------------

describe("analytics dashboard UI — fetchJson 401/403 auth failure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("401 summary response clears stored token, shows login, and renders error_description", async () => {
    const endpoints = {
      // Non-dev mode so a token is required — this steers init() through
      // the real token-probe code path instead of the dev short-circuit.
      "/api/analytics/auth-mode": () => ({ dev: false }),
      "/api/analytics/summary": () => ({
        status: 401,
        body: { error: "unauthorized", error_description: "token expired" },
      }),
      "/api/analytics/tool-counts": () => canned(1, 0).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };
    // Prime sessionStorage with a stale token BEFORE the page loads so the
    // dashboard picks it up as TOKEN at init time. We need to seed the
    // storage via the jsdom window — not the test's process.sessionStorage —
    // so plumb it in by instrumenting loadDashboard inline instead of using
    // the helper (which clobbers window.fetch after doc load).
    const html = fs.readFileSync(
      path.join(process.cwd(), "docs", "analytics.html"),
      "utf8",
    );
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", () => {});
    const dom = new JSDOM(html, {
      runScripts: "outside-only",
      url: "http://localhost/analytics",
      pretendToBeVisual: true,
      virtualConsole,
    });
    const win = dom.window as unknown as Window & typeof globalThis;
    Object.assign(win, { Date: globalThis.Date });
    // Chart stub.
    class ChartStub {
      type: string;
      data: unknown;
      options: unknown;
      constructor(
        _ctx: unknown,
        cfg: { type: string; data: unknown; options: unknown },
      ) {
        this.type = cfg.type;
        this.data = cfg.data;
        this.options = cfg.options;
      }
      destroy() {}
    }
    Object.assign(win, { Chart: ChartStub });
    // Seed the stale token before the inline script runs.
    dom.window.sessionStorage.setItem(
      "pathfinder_analytics_token",
      "old-token",
    );
    const { fetchFn } = buildFetchStub(endpoints);
    Object.assign(win, { fetch: fetchFn });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const scriptEl = dom.window.document.querySelector("script:not([src])");
    const code = scriptEl?.textContent ?? "";
    dom.window.eval(code);
    await flushAsync();
    await flushAsync();

    // Token must be wiped from sessionStorage — fetchJson strips it on 401.
    expect(
      dom.window.sessionStorage.getItem("pathfinder_analytics_token"),
    ).toBeNull();

    // Login modal is visible.
    const login = dom.window.document.getElementById("login")!;
    expect(login.style.display).toBe("flex");

    // Server-supplied error_description surfaces verbatim in loginError.
    const loginErr = dom.window.document.getElementById("loginError")!;
    expect(loginErr.textContent).toBe("token expired");
    errSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Custom-range invalid-input handling: when the user types a non-YYYY-MM-DD
// value and clicks Apply, the handler renders an inline error, logs a warn,
// and does NOT fire a fetch. Popover stays open so the user can correct the
// value. Locks down the UX contract so silent-rejection regressions are
// caught, and so re-validating with a good value clears the error + reloads.
// ---------------------------------------------------------------------------

describe("analytics dashboard UI — custom-range invalid input", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clicking Apply with a non-YYYY-MM-DD value shows an inline error and blocks fetch", async () => {
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": () => canned(3, 500).summary,
      "/api/analytics/tool-counts": () => canned(3, 500).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };

    const { dom, calls } = await loadDashboard(endpoints);
    const fetchCountBefore = calls.length;

    // Silence the console.warn emitted by the Apply handler's rejected path
    // so test output stays clean — we assert on DOM state, not log bodies.
    const warnSpy = vi
      .spyOn(dom.window.console, "warn")
      .mockImplementation(() => {});

    // Open the popover and reveal the custom-range inputs.
    const datePill = dom.window.document.getElementById("datePill")!;
    datePill.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    const customPreset = dom.window.document.querySelector(
      ".preset[data-custom]",
    ) as HTMLElement | null;
    expect(customPreset).not.toBeNull();
    customPreset!.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    // Set an invalid `from`. `to` stays empty.
    const fromEl = dom.window.document.getElementById(
      "dateFromInput",
    ) as HTMLInputElement;
    expect(fromEl).not.toBeNull();
    fromEl.value = "not-a-date";
    fromEl.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    // Click Apply — handler early-returns when either input fails the
    // YYYY-MM-DD regex, and renders an inline error.
    const applyBtn = dom.window.document.getElementById("dateApplyBtn")!;
    applyBtn.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flushAsync();

    // No new fetches fired (activeFrom/activeTo unchanged → no reload).
    expect(calls.length).toBe(fetchCountBefore);
    // Popover still open — the early-return path doesn't close it.
    const popover = dom.window.document.getElementById("datePopover");
    expect(popover).not.toBeNull();
    // Inline error is visible with the expected message.
    const dateErr = dom.window.document.getElementById(
      "dateError",
    ) as HTMLElement | null;
    expect(dateErr).not.toBeNull();
    expect(dateErr!.style.display).toBe("block");
    expect(dateErr!.textContent).toBe("Dates must be YYYY-MM-DD format");
    // Handler warns to devtools so operators can correlate a silent UI.
    expect(warnSpy).toHaveBeenCalled();

    // Re-validate with a valid date range — error clears, fetch issues.
    const fromEl2 = dom.window.document.getElementById(
      "dateFromInput",
    ) as HTMLInputElement;
    const toEl2 = dom.window.document.getElementById(
      "dateToInput",
    ) as HTMLInputElement;
    fromEl2.value = "2024-01-01";
    fromEl2.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    toEl2.value = "2024-01-31";
    toEl2.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    const applyBtn2 = dom.window.document.getElementById("dateApplyBtn")!;
    applyBtn2.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flushAsync();

    // New fetches fired (load() issues multiple analytics GETs).
    expect(calls.length).toBeGreaterThan(fetchCountBefore);
    // Error was cleared before the successful apply — because the popover
    // closes on a valid apply, the #dateError element is torn down; assert
    // that the popover is closed (no stale error DOM left behind).
    const popoverAfter = dom.window.document.getElementById("datePopover");
    expect(popoverAfter).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Preview mode (?preview=1): the inline `setupPreviewMode` IIFE installs
// its OWN window.fetch stub that returns canned JSON for /api/analytics/*
// paths. This test loads the page WITHOUT stubbing window.fetch ourselves
// and asserts that (a) the canned totals render to the stats card and (b)
// the MOCK DATA banner is injected. If the preview interceptor regresses,
// real fetch would be invoked against /api/analytics/summary and jsdom
// would reject (no network), blanking the dashboard — this test catches
// that regression end-to-end.
// ---------------------------------------------------------------------------

describe("analytics dashboard UI — preview mode (?preview=1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders canned totals and MOCK DATA banner without hitting real fetch", async () => {
    const html = fs.readFileSync(
      path.join(process.cwd(), "docs", "analytics.html"),
      "utf8",
    );
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", () => {});
    const dom = new JSDOM(html, {
      runScripts: "outside-only",
      // Critical: preview=1 is what flips the IIFE on.
      url: "http://localhost/analytics?preview=1",
      pretendToBeVisual: true,
      virtualConsole,
    });

    const win = dom.window as unknown as Window & typeof globalThis;
    Object.assign(win, { Date: globalThis.Date });
    // jsdom 21+ provides Response on the window, but older versions
    // don't. The preview IIFE calls `new Response(...)` directly, so
    // forward the node Response constructor if the window lacks it.
    if (typeof (win as { Response?: unknown }).Response === "undefined") {
      Object.assign(win, { Response: globalThis.Response });
    }
    installChartStub(win);

    // Do NOT replace window.fetch with a stub. Instead, wrap the real
    // jsdom fetch with a spy so we can assert it was NEVER invoked with
    // a /api/analytics/* URL — the preview-mode interceptor should
    // short-circuit all such calls from inside the dashboard script.
    // jsdom's built-in fetch attempts a real network call and throws
    // "TypeError: Failed to fetch" on localhost, which would blank the
    // dashboard if the interceptor missed a path.
    const fetchSpy = vi.fn(win.fetch?.bind(win) ?? (() => Promise.reject()));
    Object.assign(win, { fetch: fetchSpy });

    const scriptEl = dom.window.document.querySelector("script:not([src])");
    if (!scriptEl) throw new Error("inline script not found in analytics.html");
    const code = scriptEl.textContent ?? "";
    dom.window.eval(code);

    // Flush microtasks several times so the preview IIFE's fetch
    // overwrite + init() + all awaited loads (summary, tool-counts,
    // queries, empty-queries) resolve. The init() chain is at least 3
    // async hops deep (auth-mode skip → load() → Promise.all fetches).
    for (let i = 0; i < 10; i++) await flushAsync();

    // Preview flag must have been set by the IIFE.
    expect(
      (win as unknown as { __pathfinderPreview?: boolean }).__pathfinderPreview,
    ).toBe(true);
    // Also verify window.fetch was overridden by the preview IIFE (it
    // replaces win.fetch with its own interceptor). If this fails, the
    // URL search-params check in setupPreviewMode didn't flip.
    expect(win.fetch).not.toBe(fetchSpy);

    // Stats card renders the canned total — 6128 is the literal in
    // CANNED[/api/analytics/summary].total_queries (see analytics.html).
    // Locale-formatted as "6,128" when rendered.
    const statsHtml = dom.window.document.getElementById("stats")!.innerHTML;
    expect(statsHtml).toContain("6,128");

    // "MOCK DATA" watermark banner must be visible so screenshots can't
    // be confused for live dashboards.
    expect(dom.window.document.body.textContent).toContain("MOCK DATA");

    // Sanity check: the dashboard code path never invoked the SPY's
    // unwrapped fetch with a real /api/analytics/* URL — the preview
    // IIFE's own window.fetch override intercepts those paths and
    // returns canned Responses directly without delegating to the
    // wrapped original. (The IIFE captures originalFetch = window.fetch
    // at IIFE-invocation time; after that point, every call inside
    // setupPreviewMode's override bypasses our spy.)
    //
    // However, since the IIFE's override runs BEFORE init(), and our
    // spy was installed BEFORE the script was evaluated, the spy is
    // also the `originalFetch` captured by the IIFE. Calls for
    // /api/analytics/* are short-circuited inside the override (not
    // delegated). So the spy is only invoked for non-analytics URLs
    // (i.e. nothing). Assert no /api/analytics/ call reached the spy:
    const analyticsCalls = fetchSpy.mock.calls.filter((args) => {
      const url = args[0];
      return typeof url === "string" && url.indexOf("/api/analytics/") === 0;
    });
    expect(analyticsCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// p95 sampled-ness rendering
// ---------------------------------------------------------------------------

describe("analytics dashboard UI — p95 sampled badge", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a '(sampled)' suffix and '~' prefix when summary.p95_latency_sampled is true", async () => {
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": () => ({
        total_queries: 1000,
        total_queries_window: 500,
        empty_result_rate_window: 0,
        empty_result_count_window: 0,
        avg_latency_ms_window: 100,
        p95_latency_ms_window: 250,
        p95_latency_sampled: true,
        queries_per_day_window: [],
        queries_by_source: [],
      }),
      "/api/analytics/tool-counts": () => [],
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };

    const { dom } = await loadDashboard(endpoints);

    const statsHtml = dom.window.document.getElementById("stats")!.innerHTML;
    // Approximate prefix on the numeric value
    expect(statsHtml).toContain("~250ms");
    // "(sampled)" badge on the P95 card label
    expect(statsHtml).toMatch(/P95 Latency[^<]*\(sampled\)/);
  });

  it("omits sampled indicators when the flag is absent", async () => {
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": () => ({
        total_queries: 1000,
        total_queries_window: 500,
        empty_result_rate_window: 0,
        empty_result_count_window: 0,
        avg_latency_ms_window: 100,
        p95_latency_ms_window: 250,
        queries_per_day_window: [],
        queries_by_source: [],
      }),
      "/api/analytics/tool-counts": () => [],
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };

    const { dom } = await loadDashboard(endpoints);

    const statsHtml = dom.window.document.getElementById("stats")!.innerHTML;
    expect(statsHtml).toContain("250ms");
    expect(statsHtml).not.toContain("~250ms");
    expect(statsHtml).not.toContain("(sampled)");
  });
});

// ---------------------------------------------------------------------------
// Today preset double-highlight regression: clicking Today sets activeFrom =
// activeTo = todayISO() AND clears activeDaysBack. The preset renderer gates
// the days-kind `isActive` check on `activeDaysBack === p.days && !activeFrom`
// so a days preset can't ALSO highlight while Today is active. If the
// `!activeFrom` guard ever regresses, two presets would render with the
// .active class — visually confusing and semantically wrong.
// ---------------------------------------------------------------------------

describe("analytics dashboard UI — Today preset exclusive highlight", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("after clicking Today, re-opening the popover shows exactly one .preset.active and it is Today", async () => {
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": () => canned(1, 500).summary,
      "/api/analytics/tool-counts": () => canned(1, 500).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };

    const { dom } = await loadDashboard(endpoints);
    const doc = dom.window.document;

    // Open popover, click Today.
    doc
      .getElementById("datePill")!
      .dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    const todayPreset = doc.querySelector(
      '.preset[data-preset="today"]',
    ) as HTMLElement;
    todayPreset.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flushAsync();

    // Re-open the popover so renderFilters runs again — this is the path
    // that would render multiple .active pills if the guard regresses.
    doc
      .getElementById("datePill")!
      .dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );

    const activePresets = doc.querySelectorAll(".preset.active");
    expect(activePresets.length).toBe(1);
    const active = activePresets[0] as HTMLElement;
    expect(active.getAttribute("data-preset")).toBe("today");
    // Belt-and-suspenders: text content also identifies Today.
    expect(active.textContent?.trim().startsWith("Today")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Daily bar chart drill-down: when the chart's labels array contains a
// malformed value (not YYYY-MM-DD), the onClick handler must warn via
// console.warn with a stable prefix AND skip the load() reload entirely so
// the UI doesn't kick off a fetch with garbage `from=`/`to=` params.
// ---------------------------------------------------------------------------

describe("analytics dashboard UI — daily chart drill-down malformed-day rejection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("onClick with a malformed day label warns and does not issue a fetch", async () => {
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": () => {
        // Poison queries_per_day_window[0].day with a garbage label so
        // dayLabels[idx] fails the YYYY-MM-DD regex.
        const s = canned(3, 500).summary;
        s.queries_per_day_window[0]!.day = "garbage";
        return s;
      },
      "/api/analytics/tool-counts": () => canned(3, 500).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };

    const { dom, calls, chartInstances } = await loadDashboard(endpoints);
    const fetchCountBefore = calls.length;

    // Spy on console.warn to assert the stable log prefix fired.
    const warnSpy = vi
      .spyOn(dom.window.console, "warn")
      .mockImplementation(() => {});

    // Grab the most recent bar chart instance — that's the daily chart.
    const barChart = [...chartInstances]
      .reverse()
      .find((c) => c.type === "bar") as
      | (typeof chartInstances)[number]
      | undefined;
    expect(barChart).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const labels = (barChart as any).data.labels as string[];
    expect(labels[0]).toBe("garbage");

    // Invoke onClick with the malformed label's index.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onClick = (barChart as any).options.onClick as (
      evt: unknown,
      elements: Array<{ index: number }>,
    ) => void;
    expect(typeof onClick).toBe("function");
    onClick({}, [{ index: 0 }]);

    await flushAsync();

    // No new fetches — the drill-down reload was blocked by the regex check.
    expect(calls.length).toBe(fetchCountBefore);
    // The stable prefix must be logged so operators can correlate.
    const warnCalls = warnSpy.mock.calls;
    const hit = warnCalls.find(
      (args) =>
        typeof args[0] === "string" &&
        (args[0] as string).includes(
          "[analytics] daily chart drill-down: malformed day label",
        ),
    );
    expect(hit).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Custom-range Apply swaps backwards input: if the user enters from >
// to, the handler normalizes so the outbound fetch URL always sends
// from <= to. Locks down the swap behavior so a future refactor that
// drops the swap would surface loudly.
// ---------------------------------------------------------------------------

describe("analytics dashboard UI — custom-range backwards swap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("typing from > to and clicking Apply sends swapped from <= to to every endpoint", async () => {
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": () => canned(3, 100).summary,
      "/api/analytics/tool-counts": () => canned(3, 100).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };

    const { dom, calls } = await loadDashboard(endpoints);
    const initialCount = calls.length;

    // Open popover + reveal custom inputs.
    dom.window.document
      .getElementById("datePill")!
      .dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    const customPreset = dom.window.document.querySelector(
      ".preset[data-custom]",
    ) as HTMLElement;
    customPreset.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    // Type backwards range: from=2024-01-31, to=2024-01-01.
    const fromEl = dom.window.document.getElementById(
      "dateFromInput",
    ) as HTMLInputElement;
    const toEl = dom.window.document.getElementById(
      "dateToInput",
    ) as HTMLInputElement;
    fromEl.value = "2024-01-31";
    fromEl.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    toEl.value = "2024-01-01";
    toEl.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    // Click Apply.
    const applyBtn = dom.window.document.getElementById("dateApplyBtn")!;
    applyBtn.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flushAsync();

    const after = calls.slice(initialCount);
    const summaryCall = after.find((u) =>
      u.startsWith("/api/analytics/summary"),
    );
    expect(summaryCall).toBeDefined();
    // The outbound URL must contain the swapped range — from=2024-01-01
    // (smaller) and to=2024-01-31 (larger). Match the literal substring
    // so the exact concatenation order is locked down.
    expect(summaryCall!).toContain("from=2024-01-01");
    expect(summaryCall!).toContain("to=2024-01-31");
    // Also verify via parsed QS for any of the four endpoints.
    for (const p of [
      "/api/analytics/summary",
      "/api/analytics/tool-counts",
      "/api/analytics/queries",
      "/api/analytics/empty-queries",
    ]) {
      const call = after.find((u) => u.startsWith(p));
      expect(call, p + " should be refetched").toBeDefined();
      const qs = parseQS(call!.split("?")[1] ?? "");
      expect(qs.from, p + " from (swapped)").toBe("2024-01-01");
      expect(qs.to, p + " to (swapped)").toBe("2024-01-31");
    }
  });
});

// ---------------------------------------------------------------------------
// fetchJson stale-401 generation guard: a 401/403 whose originating load()
// has been superseded must NOT wipe a freshly-pasted valid token. The
// fetchJson(url, gen) guard compares `gen` to the current loadGeneration and
// throws without touching TOKEN / headers / sessionStorage when stale.
// Scenario: user has invalid token → load() gen=1 fires → user pastes new
// valid token → load() gen=2 fires → the gen=1 401 arrives. Pre-guard it
// clobbered the new token; post-guard the new token survives.
// ---------------------------------------------------------------------------

describe("analytics dashboard UI — fetchJson stale-401 generation guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a stale 401 from gen=1 does NOT wipe a valid token set by gen=2", async () => {
    // Deferred gen=1 401: held open until AFTER the user pastes a new
    // valid token and gen=2 kicks off. When it finally resolves, the
    // guard must detect the stale generation and early-return.
    let resolveStale401:
      | ((v: { status: number; body: unknown }) => void)
      | null = null;
    const stale401Pending = new Promise<{ status: number; body: unknown }>(
      (resolve) => {
        resolveStale401 = resolve;
      },
    );
    // gen=2 responses (valid token path) — plain 200s.
    let summaryCallCount = 0;
    const endpoints = {
      // Non-dev mode so a token is required for fetchJson.
      "/api/analytics/auth-mode": () => ({ dev: false }),
      "/api/analytics/summary": () => {
        summaryCallCount++;
        if (summaryCallCount === 1) {
          // gen=1 request hangs on the deferred 401.
          return stale401Pending;
        }
        // gen=2 request succeeds.
        return canned(7, 9999).summary;
      },
      "/api/analytics/tool-counts": () => canned(1, 0).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };

    // Inline the loadDashboard dance so we can seed sessionStorage + prime
    // the window.fetch stub BEFORE the script evaluates.
    const html = fs.readFileSync(
      path.join(process.cwd(), "docs", "analytics.html"),
      "utf8",
    );
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", () => {});
    const dom = new JSDOM(html, {
      runScripts: "outside-only",
      url: "http://localhost/analytics",
      pretendToBeVisual: true,
      virtualConsole,
    });
    const win = dom.window as unknown as Window & typeof globalThis;
    Object.assign(win, { Date: globalThis.Date });
    installChartStub(win);
    // Seed a stale token so gen=1 fires (TOKEN is truthy → load() path).
    dom.window.sessionStorage.setItem(
      "pathfinder_analytics_token",
      "old-invalid-token",
    );
    const { fetchFn } = buildFetchStub(endpoints);
    Object.assign(win, { fetch: fetchFn });
    // Silence fetchJson's intentional console.error on the 401 body parse
    // — the fixture returns structured JSON so it won't trigger, but the
    // error banner's catch may log. We assert on DOM/state, not logs.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const scriptEl = dom.window.document.querySelector("script:not([src])");
    const code = scriptEl?.textContent ?? "";
    dom.window.eval(code);
    // gen=1 load fires; its fetches are pending on stale401Pending.
    await flushAsync();

    // User pastes a new valid token via the login handler. This sets
    // TOKEN + headers + sessionStorage AND calls load() (= gen=2).
    const tokenInput = dom.window.document.getElementById(
      "tokenInput",
    ) as HTMLInputElement;
    tokenInput.value = "new-valid-token";
    const tokenSubmit = dom.window.document.getElementById("tokenSubmit")!;
    tokenSubmit.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    // Let gen=2 start and (since gen=2 handler returns synchronously)
    // begin resolving its fetches.
    await flushAsync();

    // NOW resolve the stale gen=1 401. Without the generation guard this
    // would clobber TOKEN + sessionStorage and force a re-login.
    resolveStale401!({
      status: 401,
      body: { error: "unauthorized", error_description: "token expired" },
    });
    // Flush microtasks so the stale handler runs and the gen=2 happy path
    // finishes rendering.
    await flushAsync();
    await flushAsync();
    await flushAsync();

    // The freshly-pasted token must survive — the stale 401 short-circuited
    // via the generation guard without touching TOKEN / sessionStorage.
    expect(
      dom.window.sessionStorage.getItem("pathfinder_analytics_token"),
    ).toBe("new-valid-token");

    // Login modal must be hidden — gen=2 succeeded. A regression
    // (un-guarded stale 401) would re-open the login modal.
    const login = dom.window.document.getElementById("login")!;
    expect(login.style.display).toBe("none");

    // gen=2 data rendered in the stats card.
    const statsHtml = dom.window.document.getElementById("stats")!.innerHTML;
    expect(statsHtml).toContain("9,999");

    errSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// URL-persisted time window: the selected window (days preset or from/to
// custom range) should be mirrored into the page URL via
// history.replaceState so refresh / deep-link preserves the selection.
// These tests load analytics.html with a variety of ?days= / ?from=&to=
// query strings and assert:
//   - on mount, the active window matches the URL
//   - clicks on presets / custom-apply update the URL via replaceState
//   - invalid URL inputs fall back to the 7-day default
//   - other query params (e.g. preview=1) are preserved across writes
// ---------------------------------------------------------------------------

describe("analytics dashboard UI — URL-persisted time window", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Variant of loadDashboard that lets a test supply a custom page URL so we
  // can mount with ?days=N / ?from=&to= query strings. Mirrors the regular
  // helper's wiring (Chart stub, fetch stub, inline-script eval, microtask
  // flush) but exposes the jsdom window so tests can spy on
  // history.replaceState before the click-driven branch runs.
  async function loadDashboardAtUrl(
    pageUrl: string,
    handlers: Record<string, (qs: string) => HandlerResult>,
  ): Promise<{
    dom: JSDOM;
    win: Window & typeof globalThis;
    calls: string[];
    chartInstances: Array<{ type: string; data: unknown; options: unknown }>;
  }> {
    const html = fs.readFileSync(
      path.join(process.cwd(), "docs", "analytics.html"),
      "utf8",
    );
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", () => {});
    const dom = new JSDOM(html, {
      runScripts: "outside-only",
      url: pageUrl,
      pretendToBeVisual: true,
      virtualConsole,
    });

    const win = dom.window as unknown as Window & typeof globalThis;
    Object.assign(win, { Date: globalThis.Date });
    const { instances } = installChartStub(win);
    const { fetchFn, calls } = buildFetchStub(handlers);
    Object.assign(win, { fetch: fetchFn });

    const scriptEl = dom.window.document.querySelector("script:not([src])");
    if (!scriptEl) throw new Error("inline script not found in analytics.html");
    const code = scriptEl.textContent ?? "";
    dom.window.eval(code);

    await flushAsync();

    return { dom, win, calls, chartInstances: instances };
  }

  it("mount with ?days=30 sends days=30 on outbound summary fetch and labels the pill 'Last 30 days'", async () => {
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": (qs: string) => {
        const p = parseQS(qs);
        const days = p.days ? parseInt(p.days, 10) : 7;
        return canned(days, 4242).summary;
      },
      "/api/analytics/tool-counts": () => canned(1, 0).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };

    const { dom, calls } = await loadDashboardAtUrl(
      "http://localhost/analytics?days=30",
      endpoints,
    );

    const summaryCall = calls.find((u) =>
      u.startsWith("/api/analytics/summary"),
    );
    expect(summaryCall).toBeDefined();
    const qs = parseQS(summaryCall!.split("?")[1] ?? "");
    expect(qs.days).toBe("30");
    expect(qs.from).toBeUndefined();
    expect(qs.to).toBeUndefined();

    // Pill label reflects the parsed 30-day window.
    const pillLabel = dom.window.document
      .querySelector("#datePill .date-value")
      ?.textContent?.trim();
    expect(pillLabel).toBe("Last 30 days");
  });

  it("mount with ?from=&to= sends that range on outbound fetch and uses range-format pill label", async () => {
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": () => canned(10, 100).summary,
      "/api/analytics/tool-counts": () => canned(1, 0).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };

    const { dom, calls } = await loadDashboardAtUrl(
      "http://localhost/analytics?from=2026-04-01&to=2026-04-10",
      endpoints,
    );

    const summaryCall = calls.find((u) =>
      u.startsWith("/api/analytics/summary"),
    );
    expect(summaryCall).toBeDefined();
    const qs = parseQS(summaryCall!.split("?")[1] ?? "");
    expect(qs.from).toBe("2026-04-01");
    expect(qs.to).toBe("2026-04-10");
    expect(qs.days).toBeUndefined();

    // Range pill uses short-date format: "Apr 1 – Apr 10" (locale-dependent,
    // so match by the en-dash separator rather than the exact label).
    const pillLabel = dom.window.document
      .querySelector("#datePill .date-value")
      ?.textContent?.trim();
    expect(pillLabel).toContain("–"); // en-dash between from and to
    // Must NOT contain any "Last N days" wording.
    expect(pillLabel).not.toMatch(/Last \d+ days/);
  });

  it("clicking the '14 days' preset updates the URL via replaceState with days=14 and drops from/to", async () => {
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": () => canned(7, 100).summary,
      "/api/analytics/tool-counts": () => canned(1, 0).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };

    const { dom, win } = await loadDashboardAtUrl(
      // Seed from/to in the URL so we can assert the preset click CLEARS them.
      "http://localhost/analytics?from=2026-04-01&to=2026-04-05",
      endpoints,
    );

    // Spy on history.replaceState AFTER mount so we only capture the click-
    // driven calls. Preserve the real implementation so jsdom's URL updates.
    const realReplace = win.history.replaceState.bind(win.history);
    const replaceSpy = vi.fn(
      (data: unknown, unused: string, url?: string | null) => {
        realReplace(data, unused, url ?? undefined);
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (win.history as any).replaceState = replaceSpy;

    // Open popover + click "14 days" preset.
    dom.window.document
      .getElementById("datePill")!
      .dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    const fourteen = Array.from(
      dom.window.document.querySelectorAll(".preset[data-days]"),
    ).find((el) => el.getAttribute("data-days") === "14") as HTMLElement;
    fourteen.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flushAsync();

    expect(replaceSpy).toHaveBeenCalled();
    // jsdom's location reflects the replaceState url. Inspect the last
    // written URL so we confirm both: days=14 is added AND from/to are
    // dropped in the same write.
    const finalSearch = win.location.search;
    const finalQS = parseQS(
      finalSearch.startsWith("?") ? finalSearch.slice(1) : finalSearch,
    );
    expect(finalQS.days).toBe("14");
    expect(finalQS.from).toBeUndefined();
    expect(finalQS.to).toBeUndefined();
  });

  it("clicking Apply on a valid custom range updates the URL with from/to (no days)", async () => {
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": () => canned(3, 100).summary,
      "/api/analytics/tool-counts": () => canned(1, 0).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };

    const { dom, win } = await loadDashboardAtUrl(
      // Seed days= in the URL so we can assert Apply CLEARS it.
      "http://localhost/analytics?days=30",
      endpoints,
    );

    // Open popover, reveal custom, fill inputs, click Apply.
    dom.window.document
      .getElementById("datePill")!
      .dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    const customPreset = dom.window.document.querySelector(
      ".preset[data-custom]",
    ) as HTMLElement;
    customPreset.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    const fromEl = dom.window.document.getElementById(
      "dateFromInput",
    ) as HTMLInputElement;
    const toEl = dom.window.document.getElementById(
      "dateToInput",
    ) as HTMLInputElement;
    fromEl.value = "2024-02-10";
    fromEl.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    toEl.value = "2024-02-20";
    toEl.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    dom.window.document
      .getElementById("dateApplyBtn")!
      .dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    await flushAsync();

    const finalSearch = win.location.search;
    const finalQS = parseQS(
      finalSearch.startsWith("?") ? finalSearch.slice(1) : finalSearch,
    );
    expect(finalQS.from).toBe("2024-02-10");
    expect(finalQS.to).toBe("2024-02-20");
    expect(finalQS.days).toBeUndefined();
  });

  it("mount with ?days=garbage falls back to 7-day default (outbound days=7)", async () => {
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": () => canned(7, 100).summary,
      "/api/analytics/tool-counts": () => canned(1, 0).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };

    const { calls } = await loadDashboardAtUrl(
      "http://localhost/analytics?days=garbage",
      endpoints,
    );

    const summaryCall = calls.find((u) =>
      u.startsWith("/api/analytics/summary"),
    );
    expect(summaryCall).toBeDefined();
    const qs = parseQS(summaryCall!.split("?")[1] ?? "");
    expect(qs.days).toBe("7");
    expect(qs.from).toBeUndefined();
    expect(qs.to).toBeUndefined();
  });

  it.each([
    ["?days=0", "zero"],
    ["?days=-1", "negative"],
    ["?days=3.5", "non-integer"],
  ])(
    "mount with %s falls back to 7-day default (rejects %s)",
    async (query) => {
      const endpoints = {
        "/api/analytics/auth-mode": () => ({ dev: true }),
        "/api/analytics/summary": () => canned(7, 100).summary,
        "/api/analytics/tool-counts": () => canned(1, 0).toolCounts,
        "/api/analytics/queries": () => [],
        "/api/analytics/empty-queries": () => [],
      };

      const { calls } = await loadDashboardAtUrl(
        "http://localhost/analytics" + query,
        endpoints,
      );

      const summaryCall = calls.find((u) =>
        u.startsWith("/api/analytics/summary"),
      );
      expect(summaryCall).toBeDefined();
      const qs = parseQS(summaryCall!.split("?")[1] ?? "");
      expect(qs.days).toBe("7");
    },
  );

  it("mount with a future from/to falls back to 7-day default (rejects future dates)", async () => {
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": () => canned(7, 100).summary,
      "/api/analytics/tool-counts": () => canned(1, 0).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };

    const { calls } = await loadDashboardAtUrl(
      "http://localhost/analytics?from=2099-01-01&to=2099-01-10",
      endpoints,
    );

    const summaryCall = calls.find((u) =>
      u.startsWith("/api/analytics/summary"),
    );
    expect(summaryCall).toBeDefined();
    const qs = parseQS(summaryCall!.split("?")[1] ?? "");
    expect(qs.days).toBe("7");
    expect(qs.from).toBeUndefined();
    expect(qs.to).toBeUndefined();
  });

  it("preserves ?preview=1 alongside ?days when a preset is clicked", async () => {
    // Preview mode installs its own canned-response fetch, so we don't need
    // to supply handlers — mount with ?preview=1&days=30, then click "14
    // days" and assert the URL retains preview=1 AND updates days=14.
    const html = fs.readFileSync(
      path.join(process.cwd(), "docs", "analytics.html"),
      "utf8",
    );
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", () => {});
    const dom = new JSDOM(html, {
      runScripts: "outside-only",
      url: "http://localhost/analytics?preview=1&days=30",
      pretendToBeVisual: true,
      virtualConsole,
    });

    const win = dom.window as unknown as Window & typeof globalThis;
    Object.assign(win, { Date: globalThis.Date });
    if (typeof (win as { Response?: unknown }).Response === "undefined") {
      Object.assign(win, { Response: globalThis.Response });
    }
    installChartStub(win);
    // Preview IIFE captures originalFetch via window.fetch.bind(window); if
    // the jsdom window doesn't expose fetch (depending on version), bind
    // throws. Install a noop fetch spy so the IIFE can capture and then
    // override it. Preview's own handler short-circuits every analytics URL
    // so the stub's noop impl is never invoked for app paths.
    const noopFetch = vi.fn(() => Promise.reject(new Error("noop fetch")));
    Object.assign(win, { fetch: noopFetch });

    const scriptEl = dom.window.document.querySelector("script:not([src])");
    if (!scriptEl) throw new Error("inline script not found in analytics.html");
    const code = scriptEl.textContent ?? "";
    dom.window.eval(code);

    // Flush many rounds since preview init is several async hops deep.
    for (let i = 0; i < 10; i++) await flushAsync();

    // Click "14 days" preset.
    dom.window.document
      .getElementById("datePill")!
      .dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    const fourteen = Array.from(
      dom.window.document.querySelectorAll(".preset[data-days]"),
    ).find((el) => el.getAttribute("data-days") === "14") as HTMLElement;
    fourteen.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    for (let i = 0; i < 5; i++) await flushAsync();

    const finalSearch = win.location.search;
    const finalQS = parseQS(
      finalSearch.startsWith("?") ? finalSearch.slice(1) : finalSearch,
    );
    expect(finalQS.preview).toBe("1");
    expect(finalQS.days).toBe("14");
    expect(finalQS.from).toBeUndefined();
    expect(finalQS.to).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// URL persistence parity — these tests cover state-mutating paths and URL
// re-sync semantics that the original URL-persistence implementation missed.
//
// Covered:
//   - Daily-bar drill-down must call writeWindowToUrl() like every other
//     state-mutating path (preset, Today, Apply). Without this, a refresh or
//     deep link silently reverts the drill-down.
//   - applyUrlWindowOnMount must re-sync the URL after clamping an overlarge
//     ?days=, or after rejecting invalid input and falling back to the
//     default, so the address bar always reflects the effective state.
//   - URL_MAX_DAYS must equal ALL_TIME_DAYS — a single source of truth keeps
//     the "All time" pill label and the URL clamp aligned.
//   - Apply handler must reject future dates, matching readWindowFromUrl's
//     contract (otherwise interactive Apply and URL deep-link diverge).
// ---------------------------------------------------------------------------

describe("analytics dashboard UI — URL persistence parity", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // Variant of loadDashboard that lets a test supply a custom page URL so we
  // can mount with ?days=N / ?from=&to= / ?days=99999 etc. Duplicated from
  // the URL-persisted describe block so these tests stay isolated; duplication
  // is cheap and keeps the two blocks independently skippable.
  async function loadDashboardAtUrl(
    pageUrl: string,
    handlers: Record<string, (qs: string) => HandlerResult>,
  ): Promise<{
    dom: JSDOM;
    win: Window & typeof globalThis;
    calls: string[];
    chartInstances: Array<{ type: string; data: unknown; options: unknown }>;
  }> {
    const html = fs.readFileSync(
      path.join(process.cwd(), "docs", "analytics.html"),
      "utf8",
    );
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", () => {});
    const dom = new JSDOM(html, {
      runScripts: "outside-only",
      url: pageUrl,
      pretendToBeVisual: true,
      virtualConsole,
    });

    const win = dom.window as unknown as Window & typeof globalThis;
    Object.assign(win, { Date: globalThis.Date });
    const { instances } = installChartStub(win);
    const { fetchFn, calls } = buildFetchStub(handlers);
    Object.assign(win, { fetch: fetchFn });

    const scriptEl = dom.window.document.querySelector("script:not([src])");
    if (!scriptEl) throw new Error("inline script not found in analytics.html");
    const code = scriptEl.textContent ?? "";
    dom.window.eval(code);

    await flushAsync();

    return { dom, win, calls, chartInstances: instances };
  }

  // Finding 1 — daily-bar drill-down must persist to URL.
  it("daily-bar drill-down writes from=<day>&to=<day> to the URL (no days=)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-20T10:00:00.000Z"));
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": () => canned(3, 500).summary,
      "/api/analytics/tool-counts": () => canned(3, 500).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };

    const { dom, win, chartInstances } = await loadDashboardAtUrl(
      "http://localhost/analytics",
      endpoints,
    );

    // Spy on history.replaceState AFTER mount so applyUrlWindowOnMount's
    // initial call (if any) isn't counted. Preserve the real impl so jsdom's
    // location mirror updates.
    const realReplace = win.history.replaceState.bind(win.history);
    const replaceSpy = vi.fn(
      (data: unknown, unused: string, url?: string | null) => {
        realReplace(data, unused, url ?? undefined);
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (win.history as any).replaceState = replaceSpy;

    const barChart = [...chartInstances]
      .reverse()
      .find((c) => c.type === "bar") as
      | (typeof chartInstances)[number]
      | undefined;
    expect(barChart).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const labels = (barChart as any).data.labels as string[];
    const targetDay = labels[0];
    expect(/^\d{4}-\d{2}-\d{2}$/.test(targetDay)).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onClick = (barChart as any).options.onClick as (
      evt: unknown,
      elements: Array<{ index: number }>,
    ) => void;
    onClick({}, [{ index: 0 }]);
    await flushAsync();

    // The drill-down must have written the new window to the URL. Pre-fix
    // this spy is never called because the onClick handler never invokes
    // writeWindowToUrl().
    expect(replaceSpy).toHaveBeenCalled();
    const finalSearch = win.location.search;
    const finalQS = parseQS(
      finalSearch.startsWith("?") ? finalSearch.slice(1) : finalSearch,
    );
    expect(finalQS.from).toBe(targetDay);
    expect(finalQS.to).toBe(targetDay);
    expect(finalQS.days).toBeUndefined();
  });

  // Finding 2 — clamp re-sync. Mount with overlarge ?days= and assert the
  // URL is rewritten to the clamped value.
  it("mount with ?days=999999 re-syncs the URL to the clamped value", async () => {
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": () => canned(1, 100).summary,
      "/api/analytics/tool-counts": () => canned(1, 0).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };

    const { win } = await loadDashboardAtUrl(
      "http://localhost/analytics?days=999999",
      endpoints,
    );

    const finalSearch = win.location.search;
    const finalQS = parseQS(
      finalSearch.startsWith("?") ? finalSearch.slice(1) : finalSearch,
    );
    // After fix (Finding 3) URL_MAX_DAYS === ALL_TIME_DAYS === 99999.
    expect(finalQS.days).toBe("99999");
  });

  // Finding 2 (second half) — invalid input re-sync. Mount with garbage,
  // assert the URL is rewritten to the 7-day default.
  it("mount with ?days=garbage re-syncs the URL to days=7 (default)", async () => {
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": () => canned(7, 100).summary,
      "/api/analytics/tool-counts": () => canned(1, 0).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };

    const { win } = await loadDashboardAtUrl(
      "http://localhost/analytics?days=garbage",
      endpoints,
    );

    const finalSearch = win.location.search;
    const finalQS = parseQS(
      finalSearch.startsWith("?") ? finalSearch.slice(1) : finalSearch,
    );
    // Post-fix we always emit the effective state. Default is 7 days.
    expect(finalQS.days).toBe("7");
    expect(finalQS.from).toBeUndefined();
    expect(finalQS.to).toBeUndefined();
  });

  // Finding 3 — URL_MAX_DAYS must equal ALL_TIME_DAYS. Mount with ?days=99999
  // and confirm the pill reads "All time" AND no clamp was applied.
  it("mount with ?days=99999 labels the pill 'All time' and emits days=99999 unchanged", async () => {
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": () => canned(7, 100).summary,
      "/api/analytics/tool-counts": () => canned(1, 0).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };

    const { dom, win } = await loadDashboardAtUrl(
      "http://localhost/analytics?days=99999",
      endpoints,
    );

    const pillLabel = dom.window.document
      .querySelector("#datePill .date-value")
      ?.textContent?.trim();
    expect(pillLabel).toBe("All time");

    const finalSearch = win.location.search;
    const finalQS = parseQS(
      finalSearch.startsWith("?") ? finalSearch.slice(1) : finalSearch,
    );
    expect(finalQS.days).toBe("99999");
  });

  // Finding 3 (second half) — mount with ?days=100000 should clamp to the
  // ALL_TIME_DAYS sentinel (99999) after the fix.
  it("mount with ?days=100000 clamps to 99999 (URL_MAX_DAYS === ALL_TIME_DAYS)", async () => {
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": () => canned(7, 100).summary,
      "/api/analytics/tool-counts": () => canned(1, 0).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };

    const { dom, win, calls } = await loadDashboardAtUrl(
      "http://localhost/analytics?days=100000",
      endpoints,
    );

    // URL is re-synced to the clamped value (via Finding 2 fix).
    const finalSearch = win.location.search;
    const finalQS = parseQS(
      finalSearch.startsWith("?") ? finalSearch.slice(1) : finalSearch,
    );
    expect(finalQS.days).toBe("99999");

    // Outbound summary fetch uses the clamped value too.
    const summaryCall = calls.find((u) =>
      u.startsWith("/api/analytics/summary"),
    );
    expect(summaryCall).toBeDefined();
    const outQs = parseQS(summaryCall!.split("?")[1] ?? "");
    expect(outQs.days).toBe("99999");

    // And the pill renders as "All time".
    const pillLabel = dom.window.document
      .querySelector("#datePill .date-value")
      ?.textContent?.trim();
    expect(pillLabel).toBe("All time");
  });

  // Finding 4 — parseISODate and roundTrip use UTC consistently, so the
  // future-date comparison against todayISO() (UTC) is frame-aligned. This is
  // a direct unit test of the two helpers exposed via the same eval pattern
  // the file uses. The ambient TZ-sensitive variant (setSystemTime + mount)
  // is hard to reproduce reliably inside jsdom, so we assert the invariant
  // directly: parseISODate("2026-04-21") must produce {y,m,d} = {2026,4,21}
  // in BOTH local and UTC calendar frames.
  it("parseISODate and roundTrip operate in UTC (frame-aligned with todayISO)", async () => {
    const html = fs.readFileSync(
      path.join(process.cwd(), "docs", "analytics.html"),
      "utf8",
    );
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", () => {});
    const dom = new JSDOM(html, {
      runScripts: "outside-only",
      url: "http://localhost/analytics",
      pretendToBeVisual: true,
      virtualConsole,
    });
    const win = dom.window as unknown as Window & typeof globalThis;
    Object.assign(win, { Date: globalThis.Date });
    installChartStub(win);
    // No fetch needed — we only evaluate the helpers.
    Object.assign(win, {
      fetch: vi.fn(() => Promise.reject(new Error("n/a"))),
    });

    const scriptEl = dom.window.document.querySelector("script:not([src])");
    const code = scriptEl!.textContent ?? "";
    dom.window.eval(code);
    await flushAsync();

    // Probe parseISODate in the window context. After the fix, the resulting
    // Date's UTC accessors must match the input Y/M/D exactly.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = (win as any).eval('parseISODate("2026-04-21")') as Date;
    expect(d).toBeInstanceOf(Date);
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(3); // zero-based: April
    expect(d.getUTCDate()).toBe(21);
  });

  // Finding 5 — Apply handler must reject future dates.
  it("Apply handler rejects a future-dated range with an inline error and no fetch", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-20T10:00:00.000Z"));
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": () => canned(7, 100).summary,
      "/api/analytics/tool-counts": () => canned(1, 0).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };

    const { dom, win, calls } = await loadDashboardAtUrl(
      "http://localhost/analytics",
      endpoints,
    );
    const fetchCountBefore = calls.length;
    const urlBefore = win.location.search;

    // Silence warn the handler emits on rejection.
    vi.spyOn(dom.window.console, "warn").mockImplementation(() => {});

    dom.window.document
      .getElementById("datePill")!
      .dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    const customPreset = dom.window.document.querySelector(
      ".preset[data-custom]",
    ) as HTMLElement;
    customPreset.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    const fromEl = dom.window.document.getElementById(
      "dateFromInput",
    ) as HTMLInputElement;
    const toEl = dom.window.document.getElementById(
      "dateToInput",
    ) as HTMLInputElement;
    fromEl.value = "2099-01-01";
    fromEl.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    toEl.value = "2099-01-10";
    toEl.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    dom.window.document
      .getElementById("dateApplyBtn")!
      .dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    await flushAsync();

    // No new fetch — handler early-returned.
    expect(calls.length).toBe(fetchCountBefore);
    // Popover still open with inline error surfaced.
    const dateErr = dom.window.document.getElementById(
      "dateError",
    ) as HTMLElement | null;
    expect(dateErr).not.toBeNull();
    expect(dateErr!.style.display).toBe("block");
    expect(dateErr!.textContent).toBe("End date cannot be in the future.");
    // URL unchanged (no writeWindowToUrl fired for the rejected range).
    expect(win.location.search).toBe(urlBefore);
    expect(win.location.search).not.toContain("2099");
  });

  // Finding (R2) — future-date rejection uses UTC today, but <input type="date">
  // and URL-pasted dates express the user's LOCAL calendar. Users east of UTC
  // (Tokyo UTC+9, Sydney UTC+10, etc.) have a nightly band where their local
  // "today" is one calendar day ahead of UTC "today". During that band, picking
  // local today in the custom-range picker — or deep-linking to ?to=<local
  // today> — is silently rejected as "future".
  //
  // Fix: allow dates up to today_UTC + 1 as the upper bound. Strictly beyond
  // is still unambiguously future and still rejected.
  //
  // System time: 2026-04-20T10:00:00Z → todayISO() === "2026-04-20".
  // tomorrowISO() === "2026-04-21" (the user's local "today" in Tokyo morning).
  // "2026-04-22" is strictly future-future and must still be rejected.

  it("readWindowFromUrl accepts ?to=<today_UTC + 1> so eastern-TZ users aren't rejected", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-20T10:00:00.000Z"));
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": () => canned(2, 100).summary,
      "/api/analytics/tool-counts": () => canned(1, 0).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };

    // Tokyo early-morning scenario: UTC today is 2026-04-20, but the user's
    // local calendar reads 2026-04-21 and they deep-link to
    // ?from=2026-04-20&to=2026-04-21 (their local "today"). Pre-fix this is
    // rejected as future and falls back to the 7-day default — the exact
    // silent-regression we're fixing.
    const { calls } = await loadDashboardAtUrl(
      "http://localhost/analytics?from=2026-04-20&to=2026-04-21",
      endpoints,
    );

    const summaryCall = calls.find((u) =>
      u.startsWith("/api/analytics/summary"),
    );
    expect(summaryCall).toBeDefined();
    const qs = parseQS(summaryCall!.split("?")[1] ?? "");
    // Post-fix: the range is accepted (from/to propagate to the fetch).
    expect(qs.from).toBe("2026-04-20");
    expect(qs.to).toBe("2026-04-21");
    expect(qs.days).toBeUndefined();
  });

  it("Apply handler accepts to=<today_UTC + 1> (eastern-TZ local today)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-20T10:00:00.000Z"));
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": () => canned(2, 100).summary,
      "/api/analytics/tool-counts": () => canned(1, 0).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };

    const { dom, win, calls } = await loadDashboardAtUrl(
      "http://localhost/analytics",
      endpoints,
    );
    const fetchCountBefore = calls.length;

    vi.spyOn(dom.window.console, "warn").mockImplementation(() => {});

    dom.window.document
      .getElementById("datePill")!
      .dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    const customPreset = dom.window.document.querySelector(
      ".preset[data-custom]",
    ) as HTMLElement;
    customPreset.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    const fromEl = dom.window.document.getElementById(
      "dateFromInput",
    ) as HTMLInputElement;
    const toEl = dom.window.document.getElementById(
      "dateToInput",
    ) as HTMLInputElement;
    // from = today_UTC, to = today_UTC + 1 (local today in Tokyo/Sydney morning).
    fromEl.value = "2026-04-20";
    fromEl.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    toEl.value = "2026-04-21";
    toEl.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    dom.window.document
      .getElementById("dateApplyBtn")!
      .dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    await flushAsync();

    // No inline error. On successful Apply the popover closes, which tears
    // down the #dateError element entirely — so either "no error element in
    // DOM" (popover closed) or "display !== 'block'" (element exists but
    // hidden) both indicate acceptance. Rejection paths keep the popover
    // open AND set display:block, which this assertion excludes.
    const dateErr = dom.window.document.getElementById(
      "dateError",
    ) as HTMLElement | null;
    if (dateErr) {
      expect(dateErr.style.display).not.toBe("block");
    }

    // A new fetch fired (range applied).
    expect(calls.length).toBeGreaterThan(fetchCountBefore);
    const summaryCall = [...calls]
      .reverse()
      .find((u) => u.startsWith("/api/analytics/summary"));
    expect(summaryCall).toBeDefined();
    const qs = parseQS(summaryCall!.split("?")[1] ?? "");
    expect(qs.from).toBe("2026-04-20");
    expect(qs.to).toBe("2026-04-21");

    // URL reflects the applied range.
    const finalQS = parseQS(
      win.location.search.startsWith("?")
        ? win.location.search.slice(1)
        : win.location.search,
    );
    expect(finalQS.from).toBe("2026-04-20");
    expect(finalQS.to).toBe("2026-04-21");
  });

  it("still rejects to=<today_UTC + 2> in both URL and Apply handler (guard against over-permissive fix)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-20T10:00:00.000Z"));
    const endpoints = {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": () => canned(7, 100).summary,
      "/api/analytics/tool-counts": () => canned(1, 0).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };

    // URL deep-link path: today+2 is unambiguously future-future and must
    // still be rejected — falls back to the 7-day default.
    const deep = await loadDashboardAtUrl(
      "http://localhost/analytics?from=2026-04-20&to=2026-04-22",
      endpoints,
    );
    const deepSummary = deep.calls.find((u) =>
      u.startsWith("/api/analytics/summary"),
    );
    expect(deepSummary).toBeDefined();
    const deepQS = parseQS(deepSummary!.split("?")[1] ?? "");
    expect(deepQS.days).toBe("7");
    expect(deepQS.from).toBeUndefined();
    expect(deepQS.to).toBeUndefined();

    // Apply handler path: fresh mount, open custom, pick today+2, click Apply.
    const { dom, win, calls } = await loadDashboardAtUrl(
      "http://localhost/analytics",
      endpoints,
    );
    const fetchCountBefore = calls.length;
    const urlBefore = win.location.search;

    vi.spyOn(dom.window.console, "warn").mockImplementation(() => {});

    dom.window.document
      .getElementById("datePill")!
      .dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    const customPreset = dom.window.document.querySelector(
      ".preset[data-custom]",
    ) as HTMLElement;
    customPreset.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    const fromEl = dom.window.document.getElementById(
      "dateFromInput",
    ) as HTMLInputElement;
    const toEl = dom.window.document.getElementById(
      "dateToInput",
    ) as HTMLInputElement;
    fromEl.value = "2026-04-20";
    fromEl.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    toEl.value = "2026-04-22";
    toEl.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    dom.window.document
      .getElementById("dateApplyBtn")!
      .dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    await flushAsync();

    expect(calls.length).toBe(fetchCountBefore);
    const dateErr = dom.window.document.getElementById(
      "dateError",
    ) as HTMLElement | null;
    expect(dateErr).not.toBeNull();
    expect(dateErr!.style.display).toBe("block");
    expect(dateErr!.textContent).toBe("End date cannot be in the future.");
    expect(win.location.search).toBe(urlBefore);
  });
});

// ---------------------------------------------------------------------------
// Data-availability label: when the requested window exceeds the actual
// query_log depth, show "showing N days of data" next to the date pill so
// users understand why bumping 7d → 14d → 30d produces identical numbers.
// ---------------------------------------------------------------------------

describe("analytics dashboard UI — data availability label", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * Build a Date offset from today-UTC by N days and return YYYY-MM-DD.
   * Positive N = days before today. Used so the canned `earliest_query_day`
   * payloads line up with the frozen system time.
   */
  function daysBeforeTodayUTC(n: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function makeSummaryEndpoint(earliest: string | null) {
    return (qs: string) => {
      const p = parseQS(qs);
      const days = p.days ? parseInt(p.days, 10) : 7;
      const base = canned(Math.min(days, 9), 1234).summary;
      return { ...base, earliest_query_day: earliest };
    };
  }

  function makeEndpoints(earliest: string | null) {
    return {
      "/api/analytics/auth-mode": () => ({ dev: true }),
      "/api/analytics/summary": makeSummaryEndpoint(earliest),
      "/api/analytics/tool-counts": () => canned(1, 0).toolCounts,
      "/api/analytics/queries": () => [],
      "/api/analytics/empty-queries": () => [],
    };
  }

  async function clickPresetDays(dom: JSDOM, days: number): Promise<void> {
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

  async function clickTodayPreset(dom: JSDOM): Promise<void> {
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
  }

  it("shows 'showing 9 days of data' when earliest is 8 days ago and window=14", async () => {
    // earliest = today - 8 days → 9 days inclusive. Default window is 7,
    // so switch to 14 before asserting.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-20T10:00:00.000Z"));

    const earliest = daysBeforeTodayUTC(8);
    const { dom } = await loadDashboard(makeEndpoints(earliest));
    await clickPresetDays(dom, 14);

    const label = dom.window.document.getElementById("dataAvailability");
    expect(label).not.toBeNull();
    expect(label!.textContent!.trim()).toBe("showing 9 days of data");
  });

  it("hides the label when earliest is older than the requested window", async () => {
    // earliest = 30 days ago, window = 14. availableDays (31) > requestedDays
    // (14), so the label must NOT render — the user already sees all the
    // data their window asked for.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-20T10:00:00.000Z"));

    const earliest = daysBeforeTodayUTC(30);
    const { dom } = await loadDashboard(makeEndpoints(earliest));
    await clickPresetDays(dom, 14);

    const label = dom.window.document.getElementById("dataAvailability");
    // Either absent or empty — both acceptable; assert a stable "no content"
    // condition rather than pinning on element presence so minor DOM
    // restructurings (container hide/show vs. removal) still pass.
    if (label) {
      expect(label.textContent!.trim()).toBe("");
    }
  });

  it("hides the label when earliest_query_day is null (empty table)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-20T10:00:00.000Z"));

    const { dom } = await loadDashboard(makeEndpoints(null));

    const label = dom.window.document.getElementById("dataAvailability");
    if (label) {
      expect(label.textContent!.trim()).toBe("");
    }
  });

  it("computes availableDays inclusively for explicit from/to range", async () => {
    // Custom range spanning 10 UTC days, earliest 5 days ago → 6 days of
    // data. Requested = 10, available = 6, label = "showing 6 days of data".
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-20T10:00:00.000Z"));

    const earliest = daysBeforeTodayUTC(5);
    const { dom } = await loadDashboard(makeEndpoints(earliest));

    // Open popover → enter custom mode → set from/to.
    const datePill = dom.window.document.getElementById("datePill")!;
    datePill.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    const customPreset = dom.window.document.querySelector(
      '.preset[data-custom="1"]',
    ) as HTMLElement;
    customPreset.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    const fromInput = dom.window.document.getElementById(
      "dateFromInput",
    ) as HTMLInputElement;
    const toInput = dom.window.document.getElementById(
      "dateToInput",
    ) as HTMLInputElement;
    fromInput.value = "2026-04-11";
    toInput.value = "2026-04-20";
    const applyBtn = dom.window.document.getElementById(
      "dateApplyBtn",
    ) as HTMLElement;
    applyBtn.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flushAsync();

    const label = dom.window.document.getElementById("dataAvailability");
    expect(label).not.toBeNull();
    expect(label!.textContent!.trim()).toBe("showing 6 days of data");
  });

  it("hides the label for 'Today' when earliest is today (1 <= 1)", async () => {
    // requestedDays = 1, availableDays = 1. Strict `>` comparison means
    // equal windows don't trigger the label — only true plateaus do.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-20T10:00:00.000Z"));

    const earliest = daysBeforeTodayUTC(0); // today
    const { dom } = await loadDashboard(makeEndpoints(earliest));
    await clickTodayPreset(dom);

    const label = dom.window.document.getElementById("dataAvailability");
    if (label) {
      expect(label.textContent!.trim()).toBe("");
    }
  });

  it("pluralizes 'day' when availableDays === 1", async () => {
    // earliest = today → 1 day of data, requested = 14 → label uses singular
    // "day" not "days".
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-20T10:00:00.000Z"));

    const earliest = daysBeforeTodayUTC(0);
    const { dom } = await loadDashboard(makeEndpoints(earliest));
    await clickPresetDays(dom, 14);

    const label = dom.window.document.getElementById("dataAvailability");
    expect(label).not.toBeNull();
    expect(label!.textContent!.trim()).toBe("showing 1 day of data");
  });
});
