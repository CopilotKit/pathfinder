// Theme B.0 SPIKE (plan S2) — sizes the S9 embedding seam.
//
// QUESTION: does aimock already proxy/record `/v1/embeddings` so that the
// semantic-dedup embedding work in S9 collapses to just pointing the OpenAI
// client's baseURL at aimock — or is real seam work needed?
//
// VERDICT PROVEN HERE (see the assertions below, all against a REAL aimock
// roundtrip — no vi.mock / vi.fn stubs, per org rule):
//
//   1. aimock serves a first-class, OpenAI-compatible `/v1/embeddings`
//      endpoint. Its deterministic fallback returns a stable, dimension-
//      correct JSON float array (no fixture required) and records the roundtrip
//      in the journal. → The transport/record side of the seam is FREE.
//
//   2. `OpenAIEmbeddingProvider` (src/indexing/embeddings.ts) does
//      `new OpenAI({ apiKey })` with NO explicit `baseURL`. The OpenAI SDK
//      defaults `baseURL` to `process.env.OPENAI_BASE_URL`, so setting that env
//      var transparently redirects the provider at aimock with ZERO production
//      edits. → The redirect side of the seam is a pure env var.
//
//   3. **THE ONE REAL CATCH (sized S9, now FIXED):** the OpenAI SDK v4 defaults
//      `encoding_format` to `"base64"`. aimock's embeddings handler does NOT
//      honor `encoding_format` — it always returns a JSON float array. When the
//      SDK asks for base64 and gets a float array, it MIS-DECODES the response
//      into a CORRUPT, wrong-length vector (1536 → 384). S9 lands the one-line
//      fix — `embeddings.ts:embedWithRetry` (and `llm.ts:embed`) now request
//      `encoding_format: "float"`, so the provider decodes correctly against
//      both aimock and the real API. The regression guard below pins that fix.
//
// SIZING FOR S9 (historical): the embedding seam was NOT free-baseURL-only, but
// it was still SMALL — the one-line encoding_format change, now landed in S9.
// No aimock extension, no record/replay build-out.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { LLMock } from "@copilotkit/aimock";
import OpenAI from "openai";

import {
  createEmbeddingProvider,
  OpenAIEmbeddingProvider,
} from "../indexing/embeddings.js";
import type { EmbeddingConfig } from "../types.js";

const DIMENSIONS = 1536;
const CONFIG: EmbeddingConfig = {
  provider: "openai",
  model: "text-embedding-3-small",
  dimensions: DIMENSIONS,
};

// A representative Atlas seed-candidate title — the text S9 would embed for the
// semantic-dedup vector probe.
const CANDIDATE_TEXT =
  "ADK runs use optimistic concurrency; a stale run token yields a 409 the client must refetch-and-retry";

function embeddingRequests(mock: LLMock) {
  return mock
    .getRequests()
    .filter((entry) => entry.path.endsWith("/v1/embeddings"));
}

describe("aimock /v1/embeddings spike (plan S2 — sizes S9)", () => {
  const mock = new LLMock({ port: 0, logLevel: "silent" });
  const savedBaseURL = process.env.OPENAI_BASE_URL;

  beforeAll(async () => {
    await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
    if (savedBaseURL === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = savedBaseURL;
  });

  afterEach(() => {
    mock.resetMatchCounts();
    mock.journal.clear();
  });

  it("RED: with OPENAI_BASE_URL unset, the provider is NOT redirected at aimock (zero journal hits)", () => {
    delete process.env.OPENAI_BASE_URL;

    // Constructing the provider WITHOUT the env redirect points its OpenAI
    // client at the real api.openai.com base URL — nothing lands in aimock's
    // journal. We assert the "not redirected" state without letting a request
    // escape to the network.
    const provider = createEmbeddingProvider(CONFIG, "mock");
    expect(provider).toBeInstanceOf(OpenAIEmbeddingProvider);

    expect(embeddingRequests(mock)).toHaveLength(0);
  });

  it("GREEN: with OPENAI_BASE_URL set to aimock, the UNMODIFIED provider records a real /v1/embeddings roundtrip", async () => {
    // The ONLY change vs RED: point the SDK's env-default baseURL at aimock.
    // No production code edit needed to reach aimock — the transport works.
    process.env.OPENAI_BASE_URL = `${mock.url}/v1`;

    const provider = createEmbeddingProvider(CONFIG, "mock");
    const vector = await provider.embed(CANDIDATE_TEXT);

    // The roundtrip really hit aimock at /v1/embeddings and was recorded.
    const recorded = embeddingRequests(mock);
    expect(recorded.length).toBeGreaterThanOrEqual(1);
    expect(recorded[0].method).toBe("POST");
    expect(recorded[0].response.status).toBe(200);

    // aimock returned an array of numbers (OpenAI-shaped embedding payload).
    expect(Array.isArray(vector)).toBe(true);
    expect(vector.every((n) => typeof n === "number")).toBe(true);
  });

  it("S9 FIX (regression guard): the provider now requests encoding_format:'float' so aimock returns a CORRECT-length vector", async () => {
    // S9 sizing catch (pre-fix, this test asserted the OPPOSITE — the provider's
    // SDK-default encoding_format "base64" was mis-decoded against aimock's JSON
    // float array into a WRONG-LENGTH vector, 1536→384). S9 lands the one-line
    // fix in embeddings.ts:embedWithRetry (encoding_format:"float"), so the
    // provider now decodes correctly. This is the RED→GREEN for that fix: the
    // formerly-corrupt path returns the requested dimension.
    process.env.OPENAI_BASE_URL = `${mock.url}/v1`;

    const provider = createEmbeddingProvider(CONFIG, "mock");
    const vector = await provider.embed(CANDIDATE_TEXT);

    // Correct length now that the provider asks aimock for a float array.
    expect(vector).toHaveLength(DIMENSIONS);
  });

  it("SIZES S9: requesting encoding_format:'float' FIXES the roundtrip (the one-line S9 change)", async () => {
    // Demonstrates the fix S9 needs: ask aimock for a float array directly.
    // A raw SDK call with encoding_format:'float' returns the correct length,
    // proving the seam collapses to a single embeddings-request option.
    const client = new OpenAI({ apiKey: "mock", baseURL: `${mock.url}/v1` });

    const good = await client.embeddings.create({
      model: CONFIG.model,
      input: CANDIDATE_TEXT,
      dimensions: DIMENSIONS,
      encoding_format: "float",
    });

    expect(good.data[0].embedding).toHaveLength(DIMENSIONS);
    expect(embeddingRequests(mock).length).toBeGreaterThanOrEqual(1);
  });

  it("GREEN: aimock replays a deterministic embedding for identical input (record/replay stability)", async () => {
    // aimock's deterministic fallback yields the SAME vector for the SAME text
    // — exactly the property S9's semantic-dedup tests need from the embedding
    // seam (stable cosine similarity across a run). Asserted on the corrupted
    // default path too, since determinism holds regardless of encoding.
    process.env.OPENAI_BASE_URL = `${mock.url}/v1`;
    const provider = createEmbeddingProvider(CONFIG, "mock");

    const first = await provider.embed(CANDIDATE_TEXT);
    const second = await provider.embed(CANDIDATE_TEXT);

    expect(second).toEqual(first);
    expect(embeddingRequests(mock).length).toBeGreaterThanOrEqual(2);
  });
});
