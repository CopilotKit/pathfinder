import { describe, it, expect } from "vitest";
import {
  isSyntheticQuery,
  filterSynthetic,
  normalizeQueryKey,
  clusterQueries,
  SYNTHETIC_SUFFIX,
  SYNTHETIC_PARITY_TOKEN,
  type QueryRow,
} from "./cluster.js";

describe("isSyntheticQuery", () => {
  it("flags the '<x> integration guide setup' probe phrasing", () => {
    expect(isSyntheticQuery("langgraph integration guide setup")).toBe(true);
    expect(isSyntheticQuery("CrewAI integration guide setup")).toBe(true);
    // Case + whitespace insensitive.
    expect(isSyntheticQuery("  Mastra Integration Guide Setup  ")).toBe(true);
  });

  it("flags any query containing the _parity token", () => {
    expect(isSyntheticQuery("_parity")).toBe(true);
    expect(isSyntheticQuery("langgraph_parity_check")).toBe(true);
    expect(isSyntheticQuery("run _parity suite")).toBe(true);
  });

  it("does NOT flag legitimate user queries", () => {
    expect(isSyntheticQuery("how to set up authentication")).toBe(false);
    // Mentions "integration guide" but not as the trailing probe phrasing.
    expect(isSyntheticQuery("where is the integration guide for slack")).toBe(
      false,
    );
    expect(isSyntheticQuery("deployment best practices")).toBe(false);
    expect(isSyntheticQuery("parity between environments")).toBe(false); // no underscore
  });

  it("handles empty / non-string input safely", () => {
    expect(isSyntheticQuery("")).toBe(false);
    expect(isSyntheticQuery("   ")).toBe(false);
    // @ts-expect-error — guarding runtime robustness against bad input.
    expect(isSyntheticQuery(null)).toBe(false);
  });

  it("exports the literal markers it filters on", () => {
    expect(SYNTHETIC_SUFFIX).toBe("integration guide setup");
    expect(SYNTHETIC_PARITY_TOKEN).toBe("_parity");
  });
});

describe("filterSynthetic", () => {
  it("removes synthetic rows while preserving real ones", () => {
    const rows = [
      { query_text: "how to authenticate", count: 5 },
      { query_text: "langgraph integration guide setup", count: 99 },
      { query_text: "deployment guide", count: 3 },
      { query_text: "mastra_parity", count: 42 },
    ];
    const filtered = filterSynthetic(rows);
    expect(filtered.map((r) => r.query_text)).toEqual([
      "how to authenticate",
      "deployment guide",
    ]);
  });

  it("returns an empty array when all rows are synthetic", () => {
    const rows = [
      { query_text: "a integration guide setup", count: 1 },
      { query_text: "_parity", count: 1 },
    ];
    expect(filterSynthetic(rows)).toEqual([]);
  });
});

describe("normalizeQueryKey", () => {
  it("collapses word-order and stop-word variants to the same key", () => {
    // Both reduce to the single significant token "authentication": "how",
    // "to", "set", "up", and "setup" are all stop words.
    const a = normalizeQueryKey("how to set up authentication");
    const b = normalizeQueryKey("authentication setup");
    expect(a).toBe(b);
    expect(a).toBe("authentication");
  });

  it("sorts remaining tokens so word order doesn't fragment a cluster", () => {
    expect(normalizeQueryKey("configure authentication")).toBe(
      normalizeQueryKey("authentication configure"),
    );
  });

  it("ignores punctuation and casing", () => {
    expect(normalizeQueryKey("Webhook Setup!")).toBe(
      normalizeQueryKey("webhook setup"),
    );
  });

  it("falls back to the cleaned form for all-stop-word input", () => {
    // "how to" reduces to no significant tokens, so it falls back to its
    // cleaned (lowercased, de-punctuated) form rather than an empty key — so
    // identical low-signal phrasings still group instead of each becoming a
    // singleton keyed on "".
    expect(normalizeQueryKey("how to")).toBe("how to");
    expect(normalizeQueryKey("how to")).not.toBe(
      normalizeQueryKey("webhook setup"),
    );
  });
});

describe("clusterQueries", () => {
  it("groups near-identical queries and sums counts", () => {
    const rows: QueryRow[] = [
      // Both normalize to the single token "authentication".
      {
        query_text: "how to set up authentication",
        tool_name: "search-docs",
        count: 10,
      },
      {
        query_text: "authentication setup",
        tool_name: "search-docs",
        count: 5,
      },
      { query_text: "deployment guide", tool_name: "search-docs", count: 3 },
    ];
    const clusters = clusterQueries(rows);

    // Two clusters: {authentication*} and {deployment guide}.
    expect(clusters).toHaveLength(2);

    const authCluster = clusters[0];
    expect(authCluster.totalCount).toBe(15);
    // Representative is the highest-count raw text.
    expect(authCluster.representative).toBe("how to set up authentication");
    expect(authCluster.members).toHaveLength(2);
  });

  it("sorts clusters by total count desc", () => {
    const rows: QueryRow[] = [
      { query_text: "rare topic", tool_name: "search-docs", count: 1 },
      { query_text: "popular topic", tool_name: "search-docs", count: 50 },
    ];
    const clusters = clusterQueries(rows);
    expect(clusters[0].representative).toBe("popular topic");
    expect(clusters[1].representative).toBe("rare topic");
  });

  it("collects distinct tool names per cluster", () => {
    const rows: QueryRow[] = [
      { query_text: "auth setup", tool_name: "search-docs", count: 2 },
      { query_text: "auth setup", tool_name: "search-code", count: 3 },
    ];
    const clusters = clusterQueries(rows);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].totalCount).toBe(5);
    expect(clusters[0].tools.sort()).toEqual(["search-code", "search-docs"]);
  });

  it("returns an empty array for no rows", () => {
    expect(clusterQueries([])).toEqual([]);
  });

  it("is deterministic across runs (stable tie-breaking)", () => {
    const rows: QueryRow[] = [
      { query_text: "topic b", tool_name: "search-docs", count: 5 },
      { query_text: "topic a", tool_name: "search-docs", count: 5 },
    ];
    const first = clusterQueries(rows).map((c) => c.representative);
    const second = clusterQueries(rows).map((c) => c.representative);
    expect(first).toEqual(second);
    // Equal counts break ties alphabetically by representative.
    expect(first).toEqual(["topic a", "topic b"]);
  });
});
