// Plain text chunker — paragraph-boundary splitting for non-structured content.

import { type ChunkOutput, type SourceConfig } from "../../types.js";

const DEFAULT_TARGET_TOKENS = 600;
const DEFAULT_OVERLAP_TOKENS = 50;

/**
 * Split plain text into embedding-friendly chunks on paragraph boundaries.
 *
 * @param content - The full file content
 * @param _filePath - Path to the source file (unused, kept for registry signature)
 * @param config - Source configuration with chunk size parameters
 * @returns Array of ChunkOutput objects
 */
export function chunkRawText(
  content: string,
  _filePath: string,
  config: SourceConfig,
): ChunkOutput[] {
  if (!content || !content.trim()) {
    return [];
  }

  const targetChars =
    (config.chunk?.target_tokens ?? DEFAULT_TARGET_TOKENS) * 4;
  const overlapChars =
    (config.chunk?.overlap_tokens ?? DEFAULT_OVERLAP_TOKENS) * 4;

  // Split on double newlines into paragraphs
  const paragraphs = content.split(/\n\n+/).filter((p) => p.trim().length > 0);

  if (paragraphs.length === 0) {
    return [];
  }

  // Merge small consecutive paragraphs until reaching target size
  const merged: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const trimmed = para.trim();
    const separator = current ? "\n\n" : "";

    if (
      current &&
      current.length + separator.length + trimmed.length > targetChars
    ) {
      merged.push(current);
      current = trimmed;
    } else {
      current = current ? current + separator + trimmed : trimmed;
    }
  }
  if (current.trim()) {
    merged.push(current);
  }

  // Apply overlap
  const chunks: ChunkOutput[] = [];

  for (let i = 0; i < merged.length; i++) {
    let chunkContent = merged[i];

    if (i > 0 && overlapChars > 0) {
      const prevChunk = merged[i - 1];
      const overlapText = prevChunk.slice(-overlapChars);

      // Find a clean break point (newline or space)
      const breakPoint = overlapText.lastIndexOf("\n");
      const cleanOverlap =
        breakPoint > 0 ? overlapText.slice(breakPoint) : overlapText;

      chunkContent = cleanOverlap + "\n\n" + chunkContent;
    }

    chunks.push({
      content: chunkContent.trim(),
      chunkIndex: i,
    });
  }

  return chunks;
}
