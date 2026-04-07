// IndexingPipeline — source-agnostic chunk → embed → upsert logic.

import { getChunker } from './chunking/index.js';
import { deriveUrl } from './url-derivation.js';
import { EmbeddingClient } from './embeddings.js';
import { upsertChunks, deleteChunksByFile } from '../db/queries.js';
import type { Chunk, SourceConfig } from '../types.js';
import type { ContentItem } from './providers/types.js';

export class IndexingPipeline {
    private sourceConfig: SourceConfig;
    private embeddingClient: EmbeddingClient;
    private logPrefix: string;

    constructor(embeddingClient: EmbeddingClient, sourceConfig: SourceConfig) {
        this.embeddingClient = embeddingClient;
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

    private async indexItem(item: ContentItem, stateToken: string): Promise<void> {
        const chunker = getChunker(this.sourceConfig.type);
        const chunkOutputs = chunker(item.content, item.id, this.sourceConfig);

        if (chunkOutputs.length === 0) {
            return;
        }

        const texts = chunkOutputs.map(c => c.content);
        const embeddings = await this.embeddingClient.embedBatch(texts);
        const sourceUrl = item.sourceUrl ?? deriveUrl(item.id, this.sourceConfig);

        const chunks: Chunk[] = chunkOutputs.map((chunk, i) => ({
            source_name: this.sourceConfig.name,
            source_url: sourceUrl,
            title: chunk.title ?? item.title ?? null,
            content: chunk.content,
            embedding: embeddings[i],
            repo_url: this.sourceConfig.repo ?? null,
            file_path: item.id,
            start_line: chunk.startLine ?? null,
            end_line: chunk.endLine ?? null,
            language: chunk.language ?? null,
            chunk_index: chunk.chunkIndex,
            metadata: {
                ...(chunk.headingPath ? { headingPath: chunk.headingPath } : {}),
                ...(item.metadata ?? {}),
            },
            commit_sha: stateToken,
            version: this.sourceConfig.version ?? null,
        }));

        await deleteChunksByFile(this.sourceConfig.name, item.id);
        await upsertChunks(chunks);
    }
}
