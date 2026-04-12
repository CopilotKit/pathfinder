import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import {
  createWebhookHandler,
  type ReindexOrchestrator,
} from "../webhooks/github.js";

// Mock config
const mockGetConfig = vi.fn();
const mockGetServerConfig = vi.fn();

vi.mock("../config.js", () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
  getServerConfig: (...args: unknown[]) => mockGetServerConfig(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = "test-webhook-secret-123";

function sign(body: Buffer, secret: string = WEBHOOK_SECRET): string {
  return (
    "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex")
  );
}

function makePushPayload(overrides: Record<string, unknown> = {}) {
  return {
    ref: "refs/heads/main",
    after: "abc12345deadbeef",
    before: "0000000000000000",
    repository: {
      clone_url: "https://github.com/org/repo.git",
      default_branch: "main",
      full_name: "org/repo",
    },
    commits: [
      {
        added: ["docs/guide.md"],
        modified: ["docs/index.md"],
        removed: [],
      },
    ],
    ...overrides,
  };
}

function mockReqRes(
  body: object | string,
  headers: Record<string, string> = {},
  asBuffer = true,
) {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  const rawBody = asBuffer ? Buffer.from(bodyStr) : bodyStr;
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(bodyStr);

  const req = {
    body: asBuffer ? buf : bodyStr,
    headers: {
      "x-hub-signature-256": sign(buf),
      "x-github-event": "push",
      ...headers,
    },
  } as any;

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as any;

  return { req, res };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GitHub webhook handler", () => {
  let orchestrator: ReindexOrchestrator;
  let handler: ReturnType<typeof createWebhookHandler>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockGetConfig.mockReturnValue({
      githubWebhookSecret: WEBHOOK_SECRET,
    });

    mockGetServerConfig.mockReturnValue({
      webhook: {
        repo_sources: {
          "org/repo": ["docs-source"],
        },
        path_triggers: {
          "docs-source": ["docs/"],
        },
      },
    });

    orchestrator = { queueIncrementalReindex: vi.fn() };
    handler = createWebhookHandler(orchestrator);
  });

  // -- Signature verification -------------------------------------------

  describe("signature verification", () => {
    it("rejects when req.body is not a Buffer", async () => {
      const { req, res } = mockReqRes(makePushPayload(), {}, false);
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("raw body") }),
      );
    });

    it("rejects when webhook secret is not configured", async () => {
      mockGetConfig.mockReturnValue({ githubWebhookSecret: "" });
      const { req, res } = mockReqRes(makePushPayload());
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it("rejects when webhook secret is undefined", async () => {
      mockGetConfig.mockReturnValue({ githubWebhookSecret: undefined });
      const { req, res } = mockReqRes(makePushPayload());
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it("rejects when webhook secret is whitespace-only", async () => {
      mockGetConfig.mockReturnValue({ githubWebhookSecret: "   " });
      const { req, res } = mockReqRes(makePushPayload());
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it("rejects when x-hub-signature-256 header is missing", async () => {
      const payload = makePushPayload();
      const buf = Buffer.from(JSON.stringify(payload));
      const req = {
        body: buf,
        headers: { "x-github-event": "push" },
      } as any;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as any;

      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("rejects when signature is invalid", async () => {
      const payload = makePushPayload();
      const { req, res } = mockReqRes(payload, {
        "x-hub-signature-256":
          "sha256=0000000000000000000000000000000000000000000000000000000000000000",
      });
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("rejects when signature has wrong length", async () => {
      const payload = makePushPayload();
      const { req, res } = mockReqRes(payload, {
        "x-hub-signature-256": "sha256=tooshort",
      });
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("accepts a valid signature", async () => {
      const { req, res } = mockReqRes(makePushPayload());
      await handler(req, res);
      // Should not be 401 or 403
      expect(res.status).not.toHaveBeenCalledWith(401);
      expect(res.status).not.toHaveBeenCalledWith(403);
    });
  });

  // -- Event routing ----------------------------------------------------

  describe("event routing", () => {
    it("ignores non-push events (e.g. ping)", async () => {
      const { req, res } = mockReqRes(makePushPayload(), {
        "x-github-event": "ping",
      });
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ ignored: true, reason: "not a push event" }),
      );
      expect(orchestrator.queueIncrementalReindex).not.toHaveBeenCalled();
    });

    it("ignores issues events", async () => {
      const { req, res } = mockReqRes(makePushPayload(), {
        "x-github-event": "issues",
      });
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ ignored: true }),
      );
    });
  });

  // -- Payload parsing --------------------------------------------------

  describe("payload parsing", () => {
    it("rejects malformed JSON", async () => {
      const badBody = Buffer.from("not json at all");
      const req = {
        body: badBody,
        headers: {
          "x-hub-signature-256": sign(badBody),
          "x-github-event": "push",
        },
      } as any;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as any;

      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: "Malformed JSON payload" }),
      );
    });
  });

  // -- Branch filtering -------------------------------------------------

  describe("branch filtering", () => {
    it("ignores pushes to non-default branches", async () => {
      const payload = makePushPayload({ ref: "refs/heads/feature/my-branch" });
      const { req, res } = mockReqRes(payload);
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          ignored: true,
          reason: "not the default branch",
        }),
      );
      expect(orchestrator.queueIncrementalReindex).not.toHaveBeenCalled();
    });

    it("processes pushes to the default branch", async () => {
      const { req, res } = mockReqRes(makePushPayload());
      await handler(req, res);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ queued: true }),
      );
    });
  });

  // -- Repo-to-source mapping -------------------------------------------

  describe("repo → source mapping", () => {
    it("ignores repos not in webhook config", async () => {
      const payload = makePushPayload({
        repository: {
          clone_url: "https://github.com/other/repo.git",
          default_branch: "main",
          full_name: "other/repo",
        },
      });
      const { req, res } = mockReqRes(payload);
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          ignored: true,
          reason: "repo not in webhook config",
        }),
      );
      expect(orchestrator.queueIncrementalReindex).not.toHaveBeenCalled();
    });

    it("works when webhook config has no repo_sources", async () => {
      mockGetServerConfig.mockReturnValue({ webhook: {} });
      const { req, res } = mockReqRes(makePushPayload());
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          ignored: true,
          reason: "repo not in webhook config",
        }),
      );
    });

    it("works when webhook config is undefined", async () => {
      mockGetServerConfig.mockReturnValue({});
      const { req, res } = mockReqRes(makePushPayload());
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          ignored: true,
          reason: "repo not in webhook config",
        }),
      );
    });
  });

  // -- Path-based filtering (path_triggers) -----------------------------

  describe("path_triggers filtering", () => {
    it("queues reindex when committed files match path triggers", async () => {
      const { req, res } = mockReqRes(makePushPayload());
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ queued: true });
      expect(orchestrator.queueIncrementalReindex).toHaveBeenCalledWith(
        "https://github.com/org/repo.git",
      );
    });

    it("ignores push when no committed files match path triggers", async () => {
      const payload = makePushPayload({
        commits: [
          {
            added: ["src/index.ts"],
            modified: ["src/main.ts"],
            removed: [],
          },
        ],
      });
      const { req, res } = mockReqRes(payload);
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          ignored: true,
          reason: "no path triggers matched",
        }),
      );
      expect(orchestrator.queueIncrementalReindex).not.toHaveBeenCalled();
    });

    it("queues reindex when source has no path triggers (match all)", async () => {
      mockGetServerConfig.mockReturnValue({
        webhook: {
          repo_sources: { "org/repo": ["all-source"] },
          path_triggers: {},
        },
      });
      const payload = makePushPayload({
        commits: [
          { added: ["any/random/file.txt"], modified: [], removed: [] },
        ],
      });
      const { req, res } = mockReqRes(payload);
      await handler(req, res);
      expect(res.json).toHaveBeenCalledWith({ queued: true });
      expect(orchestrator.queueIncrementalReindex).toHaveBeenCalled();
    });

    it("matches removed files against path triggers", async () => {
      const payload = makePushPayload({
        commits: [{ added: [], modified: [], removed: ["docs/old-page.md"] }],
      });
      const { req, res } = mockReqRes(payload);
      await handler(req, res);
      expect(res.json).toHaveBeenCalledWith({ queued: true });
    });

    it("checks multiple commits for path matches", async () => {
      const payload = makePushPayload({
        commits: [
          { added: ["src/index.ts"], modified: [], removed: [] },
          { added: [], modified: ["docs/guide.md"], removed: [] },
        ],
      });
      const { req, res } = mockReqRes(payload);
      await handler(req, res);
      expect(res.json).toHaveBeenCalledWith({ queued: true });
    });

    it("handles multiple sources for same repo, only one matching", async () => {
      mockGetServerConfig.mockReturnValue({
        webhook: {
          repo_sources: { "org/repo": ["src-source", "docs-source"] },
          path_triggers: {
            "src-source": ["src/"],
            "docs-source": ["docs/"],
          },
        },
      });
      const payload = makePushPayload({
        commits: [{ added: ["docs/new.md"], modified: [], removed: [] }],
      });
      const { req, res } = mockReqRes(payload);
      await handler(req, res);
      expect(res.json).toHaveBeenCalledWith({ queued: true });
      // Should only call once even though there are two sources
      expect(orchestrator.queueIncrementalReindex).toHaveBeenCalledTimes(1);
    });
  });

  // -- Happy path end-to-end --------------------------------------------

  describe("happy path", () => {
    it("queues reindex and returns 200 for valid push", async () => {
      const { req, res } = mockReqRes(makePushPayload());
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ queued: true });
      expect(orchestrator.queueIncrementalReindex).toHaveBeenCalledWith(
        "https://github.com/org/repo.git",
      );
    });
  });
});
