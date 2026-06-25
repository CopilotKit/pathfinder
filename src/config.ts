// Centralized configuration: env-var secrets + YAML server config.

import "dotenv/config";
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  ServerConfigSchema,
  type ServerConfig,
  type AnalyticsConfig,
  isDiscordSourceConfig,
  isFileSourceConfig,
} from "./types.js";
import { resolveJwtSecret } from "./oauth/secret.js";

// Resolve package.json on first parseConfig() call. Used by code paths
// that need the package version (e.g. p2p-telemetry payloads). Lives
// inside parseConfig (rather than at module load) so it doesn't fire
// during getServerConfig-only call paths, and so the existing config
// tests that mock readFileSync to YAML don't see an extra read at import
// time. Matches the dev/prod layout — package.json sits one directory
// above src/ in dev and one above dist/ in published builds. Falls back
// to "unknown" if reading fails so a malformed install doesn't crash
// startup.
function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(here, "..", "package.json");
    const raw = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      version?: string;
    };
    return raw.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// ── Environment variable config (secrets and runtime settings) ────────────────

export interface Config {
  databaseUrl: string | undefined;
  openaiApiKey: string;
  githubToken: string;
  githubWebhookSecret: string;
  port: number;
  nodeEnv: string;
  logLevel: string;
  cloneDir: string;
  slackBotToken: string;
  slackSigningSecret: string;
  discordBotToken: string;
  discordPublicKey: string;
  notionToken: string;
  mcpJwtSecret: string;
  /**
   * HMAC keys (≥32 hex chars each) used to sign and verify the OAuth
   * consent-screen nonce. Parsed from comma-separated env
   * PATHFINDER_CONSENT_HMAC_KEY. The first key signs new nonces; all keys
   * are accepted on verify so a value can be rotated without invalidating
   * in-flight consent screens. Required in production (fail-loud on unset
   * or short keys); in non-production an ephemeral 64-hex key is generated
   * at startup with a WARN log so dev/test runs work out of the box.
   */
  oauthConsentHmacKeys: string[];
  /**
   * URL of the CopilotKit-hosted telemetry-sink Lambda. Hosted-only — when
   * unset (the default for OSS deployments), the p2p-telemetry client
   * no-ops and pathfinder sends nothing externally. Set on the hosted
   * pathfinder.copilotkit.dev Railway deployment via the
   * PATHFINDER_TELEMETRY_URL env var.
   */
  p2pTelemetryUrl: string | undefined;
  /**
   * Independent kill switch for the telemetry client (PATHFINDER_TELEMETRY_DISABLED).
   * Lets ops disable telemetry without a redeploy by setting "1"/"true" —
   * useful if the sink misbehaves and we don't want to chase a config
   * rollback. When true, emit() no-ops even if the URL is set.
   */
  p2pTelemetryDisabled: boolean;
  /** Pathfinder package version, read from package.json at startup. */
  packageVersion: string;
  /** Slack webhook URL for operational alerts (reindex audit, deploy health). */
  slackWebhookUrl: string;
}

/**
 * Check whether any search tools are configured (requires embeddings + indexing).
 */
export function hasSearchTools(): boolean {
  return getServerConfig().tools.some((t) => t.type === "search");
}

/**
 * Check whether any knowledge tools are configured (requires embeddings + indexing).
 */
export function hasKnowledgeTools(): boolean {
  return getServerConfig().tools.some((t) => t.type === "knowledge");
}

/**
 * Check whether any collect tools are configured (requires database).
 */
export function hasCollectTools(): boolean {
  return getServerConfig().tools.some((t) => t.type === "collect");
}

/**
 * Check whether any bash tools use vector or hybrid grep (requires embeddings + database).
 */
export function hasBashSemanticSearch(): boolean {
  return getServerConfig().tools.some(
    (t) =>
      t.type === "bash" &&
      (t.bash?.grep_strategy === "vector" ||
        t.bash?.grep_strategy === "hybrid"),
  );
}

/**
 * Get the set of source names that need indexing (only those referenced by search tools).
 */
export function getIndexableSourceNames(): Set<string> {
  const cfg = getServerConfig();
  const searchSources = cfg.tools
    .filter((t) => t.type === "search")
    .map((t) => t.source);
  const knowledgeSources = cfg.tools
    .filter((t) => t.type === "knowledge")
    .flatMap((t) => t.sources);
  return new Set([...searchSources, ...knowledgeSources]);
}

let cachedConfig: Config | null = null;

/**
 * Parse PATHFINDER_CONSENT_HMAC_KEY into a list of HMAC keys for the OAuth
 * consent-nonce signer/verifier. Mirrors `resolveJwtSecret` policy:
 *   - present + all entries ≥32 hex chars → use as-is (comma-separated for rotation)
 *   - present + any entry invalid → throw (fail-loud)
 *   - unset in production → throw (fail-loud)
 *   - unset in non-production → generate one ephemeral 64-hex key + WARN
 *
 * Keys MUST be hex so the byte length is unambiguous regardless of locale or
 * platform encoding. 32 hex chars = 16 bytes (the same MIN_BYTES used for
 * MCP_JWT_SECRET) is the floor; `openssl rand -hex 32` (64 hex chars / 32
 * bytes) is the recommended value.
 */
function parseConsentHmacKeys(nodeEnv: string): string[] {
  const raw = process.env.PATHFINDER_CONSENT_HMAC_KEY?.trim() ?? "";
  if (raw.length > 0) {
    const keys = raw
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
    for (const k of keys) {
      if (!/^[0-9a-fA-F]{32,}$/.test(k)) {
        throw new Error(
          "PATHFINDER_CONSENT_HMAC_KEY entries must be ≥32 hex chars each. " +
            "Generate with: openssl rand -hex 32 (comma-separated for rotation).",
        );
      }
    }
    if (keys.length > 0) return keys;
  }
  if (nodeEnv === "production") {
    throw new Error(
      "PATHFINDER_CONSENT_HMAC_KEY is required in production. " +
        "Generate with: openssl rand -hex 32 (comma-separated for rotation).",
    );
  }
  const ephemeral = randomBytes(32).toString("hex");
  console.warn(
    "[oauth] PATHFINDER_CONSENT_HMAC_KEY not set — generated an ephemeral consent-nonce key for development. " +
      "All in-flight consent nonces will be invalidated on restart.",
  );
  return [ephemeral];
}

function parseConfig(): Config {
  const missing: string[] = [];

  const needsRag = hasSearchTools() || hasKnowledgeTools();
  const needsEmbedding = needsRag || hasBashSemanticSearch();
  const needsDb = needsEmbedding || hasCollectTools();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl && needsDb) missing.push("DATABASE_URL");

  const openaiApiKey = process.env.OPENAI_API_KEY;
  const embeddingProvider = getServerConfig().embedding?.provider;
  const needsOpenAI =
    needsEmbedding && (!embeddingProvider || embeddingProvider === "openai");
  if (!openaiApiKey && needsOpenAI) missing.push("OPENAI_API_KEY");

  const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET ?? "";

  // Slack credentials — required when any slack source is configured
  const hasSlackSource = getServerConfig().sources.some(
    (s) => s.type === "slack",
  );
  const slackBotToken = process.env.SLACK_BOT_TOKEN ?? "";
  const slackSigningSecret = process.env.SLACK_SIGNING_SECRET ?? "";
  if (hasSlackSource && !slackBotToken) missing.push("SLACK_BOT_TOKEN");
  if (hasSlackSource && !openaiApiKey)
    missing.push("OPENAI_API_KEY (required for Slack distillation)");

  // Discord credentials — required when any discord source is configured
  const hasDiscordSource = getServerConfig().sources.some(
    (s) => s.type === "discord",
  );
  const hasDiscordTextChannels = getServerConfig().sources.some(
    (s) =>
      isDiscordSourceConfig(s) && s.channels.some((c) => c.type === "text"),
  );
  const discordBotToken = process.env.DISCORD_BOT_TOKEN ?? "";
  const discordPublicKey = process.env.DISCORD_PUBLIC_KEY ?? "";
  if (hasDiscordSource && !discordBotToken) missing.push("DISCORD_BOT_TOKEN");
  if (hasDiscordSource && !discordPublicKey) missing.push("DISCORD_PUBLIC_KEY");
  if (hasDiscordTextChannels && !openaiApiKey)
    missing.push(
      "OPENAI_API_KEY (required for Discord text channel distillation)",
    );

  // Notion credentials — required when any notion source is configured
  const hasNotionSource = getServerConfig().sources.some(
    (s) => s.type === "notion",
  );
  const notionToken = process.env.NOTION_TOKEN ?? "";
  if (hasNotionSource && !notionToken) missing.push("NOTION_TOKEN");

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. ` +
        `Set them before starting the server.`,
    );
  }

  const port = parseInt(process.env.PORT || "3001", 10);
  if (isNaN(port) || port < 0 || port > 65535) {
    throw new Error(
      `Invalid PORT value: ${process.env.PORT}. Must be a number between 0 and 65535.`,
    );
  }

  const nodeEnv = process.env.NODE_ENV || "development";
  const mcpJwtSecret = resolveJwtSecret({ nodeEnv });
  const oauthConsentHmacKeys = parseConsentHmacKeys(nodeEnv);

  // P2P telemetry — empty string env value treated as unset so a stray
  // `PATHFINDER_TELEMETRY_URL=` line in a .env file doesn't accidentally
  // enable the client with a bogus URL.
  const rawP2pUrl = process.env.PATHFINDER_TELEMETRY_URL?.trim();
  const p2pTelemetryUrl =
    rawP2pUrl && rawP2pUrl.length > 0 ? rawP2pUrl : undefined;
  const rawP2pDisabled =
    process.env.PATHFINDER_TELEMETRY_DISABLED?.trim().toLowerCase();
  const p2pTelemetryDisabled =
    rawP2pDisabled === "1" || rawP2pDisabled === "true";

  return {
    databaseUrl,
    openaiApiKey: openaiApiKey ?? "",
    githubToken: process.env.GITHUB_TOKEN || "",
    githubWebhookSecret: githubWebhookSecret!,
    port,
    nodeEnv,
    logLevel: process.env.LOG_LEVEL || "info",
    cloneDir: process.env.CLONE_DIR || "/tmp/mcp-repos",
    slackBotToken,
    slackSigningSecret,
    discordBotToken,
    discordPublicKey,
    notionToken,
    mcpJwtSecret,
    oauthConsentHmacKeys,
    p2pTelemetryUrl,
    p2pTelemetryDisabled,
    packageVersion: readPackageVersion(),
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL ?? "",
  };
}

export function getConfig(): Config {
  if (!cachedConfig) {
    cachedConfig = parseConfig();
  }
  return cachedConfig;
}

export const config = new Proxy({} as Config, {
  get(_target, prop: string) {
    return getConfig()[prop as keyof Config];
  },
});

// ── YAML server configuration ─────────────────────────────────────────────────

let cachedServerConfig: ServerConfig | null = null;

function resolveConfigPath(): string {
  // Primary env var
  const pathfinderEnv = process.env.PATHFINDER_CONFIG;
  if (pathfinderEnv) {
    const resolved = resolve(pathfinderEnv);
    if (!existsSync(resolved)) {
      throw new Error(
        `PATHFINDER_CONFIG points to ${resolved} but file does not exist.`,
      );
    }
    return resolved;
  }

  // Deprecated env var
  const mcpDocsEnv = process.env.MCP_DOCS_CONFIG;
  if (mcpDocsEnv) {
    console.warn(
      "[config] MCP_DOCS_CONFIG is deprecated — use PATHFINDER_CONFIG instead.",
    );
    const resolved = resolve(mcpDocsEnv);
    if (!existsSync(resolved)) {
      throw new Error(
        `MCP_DOCS_CONFIG points to ${resolved} but file does not exist.`,
      );
    }
    return resolved;
  }

  // Primary config file
  const pathfinderPath = resolve(process.cwd(), "pathfinder.yaml");
  if (existsSync(pathfinderPath)) {
    return pathfinderPath;
  }

  // Deprecated config file
  const mcpDocsPath = resolve(process.cwd(), "mcp-docs.yaml");
  if (mcpDocsPath && existsSync(mcpDocsPath)) {
    console.warn(
      "[config] mcp-docs.yaml is deprecated — rename to pathfinder.yaml.",
    );
    return mcpDocsPath;
  }

  throw new Error(
    "No pathfinder.yaml found. Set PATHFINDER_CONFIG env var or place pathfinder.yaml in the working directory.",
  );
}

function loadServerConfig(): ServerConfig {
  const configPath = resolveConfigPath();
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(raw);

  // Default tool type to 'search' for backwards compatibility
  if (Array.isArray(parsed?.tools)) {
    for (const tool of parsed.tools) {
      if (tool && typeof tool === "object" && !("type" in tool)) {
        console.warn(
          `[config] Tool "${tool.name}" has no type field — defaulting to "search". Add "type: search" explicitly to silence this warning.`,
        );
        tool.type = "search";
      }
    }
  }

  const result = ServerConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config at ${configPath}:\n${issues}`);
  }

  // Validate source name uniqueness
  const sourceNames = new Set(result.data.sources.map((s) => s.name));
  if (sourceNames.size !== result.data.sources.length) {
    throw new Error("Duplicate source names found in sources configuration.");
  }

  // Validate tool name uniqueness
  const toolNames = new Set(result.data.tools.map((t) => t.name));
  if (toolNames.size !== result.data.tools.length) {
    throw new Error("Duplicate tool names found in tools configuration.");
  }

  // Cross-validate: every search tool's source must reference an existing source name
  const searchTools = result.data.tools.filter((t) => t.type === "search");
  for (const tool of searchTools) {
    if (!sourceNames.has(tool.source)) {
      throw new Error(
        `Tool "${tool.name}" references source "${tool.source}" which is not defined in sources.`,
      );
    }
  }

  // Cross-validate: every knowledge tool's sources must reference existing source names
  const knowledgeTools = result.data.tools.filter(
    (t) => t.type === "knowledge",
  );
  for (const tool of knowledgeTools) {
    for (const src of tool.sources) {
      if (!sourceNames.has(src)) {
        throw new Error(
          `Knowledge tool "${tool.name}" references source "${src}" which is not defined in sources.`,
        );
      }
    }
  }

  // Cross-validate: webhook repo_sources and path_triggers must reference valid source names
  if (result.data.webhook) {
    const wh = result.data.webhook;
    for (const [repo, sources] of Object.entries(wh.repo_sources)) {
      for (const src of sources) {
        if (!sourceNames.has(src)) {
          throw new Error(
            `Webhook repo_sources["${repo}"] references source "${src}" which is not defined in sources.`,
          );
        }
      }
    }
    for (const triggerKey of Object.keys(wh.path_triggers)) {
      if (!sourceNames.has(triggerKey)) {
        throw new Error(
          `Webhook path_triggers key "${triggerKey}" does not match any defined source name.`,
        );
      }
    }
  }

  // Warn if knowledge tools reference non-FAQ sources
  for (const tool of result.data.tools) {
    if (tool.type === "knowledge") {
      for (const srcName of tool.sources) {
        const src = result.data.sources.find((s) => s.name === srcName);
        if (src && (!("category" in src) || src.category !== "faq")) {
          console.warn(
            `[config] Knowledge tool "${tool.name}" references source "${srcName}" which does not have category: "faq" — queries may return empty results`,
          );
        }
      }
    }
  }

  // Validate local source paths exist (file-based sources only)
  for (const source of result.data.sources) {
    if (!isFileSourceConfig(source)) continue;
    if (!source.repo) {
      const resolved = resolve(source.path);
      if (!existsSync(resolved)) {
        throw new Error(
          `Source "${source.name}" references local path "${source.path}" (resolved to ${resolved}) which does not exist.`,
        );
      }
    }
  }

  return result.data;
}

export function getServerConfig(): ServerConfig {
  if (!cachedServerConfig) {
    cachedServerConfig = loadServerConfig();
  }
  return cachedServerConfig;
}

/**
 * Safe accessor for analytics config — works around z.infer losing the
 * optional `analytics` property through superRefine's discriminated union.
 */
export function getAnalyticsConfig(): AnalyticsConfig | undefined {
  return (getServerConfig() as Record<string, unknown>).analytics as
    | AnalyticsConfig
    | undefined;
}

/**
 * Render an unknown thrown value as a single log-friendly string. Local
 * duplicate of server.ts's `formatErrorForLog` to avoid a config → server
 * circular import. Keep these two in sync.
 */
function formatErrorForConfigLog(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  if (err && typeof err === "object") {
    const maybe = err as { stack?: unknown; message?: unknown };
    if (typeof maybe.stack === "string") return maybe.stack;
    if (typeof maybe.message === "string") return maybe.message;
  }
  return String(err);
}

/**
 * Try to import a peer dep module and classify the outcome:
 *   - success         → no-op
 *   - MODULE_NOT_FOUND / ERR_MODULE_NOT_FOUND → add to `missing`
 *   - any other error → log full stack + re-throw a distinct "installed but
 *     failed to import" error so the caller surfaces the real cause
 *
 * Distinguishing these matters: the previous empty catch swallowed every
 * throw as "peer missing", which produced a confusing install-hint message
 * even when the peer WAS installed but failed to load (e.g. native-addon
 * ABI mismatch, ESM/CJS interop throw, file-system permission error on
 * node_modules/). Operators would follow the hint, reinstall, and see no
 * change.
 */
async function probePeerDepOrThrow(
  tryImport: (module: string) => Promise<unknown>,
  pkg: string,
  forType: string,
  missing: Array<{ pkg: string; forType: string }>,
): Promise<void> {
  try {
    await tryImport(pkg);
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    const isNotFound =
      code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
    if (isNotFound) {
      missing.push({ pkg, forType });
      return;
    }
    // Unexpected failure shape — log the full stack so operators can diagnose
    // the real cause (native-addon failure, ESM interop throw, etc.) and
    // re-throw a distinct error with the original attached as the cause.
    console.error(
      `[startup] ${pkg} is installed but failed to import: ${formatErrorForConfigLog(err)}`,
    );
    throw new Error(
      `${pkg} is installed but failed to import (required for ${forType} document sources). See preceding log for details.`,
      { cause: err },
    );
  }
}

/**
 * R4-13 — validate that required document-extraction peer deps
 * (`pdf-parse`, `mammoth`) are installed when a `document` source is
 * configured with file patterns that need them.
 *
 * The per-file extraction path in indexing/content-extractors.ts throws a
 * clear error when the dynamic import fails — but that throw only fires
 * when a specific file is being indexed, which could be hours into a first
 * run. Running the check at config-load time surfaces the missing peer
 * BEFORE the server starts accepting traffic, so operators see the install
 * hint alongside the rest of their startup errors.
 *
 * `tryImport` is injected so tests can drive every present/absent
 * combination without manipulating node_modules.
 */
export async function assertDocumentPeerDepsForSources(
  sources: ReadonlyArray<{
    type: string;
    file_patterns?: string[];
    [key: string]: unknown;
  }>,
  opts?: { tryImport?: (module: string) => Promise<unknown> },
): Promise<void> {
  const tryImport =
    opts?.tryImport ??
    (async (m: string) => {
      // Dynamic require via Function to dodge TS's static resolution of the
      // optional peer — same pattern content-extractors.ts uses.
      return await import(m);
    });
  const documentSources = sources.filter((s) => s.type === "document");
  if (documentSources.length === 0) return;
  const needsPdf = documentSources.some((s) =>
    (s.file_patterns ?? []).some((p) => p.includes(".pdf")),
  );
  const needsDocx = documentSources.some((s) =>
    (s.file_patterns ?? []).some((p) => p.includes(".docx")),
  );
  const missing: Array<{ pkg: string; forType: string }> = [];
  if (needsPdf) {
    await probePeerDepOrThrow(tryImport, "pdf-parse", "PDF", missing);
  }
  if (needsDocx) {
    await probePeerDepOrThrow(tryImport, "mammoth", "DOCX", missing);
  }
  if (missing.length === 0) return;
  const lines = missing.map(
    (m) =>
      `  - ${m.pkg} (required for ${m.forType} document sources). Install: npm install ${m.pkg}`,
  );
  throw new Error(
    `Configured document sources require optional peer dependencies that are not installed:\n${lines.join(
      "\n",
    )}\n\nAdd these to your install or remove the corresponding source.`,
  );
}

/**
 * #88 (local-embeddings closeout) — actionable message shown when the
 * `@xenova/transformers` optional peer is missing while `embedding.provider`
 * is `local`. Centralized so the eager startup guard and the `validate`
 * warning render identical wording. Extends the lazy first-embed message in
 * indexing/embeddings.ts with the `-local` Docker image hint.
 */
export const LOCAL_EMBEDDING_DEP_MESSAGE =
  'embedding.provider is "local" but the optional peer dependency ' +
  "@xenova/transformers is not installed. Either install it " +
  "(npm install @xenova/transformers) or use the prebuilt image " +
  "ghcr.io/copilotkit/pathfinder:latest-local, which ships it preinstalled.";

/**
 * #88 — shared dep-resolution probe used by BOTH the eager `serve` startup
 * guard (which exits non-zero) and `validate` (which records a warning). Pure
 * present/absent classification: returns `true` when `@xenova/transformers`
 * can be imported, `false` when it is absent (MODULE_NOT_FOUND /
 * ERR_MODULE_NOT_FOUND).
 *
 * Unlike a generic peer probe this deliberately does NOT re-throw on an
 * "installed but failed to import" error — for the local-embeddings guard,
 * any failure to load the module means the provider cannot run, so we treat
 * it as absent and surface the install/-image hint rather than a confusing
 * partial-load stack. `tryImport` is injected so tests drive present/absent
 * without manipulating node_modules.
 */
export async function resolveLocalEmbeddingDep(opts?: {
  tryImport?: (module: string) => Promise<unknown>;
}): Promise<boolean> {
  const tryImport = opts?.tryImport ?? (async (m: string) => await import(m));
  try {
    await tryImport("@xenova/transformers");
    return true;
  } catch {
    return false;
  }
}

/**
 * #88 — eager startup guard. When `embedding.provider === "local"` and the
 * `@xenova/transformers` peer is absent, throw with the actionable message so
 * `serve` fails loudly at boot instead of booting a healthy-looking server
 * that explodes at first embed (the prior lazy throw in
 * indexing/embeddings.ts:loadModel). No-op for non-local providers and when
 * the dep is present.
 *
 * `tryImport` is injected (forwarded to resolveLocalEmbeddingDep) so tests
 * cover local+absent / local+present / non-local+absent without touching
 * node_modules.
 */
export async function assertLocalEmbeddingDepForProvider(
  provider: string | undefined,
  opts?: { tryImport?: (module: string) => Promise<unknown> },
): Promise<void> {
  if (provider !== "local") return;
  const present = await resolveLocalEmbeddingDep(opts);
  if (present) return;
  throw new Error(LOCAL_EMBEDDING_DEP_MESSAGE);
}
