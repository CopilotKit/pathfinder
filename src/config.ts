// Centralized environment variable parsing with validation

import 'dotenv/config';

export interface Config {
    databaseUrl: string;
    openaiApiKey: string;
    githubToken: string;
    githubWebhookSecret: string;
    port: number;
    nodeEnv: string;
    logLevel: string;
    embeddingModel: string;
    embeddingDimensions: number;
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
        embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
        embeddingDimensions: 1536,
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
