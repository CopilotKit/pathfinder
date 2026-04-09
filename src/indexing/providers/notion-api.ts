// Notion API client wrapper — handles pagination, rate limiting, block-to-markdown conversion.
// Uses @notionhq/client for type-safe API access.

import { Client } from '@notionhq/client';

// ── Types ────────────────────────────────────────────────────────────────────

export interface NotionPageMeta {
    id: string;
    title: string;
    lastEditedTime: string;  // ISO 8601
    url: string;
    parentType: 'workspace' | 'page' | 'database';
    parentId: string | null;
    properties?: Record<string, string>;  // for database entries
}

export interface NotionDatabaseMeta {
    id: string;
    title: string;
    url: string;
    propertyNames: string[];
}

export interface NotionApiClientOptions {
    /** Minimum ms between API requests (default: 340 for Notion's 3 req/s limit) */
    minRequestInterval?: number;
    /** Maximum block recursion depth (default: 10) */
    maxDepth?: number;
}

// ── Rate limit helpers ───────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Client ───────────────────────────────────────────────────────────────────

const MAX_PAGES = 100;
const MAX_RECURSION_DEPTH = 10;
const DEFAULT_MIN_REQUEST_INTERVAL = 340;

export class NotionApiClient {
    private client: Client;
    private userCache = new Map<string, string>();
    private minRequestInterval: number;
    private maxDepth: number;
    private lastRequestTime = 0;
    private logPrefix = '[notion-api]';

    constructor(token: string, options?: NotionApiClientOptions) {
        this.client = new Client({ auth: token });
        this.minRequestInterval = options?.minRequestInterval ?? DEFAULT_MIN_REQUEST_INTERVAL;
        this.maxDepth = options?.maxDepth ?? MAX_RECURSION_DEPTH;
    }

    // ── Public methods ──────────────────────────────────────────────────────

    /**
     * Search for pages in the workspace. Optionally filter to pages edited after a timestamp.
     */
    async searchPages(editedAfter?: string): Promise<NotionPageMeta[]> {
        const pages: NotionPageMeta[] = [];
        let startCursor: string | undefined;
        let pageCount = 0;
        const cutoff = editedAfter ? new Date(editedAfter).getTime() : 0;

        do {
            pageCount++;
            const response = await this.throttledCall(() =>
                this.client.search({
                    filter: { property: 'object', value: 'page' },
                    start_cursor: startCursor,
                    page_size: 100,
                }),
            );

            for (const result of response.results) {
                if (result.object !== 'page') continue;
                const page = result as any;
                if (cutoff && new Date(page.last_edited_time).getTime() <= cutoff) continue;
                pages.push(this.extractPageMeta(page));
            }

            startCursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;

            if (pageCount >= MAX_PAGES) {
                console.warn(`${this.logPrefix} searchPages hit max pages (${MAX_PAGES})`);
                break;
            }
        } while (startCursor);

        return pages;
    }

    /**
     * Get full markdown content of a page by converting its blocks recursively.
     */
    async getPageContent(pageId: string): Promise<string> {
        const lines = await this.fetchBlocks(pageId, 0);
        return lines.join('\n');
    }

    /**
     * Get metadata for a single page.
     */
    async getPageMeta(pageId: string): Promise<NotionPageMeta> {
        const page = await this.throttledCall(() =>
            this.client.pages.retrieve({ page_id: pageId }),
        );
        return this.extractPageMeta(page as any);
    }

    /**
     * Get metadata for a database.
     */
    async getDatabaseMeta(databaseId: string): Promise<NotionDatabaseMeta> {
        const db = await this.throttledCall(() =>
            this.client.databases.retrieve({ database_id: databaseId }),
        ) as any;

        const titleParts = db.title ?? [];
        const title = titleParts.map((t: any) => t.plain_text).join('');
        const propertyNames = Object.keys(db.properties ?? {});

        return {
            id: db.id,
            title,
            url: db.url ?? '',
            propertyNames,
        };
    }

    /**
     * Query a database for pages. Optionally filter to pages edited after a timestamp.
     */
    async queryDatabase(databaseId: string, editedAfter?: string): Promise<NotionPageMeta[]> {
        const pages: NotionPageMeta[] = [];
        let startCursor: string | undefined;
        let pageCount = 0;
        const cutoff = editedAfter ? new Date(editedAfter).getTime() : 0;

        do {
            pageCount++;
            const response: any = await this.throttledCall(() =>
                (this.client.databases as any).query({
                    database_id: databaseId,
                    start_cursor: startCursor,
                    page_size: 100,
                }),
            );

            for (const result of response.results) {
                const page = result as any;
                if (cutoff && new Date(page.last_edited_time).getTime() <= cutoff) continue;
                pages.push(this.extractPageMeta(page));
            }

            startCursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;

            if (pageCount >= MAX_PAGES) {
                console.warn(`${this.logPrefix} queryDatabase hit max pages (${MAX_PAGES})`);
                break;
            }
        } while (startCursor);

        return pages;
    }

    /**
     * Resolve a Notion user ID to a display name. Caches results.
     */
    async resolveUser(userId: string): Promise<string> {
        const cached = this.userCache.get(userId);
        if (cached) return cached;

        try {
            const user = await this.throttledCall(() =>
                this.client.users.retrieve({ user_id: userId }),
            ) as any;
            const name = user.name ?? 'Unknown User';
            this.userCache.set(userId, name);
            return name;
        } catch {
            const fallback = 'Unknown User';
            this.userCache.set(userId, fallback);
            return fallback;
        }
    }

    /**
     * Serialize a Notion properties object to a Record<string, string>.
     * Unsupported property types are omitted.
     */
    serializeProperties(properties: any): Record<string, string> {
        const result: Record<string, string> = {};

        for (const [key, prop] of Object.entries(properties)) {
            const value = this.serializeProperty(prop as any);
            if (value !== null) {
                result[key] = value;
            }
        }

        return result;
    }

    // ── Private: block fetching & conversion ────────────────────────────────

    /**
     * Fetch all blocks for a parent and convert to markdown lines.
     */
    private async fetchBlocks(parentId: string, depth: number, indent: string = ''): Promise<string[]> {
        if (depth >= this.maxDepth) return [];

        const blocks = await this.paginateBlockChildren(parentId);
        const lines: string[] = [];

        for (const blk of blocks) {
            const converted = this.convertBlock(blk, indent);
            if (converted !== null) {
                lines.push(converted);
            }

            // Recurse into children if the block has them
            if (blk.has_children) {
                const childIndent = this.getChildIndent(blk.type, indent);
                const childLines = await this.fetchBlocks(blk.id, depth + 1, childIndent);

                // Special handling for table blocks — render as markdown table
                if (blk.type === 'table') {
                    const tableLines = this.renderTable(blk, childLines, blocks);
                    lines.push(...tableLines);
                } else {
                    lines.push(...childLines);
                }
            }
        }

        return lines;
    }

    /**
     * Paginate through all children of a block.
     */
    private async paginateBlockChildren(blockId: string): Promise<any[]> {
        const blocks: any[] = [];
        let startCursor: string | undefined;
        let pageCount = 0;

        do {
            pageCount++;
            const response = await this.throttledCall(() =>
                this.client.blocks.children.list({
                    block_id: blockId,
                    start_cursor: startCursor,
                    page_size: 100,
                }),
            );

            blocks.push(...response.results);
            startCursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;

            if (pageCount >= MAX_PAGES) {
                console.warn(`${this.logPrefix} paginateBlockChildren hit max pages (${MAX_PAGES})`);
                break;
            }
        } while (startCursor);

        return blocks;
    }

    /**
     * Convert a single block to a markdown string. Returns null for unsupported types.
     */
    private convertBlock(blk: any, indent: string): string | null {
        const type = blk.type;
        const data = blk[type];

        switch (type) {
            case 'paragraph':
                return `${indent}${this.renderRichText(data.rich_text)}`;

            case 'heading_1':
                return `# ${this.renderRichText(data.rich_text)}`;
            case 'heading_2':
                return `## ${this.renderRichText(data.rich_text)}`;
            case 'heading_3':
                return `### ${this.renderRichText(data.rich_text)}`;

            case 'bulleted_list_item':
                return `${indent}- ${this.renderRichText(data.rich_text)}`;
            case 'numbered_list_item':
                return `${indent}1. ${this.renderRichText(data.rich_text)}`;

            case 'to_do':
                return `${indent}- [${data.checked ? 'x' : ' '}] ${this.renderRichText(data.rich_text)}`;

            case 'toggle':
                return `${indent}**${this.renderRichText(data.rich_text)}**`;

            case 'quote':
                return `${indent}> ${this.renderRichText(data.rich_text)}`;

            case 'callout': {
                const icon = data.icon?.emoji ?? data.icon?.external?.url ?? '';
                return `${indent}> **${icon}** ${this.renderRichText(data.rich_text)}`;
            }

            case 'code':
                return `${indent}\`\`\`${data.language ?? ''}\n${this.renderRichText(data.rich_text)}\n\`\`\``;

            case 'divider':
                return `${indent}---`;

            case 'image': {
                const imgUrl = data.type === 'external' ? data.external?.url : data.file?.url;
                const caption = data.caption ? this.renderRichText(data.caption) : '';
                return `${indent}![${caption}](${imgUrl ?? ''})`;
            }

            case 'bookmark': {
                const bmCaption = data.caption ? this.renderRichText(data.caption) : data.url;
                return `${indent}[${bmCaption}](${data.url})`;
            }

            case 'equation':
                return `${indent}$$${data.expression}$$`;

            case 'child_page':
                return `${indent}[Page: ${data.title}]`;

            case 'child_database':
                return `${indent}[Database: ${data.title}]`;

            // Table is handled specially — its text comes from child rows
            case 'table':
                return null;

            // Table rows are rendered by the table handler
            case 'table_row': {
                const cells = (data.cells ?? []).map((cell: any[]) => this.renderRichText(cell));
                return `| ${cells.join(' | ')} |`;
            }

            // Transparent containers — just recurse children (handled by fetchBlocks)
            case 'synced_block':
            case 'column_list':
            case 'column':
                return null;

            default:
                // Silently skip unsupported block types
                return null;
        }
    }

    /**
     * Render a Notion table from its child table_row lines.
     */
    private renderTable(tableBlock: any, childLines: string[], _allBlocks: any[]): string[] {
        const lines: string[] = [];
        const hasHeader = tableBlock.table?.has_column_header ?? false;

        for (let i = 0; i < childLines.length; i++) {
            lines.push(childLines[i]);
            // Insert separator after header row
            if (i === 0 && hasHeader) {
                const colCount = tableBlock.table?.table_width ?? 2;
                const separator = `| ${Array(colCount).fill('---').join(' | ')} |`;
                lines.push(separator);
            }
        }

        return lines;
    }

    /**
     * Determine child indentation based on block type.
     */
    private getChildIndent(blockType: string, currentIndent: string): string {
        if (blockType === 'bulleted_list_item' || blockType === 'numbered_list_item') {
            return currentIndent + '  ';
        }
        return currentIndent;
    }

    // ── Private: rich text rendering ────────────────────────────────────────

    /**
     * Concatenate rich text segments, wrapping linked segments as [text](url).
     */
    private renderRichText(richText: any[]): string {
        if (!richText || !Array.isArray(richText)) return '';
        return richText.map(segment => {
            const text = segment.plain_text ?? '';
            if (segment.href) {
                return `[${text}](${segment.href})`;
            }
            return text;
        }).join('');
    }

    // ── Private: property serialization ─────────────────────────────────────

    /**
     * Serialize a single Notion property to a string. Returns null for unsupported types.
     */
    private serializeProperty(prop: any): string | null {
        switch (prop.type) {
            case 'title':
                return this.renderRichText(prop.title);
            case 'rich_text':
                return this.renderRichText(prop.rich_text);
            case 'number':
                return prop.number != null ? String(prop.number) : null;
            case 'select':
                return prop.select?.name ?? null;
            case 'multi_select':
                return (prop.multi_select ?? []).map((s: any) => s.name).join(', ') || null;
            case 'date': {
                if (!prop.date) return null;
                const { start, end } = prop.date;
                return end ? `${start} → ${end}` : start;
            }
            case 'checkbox':
                return String(prop.checkbox);
            case 'url':
                return prop.url ?? null;
            case 'email':
                return prop.email ?? null;
            case 'phone_number':
                return prop.phone_number ?? null;
            case 'status':
                return prop.status?.name ?? null;
            case 'people':
                return (prop.people ?? []).map((p: any) => p.name).join(', ') || null;
            case 'created_time':
                return prop.created_time ?? null;
            case 'last_edited_time':
                return prop.last_edited_time ?? null;
            case 'files':
                return (prop.files ?? []).map((f: any) => {
                    if (f.type === 'external') return f.external?.url;
                    if (f.type === 'file') return f.file?.url;
                    return null;
                }).filter(Boolean).join(', ') || null;
            default:
                // formula, rollup, relation, created_by, last_edited_by, etc.
                return null;
        }
    }

    // ── Private: page metadata extraction ───────────────────────────────────

    /**
     * Extract NotionPageMeta from a Notion page object.
     */
    private extractPageMeta(page: any): NotionPageMeta {
        const parentRaw = page.parent ?? {};
        let parentType: NotionPageMeta['parentType'] = 'workspace';
        let parentId: string | null = null;

        if (parentRaw.type === 'page_id') {
            parentType = 'page';
            parentId = parentRaw.page_id;
        } else if (parentRaw.type === 'database_id') {
            parentType = 'database';
            parentId = parentRaw.database_id;
        }

        // Extract title from properties
        const title = this.extractTitle(page.properties);

        // Serialize database entry properties for YAML frontmatter
        const properties = parentType === 'database'
            ? this.serializeProperties(page.properties)
            : undefined;

        return {
            id: page.id,
            title,
            lastEditedTime: page.last_edited_time,
            url: page.url ?? '',
            parentType,
            parentId,
            properties,
        };
    }

    /**
     * Extract the title string from a Notion page's properties object.
     * Looks for any property of type "title".
     */
    private extractTitle(properties: any): string {
        if (!properties) return '';
        for (const prop of Object.values(properties)) {
            const p = prop as any;
            if (p.type === 'title' && Array.isArray(p.title)) {
                return this.renderRichText(p.title);
            }
        }
        return '';
    }

    // ── Private: throttled API calls ────────────────────────────────────────

    /**
     * Execute an API call with self-throttling to respect Notion's rate limit.
     */
    private async throttledCall<T>(fn: () => Promise<T>): Promise<T> {
        const now = Date.now();
        const elapsed = now - this.lastRequestTime;
        if (elapsed < this.minRequestInterval) {
            await sleep(this.minRequestInterval - elapsed);
        }
        this.lastRequestTime = Date.now();
        return fn();
    }
}
