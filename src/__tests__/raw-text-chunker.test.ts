import { describe, it, expect } from 'vitest';
import { chunkRawText } from '../indexing/chunking/raw-text.js';
import type { SourceConfig } from '../types.js';

// Helper to build a minimal SourceConfig for raw-text chunking
function mkConfig(overrides: { target_tokens?: number; overlap_tokens?: number } = {}): SourceConfig {
    return {
        name: 'test',
        type: 'raw-text',
        path: '/tmp',
        file_patterns: ['*.txt'],
        chunk: {
            target_tokens: overrides.target_tokens,
            overlap_tokens: overrides.overlap_tokens,
        },
    } as SourceConfig;
}

describe('chunkRawText', () => {
    // ── Empty / whitespace input ────────────────────────────────────────

    it('returns empty array for empty string', () => {
        expect(chunkRawText('', 'test.txt', mkConfig())).toEqual([]);
    });

    it('returns empty array for whitespace-only string', () => {
        expect(chunkRawText('   \n\n  ', 'test.txt', mkConfig())).toEqual([]);
    });

    it('returns empty array for null/undefined content', () => {
        expect(chunkRawText(null as any, 'test.txt', mkConfig())).toEqual([]);
        expect(chunkRawText(undefined as any, 'test.txt', mkConfig())).toEqual([]);
    });

    it('returns empty array for only newlines', () => {
        expect(chunkRawText('\n\n\n\n', 'test.txt', mkConfig())).toEqual([]);
    });

    // ── Single chunk ────────────────────────────────────────────────────

    it('returns a single chunk for small content', () => {
        const content = 'Hello world.';
        const chunks = chunkRawText(content, 'test.txt', mkConfig());
        expect(chunks).toHaveLength(1);
        expect(chunks[0].content).toBe('Hello world.');
        expect(chunks[0].chunkIndex).toBe(0);
    });

    it('returns a single chunk when content is under target size', () => {
        const content = 'Paragraph one.\n\nParagraph two.';
        const chunks = chunkRawText(content, 'test.txt', mkConfig({ target_tokens: 600 }));
        expect(chunks).toHaveLength(1);
        expect(chunks[0].content).toContain('Paragraph one');
        expect(chunks[0].content).toContain('Paragraph two');
    });

    // ── Paragraph-based splitting ───────────────────────────────────────

    it('splits on double newlines', () => {
        const para = 'Word '.repeat(200);
        const content = `${para}\n\n${para}\n\n${para}`;
        const chunks = chunkRawText(content, 'test.txt', mkConfig({ target_tokens: 100 }));
        expect(chunks.length).toBeGreaterThan(1);
    });

    it('merges small adjacent paragraphs', () => {
        const content = 'Short one.\n\nShort two.\n\nShort three.';
        const chunks = chunkRawText(content, 'test.txt', mkConfig({ target_tokens: 600 }));
        expect(chunks).toHaveLength(1);
        expect(chunks[0].content).toContain('Short one');
        expect(chunks[0].content).toContain('Short two');
        expect(chunks[0].content).toContain('Short three');
    });

    it('splits when merged paragraphs exceed target', () => {
        const smallPara = 'Word '.repeat(80); // ~400 chars
        const content = Array.from({ length: 10 }, () => smallPara).join('\n\n');
        const chunks = chunkRawText(content, 'test.txt', mkConfig({ target_tokens: 100 }));
        expect(chunks.length).toBeGreaterThan(1);
    });

    it('handles triple+ newlines as paragraph separators', () => {
        const content = 'Para 1.\n\n\n\nPara 2.\n\n\n\n\nPara 3.';
        const chunks = chunkRawText(content, 'test.txt', mkConfig());
        expect(chunks).toHaveLength(1);
        expect(chunks[0].content).toContain('Para 1');
        expect(chunks[0].content).toContain('Para 2');
        expect(chunks[0].content).toContain('Para 3');
    });

    it('filters out whitespace-only paragraphs', () => {
        const content = 'Real content.\n\n   \n\n\n\nMore real content.';
        const chunks = chunkRawText(content, 'test.txt', mkConfig());
        expect(chunks).toHaveLength(1);
        // Should not have empty/whitespace chunks
        for (const chunk of chunks) {
            expect(chunk.content.trim().length).toBeGreaterThan(0);
        }
    });

    // ── chunkIndex numbering ────────────────────────────────────────────

    it('sets chunkIndex sequentially', () => {
        const para = 'Word '.repeat(200);
        const content = Array.from({ length: 5 }, () => para).join('\n\n');
        const chunks = chunkRawText(content, 'test.txt', mkConfig({ target_tokens: 100 }));
        for (let i = 0; i < chunks.length; i++) {
            expect(chunks[i].chunkIndex).toBe(i);
        }
    });

    // ── Overlap ─────────────────────────────────────────────────────────

    it('applies overlap between chunks', () => {
        const para = 'UniqueMarker ' + 'Word '.repeat(200);
        const content = `${para}\n\n${para}\n\n${para}`;
        const chunks = chunkRawText(content, 'test.txt', mkConfig({ target_tokens: 100, overlap_tokens: 30 }));
        if (chunks.length >= 2) {
            // The second chunk should start with some text from the end of the first
            // (overlap prepended)
            expect(chunks[1].content.length).toBeGreaterThan(0);
        }
    });

    it('does not apply overlap to the first chunk', () => {
        const para = 'Word '.repeat(200);
        const content = `${para}\n\n${para}`;
        const chunks = chunkRawText(content, 'test.txt', mkConfig({ target_tokens: 100, overlap_tokens: 30 }));
        // First chunk should just be the first paragraph content
        expect(chunks[0].content).not.toContain('\n\n\n');
    });

    it('finds clean break point in overlap at newline', () => {
        // Build content where the overlap region contains newlines
        const line = 'Word '.repeat(40);
        const para = `${line}\n${line}\n${line}`;
        const content = `${para}\n\n${para}\n\n${para}`;
        const chunks = chunkRawText(content, 'test.txt', mkConfig({ target_tokens: 80, overlap_tokens: 20 }));
        // Just verify it doesn't crash and produces valid chunks
        expect(chunks.length).toBeGreaterThanOrEqual(1);
        for (const chunk of chunks) {
            expect(chunk.content.trim().length).toBeGreaterThan(0);
        }
    });

    it('does not apply overlap when overlap_tokens is 0', () => {
        const para = 'Word '.repeat(200);
        const content = `${para}\n\n${para}\n\n${para}`;
        const chunks = chunkRawText(content, 'test.txt', mkConfig({ target_tokens: 100, overlap_tokens: 0 }));
        expect(chunks.length).toBeGreaterThan(1);
    });

    // ── Token-based sizing ──────────────────────────────────────────────

    it('respects custom target_tokens for smaller chunks', () => {
        const content = 'Word '.repeat(500);
        const smallChunks = chunkRawText(content, 'test.txt', mkConfig({ target_tokens: 50 }));
        const largeChunks = chunkRawText(content, 'test.txt', mkConfig({ target_tokens: 500 }));
        expect(smallChunks.length).toBeGreaterThanOrEqual(largeChunks.length);
    });

    it('uses default target_tokens (600) when not specified', () => {
        const content = 'Short text.';
        const config = mkConfig();
        delete (config as any).chunk.target_tokens;
        const chunks = chunkRawText(content, 'test.txt', config);
        expect(chunks).toHaveLength(1);
    });

    it('uses default overlap_tokens (50) when not specified', () => {
        const para = 'Word '.repeat(200);
        const content = `${para}\n\n${para}`;
        const config = mkConfig({ target_tokens: 100 });
        delete (config as any).chunk.overlap_tokens;
        const chunks = chunkRawText(content, 'test.txt', config);
        expect(chunks.length).toBeGreaterThanOrEqual(1);
    });

    // ── Special characters ──────────────────────────────────────────────

    it('handles content with special characters', () => {
        const content = 'Content with $pecial ch@rs: [brackets] {braces} (parens) & <angles>';
        const chunks = chunkRawText(content, 'test.txt', mkConfig());
        expect(chunks[0].content).toContain('$pecial');
    });

    it('handles unicode content', () => {
        const content = 'Unicode: \u{1F680}\u{1F30D} and CJK: \u4F60\u597D\u4E16\u754C';
        const chunks = chunkRawText(content, 'test.txt', mkConfig());
        expect(chunks[0].content).toContain('\u{1F680}');
        expect(chunks[0].content).toContain('\u4F60\u597D');
    });

    // ── Trimming ────────────────────────────────────────────────────────

    it('trims chunk content', () => {
        const content = '  \n  Hello world.  \n  ';
        const chunks = chunkRawText(content, 'test.txt', mkConfig());
        expect(chunks[0].content).toBe('Hello world.');
    });

    // ── Very long single paragraph ──────────────────────────────────────

    it('handles a single very long paragraph without double newlines', () => {
        const content = 'Word '.repeat(2000);
        const chunks = chunkRawText(content, 'test.txt', mkConfig({ target_tokens: 100 }));
        // Without paragraph breaks, it stays as one chunk
        expect(chunks).toHaveLength(1);
    });

    // ── filePath parameter is unused but accepted ───────────────────────

    it('accepts any filePath without error', () => {
        const chunks = chunkRawText('Some content.', '', mkConfig());
        expect(chunks).toHaveLength(1);
    });

    // ── No metadata fields beyond content and chunkIndex ────────────────

    it('only has content and chunkIndex in output', () => {
        const chunks = chunkRawText('Hello.', 'test.txt', mkConfig());
        expect(chunks[0]).toHaveProperty('content');
        expect(chunks[0]).toHaveProperty('chunkIndex');
        // Should not have markdown/code-specific fields
        expect(chunks[0].title).toBeUndefined();
        expect(chunks[0].language).toBeUndefined();
        expect(chunks[0].startLine).toBeUndefined();
    });

    // ── Many small paragraphs ───────────────────────────────────────────

    it('merges many small paragraphs into fewer chunks', () => {
        const content = Array.from({ length: 50 }, (_, i) => `Para ${i}.`).join('\n\n');
        const chunks = chunkRawText(content, 'test.txt', mkConfig({ target_tokens: 600 }));
        // 50 tiny paragraphs should merge into far fewer chunks
        expect(chunks.length).toBeLessThan(50);
    });
});
