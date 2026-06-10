import {
  type AtlasRepositoryFilter,
  getAtlasStateToken,
  listIndexableAtlasContent,
  listRemovedAtlasContentIds,
} from "../../db/atlas.js";
import { isAtlasSourceConfig } from "../../types.js";
import type { AtlasSourceConfig, SourceConfig } from "../../types.js";
import type {
  AcquisitionResult,
  ContentItem,
  DataProvider,
  ProviderOptions,
} from "./types.js";

export class AtlasDataProvider implements DataProvider {
  private config: AtlasSourceConfig;

  constructor(config: SourceConfig, _options: ProviderOptions) {
    if (!isAtlasSourceConfig(config)) {
      throw new Error("AtlasDataProvider requires an atlas source config");
    }
    this.config = config;
  }

  async fullAcquire(): Promise<AcquisitionResult> {
    const stateToken =
      (await this.getCurrentStateToken()) ?? new Date(0).toISOString();
    const query = {
      changedOnOrBefore: new Date(stateToken),
      repositories: this.repositoryFilters(),
    };
    const [items, removedIds] = await Promise.all([
      this.acquireItems(query),
      listRemovedAtlasContentIds(this.config.name, query),
    ]);
    return {
      items,
      removedIds,
      stateToken,
    };
  }

  async incrementalAcquire(lastStateToken: string): Promise<AcquisitionResult> {
    const stateToken = (await this.getCurrentStateToken()) ?? lastStateToken;
    const query = {
      changedAfter: lastStateToken ? new Date(lastStateToken) : undefined,
      changedOnOrBefore: stateToken ? new Date(stateToken) : undefined,
      repositories: this.repositoryFilters(),
    };
    const [items, removedIds] = await Promise.all([
      this.acquireItems(query),
      listRemovedAtlasContentIds(this.config.name, query),
    ]);
    return {
      items,
      removedIds,
      stateToken,
    };
  }

  async getCurrentStateToken(): Promise<string | null> {
    return getAtlasStateToken(this.config.name, {
      repositories: this.repositoryFilters(),
    });
  }

  private async acquireItems(query: {
    changedAfter?: Date;
    changedOnOrBefore?: Date;
    repositories?: AtlasRepositoryFilter[];
  }): Promise<ContentItem[]> {
    const entries = await listIndexableAtlasContent(this.config.name, query);
    return entries.map((entry) => {
      if (entry.kind === "seed") {
        return {
          id: `atlas-seed:${entry.key}`,
          title: entry.title,
          content: entry.content,
          sourceUrl: `atlas://seed/${encodeURIComponent(entry.key)}`,
          metadata: {
            atlas_kind: "seed",
            atlas_key: entry.key,
            source_name: entry.sourceName,
            repo_url: entry.seed.repoUrl,
            ref: entry.seed.ref,
            subsystem: entry.seed.subsystem,
            provenance: entry.seed.provenance,
            evidence: entry.seed.evidence,
          },
        };
      }

      return {
        id: `atlas-cache:${entry.key}`,
        title: entry.title,
        content: entry.content,
        sourceUrl: `atlas://cache/${encodeURIComponent(entry.key)}`,
        metadata: {
          atlas_kind: "cache",
          atlas_page_key: entry.key,
          source_name: entry.sourceName,
          content_hash: entry.cachePage.contentHash,
          generated_seed_ids: entry.cachePage.generatedSeedIds,
          provenance: entry.cachePage.provenance,
          generated_at: entry.cachePage.generatedAt?.toISOString() ?? null,
        },
      };
    });
  }

  private repositoryFilters(): AtlasRepositoryFilter[] | undefined {
    if (!this.config.repositories || this.config.repositories.length === 0) {
      return undefined;
    }
    return this.config.repositories.map((repository) => ({
      repoUrl: repository.repo_url,
      refs: repository.refs,
      subsystems: repository.subsystems,
    }));
  }
}
