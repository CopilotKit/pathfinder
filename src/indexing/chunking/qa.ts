// Q&A chunker — formats distilled Q&A pairs for embedding.
// Source-agnostic: used by any source that produces Q&A-formatted content.

import type { ChunkOutput, SourceConfig } from '../../types.js';

/**
 * Chunk Q&A content. Each content item from a FAQ-category provider
 * is a single Q&A pair, already sized appropriately.
 * The chunker formats it and returns a single ChunkOutput.
 */
export function chunkQa(content: string, filePath: string, config: SourceConfig): ChunkOutput[] {
    if (!content || !content.trim()) {
        return [];
    }

    // The content is already formatted as "Q: ...\n\nA: ..." by the provider.
    // Extract the question for use as title.
    const questionMatch = content.match(/^Q:\s*(.+?)(?:\n|$)/);
    const title = questionMatch ? questionMatch[1].trim() : undefined;

    return [{
        content: content.trim(),
        title,
        chunkIndex: 0,
    }];
}
