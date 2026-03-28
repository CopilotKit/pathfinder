// Job queue and coordination for indexing pipelines.
// Fully config-driven: iterates over all sources defined in mcp-docs.yaml.

import { simpleGit } from 'simple-git';
import { getConfig, getServerConfig } from '../config.js';
import { EmbeddingClient } from './embeddings.js';
import { SourceIndexer } from './source-indexer.js';
import {
    getIndexState,
    upsertIndexState,
} from '../db/queries.js';
import type { IndexState, IndexStatus, SourceConfig } from '../types.js';

// Derive the list of unique repo URLs from YAML sources config
function getIndexedRepos(): string[] {
    const serverCfg = getServerConfig();
    const repos = new Set(serverCfg.sources.map(s => s.repo));
    return [...repos];
}

/**
 * Find all source configs that reference a given repo URL.
 */
function getSourcesByRepo(repoUrl: string): SourceConfig[] {
    return getServerConfig().sources.filter(s => s.repo === repoUrl);
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

    // Track last nightly reindex date to prevent drift-based duplicate triggers
    private lastReindexDate: string | null = null;

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

        const serverCfg = getServerConfig();

        // Check all configured sources for missing/errored state.
        // Queue individual sources that need reindexing rather than triggering a full reindex of everything.
        const sourcesNeedingFullReindex: SourceConfig[] = [];
        const sourcesOk: SourceConfig[] = [];
        for (const source of serverCfg.sources) {
            const state = await getIndexState(source.type, source.name);
            if (!state || !state.last_commit_sha || state.status === 'error') {
                console.log(`[orchestrator] ${source.name}: never indexed or in error state — will queue for reindex`);
                sourcesNeedingFullReindex.push(source);
            } else {
                sourcesOk.push(source);
            }
        }

        // Queue full reindex for individual missing/errored sources
        if (sourcesNeedingFullReindex.length > 0) {
            // If ALL sources need reindex, just do a full reindex
            if (sourcesNeedingFullReindex.length === serverCfg.sources.length) {
                console.log('[orchestrator] All sources need reindexing — queuing full reindex');
                this.queueFullReindex();
                return;
            }
            // Otherwise queue incremental reindexes for each affected repo
            const reposToReindex = new Set(sourcesNeedingFullReindex.map(s => s.repo));
            for (const repoUrl of reposToReindex) {
                this.queueIncrementalReindex(repoUrl);
            }
        }

        if (sourcesOk.length === 0) return;

        console.log('[orchestrator] Checking remotes for changes on indexed sources...');

        const repos = [...new Set(sourcesOk.map(s => s.repo))];
        for (const repoUrl of repos) {
            try {
                const remoteHead = await this.getRemoteHead(repoUrl);
                const sources = getSourcesByRepo(repoUrl);

                let anyChanged = false;
                for (const source of sources) {
                    const state = await getIndexState(source.type, source.name);
                    if (state?.last_commit_sha !== remoteHead) {
                        anyChanged = true;
                        break;
                    }
                }

                if (anyChanged) {
                    console.log(
                        `[orchestrator] Remote HEAD ${remoteHead.slice(0, 8)} for ${repoUrl} differs from indexed — queuing incremental reindex`,
                    );
                    this.queueIncrementalReindex(repoUrl);
                } else {
                    console.log(`[orchestrator] Index current at ${remoteHead.slice(0, 8)}`);
                }
            } catch (err) {
                // If we can't check remote, fall back to age-based staleness
                console.warn(`[orchestrator] Failed to check remote HEAD for ${repoUrl}, falling back to age check:`, err);
                const repoSources = getSourcesByRepo(repoUrl);
                const firstState = await getIndexState(repoSources[0].type, repoSources[0].name);
                if (this.isStale(firstState)) {
                    console.log(`[orchestrator] Index for ${repoUrl} is stale (>24h) — queuing full reindex`);
                    this.queueFullReindex();
                } else {
                    console.log(`[orchestrator] Index for ${repoUrl} appears fresh, skipping`);
                }
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
            const today = now.toISOString().slice(0, 10);
            if (now.getUTCHours() === hour && this.lastReindexDate !== today) {
                if (!this.isIndexing()) {
                    this.lastReindexDate = today;
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
     * Run a full re-index of all configured sources.
     */
    private async runFullReindex(
        embeddingClient: EmbeddingClient,
        cloneDir: string,
        githubToken?: string,
    ): Promise<void> {
        console.log('[orchestrator] Starting full re-index');

        const serverCfg = getServerConfig();
        for (const sourceConfig of serverCfg.sources) {
            await this.indexSourceWithState(
                sourceConfig,
                embeddingClient,
                cloneDir,
                githubToken,
            );
        }

        console.log('[orchestrator] Full re-index complete');
    }

    /**
     * Run an incremental re-index for all sources associated with a repo.
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

        const sources = getSourcesByRepo(repoUrl);
        for (const sourceConfig of sources) {
            const state = await getIndexState(sourceConfig.type, sourceConfig.name);
            if (state?.last_commit_sha) {
                await this.withSourceLock(`${sourceConfig.type}:${sourceConfig.name}`, async () => {
                    await this.setIndexStatus(sourceConfig.type, sourceConfig.name, 'indexing');
                    try {
                        const indexer = new SourceIndexer(sourceConfig, embeddingClient, cloneDir, githubToken);
                        await indexer.incrementalIndex(state.last_commit_sha!);
                        const headSha = await indexer.getHeadSha();
                        await upsertIndexState({
                            source_type: sourceConfig.type,
                            source_key: sourceConfig.name,
                            last_commit_sha: headSha,
                            last_indexed_at: new Date(),
                            status: 'idle',
                        });
                    } catch (err) {
                        console.error(`[orchestrator] Incremental reindex failed for ${sourceConfig.name}:`, err);
                        try {
                            await this.setIndexStatus(
                                sourceConfig.type,
                                sourceConfig.name,
                                'error',
                                err instanceof Error ? err.message : String(err),
                            );
                        } catch (statusErr) {
                            console.error('[orchestrator] Failed to update index status:', statusErr);
                        }
                        // Don't rethrow — continue with remaining sources
                    }
                });
            } else {
                // No previous state — do a full index for this source
                await this.indexSourceWithState(sourceConfig, embeddingClient, cloneDir, githubToken);
            }
        }

        console.log(`[orchestrator] Incremental re-index complete for ${repoUrl}`);
    }

    /**
     * Index a single source with full state tracking.
     */
    private async indexSourceWithState(
        sourceConfig: SourceConfig,
        embeddingClient: EmbeddingClient,
        cloneDir: string,
        githubToken?: string,
    ): Promise<void> {
        const lockKey = `${sourceConfig.type}:${sourceConfig.name}`;
        await this.withSourceLock(lockKey, async () => {
            const indexer = new SourceIndexer(sourceConfig, embeddingClient, cloneDir, githubToken);
            await this.setIndexStatus(sourceConfig.type, sourceConfig.name, 'indexing');

            try {
                const state = await getIndexState(sourceConfig.type, sourceConfig.name);
                if (state?.last_commit_sha) {
                    await indexer.incrementalIndex(state.last_commit_sha);
                } else {
                    await indexer.fullIndex();
                }

                const headSha = await indexer.getHeadSha();
                await upsertIndexState({
                    source_type: sourceConfig.type,
                    source_key: sourceConfig.name,
                    last_commit_sha: headSha,
                    last_indexed_at: new Date(),
                    status: 'idle',
                });
                console.log(`[orchestrator] Indexing complete for ${sourceConfig.name}`);
            } catch (err) {
                console.error(
                    `[orchestrator] Indexing failed for ${sourceConfig.name}:`,
                    err,
                );
                try {
                    await this.setIndexStatus(
                        sourceConfig.type,
                        sourceConfig.name,
                        'error',
                        err instanceof Error ? err.message : String(err),
                    );
                } catch (statusErr) {
                    console.error('[orchestrator] Failed to update index status:', statusErr);
                }
                // Don't rethrow — continue with remaining sources
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
