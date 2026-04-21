import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "node:http";

// Mock DB queries — getFaqChunks drives the per-source fetch that the handler
// iterates. By making one call throw we simulate a single source failure.
const mockGetFaqChunks = vi.fn();

vi.mock("../db/queries.js", () => ({
  getFaqChunks: (...args: unknown[]) => mockGetFaqChunks(...args),
  // Unused by the FAQ endpoint but imported by server.ts — stub to silence.
  getIndexStats: vi.fn(),
  getAllChunksForLlms: vi.fn(),
  insertCollectedData: vi.fn(),
}));

// Mock config so getServerConfig returns a stable set of FAQ sources.
const mockGetServerConfig = vi.fn();

vi.mock("../config.js", () => ({
  getServerConfig: (...args: unknown[]) => mockGetServerConfig(...args),
  getConfig: vi.fn().mockReturnValue({
    port: 3001,
    databaseUrl: "pglite:///tmp/test",
    openaiApiKey: "",
    githubToken: "",
    githubWebhookSecret: "",
    nodeEnv: "test",
    logLevel: "info",
    cloneDir: "/tmp/test",
    slackBotToken: "",
    slackSigningSecret: "",
    discordBotToken: "",
    discordPublicKey: "",
    notionToken: "",
    mcpJwtSecret: "x".repeat(32),
  }),
  getAnalyticsConfig: vi.fn().mockReturnValue(undefined),
  hasSearchTools: vi.fn().mockReturnValue(false),
  hasKnowledgeTools: vi.fn().mockReturnValue(false),
  hasCollectTools: vi.fn().mockReturnValue(false),
  hasBashSemanticSearch: vi.fn().mockReturnValue(false),
}));

import {
  registerFaqRoute,
  __resetFaqCacheForTesting,
} from "../server.js";

function buildTestApp(): express.Express {
  const app = express();
  registerFaqRoute(app);
  return app;
}

function request(
  server: http.Server,
  method: string,
  path: string,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      { hostname: "127.0.0.1", port: addr.port, path, method },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode!, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("GET /faq.txt — partial-failure handling", () => {
  let server: http.Server;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetFaqCacheForTesting();
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockGetServerConfig.mockReturnValue({
      server: { name: "Test FAQ Server" },
      sources: [
        {
          name: "faq-good",
          type: "slack",
          category: "faq",
          confidence_threshold: 0.7,
        },
        {
          name: "faq-broken",
          type: "slack",
          category: "faq",
          confidence_threshold: 0.8,
        },
      ],
      tools: [],
    });
  });

  afterEach(async () => {
    consoleSpy.mockRestore();
    __resetFaqCacheForTesting();
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function startApp(): Promise<void> {
    await new Promise<void>((resolve) => {
      const app = buildTestApp();
      server = app.listen(0, () => resolve());
    });
  }

  it("does not cache the partial response when a source fetch fails, and retries on the next request", async () => {
    // faq-good returns chunks; faq-broken throws. Both calls should go
    // through on the SECOND request because we refused to cache.
    mockGetFaqChunks.mockImplementation(
      async (sourceNames: string[]) => {
        if (sourceNames.includes("faq-broken")) {
          throw new Error("upstream timeout");
        }
        return [
          {
            source_name: "faq-good",
            source_url: null,
            title: "How do I X?",
            content: "Q: How do I X?\n\nA: You X.",
            chunk_index: 0,
          },
        ];
      },
    );

    await startApp();

    const res1 = await request(server, "GET", "/faq.txt");
    expect(res1.status).toBe(200);
    // Good source content is served
    expect(res1.body).toContain("faq-good");
    expect(res1.body).toContain("Q: How do I X?");
    // Failure signalled via header
    expect(res1.headers["x-partial-sources"]).toBe("faq-broken");
    expect(res1.headers["cache-control"]).toBe("no-store");

    // The partial-ness MUST NOT be cached: a second request re-fetches,
    // so getFaqChunks is called again for every source.
    const callsAfterFirst = mockGetFaqChunks.mock.calls.length;
    expect(callsAfterFirst).toBe(2); // faq-good + faq-broken

    const res2 = await request(server, "GET", "/faq.txt");
    expect(res2.status).toBe(200);
    // Still partial on retry (broken source still broken).
    expect(res2.headers["x-partial-sources"]).toBe("faq-broken");
    expect(res2.headers["cache-control"]).toBe("no-store");

    // The critical assertion: the second request hit the fetch path again
    // for every source. If the partial result had been cached, total calls
    // would still be 2.
    expect(mockGetFaqChunks.mock.calls.length).toBe(callsAfterFirst + 2);
  });

  it("caches normally when all sources succeed", async () => {
    mockGetFaqChunks.mockResolvedValue([
      {
        source_name: "faq-good",
        source_url: null,
        title: "Hello",
        content: "Q: Hello?\n\nA: Hi.",
        chunk_index: 0,
      },
    ]);

    await startApp();

    const res1 = await request(server, "GET", "/faq.txt");
    expect(res1.status).toBe(200);
    expect(res1.headers["x-partial-sources"]).toBeUndefined();
    // Default cache-control behaviour (not no-store).
    expect(res1.headers["cache-control"]).not.toBe("no-store");

    const callsAfterFirst = mockGetFaqChunks.mock.calls.length;
    expect(callsAfterFirst).toBe(2); // one call per source

    // Second request should be served from cache — no new fetches.
    const res2 = await request(server, "GET", "/faq.txt");
    expect(res2.status).toBe(200);
    expect(mockGetFaqChunks.mock.calls.length).toBe(callsAfterFirst);
  });

  it("lists every failing source name in X-Partial-Sources when more than one fails", async () => {
    mockGetServerConfig.mockReturnValue({
      server: { name: "Test FAQ Server" },
      sources: [
        {
          name: "faq-ok",
          type: "slack",
          category: "faq",
          confidence_threshold: 0.7,
        },
        {
          name: "faq-broken-a",
          type: "slack",
          category: "faq",
          confidence_threshold: 0.7,
        },
        {
          name: "faq-broken-b",
          type: "slack",
          category: "faq",
          confidence_threshold: 0.7,
        },
      ],
      tools: [],
    });

    mockGetFaqChunks.mockImplementation(
      async (sourceNames: string[]) => {
        if (sourceNames[0].startsWith("faq-broken")) {
          throw new Error("boom");
        }
        return [];
      },
    );

    await startApp();

    const res = await request(server, "GET", "/faq.txt");
    expect(res.status).toBe(200);
    const header = res.headers["x-partial-sources"];
    expect(typeof header).toBe("string");
    // Order follows config order; both failed sources must be present.
    expect(header).toBe("faq-broken-a,faq-broken-b");
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});
