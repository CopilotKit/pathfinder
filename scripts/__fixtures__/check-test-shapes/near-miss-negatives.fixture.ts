// Near-miss NEGATIVES for scripts/check-test-shapes.mjs. Every block here is
// one edit away from a true positive in true-positives.fixture.ts and must NOT
// be reported. A rule that cannot tell these apart is a rule people disable.
//
// Never executed, never type-checked — see the header of the true-positives
// fixture for why.
/* eslint-disable */

declare const it: (name: string, fn: () => unknown) => void;
declare const describe: (name: string, fn: () => unknown) => void;
declare const beforeEach: (fn: () => unknown) => void;
declare const expect: any;
declare const vi: any;
declare const render: (html: string) => { querySelector(s: string): any };
declare const searchChunks: (...args: unknown[]) => Promise<any[]>;
declare const parseAnalyticsFilter: (...args: unknown[]) => any;
declare const redactConnectionStrings: (s: string) => string;
declare const registerSearchTool: (...args: unknown[]) => void;
declare const mockQuery: any;
type Server = { tool: (...a: unknown[]) => void };

describe("bare-conditional-expect — negatives", () => {
  it("has an else that fails", () => {
    const label = render("<div/>").querySelector(".availability");
    if (label) {
      expect(label.textContent).toContain("9 days of data");
    } else {
      expect.fail("availability label was not rendered");
    }
  });

  it("asserts existence before narrowing", () => {
    const label = render("<div/>").querySelector(".availability");
    expect(label).toBeDefined();
    if (label) {
      expect(label.textContent).toContain("9 days of data");
    }
  });

  it("asserts the discriminant is true before narrowing", () => {
    const result = parseAnalyticsFilter({ query: {} });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filter.from).toBeUndefined();
    }
  });

  it("asserts the container is non-empty before narrowing", () => {
    const rows = [{ id: 1 }];
    expect(rows).toHaveLength(1);
    if (rows[0]) {
      expect(rows[0].id).toBe(1);
    }
  });

  it("throws instead of skipping", () => {
    const label = render("<div/>").querySelector(".availability");
    if (!label) throw new Error("label missing");
    if (label) {
      expect(label.textContent).toContain("9 days");
    }
  });

  it("branches on a value, not on existence", () => {
    const mode = "hybrid";
    if (mode === "hybrid") {
      expect(mode).toBe("hybrid");
    }
  });

  it("is silenced with a rule id and a reason", () => {
    const label = render("<div/>").querySelector(".availability");
    // check-test-shapes-ignore-next-line bare-conditional-expect — the null
    // case is covered by its own test below; this one only checks the text.
    if (label) {
      expect(label.textContent).toContain("9 days of data");
    }
  });
});

describe("nan-comparator-in-assertion — negatives", () => {
  it("uses a total comparator", async () => {
    const cosines = (await searchChunks([0.1], 3)).map(
      (r) => r.cosine_similarity,
    );
    expect(cosines).toEqual(
      [...cosines].sort((a: any, b: any) => (b ?? 0) - (a ?? 0)),
    );
  });

  it("sorts strings with the default comparator", () => {
    const days = ["2026-01-01", "2026-01-02"];
    expect([...days].sort()).toEqual(days);
  });

  it("non-null-asserts outside the comparator", async () => {
    const cosines = (await searchChunks([0.1], 3)).map(
      (r) => r.cosine_similarity!,
    );
    expect(cosines).toEqual([...cosines].sort((a: number, b: number) => b - a));
  });
});

describe("sole-isfinite-assertion — negatives", () => {
  it("asserts the value as well as its finiteness", async () => {
    const [r] = await searchChunks([0.1], 5);
    expect(r.similarity).toBe(0.42);
    expect(Number.isFinite(r.similarity)).toBe(true);
  });
});

describe("as-never-in-test — negatives", () => {
  it("types the double structurally", () => {
    const server: Pick<Server, "tool"> = { tool: vi.fn() };
    registerSearchTool(server, { embed: vi.fn() }, {});
  });

  it("widens through unknown rather than erasing the check", () => {
    const server = { tool: vi.fn() } as unknown as Server;
    registerSearchTool(server, { embed: vi.fn() }, {});
  });
});

describe("tautological-not-tocontain — negatives", () => {
  it("rules out a literal the test itself supplied", () => {
    const raw = "connect via postgres://user:pw@host/db please";
    expect(redactConnectionStrings(raw)).not.toContain(
      "postgres://user:pw@host/db",
    );
  });

  it("rules out a literal production composes from a fixture value", () => {
    const sources = [{ name: "slack-empty" }];
    const out = String(sources);
    expect(out).not.toContain("## slack-empty");
  });

  it("rules out a literal that exists in production source", () => {
    expect("x").not.toContain("plainto_tsquery");
  });
});
