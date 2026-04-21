// Unified type definitions for pathfinder server configuration and data models.
// Zod schemas provide runtime validation; TypeScript types are inferred from them.

import { z } from "zod";
import ipaddr from "ipaddr.js";

/**
 * Zod validator for a single allowlist entry: either a bare IPv4/IPv6 address
 * ("160.79.106.35", "2001:db8::1") or a CIDR range ("160.79.106.0/24").
 *
 * Validation is two-layered:
 *   1. Defensive regex pre-check (ALLOWLIST_ENTRY_REGEX below) — rejects
 *      obviously malformed input before it reaches ipaddr.js.
 *   2. ipaddr.parseCIDR / ipaddr.parse — the semantic validator that actually
 *      confirms the address/CIDR is valid.
 *
 * The regex exists as defense-in-depth against ipaddr.js tolerance drift:
 * if a future version of ipaddr.js relaxes what it accepts (e.g. starts
 * tolerating whitespace, unusual characters, or empty CIDR suffixes), the
 * regex still rejects those forms so the allowlist cannot be bypassed.
 *
 * The regexes reject:
 *   - any whitespace (leading, trailing, or internal)
 *   - characters outside the per-family allowed alphabet
 *   - a negative or non-numeric CIDR suffix
 *   - an empty CIDR suffix (e.g. "10.0.0.0/")
 *   - a prefix length outside the per-family valid range (IPv4 0-32,
 *     IPv6 0-128). Out-of-range prefixes still get rejected downstream by
 *     ipaddr.js, but catching them at the schema boundary yields a cleaner,
 *     family-aware error message for operators reading config-validation
 *     output.
 *
 * Two separate regexes are used so that e.g. "10.0.0.0/33" fails with a clear
 * "not a valid CIDR" message rather than being diffused through ipaddr.js. An
 * entry matching neither regex is rejected up front.
 */
// IPv4 / IPv4-CIDR: decimal octet characters and optional /0–/32.
const ALLOWLIST_IPV4_REGEX =
  /^[0-9.]+(\/([0-9]|[1-2][0-9]|3[0-2]))?$/;
// IPv6 / IPv6-CIDR: hex + colons, optional embedded IPv4 dotted-quad
// (e.g. ::ffff:127.0.0.1), and optional /0–/128. The alphabet allows `.`
// specifically for the embedded-v4 suffix form; ipaddr.js then does the real
// semantic parse.
const ALLOWLIST_IPV6_REGEX =
  /^[0-9a-fA-F:.]+(\/([0-9]|[1-9][0-9]|1[0-1][0-9]|12[0-8]))?$/;

const AllowlistEntrySchema = z.string().superRefine((val, ctx) => {
  // An IPv4 entry never contains ':'; an IPv6 entry always does. Dispatch on
  // that so each family gets its own prefix-range validation, and so an
  // ambiguous-looking string can't slip past (e.g. "10.0.0.0/99" is rejected
  // by ALLOWLIST_IPV4_REGEX and never evaluated as IPv6 because it has no
  // ':').
  const looksIpv6 = val.includes(":");
  const regex = looksIpv6 ? ALLOWLIST_IPV6_REGEX : ALLOWLIST_IPV4_REGEX;
  if (!regex.test(val)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Must be a valid IPv4/IPv6 address or CIDR range",
    });
    return;
  }
  try {
    if (val.includes("/")) {
      ipaddr.parseCIDR(val);
    } else {
      ipaddr.parse(val);
    }
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Must be a valid IPv4/IPv6 address or CIDR range",
    });
  }
});

// ── Source configuration schemas ──────────────────────────────────────────────

export const UrlDerivationConfigSchema = z.object({
  strip_prefix: z.string().optional(),
  strip_suffix: z.string().optional(),
  strip_route_groups: z.boolean().optional(),
  strip_index: z.boolean().optional(),
});

// ChunkConfig field applicability by source type:
//   markdown/raw-text/html: target_tokens, overlap_tokens
//   code:                   target_lines, overlap_lines
export const ChunkConfigSchema = z.object({
  target_tokens: z.number().int().positive().optional(),
  overlap_tokens: z.number().int().nonnegative().optional(),
  target_lines: z.number().int().positive().optional(),
  overlap_lines: z.number().int().nonnegative().optional(),
});

// Base fields shared by all source types
const BaseSourceFields = {
  name: z.string().min(1),
  chunk: ChunkConfigSchema,
  version: z.string().optional(),
  category: z.enum(["faq"]).optional(),
};

// File-based source schema (markdown, code, raw-text, html) — unchanged fields from today
export const FileSourceConfigSchema = z.object({
  ...BaseSourceFields,
  type: z.enum(["markdown", "code", "raw-text", "html", "document"]),
  repo: z.string().url().optional(),
  branch: z.string().optional(),
  path: z.string().min(1),
  base_url: z.string().url().optional(),
  url_derivation: UrlDerivationConfigSchema.optional(),
  file_patterns: z.array(z.string()).min(1),
  exclude_patterns: z.array(z.string()).optional(),
  skip_dirs: z.array(z.string()).optional(),
  max_file_size: z.number().int().positive().optional(),
});

// Slack source schema — different required fields
export const SlackSourceConfigSchema = z.object({
  ...BaseSourceFields,
  type: z.literal("slack"),
  category: z.enum(["faq"]).default("faq"), // override base optional with default
  channels: z.array(z.string()).min(1),
  confidence_threshold: z.number().min(0).max(1).default(0.7),
  trigger_emoji: z.string().default("pathfinder"),
  min_thread_replies: z.number().int().positive().default(2),
  distiller_model: z.string().optional(),
});

// Discord source schema — channel-based with forum thread support
export const DiscordChannelConfigSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["text", "forum"]),
});

export const DiscordSourceConfigSchema = z.object({
  ...BaseSourceFields,
  type: z.literal("discord"),
  category: z.enum(["faq"]).default("faq"),
  guild_id: z.string().min(1),
  channels: z.array(DiscordChannelConfigSchema).min(1),
  confidence_threshold: z.number().min(0).max(1).default(0.7),
  min_thread_replies: z.number().int().positive().default(2),
  distiller_model: z.string().optional(),
});

export const NotionSourceConfigSchema = z.object({
  ...BaseSourceFields,
  type: z.literal("notion"),
  root_pages: z.array(z.string().min(1)).optional().default([]),
  databases: z.array(z.string().min(1)).optional().default([]),
  max_depth: z.number().int().min(1).max(20).optional().default(5),
  include_properties: z.boolean().optional().default(true),
});

// Union: TypeScript infers the right shape based on `type`
export const SourceConfigSchema = z.discriminatedUnion("type", [
  FileSourceConfigSchema,
  SlackSourceConfigSchema,
  DiscordSourceConfigSchema,
  NotionSourceConfigSchema,
]);

// ── Tool configuration schemas ────────────────────────────────────────────────

const SearchToolConfigObjectSchema = z.object({
  name: z.string().min(1),
  type: z.literal("search"),
  description: z.string().min(1),
  source: z.string().min(1),
  default_limit: z.number().int().positive(),
  max_limit: z.number().int().positive(),
  result_format: z.enum(["docs", "code", "raw"]),
  min_score: z.number().min(0).max(1).optional(),
  search_mode: z.enum(["vector", "keyword", "hybrid"]).default("vector"),
});

// SearchToolConfig type is inferred from the object schema directly.
// Cross-field validation (default_limit <= max_limit) lives in ServerConfigSchema.superRefine.
export const SearchToolConfigSchema = SearchToolConfigObjectSchema;

export const BashCacheConfigSchema = z.object({
  max_entries: z.number().int().positive(),
  ttl_seconds: z.number().int().positive(),
});

export const BashOptionsSchema = z
  .object({
    session_state: z.boolean(),
    grep_strategy: z.enum(["memory", "vector", "hybrid"]),
    workspace: z.boolean(),
    virtual_files: z.boolean(),
    max_file_size: z.number().int().positive(),
    cache: BashCacheConfigSchema,
  })
  .partial();

export const BashToolConfigSchema = z.object({
  name: z.string().min(1),
  type: z.literal("bash"),
  description: z.string().min(1),
  sources: z.array(z.string().min(1)).min(1),
  bash: BashOptionsSchema.optional(),
});

export const CollectToolConfigSchema = z.object({
  name: z.string().min(1),
  type: z.literal("collect"),
  description: z.string().min(1),
  response: z.string().min(1),
  schema: z
    .record(
      z.string(),
      z
        .object({
          type: z.enum(["string", "number", "enum"]),
          description: z.string().optional(),
          required: z.boolean().optional(),
          values: z.array(z.string()).optional(),
        })
        .refine((f) => f.type !== "enum" || (f.values && f.values.length > 0), {
          message: "enum fields must have a non-empty values array",
        })
        .refine((f) => f.type === "enum" || !f.values, {
          message: "values is only valid for enum fields",
        }),
    )
    .refine((s) => Object.keys(s).length > 0, {
      message: "collect tool schema must define at least one field",
    }),
});

export const KnowledgeToolConfigSchema = z.object({
  name: z.string().min(1),
  type: z.literal("knowledge"),
  description: z.string().min(1),
  sources: z.array(z.string().min(1)).min(1),
  min_confidence: z.number().min(0).max(1).default(0.7),
  default_limit: z.number().int().positive().default(20),
  max_limit: z.number().int().positive().default(100),
});

// Cross-field constraints (e.g. default_limit <= max_limit for search tools)
// are enforced in ServerConfigSchema.superRefine, not here.
export const AnyToolConfigSchema = z.discriminatedUnion("type", [
  SearchToolConfigObjectSchema,
  CollectToolConfigSchema,
  BashToolConfigSchema,
  KnowledgeToolConfigSchema,
]);

// ── Embedding configuration schemas ───────────────────────────────────────────

export const OpenAIEmbeddingConfigSchema = z.object({
  provider: z.literal("openai"),
  model: z.string().min(1),
  dimensions: z.number().int().positive(),
});

export const OllamaEmbeddingConfigSchema = z.object({
  provider: z.literal("ollama"),
  model: z.string().min(1).default("nomic-embed-text"),
  dimensions: z.number().int().positive().default(768),
  base_url: z.string().url().default("http://localhost:11434"),
});

export const LocalEmbeddingConfigSchema = z.object({
  provider: z.literal("local"),
  model: z.string().min(1).default("Xenova/all-MiniLM-L6-v2"),
  dimensions: z.number().int().positive().default(384),
});

export const EmbeddingConfigSchema = z.discriminatedUnion("provider", [
  OpenAIEmbeddingConfigSchema,
  OllamaEmbeddingConfigSchema,
  LocalEmbeddingConfigSchema,
]);

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

// ── Analytics configuration schemas ──────────────────────────────────────────

export const AnalyticsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  log_queries: z.boolean().default(true),
  token: z.string().min(1).optional(),
  retention_days: z.number().int().positive().default(90),
});

// ── Top-level server configuration schema ─────────────────────────────────────

export const ServerConfigSchema = z
  .object({
    server: z.object({
      name: z.string().min(1),
      version: z.string().min(1),
      max_sessions_per_ip: z.number().int().positive().optional(),
      session_ttl_minutes: z.number().int().positive().optional(),
      // IP/CIDR entries that bypass max_sessions_per_ip. Empty by default.
      // Example: ["160.79.106.35"] to allowlist the Anthropic Assistant
      // crawler, or ["10.0.0.0/8"] for an internal health probe range.
      allowlist: z.array(AllowlistEntrySchema).optional(),
      // When true, Express is configured with `app.set("trust proxy", true)`
      // and will populate `req.ip` by walking the `X-Forwarded-For` chain.
      // When false (the default), `X-Forwarded-For` is IGNORED entirely and
      // the TCP peer address (`req.socket.remoteAddress`) is used for rate
      // limiting, allowlist checks, tracing, and analytics.
      //
      // SECURITY: Only enable `trust_proxy: true` when this server runs
      // behind a reverse proxy that strips or rewrites incoming
      // `X-Forwarded-For` headers. Enabling it on a server directly exposed
      // to the public internet lets any client spoof their source IP by
      // sending an `X-Forwarded-For` header — which would let them claim
      // to be an allowlisted IP and bypass the per-IP session limiter.
      trust_proxy: z.boolean().optional().default(false),
    }),
    sources: z.array(SourceConfigSchema).min(1),
    tools: z.array(AnyToolConfigSchema).min(1),
    embedding: EmbeddingConfigSchema.optional(),
    indexing: IndexingConfigSchema.optional(),
    webhook: WebhookConfigSchema.optional(),
    analytics: AnalyticsConfigSchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    const hasRag = cfg.tools.some(
      (t) => t.type === "search" || t.type === "knowledge",
    );
    if (hasRag && !cfg.embedding) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "embedding config is required when search tools are configured.",
        path: ["embedding"],
      });
    }
    if (hasRag && !cfg.indexing) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "indexing config is required when search tools are configured.",
        path: ["indexing"],
      });
    }
    const sourceNames = new Set(cfg.sources.map((s) => s.name));
    for (const tool of cfg.tools) {
      if (tool.type === "search" && tool.default_limit > tool.max_limit) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Tool "${tool.name}": default_limit must not exceed max_limit`,
          path: ["tools"],
        });
      }
      if (tool.type === "bash") {
        for (const src of tool.sources) {
          if (!sourceNames.has(src)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Bash tool "${tool.name}" references source "${src}" which is not defined in sources.`,
              path: ["tools"],
            });
          }
        }
        const grepStrategy = tool.bash?.grep_strategy;
        if (
          (grepStrategy === "vector" || grepStrategy === "hybrid") &&
          !cfg.embedding
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Bash tool "${tool.name}" uses grep_strategy "${grepStrategy}" which requires embedding config.`,
            path: ["embedding"],
          });
        }
      }
      // Cross-validate: knowledge tool sources must reference existing source names
      if (tool.type === "knowledge") {
        for (const src of tool.sources) {
          if (!sourceNames.has(src)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Knowledge tool "${tool.name}" references source "${src}" which is not defined in sources.`,
              path: ["tools"],
            });
          }
        }
        if (tool.default_limit > tool.max_limit) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Tool "${tool.name}": default_limit must not exceed max_limit`,
            path: ["tools"],
          });
        }
      }
    }
  });

// ── Inferred TypeScript types from Zod schemas ────────────────────────────────

export type UrlDerivationConfig = z.infer<typeof UrlDerivationConfigSchema>;
export type ChunkConfig = z.infer<typeof ChunkConfigSchema>;
export type SourceConfig = z.infer<typeof SourceConfigSchema>;
export type FileSourceConfig = z.infer<typeof FileSourceConfigSchema>;
export type SlackSourceConfig = z.infer<typeof SlackSourceConfigSchema>;
export type DiscordChannelConfig = z.infer<typeof DiscordChannelConfigSchema>;
export type DiscordSourceConfig = z.infer<typeof DiscordSourceConfigSchema>;
export type NotionSourceConfig = z.infer<typeof NotionSourceConfigSchema>;
export type SearchToolConfig = z.infer<typeof SearchToolConfigSchema>;
export type BashToolConfig = z.infer<typeof BashToolConfigSchema>;
export type CollectToolConfig = z.infer<typeof CollectToolConfigSchema>;
export type KnowledgeToolConfig = z.infer<typeof KnowledgeToolConfigSchema>;
export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;
export type OpenAIEmbeddingConfig = z.infer<typeof OpenAIEmbeddingConfigSchema>;
export type OllamaEmbeddingConfig = z.infer<typeof OllamaEmbeddingConfigSchema>;
export type LocalEmbeddingConfig = z.infer<typeof LocalEmbeddingConfigSchema>;
export type IndexingConfig = z.infer<typeof IndexingConfigSchema>;
export type WebhookConfig = z.infer<typeof WebhookConfigSchema>;
export type AnalyticsConfig = z.infer<typeof AnalyticsConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type BashCacheConfig = z.infer<typeof BashCacheConfigSchema>;
export type BashOptions = z.infer<typeof BashOptionsSchema>;

// ── Source config type guards ────────────────────────────────────────────────

const FILE_SOURCE_TYPES = new Set([
  "markdown",
  "code",
  "raw-text",
  "html",
  "document",
]);
export function isFileSourceConfig(
  config: SourceConfig,
): config is FileSourceConfig {
  return FILE_SOURCE_TYPES.has(config.type);
}

export function isSlackSourceConfig(
  config: SourceConfig,
): config is SlackSourceConfig {
  return config.type === "slack";
}

export function isDiscordSourceConfig(
  config: SourceConfig,
): config is DiscordSourceConfig {
  return config.type === "discord";
}

export function isNotionSourceConfig(
  config: SourceConfig,
): config is NotionSourceConfig {
  return config.type === "notion";
}

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

export interface FaqChunkResult extends ChunkResult {
  metadata: Record<string, unknown>;
  confidence: number; // extracted from metadata->>'confidence'
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

export type IndexStatus = "idle" | "indexing" | "error";

export interface IndexState {
  source_type: string;
  source_key: string;
  last_commit_sha?: string | null;
  last_indexed_at?: Date | null;
  status?: IndexStatus;
  error_message?: string | null;
}
