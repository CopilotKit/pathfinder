// NotionDataProvider — Notion page acquisition via API client.
// Implements DataProvider: discovers pages from root_pages, databases, or workspace search,
// fetches markdown content, and detects deletions during incremental acquire.

import { NotionApiClient, type NotionPageMeta } from "./notion-api.js";
import { getIndexedItemIds } from "../../db/queries.js";
import type { SourceConfig, NotionSourceConfig } from "../../types.js";
import type {
  DataProvider,
  AcquisitionResult,
  ContentItem,
  ProviderOptions,
} from "./types.js";

export class NotionDataProvider implements DataProvider {
  private config: NotionSourceConfig;
  private apiClient: NotionApiClient;
  private logPrefix: string;

  constructor(config: SourceConfig, options: ProviderOptions) {
    if (config.type !== "notion") {
      throw new Error("NotionDataProvider requires a notion source config");
    }
    this.config = config;
    const token = options.notionToken;
    if (!token) {
      throw new Error(
        "NotionDataProvider requires a notionToken in provider options",
      );
    }
    this.apiClient = new NotionApiClient(token, {
      maxDepth: this.config.max_depth,
    });
    this.logPrefix = `[notion-provider:${config.name}]`;
  }

  async fullAcquire(): Promise<AcquisitionResult> {
    console.log(`${this.logPrefix} Starting full acquire`);

    const pages = await this.discoverAllPages();
    console.log(`${this.logPrefix} Discovered ${pages.size} page(s)`);

    const { items, maxTime, failedCount } = await this.acquireContent(pages);

    if (failedCount === pages.size && pages.size > 0) {
      throw new Error(`All ${failedCount} page(s) failed during acquire`);
    }

    console.log(
      `${this.logPrefix} Full acquire complete: ${items.length} item(s)`,
    );

    return {
      items,
      removedIds: [],
      stateToken: maxTime || new Date().toISOString(),
    };
  }

  async incrementalAcquire(lastStateToken: string): Promise<AcquisitionResult> {
    console.log(
      `${this.logPrefix} Starting incremental acquire since ${lastStateToken}`,
    );

    // Discover full page set for deletion detection
    const allPages = await this.discoverAllPages();
    const allPageIds = new Set(allPages.keys());

    // Discover recently edited pages
    const editedPages = await this.discoverEditedPages(lastStateToken);

    // Detect deletions
    const indexedIds = await getIndexedItemIds(this.config.name);
    const removedIds: string[] = [];
    for (const id of indexedIds) {
      if (!allPageIds.has(id)) {
        removedIds.push(id);
      }
    }

    // Early return if no changes
    if (editedPages.size === 0 && removedIds.length === 0) {
      console.log(`${this.logPrefix} No changes detected`);
      return { items: [], removedIds: [], stateToken: lastStateToken };
    }

    // Acquire content only for edited pages
    const { items, maxTime, failedCount } =
      await this.acquireContent(editedPages);

    if (failedCount === editedPages.size && editedPages.size > 0) {
      throw new Error(`All ${failedCount} page(s) failed during acquire`);
    }

    console.log(
      `${this.logPrefix} Incremental acquire complete: ${items.length} item(s), ${removedIds.length} removal(s)`,
    );

    return {
      items,
      removedIds,
      stateToken: maxTime || lastStateToken,
    };
  }

  async getCurrentStateToken(): Promise<string | null> {
    const pages = await this.apiClient.searchPages();
    if (pages.length === 0) return null;

    let maxTime = "";
    for (const page of pages) {
      if (page.lastEditedTime > maxTime) {
        maxTime = page.lastEditedTime;
      }
    }

    return maxTime || null;
  }

  // -----------------------------------------------------------------------
  // Private: discovery
  // -----------------------------------------------------------------------

  /**
   * Discover all pages — full page set for indexing or deletion detection.
   */
  private async discoverAllPages(): Promise<Map<string, NotionPageMeta>> {
    const pages = new Map<string, NotionPageMeta>();
    const hasRootPages = this.config.root_pages.length > 0;
    const hasDatabases = this.config.databases.length > 0;

    if (!hasRootPages && !hasDatabases) {
      // Search-all mode
      const results = await this.apiClient.searchPages();
      for (const page of results) {
        pages.set(page.id, page);
      }
      return pages;
    }

    // Fetch root pages
    for (const pageId of this.config.root_pages) {
      try {
        const page = await this.apiClient.getPageMeta(pageId);
        pages.set(page.id, page);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `${this.logPrefix} Failed to fetch root page ${pageId}: ${msg}`,
        );
      }
    }

    // Query databases
    for (const dbId of this.config.databases) {
      try {
        const entries = await this.apiClient.queryDatabase(dbId);
        for (const entry of entries) {
          pages.set(entry.id, entry);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `${this.logPrefix} Failed to query database ${dbId}: ${msg}`,
        );
      }
    }

    return pages;
  }

  /**
   * Discover recently edited pages — only pages edited after the given timestamp.
   */
  private async discoverEditedPages(
    editedAfter: string,
  ): Promise<Map<string, NotionPageMeta>> {
    const pages = new Map<string, NotionPageMeta>();
    const hasRootPages = this.config.root_pages.length > 0;
    const hasDatabases = this.config.databases.length > 0;

    if (!hasRootPages && !hasDatabases) {
      const results = await this.apiClient.searchPages(editedAfter);
      for (const page of results) {
        pages.set(page.id, page);
      }
      return pages;
    }

    // Fetch root pages and filter by time
    const cutoff = new Date(editedAfter).getTime();
    for (const pageId of this.config.root_pages) {
      try {
        const page = await this.apiClient.getPageMeta(pageId);
        if (new Date(page.lastEditedTime).getTime() > cutoff) {
          pages.set(page.id, page);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `${this.logPrefix} Failed to fetch root page ${pageId}: ${msg}`,
        );
      }
    }

    // Query databases with time filter
    for (const dbId of this.config.databases) {
      try {
        const entries = await this.apiClient.queryDatabase(dbId, editedAfter);
        for (const entry of entries) {
          pages.set(entry.id, entry);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `${this.logPrefix} Failed to query database ${dbId}: ${msg}`,
        );
      }
    }

    return pages;
  }

  // -----------------------------------------------------------------------
  // Private: content acquisition
  // -----------------------------------------------------------------------

  /**
   * Acquire content for a set of pages. Returns items, max edit time, and failure count.
   */
  private async acquireContent(
    pages: Map<string, NotionPageMeta>,
  ): Promise<{ items: ContentItem[]; maxTime: string; failedCount: number }> {
    const items: ContentItem[] = [];
    let maxTime = "";
    let failedCount = 0;

    for (const [id, page] of pages) {
      try {
        let content = await this.apiClient.getPageContent(id);

        // Prepend YAML frontmatter if page has properties and include_properties is enabled
        if (page.properties && this.config.include_properties) {
          const frontmatter = this.buildFrontmatter(page.properties);
          if (frontmatter) {
            content = `${frontmatter}\n\n${content}`;
          }
        }

        // Empty pages get title-only content
        if (!content.trim()) {
          content = `# ${page.title}`;
        }

        items.push({
          id: page.id,
          content,
          title: page.title,
          sourceUrl: page.url,
          metadata: {
            parentType: page.parentType,
            parentId: page.parentId,
          },
        });

        if (page.lastEditedTime > maxTime) {
          maxTime = page.lastEditedTime;
        }
      } catch (err) {
        failedCount++;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `${this.logPrefix} Failed to acquire content for page ${id}: ${msg}`,
        );
      }
    }

    return { items, maxTime, failedCount };
  }

  /**
   * Build YAML frontmatter from page properties.
   * Skips the "title" key (redundant with page title) and null/empty values.
   */
  private buildFrontmatter(properties: Record<string, string>): string | null {
    const lines: string[] = [];

    for (const [key, value] of Object.entries(properties)) {
      // Skip title property — it's already the page title
      if (key.toLowerCase() === "title") continue;
      // Skip null/empty values
      if (!value) continue;
      lines.push(`${key}: ${value}`);
    }

    if (lines.length === 0) return null;
    return `---\n${lines.join("\n")}\n---`;
  }
}
