import { describe, it, expect } from 'vitest';
import { SourceConfigSchema, FileSourceConfigSchema, SlackSourceConfigSchema } from '../types.js';

describe('SourceConfig discriminated union', () => {
    it('accepts file-based source configs (backward compatible)', () => {
        const config = {
            name: 'test-docs',
            type: 'markdown',
            path: 'docs/',
            file_patterns: ['**/*.md'],
            chunk: { target_tokens: 600, overlap_tokens: 50 },
        };
        const result = SourceConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
    });

    it('accepts html source type', () => {
        const config = {
            name: 'test-html',
            type: 'html',
            path: 'docs/',
            file_patterns: ['**/*.html'],
            chunk: { target_tokens: 600, overlap_tokens: 50 },
        };
        const result = SourceConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
    });

    it('accepts code source type', () => {
        const config = {
            name: 'test-code',
            type: 'code',
            path: 'src/',
            file_patterns: ['**/*.ts'],
            chunk: { target_lines: 100, overlap_lines: 10 },
        };
        const result = SourceConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
    });

    it('accepts slack source config with channels', () => {
        const config = {
            name: 'slack-support',
            type: 'slack',
            channels: ['C01234ABCDE', 'C05678FGHIJ'],
            chunk: { target_tokens: 600, overlap_tokens: 0 },
        };
        const result = SourceConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if (result.success) {
            const data = result.data;
            expect(data.type).toBe('slack');
            if (data.type === 'slack') {
                expect(data.channels).toEqual(['C01234ABCDE', 'C05678FGHIJ']);
                expect(data.confidence_threshold).toBe(0.7); // default
                expect(data.trigger_emoji).toBe('pathfinder'); // default
                expect(data.min_thread_replies).toBe(2); // default
            }
        }
    });

    it('accepts slack source config with all optional fields', () => {
        const config = {
            name: 'slack-full',
            type: 'slack',
            channels: ['C01234ABCDE'],
            confidence_threshold: 0.5,
            trigger_emoji: 'docs',
            min_thread_replies: 3,
            distiller_model: 'gpt-4o',
            chunk: { target_tokens: 800 },
        };
        const result = SourceConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if (result.success && result.data.type === 'slack') {
            expect(result.data.confidence_threshold).toBe(0.5);
            expect(result.data.trigger_emoji).toBe('docs');
            expect(result.data.min_thread_replies).toBe(3);
            expect(result.data.distiller_model).toBe('gpt-4o');
        }
    });

    it('rejects slack source without channels', () => {
        const config = {
            name: 'slack-bad',
            type: 'slack',
            chunk: { target_tokens: 600 },
        };
        const result = SourceConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });

    it('rejects slack source with empty channels array', () => {
        const config = {
            name: 'slack-empty',
            type: 'slack',
            channels: [],
            chunk: { target_tokens: 600 },
        };
        const result = SourceConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });

    it('rejects slack source with confidence_threshold out of range', () => {
        const config = {
            name: 'slack-bad-threshold',
            type: 'slack',
            channels: ['C01234ABCDE'],
            confidence_threshold: 1.5,
            chunk: { target_tokens: 600 },
        };
        const result = SourceConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });

    it('rejects file source without path', () => {
        const config = {
            name: 'bad-file',
            type: 'markdown',
            file_patterns: ['**/*.md'],
            chunk: { target_tokens: 600 },
        };
        const result = SourceConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });

    it('rejects file source without file_patterns', () => {
        const config = {
            name: 'bad-file2',
            type: 'markdown',
            path: 'docs/',
            chunk: { target_tokens: 600 },
        };
        const result = SourceConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });

    it('slack source does not require path or file_patterns', () => {
        const config = {
            name: 'slack-minimal',
            type: 'slack',
            channels: ['C01234ABCDE'],
            chunk: {},
        };
        const result = SourceConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
    });

    it('type narrowing works: file source has path', () => {
        const config = {
            name: 'test-docs',
            type: 'markdown' as const,
            path: 'docs/',
            file_patterns: ['**/*.md'],
            chunk: { target_tokens: 600, overlap_tokens: 50 },
        };
        const result = SourceConfigSchema.parse(config);
        if (result.type !== 'slack') {
            // TypeScript should know this is FileSourceConfig
            expect(result.path).toBe('docs/');
            expect(result.file_patterns).toEqual(['**/*.md']);
        }
    });
});
