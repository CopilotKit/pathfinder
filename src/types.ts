// Unified type definitions for mcp-docs server configuration and data models.
// Zod schemas provide runtime validation; TypeScript types are inferred from them.

import { z } from 'zod';

// ── Source configuration schemas ──────────────────────────────────────────────

export const UrlDerivationConfigSchema = z.object({
    strip_prefix: z.string().optional(),
    strip_suffix: z.string().optional(),
    strip_route_groups: z.boolean().optional(),
    strip_index: z.boolean().optional(),
});

// ChunkConfig field applicability by source type:
//   markdown/raw-text: target_tokens, overlap_tokens
//   code:              target_lines, overlap_lines
export const ChunkConfigSchema = z.object({
    target_tokens: z.number().int().positive().optional(),
    overlap_tokens: z.number().int().nonnegative().optional(),
    target_lines: z.number().int().positive().optional(),
    overlap_lines: z.number().int().nonnegative().optional(),
});

export const SourceConfigSchema = z.object({
    name: z.string().min(1),
    type: z.enum(['markdown', 'code', 'raw-text']),
    repo: z.string().url(),
    branch: z.string().optional(),
    path: z.string().min(1),
    base_url: z.string().url().optional(),
    url_derivation: UrlDerivationConfigSchema.optional(),
    file_patterns: z.array(z.string()).min(1),
    exclude_patterns: z.array(z.string()).optional(),
    skip_dirs: z.array(z.string()).optional(),
    max_file_size: z.number().int().positive().optional(),
    chunk: ChunkConfigSchema,
});

// ── Tool configuration schemas ────────────────────────────────────────────────

export const ToolConfigSchema = z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    source: z.string().min(1),
    default_limit: z.number().int().positive(),
    max_limit: z.number().int().positive(),
    result_format: z.enum(['docs', 'code', 'raw']),
}).refine(t => t.default_limit <= t.max_limit, {
    message: 'default_limit must not exceed max_limit',
});

// ── Embedding configuration schemas ───────────────────────────────────────────

export const EmbeddingConfigSchema = z.object({
    provider: z.enum(['openai']),
    model: z.string().min(1),
    dimensions: z.number().int().positive(),
});

// ── Indexing configuration schemas ────────────────────────────────────────────

export const IndexingConfigSchema = z.object({
    auto_reindex: z.boolean(),
    reindex_hour_utc: z.number().int().min(0).max(23),
    stale_threshold_hours: z.number().int().positive(),
});

// ── Webhook configuration schemas ─────────────────────────────────────────────

export const WebhookConfigSchema = z.object({
    repo_sources: z.record(z.string(), z.array(z.string())),
    path_triggers: z.record(z.string(), z.array(z.string())),
});

// ── Top-level server configuration schema ─────────────────────────────────────

export const ServerConfigSchema = z.object({
    server: z.object({
        name: z.string().min(1),
        version: z.string().min(1),
    }),
    sources: z.array(SourceConfigSchema).min(1),
    tools: z.array(ToolConfigSchema).min(1),
    embedding: EmbeddingConfigSchema,
    indexing: IndexingConfigSchema,
    webhook: WebhookConfigSchema.optional(),
});

// ── Inferred TypeScript types from Zod schemas ────────────────────────────────

export type UrlDerivationConfig = z.infer<typeof UrlDerivationConfigSchema>;
export type ChunkConfig = z.infer<typeof ChunkConfigSchema>;
export type SourceConfig = z.infer<typeof SourceConfigSchema>;
export type ToolConfig = z.infer<typeof ToolConfigSchema>;
export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;
export type IndexingConfig = z.infer<typeof IndexingConfigSchema>;
export type WebhookConfig = z.infer<typeof WebhookConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

// ── Data types: unified chunk ─────────────────────────────────────────────────

export interface Chunk {
    source_name: string;
    source_url?: string | null;
    title?: string | null;
    content: string;
    embedding: number[];
    repo_url: string;
    file_path: string;
    start_line?: number | null;
    end_line?: number | null;
    language?: string | null;
    chunk_index: number;
    metadata?: Record<string, unknown>;
    commit_sha?: string | null;
}

export interface ChunkResult {
    id: number;
    source_name: string;
    source_url: string | null;
    title: string | null;
    content: string;
    repo_url: string;
    file_path: string;
    start_line: number | null;
    end_line: number | null;
    language: string | null;
    similarity: number;
}

// Chunker output: what chunkers produce before embedding
export interface ChunkOutput {
    content: string;
    title?: string;
    headingPath?: string[];
    startLine?: number;
    endLine?: number;
    language?: string;
    chunkIndex: number;
}

// ── Index state types ─────────────────────────────────────────────────────────

export type IndexStatus = 'idle' | 'indexing' | 'error';

export interface IndexState {
    source_type: string;
    source_key: string;
    last_commit_sha?: string | null;
    last_indexed_at?: Date | null;
    status?: IndexStatus;
    error_message?: string | null;
}
