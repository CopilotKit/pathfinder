// FileDataProvider — git-backed and local file data acquisition.
// Handles clone/pull, file walking, pattern matching, content reading.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { simpleGit, type SimpleGit } from 'simple-git';
import { matchesPatterns, hasLowSemanticValue } from '../utils.js';
import type { SourceConfig } from '../../types.js';
import type { DataProvider, AcquisitionResult, ContentItem, ProviderOptions } from './types.js';

const DEFAULT_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git']);
const DEFAULT_MAX_FILE_SIZE = 102400; // 100KB

function repoNameFromUrl(repoUrl: string): string {
    const last = repoUrl.split('/').pop() ?? '';
    return last.replace(/\.git$/, '');
}

function authenticatedUrl(repoUrl: string, githubToken?: string): string {
    if (githubToken) {
        return repoUrl.replace(
            'https://github.com/',
            `https://x-access-token:${githubToken}@github.com/`,
        );
    }
    return repoUrl;
}

export class FileDataProvider implements DataProvider {
    private config: SourceConfig;
    private options: ProviderOptions;
    private logPrefix: string;
    private skipDirs: Set<string>;
    private maxFileSize: number;

    constructor(config: SourceConfig, options: ProviderOptions) {
        this.config = config;
        this.options = options;
        this.logPrefix = `[file-provider:${config.name}]`;
        this.skipDirs = new Set([...DEFAULT_SKIP_DIRS, ...(config.skip_dirs ?? [])]);
        this.maxFileSize = config.max_file_size ?? DEFAULT_MAX_FILE_SIZE;
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
            stateToken = await git.revparse(['HEAD']);
        }

        const walkRoot = this.isLocal()
            ? repoDir
            : path.join(repoDir, this.config.path);

        if (!fs.existsSync(walkRoot)) {
            console.warn(`${this.logPrefix} Walk root not found at ${walkRoot}, skipping`);
            return { items: [], removedIds: [], stateToken };
        }

        const allFiles = await this.walkFiles(walkRoot);
        const matchingFiles = allFiles.filter(absPath => {
            const relPath = path.relative(repoDir, absPath);
            return matchesPatterns(relPath, this.config);
        });

        const skipped = allFiles.length - matchingFiles.length;
        console.log(
            `${this.logPrefix} Found ${matchingFiles.length} files for full acquire` +
            (skipped > 0 ? ` (${skipped} excluded by patterns)` : ''),
        );

        const items: ContentItem[] = [];
        for (const absPath of matchingFiles) {
            const relPath = path.relative(repoDir, absPath);
            try {
                const content = await fs.promises.readFile(absPath, 'utf-8');
                if (hasLowSemanticValue(content)) continue;
                items.push({ id: relPath, content });
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`${this.logPrefix} Failed to read ${relPath}: ${msg}`);
            }
        }

        return { items, removedIds: [], stateToken };
    }

    async incrementalAcquire(lastStateToken: string): Promise<AcquisitionResult> {
        if (this.isLocal()) {
            console.log(`${this.logPrefix} Local source — falling back to full acquire`);
            return this.fullAcquire();
        }

        const repoName = repoNameFromUrl(this.config.repo!);
        const repoDir = path.join(this.options.cloneDir, repoName);
        const git = await this.ensureRepo(repoDir, repoName);
        const headSha = await git.revparse(['HEAD']);

        if (headSha === lastStateToken) {
            console.log(`${this.logPrefix} No new commits, skipping`);
            return { items: [], removedIds: [], stateToken: headSha };
        }

        // Unshallow for diff
        try {
            await git.fetch(['--unshallow']);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes('unshallow') && !msg.includes('does not make sense')) {
                console.warn(`${this.logPrefix} git fetch --unshallow failed:`, msg);
            }
        }

        let diffOutput: string;
        try {
            diffOutput = await git.diff(['--name-only', `${lastStateToken}..HEAD`]);
        } catch (err) {
            console.warn(`${this.logPrefix} git diff failed, falling back to full acquire:`, err);
            return this.fullAcquire();
        }

        const changedFiles = diffOutput.split('\n').map(f => f.trim()).filter(f => f.length > 0);
        const matchingChanged = changedFiles.filter(f => matchesPatterns(f, this.config));

        if (matchingChanged.length === 0) {
            console.log(`${this.logPrefix} No matching changes detected`);
            return { items: [], removedIds: [], stateToken: headSha };
        }

        console.log(`${this.logPrefix} Incremental acquire: ${matchingChanged.length} changed files`);

        // Find deleted files
        const diffStatusOutput = await git.diff(['--name-status', `${lastStateToken}..HEAD`]);
        const deletedFiles = diffStatusOutput.split('\n')
            .filter(line => line.startsWith('D\t'))
            .map(line => line.slice(2).trim())
            .filter(f => matchesPatterns(f, this.config));

        // Read changed (non-deleted) files
        const filesToRead = matchingChanged.filter(f => !deletedFiles.includes(f));
        const items: ContentItem[] = [];
        for (const relPath of filesToRead) {
            const absPath = path.join(repoDir, relPath);
            if (!fs.existsSync(absPath)) continue;
            try {
                const stat = await fs.promises.stat(absPath);
                if (stat.size > this.maxFileSize) continue;
                const content = await fs.promises.readFile(absPath, 'utf-8');
                if (hasLowSemanticValue(content)) continue;
                items.push({ id: relPath, content });
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`${this.logPrefix} Failed to read ${relPath}: ${msg}`);
            }
        }

        return { items, removedIds: deletedFiles, stateToken: headSha };
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
            const result = await git.listRemote([url, 'HEAD']);
            const sha = result.split('\t')[0]?.trim();
            return sha || null;
        } catch {
            // If ls-remote fails, check if clone dir exists and get local HEAD
            const repoName = repoNameFromUrl(this.config.repo!);
            const repoDir = path.join(this.options.cloneDir, repoName);
            if (!fs.existsSync(repoDir)) return null;
            try {
                const git = simpleGit(repoDir);
                return await git.revparse(['HEAD']);
            } catch {
                return null;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    private async ensureRepo(repoDir: string, repoName: string): Promise<SimpleGit> {
        await fs.promises.mkdir(this.options.cloneDir, { recursive: true });

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

        const authUrl = authenticatedUrl(this.config.repo!, this.options.githubToken);
        console.log(`${this.logPrefix} Cloning ${this.config.repo!} into ${repoDir}`);
        const git = simpleGit(this.options.cloneDir);
        const cloneOpts = ['--depth=1'];
        if (this.config.branch) {
            cloneOpts.push('--branch', this.config.branch);
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

    private async computeLocalSha(walkRoot: string): Promise<string> {
        const files = await this.walkFiles(walkRoot);
        const hash = createHash('sha256');
        for (const f of files.sort()) {
            const stat = await fs.promises.stat(f);
            hash.update(`${f}:${stat.mtimeMs}\n`);
        }
        return `local-${hash.digest('hex').slice(0, 12)}`;
    }
}
