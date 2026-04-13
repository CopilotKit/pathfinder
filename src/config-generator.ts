// Config generator: produces pathfinder.yaml from crawl results.

import * as cheerio from 'cheerio';
import { stringify as stringifyYaml } from 'yaml';
import type { CrawlResult, CrawledPage } from './crawl.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface GeneratedConfig {
    server: {
        name: string;
        version: string;
    };
    sources: GeneratedSource[];
    tools: GeneratedTool[];
    embedding: {
        provider: string;
        model: string;
        dimensions: number;
    };
    indexing: {
        auto_reindex: boolean;
        reindex_hour_utc: number;
        stale_threshold_hours: number;
    };
}

interface GeneratedSource {
    name: string;
    type: string;
    path: string;
    file_patterns: string[];
    base_url: string;
    repo?: string;
    content_selector?: string;
    chunk: {
        target_tokens: number;
        overlap_tokens: number;
    };
}

interface GeneratedTool {
    name: string;
    type: string;
    description: string;
    source: string;
    default_limit: number;
    max_limit: number;
    result_format: string;
}

// ── Source type detection ───────────────────────────────────────────────────

/**
 * Detect whether crawled pages are HTML or markdown.
 * Checks URL extensions and content-type headers.
 */
export function detectSourceType(pages: CrawledPage[]): 'html' | 'markdown' {
    if (pages.length === 0) return 'html';

    const mdCount = pages.filter(p => {
        const urlPath = new URL(p.url).pathname;
        return urlPath.endsWith('.md') || urlPath.endsWith('.mdx');
    }).length;

    // If majority of pages are .md/.mdx files, it's a markdown source
    if (mdCount > pages.length * 0.5) return 'markdown';
    return 'html';
}

// ── Base URL derivation ────────────────────────────────────────────────────

/**
 * Find the common URL path prefix across all page URLs.
 * Strips the final path component (which varies per page).
 */
export function deriveBaseUrl(urls: string[]): string {
    if (urls.length === 0) return '';
    if (urls.length === 1) {
        const parsed = new URL(urls[0]);
        const segments = parsed.pathname.split('/').filter(Boolean);
        segments.pop(); // remove the page-specific segment
        return parsed.origin + (segments.length > 0 ? '/' + segments.join('/') : '');
    }

    const parsed = urls.map(u => new URL(u));
    const origin = parsed[0].origin;

    // Find common path prefix
    const pathSegments = parsed.map(p => p.pathname.split('/').filter(Boolean));
    const minLen = Math.min(...pathSegments.map(s => s.length));

    const commonSegments: string[] = [];
    for (let i = 0; i < minLen; i++) {
        const seg = pathSegments[0][i];
        if (pathSegments.every(s => s[i] === seg)) {
            commonSegments.push(seg);
        } else {
            break;
        }
    }

    return origin + (commonSegments.length > 0 ? '/' + commonSegments.join('/') : '');
}

// ── File pattern derivation ────────────────────────────────────────────────

export function deriveFilePatterns(sourceType: string): string[] {
    if (sourceType === 'markdown') return ['**/*.md', '**/*.mdx'];
    return ['**/*.html'];
}

// ── Content selector detection ─────────────────────────────────────────────

/**
 * Detect the main content container selector from an HTML page.
 * Checks for semantic elements in priority order.
 */
export function detectContentSelector(html: string): string | null {
    const $ = cheerio.load(html);

    if ($('main').length > 0) return 'main';
    if ($('article').length > 0) return 'article';
    if ($('[role="main"]').length > 0) return '[role="main"]';
    if ($('.content').length > 0) return '.content';
    if ($('#content').length > 0) return '#content';

    return null;
}

// ── Server name derivation ──────────────────────────────────────────────────

function deriveServerName(url: string): string {
    const parsed = new URL(url);
    let hostname = parsed.hostname;

    // Strip common prefixes
    hostname = hostname.replace(/^(www|docs|api)\./, '');

    // Strip common suffixes
    hostname = hostname.replace(/\.(readthedocs|github|gitlab)\.(io|com|org)$/, '');
    hostname = hostname.replace(/\.(com|org|io|dev|net)$/, '');

    // Replace dots and special chars with hyphens
    const name = hostname.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-');

    return `${name}-docs`;
}

// ── Git-hosted docs detection ───────────────────────────────────────────────

interface GitRepoInfo {
    repoUrl: string;
    docsPath: string;
}

function detectGitRepo(url: string): GitRepoInfo | null {
    const parsed = new URL(url);

    // GitHub: https://github.com/org/repo or https://github.com/org/repo/tree/main/docs
    if (parsed.hostname === 'github.com') {
        const segments = parsed.pathname.split('/').filter(Boolean);
        if (segments.length >= 2) {
            const repoUrl = `https://github.com/${segments[0]}/${segments[1]}.git`;
            // Try to extract docs path from URL
            let docsPath = '';
            if (segments.length > 4 && (segments[2] === 'tree' || segments[2] === 'blob')) {
                // segments[3] is branch, segments[4+] is path
                docsPath = segments.slice(4).join('/');
            }
            return { repoUrl, docsPath: docsPath || 'docs/' };
        }
    }

    // GitLab: similar pattern
    if (parsed.hostname === 'gitlab.com' || parsed.hostname.includes('gitlab')) {
        const segments = parsed.pathname.split('/').filter(Boolean);
        if (segments.length >= 2) {
            const repoUrl = `https://${parsed.hostname}/${segments[0]}/${segments[1]}.git`;
            return { repoUrl, docsPath: 'docs/' };
        }
    }

    return null;
}

// ── Main config generation ──────────────────────────────────────────────────

export function generateConfig(crawlResult: CrawlResult, inputUrl: string): GeneratedConfig {
    const sourceType = detectSourceType(crawlResult.pages);
    const pageUrls = crawlResult.pages.map(p => p.url);
    const baseUrl = deriveBaseUrl(pageUrls);
    const filePatterns = deriveFilePatterns(sourceType);
    const serverName = deriveServerName(inputUrl);

    // Check for git-hosted docs
    const gitRepo = detectGitRepo(inputUrl);
    const hostname = new URL(inputUrl).hostname;

    // Fix I2: detect content selector and wire into source config
    const contentSelector = crawlResult.pages.length > 0
        ? detectContentSelector(crawlResult.pages[0].html)
        : null;

    const source: GeneratedSource = {
        name: 'docs',
        type: sourceType,
        path: gitRepo ? gitRepo.docsPath : `.pathfinder/cache/${hostname}`,
        file_patterns: filePatterns,
        base_url: baseUrl || inputUrl,
        chunk: {
            target_tokens: 600,
            overlap_tokens: 50,
        },
    };

    if (gitRepo) {
        source.repo = gitRepo.repoUrl;
    }

    if (contentSelector) {
        source.content_selector = contentSelector;
    }

    const tool: GeneratedTool = {
        name: 'search-docs',
        type: 'search',
        description: `Search ${serverName.replace(/-/g, ' ')} for relevant information`,
        source: 'docs',
        default_limit: 5,
        max_limit: 20,
        result_format: 'docs',
    };

    return {
        server: {
            name: serverName,
            version: '1.0.0',
        },
        sources: [source],
        tools: [tool],
        embedding: {
            provider: 'openai',
            model: 'text-embedding-3-small',
            dimensions: 1536,
        },
        indexing: {
            auto_reindex: true,
            reindex_hour_utc: 3,
            stale_threshold_hours: 24,
        },
    };
}

/**
 * Generate a complete pathfinder.yaml string from crawl results.
 */
export function generateConfigYaml(crawlResult: CrawlResult, inputUrl: string): string {
    const config = generateConfig(crawlResult, inputUrl);

    const header = [
        '# Pathfinder configuration — auto-generated from ' + inputUrl,
        '# Review and customize before running: pathfinder serve',
        '# Full documentation: https://pathfinder.copilotkit.dev',
        '',
    ].join('\n');

    return header + stringifyYaml(config, {
        lineWidth: 120,
        defaultStringType: 'QUOTE_DOUBLE',
        defaultKeyType: 'PLAIN',
    });
}
