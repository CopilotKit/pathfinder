import { describe, it, expect } from 'vitest';
import { generateConfig, detectSourceType, deriveBaseUrl, deriveFilePatterns, detectContentSelector } from '../config-generator.js';
import type { CrawlResult, CrawledPage } from '../crawl.js';

// ── Source type detection ───────────────────────────────────────────────────

describe('detectSourceType', () => {
    it('returns "html" for pages with text/html content-type', () => {
        const pages: CrawledPage[] = [
            { url: 'https://docs.example.com/intro', html: '<html><body>Hi</body></html>', contentType: 'text/html; charset=utf-8', textLength: 100 },
        ];
        expect(detectSourceType(pages)).toBe('html');
    });

    it('returns "markdown" when URLs end in .md', () => {
        const pages: CrawledPage[] = [
            { url: 'https://raw.github.com/repo/docs/intro.md', html: '# Intro\nSome text', contentType: 'text/plain', textLength: 100 },
            { url: 'https://raw.github.com/repo/docs/guide.md', html: '# Guide\nMore text', contentType: 'text/plain', textLength: 100 },
        ];
        expect(detectSourceType(pages)).toBe('markdown');
    });

    it('defaults to "html" for mixed content', () => {
        const pages: CrawledPage[] = [
            { url: 'https://docs.example.com/intro', html: '<html><body>Hi</body></html>', contentType: 'text/html', textLength: 100 },
            { url: 'https://docs.example.com/raw.md', html: '# Raw', contentType: 'text/plain', textLength: 50 },
        ];
        expect(detectSourceType(pages)).toBe('html');
    });
});

// ── Base URL derivation ────────────────────────────────────────────────────

describe('deriveBaseUrl', () => {
    it('finds common path prefix across all page URLs', () => {
        const urls = [
            'https://docs.example.com/docs/getting-started',
            'https://docs.example.com/docs/api-reference',
            'https://docs.example.com/docs/faq',
        ];
        expect(deriveBaseUrl(urls)).toBe('https://docs.example.com/docs');
    });

    it('returns origin when pages are at root', () => {
        const urls = [
            'https://docs.example.com/intro',
            'https://docs.example.com/guide',
        ];
        expect(deriveBaseUrl(urls)).toBe('https://docs.example.com');
    });

    it('handles single page', () => {
        const urls = ['https://docs.example.com/docs/intro'];
        expect(deriveBaseUrl(urls)).toBe('https://docs.example.com/docs');
    });
});

// ── File pattern derivation ────────────────────────────────────────────────

describe('deriveFilePatterns', () => {
    it('generates **/*.html for HTML source type', () => {
        expect(deriveFilePatterns('html')).toEqual(['**/*.html']);
    });

    it('generates markdown patterns for markdown source type', () => {
        expect(deriveFilePatterns('markdown')).toEqual(['**/*.md', '**/*.mdx']);
    });
});

// ── Content selector detection ─────────────────────────────────────────────

describe('detectContentSelector', () => {
    it('detects <main> element', () => {
        const html = '<html><body><nav>Nav</nav><main><h1>Content</h1><p>Text here</p></main></body></html>';
        expect(detectContentSelector(html)).toBe('main');
    });

    it('detects <article> element', () => {
        const html = '<html><body><article><h1>Post</h1><p>Body</p></article></body></html>';
        expect(detectContentSelector(html)).toBe('article');
    });

    it('detects role="main"', () => {
        const html = '<html><body><div role="main"><p>Content</p></div></body></html>';
        expect(detectContentSelector(html)).toBe('[role="main"]');
    });

    it('returns null when no semantic container found', () => {
        const html = '<html><body><div><p>Just divs</p></div></body></html>';
        expect(detectContentSelector(html)).toBeNull();
    });
});

// ── Full config generation ─────────────────────────────────────────────────

describe('generateConfig', () => {
    it('produces valid pathfinder.yaml content for an HTML site', () => {
        const crawlResult: CrawlResult = {
            pages: [
                { url: 'https://docs.example.com/docs/intro', html: '<html><head><title>Intro - Example</title></head><body><main><h1>Intro</h1></main></body></html>', contentType: 'text/html', textLength: 200 },
                { url: 'https://docs.example.com/docs/guide', html: '<html><head><title>Guide - Example</title></head><body><main><h1>Guide</h1></main></body></html>', contentType: 'text/html', textLength: 300 },
            ],
            discoveryMethod: 'sitemap',
            baseUrl: 'https://docs.example.com',
            warnings: [],
            failedUrls: [],
        };

        const config = generateConfig(crawlResult, 'https://docs.example.com');

        expect(config.server.name).toBe('example-docs');
        expect(config.sources).toHaveLength(1);
        expect(config.sources[0].type).toBe('html');
        expect(config.sources[0].base_url).toBe('https://docs.example.com/docs');
        expect(config.sources[0].file_patterns).toEqual(['**/*.html']);
        expect(config.tools).toHaveLength(1);
        expect(config.tools[0].type).toBe('search');
        expect(config.embedding).toBeDefined();
        expect(config.embedding.provider).toBe('openai');
        expect(config.indexing).toBeDefined();
    });

    it('derives server name from hostname', () => {
        const crawlResult: CrawlResult = {
            pages: [{ url: 'https://my-awesome-lib.readthedocs.io/en/latest/intro', html: '<html><body>Hi</body></html>', contentType: 'text/html', textLength: 100 }],
            discoveryMethod: 'sitemap',
            baseUrl: 'https://my-awesome-lib.readthedocs.io',
            warnings: [],
            failedUrls: [],
        };

        const config = generateConfig(crawlResult, 'https://my-awesome-lib.readthedocs.io');
        expect(config.server.name).toBe('my-awesome-lib-docs');
    });

    it('uses cache directory as source path', () => {
        const crawlResult: CrawlResult = {
            pages: [{ url: 'https://docs.example.com/page', html: '<html><body>Hi</body></html>', contentType: 'text/html', textLength: 100 }],
            discoveryMethod: 'sitemap',
            baseUrl: 'https://docs.example.com',
            warnings: [],
            failedUrls: [],
        };

        const config = generateConfig(crawlResult, 'https://docs.example.com');
        expect(config.sources[0].path).toBe('.pathfinder/cache/docs.example.com');
    });

    it('detects git-hosted docs and uses repo source', () => {
        const crawlResult: CrawlResult = {
            pages: [{ url: 'https://github.com/org/repo/blob/main/docs/README.md', html: '# README', contentType: 'text/plain', textLength: 100 }],
            discoveryMethod: 'crawl',
            baseUrl: 'https://github.com',
            warnings: [],
            failedUrls: [],
        };

        const config = generateConfig(crawlResult, 'https://github.com/org/repo');
        expect(config.sources[0].repo).toBeDefined();
        expect(config.sources[0].type).toBe('markdown');
    });
});

// ── generateConfig edge cases ───────────────────────────────────────────────

describe('generateConfig edge cases', () => {
    it('handles zero pages (empty crawl result)', () => {
        const crawlResult: CrawlResult = {
            pages: [],
            discoveryMethod: 'sitemap',
            baseUrl: 'https://docs.example.com',
            warnings: [],
            failedUrls: [],
        };

        const config = generateConfig(crawlResult, 'https://docs.example.com');
        expect(config.server.name).toBe('example-docs');
        expect(config.sources).toHaveLength(1);
        expect(config.sources[0].type).toBe('html');
    });

    it('detects GitLab repos correctly', () => {
        const crawlResult: CrawlResult = {
            pages: [{ url: 'https://gitlab.com/org/repo/-/blob/main/docs/README.md', html: '# README', contentType: 'text/plain', textLength: 100 }],
            discoveryMethod: 'crawl',
            baseUrl: 'https://gitlab.com',
            warnings: [],
            failedUrls: [],
        };

        const config = generateConfig(crawlResult, 'https://gitlab.com/org/repo');
        expect(config.sources[0].repo).toContain('gitlab.com');
    });

    it('wires detected content_selector into source config', () => {
        const crawlResult: CrawlResult = {
            pages: [
                { url: 'https://docs.example.com/page', html: '<html><body><main><h1>Title</h1><p>Content</p></main></body></html>', contentType: 'text/html', textLength: 200 },
            ],
            discoveryMethod: 'sitemap',
            baseUrl: 'https://docs.example.com',
            warnings: [],
            failedUrls: [],
        };

        const config = generateConfig(crawlResult, 'https://docs.example.com');
        // Fix I2: detectContentSelector should find <main> and include it
        expect((config.sources[0] as any).content_selector).toBe('main');
    });
});

// ── YAML serialization ─────────────────────────────────────────────────────

describe('generateConfigYaml', () => {
    it('produces parseable YAML string', async () => {
        const { generateConfigYaml } = await import('../config-generator.js');
        const { parse: parseYaml } = await import('yaml');

        const crawlResult: CrawlResult = {
            pages: [
                { url: 'https://docs.example.com/intro', html: '<html><body><main>Content</main></body></html>', contentType: 'text/html', textLength: 200 },
            ],
            discoveryMethod: 'sitemap',
            baseUrl: 'https://docs.example.com',
            warnings: [],
            failedUrls: [],
        };

        const yaml = generateConfigYaml(crawlResult, 'https://docs.example.com');
        const parsed = parseYaml(yaml);

        expect(parsed.server).toBeDefined();
        expect(parsed.sources).toBeInstanceOf(Array);
        expect(parsed.tools).toBeInstanceOf(Array);
        expect(parsed.embedding).toBeDefined();
    });
});
