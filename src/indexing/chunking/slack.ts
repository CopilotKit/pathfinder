// Slack chunker — formats distilled Q&A pairs for embedding.
// Minimal: each Q&A pair is already a self-contained chunk from the distiller.

import type { ChunkOutput, SourceConfig } from '../../types.js';

/**
 * Chunk Slack Q&A content. Each content item from the SlackDataProvider
 * is a single Q&A pair, already sized appropriately by the LLM distiller.
 * The chunker formats it and returns a single ChunkOutput.
 */
export function chunkSlack(content: string, filePath: string, config: SourceConfig): ChunkOutput[] {
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
