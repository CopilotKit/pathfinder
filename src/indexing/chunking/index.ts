// Chunker registry — maps source.type to a chunking function.

import { type ChunkOutput, type SourceConfig } from "../../types.js";

type ChunkerFn = (
  content: string,
  filePath: string,
  config: SourceConfig,
) => ChunkOutput[];

const registry = new Map<string, ChunkerFn>();

export function registerChunker(type: string, fn: ChunkerFn): void {
  registry.set(type, fn);
}

export function getChunker(type: string): ChunkerFn {
  const fn = registry.get(type);
  if (!fn)
    throw new Error(
      `Unknown chunker type: "${type}". Available: ${[...registry.keys()].join(", ")}`,
    );
  return fn;
}

// Register built-ins on import
import { chunkMarkdown } from "./markdown.js";
import { chunkCode } from "./code.js";
import { chunkRawText } from "./raw-text.js";
import { chunkHtml } from "./html.js";

registerChunker("markdown", chunkMarkdown);
registerChunker("code", chunkCode);
registerChunker("raw-text", chunkRawText);
registerChunker("html", chunkHtml);

import { chunkDocument } from "./document.js";

registerChunker("document", chunkDocument);

import { chunkQa } from "./qa.js";

registerChunker("slack", chunkQa);
registerChunker("discord", chunkQa);
registerChunker("notion", chunkMarkdown);
