import { z } from "zod-v4";
import { Bash, InMemoryFs, MountableFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import type { McpServer } from "@modelcontextprotocol/server";
import type { BashToolConfig } from "../../types.js";
import { BashSessionState } from "./bash-session.js";
import { parseGrepCommand, parseQmdCommand, vectorGrep } from "./bash-grep.js";
import {
  parseRelatedCommand,
  handleRelatedCommand,
  formatGrepMissSuggestion,
} from "./bash-related.js";
import { searchChunks, textSearchChunks } from "../../db/queries.js";
import type { EmbeddingProvider } from "../../indexing/embeddings.js";
import type { BashTelemetry } from "./bash-telemetry.js";
import type { WorkspaceManager } from "../../workspace.js";

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
  return parts.join("\n");
}

/**
 * `s` as one single-quoted shell word: the shell reads it as a literal, so
 * `$(...)`, backticks, `$VAR` and quotes in it never run or expand.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * A bare `cd` target with one pair of outer quotes removed, when the quoted
 * text is plain (`'/docs'`, `"/docs"`). Anything else is returned as is and
 * is then checked as a literal path.
 */
function unquoteCdTarget(target: string): string {
  const single = /^'([^']*)'$/.exec(target);
  if (single) return single[1];
  const double = /^"([^"$`\\]*)"$/.exec(target);
  if (double) return double[1];
  return target;
}

/** Extracts the target directory from a bare `cd <path>` command. */
export function parseBareCD(command: string): string | null {
  const trimmed = command.trim();
  const match = trimmed.match(/^cd\s+((?:[^\s;&|])+)\s*$/);
  if (match) return match[1];
  if (trimmed === "cd") return "/";
  return null;
}

/**
 * Appended to the bash tool description and returned for a bare `cd` on
 * 2026-07-28 (modern, stateless) connections, where no cwd survives a call.
 */
export const MODERN_CD_HINT =
  "cd does not persist between calls on this connection; use absolute paths or `cd X && <cmd>`";

/**
 * Returned (exit code 1) on a 2026-07-28 (modern, stateless) connection with
 * the workspace enabled, for any command whose file operations reach
 * `/workspace` or a path below it: the workspace is keyed by session ID, which
 * modern connections do not have. The check is on the path the shell resolves
 * (see scratchOnlyFs), so `//workspace`, `/docs/../workspace`, braces and
 * relative paths count, while text such as `grep "/workspace" /docs` and
 * paths such as `/docs/workspace-setup.mdx` or `/workspaces` do not.
 */
export const MODERN_WORKSPACE_REFUSAL =
  "workspace: /workspace is unavailable on 2026-07-28 connections; it works only on 2025-era (session) connections";

/** Start of the error for a write outside /tmp (same wording as just-bash). */
export const READ_ONLY_ERROR = "EROFS: read-only file system";

const readOnlyError = (p: string): Error =>
  new Error(`${READ_ONLY_ERROR}, ${p} (only /tmp is writable)`);

/** The segments of `p`, read from "/" with `//`, `.` and `..` collapsed. */
function segmentsOf(p: string): string[] {
  const segments: string[] = [];
  for (const segment of p.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments;
}

/** The first segment of `p`, read from "/" with `//`, `.` and `..` collapsed. */
function topDir(p: string): string | undefined {
  return segmentsOf(p)[0];
}

/** Write targets whose data is thrown away, as on a real system. */
const SINKS = new Set(["/dev/null", "/dev/zero"]);

/** True when `p` is /dev/null or /dev/zero (`//dev/./null` included). */
function isSink(p: string): boolean {
  return SINKS.has(`/${segmentsOf(p).join("/")}`);
}

/**
 * Wraps the per-call view (the shared filesystem with a private /tmp mounted
 * on it) so that only /tmp is writable. A write whose target is anywhere else
 * calls `onWrite` and never reaches the inner filesystem, so no command can
 * change what other clients read. Contract: a write outside /tmp gives an
 * EROFS message and exit 1, the shared filesystem is unchanged, and other
 * output on the command line is best-effort.
 *
 * - writeFile/appendFile (redirects, `tee`, `sed -i`, ...) record the path
 *   and resolve without writing. just-bash throws out of the whole exec()
 *   when a redirect rejects, which would drop the output of every other
 *   statement on the line; exec() adds the EROFS line and exit 1 afterwards.
 * - The other write methods (mkdir, rm, cp, mv, chmod, symlink, link,
 *   utimes) record the path and reject. The command that called them
 *   catches the error, prints its own message and fails, so `touch x ||
 *   fallback` and `mkdir d && ...` still see the failure, and the rest of
 *   the line still runs.
 * - writeFile, appendFile, cp and utimes whose target is /dev/null or
 *   /dev/zero succeed and are discarded. They are not recorded and do not
 *   reach the inner filesystem: in just-bash /dev/null is an ordinary shared
 *   file, so passing them through would let one client read another's data.
 * With `onWorkspace` set, any operation on a `/workspace` path
 * calls it and throws MODERN_WORKSPACE_REFUSAL instead. just-bash resolves
 * braces, quotes, escapes, variables and relative paths before it calls the
 * filesystem, so both checks see the real target.
 */
function scratchOnlyFs(
  inner: IFileSystem,
  onWrite: (p: string) => void,
  onWorkspace?: () => void,
): IFileSystem {
  const check = (...paths: string[]): void => {
    if (!onWorkspace) return;
    for (const p of paths) {
      if (topDir(p) === "workspace") {
        onWorkspace();
        throw new Error(`${p}: ${MODERN_WORKSPACE_REFUSAL}`);
      }
    }
  };
  // Every path in `written` must be under /tmp. A refused content write
  // (`soft`) resolves; any other refused write rejects.
  const write = (
    written: string[],
    op: () => Promise<void>,
    soft = false,
  ): Promise<void> => {
    check(...written);
    const outside = written.find((p) => topDir(p) !== "tmp");
    if (outside === undefined) return op();
    onWrite(outside);
    return soft ? Promise.resolve() : Promise.reject(readOnlyError(outside));
  };
  // A sink discards the write; anything else goes through `write`.
  const sinkOr = (p: string, go: () => Promise<void>): Promise<void> =>
    isSink(p) ? Promise.resolve() : go();
  const readdirWithFileTypes = inner.readdirWithFileTypes;
  return {
    readFile: async (p, o) => (check(p), inner.readFile(p, o)),
    readFileBuffer: async (p) => (check(p), inner.readFileBuffer(p)),
    exists: async (p) => (check(p), inner.exists(p)),
    stat: async (p) => (check(p), inner.stat(p)),
    lstat: async (p) => (check(p), inner.lstat(p)),
    readdir: async (p) => (check(p), inner.readdir(p)),
    ...(readdirWithFileTypes
      ? {
          readdirWithFileTypes: async (p: string) => (
            check(p),
            readdirWithFileTypes.call(inner, p)
          ),
        }
      : {}),
    readlink: async (p) => (check(p), inner.readlink(p)),
    realpath: async (p) => (check(p), inner.realpath(p)),
    resolvePath: (base, p) => inner.resolvePath(base, p),
    getAllPaths: () => inner.getAllPaths(),
    writeFile: async (p, c, o) =>
      sinkOr(p, () => write([p], () => inner.writeFile(p, c, o), true)),
    appendFile: async (p, c, o) =>
      sinkOr(p, () => write([p], () => inner.appendFile(p, c, o), true)),
    mkdir: async (p, o) => write([p], () => inner.mkdir(p, o)),
    rm: async (p, o) => write([p], () => inner.rm(p, o)),
    cp: async (src, dest, o) => (
      check(src),
      sinkOr(dest, () => write([dest], () => inner.cp(src, dest, o)))
    ),
    mv: async (src, dest) => write([src, dest], () => inner.mv(src, dest)),
    chmod: async (p, m) => write([p], () => inner.chmod(p, m)),
    symlink: async (target, linkPath) =>
      write([linkPath], () => inner.symlink(target, linkPath)),
    link: async (existing, newPath) => (
      check(existing),
      write([newPath], () => inner.link(existing, newPath))
    ),
    utimes: async (p, a, m) =>
      sinkOr(p, () => write([p], () => inner.utimes(p, a, m))),
  };
}

const MODERN_WORKSPACE_NOTE =
  "/workspace is available only on 2025-era (session) connections.";

/** Appended to the modern tool description: the filesystem contract. */
export const MODERN_FS_NOTE =
  "The filesystem is read-only. /tmp is writable scratch space that is private to this call and discarded after it.";

export interface BashToolOptions {
  sessionState?: BashSessionState;
  /** Lazy resolver for session state — called on first tool invocation. */
  getSessionState?: () => BashSessionState | undefined;
  /** Embedding provider for vector-backed grep. */
  embeddingClient?: EmbeddingProvider;
  /** Names of search tools, used for grep-miss suggestions. */
  searchToolNames?: string[];
  /** Telemetry recorder for commands, file accesses, and grep misses. */
  telemetry?: BashTelemetry;
  /** Workspace manager for /workspace/ file operations. */
  workspace?: WorkspaceManager;
  /** Resolver for session ID — used by workspace interception. */
  getSessionId?: () => string | undefined;
  /** Callback invoked when a tool handler fires, for session-used tracking. */
  onToolCall?: () => void;
  /**
   * Protocol era of the connection. `"modern"` (2026-07-28, stateless) never
   * uses session state: cwd is always "/" and a bare `cd` returns
   * MODERN_CD_HINT. `undefined` or `"legacy"` keeps the session behaviour.
   */
  era?: "legacy" | "modern";
  /**
   * Aborts the command when it fires (just-bash stops at the next statement
   * boundary; `sleep` wakes at once). The modern leg passes the request's
   * deadline signal. Legacy callers omit it.
   */
  signal?: AbortSignal;
}

export function registerBashTool(
  server: McpServer,
  toolConfig: BashToolConfig,
  bash: Bash,
  options?: BashToolOptions,
): void {
  const modern = options?.era === "modern";
  const sessionEnabled = !modern && toolConfig.bash?.session_state === true;

  // Session state can be provided directly or via a lazy resolver.
  // The lazy resolver is useful when the session ID isn't known at registration time.
  let resolvedSessionState: BashSessionState | null | undefined;
  function getSessionState(): BashSessionState | null {
    if (resolvedSessionState !== undefined) return resolvedSessionState;
    if (!sessionEnabled) {
      resolvedSessionState = null;
      return null;
    }
    if (options?.sessionState) {
      resolvedSessionState = options.sessionState;
      return resolvedSessionState;
    }
    if (options?.getSessionState) {
      const state = options.getSessionState();
      if (state) {
        resolvedSessionState = state;
        return state;
      }
      // Resolver returned undefined — not ready yet, try again next call
      return null;
    }
    resolvedSessionState = new BashSessionState();
    return resolvedSessionState;
  }

  // Every command runs over a read-only view of the shared filesystem, which
  // every client of this tool reads, with a private /tmp mounted on top.
  // Modern: a new /tmp for each call, discarded after it. Legacy: one /tmp
  // for this registration, which is one session (the legacy handlers build a
  // server per session), discarded with it.
  // Modern with the workspace on also refuses /workspace paths (returns null)
  // unless /workspace is part of the shared docs tree.
  const sessionTmp = modern ? undefined : new InMemoryFs();
  async function exec(
    commandLine: string,
    execOptions: { cwd: string; signal?: AbortSignal },
  ): Promise<ExecResult | null> {
    const refuseWorkspace =
      modern &&
      options?.workspace !== undefined &&
      !(await bash.fs.exists("/workspace"));
    let refused = false;
    const writes: string[] = [];
    const view = new Bash({
      fs: scratchOnlyFs(
        new MountableFs({
          base: bash.fs,
          mounts: [
            { mountPoint: "/tmp", filesystem: sessionTmp ?? new InMemoryFs() },
          ],
        }),
        (p) => writes.push(p),
        refuseWorkspace
          ? () => {
              refused = true;
            }
          : undefined,
      ),
      cwd: "/",
    });
    let result: ExecResult;
    try {
      result = await view.exec(commandLine, execOptions);
    } catch (error) {
      // A refused redirect resolves (see scratchOnlyFs), so this is a
      // fallback: if a refused write still throws out of exec(), report it
      // as a failed command instead of an error.
      if (refused) return null;
      if (writes.length === 0) throw error;
      result = { stdout: "", stderr: "", exitCode: 1 };
    }
    if (refused) return null;
    // A refused redirect and `rm -f` print no error, so say it here.
    if (writes.length > 0 && !result.stderr.includes(READ_ONLY_ERROR)) {
      result = {
        stdout: result.stdout,
        stderr: `${result.stderr}${readOnlyError(writes[0]).message}\n`,
        exitCode: result.exitCode || 1,
      };
    }
    return result;
  }
  const refusal = (command: string) => ({
    content: [
      {
        type: "text" as const,
        text: formatBashResult(command, {
          stdout: "",
          stderr: MODERN_WORKSPACE_REFUSAL,
          exitCode: 1,
        }),
      },
    ],
  });

  const inputSchema = z.object({
    command: z
      .string()
      .describe("Bash command to execute (e.g., find, grep, cat, head, ls)"),
  });

  server.registerTool(
    toolConfig.name,
    {
      description: modern
        ? `${toolConfig.description}\n\n${MODERN_CD_HINT}\n\n${MODERN_FS_NOTE}${
            options?.workspace ? `\n\n${MODERN_WORKSPACE_NOTE}` : ""
          }`
        : toolConfig.description,
      inputSchema,
    },
    async ({ command }) => {
      options?.onToolCall?.();
      try {
        const sessionState = getSessionState();
        const cwd = sessionState?.getCwd() ?? "/";

        // Modern (stateless): a bare `cd` cannot persist. Check the target
        // from "/" and answer with the hint instead of changing any state.
        if (modern) {
          const cdTarget = parseBareCD(command);
          if (cdTarget !== null) {
            const resolved = new BashSessionState().resolvePath(
              unquoteCdTarget(cdTarget),
            );
            const check = await exec(
              `test -d ${shellQuote(resolved)} && echo ok || echo fail`,
              options?.signal
                ? { cwd: "/", signal: options.signal }
                : { cwd: "/" },
            );
            if (check === null) return refusal(command);
            // The check itself failed (exit 124: the deadline aborted it).
            // Report that, not a missing directory.
            if (check.exitCode !== 0) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: formatBashResult(command, check),
                  },
                ],
              };
            }
            const exists = check.stdout.trim() === "ok";
            return {
              content: [
                {
                  type: "text" as const,
                  text: formatBashResult(command, {
                    stdout: exists ? MODERN_CD_HINT : "",
                    stderr: exists
                      ? ""
                      : `cd: ${cdTarget}: No such file or directory\n`,
                    exitCode: exists ? 0 : 1,
                  }),
                },
              ],
            };
          }
        }

        // Handle bare `cd <path>` — update session CWD without exec
        if (sessionState) {
          const cdTarget = parseBareCD(command);
          if (cdTarget !== null) {
            const resolved = sessionState.resolvePath(cdTarget);
            // Verify the directory exists (shared files or this session's /tmp)
            const check = await exec(
              `test -d "${resolved}" && echo ok || echo fail`,
              { cwd: "/" },
            );
            if (check?.stdout.trim() !== "ok") {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: formatBashResult(command, {
                      stdout: "",
                      stderr: `cd: ${cdTarget}: No such file or directory\n`,
                      exitCode: 1,
                    }),
                  },
                ],
              };
            }
            sessionState.setCwd(resolved);
            return {
              content: [
                {
                  type: "text" as const,
                  text: formatBashResult(command, {
                    stdout: "",
                    stderr: "",
                    exitCode: 0,
                  }),
                },
              ],
            };
          }
        }

        // Intercept `related <path>` command
        if (options?.embeddingClient) {
          const rel = parseRelatedCommand(command);
          if (rel.isRelated) {
            // Modern (stateless) has no session cwd: resolve from "/", the
            // same as the modern bare `cd`, so the queried file matches its
            // own hit and is not listed as related to itself.
            const resolvedPath = sessionState
              ? sessionState.resolvePath(rel.path)
              : modern
                ? new BashSessionState().resolvePath(rel.path)
                : rel.path;
            // Try to get file content from bash instance
            const catResult = await exec(
              `cat ${shellQuote(resolvedPath)}`,
              options?.signal
                ? { cwd: "/", signal: options.signal }
                : { cwd: "/" },
            );
            if (catResult === null) return refusal(command);
            const fileContent =
              catResult.exitCode === 0 ? catResult.stdout : undefined;
            const relResult = await handleRelatedCommand(
              resolvedPath,
              fileContent,
              options.embeddingClient,
              (emb, lim) => searchChunks(emb, lim),
            );
            return {
              content: [
                {
                  type: "text" as const,
                  text: formatBashResult(command, relResult),
                },
              ],
            };
          }
        }

        // Intercept `qmd` command for vector-backed semantic search
        const grepStrategy = toolConfig.bash?.grep_strategy;
        if (
          grepStrategy &&
          grepStrategy !== "memory" &&
          options?.embeddingClient
        ) {
          const qmd = parseQmdCommand(command);
          if (qmd.isQmd) {
            const qmdResult = await vectorGrep({
              pattern: qmd.query,
              sourceName: undefined, // search all sources
              embeddingClient: options.embeddingClient,
              searchChunksFn: searchChunks,
              textSearchFn: textSearchChunks,
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text: formatBashResult(command, qmdResult),
                },
              ],
            };
          }
        }

        // Intercept workspace commands (/workspace/ virtual directory).
        // 2025-era only: a modern command never reaches WorkspaceManager, even
        // if a session id were present; its /workspace paths are refused by
        // exec() instead.
        if (!modern && options?.workspace && options?.getSessionId) {
          const sid = options.getSessionId();
          if (sid) {
            const trimmedCmd = command.trim();

            // Write: echo "..." > /workspace/file or cat ... > /workspace/file
            const writeMatch = trimmedCmd.match(
              /^(?:echo\s+.*?|cat\s+.*?)>\s*\/workspace\/(.+)/,
            );
            if (writeMatch) {
              const filename = writeMatch[1].trim();
              options.workspace.ensureSession(sid);
              const contentResult = await exec(
                trimmedCmd.replace(/>\s*\/workspace\/.*$/, ""),
                { cwd },
              );
              if (contentResult === null) return refusal(command);
              if (contentResult.exitCode === 0) {
                const ok = options.workspace.writeFile(
                  sid,
                  filename,
                  contentResult.stdout,
                );
                if (!ok) {
                  return {
                    content: [
                      {
                        type: "text" as const,
                        text: formatBashResult(command, {
                          stdout: "",
                          stderr: "workspace: quota exceeded",
                          exitCode: 1,
                        }),
                      },
                    ],
                  };
                }
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: formatBashResult(command, {
                        stdout: `Written to /workspace/${filename}`,
                        stderr: "",
                        exitCode: 0,
                      }),
                    },
                  ],
                };
              } else {
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: formatBashResult(command, contentResult),
                    },
                  ],
                };
              }
            }

            // Read: cat/head/tail /workspace/file
            const readMatch = trimmedCmd.match(
              /^(cat|head|tail)\s+\/workspace\/(.+)/,
            );
            if (readMatch) {
              options.workspace.ensureSession(sid);
              const content = options.workspace.readFile(
                sid,
                readMatch[2].trim(),
              );
              if (content === null) {
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: formatBashResult(command, {
                        stdout: "",
                        stderr: `cat: /workspace/${readMatch[2].trim()}: No such file`,
                        exitCode: 1,
                      }),
                    },
                  ],
                };
              }
              return {
                content: [
                  {
                    type: "text" as const,
                    text: formatBashResult(command, {
                      stdout: content,
                      stderr: "",
                      exitCode: 0,
                    }),
                  },
                ],
              };
            }

            // List: ls [-flags] /workspace[/subdir]
            const lsMatch = trimmedCmd.match(
              /^ls\s+(?:-\S+\s+)?\/workspace\/?(.*)$/,
            );
            if (lsMatch) {
              options.workspace.ensureSession(sid);
              const subdir = lsMatch[1]?.trim() || undefined;
              const files = options.workspace.listFiles(sid, subdir);
              return {
                content: [
                  {
                    type: "text" as const,
                    text: formatBashResult(command, {
                      stdout: files.join("\n"),
                      stderr: "",
                      exitCode: 0,
                    }),
                  },
                ],
              };
            }

            // Catch-all: unrecognized /workspace/ command
            if (
              trimmedCmd.includes("/workspace/") ||
              trimmedCmd.includes("/workspace")
            ) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: formatBashResult(command, {
                      stdout: "",
                      stderr:
                        'workspace: supported operations are:\n  echo "content" > /workspace/file\n  cat /workspace/file\n  head /workspace/file\n  tail /workspace/file\n  ls /workspace/\n  ls /workspace/subdir/',
                      exitCode: 1,
                    }),
                  },
                ],
              };
            }
          }
        }

        const signal = options?.signal;
        const result = await exec(command, signal ? { cwd, signal } : { cwd });
        if (result === null) return refusal(command);

        // Record command telemetry (fire-and-forget)
        options?.telemetry?.recordCommand(command);

        // Detect file access commands (cat/head/tail) for telemetry
        const fileAccessMatch = command.match(/^(cat|head|tail)\s+(.+)/);
        if (fileAccessMatch) {
          const filePath = fileAccessMatch[2]
            .trim()
            .replace(/^["']|["']$/g, "");
          options?.telemetry?.recordFileAccess(filePath, command);
        }

        // Append grep-miss suggestion when grep returns no results
        if (options?.searchToolNames && options.searchToolNames.length > 0) {
          const parsed = parseGrepCommand(command);
          if (parsed.isGrep && result.exitCode === 1 && !result.stdout.trim()) {
            options?.telemetry?.recordGrepMiss(
              parsed.pattern ?? command,
              command,
            );
            const suggestion = formatGrepMissSuggestion(
              options.searchToolNames,
            );
            return {
              content: [
                {
                  type: "text" as const,
                  text: formatBashResult(command, {
                    ...result,
                    stderr: (result.stderr || "") + suggestion,
                  }),
                },
              ],
            };
          }
        }

        return {
          content: [
            { type: "text" as const, text: formatBashResult(command, result) },
          ],
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
