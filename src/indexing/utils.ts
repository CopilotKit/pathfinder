// Shared indexing utilities — used by providers, bash-fs, and test scripts.

import fs from "node:fs";
import path from "node:path";
import type { FileSourceConfig } from "../types.js";

/**
 * Check if file content has low semantic value (SVG paths, base64, minified code).
 * Samples the first 8KB and checks the ratio of digits, dots, commas, semicolons,
 * and equals signs. If >30% of characters are these low-value tokens, the file
 * is likely SVG path data, base64, or minified code with no search value.
 */
export function hasLowSemanticValue(content: string): boolean {
  if (content.length < 500) return false;

  const sample = content.slice(0, 8192);
  let lowValueChars = 0;

  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (
      (c >= 48 && c <= 57) || // 0-9
      c === 46 || // .
      c === 44 || // ,
      c === 59 || // ;
      c === 61 // =
    ) {
      lowValueChars++;
    }
  }

  const ratio = lowValueChars / sample.length;
  return ratio > 0.3;
}

/**
 * Convert a glob pattern to a RegExp.
 * Supports: ** (any path), * (any segment), ? (any char)
 */
export function globToRegex(pattern: string): RegExp {
  let re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex chars (except * and ?)
    .replace(/\*\*\//g, "{{GLOBSTAR_SLASH}}") // **/ = any path prefix (including empty)
    .replace(/\*\*/g, "{{GLOBSTAR}}") // ** alone = anything
    .replace(/\*/g, "[^/]*") // * = anything except /
    .replace(/\?/g, "[^/]") // ? = single char except /
    .replace(/\{\{GLOBSTAR_SLASH\}\}/g, "(?:.*/)?") // **/ = optional path prefix
    .replace(/\{\{GLOBSTAR\}\}/g, ".*"); // ** = anything including /

  return new RegExp(`^${re}$`);
}

/**
 * Check if a relative file path matches the source's file_patterns (include)
 * and does not match exclude_patterns.
 */
export function matchesPatterns(
  relPath: string,
  sourceConfig: FileSourceConfig,
): boolean {
  const normalized = relPath.replace(/\\/g, "/");

  // Check excludes first (takes precedence)
  const excludes = sourceConfig.exclude_patterns ?? [];
  for (const pattern of excludes) {
    if (globToRegex(pattern).test(normalized)) {
      return false;
    }
  }

  // Must match at least one include pattern
  for (const pattern of sourceConfig.file_patterns) {
    if (globToRegex(pattern).test(normalized)) {
      return true;
    }
  }

  return false;
}

// ── Default constants (mirrored from FileDataProvider) ───────────────────────

const DEFAULT_SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git"]);
const DEFAULT_MAX_FILE_SIZE = 102400; // 100KB

/**
 * Derive a repository directory name from a git URL.
 * Example: "https://github.com/org/repo.git" → "repo"
 */
function repoNameFromUrl(url: string): string {
  return (
    url
      .split("/")
      .pop()
      ?.replace(/\.git$/, "") ?? "repo"
  );
}

/**
 * Enumerate all source files that match a FileSourceConfig's patterns,
 * WITHOUT reading their contents. Useful for auditing which files would
 * be indexed vs. which are actually present in the index.
 *
 * Returns a Set of relative paths (relative to the repo root for git
 * sources, or the resolved local path for local sources).
 */
export async function walkSourceFiles(
  sourceConfig: FileSourceConfig,
  cloneDir: string,
  _githubToken?: string,
): Promise<Set<string>> {
  // Determine repo root directory
  const repoDir = sourceConfig.repo
    ? path.join(cloneDir, repoNameFromUrl(sourceConfig.repo))
    : path.resolve(sourceConfig.path);

  // Determine walk starting point
  const walkRoot = sourceConfig.repo
    ? path.join(repoDir, sourceConfig.path)
    : repoDir;

  if (!fs.existsSync(walkRoot)) {
    return new Set();
  }

  const skipDirs = new Set([
    ...DEFAULT_SKIP_DIRS,
    ...(sourceConfig.skip_dirs ?? []),
  ]);
  const maxFileSize = sourceConfig.max_file_size ?? DEFAULT_MAX_FILE_SIZE;

  const result = new Set<string>();

  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (skipDirs.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.promises.stat(fullPath);
          if (stat.size > maxFileSize) continue;
        } catch {
          continue;
        }

        const relPath = path.relative(repoDir, fullPath);
        if (matchesPatterns(relPath, sourceConfig)) {
          result.add(relPath);
        }
      }
    }
  }

  await walk(walkRoot);
  return result;
}
