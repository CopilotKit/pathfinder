// SlackDataProvider — Slack thread acquisition via Web API + LLM distillation.
// Implements DataProvider: fetches threads from configured channels, distills
// them into Q&A pairs, and returns ContentItems for the indexing pipeline.

import { SlackApiClient, type SlackMessage } from './slack-api.js';
import { distillThread, type ThreadMessage } from '../distiller.js';
import { getConfig } from '../../config.js';
import type { SourceConfig, SlackSourceConfig } from '../../types.js';
import type { DataProvider, AcquisitionResult, ContentItem, ProviderOptions } from './types.js';

export class SlackDataProvider implements DataProvider {
    private config: SlackSourceConfig;
    private apiClient: SlackApiClient;
    private logPrefix: string;

    constructor(config: SourceConfig, options: ProviderOptions) {
        if (config.type !== 'slack') {
            throw new Error('SlackDataProvider requires a slack source config');
        }
        this.config = config;
        this.apiClient = new SlackApiClient({
            token: options.slackBotToken ?? '',
        });
        this.logPrefix = `[slack-provider:${config.name}]`;
    }

    async fullAcquire(): Promise<AcquisitionResult> {
        console.log(`${this.logPrefix} Starting full acquire for ${this.config.channels.length} channel(s)`);
        const allItems: ContentItem[] = [];
        let maxTimestamp = '0';

        for (const channelId of this.config.channels) {
            try {
                const { items, latestTs } = await this.processChannel(channelId);
                allItems.push(...items);
                if (latestTs > maxTimestamp) maxTimestamp = latestTs;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`${this.logPrefix} Failed to process channel ${channelId}: ${msg}`);
            }
        }

        console.log(`${this.logPrefix} Full acquire complete: ${allItems.length} Q&A pairs from ${this.config.channels.length} channel(s)`);

        return {
            items: allItems,
            removedIds: [],
            stateToken: maxTimestamp,
        };
    }

    async incrementalAcquire(lastStateToken: string): Promise<AcquisitionResult> {
        console.log(`${this.logPrefix} Starting incremental acquire since ${lastStateToken}`);
        const allItems: ContentItem[] = [];
        let maxTimestamp = lastStateToken;

        for (const channelId of this.config.channels) {
            try {
                const { items, latestTs } = await this.processChannel(channelId, lastStateToken);
                allItems.push(...items);
                if (latestTs > maxTimestamp) maxTimestamp = latestTs;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`${this.logPrefix} Failed to process channel ${channelId}: ${msg}`);
            }
        }

        console.log(`${this.logPrefix} Incremental acquire complete: ${allItems.length} Q&A pairs`);

        return {
            items: allItems,
            removedIds: [], // Slack API doesn't surface deletions; caught on next full acquire
            stateToken: maxTimestamp,
        };
    }

    async getCurrentStateToken(): Promise<string | null> {
        let maxTimestamp = '0';

        for (const channelId of this.config.channels) {
            try {
                const messages = await this.apiClient.fetchChannelHistory(channelId);
                if (messages.length > 0) {
                    // Messages are returned newest-first by Slack
                    const latest = messages[0].ts;
                    if (latest > maxTimestamp) maxTimestamp = latest;
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.warn(`${this.logPrefix} Failed to check channel ${channelId}: ${msg}`);
            }
        }

        return maxTimestamp === '0' ? null : maxTimestamp;
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    /**
     * Process a single channel: fetch threads, distill, return items.
     */
    private async processChannel(
        channelId: string,
        oldest?: string,
    ): Promise<{ items: ContentItem[]; latestTs: string }> {
        const messages = await this.apiClient.fetchChannelHistory(channelId, oldest);
        const items: ContentItem[] = [];
        let latestTs = oldest ?? '0';

        // Filter to threaded messages with sufficient replies
        const threads = messages.filter(
            m => m.thread_ts === m.ts && (m.reply_count ?? 0) >= this.config.min_thread_replies,
        );

        console.log(`${this.logPrefix} Channel ${channelId}: ${messages.length} messages, ${threads.length} qualifying threads`);

        // Process threads sequentially to avoid OpenAI rate limits
        for (const thread of threads) {
            try {
                const threadItems = await this.processThread(channelId, thread);
                items.push(...threadItems);

                if (thread.ts > latestTs) latestTs = thread.ts;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`${this.logPrefix} Failed to distill thread ${thread.ts}: ${msg}`);
            }
        }

        return { items, latestTs };
    }

    /**
     * Process a single thread: fetch replies, resolve users, distill, create items.
     */
    private async processThread(
        channelId: string,
        parentMessage: SlackMessage,
    ): Promise<ContentItem[]> {
        const replies = await this.apiClient.fetchThreadReplies(channelId, parentMessage.ts);

        // Resolve user display names
        const threadMessages: ThreadMessage[] = [];
        for (const reply of replies) {
            let author = reply.user ?? 'unknown';
            try {
                if (reply.user) {
                    const user = await this.apiClient.fetchUserInfo(reply.user);
                    author = user.displayName;
                }
            } catch {
                // Fall back to user ID
            }

            threadMessages.push({
                author,
                content: reply.text ?? '',
                timestamp: reply.ts,
                reactions: reply.reactions,
            });
        }

        // Distill the thread
        const cfg = getConfig();
        const distillerResult = await distillThread(threadMessages, {
            model: this.config.distiller_model,
            apiKey: cfg.openaiApiKey,
        });

        // Filter by confidence threshold and create ContentItems
        const items: ContentItem[] = [];
        let permalink: string | undefined;

        for (let i = 0; i < distillerResult.pairs.length; i++) {
            const pair = distillerResult.pairs[i];

            if (pair.confidence < this.config.confidence_threshold) {
                continue;
            }

            // Lazy-fetch permalink (only if we have qualifying pairs)
            if (!permalink) {
                try {
                    permalink = await this.apiClient.getChannelPermalink(channelId, parentMessage.ts);
                } catch {
                    permalink = undefined;
                }
            }

            const participants = [...new Set(threadMessages.map(m => m.author))];

            items.push({
                id: `${channelId}:${parentMessage.ts}:${i}`,
                content: `Q: ${pair.question}\n\nA: ${pair.answer}`,
                title: pair.question,
                sourceUrl: permalink,
                metadata: {
                    channel: channelId,
                    participants,
                    confidence: pair.confidence,
                    emojiTriggered: false,
                },
            });
        }

        return items;
    }
}
