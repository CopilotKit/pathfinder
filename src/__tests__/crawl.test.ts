import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { crawlSite, parseSitemap, parseSitemapIndex, extractLinks, respectsRobotsTxt } from '../crawl.js';

// ── Sitemap parsing ─────────────────────────────────────────────────────────

describe('parseSitemap', () => {
    it('extracts <loc> entries from a valid sitemap.xml', () => {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://docs.example.com/getting-started</loc></url>
  <url><loc>https://docs.example.com/api-reference</loc></url>
  <url><loc>https://docs.example.com/faq</loc></url>
</urlset>`;
        const urls = parseSitemap(xml);
        expect(urls).toEqual([
            'https://docs.example.com/getting-started',
            'https://docs.example.com/api-reference',
            'https://docs.example.com/faq',
        ]);
    });

    it('returns empty array for malformed XML', () => {
        expect(parseSitemap('<not-a-sitemap>')).toEqual([]);
    });

    it('returns empty array for empty string', () => {
        expect(parseSitemap('')).toEqual([]);
    });

    it('handles sitemap with extra whitespace in <loc> tags', () => {
        const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>  https://docs.example.com/page  </loc></url>
</urlset>`;
        expect(parseSitemap(xml)).toEqual(['https://docs.example.com/page']);
    });
});

describe('parseSitemapIndex', () => {
    it('extracts sitemap URLs from a sitemap index', () => {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://docs.example.com/sitemap-docs.xml</loc></sitemap>
  <sitemap><loc>https://docs.example.com/sitemap-blog.xml</loc></sitemap>
</sitemapindex>`;
        const urls = parseSitemapIndex(xml);
        expect(urls).toEqual([
            'https://docs.example.com/sitemap-docs.xml',
            'https://docs.example.com/sitemap-blog.xml',
        ]);
    });

    it('returns empty array when not a sitemap index', () => {
        expect(parseSitemapIndex('<urlset></urlset>')).toEqual([]);
    });
});

// ── Sitemap edge cases ──────────────────────────────────────────────────────

describe('parseSitemap edge cases', () => {
    it('handles very large sitemap with 10000+ URLs', () => {
        const urls = Array.from({ length: 10000 }, (_, i) =>
            `<url><loc>https://docs.example.com/page-${i}</loc></url>`
        ).join('\n');
        const xml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
        const result = parseSitemap(xml);
        expect(result).toHaveLength(10000);
    });

    it('handles sitemap with CDATA-wrapped URLs', () => {
        const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc><![CDATA[https://docs.example.com/page?a=1&b=2]]></loc></url>
</urlset>`;
        const result = parseSitemap(xml);
        expect(result).toHaveLength(1);
        expect(result[0]).toContain('page?a=1&b=2');
    });
});

// ── Link extraction ─────────────────────────────────────────────────────────

describe('extractLinks', () => {
    it('extracts same-origin links from HTML', () => {
        const html = `<html><body>
            <a href="/docs/intro">Intro</a>
            <a href="/docs/api">API</a>
            <a href="https://other.com/page">External</a>
            <a href="https://docs.example.com/docs/faq">Same origin absolute</a>
        </body></html>`;
        const links = extractLinks(html, 'https://docs.example.com');
        expect(links).toContain('https://docs.example.com/docs/intro');
        expect(links).toContain('https://docs.example.com/docs/api');
        expect(links).toContain('https://docs.example.com/docs/faq');
        expect(links).not.toContain('https://other.com/page');
    });

    it('deduplicates links', () => {
        const html = `<html><body>
            <a href="/page">Link 1</a>
            <a href="/page">Link 2</a>
            <a href="/page#section">With hash</a>
        </body></html>`;
        const links = extractLinks(html, 'https://example.com');
        const pageLinks = links.filter(l => l === 'https://example.com/page');
        expect(pageLinks).toHaveLength(1);
    });

    it('strips hash fragments', () => {
        const html = `<html><body><a href="/page#section">Link</a></body></html>`;
        const links = extractLinks(html, 'https://example.com');
        expect(links).toContain('https://example.com/page');
        expect(links.some(l => l.includes('#'))).toBe(false);
    });

    it('ignores mailto: and javascript: links', () => {
        const html = `<html><body>
            <a href="mailto:test@test.com">Email</a>
            <a href="javascript:void(0)">JS</a>
            <a href="/real-page">Real</a>
        </body></html>`;
        const links = extractLinks(html, 'https://example.com');
        expect(links).toEqual(['https://example.com/real-page']);
    });

    it('handles relative links with path prefix', () => {
        const html = `<html><body><a href="sub-page">Sub</a></body></html>`;
        const links = extractLinks(html, 'https://example.com/docs/');
        expect(links).toContain('https://example.com/docs/sub-page');
    });
});

// ── extractLinks edge cases ─────────────────────────────────────────────────

describe('extractLinks edge cases', () => {
    it('ignores data: URIs', () => {
        const html = `<html><body>
            <a href="data:text/html,<h1>Hi</h1>">Data</a>
            <a href="/real-page">Real</a>
        </body></html>`;
        const links = extractLinks(html, 'https://example.com');
        expect(links).toEqual(['https://example.com/real-page']);
    });

    it('handles relative URLs with ../ path traversal', () => {
        const html = `<html><body><a href="../other-section/page">Link</a></body></html>`;
        const links = extractLinks(html, 'https://example.com/docs/guide/');
        expect(links).toContain('https://example.com/docs/other-section/page');
    });

    it('ignores tel: links', () => {
        const html = `<html><body><a href="tel:+1234567890">Call</a></body></html>`;
        const links = extractLinks(html, 'https://example.com');
        expect(links).toEqual([]);
    });

    it('handles URLs with query parameters (preserves params, strips hash)', () => {
        const html = `<html><body><a href="/page?tab=api#section">Link</a></body></html>`;
        const links = extractLinks(html, 'https://example.com');
        expect(links).toContain('https://example.com/page?tab=api');
        expect(links.some(l => l.includes('#'))).toBe(false);
    });
});

// ── robots.txt ──────────────────────────────────────────────────────────────

describe('respectsRobotsTxt', () => {
    it('returns true when path is not disallowed', () => {
        const robotsTxt = `User-agent: *\nDisallow: /admin/\nDisallow: /private/`;
        expect(respectsRobotsTxt(robotsTxt, '/docs/intro')).toBe(true);
    });

    it('returns false when path is disallowed', () => {
        const robotsTxt = `User-agent: *\nDisallow: /admin/\nDisallow: /private/`;
        expect(respectsRobotsTxt(robotsTxt, '/admin/settings')).toBe(false);
    });

    it('extracts Sitemap directives', () => {
        const robotsTxt = `User-agent: *\nDisallow: /admin/\nSitemap: https://example.com/sitemap.xml\nSitemap: https://example.com/sitemap2.xml`;
        // respectsRobotsTxt only checks allow/disallow; sitemap extraction is separate
        expect(respectsRobotsTxt(robotsTxt, '/docs/page')).toBe(true);
    });

    it('handles empty robots.txt (everything allowed)', () => {
        expect(respectsRobotsTxt('', '/anything')).toBe(true);
    });

    it('handles Disallow: / (everything blocked)', () => {
        const robotsTxt = `User-agent: *\nDisallow: /`;
        expect(respectsRobotsTxt(robotsTxt, '/docs/page')).toBe(false);
    });
});

// ── extractSitemapUrls from robots.txt ──────────────────────────────────────

describe('extractSitemapsFromRobotsTxt', () => {
    it('extracts Sitemap: directives', async () => {
        const { extractSitemapsFromRobotsTxt } = await import('../crawl.js');
        const robotsTxt = `User-agent: *\nDisallow: /admin/\nSitemap: https://example.com/sitemap.xml\nSitemap: https://example.com/sitemap-blog.xml`;
        expect(extractSitemapsFromRobotsTxt(robotsTxt)).toEqual([
            'https://example.com/sitemap.xml',
            'https://example.com/sitemap-blog.xml',
        ]);
    });
});

// ── crawlSite (integration-level, mocked fetch) ────────────────────────────

describe('crawlSite', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('discovers pages via sitemap.xml', async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url === 'https://docs.example.com/sitemap.xml') {
                return new Response(`<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://docs.example.com/intro</loc></url>
  <url><loc>https://docs.example.com/guide</loc></url>
</urlset>`, { status: 200, headers: { 'content-type': 'application/xml' } });
            }
            if (url === 'https://docs.example.com/intro' || url === 'https://docs.example.com/guide') {
                return new Response('<html><head><title>Page</title></head><body><main><h1>Hello</h1><p>Content here</p></main></body></html>', {
                    status: 200,
                    headers: { 'content-type': 'text/html' },
                });
            }
            return new Response('', { status: 404 });
        });

        const result = await crawlSite('https://docs.example.com', {
            rateLimit: 100,
            maxPages: 10,
            cacheDir: undefined,
        });

        expect(result.pages).toHaveLength(2);
        expect(result.pages.map(p => p.url).sort()).toEqual([
            'https://docs.example.com/guide',
            'https://docs.example.com/intro',
        ]);
        expect(result.discoveryMethod).toBe('sitemap');
    });

    it('falls back to robots.txt Sitemap: directive when sitemap.xml 404s', async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url === 'https://docs.example.com/sitemap.xml') {
                return new Response('', { status: 404 });
            }
            if (url === 'https://docs.example.com/sitemap_index.xml') {
                return new Response('', { status: 404 });
            }
            if (url === 'https://docs.example.com/robots.txt') {
                return new Response(
                    'User-agent: *\nDisallow: /admin/\nSitemap: https://docs.example.com/alt-sitemap.xml',
                    { status: 200, headers: { 'content-type': 'text/plain' } },
                );
            }
            if (url === 'https://docs.example.com/alt-sitemap.xml') {
                return new Response(`<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://docs.example.com/page1</loc></url>
</urlset>`, { status: 200, headers: { 'content-type': 'application/xml' } });
            }
            if (url === 'https://docs.example.com/page1') {
                return new Response('<html><body><p>Content</p></body></html>', {
                    status: 200,
                    headers: { 'content-type': 'text/html' },
                });
            }
            return new Response('', { status: 404 });
        });

        const result = await crawlSite('https://docs.example.com', {
            rateLimit: 100,
            maxPages: 10,
            cacheDir: undefined,
        });

        expect(result.pages).toHaveLength(1);
        expect(result.pages[0].url).toBe('https://docs.example.com/page1');
        expect(result.discoveryMethod).toBe('robots-sitemap');
    });

    it('falls back to recursive link crawling when no sitemap or robots', async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url.endsWith('sitemap.xml') || url.endsWith('sitemap_index.xml')) {
                return new Response('', { status: 404 });
            }
            if (url.endsWith('robots.txt')) {
                return new Response('', { status: 404 });
            }
            if (url === 'https://docs.example.com' || url === 'https://docs.example.com/') {
                return new Response(`<html><body>
                    <a href="/page-a">A</a>
                    <a href="/page-b">B</a>
                </body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
            }
            if (url === 'https://docs.example.com/page-a') {
                return new Response('<html><body><p>Page A content</p></body></html>', {
                    status: 200, headers: { 'content-type': 'text/html' },
                });
            }
            if (url === 'https://docs.example.com/page-b') {
                return new Response('<html><body><p>Page B content</p></body></html>', {
                    status: 200, headers: { 'content-type': 'text/html' },
                });
            }
            return new Response('', { status: 404 });
        });

        const result = await crawlSite('https://docs.example.com', {
            rateLimit: 100,
            maxPages: 10,
            maxDepth: 3,
            cacheDir: undefined,
        });

        expect(result.pages.length).toBeGreaterThanOrEqual(1);
        expect(result.discoveryMethod).toBe('crawl');
    });

    it('respects maxPages limit', async () => {
        const pageUrls = Array.from({ length: 20 }, (_, i) =>
            `https://docs.example.com/page-${i}`
        );
        const sitemapXml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${pageUrls.map(u => `<url><loc>${u}</loc></url>`).join('\n')}
</urlset>`;

        fetchMock.mockImplementation(async (url: string) => {
            if (url.endsWith('sitemap.xml')) {
                return new Response(sitemapXml, { status: 200, headers: { 'content-type': 'application/xml' } });
            }
            return new Response('<html><body><p>Content</p></body></html>', {
                status: 200, headers: { 'content-type': 'text/html' },
            });
        });

        const result = await crawlSite('https://docs.example.com', {
            rateLimit: 100,
            maxPages: 5,
            cacheDir: undefined,
        });

        expect(result.pages).toHaveLength(5);
    });

    it('retries on 429 with backoff', async () => {
        let attempt = 0;
        fetchMock.mockImplementation(async (url: string) => {
            if (url.endsWith('sitemap.xml')) {
                return new Response(`<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://docs.example.com/page</loc></url>
</urlset>`, { status: 200, headers: { 'content-type': 'application/xml' } });
            }
            if (url === 'https://docs.example.com/page') {
                attempt++;
                if (attempt <= 2) {
                    return new Response('', { status: 429, headers: { 'retry-after': '0' } });
                }
                return new Response('<html><body><p>Finally</p></body></html>', {
                    status: 200, headers: { 'content-type': 'text/html' },
                });
            }
            return new Response('', { status: 404 });
        });

        const result = await crawlSite('https://docs.example.com', {
            rateLimit: 100,
            maxPages: 10,
            cacheDir: undefined,
        });

        expect(result.pages).toHaveLength(1);
        expect(attempt).toBe(3);
    });

    it('detects SPA shells (body text < 100 chars) and warns', async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url.endsWith('sitemap.xml')) {
                return new Response(`<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://spa.example.com/page</loc></url>
</urlset>`, { status: 200, headers: { 'content-type': 'application/xml' } });
            }
            if (url === 'https://spa.example.com/page') {
                return new Response('<html><body><div id="root"></div><script src="/app.js"></script></body></html>', {
                    status: 200, headers: { 'content-type': 'text/html' },
                });
            }
            return new Response('', { status: 404 });
        });

        const result = await crawlSite('https://spa.example.com', {
            rateLimit: 100,
            maxPages: 10,
            cacheDir: undefined,
        });

        // Fix I4: use expect.arrayContaining for SPA detection assertion
        expect(result.warnings).toEqual(
            expect.arrayContaining([expect.stringContaining('SPA')])
        );
    });

    it('records 401/403 pages in failedUrls', async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url.endsWith('sitemap.xml')) {
                return new Response(`<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://docs.example.com/public</loc></url>
  <url><loc>https://docs.example.com/private</loc></url>
</urlset>`, { status: 200, headers: { 'content-type': 'application/xml' } });
            }
            if (url.includes('/public')) {
                return new Response('<html><body><p>Public</p></body></html>', {
                    status: 200, headers: { 'content-type': 'text/html' },
                });
            }
            if (url.includes('/private')) {
                return new Response('', { status: 403 });
            }
            return new Response('', { status: 404 });
        });

        const result = await crawlSite('https://docs.example.com', {
            rateLimit: 100,
            maxPages: 10,
            cacheDir: undefined,
        });

        expect(result.pages).toHaveLength(1);
        expect(result.failedUrls).toHaveLength(1);
        expect(result.failedUrls[0].url).toBe('https://docs.example.com/private');
        expect(result.failedUrls[0].status).toBe(403);
    });
});

// ── crawlSite network errors ────────────────────────────────────────────────

describe('crawlSite network errors', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('handles fetch timeout (AbortSignal) gracefully', async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url.endsWith('sitemap.xml')) {
                return new Response(`<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://docs.example.com/page</loc></url>
</urlset>`, { status: 200, headers: { 'content-type': 'application/xml' } });
            }
            if (url === 'https://docs.example.com/page') {
                throw new DOMException('The operation was aborted', 'AbortError');
            }
            return new Response('', { status: 404 });
        });

        const result = await crawlSite('https://docs.example.com', {
            rateLimit: 100,
            maxPages: 10,
            maxRetries: 1,
            cacheDir: undefined,
        });

        expect(result.pages).toHaveLength(0);
    });

    it('handles all pages returning 5xx after max retries', async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url.endsWith('sitemap.xml')) {
                return new Response(`<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://docs.example.com/page1</loc></url>
  <url><loc>https://docs.example.com/page2</loc></url>
</urlset>`, { status: 200, headers: { 'content-type': 'application/xml' } });
            }
            return new Response('Internal Server Error', { status: 500 });
        });

        const result = await crawlSite('https://docs.example.com', {
            rateLimit: 100,
            maxPages: 10,
            maxRetries: 1,
            cacheDir: undefined,
        });

        expect(result.pages).toHaveLength(0);
        expect(result.failedUrls.length).toBeGreaterThan(0);
    });

    it('tries sitemap_index.xml as fallback when sitemap.xml 404s', async () => {
        const fetchedUrls: string[] = [];
        fetchMock.mockImplementation(async (url: string) => {
            fetchedUrls.push(url);
            if (url === 'https://docs.example.com/sitemap.xml') {
                return new Response('', { status: 404 });
            }
            if (url === 'https://docs.example.com/sitemap_index.xml') {
                return new Response(`<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://docs.example.com/sitemap-pages.xml</loc></sitemap>
</sitemapindex>`, { status: 200, headers: { 'content-type': 'application/xml' } });
            }
            if (url === 'https://docs.example.com/sitemap-pages.xml') {
                return new Response(`<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://docs.example.com/page</loc></url>
</urlset>`, { status: 200, headers: { 'content-type': 'application/xml' } });
            }
            if (url === 'https://docs.example.com/page') {
                return new Response('<html><body><p>Content</p></body></html>', {
                    status: 200, headers: { 'content-type': 'text/html' },
                });
            }
            return new Response('', { status: 404 });
        });

        const result = await crawlSite('https://docs.example.com', {
            rateLimit: 100,
            maxPages: 10,
            cacheDir: undefined,
        });

        expect(fetchedUrls).toContain('https://docs.example.com/sitemap_index.xml');
        expect(result.pages).toHaveLength(1);
    });
});
