import { describe, it, expect } from 'vitest';
import { chunkSlack } from '../indexing/chunking/slack.js';
import { getChunker } from '../indexing/chunking/index.js';
import type { SourceConfig } from '../types.js';

// Minimal config for the chunker — Slack chunker doesn't use most fields
const slackConfig = {
    name: 'slack-test',
    type: 'slack' as const,
    channels: ['C001'],
    chunk: { target_tokens: 600, overlap_tokens: 0 },
    confidence_threshold: 0.7,
    trigger_emoji: 'pathfinder',
    min_thread_replies: 2,
} satisfies SourceConfig;

describe('chunkSlack', () => {
    it('returns a single chunk for a Q&A pair', () => {
        const content = 'Q: How do I install CopilotKit?\n\nA: Run npm install @copilotkit/react-core and wrap your app with the CopilotKit provider.';
        const chunks = chunkSlack(content, 'C001:1234.5678:0', slackConfig);

        expect(chunks).toHaveLength(1);
        expect(chunks[0].content).toBe(content);
        expect(chunks[0].chunkIndex).toBe(0);
    });

    it('extracts question as title', () => {
        const content = 'Q: How do I configure SSR?\n\nA: Use the runtime provider with your API key.';
        const chunks = chunkSlack(content, 'C001:1234.5678:0', slackConfig);

        expect(chunks[0].title).toBe('How do I configure SSR?');
    });

    it('returns empty array for empty content', () => {
        expect(chunkSlack('', 'C001:1234:0', slackConfig)).toEqual([]);
        expect(chunkSlack('   ', 'C001:1234:0', slackConfig)).toEqual([]);
    });

    it('handles content without Q: prefix gracefully', () => {
        const content = 'Some content without the expected format';
        const chunks = chunkSlack(content, 'C001:1234:0', slackConfig);

        expect(chunks).toHaveLength(1);
        expect(chunks[0].title).toBeUndefined();
    });
});

describe('slack chunker registration', () => {
    it('is registered in the chunker registry', () => {
        const chunker = getChunker('slack');
        expect(chunker).toBe(chunkSlack);
    });
});
