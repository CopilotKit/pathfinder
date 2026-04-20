import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OllamaEmbeddingProvider } from "../indexing/embeddings.js";

describe("OllamaEmbeddingProvider", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("calls Ollama /api/embed endpoint", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }), {
        status: 200,
      }),
    );

    const provider = new OllamaEmbeddingProvider(
      "nomic-embed-text",
      768,
      "http://localhost:11434",
    );
    const result = await provider.embed("hello world");

    expect(result).toEqual([0.1, 0.2, 0.3]);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:11434/api/embed",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "nomic-embed-text",
          input: ["hello world"],
        }),
      }),
    );
  });

  it("embedBatch sends all texts in one request", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          embeddings: [
            [1, 0],
            [0, 1],
            [1, 1],
          ],
        }),
        { status: 200 },
      ),
    );

    const provider = new OllamaEmbeddingProvider(
      "nomic-embed-text",
      768,
      "http://localhost:11434",
    );
    const result = await provider.embedBatch(["a", "b", "c"]);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual([1, 0]);
    expect(result[2]).toEqual([1, 1]);
  });

  it("returns empty array for empty input", async () => {
    const provider = new OllamaEmbeddingProvider(
      "nomic-embed-text",
      768,
      "http://localhost:11434",
    );
    const result = await provider.embedBatch([]);
    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws on non-200 response", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "model not found" }), {
        status: 404,
      }),
    );

    const provider = new OllamaEmbeddingProvider(
      "bad-model",
      768,
      "http://localhost:11434",
    );
    await expect(provider.embed("test")).rejects.toThrow(/Ollama.*404/);
  });

  it("throws on connection error", async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));

    const provider = new OllamaEmbeddingProvider(
      "nomic-embed-text",
      768,
      "http://localhost:11434",
    );
    await expect(provider.embed("test")).rejects.toThrow(/fetch failed/);
  });

  it("strips trailing slash from base_url", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ embeddings: [[1]] }), { status: 200 }),
    );

    const provider = new OllamaEmbeddingProvider(
      "m",
      768,
      "http://localhost:11434/",
    );
    await provider.embed("test");

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:11434/api/embed",
      expect.anything(),
    );
  });

  it("batches large inputs into groups of 512", async () => {
    const texts = Array.from({ length: 600 }, (_, i) => `text-${i}`);
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            embeddings: Array.from({ length: 512 }, () => [1]),
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            embeddings: Array.from({ length: 88 }, () => [2]),
          }),
          { status: 200 },
        ),
      );

    const provider = new OllamaEmbeddingProvider(
      "m",
      768,
      "http://localhost:11434",
    );
    const result = await provider.embedBatch(texts);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(600);
    expect(result[0]).toEqual([1]);
    expect(result[512]).toEqual([2]);
  });
});
