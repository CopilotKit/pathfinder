import { describe, it, expect, vi, beforeEach } from "vitest";

// We need a reference to the mock create fn that persists across the mock factory
let mockCreate = vi.fn();

// Mock OpenAI before importing the module under test
vi.mock("openai", () => {
  const MockOpenAI = function (this: any, _opts: Record<string, unknown>) {
    this.embeddings = { create: (...args: unknown[]) => mockCreate(...args) };
  } as any;
  MockOpenAI.RateLimitError = class extends Error {
    constructor(m = "") {
      super(m);
    }
  };
  MockOpenAI.InternalServerError = class extends Error {
    constructor(m = "") {
      super(m);
    }
  };
  MockOpenAI.APIConnectionError = class extends Error {
    constructor(m = "") {
      super(m);
    }
  };
  return { default: MockOpenAI };
});

vi.useFakeTimers({ shouldAdvanceTime: true });

import { createEmbeddingProvider } from "../indexing/embeddings.js";
import type { EmbeddingProvider } from "../indexing/embeddings.js";
import type { EmbeddingConfig } from "../types.js";

describe("createEmbeddingProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate = vi.fn();
  });

  it("returns an OpenAIEmbeddingProvider for openai config", () => {
    const config: EmbeddingConfig = {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
    };
    const provider = createEmbeddingProvider(config, "test-key");
    expect(provider).toBeDefined();
    expect(typeof provider.embed).toBe("function");
    expect(typeof provider.embedBatch).toBe("function");
  });

  it("OpenAIEmbeddingProvider.embed calls OpenAI API", async () => {
    mockCreate.mockResolvedValue({
      data: [{ index: 0, embedding: [0.1, 0.2] }],
    });
    const config: EmbeddingConfig = {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
    };
    const provider = createEmbeddingProvider(config, "test-key");
    const result = await provider.embed("hello");
    expect(result).toEqual([0.1, 0.2]);
    expect(mockCreate).toHaveBeenCalledWith({
      model: "text-embedding-3-small",
      input: ["hello"],
      dimensions: 1536,
    });
  });

  it("requires apiKey for openai provider", () => {
    const config: EmbeddingConfig = {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
    };
    // Should not throw — apiKey is passed separately
    const provider = createEmbeddingProvider(config, "test-key");
    expect(provider).toBeDefined();
  });

  it("throws for openai provider without apiKey", () => {
    const config: EmbeddingConfig = {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
    };
    expect(() => createEmbeddingProvider(config)).toThrow(/OPENAI_API_KEY/i);
  });
});

describe("EmbeddingProvider interface contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate = vi.fn();
  });

  it("embed returns number[]", async () => {
    mockCreate.mockResolvedValue({
      data: [{ index: 0, embedding: [1, 2, 3] }],
    });
    const provider = createEmbeddingProvider(
      { provider: "openai", model: "m", dimensions: 3 },
      "key",
    );
    const result = await provider.embed("test");
    expect(Array.isArray(result)).toBe(true);
    expect(result.every((v) => typeof v === "number")).toBe(true);
  });

  it("embedBatch returns number[][]", async () => {
    mockCreate.mockResolvedValue({
      data: [
        { index: 0, embedding: [1] },
        { index: 1, embedding: [2] },
      ],
    });
    const provider = createEmbeddingProvider(
      { provider: "openai", model: "m", dimensions: 1 },
      "key",
    );
    const result = await provider.embedBatch(["a", "b"]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual([1]);
    expect(result[1]).toEqual([2]);
  });
});
