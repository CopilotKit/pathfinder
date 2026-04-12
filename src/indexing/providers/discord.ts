// DiscordDataProvider — Discord thread acquisition via REST API + LLM distillation (text)
// and direct Q&A extraction (forum). Implements DataProvider.

import OpenAI from "openai";
import {
  DiscordApiClient,
  type DiscordMessage,
  type DiscordThread,
} from "./discord-api.js";
import { distillThread, type ThreadMessage } from "../distiller.js";
import { getConfig } from "../../config.js";
import type {
  SourceConfig,
  DiscordSourceConfig,
  DiscordChannelConfig,
} from "../../types.js";
import type {
  DataProvider,
  AcquisitionResult,
  ContentItem,
  ProviderOptions,
} from "./types.js";

const MAX_ANSWER_CHARS = 8000;

export class DiscordDataProvider implements DataProvider {
  private config: DiscordSourceConfig;
  private apiClient: DiscordApiClient;
  private openaiClient: OpenAI | null = null;
  private logPrefix: string;

  constructor(config: SourceConfig, options: ProviderOptions) {
    if (config.type !== "discord") {
      throw new Error("DiscordDataProvider requires a discord source config");
    }
    this.config = config;
    const token = options.discordBotToken;
    if (!token) {
      throw new Error(
        "DiscordDataProvider requires a discordBotToken in provider options",
      );
    }
    this.apiClient = new DiscordApiClient({ token });

    // Only create OpenAI client if text channels are configured
    const hasTextChannels = this.config.channels.some((c) => c.type === "text");
    if (hasTextChannels) {
      this.openaiClient = new OpenAI({ apiKey: getConfig().openaiApiKey });
    }

    this.logPrefix = `[discord-provider:${config.name}]`;
  }

  async fullAcquire(): Promise<AcquisitionResult> {
    console.log(
      `${this.logPrefix} Starting full acquire for ${this.config.channels.length} channel(s)`,
    );
    const allItems: ContentItem[] = [];
    let maxSnowflake = "0";
    let failedChannels = 0;

    for (const channel of this.config.channels) {
      try {
        const { items, latestId } =
          channel.type === "text"
            ? await this.processTextChannel(channel.id)
            : await this.processForumChannel(channel.id);

        allItems.push(...items);
        if (BigInt(latestId) > BigInt(maxSnowflake)) maxSnowflake = latestId;
      } catch (err) {
        failedChannels++;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `${this.logPrefix} Failed to process channel ${channel.id}: ${msg}`,
        );
      }
    }

    if (failedChannels === this.config.channels.length) {
      throw new Error(`All ${failedChannels} channel(s) failed during acquire`);
    }

    console.log(
      `${this.logPrefix} Full acquire complete: ${allItems.length} Q&A pairs from ${this.config.channels.length} channel(s)`,
    );

    return {
      items: allItems,
      removedIds: [],
      stateToken: maxSnowflake,
    };
  }

  async incrementalAcquire(lastStateToken: string): Promise<AcquisitionResult> {
    console.log(
      `${this.logPrefix} Starting incremental acquire since ${lastStateToken}`,
    );
    const allItems: ContentItem[] = [];
    let maxSnowflake = lastStateToken;
    let failedChannels = 0;

    for (const channel of this.config.channels) {
      try {
        const { items, latestId } =
          channel.type === "text"
            ? await this.processTextChannel(channel.id, lastStateToken)
            : await this.processForumChannel(channel.id, lastStateToken);

        allItems.push(...items);
        if (BigInt(latestId) > BigInt(maxSnowflake)) maxSnowflake = latestId;
      } catch (err) {
        failedChannels++;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `${this.logPrefix} Failed to process channel ${channel.id}: ${msg}`,
        );
      }
    }

    if (failedChannels === this.config.channels.length) {
      throw new Error(`All ${failedChannels} channel(s) failed during acquire`);
    }

    console.log(
      `${this.logPrefix} Incremental acquire complete: ${allItems.length} Q&A pairs`,
    );

    return {
      items: allItems,
      removedIds: [],
      stateToken: maxSnowflake,
    };
  }

  async getCurrentStateToken(): Promise<string | null> {
    let maxSnowflake = "0";

    for (const channel of this.config.channels) {
      try {
        if (channel.type === "text") {
          const messages = await this.apiClient.fetchChannelMessages(
            channel.id,
            undefined,
            1,
          );
          if (messages.length > 0) {
            const latest = messages[0].id;
            if (BigInt(latest) > BigInt(maxSnowflake)) maxSnowflake = latest;
          }
        } else {
          const threads = await this.apiClient.fetchForumThreads(
            channel.id,
            this.config.guild_id,
          );
          for (const thread of threads) {
            if (BigInt(thread.last_message_id) > BigInt(maxSnowflake)) {
              maxSnowflake = thread.last_message_id;
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `${this.logPrefix} Failed to check channel ${channel.id}: ${msg}`,
        );
      }
    }

    return maxSnowflake === "0" ? null : maxSnowflake;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Process a text channel: fetch messages with threads, distill via LLM.
   */
  private async processTextChannel(
    channelId: string,
    after?: string,
  ): Promise<{ items: ContentItem[]; latestId: string }> {
    const messages = await this.apiClient.fetchChannelMessages(
      channelId,
      after,
    );
    const items: ContentItem[] = [];
    let latestId = after ?? "0";

    // Filter to messages with threads having >= min_thread_replies
    const threads = messages.filter(
      (m) =>
        m.thread && m.thread.message_count >= this.config.min_thread_replies,
    );

    console.log(
      `${this.logPrefix} Channel ${channelId}: ${messages.length} messages, ${threads.length} qualifying threads`,
    );

    for (const message of threads) {
      try {
        const threadItems = await this.processTextThread(channelId, message);
        items.push(...threadItems);

        if (BigInt(message.id) > BigInt(latestId)) latestId = message.id;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `${this.logPrefix} Failed to distill thread ${message.id}: ${msg}`,
        );
      }
    }

    return { items, latestId };
  }

  /**
   * Process a single text channel thread: fetch replies, resolve users, distill.
   */
  private async processTextThread(
    channelId: string,
    parentMessage: DiscordMessage,
  ): Promise<ContentItem[]> {
    const threadId = parentMessage.thread!.id;
    const replies = await this.apiClient.fetchThreadMessages(threadId);

    // Resolve user display names
    const threadMessages: ThreadMessage[] = [];
    for (const reply of replies) {
      let author = reply.author.global_name ?? reply.author.username;
      try {
        const user = await this.apiClient.fetchUser(reply.author.id);
        author = user.displayName;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `${this.logPrefix} Failed to resolve user ${reply.author.id}: ${msg}`,
        );
      }

      threadMessages.push({
        author,
        content: reply.content,
        timestamp: reply.timestamp,
        reactions: reply.reactions?.map((r) => ({
          name: r.emoji.name,
          count: r.count,
        })),
      });
    }

    // Distill the thread
    const distillerResult = await distillThread(threadMessages, {
      model: this.config.distiller_model,
      client: this.openaiClient!,
    });

    const items: ContentItem[] = [];
    const sourceUrl = this.apiClient.getMessageUrl(
      this.config.guild_id,
      channelId,
      parentMessage.id,
    );
    const participants = [...new Set(threadMessages.map((m) => m.author))];

    for (let i = 0; i < distillerResult.pairs.length; i++) {
      const pair = distillerResult.pairs[i];

      items.push({
        id: `${channelId}:${parentMessage.id}:${i}`,
        content: `Q: ${pair.question}\n\nA: ${pair.answer}`,
        title: pair.question,
        sourceUrl,
        metadata: {
          channel: channelId,
          participants,
          confidence: pair.confidence,
        },
      });
    }

    return items;
  }

  /**
   * Process a forum channel: fetch threads, extract Q&A directly.
   */
  private async processForumChannel(
    channelId: string,
    afterToken?: string,
  ): Promise<{ items: ContentItem[]; latestId: string }> {
    const allThreads = await this.apiClient.fetchForumThreads(
      channelId,
      this.config.guild_id,
    );
    let latestId = afterToken ?? "0";
    const items: ContentItem[] = [];

    // Filter by min_thread_replies
    let threads = allThreads.filter(
      (t) => t.message_count >= this.config.min_thread_replies,
    );

    // For incremental, filter threads with new activity
    if (afterToken) {
      threads = threads.filter(
        (t) => BigInt(t.last_message_id) > BigInt(afterToken),
      );
    }

    console.log(
      `${this.logPrefix} Forum ${channelId}: ${allThreads.length} total threads, ${threads.length} qualifying`,
    );

    for (const thread of threads) {
      try {
        const messages = await this.apiClient.fetchThreadMessages(thread.id);
        const answer = synthesizeForumAnswer(messages, thread.name);

        if (!answer) {
          console.log(
            `${this.logPrefix} Skipping forum thread ${thread.id} — empty synthesized answer`,
          );
          continue;
        }

        const truncatedAnswer = truncateAnswer(answer);
        const sourceUrl = this.apiClient.getMessageUrl(
          this.config.guild_id,
          thread.id,
          messages[0]?.id ?? thread.id,
        );

        items.push({
          id: `${channelId}:${thread.id}`,
          content: `Q: ${thread.name}\n\nA: ${truncatedAnswer}`,
          title: thread.name,
          sourceUrl,
          metadata: {
            channel: channelId,
            confidence: 1.0,
            forumThread: true,
          },
        });

        if (BigInt(thread.last_message_id) > BigInt(latestId)) {
          latestId = thread.last_message_id;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `${this.logPrefix} Failed to process forum thread ${thread.id}: ${msg}`,
        );
      }
    }

    return { items, latestId };
  }
}

/**
 * Synthesize an answer from forum thread reply messages.
 */
function synthesizeForumAnswer(
  messages: DiscordMessage[],
  threadName: string,
): string {
  if (messages.length === 0) return "";

  const firstContent = messages[0]?.content.trim() ?? "";
  const titleLower = threadName.trim().toLowerCase();

  let processedMessages = messages;

  // If the first message starts with or matches the title, strip the title portion
  // but keep any additional content the OP may have added
  if (firstContent.toLowerCase().startsWith(titleLower)) {
    const remainder = firstContent.slice(threadName.trim().length).trim();
    if (!remainder) {
      // First message was just the title restated — skip it
      processedMessages = messages.slice(1);
    }
    // If there's a remainder, keep the full message (OP added context beyond the title)
  } else if (
    titleLower.startsWith(firstContent.toLowerCase()) &&
    firstContent.length > 0
  ) {
    // First message is a truncated version of the title — skip it
    processedMessages = messages.slice(1);
  }

  // Filter out messages with empty/whitespace-only content
  const withContent = processedMessages.filter(
    (m) => m.content.trim().length > 0,
  );
  if (withContent.length === 0) return "";

  return withContent
    .map((m) => `${m.author.global_name ?? m.author.username}: ${m.content}`)
    .join("\n\n");
}

/**
 * Truncate an answer if it exceeds MAX_ANSWER_CHARS.
 */
function truncateAnswer(answer: string): string {
  if (answer.length <= MAX_ANSWER_CHARS) return answer;
  const truncated = answer.slice(0, MAX_ANSWER_CHARS);
  const lastBreak = truncated.lastIndexOf("\n\n");
  return (
    (lastBreak > 0 ? truncated.slice(0, lastBreak) : truncated) +
    "\n\n[truncated]"
  );
}
