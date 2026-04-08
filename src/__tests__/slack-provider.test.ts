import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackDataProvider } from '../indexing/providers/slack.js';
import type { SlackSourceConfig } from '../types.js';

// Mock dependencies
vi.mock('../indexing/providers/slack-api.js', () => {
    const MockSlackApiClient = vi.fn(function (this: Record<string, unknown>) {
        this.fetchChannelHistory = vi.fn();
        this.fetchThreadReplies = vi.fn();
        this.fetchUserInfo = vi.fn();
        this.getChannelPermalink = vi.fn();
    });
    return { SlackApiClient: MockSlackApiClient };
});

vi.mock('../indexing/distiller.js', () => ({
    distillThread: vi.fn(),
}));

vi.mock('../config.js', () => ({
    getConfig: vi.fn().mockReturnValue({
        openaiApiKey: 'test-key',
        slackBotToken: 'xoxb-test',
        slackSigningSecret: 'test-secret',
        databaseUrl: 'postgresql://test',
        githubToken: '',
        githubWebhookSecret: '',
        port: 3001,
        nodeEnv: 'test',
        logLevel: 'info',
        cloneDir: '/tmp/test',
    }),
}));

import { SlackApiClient } from '../indexing/providers/slack-api.js';
import { distillThread } from '../indexing/distiller.js';

const slackConfig: SlackSourceConfig = {
    name: 'slack-test',
    type: 'slack',
    channels: ['C001'],
    confidence_threshold: 0.7,
    trigger_emoji: 'pathfinder',
    min_thread_replies: 2,
    chunk: { target_tokens: 600, overlap_tokens: 0 },
    category: 'faq',
};

describe('SlackDataProvider', () => {
    let provider: SlackDataProvider;
    let mockApiClient: Record<string, ReturnType<typeof vi.fn>>;

    beforeEach(() => {
        vi.clearAllMocks();
        provider = new SlackDataProvider(slackConfig, {
            cloneDir: '/tmp/test',
            slackBotToken: 'xoxb-test',
        });
        // Get the mock instance created by the constructor
        mockApiClient = (SlackApiClient as ReturnType<typeof vi.fn>).mock.results[0].value;
    });

    describe('fullAcquire', () => {
        it('fetches threads and distills Q&A pairs', async () => {
            mockApiClient.fetchChannelHistory.mockResolvedValue([
                { ts: '1000.0001', thread_ts: '1000.0001', reply_count: 3, user: 'U001', text: 'Question?' },
            ]);
            mockApiClient.fetchThreadReplies.mockResolvedValue([
                { ts: '1000.0001', user: 'U001', text: 'Question?' },
                { ts: '1000.0002', user: 'U002', text: 'Answer here.' },
                { ts: '1000.0003', user: 'U001', text: 'Thanks!' },
            ]);
            mockApiClient.fetchUserInfo
                .mockResolvedValueOnce({ id: 'U001', displayName: 'Alice' })
                .mockResolvedValueOnce({ id: 'U002', displayName: 'Bob' })
                .mockResolvedValueOnce({ id: 'U001', displayName: 'Alice' });
            mockApiClient.getChannelPermalink.mockResolvedValue('https://slack.com/archives/C001/p1000');
            (distillThread as ReturnType<typeof vi.fn>).mockResolvedValue({
                pairs: [{ question: 'What is X?', answer: 'X is Y.', confidence: 0.9 }],
            });

            const result = await provider.fullAcquire();

            expect(result.items).toHaveLength(1);
            expect(result.items[0].id).toBe('C001:1000.0001:0');
            expect(result.items[0].content).toContain('Q: What is X?');
            expect(result.items[0].content).toContain('A: X is Y.');
            expect(result.items[0].title).toBe('What is X?');
            expect(result.items[0].sourceUrl).toBe('https://slack.com/archives/C001/p1000');
            expect(result.items[0].metadata?.confidence).toBe(0.9);
            expect(result.stateToken).toBe('1000.0001');
            expect(result.removedIds).toEqual([]);
        });

        it('filters threads below min_thread_replies', async () => {
            mockApiClient.fetchChannelHistory.mockResolvedValue([
                { ts: '1000.0001', thread_ts: '1000.0001', reply_count: 1, user: 'U001', text: 'Only one reply' },
            ]);

            const result = await provider.fullAcquire();
            expect(result.items).toEqual([]);
            expect(mockApiClient.fetchThreadReplies).not.toHaveBeenCalled();
        });

        it('stores all Q&A pairs regardless of confidence (filtering at query time)', async () => {
            mockApiClient.fetchChannelHistory.mockResolvedValue([
                { ts: '1000.0001', thread_ts: '1000.0001', reply_count: 3, user: 'U001' },
            ]);
            mockApiClient.fetchThreadReplies.mockResolvedValue([
                { ts: '1000.0001', user: 'U001', text: 'Q' },
                { ts: '1000.0002', user: 'U002', text: 'A' },
            ]);
            mockApiClient.fetchUserInfo.mockResolvedValue({ id: 'U001', displayName: 'User' });
            (distillThread as ReturnType<typeof vi.fn>).mockResolvedValue({
                pairs: [
                    { question: 'High conf', answer: 'Answer', confidence: 0.9 },
                    { question: 'Low conf', answer: 'Answer', confidence: 0.3 },
                ],
            });
            mockApiClient.getChannelPermalink.mockResolvedValue('https://slack.com/link');

            const result = await provider.fullAcquire();
            expect(result.items).toHaveLength(2);
            expect(result.items[0].title).toBe('High conf');
            expect(result.items[0].metadata?.confidence).toBe(0.9);
            expect(result.items[1].title).toBe('Low conf');
            expect(result.items[1].metadata?.confidence).toBe(0.3);
        });

        it('handles empty channel gracefully', async () => {
            mockApiClient.fetchChannelHistory.mockResolvedValue([]);
            const result = await provider.fullAcquire();
            expect(result.items).toEqual([]);
            expect(result.stateToken).toBe('0');
        });

        it('continues processing other channels on error', async () => {
            const multiChannelConfig: SlackSourceConfig = {
                ...slackConfig,
                channels: ['C001', 'C002'],
            };
            const multiProvider = new SlackDataProvider(multiChannelConfig, {
                cloneDir: '/tmp/test',
                slackBotToken: 'xoxb-test',
            });
            const multiMock = (SlackApiClient as ReturnType<typeof vi.fn>).mock.results[
                (SlackApiClient as ReturnType<typeof vi.fn>).mock.results.length - 1
            ].value;

            multiMock.fetchChannelHistory
                .mockRejectedValueOnce(new Error('channel_not_found'))
                .mockResolvedValueOnce([
                    { ts: '2000.0001', thread_ts: '2000.0001', reply_count: 3, user: 'U001' },
                ]);
            multiMock.fetchThreadReplies.mockResolvedValue([
                { ts: '2000.0001', user: 'U001', text: 'Q' },
                { ts: '2000.0002', user: 'U002', text: 'A' },
            ]);
            multiMock.fetchUserInfo.mockResolvedValue({ id: 'U001', displayName: 'User' });
            multiMock.getChannelPermalink.mockResolvedValue('https://slack.com/link');
            (distillThread as ReturnType<typeof vi.fn>).mockResolvedValue({
                pairs: [{ question: 'Q', answer: 'A', confidence: 0.9 }],
            });

            const result = await multiProvider.fullAcquire();
            expect(result.items).toHaveLength(1);
        });
    });

    describe('incrementalAcquire', () => {
        it('passes oldest parameter for incremental fetch', async () => {
            mockApiClient.fetchChannelHistory.mockResolvedValue([]);

            await provider.incrementalAcquire('1500.0000');
            expect(mockApiClient.fetchChannelHistory).toHaveBeenCalledWith('C001', '1500.0000');
        });

        it('returns stateToken >= lastStateToken', async () => {
            mockApiClient.fetchChannelHistory.mockResolvedValue([]);

            const result = await provider.incrementalAcquire('1500.0000');
            expect(result.stateToken).toBe('1500.0000');
        });
    });

    describe('getCurrentStateToken', () => {
        it('returns max timestamp from channels', async () => {
            mockApiClient.fetchChannelHistory.mockResolvedValue([
                { ts: '2000.0001' },
            ]);

            const token = await provider.getCurrentStateToken();
            expect(token).toBe('2000.0001');
        });

        it('returns null when no messages found', async () => {
            mockApiClient.fetchChannelHistory.mockResolvedValue([]);

            const token = await provider.getCurrentStateToken();
            expect(token).toBeNull();
        });
    });

    describe('constructor', () => {
        it('throws for non-slack config', () => {
            expect(() => new SlackDataProvider(
                { name: 'test', type: 'markdown', path: 'docs/', file_patterns: ['**/*.md'], chunk: {} } as unknown as SlackSourceConfig,
                { cloneDir: '/tmp/test' },
            )).toThrow('SlackDataProvider requires a slack source config');
        });
    });
});
