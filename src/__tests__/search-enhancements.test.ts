import { describe, it, expect } from 'vitest';
import { SearchToolConfigSchema, SourceConfigSchema } from '../types.js';

describe('Search enhancements schema', () => {
    it('accepts min_score in search tool config and preserves it', () => {
        const result = SearchToolConfigSchema.safeParse({
            name: 'test',
            type: 'search',
            description: 'test search',
            source: 'docs',
            default_limit: 5,
            max_limit: 20,
            result_format: 'docs',
            min_score: 0.5,
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.min_score).toBe(0.5);
        }
    });

    it('rejects min_score above 1', () => {
        const result = SearchToolConfigSchema.safeParse({
            name: 'test',
            type: 'search',
            description: 'test search',
            source: 'docs',
            default_limit: 5,
            max_limit: 20,
            result_format: 'docs',
            min_score: 1.5,
        });
        expect(result.success).toBe(false);
    });

    it('rejects min_score below 0', () => {
        const result = SearchToolConfigSchema.safeParse({
            name: 'test',
            type: 'search',
            description: 'test search',
            source: 'docs',
            default_limit: 5,
            max_limit: 20,
            result_format: 'docs',
            min_score: -0.1,
        });
        expect(result.success).toBe(false);
    });

    it('allows omitting min_score', () => {
        const result = SearchToolConfigSchema.safeParse({
            name: 'test',
            type: 'search',
            description: 'test search',
            source: 'docs',
            default_limit: 5,
            max_limit: 20,
            result_format: 'docs',
        });
        expect(result.success).toBe(true);
    });

    it('accepts min_score of exactly 0', () => {
        const result = SearchToolConfigSchema.safeParse({
            name: 'test',
            type: 'search',
            description: 'test search',
            source: 'docs',
            default_limit: 5,
            max_limit: 20,
            result_format: 'docs',
            min_score: 0,
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.min_score).toBe(0);
        }
    });

    it('accepts min_score of exactly 1', () => {
        const result = SearchToolConfigSchema.safeParse({
            name: 'test',
            type: 'search',
            description: 'test search',
            source: 'docs',
            default_limit: 5,
            max_limit: 20,
            result_format: 'docs',
            min_score: 1,
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.min_score).toBe(1);
        }
    });
});

describe('Version filtering schema', () => {
    it('accepts version in source config and preserves it', () => {
        const result = SourceConfigSchema.safeParse({
            name: 'docs',
            type: 'markdown',
            path: 'docs/',
            file_patterns: ['**/*.md'],
            chunk: { target_tokens: 500 },
            version: 'v2.0',
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.version).toBe('v2.0');
        }
    });

    it('allows omitting version from source config', () => {
        const result = SourceConfigSchema.safeParse({
            name: 'docs',
            type: 'markdown',
            path: 'docs/',
            file_patterns: ['**/*.md'],
            chunk: { target_tokens: 500 },
        });
        expect(result.success).toBe(true);
    });
});
