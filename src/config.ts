// Centralized configuration: env-var secrets + YAML server config.

import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ServerConfigSchema, type ServerConfig, isDiscordSourceConfig, isFileSourceConfig } from './types.js';

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
}

/**
 * Check whether any search tools are configured (requires embeddings + indexing).
 */
export function hasSearchTools(): boolean {
    return getServerConfig().tools.some(t => t.type === 'search');
}

/**
 * Check whether any knowledge tools are configured (requires embeddings + indexing).
 */
export function hasKnowledgeTools(): boolean {
    return getServerConfig().tools.some(t => t.type === 'knowledge');
}

/**
 * Check whether any collect tools are configured (requires database).
 */
export function hasCollectTools(): boolean {
    return getServerConfig().tools.some(t => t.type === 'collect');
}

/**
 * Check whether any bash tools use vector or hybrid grep (requires embeddings + database).
 */
export function hasBashSemanticSearch(): boolean {
    return getServerConfig().tools.some(t =>
        t.type === 'bash' &&
        (t.bash?.grep_strategy === 'vector' || t.bash?.grep_strategy === 'hybrid')
    );
}

/**
 * Get the set of source names that need indexing (only those referenced by search tools).
 */
export function getIndexableSourceNames(): Set<string> {
    const cfg = getServerConfig();
    const searchSources = cfg.tools.filter(t => t.type === 'search').map(t => t.source);
    const knowledgeSources = cfg.tools.filter(t => t.type === 'knowledge').flatMap(t => t.sources);
    return new Set([...searchSources, ...knowledgeSources]);
}

let cachedConfig: Config | null = null;

function parseConfig(): Config {
    const missing: string[] = [];

    const needsRag = hasSearchTools() || hasKnowledgeTools();
    const needsDb = needsRag || hasCollectTools() || hasBashSemanticSearch();

    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl && needsDb) missing.push('DATABASE_URL');

    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey && needsRag) missing.push('OPENAI_API_KEY');

    const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET ?? '';

    // Slack credentials — required when any slack source is configured
    const hasSlackSource = getServerConfig().sources.some(s => s.type === 'slack');
    const slackBotToken = process.env.SLACK_BOT_TOKEN ?? '';
    const slackSigningSecret = process.env.SLACK_SIGNING_SECRET ?? '';
    if (hasSlackSource && !slackBotToken) missing.push('SLACK_BOT_TOKEN');
    if (hasSlackSource && !openaiApiKey) missing.push('OPENAI_API_KEY (required for Slack distillation)');

    // Discord credentials — required when any discord source is configured
    const hasDiscordSource = getServerConfig().sources.some(s => s.type === 'discord');
    const hasDiscordTextChannels = getServerConfig().sources.some(s => isDiscordSourceConfig(s) && s.channels.some(c => c.type === 'text'));
    const discordBotToken = process.env.DISCORD_BOT_TOKEN ?? '';
    const discordPublicKey = process.env.DISCORD_PUBLIC_KEY ?? '';
    if (hasDiscordSource && !discordBotToken) missing.push('DISCORD_BOT_TOKEN');
    if (hasDiscordSource && !discordPublicKey) missing.push('DISCORD_PUBLIC_KEY');
    if (hasDiscordTextChannels && !openaiApiKey) missing.push('OPENAI_API_KEY (required for Discord text channel distillation)');

    // Notion credentials — required when any notion source is configured
    const hasNotionSource = getServerConfig().sources.some(s => s.type === 'notion');
    const notionToken = process.env.NOTION_TOKEN ?? '';
    if (hasNotionSource && !notionToken) missing.push('NOTION_TOKEN');

    if (missing.length > 0) {
        throw new Error(
            `Missing required environment variables: ${missing.join(', ')}. ` +
            `Set them before starting the server.`
        );
    }

    const port = parseInt(process.env.PORT || '3001', 10);
    if (isNaN(port) || port < 0 || port > 65535) {
        throw new Error(`Invalid PORT value: ${process.env.PORT}. Must be a number between 0 and 65535.`);
    }

    return {
        databaseUrl,
        openaiApiKey: openaiApiKey ?? '',
        githubToken: process.env.GITHUB_TOKEN || '',
        githubWebhookSecret: githubWebhookSecret!,
        port,
        nodeEnv: process.env.NODE_ENV || 'development',
        logLevel: process.env.LOG_LEVEL || 'info',
        cloneDir: process.env.CLONE_DIR || '/tmp/mcp-repos',
        slackBotToken,
        slackSigningSecret,
        discordBotToken,
        discordPublicKey,
        notionToken,
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
            throw new Error(`PATHFINDER_CONFIG points to ${resolved} but file does not exist.`);
        }
        return resolved;
    }

    // Deprecated env var
    const mcpDocsEnv = process.env.MCP_DOCS_CONFIG;
    if (mcpDocsEnv) {
        console.warn('[config] MCP_DOCS_CONFIG is deprecated — use PATHFINDER_CONFIG instead.');
        const resolved = resolve(mcpDocsEnv);
        if (!existsSync(resolved)) {
            throw new Error(`MCP_DOCS_CONFIG points to ${resolved} but file does not exist.`);
        }
        return resolved;
    }

    // Primary config file
    const pathfinderPath = resolve(process.cwd(), 'pathfinder.yaml');
    if (existsSync(pathfinderPath)) {
        return pathfinderPath;
    }

    // Deprecated config file
    const mcpDocsPath = resolve(process.cwd(), 'mcp-docs.yaml');
    if (mcpDocsPath && existsSync(mcpDocsPath)) {
        console.warn('[config] mcp-docs.yaml is deprecated — rename to pathfinder.yaml.');
        return mcpDocsPath;
    }

    throw new Error(
        'No pathfinder.yaml found. Set PATHFINDER_CONFIG env var or place pathfinder.yaml in the working directory.'
    );
}

function loadServerConfig(): ServerConfig {
    const configPath = resolveConfigPath();
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(raw);

    // Default tool type to 'search' for backwards compatibility
    if (Array.isArray(parsed?.tools)) {
        for (const tool of parsed.tools) {
            if (tool && typeof tool === 'object' && !('type' in tool)) {
                console.warn(`[config] Tool "${tool.name}" has no type field — defaulting to "search". Add "type: search" explicitly to silence this warning.`);
                tool.type = 'search';
            }
        }
    }

    const result = ServerConfigSchema.safeParse(parsed);
    if (!result.success) {
        const issues = result.error.issues
            .map(i => `  - ${i.path.join('.')}: ${i.message}`)
            .join('\n');
        throw new Error(`Invalid config at ${configPath}:\n${issues}`);
    }

    // Validate source name uniqueness
    const sourceNames = new Set(result.data.sources.map(s => s.name));
    if (sourceNames.size !== result.data.sources.length) {
        throw new Error('Duplicate source names found in sources configuration.');
    }

    // Validate tool name uniqueness
    const toolNames = new Set(result.data.tools.map(t => t.name));
    if (toolNames.size !== result.data.tools.length) {
        throw new Error('Duplicate tool names found in tools configuration.');
    }

    // Cross-validate: every search tool's source must reference an existing source name
    const searchTools = result.data.tools.filter(t => t.type === 'search');
    for (const tool of searchTools) {
        if (!sourceNames.has(tool.source)) {
            throw new Error(
                `Tool "${tool.name}" references source "${tool.source}" which is not defined in sources.`
            );
        }
    }

    // Cross-validate: every knowledge tool's sources must reference existing source names
    const knowledgeTools = result.data.tools.filter(t => t.type === 'knowledge');
    for (const tool of knowledgeTools) {
        for (const src of tool.sources) {
            if (!sourceNames.has(src)) {
                throw new Error(
                    `Knowledge tool "${tool.name}" references source "${src}" which is not defined in sources.`
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
                        `Webhook repo_sources["${repo}"] references source "${src}" which is not defined in sources.`
                    );
                }
            }
        }
        for (const triggerKey of Object.keys(wh.path_triggers)) {
            if (!sourceNames.has(triggerKey)) {
                throw new Error(
                    `Webhook path_triggers key "${triggerKey}" does not match any defined source name.`
                );
            }
        }
    }

    // Warn if knowledge tools reference non-FAQ sources
    for (const tool of result.data.tools) {
        if (tool.type === 'knowledge') {
            for (const srcName of tool.sources) {
                const src = result.data.sources.find(s => s.name === srcName);
                if (src && (!('category' in src) || src.category !== 'faq')) {
                    console.warn(`[config] Knowledge tool "${tool.name}" references source "${srcName}" which does not have category: "faq" — queries may return empty results`);
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
                    `Source "${source.name}" references local path "${source.path}" (resolved to ${resolved}) which does not exist.`
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
