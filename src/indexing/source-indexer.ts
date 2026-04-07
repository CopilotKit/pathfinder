// Unified source indexer — handles any source type (markdown, code, raw-text)
// by delegating to the chunker registry and URL derivation config.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { simpleGit, type SimpleGit } from 'simple-git';
import { getChunker } from './chunking/index.js';
import { deriveUrl } from './url-derivation.js';
import { EmbeddingClient } from './embeddings.js';
import {
    upsertChunks,
    deleteChunksByFile,
} from '../db/queries.js';
import type { Chunk, ChunkOutput, SourceConfig } from '../types.js';

// Re-export shared utilities for backwards compatibility
export { hasLowSemanticValue, globToRegex, matchesPatterns } from './utils.js';
import { hasLowSemanticValue, globToRegex, matchesPatterns } from './utils.js';


const DEFAULT_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git']);
const DEFAULT_MAX_FILE_SIZE = 102400; // 100KB

/**
 * Extract a directory-friendly repo name from a clone URL.
 *   https://github.com/CopilotKit/CopilotKit.git  →  CopilotKit
 */
function repoNameFromUrl(repoUrl: string): string {
    const last = repoUrl.split('/').pop() ?? '';
    return last.replace(/\.git$/, '');
}

/**
 * Construct the authenticated (or plain) clone URL.
 */
function authenticatedUrl(repoUrl: string, githubToken?: string): string {
    if (githubToken) {
        return repoUrl.replace(
            'https://github.com/',
            `https://x-access-token:${githubToken}@github.com/`,
        );
    }
    return repoUrl;
}

export class SourceIndexer {
    private sourceConfig: SourceConfig;
    private embeddingClient: EmbeddingClient;
    private cloneDir: string;
    private githubToken?: string;

    private logPrefix: string;
    private skipDirs: Set<string>;
    private maxFileSize: number;

    constructor(
        sourceConfig: SourceConfig,
        embeddingClient: EmbeddingClient,
        cloneDir: string,
        githubToken?: string,
    ) {
        this.sourceConfig = sourceConfig;
        this.embeddingClient = embeddingClient;
        this.cloneDir = cloneDir;
        this.githubToken = githubToken;

        this.logPrefix = `[source-indexer:${sourceConfig.name}]`;
        this.skipDirs = new Set([...DEFAULT_SKIP_DIRS, ...(sourceConfig.skip_dirs ?? [])]);
        this.maxFileSize = sourceConfig.max_file_size ?? DEFAULT_MAX_FILE_SIZE;
    }

    private isLocal(): boolean {
        return !this.sourceConfig.repo;
    }

    /**
     * Full re-index: for git-backed sources, clone/pull the repo; for local
     * sources, read directly from the configured path. Then walk matching
     * files, chunk, embed, and upsert.
     */
    async fullIndex(): Promise<void> {
        let repoDir: string;
        let headSha: string;

        if (this.isLocal()) {
            repoDir = path.resolve(this.sourceConfig.path);
            if (!fs.existsSync(repoDir)) {
                throw new Error(`Local source path does not exist: ${repoDir}`);
            }
            headSha = await this.computeLocalSha(repoDir);
        } else {
            const repoName = repoNameFromUrl(this.sourceConfig.repo!);
            repoDir = path.join(this.cloneDir, repoName);
            const git = await this.ensureRepo(repoDir, repoName);
            headSha = await git.revparse(['HEAD']);
        }

        const walkRoot = this.isLocal()
            ? repoDir
            : path.join(repoDir, this.sourceConfig.path);

        if (!fs.existsSync(walkRoot)) {
            console.warn(`${this.logPrefix} Walk root not found at ${walkRoot}, skipping`);
            return;
        }

        const allFiles = await this.walkFiles(walkRoot);
        const matchingFiles = allFiles.filter((absPath) => {
            const relPath = path.relative(repoDir, absPath);
            return matchesPatterns(relPath, this.sourceConfig);
        });

        const skipped = allFiles.length - matchingFiles.length;
        console.log(
            `${this.logPrefix} Found ${matchingFiles.length} files for full index` +
            (skipped > 0 ? ` (${skipped} excluded by patterns)` : ''),
        );

        for (const absPath of matchingFiles) {
            const relPath = path.relative(repoDir, absPath);
            try {
                await this.indexFile(absPath, relPath, headSha);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`${this.logPrefix} Failed to index ${relPath}: ${msg}`);
            }
        }

        console.log(`${this.logPrefix} Full index complete (${matchingFiles.length} files)`);
    }

    /**
     * Incremental index: re-index only files changed since lastCommitSha.
     * Local sources always fall back to a full reindex.
     */
    async incrementalIndex(lastCommitSha: string): Promise<void> {
        if (this.isLocal()) {
            console.log(`${this.logPrefix} Local source — falling back to full reindex`);
            await this.fullIndex();
            return;
        }

        const repoName = repoNameFromUrl(this.sourceConfig.repo!);
        const repoDir = path.join(this.cloneDir, repoName);
        const git = await this.ensureRepo(repoDir, repoName);

        const headSha = await git.revparse(['HEAD']);

        if (headSha === lastCommitSha) {
            console.log(`${this.logPrefix} No new commits, skipping incremental index`);
            return;
        }

        // Unshallow the clone so git diff can see the old commit SHA
        try {
            await git.fetch(['--unshallow']);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes('unshallow') && !msg.includes('does not make sense')) {
                console.warn(`${this.logPrefix} git fetch --unshallow failed:`, msg);
            }
        }

        // Get list of changed files between last indexed commit and HEAD
        let diffOutput: string;
        try {
            diffOutput = await git.diff(['--name-only', `${lastCommitSha}..HEAD`]);
        } catch (err) {
            console.warn(`${this.logPrefix} git diff failed (shallow clone?), falling back to full reindex:`, err);
            await this.fullIndex();
            return;
        }

        const changedFiles = diffOutput
            .split('\n')
            .map((f) => f.trim())
            .filter((f) => f.length > 0);

        // Filter to files matching this source's patterns
        const matchingChanged = changedFiles.filter((f) =>
            matchesPatterns(f, this.sourceConfig),
        );

        if (matchingChanged.length === 0) {
            console.log(`${this.logPrefix} No matching changes detected, skipping`);
            return;
        }

        console.log(`${this.logPrefix} Incremental index: ${matchingChanged.length} changed files`);

        // Get deleted files via diff with status
        const diffStatusOutput = await git.diff([
            '--name-status',
            `${lastCommitSha}..HEAD`,
        ]);
        const deletedFiles = diffStatusOutput
            .split('\n')
            .filter((line) => line.startsWith('D\t'))
            .map((line) => line.slice(2).trim())
            .filter((f) => matchesPatterns(f, this.sourceConfig));

        // Delete chunks for removed files
        if (deletedFiles.length > 0) {
            console.log(`${this.logPrefix} Removing ${deletedFiles.length} deleted files from index`);
        }
        for (const relPath of deletedFiles) {
            await deleteChunksByFile(this.sourceConfig.name, relPath);
        }

        // Re-index changed (non-deleted) files
        const filesToIndex = matchingChanged.filter((f) => !deletedFiles.includes(f));
        for (const relPath of filesToIndex) {
            const absPath = path.join(repoDir, relPath);
            if (fs.existsSync(absPath)) {
                try {
                    const stat = await fs.promises.stat(absPath);
                    if (stat.size <= this.maxFileSize) {
                        await this.indexFile(absPath, relPath, headSha);
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                console.error(`${this.logPrefix} Failed to index ${relPath}: ${msg}`);
                }
            }
        }

        console.log(`${this.logPrefix} Incremental index complete`);
    }

    /**
     * Get the current HEAD SHA of the cloned repo.
     * For local sources, returns a deterministic hash based on the file
     * listing and modification times, so unchanged content produces the
     * same SHA across restarts.
     */
    async getHeadSha(): Promise<string> {
        if (this.isLocal()) {
            const walkRoot = path.resolve(this.sourceConfig.path);
            return this.computeLocalSha(walkRoot);
        }
        const repoName = repoNameFromUrl(this.sourceConfig.repo!);
        const repoDir = path.join(this.cloneDir, repoName);
        const git = simpleGit(repoDir);
        return git.revparse(['HEAD']);
    }

    /**
     * Compute a deterministic SHA for a local source directory based on
     * the sorted list of file paths and their modification times.
     * Note: uses mtimes, not file content — a fresh deploy with identical
     * files but new mtimes will produce a different SHA and trigger reindex.
     */
    private async computeLocalSha(walkRoot: string): Promise<string> {
        const files = await this.walkFiles(walkRoot);
        const hash = createHash('sha256');
        for (const f of files.sort()) {
            const stat = await fs.promises.stat(f);
            hash.update(`${f}:${stat.mtimeMs}\n`);
        }
        return `local-${hash.digest('hex').slice(0, 12)}`;
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    /**
     * Clone or pull the repo. Returns a SimpleGit instance pointed at the repo dir.
     */
    private async ensureRepo(repoDir: string, repoName: string): Promise<SimpleGit> {
        await fs.promises.mkdir(this.cloneDir, { recursive: true });

        const gitDir = path.join(repoDir, '.git');
        if (fs.existsSync(gitDir)) {
            console.log(`${this.logPrefix} Pulling latest changes for ${repoName}`);
            const git = simpleGit(repoDir);
            try {
                await git.pull();
                return git;
            } catch (err) {
                console.warn(`${this.logPrefix} Corrupted repo at ${repoDir}, re-cloning:`, err);
                await fs.promises.rm(repoDir, { recursive: true, force: true });
            }
        }

        const authUrl = authenticatedUrl(this.sourceConfig.repo!, this.githubToken);
        console.log(`${this.logPrefix} Cloning ${this.sourceConfig.repo!} into ${repoDir}`);
        const git = simpleGit(this.cloneDir);
        const cloneOpts = ['--depth=1'];
        if (this.sourceConfig.branch) {
            cloneOpts.push('--branch', this.sourceConfig.branch);
        }
        await git.clone(authUrl, repoName, cloneOpts);
        return simpleGit(repoDir);
    }

    /**
     * Recursively walk a directory for files, respecting skip_dirs and max_file_size.
     */
    private async walkFiles(dir: string): Promise<string[]> {
        const results: string[] = [];

        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch (err) {
            console.warn(`${this.logPrefix} Unable to read directory ${dir}:`, err);
            return results;
        }

        for (const entry of entries) {
            if (this.skipDirs.has(entry.name)) continue;

            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                const nested = await this.walkFiles(fullPath);
                results.push(...nested);
            } else if (entry.isFile()) {
                // Skip files larger than max_file_size
                try {
                    const stat = await fs.promises.stat(fullPath);
                    if (stat.size > this.maxFileSize) continue;
                } catch (err) {
                    console.warn(`${this.logPrefix} Unable to stat ${fullPath}:`, err);
                    continue;
                }

                results.push(fullPath);
            }
        }

        return results;
    }

    /**
     * Read, chunk, embed, and upsert a single file.
     */
    private async indexFile(
        absPath: string,
        relPath: string,
        commitSha: string,
    ): Promise<void> {
        const content = await fs.promises.readFile(absPath, 'utf-8');

        if (hasLowSemanticValue(content)) {
            return;
        }

        const chunker = getChunker(this.sourceConfig.type);
        const chunkOutputs: ChunkOutput[] = chunker(content, relPath, this.sourceConfig);

        if (chunkOutputs.length === 0) {
            return;
        }

        const texts = chunkOutputs.map((c) => c.content);
        const embeddings = await this.embeddingClient.embedBatch(texts);
        const sourceUrl = deriveUrl(relPath, this.sourceConfig);

        const chunks: Chunk[] = chunkOutputs.map((chunk, i) => ({
            source_name: this.sourceConfig.name,
            source_url: sourceUrl,
            title: chunk.title ?? null,
            content: chunk.content,
            embedding: embeddings[i],
            repo_url: this.sourceConfig.repo ?? null,
            file_path: relPath,
            start_line: chunk.startLine ?? null,
            end_line: chunk.endLine ?? null,
            language: chunk.language ?? null,
            chunk_index: chunk.chunkIndex,
            metadata: chunk.headingPath ? { headingPath: chunk.headingPath } : {},
            commit_sha: commitSha,
            version: this.sourceConfig.version ?? null,
        }));

        // Delete existing chunks for this file first to remove stale entries
        // (e.g., file shortened from 5 chunks to 3 — old chunks 3-4 would persist)
        await deleteChunksByFile(this.sourceConfig.name, relPath);
        await upsertChunks(chunks);
    }
}
