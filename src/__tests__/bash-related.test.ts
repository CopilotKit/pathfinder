import { describe, it, expect, vi } from 'vitest';
import { parseRelatedCommand, handleRelatedCommand, formatGrepMissSuggestion } from '../mcp/tools/bash-related.js';

describe('parseRelatedCommand', () => {
    it('parses valid related command', () => {
        expect(parseRelatedCommand('related /docs/quickstart.mdx')).toEqual({ isRelated: true, path: '/docs/quickstart.mdx' });
    });
    it('rejects non-related commands', () => {
        expect(parseRelatedCommand('cat /docs/file.md').isRelated).toBe(false);
        expect(parseRelatedCommand('grep related /docs').isRelated).toBe(false);
    });
    it('rejects related with no path', () => {
        expect(parseRelatedCommand('related').isRelated).toBe(false);
        expect(parseRelatedCommand('related  ').isRelated).toBe(false);
    });
});

describe('handleRelatedCommand', () => {
    const mockEmbed = { embed: vi.fn().mockResolvedValue([0.1, 0.2]), embedBatch: vi.fn() };
    const mockSearch = vi.fn().mockResolvedValue([
        { id: 1, source_name: 'docs', source_url: null, title: 'Related', content: 'content', repo_url: null, file_path: 'guides/related.mdx', start_line: 1, end_line: 5, language: null, similarity: 0.92 },
        { id: 2, source_name: 'docs', source_url: null, title: 'Self', content: 'self', repo_url: null, file_path: 'quickstart.mdx', start_line: 1, end_line: 5, language: null, similarity: 0.99 },
    ]);

    it('returns related files excluding self', async () => {
        const result = await handleRelatedCommand('/docs/quickstart.mdx', '# Quickstart', mockEmbed as any, mockSearch);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('guides/related.mdx');
        expect(result.stdout).toContain('0.92');
        // Self file (quickstart.mdx) appears in header but NOT as a result line
        expect(result.stdout).not.toMatch(/\d+\.\d+\s+\/docs\/quickstart\.mdx/);
    });

    it('returns error for missing file', async () => {
        const result = await handleRelatedCommand('/missing.md', undefined, mockEmbed as any, mockSearch);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('No such file');
    });

    it('handles empty results', async () => {
        mockSearch.mockResolvedValueOnce([]);
        const result = await handleRelatedCommand('/file.md', 'content', mockEmbed as any, mockSearch);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('No related files');
    });

    it('self-excludes with source-prefixed paths (multi-source)', async () => {
        const multiSourceSearch = vi.fn().mockResolvedValue([
            { id: 1, source_name: 'docs', source_url: null, title: 'Related', content: 'content', repo_url: null, file_path: 'guides/related.mdx', start_line: 1, end_line: 5, language: null, similarity: 0.92 },
            { id: 2, source_name: 'docs', source_url: null, title: 'Self', content: 'self', repo_url: null, file_path: 'quickstart.mdx', start_line: 1, end_line: 5, language: null, similarity: 0.99 },
        ]);
        const result = await handleRelatedCommand('/docs/quickstart.mdx', '# Quickstart', mockEmbed as any, multiSourceSearch);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('guides/related.mdx');
        expect(result.stdout).toContain('0.92');
        // Self file should be excluded even with source prefix
        expect(result.stdout).not.toMatch(/\d+\.\d+\s+\/docs\/quickstart\.mdx/);
    });

    it('does not false-positive exclude files sharing a basename', async () => {
        const searchWithSharedBasename = vi.fn().mockResolvedValue([
            { id: 1, source_name: 'docs', source_url: null, title: 'Components Index', content: 'components', repo_url: null, file_path: 'components/index.mdx', start_line: 1, end_line: 5, language: null, similarity: 0.90 },
            { id: 2, source_name: 'docs', source_url: null, title: 'Root Index', content: 'root', repo_url: null, file_path: 'index.mdx', start_line: 1, end_line: 5, language: null, similarity: 0.85 },
        ]);
        // Searching for /docs/components/index.mdx — only that exact path should be excluded, not /docs/index.mdx
        const result = await handleRelatedCommand('/docs/components/index.mdx', '# Components', mockEmbed as any, searchWithSharedBasename);
        expect(result.exitCode).toBe(0);
        // /docs/index.mdx should NOT be excluded (different directory)
        expect(result.stdout).toContain('/docs/index.mdx');
        // /docs/components/index.mdx IS the self — should be excluded
        expect(result.stdout).not.toMatch(/\d+\.\d+\s+\/docs\/components\/index\.mdx/);
    });

    it('handles embedding client error', async () => {
        const failEmbed = { embed: vi.fn().mockRejectedValue(new Error('embed failed')), embedBatch: vi.fn() };
        const result = await handleRelatedCommand('/file.md', 'content', failEmbed as any, mockSearch);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('embed failed');
    });

    it('deduplicates by file_path keeping highest similarity', async () => {
        const dupeSearch = vi.fn().mockResolvedValue([
            { id: 1, source_name: 'docs', source_url: null, title: 'A', content: 'x', repo_url: null, file_path: 'guides/a.mdx', start_line: 1, end_line: 5, language: null, similarity: 0.80 },
            { id: 2, source_name: 'docs', source_url: null, title: 'A2', content: 'y', repo_url: null, file_path: 'guides/a.mdx', start_line: 6, end_line: 10, language: null, similarity: 0.95 },
            { id: 3, source_name: 'docs', source_url: null, title: 'B', content: 'z', repo_url: null, file_path: 'guides/b.mdx', start_line: 1, end_line: 5, language: null, similarity: 0.70 },
        ]);
        const result = await handleRelatedCommand('/other.md', 'content', mockEmbed as any, dupeSearch);
        expect(result.exitCode).toBe(0);
        // a.mdx should appear once with 0.95 (the higher similarity)
        expect(result.stdout).toContain('0.95');
        expect(result.stdout).not.toContain('0.80');
        // b.mdx should also appear
        expect(result.stdout).toContain('guides/b.mdx');
    });
});

describe('formatGrepMissSuggestion', () => {
    it('formats suggestion with tool names and qmd', () => {
        const result = formatGrepMissSuggestion(['search-docs', 'search-code']);
        expect(result).toContain('qmd');
        expect(result).toContain('search-docs');
        expect(result).toContain('search-code');
    });
    it('returns empty string with no search tools', () => {
        expect(formatGrepMissSuggestion([])).toBe('');
    });
});
