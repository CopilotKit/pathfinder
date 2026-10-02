import type { Request } from "express";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { InitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  normalizeRequestSource,
  isRecognizedRequestSource,
  REQUEST_SOURCE_HEADER,
  REQUEST_CONTEXT_FIELD_MAX_LEN,
} from "./db/analytics.js";
// Note: src/db/analytics.ts imports cleanClientString and rateLimitedWarn
// back from this module.
// The cycle is safe because neither module reads the other's bindings at
// module-evaluation time, only inside function bodies.
import type { RequestSource, QueryLogEntry } from "./db/analytics.js";
import { oauthClientIp } from "./oauth/trusted-client-ip.js";
import type { AuthContext } from "./oauth/handlers.js";

/**
 * Per-session analytics context stamped onto every query_log row; its field
 * names are the query_log column names. On /mcp it is built once from the
 * initialize request. On SSE it is rebuilt on every tool call: the auth client
 * id comes from GET /sse, and protocol_version / client_name come from the
 * first initialize that POST /messages accepted. A tool call that runs before
 * that initialize is accepted has NULL protocol_version and client_name.
 */
export interface SessionAnalyticsContext {
  transport: "streamable_http" | "sse";
  /**
   * Protocol era, independent of `transport`. "legacy" is the
   * pre-2026-07-28 session-based MCP protocol; every current writer stamps
   * "legacy", on both transports. "modern" is reserved for the stateless
   * protocol.
   */
  protocol_era: "legacy" | "modern";
  protocol_version: string | null;
  client_name: string | null;
  auth_client_id: string | null;
}

/**
 * The five query_log fields filled from {@link SessionAnalyticsContext}. Keyed
 * by the context's own fields and picked from QueryLogEntry, so a field added
 * to SessionAnalyticsContext but missing from QueryLogEntry fails to compile.
 */
export type AnalyticsContextFields = Required<
  Pick<QueryLogEntry, keyof SessionAnalyticsContext>
>;

const NULL_ANALYTICS_CONTEXT_FIELDS: AnalyticsContextFields = Object.freeze({
  transport: null,
  protocol_era: null,
  protocol_version: null,
  client_name: null,
  auth_client_id: null,
});

/**
 * Read the per-session analytics context and map it onto query_log fields
 * (null when absent). This is the ONE place the accessor is called, and it
 * cannot throw: a missing analytics row is preferable to a failed tool call,
 * so an accessor that throws yields all-null fields. The warning names the
 * error's class but not its message, which may carry client bytes.
 */
export function analyticsContextFields(
  getCtx: (() => SessionAnalyticsContext | undefined) | undefined,
): AnalyticsContextFields {
  try {
    // The field reads stay inside the try: a context with a throwing getter
    // is handled the same way as an accessor that throws.
    const ctx = getCtx?.();
    return {
      transport: ctx?.transport ?? null,
      protocol_era: ctx?.protocol_era ?? null,
      protocol_version: ctx?.protocol_version ?? null,
      client_name: ctx?.client_name ?? null,
      auth_client_id: ctx?.auth_client_id ?? null,
    };
  } catch (err) {
    rateLimitedWarn(
      "analytics-context-accessor",
      `[analytics] getAnalyticsContext threw ${errorClassName(err)} — ` +
        `writing null session context fields on query_log rows`,
    );
    return { ...NULL_ANALYTICS_CONTEXT_FIELDS };
  }
}

export interface PathfinderRequestContext {
  ip: string;
  userAgent: string | undefined;
  requestSource: RequestSource;
  authClientId: string | null;
}

/**
 * Single adapter from an Express request to the per-request facts analytics
 * needs. Uses oauthClientIp (the same trust-proxy accessor server.ts wires
 * via setTrustingProxy) so this module never imports server.ts. Read-only:
 * never reassigns req.auth.
 */
export function requestContext(
  req: Request & { auth?: AuthContext },
): PathfinderRequestContext {
  const ua = req.headers["user-agent"];
  return {
    ip: oauthClientIp(req),
    userAgent: Array.isArray(ua) ? ua[0] : ua,
    requestSource: requestSourceFromHeaders(req),
    authClientId: req.auth?.client_id || null,
  };
}

/**
 * C0 controls (U+0000-U+001F, NUL included), DEL (U+007F) and C1 controls
 * (U+0080-U+009F). Postgres TEXT cannot hold NUL, so one NUL in a value makes
 * the whole INSERT fail; the others can forge or colour log lines.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/** A UTF-16 surrogate that is not half of a valid pair. */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Everything outside printable ASCII. A strict superset of
 * {@link CONTROL_CHARS} and of every lone surrogate, so a token
 * {@link cleanClientString} would keep is still safe to log.
 */
const NON_PRINTABLE_ASCII = /[^\x20-\x7e]/g;

/**
 * Make a client-controlled value safe to put in a log line: every UTF-16 code
 * unit outside printable ASCII becomes "?", so it cannot forge or colour lines.
 * This is for LOG OUTPUT only; stored values go through
 * {@link cleanClientString}. Its replaced set ({@link NON_PRINTABLE_ASCII})
 * covers every character the cleaner strips.
 */
export function safeLogToken(s: string): string {
  return s.replace(NON_PRINTABLE_ASCII, "?");
}

/** Minimum time between two lines for the same {@link rateLimitedWarn} key. */
export const RATE_LIMITED_WARN_INTERVAL_MS = 60_000;

const rateLimitedWarnState = new Map<
  string,
  { lastAt: number; suppressed: number }
>();

/**
 * console.warn `message` at most once per {@link RATE_LIMITED_WARN_INTERVAL_MS}
 * per `key`. Calls inside the interval are counted, and the next line that is
 * emitted ends with "(suppressed N since last report)". `key` must come from
 * a small fixed set chosen by server code, and `message` must not contain
 * client-supplied bytes: the caller builds both from server-side names only.
 */
export function rateLimitedWarn(key: string, message: string): void {
  const now = Date.now();
  const state = rateLimitedWarnState.get(key);
  if (state && now - state.lastAt < RATE_LIMITED_WARN_INTERVAL_MS) {
    state.suppressed += 1;
    return;
  }
  const suppressed = state?.suppressed ?? 0;
  rateLimitedWarnState.set(key, { lastAt: now, suppressed: 0 });
  console.warn(
    suppressed > 0
      ? `${message} (suppressed ${suppressed} since last report)`
      : message,
  );
}

/** @internal — test seam: clears every {@link rateLimitedWarn} key. */
export function __resetRateLimitedWarnForTesting(): void {
  rateLimitedWarnState.clear();
}

/**
 * A log-safe name for a thrown value: the constructor name of an Error (set by
 * code, not by the client), otherwise its `typeof`. Never the message. Total:
 * a missing constructor, a throwing getter or a non-string name yields
 * "Error", because the caller runs it inside a catch block.
 */
function errorClassName(err: unknown): string {
  try {
    const name: unknown =
      err instanceof Error ? err.constructor?.name : typeof err;
    if (typeof name !== "string") return "Error";
    return safeLogToken(name).slice(0, 64) || "Error";
  } catch {
    return "Error";
  }
}

/**
 * THE cleaner for client-supplied strings that are logged or stored
 * (handshake fields, OAuth client id). Total: accepts anything, never throws.
 *
 * - A non-string yields null.
 * - C0/C1 controls and DEL (NUL included) are removed.
 * - Lone surrogates are removed (a valid pair is kept), so the value is
 *   well-formed UTF-16 and is never stored as U+FFFD.
 * - Surrounding whitespace is trimmed.
 * - The value is capped at `maxLen` CODE POINTS, so a surrogate pair is never
 *   split. With `overflow: "null"` a value over the cap yields null instead
 *   of a prefix: use it for identity keys, where a prefix would merge two
 *   distinct ids.
 * - A result that is empty yields null.
 *
 * Idempotent: `clean(clean(x)) === clean(x)`, so the handshake value and the
 * stored column agree by construction.
 */
export function cleanClientString(
  value: unknown,
  maxLen: number,
  overflow: "truncate" | "null" = "truncate",
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value
    .replace(CONTROL_CHARS, "")
    .replace(LONE_SURROGATE, "")
    .trim();
  const points = Array.from(trimmed);
  if (points.length > maxLen) {
    if (overflow === "null") return null;
    // Trim again: the cut can leave trailing whitespace, which a second
    // pass would remove, breaking idempotence.
    const cut = points.slice(0, maxLen).join("").trimEnd();
    return cut === "" ? null : cut;
  }
  return trimmed === "" ? null : trimmed;
}

export interface Handshake {
  protocolVersion: string | null;
  clientName: string | null;
}

/**
 * Extract protocolVersion and clientInfo.name from an initialize request the
 * caller has already classified (pass `undefined` for any other message, so
 * the request is parsed once). protocolVersion is the version the client
 * requested, not the version the server answers with. Each field goes
 * through {@link cleanClientString} with
 * {@link REQUEST_CONTEXT_FIELD_MAX_LEN}, the same cleaner logQuery applies, so
 * the stored value equals the handshake value.
 */
export function handshakeOf(msg: InitializeRequest | undefined): Handshake {
  if (msg === undefined) {
    return { protocolVersion: null, clientName: null };
  }
  return {
    protocolVersion: cleanClientString(
      msg.params.protocolVersion,
      REQUEST_CONTEXT_FIELD_MAX_LEN,
    ),
    clientName: cleanClientString(
      msg.params.clientInfo?.name,
      REQUEST_CONTEXT_FIELD_MAX_LEN,
    ),
  };
}

/**
 * @internal — test seam. {@link handshakeOf} for an unclassified message:
 * anything that is not an initialize yields nulls.
 */
export function handshakeFromInitialize(msg: unknown): Handshake {
  return handshakeOf(isInitializeRequest(msg) ? msg : undefined);
}

/**
 * Per-transport handshake record. Keyed by the transport object, so entries
 * are collected with the transport and need no cleanup on session close.
 */
const handshakes = new WeakMap<object, Handshake>();

/**
 * Record the handshake for `key`. The first record wins, so a later
 * initialize on the same session cannot change its attribution. Returns
 * whether this call recorded it.
 */
export function recordHandshake(key: object, hs: Handshake): boolean {
  if (handshakes.has(key)) return false;
  handshakes.set(key, hs);
  return true;
}

export function handshakeFor(key: object | undefined): Handshake | undefined {
  return key === undefined ? undefined : handshakes.get(key);
}

/**
 * Read and normalize the request-origin tag from the X-Pathfinder-Source
 * header. Captured ONCE at MCP-session init and closed over for the lifetime
 * of the session (each session gets its own server + transport), so every
 * tool call within that session records the origin its client declared.
 *
 * Node joins duplicate headers into a comma-separated string and lower-cases
 * the name; we hand whatever's present to normalizeRequestSource, which maps
 * absent/unknown values to the default ('user'). An array-shaped value (only
 * possible for set-cookie under Node) is reduced to its first element.
 *
 * A value we do not RECOGNIZE is still tagged 'user', and it is logged — see
 * the warning below.
 *
 * {@link requestContext} calls it. It is exported, and re-exported from
 * server.ts, so tests can check the header→source mapping without the full
 * Express app.
 */
export function requestSourceFromHeaders(req: Request): RequestSource {
  const raw = req.headers[REQUEST_SOURCE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === "string" && value.trim() !== "") {
    warnUnrecognizedRequestSource(value);
  }
  return normalizeRequestSource(value);
}

/**
 * Distinct unrecognized `X-Pathfinder-Source` values already warned about in
 * this process. The header is read once per MCP session init, so an unbounded
 * warn would still be bounded by session rate — but a misconfigured client
 * reconnecting in a loop would bury the line it is supposed to surface, and a
 * client sending a per-request identifier would grow this set without limit.
 * One line per distinct word, capped, is enough: the point is to name the
 * word, once, early.
 */
const warnedRequestSources = new Set<string>();
const WARNED_REQUEST_SOURCES_MAX = 50;

/** @internal — test seam for {@link warnUnrecognizedRequestSource}. */
export function __resetWarnedRequestSourcesForTesting(): void {
  warnedRequestSources.clear();
}

/**
 * Say so when a client declares an origin this server has never heard of.
 *
 * This is the compensation for a normalization that cannot fail: an unknown
 * `X-Pathfinder-Source` is indistinguishable downstream from no header at all
 * — both persist as 'user' — so a cross-service vocabulary mismatch shows up
 * only as an audience that quietly counts zero. The fix for a word is in
 * REQUEST_SOURCE_ALIASES; this line names the word.
 *
 * Before it is logged, the raw value goes through {@link safeLogToken} and is
 * truncated: it is attacker-controlled input going into an operator's log.
 */
function warnUnrecognizedRequestSource(value: string): void {
  if (isRecognizedRequestSource(value)) return;
  const key = value.trim().toLowerCase();
  if (warnedRequestSources.has(key)) return;
  // At the cap, stop warning rather than warning forever about words we can
  // no longer remember. Fifty distinct unknown origins is already a louder
  // signal than any one of them.
  if (warnedRequestSources.size >= WARNED_REQUEST_SOURCES_MAX) return;
  warnedRequestSources.add(key);
  const safe = safeLogToken(key).slice(0, 64);
  console.warn(
    `[analytics] unrecognized ${REQUEST_SOURCE_HEADER}: "${safe}" — ` +
      `tagging these rows as '${normalizeRequestSource(undefined)}'. If this ` +
      `is one of ours, add it to REQUEST_SOURCE_ALIASES in ` +
      `src/db/analytics.ts and to the wire-contract test.`,
  );
}
