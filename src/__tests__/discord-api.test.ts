import { describe, it, expect, vi, beforeEach } from "vitest";
import { DiscordApiClient } from "../indexing/providers/discord-api.js";

// Mock @discordjs/rest
const mockGet = vi.fn();

vi.mock("@discordjs/rest", () => {
  class MockREST {
    get = mockGet;
    setToken(_token: string) {
      return this;
    }
    constructor(_options?: any) {}
  }
  return { REST: MockREST };
});

// Mock discord-api-types
vi.mock("discord-api-types/v10", () => ({
  Routes: {
    channelMessages: (channelId: string) => `/channels/${channelId}/messages`,
    guildActiveThreads: (guildId: string) =>
      `/guilds/${guildId}/threads/active`,
    channelThreads: (channelId: string, archivedType: string) =>
      `/channels/${channelId}/threads/archived/${archivedType}`,
    user: (userId: string) => `/users/${userId}`,
    channel: (channelId: string) => `/channels/${channelId}`,
  },
}));

describe("DiscordApiClient", () => {
  let client: DiscordApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new DiscordApiClient({ token: "test-bot-token" });
  });

  describe("fetchChannelMessages", () => {
    it("fetches messages from a text channel", async () => {
      mockGet.mockResolvedValueOnce([
        {
          id: "1001",
          author: { id: "U1", username: "alice", global_name: "Alice" },
          content: "Hello",
          timestamp: "2024-01-01T00:00:00Z",
        },
        {
          id: "1002",
          author: { id: "U2", username: "bob" },
          content: "World",
          timestamp: "2024-01-01T00:01:00Z",
        },
      ]);

      const messages = await client.fetchChannelMessages("C001");
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe("Hello");
      expect(messages[1].author.username).toBe("bob");
    });

    it("paginates using after parameter", async () => {
      mockGet
        .mockResolvedValueOnce([
          {
            id: "1001",
            author: { id: "U1", username: "a" },
            content: "P1",
            timestamp: "2024-01-01T00:00:00Z",
          },
          {
            id: "1002",
            author: { id: "U1", username: "a" },
            content: "P1b",
            timestamp: "2024-01-01T00:00:01Z",
          },
        ])
        .mockResolvedValueOnce([
          {
            id: "1003",
            author: { id: "U1", username: "a" },
            content: "P2",
            timestamp: "2024-01-01T00:00:02Z",
          },
        ])
        .mockResolvedValueOnce([]);

      // Set page size to 2 to force pagination
      const messages = await client.fetchChannelMessages("C001", undefined, 2);
      expect(messages).toHaveLength(3);
    });

    it("respects after parameter for incremental fetch", async () => {
      mockGet.mockResolvedValueOnce([]);

      await client.fetchChannelMessages("C001", "999");
      expect(mockGet).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          query: expect.any(URLSearchParams),
        }),
      );
      const callQuery = mockGet.mock.calls[0][1].query as URLSearchParams;
      expect(callQuery.get("after")).toBe("999");
    });

    it("stops at MAX_PAGES safety bound", async () => {
      // Return full pages forever to test the safety bound
      const fullPage = Array.from({ length: 100 }, (_, i) => ({
        id: String(i),
        author: { id: "U1", username: "a" },
        content: "msg",
        timestamp: "2024-01-01T00:00:00Z",
      }));
      mockGet.mockResolvedValue(fullPage);

      const messages = await client.fetchChannelMessages("C001");
      // Should stop at MAX_PAGES (100), not run forever
      expect(mockGet.mock.calls.length).toBeLessThanOrEqual(100);
    });
  });

  describe("fetchForumThreads", () => {
    it("combines active and archived threads, deduplicates", async () => {
      // Active threads (guild-level, filtered by parent_id)
      mockGet.mockResolvedValueOnce({
        threads: [
          {
            id: "T1",
            name: "Thread 1",
            parent_id: "C001",
            message_count: 5,
            owner_id: "U1",
            created_timestamp: "2024-01-01",
            last_message_id: "2001",
            archived: false,
          },
          {
            id: "T2",
            name: "Thread 2",
            parent_id: "C999",
            message_count: 3,
            owner_id: "U1",
            created_timestamp: "2024-01-01",
            last_message_id: "2002",
            archived: false,
          },
        ],
      });
      // Public archived
      mockGet.mockResolvedValueOnce({
        threads: [
          {
            id: "T3",
            name: "Thread 3",
            parent_id: "C001",
            message_count: 4,
            owner_id: "U2",
            created_timestamp: "2024-01-01",
            last_message_id: "2003",
            archived: true,
          },
        ],
        has_more: false,
      });
      // Private archived
      mockGet.mockResolvedValueOnce({
        threads: [
          {
            id: "T1",
            name: "Thread 1 dup",
            parent_id: "C001",
            message_count: 5,
            owner_id: "U1",
            created_timestamp: "2024-01-01",
            last_message_id: "2001",
            archived: true,
          },
        ],
        has_more: false,
      });

      const threads = await client.fetchForumThreads("C001", "G001");
      // T2 excluded (wrong parent_id), T1 deduped
      expect(threads).toHaveLength(2);
      expect(threads.map((t) => t.id).sort()).toEqual(["T1", "T3"]);
    });

    it("paginates archived threads when has_more is true", async () => {
      // Active threads (empty)
      mockGet.mockResolvedValueOnce({ threads: [] });
      // Public archived — page 1 with has_more
      mockGet.mockResolvedValueOnce({
        threads: [
          {
            id: "T1",
            name: "Thread 1",
            parent_id: "C001",
            message_count: 5,
            owner_id: "U1",
            created_timestamp: "2024-01-01",
            last_message_id: "2001",
            archived: true,
          },
        ],
        has_more: true,
      });
      // Public archived — page 2
      mockGet.mockResolvedValueOnce({
        threads: [
          {
            id: "T2",
            name: "Thread 2",
            parent_id: "C001",
            message_count: 3,
            owner_id: "U2",
            created_timestamp: "2024-01-02",
            last_message_id: "2002",
            archived: true,
          },
        ],
        has_more: false,
      });
      // Private archived (empty)
      mockGet.mockResolvedValueOnce({ threads: [], has_more: false });

      const threads = await client.fetchForumThreads("C001", "G001");
      expect(threads).toHaveLength(2);
      expect(threads.map((t) => t.id).sort()).toEqual(["T1", "T2"]);
      // Verify 4 API calls: active + 2 public archived pages + 1 private archived
      expect(mockGet).toHaveBeenCalledTimes(4);
    });
  });

  describe("fetchThreadMessages", () => {
    it("returns messages in a thread", async () => {
      mockGet.mockResolvedValueOnce([
        {
          id: "3001",
          author: { id: "U1", username: "alice" },
          content: "OP",
          timestamp: "2024-01-01T00:00:00Z",
        },
        {
          id: "3002",
          author: { id: "U2", username: "bob" },
          content: "Reply",
          timestamp: "2024-01-01T00:01:00Z",
        },
      ]);

      const messages = await client.fetchThreadMessages("T001");
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe("OP");
    });
  });

  describe("fetchUser", () => {
    it("fetches user with display name", async () => {
      mockGet.mockResolvedValueOnce({
        id: "U1",
        username: "alice",
        global_name: "Alice Smith",
      });

      const user = await client.fetchUser("U1");
      expect(user.displayName).toBe("Alice Smith");
    });

    it("falls back to username when global_name is absent", async () => {
      mockGet.mockResolvedValueOnce({
        id: "U1",
        username: "alice",
      });

      const user = await client.fetchUser("U1");
      expect(user.displayName).toBe("alice");
    });

    it("caches user results", async () => {
      mockGet.mockResolvedValueOnce({
        id: "U1",
        username: "alice",
        global_name: "Alice",
      });

      await client.fetchUser("U1");
      await client.fetchUser("U1");
      // Only one API call — second was cached
      expect(mockGet).toHaveBeenCalledTimes(1);
    });
  });

  describe("getMessageUrl", () => {
    it("generates correct Discord message URL", () => {
      const url = client.getMessageUrl("G001", "C001", "M001");
      expect(url).toBe("https://discord.com/channels/G001/C001/M001");
    });
  });

  describe("rate limit handling", () => {
    it("retries on 429 with retry_after", async () => {
      const rateLimitError: any = new Error("Rate limited");
      rateLimitError.status = 429;
      rateLimitError.retryAfter = 10; // 10ms — will be clamped to 1000ms minimum

      mockGet.mockRejectedValueOnce(rateLimitError).mockResolvedValueOnce([
        {
          id: "1001",
          author: { id: "U1", username: "a" },
          content: "OK",
          timestamp: "2024-01-01T00:00:00Z",
        },
      ]);

      const messages = await client.fetchChannelMessages("C001");
      expect(messages).toHaveLength(1);
      expect(mockGet).toHaveBeenCalledTimes(2);
    });

    it("throws after max retries exceeded", async () => {
      const rateLimitError: any = new Error("Rate limited");
      rateLimitError.status = 429;
      rateLimitError.retryAfter = 1; // 1ms — will be clamped to 1000ms minimum

      const limitedClient = new DiscordApiClient({
        token: "test",
        maxRetries: 2,
      });
      mockGet.mockRejectedValue(rateLimitError);

      await expect(
        limitedClient.fetchChannelMessages("C001"),
      ).rejects.toThrow();
    });
  });
});
