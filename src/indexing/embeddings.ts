// OpenAI batch embedding client with automatic batching and retry logic

import OpenAI from "openai";

const MAX_BATCH_SIZE = 2048;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export class EmbeddingClient {
  private client: OpenAI;
  private model: string;
  private dimensions: number;

  constructor(apiKey: string, model?: string, dimensions?: number) {
    this.client = new OpenAI({ apiKey });
    this.model = model ?? "text-embedding-3-small";
    this.dimensions = dimensions ?? 1536;
  }

  async embed(text: string): Promise<number[]> {
    const result = await this.embedBatch([text]);
    return result[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Truncate texts that exceed OpenAI's 8192 token limit (~32K chars with safety margin)
    const MAX_CHARS = 30_000;
    const truncated = texts.map((t) => {
      if (t.length > MAX_CHARS) {
        return t.slice(0, MAX_CHARS);
      }
      return t;
    });

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
