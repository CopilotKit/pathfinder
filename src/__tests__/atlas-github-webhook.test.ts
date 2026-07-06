import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import {
  createWebhookHandler,
  type ReindexOrchestrator,
} from "../webhooks/github.js";

const mockGetConfig = vi.fn();
const mockGetServerConfig = vi.fn();
const mockRecordWebhookDelivery = vi.fn().mockResolvedValue(undefined);
const mockUpsertAtlasSeedCandidate = vi.fn().mockResolvedValue({
  id: 1,
  canonicalKey: "github-pr:atlas:org/repo:42",
  status: "pending",
});

vi.mock("../config.js", () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
  getServerConfig: (...args: unknown[]) => mockGetServerConfig(...args),
}));

vi.mock("../db/queries.js", () => ({
  recordWebhookDelivery: (...args: unknown[]) =>
    mockRecordWebhookDelivery(...args),
}));

vi.mock("../db/atlas.js", () => ({
  upsertAtlasSeedCandidate: (...args: unknown[]) =>
    mockUpsertAtlasSeedCandidate(...args),
}));

const WEBHOOK_SECRET = "test-webhook-secret-123";

function sign(body: Buffer, secret: string = WEBHOOK_SECRET): string {
  return (
    "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex")
  );
}

function mockReqRes(
  body: object | string,
  headers: Record<string, string | string[]> = {},
) {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  const rawBody = Buffer.from(bodyStr);

  const req = {
    body: rawBody,
    headers: {
      "x-hub-signature-256": sign(rawBody),
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-1",
      ...headers,
    },
  } as any;

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as any;

  return { req, res };
}

function makePullRequestPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "closed",
    repository: {
      clone_url: "https://github.com/org/repo.git",
      default_branch: "main",
      full_name: "org/repo",
    },
    pull_request: {
      number: 42,
      merged: true,
      merge_commit_sha: "abc12345deadbeef",
      title: "Explain runtime architecture",
      body: "The runtime now routes requests through the agent bridge.",
      html_url: "https://github.com/org/repo/pull/42",
      base: { ref: "main" },
      head: { ref: "feature/runtime-architecture" },
      user: { login: "octocat" },
      merged_by: { login: "maintainer" },
    },
    ...overrides,
  };
}

function makeServerConfig() {
  return {
    sources: [
      {
        name: "atlas",
        type: "atlas",
        chunk: {},
      },
      {
        name: "docs-source",
        type: "markdown",
        path: "docs",
        file_patterns: ["**/*.md"],
        chunk: {},
      },
    ],
    webhook: {
      repo_sources: {
        "org/repo": ["atlas", "docs-source"],
      },
      path_triggers: {},
    },
  };
}

describe("GitHub webhook Atlas seed extraction", () => {
  let orchestrator: ReindexOrchestrator;
  let handler: ReturnType<typeof createWebhookHandler>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConfig.mockReturnValue({
      githubWebhookSecret: WEBHOOK_SECRET,
    });
    mockGetServerConfig.mockReturnValue(makeServerConfig());
    orchestrator = {
      queueIncrementalReindex: vi.fn(),
      queueSourceReindex: vi.fn(),
    };
    handler = createWebhookHandler(orchestrator);
  });

  it("creates a pending Atlas seed candidate for a merged pull request into the default branch", async () => {
    const { req, res } = mockReqRes(makePullRequestPayload());

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      queued: true,
      atlas_seed_candidates: 1,
    });
    expect(mockUpsertAtlasSeedCandidate).toHaveBeenCalledWith({
      canonicalKey: "github-pr:atlas:org/repo:42",
      sourceName: "atlas",
      repoUrl: "https://github.com/org/repo.git",
      ref: "main",
      subsystem: null,
      title: "PR #42: Explain runtime architecture",
      content: expect.stringContaining("Explain runtime architecture"),
      provenance: expect.objectContaining({
        provider: "github",
        event: "pull_request",
        delivery_id: "delivery-1",
        repo: "org/repo",
        pr_number: 42,
        url: "https://github.com/org/repo/pull/42",
        base_branch: "main",
        head_branch: "feature/runtime-architecture",
        merge_commit_sha: "abc12345deadbeef",
      }),
      evidence: [
        expect.objectContaining({
          type: "pull_request",
          url: "https://github.com/org/repo/pull/42",
        }),
      ],
    });
    expect(orchestrator.queueIncrementalReindex).not.toHaveBeenCalled();
  });

  // BYTE-IDENTITY GATE (A.3): the webhook seed `content` is the ONE surface
  // shared with the batch adapter (buildGitHubSeedContent). A.3 lifts the
  // WHAT-metadata header off the BATCH content but MUST leave the webhook bytes
  // untouched — the header, blank-line spacing, label order, and raw body must
  // reproduce exactly. This locks the exact bytes so any drift in the shared
  // helper (e.g. the batch-only lift accidentally reshaping the webhook path)
  // fails loud here.
  it("emits BYTE-IDENTICAL seed content for the webhook (WHAT-header + raw body)", async () => {
    const { req, res } = mockReqRes(makePullRequestPayload());

    await handler(req, res);

    const EXPECTED_CONTENT = [
      "# PR #42: Explain runtime architecture",
      "",
      "Repository: org/repo",
      "Base branch: main",
      "Head branch: feature/runtime-architecture",
      "Merge commit: abc12345deadbeef",
      "Author: octocat",
      "Merged by: maintainer",
      "URL: https://github.com/org/repo/pull/42",
      "",
      "The runtime now routes requests through the agent bridge.",
    ].join("\n");

    expect(mockUpsertAtlasSeedCandidate).toHaveBeenCalledTimes(1);
    const arg = mockUpsertAtlasSeedCandidate.mock.calls[0][0] as {
      content: string;
    };
    expect(arg.content).toBe(EXPECTED_CONTENT);
  });

  it("ignores merged pull requests for repos without an Atlas source", async () => {
    mockGetServerConfig.mockReturnValue({
      ...makeServerConfig(),
      webhook: {
        repo_sources: { "org/repo": ["docs-source"] },
        path_triggers: {},
      },
    });
    const { req, res } = mockReqRes(makePullRequestPayload());

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ignored: true,
        reason: "repo has no atlas sources",
      }),
    );
    expect(mockUpsertAtlasSeedCandidate).not.toHaveBeenCalled();
  });

  it("rejects pull request seed extraction when the signature is invalid", async () => {
    const { req, res } = mockReqRes(makePullRequestPayload(), {
      "x-hub-signature-256":
        "sha256=0000000000000000000000000000000000000000000000000000000000000000",
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockUpsertAtlasSeedCandidate).not.toHaveBeenCalled();
  });

  it("rejects duplicate delivery headers before extracting pull request seeds", async () => {
    const { req, res } = mockReqRes(makePullRequestPayload(), {
      "x-github-delivery": ["delivery-1", "delivery-2"],
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Duplicate GitHub webhook header",
      }),
    );
    expect(mockUpsertAtlasSeedCandidate).not.toHaveBeenCalled();
  });

  it("rejects runtime duplicate delivery headers before extracting pull request seeds", async () => {
    const { req, res } = mockReqRes(makePullRequestPayload(), {
      "x-github-delivery": "delivery-1, delivery-2",
    });
    req.rawHeaders = [
      "X-Hub-Signature-256",
      req.headers["x-hub-signature-256"],
      "X-GitHub-Event",
      "pull_request",
      "X-GitHub-Delivery",
      "delivery-1",
      "x-github-delivery",
      "delivery-2",
    ];

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Duplicate GitHub webhook header",
        header: "x-github-delivery",
      }),
    );
    expect(mockUpsertAtlasSeedCandidate).not.toHaveBeenCalled();
  });

  it("ignores merged pull requests whose base branch is not the default branch", async () => {
    const { req, res } = mockReqRes(
      makePullRequestPayload({
        pull_request: {
          ...makePullRequestPayload().pull_request,
          base: { ref: "release" },
        },
      }),
    );

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ignored: true,
        reason: "not the default branch",
      }),
    );
    expect(mockUpsertAtlasSeedCandidate).not.toHaveBeenCalled();
  });

  it("uses a stable canonical key so duplicate pull request deliveries are idempotent", async () => {
    const payload = makePullRequestPayload();
    const first = mockReqRes(payload, { "x-github-delivery": "delivery-1" });
    const second = mockReqRes(payload, { "x-github-delivery": "delivery-2" });

    await handler(first.req, first.res);
    await handler(second.req, second.res);

    expect(mockUpsertAtlasSeedCandidate).toHaveBeenCalledTimes(2);
    expect(
      mockUpsertAtlasSeedCandidate.mock.calls.map(([input]) => input),
    ).toEqual([
      expect.objectContaining({ canonicalKey: "github-pr:atlas:org/repo:42" }),
      expect.objectContaining({ canonicalKey: "github-pr:atlas:org/repo:42" }),
    ]);
  });

  it("uses source-scoped canonical keys for multiple Atlas sources on the same pull request", async () => {
    mockGetServerConfig.mockReturnValue({
      ...makeServerConfig(),
      sources: [
        { name: "atlas-runtime", type: "atlas", chunk: {} },
        { name: "atlas-ui", type: "atlas", chunk: {} },
      ],
      webhook: {
        repo_sources: {
          "org/repo": ["atlas-runtime", "atlas-ui"],
        },
        path_triggers: {},
      },
    });
    const { req, res } = mockReqRes(makePullRequestPayload());

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      queued: true,
      atlas_seed_candidates: 2,
    });
    expect(
      mockUpsertAtlasSeedCandidate.mock.calls.map(([input]) => input),
    ).toEqual([
      expect.objectContaining({
        canonicalKey: "github-pr:atlas-runtime:org/repo:42",
        sourceName: "atlas-runtime",
      }),
      expect.objectContaining({
        canonicalKey: "github-pr:atlas-ui:org/repo:42",
        sourceName: "atlas-ui",
      }),
    ]);
  });

  it("fails loudly for malformed configured Atlas pull request payloads", async () => {
    const { req, res } = mockReqRes({
      action: "closed",
      repository: {
        clone_url: "https://github.com/org/repo.git",
        default_branch: "main",
        full_name: "org/repo",
      },
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Malformed Atlas pull_request payload",
      }),
    );
    expect(mockUpsertAtlasSeedCandidate).not.toHaveBeenCalled();
  });
});
