// Centralized configuration: env-var secrets + YAML server config.

import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ServerConfigSchema, type ServerConfig } from './types.js';

// ── Environment variable config (secrets and runtime settings) ────────────────

export interface Config {
    databaseUrl: string;
    openaiApiKey: string;
    githubToken: string;
    githubWebhookSecret: string;
    port: number;
    nodeEnv: string;
    logLevel: string;
    cloneDir: string;
}

let cachedConfig: Config | null = null;

function parseConfig(): Config {
    const missing: string[] = [];

    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) missing.push('DATABASE_URL');

    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) missing.push('OPENAI_API_KEY');

    const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!githubWebhookSecret) missing.push('GITHUB_WEBHOOK_SECRET');

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
        databaseUrl: databaseUrl!,
        openaiApiKey: openaiApiKey!,
        githubToken: process.env.GITHUB_TOKEN || '',
        githubWebhookSecret: githubWebhookSecret!,
        port,
        nodeEnv: process.env.NODE_ENV || 'development',
        logLevel: process.env.LOG_LEVEL || 'info',
        cloneDir: process.env.CLONE_DIR || '/tmp/mcp-repos',
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
    const envPath = process.env.MCP_DOCS_CONFIG;
    if (envPath) {
        const resolved = resolve(envPath);
        if (!existsSync(resolved)) {
            throw new Error(`MCP_DOCS_CONFIG points to ${resolved} but file does not exist.`);
        }
        return resolved;
    }

    const cwdPath = resolve(process.cwd(), 'mcp-docs.yaml');
    if (existsSync(cwdPath)) {
        return cwdPath;
    }

    throw new Error(
        'No mcp-docs.yaml found. Set MCP_DOCS_CONFIG env var or place mcp-docs.yaml in the working directory.'
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
        throw new Error(`Invalid mcp-docs.yaml at ${configPath}:\n${issues}`);
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

    // Validate local source paths exist
    for (const source of result.data.sources) {
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
