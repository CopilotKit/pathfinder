// Code indexing pipeline — clones repos, chunks source files, embeds, upserts

import fs from 'node:fs';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { chunkCode } from './chunking/code.js';
import { EmbeddingClient } from './embeddings.js';
import {
    upsertCodeChunks,
    deleteCodeChunksByFile,
    type CodeChunk,
} from '../db/queries.js';
import { INDEXED_REPOS } from '../constants.js';
import { shouldIndex } from './path-filter.js';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git']);
const MAX_FILE_SIZE = 100 * 1024; // 100KB

/**
 * Extract a directory-friendly repo name from a clone URL.
 *   https://github.com/CopilotKit/with-mastra.git  →  with-mastra
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

/**
 * Recursively walk a directory for indexable source files.
 */
async function walkSourceFiles(dir: string): Promise<string[]> {
    const results: string[] = [];

    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
        console.warn(`[code-indexer] Unable to read directory ${dir}:`, err);
        return results;
    }

    for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            const nested = await walkSourceFiles(fullPath);
            results.push(...nested);
        } else if (entry.isFile()) {
            const ext = path.extname(entry.name);
            if (!SOURCE_EXTENSIONS.has(ext)) continue;
            if (entry.name.endsWith('.min.js')) continue;
            if (entry.name.endsWith('.lock')) continue;

            // Skip files larger than 100KB (likely generated)
            try {
                const stat = await fs.promises.stat(fullPath);
                if (stat.size > MAX_FILE_SIZE) continue;
            } catch (err) {
                console.warn(`[code-indexer] Unable to stat ${fullPath}:`, err);
                continue;
            }

            results.push(fullPath);
        }
    }

    return results;
}

export class CodeIndexer {
    private embeddingClient: EmbeddingClient;
    private cloneDir: string;
    private githubToken?: string;

    constructor(embeddingClient: EmbeddingClient, cloneDir: string, githubToken?: string) {
        this.embeddingClient = embeddingClient;
        this.cloneDir = cloneDir;
        this.githubToken = githubToken;
    }

    /**
     * Full re-index of a single repo.
     */
    async indexRepo(repoUrl: string): Promise<void> {
        const repoName = repoNameFromUrl(repoUrl);
        const repoDir = path.join(this.cloneDir, repoName);
        const git = await this.ensureRepo(repoUrl, repoDir, repoName);

        const headSha = await git.revparse(['HEAD']);
        const allFiles = await walkSourceFiles(repoDir);

        // Apply path filters from index-config.json
        const sourceFiles = allFiles.filter((absPath) => {
            const relPath = path.relative(repoDir, absPath);
            return shouldIndex(relPath, 'code');
        });

        const skipped = allFiles.length - sourceFiles.length;
        console.log(
            `[code-indexer] Indexing ${repoName}: ${sourceFiles.length} source files` +
            (skipped > 0 ? ` (${skipped} excluded by path filters)` : ''),
        );

        for (const absPath of sourceFiles) {
            const relPath = path.relative(repoDir, absPath);
            try {
                await this.indexFile(absPath, relPath, repoUrl, headSha);
            } catch (err) {
                console.error(`[code-indexer] Failed to index ${relPath}:`, err);
            }
        }

        console.log(`[code-indexer] ${repoName} full index complete`);
    }

    /**
     * Full re-index of all repos (sequentially to avoid memory issues).
     */
    async fullIndex(): Promise<void> {
        console.log(
            `[code-indexer] Starting full index of ${INDEXED_REPOS.length} repos`,
        );

        for (const repoUrl of INDEXED_REPOS) {
            try {
                await this.indexRepo(repoUrl);
            } catch (err) {
                console.error(
                    `[code-indexer] Failed to index ${repoUrl}:`,
                    err,
                );
                // Continue with remaining repos
            }
        }

        console.log('[code-indexer] Full index of all repos complete');
    }

    /**
     * Incremental index for a single repo — re-index changed files since lastCommitSha.
     */
    async incrementalIndex(
        repoUrl: string,
        lastCommitSha: string,
    ): Promise<void> {
        const repoName = repoNameFromUrl(repoUrl);
        const repoDir = path.join(this.cloneDir, repoName);
        const git = await this.ensureRepo(repoUrl, repoDir, repoName);

        const headSha = await git.revparse(['HEAD']);

        if (headSha === lastCommitSha) {
            console.log(
                `[code-indexer] ${repoName}: no new commits, skipping`,
            );
            return;
        }

        // Unshallow the clone so git diff can see the old commit SHA
        try {
            await git.fetch(['--unshallow']);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes('unshallow') && !msg.includes('does not make sense')) {
                console.warn(`[code-indexer] git fetch --unshallow failed:`, msg);
            }
        }

        let diffOutput: string;
        try {
            diffOutput = await git.diff([
                '--name-only',
                `${lastCommitSha}..HEAD`,
            ]);
        } catch (err) {
            console.warn(`[code-indexer] git diff failed (shallow clone?), falling back to full reindex:`, err);
            await this.indexRepo(repoUrl);
            return;
        }
        const changedFiles = diffOutput
            .split('\n')
            .map((f) => f.trim())
            .filter((f) => f.length > 0);

        // Filter to indexable source files
        const sourceChanged = changedFiles.filter((f) => {
            const ext = path.extname(f);
            return SOURCE_EXTENSIONS.has(ext) && !f.endsWith('.min.js');
        });

        if (sourceChanged.length === 0) {
            console.log(
                `[code-indexer] ${repoName}: no source changes, skipping`,
            );
            return;
        }

        console.log(
            `[code-indexer] ${repoName}: incremental index of ${sourceChanged.length} files`,
        );

        // Get deleted files
        const diffStatusOutput = await git.diff([
            '--name-status',
            `${lastCommitSha}..HEAD`,
        ]);
        const deletedFiles = diffStatusOutput
            .split('\n')
            .filter((line) => line.startsWith('D\t'))
            .map((line) => line.slice(2).trim());

        // Delete chunks for removed files
        for (const relPath of deletedFiles) {
            const ext = path.extname(relPath);
            if (SOURCE_EXTENSIONS.has(ext)) {
                console.log(
                    `[code-indexer] Deleting chunks for removed file: ${relPath}`,
                );
                await deleteCodeChunksByFile(repoUrl, relPath);
            }
        }

        // Re-index changed (non-deleted) files
        const filesToIndex = sourceChanged.filter(
            (f) => !deletedFiles.includes(f),
        );
        for (const relPath of filesToIndex) {
            const absPath = path.join(repoDir, relPath);
            if (fs.existsSync(absPath)) {
                try {
                    const stat = await fs.promises.stat(absPath);
                    if (stat.size <= MAX_FILE_SIZE) {
                        await this.indexFile(absPath, relPath, repoUrl, headSha);
                    }
                } catch (err) {
                    console.error(`[code-indexer] Failed to process ${relPath}:`, err);
                }
            }
        }

        console.log(`[code-indexer] ${repoName} incremental index complete`);
    }

    /**
     * Get the current HEAD SHA for a repo.
     */
    async getHeadSha(repoUrl: string): Promise<string> {
        const repoName = repoNameFromUrl(repoUrl);
        const repoDir = path.join(this.cloneDir, repoName);
        const git = simpleGit(repoDir);
        return git.revparse(['HEAD']);
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    /**
     * Clone or pull the repo. Returns a SimpleGit instance pointed at the repo dir.
     */
    private async ensureRepo(
        repoUrl: string,
        repoDir: string,
        repoName: string,
    ): Promise<SimpleGit> {
        await fs.promises.mkdir(this.cloneDir, { recursive: true });

        if (fs.existsSync(path.join(repoDir, '.git'))) {
            console.log(`[code-indexer] Pulling latest changes for ${repoName}`);
            const git = simpleGit(repoDir);
            await git.pull();
            return git;
        }

        console.log(`[code-indexer] Cloning ${repoUrl} into ${repoDir}`);
        const git = simpleGit(this.cloneDir);
        await git.clone(authenticatedUrl(repoUrl, this.githubToken), repoName, [
            '--depth=1',
        ]);
        return simpleGit(repoDir);
    }

    /**
     * Read, chunk, embed, and upsert a single source file.
     */
    private async indexFile(
        absPath: string,
        relPath: string,
        repoUrl: string,
        commitSha: string,
    ): Promise<void> {
        const content = await fs.promises.readFile(absPath, 'utf-8');
        const codeChunks = chunkCode(content, relPath);

        if (codeChunks.length === 0) {
            return;
        }

        const texts = codeChunks.map((c) => c.content);
        const embeddings = await this.embeddingClient.embedBatch(texts);

        const dbChunks: CodeChunk[] = codeChunks.map((chunk, i) => ({
            repo_url: repoUrl,
            file_path: relPath,
            content: chunk.content,
            embedding: embeddings[i],
            start_line: chunk.startLine,
            end_line: chunk.endLine,
            language: chunk.language,
            chunk_index: chunk.chunkIndex,
            metadata: {},
            commit_sha: commitSha,
        }));

        await upsertCodeChunks(dbChunks);
        console.log(
            `[code-indexer] Indexed ${relPath} (${dbChunks.length} chunks)`,
        );
    }
}
