// Job queue and coordination for indexing pipelines

import { simpleGit } from 'simple-git';
import { getConfig, getServerConfig } from '../config.js';
import { EmbeddingClient } from './embeddings.js';
import { DocsIndexer } from './docs-indexer.js';
import { CodeIndexer } from './code-indexer.js';
import {
    getIndexState,
    upsertIndexState,
    type IndexState,
    type IndexStatus,
} from '../db/queries.js';

// Derive the list of unique repo URLs from YAML sources config
function getIndexedRepos(): string[] {
    const serverCfg = getServerConfig();
    const repos = new Set(serverCfg.sources.map(s => s.repo));
    return [...repos];
}

function getStaleThresholdMs(): number {
    const serverCfg = getServerConfig();
    return serverCfg.indexing.stale_threshold_hours * 60 * 60 * 1000;
}

interface Job {
    type: 'full-reindex' | 'incremental-reindex';
    repoUrl?: string; // for incremental
}

export class IndexingOrchestrator {
    private queue: Job[] = [];
    private running = false;
    private processing = false;

    // Per-source mutex: prevents concurrent indexing of the same source
    private activeSources = new Set<string>();

    constructor() {
        // No-op — all setup happens lazily via getConfig()
    }

    /**
     * Smart startup check: compare DB commit SHAs against remote HEAD.
     * Only re-indexes sources that have actually changed, avoiding
     * unnecessary OpenAI API calls on container restarts.
     */
    async checkAndIndex(): Promise<void> {
        console.log('[orchestrator] Checking index state...');

        // Check docs
        const docsState = await getIndexState('docs', 'copilotkit-docs');
        if (!docsState || !docsState.last_commit_sha || docsState.status === 'error') {
            console.log('[orchestrator] Docs: never indexed or in error state — queuing full reindex');
            this.queueFullReindex();
            return;
        }

        // Check code for each repo
        for (const repoUrl of getIndexedRepos()) {
            const codeState = await getIndexState('code', repoUrl);
            if (!codeState || !codeState.last_commit_sha || codeState.status === 'error') {
                console.log(`[orchestrator] Code: never indexed or in error state for ${repoUrl} — queuing full reindex`);
                this.queueFullReindex();
                return;
            }
        }

        // All sources have been indexed before. Check if remote has new commits.
        console.log('[orchestrator] All sources previously indexed. Checking remote for changes...');

        try {
            const remoteHead = await this.getRemoteHead(getIndexedRepos()[0]);
            const docsChanged = docsState.last_commit_sha !== remoteHead;
            const codeState = await getIndexState('code', getIndexedRepos()[0]);
            const codeChanged = codeState?.last_commit_sha !== remoteHead;

            if (docsChanged || codeChanged) {
                console.log(
                    `[orchestrator] Remote HEAD ${remoteHead.slice(0, 8)} differs from indexed ` +
                    `(docs: ${docsState.last_commit_sha?.slice(0, 8)}, code: ${codeState?.last_commit_sha?.slice(0, 8)}) — queuing incremental reindex`,
                );
                this.queueIncrementalReindex(getIndexedRepos()[0]);
            } else {
                console.log(`[orchestrator] Index is current at ${remoteHead.slice(0, 8)} — no reindex needed`);
            }
        } catch (err) {
            // If we can't check remote, fall back to age-based staleness
            console.warn('[orchestrator] Failed to check remote HEAD, falling back to age check:', err);
            if (this.isStale(docsState)) {
                console.log('[orchestrator] Docs index is stale (>24h) — queuing full reindex');
                this.queueFullReindex();
            } else {
                console.log('[orchestrator] Index appears fresh, skipping');
            }
        }
    }

    /**
     * Get the HEAD SHA of a remote repo without cloning.
     * Uses `git ls-remote` which only fetches refs.
     */
    private async getRemoteHead(repoUrl: string): Promise<string> {
        const config = getConfig();
        let url = repoUrl;
        if (config.githubToken) {
            url = repoUrl.replace('https://github.com/', `https://x-access-token:${config.githubToken}@github.com/`);
        }
        const git = simpleGit();
        const result = await git.listRemote([url, 'HEAD']);
        const sha = result.split('\t')[0]?.trim();
        if (!sha) throw new Error(`Could not resolve HEAD for ${repoUrl}`);
        return sha;
    }

    /**
     * Queue a full re-index of all sources. Returns immediately.
     */
    queueFullReindex(): void {
        this.queue.push({ type: 'full-reindex' });
        console.log('[orchestrator] Full re-index queued');
        this.drain().catch((err) => {
            console.error('[orchestrator] drain() failed:', err);
        });
    }

    /**
     * Queue an incremental re-index for a specific repo. Returns immediately.
     */
    queueIncrementalReindex(repoUrl: string): void {
        this.queue.push({ type: 'incremental-reindex', repoUrl });
        console.log(
            `[orchestrator] Incremental re-index queued for ${repoUrl}`,
        );
        this.drain().catch((err) => {
            console.error('[orchestrator] drain() failed:', err);
        });
    }

    /**
     * Returns true if any indexing job is currently running.
     */
    isIndexing(): boolean {
        return this.running;
    }

    /**
     * Start a background timer that triggers a full reindex once per day at
     * the configured UTC hour.  Uses a simple setInterval (no cron library).
     */
    startNightlyReindex(): void {
        const serverCfg = getServerConfig();
        if (!serverCfg.indexing.auto_reindex) {
            console.log('[orchestrator] Nightly reindex disabled');
            return;
        }

        const hour = serverCfg.indexing.reindex_hour_utc;
        console.log(`[orchestrator] Nightly reindex scheduled at ${hour}:00 UTC`);

        // Check every 60 seconds if it's time to run
        setInterval(() => {
            const now = new Date();
            if (now.getUTCHours() === hour && now.getUTCMinutes() === 0) {
                if (!this.isIndexing()) {
                    console.log('[orchestrator] Starting nightly reindex');
                    this.queueFullReindex();
                }
            }
        }, 60_000);
    }

    // -----------------------------------------------------------------------
    // Private
    // -----------------------------------------------------------------------

    /**
     * Check if an index state is stale (never indexed or older than 24h).
     */
    private isStale(state: IndexState | null): boolean {
        if (!state) return true;
        if (!state.last_indexed_at) return true;
        if (state.status === 'error') return true;

        const age = Date.now() - new Date(state.last_indexed_at).getTime();
        return age > getStaleThresholdMs();
    }

    /**
     * Process the job queue (max 1 concurrent job).
     */
    private async drain(): Promise<void> {
        if (this.processing) return; // Already draining
        this.processing = true;

        try {
            while (this.queue.length > 0) {
                const job = this.queue.shift()!;
                this.running = true;

                try {
                    await this.executeJob(job);
                } catch (err) {
                    console.error(
                        '[orchestrator] Job failed:',
                        err,
                    );
                }
            }
        } finally {
            this.running = false;
            this.processing = false;
        }
    }

    /**
     * Execute a single job.
     */
    private async executeJob(job: Job): Promise<void> {
        const config = getConfig();
        const serverCfg = getServerConfig();
        const embeddingClient = new EmbeddingClient(
            config.openaiApiKey,
            serverCfg.embedding.model,
            serverCfg.embedding.dimensions,
        );

        if (job.type === 'full-reindex') {
            await this.runFullReindex(embeddingClient, config.cloneDir, config.githubToken);
        } else if (job.type === 'incremental-reindex' && job.repoUrl) {
            await this.runIncrementalReindex(
                embeddingClient,
                config.cloneDir,
                config.githubToken,
                job.repoUrl,
            );
        }
    }

    /**
     * Run a full re-index of docs and all code repos.
     */
    private async runFullReindex(
        embeddingClient: EmbeddingClient,
        cloneDir: string,
        githubToken?: string,
    ): Promise<void> {
        console.log('[orchestrator] Starting full re-index');

        // Index docs
        await this.indexDocsWithState(embeddingClient, cloneDir, githubToken);

        // Index all code repos sequentially
        const codeIndexer = new CodeIndexer(embeddingClient, cloneDir, githubToken);
        for (const repoUrl of getIndexedRepos()) {
            await this.indexCodeRepoWithState(
                codeIndexer,
                repoUrl,
            );
        }

        console.log('[orchestrator] Full re-index complete');
    }

    /**
     * Run an incremental re-index for a specific repo.
     */
    private async runIncrementalReindex(
        embeddingClient: EmbeddingClient,
        cloneDir: string,
        githubToken: string | undefined,
        repoUrl: string,
    ): Promise<void> {
        console.log(
            `[orchestrator] Starting incremental re-index for ${repoUrl}`,
        );

        // Determine if this is a docs or code repo
        const isDocs = repoUrl === 'https://github.com/CopilotKit/CopilotKit.git';

        if (isDocs) {
            // Check if we have a previous commit SHA for docs
            const docsState = await getIndexState('docs', 'copilotkit-docs');
            if (docsState?.last_commit_sha) {
                const docsIndexer = new DocsIndexer(embeddingClient, cloneDir, githubToken);
                await this.withSourceLock('docs:copilotkit-docs', async () => {
                    await this.setIndexStatus('docs', 'copilotkit-docs', 'indexing');
                    try {
                        await docsIndexer.incrementalIndex(docsState.last_commit_sha!);
                        const headSha = await docsIndexer.getHeadSha();
                        await upsertIndexState({
                            source_type: 'docs',
                            source_key: 'copilotkit-docs',
                            last_commit_sha: headSha,
                            last_indexed_at: new Date(),
                            status: 'idle',
                        });
                    } catch (err) {
                        try {
                            await this.setIndexStatus(
                                'docs',
                                'copilotkit-docs',
                                'error',
                                err instanceof Error ? err.message : String(err),
                            );
                        } catch (statusErr) {
                            console.error('[orchestrator] Failed to update index status:', statusErr);
                        }
                        throw err;
                    }
                });
            } else {
                // No previous state — do a full docs index
                await this.indexDocsWithState(embeddingClient, cloneDir, githubToken);
            }
        }

        // Always do code incremental for the given repo
        const codeIndexer = new CodeIndexer(embeddingClient, cloneDir, githubToken);
        const codeState = await getIndexState('code', repoUrl);
        if (codeState?.last_commit_sha) {
            await this.withSourceLock(`code:${repoUrl}`, async () => {
                await this.setIndexStatus('code', repoUrl, 'indexing');
                try {
                    await codeIndexer.incrementalIndex(
                        repoUrl,
                        codeState.last_commit_sha!,
                    );
                    const headSha = await codeIndexer.getHeadSha(repoUrl);
                    await upsertIndexState({
                        source_type: 'code',
                        source_key: repoUrl,
                        last_commit_sha: headSha,
                        last_indexed_at: new Date(),
                        status: 'idle',
                    });
                } catch (err) {
                    try {
                        await this.setIndexStatus(
                            'code',
                            repoUrl,
                            'error',
                            err instanceof Error ? err.message : String(err),
                        );
                    } catch (statusErr) {
                        console.error('[orchestrator] Failed to update index status:', statusErr);
                    }
                    throw err;
                }
            });
        } else {
            // No previous state — do a full index for this repo
            await this.indexCodeRepoWithState(codeIndexer, repoUrl);
        }
    }

    /**
     * Index docs with full state tracking.
     */
    private async indexDocsWithState(
        embeddingClient: EmbeddingClient,
        cloneDir: string,
        githubToken?: string,
    ): Promise<void> {
        await this.withSourceLock('docs:copilotkit-docs', async () => {
            const docsIndexer = new DocsIndexer(embeddingClient, cloneDir, githubToken);
            await this.setIndexStatus('docs', 'copilotkit-docs', 'indexing');

            try {
                const docsState = await getIndexState('docs', 'copilotkit-docs');
                if (docsState?.last_commit_sha) {
                    await docsIndexer.incrementalIndex(docsState.last_commit_sha);
                } else {
                    await docsIndexer.fullIndex();
                }

                const headSha = await docsIndexer.getHeadSha();
                await upsertIndexState({
                    source_type: 'docs',
                    source_key: 'copilotkit-docs',
                    last_commit_sha: headSha,
                    last_indexed_at: new Date(),
                    status: 'idle',
                });
                console.log('[orchestrator] Docs indexing complete');
            } catch (err) {
                console.error('[orchestrator] Docs indexing failed:', err);
                try {
                    await this.setIndexStatus(
                        'docs',
                        'copilotkit-docs',
                        'error',
                        err instanceof Error ? err.message : String(err),
                    );
                } catch (statusErr) {
                    console.error('[orchestrator] Failed to update index status:', statusErr);
                }
                // Don't rethrow — continue with code repos
            }
        });
    }

    /**
     * Index a single code repo with full state tracking.
     */
    private async indexCodeRepoWithState(
        codeIndexer: CodeIndexer,
        repoUrl: string,
    ): Promise<void> {
        await this.withSourceLock(`code:${repoUrl}`, async () => {
            await this.setIndexStatus('code', repoUrl, 'indexing');

            try {
                const codeState = await getIndexState('code', repoUrl);
                if (codeState?.last_commit_sha) {
                    await codeIndexer.incrementalIndex(repoUrl, codeState.last_commit_sha);
                } else {
                    await codeIndexer.indexRepo(repoUrl);
                }

                const headSha = await codeIndexer.getHeadSha(repoUrl);
                await upsertIndexState({
                    source_type: 'code',
                    source_key: repoUrl,
                    last_commit_sha: headSha,
                    last_indexed_at: new Date(),
                    status: 'idle',
                });
                console.log(
                    `[orchestrator] Code indexing complete for ${repoUrl}`,
                );
            } catch (err) {
                console.error(
                    `[orchestrator] Code indexing failed for ${repoUrl}:`,
                    err,
                );
                try {
                    await this.setIndexStatus(
                        'code',
                        repoUrl,
                        'error',
                        err instanceof Error ? err.message : String(err),
                    );
                } catch (statusErr) {
                    console.error('[orchestrator] Failed to update index status:', statusErr);
                }
                // Don't rethrow — continue with remaining repos
            }
        });
    }

    /**
     * Simple per-source mutex. If the source is already being indexed, skip.
     */
    private async withSourceLock(
        sourceKey: string,
        fn: () => Promise<void>,
    ): Promise<void> {
        if (this.activeSources.has(sourceKey)) {
            console.log(
                `[orchestrator] Skipping ${sourceKey} — already being indexed`,
            );
            return;
        }

        this.activeSources.add(sourceKey);
        try {
            await fn();
        } finally {
            this.activeSources.delete(sourceKey);
        }
    }

    /**
     * Update the index_state status for a source.
     */
    private async setIndexStatus(
        sourceType: string,
        sourceKey: string,
        status: IndexStatus,
        errorMessage?: string,
    ): Promise<void> {
        const existing = await getIndexState(sourceType, sourceKey);
        await upsertIndexState({
            source_type: sourceType,
            source_key: sourceKey,
            last_commit_sha: existing?.last_commit_sha ?? null,
            last_indexed_at: existing?.last_indexed_at ?? null,
            status,
            error_message: errorMessage ?? null,
        });
    }
}
