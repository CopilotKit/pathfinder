import { describe, it, expect } from 'vitest';
import {
    SourceConfigSchema,
    SlackSourceConfigSchema,
    KnowledgeToolConfigSchema,
    AnyToolConfigSchema,
    ServerConfigSchema,
} from '../types.js';

describe('Source category field', () => {
    it('accepts file source without category (undefined)', () => {
        const config = {
            name: 'test-docs',
            type: 'markdown',
            path: 'docs/',
            file_patterns: ['**/*.md'],
            chunk: { target_tokens: 600, overlap_tokens: 50 },
        };
        const result = SourceConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if (result.success) {
            expect((result.data as Record<string, unknown>).category).toBeUndefined();
        }
    });

    it('accepts file source with explicit faq category', () => {
        const config = {
            name: 'test-docs',
            type: 'markdown',
            path: 'docs/',
            file_patterns: ['**/*.md'],
            chunk: { target_tokens: 600 },
            category: 'faq',
        };
        const result = SourceConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
    });

    it('rejects file source with invalid category', () => {
        const config = {
            name: 'test-docs',
            type: 'markdown',
            path: 'docs/',
            file_patterns: ['**/*.md'],
            chunk: { target_tokens: 600 },
            category: 'blog',
        };
        const result = SourceConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });

    it('slack source defaults category to faq', () => {
        const config = {
            name: 'slack-support',
            type: 'slack',
            channels: ['C01234ABCDE'],
            chunk: {},
        };
        const result = SourceConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if (result.success && result.data.type === 'slack') {
            expect(result.data.category).toBe('faq');
        }
    });

    it('slack source allows explicit category override', () => {
        const config = {
            name: 'slack-support',
            type: 'slack',
            channels: ['C01234ABCDE'],
            chunk: {},
            category: 'faq',
        };
        const result = SourceConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
    });
});

describe('KnowledgeToolConfigSchema', () => {
    const validKnowledge = {
        name: 'get-faq',
        type: 'knowledge' as const,
        description: 'Get FAQ',
        sources: ['slack-support'],
        min_confidence: 0.7,
        default_limit: 20,
        max_limit: 100,
    };

    it('parses a valid knowledge tool config', () => {
        const result = KnowledgeToolConfigSchema.safeParse(validKnowledge);
        expect(result.success).toBe(true);
    });

    it('applies defaults for optional fields', () => {
        const minimal = {
            name: 'get-faq',
            type: 'knowledge' as const,
            description: 'Get FAQ',
            sources: ['slack-support'],
        };
        const result = KnowledgeToolConfigSchema.safeParse(minimal);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.min_confidence).toBe(0.7);
            expect(result.data.default_limit).toBe(20);
            expect(result.data.max_limit).toBe(100);
        }
    });

    it('rejects missing name', () => {
        const { name, ...rest } = validKnowledge;
        expect(KnowledgeToolConfigSchema.safeParse(rest).success).toBe(false);
    });

    it('rejects missing description', () => {
        const { description, ...rest } = validKnowledge;
        expect(KnowledgeToolConfigSchema.safeParse(rest).success).toBe(false);
    });

    it('rejects empty sources array', () => {
        const config = { ...validKnowledge, sources: [] };
        expect(KnowledgeToolConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects min_confidence out of range', () => {
        expect(KnowledgeToolConfigSchema.safeParse({ ...validKnowledge, min_confidence: 1.5 }).success).toBe(false);
        expect(KnowledgeToolConfigSchema.safeParse({ ...validKnowledge, min_confidence: -0.1 }).success).toBe(false);
    });

    it('is included in AnyToolConfigSchema union', () => {
        const result = AnyToolConfigSchema.safeParse(validKnowledge);
        expect(result.success).toBe(true);
    });
});

describe('ServerConfigSchema knowledge tool validation', () => {
    const baseConfig = {
        server: { name: 'test', version: '1.0' },
        sources: [
            {
                name: 'slack-support',
                type: 'slack' as const,
                channels: ['C01234ABCDE'],
                chunk: {},
            },
        ],
        embedding: { provider: 'openai' as const, model: 'text-embedding-3-small', dimensions: 1536 },
        indexing: { auto_reindex: true, reindex_hour_utc: 3, stale_threshold_hours: 24 },
    };

    it('accepts config with knowledge tool referencing valid source', () => {
        const config = {
            ...baseConfig,
            tools: [{
                name: 'get-faq',
                type: 'knowledge' as const,
                description: 'Get FAQ',
                sources: ['slack-support'],
            }],
        };
        const result = ServerConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
    });

    it('rejects knowledge tool referencing non-existent source', () => {
        const config = {
            ...baseConfig,
            tools: [{
                name: 'get-faq',
                type: 'knowledge' as const,
                description: 'Get FAQ',
                sources: ['nonexistent'],
            }],
        };
        const result = ServerConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });

    it('requires embedding config when knowledge tools are configured', () => {
        const { embedding, ...rest } = baseConfig;
        const config = {
            ...rest,
            tools: [{
                name: 'get-faq',
                type: 'knowledge' as const,
                description: 'Get FAQ',
                sources: ['slack-support'],
            }],
        };
        const result = ServerConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });

    it('rejects knowledge tool where default_limit > max_limit', () => {
        const config = {
            ...baseConfig,
            tools: [{
                name: 'get-faq',
                type: 'knowledge' as const,
                description: 'Get FAQ',
                sources: ['slack-support'],
                default_limit: 200,
                max_limit: 50,
            }],
        };
        const result = ServerConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });
});
