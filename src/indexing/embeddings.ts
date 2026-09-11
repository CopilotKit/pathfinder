// Embedding provider abstraction — supports OpenAI, Ollama, and local (transformers.js)

import OpenAI from "openai";
import type { EmbeddingConfig } from "../types.js";

const MAX_BATCH_SIZE = 2048;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

// How many times a single batch may be shrunk in response to an
// input-too-long 400 before giving up. Each round halves the offending input,
// so 12 rounds take a 30,000-character input below 8 characters — the bound
// exists to guarantee termination, not because it is ever expected to be hit.
const MAX_SHRINK_ROUNDS = 12;

// Inputs are never shrunk below this. An input this small that STILL trips the
// length error is not a length problem, and looping further would hide the
// real one.
const MIN_SHRINK_CHARS = 64;

/**
 * Whether an API error is the provider rejecting an input purely for being too
 * long — recoverable by sending less text, unlike every other 400.
 *
 * This distinction is what kept mcp.copilotkit.ai's `code` source frozen for
 * ten days. A single code chunk embedded to more than 8192 tokens, OpenAI
 * answered `400 Invalid 'input[2]': maximum input length is 8192 tokens.`, the
 * provider treated it as fatal, the item failed, and the orchestrator held the
 * source's state token — every run, identically, for ten days.
 */
function isInputTooLongError(error: unknown): boolean {
  // Duck-type the 400 rather than relying solely on `instanceof`: the SDK
  // class is not always the same object across module boundaries (and test
  // doubles replace it outright), while `status` is stable on every APIError.
  const status = (error as { status?: unknown } | null)?.status;
  const isBadRequest =
    status === 400 ||
    (typeof OpenAI.BadRequestError === "function" &&
      error instanceof OpenAI.BadRequestError);
  if (!isBadRequest) return false;
  const message = String((error as Error | null)?.message ?? "");
  return /maximum input length|maximum context length|reduce (?:your|the) input/i.test(
    message,
  );
}

/**
 * Which input index the provider named, if it named one. OpenAI reports the
 * FIRST offending element as `input[N]`, so shrinking just that element and
 * retrying converges on the real limit without mangling healthy siblings in
 * the same batch.
 */
function parseOffendingInputIndex(error: unknown): number | null {
  const message = String((error as Error)?.message ?? "");
  const match = /input\[(\d+)\]/.exec(message);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

// Assert a provider returned exactly one vector per input text, failing LOUD
// with context on a shortfall. A provider/proxy that streams nothing (or a mock
// returning `{ data: [] }`) yields a results array SHORTER than the input, so
// `embed()`'s `result[0]` is `undefined` — a bogus vector that flows downstream
// and crashes opaquely at the pgvector write (or silently persists garbage).
// Every provider calls this at the end of embedBatch so the failure surfaces
// HERE, at the boundary, naming the provider and the expected/actual counts.
function assertEmbeddingCount(
  provider: string,
  expected: number,
  results: number[][],
): void {
  if (results.length !== expected) {
    throw new Error(
      `[${provider}] embedding count mismatch: expected ${expected} vector(s) ` +
        `for ${expected} input text(s), got ${results.length}. The embedding ` +
        `provider returned an incomplete response.`,
    );
  }
}

// Assert every returned vector matches the configured `dimensions`, failing
// LOUD with context on a mismatch. Ollama's /api/embed and transformers.js both
// return the model's NATIVE-size vectors and ignore the configured dimensions,
// so a model whose native size ≠ the configured dimensions (the size the
// pgvector column is fixed to) silently produces mismatched vectors that only
// blow up opaquely at the DB write. Validating HERE surfaces the mismatch at
// the provider boundary, naming the expected/actual dimension.
function assertEmbeddingDimensions(
  provider: string,
  expected: number,
  results: number[][],
): void {
  for (const vec of results) {
    if (vec.length !== expected) {
      throw new Error(
        `[${provider}] embedding dimension mismatch: configured for ${expected} ` +
          `dimensions (the pgvector column size) but got ${vec.length}. This ` +
          `model's native embedding size does not match the configured ` +
          `dimensions; set embedding.dimensions to the model's native size or ` +
          `choose a matching model.`,
      );
    }
  }
}

// Whether an OpenAI embedding model accepts the `dimensions` request param.
// Only the text-embedding-3-* family supports it; the older
// text-embedding-ada-002 (and any other legacy model) REJECTS the param with
// an HTTP 400 ("Unknown parameter: 'dimensions'"). Sending it unconditionally
// hard-400s a non-default model, so the request must omit it for models that
// don't support it. Prefix-matching the 3-* family (rather than an ada-002
// denylist) is forward-safe: it opts NEW models IN only when they join the
// dimension-configurable family, and defaults an unknown model to the safe
// "omit" behavior.
function modelSupportsDimensions(model: string): boolean {
  return /^text-embedding-3-/.test(model);
}

/**
 * Halve the length of the input(s) the provider rejected.
 *
 * When the error named an index, only that input is touched, so a single
 * pathological chunk does not degrade the rest of its batch. When it did not,
 * every input above {@link MIN_SHRINK_CHARS} is halved — a blunt instrument,
 * but one that still converges.
 *
 * Returns null when nothing can usefully be shrunk, which is the signal to
 * stop and surface the original error.
 */
function shrinkOversizedInputs(
  texts: string[],
  offendingIndex: number | null,
): { texts: string[]; changedCount: number } | null {
  const shouldShrink = (index: number, text: string): boolean => {
    if (text.length <= MIN_SHRINK_CHARS) return false;
    return offendingIndex === null || offendingIndex === index;
  };

  let changedCount = 0;
  const next = texts.map((text, index) => {
    if (!shouldShrink(index, text)) return text;
    changedCount++;
    return text.slice(
      0,
      Math.max(MIN_SHRINK_CHARS, Math.floor(text.length / 2)),
    );
  });

  return changedCount === 0 ? null : { texts: next, changedCount };
}

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

    // A first-pass cap on absurd inputs. It is expressed in CHARACTERS while
    // the API's limit is in TOKENS, so it can only ever be a heuristic: 30,000
    // characters is ~8192 tokens at 3.66 chars/token, and dense source code
    // tokenizes well below that ratio. Inputs that slip past this cap and get
    // rejected are recovered by the shrink-and-retry path in embedWithRetry —
    // that, not this constant, is what makes an over-length input non-fatal.
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
    // Fail loud if the provider returned fewer vectors than texts (an empty /
    // truncated response) — `embed()`'s result[0] would otherwise be undefined.
    assertEmbeddingCount("openai", truncated.length, results);
    // …and on a native-size vs configured-dimensions mismatch: a legacy model
    // (text-embedding-ada-002) omits the `dimensions` param, and a proxy may
    // ignore it, so a returned vector whose length ≠ the configured dimensions
    // would only surface as an opaque pgvector write error.
    assertEmbeddingDimensions("openai", this.dimensions, results);
    return results;
  }

  private async embedWithRetry(
    texts: string[],
    batchNum: number,
    attempt: number = 1,
    shrinkRound: number = 0,
  ): Promise<number[][]> {
    try {
      const response = await this.client.embeddings.create({
        model: this.model,
        input: texts,
        // `dimensions` is only accepted by the text-embedding-3-* family;
        // text-embedding-ada-002 (and other legacy models) 400 on it. Spread
        // it in ONLY when the model supports it so a non-default model does
        // not hard-fail on an unknown-param 400.
        ...(modelSupportsDimensions(this.model)
          ? { dimensions: this.dimensions }
          : {}),
        // Request a FLOAT array explicitly. The OpenAI SDK v4 defaults
        // encoding_format to "base64"; a base64 response is decoded by the SDK
        // into a Float32Array-backed number[]. Against a mock/proxy that returns
        // a JSON float array while the SDK expects base64 (aimock's
        // /v1/embeddings — see the S2 spike), the SDK MIS-DECODES the float array
        // as base64 and yields a CORRUPT, wrong-length vector (1536 → 384).
        // Asking for "float" makes the wire format unambiguous — correct against
        // both the real API and any float-returning proxy, and more robust than
        // relying on the base64 round-trip.
        encoding_format: "float",
      });

      // OpenAI returns embeddings sorted by index, but sort explicitly to be safe
      const sorted = response.data.sort((a, b) => a.index - b.index);
      return sorted.map((item) => item.embedding);
    } catch (error: unknown) {
      // An input-too-long 400 is recoverable by sending less text, so it is
      // handled before the generic retry bookkeeping: it is not an attempt
      // that should count against MAX_RETRIES, and retrying it unchanged
      // would fail identically forever.
      if (isInputTooLongError(error)) {
        const shrunk = shrinkOversizedInputs(
          texts,
          parseOffendingInputIndex(error),
        );
        if (shrunk && shrinkRound < MAX_SHRINK_ROUNDS) {
          console.warn(
            `Embedding batch ${batchNum}: input rejected as too long ` +
              `(${(error as Error).message}); truncating ${shrunk.changedCount} ` +
              `input(s) and retrying (shrink round ${shrinkRound + 1}/${MAX_SHRINK_ROUNDS}). ` +
              `Indexed content for the affected chunk(s) will be TRUNCATED.`,
          );
          return this.embedWithRetry(
            shrunk.texts,
            batchNum,
            attempt,
            shrinkRound + 1,
          );
        }
        console.error(
          `Embedding batch ${batchNum}: input still rejected as too long after ` +
            `${shrinkRound} shrink round(s); giving up.`,
        );
        throw error;
      }

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
    // Fail loud on an incomplete response (result[0] would be undefined)…
    assertEmbeddingCount("ollama", texts.length, results);
    // …and on a native-size vs configured-dimensions mismatch: Ollama returns
    // the model's native size and ignores `dimensions`, so a size mismatch
    // would only surface as an opaque pgvector write error.
    assertEmbeddingDimensions("ollama", this.dimensions, results);
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
    // Fail loud on an incomplete response (result[0] would be undefined)…
    assertEmbeddingCount("local", texts.length, results);
    // …and on a native-size vs configured-dimensions mismatch: transformers.js
    // returns the model's native size and ignores `dimensions`, so a size
    // mismatch would only surface as an opaque pgvector write error.
    assertEmbeddingDimensions("local", this.dimensions, results);
    return results;
  }

  private async getExtractor(): Promise<Extractor> {
    if (this.extractor) return this.extractor;
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = this.loadModel();
    try {
      this.extractor = await this.loadingPromise;
    } finally {
      this.loadingPromise = null;
    }
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
