import { describe, it, expect, vi } from "vitest";
import { IndexingPipeline } from "../indexing/pipeline.js";
import type { ContentItem } from "../indexing/providers/types.js";
import type { SourceConfig } from "../types.js";

// Mock the dependencies. The inner chunker is a vi.fn (hoisted so the vi.mock
// factory can close over it) so tests can assert the full argument list — the
// real ChunkerFn and call site pass a 4th arg, item.absolutePath, in addition
// to content/filePath/config.
const { mockChunkerFn } = vi.hoisted(() => ({
  mockChunkerFn: vi.fn(
    (
      content: string,
      _filePath: string,
      _config: unknown,
      _absolutePath?: string,
    ) => [
      {
        content,
        title: "Test Title",
        chunkIndex: 0,
      },
    ],
  ),
}));
vi.mock("../indexing/chunking/index.js", () => ({
  getChunker: vi.fn().mockReturnValue(mockChunkerFn),
}));

vi.mock("../indexing/embeddings.js", () => {
  const MockEmbeddingClient = vi.fn().mockImplementation(function (
    this: Record<string, unknown>,
  ) {
    this.embedBatch = vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]);
  });
  return { EmbeddingClient: MockEmbeddingClient };
});

vi.mock("../db/queries.js", () => ({
  replaceChunksForFile: vi.fn().mockResolvedValue(undefined),
  deleteChunksByFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../indexing/url-derivation.js", () => ({
  deriveUrl: () => "https://example.com/test",
}));

const { replaceChunksForFile, deleteChunksByFile } =
  await import("../db/queries.js");
const { EmbeddingClient } = await import("../indexing/embeddings.js");

const testConfig: SourceConfig = {
  name: "test-source",
  type: "markdown",
  path: "docs/",
  file_patterns: ["**/*.md"],
  chunk: { target_tokens: 600, overlap_tokens: 50 },
};

describe("IndexingPipeline", () => {
  it("indexes items: chunk → embed → delete old → upsert", async () => {
    const embeddingClient = new EmbeddingClient("key", "model", 1536);
    const pipeline = new IndexingPipeline(embeddingClient, testConfig);

    mockChunkerFn.mockClear();
    const items: ContentItem[] = [
      {
        id: "docs/test.md",
        absolutePath: "/abs/clone/docs/test.md",
        content: "# Hello\nSome content here",
      },
    ];

    await pipeline.indexItems(items, "abc123");

    // The chunker receives item.absolutePath as its 4th argument (some chunkers
    // need the on-disk path, e.g. for language/extension-aware splitting).
    expect(mockChunkerFn).toHaveBeenCalledWith(
      "# Hello\nSome content here",
      "docs/test.md",
      testConfig,
      "/abs/clone/docs/test.md",
    );

    // The delete+upsert is now a SINGLE atomic call so a failed upsert cannot
    // leave the file's chunks deleted-but-not-replaced (data loss).
    expect(replaceChunksForFile).toHaveBeenCalledWith(
      "test-source",
      "docs/test.md",
      expect.arrayContaining([
        expect.objectContaining({
          source_name: "test-source",
          file_path: "docs/test.md",
          commit_sha: "abc123",
        }),
      ]),
    );
  });

  it("clears stale chunks for items that now produce zero chunks", async () => {
    // A file that previously indexed N chunks but now yields zero (and is
    // routed through `items`, not `removedIds`) must have its stale chunks
    // cleared — NOT left in the index forever. The zero-chunk path calls
    // replaceChunksForFile(name, id, []) (the delete-only transaction) instead
    // of early-returning. Embedding is skipped (no chunks to embed).
    const { getChunker } = await import("../indexing/chunking/index.js");
    vi.mocked(getChunker).mockReturnValueOnce(() => []);

    const embeddingClient = new EmbeddingClient("key", "model", 1536);
    const pipeline = new IndexingPipeline(embeddingClient, testConfig);

    vi.mocked(replaceChunksForFile).mockClear();
    vi.mocked(embeddingClient.embedBatch).mockClear();
    await pipeline.indexItems([{ id: "empty.md", content: "" }], "abc");

    // Delete-only call with an EMPTY chunk array clears any prior chunks.
    expect(replaceChunksForFile).toHaveBeenCalledWith(
      "test-source",
      "empty.md",
      [],
    );
    // No embedding round-trip when there are no chunks to embed.
    expect(embeddingClient.embedBatch).not.toHaveBeenCalled();
  });

  it("removes items by ID", async () => {
    const embeddingClient = new EmbeddingClient("key", "model", 1536);
    const pipeline = new IndexingPipeline(embeddingClient, testConfig);

    vi.mocked(deleteChunksByFile).mockReset();
    vi.mocked(deleteChunksByFile).mockResolvedValue(undefined);
    await pipeline.removeItems(["docs/old.md", "docs/deleted.md"]);

    expect(deleteChunksByFile).toHaveBeenCalledTimes(2);
    expect(deleteChunksByFile).toHaveBeenCalledWith(
      "test-source",
      "docs/old.md",
    );
    expect(deleteChunksByFile).toHaveBeenCalledWith(
      "test-source",
      "docs/deleted.md",
    );
  });

  it("continues removing remaining ids when one delete fails and reports the failed id", async () => {
    const embeddingClient = new EmbeddingClient("key", "model", 1536);
    const pipeline = new IndexingPipeline(embeddingClient, testConfig);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(deleteChunksByFile).mockReset();
    // First id fails; the batch must NOT abort — the remaining ids still run.
    vi.mocked(deleteChunksByFile)
      .mockRejectedValueOnce(new Error("delete boom"))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    // The failed id MUST be returned so the caller holds the state token back.
    const { failedIds } = await pipeline.removeItems([
      "docs/bad.md",
      "docs/ok1.md",
      "docs/ok2.md",
    ]);
    expect(failedIds).toEqual(["docs/bad.md"]);

    expect(deleteChunksByFile).toHaveBeenCalledTimes(3);
    expect(deleteChunksByFile).toHaveBeenCalledWith(
      "test-source",
      "docs/ok1.md",
    );
    expect(deleteChunksByFile).toHaveBeenCalledWith(
      "test-source",
      "docs/ok2.md",
    );
    // The failure was logged via the pipeline's logPrefix and the FULL error
    // object (not just err.message) so the stack survives.
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[pipeline:test-source] Failed to remove docs/bad.md",
      ),
      expect.any(Error),
    );
    errSpy.mockRestore();
  });

  it("reports an empty failedIds array when all removes succeed", async () => {
    const embeddingClient = new EmbeddingClient("key", "model", 1536);
    const pipeline = new IndexingPipeline(embeddingClient, testConfig);

    vi.mocked(deleteChunksByFile).mockReset();
    vi.mocked(deleteChunksByFile).mockResolvedValue(undefined);

    const { failedIds } = await pipeline.removeItems([
      "docs/a.md",
      "docs/b.md",
    ]);
    expect(failedIds).toEqual([]);
  });

  it("passes sourceUrl from ContentItem when provided", async () => {
    const embeddingClient = new EmbeddingClient("key", "model", 1536);
    const pipeline = new IndexingPipeline(embeddingClient, testConfig);

    vi.mocked(replaceChunksForFile).mockClear();
    await pipeline.indexItems(
      [
        {
          id: "docs/test.md",
          content: "Content",
          sourceUrl: "https://custom.url/test",
        },
      ],
      "abc",
    );

    expect(replaceChunksForFile).toHaveBeenCalledWith(
      "test-source",
      "docs/test.md",
      expect.arrayContaining([
        expect.objectContaining({
          source_url: "https://custom.url/test",
        }),
      ]),
    );
  });

  it("embeds the chunk title and headingPath alongside the content", async () => {
    const { getChunker } = await import("../indexing/chunking/index.js");
    vi.mocked(getChunker).mockReturnValueOnce(() => [
      {
        content: "The body of the chunk",
        title: "useCopilotAction",
        headingPath: ["Reference", "Hooks"],
        chunkIndex: 0,
      },
    ]);

    const embeddingClient = new EmbeddingClient("key", "model", 1536);
    const pipeline = new IndexingPipeline(embeddingClient, testConfig);

    await pipeline.indexItems(
      [{ id: "docs/hooks.md", content: "irrelevant" }],
      "abc",
    );

    const embedBatch = vi.mocked(embeddingClient.embedBatch);
    expect(embedBatch).toHaveBeenCalledTimes(1);
    const embeddedText = embedBatch.mock.calls[0][0][0];
    expect(embeddedText).toContain("useCopilotAction");
    expect(embeddedText).toContain("Reference");
    expect(embeddedText).toContain("Hooks");
    expect(embeddedText).toContain("The body of the chunk");
  });

  it("embeds content gracefully when a code chunk has no heading", async () => {
    const { getChunker } = await import("../indexing/chunking/index.js");
    vi.mocked(getChunker).mockReturnValueOnce(() => [
      {
        content: "export function foo() {}",
        chunkIndex: 0,
      },
    ]);

    const embeddingClient = new EmbeddingClient("key", "model", 1536);
    const pipeline = new IndexingPipeline(embeddingClient, testConfig);

    await pipeline.indexItems(
      [{ id: "src/foo.ts", content: "irrelevant" }],
      "abc",
    );

    const embedBatch = vi.mocked(embeddingClient.embedBatch);
    expect(embedBatch).toHaveBeenCalledTimes(1);
    const embeddedText = embedBatch.mock.calls[0][0][0];
    // No leading/trailing newlines from absent title/headingPath.
    expect(embeddedText).toBe("export function foo() {}");
  });

  it("keeps the chunk's headingPath even when item.metadata supplies one", async () => {
    const { getChunker } = await import("../indexing/chunking/index.js");
    vi.mocked(getChunker).mockReturnValueOnce(() => [
      {
        content: "The body of the chunk",
        title: "useCopilotAction",
        headingPath: ["Reference", "Hooks"],
        chunkIndex: 0,
      },
    ]);

    const embeddingClient = new EmbeddingClient("key", "model", 1536);
    const pipeline = new IndexingPipeline(embeddingClient, testConfig);

    vi.mocked(replaceChunksForFile).mockClear();
    await pipeline.indexItems(
      [
        {
          id: "docs/hooks.md",
          content: "irrelevant",
          // A provider that (incorrectly) sets headingPath must NOT clobber the
          // chunk-derived headingPath, which is embedded into the vector and is
          // load-bearing for retrieval.
          metadata: { headingPath: ["Wrong", "Provider", "Path"], custom: "x" },
        },
      ],
      "abc",
    );

    const upserted = vi.mocked(replaceChunksForFile).mock.calls[0][2];
    expect(upserted[0].metadata).toMatchObject({
      headingPath: ["Reference", "Hooks"],
      custom: "x",
    });
  });

  it("throws when embedBatch returns fewer embeddings than texts", async () => {
    const { getChunker } = await import("../indexing/chunking/index.js");
    // Two chunks → two texts to embed.
    vi.mocked(getChunker).mockReturnValueOnce(() => [
      { content: "chunk one", chunkIndex: 0 },
      { content: "chunk two", chunkIndex: 1 },
    ]);

    const embeddingClient = new EmbeddingClient("key", "model", 1536);
    // Stub the provider to return only ONE embedding for the two texts.
    vi.mocked(embeddingClient.embedBatch).mockResolvedValueOnce([
      [0.1, 0.2, 0.3],
    ]);

    const pipeline = new IndexingPipeline(embeddingClient, testConfig);

    // indexItems swallows per-item errors, so exercise indexItem directly to
    // assert the loud failure on the embedding-count mismatch.
    const indexItem = (
      pipeline as unknown as {
        indexItem(item: ContentItem, stateToken: string): Promise<void>;
      }
    ).indexItem.bind(pipeline);

    await expect(
      indexItem({ id: "docs/two.md", content: "irrelevant" }, "abc"),
    ).rejects.toThrow(/Embedding count mismatch for item docs\/two\.md/);
  });

  it("swallows a replaceChunksForFile failure per item, continues the batch, and reports the failed id", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(replaceChunksForFile).mockReset();
    // First item's atomic replace throws; the loop must log + continue so the
    // second item is still indexed.
    vi.mocked(replaceChunksForFile)
      .mockRejectedValueOnce(new Error("replace boom"))
      .mockResolvedValueOnce(undefined);

    const embeddingClient = new EmbeddingClient("key", "model", 1536);
    const pipeline = new IndexingPipeline(embeddingClient, testConfig);

    // The failed id is RETURNED (so the orchestrator holds the token back) and
    // the successful item still indexes.
    const { failedIds } = await pipeline.indexItems(
      [
        { id: "docs/bad.md", content: "a" },
        { id: "docs/good.md", content: "b" },
      ],
      "abc",
    );
    expect(failedIds).toEqual(["docs/bad.md"]);

    expect(replaceChunksForFile).toHaveBeenCalledTimes(2);
    // The successful item still wrote its chunks.
    expect(replaceChunksForFile).toHaveBeenCalledWith(
      "test-source",
      "docs/good.md",
      expect.any(Array),
    );
    // The failure logs the FULL error object (not just err.message).
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to index docs/bad.md"),
      expect.any(Error),
    );
    errSpy.mockRestore();
    // Restore the default resolved behavior for any later tests.
    vi.mocked(replaceChunksForFile).mockReset();
    vi.mocked(replaceChunksForFile).mockResolvedValue(undefined);
  });

  it("reports an empty failedIds array when all items index successfully", async () => {
    vi.mocked(replaceChunksForFile).mockReset();
    vi.mocked(replaceChunksForFile).mockResolvedValue(undefined);

    const embeddingClient = new EmbeddingClient("key", "model", 1536);
    const pipeline = new IndexingPipeline(embeddingClient, testConfig);

    const { failedIds } = await pipeline.indexItems(
      [{ id: "docs/ok.md", content: "a" }],
      "abc",
    );
    expect(failedIds).toEqual([]);
  });
});
