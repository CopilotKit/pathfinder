// Discord REST API client wrapper — handles pagination, rate limiting, user caching.
// Uses @discordjs/rest (REST-only, no gateway/WebSocket).

import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DiscordMessage {
  id: string;
  author: { id: string; username: string; global_name?: string };
  content: string;
  timestamp: string;
  thread?: { id: string; message_count: number };
  reactions?: Array<{ emoji: { name: string }; count: number }>;
}

export interface DiscordThread {
  id: string;
  name: string;
  parent_id: string;
  message_count: number;
  owner_id: string;
  created_timestamp: string;
  last_message_id: string;
  archived: boolean;
}

export interface DiscordUser {
  id: string;
  displayName: string;
}

export interface DiscordApiClientOptions {
  token: string;
  /** Max retries on rate-limited requests (default: 5) */
  maxRetries?: number;
}

// ── Rate limit helpers ───────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Client ───────────────────────────────────────────────────────────────────

const MAX_PAGES = 100;
const DEFAULT_PAGE_LIMIT = 100;

export class DiscordApiClient {
  private rest: REST;
  private maxRetries: number;
  private userCache = new Map<string, DiscordUser>();
  private logPrefix = "[discord-api]";

  constructor(options: DiscordApiClientOptions) {
    this.rest = new REST({ version: "10", rejectOnRateLimit: ["/"] }).setToken(
      options.token,
    );
    this.maxRetries = options.maxRetries ?? 5;
  }

  /**
   * Fetch messages from a text channel, paginated using `after` parameter.
   * If `after` is provided, only messages after that snowflake ID are returned.
   */
  async fetchChannelMessages(
    channelId: string,
    after?: string,
    limit?: number,
  ): Promise<DiscordMessage[]> {
    const messages: DiscordMessage[] = [];
    let lastId = after;
    const pageLimit = limit ?? DEFAULT_PAGE_LIMIT;
    let pages = 0;

    do {
      pages++;
      const query = new URLSearchParams({ limit: String(pageLimit) });
      if (lastId) query.set("after", lastId);

      const result = await this.callWithRetry(
        () =>
          this.rest.get(Routes.channelMessages(channelId), {
            query,
          }) as Promise<DiscordMessage[]>,
      );

      if (!result || result.length === 0) break;

      messages.push(...result);
      lastId = result[result.length - 1].id;

      // If we got fewer than the page limit, there are no more pages
      if (result.length < pageLimit) break;

      if (pages >= MAX_PAGES) {
        console.warn(
          `${this.logPrefix} fetchChannelMessages hit max pages (${MAX_PAGES}) for channel ${channelId}`,
        );
        break;
      }
    } while (true);

    return messages;
  }

  /**
   * Fetch all threads in a forum channel (active + archived).
   * Active threads: GET /guilds/{guildId}/threads/active, filtered by parent_id.
   * Archived threads: paginated via before parameter.
   */
  async fetchForumThreads(
    channelId: string,
    guildId: string,
  ): Promise<DiscordThread[]> {
    const threadMap = new Map<string, DiscordThread>();

    // 1. Active threads (guild-level, filter by parent_id)
    try {
      const activeResult = await this.callWithRetry(
        () =>
          this.rest.get(Routes.guildActiveThreads(guildId)) as Promise<{
            threads: DiscordThread[];
          }>,
      );
      for (const thread of activeResult.threads ?? []) {
        if (thread.parent_id === channelId) {
          threadMap.set(thread.id, thread);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `${this.logPrefix} Failed to fetch active threads for guild ${guildId}: ${msg}`,
      );
    }

    // 2. Public archived threads
    await this.fetchArchivedThreads(channelId, "public", threadMap);

    // 3. Private archived threads
    await this.fetchArchivedThreads(channelId, "private", threadMap);

    return [...threadMap.values()];
  }

  /**
   * Fetch messages within a thread.
   */
  async fetchThreadMessages(
    threadId: string,
    limit?: number,
  ): Promise<DiscordMessage[]> {
    return this.fetchChannelMessages(threadId, undefined, limit);
  }

  /**
   * Fetch user info with caching.
   */
  async fetchUser(userId: string): Promise<DiscordUser> {
    const cached = this.userCache.get(userId);
    if (cached) return cached;

    const result = await this.callWithRetry(
      () =>
        this.rest.get(Routes.user(userId)) as Promise<{
          id: string;
          username: string;
          global_name?: string;
        }>,
    );

    const user: DiscordUser = {
      id: result.id,
      displayName: result.global_name ?? result.username,
    };

    this.userCache.set(userId, user);
    return user;
  }

  /**
   * Get a message URL (deterministic, no API call).
   */
  getMessageUrl(guildId: string, channelId: string, messageId: string): string {
    return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Fetch archived threads (public or private) with pagination.
   */
  private async fetchArchivedThreads(
    channelId: string,
    type: "public" | "private",
    threadMap: Map<string, DiscordThread>,
  ): Promise<void> {
    let before: string | undefined;
    let pages = 0;

    do {
      pages++;
      const query = new URLSearchParams();
      if (before) query.set("before", before);

      try {
        const result = await this.callWithRetry(
          () =>
            this.rest.get(`/channels/${channelId}/threads/archived/${type}`, {
              query,
            }) as Promise<{ threads: DiscordThread[]; has_more: boolean }>,
        );

        for (const thread of result.threads ?? []) {
          if (!threadMap.has(thread.id)) {
            threadMap.set(thread.id, thread);
          }
        }

        if (!result.has_more || !result.threads?.length) break;

        // Use the last thread's ID as the before cursor
        before = result.threads[result.threads.length - 1].id;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `${this.logPrefix} Failed to fetch ${type} archived threads for channel ${channelId}: ${msg}`,
        );
        break;
      }

      if (pages >= MAX_PAGES) {
        console.warn(
          `${this.logPrefix} fetchArchivedThreads hit max pages (${MAX_PAGES})`,
        );
        break;
      }
    } while (true);
  }

  /**
   * Call a Discord API method with retry on rate limit (429) responses.
   * Respects retry_after with exponential backoff fallback.
   */
  private async callWithRetry<T>(
    fn: () => Promise<T>,
    attempt: number = 1,
  ): Promise<T> {
    try {
      return await fn();
    } catch (error: unknown) {
      const status = (error as any)?.status ?? (error as any)?.statusCode;
      const isRateLimited = status === 429;

      if (!isRateLimited || attempt > this.maxRetries) {
        throw error;
      }

      const retryAfter =
        (error as any)?.retryAfter ?? (error as any)?.retry_after;
      // retryAfter from @discordjs/rest is in ms; fallback to exponential backoff in ms
      const delayMs =
        retryAfter != null
          ? Math.max(retryAfter, 1000)
          : Math.max(Math.pow(2, attempt) * 1000, 1000);

      console.warn(
        `${this.logPrefix} Rate limited (attempt ${attempt}/${this.maxRetries}), ` +
          `retrying in ${delayMs}ms`,
      );

      await sleep(delayMs);
      return this.callWithRetry(fn, attempt + 1);
    }
  }
}
