// Recursive markdown/MDX splitter

import { type ChunkOutput, type SourceConfig } from '../../types.js';

export interface MarkdownChunk {
    content: string;
    title: string;
    headingPath: string[];
    chunkIndex: number;
}

const DEFAULT_TARGET_TOKENS = 600;
const DEFAULT_OVERLAP_TOKENS = 50;

/**
 * Parse YAML frontmatter from markdown content.
 * Returns the title (if found) and the content with frontmatter stripped.
 */
function parseFrontmatter(content: string): { title: string | null; body: string } {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!match) return { title: null, body: content };

    const frontmatter = match[1];
    const body = content.slice(match[0].length);

    const titleMatch = frontmatter.match(/^title:\s*["']?(.+?)["']?\s*$/m);
    return {
        title: titleMatch ? titleMatch[1].trim() : null,
        body,
    };
}

/**
 * Extract the first heading from content to use as fallback title.
 */
function extractFirstHeading(content: string): string | null {
    const match = content.match(/^#{1,6}\s+(.+)$/m);
    return match ? match[1].trim() : null;
}

/**
 * Strip MDX-specific syntax: import statements and JSX component tags.
 * Preserves text content inside JSX tags.
 */
function stripMdx(content: string): string {
    // Strip import statements (single and multi-line)
    let result = content.replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '');

    // Strip self-closing JSX tags: <Component ... />
    result = result.replace(/<[A-Z][A-Za-z0-9]*(?:\s+[^>]*)?\s*\/>/g, '');

    // Strip JSX component open/close tags but keep inner content
    // Handles nested tags by repeatedly stripping innermost pairs
    let prev = '';
    while (prev !== result) {
        prev = result;
        result = result.replace(/<([A-Z][A-Za-z0-9]*)(?:\s+[^>]*)?>([^]*?)<\/\1>/g, '$2');
    }

    // Clean up excessive blank lines left by stripping
    result = result.replace(/\n{3,}/g, '\n\n');

    return result.trim();
}

/**
 * Split content while preserving code blocks intact.
 * Returns segments that are either code blocks or regular text.
 */
interface ContentSegment {
    text: string;
    isCodeBlock: boolean;
}

function segmentCodeBlocks(content: string): ContentSegment[] {
    const segments: ContentSegment[] = [];
    const codeBlockRegex = /^(`{3,})[^\n]*\n(?:[\s\S]*?\n)?\1\s*$/gm;

    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = codeBlockRegex.exec(content)) !== null) {
        if (match.index > lastIndex) {
            segments.push({ text: content.slice(lastIndex, match.index), isCodeBlock: false });
        }
        segments.push({ text: match[0], isCodeBlock: true });
        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < content.length) {
        segments.push({ text: content.slice(lastIndex), isCodeBlock: false });
    }

    return segments;
}

/**
 * Split text on a delimiter, but never split inside code blocks.
 */
function splitPreservingCodeBlocks(content: string, delimiter: string | RegExp): string[] {
    const segments = segmentCodeBlocks(content);
    const parts: string[] = [];
    let current = '';

    for (const segment of segments) {
        if (segment.isCodeBlock) {
            current += segment.text;
        } else {
            const subParts = typeof delimiter === 'string'
                ? segment.text.split(delimiter)
                : segment.text.split(delimiter);

            if (subParts.length === 1) {
                current += subParts[0];
            } else {
                // First sub-part continues the current accumulator
                current += subParts[0];
                for (let i = 1; i < subParts.length; i++) {
                    parts.push(current);
                    // Re-attach the delimiter for heading-based splits
                    if (typeof delimiter === 'string' && delimiter.startsWith('#')) {
                        current = delimiter + subParts[i];
                    } else {
                        current = subParts[i];
                    }
                }
            }
        }
    }
    if (current) {
        parts.push(current);
    }

    return parts.filter(p => p.trim().length > 0);
}


interface HeadingInfo {
    level: number;
    text: string;
}

/**
 * Track heading hierarchy up to a given position in the original content.
 */
function getHeadingPathAtPosition(fullContent: string, position: number): string[] {
    const contentBefore = fullContent.slice(0, position);
    const headingRegex = /^(#{1,6})\s+(.+)$/gm;
    const headings: HeadingInfo[] = [];
    let match: RegExpExecArray | null;

    while ((match = headingRegex.exec(contentBefore)) !== null) {
        const level = match[1].length;
        const text = match[2].trim();

        // Remove headings at same or deeper level (new section at this level)
        while (headings.length > 0 && headings[headings.length - 1].level >= level) {
            headings.pop();
        }
        headings.push({ level, text });
    }

    return headings.map(h => h.text);
}

/**
 * Split text on heading boundaries at a specific level.
 * Re-attaches the heading marker to each section.
 */
function splitOnHeading(content: string, level: number): string[] {
    const prefix = '#'.repeat(level) + ' ';
    const regex = new RegExp(`(?=^${prefix.replace(/ $/, ' ')})`, 'gm');

    const segments = segmentCodeBlocks(content);
    const parts: string[] = [];
    let current = '';

    for (const segment of segments) {
        if (segment.isCodeBlock) {
            current += segment.text;
        } else {
            const subParts = segment.text.split(regex);
            if (subParts.length === 1) {
                current += subParts[0];
            } else {
                current += subParts[0];
                for (let i = 1; i < subParts.length; i++) {
                    if (current.trim()) parts.push(current);
                    current = subParts[i];
                }
            }
        }
    }
    if (current.trim()) parts.push(current);

    return parts;
}

/**
 * Recursively split content to fit within target chunk size.
 * Priority: h2 -> h3 -> paragraph -> line
 */
function recursiveSplit(content: string, targetChars: number, depth: number = 0): string[] {
    if (content.length <= targetChars) {
        return [content];
    }

    let parts: string[];

    if (depth === 0) {
        // Split on ## headings
        parts = splitOnHeading(content, 2);
        if (parts.length > 1) {
            return parts.flatMap(p => recursiveSplit(p, targetChars, 1));
        }
    }

    if (depth <= 1) {
        // Split on ### headings
        parts = splitOnHeading(content, 3);
        if (parts.length > 1) {
            return parts.flatMap(p => recursiveSplit(p, targetChars, 2));
        }
    }

    if (depth <= 2) {
        // Split on paragraph boundaries
        parts = splitPreservingCodeBlocks(content, /\n\n+/);
        if (parts.length > 1) {
            return mergeSmallParts(parts, targetChars).flatMap(p => recursiveSplit(p, targetChars, 3));
        }
    }

    // Split on line boundaries
    const lines = content.split('\n');
    if (lines.length > 1) {
        return mergeSmallParts(lines, targetChars);
    }

    // Content is a single very long line; return as-is
    return [content];
}

/**
 * Merge adjacent small parts until they approach the target size.
 */
function mergeSmallParts(parts: string[], targetSize: number): string[] {
    const merged: string[] = [];
    let current = '';

    for (const part of parts) {
        const separator = current && !current.endsWith('\n') ? '\n\n' : '';
        if (current && (current.length + separator.length + part.length) > targetSize) {
            merged.push(current);
            current = part;
        } else {
            current = current ? current + separator + part : part;
        }
    }
    if (current.trim()) {
        merged.push(current);
    }

    return merged;
}

/**
 * Apply overlap between consecutive chunks.
 */
function applyOverlap(chunks: string[], overlapChars: number): string[] {
    if (chunks.length <= 1 || overlapChars <= 0) return chunks;

    const result: string[] = [chunks[0]];
    for (let i = 1; i < chunks.length; i++) {
        const prevChunk = chunks[i - 1];
        const overlapText = prevChunk.slice(-overlapChars);

        // Find a clean break point (newline or space) in the overlap
        const breakPoint = overlapText.lastIndexOf('\n');
        const cleanOverlap = breakPoint > 0 ? overlapText.slice(breakPoint) : overlapText;

        result.push(cleanOverlap + chunks[i]);
    }

    return result;
}

/**
 * Split markdown/MDX content into embedding-friendly chunks.
 *
 * @param content - The full markdown/MDX file content
 * @param filePath - Path to the source file (used for metadata)
 * @returns Array of MarkdownChunk objects
 */
export function chunkMarkdown(content: string, filePath: string, config: SourceConfig): ChunkOutput[] {
    if (!content || !content.trim()) {
        return [];
    }

    const targetChars = (config.chunk?.target_tokens ?? DEFAULT_TARGET_TOKENS) * 4;
    const overlapChars = (config.chunk?.overlap_tokens ?? DEFAULT_OVERLAP_TOKENS) * 4;

    // Parse frontmatter
    const { title: fmTitle, body } = parseFrontmatter(content);

    // Strip MDX syntax
    const cleanBody = stripMdx(body);

    if (!cleanBody.trim()) {
        return [];
    }

    // Determine title
    const title = fmTitle || extractFirstHeading(cleanBody) || filePath.split('/').pop() || filePath;

    // Recursively split the content
    const rawChunks = recursiveSplit(cleanBody, targetChars);

    // Apply overlap
    const overlappedChunks = applyOverlap(rawChunks, overlapChars);

    // Build heading paths by finding where each raw chunk starts in the original
    const chunks: ChunkOutput[] = [];
    let searchFrom = 0;

    for (let i = 0; i < overlappedChunks.length; i++) {
        const chunkText = overlappedChunks[i].trim();
        if (!chunkText) continue;

        // Find the position of this chunk's primary content in the clean body
        // Use the raw (non-overlapped) chunk to find position
        const rawText = rawChunks[i]?.trim() || chunkText;
        const pos = cleanBody.indexOf(rawText, searchFrom);
        const headingPath = pos >= 0
            ? getHeadingPathAtPosition(cleanBody, pos)
            : [];
        if (pos >= 0) {
            searchFrom = pos;
        }

        chunks.push({
            content: chunkText,
            title,
            headingPath,
            chunkIndex: chunks.length,
        });
    }

    return chunks;
}
