import { describe, it, expect } from 'vitest';
import { SourceConfigSchema } from '../types.js';
import { chunkHtml } from '../indexing/chunking/html.js';
import { getChunker } from '../indexing/chunking/index.js';
import type { SourceConfig } from '../types.js';

describe('html source type schema', () => {
    it('accepts type: html in source config', () => {
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
});

const htmlConfig: SourceConfig = {
    name: 'test',
    type: 'html',
    path: 'docs/',
    file_patterns: ['**/*.html'],
    chunk: { target_tokens: 600, overlap_tokens: 50 },
};

describe('chunkHtml', () => {
    it('extracts text from basic HTML with heading sections', () => {
        const html = `<!DOCTYPE html><html><head><title>Test Page</title></head><body>
            <article>
                <h1>Introduction</h1>
                <p>Welcome to the docs.</p>
                <h2>Getting Started</h2>
                <p>Install the package.</p>
                <h2>Configuration</h2>
                <p>Edit your config file.</p>
            </article>
        </body></html>`;
        const chunks = chunkHtml(html, 'docs/test.html', htmlConfig);
        expect(chunks.length).toBeGreaterThanOrEqual(1);
        expect(chunks[0].title).toBe('Test Page');
        const allText = chunks.map(c => c.content).join('\n');
        expect(allText).toContain('Welcome to the docs');
        expect(allText).toContain('Install the package');
        expect(allText).toContain('Edit your config file');
    });

    it('strips script, style, nav, footer, header, svg, noscript elements', () => {
        const html = `<!DOCTYPE html><html><head><title>Strip Test</title></head><body>
            <nav><a href="/">Home</a></nav>
            <header><h1>Site Header</h1></header>
            <article>
                <h2>Real Content</h2>
                <p>This should appear.</p>
                <script>alert('evil')</script>
                <style>.hidden { display: none; }</style>
                <svg><text>svg-leak-marker</text></svg>
                <noscript>Enable JS</noscript>
            </article>
            <footer>Copyright 2026</footer>
        </body></html>`;
        const chunks = chunkHtml(html, 'docs/strip.html', htmlConfig);
        const allText = chunks.map(c => c.content).join('\n');
        expect(allText).toContain('This should appear');
        expect(allText).not.toContain('alert');
        expect(allText).not.toContain('display: none');
        expect(allText).not.toContain('Home');
        expect(allText).not.toContain('Site Header');
        expect(allText).not.toContain('Copyright');
        expect(allText).not.toContain('Enable JS');
        expect(allText).not.toContain('svg-leak-marker');
    });

    it('prefers article over body as content container', () => {
        const html = `<!DOCTYPE html><html><head><title>Container</title></head><body>
            <p>Body noise outside article.</p>
            <article>
                <h2>Article Content</h2>
                <p>Inside article.</p>
            </article>
        </body></html>`;
        const chunks = chunkHtml(html, 'docs/container.html', htmlConfig);
        const allText = chunks.map(c => c.content).join('\n');
        expect(allText).toContain('Inside article');
        expect(allText).not.toContain('Body noise');
    });

    it('falls back to body when no content container found', () => {
        const html = `<!DOCTYPE html><html><head><title>Fallback</title></head><body>
            <h2>Just Body</h2>
            <p>Body content directly.</p>
        </body></html>`;
        const chunks = chunkHtml(html, 'docs/fallback.html', htmlConfig);
        const allText = chunks.map(c => c.content).join('\n');
        expect(allText).toContain('Body content directly');
    });

    it('returns empty array for empty body', () => {
        const html = `<!DOCTYPE html><html><head><title>Empty</title></head><body></body></html>`;
        const chunks = chunkHtml(html, 'docs/empty.html', htmlConfig);
        expect(chunks).toHaveLength(0);
    });

    it('returns empty array for empty string', () => {
        const chunks = chunkHtml('', 'docs/empty.html', htmlConfig);
        expect(chunks).toHaveLength(0);
    });

    it('preserves code blocks with whitespace intact', () => {
        const html = `<!DOCTYPE html><html><head><title>Code</title></head><body>
            <article>
                <h2>Example</h2>
                <pre><code>function hello() {
    return "world";
}</code></pre>
            </article>
        </body></html>`;
        const chunks = chunkHtml(html, 'docs/code.html', htmlConfig);
        const allText = chunks.map(c => c.content).join('\n');
        expect(allText).toContain('function hello()');
        expect(allText).toContain('return "world"');
        // Should have code fence markers
        expect(allText).toContain('```');
    });

    it('formats unordered lists with dash prefix', () => {
        const html = `<!DOCTYPE html><html><head><title>Lists</title></head><body>
            <article>
                <h2>Features</h2>
                <ul><li>Fast</li><li>Reliable</li><li>Simple</li></ul>
            </article>
        </body></html>`;
        const chunks = chunkHtml(html, 'docs/lists.html', htmlConfig);
        const allText = chunks.map(c => c.content).join('\n');
        expect(allText).toContain('- Fast');
        expect(allText).toContain('- Reliable');
        expect(allText).toContain('- Simple');
    });

    it('formats ordered lists with numbers', () => {
        const html = `<!DOCTYPE html><html><head><title>Steps</title></head><body>
            <article>
                <h2>Steps</h2>
                <ol><li>Install</li><li>Configure</li><li>Deploy</li></ol>
            </article>
        </body></html>`;
        const chunks = chunkHtml(html, 'docs/steps.html', htmlConfig);
        const allText = chunks.map(c => c.content).join('\n');
        expect(allText).toContain('1. Install');
        expect(allText).toContain('2. Configure');
        expect(allText).toContain('3. Deploy');
    });

    it('formats table rows with pipe separators', () => {
        const html = `<!DOCTYPE html><html><head><title>Table</title></head><body>
            <article>
                <h2>Comparison</h2>
                <table>
                    <tr><th>Feature</th><th>Pathfinder</th></tr>
                    <tr><td>Search</td><td>Yes</td></tr>
                    <tr><td>Bash</td><td>Yes</td></tr>
                </table>
            </article>
        </body></html>`;
        const chunks = chunkHtml(html, 'docs/table.html', htmlConfig);
        const allText = chunks.map(c => c.content).join('\n');
        expect(allText).toContain('Feature | Pathfinder');
        expect(allText).toContain('Search | Yes');
    });

    it('builds correct headingPath from heading hierarchy', () => {
        const html = `<!DOCTYPE html><html><head><title>Hierarchy</title></head><body>
            <article>
                <h1>Top Level</h1>
                <p>Intro text.</p>
                <h2>Section A</h2>
                <p>Section A content.</p>
                <h3>Subsection A1</h3>
                <p>Subsection content.</p>
                <h2>Section B</h2>
                <p>Section B content.</p>
            </article>
        </body></html>`;
        const chunks = chunkHtml(html, 'docs/hierarchy.html', htmlConfig);
        // Find the chunk containing "Subsection content"
        const subsectionChunk = chunks.find(c => c.content.includes('Subsection content'));
        expect(subsectionChunk).toBeDefined();
        expect(subsectionChunk!.headingPath).toEqual(['Top Level', 'Section A', 'Subsection A1']);

        // Section B should not include Section A in its path
        const sectionBChunk = chunks.find(c => c.content.includes('Section B content'));
        expect(sectionBChunk).toBeDefined();
        expect(sectionBChunk!.headingPath).toEqual(['Top Level', 'Section B']);
    });

    it('uses first h1 as title when no title tag', () => {
        const html = `<!DOCTYPE html><html><head></head><body>
            <article><h1>My Page Title</h1><p>Content.</p></article>
        </body></html>`;
        const chunks = chunkHtml(html, 'docs/notitle.html', htmlConfig);
        expect(chunks.length).toBeGreaterThanOrEqual(1);
        expect(chunks[0].title).toBe('My Page Title');
    });

    it('uses filename as title when no title tag and no h1', () => {
        const html = `<!DOCTYPE html><html><head></head><body>
            <article><p>Just a paragraph.</p></article>
        </body></html>`;
        const chunks = chunkHtml(html, 'docs/notitle.html', htmlConfig);
        expect(chunks.length).toBeGreaterThanOrEqual(1);
        expect(chunks[0].title).toBe('notitle.html');
    });

    it('strips site name suffix from title tag', () => {
        const html = `<!DOCTYPE html><html><head><title>Getting Started \u2014 My Docs</title></head><body>
            <article><p>Content here.</p></article>
        </body></html>`;
        const chunks = chunkHtml(html, 'docs/start.html', htmlConfig);
        expect(chunks.length).toBeGreaterThanOrEqual(1);
        expect(chunks[0].title).toBe('Getting Started');
    });

    it('prefers main over article as content container', () => {
        const html = `<!DOCTYPE html><html><head><title>Priority</title></head><body>
            <article><p>Article content.</p></article>
            <main><p>Main content.</p></main>
        </body></html>`;
        const chunks = chunkHtml(html, 'docs/priority.html', htmlConfig);
        const allText = chunks.map(c => c.content).join('\n');
        expect(allText).toContain('Main content');
        expect(allText).not.toContain('Article content');
    });

    it('detects headings nested inside section and div elements', () => {
        const html = `<!DOCTYPE html><html><head><title>Nested</title></head><body>
            <main>
                <section>
                    <h2>First Section</h2>
                    <p>First content.</p>
                </section>
                <div class="block">
                    <h2>Second Section</h2>
                    <p>Second content.</p>
                </div>
            </main>
        </body></html>`;
        const chunks = chunkHtml(html, 'docs/nested.html', htmlConfig);
        expect(chunks.length).toBeGreaterThanOrEqual(2);
        const first = chunks.find(c => c.content.includes('First content'));
        const second = chunks.find(c => c.content.includes('Second content'));
        expect(first).toBeDefined();
        expect(second).toBeDefined();
        expect(first!.headingPath).toEqual(['First Section']);
        expect(second!.headingPath).toEqual(['Second Section']);
    });

    it('returns single chunk with empty headingPath when no headings present', () => {
        const html = `<!DOCTYPE html><html><head><title>No Headings</title></head><body>
            <article><p>Just paragraphs.</p><p>More text.</p></article>
        </body></html>`;
        const chunks = chunkHtml(html, 'docs/noheadings.html', htmlConfig);
        expect(chunks.length).toBe(1);
        expect(chunks[0].headingPath).toEqual([]);
        expect(chunks[0].content).toContain('Just paragraphs');
    });
});

describe('html chunker registration', () => {
    it('getChunker returns the html chunker function', () => {
        const chunker = getChunker('html');
        expect(chunker).toBe(chunkHtml);
    });
});
