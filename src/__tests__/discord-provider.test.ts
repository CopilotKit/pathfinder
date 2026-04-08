import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscordDataProvider } from '../indexing/providers/discord.js';
import type { DiscordSourceConfig } from '../types.js';

// Mock dependencies
vi.mock('../indexing/providers/discord-api.js', () => {
    const MockDiscordApiClient = vi.fn(function (this: Record<string, unknown>) {
        this.fetchChannelMessages = vi.fn();
        this.fetchForumThreads = vi.fn();
        this.fetchThreadMessages = vi.fn();
        this.fetchUser = vi.fn();
        this.getMessageUrl = vi.fn();
    });
    return { DiscordApiClient: MockDiscordApiClient };
});

vi.mock('../indexing/distiller.js', () => ({
    distillThread: vi.fn(),
}));

vi.mock('../config.js', () => ({
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
}));

import { DiscordApiClient } from '../indexing/providers/discord-api.js';
import { distillThread } from '../indexing/distiller.js';

const textOnlyConfig: DiscordSourceConfig = {
    name: 'discord-test',
    type: 'discord',
    guild_id: 'G001',
    channels: [{ id: 'C001', type: 'text' }],
    confidence_threshold: 0.7,
    min_thread_replies: 2,
    chunk: {},
    category: 'faq',
};

const forumOnlyConfig: DiscordSourceConfig = {
    name: 'discord-forum',
    type: 'discord',
    guild_id: 'G001',
    channels: [{ id: 'F001', type: 'forum' }],
    confidence_threshold: 0.7,
    min_thread_replies: 2,
    chunk: {},
    category: 'faq',
};

const mixedConfig: DiscordSourceConfig = {
    name: 'discord-mixed',
    type: 'discord',
    guild_id: 'G001',
    channels: [
        { id: 'C001', type: 'text' },
        { id: 'F001', type: 'forum' },
    ],
    confidence_threshold: 0.7,
    min_thread_replies: 2,
    chunk: {},
    category: 'faq',
};

describe('DiscordDataProvider', () => {
    let mockApiClient: Record<string, ReturnType<typeof vi.fn>>;

    function createProvider(config: DiscordSourceConfig) {
        const provider = new DiscordDataProvider(config, {
            cloneDir: '/tmp/test',
            discordBotToken: 'test-discord-token',
        });
        mockApiClient = (DiscordApiClient as ReturnType<typeof vi.fn>).mock.results[
            (DiscordApiClient as ReturnType<typeof vi.fn>).mock.results.length - 1
        ].value;
        return provider;
    }

    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('constructor', () => {
        it('throws for non-discord config', () => {
            expect(() => new DiscordDataProvider(
                { name: 'test', type: 'slack', channels: ['C1'], chunk: {}, confidence_threshold: 0.7, trigger_emoji: 'p', min_thread_replies: 2, category: 'faq' } as any,
                { cloneDir: '/tmp/test', discordBotToken: 'token' },
            )).toThrow('DiscordDataProvider requires a discord source config');
        });

        it('throws when discordBotToken is missing', () => {
            expect(() => new DiscordDataProvider(
                textOnlyConfig,
                { cloneDir: '/tmp/test' },
            )).toThrow('discordBotToken');
        });
    });

    describe('fullAcquire — text channels', () => {
        it('fetches threads and distills Q&A pairs', async () => {
            const provider = createProvider(textOnlyConfig);

            mockApiClient.fetchChannelMessages.mockResolvedValue([
                { id: '1001', author: { id: 'U1', username: 'alice' }, content: 'Question?', timestamp: '2024-01-01T00:00:00Z', thread: { id: 'T1', message_count: 5 } },
            ]);
            mockApiClient.fetchThreadMessages.mockResolvedValue([
                { id: '1001', author: { id: 'U1', username: 'alice' }, content: 'Question?', timestamp: '2024-01-01T00:00:00Z' },
                { id: '1002', author: { id: 'U2', username: 'bob', global_name: 'Bob' }, content: 'Answer.', timestamp: '2024-01-01T00:01:00Z' },
                { id: '1003', author: { id: 'U1', username: 'alice' }, content: 'Thanks!', timestamp: '2024-01-01T00:02:00Z' },
            ]);
            mockApiClient.fetchUser
                .mockResolvedValueOnce({ id: 'U1', displayName: 'Alice' })
                .mockResolvedValueOnce({ id: 'U2', displayName: 'Bob' })
                .mockResolvedValueOnce({ id: 'U1', displayName: 'Alice' });
            mockApiClient.getMessageUrl.mockReturnValue('https://discord.com/channels/G001/C001/1001');
            (distillThread as ReturnType<typeof vi.fn>).mockResolvedValue({
                pairs: [{ question: 'What is X?', answer: 'X is Y.', confidence: 0.9 }],
            });

            const result = await provider.fullAcquire();

            expect(result.items).toHaveLength(1);
            expect(result.items[0].id).toBe('C001:1001:0');
            expect(result.items[0].content).toContain('Q: What is X?');
            expect(result.items[0].content).toContain('A: X is Y.');
            expect(result.items[0].title).toBe('What is X?');
            expect(result.items[0].sourceUrl).toBe('https://discord.com/channels/G001/C001/1001');
            expect(result.items[0].metadata?.confidence).toBe(0.9);
            expect(result.removedIds).toEqual([]);
        });

        it('filters threads below min_thread_replies', async () => {
            const provider = createProvider(textOnlyConfig);

            mockApiClient.fetchChannelMessages.mockResolvedValue([
                { id: '1001', author: { id: 'U1', username: 'a' }, content: 'Q', timestamp: '2024-01-01T00:00:00Z', thread: { id: 'T1', message_count: 1 } },
            ]);

            const result = await provider.fullAcquire();
            expect(result.items).toEqual([]);
            expect(mockApiClient.fetchThreadMessages).not.toHaveBeenCalled();
        });

        it('handles empty channel', async () => {
            const provider = createProvider(textOnlyConfig);
            mockApiClient.fetchChannelMessages.mockResolvedValue([]);
            const result = await provider.fullAcquire();
            expect(result.items).toEqual([]);
        });
    });

    describe('fullAcquire — forum channels', () => {
        it('extracts Q&A directly from forum threads', async () => {
            const provider = createProvider(forumOnlyConfig);

            mockApiClient.fetchForumThreads.mockResolvedValue([
                { id: 'T1', name: 'How do I install?', parent_id: 'F001', message_count: 3, owner_id: 'U1', created_timestamp: '2024-01-01', last_message_id: '5001', archived: false },
            ]);
            mockApiClient.fetchThreadMessages.mockResolvedValue([
                { id: '5000', author: { id: 'U1', username: 'alice', global_name: 'Alice' }, content: 'How do I install? I need help.', timestamp: '2024-01-01T00:00:00Z' },
                { id: '5001', author: { id: 'U2', username: 'bob', global_name: 'Bob' }, content: 'Run npm install @copilotkit/core', timestamp: '2024-01-01T00:01:00Z' },
            ]);
            mockApiClient.getMessageUrl.mockReturnValue('https://discord.com/channels/G001/T1/5000');

            const result = await provider.fullAcquire();

            expect(result.items).toHaveLength(1);
            expect(result.items[0].id).toBe('F001:T1');
            expect(result.items[0].content).toContain('Q: How do I install?');
            expect(result.items[0].content).toContain('A: ');
            expect(result.items[0].content).toContain('Bob: Run npm install @copilotkit/core');
            expect(result.items[0].metadata?.confidence).toBe(1.0);
            expect(result.items[0].metadata?.forumThread).toBe(true);
            // Distiller should NOT be called for forum channels
            expect(distillThread).not.toHaveBeenCalled();
        });

        it('skips first message if it restates the thread title', async () => {
            const provider = createProvider(forumOnlyConfig);

            mockApiClient.fetchForumThreads.mockResolvedValue([
                { id: 'T1', name: 'How do I install?', parent_id: 'F001', message_count: 3, owner_id: 'U1', created_timestamp: '2024-01-01', last_message_id: '5002', archived: false },
            ]);
            mockApiClient.fetchThreadMessages.mockResolvedValue([
                { id: '5000', author: { id: 'U1', username: 'alice' }, content: 'How do I install?', timestamp: '2024-01-01T00:00:00Z' },
                { id: '5001', author: { id: 'U2', username: 'bob', global_name: 'Bob' }, content: 'Use npm install', timestamp: '2024-01-01T00:01:00Z' },
                { id: '5002', author: { id: 'U1', username: 'alice' }, content: 'Thanks!', timestamp: '2024-01-01T00:02:00Z' },
            ]);
            mockApiClient.getMessageUrl.mockReturnValue('https://discord.com/channels/G001/T1/5000');

            const result = await provider.fullAcquire();

            expect(result.items).toHaveLength(1);
            // The answer should NOT contain the title-restating first message
            expect(result.items[0].content).not.toContain('alice: How do I install?');
            expect(result.items[0].content).toContain('Bob: Use npm install');
        });

        it('preserves first message when it adds content beyond the title', async () => {
            const provider = createProvider(forumOnlyConfig);

            mockApiClient.fetchForumThreads.mockResolvedValue([
                { id: 'T1', name: 'How do I install?', parent_id: 'F001', message_count: 3, owner_id: 'U1', created_timestamp: '2024-01-01', last_message_id: '5002', archived: false },
            ]);
            mockApiClient.fetchThreadMessages.mockResolvedValue([
                { id: '5000', author: { id: 'U1', username: 'alice', global_name: 'Alice' }, content: 'How do I install? I\'ve been trying for hours and nothing works.', timestamp: '2024-01-01T00:00:00Z' },
                { id: '5001', author: { id: 'U2', username: 'bob', global_name: 'Bob' }, content: 'Run npm install @copilotkit/core', timestamp: '2024-01-01T00:01:00Z' },
                { id: '5002', author: { id: 'U1', username: 'alice', global_name: 'Alice' }, content: 'Thanks!', timestamp: '2024-01-01T00:02:00Z' },
            ]);
            mockApiClient.getMessageUrl.mockReturnValue('https://discord.com/channels/G001/T1/5000');

            const result = await provider.fullAcquire();

            expect(result.items).toHaveLength(1);
            // The first message should be preserved because it contains content beyond the title
            expect(result.items[0].content).toContain('Alice: How do I install?');
            expect(result.items[0].content).toContain('nothing works');
            expect(result.items[0].content).toContain('Bob: Run npm install @copilotkit/core');
        });

        it('truncates long forum answers at MAX_ANSWER_CHARS', async () => {
            const provider = createProvider(forumOnlyConfig);

            mockApiClient.fetchForumThreads.mockResolvedValue([
                { id: 'T1', name: 'Long thread', parent_id: 'F001', message_count: 100, owner_id: 'U1', created_timestamp: '2024-01-01', last_message_id: '9999', archived: false },
            ]);

            // Generate many long messages to exceed 8000 chars
            const longMessages = Array.from({ length: 50 }, (_, i) => ({
                id: String(6000 + i),
                author: { id: `U${i}`, username: `user${i}`, global_name: `User ${i}` },
                content: 'A'.repeat(200),
                timestamp: `2024-01-01T00:${String(i).padStart(2, '0')}:00Z`,
            }));
            mockApiClient.fetchThreadMessages.mockResolvedValue(longMessages);
            mockApiClient.getMessageUrl.mockReturnValue('https://discord.com/channels/G001/T1/6000');

            const result = await provider.fullAcquire();

            expect(result.items).toHaveLength(1);
            // Answer portion should be truncated
            const answerStart = result.items[0].content.indexOf('A: ');
            const answer = result.items[0].content.slice(answerStart + 3);
            expect(answer.length).toBeLessThanOrEqual(8100); // 8000 + some tolerance for truncation marker
            expect(answer).toContain('[truncated]');
        });

        it('filters forum threads below min_thread_replies', async () => {
            const provider = createProvider(forumOnlyConfig);

            mockApiClient.fetchForumThreads.mockResolvedValue([
                { id: 'T1', name: 'Too few replies', parent_id: 'F001', message_count: 1, owner_id: 'U1', created_timestamp: '2024-01-01', last_message_id: '5001', archived: false },
            ]);

            const result = await provider.fullAcquire();
            expect(result.items).toEqual([]);
        });

        it('skips forum threads with empty synthesized answer', async () => {
            const provider = createProvider(forumOnlyConfig);

            mockApiClient.fetchForumThreads.mockResolvedValue([
                { id: 'T1', name: 'Unanswered', parent_id: 'F001', message_count: 2, owner_id: 'U1', created_timestamp: '2024-01-01', last_message_id: '5001', archived: false },
            ]);
            // Only embeds, no text content
            mockApiClient.fetchThreadMessages.mockResolvedValue([
                { id: '5000', author: { id: 'U1', username: 'alice' }, content: '', timestamp: '2024-01-01T00:00:00Z' },
                { id: '5001', author: { id: 'U2', username: 'bob' }, content: '', timestamp: '2024-01-01T00:01:00Z' },
            ]);

            const result = await provider.fullAcquire();
            expect(result.items).toEqual([]);
        });
    });

    describe('fullAcquire — mixed channels', () => {
        it('processes both text and forum channels', async () => {
            const provider = createProvider(mixedConfig);

            // Text channel
            mockApiClient.fetchChannelMessages.mockResolvedValue([
                { id: '1001', author: { id: 'U1', username: 'a' }, content: 'Q?', timestamp: '2024-01-01T00:00:00Z', thread: { id: 'T1', message_count: 3 } },
            ]);
            mockApiClient.fetchThreadMessages.mockResolvedValueOnce([
                { id: '1001', author: { id: 'U1', username: 'a' }, content: 'Q?', timestamp: '2024-01-01T00:00:00Z' },
                { id: '1002', author: { id: 'U2', username: 'b' }, content: 'A.', timestamp: '2024-01-01T00:01:00Z' },
            ]);
            mockApiClient.fetchUser.mockResolvedValue({ id: 'U1', displayName: 'User' });
            mockApiClient.getMessageUrl.mockReturnValue('https://discord.com/channels/G001/C001/1001');
            (distillThread as ReturnType<typeof vi.fn>).mockResolvedValue({
                pairs: [{ question: 'Text Q', answer: 'Text A', confidence: 0.8 }],
            });

            // Forum channel
            mockApiClient.fetchForumThreads.mockResolvedValue([
                { id: 'FT1', name: 'Forum question', parent_id: 'F001', message_count: 3, owner_id: 'U1', created_timestamp: '2024-01-01', last_message_id: '9001', archived: false },
            ]);
            mockApiClient.fetchThreadMessages.mockResolvedValueOnce([
                { id: '9000', author: { id: 'U1', username: 'a', global_name: 'UserA' }, content: 'Details here', timestamp: '2024-01-01T00:00:00Z' },
                { id: '9001', author: { id: 'U2', username: 'b', global_name: 'UserB' }, content: 'The answer', timestamp: '2024-01-01T00:01:00Z' },
            ]);

            const result = await provider.fullAcquire();

            expect(result.items).toHaveLength(2);
            // One from text distillation, one from forum extraction
            const textItem = result.items.find(i => i.id.startsWith('C001:'));
            const forumItem = result.items.find(i => i.id.startsWith('F001:'));
            expect(textItem).toBeDefined();
            expect(forumItem).toBeDefined();
            expect(forumItem!.metadata?.forumThread).toBe(true);
            expect(forumItem!.metadata?.confidence).toBe(1.0);
        });
    });

    describe('fullAcquire — error handling', () => {
        it('throws when all channels fail', async () => {
            const provider = createProvider(textOnlyConfig);
            mockApiClient.fetchChannelMessages.mockRejectedValue(new Error('channel_not_found'));
            await expect(provider.fullAcquire()).rejects.toThrow('All 1 channel(s) failed');
        });

        it('continues when one channel fails in multi-channel config', async () => {
            const provider = createProvider(mixedConfig);

            // Text channel fails
            mockApiClient.fetchChannelMessages.mockRejectedValue(new Error('fail'));

            // Forum channel succeeds
            mockApiClient.fetchForumThreads.mockResolvedValue([
                { id: 'FT1', name: 'Question', parent_id: 'F001', message_count: 3, owner_id: 'U1', created_timestamp: '2024-01-01', last_message_id: '9001', archived: false },
            ]);
            mockApiClient.fetchThreadMessages.mockResolvedValue([
                { id: '9000', author: { id: 'U1', username: 'a', global_name: 'A' }, content: 'Details', timestamp: '2024-01-01T00:00:00Z' },
                { id: '9001', author: { id: 'U2', username: 'b', global_name: 'B' }, content: 'Answer', timestamp: '2024-01-01T00:01:00Z' },
            ]);
            mockApiClient.getMessageUrl.mockReturnValue('https://discord.com/channels/G001/F001/9000');

            const result = await provider.fullAcquire();
            expect(result.items).toHaveLength(1);
        });
    });

    describe('incrementalAcquire', () => {
        it('passes after parameter for text channels', async () => {
            const provider = createProvider(textOnlyConfig);
            mockApiClient.fetchChannelMessages.mockResolvedValue([]);

            await provider.incrementalAcquire('999');
            expect(mockApiClient.fetchChannelMessages).toHaveBeenCalledWith('C001', '999');
        });

        it('filters forum threads by last_message_id > lastStateToken via BigInt', async () => {
            const provider = createProvider(forumOnlyConfig);

            mockApiClient.fetchForumThreads.mockResolvedValue([
                { id: 'T1', name: 'Old thread', parent_id: 'F001', message_count: 5, owner_id: 'U1', created_timestamp: '2024-01-01', last_message_id: '500', archived: false },
                { id: 'T2', name: 'New thread', parent_id: 'F001', message_count: 3, owner_id: 'U2', created_timestamp: '2024-01-02', last_message_id: '1500', archived: false },
            ]);
            mockApiClient.fetchThreadMessages.mockResolvedValue([
                { id: '1400', author: { id: 'U2', username: 'b', global_name: 'B' }, content: 'Details', timestamp: '2024-01-02T00:00:00Z' },
                { id: '1500', author: { id: 'U3', username: 'c', global_name: 'C' }, content: 'Reply', timestamp: '2024-01-02T00:01:00Z' },
            ]);
            mockApiClient.getMessageUrl.mockReturnValue('https://discord.com/channels/G001/T2/1400');

            const result = await provider.incrementalAcquire('1000');

            expect(result.items).toHaveLength(1);
            expect(result.items[0].id).toBe('F001:T2');
        });

        it('returns stateToken >= lastStateToken', async () => {
            const provider = createProvider(textOnlyConfig);
            mockApiClient.fetchChannelMessages.mockResolvedValue([]);

            const result = await provider.incrementalAcquire('1500');
            expect(BigInt(result.stateToken)).toBeGreaterThanOrEqual(BigInt('1500'));
        });
    });

    describe('getCurrentStateToken', () => {
        it('returns max snowflake across text and forum channels', async () => {
            const provider = createProvider(mixedConfig);

            // Text channel: latest message
            mockApiClient.fetchChannelMessages.mockResolvedValue([
                { id: '2000', author: { id: 'U1', username: 'a' }, content: 'msg', timestamp: '2024-01-01T00:00:00Z' },
            ]);

            // Forum channel: threads
            mockApiClient.fetchForumThreads.mockResolvedValue([
                { id: 'T1', name: 'Thread', parent_id: 'F001', message_count: 3, owner_id: 'U1', created_timestamp: '2024-01-01', last_message_id: '3000', archived: false },
            ]);

            const token = await provider.getCurrentStateToken();
            expect(token).toBe('3000');
        });

        it('returns null when no messages found', async () => {
            const provider = createProvider(textOnlyConfig);
            mockApiClient.fetchChannelMessages.mockResolvedValue([]);

            const token = await provider.getCurrentStateToken();
            expect(token).toBeNull();
        });
    });
});
