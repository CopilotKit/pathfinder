import { describe, it, expect, vi } from 'vitest';
import { parseGrepCommand, vectorGrep } from '../mcp/tools/bash-grep.js';

describe('parseGrepCommand', () => {
    it('parses basic grep command', () => {
        const result = parseGrepCommand('grep "useCoAgent" /docs');
        expect(result).toEqual({ isGrep: true, pattern: 'useCoAgent', flags: [], paths: ['/docs'] });
    });
    it('parses grep with flags', () => {
        const result = parseGrepCommand('grep -rn "pattern" /docs /code');
        expect(result).toEqual({ isGrep: true, pattern: 'pattern', flags: ['-rn'], paths: ['/docs', '/code'] });
    });
    it('parses grep with separate flags', () => {
        const result = parseGrepCommand('grep -r -l "pattern" /');
        expect(result).toEqual({ isGrep: true, pattern: 'pattern', flags: ['-r', '-l'], paths: ['/'] });
    });
    it('parses grep with unquoted pattern', () => {
        const result = parseGrepCommand('grep useCoAgent /docs');
        expect(result).toEqual({ isGrep: true, pattern: 'useCoAgent', flags: [], paths: ['/docs'] });
    });
    it('returns isGrep false for non-grep commands', () => {
        expect(parseGrepCommand('cat /docs/file.md').isGrep).toBe(false);
        expect(parseGrepCommand('find / -name "*.ts"').isGrep).toBe(false);
        expect(parseGrepCommand('ls /docs').isGrep).toBe(false);
    });
    it('handles piped grep (not intercepted)', () => {
        expect(parseGrepCommand('cat file.ts | grep pattern').isGrep).toBe(false);
    });
    it('parses grep with single-quoted pattern', () => {
        const result = parseGrepCommand("grep -r 'useCoAgent' /docs");
        expect(result).toEqual({ isGrep: true, pattern: 'useCoAgent', flags: ['-r'], paths: ['/docs'] });
    });
    it('handles grep with no path (defaults to /)', () => {
        const result = parseGrepCommand('grep "pattern"');
        expect(result).toEqual({ isGrep: true, pattern: 'pattern', flags: [], paths: ['/'] });
    });
});

describe('vectorGrep', () => {
    const mockEmbeddingClient = { embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]), embedBatch: vi.fn() };
    const mockSearchChunks = vi.fn().mockResolvedValue([{
        id: 1, source_name: 'docs', source_url: null, title: 'Streaming',
        content: 'How to use useCoAgent for streaming.',
        repo_url: null, file_path: 'guides/streaming.mdx', start_line: 5, end_line: 10, language: null, similarity: 0.92,
    }]);
    const mockTextSearch = vi.fn().mockResolvedValue([{
        id: 2, source_name: 'docs', source_url: null, title: 'Hooks',
        content: 'The useCoAgent hook provides state management.',
        repo_url: null, file_path: 'api/hooks.mdx', start_line: 1, end_line: 5, language: null, similarity: 0.0,
    }]);

    it('returns formatted grep-like output', async () => {
        const result = await vectorGrep({
            pattern: 'useCoAgent', sourceName: 'docs',
            embeddingClient: mockEmbeddingClient as any,
            searchChunksFn: mockSearchChunks, textSearchFn: mockTextSearch,
        });
        expect(result.stdout).toContain('useCoAgent');
        expect(result.exitCode).toBe(0);
        expect(mockEmbeddingClient.embed).toHaveBeenCalledWith('useCoAgent');
    });

    it('returns exit code 1 when no matches found', async () => {
        mockSearchChunks.mockResolvedValueOnce([]);
        mockTextSearch.mockResolvedValueOnce([]);
        const result = await vectorGrep({
            pattern: 'nonexistent_xyz', sourceName: 'docs',
            embeddingClient: mockEmbeddingClient as any,
            searchChunksFn: mockSearchChunks, textSearchFn: mockTextSearch,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe('');
    });

    it('handles semantic search failure gracefully', async () => {
        const failEmbed = { embed: vi.fn().mockRejectedValue(new Error('API down')), embedBatch: vi.fn() };
        const result = await vectorGrep({
            pattern: 'useCoAgent', sourceName: 'docs',
            embeddingClient: failEmbed as any,
            searchChunksFn: mockSearchChunks, textSearchFn: mockTextSearch,
        });
        // Text search still works, so should find results
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('useCoAgent');
    });

    it('handles text search failure gracefully', async () => {
        const failTextSearch = vi.fn().mockRejectedValue(new Error('DB timeout'));
        const result = await vectorGrep({
            pattern: 'useCoAgent', sourceName: 'docs',
            embeddingClient: mockEmbeddingClient as any,
            searchChunksFn: mockSearchChunks, textSearchFn: failTextSearch,
        });
        // Semantic search still works
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('useCoAgent');
    });

    it('returns exit 2 with error info when both searches fail', async () => {
        const failEmbed = { embed: vi.fn().mockRejectedValue(new Error('API down')), embedBatch: vi.fn() };
        const failTextSearch = vi.fn().mockRejectedValue(new Error('DB down'));
        const result = await vectorGrep({
            pattern: 'useCoAgent', sourceName: 'docs',
            embeddingClient: failEmbed as any,
            searchChunksFn: vi.fn().mockResolvedValue([]), textSearchFn: failTextSearch,
        });
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain('search unavailable');
        expect(result.stderr).toContain('API down');
        expect(result.stderr).toContain('DB down');
        expect(result.stdout).toBe('');
    });

    it('deduplicates results by chunk ID', async () => {
        const sharedResult = {
            id: 99, source_name: 'docs', source_url: null, title: 'Shared',
            content: 'useCoAgent is used here.',
            repo_url: null, file_path: 'guides/shared.mdx', start_line: 1, end_line: 5, language: null, similarity: 0.85,
        };
        const dupeSearch = vi.fn().mockResolvedValue([sharedResult]);
        const dupeText = vi.fn().mockResolvedValue([{ ...sharedResult, similarity: 0.0 }]);
        const result = await vectorGrep({
            pattern: 'useCoAgent', sourceName: 'docs',
            embeddingClient: mockEmbeddingClient as any,
            searchChunksFn: dupeSearch, textSearchFn: dupeText,
        });
        // Should only appear once despite being in both result sets
        const matches = result.stdout.split('\n').filter(l => l.includes('shared.mdx'));
        expect(matches.length).toBe(1);
    });

    it('filters out chunks that dont actually contain the pattern', async () => {
        const irrelevantResult = {
            id: 50, source_name: 'docs', source_url: null, title: 'Irrelevant',
            content: 'This talks about something else entirely.',
            repo_url: null, file_path: 'guides/other.mdx', start_line: 1, end_line: 3, language: null, similarity: 0.80,
        };
        const search = vi.fn().mockResolvedValue([irrelevantResult]);
        const result = await vectorGrep({
            pattern: 'useCoAgent', sourceName: 'docs',
            embeddingClient: mockEmbeddingClient as any,
            searchChunksFn: search, textSearchFn: vi.fn().mockResolvedValue([]),
        });
        expect(result.exitCode).toBe(1); // No actual content match
    });
});
