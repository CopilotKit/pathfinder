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
    repo: z.string().url().optional(),
    branch: z.string().optional(),
    path: z.string().min(1),
    base_url: z.string().url().optional(),
    url_derivation: UrlDerivationConfigSchema.optional(),
    file_patterns: z.array(z.string()).min(1),
    exclude_patterns: z.array(z.string()).optional(),
    skip_dirs: z.array(z.string()).optional(),
    max_file_size: z.number().int().positive().optional(),
    chunk: ChunkConfigSchema,
    version: z.string().optional(),
});

// ── Tool configuration schemas ────────────────────────────────────────────────

const SearchToolConfigObjectSchema = z.object({
    name: z.string().min(1),
    type: z.literal('search'),
    description: z.string().min(1),
    source: z.string().min(1),
    default_limit: z.number().int().positive(),
    max_limit: z.number().int().positive(),
    result_format: z.enum(['docs', 'code', 'raw']),
    min_score: z.number().min(0).max(1).optional(),
});

// SearchToolConfig type is inferred from the object schema directly.
// Cross-field validation (default_limit <= max_limit) lives in ServerConfigSchema.superRefine.
export const SearchToolConfigSchema = SearchToolConfigObjectSchema;

export const BashCacheConfigSchema = z.object({
    max_entries: z.number().int().positive(),
    ttl_seconds: z.number().int().positive(),
});

export const BashOptionsSchema = z.object({
    session_state: z.boolean(),
    grep_strategy: z.enum(['memory', 'vector', 'hybrid']),
    workspace: z.boolean(),
    virtual_files: z.boolean(),
    max_file_size: z.number().int().positive(),
    cache: BashCacheConfigSchema,
}).partial();

export const BashToolConfigSchema = z.object({
    name: z.string().min(1),
    type: z.literal('bash'),
    description: z.string().min(1),
    sources: z.array(z.string().min(1)).min(1),
    bash: BashOptionsSchema.optional(),
});

export const CollectToolConfigSchema = z.object({
    name: z.string().min(1),
    type: z.literal('collect'),
    description: z.string().min(1),
    response: z.string().min(1),
    schema: z.record(z.string(), z.object({
        type: z.enum(['string', 'number', 'enum']),
        description: z.string().optional(),
        required: z.boolean().optional(),
        values: z.array(z.string()).optional(),
    }).refine(f => f.type !== 'enum' || (f.values && f.values.length > 0), {
        message: 'enum fields must have a non-empty values array',
    }).refine(f => f.type === 'enum' || !f.values, {
        message: 'values is only valid for enum fields',
    })).refine(
        s => Object.keys(s).length > 0,
        { message: 'collect tool schema must define at least one field' },
    ),
});

// Cross-field constraints (e.g. default_limit <= max_limit for search tools)
// are enforced in ServerConfigSchema.superRefine, not here.
export const AnyToolConfigSchema = z.discriminatedUnion('type', [
    SearchToolConfigObjectSchema,
    CollectToolConfigSchema,
    BashToolConfigSchema,
]);

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
        max_sessions_per_ip: z.number().int().positive().optional(),
        session_ttl_minutes: z.number().int().positive().optional(),
    }),
    sources: z.array(SourceConfigSchema).min(1),
    tools: z.array(AnyToolConfigSchema).min(1),
    embedding: EmbeddingConfigSchema.optional(),
    indexing: IndexingConfigSchema.optional(),
    webhook: WebhookConfigSchema.optional(),
}).superRefine((cfg, ctx) => {
    const hasRag = cfg.tools.some(t => t.type === 'search');
    if (hasRag && !cfg.embedding) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'embedding config is required when search tools are configured.',
            path: ['embedding'],
        });
    }
    if (hasRag && !cfg.indexing) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'indexing config is required when search tools are configured.',
            path: ['indexing'],
        });
    }
    const sourceNames = new Set(cfg.sources.map(s => s.name));
    for (const tool of cfg.tools) {
        if (tool.type === 'search' && tool.default_limit > tool.max_limit) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Tool "${tool.name}": default_limit must not exceed max_limit`,
                path: ['tools'],
            });
        }
        if (tool.type === 'bash') {
            for (const src of tool.sources) {
                if (!sourceNames.has(src)) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message: `Bash tool "${tool.name}" references source "${src}" which is not defined in sources.`,
                        path: ['tools'],
                    });
                }
            }
            const grepStrategy = tool.bash?.grep_strategy;
            if ((grepStrategy === 'vector' || grepStrategy === 'hybrid') && !cfg.embedding) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: `Bash tool "${tool.name}" uses grep_strategy "${grepStrategy}" which requires embedding config.`,
                    path: ['embedding'],
                });
            }
        }
    }
});

// ── Inferred TypeScript types from Zod schemas ────────────────────────────────

export type UrlDerivationConfig = z.infer<typeof UrlDerivationConfigSchema>;
export type ChunkConfig = z.infer<typeof ChunkConfigSchema>;
export type SourceConfig = z.infer<typeof SourceConfigSchema>;
export type SearchToolConfig = z.infer<typeof SearchToolConfigSchema>;
export type BashToolConfig = z.infer<typeof BashToolConfigSchema>;
export type CollectToolConfig = z.infer<typeof CollectToolConfigSchema>;
export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;
export type IndexingConfig = z.infer<typeof IndexingConfigSchema>;
export type WebhookConfig = z.infer<typeof WebhookConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type BashCacheConfig = z.infer<typeof BashCacheConfigSchema>;
export type BashOptions = z.infer<typeof BashOptionsSchema>;

// ── Data types: unified chunk ─────────────────────────────────────────────────

export interface Chunk {
    source_name: string;
    source_url?: string | null;
    title?: string | null;
    content: string;
    embedding: number[];
    repo_url: string | null;
    file_path: string;
    start_line?: number | null;
    end_line?: number | null;
    language?: string | null;
    chunk_index: number;
    metadata?: Record<string, unknown>;
    commit_sha?: string | null;
    version?: string | null;
}

export interface ChunkResult {
    id: number;
    source_name: string;
    source_url: string | null;
    title: string | null;
    content: string;
    repo_url: string | null;
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
