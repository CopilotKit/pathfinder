import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @xenova/transformers
const mockPipeline = vi.fn();
vi.mock("@xenova/transformers", () => ({
  pipeline: mockPipeline,
  env: { cacheDir: "" },
}));

import { LocalEmbeddingProvider } from "../indexing/embeddings.js";

describe("LocalEmbeddingProvider", () => {
  let mockExtractor: { _call: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockExtractor = {
      _call: vi.fn(),
    };
    mockPipeline.mockResolvedValue(mockExtractor);
  });

  it("loads model on first embed call", async () => {
    mockExtractor._call.mockResolvedValue({
      tolist: () => [[0.1, 0.2, 0.3]],
    });

    const provider = new LocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384);
    await provider.embed("hello");

    expect(mockPipeline).toHaveBeenCalledWith(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
    );
  });

  it("reuses model on subsequent calls", async () => {
    mockExtractor._call.mockResolvedValue({
      tolist: () => [[1, 2, 3]],
    });

    const provider = new LocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384);
    await provider.embed("first");
    await provider.embed("second");

    // pipeline() should only be called once
    expect(mockPipeline).toHaveBeenCalledTimes(1);
  });

  it("embed returns a single vector", async () => {
    mockExtractor._call.mockResolvedValue({
      tolist: () => [[0.5, 0.6, 0.7]],
    });

    const provider = new LocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384);
    const result = await provider.embed("test");
    expect(result).toEqual([0.5, 0.6, 0.7]);
  });

  it("embedBatch processes all texts", async () => {
    mockExtractor._call.mockResolvedValue({
      tolist: () => [
        [1, 0],
        [0, 1],
        [1, 1],
      ],
    });

    const provider = new LocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384);
    const result = await provider.embedBatch(["a", "b", "c"]);
    expect(result).toHaveLength(3);
  });

  it("returns empty array for empty input", async () => {
    const provider = new LocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384);
    const result = await provider.embedBatch([]);
    expect(result).toEqual([]);
    expect(mockPipeline).not.toHaveBeenCalled();
  });

  it("throws clear error when @xenova/transformers not installed", async () => {
    mockPipeline.mockRejectedValue(new Error("Cannot find module"));

    const provider = new LocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384);
    await expect(provider.embed("test")).rejects.toThrow(
      /Install @xenova\/transformers/,
    );
  });

  it("batches in groups of 32 for local inference", async () => {
    const texts = Array.from({ length: 50 }, (_, i) => `text-${i}`);
    mockExtractor._call
      .mockResolvedValueOnce({
        tolist: () => Array.from({ length: 32 }, () => [1]),
      })
      .mockResolvedValueOnce({
        tolist: () => Array.from({ length: 18 }, () => [2]),
      });

    const provider = new LocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384);
    const result = await provider.embedBatch(texts);

    expect(mockExtractor._call).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(50);
  });

  it("concurrent embed calls share the same loading promise", async () => {
    mockExtractor._call.mockResolvedValue({
      tolist: () => [[1, 2, 3]],
    });

    const provider = new LocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384);

    // Fire two concurrent embed calls
    const [r1, r2] = await Promise.all([
      provider.embed("first"),
      provider.embed("second"),
    ]);

    // Model should only be loaded once despite concurrent calls
    expect(mockPipeline).toHaveBeenCalledTimes(1);
    expect(r1).toEqual([1, 2, 3]);
    expect(r2).toEqual([1, 2, 3]);
  });
});
