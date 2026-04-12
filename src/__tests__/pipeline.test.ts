import { describe, it, expect, vi } from "vitest";
import { IndexingPipeline } from "../indexing/pipeline.js";
import type { ContentItem } from "../indexing/providers/types.js";
import type { SourceConfig } from "../types.js";

// Mock the dependencies
vi.mock("../indexing/chunking/index.js", () => ({
  getChunker: vi
    .fn()
    .mockReturnValue((content: string, _filePath: string, _config: unknown) => [
      {
        content,
        title: "Test Title",
        chunkIndex: 0,
      },
    ]),
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
  upsertChunks: vi.fn().mockResolvedValue(undefined),
  deleteChunksByFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../indexing/url-derivation.js", () => ({
  deriveUrl: () => "https://example.com/test",
}));

const { upsertChunks, deleteChunksByFile } = await import("../db/queries.js");
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

    const items: ContentItem[] = [
      {
        id: "docs/test.md",
        content: "# Hello\nSome content here",
      },
    ];

    await pipeline.indexItems(items, "abc123");

    expect(deleteChunksByFile).toHaveBeenCalledWith(
      "test-source",
      "docs/test.md",
    );
    expect(upsertChunks).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          source_name: "test-source",
          file_path: "docs/test.md",
          commit_sha: "abc123",
        }),
      ]),
    );
  });

  it("skips items that produce zero chunks", async () => {
    const { getChunker } = await import("../indexing/chunking/index.js");
    vi.mocked(getChunker).mockReturnValueOnce(() => []);

    const embeddingClient = new EmbeddingClient("key", "model", 1536);
    const pipeline = new IndexingPipeline(embeddingClient, testConfig);

    vi.mocked(upsertChunks).mockClear();
    await pipeline.indexItems([{ id: "empty.md", content: "" }], "abc");
    expect(upsertChunks).not.toHaveBeenCalled();
  });

  it("removes items by ID", async () => {
    const embeddingClient = new EmbeddingClient("key", "model", 1536);
    const pipeline = new IndexingPipeline(embeddingClient, testConfig);

    vi.mocked(deleteChunksByFile).mockClear();
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

  it("passes sourceUrl from ContentItem when provided", async () => {
    const embeddingClient = new EmbeddingClient("key", "model", 1536);
    const pipeline = new IndexingPipeline(embeddingClient, testConfig);

    vi.mocked(upsertChunks).mockClear();
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

    expect(upsertChunks).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          source_url: "https://custom.url/test",
        }),
      ]),
    );
  });
});
