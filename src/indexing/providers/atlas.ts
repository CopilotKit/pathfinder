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
    // The state token is microsecond high-water TEXT (or the epoch fallback as
    // microsecond text when the source is empty). It flows straight into the
    // SQL bound as a `$N::timestamptz` text param — never wrapped in a JS Date,
    // which would truncate the microseconds.
    const stateToken =
      (await this.getCurrentStateToken()) ?? "1970-01-01T00:00:00.000000Z";
    const query = {
      changedOnOrBefore: stateToken,
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
    // Fail loud on a malformed checkpoint BEFORE any other branch. An
    // empty/undefined lastStateToken is the legitimate first-run "from the
    // beginning" signal (no `changedAfter` lower bound); anything else must be a
    // real microsecond timestamp, or the `$N::timestamptz` bind would either
    // throw deep in Postgres with no source context or — worse — silently
    // coerce garbage. Validating here (not after the null-token early return
    // below) ensures a corrupt checkpoint surfaces even when the source is empty
    // — otherwise garbage would silently pass through and re-persist on every
    // run of an empty source.
    const changedAfter = this.parseLowerBound(lastStateToken);
    const currentStateToken = await this.getCurrentStateToken();
    // A null current token means the high-water read found no rows (source
    // empty or unreadable). Falling back to lastStateToken would build the
    // window `changedAfter: T AND changedOnOrBefore: T` (i.e. `> T AND <= T`),
    // which matches nothing — a silent no-op that masks the case where the
    // state-token query failed to see rows it should have. Skip the pass
    // LOUDLY instead of issuing a guaranteed-empty query, and keep the caller's
    // (now-validated) checkpoint unchanged so the next run retries from the same
    // point.
    if (currentStateToken === null) {
      console.warn(
        `[atlas] Skipping incremental acquire for source "${this.config.name}": ` +
          `the current state token was null (source empty or unreadable). ` +
          `Carrying lastStateToken forward without running an empty window.`,
      );
      return { items: [], removedIds: [], stateToken: lastStateToken };
    }
    // currentStateToken is proven non-null by the early return above — bind the
    // raw microsecond text directly (no dead `? ... : undefined` ternary, no
    // `new Date()` wrap that would truncate the microseconds).
    const query = {
      changedAfter,
      changedOnOrBefore: currentStateToken,
      repositories: this.repositoryFilters(),
    };
    const [items, removedIds] = await Promise.all([
      this.acquireItems(query),
      listRemovedAtlasContentIds(this.config.name, query),
    ]);
    return {
      items,
      removedIds,
      stateToken: currentStateToken,
    };
  }

  // The exact fixed-width microsecond shape getAtlasStateToken emits via
  // `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` — 6 fractional digits and a
  // trailing Z. A bare `new Date(...)` probe is far looser than Postgres
  // `::timestamptz`: "2026" or "Jan 5 2026" parse in JS but bind with
  // different / locale-dependent semantics, defeating the fail-loud intent. We
  // require this precise token so anything that did NOT come from our own
  // state-token writer fails loud here instead of silently binding a different
  // instant.
  private static readonly STATE_TOKEN_PATTERN =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

  // Validate the persisted checkpoint before it reaches the SQL bind. Empty or
  // undefined means "first run, no lower bound"; any non-empty value must be the
  // exact microsecond state-token shape. We keep the raw microsecond text (the
  // regex is only a validity gate — we never reformat it) so the `> $token`
  // bound runs at full precision.
  private parseLowerBound(lastStateToken: string): string | undefined {
    if (!lastStateToken) return undefined;
    if (!AtlasDataProvider.STATE_TOKEN_PATTERN.test(lastStateToken)) {
      throw new Error(
        `[atlas] Refusing incremental acquire for source "${this.config.name}": ` +
          `lastStateToken is not a valid microsecond state token ` +
          `(expected YYYY-MM-DDTHH:MM:SS.ffffffZ): ` +
          `${JSON.stringify(lastStateToken)}`,
      );
    }
    return lastStateToken;
  }

  async getCurrentStateToken(): Promise<string | null> {
    return getAtlasStateToken(this.config.name, {
      repositories: this.repositoryFilters(),
    });
  }

  private async acquireItems(query: {
    changedAfter?: string;
    changedOnOrBefore?: string;
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
