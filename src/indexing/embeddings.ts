// Embedding provider abstraction — supports OpenAI, Ollama, and local (transformers.js)

import OpenAI from "openai";
import type { EmbeddingConfig } from "../types.js";

const MAX_BATCH_SIZE = 2048;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

// ── Provider interface ──────────────────────────────────────────────────────

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createEmbeddingProvider(
  config: EmbeddingConfig,
  openaiApiKey?: string,
): EmbeddingProvider {
  switch (config.provider) {
    case "openai": {
      if (!openaiApiKey) {
        throw new Error(
          'OPENAI_API_KEY is required when embedding.provider is "openai".',
        );
      }
      return new OpenAIEmbeddingProvider(
        openaiApiKey,
        config.model,
        config.dimensions,
      );
    }
    case "ollama":
      return new OllamaEmbeddingProvider(
        config.model,
        config.dimensions,
        config.base_url,
      );
    case "local":
      return new LocalEmbeddingProvider(config.model, config.dimensions);
  }
}

// ── OpenAI provider ─────────────────────────────────────────────────────────

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private client: OpenAI;
  private model: string;
  private dimensions: number;

  /**
   * Constructor accepts positional params with defaults so the backwards-compat
   * alias `EmbeddingClient` works for existing call sites that pass
   * (apiKey, model, dimensions) directly.
   */
  constructor(
    apiKey: string,
    model: string = "text-embedding-3-small",
    dimensions: number = 1536,
  ) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    const result = await this.embedBatch([text]);
    return result[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Truncate texts that exceed OpenAI's 8192 token limit (~32K chars with safety margin)
    const MAX_CHARS = 30_000;
    const truncated = texts.map((t) =>
      t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) : t,
    );

    const chunks: string[][] = [];
    for (let i = 0; i < truncated.length; i += MAX_BATCH_SIZE) {
      chunks.push(truncated.slice(i, i + MAX_BATCH_SIZE));
    }

    const totalBatches = chunks.length;
    const results: number[][] = [];
    for (let i = 0; i < chunks.length; i++) {
      // Only log batch progress when there are multiple batches
      if (totalBatches > 1) {
        console.log(
          `Embedding batch ${i + 1}/${totalBatches} (${chunks[i].length} texts)...`,
        );
      }
      const batchResults = await this.embedWithRetry(chunks[i], i + 1);
      results.push(...batchResults);
    }
    return results;
  }

  private async embedWithRetry(
    texts: string[],
    batchNum: number,
    attempt: number = 1,
  ): Promise<number[][]> {
    try {
      const response = await this.client.embeddings.create({
        model: this.model,
        input: texts,
        dimensions: this.dimensions,
      });

      // OpenAI returns embeddings sorted by index, but sort explicitly to be safe
      const sorted = response.data.sort((a, b) => a.index - b.index);
      return sorted.map((item) => item.embedding);
    } catch (error: unknown) {
      if (attempt >= MAX_RETRIES) {
        console.error(
          `Embedding batch ${batchNum} failed after ${MAX_RETRIES} retries`,
        );
        throw error;
      }

      const isRetryable =
        error instanceof OpenAI.RateLimitError ||
        error instanceof OpenAI.InternalServerError ||
        error instanceof OpenAI.APIConnectionError;

      if (!isRetryable) throw error;

      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.warn(
        `Embedding batch ${batchNum} attempt ${attempt}/${MAX_RETRIES} failed ` +
          `(${(error as Error).message}), retrying in ${delay}ms...`,
      );

      await sleep(delay);
      return this.embedWithRetry(texts, batchNum, attempt + 1);
    }
  }
}

// ── Ollama provider ────────────────────────────────────────────────────────

const OLLAMA_BATCH_SIZE = 512;

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private model: string;
  private dimensions: number;
  private baseUrl: string;

  constructor(model: string, dimensions: number, baseUrl: string) {
    this.model = model;
    this.dimensions = dimensions;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async embed(text: string): Promise<number[]> {
    const result = await this.embedBatch([text]);
    return result[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += OLLAMA_BATCH_SIZE) {
      batches.push(texts.slice(i, i + OLLAMA_BATCH_SIZE));
    }

    const totalBatches = batches.length;
    const results: number[][] = [];
    for (let i = 0; i < batches.length; i++) {
      if (totalBatches > 1) {
        console.log(
          `[ollama] Embedding batch ${i + 1}/${totalBatches} (${batches[i].length} texts)...`,
        );
      }
      const batchResult = await this.callOllamaEmbed(batches[i]);
      results.push(...batchResult);
    }
    return results;
  }

  private async callOllamaEmbed(texts: string[]): Promise<number[][]> {
    const url = `${this.baseUrl}/api/embed`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Ollama embedding request failed (${response.status}): ${body}`,
      );
    }

    const data = (await response.json()) as { embeddings: number[][] };
    return data.embeddings;
  }
}

// ── Local provider ─────────────────────────────────────────────────────────

const LOCAL_BATCH_SIZE = 32;

/** Minimal interface for a transformers.js feature-extraction pipeline. */
interface Extractor {
  _call(
    texts: string[],
    options: { pooling: string; normalize: boolean },
  ): Promise<{ tolist(): number[][] }>;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  private model: string;
  private dimensions: number;
  private extractor: Extractor | null = null;
  private loadingPromise: Promise<Extractor> | null = null;

  constructor(model: string, dimensions: number) {
    this.model = model;
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    const result = await this.embedBatch([text]);
    return result[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const extractor = await this.getExtractor();

    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += LOCAL_BATCH_SIZE) {
      batches.push(texts.slice(i, i + LOCAL_BATCH_SIZE));
    }

    const totalBatches = batches.length;
    const results: number[][] = [];
    for (let i = 0; i < batches.length; i++) {
      if (totalBatches > 1) {
        console.log(
          `[local] Embedding batch ${i + 1}/${totalBatches} (${batches[i].length} texts)...`,
        );
      }
      const output = await extractor._call(batches[i], {
        pooling: "mean",
        normalize: true,
      });
      const vectors: number[][] = output.tolist();
      results.push(...vectors);
    }
    return results;
  }

  private async getExtractor(): Promise<Extractor> {
    if (this.extractor) return this.extractor;
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = this.loadModel();
    this.extractor = await this.loadingPromise;
    this.loadingPromise = null;
    return this.extractor;
  }

  private async loadModel(): Promise<Extractor> {
    try {
      const { pipeline } = await import("@xenova/transformers");
      console.log(`[local] Loading model ${this.model}...`);
      const extractor = (await pipeline(
        "feature-extraction",
        this.model,
      )) as Extractor;
      console.log(`[local] Model ${this.model} loaded.`);
      return extractor;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (
        msg.includes("Cannot find module") ||
        msg.includes("ERR_MODULE_NOT_FOUND")
      ) {
        throw new Error(
          "Install @xenova/transformers to use local embeddings: npm install @xenova/transformers",
        );
      }
      throw error;
    }
  }
}

// ── Backwards compatibility ─────────────────────────────────────────────────
// Alias for existing call sites that construct EmbeddingClient directly.
// TODO: Remove once all call sites use createEmbeddingProvider.
export const EmbeddingClient = OpenAIEmbeddingProvider;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
