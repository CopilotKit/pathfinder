import { describe, it, expect, vi, beforeEach } from 'vitest';
import { distillThread, type ThreadMessage } from '../indexing/distiller.js';

// Shared mock function accessible in tests
const mockCreate = vi.fn();

// Mock the openai module — default export must be a class (used with `new`)
vi.mock('openai', () => {
    class MockOpenAI {
        chat = {
            completions: {
                create: mockCreate,
            },
        };
        constructor(_opts?: unknown) {}
    }
    return { default: MockOpenAI };
});

describe('distillThread', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    const sampleMessages: ThreadMessage[] = [
        { author: 'Alice', content: 'How do I set up CopilotKit with Next.js?', timestamp: '2024-01-15 10:00' },
        { author: 'Bob', content: 'You need to install @copilotkit/react-core and wrap your app with CopilotKit provider.', timestamp: '2024-01-15 10:05', reactions: [{ name: 'thumbsup', count: 3 }] },
        { author: 'Alice', content: 'Thanks, that worked!', timestamp: '2024-01-15 10:10' },
    ];

    it('extracts Q&A pairs from a thread', async () => {
        mockCreate.mockResolvedValueOnce({
            choices: [{
                message: {
                    content: JSON.stringify({
                        pairs: [{
                            question: 'How do I set up CopilotKit with Next.js?',
                            answer: 'Install @copilotkit/react-core and wrap your app with the CopilotKit provider component.',
                            confidence: 0.92,
                        }],
                    }),
                },
            }],
        });

        const result = await distillThread(sampleMessages, { apiKey: 'test-key' });
        expect(result.pairs).toHaveLength(1);
        expect(result.pairs[0].question).toContain('CopilotKit');
        expect(result.pairs[0].confidence).toBe(0.92);
    });

    it('returns multiple pairs for threads with follow-ups', async () => {
        mockCreate.mockResolvedValueOnce({
            choices: [{
                message: {
                    content: JSON.stringify({
                        pairs: [
                            { question: 'Q1', answer: 'A1', confidence: 0.9 },
                            { question: 'Q2', answer: 'A2', confidence: 0.7 },
                        ],
                    }),
                },
            }],
        });

        const result = await distillThread(sampleMessages, { apiKey: 'test-key' });
        expect(result.pairs).toHaveLength(2);
    });

    it('returns empty pairs for empty message list', async () => {
        const result = await distillThread([], { apiKey: 'test-key' });
        expect(result.pairs).toEqual([]);
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('handles LLM returning no pairs', async () => {
        mockCreate.mockResolvedValueOnce({
            choices: [{
                message: { content: JSON.stringify({ pairs: [] }) },
            }],
        });

        const result = await distillThread(sampleMessages, { apiKey: 'test-key' });
        expect(result.pairs).toEqual([]);
    });

    it('handles malformed JSON response gracefully', async () => {
        mockCreate.mockResolvedValueOnce({
            choices: [{
                message: { content: 'not valid json {{{' },
            }],
        });

        const result = await distillThread(sampleMessages, { apiKey: 'test-key' });
        expect(result.pairs).toEqual([]);
    });

    it('handles empty response from LLM', async () => {
        mockCreate.mockResolvedValueOnce({
            choices: [{ message: { content: null } }],
        });

        const result = await distillThread(sampleMessages, { apiKey: 'test-key' });
        expect(result.pairs).toEqual([]);
    });

    it('filters out malformed pairs', async () => {
        mockCreate.mockResolvedValueOnce({
            choices: [{
                message: {
                    content: JSON.stringify({
                        pairs: [
                            { question: 'Valid Q', answer: 'Valid A', confidence: 0.8 },
                            { question: '', answer: 'No question', confidence: 0.5 },
                            { question: 'No answer', answer: '', confidence: 0.5 },
                            { question: 'Bad confidence', answer: 'Answer', confidence: 1.5 },
                            { question: 'Missing confidence', answer: 'Answer' },
                        ],
                    }),
                },
            }],
        });

        const result = await distillThread(sampleMessages, { apiKey: 'test-key' });
        expect(result.pairs).toHaveLength(1);
        expect(result.pairs[0].question).toBe('Valid Q');
    });

    it('handles missing pairs array in response', async () => {
        mockCreate.mockResolvedValueOnce({
            choices: [{
                message: { content: JSON.stringify({ data: 'wrong key' }) },
            }],
        });

        const result = await distillThread(sampleMessages, { apiKey: 'test-key' });
        expect(result.pairs).toEqual([]);
    });

    it('truncates messages to maxMessages', async () => {
        const manyMessages = Array.from({ length: 150 }, (_, i) => ({
            author: 'User',
            content: `Message ${i}`,
            timestamp: `2024-01-15 ${i}`,
        }));

        mockCreate.mockResolvedValueOnce({
            choices: [{ message: { content: JSON.stringify({ pairs: [] }) } }],
        });

        await distillThread(manyMessages, { apiKey: 'test-key', maxMessages: 50 });

        const callArgs = mockCreate.mock.calls[0][0];
        const userContent = callArgs.messages[1].content;
        // Should only contain 50 messages
        const messageCount = (userContent.match(/User:/g) || []).length;
        expect(messageCount).toBe(50);
    });

    it('includes reactions in transcript', async () => {
        const messagesWithReactions: ThreadMessage[] = [
            {
                author: 'Alice',
                content: 'Question?',
                timestamp: '2024-01-15',
                reactions: [{ name: 'eyes', count: 2 }],
            },
        ];

        mockCreate.mockResolvedValueOnce({
            choices: [{ message: { content: JSON.stringify({ pairs: [] }) } }],
        });

        await distillThread(messagesWithReactions, { apiKey: 'test-key' });

        const callArgs = mockCreate.mock.calls[0][0];
        const userContent = callArgs.messages[1].content;
        expect(userContent).toContain(':eyes: x2');
    });

    it('re-throws API errors (not JSON parse errors)', async () => {
        const apiError = new Error('API quota exceeded');
        mockCreate.mockRejectedValueOnce(apiError);

        await expect(distillThread(sampleMessages, { apiKey: 'test-key' })).rejects.toThrow('API quota exceeded');
    });

    it('uses specified model', async () => {
        mockCreate.mockResolvedValueOnce({
            choices: [{ message: { content: JSON.stringify({ pairs: [] }) } }],
        });

        await distillThread(sampleMessages, { apiKey: 'test-key', model: 'gpt-4o' });

        const callArgs = mockCreate.mock.calls[0][0];
        expect(callArgs.model).toBe('gpt-4o');
    });
});
