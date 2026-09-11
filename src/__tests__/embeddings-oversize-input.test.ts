import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

// Regression for the ten-day `code`-source wedge on mcp.copilotkit.ai.
//
// OpenAIEmbeddingProvider guarded oversized inputs with a CHARACTER cap:
//
//   const MAX_CHARS = 30_000;   // "~8192 tokens with safety margin"
//
// That is a unit error. 30,000 characters is only ~8192 tokens at ≥3.66
// chars/token; dense source code tokenizes far denser than prose, so a 30,000
// character code chunk is comfortably over 10,000 tokens. Production hit it:
//
//   BadRequestError: 400 Invalid 'input[2]': maximum input length is 8192 tokens.
//
// A 400 is not retryable, so the item failed, the source's state token was
// held, and the whole `code` source froze for ten days.
//
// The invariant: an input the API rejects purely for LENGTH must be recovered
// from in-provider by shrinking and retrying, not surfaced as a hard failure.
// No fixed character cap can be correct for every tokenizer, so the provider
// has to converge on the real limit empirically.
//
// The fake below is the REAL OpenAI SDK talking to a REAL HTTP server that
// returns production's exact 400 shape. Its limit is expressed in characters
// (a stand-in for the tokenizer) and deliberately set BELOW MAX_CHARS, which
// is precisely the condition the char cap cannot see.

const SERVER_CHAR_LIMIT = 4_000;

interface EmbeddingsRequest {
  input: string[];
  model: string;
}

let server: http.Server;
let baseUrl: string;
let requests: EmbeddingsRequest[] = [];
let savedBaseUrl: string | undefined;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body) as EmbeddingsRequest;
      requests.push(parsed);
      const overIndex = parsed.input.findIndex(
        (t) => t.length > SERVER_CHAR_LIMIT,
      );
      if (overIndex !== -1) {
        // Production's exact error shape.
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: `Invalid 'input[${overIndex}]': maximum input length is 8192 tokens.`,
              type: "invalid_request_error",
              param: `input[${overIndex}]`,
              code: null,
            },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          model: parsed.model,
          data: parsed.input.map((_, i) => ({
            object: "embedding",
            index: i,
            embedding: Array.from({ length: 8 }, () => 0.01),
          })),
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1`;
  savedBaseUrl = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = baseUrl;
});

afterAll(async () => {
  if (savedBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = savedBaseUrl;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function makeProvider() {
  // Import AFTER OPENAI_BASE_URL is set: the SDK client is built in the
  // provider constructor and reads the env var there.
  const { OpenAIEmbeddingProvider } = await import("../indexing/embeddings.js");
  return new OpenAIEmbeddingProvider("test-key", "text-embedding-3-small", 8);
}

describe("OpenAIEmbeddingProvider: an over-length input must not hard-fail", () => {
  it("recovers from a length-400 by shrinking the offending input and retrying", async () => {
    requests = [];
    const provider = await makeProvider();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // 20,000 chars: UNDER the 30,000 char cap, so the existing guard lets it
    // through untouched — and the server rejects it. This is the production
    // condition exactly.
    const oversized = "x".repeat(20_000);
    const vectors = await provider.embedBatch(["small", oversized]);

    warnSpy.mockRestore();

    expect(vectors).toHaveLength(2);
    expect(vectors[1]).toHaveLength(8);
    // It converged by shrinking, not by luck: more than one request was made
    // and the final one was within the server's limit.
    expect(requests.length).toBeGreaterThan(1);
    const last = requests[requests.length - 1];
    expect(Math.max(...last.input.map((t) => t.length))).toBeLessThanOrEqual(
      SERVER_CHAR_LIMIT,
    );
    // Healthy siblings in the batch are not mangled.
    expect(last.input[0]).toBe("small");
  });

  it("still fails loudly on a NON-length 400 (no infinite shrink loop)", async () => {
    // Guard against "swallow every 400". A bad API key or an unknown param
    // must still throw.
    requests = [];
    const badServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "Unknown parameter: 'dimensions'.",
              type: "invalid_request_error",
            },
          }),
        );
      });
    });
    await new Promise<void>((r) => badServer.listen(0, "127.0.0.1", r));
    const { port } = badServer.address() as AddressInfo;
    const prev = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
    try {
      const provider = await makeProvider();
      await expect(provider.embedBatch(["anything"])).rejects.toThrow(
        /Unknown parameter/,
      );
    } finally {
      process.env.OPENAI_BASE_URL = prev;
      await new Promise<void>((r) => badServer.close(() => r()));
    }
  });
});
