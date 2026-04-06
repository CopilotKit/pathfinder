import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Bash } from 'just-bash';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerBashTool } from '../mcp/tools/bash.js';
import type { BashToolConfig } from '../types.js';

const files: Record<string, string> = {
    '/docs/quickstart.mdx': '# Quickstart\n\nGet started with CopilotKit.',
    '/docs/guides/streaming.mdx': '# Streaming\n\nHow to use streaming with useCoAgent.',
    '/docs/guides/generative-ui.mdx': '# Generative UI\n\nBuild dynamic interfaces.',
    '/code/src/hooks/useCoAgent.ts': 'export function useCoAgent() { return {}; }',
    '/code/src/hooks/useCopilotChat.ts': 'export function useCopilotChat() { return {}; }',
    '/code/src/index.ts': "export { useCoAgent } from './hooks/useCoAgent';\nexport { useCopilotChat } from './hooks/useCopilotChat';",
};

const toolConfig: BashToolConfig = {
    name: 'explore-docs',
    type: 'bash',
    description: 'Explore documentation and code files using bash commands.',
    sources: ['docs', 'code'],
};

describe('bash tool via MCP protocol', () => {
    let client: Client;
    let server: McpServer;

    beforeAll(async () => {
        server = new McpServer({ name: 'test', version: '1.0.0' });
        const bash = new Bash({ files, cwd: '/' });
        registerBashTool(server, toolConfig, bash);

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);

        client = new Client({ name: 'test-client', version: '1.0.0' });
        await client.connect(clientTransport);
    });

    afterAll(async () => {
        await client.close();
        await server.close();
    });

    function callBash(command: string) {
        return client.callTool({
            name: 'explore-docs',
            arguments: { command },
        });
    }

    function getText(result: Awaited<ReturnType<typeof callBash>>): string {
        return (result.content as Array<{ type: string; text: string }>)[0].text;
    }

    it('lists the bash tool with correct schema', async () => {
        const { tools } = await client.listTools();
        const tool = tools.find(t => t.name === 'explore-docs');

        expect(tool).toBeDefined();
        expect(tool!.description).toBe(toolConfig.description);
        expect(tool!.inputSchema.properties).toHaveProperty('command');
    });

    it('discovers files with find', async () => {
        const result = await callBash('find / -name "*.mdx" | sort');
        const text = getText(result);

        expect(result.isError).toBeFalsy();
        expect(text).toContain('/docs/quickstart.mdx');
        expect(text).toContain('/docs/guides/streaming.mdx');
        expect(text).toContain('/docs/guides/generative-ui.mdx');
    });

    it('reads file contents with cat', async () => {
        const result = await callBash('cat /docs/quickstart.mdx');
        const text = getText(result);

        expect(result.isError).toBeFalsy();
        expect(text).toContain('# Quickstart');
        expect(text).toContain('Get started with CopilotKit.');
    });

    it('searches across files with grep', async () => {
        const result = await callBash('grep -rl "useCoAgent" /');
        const text = getText(result);

        expect(result.isError).toBeFalsy();
        expect(text).toContain('/docs/guides/streaming.mdx');
        expect(text).toContain('/code/src/hooks/useCoAgent.ts');
        expect(text).toContain('/code/src/index.ts');
    });

    it('supports piped commands', async () => {
        const result = await callBash('find /code -name "*.ts" | wc -l');
        const text = getText(result);

        expect(result.isError).toBeFalsy();
        expect(text).toContain('3');
    });

    it('starts from / on every call', async () => {
        await callBash('cd /docs/guides');
        const result = await callBash('pwd');
        const text = getText(result);

        expect(text).toBe('$ pwd\n/\n');
    });

    it('returns exit code on failure', async () => {
        const result = await callBash('cat /nonexistent');
        const text = getText(result);

        expect(result.isError).toBeFalsy();
        expect(text).toContain('[exit code 1]');
    });

    it('handles inline cd within a single command', async () => {
        const result = await callBash('cd /docs && ls');
        const text = getText(result);

        expect(result.isError).toBeFalsy();
        expect(text).toContain('quickstart.mdx');
        expect(text).toContain('guides');
    });
});
