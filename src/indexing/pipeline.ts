// IndexingPipeline — source-agnostic chunk → embed → upsert logic.

import { getChunker } from "./chunking/index.js";
import { deriveUrl } from "./url-derivation.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { upsertChunks, deleteChunksByFile } from "../db/queries.js";
import { isFileSourceConfig } from "../types.js";
import type { Chunk, SourceConfig } from "../types.js";
import type { ContentItem } from "./providers/types.js";

export class IndexingPipeline {
  private sourceConfig: SourceConfig;
  private embeddingProvider: EmbeddingProvider;
  private logPrefix: string;

  constructor(
    embeddingProvider: EmbeddingProvider,
    sourceConfig: SourceConfig,
  ) {
    this.embeddingProvider = embeddingProvider;
    this.sourceConfig = sourceConfig;
    this.logPrefix = `[pipeline:${sourceConfig.name}]`;
  }

  /**
   * Index a batch of content items: chunk → embed → upsert.
   * Each item's existing chunks are deleted first to handle shrinkage.
   */
  async indexItems(items: ContentItem[], stateToken: string): Promise<void> {
    for (const item of items) {
      try {
        await this.indexItem(item, stateToken);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${this.logPrefix} Failed to index ${item.id}: ${msg}`);
      }
    }
  }

  /** Remove items from the index by ID. */
  async removeItems(ids: string[]): Promise<void> {
    for (const id of ids) {
      await deleteChunksByFile(this.sourceConfig.name, id);
    }
  }

  private async indexItem(
    item: ContentItem,
    stateToken: string,
  ): Promise<void> {
    const chunker = getChunker(this.sourceConfig.type);
    const chunkOutputs = chunker(
      item.content,
      item.id,
      this.sourceConfig,
      item.absolutePath,
    );

    if (chunkOutputs.length === 0) {
      return;
    }

    // Embed the chunk's title + heading path alongside its content so that
    // precise symbol/prop/heading queries retain their strongest anchor.
    // Code chunks (which may lack a title/heading) fall back to content only.
    const texts = chunkOutputs.map((c) =>
      [c.title, c.headingPath?.join(" > "), c.content]
        .filter(Boolean)
        .join("\n"),
    );
    const embeddings = await this.embeddingProvider.embedBatch(texts);
    if (embeddings.length !== texts.length) {
      throw new Error(
        `Embedding count mismatch for item ${item.id}: expected ${texts.length}, got ${embeddings.length}`,
      );
    }
    const sourceUrl =
      item.sourceUrl ??
      (isFileSourceConfig(this.sourceConfig)
        ? deriveUrl(item.id, this.sourceConfig)
        : null);

    const chunks: Chunk[] = chunkOutputs.map((chunk, i) => ({
      source_name: this.sourceConfig.name,
      source_url: sourceUrl,
      title: chunk.title ?? item.title ?? null,
      content: chunk.content,
      embedding: embeddings[i],
      repo_url: isFileSourceConfig(this.sourceConfig)
        ? (this.sourceConfig.repo ?? null)
        : null,
      file_path: item.id,
      start_line: chunk.startLine ?? null,
      end_line: chunk.endLine ?? null,
      language: chunk.language ?? null,
      chunk_index: chunk.chunkIndex,
      // Spread item.metadata FIRST so the chunk-derived headingPath always
      // wins: it is embedded into the vector above and is load-bearing for
      // retrieval, so a provider's metadata.headingPath must not clobber it.
      metadata: {
        ...(item.metadata ?? {}),
        ...(chunk.headingPath ? { headingPath: chunk.headingPath } : {}),
      },
      commit_sha: stateToken,
      version: this.sourceConfig.version ?? null,
    }));

    await deleteChunksByFile(this.sourceConfig.name, item.id);
    await upsertChunks(chunks);
  }
}
