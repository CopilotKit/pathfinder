#!/usr/bin/env node
import {
  Client,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import { Command, CommanderError } from "commander";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runAtlasHarvestCli } from "./atlas/harvest-cli.js";
import { collectMissingRequiredEnv } from "./config.js";

const DEFAULT_TOOL = "atlas-search";
const DEFAULT_FEEDBACK_TOOL = "submit-feedback";
const FEEDBACK_RATINGS = ["helpful", "not_helpful"] as const;
const DEFAULT_MCP_URL = "https://mcp.pathfinder.copilotkit.dev/mcp";
const ATLAS_CLIENT_INFO = { name: "atlas", version: "1.0.0" };
/**
 * How long atlas waits for the server to answer one request. The client's
 * own default is 60 s, too short for a slow tool call. The bound stops a
 * server that never answers (a 202 with no body, an empty stream, a wrong
 * id) from hanging atlas.
 */
const REQUEST_TIMEOUT_MS = 600_000;
const REQUEST_TIMEOUT = { timeout: REQUEST_TIMEOUT_MS };
/**
 * The request-origin tag atlas sends in X-Pathfinder-Source on every request.
 * Atlas searches are real agent work, so they count as `user` traffic in
 * query_log.request_source. The modern protocol has no session, so the server
 * reads the header from each request; the tag therefore goes on all of them.
 */
export const ATLAS_REQUEST_SOURCE = "user";
const REQUEST_SOURCE_HEADER = "X-Pathfinder-Source";
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

interface FeedbackOptions {
  comment?: string;
  for?: string;
  json?: boolean;
  rating?: string;
  token?: string;
  tool?: string;
  url?: string;
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

export function buildFeedbackArguments(
  query: string,
  options: FeedbackOptions,
): Record<string, unknown> {
  const rating = options.rating;
  if (
    rating === undefined ||
    !(FEEDBACK_RATINGS as readonly string[]).includes(rating)
  ) {
    throw new Error(`rating must be one of: ${FEEDBACK_RATINGS.join(", ")}`);
  }

  const comment = options.comment;
  if (comment === undefined || comment.trim() === "") {
    throw new Error("comment must not be empty");
  }

  // --for always resolves via its Commander default, so a missing value here
  // means the default was dropped — fail loud rather than sending an undefined
  // tool_name (symmetric with the --tool guard in feedback()/search()).
  if (options.for === undefined) {
    throw new Error("atlas: --for is required");
  }

  return {
    tool_name: options.for,
    query,
    rating,
    comment,
  };
}

type ToolContent = Array<{ type?: string; text?: string }>;

function toolTextItems(content: unknown): string[] {
  const items: ToolContent = Array.isArray(content) ? content : [];
  return items
    .map((item) => item.text)
    .filter((text): text is string => typeof text === "string");
}

function printToolText(result: CallToolResult, write: WriteFn): void {
  const textItems = toolTextItems(result.content);

  if (textItems.length === 0) {
    write("No results.\n");
    return;
  }

  for (const text of textItems) {
    write(`${text}\n`);
  }
}

/**
 * The error message of a JSON-RPC error frame that has no id or a null id,
 * or undefined for any other body.
 */
function idlessErrorMessage(frame: unknown): string | undefined {
  if (typeof frame !== "object" || frame === null || !("error" in frame)) {
    return undefined;
  }
  if ("id" in frame && frame.id !== null && frame.id !== undefined) {
    return undefined;
  }
  const error = frame.error;
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  return "message" in error && typeof error.message === "string"
    ? error.message
    : "MCP tool call failed";
}

interface CallToolOptions {
  json?: boolean;
  token?: string;
  url?: string;
}

async function callTool(
  toolName: string,
  toolArguments: Record<string, unknown>,
  options: CallToolOptions,
  write: WriteFn,
): Promise<void> {
  const url = options.url ?? process.env.ATLAS_MCP_URL ?? DEFAULT_MCP_URL;
  const token = options.token ?? process.env.ATLAS_TOKEN;

  // The id of the tools/call request once it is sent, and its result frame.
  let toolsCallId: string | number | undefined;
  let toolsCallResult: unknown;

  // requestInit headers ride on every request the transport sends: the
  // server/discover probe, initialize, tools/call and the session DELETE.
  // The bearer is a plain header, not an authProvider: with an authProvider
  // the client turns a 401 into a bare "Unauthorized" and drops the body.
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        [REQUEST_SOURCE_HEADER]: ATLAS_REQUEST_SOURCE,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    },
    // An error frame with no id (or id null) matches no request, so the
    // client would wait for its timeout or fail its own schema check. Atlas
    // has always reported the server's message instead, so read the frame
    // here while the tools/call is in flight.
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (
        toolsCallId !== undefined &&
        init?.method === "POST" &&
        response.ok &&
        (response.headers.get("content-type") ?? "").includes(
          "application/json",
        )
      ) {
        const message = idlessErrorMessage(
          await response
            .clone()
            .json()
            .catch(() => undefined),
        );
        if (message !== undefined) {
          throw new Error(message);
        }
      }
      return response;
    },
  });
  // 'auto' probes with server/discover and speaks the 2026-07-28 stateless
  // protocol when the server offers it; otherwise it falls back to the plain
  // 2025 initialize handshake.
  const client = new Client(ATLAS_CLIENT_INFO, {
    versionNegotiation: { mode: "auto" },
  });

  // --json prints the tools/call response frame in the shape atlas has
  // always printed: {result, jsonrpc, id}, the key order the server sends.
  // The client hands back only the parsed result, so note the tools/call
  // request id on the way out and keep the matching response on the way in.
  // A pre-set onmessage is an observer: the client calls it for every inbound
  // message before its own handling. The frame the client delivers has its
  // keys re-ordered (jsonrpc and id first), so the output is rebuilt from it.
  const send = transport.send.bind(transport);
  transport.send = (message, sendOptions) => {
    if (isJSONRPCRequest(message) && message.method === "tools/call") {
      toolsCallId = message.id;
    }
    return send(message, sendOptions);
  };
  // The ids are compared as strings: a proxy that echoes "1" for 1 still
  // matches, as it did before the v2 client.
  transport.onmessage = (message) => {
    if (
      toolsCallId !== undefined &&
      isJSONRPCResultResponse(message) &&
      String(message.id) === String(toolsCallId)
    ) {
      toolsCallResult = message.result;
    }
  };

  try {
    await client.connect(transport, REQUEST_TIMEOUT);
    const result = await client.callTool(
      { name: toolName, arguments: toolArguments },
      REQUEST_TIMEOUT,
    );

    if (result.isError === true) {
      throw new Error(
        toolTextItems(result.content).join("\n") ||
          "MCP tool call reported an error",
      );
    }

    if (options.json) {
      if (toolsCallId === undefined || toolsCallResult === undefined) {
        throw new Error("atlas: no response frame from server for tools/call");
      }
      const frame = {
        result: toolsCallResult,
        jsonrpc: "2.0",
        id: toolsCallId,
      };
      write(`${JSON.stringify(frame, null, 2)}\n`);
      return;
    }

    printToolText(result, write);
  } catch (error) {
    // Report a non-2xx answer the way atlas always has: status and body.
    if (error instanceof SdkHttpError) {
      const body = error.data.text;
      throw new Error(
        `HTTP ${error.status}: ${typeof body === "string" ? body : ""}`,
      );
    }
    if (
      error instanceof SdkError &&
      error.code === SdkErrorCode.RequestTimeout
    ) {
      throw new Error("no response from server within 10 minutes");
    }
    throw error;
  } finally {
    await closeMcpClient(client, transport);
  }
}

/**
 * Best-effort cleanup: end the legacy session (a modern connection has none,
 * so terminateSession is a no-op there) and close the client. Cleanup must
 * not mask the tool result or the original failure.
 */
async function closeMcpClient(
  client: Client,
  transport: StreamableHTTPClientTransport,
): Promise<void> {
  try {
    await transport.terminateSession();
  } catch {
    // Ignored, see above.
  }
  try {
    await client.close();
  } catch {
    // Ignored, see above.
  }
}

async function search(
  query: string,
  options: SearchOptions,
  write: WriteFn,
): Promise<void> {
  // --tool always resolves via its Commander default, so a missing value here
  // means the default was dropped — fail loud rather than silently re-default.
  if (options.tool === undefined) {
    throw new Error("atlas: --tool is required");
  }
  const toolArguments = buildToolArguments(query, options);

  await callTool(options.tool, toolArguments, options, write);
}

async function feedback(
  query: string,
  options: FeedbackOptions,
  write: WriteFn,
): Promise<void> {
  // --tool always resolves via its Commander default, so a missing value here
  // means the default was dropped — fail loud rather than silently re-default.
  if (options.tool === undefined) {
    throw new Error("atlas: --tool is required");
  }
  const toolArguments = buildFeedbackArguments(query, options);

  await callTool(options.tool, toolArguments, options, write);
}

/**
 * Env preflight — enumerate EVERY missing required environment variable in
 * one pass and report them before any harvest/search work runs. Intentionally
 * lives here in atlas-cli.ts (NOT a harvest-cli subcommand) so it stays off
 * the harvest-cli serialization chain.
 *
 * Fails-loud with a non-zero exit when anything is missing so an operator
 * running `atlas preflight` in a deploy check sees the full list up front —
 * unlike server boot, which throws on the first failing group. Returns 0 and
 * prints an OK line when the environment is fully configured.
 */
export function runPreflight(writeOut: WriteFn, writeErr: WriteFn): number {
  const missing = collectMissingRequiredEnv();
  if (missing.length === 0) {
    writeOut("atlas preflight: OK — all required environment variables set.\n");
    return 0;
  }
  writeErr(
    `atlas preflight: missing required environment variables:\n${missing
      .map((m) => `  - ${m}`)
      .join(
        "\n",
      )}\nSet them before starting the server or running a harvest.\n`,
  );
  return 1;
}

export async function runAtlasCli(
  argv: string[] = process.argv.slice(2),
  io: AtlasCliIo = {},
): Promise<number> {
  const writeOut = io.stdout ?? ((text: string) => process.stdout.write(text));
  const writeErr = io.stderr ?? ((text: string) => process.stderr.write(text));

  // `harvest` short-circuits BEFORE commander parses: the raw tail is
  // forwarded to the harvest driver genuinely verbatim — order intact,
  // INCLUDING a leading `--`, which commander's `[args...]` variadic would
  // otherwise consume as its own operand separator and silently drop,
  // turning standalone-inert operands back into parsed options. The driver
  // (src/atlas/harvest-cli.ts) owns its own commander program, io wiring,
  // exit codes, and stderr formatting (formatCliError), so `atlas harvest
  // run --run-id ...` behaves exactly like running the driver module
  // directly.
  if (argv[0] === "harvest") {
    return runAtlasHarvestCli(argv.slice(1), {
      stdout: writeOut,
      stderr: writeErr,
    });
  }

  const program = new Command();
  program
    .name("atlas")
    .description("Agent-facing Atlas search over Pathfinder MCP")
    .exitOverride()
    // Required so the `harvest` mount below can use passThroughOptions():
    // option processing stops at the first subcommand, leaving each verb to
    // parse its own flags (search/feedback already declare all their options
    // locally, so their behavior is unchanged).
    .enablePositionalOptions()
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

  program
    .command("feedback")
    .description(
      "Submit Atlas retrieval feedback through a Pathfinder MCP endpoint",
    )
    .argument("<query>", "The query the feedback is about")
    .requiredOption(
      "--rating <rating>",
      "Feedback rating (helpful or not_helpful)",
    )
    .requiredOption("--comment <text>", "Free-form feedback comment")
    .option("--for <tool_name>", "Tool the feedback is about", DEFAULT_TOOL)
    .option("--url <url>", "Pathfinder MCP URL")
    .option("--token <token>", "Bearer token for the MCP endpoint")
    .option("--tool <name>", "MCP tool name", DEFAULT_FEEDBACK_TOOL)
    .option("--json", "Print the raw MCP JSON-RPC response")
    .action(async (query: string, options: FeedbackOptions) => {
      await feedback(query, options, writeOut);
    });

  let preflightExitCode: number | undefined;
  program
    .command("preflight")
    .description(
      "Report every missing required environment variable in one pass " +
        "(fatal-in-production keys + source-gated tokens) before running the server or a harvest",
    )
    .action(() => {
      preflightExitCode = runPreflight(writeOut, writeErr);
    });

  // The harvest DRIVER (src/atlas/harvest-cli.ts) as a registered verb.
  // Execution is handled by the pre-parse short-circuit at the top of
  // runAtlasCli (which forwards the raw tail verbatim, leading `--`
  // included), so this registration is UNREACHABLE for `atlas harvest ...`
  // invocations. It is kept so `atlas --help` still lists the verb, and as a
  // correct fallback for any commander-routed path.
  let harvestExitCode: number | undefined;
  program
    .command("harvest")
    .description(
      "Atlas harvest driver — run the pipeline over a fragment corpus and " +
        "drive ratification/index (subcommands: run, artifact, sync, reindex)",
    )
    .helpOption(false)
    .allowUnknownOption()
    .allowExcessArguments(true)
    .passThroughOptions()
    .argument("[args...]", "Arguments forwarded to the harvest driver")
    .action(async (args: string[]) => {
      harvestExitCode = await runAtlasHarvestCli(args, {
        stdout: writeOut,
        stderr: writeErr,
      });
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    return preflightExitCode ?? harvestExitCode ?? 0;
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
  runAtlasCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(
        `error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
