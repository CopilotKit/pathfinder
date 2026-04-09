import { describe, it, expect } from 'vitest';
import { SourceConfigSchema, NotionSourceConfigSchema } from '../types.js';

describe('NotionSourceConfigSchema', () => {
    it('accepts valid notion source config', () => {
        const config = {
            name: 'notion-docs',
            type: 'notion',
            root_pages: ['page-id-1', 'page-id-2'],
            databases: ['db-id-1'],
            max_depth: 3,
            include_properties: false,
            chunk: {},
        };
        const result = SourceConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if (result.success && result.data.type === 'notion') {
            expect(result.data.root_pages).toEqual(['page-id-1', 'page-id-2']);
            expect(result.data.databases).toEqual(['db-id-1']);
            expect(result.data.max_depth).toBe(3);
            expect(result.data.include_properties).toBe(false);
        }
    });

    it('applies defaults for optional fields', () => {
        const config = {
            name: 'notion-minimal',
            type: 'notion',
            chunk: {},
        };
        const result = NotionSourceConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.root_pages).toEqual([]);
            expect(result.data.databases).toEqual([]);
            expect(result.data.max_depth).toBe(5);
            expect(result.data.include_properties).toBe(true);
        }
    });

    it('rejects max_depth below 1', () => {
        const config = {
            name: 'notion-bad-depth',
            type: 'notion',
            max_depth: 0,
            chunk: {},
        };
        const result = NotionSourceConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });

    it('rejects max_depth above 20', () => {
        const config = {
            name: 'notion-deep',
            type: 'notion',
            max_depth: 21,
            chunk: {},
        };
        const result = NotionSourceConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });

    it('rejects empty strings in root_pages', () => {
        const config = {
            name: 'notion-empty-page',
            type: 'notion',
            root_pages: ['valid-id', ''],
            chunk: {},
        };
        const result = NotionSourceConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });

    it('rejects empty strings in databases', () => {
        const config = {
            name: 'notion-empty-db',
            type: 'notion',
            databases: [''],
            chunk: {},
        };
        const result = NotionSourceConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });

    it('allows category to be set to faq explicitly', () => {
        const config = {
            name: 'notion-faq',
            type: 'notion',
            category: 'faq',
            chunk: {},
        };
        const result = NotionSourceConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.category).toBe('faq');
        }
    });

    it('category is undefined by default', () => {
        const config = {
            name: 'notion-no-cat',
            type: 'notion',
            chunk: {},
        };
        const result = NotionSourceConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.category).toBeUndefined();
        }
    });

    it('resolves correctly in discriminated union', () => {
        const config = {
            name: 'notion-union',
            type: 'notion',
            chunk: {},
        };
        const result = SourceConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.type).toBe('notion');
        }
    });
});
