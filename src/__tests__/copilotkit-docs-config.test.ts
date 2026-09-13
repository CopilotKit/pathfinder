// Guards the SHIPPED production config, deploy/copilotkit-docs.yaml, on the
// three properties that decide whether a live documentation page is findable,
// whether the link a search result hands back actually resolves, and whether
// the tool description an LLM reads to route its query is true:
//
//   1. which repository files the `docs` source claims,
//   2. the URL each claimed file derives, and
//   3. what `search-docs` advertises that it covers.
//
// Both (1) and (2) were silently wrong before. The API reference — 184 pages
// under src/content/reference/ — went unindexed for months because the walk
// root was its sibling. Then the opposite failure: src/content/ag-ui/ was
// added to file_patterns hours before CopilotKit#7092 deleted that tree
// upstream, so the index held 96 pages whose source no longer exists and
// `search-docs` advertised links to dying URLs. Neither was visible from any
// unit test over synthetic configs, because the defect lived in the YAML that
// ships.
//
// The derivation half matters just as much in the other direction: the ordered
// strip_prefix list is first-match-wins, so reordering or widening it mints
// plausible URLs that 404 — a search result that lies, which is worse than a
// missing one. These assertions pin one page per subtree.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { ServerConfigSchema, isFileSourceConfig } from "../types.js";
import { matchesPatterns } from "../indexing/utils.js";
import { deriveUrl } from "../indexing/url-derivation.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG_PATH = resolve(REPO_ROOT, "deploy/copilotkit-docs.yaml");

const config = ServerConfigSchema.parse(
  parseYaml(readFileSync(CONFIG_PATH, "utf8")),
);
const docsSource = config.sources.find((s) => s.name === "docs");
if (!docsSource || !isFileSourceConfig(docsSource)) {
  throw new Error("deploy/copilotkit-docs.yaml has no file source named docs");
}

const CONTENT = "showcase/shell-docs/src/content/";

describe("deploy/copilotkit-docs.yaml — docs source coverage", () => {
  it.each([["docs/quickstart.mdx"], ["reference/hooks/useAgent.mdx"]])(
    "claims %s",
    (rel) => {
      expect(matchesPatterns(CONTENT + rel, docsSource)).toBe(true);
    },
  );

  it("does not claim MDX partials, which are inlined into pages", () => {
    expect(
      matchesPatterns(CONTENT + "snippets/installation.mdx", docsSource),
    ).toBe(false);
  });

  // CopilotKit#7092 deleted showcase/shell-docs/src/content/ag-ui/ upstream on
  // 2026-09-11. Claiming a tree that no longer exists indexes pages whose
  // source is gone and whose docs.copilotkit.ai/ag-ui/... URLs die as the site
  // rebuilds. The canonical copy is the upstream ag-ui-protocol/ag-ui docs
  // tree, already indexed by the `ag-ui-docs` source, which answers with
  // docs.ag-ui.com links that resolve.
  it.each([
    ["ag-ui/concepts/agents.mdx"],
    ["ag-ui/concepts/architecture.mdx"],
    ["ag-ui/agentic-protocols.mdx"],
    ["ag-ui/sdk/js/core/events.mdx"],
  ])("does not claim the retired mirror page %s", (rel) => {
    expect(matchesPatterns(CONTENT + rel, docsSource)).toBe(false);
  });

  // An exemption records a tree that EXISTS and is correctly unclaimed. The
  // ag-ui tree no longer exists, so the unclaimed-content audit cannot fire on
  // it either way; an entry here would be a permanent blind spot for whatever
  // lands at that path next.
  it("adds no unclaimed-audit exemption for the deleted ag-ui path", () => {
    const exempt = docsSource.unclaimed_exempt_paths ?? [];
    expect(exempt.some((p) => p.includes("content/ag-ui"))).toBe(false);
  });
});

describe("deploy/copilotkit-docs.yaml — derived URLs match the live routes", () => {
  it.each([
    // Prose pages live at the site ROOT — the longer content/docs/ prefix
    // must keep winning over the shorter content/ one.
    ["docs/quickstart.mdx", "https://docs.copilotkit.ai/quickstart"],
    // Reference pages are a SIBLING of the prose tree, so they fall through to
    // the shorter content/ prefix and keep their directory. This is the pin
    // that catches a reordered or widened strip_prefix list.
    [
      "reference/hooks/useAgent.mdx",
      "https://docs.copilotkit.ai/reference/hooks/useAgent",
    ],
    ["docs/index.mdx", "https://docs.copilotkit.ai/"],
  ])("derives %s -> %s", (rel, expected) => {
    expect(deriveUrl(CONTENT + rel, docsSource)).toBe(expected);
  });
});

// A search tool's description is what an LLM reads to decide which tool to
// call, so a stale coverage claim there misroutes every query it touches.
// search-docs advertised the docs.copilotkit.ai/ag-ui/... mirror right up
// until CopilotKit#7092 deleted it; the canonical AG-UI copy belongs to
// search-ag-ui-docs.
describe("deploy/copilotkit-docs.yaml — search-docs advertises only what it indexes", () => {
  const tools =
    (
      config as unknown as {
        tools?: Array<{ name?: string; description?: string }>;
      }
    ).tools ?? [];
  const byName = Object.fromEntries(
    tools.map((t) => [String(t.name), String(t.description ?? "")]),
  );

  // Naming AG-UI to route AWAY from it is correct and stays. What must not
  // come back is a COVERAGE claim — the docs.copilotkit.ai/ag-ui/... link
  // shape that told an LLM search-docs could answer AG-UI questions itself.
  it("does not claim to cover the retired docs.copilotkit.ai/ag-ui pages", () => {
    const description = byName["search-docs"];
    expect(description).toBeDefined();
    expect(description).not.toMatch(/copilotkit\.ai\/ag-ui/i);
    expect(description).not.toMatch(/hosted on the CopilotKit docs site/i);
  });

  it("points AG-UI protocol questions at search-ag-ui-docs", () => {
    expect(byName["search-docs"]).toMatch(
      /NOT for AG-UI protocol docs \(use search-ag-ui-docs\)/,
    );
  });

  it("describes search-ag-ui-docs as the AG-UI documentation, with no second copy", () => {
    const description = byName["search-ag-ui-docs"];
    expect(description).toBeDefined();
    expect(description).toContain("https://docs.ag-ui.com");
    expect(description).not.toMatch(/docs\.copilotkit\.ai/);
  });
});

// The shipped exclusion for the GitHub-issue triage relay. It is pinned here
// rather than left to the YAML alone because the rule is what keeps relayed
// issue bodies — SEO spam included — out of the weekly Notion search report
// and the gap-analysis LLM prompt until the relay starts declaring itself with
// `X-Pathfinder-Source: github-triage`.
describe("deploy/copilotkit-docs.yaml — machine-relay exclusion", () => {
  const relays =
    (config as unknown as { analytics?: { machine_relays?: unknown[] } })
      .analytics?.machine_relays ?? [];

  const byName = Object.fromEntries(
    (relays as Array<Record<string, unknown>>).map((r) => [String(r.name), r]),
  );

  it("declares the GitHub-issue triage relay by identity, not by content shape", () => {
    const rule = byName["github-issue-triage"];
    expect(rule).toBeDefined();
    expect(rule.user_agent).toBe("node");
    expect(rule.client_ip_cidr).toBe("152.55.176.0/20");
    // An operator reading the dashboard panel must be able to see WHY.
    expect(String(rule.reason)).toContain("triage relay");
  });

  // The ad-hoc Python replay harness: 258 rows from one workstation in one
  // 55-second burst on 2026-09-10, 206 of its 258 distinct query texts
  // verbatim replays of queries other clients had already logged. Pinned here
  // because the rule is what keeps a hand-run benchmark from reading as user
  // demand in Top Queries, the weekly Notion report and the gap analysis.
  it("declares the ad-hoc Python replay harness by User-Agent alone", () => {
    const rule = byName["adhoc-python-replay-harness"];
    expect(rule).toBeDefined();
    expect(rule.user_agent).toBe("Python-urllib/3.9");
    // Deliberately NO CIDR: the source is a residential dynamic address, so
    // pinning it would be brittle and would publish a home IP. The User-Agent
    // is sufficient — no MCP client library speaks stdlib urllib.
    expect(rule.client_ip_cidr).toBeUndefined();
    expect(String(rule.reason)).toContain("replay harness");
  });

  it("declares only identity-shaped rules — no content-shape predicate", () => {
    expect(relays).toHaveLength(2);
    for (const rule of relays as Array<Record<string, unknown>>) {
      // Every rule must carry a human-readable reason for the dashboard
      // panel, and may only discriminate on identity (UA / source network).
      expect(String(rule.reason ?? "")).not.toHaveLength(0);
      expect(Object.keys(rule).sort()).toEqual(
        expect.arrayContaining(["name", "reason"]),
      );
      for (const key of Object.keys(rule)) {
        expect(["name", "reason", "user_agent", "client_ip_cidr"]).toContain(
          key,
        );
      }
    }
  });
});
