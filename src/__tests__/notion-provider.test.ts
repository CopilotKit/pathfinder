// Tests for NotionDataProvider — page discovery, content acquisition, deletion detection.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NotionPageMeta } from '../indexing/providers/notion-api.js';
import type { SourceConfig } from '../types.js';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockSearchPages = vi.fn();
const mockGetPageContent = vi.fn();
const mockGetPageMeta = vi.fn();
const mockQueryDatabase = vi.fn();

vi.mock('../indexing/providers/notion-api.js', () => ({
    NotionApiClient: class {
        searchPages = mockSearchPages;
        getPageContent = mockGetPageContent;
        getPageMeta = mockGetPageMeta;
        queryDatabase = mockQueryDatabase;
        constructor(_token: string) {}
    },
}));

const mockGetIndexedItemIds = vi.fn();
vi.mock('../db/queries.js', () => ({
    getIndexedItemIds: (...args: unknown[]) => mockGetIndexedItemIds(...args),
}));

vi.mock('../config.js', () => ({
    getConfig: () => ({ openaiApiKey: 'test-key' }),
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

function makePage(
    id: string,
    title: string,
    time: string,
    parentType: 'workspace' | 'page' | 'database' = 'workspace',
    properties?: Record<string, string>,
): NotionPageMeta {
    return {
        id,
        title,
        lastEditedTime: time,
        url: `https://notion.so/${id}`,
        parentType,
        parentId: null,
        properties,
    };
}

function makeConfig(overrides: Partial<SourceConfig & { type: 'notion' }> = {}): SourceConfig {
    return {
        type: 'notion',
        name: 'test-notion',
        chunk: { target_tokens: 500 },
        root_pages: [],
        databases: [],
        max_depth: 5,
        include_properties: true,
        ...overrides,
    } as SourceConfig;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('NotionDataProvider', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetIndexedItemIds.mockResolvedValue(new Set());
    });

    async function createProvider(config?: SourceConfig, token?: string) {
        const { NotionDataProvider } = await import('../indexing/providers/notion.js');
        return new NotionDataProvider(config ?? makeConfig(), { cloneDir: '/tmp', notionToken: token ?? 'test-token' });
    }

    // ── Constructor validation ──────────────────────────────────────────

    it('throws if config.type is not notion', async () => {
        const { NotionDataProvider } = await import('../indexing/providers/notion.js');
        expect(() => new NotionDataProvider(
            { type: 'markdown', name: 'x', chunk: { target_tokens: 500 }, path: '.', file_patterns: ['*.md'] } as SourceConfig,
            { cloneDir: '/tmp', notionToken: 'tok' },
        )).toThrow('NotionDataProvider requires a notion source config');
    });

    it('throws if notionToken is missing', async () => {
        const { NotionDataProvider } = await import('../indexing/providers/notion.js');
        expect(() => new NotionDataProvider(
            makeConfig(),
            { cloneDir: '/tmp' },
        )).toThrow('notionToken');
    });

    // ── fullAcquire ─────────────────────────────────────────────────────

    it('fullAcquire with search-all mode (no root_pages/databases)', async () => {
        const pages = [
            makePage('p1', 'Page One', '2025-01-01T00:00:00Z'),
            makePage('p2', 'Page Two', '2025-01-02T00:00:00Z'),
        ];
        mockSearchPages.mockResolvedValue(pages);
        mockGetPageContent.mockImplementation(async (id: string) =>
            id === 'p1' ? '# Page One\nContent' : '# Page Two\nMore content',
        );

        const provider = await createProvider();
        const result = await provider.fullAcquire();

        expect(result.items).toHaveLength(2);
        expect(result.items[0].id).toBe('p1');
        expect(result.items[0].title).toBe('Page One');
        expect(result.items[0].content).toBe('# Page One\nContent');
        expect(result.items[0].sourceUrl).toBe('https://notion.so/p1');
        expect(result.items[1].id).toBe('p2');
        expect(result.removedIds).toEqual([]);
        expect(result.stateToken).toBe('2025-01-02T00:00:00Z');
    });

    it('fullAcquire with databases (property header prepended)', async () => {
        const pages = [
            makePage('dp1', 'DB Page', '2025-03-01T00:00:00Z', 'database', {
                title: 'DB Page',
                Status: 'Done',
                Priority: 'High',
            }),
        ];
        mockQueryDatabase.mockResolvedValue(pages);
        mockGetPageContent.mockResolvedValue('Some content');

        const provider = await createProvider(makeConfig({ databases: ['db1'] }));
        const result = await provider.fullAcquire();

        expect(result.items).toHaveLength(1);
        // Should have YAML frontmatter with Status and Priority, but not title
        expect(result.items[0].content).toContain('---');
        expect(result.items[0].content).toContain('Status: Done');
        expect(result.items[0].content).toContain('Priority: High');
        expect(result.items[0].content).not.toMatch(/^---\n.*title:/m);
        expect(result.items[0].content).toContain('Some content');
    });

    it('fullAcquire with include_properties=false (no header)', async () => {
        const pages = [
            makePage('dp1', 'DB Page', '2025-03-01T00:00:00Z', 'database', {
                title: 'DB Page',
                Status: 'Done',
            }),
        ];
        mockQueryDatabase.mockResolvedValue(pages);
        mockGetPageContent.mockResolvedValue('Some content');

        const provider = await createProvider(makeConfig({ databases: ['db1'], include_properties: false }));
        const result = await provider.fullAcquire();

        expect(result.items).toHaveLength(1);
        expect(result.items[0].content).toBe('Some content');
        expect(result.items[0].content).not.toContain('---');
    });

    it('fullAcquire with root_pages', async () => {
        const page = makePage('rp1', 'Root Page', '2025-02-01T00:00:00Z');
        mockGetPageMeta.mockResolvedValue(page);
        mockGetPageContent.mockResolvedValue('Root content');

        const provider = await createProvider(makeConfig({ root_pages: ['rp1'] }));
        const result = await provider.fullAcquire();

        expect(mockGetPageMeta).toHaveBeenCalledWith('rp1');
        expect(result.items).toHaveLength(1);
        expect(result.items[0].id).toBe('rp1');
        expect(result.items[0].content).toBe('Root content');
    });

    it('fullAcquire deduplicates pages in both root_pages and database', async () => {
        const page = makePage('dup1', 'Shared Page', '2025-04-01T00:00:00Z');
        mockGetPageMeta.mockResolvedValue(page);
        mockQueryDatabase.mockResolvedValue([page]);
        mockGetPageContent.mockResolvedValue('Content');

        const provider = await createProvider(makeConfig({ root_pages: ['dup1'], databases: ['db1'] }));
        const result = await provider.fullAcquire();

        // Should only appear once despite being in both root_pages and database
        expect(result.items).toHaveLength(1);
        expect(result.items[0].id).toBe('dup1');
    });

    // ── incrementalAcquire ──────────────────────────────────────────────

    it('incrementalAcquire filters to recently edited pages', async () => {
        const oldPage = makePage('old1', 'Old', '2025-01-01T00:00:00Z');
        const newPage = makePage('new1', 'New', '2025-06-01T00:00:00Z');
        // discoverAllPages returns both
        mockSearchPages.mockResolvedValueOnce([oldPage, newPage]);
        // discoverEditedPages returns only new
        mockSearchPages.mockResolvedValueOnce([newPage]);
        mockGetPageContent.mockResolvedValue('New content');

        const provider = await createProvider();
        const result = await provider.incrementalAcquire('2025-03-01T00:00:00Z');

        // Only the new page should have content acquired
        expect(result.items).toHaveLength(1);
        expect(result.items[0].id).toBe('new1');
    });

    it('incrementalAcquire detects deleted pages via removedIds', async () => {
        // Full discovery returns only p2 (p1 was deleted)
        mockSearchPages.mockResolvedValueOnce([makePage('p2', 'Two', '2025-06-01T00:00:00Z')]);
        // Edited pages returns p2
        mockSearchPages.mockResolvedValueOnce([makePage('p2', 'Two', '2025-06-01T00:00:00Z')]);
        mockGetPageContent.mockResolvedValue('Content');
        // DB has both p1 and p2 indexed
        mockGetIndexedItemIds.mockResolvedValue(new Set(['p1', 'p2']));

        const provider = await createProvider();
        const result = await provider.incrementalAcquire('2025-03-01T00:00:00Z');

        expect(result.removedIds).toContain('p1');
        expect(result.removedIds).not.toContain('p2');
    });

    it('incrementalAcquire returns early when no changes', async () => {
        const page = makePage('p1', 'One', '2025-01-01T00:00:00Z');
        // Full discover returns p1
        mockSearchPages.mockResolvedValueOnce([page]);
        // Edited pages returns empty (nothing changed)
        mockSearchPages.mockResolvedValueOnce([]);
        // DB has p1 indexed
        mockGetIndexedItemIds.mockResolvedValue(new Set(['p1']));

        const provider = await createProvider();
        const result = await provider.incrementalAcquire('2025-03-01T00:00:00Z');

        expect(result.items).toHaveLength(0);
        expect(result.removedIds).toHaveLength(0);
        expect(result.stateToken).toBe('2025-03-01T00:00:00Z');
        // Should not have called getPageContent at all
        expect(mockGetPageContent).not.toHaveBeenCalled();
    });

    // ── getCurrentStateToken ────────────────────────────────────────────

    it('getCurrentStateToken returns latest timestamp', async () => {
        mockSearchPages.mockResolvedValue([
            makePage('p1', 'One', '2025-01-01T00:00:00Z'),
            makePage('p2', 'Two', '2025-06-15T12:00:00Z'),
            makePage('p3', 'Three', '2025-03-01T00:00:00Z'),
        ]);

        const provider = await createProvider();
        const token = await provider.getCurrentStateToken();

        expect(token).toBe('2025-06-15T12:00:00Z');
    });

    it('getCurrentStateToken returns null when empty', async () => {
        mockSearchPages.mockResolvedValue([]);

        const provider = await createProvider();
        const token = await provider.getCurrentStateToken();

        expect(token).toBeNull();
    });

    // ── Error handling ──────────────────────────────────────────────────

    it('partial failure: continues when individual page fails', async () => {
        mockSearchPages.mockResolvedValue([
            makePage('p1', 'One', '2025-01-01T00:00:00Z'),
            makePage('p2', 'Two', '2025-01-02T00:00:00Z'),
        ]);
        mockGetPageContent.mockImplementation(async (id: string) => {
            if (id === 'p1') throw new Error('API error');
            return 'Content for p2';
        });

        const provider = await createProvider();
        const result = await provider.fullAcquire();

        // p1 failed, p2 succeeded
        expect(result.items).toHaveLength(1);
        expect(result.items[0].id).toBe('p2');
    });

    it('all pages fail: throws', async () => {
        mockSearchPages.mockResolvedValue([
            makePage('p1', 'One', '2025-01-01T00:00:00Z'),
            makePage('p2', 'Two', '2025-01-02T00:00:00Z'),
        ]);
        mockGetPageContent.mockRejectedValue(new Error('API error'));

        const provider = await createProvider();
        await expect(provider.fullAcquire()).rejects.toThrow('All 2 page(s) failed');
    });

    it('empty page: indexed with title-only content', async () => {
        mockSearchPages.mockResolvedValue([
            makePage('p1', 'Empty Page', '2025-01-01T00:00:00Z'),
        ]);
        mockGetPageContent.mockResolvedValue('');

        const provider = await createProvider();
        const result = await provider.fullAcquire();

        expect(result.items).toHaveLength(1);
        expect(result.items[0].content).toBe('# Empty Page');
    });
});
