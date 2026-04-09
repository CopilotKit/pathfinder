import { describe, it, expect, vi, beforeEach } from 'vitest';

// We need a reference to the mock create fn that persists across the mock factory
let mockCreate: ReturnType<typeof vi.fn> = vi.fn();

// Mock OpenAI before importing the module under test
vi.mock('openai', () => {
    class MockOpenAI {
        embeddings = { create: (...args: unknown[]) => mockCreate(...args) };
        constructor(_opts: Record<string, unknown>) {}
    }
    // Attach error classes so instanceof checks work in embeddings.ts
    (MockOpenAI as any).RateLimitError = class RateLimitError extends Error {
        constructor(msg = 'rate limit') { super(msg); this.name = 'RateLimitError'; }
    };
    (MockOpenAI as any).InternalServerError = class InternalServerError extends Error {
        constructor(msg = 'internal') { super(msg); this.name = 'InternalServerError'; }
    };
    (MockOpenAI as any).APIConnectionError = class APIConnectionError extends Error {
        constructor(msg = 'connection') { super(msg); this.name = 'APIConnectionError'; }
    };
    return { default: MockOpenAI };
});

// Stub timers so retry delays are instant
vi.useFakeTimers({ shouldAdvanceTime: true });

import OpenAI from 'openai';
import { EmbeddingClient } from '../indexing/embeddings.js';

/** Build a fake embeddings.create response */
function fakeResponse(embeddings: number[][]) {
    return {
        data: embeddings.map((embedding, index) => ({ index, embedding })),
    };
}

describe('EmbeddingClient', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCreate = vi.fn();
    });

    // ── Constructor defaults ────────────────────────────────────────────────

    it('uses default model and dimensions', async () => {
        mockCreate.mockResolvedValue(fakeResponse([[1, 2, 3]]));
        const client = new EmbeddingClient('test-key');
        await client.embed('hello');

        expect(mockCreate).toHaveBeenCalledWith({
            model: 'text-embedding-3-small',
            input: ['hello'],
            dimensions: 1536,
        });
    });

    it('accepts custom model and dimensions', async () => {
        mockCreate.mockResolvedValue(fakeResponse([[1, 2]]));
        const client = new EmbeddingClient('test-key', 'text-embedding-3-large', 3072);
        await client.embed('hello');

        expect(mockCreate).toHaveBeenCalledWith({
            model: 'text-embedding-3-large',
            input: ['hello'],
            dimensions: 3072,
        });
    });

    // ── embed (single text) ─────────────────────────────────────────────────

    it('returns a single embedding vector', async () => {
        mockCreate.mockResolvedValue(fakeResponse([[0.1, 0.2, 0.3]]));
        const client = new EmbeddingClient('test-key');
        const result = await client.embed('test text');
        expect(result).toEqual([0.1, 0.2, 0.3]);
    });

    // ── embedBatch ──────────────────────────────────────────────────────────

    it('returns empty array for empty input', async () => {
        const client = new EmbeddingClient('test-key');
        const result = await client.embedBatch([]);
        expect(result).toEqual([]);
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('embeds multiple texts in a single batch', async () => {
        mockCreate.mockResolvedValue(
            fakeResponse([
                [1, 0, 0],
                [0, 1, 0],
                [0, 0, 1],
            ]),
        );
        const client = new EmbeddingClient('test-key');
        const result = await client.embedBatch(['a', 'b', 'c']);
        expect(result).toHaveLength(3);
        expect(result[0]).toEqual([1, 0, 0]);
        expect(result[2]).toEqual([0, 0, 1]);
    });

    it('sorts results by index even if API returns them out of order', async () => {
        mockCreate.mockResolvedValue({
            data: [
                { index: 2, embedding: [0, 0, 1] },
                { index: 0, embedding: [1, 0, 0] },
                { index: 1, embedding: [0, 1, 0] },
            ],
        });
        const client = new EmbeddingClient('test-key');
        const result = await client.embedBatch(['a', 'b', 'c']);
        expect(result[0]).toEqual([1, 0, 0]);
        expect(result[1]).toEqual([0, 1, 0]);
        expect(result[2]).toEqual([0, 0, 1]);
    });

    // ── Text truncation ─────────────────────────────────────────────────────

    it('truncates texts longer than 30,000 characters', async () => {
        mockCreate.mockResolvedValue(fakeResponse([[1]]));
        const client = new EmbeddingClient('test-key');
        const longText = 'x'.repeat(50_000);
        await client.embedBatch([longText]);

        const calledInput = mockCreate.mock.calls[0][0].input;
        expect(calledInput[0].length).toBe(30_000);
    });

    it('does not truncate texts under 30,000 characters', async () => {
        mockCreate.mockResolvedValue(fakeResponse([[1]]));
        const client = new EmbeddingClient('test-key');
        const text = 'x'.repeat(29_999);
        await client.embedBatch([text]);

        const calledInput = mockCreate.mock.calls[0][0].input;
        expect(calledInput[0].length).toBe(29_999);
    });

    // ── Batching (MAX_BATCH_SIZE = 2048) ────────────────────────────────────

    it('splits large input into multiple batches of 2048', async () => {
        // Create 2050 texts — should produce 2 batches (2048 + 2)
        const texts = Array.from({ length: 2050 }, (_, i) => `text-${i}`);
        mockCreate
            .mockResolvedValueOnce(
                fakeResponse(Array.from({ length: 2048 }, () => [1])),
            )
            .mockResolvedValueOnce(fakeResponse(Array.from({ length: 2 }, () => [2])));

        const client = new EmbeddingClient('test-key');
        const result = await client.embedBatch(texts);

        expect(mockCreate).toHaveBeenCalledTimes(2);
        expect(result).toHaveLength(2050);
        // First batch results
        expect(result[0]).toEqual([1]);
        // Second batch results
        expect(result[2048]).toEqual([2]);
    });

    // ── Retry logic ─────────────────────────────────────────────────────────

    it('retries on RateLimitError and succeeds', async () => {
        mockCreate
            .mockRejectedValueOnce(new (OpenAI as any).RateLimitError('rate limited'))
            .mockResolvedValueOnce(fakeResponse([[1, 2]]));

        const client = new EmbeddingClient('test-key');
        const result = await client.embed('retry me');
        expect(result).toEqual([1, 2]);
        expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('retries on InternalServerError', async () => {
        mockCreate
            .mockRejectedValueOnce(new (OpenAI as any).InternalServerError('500'))
            .mockResolvedValueOnce(fakeResponse([[3, 4]]));

        const client = new EmbeddingClient('test-key');
        const result = await client.embed('retry internal');
        expect(result).toEqual([3, 4]);
        expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('retries on APIConnectionError', async () => {
        mockCreate
            .mockRejectedValueOnce(new (OpenAI as any).APIConnectionError('timeout'))
            .mockResolvedValueOnce(fakeResponse([[5, 6]]));

        const client = new EmbeddingClient('test-key');
        const result = await client.embed('retry connection');
        expect(result).toEqual([5, 6]);
        expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('throws after MAX_RETRIES (3) exhausted', async () => {
        const error = new (OpenAI as any).RateLimitError('persistent rate limit');
        mockCreate
            .mockRejectedValueOnce(error)
            .mockRejectedValueOnce(error)
            .mockRejectedValueOnce(error);

        const client = new EmbeddingClient('test-key');
        await expect(client.embed('fail')).rejects.toThrow('persistent rate limit');
        expect(mockCreate).toHaveBeenCalledTimes(3);
    });

    it('does not retry on non-retryable errors', async () => {
        const error = new Error('bad request');
        mockCreate.mockRejectedValueOnce(error);

        const client = new EmbeddingClient('test-key');
        await expect(client.embed('bad')).rejects.toThrow('bad request');
        expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('uses exponential backoff delays', async () => {
        const sleepSpy = vi.spyOn(globalThis, 'setTimeout');
        const error = new (OpenAI as any).RateLimitError('rate limited');
        mockCreate
            .mockRejectedValueOnce(error)
            .mockRejectedValueOnce(error)
            .mockResolvedValueOnce(fakeResponse([[1]]));

        const client = new EmbeddingClient('test-key');
        await client.embed('backoff test');

        // setTimeout called for sleep: first retry 1000ms, second retry 2000ms
        const sleepCalls = sleepSpy.mock.calls.filter(
            ([, delay]) => delay === 1000 || delay === 2000,
        );
        expect(sleepCalls.length).toBeGreaterThanOrEqual(2);
    });
});
