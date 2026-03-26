// Docs indexing pipeline — clones CopilotKit repo, chunks MDX files, embeds, upserts

import fs from 'node:fs';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { chunkMarkdown } from './chunking/markdown.js';
import { EmbeddingClient } from './embeddings.js';
import {
    upsertDocChunks,
    deleteDocChunksByFile,
    type DocChunk,
} from '../db/queries.js';

const DOCS_REPO_URL = 'https://github.com/CopilotKit/CopilotKit.git';
const DOCS_CONTENT_PREFIX = 'docs/content/docs/';

/**
 * Derive a public docs URL from a file path inside the cloned repo.
 *
 * Example:
 *   docs/content/docs/(root)/quickstart.mdx  →  https://docs.copilotkit.ai/quickstart
 *   docs/content/docs/coagents/overview.mdx   →  https://docs.copilotkit.ai/coagents/overview
 */
function filePathToSourceUrl(filePath: string): string {
    // filePath is relative to repo root, e.g. docs/content/docs/(root)/quickstart.mdx
    let slug = filePath.slice(DOCS_CONTENT_PREFIX.length);

    // Strip .mdx extension
    slug = slug.replace(/\.mdx$/, '');

    // Strip parenthesised route groups like (root)
    slug = slug.replace(/\([^)]+\)\//g, '');

    // Remove /index suffix — directory index pages map to the directory URL
    slug = slug.replace(/\/index$/, '');

    return `https://docs.copilotkit.ai/${slug}`;
}

/**
 * Construct the authenticated (or plain) clone URL.
 */
function cloneUrl(githubToken?: string): string {
    if (githubToken) {
        return `https://x-access-token:${githubToken}@github.com/CopilotKit/CopilotKit.git`;
    }
    return DOCS_REPO_URL;
}

/**
 * Recursively walk a directory for files matching a predicate.
 */
async function walkFiles(
    dir: string,
    predicate: (filePath: string) => boolean,
): Promise<string[]> {
    const results: string[] = [];

    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
        console.warn(`[docs-indexer] Unable to read directory ${dir}:`, err);
        return results;
    }
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const nested = await walkFiles(fullPath, predicate);
            results.push(...nested);
        } else if (entry.isFile() && predicate(fullPath)) {
            results.push(fullPath);
        }
    }

    return results;
}

export class DocsIndexer {
    private embeddingClient: EmbeddingClient;
    private cloneDir: string;
    private githubToken?: string;

    constructor(embeddingClient: EmbeddingClient, cloneDir: string, githubToken?: string) {
        this.embeddingClient = embeddingClient;
        this.cloneDir = cloneDir;
        this.githubToken = githubToken;
    }

    /**
     * Full re-index: clone/pull the repo, walk all MDX files, chunk, embed, upsert.
     */
    async fullIndex(): Promise<void> {
        const repoDir = path.join(this.cloneDir, 'CopilotKit');
        const git = await this.ensureRepo(repoDir);

        const headSha = await git.revparse(['HEAD']);
        const docsDir = path.join(repoDir, DOCS_CONTENT_PREFIX);

        if (!fs.existsSync(docsDir)) {
            console.warn(`Docs directory not found at ${docsDir}, skipping docs indexing`);
            return;
        }

        const mdxFiles = await walkFiles(docsDir, (f) => f.endsWith('.mdx'));
        console.log(`[docs-indexer] Found ${mdxFiles.length} MDX files for full index`);

        for (const absPath of mdxFiles) {
            const relPath = path.relative(repoDir, absPath);
            try {
                await this.indexFile(absPath, relPath, headSha);
            } catch (err) {
                console.error(`[docs-indexer] Failed to index ${relPath}:`, err);
            }
        }

        console.log(`[docs-indexer] Full index complete (${mdxFiles.length} files)`);
    }

    /**
     * Incremental index: re-index only files changed since lastCommitSha.
     */
    async incrementalIndex(lastCommitSha: string): Promise<void> {
        const repoDir = path.join(this.cloneDir, 'CopilotKit');
        const git = await this.ensureRepo(repoDir);

        const headSha = await git.revparse(['HEAD']);

        if (headSha === lastCommitSha) {
            console.log('[docs-indexer] No new commits, skipping incremental index');
            return;
        }

        // Unshallow the clone so git diff can see the old commit SHA
        try {
            await git.fetch(['--unshallow']);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes('unshallow') && !msg.includes('does not make sense')) {
                console.warn(`[docs-indexer] git fetch --unshallow failed:`, msg);
            }
        }

        // Get list of changed files between last indexed commit and HEAD
        let diffOutput: string;
        try {
            diffOutput = await git.diff(['--name-only', `${lastCommitSha}..HEAD`]);
        } catch (err) {
            console.warn(`[docs-indexer] git diff failed (shallow clone?), falling back to full reindex:`, err);
            await this.fullIndex();
            return;
        }
        const changedFiles = diffOutput
            .split('\n')
            .map((f) => f.trim())
            .filter((f) => f.length > 0);

        // Filter to only MDX files under the docs content path
        const mdxChanged = changedFiles.filter(
            (f) => f.startsWith(DOCS_CONTENT_PREFIX) && f.endsWith('.mdx'),
        );

        if (mdxChanged.length === 0) {
            console.log('[docs-indexer] No docs changes detected, skipping');
            return;
        }

        console.log(`[docs-indexer] Incremental index: ${mdxChanged.length} changed files`);

        // Also get deleted files via diff with status
        const diffStatusOutput = await git.diff([
            '--name-status',
            `${lastCommitSha}..HEAD`,
        ]);
        const deletedFiles = diffStatusOutput
            .split('\n')
            .filter((line) => line.startsWith('D\t'))
            .map((line) => line.slice(2).trim())
            .filter((f) => f.startsWith(DOCS_CONTENT_PREFIX) && f.endsWith('.mdx'));

        // Delete chunks for removed files
        for (const relPath of deletedFiles) {
            console.log(`[docs-indexer] Deleting chunks for removed file: ${relPath}`);
            await deleteDocChunksByFile(relPath);
        }

        // Re-index changed (non-deleted) files
        const filesToIndex = mdxChanged.filter((f) => !deletedFiles.includes(f));
        for (const relPath of filesToIndex) {
            const absPath = path.join(repoDir, relPath);
            if (fs.existsSync(absPath)) {
                try {
                    await this.indexFile(absPath, relPath, headSha);
                } catch (err) {
                    console.error(`[docs-indexer] Failed to index ${relPath}:`, err);
                }
            }
        }

        console.log(`[docs-indexer] Incremental index complete`);
    }

    /**
     * Get the current HEAD SHA of the cloned repo.
     */
    async getHeadSha(): Promise<string> {
        const repoDir = path.join(this.cloneDir, 'CopilotKit');
        const git = simpleGit(repoDir);
        return git.revparse(['HEAD']);
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    /**
     * Clone or pull the repo. Returns a SimpleGit instance pointed at the repo dir.
     */
    private async ensureRepo(repoDir: string): Promise<SimpleGit> {
        await fs.promises.mkdir(this.cloneDir, { recursive: true });

        if (fs.existsSync(path.join(repoDir, '.git'))) {
            console.log(`[docs-indexer] Pulling latest changes in ${repoDir}`);
            const git = simpleGit(repoDir);
            await git.pull();
            return git;
        }

        console.log(`[docs-indexer] Cloning ${DOCS_REPO_URL} into ${repoDir}`);
        const git = simpleGit(this.cloneDir);
        await git.clone(cloneUrl(this.githubToken), 'CopilotKit', [
            '--depth=1',
        ]);
        return simpleGit(repoDir);
    }

    /**
     * Read, chunk, embed, and upsert a single MDX file.
     */
    private async indexFile(
        absPath: string,
        relPath: string,
        commitSha: string,
    ): Promise<void> {
        const content = await fs.promises.readFile(absPath, 'utf-8');
        const markdownChunks = chunkMarkdown(content, relPath);

        if (markdownChunks.length === 0) {
            return;
        }

        const texts = markdownChunks.map((c) => c.content);
        const embeddings = await this.embeddingClient.embedBatch(texts);
        const sourceUrl = filePathToSourceUrl(relPath);

        const docChunks: DocChunk[] = markdownChunks.map((chunk, i) => ({
            source_url: sourceUrl,
            title: chunk.title,
            content: chunk.content,
            embedding: embeddings[i],
            file_path: relPath,
            chunk_index: chunk.chunkIndex,
            metadata: {
                heading_path: chunk.headingPath,
            },
            commit_sha: commitSha,
        }));

        await upsertDocChunks(docChunks);
        console.log(
            `[docs-indexer] Indexed ${relPath} (${docChunks.length} chunks)`,
        );
    }
}
