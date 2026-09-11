// Detect content that exists in a repository but that NO configured source
// claims.
//
// Every other reindex-audit check compares what is on disk against what is in
// the index — but "what is on disk" is enumerated by walking the path the
// CONFIG points at, the same path the indexer used. When that walk root is
// wrong or too narrow, both halves of the comparison are blind identically and
// agree perfectly.
//
// That is not hypothetical. The CopilotKit API reference — 184 `.mdx` files
// under `showcase/shell-docs/src/content/reference/` — was invisible for
// months because the docs source's `path` was the SIBLING directory
// `showcase/shell-docs/src/content/docs/`. The indexer walked `docs/` and
// found 682 files, the audit walked `docs/` and found 682, the index held 682:
// a perfect match, with 183 live documentation pages missing from search.
//
// So this check is anchored to the REPOSITORY rather than to the config: it
// walks the whole repo and asks which indexable-looking files no source's walk
// root and patterns would ever reach.

import fs from "node:fs";
import path from "node:path";
import { globToRegex, matchesPatterns } from "./utils.js";
import type { FileSourceConfig } from "../types.js";

/**
 * Minimum files of ONE extension in a single unclaimed directory tree before
 * it is worth an operator's attention.
 *
 * Noise control is the whole problem here. Most of a repository is
 * legitimately unclaimed, and a check that reports every unclaimed file is
 * worthless — it gets muted, which is exactly how the original blindness
 * arose. What distinguished the reference tree from ordinary unclaimed content
 * was its SHAPE: a large cohesive directory of the same file type the source
 * already indexes, sitting as a sibling of a claimed tree. This constant is the
 * "large" half of that shape.
 */
export const MIN_UNCLAIMED_CLUSTER_FILES = 10;

/**
 * Directories that never hold authored content. Dot-directories are skipped
 * wholesale (`.git`, `.next`, `.venv`, `.turbo`, `.pytest_cache`, …) since a
 * dot-prefixed directory is tooling state, not published material.
 */
const GENERATED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "vendor",
  "venv",
  "__pycache__",
  "site-packages",
  "storybook-static",
]);

/**
 * Ceiling on files examined per repository. A runaway walk must degrade the
 * audit, not the server it runs inside.
 */
const MAX_WALKED_FILES = 250_000;

export interface UnclaimedCluster {
  /** Repo-root-relative directory holding the unclaimed files. */
  dir: string;
  /** The file extension, including the dot. */
  extension: string;
  count: number;
  samples: string[];
}

/** Derive a repository directory name from a git URL. */
function repoNameFromUrl(url: string): string {
  return (
    url
      .split("/")
      .pop()
      ?.replace(/\.git$/, "") ?? "repo"
  );
}

/**
 * The directory that file paths for this source are relative to: the clone
 * root for a git source, the resolved path for a local one.
 *
 * A local source has no repository around it, so its own directory IS the
 * whole visible world and this check can only see inside it. Git sources are
 * where the blind spot lives, because there the config picks a subtree of
 * something larger.
 */
export function repoRootFor(
  source: FileSourceConfig,
  cloneDir: string,
): string {
  return source.repo
    ? path.join(cloneDir, repoNameFromUrl(source.repo))
    : path.resolve(source.path);
}

/** Group file sources by the repository root they read from. */
export function groupSourcesByRepoRoot(
  sources: FileSourceConfig[],
  cloneDir: string,
): Map<string, FileSourceConfig[]> {
  const groups = new Map<string, FileSourceConfig[]>();
  for (const source of sources) {
    const root = repoRootFor(source, cloneDir);
    const existing = groups.get(root);
    if (existing) existing.push(source);
    else groups.set(root, [source]);
  }
  return groups;
}

/** Repo-root-relative prefix of a source's walk root ("" for the whole repo). */
function walkRootPrefix(source: FileSourceConfig): string {
  if (!source.repo) return "";
  const normalized = source.path
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  return normalized === "" || normalized === "." ? "" : `${normalized}/`;
}

/** Compiled include/exclude/exempt patterns, built once per source. */
interface SourceMatcher {
  prefix: string;
  source: FileSourceConfig;
  includes: RegExp[];
  excludes: RegExp[];
}

function compile(source: FileSourceConfig): SourceMatcher {
  return {
    prefix: walkRootPrefix(source),
    source,
    includes: source.file_patterns.map(globToRegex),
    excludes: (source.exclude_patterns ?? []).map(globToRegex),
  };
}

/** Does an exemption entry cover this repo-root-relative path? */
function isExempt(rel: string, exemptions: string[]): boolean {
  for (const raw of exemptions) {
    const entry = raw
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/+$/, "");
    if (entry === "" || entry === ".") return true;
    if (rel === entry || rel.startsWith(`${entry}/`)) return true;
    if (/[*?]/.test(entry) && globToRegex(entry).test(rel)) return true;
  }
  return false;
}

type FileStatus = "claimed" | "accounted" | "unclaimed";

/**
 * How a repository file relates to the configured sources.
 *
 * `accounted` is the load-bearing middle state: a file the source's own
 * `exclude_patterns` knock out was reviewed by an operator and rejected on
 * purpose, so it is not a blind spot. The exclusion only counts when one of
 * that source's INCLUDE patterns would otherwise have taken the file —
 * otherwise a code source whose globstar exclusion covers all of `showcase/`
 * would silently vouch for every `.mdx` under `showcase/` too, and that is
 * precisely the tree the reference pages were hiding in.
 */
function classify(rel: string, matchers: SourceMatcher[]): FileStatus {
  let accounted = false;
  for (const m of matchers) {
    if (m.prefix && !rel.startsWith(m.prefix)) continue;
    if (matchesPatterns(rel, m.source)) return "claimed";
    if (
      m.excludes.length > 0 &&
      m.includes.some((re) => re.test(rel)) &&
      m.excludes.some((re) => re.test(rel))
    ) {
      accounted = true;
    }
  }
  return accounted ? "accounted" : "unclaimed";
}

function parentDir(dir: string): string {
  const i = dir.lastIndexOf("/");
  return i === -1 ? "" : dir.slice(0, i);
}

interface DirStats {
  claimed: number;
  claimedByExt: Map<string, number>;
  candidateByExt: Map<string, { count: number; samples: string[] }>;
}

function statsFor(map: Map<string, DirStats>, dir: string): DirStats {
  let s = map.get(dir);
  if (!s) {
    s = { claimed: 0, claimedByExt: new Map(), candidateByExt: new Map() };
    map.set(dir, s);
  }
  return s;
}

/**
 * Find directory trees of indexable-looking files that no source claims.
 *
 * `sources` must be EVERY configured source reading from `repoRoot`, not just
 * the ones that happened to reindex — a file claimed by a source that did not
 * run is still claimed.
 */
export async function findUnclaimedClusters(
  repoRoot: string,
  sources: FileSourceConfig[],
): Promise<UnclaimedCluster[]> {
  if (sources.length === 0 || !fs.existsSync(repoRoot)) return [];

  const matchers = sources.map(compile);
  const exemptions = sources.flatMap((s) => s.unclaimed_exempt_paths ?? []);
  const skipDirs = new Set([
    ...GENERATED_DIRS,
    ...sources.flatMap((s) => s.skip_dirs ?? []),
  ]);

  const dirs = new Map<string, DirStats>();
  let walked = 0;
  let truncated = false;

  async function walk(absDir: string, relDir: string): Promise<void> {
    if (truncated) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      console.warn(
        `[reindex-audit] Failed to read ${absDir}:`,
        err instanceof Error ? err.message : err,
      );
      return;
    }
    // Sorted so samples and finding order are stable across runs and hosts.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (truncated) return;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || skipDirs.has(entry.name)) continue;
        await walk(path.join(absDir, entry.name), rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (++walked > MAX_WALKED_FILES) {
        truncated = true;
        console.warn(
          `[reindex-audit] Unclaimed-content scan of ${repoRoot} hit the ${MAX_WALKED_FILES}-file ceiling; skipping`,
        );
        return;
      }

      const ext = path.extname(entry.name);
      if (!ext) continue;
      const status = classify(rel, matchers);
      // An exempt file is one an operator already reviewed and signed off on;
      // it is neither a claim nor a blind spot.
      const candidate =
        status === "unclaimed" && !isExempt(rel, exemptions) ? ext : null;
      if (status !== "claimed" && !candidate) continue;

      for (let dir = relDir; ; dir = parentDir(dir)) {
        const s = statsFor(dirs, dir);
        if (status === "claimed") {
          s.claimed++;
          s.claimedByExt.set(ext, (s.claimedByExt.get(ext) ?? 0) + 1);
        } else if (candidate) {
          let c = s.candidateByExt.get(candidate);
          if (!c) {
            c = { count: 0, samples: [] };
            s.candidateByExt.set(candidate, c);
          }
          c.count++;
          if (c.samples.length < 10) c.samples.push(rel);
        }
        if (dir === "") break;
      }
    }
  }

  await walk(repoRoot, "");
  if (truncated) return [];

  // Roll up to the MAXIMAL unclaimed subtree: the highest directory holding no
  // claimed file at all whose parent DOES hold one. `content/reference/` rolls
  // up as a single 184-file finding rather than fragmenting into
  // `reference/hooks/`, `reference/components/`, and a dozen more — each too
  // small to clear the bar and far too many to read.
  const clusters: UnclaimedCluster[] = [];
  for (const [dir, stats] of dirs) {
    if (dir === "" || stats.claimed > 0) continue;
    const parent = dirs.get(parentDir(dir));
    if (!parent || parent.claimed === 0) continue;

    for (const [ext, c] of stats.candidateByExt) {
      if (c.count < MIN_UNCLAIMED_CLUSTER_FILES) continue;
      // The extension must be one this repository already publishes THROUGH
      // THE SAME PARENT — the reference tree's signature. A repo's stray
      // `.ts` scripts sitting beside an indexed docs tree are not a
      // documentation gap, and saying so here is what keeps the check quiet.
      if ((parent.claimedByExt.get(ext) ?? 0) === 0) continue;
      clusters.push({
        dir,
        extension: ext,
        count: c.count,
        samples: c.samples,
      });
    }
  }

  clusters.sort(
    (a, b) =>
      a.dir.localeCompare(b.dir) || a.extension.localeCompare(b.extension),
  );
  return clusters;
}
