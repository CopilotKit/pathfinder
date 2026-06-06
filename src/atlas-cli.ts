#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TOOL = "atlas-search";
const DEFAULT_MCP_URL = "https://mcp.pathfinder.copilotkit.dev/mcp";
const INTEGER_PATTERN = /^[1-9]\d*$/;
const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

type WriteFn = (text: string) => void;

interface AtlasCliIo {
  stdout?: WriteFn;
  stderr?: WriteFn;
}

interface SearchOptions {
  json?: boolean;
  limit?: string;
  minScore?: string;
  token?: string;
  tool?: string;
  url?: string;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: {
    message?: string;
  };
}

interface McpPostResult {
  messages: JsonRpcMessage[];
  sessionId: string | null;
}

function parseSseMessages(text: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  let dataLines: string[] = [];

  const flushEvent = () => {
    if (dataLines.length === 0) {
      return;
    }

    const data = dataLines.join("\n");
    dataLines = [];

    // Skip keepalive / empty `data:` frames: an empty value yields `""`,
    // which would otherwise crash on JSON.parse("").
    if (data.trim() === "") {
      return;
    }

    try {
      messages.push(JSON.parse(data) as JsonRpcMessage);
    } catch {
      // Skip unparseable keepalive frames rather than crashing the search.
    }
  };

  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine === "") {
      flushEvent();
      continue;
    }

    if (!rawLine.startsWith("data:")) {
      continue;
    }

    const data = rawLine.slice(5);
    dataLines.push(data.startsWith(" ") ? data.slice(1) : data);
  }

  flushEvent();

  return messages;
}

async function mcpPost(
  url: string,
  body: unknown,
  options: {
    onSessionId?: (sessionId: string) => void;
    sessionId?: string;
    token?: string;
  } = {},
): Promise<McpPostResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  if (options.sessionId) {
    headers["Mcp-Session-Id"] = options.sessionId;
  }

  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const nextSessionId =
    response.headers.get("mcp-session-id") ?? options.sessionId ?? null;
  if (nextSessionId) {
    options.onSessionId?.(nextSessionId);
  }

  if (response.status === 202) {
    return { messages: [], sessionId: nextSessionId };
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  const text = await response.text();
  const messages = parseSseMessages(text);

  if (messages.length > 0) {
    return { messages, sessionId: nextSessionId };
  }

  if (!text.trim()) {
    return { messages: [], sessionId: nextSessionId };
  }

  try {
    return {
      messages: [JSON.parse(text) as JsonRpcMessage],
      sessionId: nextSessionId,
    };
  } catch {
    throw new Error(`Unparseable response: ${text.slice(0, 200)}`);
  }
}

async function closeMcpSession(
  url: string,
  options: {
    sessionId?: string;
    token?: string;
  },
): Promise<void> {
  if (!options.sessionId) {
    return;
  }

  const headers: Record<string, string> = {
    "Mcp-Session-Id": options.sessionId,
  };

  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  try {
    await fetch(url, {
      method: "DELETE",
      headers,
    });
  } catch {
    // Best-effort cleanup must not mask the search result or original failure.
  }
}

function buildToolArguments(
  query: string,
  options: SearchOptions,
): Record<string, unknown> {
  const args: Record<string, unknown> = { query };

  if (options.limit !== undefined) {
    if (!INTEGER_PATTERN.test(options.limit)) {
      throw new Error("limit must be a positive integer");
    }

    const limit = Number(options.limit);
    if (!Number.isSafeInteger(limit)) {
      throw new Error("limit must be a positive integer");
    }
    args.limit = limit;
  }

  if (options.minScore !== undefined) {
    if (!NUMBER_PATTERN.test(options.minScore)) {
      throw new Error("min-score must be a finite number in [0, 1]");
    }

    const minScore = Number(options.minScore);
    if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
      throw new Error("min-score must be a finite number in [0, 1]");
    }
    args.min_score = minScore;
  }

  return args;
}

function printToolText(message: JsonRpcMessage, write: WriteFn): void {
  const result = message.result as
    | { content?: Array<{ type?: string; text?: string }> }
    | undefined;
  const content = result?.content ?? [];
  const textItems = content
    .map((item) => item.text)
    .filter((text): text is string => typeof text === "string");

  if (textItems.length === 0) {
    write("No results.\n");
    return;
  }

  for (const text of textItems) {
    write(`${text}\n`);
  }
}

async function search(
  query: string,
  options: SearchOptions,
  write: WriteFn,
): Promise<void> {
  const url = options.url ?? process.env.ATLAS_MCP_URL ?? DEFAULT_MCP_URL;
  const token = options.token ?? process.env.ATLAS_TOKEN;
  const tool = options.tool ?? DEFAULT_TOOL;
  const toolArguments = buildToolArguments(query, options);
  let sessionId: string | undefined;
  const recordSessionId = (nextSessionId: string) => {
    sessionId = nextSessionId;
  };

  try {
    const init = await mcpPost(
      url,
      {
        jsonrpc: "2.0",
        method: "initialize",
        id: 0,
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "atlas", version: "1.0.0" },
        },
      },
      { onSessionId: recordSessionId, token },
    );

    sessionId = init.sessionId ?? undefined;
    const initError = init.messages.find((item) => item.error)?.error;
    if (initError) {
      throw new Error(initError.message ?? "MCP initialize failed");
    }

    await mcpPost(
      url,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { onSessionId: recordSessionId, sessionId, token },
    );

    const response = await mcpPost(
      url,
      {
        jsonrpc: "2.0",
        method: "tools/call",
        id: 1,
        params: {
          name: tool,
          arguments: toolArguments,
        },
      },
      { onSessionId: recordSessionId, sessionId, token },
    );

    const message = response.messages.find((item) => item.result ?? item.error);
    if (!message) {
      write(options.json ? "null\n" : "No response.\n");
      return;
    }

    if (message.error) {
      throw new Error(message.error.message ?? "MCP tool call failed");
    }

    if (options.json) {
      write(`${JSON.stringify(message, null, 2)}\n`);
      return;
    }

    printToolText(message, write);
  } finally {
    await closeMcpSession(url, { sessionId, token });
  }
}

export async function runAtlasCli(
  argv: string[] = process.argv.slice(2),
  io: AtlasCliIo = {},
): Promise<number> {
  const writeOut = io.stdout ?? ((text: string) => process.stdout.write(text));
  const writeErr = io.stderr ?? ((text: string) => process.stderr.write(text));

  const program = new Command();
  program
    .name("atlas")
    .description("Agent-facing Atlas search over Pathfinder MCP")
    .exitOverride()
    .configureOutput({
      writeOut,
      writeErr,
      outputError: (text, write) => write(text),
    });

  program
    .command("search")
    .description("Search Atlas knowledge through a Pathfinder MCP endpoint")
    .argument("<query>", "Search query")
    .option("--url <url>", "Pathfinder MCP URL")
    .option("--token <token>", "Bearer token for the MCP endpoint")
    .option("--tool <name>", "MCP tool name", DEFAULT_TOOL)
    .option("--limit <n>", "Maximum number of results")
    .option("--min-score <score>", "Minimum search score")
    .option("--json", "Print the raw MCP JSON-RPC response")
    .action(async (query: string, options: SearchOptions) => {
      await search(query, options, writeOut);
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }

    const message = error instanceof Error ? error.message : String(error);
    writeErr(`error: ${message}\n`);
    return 1;
  }
}

export function isAtlasCliEntrypoint(
  moduleUrl: string,
  argvPath: string | undefined,
): boolean {
  if (!argvPath) {
    return false;
  }

  return (
    resolveEntrypointPath(fileURLToPath(moduleUrl)) ===
    resolveEntrypointPath(argvPath)
  );
}

function resolveEntrypointPath(candidatePath: string): string {
  const normalizedPath = path.resolve(candidatePath);

  try {
    return fs.realpathSync(normalizedPath);
  } catch {
    return normalizedPath;
  }
}

if (isAtlasCliEntrypoint(import.meta.url, process.argv[1])) {
  runAtlasCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
