/**
 * Shared rejection payloads for the per-IP session rate limiter.
 *
 * Used by both the SSE transport (src/sse-handlers.ts) and the
 * Streamable-HTTP /mcp transport (src/server.ts) so that rate-limited clients
 * get a consistent, descriptive error instead of a silent disconnect or a
 * bare "Too many sessions" string.
 */

/** Support contact surfaced in every rejection so operators can reach us. */
export const RATE_LIMIT_CONTACT = "oss@copilotkit.ai";

/**
 * JSON-RPC server-error-range code for rate-limit rejections.
 *
 * The MCP spec reserves -32000..-32099 for implementation-defined server
 * errors; we use -32005 as a stable, documented value clients can match
 * against for rate-limit handling.
 */
export const JSONRPC_RATE_LIMIT_CODE = -32005;

export interface RateLimitPayload {
  error: "rate_limited";
  reason: string;
  limit: number;
  currentCount: number;
  retryAfterSeconds: number;
  contact: string;
}

export interface RateLimitInputs {
  limit: number;
  currentCount: number;
  retryAfterSeconds: number;
}

/**
 * Minimum Retry-After hint, in seconds.
 *
 * Per RFC 7231, Retry-After is the minimum reasonable interval before retry.
 * Anything shorter would ask clients to hammer us faster than the limiter can
 * clear state.
 */
const RETRY_AFTER_MIN_SECONDS = 1;

/**
 * Maximum Retry-After hint, in seconds.
 *
 * Session-idle TTLs (30m+) are far too long to hand back as a retry hint —
 * idle sessions clear well before TTL and active ones never do. 5 minutes is
 * a conservative upper bound that keeps clients backing off without
 * stranding them on a value that no longer reflects reality.
 */
const RETRY_AFTER_MAX_SECONDS = 300;

/**
 * Default Retry-After hint, in seconds, used when the caller passes NaN,
 * a non-finite value, zero, or a negative number.
 */
const RETRY_AFTER_DEFAULT_SECONDS = 60;

/**
 * Normalize an arbitrary caller-supplied Retry-After hint into a sane integer
 * in [RETRY_AFTER_MIN_SECONDS, RETRY_AFTER_MAX_SECONDS].
 *
 * - Non-finite / NaN / values <= 0 fall back to RETRY_AFTER_DEFAULT_SECONDS.
 * - Positive values are floored so the wire value is always an integer.
 * - Positive values < 1s (which floor to 0) are clamped up to the minimum
 *   (RETRY_AFTER_MIN_SECONDS = 1), not defaulted.
 * - Values above the ceiling are clamped down to RETRY_AFTER_MAX_SECONDS.
 *
 * Exported so HTTP callers (e.g. the `Retry-After` header in src/server.ts
 * and src/sse-handlers.ts) can apply the same clamp as the JSON body,
 * keeping the header and body values in lockstep.
 */
export function clampRetryAfterSeconds(input: number): number {
  if (!Number.isFinite(input) || input <= 0) {
    return RETRY_AFTER_DEFAULT_SECONDS;
  }
  const floored = Math.floor(input);
  if (floored < RETRY_AFTER_MIN_SECONDS) {
    return RETRY_AFTER_MIN_SECONDS;
  }
  if (floored > RETRY_AFTER_MAX_SECONDS) {
    return RETRY_AFTER_MAX_SECONDS;
  }
  return floored;
}

/**
 * Build the shared descriptive rejection body.
 *
 * Shape is intentionally flat and serialization-safe so both HTTP bodies and
 * JSON-RPC error.data frames carry the same fields.
 *
 * `retryAfterSeconds` is defensively clamped here so every caller (HTTP
 * `Retry-After` header, JSON-RPC error data, human-readable reason) sees the
 * same sanitized integer — even if upstream passes a SESSION_TTL-derived
 * value or an accidental NaN/negative.
 */
export function buildRateLimitPayload(
  inputs: RateLimitInputs,
): RateLimitPayload {
  const { limit, currentCount } = inputs;
  const retryAfterSeconds = clampRetryAfterSeconds(inputs.retryAfterSeconds);
  return {
    error: "rate_limited",
    reason:
      `This IP already has ${currentCount} active MCP session${currentCount === 1 ? "" : "s"}, ` +
      `at the configured per-IP limit of ${limit}. ` +
      `Retry after ~${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"} once an existing session idles out.`,
    limit,
    currentCount,
    retryAfterSeconds,
    contact: RATE_LIMIT_CONTACT,
  };
}

export interface JsonRpcRateLimitFrame {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data: RateLimitPayload;
  };
}

/**
 * Build a JSON-RPC 2.0 error frame suitable for writing to the /mcp response
 * when the client's initialize request is rejected by the IP limiter.
 */
export function jsonRpcRateLimitError(
  id: string | number | null,
  inputs: RateLimitInputs,
): JsonRpcRateLimitFrame {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: JSONRPC_RATE_LIMIT_CODE,
      message: "Rate limited: too many sessions from this IP",
      data: buildRateLimitPayload(inputs),
    },
  };
}
