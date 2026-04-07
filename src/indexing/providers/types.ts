// Data provider interfaces — the contract between data acquisition and indexing.

import type { SourceConfig } from '../../types.js';

/** A single content item to be indexed. */
export interface ContentItem {
    /** Unique identifier within the source (file path, thread ID, page ID, etc.) */
    id: string;
    /** Raw content to be chunked */
    content: string;
    /** Human-readable title (optional — chunker may derive one) */
    title?: string;
    /** URL to the original content (optional) */
    sourceUrl?: string;
    /** Additional metadata passed through to chunk records */
    metadata?: Record<string, unknown>;
}

/** Result of a data acquisition run. */
export interface AcquisitionResult {
    /** Items to index (full list for full acquire, changed items for incremental) */
    items: ContentItem[];
    /**
     * Item IDs to remove from the index.
     * Full acquire: always empty — deleted-file detection is not performed during
     * full acquire, so chunks from files no longer in the source persist until the
     * next incremental acquire or manual cleanup.
     * Incremental acquire: IDs of items deleted since lastStateToken.
     */
    removedIds: string[];
    /** Opaque state token to persist (commit SHA, API cursor, timestamp) */
    stateToken: string;
}

/** Interface that all data providers implement. */
export interface DataProvider {
    /**
     * Full acquisition — return all indexable items.
     * Providers must apply their own content filtering before returning items.
     */
    fullAcquire(): Promise<AcquisitionResult>;

    /**
     * Incremental acquisition — only items changed since lastStateToken.
     */
    incrementalAcquire(lastStateToken: string): Promise<AcquisitionResult>;

    /**
     * Get the current state token without acquiring items (for staleness checks).
     * Returns null if the source is unavailable (e.g., clone dir missing).
     */
    getCurrentStateToken(): Promise<string | null>;
}

/** Options passed to provider factories. */
export interface ProviderOptions {
    cloneDir: string;
    githubToken?: string;
    slackBotToken?: string;
}

/** Factory function that creates a DataProvider for a given source config. */
export type DataProviderFactory = (config: SourceConfig, options: ProviderOptions) => DataProvider;
