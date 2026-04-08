// Slack Web API client wrapper — handles pagination, rate limiting, user caching.

import { WebClient, type WebAPICallResult } from '@slack/web-api';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SlackMessage {
    ts: string;
    user?: string;
    text?: string;
    thread_ts?: string;
    reply_count?: number;
    reactions?: Array<{ name: string; count: number }>;
    team?: string;
}

export interface SlackUser {
    id: string;
    displayName: string;
    teamId?: string;
}

export interface SlackApiClientOptions {
    token: string;
    /** Max retries on rate-limited requests (default: 5) */
    maxRetries?: number;
}

// ── Rate limit helpers ───────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Client ───────────────────────────────────────────────────────────────────

export class SlackApiClient {
    private client: WebClient;
    private maxRetries: number;
    private userCache = new Map<string, SlackUser>();
    private teamNameCache = new Map<string, string>();
    private logPrefix = '[slack-api]';

    constructor(options: SlackApiClientOptions) {
        this.client = new WebClient(options.token, {
            // Disable built-in retry so we handle it ourselves
            retryConfig: { retries: 0 },
        });
        this.maxRetries = options.maxRetries ?? 5;
    }

    /**
     * Fetch channel message history, paginated. Returns all top-level messages.
     * If `oldest` is provided, only messages after that timestamp are returned.
     */
    async fetchChannelHistory(channelId: string, oldest?: string): Promise<SlackMessage[]> {
        const messages: SlackMessage[] = [];
        let cursor: string | undefined;

        do {
            const result = await this.callWithRetry(() =>
                this.client.conversations.history({
                    channel: channelId,
                    oldest,
                    cursor,
                    limit: 200,
                }),
            );

            const rawMessages = (result as any).messages as SlackMessage[] | undefined;
            if (rawMessages) {
                messages.push(...rawMessages);
            }

            cursor = (result as any).response_metadata?.next_cursor;
        } while (cursor);

        return messages;
    }

    /**
     * Fetch all replies in a thread, paginated.
     */
    async fetchThreadReplies(channelId: string, threadTs: string): Promise<SlackMessage[]> {
        const messages: SlackMessage[] = [];
        let cursor: string | undefined;

        do {
            const result = await this.callWithRetry(() =>
                this.client.conversations.replies({
                    channel: channelId,
                    ts: threadTs,
                    cursor,
                    limit: 200,
                }),
            );

            const rawMessages = (result as any).messages as SlackMessage[] | undefined;
            if (rawMessages) {
                messages.push(...rawMessages);
            }

            cursor = (result as any).response_metadata?.next_cursor;
        } while (cursor);

        return messages;
    }

    /**
     * Fetch user info with caching. Returns display name with workspace suffix
     * for external users in Slack Connect channels.
     */
    async fetchUserInfo(userId: string): Promise<SlackUser> {
        const cached = this.userCache.get(userId);
        if (cached) return cached;

        const result = await this.callWithRetry(() =>
            this.client.users.info({ user: userId }),
        );

        const user = (result as any).user;
        const profile = user?.profile;
        const displayName = profile?.display_name || profile?.real_name || userId;
        const teamId = user?.team_id;

        let fullName = displayName;
        if (teamId) {
            const teamName = await this.resolveTeamName(teamId);
            if (teamName) {
                fullName = `${displayName} (${teamName})`;
            }
        }

        const slackUser: SlackUser = {
            id: userId,
            displayName: fullName,
            teamId,
        };

        this.userCache.set(userId, slackUser);
        return slackUser;
    }

    /**
     * Get a permalink URL for a specific message.
     */
    async getChannelPermalink(channelId: string, messageTs: string): Promise<string> {
        const result = await this.callWithRetry(() =>
            this.client.chat.getPermalink({
                channel: channelId,
                message_ts: messageTs,
            }),
        );

        return (result as any).permalink as string;
    }

    /**
     * Resolve a team ID to a team name (for Slack Connect workspace suffix).
     * Caches results. Returns null if lookup fails (e.g., no permission).
     */
    private async resolveTeamName(teamId: string): Promise<string | null> {
        const cached = this.teamNameCache.get(teamId);
        if (cached !== undefined) return cached || null;

        try {
            const result = await this.callWithRetry(() =>
                this.client.team.info({ team: teamId }),
            );
            const name = (result as any).team?.name ?? null;
            this.teamNameCache.set(teamId, name ?? '');
            return name;
        } catch {
            this.teamNameCache.set(teamId, '');
            return null;
        }
    }

    /**
     * Call a Slack API method with retry on rate limit (429) responses.
     * Respects Retry-After header with exponential backoff fallback.
     */
    private async callWithRetry<T extends WebAPICallResult>(
        fn: () => Promise<T>,
        attempt: number = 1,
    ): Promise<T> {
        try {
            return await fn();
        } catch (error: unknown) {
            const isRateLimited = (error as any)?.code === 'slack_webapi_rate_limited_error'
                || (error as any)?.data?.error === 'ratelimited';

            if (!isRateLimited || attempt > this.maxRetries) {
                throw error;
            }

            const retryAfter = (error as any)?.data?.retryAfter
                ?? (error as any)?.retryAfter
                ?? Math.pow(2, attempt);
            const delayMs = retryAfter * 1000;

            console.warn(
                `${this.logPrefix} Rate limited (attempt ${attempt}/${this.maxRetries}), ` +
                `retrying in ${retryAfter}s`,
            );

            await sleep(delayMs);
            return this.callWithRetry(fn, attempt + 1);
        }
    }

    /** Expose the underlying WebClient for testing/advanced usage. */
    get webClient(): WebClient {
        return this.client;
    }
}
