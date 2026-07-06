import { describe, it, expect, vi, beforeEach } from "vitest";

// We need a reference to the mock create fn that persists across the mock factory
let mockCreate = vi.fn();

// Mock OpenAI before importing the module under test
vi.mock("openai", () => {
  const MockOpenAI = function (this: any, _opts: Record<string, unknown>) {
    this.embeddings = { create: (...args: unknown[]) => mockCreate(...args) };
  } as any;
  MockOpenAI.RateLimitError = class RateLimitError extends Error {
    constructor(msg = "rate limit") {
      super(msg);
      this.name = "RateLimitError";
    }
  };
  MockOpenAI.InternalServerError = class InternalServerError extends Error {
    constructor(msg = "internal") {
      super(msg);
      this.name = "InternalServerError";
    }
  };
  MockOpenAI.APIConnectionError = class APIConnectionError extends Error {
    constructor(msg = "connection") {
      super(msg);
      this.name = "APIConnectionError";
    }
  };
  return { default: MockOpenAI };
});

// Stub timers so retry delays are instant
vi.useFakeTimers({ shouldAdvanceTime: true });

import OpenAI from "openai";
import { EmbeddingClient } from "../indexing/embeddings.js";

/** Build a fake embeddings.create response */
function fakeResponse(embeddings: number[][]) {
  return {
    data: embeddings.map((embedding, index) => ({ index, embedding })),
  };
}

/**
 * A vector sized to the given dimensions (default 1536, the OpenAI provider
 * default). The provider now asserts returned-vector length == configured
 * dimensions, so fixtures whose exact contents aren't load-bearing use a
 * correctly-sized vector to exercise the path under test.
 */
function dimVec(dimensions = 1536): number[] {
  return Array.from({ length: dimensions }, () => 0.1);
}

describe("EmbeddingClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate = vi.fn();
  });

  // ── Constructor defaults ────────────────────────────────────────────────

  it("uses default model and dimensions", async () => {
    mockCreate.mockResolvedValue(fakeResponse([dimVec()]));
    const client = new EmbeddingClient("test-key");
    await client.embed("hello");

    expect(mockCreate).toHaveBeenCalledWith({
      model: "text-embedding-3-small",
      input: ["hello"],
      dimensions: 1536,
      encoding_format: "float",
    });
  });

  it("accepts custom model and dimensions", async () => {
    mockCreate.mockResolvedValue(fakeResponse([dimVec(3072)]));
    const client = new EmbeddingClient(
      "test-key",
      "text-embedding-3-large",
      3072,
    );
    await client.embed("hello");

    expect(mockCreate).toHaveBeenCalledWith({
      model: "text-embedding-3-large",
      input: ["hello"],
      dimensions: 3072,
      encoding_format: "float",
    });
  });

  // ── `dimensions` is only sent for models that support it ─────────────────
  //
  // text-embedding-ada-002 does NOT accept the `dimensions` request param —
  // OpenAI rejects it with an HTTP 400. Only the text-embedding-3-* family
  // supports it. Sending it unconditionally hard-400s ada-002. The request
  // must omit `dimensions` for a model that doesn't support it.

  it("does NOT send `dimensions` for text-embedding-ada-002 (it 400s on that param)", async () => {
    mockCreate.mockResolvedValue(fakeResponse([dimVec()]));
    const client = new EmbeddingClient("test-key", "text-embedding-ada-002");
    await client.embed("hello");

    const calledWith = mockCreate.mock.calls[0][0];
    expect(calledWith.model).toBe("text-embedding-ada-002");
    expect(calledWith.input).toEqual(["hello"]);
    expect(calledWith.encoding_format).toBe("float");
    // The load-bearing assertion: no `dimensions` key on the request at all.
    expect("dimensions" in calledWith).toBe(false);
  });

  it("still sends `dimensions` for the text-embedding-3-* family that supports it", async () => {
    mockCreate.mockResolvedValue(fakeResponse([dimVec()]));
    const small = new EmbeddingClient("test-key", "text-embedding-3-small");
    await small.embed("hello");
    expect(mockCreate.mock.calls[0][0].dimensions).toBe(1536);

    mockCreate.mockClear();
    mockCreate.mockResolvedValue(fakeResponse([dimVec(3072)]));
    const large = new EmbeddingClient(
      "test-key",
      "text-embedding-3-large",
      3072,
    );
    await large.embed("hello");
    expect(mockCreate.mock.calls[0][0].dimensions).toBe(3072);
  });

  // ── embed (single text) ─────────────────────────────────────────────────

  it("returns a single embedding vector", async () => {
    mockCreate.mockResolvedValue(fakeResponse([[0.1, 0.2, 0.3]]));
    // dimensions=3 so the returned 3-dim vector matches the configured size.
    const client = new EmbeddingClient("test-key", "text-embedding-3-small", 3);
    const result = await client.embed("test text");
    expect(result).toEqual([0.1, 0.2, 0.3]);
  });

  // ── embedBatch ──────────────────────────────────────────────────────────

  it("returns empty array for empty input", async () => {
    const client = new EmbeddingClient("test-key");
    const result = await client.embedBatch([]);
    expect(result).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("embeds multiple texts in a single batch", async () => {
    mockCreate.mockResolvedValue(
      fakeResponse([
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ]),
    );
    // dimensions=3 so the returned 3-dim vectors match the configured size.
    const client = new EmbeddingClient("test-key", "text-embedding-3-small", 3);
    const result = await client.embedBatch(["a", "b", "c"]);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual([1, 0, 0]);
    expect(result[2]).toEqual([0, 0, 1]);
  });

  it("sorts results by index even if API returns them out of order", async () => {
    mockCreate.mockResolvedValue({
      data: [
        { index: 2, embedding: [0, 0, 1] },
        { index: 0, embedding: [1, 0, 0] },
        { index: 1, embedding: [0, 1, 0] },
      ],
    });
    // dimensions=3 so the returned 3-dim vectors match the configured size.
    const client = new EmbeddingClient("test-key", "text-embedding-3-small", 3);
    const result = await client.embedBatch(["a", "b", "c"]);
    expect(result[0]).toEqual([1, 0, 0]);
    expect(result[1]).toEqual([0, 1, 0]);
    expect(result[2]).toEqual([0, 0, 1]);
  });

  // ── Text truncation ─────────────────────────────────────────────────────

  it("truncates texts longer than 30,000 characters", async () => {
    mockCreate.mockResolvedValue(fakeResponse([[1]]));
    // dimensions=1 so the returned 1-dim vector matches the configured size;
    // this test asserts on the sent input length, not the returned vector.
    const client = new EmbeddingClient("test-key", "text-embedding-3-small", 1);
    const longText = "x".repeat(50_000);
    await client.embedBatch([longText]);

    const calledInput = mockCreate.mock.calls[0][0].input;
    expect(calledInput[0].length).toBe(30_000);
  });

  it("does not truncate texts under 30,000 characters", async () => {
    mockCreate.mockResolvedValue(fakeResponse([[1]]));
    // dimensions=1 so the returned 1-dim vector matches the configured size;
    // this test asserts on the sent input length, not the returned vector.
    const client = new EmbeddingClient("test-key", "text-embedding-3-small", 1);
    const text = "x".repeat(29_999);
    await client.embedBatch([text]);

    const calledInput = mockCreate.mock.calls[0][0].input;
    expect(calledInput[0].length).toBe(29_999);
  });

  // ── Batching (MAX_BATCH_SIZE = 2048) ────────────────────────────────────

  it("splits large input into multiple batches of 2048", async () => {
    // Create 2050 texts — should produce 2 batches (2048 + 2)
    const texts = Array.from({ length: 2050 }, (_, i) => `text-${i}`);
    mockCreate
      .mockResolvedValueOnce(
        fakeResponse(Array.from({ length: 2048 }, () => [1])),
      )
      .mockResolvedValueOnce(
        fakeResponse(Array.from({ length: 2 }, () => [2])),
      );

    // dimensions=1 so the returned 1-dim vectors match the configured size;
    // this test asserts on batch counts and boundaries, not vector contents.
    const client = new EmbeddingClient("test-key", "text-embedding-3-small", 1);
    const result = await client.embedBatch(texts);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2050);
    // First batch results
    expect(result[0]).toEqual([1]);
    // Second batch results
    expect(result[2048]).toEqual([2]);
  });

  // ── Retry logic ─────────────────────────────────────────────────────────

  it("retries on RateLimitError and succeeds", async () => {
    mockCreate
      .mockRejectedValueOnce(new (OpenAI as any).RateLimitError("rate limited"))
      .mockResolvedValueOnce(fakeResponse([[1, 2]]));

    // dimensions=2 so the returned 2-dim vector matches the configured size.
    const client = new EmbeddingClient("test-key", "text-embedding-3-small", 2);
    const result = await client.embed("retry me");
    expect(result).toEqual([1, 2]);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("retries on InternalServerError", async () => {
    mockCreate
      .mockRejectedValueOnce(new (OpenAI as any).InternalServerError("500"))
      .mockResolvedValueOnce(fakeResponse([[3, 4]]));

    // dimensions=2 so the returned 2-dim vector matches the configured size.
    const client = new EmbeddingClient("test-key", "text-embedding-3-small", 2);
    const result = await client.embed("retry internal");
    expect(result).toEqual([3, 4]);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("retries on APIConnectionError", async () => {
    mockCreate
      .mockRejectedValueOnce(new (OpenAI as any).APIConnectionError("timeout"))
      .mockResolvedValueOnce(fakeResponse([[5, 6]]));

    // dimensions=2 so the returned 2-dim vector matches the configured size.
    const client = new EmbeddingClient("test-key", "text-embedding-3-small", 2);
    const result = await client.embed("retry connection");
    expect(result).toEqual([5, 6]);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("throws after MAX_RETRIES (3) exhausted", async () => {
    const error = new (OpenAI as any).RateLimitError("persistent rate limit");
    mockCreate
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error);

    const client = new EmbeddingClient("test-key");
    await expect(client.embed("fail")).rejects.toThrow("persistent rate limit");
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it("does not retry on non-retryable errors", async () => {
    const error = new Error("bad request");
    mockCreate.mockRejectedValueOnce(error);

    const client = new EmbeddingClient("test-key");
    await expect(client.embed("bad")).rejects.toThrow("bad request");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  // ── STRUCTURAL fix (4a): embed() length guard ────────────────────────────
  //
  // embed() returns embedBatch([text])[0]. When the provider returns an EMPTY
  // (or short) response — a proxy/provider that streamed nothing, a mock that
  // returned `{ data: [] }` — result[0] is `undefined`, which flows downstream
  // as a bogus vector and crashes opaquely at the pgvector write (or worse,
  // silently persists garbage). embed() must assert the batch returned exactly
  // the requested count and fail LOUD with context.
  it("throws a loud, contextful error when the provider returns an EMPTY response for a single embed", async () => {
    // Provider responds with zero embeddings — result[0] would be undefined.
    mockCreate.mockResolvedValue({ data: [] });
    const client = new EmbeddingClient("test-key");
    await expect(client.embed("hello")).rejects.toThrow(
      /embed.*expected 1.*got 0/i,
    );
  });

  it("throws when embedBatch gets fewer vectors back than texts sent", async () => {
    // Two texts in, one vector back — a truncated provider response.
    // Both fake vectors are sized to the configured dimensions so the count
    // guard (not the dimension guard) is the one that fires.
    mockCreate.mockResolvedValue(
      fakeResponse([Array.from({ length: 1536 }, () => 0.1)]),
    );
    const client = new EmbeddingClient("test-key");
    await expect(client.embedBatch(["a", "b"])).rejects.toThrow(
      /expected 2.*got 1/i,
    );
  });

  // ── STRUCTURAL fix: OpenAI provider dimension guard ──────────────────────
  //
  // For an OpenAI/proxy model where the `dimensions` request param is omitted
  // (legacy text-embedding-ada-002) or ignored (a proxy that returns native-
  // size vectors), the provider returns vectors whose length ≠ the configured
  // `dimensions` (the size the pgvector column is fixed to). That mismatched
  // vector otherwise flows silently into the pgvector write and crashes
  // opaquely there instead of failing loud at the provider boundary. The
  // OpenAI provider must fail LOUD, with context, on a dimension mismatch —
  // matching its Ollama and local siblings.
  it("throws a loud, contextful error when a returned vector's length != configured dimensions", async () => {
    // Configured (default) for 1536 but the proxy returns a 384-dim vector — a
    // mismatch the pgvector column would later reject with an opaque error.
    mockCreate.mockResolvedValue(
      fakeResponse([Array.from({ length: 384 }, () => 0.1)]),
    );
    const client = new EmbeddingClient("test-key");
    await expect(client.embed("hello")).rejects.toThrow(
      /dimension.*1536.*got 384/i,
    );
  });

  it("accepts vectors whose length MATCHES the configured dimensions", async () => {
    const vec = Array.from({ length: 1536 }, () => 0.1);
    mockCreate.mockResolvedValue(fakeResponse([vec]));
    const client = new EmbeddingClient("test-key");
    const result = await client.embed("hello");
    expect(result).toHaveLength(1536);
  });

  it("uses exponential backoff delays", async () => {
    const sleepSpy = vi.spyOn(globalThis, "setTimeout");
    const error = new (OpenAI as any).RateLimitError("rate limited");
    mockCreate
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(fakeResponse([[1]]));

    // dimensions=1 so the returned 1-dim vector matches the configured size;
    // this test asserts on retry-backoff delays, not vector contents.
    const client = new EmbeddingClient("test-key", "text-embedding-3-small", 1);
    await client.embed("backoff test");

    // setTimeout called for sleep: first retry 1000ms, second retry 2000ms
    const sleepCalls = sleepSpy.mock.calls.filter(
      ([, delay]) => delay === 1000 || delay === 2000,
    );
    expect(sleepCalls.length).toBeGreaterThanOrEqual(2);
  });
});
