// HTML chunker — extracts semantic text content from HTML documents
// using cheerio for DOM traversal, splits on heading boundaries.

import * as cheerio from 'cheerio';
import type { CheerioAPI, Cheerio } from 'cheerio';
import type { Element, Text, AnyNode } from 'domhandler';
import { type ChunkOutput, type SourceConfig } from '../../types.js';

const DEFAULT_TARGET_TOKENS = 600;
const DEFAULT_OVERLAP_TOKENS = 50;

/** Elements to remove entirely before content extraction. */
const STRIP_SELECTORS = 'script, style, nav, footer, header, svg, noscript';

/** Selectors to try for the main content container, in priority order. */
const CONTENT_SELECTORS = ['main', 'article', '[role="main"]', '.content', '#content'];

/**
 * Extract text from a cheerio element, converting block elements to newlines
 * and preserving code blocks.
 */
function extractText($: CheerioAPI, el: Cheerio<AnyNode>): string {
    const lines: string[] = [];

    el.contents().each((_, node) => {
        if (node.type === 'text') {
            const text = (node as Text).data?.trim();
            if (text) lines.push(text);
            return;
        }

        if (node.type !== 'tag') return;
        const tagNode = node as Element;
        const tag = tagNode.tagName?.toLowerCase();
        const child = $(tagNode);

        if (tag === 'pre') {
            // Preserve code blocks with whitespace intact
            lines.push('\n```\n' + child.text() + '\n```\n');
        } else if (tag === 'ul') {
            child.children('li').each((_, li) => {
                lines.push('- ' + extractText($, $(li)));
            });
        } else if (tag === 'ol') {
            child.children('li').each((i, li) => {
                lines.push(`${i + 1}. ` + extractText($, $(li)));
            });
        } else if (tag === 'table') {
            child.find('tr').each((_, tr) => {
                const cells: string[] = [];
                $(tr).find('th, td').each((_, cell) => {
                    cells.push($(cell).text().trim());
                });
                if (cells.length > 0) lines.push(cells.join(' | '));
            });
        } else if (tag === 'img') {
            const alt = child.attr('alt');
            if (alt) lines.push(`[image: ${alt}]`);
        } else if (['p', 'div', 'blockquote', 'dd', 'section', 'figcaption'].includes(tag)) {
            const text = extractText($, child);
            if (text) lines.push(text);
        } else if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
            // Headings are split by the section splitter at the top level; here we just extract text content
            lines.push(child.text().trim());
        } else {
            // Recurse into other elements (spans, links, etc.)
            const text = extractText($, child);
            if (text) lines.push(text);
        }
    });

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Split content container into sections by heading elements (h1-h3).
 * Returns an array of { heading, level, content } objects.
 */
interface HtmlSection {
    heading: string | null;
    level: number;
    content: string;
}

function splitOnHeadings($: CheerioAPI, container: Cheerio<AnyNode>): HtmlSection[] {
    const sections: HtmlSection[] = [];
    let currentHeading: string | null = null;
    let currentLevel = 0;
    let currentContent: string[] = [];

    function flush() {
        const text = currentContent.join('\n').replace(/\n{3,}/g, '\n\n').trim();
        if (text) {
            sections.push({ heading: currentHeading, level: currentLevel, content: text });
        }
        currentContent = [];
    }

    // Walk all descendant nodes in document order, splitting on h1/h2/h3
    function walk(el: Cheerio<AnyNode>) {
        el.contents().each((_, node) => {
            if (node.type === 'text') {
                const text = (node as Text).data?.trim();
                if (text) currentContent.push(text);
                return;
            }
            if (node.type !== 'tag') return;
            const tagNode = node as Element;
            const tag = tagNode.tagName?.toLowerCase();

            if (tag && /^h[123]$/.test(tag)) {
                flush();
                currentHeading = $(tagNode).text().trim();
                currentLevel = parseInt(tag[1]);
                return; // Don't recurse into the heading
            }

            // h4-h6 are not section boundaries but should stand out in text
            if (tag && /^h[456]$/.test(tag)) {
                const text = $(tagNode).text().trim();
                if (text) currentContent.push('\n' + text);
                return;
            }

            // Block elements with special formatting — keep in sync with extractText
            if (tag === 'pre') {
                currentContent.push('\n```\n' + $(tagNode).text() + '\n```\n');
                return;
            }
            if (tag === 'ul') {
                $(tagNode).children('li').each((_, li) => {
                    currentContent.push('- ' + extractText($, $(li)));
                });
                return;
            }
            if (tag === 'ol') {
                $(tagNode).children('li').each((i, li) => {
                    currentContent.push(`${i + 1}. ` + extractText($, $(li)));
                });
                return;
            }
            if (tag === 'table') {
                $(tagNode).find('tr').each((_, tr) => {
                    const cells: string[] = [];
                    $(tr).find('th, td').each((_, cell) => {
                        cells.push($(cell).text().trim());
                    });
                    if (cells.length > 0) currentContent.push(cells.join(' | '));
                });
                return;
            }
            if (tag === 'img') {
                const alt = $(tagNode).attr('alt');
                if (alt) currentContent.push(`[image: ${alt}]`);
                return;
            }

            // Other block content elements — delegate to extractText
            if (['p', 'blockquote', 'dd', 'figcaption', 'dl', 'figure'].includes(tag)) {
                const text = extractText($, $(tagNode));
                if (text) currentContent.push(text);
                return;
            }

            // Recurse into container elements (section, div, article, etc.)
            walk($(tagNode));
        });
    }

    walk(container);
    flush();
    return sections;
}

/**
 * Build heading path from sections up to a given index.
 * Tracks h1 > h2 > h3 hierarchy (same concept as markdown chunker).
 */
function buildHeadingPath(sections: HtmlSection[], upToIndex: number): string[] {
    const stack: { level: number; text: string }[] = [];

    for (let i = 0; i <= upToIndex; i++) {
        const section = sections[i];
        if (!section.heading) continue;

        // Pop headings at same or deeper level
        while (stack.length > 0 && stack[stack.length - 1].level >= section.level) {
            stack.pop();
        }
        stack.push({ level: section.level, text: section.heading });
    }

    return stack.map(h => h.text);
}

/**
 * Merge small consecutive sections that share the same heading context,
 * then apply overlap between chunks.
 *
 * Sections with distinct headings are never merged — each heading-bearing
 * section becomes its own chunk so that headingPath stays accurate.
 * Only headingless content following the same heading gets merged.
 */
function mergeAndOverlap(sections: HtmlSection[], targetChars: number, overlapChars: number): { content: string; sectionIndex: number }[] {
    const merged: { content: string; sectionIndex: number }[] = [];
    let current = '';
    let currentIdx = 0;

    for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        const text = section.content;
        const separator = current ? '\n\n' : '';

        // Start a new chunk when the section has its own heading
        // (preserves headingPath per-section) or when size exceeds target
        const sizeExceeded = current && (current.length + separator.length + text.length) > targetChars;
        const hasNewHeading = section.heading !== null && current.length > 0;

        if (sizeExceeded || hasNewHeading) {
            if (current.trim()) {
                merged.push({ content: current, sectionIndex: currentIdx });
            }
            current = text;
            currentIdx = i;
        } else {
            if (!current) currentIdx = i;
            current = current ? current + separator + text : text;
        }
    }
    if (current.trim()) {
        merged.push({ content: current, sectionIndex: currentIdx });
    }

    // Apply overlap
    if (merged.length <= 1 || overlapChars <= 0) return merged;

    const result: { content: string; sectionIndex: number }[] = [merged[0]];
    for (let i = 1; i < merged.length; i++) {
        const prev = merged[i - 1].content;
        const overlapText = prev.slice(-overlapChars);
        const breakPoint = overlapText.lastIndexOf('\n');
        const cleanOverlap = breakPoint > 0 ? overlapText.slice(breakPoint) : overlapText;
        result.push({
            content: cleanOverlap + '\n\n' + merged[i].content,
            sectionIndex: merged[i].sectionIndex,
        });
    }

    return result;
}

/**
 * Extract title from HTML: <title> tag, then first <h1>, then filename.
 */
function extractTitle($: CheerioAPI, filePath: string): string {
    const titleTag = $('title').first().text().trim();
    if (titleTag) {
        // Strip " — SiteName" suffixes common in doc sites
        const dashIdx = titleTag.indexOf(' — ');
        return dashIdx > 0 ? titleTag.slice(0, dashIdx) : titleTag;
    }

    const h1 = $('h1').first().text().trim();
    if (h1) return h1;

    return filePath.split('/').pop() ?? filePath;
}

/**
 * Chunk HTML content into embedding-friendly chunks.
 * Follows the ChunkerFn signature: (content, filePath, config) => ChunkOutput[]
 */
export function chunkHtml(content: string, filePath: string, config: SourceConfig): ChunkOutput[] {
    if (!content || !content.trim()) {
        return [];
    }

    const $ = cheerio.load(content);

    // Strip non-content elements
    $(STRIP_SELECTORS).remove();

    // Find the main content container
    let container: Cheerio<AnyNode> | null = null;
    for (const selector of CONTENT_SELECTORS) {
        const found = $(selector).first();
        if (found.length > 0) {
            container = found;
            break;
        }
    }
    if (!container) {
        container = $('body');
    }

    if (!container || container.length === 0) {
        return [];
    }

    const title = extractTitle($, filePath);
    const targetChars = (config.chunk?.target_tokens ?? DEFAULT_TARGET_TOKENS) * 4;
    const overlapChars = (config.chunk?.overlap_tokens ?? DEFAULT_OVERLAP_TOKENS) * 4;

    // Split content on heading boundaries
    const sections = splitOnHeadings($, container);

    if (sections.length === 0) {
        // No headings — treat entire content as one section
        const text = extractText($, container);
        if (!text.trim()) return [];
        return [{
            content: text.trim(),
            title,
            headingPath: [],
            chunkIndex: 0,
        }];
    }

    // Merge small sections and apply overlap
    const merged = mergeAndOverlap(sections, targetChars, overlapChars);

    return merged.map((chunk, i) => ({
        content: chunk.content,
        title,
        headingPath: buildHeadingPath(sections, chunk.sectionIndex),
        chunkIndex: i,
    }));
}
