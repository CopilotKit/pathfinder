/**
 * End-to-end proof for the unclaimed-content audit.
 *
 * Reconstructs the real blind spot: the CopilotKit API reference — 184 `.mdx`
 * files under `showcase/shell-docs/src/content/reference/` — was invisible for
 * months because the docs source's `path` was the SIBLING directory
 * `showcase/shell-docs/src/content/docs/`. Every existing audit check compares
 * disk against index, but "disk" is enumerated by walking the path the config
 * points at, so both halves were blind identically and agreed perfectly.
 *
 * The disk here is REAL — a temp-dir repo fixture laid out like the clone the
 * indexer walks — and `walkSourceFiles` is the real implementation, so the
 * test exercises the actual enumeration path rather than a hand-built
 * "these files are missing" fixture. Only the app config and the database are
 * faked.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { mockGetConfig, mockGetServerConfig, mockGetIndexedItemIds } = vi.hoisted(
  () => ({
    mockGetConfig: vi.fn(),
    mockGetServerConfig: vi.fn(),
    mockGetIndexedItemIds: vi.fn(),
  }),
);

vi.mock("../config.js", () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
  getServerConfig: (...args: unknown[]) => mockGetServerConfig(...args),
}));

vi.mock("../db/queries.js", () => ({
  getIndexedItemIds: (...args: unknown[]) => mockGetIndexedItemIds(...args),
}));

import { runReindexAudit, resetAuditCache } from "../indexing/reindex-audit.js";
import { walkSourceFiles } from "../indexing/utils.js";
import type { FileSourceConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Repo fixture — the historical layout, shrunk
// ---------------------------------------------------------------------------

const CONTENT = "showcase/shell-docs/src/content";
let tmpRoot: string;
let cloneDir: string;
let repoRoot: string;

function write(rel: string, body = "# page\n\nprose\n"): void {
  const full = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

function writeMany(dir: string, ext: string, n: number, prefix = "page"): void {
  for (let i = 0; i < n; i++) write(`${dir}/${prefix}-${i}${ext}`);
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pf-unclaimed-"));
  cloneDir = path.join(tmpRoot, "clones");
  // repoNameFromUrl("https://github.com/acme/shell.git") -> "shell"
  repoRoot = path.join(cloneDir, "shell");

  // Claimed: the prose docs tree the (mis-scoped) source walks.
  writeMany(`${CONTENT}/docs`, ".mdx", 30);
  writeMany(`${CONTENT}/docs/guides`, ".mdx", 20, "guide");

  // UNCLAIMED, and the whole point: a large cohesive sibling of the claimed
  // tree, same file type, rendered by the site but reachable by no source.
  writeMany(`${CONTENT}/reference/hooks`, ".mdx", 20, "use");
  writeMany(`${CONTENT}/reference/components`, ".mdx", 15, "comp");

  // UNCLAIMED but deliberately so: MDX partials inlined at render time.
  // Big enough to cluster, and the case the opt-out exists for.
  writeMany(`${CONTENT}/snippets`, ".mdx", 12, "snippet");

  // Ordinary unclaimed content: a handful of scattered files.
  writeMany(`${CONTENT}/misc`, ".mdx", 3, "note");

  // A tests tree the code source explicitly excludes.
  writeMany("packages/core/tests", ".ts", 40, "spec");
  // Claimed code, so .ts is an extension this repo indexes.
  writeMany("packages/core/src", ".ts", 25, "mod");
  // Build output: a framework's generated bundle, same extension as claimed
  // code. Must never be walked.
  writeMany(`${CONTENT}/../.next/static`, ".ts", 50, "chunk");
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REPO = "https://github.com/acme/shell.git";

/** The docs source AS IT WAS: walk root pinned to the prose tree. */
function docsSource(overrides: Partial<FileSourceConfig> = {}): FileSourceConfig {
  return {
    name: "docs",
    type: "markdown",
    repo: REPO,
    path: `${CONTENT}/docs/`,
    file_patterns: [`${CONTENT}/docs/**/*.mdx`],
    chunk: {},
    ...overrides,
  } as FileSourceConfig;
}

function codeSource(): FileSourceConfig {
  return {
    name: "code",
    type: "code",
    repo: REPO,
    path: ".",
    file_patterns: ["**/*.ts"],
    exclude_patterns: ["**/tests/**"],
    chunk: {},
  } as FileSourceConfig;
}

function appConfig() {
  return {
    databaseUrl: "postgresql://test",
    openaiApiKey: "test-key",
    githubToken: "",
    cloneDir,
    slackWebhookUrl: "",
  };
}

/**
 * Point the fake index at exactly what each source walks, so the stale /
 * scope-leak / divergence checks all stay silent and any finding the test sees
 * is the new one.
 */
function indexInSyncWith(sources: FileSourceConfig[]): void {
  mockGetIndexedItemIds.mockImplementation(async (name: string) => {
    const src = sources.find((s) => s.name === name)!;
    return (await walkSourceFiles(src, cloneDir, "")) ?? new Set<string>();
  });
}

function setSources(sources: FileSourceConfig[]): void {
  mockGetServerConfig.mockReturnValue({ sources });
  indexInSyncWith(sources);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAuditCache();
  mockGetConfig.mockReturnValue(appConfig());
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("unclaimed-content audit", () => {
  it("reports the reference tree no source's walk root can reach", async () => {
    setSources([
      docsSource({
        unclaimed_exempt_paths: [`${CONTENT}/snippets`],
      } as Partial<FileSourceConfig>),
      codeSource(),
    ]);

    const findings = await runReindexAudit(["docs", "code"]);

    const unclaimed = findings.filter((f) => f.check === "unclaimed_content");
    expect(unclaimed).toHaveLength(1);
    expect(unclaimed[0].path).toBe(`${CONTENT}/reference`);
    expect(unclaimed[0].extension).toBe(".mdx");
    expect(unclaimed[0].count).toBe(35);
    expect(unclaimed[0].samples.length).toBeGreaterThan(0);
    expect(unclaimed[0].samples.every((p) => p.includes("/reference/"))).toBe(
      true,
    );
  });

  it("goes silent once the config is fixed to claim the reference tree", async () => {
    setSources([
      docsSource({
        path: `${CONTENT}/`,
        file_patterns: [
          `${CONTENT}/docs/**/*.mdx`,
          `${CONTENT}/reference/**/*.mdx`,
        ],
        unclaimed_exempt_paths: [`${CONTENT}/snippets`],
      } as Partial<FileSourceConfig>),
      codeSource(),
    ]);

    const findings = await runReindexAudit(["docs", "code"]);

    expect(findings.filter((f) => f.check === "unclaimed_content")).toEqual([]);
  });

  // ── Negative assertions ────────────────────────────────────────────────
  //
  // Noise control IS the feature. A check that reports every unclaimed file
  // gets muted, and a muted check is how the reference tree stayed invisible.

  it("reports a deliberately-excluded directory until it is opted out", async () => {
    // Without the opt-out, snippets/ looks exactly like the reference tree.
    setSources([docsSource(), codeSource()]);
    const before = await runReindexAudit(["docs", "code"]);
    expect(
      before
        .filter((f) => f.check === "unclaimed_content")
        .map((f) => f.path)
        .sort(),
    ).toEqual([`${CONTENT}/reference`, `${CONTENT}/snippets`]);

    // The operator reviews it once, records it, and never sees it again.
    resetAuditCache();
    setSources([
      docsSource({
        unclaimed_exempt_paths: [`${CONTENT}/snippets`],
      } as Partial<FileSourceConfig>),
      codeSource(),
    ]);
    const after = await runReindexAudit(["docs", "code"]);
    expect(
      after.filter((f) => f.check === "unclaimed_content").map((f) => f.path),
    ).toEqual([`${CONTENT}/reference`]);
  });

  it("ignores a scattered handful of unclaimed files", async () => {
    setSources([
      docsSource({
        path: `${CONTENT}/`,
        file_patterns: [
          `${CONTENT}/docs/**/*.mdx`,
          `${CONTENT}/reference/**/*.mdx`,
        ],
        unclaimed_exempt_paths: [`${CONTENT}/snippets`],
      } as Partial<FileSourceConfig>),
      codeSource(),
    ]);

    const findings = await runReindexAudit(["docs", "code"]);

    // content/misc holds 3 unclaimed .mdx — real, unclaimed, and not worth
    // an alert. Only a cohesive tree clears the bar.
    expect(
      findings.some((f) => f.path === `${CONTENT}/misc`),
    ).toBe(false);
  });

  it("ignores an explicitly excluded tests tree and generated build output", async () => {
    setSources([
      docsSource({
        path: `${CONTENT}/`,
        file_patterns: [
          `${CONTENT}/docs/**/*.mdx`,
          `${CONTENT}/reference/**/*.mdx`,
        ],
        unclaimed_exempt_paths: [`${CONTENT}/snippets`],
      } as Partial<FileSourceConfig>),
      codeSource(),
    ]);

    const findings = await runReindexAudit(["docs", "code"]);
    const paths = findings
      .filter((f) => f.check === "unclaimed_content")
      .map((f) => f.path);

    // 40 .ts files, an extension the code source indexes, in a big cohesive
    // directory — silent ONLY because the source's exclude_patterns already
    // say so. An explicit exclusion IS an operator decision on record.
    expect(paths).not.toContain("packages/core/tests");
    // 50 .ts files of generated output, never walked at all.
    expect(paths.some((p) => p?.includes(".next"))).toBe(false);
    expect(findings.filter((f) => f.check === "unclaimed_content")).toEqual([]);
  });
});
