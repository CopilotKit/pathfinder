// FileDataProvider — git-backed and local file data acquisition.
// Handles clone/pull, file walking, pattern matching, content reading.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { simpleGit, type SimpleGit } from "simple-git";
import { matchesPatterns, hasLowSemanticValue } from "../utils.js";
import { extractContent } from "../content-extractors.js";
import { getIndexedItemIds } from "../../db/queries.js";
import { isFileSourceConfig } from "../../types.js";
import type { SourceConfig, FileSourceConfig } from "../../types.js";
import type {
  DataProvider,
  AcquisitionResult,
  ContentItem,
  ProviderOptions,
} from "./types.js";

const DEFAULT_SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git"]);
const DEFAULT_MAX_FILE_SIZE = 102400; // 100KB
const DEFAULT_DOCUMENT_MAX_FILE_SIZE = 10485760; // 10MB

function repoNameFromUrl(repoUrl: string): string {
  const last = repoUrl.split("/").pop() ?? "";
  return last.replace(/\.git$/, "");
}

function authenticatedUrl(repoUrl: string, githubToken?: string): string {
  if (githubToken) {
    return repoUrl.replace(
      "https://github.com/",
      `https://x-access-token:${githubToken}@github.com/`,
    );
  }
  return repoUrl;
}

/**
 * Build the per-file contribution to a local source's state token.
 *
 * The token folds path + mtime + size together so that change detection
 * triggers a re-index when *either* mtime *or* size changes. Including size
 * (in addition to mtime) catches content edits that preserve mtime — e.g.
 * `cp -p`, some `git checkout`/restore, and `rsync --times` — which an
 * mtime-only token would silently miss, leaving stale content indexed.
 *
 * Remaining limitation: a content change that preserves *both* mtime *and*
 * size (an in-place edit of equal length) is still undetected by this token.
 * Hashing file content would close that gap but would require reading every
 * file on each scan; size is the minimal correct improvement that avoids that
 * cost.
 */
export function localFileHashInput(
  relPath: string,
  mtimeMs: number,
  size: number,
): string {
  return `${relPath}:${mtimeMs}:${size}\n`;
}

export class FileDataProvider implements DataProvider {
  private config: FileSourceConfig;
  private options: ProviderOptions;
  private logPrefix: string;
  private skipDirs: Set<string>;
  private maxFileSize: number;

  constructor(config: SourceConfig, options: ProviderOptions) {
    if (!isFileSourceConfig(config)) {
      throw new Error(
        `FileDataProvider cannot handle ${(config as { type: string }).type} source type`,
      );
    }
    this.config = config;
    this.options = options;
    this.logPrefix = `[file-provider:${config.name}]`;
    this.skipDirs = new Set([
      ...DEFAULT_SKIP_DIRS,
      ...(config.skip_dirs ?? []),
    ]);
    this.maxFileSize =
      config.max_file_size ??
      (config.type === "document"
        ? DEFAULT_DOCUMENT_MAX_FILE_SIZE
        : DEFAULT_MAX_FILE_SIZE);
  }

  private isLocal(): boolean {
    return !this.config.repo;
  }

  async fullAcquire(): Promise<AcquisitionResult> {
    let repoDir: string;
    let stateToken: string;

    if (this.isLocal()) {
      repoDir = path.resolve(this.config.path);
      if (!fs.existsSync(repoDir)) {
        throw new Error(`Local source path does not exist: ${repoDir}`);
      }
      stateToken = await this.computeLocalSha(repoDir);
    } else {
      const repoName = repoNameFromUrl(this.config.repo!);
      repoDir = path.join(this.options.cloneDir, repoName);
      const git = await this.ensureRepo(repoDir, repoName);
      stateToken = await git.revparse(["HEAD"]);
    }

    const walkRoot = this.isLocal()
      ? repoDir
      : path.join(repoDir, this.config.path);

    if (!fs.existsSync(walkRoot)) {
      console.warn(
        `${this.logPrefix} Walk root not found at ${walkRoot}, skipping`,
      );
      let removedIds: string[] = [];
      try {
        const indexedPaths = await getIndexedItemIds(this.config.name);
        removedIds = [...indexedPaths];
        if (removedIds.length > 0) {
          console.log(
            `${this.logPrefix} Walk root missing: ${removedIds.length} stale files to remove from index`,
          );
        }
      } catch (err) {
        console.warn(
          `${this.logPrefix} Failed to check for stale files:`,
          err instanceof Error ? err.message : err,
        );
      }
      return { items: [], removedIds, stateToken };
    }

    const allFiles = await this.walkFiles(walkRoot);
    const matchingFiles = allFiles.filter((absPath) => {
      const relPath = path.relative(repoDir, absPath);
      return matchesPatterns(relPath, this.config);
    });

    const skipped = allFiles.length - matchingFiles.length;
    console.log(
      `${this.logPrefix} Found ${matchingFiles.length} files for full acquire` +
        (skipped > 0 ? ` (${skipped} excluded by patterns)` : ""),
    );

    const items: ContentItem[] = [];
    for (const absPath of matchingFiles) {
      const relPath = path.relative(repoDir, absPath);
      try {
        const { content, metadata } = await extractContent(
          absPath,
          this.config.type,
        );
        if (hasLowSemanticValue(content)) continue;
        items.push({ id: relPath, absolutePath: absPath, content, metadata });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${this.logPrefix} Failed to read ${relPath}: ${msg}`);
      }
    }

    // Detect stale files: paths in the DB but no longer on disk.
    // Use matchingFiles (disk presence) rather than items (post-extraction)
    // so files that exist but fail extraction aren't falsely flagged as stale.
    const currentPaths = new Set(
      matchingFiles.map((absPath) => path.relative(repoDir, absPath)),
    );

    let removedIds: string[] = [];
    try {
      const indexedPaths = await getIndexedItemIds(this.config.name);
      removedIds = [...indexedPaths].filter((p) => !currentPaths.has(p));
      if (removedIds.length > 0) {
        console.log(
          `${this.logPrefix} Full acquire: ${removedIds.length} stale files to remove from index`,
        );
      }
    } catch (err) {
      console.warn(
        `${this.logPrefix} Failed to check for stale files, skipping cleanup:`,
        err instanceof Error ? err.message : err,
      );
    }

    return { items, removedIds, stateToken };
  }

  async incrementalAcquire(lastStateToken: string): Promise<AcquisitionResult> {
    if (this.isLocal()) {
      console.log(
        `${this.logPrefix} Local source — falling back to full acquire`,
      );
      return this.fullAcquire();
    }

    const repoName = repoNameFromUrl(this.config.repo!);
    const repoDir = path.join(this.options.cloneDir, repoName);
    const git = await this.ensureRepo(repoDir, repoName);
    const headSha = await git.revparse(["HEAD"]);

    if (headSha === lastStateToken) {
      console.log(`${this.logPrefix} No new commits, skipping`);
      return { items: [], removedIds: [], stateToken: headSha };
    }

    // Unshallow for diff
    try {
      await git.fetch(["--unshallow"]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("unshallow") && !msg.includes("does not make sense")) {
        console.warn(`${this.logPrefix} git fetch --unshallow failed:`, msg);
      }
    }

    let diffOutput: string;
    try {
      diffOutput = await git.diff(["--name-only", `${lastStateToken}..HEAD`]);
    } catch (err) {
      console.warn(
        `${this.logPrefix} git diff failed, falling back to full acquire:`,
        err,
      );
      return this.fullAcquire();
    }

    const changedFiles = diffOutput
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
    // Treat "." (and "") as "no prefix": a repo-root source walks from the
    // repo root, and git-diff paths are repo-root-relative with NO leading
    // "./". Deriving a "./" prefix from the truthy "." would filter out EVERY
    // changed/deleted/renamed path, silently indexing nothing while advancing
    // the state token. Mirrors the `path !== "."` guard in reindex-audit.ts.
    const normPath =
      this.config.path && this.config.path !== "." ? this.config.path : "";
    const pathPrefix = normPath ? normPath.replace(/\/$/, "") + "/" : "";
    const scopedChanged = pathPrefix
      ? changedFiles.filter((f) => f.startsWith(pathPrefix))
      : changedFiles;
    const matchingChanged = scopedChanged
      .filter((f) => !f.split("/").some((seg) => this.skipDirs.has(seg)))
      .filter((f) => matchesPatterns(f, this.config));

    // Find deleted/renamed files. This MUST run even when matchingChanged is
    // empty: a commit whose only matching-relevant change is a rename of a
    // MATCHED file to a NON-matched extension (e.g. `docs/a.md` → `docs/b.txt`)
    // produces an empty `--name-only` match set (only the non-matching new path
    // is listed) yet still removes `docs/a.md` from the index. Detecting
    // removals before the no-matching-changes short-circuit upholds the "never
    // silently advance the state token past a removal" guarantee below.
    let removedFiles: string[] = [];
    try {
      const diffStatusOutput = await git.diff([
        "--name-status",
        `${lastStateToken}..HEAD`,
      ]);
      const statusLines = diffStatusOutput.split("\n");
      const deletedFiles = statusLines
        .filter((line) => line.startsWith("D\t"))
        .map((line) => line.slice(2).trim())
        .filter((f) => !pathPrefix || f.startsWith(pathPrefix))
        .filter((f) => !f.split("/").some((seg) => this.skipDirs.has(seg)))
        .filter((f) => matchesPatterns(f, this.config));
      const renamedOldPaths = statusLines
        .filter((line) => /^R\d*\t/.test(line))
        .map((line) => {
          const parts = line.split("\t");
          return parts[1]?.trim();
        })
        .filter((f): f is string => !!f)
        .filter((f) => !pathPrefix || f.startsWith(pathPrefix))
        .filter((f) => !f.split("/").some((seg) => this.skipDirs.has(seg)))
        .filter((f) => matchesPatterns(f, this.config));
      removedFiles = [...deletedFiles, ...renamedOldPaths];
    } catch (err) {
      // Deletion detection failed. Do NOT swallow it as `removedFiles = []`:
      // the changed-files diff already succeeded, so the caller would advance
      // the state token while silently leaving stale/deleted docs in the index
      // forever (a transient git error masquerading as "no deletions"). Throw
      // so the orchestrator marks the run errored and holds the prior token —
      // the next incremental run re-diffs from the same point and re-detects
      // the deletions. (The changed-files diff failing earlier legitimately
      // falls back to fullAcquire, which does its own DB-vs-disk deletion
      // detection; this branch is specifically the case where we KNOW there
      // were changes but can't tell which were deletions.)
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `${this.logPrefix} git diff --name-status (deletion detection) failed:`,
        err,
      );
      throw new Error(`${this.logPrefix} deletion detection failed: ${msg}`);
    }

    if (matchingChanged.length === 0) {
      // Genuine no-op only when there is also nothing to remove. When a rename
      // out of the matched set leaves removals (removedFiles.length > 0), we
      // must still process those deletions while advancing the token, rather
      // than short-circuiting with removedIds: [] (which would strand the
      // renamed-away file's chunks in the index forever).
      if (removedFiles.length === 0) {
        console.log(`${this.logPrefix} No matching changes detected`);
        return { items: [], removedIds: [], stateToken: headSha };
      }
      return { items: [], removedIds: removedFiles, stateToken: headSha };
    }

    console.log(
      `${this.logPrefix} Incremental acquire: ${matchingChanged.length} changed files`,
    );

    // Read changed (non-deleted) files
    const filesToRead = matchingChanged.filter(
      (f) => !removedFiles.includes(f),
    );
    const items: ContentItem[] = [];
    // Files that should legitimately leave the index: size-exceeded and
    // low-semantic-value content no longer belongs in the index, so it is safe
    // (and correct) to fold these into removedIds.
    const removedForContent: string[] = [];
    // Read/extraction FAILURES on files that still exist on disk. These must NOT
    // be deleted and must NOT let the state token advance over them — a
    // transient EACCES/EIO/ENOMEM or an extractor parse error is not an
    // intentional removal. Mirror the deletion-detection precedent above: throw
    // after the loop so the orchestrator marks the run errored and holds the
    // prior token, and the next incremental run re-diffs and retries the file.
    // (Asymmetric-by-design with fullAcquire, which computes stale files from
    // disk presence rather than post-extraction items for the same reason.)
    const readFailures: string[] = [];
    for (const relPath of filesToRead) {
      const absPath = path.join(repoDir, relPath);
      if (!fs.existsSync(absPath)) continue;
      try {
        const stat = await fs.promises.stat(absPath);
        if (stat.size > this.maxFileSize) {
          removedForContent.push(relPath);
          continue;
        }
        const { content, metadata } = await extractContent(
          absPath,
          this.config.type,
        );
        if (hasLowSemanticValue(content)) {
          removedForContent.push(relPath);
          continue;
        }
        items.push({ id: relPath, absolutePath: absPath, content, metadata });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${this.logPrefix} Failed to read ${relPath}: ${msg}`);
        readFailures.push(relPath);
      }
    }

    if (readFailures.length > 0) {
      // Do NOT delete these files' chunks and do NOT advance the token: the
      // files still exist on disk and only failed to read/extract this run. A
      // later incremental diff won't re-list an unchanged file, so deleting now
      // would permanently lose their chunks. Throw to hold the prior token for
      // retry (matches the deletion-detection branch above).
      throw new Error(
        `${this.logPrefix} read/extraction failed for ${readFailures.length} changed file(s); holding state token for retry: ${readFailures.join(", ")}`,
      );
    }

    return {
      items,
      removedIds: [...removedFiles, ...removedForContent],
      stateToken: headSha,
    };
  }

  async getCurrentStateToken(): Promise<string | null> {
    if (this.isLocal()) {
      const walkRoot = path.resolve(this.config.path);
      if (!fs.existsSync(walkRoot)) return null;
      return this.computeLocalSha(walkRoot);
    }

    // For git sources: try ls-remote first (no clone needed)
    try {
      let url = this.config.repo!;
      if (this.options.githubToken) {
        url = authenticatedUrl(url, this.options.githubToken);
      }
      const git = simpleGit();
      const result = await git.listRemote([url, "HEAD"]);
      const sha = result.split("\t")[0]?.trim();
      return sha || null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `${this.logPrefix} ls-remote failed for ${this.config.repo}: ${msg}`,
      );
      // Fall back to local HEAD if clone dir exists
      const repoName = repoNameFromUrl(this.config.repo!);
      const repoDir = path.join(this.options.cloneDir, repoName);
      if (!fs.existsSync(repoDir)) return null;
      try {
        const git = simpleGit(repoDir);
        return await git.revparse(["HEAD"]);
      } catch (innerErr) {
        const innerMsg =
          innerErr instanceof Error ? innerErr.message : String(innerErr);
        console.warn(
          `${this.logPrefix} local HEAD lookup also failed for ${repoDir}: ${innerMsg}`,
        );
        return null;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async ensureRepo(
    repoDir: string,
    repoName: string,
  ): Promise<SimpleGit> {
    await fs.promises.mkdir(this.options.cloneDir, { recursive: true });

    const gitDir = path.join(repoDir, ".git");
    if (fs.existsSync(gitDir)) {
      console.log(`${this.logPrefix} Pulling latest changes for ${repoName}`);
      const git = simpleGit(repoDir);
      try {
        await git.pull();
        return git;
      } catch (pullErr) {
        const msg =
          pullErr instanceof Error ? pullErr.message : String(pullErr);
        console.warn(
          `${this.logPrefix} Pull failed at ${repoDir}, re-cloning:`,
          msg,
        );
        await fs.promises.rm(repoDir, { recursive: true, force: true });
      }
    }

    const authUrl = authenticatedUrl(
      this.config.repo!,
      this.options.githubToken,
    );
    console.log(
      `${this.logPrefix} Cloning ${this.config.repo!} into ${repoDir}`,
    );
    const git = simpleGit(this.options.cloneDir);
    const cloneOpts = ["--depth=1"];
    if (this.config.branch) {
      cloneOpts.push("--branch", this.config.branch);
    }
    await git.clone(authUrl, repoName, cloneOpts);
    return simpleGit(repoDir);
  }

  private async walkFiles(dir: string): Promise<string[]> {
    const results: string[] = [];

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      console.warn(
        `${this.logPrefix} Unable to read directory ${dir}:`,
        err instanceof Error ? err.message : err,
      );
      return results;
    }

    for (const entry of entries) {
      if (this.skipDirs.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        const nested = await this.walkFiles(fullPath);
        results.push(...nested);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.promises.stat(fullPath);
          if (stat.size > this.maxFileSize) continue;
        } catch (err) {
          console.warn(
            `${this.logPrefix} Unable to stat ${fullPath}:`,
            err instanceof Error ? err.message : err,
          );
          continue;
        }
        results.push(fullPath);
      }
    }

    return results;
  }

  private async computeLocalSha(walkRoot: string): Promise<string> {
    const files = await this.walkFiles(walkRoot);
    const hash = createHash("sha256");
    for (const f of files.sort()) {
      try {
        const stat = await fs.promises.stat(f);
        // Fold path + mtime + size so a re-index triggers when either mtime
        // or size changes. Including size catches mtime-preserving edits
        // (cp -p, git checkout/restore, rsync --times); a same-mtime,
        // same-size edit is the remaining undetected case. See
        // localFileHashInput for the full rationale.
        hash.update(
          localFileHashInput(
            path.relative(walkRoot, f),
            stat.mtimeMs,
            stat.size,
          ),
        );
      } catch (err) {
        // ENOENT is the documented delete-after-walk race (the file vanished
        // between walkFiles and this stat) — skip it silently. Any other error
        // (EACCES, EIO, …) is a systemic stat failure that would silently skew
        // the change-detection hash, so surface it via console.warn rather than
        // swallowing it blind.
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "ENOENT") {
          console.warn(
            `${this.logPrefix} Unable to stat ${f} while hashing:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
    return `local-${hash.digest("hex").slice(0, 12)}`;
  }
}
