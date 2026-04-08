import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ValidationResult } from '../validate.js';

// Mock fs
vi.mock('node:fs', async () => {
    const actual = await vi.importActual('node:fs');
    return {
        ...actual,
        existsSync: vi.fn().mockReturnValue(true),
        readFileSync: vi.fn(),
    };
});

// Mock child_process
vi.mock('node:child_process', () => ({
    execSync: vi.fn(),
}));

// Mock config
vi.mock('../config.js', () => {
    const sources = [
        {
            name: 'docs',
            type: 'markdown',
            path: './docs',
            file_patterns: ['**/*.md'],
            chunk: {},
        },
        {
            name: 'discord-support',
            type: 'discord',
            guild_id: '123456',
            channels: [
                { id: '111', type: 'text' },
                { id: '222', type: 'forum' },
            ],
            confidence_threshold: 0.7,
            min_thread_replies: 2,
            chunk: {},
            category: 'faq',
        },
    ];
    const tools = [
        { name: 'search-docs', type: 'search', source: 'docs', description: 'Search', default_limit: 10, max_limit: 50, result_format: 'docs' },
        { name: 'get-faq', type: 'knowledge', sources: ['discord-support'], description: 'FAQ', min_confidence: 0.7, default_limit: 20, max_limit: 100 },
    ];
    return {
        getConfig: vi.fn().mockReturnValue({
            openaiApiKey: 'test-key',
            slackBotToken: '',
            slackSigningSecret: '',
            discordBotToken: 'test-discord-token',
            discordPublicKey: 'test-public-key',
            databaseUrl: 'postgresql://test',
            githubToken: '',
            githubWebhookSecret: '',
            port: 3001,
            nodeEnv: 'test',
            logLevel: 'info',
            cloneDir: '/tmp/test',
        }),
        getServerConfig: vi.fn().mockReturnValue({
            server: { name: 'test', version: '1.0' },
            sources,
            tools,
            embedding: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 },
            indexing: { auto_reindex: true, reindex_hour_utc: 4, stale_threshold_hours: 24 },
        }),
    };
});

// Mock Discord API client
vi.mock('../indexing/providers/discord-api.js', () => {
    const MockDiscordApiClient = vi.fn(function (this: Record<string, unknown>) {
        this.rest = {
            get: vi.fn(),
        };
    });
    return { DiscordApiClient: MockDiscordApiClient };
});

// Mock Slack API client
vi.mock('../indexing/providers/slack-api.js', () => {
    const MockSlackApiClient = vi.fn(function (this: Record<string, unknown>) {
        this.webClient = {
            auth: { test: vi.fn() },
            conversations: { info: vi.fn() },
        };
    });
    return { SlackApiClient: MockSlackApiClient };
});

import { validateConfig } from '../validate.js';
import { existsSync } from 'node:fs';
import { getConfig, getServerConfig } from '../config.js';

const defaultSources = [
    {
        name: 'docs',
        type: 'markdown',
        path: './docs',
        file_patterns: ['**/*.md'],
        chunk: {},
    },
    {
        name: 'discord-support',
        type: 'discord',
        guild_id: '123456',
        channels: [
            { id: '111', type: 'text' },
            { id: '222', type: 'forum' },
        ],
        confidence_threshold: 0.7,
        min_thread_replies: 2,
        chunk: {},
        category: 'faq',
    },
];

const defaultTools = [
    { name: 'search-docs', type: 'search', source: 'docs', description: 'Search', default_limit: 10, max_limit: 50, result_format: 'docs' },
    { name: 'get-faq', type: 'knowledge', sources: ['discord-support'], description: 'FAQ', min_confidence: 0.7, default_limit: 20, max_limit: 100 },
];

const defaultServerConfig = {
    server: { name: 'test', version: '1.0' },
    sources: defaultSources,
    tools: defaultTools,
    embedding: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 },
    indexing: { auto_reindex: true, reindex_hour_utc: 4, stale_threshold_hours: 24 },
};

const defaultConfig = {
    openaiApiKey: 'test-key',
    slackBotToken: '',
    slackSigningSecret: '',
    discordBotToken: 'test-discord-token',
    discordPublicKey: 'test-public-key',
    databaseUrl: 'postgresql://test',
    githubToken: '',
    githubWebhookSecret: '',
    port: 3001,
    nodeEnv: 'test',
    logLevel: 'info',
    cloneDir: '/tmp/test',
};

describe('validateConfig', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
        (getConfig as ReturnType<typeof vi.fn>).mockReturnValue(defaultConfig);
        (getServerConfig as ReturnType<typeof vi.fn>).mockReturnValue(defaultServerConfig);
    });

    it('returns valid result when config and sources are accessible', async () => {
        const result = await validateConfig();

        expect(result.configValid).toBe(true);
        expect(result.sources).toHaveLength(2);
        expect(result.errors).toHaveLength(0);
    });

    it('reports missing env vars', async () => {
        const { getConfig } = await import('../config.js');
        (getConfig as ReturnType<typeof vi.fn>).mockReturnValue({
            openaiApiKey: '',
            discordBotToken: '',
            discordPublicKey: '',
            slackBotToken: '',
            databaseUrl: '',
        });

        const result = await validateConfig();

        const discordEnv = result.envVars.find(e => e.name === 'DISCORD_BOT_TOKEN');
        expect(discordEnv?.present).toBe(false);
        expect(result.errors.some(e => e.includes('DISCORD_BOT_TOKEN'))).toBe(true);
    });

    it('validates tool-source cross references', async () => {
        const result = await validateConfig();

        expect(result.tools).toHaveLength(2);
        expect(result.tools.every(t => t.valid)).toBe(true);
    });

    it('detects invalid tool-source references', async () => {
        const { getServerConfig } = await import('../config.js');
        (getServerConfig as ReturnType<typeof vi.fn>).mockReturnValue({
            server: { name: 'test', version: '1.0' },
            sources: [{ name: 'docs', type: 'markdown', path: './docs', file_patterns: ['**/*.md'], chunk: {} }],
            tools: [{ name: 'bad-tool', type: 'search', source: 'nonexistent', description: 'X', default_limit: 10, max_limit: 50, result_format: 'docs' }],
            embedding: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 },
            indexing: { auto_reindex: true, reindex_hour_utc: 4, stale_threshold_hours: 24 },
        });

        const result = await validateConfig();
        const badTool = result.tools.find(t => t.name === 'bad-tool');
        expect(badTool?.valid).toBe(false);
        expect(result.errors.some(e => e.includes('nonexistent'))).toBe(true);
    });

    it('handles config load failure gracefully', async () => {
        const { getServerConfig } = await import('../config.js');
        (getServerConfig as ReturnType<typeof vi.fn>).mockImplementation(() => {
            throw new Error('Invalid YAML at line 5');
        });

        const result = await validateConfig();
        expect(result.configValid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('Invalid YAML');
    });

    it('detects local path not existing', async () => {
        (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

        const result = await validateConfig();

        const docsSource = result.sources.find(s => s.name === 'docs');
        expect(docsSource?.valid).toBe(false);
    });
});
