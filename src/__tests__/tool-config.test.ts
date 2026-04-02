import { describe, it, expect } from 'vitest';
import { CollectToolConfigSchema, AnyToolConfigSchema, ServerConfigSchema } from '../types.js';

describe('CollectToolConfigSchema', () => {
    const validCollect = {
        name: 'submit-feedback',
        type: 'collect' as const,
        description: 'Submit feedback',
        response: 'Thanks!',
        schema: {
            rating: { type: 'enum' as const, values: ['good', 'bad'], required: true },
        },
    };

    it('parses a valid collect tool config', () => {
        const result = CollectToolConfigSchema.safeParse(validCollect);
        expect(result.success).toBe(true);
    });

    it('rejects missing name', () => {
        const { name, ...rest } = validCollect;
        expect(CollectToolConfigSchema.safeParse(rest).success).toBe(false);
    });

    it('rejects missing description', () => {
        const { description, ...rest } = validCollect;
        expect(CollectToolConfigSchema.safeParse(rest).success).toBe(false);
    });

    it('rejects missing response', () => {
        const { response, ...rest } = validCollect;
        expect(CollectToolConfigSchema.safeParse(rest).success).toBe(false);
    });

    it('rejects missing schema', () => {
        const { schema, ...rest } = validCollect;
        expect(CollectToolConfigSchema.safeParse(rest).success).toBe(false);
    });

    it('rejects enum field without values', () => {
        const config = {
            ...validCollect,
            schema: {
                rating: { type: 'enum' as const, required: true },
            },
        };
        expect(CollectToolConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects enum field with empty values', () => {
        const config = {
            ...validCollect,
            schema: {
                rating: { type: 'enum' as const, values: [], required: true },
            },
        };
        expect(CollectToolConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects unknown field type', () => {
        const config = {
            ...validCollect,
            schema: {
                data: { type: 'boolean', required: true },
            },
        };
        expect(CollectToolConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects values on non-enum fields', () => {
        const config = {
            ...validCollect,
            schema: {
                name: { type: 'string' as const, values: ['a', 'b'], required: true },
            },
        };
        expect(CollectToolConfigSchema.safeParse(config).success).toBe(false);
    });
});

describe('AnyToolConfigSchema', () => {
    it('parses a search tool with explicit type', () => {
        const config = {
            name: 'search-docs',
            type: 'search',
            description: 'Search docs',
            source: 'docs',
            default_limit: 5,
            max_limit: 20,
            result_format: 'docs',
        };
        const result = AnyToolConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.type).toBe('search');
    });

    it('parses a collect tool', () => {
        const config = {
            name: 'feedback',
            type: 'collect',
            description: 'Give feedback',
            response: 'OK',
            schema: { note: { type: 'string' } },
        };
        const result = AnyToolConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.type).toBe('collect');
    });

    it('rejects unknown tool type', () => {
        const config = {
            name: 'mystery',
            type: 'magic',
            description: 'Does magic',
        };
        expect(AnyToolConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects collect tool with empty schema', () => {
        const config = {
            name: 'feedback',
            type: 'collect',
            description: 'Give feedback',
            response: 'OK',
            schema: {},
        };
        expect(AnyToolConfigSchema.safeParse(config).success).toBe(false);
    });

    it('discriminates correctly between search and collect fields', () => {
        // A collect tool should not need source/limits
        const collect = {
            name: 'feedback',
            type: 'collect',
            description: 'Give feedback',
            response: 'OK',
            schema: { note: { type: 'string' } },
        };
        expect(AnyToolConfigSchema.safeParse(collect).success).toBe(true);

        // A search tool should not need response/schema
        const search = {
            name: 'search',
            type: 'search',
            description: 'Search',
            source: 'docs',
            default_limit: 5,
            max_limit: 20,
            result_format: 'docs',
        };
        expect(AnyToolConfigSchema.safeParse(search).success).toBe(true);
    });
});

describe('backwards-compat config defaulting', () => {
    it('defaults missing type to search and parses via AnyToolConfigSchema', () => {
        const toolWithoutType = {
            name: 'search-docs',
            description: 'Search',
            source: 'docs',
            default_limit: 5,
            max_limit: 20,
            result_format: 'docs',
        };

        // Simulate the defaulting logic from config.ts
        const tool = { ...toolWithoutType } as Record<string, unknown>;
        if (!('type' in tool)) {
            tool.type = 'search';
        }

        const result = AnyToolConfigSchema.safeParse(tool);
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.type).toBe('search');
    });

    it('does not overwrite an explicit type', () => {
        const collectTool = {
            name: 'feedback',
            type: 'collect',
            description: 'Give feedback',
            response: 'OK',
            schema: { note: { type: 'string' } },
        };

        // Same defaulting logic — should not touch existing type
        const tool = { ...collectTool } as Record<string, unknown>;
        if (!('type' in tool)) {
            tool.type = 'search';
        }

        const result = AnyToolConfigSchema.safeParse(tool);
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.type).toBe('collect');
    });
});

describe('ServerConfigSchema', () => {
    const minimalConfig = {
        server: { name: 'test', version: '1.0.0' },
        sources: [{
            name: 'docs',
            type: 'markdown',
            repo: 'https://github.com/test/test.git',
            path: 'docs/',
            file_patterns: ['**/*.md'],
            chunk: { target_tokens: 600, overlap_tokens: 50 },
        }],
        embedding: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 },
        indexing: { auto_reindex: true, reindex_hour_utc: 3, stale_threshold_hours: 24 },
    };

    it('rejects search tool where default_limit > max_limit', () => {
        const config = {
            ...minimalConfig,
            tools: [{
                name: 'search-docs',
                type: 'search',
                description: 'Search',
                source: 'docs',
                default_limit: 30,
                max_limit: 10,
                result_format: 'docs',
            }],
        };
        const result = ServerConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });

    it('accepts search tool where default_limit <= max_limit', () => {
        const config = {
            ...minimalConfig,
            tools: [{
                name: 'search-docs',
                type: 'search',
                description: 'Search',
                source: 'docs',
                default_limit: 5,
                max_limit: 20,
                result_format: 'docs',
            }],
        };
        const result = ServerConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
    });
});
