// IndexingPipeline — source-agnostic chunk → embed → upsert logic.

import { getChunker } from "./chunking/index.js";
import { deriveUrl } from "./url-derivation.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { replaceChunksForFile, deleteChunksByFile } from "../db/queries.js";
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
   * Index a batch of content items: chunk → embed → upsert. Each item is
   * replaced atomically via {@link replaceChunksForFile} (delete + insert in a
   * single transaction), so a failed insert never leaves an item's pre-existing
   * chunks deleted-but-not-replaced.
   *
   * A single item's failure must not abort the batch (the remaining items still
   * index), but it MUST be surfaced: the returned `failedIds` lists every item
   * whose `indexItem` threw. The caller uses this to avoid advancing the index
   * state token past items that did not actually index — otherwise a failed
   * item falls behind the advanced token and is never re-processed (permanent
   * silent data loss).
   */
  async indexItems(
    items: ContentItem[],
    stateToken: string,
  ): Promise<{ failedIds: string[] }> {
    const failedIds: string[] = [];
    for (const item of items) {
      try {
        await this.indexItem(item, stateToken);
      } catch (err) {
        // Log the full error (not just err.message) so the stack + any
        // pg-level metadata survives for diagnosis; collect the id so the
        // caller can hold the state token back.
        console.error(`${this.logPrefix} Failed to index ${item.id}:`, err);
        failedIds.push(item.id);
      }
    }
    return { failedIds };
  }

  /**
   * Remove items from the index by ID. Mirrors {@link indexItems}: a single
   * failing delete must not abort the batch, so the remaining ids are still
   * processed — but the failed ids are RETURNED so the caller does not advance
   * the index state token over items whose stale chunks are still in the index.
   */
  async removeItems(ids: string[]): Promise<{ failedIds: string[] }> {
    const failedIds: string[] = [];
    for (const id of ids) {
      try {
        await deleteChunksByFile(this.sourceConfig.name, id);
      } catch (err) {
        // Log the full error (not just err.message) so the stack survives.
        console.error(`${this.logPrefix} Failed to remove ${id}:`, err);
        failedIds.push(id);
      }
    }
    return { failedIds };
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
      // The item produced zero chunks. If it previously had chunks (and is
      // routed through `items` rather than `removedIds`), early-returning here
      // would leave those stale chunks in the index forever. Clear them via the
      // delete-only path of replaceChunksForFile (empty array → DELETE, no
      // INSERT). Harmless when the file never had chunks (the DELETE matches
      // nothing). No embedding round-trip is needed since there's nothing to
      // embed.
      await replaceChunksForFile(this.sourceConfig.name, item.id, []);
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
      // Guard on `.length` (not mere truthiness): an empty array `[]` is truthy
      // and would otherwise clobber a provider's headingPath with nothing.
      metadata: {
        ...(item.metadata ?? {}),
        ...(chunk.headingPath?.length
          ? { headingPath: chunk.headingPath }
          : {}),
      },
      commit_sha: stateToken,
      version: this.sourceConfig.version ?? null,
    }));

    // Atomic delete+insert: replaceChunksForFile runs the DELETE and the INSERTs
    // on a single client inside one transaction. If any insert fails the whole
    // operation rolls back, so the item's PRE-EXISTING chunks are never left
    // deleted-but-not-replaced (indexItems swallows the error and the caller
    // advances its state token, which would otherwise lose the chunks forever).
    await replaceChunksForFile(this.sourceConfig.name, item.id, chunks);
  }
}
