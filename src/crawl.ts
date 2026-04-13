// Site crawler for auto-generating pathfinder.yaml from a documentation URL.
// Strategy: sitemap.xml → sitemap_index.xml → robots.txt Sitemap: → recursive link following.

import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

// ── Types ───────────────────────────────────────────────────────────────────

export interface CrawlOptions {
    /** Milliseconds between requests. Default 500 (2 req/s). */
    rateLimit?: number;
    /** Maximum pages to fetch. Default 500. */
    maxPages?: number;
    /** Maximum link-follow depth for recursive crawling. Default 3. */
    maxDepth?: number;
    /** Directory to cache fetched pages. Undefined = no caching. */
    cacheDir?: string;
    /** Maximum retries on 429/5xx. Default 3. */
    maxRetries?: number;
}

export interface CrawledPage {
    url: string;
    html: string;
    contentType: string;
    /** Text content length (body text after stripping tags). */
    textLength: number;
}

export interface CrawlResult {
    pages: CrawledPage[];
    discoveryMethod: 'sitemap' | 'sitemap-index' | 'robots-sitemap' | 'crawl';
    baseUrl: string;
    warnings: string[];
    failedUrls: { url: string; status: number; reason: string }[];
}

// ── Sitemap parsing ─────────────────────────────────────────────────────────

/**
 * Parse a sitemap.xml and extract all <loc> URLs.
 * Uses cheerio in XML mode for reliable parsing.
 */
export function parseSitemap(xml: string): string[] {
    if (!xml || !xml.trim()) return [];
    try {
        const $ = cheerio.load(xml, { xml: true });
        const urls: string[] = [];
        $('url > loc').each((_, el) => {
            const text = $(el).text().trim();
            if (text) urls.push(text);
        });
        return urls;
    } catch {
        return [];
    }
}

/**
 * Parse a sitemap index and extract child sitemap URLs.
 */
export function parseSitemapIndex(xml: string): string[] {
    if (!xml || !xml.trim()) return [];
    try {
        const $ = cheerio.load(xml, { xml: true });
        const urls: string[] = [];
        $('sitemap > loc').each((_, el) => {
            const text = $(el).text().trim();
            if (text) urls.push(text);
        });
        return urls;
    } catch {
        return [];
    }
}

// ── Link extraction ─────────────────────────────────────────────────────────

/**
 * Extract same-origin links from an HTML page.
 * Strips hash fragments, deduplicates, ignores mailto:/javascript:/tel:/data:.
 */
export function extractLinks(html: string, baseUrl: string): string[] {
    const $ = cheerio.load(html);
    const origin = new URL(baseUrl).origin;
    const seen = new Set<string>();
    const links: string[] = [];

    $('a[href]').each((_, el) => {
        const raw = $(el).attr('href');
        if (!raw) return;
        if (raw.startsWith('mailto:') || raw.startsWith('javascript:') || raw.startsWith('tel:') || raw.startsWith('data:')) return;

        try {
            const resolved = new URL(raw, baseUrl);
            // Strip hash fragment
            resolved.hash = '';
            // Fix I1: push normalized URL (trailing slash removed) for consistent dedup
            const normalized = resolved.href.replace(/\/$/, '');

            if (resolved.origin === origin && !seen.has(normalized)) {
                seen.add(normalized);
                links.push(normalized);
            }
        } catch {
            // Invalid URL, skip
        }
    });

    return links;
}

// ── robots.txt ──────────────────────────────────────────────────────────────

/**
 * Check if a path is allowed by robots.txt rules.
 * Simplified parser: only handles User-agent: * rules.
 */
export function respectsRobotsTxt(robotsTxt: string, path: string): boolean {
    if (!robotsTxt.trim()) return true;

    const lines = robotsTxt.split('\n');
    let inGlobalBlock = false;
    const disallowed: string[] = [];

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.toLowerCase().startsWith('user-agent:')) {
            const agent = line.slice('user-agent:'.length).trim();
            inGlobalBlock = agent === '*';
            continue;
        }
        if (inGlobalBlock && line.toLowerCase().startsWith('disallow:')) {
            const rule = line.slice('disallow:'.length).trim();
            if (rule) disallowed.push(rule);
        }
    }

    for (const rule of disallowed) {
        if (path.startsWith(rule)) return false;
    }
    return true;
}

/**
 * Extract Sitemap: directives from robots.txt.
 */
export function extractSitemapsFromRobotsTxt(robotsTxt: string): string[] {
    const sitemaps: string[] = [];
    for (const rawLine of robotsTxt.split('\n')) {
        const line = rawLine.trim();
        if (line.toLowerCase().startsWith('sitemap:')) {
            const url = line.slice('sitemap:'.length).trim();
            if (url) sitemaps.push(url);
        }
    }
    return sitemaps;
}

// ── Rate-limited fetcher ────────────────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

interface FetchResult {
    ok: boolean;
    status: number;
    body: string;
    contentType: string;
}

async function rateLimitedFetch(
    url: string,
    rateLimit: number,
    maxRetries: number,
    lastFetchTime: { value: number },
): Promise<FetchResult> {
    // Rate limiting
    const now = Date.now();
    const elapsed = now - lastFetchTime.value;
    if (elapsed < rateLimit) {
        await sleep(rateLimit - elapsed);
    }
    lastFetchTime.value = Date.now();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Pathfinder/1.0 (https://pathfinder.copilotkit.dev)',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                },
                signal: AbortSignal.timeout(15000),
            });

            if (response.status === 429) {
                if (attempt < maxRetries) {
                    const retryAfter = parseInt(response.headers.get('retry-after') || '2', 10);
                    const backoff = Math.max(retryAfter * 1000, (attempt + 1) * 1000);
                    await sleep(backoff);
                    continue;
                }
            }

            if (response.status >= 500 && attempt < maxRetries) {
                await sleep((attempt + 1) * 1000);
                continue;
            }

            const body = await response.text();
            const contentType = response.headers.get('content-type') || '';

            return {
                ok: response.ok,
                status: response.status,
                body,
                contentType,
            };
        } catch (err) {
            if (attempt < maxRetries) {
                await sleep((attempt + 1) * 1000);
                continue;
            }
            return {
                ok: false,
                status: 0,
                body: '',
                contentType: '',
            };
        }
    }

    // Should not reach here, but TypeScript needs it
    return { ok: false, status: 0, body: '', contentType: '' };
}

// ── Page content analysis ───────────────────────────────────────────────────

/**
 * Extract visible text length from HTML body.
 * Used to detect SPA shells that render client-side.
 */
function getBodyTextLength(html: string): number {
    const $ = cheerio.load(html);
    $('script, style, noscript').remove();
    return $('body').text().trim().length;
}

// ── Cache helpers ───────────────────────────────────────────────────────────

function urlToCachePath(cacheDir: string, url: string): string {
    const parsed = new URL(url);
    // Convert URL path to filesystem path
    let filePath = parsed.pathname.replace(/\/$/, '') || '/index';
    if (!path.extname(filePath)) {
        filePath += '.html';
    }
    return path.join(cacheDir, parsed.hostname, filePath);
}

function readCache(cachePath: string): string | null {
    try {
        return fs.readFileSync(cachePath, 'utf-8');
    } catch {
        return null;
    }
}

function writeCache(cachePath: string, content: string): void {
    try {
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, content, 'utf-8');
    } catch {
        // Non-fatal: cache write failure is silently ignored
    }
}

// ── SPA detection helper ────────────────────────────────────────────────────

function checkSpaWarnings(pages: CrawledPage[], warnings: string[]): void {
    const spaPages = pages.filter(p => p.textLength < 100);
    if (spaPages.length > pages.length * 0.5 && pages.length > 0) {
        warnings.push(
            `SPA detected: ${spaPages.length}/${pages.length} pages have very little text content. ` +
            `This site may render content client-side with JavaScript. ` +
            `Consider using a headless browser or finding a static/pre-rendered version.`
        );
    }
}

// ── Main crawl function ─────────────────────────────────────────────────────

export async function crawlSite(url: string, options: CrawlOptions = {}): Promise<CrawlResult> {
    const rateLimit = options.rateLimit ?? 500;
    const maxPages = options.maxPages ?? 500;
    const maxDepth = options.maxDepth ?? 3;
    const maxRetries = options.maxRetries ?? 3;
    const cacheDir = options.cacheDir;

    const baseUrlObj = new URL(url);
    const baseUrl = baseUrlObj.origin;
    const lastFetchTime = { value: 0 };

    const pages: CrawledPage[] = [];
    const failedUrls: CrawlResult['failedUrls'] = [];
    const warnings: string[] = [];
    const visited = new Set<string>();

    // Helper to normalize URLs for consistent dedup (strip trailing slash)
    function normalizeUrl(u: string): string {
        return u.replace(/\/$/, '');
    }

    // Helper to fetch and store a page
    async function fetchPage(pageUrl: string): Promise<CrawledPage | null> {
        const normalized = normalizeUrl(pageUrl);
        if (visited.has(normalized) || pages.length >= maxPages) return null;
        visited.add(normalized);

        // Check cache first
        if (cacheDir) {
            const cachePath = urlToCachePath(cacheDir, pageUrl);
            const cached = readCache(cachePath);
            if (cached !== null) {
                const textLength = getBodyTextLength(cached);
                return { url: pageUrl, html: cached, contentType: 'text/html', textLength };
            }
        }

        const result = await rateLimitedFetch(pageUrl, rateLimit, maxRetries, lastFetchTime);

        if (!result.ok) {
            if (result.status === 401 || result.status === 403) {
                failedUrls.push({ url: pageUrl, status: result.status, reason: 'auth-required' });
            } else if (result.status !== 404) {
                failedUrls.push({ url: pageUrl, status: result.status, reason: 'fetch-error' });
            }
            return null;
        }

        // Only process HTML responses
        if (!result.contentType.includes('text/html') && !result.contentType.includes('application/xhtml')) {
            return null;
        }

        const textLength = getBodyTextLength(result.body);

        // Cache the page
        if (cacheDir) {
            const cachePath = urlToCachePath(cacheDir, pageUrl);
            writeCache(cachePath, result.body);
        }

        return { url: pageUrl, html: result.body, contentType: result.contentType, textLength };
    }

    // Fetch robots.txt early so sitemap-discovered URLs can be filtered
    const robotsResult = await rateLimitedFetch(`${baseUrl}/robots.txt`, rateLimit, maxRetries, lastFetchTime);
    let robotsTxt = '';
    if (robotsResult.ok) {
        robotsTxt = robotsResult.body;
    }

    // Helper to fetch pages from a list of URLs discovered via sitemap
    async function fetchSitemapPages(allPageUrls: string[]): Promise<void> {
        const urlsToFetch = allPageUrls.slice(0, maxPages);
        for (const pageUrl of urlsToFetch) {
            if (pages.length >= maxPages) break;
            // Enforce robots.txt on sitemap-discovered URLs
            if (robotsTxt) {
                const pathname = new URL(pageUrl).pathname;
                if (!respectsRobotsTxt(robotsTxt, pathname)) continue;
            }
            const page = await fetchPage(pageUrl);
            if (page) pages.push(page);
        }
    }

    // ── Strategy 1: Try sitemap.xml ─────────────────────────────────────────

    const sitemapResult = await rateLimitedFetch(`${baseUrl}/sitemap.xml`, rateLimit, maxRetries, lastFetchTime);
    if (sitemapResult.ok) {
        // Check if it's a sitemap index
        const indexUrls = parseSitemapIndex(sitemapResult.body);
        let allPageUrls: string[] = [];

        if (indexUrls.length > 0) {
            // Fetch each child sitemap
            for (const sitemapUrl of indexUrls) {
                const childResult = await rateLimitedFetch(sitemapUrl, rateLimit, maxRetries, lastFetchTime);
                if (childResult.ok) {
                    allPageUrls.push(...parseSitemap(childResult.body));
                }
            }
        } else {
            allPageUrls = parseSitemap(sitemapResult.body);
        }

        if (allPageUrls.length > 0) {
            await fetchSitemapPages(allPageUrls);
            checkSpaWarnings(pages, warnings);

            return {
                pages,
                discoveryMethod: indexUrls.length > 0 ? 'sitemap-index' : 'sitemap',
                baseUrl,
                warnings,
                failedUrls,
            };
        }
    }

    // ── Strategy 1b: Try sitemap_index.xml as fallback (Fix I3) ─────────────

    const sitemapIndexResult = await rateLimitedFetch(`${baseUrl}/sitemap_index.xml`, rateLimit, maxRetries, lastFetchTime);
    if (sitemapIndexResult.ok) {
        const indexUrls = parseSitemapIndex(sitemapIndexResult.body);
        if (indexUrls.length > 0) {
            let allPageUrls: string[] = [];
            for (const sitemapUrl of indexUrls) {
                const childResult = await rateLimitedFetch(sitemapUrl, rateLimit, maxRetries, lastFetchTime);
                if (childResult.ok) {
                    allPageUrls.push(...parseSitemap(childResult.body));
                }
            }

            if (allPageUrls.length > 0) {
                await fetchSitemapPages(allPageUrls);
                checkSpaWarnings(pages, warnings);

                return {
                    pages,
                    discoveryMethod: 'sitemap-index',
                    baseUrl,
                    warnings,
                    failedUrls,
                };
            }
        }
    }

    // ── Strategy 2: Try robots.txt for Sitemap: directives ──────────────────
    // (robots.txt already fetched above for filtering)

    if (robotsResult.ok) {
        const sitemapUrls = extractSitemapsFromRobotsTxt(robotsTxt);

        if (sitemapUrls.length > 0) {
            let allPageUrls: string[] = [];
            for (const sitemapUrl of sitemapUrls) {
                const smResult = await rateLimitedFetch(sitemapUrl, rateLimit, maxRetries, lastFetchTime);
                if (smResult.ok) {
                    // Could be sitemap index or regular sitemap
                    const indexUrls = parseSitemapIndex(smResult.body);
                    if (indexUrls.length > 0) {
                        for (const childUrl of indexUrls) {
                            const childResult = await rateLimitedFetch(childUrl, rateLimit, maxRetries, lastFetchTime);
                            if (childResult.ok) {
                                allPageUrls.push(...parseSitemap(childResult.body));
                            }
                        }
                    } else {
                        allPageUrls.push(...parseSitemap(smResult.body));
                    }
                }
            }

            if (allPageUrls.length > 0) {
                await fetchSitemapPages(allPageUrls);
                checkSpaWarnings(pages, warnings);

                return {
                    pages,
                    discoveryMethod: 'robots-sitemap',
                    baseUrl,
                    warnings,
                    failedUrls,
                };
            }
        }
    }

    // ── Strategy 3: Recursive link crawling ─────────────────────────────────

    // BFS crawl from the root URL
    const queue: { url: string; depth: number }[] = [{ url: normalizeUrl(url), depth: 0 }];

    while (queue.length > 0 && pages.length < maxPages) {
        const current = queue.shift()!;
        if (visited.has(normalizeUrl(current.url))) continue;

        // Check robots.txt disallow rules
        const pathname = new URL(current.url).pathname;
        if (robotsTxt && !respectsRobotsTxt(robotsTxt, pathname)) {
            continue;
        }

        const page = await fetchPage(current.url);
        if (!page) continue;
        pages.push(page);

        // Only follow links if we haven't reached max depth
        if (current.depth < maxDepth) {
            const links = extractLinks(page.html, current.url);
            for (const link of links) {
                if (!visited.has(normalizeUrl(link))) {
                    queue.push({ url: normalizeUrl(link), depth: current.depth + 1 });
                }
            }
        }
    }

    checkSpaWarnings(pages, warnings);

    return {
        pages,
        discoveryMethod: 'crawl',
        baseUrl,
        warnings,
        failedUrls,
    };
}
