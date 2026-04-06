import { describe, it, expect } from 'vitest';
import { buildBashFilesMap } from '../mcp/tools/bash-fs.js';
import type { SourceConfig } from '../types.js';

describe('buildBashFilesMap', () => {
    it('builds files map for a single source (no prefix)', async () => {
        const sources: SourceConfig[] = [{
            name: 'docs',
            type: 'markdown',
            path: 'fixtures/breeze-api/docs',
            file_patterns: ['**/*.md'],
            chunk: { target_tokens: 600, overlap_tokens: 50 },
        }];
        const map = await buildBashFilesMap(sources);
        const keys = Object.keys(map);
        expect(keys.length).toBeGreaterThan(0);
        // Single source: no prefix, paths start with /
        for (const key of keys) {
            expect(key).toMatch(/^\//);
            expect(key).not.toMatch(/^\/docs\//);
            expect(key).toMatch(/\.md$/);
        }
    });

    it('builds files map for multiple sources (with prefix)', async () => {
        const sources: SourceConfig[] = [
            {
                name: 'docs',
                type: 'markdown',
                path: 'fixtures/breeze-api/docs',
                file_patterns: ['**/*.md'],
                chunk: { target_tokens: 600, overlap_tokens: 50 },
            },
            {
                name: 'code',
                type: 'code',
                path: 'fixtures/breeze-api',
                file_patterns: ['**/*.js'],
                chunk: { target_lines: 80, overlap_lines: 10 },
            },
        ];
        const map = await buildBashFilesMap(sources);
        const keys = Object.keys(map);
        expect(keys.length).toBeGreaterThan(0);
        // Multi source: prefixed with /{source_name}/
        const docKeys = keys.filter(k => k.startsWith('/docs/'));
        const codeKeys = keys.filter(k => k.startsWith('/code/'));
        expect(docKeys.length).toBeGreaterThan(0);
        expect(codeKeys.length).toBeGreaterThan(0);
    });

    it('excludes files matching exclude_patterns', async () => {
        const sources: SourceConfig[] = [{
            name: 'code',
            type: 'code',
            path: 'fixtures/breeze-api',
            file_patterns: ['**/*.js', '**/*.md'],
            exclude_patterns: ['**/*.md'],
            chunk: { target_lines: 80, overlap_lines: 10 },
        }];
        const map = await buildBashFilesMap(sources);
        const keys = Object.keys(map);
        for (const key of keys) {
            expect(key).not.toMatch(/\.md$/);
        }
    });

    it('file contents are strings', async () => {
        const sources: SourceConfig[] = [{
            name: 'docs',
            type: 'markdown',
            path: 'fixtures/breeze-api/docs',
            file_patterns: ['**/*.md'],
            chunk: { target_tokens: 600, overlap_tokens: 50 },
        }];
        const map = await buildBashFilesMap(sources);
        for (const val of Object.values(map)) {
            expect(typeof val).toBe('string');
            expect(val.length).toBeGreaterThan(0);
        }
    });

    it('returns empty map for nonexistent path', async () => {
        const sources: SourceConfig[] = [{
            name: 'ghost',
            type: 'markdown',
            path: 'fixtures/nonexistent',
            file_patterns: ['**/*.md'],
            chunk: { target_tokens: 600, overlap_tokens: 50 },
        }];
        const map = await buildBashFilesMap(sources);
        expect(Object.keys(map)).toHaveLength(0);
    });
});
