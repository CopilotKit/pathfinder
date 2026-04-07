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
});
