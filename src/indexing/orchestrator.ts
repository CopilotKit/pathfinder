// Job queue and coordination for indexing pipelines.
// Fully config-driven: indexes sources referenced by search tools in pathfinder.yaml.

import fs from "node:fs";
import path from "node:path";

import {
  getConfig,
  getServerConfig,
  getAnalyticsConfig,
  getIndexableSourceNames,
} from "../config.js";
import { createEmbeddingProvider } from "./embeddings.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { getProvider } from "./providers/index.js";
import { IndexingPipeline } from "./pipeline.js";
import {
  getIndexState,
  upsertIndexState,
  cleanupOldWebhookDeliveries,
} from "../db/queries.js";
import { cleanupOldQueryLogs } from "../db/analytics.js";
import { isFileSourceConfig } from "../types.js";
import type { IndexState, IndexStatus, SourceConfig } from "../types.js";
import type { ProviderOptions } from "./providers/types.js";

/**
 * Find all source configs that reference a given repo URL.
 */
function getSourcesByRepo(repoUrl: string): SourceConfig[] {
  return getServerConfig().sources.filter(
    (s) => isFileSourceConfig(s) && s.repo === repoUrl,
  );
}

function getStaleThresholdMs(): number {
  const serverCfg = getServerConfig();
  return (serverCfg.indexing?.stale_threshold_hours ?? 24) * 60 * 60 * 1000;
}

interface Job {
  type:
    | "full-reindex"
    | "incremental-reindex"
    | "full-reindex-local"
    | "source-reindex";
  repoUrl?: string; // for incremental
  sources?: SourceConfig[]; // for full-reindex-local
  sourceName?: string; // for source-reindex
}

export class IndexingOrchestrator {
  private queue: Job[] = [];
  private running = false;
  private draining = false;

  // Per-source mutex: prevents concurrent indexing of the same source
  private activeSources = new Set<string>();

  // Per-repo mutex: prevents concurrent indexing of the same repo across jobs
  private activeRepos = new Set<string>();

  // Dedup keys for jobs currently being executed (not in queue but running)
  private executingJobKeys = new Set<string>();

  // Number of jobs currently executing
  private activeJobCount = 0;

  // Maximum number of concurrent indexing jobs
  private maxConcurrent: number;

  // Track last nightly reindex date to prevent drift-based duplicate triggers
  private lastReindexDate: string | null = null;

  // Callback fired after each reindex job completes with affected source names
  onReindexComplete?: (sourceNames: string[]) => void;

  constructor(options?: { maxConcurrent?: number }) {
    this.maxConcurrent = options?.maxConcurrent ?? 3;
  }

  /**
   * Smart startup check: compare DB commit SHAs against remote HEAD.
   * Only re-indexes sources that have actually changed, avoiding
   * unnecessary OpenAI API calls on container restarts.
   */
  async checkAndIndex(): Promise<void> {
    const indexableNames = getIndexableSourceNames();
    if (indexableNames.size === 0) {
      console.log(
        "[orchestrator] No search tools configured — skipping indexing",
      );
      return;
    }

    console.log("[orchestrator] Checking index state...");

    const serverCfg = getServerConfig();
    const indexableSources = serverCfg.sources.filter((s) =>
      indexableNames.has(s.name),
    );

    // Check indexable sources for missing/errored state.
    // Queue individual sources that need reindexing rather than triggering a full reindex of everything.
    const sourcesNeedingFullReindex: SourceConfig[] = [];
    const sourcesOk: SourceConfig[] = [];
    for (const source of indexableSources) {
      const state = await getIndexState(source.type, source.name);
      if (!state || !state.last_commit_sha || state.status === "error") {
        console.log(
          `[orchestrator] ${source.name}: never indexed or in error state — will queue for reindex`,
        );
        sourcesNeedingFullReindex.push(source);
      } else {
        sourcesOk.push(source);
      }
    }

    // Queue full reindex for individual missing/errored sources
    if (sourcesNeedingFullReindex.length > 0) {
      // If ALL sources need reindex, just do a full reindex
      if (sourcesNeedingFullReindex.length === indexableSources.length) {
        console.log(
          "[orchestrator] All indexable sources need reindexing — queuing full reindex",
        );
        this.queueFullReindex();
        return;
      }
      // Queue incremental reindexes for each affected git-backed repo
      const reposToReindex = new Set<string>();
      for (const s of sourcesNeedingFullReindex) {
        if (isFileSourceConfig(s) && s.repo) reposToReindex.add(s.repo);
      }
      for (const repoUrl of reposToReindex) {
        this.queueIncrementalReindex(repoUrl);
      }
      // Local sources (no repo) get queued as a full reindex of just those sources
      const localSources = sourcesNeedingFullReindex.filter(
        (s) => isFileSourceConfig(s) && !s.repo,
      );
      if (localSources.length > 0) {
        this.queue.push({ type: "full-reindex-local", sources: localSources });
        this.drain().catch((err) =>
          console.error("[orchestrator] drain() failed:", err),
        );
      }

      // Non-file sources (e.g., Slack) that need reindexing
      const nonFileSources = sourcesNeedingFullReindex.filter(
        (s) => !isFileSourceConfig(s),
      );
      for (const source of nonFileSources) {
        this.queueSourceReindex(source.name);
      }
    }

    if (sourcesOk.length === 0) return;

    // Local sources in sourcesOk have no remote to check — always reindex on startup
    const localSourcesOk = sourcesOk.filter(
      (s) => isFileSourceConfig(s) && !s.repo,
    );
    if (localSourcesOk.length > 0) {
      console.log(
        `[orchestrator] Queuing reindex for ${localSourcesOk.length} local source(s)`,
      );
      this.queue.push({ type: "full-reindex-local", sources: localSourcesOk });
      this.drain().catch((err) =>
        console.error("[orchestrator] drain() failed:", err),
      );
    }

    console.log(
      "[orchestrator] Checking remotes for changes on indexed sources...",
    );

    // Check each git-backed source for changes
    const gitSourcesOk = sourcesOk.filter(
      (s) => isFileSourceConfig(s) && s.repo,
    );
    for (const source of gitSourcesOk) {
      try {
        const currentToken = await this.getSourceStateToken(source);
        const state = await getIndexState(source.type, source.name);

        if (currentToken === null || state?.last_commit_sha !== currentToken) {
          const reason =
            currentToken === null
              ? "source unavailable (clone missing?)"
              : `remote ${currentToken.slice(0, 8)} differs from indexed`;
          console.log(
            `[orchestrator] ${reason} for ${source.name} — queuing reindex`,
          );
          if (isFileSourceConfig(source) && source.repo) {
            this.queueIncrementalReindex(source.repo);
          }
        } else {
          console.log(
            `[orchestrator] ${source.name} index current at ${currentToken.slice(0, 8)}`,
          );
        }
      } catch (err) {
        console.warn(
          `[orchestrator] Failed to check state for ${source.name}, falling back to age check:`,
          err,
        );
        const state = await getIndexState(source.type, source.name);
        if (this.isStale(state)) {
          console.log(
            `[orchestrator] Index for ${source.name} is stale — queuing full reindex`,
          );
          this.queueFullReindex();
        }
      }
    }

    // Ensure git repos are cloned even when index is current.
    // On fresh deploys, the container has no local clones but the DB may have valid state.
    // Bash tools need the clone directories to build their filesystem.
    const cloneDir = getConfig().cloneDir;
    for (const source of gitSourcesOk) {
      if (!isFileSourceConfig(source) || !source.repo) continue;
      const repoName = source.repo
        .replace(/\.git$/, "")
        .split("/")
        .pop()!;
      const repoDir = path.join(cloneDir, repoName);
      if (!fs.existsSync(repoDir)) {
        console.log(
          `[orchestrator] Clone directory missing for ${source.name}, queuing reindex to populate`,
        );
        this.queueIncrementalReindex(source.repo);
      }
    }
  }

  /**
   * Get the current state token for a source without acquiring items.
   * Returns null if the source is unavailable.
   */
  private async getSourceStateToken(
    source: SourceConfig,
  ): Promise<string | null> {
    const config = getConfig();
    const providerOptions: ProviderOptions = {
      cloneDir: config.cloneDir,
      githubToken: config.githubToken,
      slackBotToken: config.slackBotToken,
      discordBotToken: config.discordBotToken,
      notionToken: config.notionToken,
    };
    const provider = getProvider(source.type)(source, providerOptions);
    return provider.getCurrentStateToken();
  }

  /**
   * Derive a dedup key for a job. Jobs with the same key are considered duplicates.
   */
  private jobDedupKey(job: Job): string {
    if (job.type === "incremental-reindex") return `incremental:${job.repoUrl}`;
    if (job.type === "source-reindex") return `source:${job.sourceName}`;
    if (job.type === "full-reindex") return "full-reindex";
    // full-reindex-local jobs are not deduped (they carry specific source lists)
    return `local:${job.sources?.map((s) => s.name).join(",") ?? ""}`;
  }

  /**
   * Check if a job is a duplicate of one already queued or currently executing.
   */
  private isDuplicateJob(job: Job): boolean {
    const key = this.jobDedupKey(job);
    if (this.executingJobKeys.has(key)) return true;
    if (job.type === "full-reindex") {
      return this.queue.some((j) => j.type === "full-reindex");
    }
    if (job.type === "incremental-reindex") {
      return this.queue.some(
        (j) => j.type === "incremental-reindex" && j.repoUrl === job.repoUrl,
      );
    }
    if (job.type === "source-reindex") {
      return this.queue.some(
        (j) => j.type === "source-reindex" && j.sourceName === job.sourceName,
      );
    }
    return false;
  }

  /**
   * Queue a full re-index of all sources. Returns immediately.
   * Deduplicates: only one full-reindex can be queued or running at a time.
   */
  queueFullReindex(): void {
    const job: Job = { type: "full-reindex" };
    if (this.isDuplicateJob(job)) {
      console.log(
        "[orchestrator] Full re-index already queued, skipping duplicate",
      );
      return;
    }
    this.queue.push(job);
    console.log("[orchestrator] Full re-index queued");
    this.drain().catch((err) => {
      console.error("[orchestrator] drain() failed:", err);
    });
  }

  /**
   * Queue an incremental re-index for a specific repo. Returns immediately.
   * Deduplicates on (type, repoUrl): skips if the same repo is already queued or running.
   */
  queueIncrementalReindex(repoUrl: string): void {
    const job: Job = { type: "incremental-reindex", repoUrl };
    if (this.isDuplicateJob(job)) {
      console.log(
        `[orchestrator] Incremental re-index for ${repoUrl} already queued, skipping`,
      );
      return;
    }
    this.queue.push(job);
    console.log(`[orchestrator] Incremental re-index queued for ${repoUrl}`);
    this.drain().catch((err) => {
      console.error("[orchestrator] drain() failed:", err);
    });
  }

  /**
   * Queue a reindex for a single named source. Returns immediately.
   * Used by webhook handlers to trigger reindexing of specific sources.
   * Deduplicates on (type, sourceName): skips if the same source is already queued or running.
   */
  queueSourceReindex(sourceName: string): void {
    const job: Job = { type: "source-reindex", sourceName };
    if (this.isDuplicateJob(job)) {
      console.log(
        `[orchestrator] Source re-index for ${sourceName} already queued, skipping`,
      );
      return;
    }
    this.queue.push(job);
    console.log(`[orchestrator] Source re-index queued for ${sourceName}`);
    this.drain().catch((err) => {
      console.error("[orchestrator] drain() failed:", err);
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
    if (!serverCfg.indexing?.auto_reindex) {
      console.log("[orchestrator] Nightly reindex disabled");
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
          console.log("[orchestrator] Starting nightly reindex");
          this.queueFullReindex();

          // Analytics cleanup — always runs since logging is always on
          const retentionDays = getAnalyticsConfig()?.retention_days ?? 90;
          cleanupOldQueryLogs(retentionDays)
            .then((deleted) => {
              if (deleted > 0) {
                console.log(
                  `[analytics] Cleaned up ${deleted} query_log rows older than ${retentionDays} days`,
                );
              }
            })
            .catch((err) => {
              console.error("[analytics] Cleanup failed:", err);
            });

          // Webhook delivery cleanup — 30-day retention
          cleanupOldWebhookDeliveries(30)
            .then((deleted) => {
              if (deleted > 0) {
                console.log(
                  `[webhook-tracking] Cleaned up ${deleted} webhook_deliveries rows older than 30 days`,
                );
              }
            })
            .catch((err) => {
              console.error("[webhook-tracking] Cleanup failed:", err);
            });
        }
      }
    }, 60_000);
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  /**
   * Check if an index state is stale (never indexed or older than the configured threshold).
   */
  private isStale(state: IndexState | null): boolean {
    if (!state) return true;
    if (!state.last_indexed_at) return true;
    if (state.status === "error") return true;

    const age = Date.now() - new Date(state.last_indexed_at).getTime();
    return age > getStaleThresholdMs();
  }

  /**
   * Derive the repo URL(s) a job will touch, for concurrency coordination.
   * Returns null for full-reindex (touches all repos — needs exclusive access)
   * or for local/non-repo sources that don't have a repo URL.
   */
  private getJobRepoKey(job: Job): string | null {
    if (job.type === "incremental-reindex") {
      return job.repoUrl ?? null;
    }
    if (job.type === "source-reindex" && job.sourceName) {
      const serverCfg = getServerConfig();
      const source = serverCfg.sources.find((s) => s.name === job.sourceName);
      if (source && isFileSourceConfig(source) && source.repo) {
        return source.repo;
      }
      return null; // Non-repo source — no repo-level conflict
    }
    if (job.type === "full-reindex-local") {
      return null; // Local sources only — no repo conflict
    }
    // full-reindex: return a sentinel meaning "all repos"
    return "__all__";
  }

  /**
   * Check if a job can run right now given active repo constraints.
   */
  private canRunJob(job: Job): boolean {
    // If a full-reindex is active (sentinel "__all__" in activeRepos), block everything
    if (this.activeRepos.has("__all__")) return false;

    const repoKey = this.getJobRepoKey(job);

    // full-reindex needs exclusive access — can only run when nothing else is active
    if (repoKey === "__all__") {
      return this.activeJobCount === 0;
    }

    // Jobs with a repo key can't run if that repo is already active
    if (repoKey && this.activeRepos.has(repoKey)) return false;

    return true;
  }

  /**
   * Process the job queue with up to maxConcurrent parallel jobs.
   * Jobs for the same repo are serialized; different repos run in parallel.
   */
  private async drain(): Promise<void> {
    if (this.draining) return; // Already draining
    this.draining = true;

    try {
      do {
        while (this.queue.length > 0) {
          // Find runnable jobs (respecting concurrency + repo constraints)
          const launched: Promise<void>[] = [];

          for (
            let i = 0;
            i < this.queue.length && this.activeJobCount < this.maxConcurrent;
          ) {
            const job = this.queue[i];
            if (this.canRunJob(job)) {
              // Remove from queue
              this.queue.splice(i, 1);

              const repoKey = this.getJobRepoKey(job);
              const dedupKey = this.jobDedupKey(job);
              if (repoKey) this.activeRepos.add(repoKey);
              this.executingJobKeys.add(dedupKey);
              this.activeJobCount++;
              this.running = true;

              // Launch job concurrently
              const jobPromise = this.executeJob(job)
                .catch((err) => {
                  console.error("[orchestrator] Job failed:", err);
                })
                .finally(() => {
                  if (repoKey) this.activeRepos.delete(repoKey);
                  this.executingJobKeys.delete(dedupKey);
                  this.activeJobCount--;
                  if (this.activeJobCount === 0) this.running = false;
                });
              launched.push(jobPromise);
            } else {
              i++; // Skip this job, try next
            }
          }

          if (launched.length === 0) {
            // No jobs could be launched — all remaining are blocked on repo conflicts.
            // Wait for at least one active job to finish before retrying.
            if (this.activeJobCount > 0) {
              await new Promise<void>((resolve) => {
                const check = setInterval(() => {
                  if (this.activeJobCount < this.maxConcurrent) {
                    clearInterval(check);
                    resolve();
                  }
                }, 50);
              });
              continue; // Re-evaluate the queue
            }
            break; // Nothing active and nothing runnable — shouldn't happen, but bail safely
          }

          // Wait for at least one launched job to complete before scanning queue again
          await Promise.race(launched);
        }

        // Wait for all remaining active jobs to finish
        if (this.activeJobCount > 0) {
          await new Promise<void>((resolve) => {
            const check = setInterval(() => {
              if (this.activeJobCount === 0) {
                clearInterval(check);
                resolve();
              }
            }, 50);
          });
        }
      } while (this.queue.length > 0); // Re-check: jobs may have been queued during final-wait
    } finally {
      this.running = false;
      this.draining = false;
    }
  }

  /**
   * Execute a single job.
   */
  private async executeJob(job: Job): Promise<void> {
    const config = getConfig();
    const serverCfg = getServerConfig();
    if (!serverCfg.embedding) {
      throw new Error("embedding config is required for indexing");
    }
    const embeddingProvider = createEmbeddingProvider(
      serverCfg.embedding,
      config.openaiApiKey || undefined,
    );

    const serverCfg2 = getServerConfig();
    let affectedSourceNames: string[] = [];

    if (job.type === "full-reindex") {
      await this.runFullReindex(
        embeddingProvider,
        config.cloneDir,
        config.githubToken,
      );
      affectedSourceNames = serverCfg2.sources.map((s) => s.name);
    } else if (job.type === "full-reindex-local") {
      if (!job.sources || job.sources.length === 0) {
        console.warn(
          "[orchestrator] full-reindex-local job has no sources, skipping",
        );
        return;
      }
      for (const sourceConfig of job.sources) {
        await this.indexSourceWithState(
          sourceConfig,
          embeddingProvider,
          config.cloneDir,
        );
      }
      affectedSourceNames = job.sources.map((s) => s.name);
    } else if (job.type === "incremental-reindex") {
      if (!job.repoUrl) {
        console.warn(
          "[orchestrator] incremental-reindex job has no repoUrl, skipping",
        );
        return;
      }
      await this.runIncrementalReindex(
        embeddingProvider,
        config.cloneDir,
        config.githubToken,
        job.repoUrl,
      );
      affectedSourceNames = getSourcesByRepo(job.repoUrl).map((s) => s.name);
    } else if (job.type === "source-reindex") {
      if (!job.sourceName) {
        console.warn(
          "[orchestrator] source-reindex job has no sourceName, skipping",
        );
        return;
      }
      const sourceConfig = serverCfg2.sources.find(
        (s) => s.name === job.sourceName,
      );
      if (!sourceConfig) {
        console.warn(
          `[orchestrator] source-reindex: source "${job.sourceName}" not found in config`,
        );
        return;
      }
      await this.indexSourceWithState(
        sourceConfig,
        embeddingProvider,
        config.cloneDir,
      );
      affectedSourceNames = [job.sourceName];
    }

    if (affectedSourceNames.length > 0 && this.onReindexComplete) {
      try {
        this.onReindexComplete(affectedSourceNames);
      } catch (err) {
        console.error("[orchestrator] onReindexComplete callback failed:", err);
      }
    }
  }

  /**
   * Run a full re-index of all indexable sources (those referenced by search tools).
   */
  private async runFullReindex(
    embeddingProvider: EmbeddingProvider,
    cloneDir: string,
    githubToken?: string,
  ): Promise<void> {
    console.log("[orchestrator] Starting full re-index");

    const serverCfg = getServerConfig();
    const indexableNames = getIndexableSourceNames();
    for (const sourceConfig of serverCfg.sources.filter((s) =>
      indexableNames.has(s.name),
    )) {
      await this.indexSourceWithState(
        sourceConfig,
        embeddingProvider,
        cloneDir,
        githubToken,
      );
    }

    console.log("[orchestrator] Full re-index complete");
  }

  /**
   * Run an incremental re-index for all sources associated with a repo.
   */
  private async runIncrementalReindex(
    embeddingProvider: EmbeddingProvider,
    cloneDir: string,
    githubToken: string | undefined,
    repoUrl: string,
  ): Promise<void> {
    console.log(`[orchestrator] Starting incremental re-index for ${repoUrl}`);

    const indexableNames = getIndexableSourceNames();
    const sources = getSourcesByRepo(repoUrl).filter((s) =>
      indexableNames.has(s.name),
    );
    for (const sourceConfig of sources) {
      await this.indexSourceWithState(
        sourceConfig,
        embeddingProvider,
        cloneDir,
        githubToken,
      );
    }

    console.log(`[orchestrator] Incremental re-index complete for ${repoUrl}`);
  }

  /**
   * Index a single source with full state tracking.
   */
  private async indexSourceWithState(
    sourceConfig: SourceConfig,
    embeddingProvider: EmbeddingProvider,
    cloneDir: string,
    githubToken?: string,
  ): Promise<void> {
    const lockKey = `${sourceConfig.type}:${sourceConfig.name}`;
    await this.withSourceLock(lockKey, async () => {
      const providerOptions: ProviderOptions = {
        cloneDir,
        githubToken,
        slackBotToken: getConfig().slackBotToken,
        discordBotToken: getConfig().discordBotToken,
        notionToken: getConfig().notionToken,
      };
      const provider = getProvider(sourceConfig.type)(
        sourceConfig,
        providerOptions,
      );
      const pipeline = new IndexingPipeline(embeddingProvider, sourceConfig);

      await this.setIndexStatus(
        sourceConfig.type,
        sourceConfig.name,
        "indexing",
      );

      try {
        const state = await getIndexState(sourceConfig.type, sourceConfig.name);
        let result;
        if (state?.last_commit_sha) {
          result = await provider.incrementalAcquire(state.last_commit_sha);
        } else {
          result = await provider.fullAcquire();
        }

        if (result.removedIds.length > 0) {
          await pipeline.removeItems(result.removedIds);
        }
        if (result.items.length > 0) {
          await pipeline.indexItems(result.items, result.stateToken);
        }

        await upsertIndexState({
          source_type: sourceConfig.type,
          source_key: sourceConfig.name,
          last_commit_sha: result.stateToken,
          last_indexed_at: new Date(),
          status: "idle",
        });
        console.log(
          `[orchestrator] Indexing complete for ${sourceConfig.name}`,
        );
      } catch (err) {
        console.error(
          `[orchestrator] Indexing failed for ${sourceConfig.name}:`,
          err,
        );
        try {
          await this.setIndexStatus(
            sourceConfig.type,
            sourceConfig.name,
            "error",
            err instanceof Error ? err.message : String(err),
          );
        } catch (statusErr) {
          console.error(
            "[orchestrator] Failed to update index status:",
            statusErr,
          );
        }
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
