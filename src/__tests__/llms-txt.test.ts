import { describe, it, expect } from 'vitest';
import { generateLlmsTxt, generateLlmsFullTxt } from '../llms-txt.js';

const mockChunks = [
    { source_name: 'docs', file_path: 'docs/quickstart.mdx', title: 'Quick Start', content: '# Quick Start\nGet started...', chunk_index: 0 },
    { source_name: 'docs', file_path: 'docs/quickstart.mdx', title: 'Quick Start', content: '## Installation\nRun npm...', chunk_index: 1 },
    { source_name: 'docs', file_path: 'docs/auth.mdx', title: 'Authentication', content: '# Auth\nUse tokens...', chunk_index: 0 },
];

describe('llms.txt generation', () => {
    it('generates index with one line per unique file', () => {
        const result = generateLlmsTxt(mockChunks, 'My Docs');
        expect(result).toContain('docs/quickstart.mdx');
        expect(result).toContain('docs/auth.mdx');
        expect(result).toContain('Quick Start');
        expect(result).toContain('Authentication');
        // Should only list each file once despite multiple chunks
        const lines = result.split('\n').filter(l => l.includes('quickstart'));
        expect(lines).toHaveLength(1);
    });

    it('generates full text with all content', () => {
        const result = generateLlmsFullTxt(mockChunks);
        expect(result).toContain('Get started...');
        expect(result).toContain('Run npm...');
        expect(result).toContain('Use tokens...');
        // Chunks from same file should be joined
        expect(result).toContain('Get started...\n## Installation\nRun npm...');
    });

    it('returns header only for empty chunks in llms.txt, empty string for full txt', () => {
        const llmsTxt = generateLlmsTxt([], 'Empty Server');
        expect(llmsTxt).toContain('# Empty Server');
        expect(llmsTxt).toContain('> Documentation index for AI agents');
        // No source sections
        const lines = llmsTxt.split('\n').filter(l => l.startsWith('## '));
        expect(lines).toHaveLength(0);

        const fullTxt = generateLlmsFullTxt([]);
        expect(fullTxt).toBe('');
    });

    it('uses file_path as fallback when title is null', () => {
        const chunks = [
            { source_name: 'docs', file_path: 'docs/untitled.mdx', title: null, content: 'Some content', chunk_index: 0 },
        ];
        const result = generateLlmsTxt(chunks, 'My Docs');
        // Should use the file_path as the display title
        expect(result).toContain('docs/untitled.mdx — docs/untitled.mdx');
    });

    it('groups chunks under separate source headings', () => {
        const chunks = [
            { source_name: 'docs', file_path: 'docs/a.mdx', title: 'Page A', content: 'A', chunk_index: 0 },
            { source_name: 'sdk', file_path: 'sdk/b.ts', title: 'Module B', content: 'B', chunk_index: 0 },
            { source_name: 'docs', file_path: 'docs/c.mdx', title: 'Page C', content: 'C', chunk_index: 0 },
        ];
        const result = generateLlmsTxt(chunks, 'Multi Source');
        expect(result).toContain('## docs');
        expect(result).toContain('## sdk');
        // docs section should have both doc files
        const docsSection = result.split('## sdk')[0];
        expect(docsSection).toContain('docs/a.mdx');
        expect(docsSection).toContain('docs/c.mdx');
    });

    it('sorts chunks by chunk_index in full text even when out of order', () => {
        const chunks = [
            { source_name: 'docs', file_path: 'docs/page.mdx', title: 'Page', content: 'Third', chunk_index: 2 },
            { source_name: 'docs', file_path: 'docs/page.mdx', title: 'Page', content: 'First', chunk_index: 0 },
            { source_name: 'docs', file_path: 'docs/page.mdx', title: 'Page', content: 'Second', chunk_index: 1 },
        ];
        const result = generateLlmsFullTxt(chunks);
        const contentStart = result.indexOf('First');
        const contentMid = result.indexOf('Second');
        const contentEnd = result.indexOf('Third');
        expect(contentStart).toBeLessThan(contentMid);
        expect(contentMid).toBeLessThan(contentEnd);
    });
});
