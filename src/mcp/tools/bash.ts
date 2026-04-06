import { z } from 'zod';
import type { Bash } from 'just-bash';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BashToolConfig } from '../../types.js';

interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export function formatBashResult(command: string, result: ExecResult): string {
    const parts = [`$ ${command}`];
    if (result.stdout) parts.push(result.stdout);
    if (result.stderr) parts.push(result.stderr);
    if (result.exitCode !== 0) parts.push(`[exit code ${result.exitCode}]`);
    return parts.join('\n');
}

export function registerBashTool(
    server: McpServer,
    toolConfig: BashToolConfig,
    bash: Bash,
): void {
    const inputSchema = {
        command: z.string().describe("Bash command to execute (e.g., find, grep, cat, head, ls)"),
    };

    server.tool(
        toolConfig.name,
        toolConfig.description,
        inputSchema,
        async ({ command }) => {
            try {
                const result = await bash.exec(command, { cwd: '/' });
                return {
                    content: [{ type: "text" as const, text: formatBashResult(command, result) }],
                };
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                console.error(`[${toolConfig.name}] Error: ${detail}`);
                return {
                    content: [{ type: "text" as const, text: `Error: ${detail}` }],
                    isError: true,
                };
            }
        },
    );
}
