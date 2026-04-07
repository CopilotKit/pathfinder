import { z } from 'zod';
import type { Bash } from 'just-bash';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BashToolConfig } from '../../types.js';
import { BashSessionState } from './bash-session.js';
import { parseGrepCommand, parseQmdCommand, vectorGrep } from './bash-grep.js';
import { parseRelatedCommand, handleRelatedCommand, formatGrepMissSuggestion } from './bash-related.js';
import { searchChunks, textSearchChunks } from '../../db/queries.js';
import type { EmbeddingClient } from '../../indexing/embeddings.js';
import type { BashTelemetry } from './bash-telemetry.js';
import type { WorkspaceManager } from '../../workspace.js';

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

/** Extracts the target directory from a bare `cd <path>` command. */
export function parseBareCD(command: string): string | null {
    const trimmed = command.trim();
    const match = trimmed.match(/^cd\s+((?:[^\s;&|])+)\s*$/);
    if (match) return match[1];
    if (trimmed === 'cd') return '/';
    return null;
}

export interface BashToolOptions {
    sessionState?: BashSessionState;
    /** Lazy resolver for session state — called on first tool invocation. */
    getSessionState?: () => BashSessionState | undefined;
    /** Embedding client for vector-backed grep. */
    embeddingClient?: EmbeddingClient;
    /** Names of search tools, used for grep-miss suggestions. */
    searchToolNames?: string[];
    /** Telemetry recorder for commands, file accesses, and grep misses. */
    telemetry?: BashTelemetry;
    /** Workspace manager for /workspace/ file operations. */
    workspace?: WorkspaceManager;
    /** Resolver for session ID — used by workspace interception. */
    getSessionId?: () => string | undefined;
}

export function registerBashTool(
    server: McpServer,
    toolConfig: BashToolConfig,
    bash: Bash,
    options?: BashToolOptions,
): void {
    const sessionEnabled = toolConfig.bash?.session_state === true;

    // Session state can be provided directly or via a lazy resolver.
    // The lazy resolver is useful when the session ID isn't known at registration time.
    let resolvedSessionState: BashSessionState | null | undefined;
    function getSessionState(): BashSessionState | null {
        if (resolvedSessionState !== undefined) return resolvedSessionState;
        if (!sessionEnabled) { resolvedSessionState = null; return null; }
        if (options?.sessionState) { resolvedSessionState = options.sessionState; return resolvedSessionState; }
        if (options?.getSessionState) {
            const state = options.getSessionState();
            if (state) { resolvedSessionState = state; return state; }
            // Resolver returned undefined — not ready yet, try again next call
            return null;
        }
        resolvedSessionState = new BashSessionState();
        return resolvedSessionState;
    }

    const inputSchema = {
        command: z.string().describe("Bash command to execute (e.g., find, grep, cat, head, ls)"),
    };

    server.tool(
        toolConfig.name,
        toolConfig.description,
        inputSchema,
        async ({ command }) => {
            try {
                const sessionState = getSessionState();
                const cwd = sessionState?.getCwd() ?? '/';

                // Handle bare `cd <path>` — update session CWD without exec
                if (sessionState) {
                    const cdTarget = parseBareCD(command);
                    if (cdTarget !== null) {
                        const resolved = sessionState.resolvePath(cdTarget);
                        // Verify directory exists in virtual FS
                        const check = await bash.exec(`test -d "${resolved}" && echo ok || echo fail`, { cwd: '/' });
                        if (check.stdout.trim() !== 'ok') {
                            return {
                                content: [{ type: "text" as const, text: formatBashResult(command, {
                                    stdout: '',
                                    stderr: `cd: ${cdTarget}: No such file or directory\n`,
                                    exitCode: 1,
                                }) }],
                            };
                        }
                        sessionState.setCwd(resolved);
                        return {
                            content: [{ type: "text" as const, text: formatBashResult(command, { stdout: '', stderr: '', exitCode: 0 }) }],
                        };
                    }
                }

                // Intercept `related <path>` command
                if (options?.embeddingClient) {
                    const rel = parseRelatedCommand(command);
                    if (rel.isRelated) {
                        const resolvedPath = sessionState ? sessionState.resolvePath(rel.path) : rel.path;
                        // Try to get file content from bash instance
                        const escaped = resolvedPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                        const catResult = await bash.exec(`cat "${escaped}"`, { cwd: '/' });
                        const fileContent = catResult.exitCode === 0 ? catResult.stdout : undefined;
                        const relResult = await handleRelatedCommand(
                            resolvedPath, fileContent, options.embeddingClient,
                            (emb, lim) => searchChunks(emb, lim),
                        );
                        return {
                            content: [{ type: "text" as const, text: formatBashResult(command, relResult) }],
                        };
                    }
                }

                // Intercept `qmd` command for vector-backed semantic search
                const grepStrategy = toolConfig.bash?.grep_strategy;
                if (grepStrategy && grepStrategy !== 'memory' && options?.embeddingClient) {
                    const qmd = parseQmdCommand(command);
                    if (qmd.isQmd) {
                        const qmdResult = await vectorGrep({
                            pattern: qmd.query,
                            sourceName: undefined,  // search all sources
                            embeddingClient: options.embeddingClient,
                            searchChunksFn: searchChunks,
                            textSearchFn: textSearchChunks,
                        });
                        return {
                            content: [{ type: "text" as const, text: formatBashResult(command, qmdResult) }],
                        };
                    }
                }

                // Intercept workspace commands (/workspace/ virtual directory)
                if (options?.workspace && options?.getSessionId) {
                    const sid = options.getSessionId();
                    if (sid) {
                        const trimmedCmd = command.trim();

                        // Write: echo "..." > /workspace/file or cat ... > /workspace/file
                        const writeMatch = trimmedCmd.match(/^(?:echo\s+.*?|cat\s+.*?)>\s*\/workspace\/(.+)/);
                        if (writeMatch) {
                            const filename = writeMatch[1].trim();
                            options.workspace.ensureSession(sid);
                            const contentResult = await bash.exec(trimmedCmd.replace(/>\s*\/workspace\/.*$/, ''), { cwd });
                            if (contentResult.exitCode === 0) {
                                const ok = options.workspace.writeFile(sid, filename, contentResult.stdout);
                                if (!ok) {
                                    return { content: [{ type: "text" as const, text: formatBashResult(command, { stdout: '', stderr: 'workspace: quota exceeded', exitCode: 1 }) }] };
                                }
                                return { content: [{ type: "text" as const, text: formatBashResult(command, { stdout: `Written to /workspace/${filename}`, stderr: '', exitCode: 0 }) }] };
                            } else {
                                return { content: [{ type: "text" as const, text: formatBashResult(command, contentResult) }] };
                            }
                        }

                        // Read: cat/head/tail /workspace/file
                        const readMatch = trimmedCmd.match(/^(cat|head|tail)\s+\/workspace\/(.+)/);
                        if (readMatch) {
                            options.workspace.ensureSession(sid);
                            const content = options.workspace.readFile(sid, readMatch[2].trim());
                            if (content === null) {
                                return { content: [{ type: "text" as const, text: formatBashResult(command, { stdout: '', stderr: `cat: /workspace/${readMatch[2].trim()}: No such file`, exitCode: 1 }) }] };
                            }
                            return { content: [{ type: "text" as const, text: formatBashResult(command, { stdout: content, stderr: '', exitCode: 0 }) }] };
                        }

                        // List: ls [-flags] /workspace[/subdir]
                        const lsMatch = trimmedCmd.match(/^ls\s+(?:-\S+\s+)?\/workspace\/?(.*)$/);
                        if (lsMatch) {
                            options.workspace.ensureSession(sid);
                            const subdir = lsMatch[1]?.trim() || undefined;
                            const files = options.workspace.listFiles(sid, subdir);
                            return { content: [{ type: "text" as const, text: formatBashResult(command, { stdout: files.join('\n'), stderr: '', exitCode: 0 }) }] };
                        }

                        // Catch-all: unrecognized /workspace/ command
                        if (trimmedCmd.includes('/workspace/') || trimmedCmd.includes('/workspace')) {
                            return { content: [{ type: "text" as const, text: formatBashResult(command, {
                                stdout: '',
                                stderr: 'workspace: supported operations are:\n  echo "content" > /workspace/file\n  cat /workspace/file\n  head /workspace/file\n  tail /workspace/file\n  ls /workspace/\n  ls /workspace/subdir/',
                                exitCode: 1,
                            }) }] };
                        }
                    }
                }

                const result = await bash.exec(command, { cwd });

                // Record command telemetry (fire-and-forget)
                options?.telemetry?.recordCommand(command);

                // Detect file access commands (cat/head/tail) for telemetry
                const fileAccessMatch = command.match(/^(cat|head|tail)\s+(.+)/);
                if (fileAccessMatch) {
                    const filePath = fileAccessMatch[2].trim().replace(/^["']|["']$/g, '');
                    options?.telemetry?.recordFileAccess(filePath, command);
                }

                // Append grep-miss suggestion when grep returns no results
                if (options?.searchToolNames && options.searchToolNames.length > 0) {
                    const parsed = parseGrepCommand(command);
                    if (parsed.isGrep && result.exitCode === 1 && !result.stdout.trim()) {
                        options?.telemetry?.recordGrepMiss(parsed.pattern ?? command, command);
                        const suggestion = formatGrepMissSuggestion(options.searchToolNames);
                        return {
                            content: [{ type: "text" as const, text: formatBashResult(command, { ...result, stderr: (result.stderr || '') + suggestion }) }],
                        };
                    }
                }

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
