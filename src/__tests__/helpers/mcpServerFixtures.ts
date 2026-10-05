// Shared fixtures for suites that build a full server through createMcpServer:
// one `baseConfig` literal (a new required `Config` field is added here once)
// and createMcpServerWith, which calls createMcpServer by argument name.
//
// The caller's own `vi.mock("../config.js", ...)` and friends still apply:
// vitest mocks by resolved module id, so the import below sees the same mocks.
import { expect, vi } from "vitest";
import type { MockInstance } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
import { createMcpServer } from "../../mcp/server.js";
import type { Config } from "../../config.js";
import type { SessionAnalyticsContext } from "../../request-context.js";

/** A complete `Config` with every secret empty. Spread and override per test. */
export const baseConfig: Config = {
  databaseUrl: undefined,
  openaiApiKey: "",
  githubToken: "",
  githubWebhookSecret: "",
  port: 0,
  nodeEnv: "test",
  logLevel: "silent",
  cloneDir: "",
  slackBotToken: "",
  slackSigningSecret: "",
  discordBotToken: "",
  discordPublicKey: "",
  notionToken: "",
  mcpJwtSecret: "",
  oauthConsentHmacKeys: [],
  p2pTelemetryUrl: undefined,
  p2pTelemetryDisabled: true,
  modernProtocol: false,
  packageVersion: "0.0.0",
  slackWebhookUrl: "",
};

type CreateMcpServerArgs = Parameters<typeof createMcpServer>;

/** The createMcpServer arguments these suites set, by name. */
export interface NamedCreateMcpServerArgs {
  getAnalyticsContext?: () => SessionAnalyticsContext | undefined;
}

/** The positional slot of each named argument. */
const SLOT = { getAnalyticsContext: 9 } as const satisfies Record<
  keyof NamedCreateMcpServerArgs,
  number
>;

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;

// Compile-time guards, checked in this file. Each fails to compile when the
// createMcpServer signature moves out from under SLOT:
// - every named field's type must equal the type of its slot, so a reorder
//   that changes a slot's type fails here;
// - the parameter count is pinned, so any added or removed parameter fails
//   here, even one whose type matches, and SLOT must be re-checked by hand.
// Parameter NAMES are not visible to the type system, so a swap of two
// parameters that have the same type is not caught. No other parameter has
// slot 9's type, so no such swap exists for it.
export type SlotTypesMatch = Assert<
  Equal<
    {
      [
        K in keyof NamedCreateMcpServerArgs
      ]-?: CreateMcpServerArgs[(typeof SLOT)[K]];
    },
    Required<{
      [K in keyof NamedCreateMcpServerArgs]:
        NamedCreateMcpServerArgs[K] | undefined;
    }>
  >
>;
export type ParameterCountPinned = Assert<
  Equal<Required<CreateMcpServerArgs>["length"], 11>
>;

/** Call createMcpServer with named arguments, each placed at its SLOT. */
export function createMcpServerWith(args: NamedCreateMcpServerArgs): McpServer {
  const positional: CreateMcpServerArgs = [];
  positional[SLOT.getAnalyticsContext] = args.getAnalyticsContext;
  return createMcpServer(...positional);
}

/**
 * How long to keep watching after a mock reaches its expected call count. The
 * tool handlers call logQuery fire-and-forget, so a duplicate call can land
 * after the first one; vi.waitFor alone returns on the first call.
 */
export const LATE_CALL_GRACE_MS = 50;

/**
 * Wait until `mock` has been called `times` times, keep watching for
 * {@link LATE_CALL_GRACE_MS}, then require EXACTLY `times` calls. A late
 * duplicate call fails this.
 */
export async function expectSettledCallCount(
  mock: MockInstance,
  times: number,
): Promise<void> {
  await vi.waitFor(() =>
    expect(mock.mock.calls.length).toBeGreaterThanOrEqual(times),
  );
  await new Promise((resolve) => setTimeout(resolve, LATE_CALL_GRACE_MS));
  expect(mock).toHaveBeenCalledTimes(times);
}
