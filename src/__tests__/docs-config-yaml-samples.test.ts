// Structural guard for the YAML samples on the public config reference page
// (docs/config/index.html). Every `<div>` whose class list holds `code-block`
// is a YAML sample an operator may copy, so each one must parse and must pass
// the real config loader: getServerConfig() in src/config.ts. That runs
// ServerConfigSchema and the loader's own checks after it: unique source and
// tool names, and tool and webhook references to defined sources.
//
// The loader reads the file named by PATHFINDER_CONFIG. Here node:fs is mocked
// so that path returns the sample under test, and so that existsSync is always
// true. The loader also checks that a local source path exists on disk. That
// check is about the operator's machine, not the sample, so it is skipped.
//
// How a sample is classified (decided from its parsed top-level keys):
//   - Marked `data-sample="not-yaml"`: skipped. Only the url_derivation step
//     trace carries this marker; it is prose, not config. A test below pins
//     that exactly one block is marked, so the marker cannot spread silently.
//   - Has `server`, `sources` and `tools`: a full config. Validated as is,
//     with nothing added.
//   - Every top-level key is a ServerConfigSchema key: a partial config.
//     Validated inside a minimal valid wrapper (see `wrapConfigFragment`).
//   - Every top-level key is a file-source key: a partial source (for example
//     the url_derivation sample). Validated as one markdown source inside the
//     wrapper.
//   - Anything else fails: a sample whose keys the schema does not know.
//
// What the wrapper adds to a partial sample, and why:
//   - `server`, one source and one bash tool, because the schema requires
//     them. The source is named `docs`, the name the page's examples use, so a
//     sample reference to `docs` resolves. If the sample defines its own
//     `docs` source, the wrapper's source is left out.
//   - A stub markdown source for each source name that a sample TOOL names but
//     the sample does not define, because a tools-only sample cannot define
//     its sources. Webhook references get no stub: a dangling one fails, as it
//     does at load.
//   - `embedding`, only when the sample's only top-level key is `tools` and it
//     has no `embedding`. Such a sample shows one tool's fields on purpose,
//     and the page says next to it when that tool needs an embedding block.
//     Every other sample gets no embedding: if it needs one, it must show one,
//     or the schema's embedding rule fails it.
//
// zod strips unknown keys instead of rejecting them, so a successful load
// alone would pass a sample with a misspelled or renamed key. Each sample is
// therefore also checked for keys that the load dropped.
import { describe, it, expect, vi, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ServerConfigSchema, FileSourceConfigSchema } from "../types.js";
import { droppedKeys } from "./helpers/dropped-keys.js";

const DOCS_PATH = join(__dirname, "..", "..", "docs", "config", "index.html");

// The number of YAML samples on the page (code blocks without a
// data-sample marker). Update it when a sample is added or removed.
const EXPECTED_YAML_SAMPLES = 22;

interface Sample {
  line: number;
  marker: string | undefined;
  text: string;
}

const decodeEntities = (t: string): string =>
  t
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

/** True when an opening tag's attribute text has `code-block` in its class list. */
const hasCodeBlockClass = (attrs: string): boolean =>
  /\bclass\s*=\s*(["'])(?:(?!\1).)*\bcode-block\b/.test(attrs);

/** The value of attribute `name` in an opening tag's attribute text. */
const attrValue = (attrs: string, name: string): string | undefined =>
  attrs.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`))?.[2];

/**
 * Every code-block body on the page, with tags stripped and entities decoded.
 * Any `<div>` whose class list holds `code-block` counts, whatever its other
 * attributes or their order.
 */
function extractSamples(html: string): Sample[] {
  const out: Sample[] = [];
  for (const m of html.matchAll(/<div\b([^>]*)>/g)) {
    if (!hasCodeBlockClass(m[1])) continue;
    // A code block holds no nested <div>, so its body ends at the next </div>.
    const start = m.index + m[0].length;
    const end = html.indexOf("</div>", start);
    out.push({
      line: html.slice(0, m.index).split("\n").length,
      marker: attrValue(m[1], "data-sample"),
      text: decodeEntities(
        html
          .slice(start, end === -1 ? html.length : end)
          .replace(/<[^>]*>/g, ""),
      ),
    });
  }
  return out;
}

/** Opening `<div>` tags with `code-block` in the class list, counted alone. */
const countCodeBlockTags = (html: string): number =>
  [...html.matchAll(/<div\b([^>]*)>/g)].filter((m) => hasCodeBlockClass(m[1]))
    .length;

const TOP_LEVEL_KEYS = new Set(
  Object.keys(ServerConfigSchema.innerType().shape),
);
const FILE_SOURCE_KEYS = new Set(Object.keys(FileSourceConfigSchema.shape));

const WRAPPER_SOURCE = {
  name: "docs",
  type: "markdown",
  path: "./docs",
  file_patterns: ["**/*.md"],
};

const WRAPPER_EMBEDDING = {
  provider: "openai",
  model: "text-embedding-3-small",
  dimensions: 1536,
};

/**
 * Put a partial config into the smallest config that validates on its own.
 * See the header for what is added and why. `sources` and `tools` from the
 * sample are appended to the wrapper's lists; any other key from the sample
 * replaces the wrapper's value.
 */
function wrapConfigFragment(frag: Record<string, unknown>): unknown {
  const fragSources =
    (frag.sources as Record<string, unknown>[] | undefined) ?? [];
  const sources: Record<string, unknown>[] = fragSources.some(
    (s) => s.name === WRAPPER_SOURCE.name,
  )
    ? [...fragSources]
    : [WRAPPER_SOURCE, ...fragSources];
  const tools = (frag.tools as Record<string, unknown>[] | undefined) ?? [];
  const defined = new Set(sources.map((s) => s.name));
  for (const t of tools) {
    const refs = [
      ...(typeof t.source === "string" ? [t.source] : []),
      ...(Array.isArray(t.sources) ? (t.sources as string[]) : []),
    ];
    for (const name of refs.filter((n) => !defined.has(n))) {
      defined.add(name);
      sources.push({ ...WRAPPER_SOURCE, name });
    }
  }
  const toolsOnly = Object.keys(frag).every((k) => k === "tools");
  return {
    server: { name: "wrapper", version: "1.0.0" },
    ...(toolsOnly ? { embedding: WRAPPER_EMBEDDING } : {}),
    ...frag,
    sources,
    tools: [
      {
        name: "wrapper-explore",
        type: "bash",
        description: "wrapper",
        sources: [WRAPPER_SOURCE.name],
      },
      ...tools,
    ],
  };
}

// ── The real loader, fed one sample at a time ────────────────────────────────

const VIRTUAL_CONFIG = join(__dirname, "__docs-sample__", "pathfinder.yaml");
let currentConfigText = "";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    // Local source paths in samples do not exist on this machine.
    existsSync: () => true,
    readFileSync: ((path: unknown, ...rest: unknown[]) =>
      path === VIRTUAL_CONFIG
        ? currentConfigText
        : (actual.readFileSync as (...a: unknown[]) => unknown)(
            path,
            ...rest,
          )) as typeof actual.readFileSync,
  };
});

const savedConfigEnv = process.env.PATHFINDER_CONFIG;
afterAll(() => {
  if (savedConfigEnv === undefined) delete process.env.PATHFINDER_CONFIG;
  else process.env.PATHFINDER_CONFIG = savedConfigEnv;
});

/** Run `input` through getServerConfig() from a fresh config module. */
async function loadWithRealLoader(input: unknown): Promise<unknown> {
  currentConfigText = stringifyYaml(input);
  process.env.PATHFINDER_CONFIG = VIRTUAL_CONFIG;
  vi.resetModules();
  const { getServerConfig } = await import("../config.js");
  return getServerConfig();
}

type Verdict = { ok: true } | { ok: false; reason: string };

/** Parse one sample and run it through the real config loader. */
async function checkSample(text: string): Promise<Verdict> {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (e) {
    return { ok: false, reason: `YAML parse error: ${(e as Error).message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "sample is not a YAML mapping" };
  }
  const frag = parsed as Record<string, unknown>;
  const keys = Object.keys(frag);
  let input: unknown;
  if (["server", "sources", "tools"].every((k) => k in frag)) {
    input = frag;
  } else if (keys.every((k) => TOP_LEVEL_KEYS.has(k))) {
    input = wrapConfigFragment(frag);
  } else if (keys.every((k) => FILE_SOURCE_KEYS.has(k))) {
    input = wrapConfigFragment({
      sources: [{ ...WRAPPER_SOURCE, ...frag, name: "sample" }],
    });
  } else {
    return {
      ok: false,
      reason: `top-level keys [${keys.join(", ")}] are neither config keys nor source keys`,
    };
  }
  let loaded: unknown;
  try {
    loaded = await loadWithRealLoader(input);
  } catch (e) {
    return { ok: false, reason: `config load failed: ${(e as Error).message}` };
  }
  const dropped = droppedKeys(input, loaded);
  if (dropped.length > 0) {
    return {
      ok: false,
      reason: `keys the schema does not know: ${dropped.join(", ")}`,
    };
  }
  return { ok: true };
}

describe("docs/config/index.html YAML samples", () => {
  const html = readFileSync(DOCS_PATH, "utf8");
  const samples = extractSamples(html);
  const yamlSamples = samples.filter((s) => s.marker === undefined);

  it("extracts every code block, and only the url_derivation trace is marked not-yaml", () => {
    // Every code-block tag on the page yields a sample, so a block cannot
    // drop out of the checks below because of an attribute the extractor
    // does not expect.
    expect(samples.length).toBe(countCodeBlockTags(html));
    expect(yamlSamples.length).toBe(EXPECTED_YAML_SAMPLES);
    const marked = samples.filter((s) => s.marker !== undefined);
    expect(marked.map((s) => s.marker)).toEqual(["not-yaml"]);
    expect(marked[0].text).toMatch(/^# Original file path/);
  });

  it("extracts a code block whatever its other attributes", () => {
    const got = extractSamples(
      [
        '<div id="a" class="note code-block">x: 1</div>',
        "<div data-sample='not-yaml' class='code-block'>y</div>",
        '<div class="code-blocks">z: 1</div>',
      ].join("\n"),
    );
    expect(got).toEqual([
      { line: 1, marker: undefined, text: "x: 1" },
      { line: 2, marker: "not-yaml", text: "y" },
    ]);
  });

  it.each(yamlSamples.map((s) => [s.line, s.text] as const))(
    "the sample at line %i parses and passes the config loader",
    async (_line, text) => {
      expect(await checkSample(text)).toEqual({ ok: true });
    },
  );

  it.each([
    [
      "a key the schema does not know",
      "tools:\n  - name: t\n    type: bash\n    description: d\n    sources: [docs]\n    bash:\n      grep_strategi: memory\n",
      /keys the schema does not know: .*grep_strategi/,
    ],
    ["a YAML parse error", "server: [unclosed\n", /^YAML parse error: /],
    ["a document that is not a mapping", "- a\n- b\n", /not a YAML mapping/],
    ["a scalar document", "just text\n", /not a YAML mapping/],
    [
      "an unknown top-level key",
      "servr:\n  name: x\n",
      /top-level keys \[servr\] are neither config keys nor source keys/,
    ],
    [
      "a dangling webhook source reference",
      'webhook:\n  repo_sources:\n    "org/repo": [nonexistent]\n  path_triggers:\n    docs: ["docs/"]\n',
      /Webhook repo_sources\["org\/repo"\] references source "nonexistent"/,
    ],
    [
      "a dangling webhook path_triggers key",
      'webhook:\n  repo_sources:\n    "org/repo": [docs]\n  path_triggers:\n    nonexistent: ["docs/"]\n',
      /path_triggers key "nonexistent" does not match any defined source/,
    ],
    [
      "duplicate tool names",
      "tools:\n  - name: dup\n    type: bash\n    description: d\n    sources: [docs]\n  - name: dup\n    type: bash\n    description: d\n    sources: [docs]\n",
      /Duplicate tool names/,
    ],
    [
      "a search tool in a partial sample that is not tools-only, with no embedding",
      "indexing:\n  auto_reindex: false\ntools:\n  - name: s\n    type: search\n    description: d\n    source: docs\n    default_limit: 5\n    max_limit: 20\n    result_format: docs\n",
      /config load failed: [\s\S]*embedding config is required/,
    ],
  ])("rejects %s", async (_name, text, reason) => {
    const verdict = await checkSample(text);
    expect(verdict.ok).toBe(false);
    expect(verdict).toMatchObject({ reason: expect.stringMatching(reason) });
  });
});
