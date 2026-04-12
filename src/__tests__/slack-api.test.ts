import { describe, it, expect, vi, beforeEach } from "vitest";
import { SlackApiClient } from "../indexing/providers/slack-api.js";

// Mock the @slack/web-api module
vi.mock("@slack/web-api", () => {
  const mockConversations = {
    history: vi.fn(),
    replies: vi.fn(),
  };
  const mockUsers = {
    info: vi.fn(),
  };
  const mockChat = {
    getPermalink: vi.fn(),
  };
  const mockTeam = {
    info: vi.fn(),
  };

  class MockWebClient {
    conversations = mockConversations;
    users = mockUsers;
    chat = mockChat;
    team = mockTeam;
    constructor(_token: string, _options?: any) {}
  }

  return {
    WebClient: MockWebClient,
  };
});

describe("SlackApiClient", () => {
  let client: SlackApiClient;
  let mockWebClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new SlackApiClient({ token: "xoxb-test-token" });
    mockWebClient = client.webClient;
  });

  describe("fetchChannelHistory", () => {
    it("fetches messages from a channel", async () => {
      mockWebClient.conversations.history.mockResolvedValueOnce({
        ok: true,
        messages: [
          { ts: "1234.5678", user: "U001", text: "Hello" },
          {
            ts: "1234.5679",
            user: "U002",
            text: "World",
            thread_ts: "1234.5678",
            reply_count: 3,
          },
        ],
        response_metadata: {},
      });

      const messages = await client.fetchChannelHistory("C001");
      expect(messages).toHaveLength(2);
      expect(messages[0].text).toBe("Hello");
      expect(mockWebClient.conversations.history).toHaveBeenCalledWith({
        channel: "C001",
        oldest: undefined,
        cursor: undefined,
        limit: 200,
      });
    });

    it("paginates through multiple pages", async () => {
      mockWebClient.conversations.history
        .mockResolvedValueOnce({
          ok: true,
          messages: [{ ts: "1", user: "U001", text: "Page 1" }],
          response_metadata: { next_cursor: "cursor1" },
        })
        .mockResolvedValueOnce({
          ok: true,
          messages: [{ ts: "2", user: "U002", text: "Page 2" }],
          response_metadata: {},
        });

      const messages = await client.fetchChannelHistory("C001");
      expect(messages).toHaveLength(2);
      expect(mockWebClient.conversations.history).toHaveBeenCalledTimes(2);
    });

    it("passes oldest parameter for incremental fetch", async () => {
      mockWebClient.conversations.history.mockResolvedValueOnce({
        ok: true,
        messages: [],
        response_metadata: {},
      });

      await client.fetchChannelHistory("C001", "1234.0000");
      expect(mockWebClient.conversations.history).toHaveBeenCalledWith(
        expect.objectContaining({ oldest: "1234.0000" }),
      );
    });
  });

  describe("fetchThreadReplies", () => {
    it("fetches replies for a thread", async () => {
      mockWebClient.conversations.replies.mockResolvedValueOnce({
        ok: true,
        messages: [
          { ts: "1234.5678", user: "U001", text: "Original" },
          { ts: "1234.5679", user: "U002", text: "Reply 1" },
          { ts: "1234.5680", user: "U001", text: "Reply 2" },
        ],
        response_metadata: {},
      });

      const messages = await client.fetchThreadReplies("C001", "1234.5678");
      expect(messages).toHaveLength(3);
    });
  });

  describe("fetchUserInfo", () => {
    it("fetches user display name", async () => {
      mockWebClient.users.info.mockResolvedValueOnce({
        ok: true,
        user: {
          id: "U001",
          team_id: "T001",
          profile: { display_name: "Alice", real_name: "Alice Smith" },
        },
      });
      mockWebClient.team.info.mockResolvedValueOnce({
        ok: true,
        team: { name: "Acme Corp" },
      });

      const user = await client.fetchUserInfo("U001");
      expect(user.displayName).toBe("Alice (Acme Corp)");
      expect(user.id).toBe("U001");
    });

    it("caches user info on subsequent calls", async () => {
      mockWebClient.users.info.mockResolvedValueOnce({
        ok: true,
        user: {
          id: "U001",
          profile: { display_name: "Bob" },
        },
      });
      mockWebClient.team.info.mockResolvedValueOnce({
        ok: true,
        team: { name: "Team" },
      });

      await client.fetchUserInfo("U001");
      await client.fetchUserInfo("U001");
      expect(mockWebClient.users.info).toHaveBeenCalledTimes(1);
    });

    it("falls back to real_name when display_name is empty", async () => {
      mockWebClient.users.info.mockResolvedValueOnce({
        ok: true,
        user: {
          id: "U001",
          profile: { display_name: "", real_name: "Charlie" },
        },
      });

      const user = await client.fetchUserInfo("U001");
      expect(user.displayName).toContain("Charlie");
    });

    it("falls back to user ID when no name available", async () => {
      mockWebClient.users.info.mockResolvedValueOnce({
        ok: true,
        user: {
          id: "U001",
          profile: { display_name: "", real_name: "" },
        },
      });

      const user = await client.fetchUserInfo("U001");
      expect(user.displayName).toContain("U001");
    });
  });

  describe("getChannelPermalink", () => {
    it("returns permalink URL", async () => {
      mockWebClient.chat.getPermalink.mockResolvedValueOnce({
        ok: true,
        permalink: "https://workspace.slack.com/archives/C001/p1234567890",
      });

      const url = await client.getChannelPermalink("C001", "1234.5678");
      expect(url).toBe("https://workspace.slack.com/archives/C001/p1234567890");
    });
  });

  describe("rate limit handling", () => {
    it("retries on rate limit with backoff", async () => {
      const rateLimitError = new Error("Rate limited");
      (rateLimitError as any).code = "slack_webapi_rate_limited_error";
      (rateLimitError as any).data = { retryAfter: 0.01 }; // 10ms for test speed

      mockWebClient.conversations.history
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({
          ok: true,
          messages: [{ ts: "1", text: "Success" }],
          response_metadata: {},
        });

      const messages = await client.fetchChannelHistory("C001");
      expect(messages).toHaveLength(1);
      expect(mockWebClient.conversations.history).toHaveBeenCalledTimes(2);
    });

    it("throws after max retries exceeded", async () => {
      const rateLimitError = new Error("Rate limited");
      (rateLimitError as any).code = "slack_webapi_rate_limited_error";
      (rateLimitError as any).data = { retryAfter: 0.001 };

      // Create client with maxRetries=2
      const limitedClient = new SlackApiClient({
        token: "xoxb-test",
        maxRetries: 2,
      });
      const mock = limitedClient.webClient as any;
      mock.conversations = {
        history: vi.fn().mockRejectedValue(rateLimitError),
      };

      await expect(limitedClient.fetchChannelHistory("C001")).rejects.toThrow();
    });
  });
});
