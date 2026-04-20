import { describe, it, expect } from "vitest";
import { EmbeddingConfigSchema } from "../types.js";

describe("EmbeddingConfigSchema", () => {
  // ── OpenAI provider ─────────────────────────────────────────────────
  it("accepts valid openai config", () => {
    const result = EmbeddingConfigSchema.safeParse({
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
    });
    expect(result.success).toBe(true);
  });

  it("rejects openai config without model", () => {
    const result = EmbeddingConfigSchema.safeParse({
      provider: "openai",
      dimensions: 1536,
    });
    expect(result.success).toBe(false);
  });

  // ── Ollama provider ─────────────────────────────────────────────────
  it("accepts valid ollama config with defaults", () => {
    const result = EmbeddingConfigSchema.safeParse({
      provider: "ollama",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe("nomic-embed-text");
      expect(result.data.dimensions).toBe(768);
      expect((result.data as any).base_url).toBe("http://localhost:11434");
    }
  });

  it("accepts ollama config with custom values", () => {
    const result = EmbeddingConfigSchema.safeParse({
      provider: "ollama",
      model: "mxbai-embed-large",
      dimensions: 1024,
      base_url: "http://gpu-server:11434",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe("mxbai-embed-large");
      expect(result.data.dimensions).toBe(1024);
    }
  });

  it("rejects ollama config with invalid base_url", () => {
    const result = EmbeddingConfigSchema.safeParse({
      provider: "ollama",
      base_url: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  // ── Local provider ──────────────────────────────────────────────────
  it("accepts valid local config with defaults", () => {
    const result = EmbeddingConfigSchema.safeParse({
      provider: "local",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe("Xenova/all-MiniLM-L6-v2");
      expect(result.data.dimensions).toBe(384);
    }
  });

  it("accepts local config with custom model", () => {
    const result = EmbeddingConfigSchema.safeParse({
      provider: "local",
      model: "Xenova/bge-small-en-v1.5",
      dimensions: 384,
    });
    expect(result.success).toBe(true);
  });

  // ── Invalid provider ────────────────────────────────────────────────
  it("rejects unknown provider", () => {
    const result = EmbeddingConfigSchema.safeParse({
      provider: "cohere",
      model: "embed-english-v3.0",
      dimensions: 1024,
    });
    expect(result.success).toBe(false);
  });
});
