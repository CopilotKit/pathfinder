import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @notionhq/client before importing the module under test
const mockSearch = vi.fn();
const mockPagesRetrieve = vi.fn();
const mockBlocksChildrenList = vi.fn();
const mockDatabasesRetrieve = vi.fn();
const mockDatabasesQuery = vi.fn();
const mockUsersRetrieve = vi.fn();

vi.mock('@notionhq/client', () => ({
    Client: class MockClient {
        search = mockSearch;
        pages = { retrieve: mockPagesRetrieve };
        blocks = { children: { list: mockBlocksChildrenList } };
        databases = { retrieve: mockDatabasesRetrieve, query: mockDatabasesQuery };
        users = { retrieve: mockUsersRetrieve };
        constructor(_opts: any) {}
    },
}));

import { NotionApiClient, type NotionPageMeta, type NotionDatabaseMeta } from '../indexing/providers/notion-api.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal Notion rich-text array. */
function richText(text: string, link?: string): any[] {
    return [{
        type: 'text',
        plain_text: text,
        href: link ?? null,
    }];
}

/** Build a block object for mockBlocksChildrenList. */
function block(type: string, extra: Record<string, any> = {}, hasChildren = false): any {
    return { id: `blk-${Math.random().toString(36).slice(2, 8)}`, type, has_children: hasChildren, ...extra };
}

/** Wrap blocks in a paginated response (single page). */
function blocksResponse(blocks: any[], hasMore = false, nextCursor: string | null = null) {
    return { results: blocks, has_more: hasMore, next_cursor: nextCursor };
}

/** Build a Notion page object for search/retrieve responses. */
function notionPage(id: string, title: string, lastEdited: string, parentType: 'workspace' | 'page_id' | 'database_id' = 'workspace', parentId?: string): any {
    const parent: any =
        parentType === 'workspace' ? { type: 'workspace', workspace: true } :
        parentType === 'page_id' ? { type: 'page_id', page_id: parentId } :
        { type: 'database_id', database_id: parentId };
    return {
        object: 'page',
        id,
        url: `https://www.notion.so/${id.replace(/-/g, '')}`,
        last_edited_time: lastEdited,
        parent,
        properties: {
            title: { type: 'title', title: richText(title) },
        },
    };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('NotionApiClient', () => {
    let client: NotionApiClient;

    beforeEach(() => {
        vi.clearAllMocks();
        // Disable real timers/delays — we stub the throttle internally via setting minDelay to 0
        client = new NotionApiClient('test-token', { minRequestInterval: 0 });
    });

    // ── Block-to-markdown conversion ────────────────────────────────────────

    describe('block-to-markdown', () => {
        it('converts paragraph to plain text', async () => {
            mockBlocksChildrenList.mockResolvedValueOnce(blocksResponse([
                block('paragraph', { paragraph: { rich_text: richText('Hello world') } }),
            ]));
            const md = await client.getPageContent('page-1');
            expect(md).toContain('Hello world');
        });

        it('converts heading_1 to # text', async () => {
            mockBlocksChildrenList.mockResolvedValueOnce(blocksResponse([
                block('heading_1', { heading_1: { rich_text: richText('Title') } }),
            ]));
            const md = await client.getPageContent('page-1');
            expect(md).toContain('# Title');
        });

        it('converts heading_2 to ## text', async () => {
            mockBlocksChildrenList.mockResolvedValueOnce(blocksResponse([
                block('heading_2', { heading_2: { rich_text: richText('Subtitle') } }),
            ]));
            const md = await client.getPageContent('page-1');
            expect(md).toContain('## Subtitle');
        });

        it('converts heading_3 to ### text', async () => {
            mockBlocksChildrenList.mockResolvedValueOnce(blocksResponse([
                block('heading_3', { heading_3: { rich_text: richText('Section') } }),
            ]));
            const md = await client.getPageContent('page-1');
            expect(md).toContain('### Section');
        });

        it('converts bulleted_list_item to - text', async () => {
            mockBlocksChildrenList.mockResolvedValueOnce(blocksResponse([
                block('bulleted_list_item', { bulleted_list_item: { rich_text: richText('Bullet point') } }),
            ]));
            const md = await client.getPageContent('page-1');
            expect(md).toContain('- Bullet point');
        });

        it('converts numbered_list_item to 1. text', async () => {
            mockBlocksChildrenList.mockResolvedValueOnce(blocksResponse([
                block('numbered_list_item', { numbered_list_item: { rich_text: richText('First item') } }),
            ]));
            const md = await client.getPageContent('page-1');
            expect(md).toContain('1. First item');
        });

        it('converts to_do (checked) to - [x] text', async () => {
            mockBlocksChildrenList.mockResolvedValueOnce(blocksResponse([
                block('to_do', { to_do: { rich_text: richText('Done task'), checked: true } }),
            ]));
            const md = await client.getPageContent('page-1');
            expect(md).toContain('- [x] Done task');
        });

        it('converts to_do (unchecked) to - [ ] text', async () => {
            mockBlocksChildrenList.mockResolvedValueOnce(blocksResponse([
                block('to_do', { to_do: { rich_text: richText('Open task'), checked: false } }),
            ]));
            const md = await client.getPageContent('page-1');
            expect(md).toContain('- [ ] Open task');
        });

        it('converts quote to > text', async () => {
            mockBlocksChildrenList.mockResolvedValueOnce(blocksResponse([
                block('quote', { quote: { rich_text: richText('A wise saying') } }),
            ]));
            const md = await client.getPageContent('page-1');
            expect(md).toContain('> A wise saying');
        });

        it('converts callout to > **icon** text', async () => {
            mockBlocksChildrenList.mockResolvedValueOnce(blocksResponse([
                block('callout', { callout: { rich_text: richText('Important note'), icon: { type: 'emoji', emoji: '💡' } } }),
            ]));
            const md = await client.getPageContent('page-1');
            expect(md).toContain('> **💡** Important note');
        });

        it('converts callout with no icon', async () => {
            mockBlocksChildrenList.mockResolvedValueOnce(blocksResponse([
                block('callout', { callout: { rich_text: richText('No icon callout'), icon: null } }),
            ]));
            const md = await client.getPageContent('page-1');
            expect(md).toContain('> **** No icon callout');
        });

        it('converts code block with language', async () => {
            mockBlocksChildrenList.mockResolvedValueOnce(blocksResponse([
                block('code', { code: { rich_text: richText('const x = 1;'), language: 'typescript' } }),
            ]));
            const md = await client.getPageContent('page-1');
            expect(md).toContain('```typescript\nconst x = 1;\n```');
        });

        it('converts divider to ---', async () => {
            mockBlocksChildrenList.mockResolvedValueOnce(blocksResponse([
                block('divider', { divider: {} }),
            ]));
            const md = await client.getPageContent('page-1');
            expect(md).toContain('---');
        });

        it('converts bookmark to [caption](url)', async () => {
            mockBlocksChildrenList.mockResolvedValueOnce(blocksResponse([
                block('bookmark', { bookmark: { url: 'https://example.com', caption: richText('Example') } }),
            ]));
            const md = await client.getPageContent('page-1');
            expect(md).toContain('[Example](https://example.com)');
        });

        it('converts bookmark with no caption to [url](url)', async () => {
            mockBlocksChildrenList.mockResolvedValueOnce(blocksResponse([
                block('bookmark', { bookmark: { url: 'https://example.com' } }),
            ]));
            const md = await client.getPageContent('page-1');
            expect(md).toContain('[https://example.com](https://example.com)');
        });

        it('converts equation to $$expression$$', async () => {
            mockBlocksChildrenList.mockResolvedValueOnce(blocksResponse([
                block('equation', { equation: { expression: 'E = mc^2' } }),
            ]));
            const md = await client.getPageContent('page-1');
            expect(md).toContain('$$E = mc^2$$');
        });

        it('converts image with file URL', async () => {
            mockBlocksChildrenList.mockResolvedValueOnce(blocksResponse([
                block('image', { image: { type: 'file', file: { url: 'https://s3.aws.com/notion/pic.png' }, caption: richText('Uploaded pic') } }),
            ]));
            const md = await client.getPageContent('page-1');
            expect(md).toContain('![Uploaded pic](https://s3.aws.com/notion/pic.png)');
        });

        it('converts image with external URL', async () => {
            mockBlocksChildrenList.mockResolvedValueOnce(blocksResponse([
                block('image', { image: { type: 'external', external: { url: 'https://img.com/pic.png' }, caption: richText('A picture') } }),
            ]));
            const md = await client.getPageContent('page-1');
            expect(md).toContain('![A picture](https://img.com/pic.png)');
        });

        it('converts child_page to [Page: title]', async () => {
            mockBlocksChildrenList.mockResolvedValueOnce(blocksResponse([
                block('child_page', { child_page: { title: 'Sub Page' } }),
            ]));
            const md = await client.getPageContent('page-1');
            expect(md).toContain('[Page: Sub Page]');
        });

        it('converts child_database to [Database: title]', async () => {
            mockBlocksChildrenList.mockResolvedValueOnce(blocksResponse([
                block('child_database', { child_database: { title: 'My DB' } }),
            ]));
            const md = await client.getPageContent('page-1');
            expect(md).toContain('[Database: My DB]');
        });

        it('silently skips unsupported block types', async () => {
            mockBlocksChildrenList.mockResolvedValueOnce(blocksResponse([
                block('paragraph', { paragraph: { rich_text: richText('Before') } }),
                block('unsupported', { unsupported: {} }),
                block('paragraph', { paragraph: { rich_text: richText('After') } }),
            ]));
            const md = await client.getPageContent('page-1');
            expect(md).toContain('Before');
            expect(md).toContain('After');
            expect(md).not.toContain('unsupported');
        });

        it('renders rich text with links as [text](url)', async () => {
            mockBlocksChildrenList.mockResolvedValueOnce(blocksResponse([
                block('paragraph', { paragraph: { rich_text: [
                    { type: 'text', plain_text: 'Click ', href: null },
                    { type: 'text', plain_text: 'here', href: 'https://example.com' },
                    { type: 'text', plain_text: ' to continue', href: null },
                ] } }),
            ]));
            const md = await client.getPageContent('page-1');
            expect(md).toContain('Click [here](https://example.com) to continue');
        });

        it('converts table blocks to markdown table', async () => {
            const tableBlock = block('table', {
                table: { has_column_header: true, has_row_header: false, table_width: 2 },
            }, true);
            mockBlocksChildrenList
                .mockResolvedValueOnce(blocksResponse([tableBlock]))
                // Children of the table block (rows)
                .mockResolvedValueOnce(blocksResponse([
                    block('table_row', { table_row: { cells: [richText('Header A'), richText('Header B')] } }),
                    block('table_row', { table_row: { cells: [richText('Cell 1'), richText('Cell 2')] } }),
                ]));
            const md = await client.getPageContent('page-1');
            expect(md).toContain('| Header A | Header B |');
            expect(md).toContain('| --- | --- |');
            expect(md).toContain('| Cell 1 | Cell 2 |');
        });

        it('converts table without column header (no separator row)', async () => {
            const tableBlock = block('table', {
                table: { has_column_header: false, has_row_header: false, table_width: 2 },
            }, true);
            mockBlocksChildrenList
                .mockResolvedValueOnce(blocksResponse([tableBlock]))
                .mockResolvedValueOnce(blocksResponse([
                    block('table_row', { table_row: { cells: [richText('A1'), richText('B1')] } }),
                    block('table_row', { table_row: { cells: [richText('A2'), richText('B2')] } }),
                ]));
            const md = await client.getPageContent('page-1');
            expect(md).toContain('| A1 | B1 |');
            expect(md).toContain('| A2 | B2 |');
            expect(md).not.toContain('| --- | --- |');
        });
    });

    // ── Pagination ──────────────────────────────────────────────────────────

    describe('pagination', () => {
        it('paginates block children with has_more + next_cursor', async () => {
            mockBlocksChildrenList
                .mockResolvedValueOnce(blocksResponse(
                    [block('paragraph', { paragraph: { rich_text: richText('Page 1') } })],
                    true, 'cursor-2',
                ))
                .mockResolvedValueOnce(blocksResponse(
                    [block('paragraph', { paragraph: { rich_text: richText('Page 2') } })],
                    false, null,
                ));
            const md = await client.getPageContent('page-1');
            expect(md).toContain('Page 1');
            expect(md).toContain('Page 2');
            expect(mockBlocksChildrenList).toHaveBeenCalledTimes(2);
        });
    });

    // ── Recursion ───────────────────────────────────────────────────────────

    describe('recursion', () => {
        it('recurses into child blocks (toggle with children)', async () => {
            const toggleBlock = block('toggle', {
                toggle: { rich_text: richText('Toggle title') },
            }, true);

            mockBlocksChildrenList
                // Top-level blocks
                .mockResolvedValueOnce(blocksResponse([toggleBlock]))
                // Children of toggle
                .mockResolvedValueOnce(blocksResponse([
                    block('paragraph', { paragraph: { rich_text: richText('Inside toggle') } }),
                ]));

            const md = await client.getPageContent('page-1');
            expect(md).toContain('**Toggle title**');
            expect(md).toContain('Inside toggle');
        });

        it('respects max recursion depth', async () => {
            // Build a chain of deeply nested toggles (depth 12)
            // Each level returns a toggle with has_children=true
            for (let i = 0; i < 12; i++) {
                const nestedToggle = block('toggle', {
                    toggle: { rich_text: richText(`Level ${i}`) },
                }, true);
                mockBlocksChildrenList.mockResolvedValueOnce(blocksResponse([nestedToggle]));
            }
            // Final level — should not be reached (depth 10 cap)
            mockBlocksChildrenList.mockResolvedValueOnce(blocksResponse([
                block('paragraph', { paragraph: { rich_text: richText('Too deep') } }),
            ]));

            const md = await client.getPageContent('page-1');
            // Depth 0-9 should be present (10 levels), depth 10+ should not
            expect(md).toContain('Level 0');
            expect(md).toContain('Level 9');
            // The block at depth 11 should not have its children fetched
            // (we allow the toggle text at level 10 but don't recurse into it)
            expect(md).not.toContain('Too deep');
        });

        it('respects custom maxDepth from constructor options', async () => {
            const shallowClient = new NotionApiClient('test-token', { minRequestInterval: 0, maxDepth: 3 });
            mockBlocksChildrenList.mockReset();

            // Build a chain of deeply nested toggles (depth 5)
            for (let i = 0; i < 5; i++) {
                const nestedToggle = block('toggle', {
                    toggle: { rich_text: richText(`Level ${i}`) },
                }, true);
                mockBlocksChildrenList.mockResolvedValueOnce(blocksResponse([nestedToggle]));
            }
            mockBlocksChildrenList.mockResolvedValueOnce(blocksResponse([
                block('paragraph', { paragraph: { rich_text: richText('Too deep for shallow') } }),
            ]));

            const md = await shallowClient.getPageContent('page-1');
            // Depth 0-2 should be present (3 levels), depth 3+ should not recurse
            expect(md).toContain('Level 0');
            expect(md).toContain('Level 2');
            expect(md).not.toContain('Too deep for shallow');
        });
    });

    // ── searchPages ─────────────────────────────────────────────────────────

    describe('searchPages', () => {
        it('returns page metadata from search', async () => {
            mockSearch.mockResolvedValueOnce({
                results: [notionPage('p1', 'My Page', '2024-06-01T00:00:00Z')],
                has_more: false,
                next_cursor: null,
            });

            const pages = await client.searchPages();
            expect(pages).toHaveLength(1);
            expect(pages[0].id).toBe('p1');
            expect(pages[0].title).toBe('My Page');
            expect(pages[0].lastEditedTime).toBe('2024-06-01T00:00:00Z');
            expect(pages[0].parentType).toBe('workspace');
        });

        it('paginates search results', async () => {
            mockSearch
                .mockResolvedValueOnce({
                    results: [notionPage('p1', 'Page 1', '2024-06-01T00:00:00Z')],
                    has_more: true,
                    next_cursor: 'cursor-2',
                })
                .mockResolvedValueOnce({
                    results: [notionPage('p2', 'Page 2', '2024-06-02T00:00:00Z')],
                    has_more: false,
                    next_cursor: null,
                });

            const pages = await client.searchPages();
            expect(pages).toHaveLength(2);
            expect(pages[0].id).toBe('p1');
            expect(pages[1].id).toBe('p2');
        });

        it('filters out database objects from search', async () => {
            mockSearch.mockResolvedValueOnce({
                results: [
                    notionPage('p1', 'A Page', '2024-06-01T00:00:00Z'),
                    { object: 'database', id: 'db1', title: [{ plain_text: 'A DB' }] },
                ],
                has_more: false,
                next_cursor: null,
            });

            const pages = await client.searchPages();
            expect(pages).toHaveLength(1);
            expect(pages[0].id).toBe('p1');
        });

        it('filters by editedAfter timestamp', async () => {
            mockSearch.mockResolvedValueOnce({
                results: [
                    notionPage('p1', 'Old Page', '2024-01-01T00:00:00Z'),
                    notionPage('p2', 'New Page', '2024-07-01T00:00:00Z'),
                ],
                has_more: false,
                next_cursor: null,
            });

            const pages = await client.searchPages('2024-06-01T00:00:00Z');
            expect(pages).toHaveLength(1);
            expect(pages[0].id).toBe('p2');
        });
    });

    // ── queryDatabase ───────────────────────────────────────────────────────

    describe('queryDatabase', () => {
        it('returns entries from a database', async () => {
            mockDatabasesQuery.mockResolvedValueOnce({
                results: [notionPage('p1', 'Entry 1', '2024-06-01T00:00:00Z', 'database_id', 'db1')],
                has_more: false,
                next_cursor: null,
            });

            const entries = await client.queryDatabase('db1');
            expect(entries).toHaveLength(1);
            expect(entries[0].id).toBe('p1');
            expect(entries[0].parentType).toBe('database');
        });

        it('filters entries by editedAfter', async () => {
            mockDatabasesQuery.mockResolvedValueOnce({
                results: [
                    notionPage('p1', 'Old', '2024-01-01T00:00:00Z', 'database_id', 'db1'),
                    notionPage('p2', 'New', '2024-07-01T00:00:00Z', 'database_id', 'db1'),
                ],
                has_more: false,
                next_cursor: null,
            });

            const entries = await client.queryDatabase('db1', '2024-06-01T00:00:00Z');
            expect(entries).toHaveLength(1);
            expect(entries[0].id).toBe('p2');
        });

        it('returns serialized properties for database entries', async () => {
            const dbPage = {
                object: 'page',
                id: 'dp1',
                url: 'https://www.notion.so/dp1',
                last_edited_time: '2024-06-01T00:00:00Z',
                parent: { type: 'database_id', database_id: 'db1' },
                properties: {
                    Name: { type: 'title', title: richText('Task Name') },
                    Status: { type: 'select', select: { name: 'In Progress' } },
                    Priority: { type: 'number', number: 3 },
                },
            };
            mockDatabasesQuery.mockResolvedValueOnce({
                results: [dbPage],
                has_more: false,
                next_cursor: null,
            });

            const entries = await client.queryDatabase('db1');
            expect(entries).toHaveLength(1);
            expect(entries[0].properties).toBeDefined();
            expect(entries[0].properties!['Name']).toBe('Task Name');
            expect(entries[0].properties!['Status']).toBe('In Progress');
            expect(entries[0].properties!['Priority']).toBe('3');
        });

        it('does not return properties for non-database pages', async () => {
            mockSearch.mockResolvedValueOnce({
                results: [notionPage('p1', 'Regular Page', '2024-06-01T00:00:00Z', 'workspace')],
                has_more: false,
                next_cursor: null,
            });

            const pages = await client.searchPages();
            expect(pages).toHaveLength(1);
            expect(pages[0].properties).toBeUndefined();
        });
    });

    // ── getPageMeta ─────────────────────────────────────────────────────────

    describe('getPageMeta', () => {
        it('returns page metadata from retrieve', async () => {
            mockPagesRetrieve.mockResolvedValueOnce(
                notionPage('p1', 'Retrieved Page', '2024-06-15T12:00:00Z', 'page_id', 'parent-1'),
            );

            const meta = await client.getPageMeta('p1');
            expect(meta.id).toBe('p1');
            expect(meta.title).toBe('Retrieved Page');
            expect(meta.parentType).toBe('page');
            expect(meta.parentId).toBe('parent-1');
        });
    });

    // ── getDatabaseMeta ─────────────────────────────────────────────────────

    describe('getDatabaseMeta', () => {
        it('returns database metadata', async () => {
            mockDatabasesRetrieve.mockResolvedValueOnce({
                id: 'db1',
                title: [{ plain_text: 'Projects DB' }],
                url: 'https://www.notion.so/db1',
                properties: {
                    Name: { id: 'prop1', type: 'title' },
                    Status: { id: 'prop2', type: 'select' },
                    Priority: { id: 'prop3', type: 'number' },
                },
            });

            const meta = await client.getDatabaseMeta('db1');
            expect(meta.id).toBe('db1');
            expect(meta.title).toBe('Projects DB');
            expect(meta.propertyNames).toEqual(expect.arrayContaining(['Name', 'Status', 'Priority']));
        });
    });

    // ── resolveUser ─────────────────────────────────────────────────────────

    describe('resolveUser', () => {
        it('resolves user name', async () => {
            mockUsersRetrieve.mockResolvedValueOnce({
                id: 'u1',
                name: 'Alice',
                type: 'person',
            });

            const name = await client.resolveUser('u1');
            expect(name).toBe('Alice');
        });

        it('caches user resolution', async () => {
            mockUsersRetrieve.mockResolvedValueOnce({
                id: 'u1',
                name: 'Alice',
                type: 'person',
            });

            await client.resolveUser('u1');
            const name = await client.resolveUser('u1');
            expect(name).toBe('Alice');
            expect(mockUsersRetrieve).toHaveBeenCalledTimes(1);
        });

        it('falls back to "Unknown User" on error', async () => {
            mockUsersRetrieve.mockRejectedValueOnce(new Error('Not found'));

            const name = await client.resolveUser('u-bad');
            expect(name).toBe('Unknown User');
        });
    });

    // ── serializeProperties ─────────────────────────────────────────────────

    describe('serializeProperties', () => {
        it('serializes title property', () => {
            const props = { Name: { type: 'title', title: richText('Hello') } };
            const result = client.serializeProperties(props);
            expect(result.Name).toBe('Hello');
        });

        it('serializes rich_text property', () => {
            const props = { Description: { type: 'rich_text', rich_text: richText('Some text') } };
            const result = client.serializeProperties(props);
            expect(result.Description).toBe('Some text');
        });

        it('serializes number property', () => {
            const props = { Count: { type: 'number', number: 42 } };
            const result = client.serializeProperties(props);
            expect(result.Count).toBe('42');
        });

        it('serializes select property', () => {
            const props = { Status: { type: 'select', select: { name: 'Active' } } };
            const result = client.serializeProperties(props);
            expect(result.Status).toBe('Active');
        });

        it('serializes multi_select property', () => {
            const props = { Tags: { type: 'multi_select', multi_select: [{ name: 'A' }, { name: 'B' }] } };
            const result = client.serializeProperties(props);
            expect(result.Tags).toBe('A, B');
        });

        it('serializes date property', () => {
            const props = { Due: { type: 'date', date: { start: '2024-06-01', end: null } } };
            const result = client.serializeProperties(props);
            expect(result.Due).toBe('2024-06-01');
        });

        it('serializes date property with range', () => {
            const props = { Range: { type: 'date', date: { start: '2024-06-01', end: '2024-06-30' } } };
            const result = client.serializeProperties(props);
            expect(result.Range).toBe('2024-06-01 → 2024-06-30');
        });

        it('serializes checkbox property', () => {
            const props = { Done: { type: 'checkbox', checkbox: true } };
            const result = client.serializeProperties(props);
            expect(result.Done).toBe('true');
        });

        it('serializes url property', () => {
            const props = { Link: { type: 'url', url: 'https://example.com' } };
            const result = client.serializeProperties(props);
            expect(result.Link).toBe('https://example.com');
        });

        it('serializes email property', () => {
            const props = { Email: { type: 'email', email: 'a@b.com' } };
            const result = client.serializeProperties(props);
            expect(result.Email).toBe('a@b.com');
        });

        it('serializes phone_number property', () => {
            const props = { Phone: { type: 'phone_number', phone_number: '555-1234' } };
            const result = client.serializeProperties(props);
            expect(result.Phone).toBe('555-1234');
        });

        it('serializes status property', () => {
            const props = { Status: { type: 'status', status: { name: 'In Progress' } } };
            const result = client.serializeProperties(props);
            expect(result.Status).toBe('In Progress');
        });

        it('serializes people property', () => {
            const props = { Assignee: { type: 'people', people: [{ name: 'Alice' }, { name: 'Bob' }] } };
            const result = client.serializeProperties(props);
            expect(result.Assignee).toBe('Alice, Bob');
        });

        it('serializes created_time property', () => {
            const props = { Created: { type: 'created_time', created_time: '2024-06-01T00:00:00Z' } };
            const result = client.serializeProperties(props);
            expect(result.Created).toBe('2024-06-01T00:00:00Z');
        });

        it('serializes last_edited_time property', () => {
            const props = { Updated: { type: 'last_edited_time', last_edited_time: '2024-06-15T00:00:00Z' } };
            const result = client.serializeProperties(props);
            expect(result.Updated).toBe('2024-06-15T00:00:00Z');
        });

        it('serializes files property', () => {
            const props = { Attachments: { type: 'files', files: [
                { type: 'external', name: 'doc.pdf', external: { url: 'https://example.com/doc.pdf' } },
            ] } };
            const result = client.serializeProperties(props);
            expect(result.Attachments).toBe('https://example.com/doc.pdf');
        });

        it('skips unsupported property types (formula, rollup, relation)', () => {
            const props = {
                Name: { type: 'title', title: richText('Test') },
                Formula: { type: 'formula', formula: { type: 'string', string: 'computed' } },
                Rollup: { type: 'rollup', rollup: {} },
                Relation: { type: 'relation', relation: [] },
                CreatedBy: { type: 'created_by', created_by: { name: 'X' } },
                EditedBy: { type: 'last_edited_by', last_edited_by: { name: 'Y' } },
            };
            const result = client.serializeProperties(props);
            expect(result.Name).toBe('Test');
            expect(result).not.toHaveProperty('Formula');
            expect(result).not.toHaveProperty('Rollup');
            expect(result).not.toHaveProperty('Relation');
            expect(result).not.toHaveProperty('CreatedBy');
            expect(result).not.toHaveProperty('EditedBy');
        });
    });

    // ── MAX_PAGES safety bound ───────────────────────────────────────────

    describe('MAX_PAGES safety bound', () => {
        it('searchPages stops paginating at MAX_PAGES (100)', async () => {
            // Return has_more=true for 100 pages, then it should stop
            for (let i = 0; i < 100; i++) {
                mockSearch.mockResolvedValueOnce({
                    results: [notionPage(`p${i}`, `Page ${i}`, '2024-06-01T00:00:00Z')],
                    has_more: true,
                    next_cursor: `cursor-${i + 1}`,
                });
            }
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

            const pages = await client.searchPages();

            expect(pages).toHaveLength(100);
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('searchPages hit max pages'));
            // Should NOT have made a 101st call
            expect(mockSearch).toHaveBeenCalledTimes(100);
            warnSpy.mockRestore();
        });

        it('queryDatabase stops paginating at MAX_PAGES (100)', async () => {
            for (let i = 0; i < 100; i++) {
                mockDatabasesQuery.mockResolvedValueOnce({
                    results: [notionPage(`p${i}`, `Entry ${i}`, '2024-06-01T00:00:00Z', 'database_id', 'db1')],
                    has_more: true,
                    next_cursor: `cursor-${i + 1}`,
                });
            }
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

            const entries = await client.queryDatabase('db1');

            expect(entries).toHaveLength(100);
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('queryDatabase hit max pages'));
            expect(mockDatabasesQuery).toHaveBeenCalledTimes(100);
            warnSpy.mockRestore();
        });

        it('paginateBlockChildren stops at MAX_PAGES (100)', async () => {
            // Use a fresh client to avoid leftover mocks from other tests
            const freshClient = new NotionApiClient('test-token', { minRequestInterval: 0 });
            mockBlocksChildrenList.mockReset();

            for (let i = 0; i < 100; i++) {
                mockBlocksChildrenList.mockResolvedValueOnce(blocksResponse(
                    [block('paragraph', { paragraph: { rich_text: richText(`Block ${i}`) } })],
                    true, `cursor-${i + 1}`,
                ));
            }
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

            const md = await freshClient.getPageContent('page-1');

            expect(md).toContain('Block 0');
            expect(md).toContain('Block 99');
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('paginateBlockChildren hit max pages'));
            expect(mockBlocksChildrenList).toHaveBeenCalledTimes(100);
            warnSpy.mockRestore();
        });
    });

    // ── extractTitle edge case ─────────────────────────────────────────────

    describe('extractTitle', () => {
        it('returns empty string when page has no title property', async () => {
            mockSearch.mockResolvedValueOnce({
                results: [{
                    object: 'page',
                    id: 'no-title',
                    url: 'https://www.notion.so/notitle',
                    last_edited_time: '2024-06-01T00:00:00Z',
                    parent: { type: 'workspace', workspace: true },
                    properties: {
                        Description: { type: 'rich_text', rich_text: richText('Just a description') },
                    },
                }],
                has_more: false,
                next_cursor: null,
            });

            const pages = await client.searchPages();
            expect(pages).toHaveLength(1);
            expect(pages[0].title).toBe('');
        });

        it('returns empty string when page has no properties at all', async () => {
            mockSearch.mockResolvedValueOnce({
                results: [{
                    object: 'page',
                    id: 'no-props',
                    url: 'https://www.notion.so/noprops',
                    last_edited_time: '2024-06-01T00:00:00Z',
                    parent: { type: 'workspace', workspace: true },
                    properties: {},
                }],
                has_more: false,
                next_cursor: null,
            });

            const pages = await client.searchPages();
            expect(pages).toHaveLength(1);
            expect(pages[0].title).toBe('');
        });
    });

    // ── Throttling ──────────────────────────────────────────────────────────

    describe('throttling', () => {
        it('enforces minimum delay between API calls', async () => {
            // Create a client with real throttling (340ms)
            const throttledClient = new NotionApiClient('test-token', { minRequestInterval: 340 });

            mockBlocksChildrenList
                .mockResolvedValue(blocksResponse([
                    block('paragraph', { paragraph: { rich_text: richText('Text') } }),
                ]));

            const start = Date.now();
            // Make 3 sequential calls — should take >= 680ms (2 intervals between 3 calls)
            await throttledClient.getPageContent('p1');
            await throttledClient.getPageContent('p2');
            await throttledClient.getPageContent('p3');
            const elapsed = Date.now() - start;

            expect(elapsed).toBeGreaterThanOrEqual(600); // Allow small timing margin
        });
    });
});
