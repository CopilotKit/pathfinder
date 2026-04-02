import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerCollectTool } from '../mcp/tools/collect.js';
import type { CollectToolConfig } from '../types.js';

vi.mock('../db/queries.js', () => ({
    insertCollectedData: vi.fn(),
}));

import { insertCollectedData } from '../db/queries.js';

const toolConfig: CollectToolConfig = {
    name: 'submit-feedback',
    type: 'collect',
    description: 'Submit feedback on search results.',
    response: 'Feedback recorded. Thank you.',
    schema: {
        tool_name: { type: 'string', description: 'Which search tool', required: true },
        query: { type: 'string', description: 'The query', required: true },
        rating: { type: 'enum', values: ['helpful', 'not_helpful'], description: 'Rating', required: true },
        comment: { type: 'string', description: 'Details', required: true },
    },
};

describe('collect tool via MCP protocol', () => {
    let client: Client;
    let server: McpServer;

    beforeAll(async () => {
        server = new McpServer({ name: 'test', version: '1.0.0' });
        registerCollectTool(server, toolConfig);

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);

        client = new Client({ name: 'test-client', version: '1.0.0' });
        await client.connect(clientTransport);
    });

    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterAll(async () => {
        await client.close();
        await server.close();
    });

    it('lists the collect tool', async () => {
        const { tools } = await client.listTools();
        const tool = tools.find(t => t.name === 'submit-feedback');

        expect(tool).toBeDefined();
        expect(tool!.description).toBe(toolConfig.description);
        expect(tool!.inputSchema.properties).toHaveProperty('tool_name');
        expect(tool!.inputSchema.properties).toHaveProperty('rating');
    });

    it('calls the tool, returns canned response, and writes to DB', async () => {
        const args = {
            tool_name: 'search-docs',
            query: 'how to auth',
            rating: 'not_helpful',
            comment: 'Docs referenced a deprecated API',
        };

        const result = await client.callTool({
            name: 'submit-feedback',
            arguments: args,
        });

        expect(result.isError).toBeFalsy();
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        expect(text).toBe('Feedback recorded. Thank you.');

        expect(insertCollectedData).toHaveBeenCalledWith('submit-feedback', args);
    });

    it('returns generic error on DB failure', async () => {
        vi.mocked(insertCollectedData).mockRejectedValueOnce(
            new Error('connection refused to 10.0.0.5:5432'),
        );

        const result = await client.callTool({
            name: 'submit-feedback',
            arguments: {
                tool_name: 'search-docs',
                query: 'test',
                rating: 'helpful',
                comment: 'worked',
            },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        expect(text).toBe('Error: Failed to store data. Please try again later.');
        expect(text).not.toContain('10.0.0.5');
    });

    it('rejects invalid input', async () => {
        const result = await client.callTool({
            name: 'submit-feedback',
            arguments: {
                tool_name: 'search-docs',
                // missing required fields
            },
        });

        expect(result.isError).toBe(true);
    });
});
