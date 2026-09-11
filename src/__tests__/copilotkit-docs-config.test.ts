// Guards the SHIPPED production config, deploy/copilotkit-docs.yaml, on the
// two properties that decide whether a live documentation page is findable and
// whether the link a search result hands back actually resolves:
//
//   1. which repository files the `docs` source claims, and
//   2. the URL each claimed file derives.
//
// Both were silently wrong before. The API reference — 184 pages under
// src/content/reference/ — went unindexed for months because the walk root was
// its sibling, and the ag-ui tree's 96 live pages went unindexed because
// file_patterns never named it. Neither failure was visible from any unit test
// over synthetic configs, because the defect lived in the YAML that ships.
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
  it.each([
    ["ag-ui/concepts/agents.mdx"],
    ["ag-ui/concepts/architecture.mdx"],
    ["ag-ui/agentic-protocols.mdx"],
    ["ag-ui/sdk/js/core/events.mdx"],
    ["docs/quickstart.mdx"],
    ["reference/hooks/useAgent.mdx"],
  ])("claims %s", (rel) => {
    expect(matchesPatterns(CONTENT + rel, docsSource)).toBe(true);
  });

  it("does not claim MDX partials, which are inlined into pages", () => {
    expect(
      matchesPatterns(CONTENT + "snippets/installation.mdx", docsSource),
    ).toBe(false);
  });

  it("leaves the ag-ui tree out of the unclaimed-audit exemptions now that it is claimed", () => {
    const exempt = docsSource.unclaimed_exempt_paths ?? [];
    expect(exempt.some((p) => p.includes("content/ag-ui"))).toBe(false);
  });
});

describe("deploy/copilotkit-docs.yaml — derived URLs match the live routes", () => {
  it.each([
    // src/app/ag-ui/[[...slug]] serves the ag-ui tree UNDER /ag-ui/.
    [
      "ag-ui/concepts/agents.mdx",
      "https://docs.copilotkit.ai/ag-ui/concepts/agents",
    ],
    [
      "ag-ui/sdk/js/core/events.mdx",
      "https://docs.copilotkit.ai/ag-ui/sdk/js/core/events",
    ],
    ["ag-ui/introduction.mdx", "https://docs.copilotkit.ai/ag-ui/introduction"],
    // Prose pages live at the site ROOT — the longer content/docs/ prefix
    // must keep winning over the shorter content/ one.
    ["docs/quickstart.mdx", "https://docs.copilotkit.ai/quickstart"],
    // Reference pages keep their directory.
    [
      "reference/hooks/useAgent.mdx",
      "https://docs.copilotkit.ai/reference/hooks/useAgent",
    ],
  ])("derives %s -> %s", (rel, expected) => {
    expect(deriveUrl(CONTENT + rel, docsSource)).toBe(expected);
  });
});
