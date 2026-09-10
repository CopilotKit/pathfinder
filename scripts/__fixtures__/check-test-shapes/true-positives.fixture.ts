// Fixtures for scripts/check-test-shapes.mjs — every rule's SHAPE, one per
// block, drawn from the real sites that review found. Run:
//
//   node scripts/check-test-shapes.mjs scripts/__fixtures__/check-test-shapes
//
// Passing explicit paths bypasses the baseline, so the checker must report
// every block below and nothing from near-miss-negatives.fixture.ts.
//
// This file is NEVER executed and NEVER type-checked: vitest only collects
// `src/**/*.test.ts`, the root tsconfig's rootDir is src/, and
// tsconfig.scripts.json includes only the two shipped script dirs. It exists to
// be PARSED. Do not add imports or try to make it run.
/* eslint-disable */

declare const it: (name: string, fn: () => unknown) => void;
declare const describe: (name: string, fn: () => unknown) => void;
declare const beforeEach: (fn: () => unknown) => void;
declare const expect: any;
declare const vi: any;
declare const render: (html: string) => { querySelector(s: string): any };
declare const searchChunks: (...args: unknown[]) => Promise<any[]>;
declare const registerSearchTool: (...args: unknown[]) => void;
declare const generateFaqTxt: (...args: unknown[]) => string;
declare const mockQuery: any;

describe("bare-conditional-expect", () => {
  // Shape from analytics-ui.test.ts: `label` is null in exactly the case the
  // test guards (the label was not rendered), so the assertion never runs.
  it("shows the availability label", () => {
    const dom = render("<div/>");
    const label = dom.querySelector(".availability");
    if (label) {
      expect(label.textContent).toContain("9 days of data");
    }
  });
});

describe("nan-comparator-in-assertion", () => {
  // Shape from min-score-gate.test.ts:369. With a null cosine, `b! - a!` is
  // NaN, sort treats that as "equal", the copy comes back unpermuted, and the
  // assertion holds no matter how the production ordering changed.
  it("orders rows by descending cosine", async () => {
    const cosines = (await searchChunks([0.1], 3)).map(
      (r) => r.cosine_similarity,
    );
    expect(cosines).toEqual([...cosines].sort((a: any, b: any) => b! - a!));
  });
});

describe("sole-isfinite-assertion", () => {
  // Passes for 0, for -1, for every wrong-but-numeric value.
  it("coerces the similarity to a number", async () => {
    const [r] = await searchChunks([0.1], 5);
    expect(Number.isFinite(r.similarity)).toBe(true);
  });
});

describe("as-never-in-test", () => {
  // Shape from search-tool.test.ts: `as never` stops the compiler checking
  // that the double has the members the tool actually calls.
  it("registers the search tool", () => {
    const server = { tool: vi.fn() };
    const embeddingClient = { embed: vi.fn() };
    registerSearchTool(server as never, embeddingClient as never, {});
  });
});

describe("tautological-not-tocontain", () => {
  // Nothing in src/ and nothing in this file supplies the marker below, so no
  // code path could ever produce it: true by construction. (Note this comment
  // does NOT repeat the literal — a second occurrence anywhere in the file,
  // comments included, counts as grounding and suppresses the rule.)
  it("omits the marker", () => {
    const out = generateFaqTxt([], "TestServer", []);
    expect(out).not.toContain("qqzx-unemitted-marker");
  });
});

describe("clear-all-mocks-with-once", () => {
  // clearAllMocks drains the call log but NOT the once-queue, so the value
  // queued by a test that returns early leaks into the next test's first call.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles an empty query without touching the pool", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await searchChunks([], 10)).toEqual([]);
  });
});

describe("bare-ignore-directive", () => {
  // An ignore with no rule id and no reason is itself a finding: silencing a
  // rule must cost at least as much as explaining why.
  it("is silenced without saying why", () => {
    const dom = render("<div/>");
    const label = dom.querySelector(".availability");
    // check-test-shapes-ignore-next-line
    if (label) {
      expect(label.textContent).toContain("9 days of data");
    }
  });
});
