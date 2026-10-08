// P2P telemetry client — fire-and-forget POSTs to a CopilotKit-hosted
// telemetry-sink Lambda which fans out to downstream services for
// company deanonymization.
//
// Active only on the hosted pathfinder.copilotkit.dev instance: when
// PATHFINDER_TELEMETRY_URL is unset, every emit() is a no-op so OSS
// self-hosters send nothing. Emits two events, both carrying the
// originating MCP client's IP so the Lambda can attribute the traffic to a
// company downstream: `pathfinder.session.created` (one per legacy session
// create) and `pathfinder.client.seen` (modern stateless leg, which has no
// session; deduplicated per ip + user-agent by ClientSeenDeduper).
//
// Design rationale (vs. the queue+flush shape used by BashTelemetry):
// session-create is rare (one per MCP client connect, not per tool call),
// so a per-event POST is fine and avoids a flush-on-shutdown contract.

import { randomUUID } from "node:crypto";

export interface P2PTelemetryOptions {
  /** Telemetry-sink Lambda endpoint. Unset → emit() no-ops entirely. */
  url: string | undefined;
  /** Kill switch independent of url — set via PATHFINDER_TELEMETRY_DISABLED. */
  disabled: boolean;
  /** Bundled in event payload's `package.version`. */
  packageVersion: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Per-request timeout. Telemetry must not stall request handlers. */
  timeoutMs?: number;
  /** Minimum gap between two "send failed" warnings. */
  warnIntervalMs?: number;
  /** Injectable clock (ms) for the warning limiter in tests. */
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 3_000;

/** Most 307/308 redirects one send follows; the timeout covers all of them. */
const MAX_REDIRECTS = 5;

/** Event emitted on the modern (stateless) leg, about once per client per window (best-effort; at most `max` keys tracked, LRU). */
export const CLIENT_SEEN_EVENT = "pathfinder.client.seen";

const CLIENT_SEEN_DEFAULT_MAX = 10_000;
const CLIENT_SEEN_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long a client is held back after its client.seen send failed, and the
 * minimum gap between two "send failed" warnings for one sink.
 *
 * 5 minutes: long enough that a sink outage or a wrong URL costs at most 12
 * POSTs (and 12 warnings) per client per hour instead of one per request, and
 * far longer than the 3 s send timeout. Short enough that the event, which
 * feeds day-level company attribution, arrives soon after the sink recovers.
 */
export const TELEMETRY_FAILURE_BACKOFF_MS = 5 * 60 * 1000;

export interface ClientSeenDeduperOptions {
  /** Max tracked keys; the least-recently-seen key is evicted at the cap. */
  max?: number;
  /** Suppression window per key after a send. */
  ttlMs?: number;
  /** Suppression window per key after claim.fail(). */
  failureTtlMs?: number;
  /** Injectable clock (ms) for tests. */
  now?: () => number;
}

/** A claim on one emit, returned by ClientSeenDeduper.claim(). */
export interface ClientSeenClaim {
  /**
   * Report that this emit's send failed. The key is then suppressed only for
   * the short failure window, so the client is retried after it. Does
   * nothing if the key now holds a newer record (or none): a late failure
   * never touches a record that a later claim made.
   */
  fail(): void;
}

/** One record per key. Compared by identity in ClientSeenClaim.fail(). */
interface SeenRecord {
  /** The key is suppressed while now < until. */
  until: number;
}

/**
 * Decides whether a (ip, user-agent) pair should emit CLIENT_SEEN_EVENT.
 * claim() marks the key before the send and returns a claim; repeats are
 * suppressed for ttlMs from then, also while the send is in flight. If the
 * send fails, claim.fail() shortens that to failureTtlMs. Bounded LRU (Map
 * insertion order).
 */
export class ClientSeenDeduper {
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly now: () => number;
  /** key -> current record. Re-inserted on every sighting to keep LRU order. */
  private readonly seen = new Map<string, SeenRecord>();

  constructor(opts: ClientSeenDeduperOptions = {}) {
    this.max = opts.max ?? CLIENT_SEEN_DEFAULT_MAX;
    this.ttlMs = opts.ttlMs ?? CLIENT_SEEN_DEFAULT_TTL_MS;
    this.failureTtlMs = opts.failureTtlMs ?? TELEMETRY_FAILURE_BACKOFF_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * First sight, or a sighting after the key's window ran out, records the
   * key and returns a claim. A repeat inside the window returns undefined.
   */
  claim(ip: string, userAgent: string): ClientSeenClaim | undefined {
    const key = ip + "\u0000" + userAgent;
    const now = this.now();
    const current = this.seen.get(key);
    // Delete first so a re-set moves the key to the most-recent end.
    this.seen.delete(key);
    if (current !== undefined && now < current.until) {
      // Repeat inside the window: refresh recency, keep the same record.
      this.seen.set(key, current);
      return undefined;
    }
    const record: SeenRecord = { until: now + this.ttlMs };
    this.seen.set(key, record);
    while (this.seen.size > this.max) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return {
      fail: () => {
        if (this.seen.get(key) !== record) return;
        this.seen.set(key, { until: this.now() + this.failureTtlMs });
      },
    };
  }

  /** claim() without the handle: true when the pair should emit. */
  shouldEmit(ip: string, userAgent: string): boolean {
    return this.claim(ip, userAgent) !== undefined;
  }
}

/** Delivery callbacks for emit(). Each runs at most once; a throw is logged, not raised. */
export interface P2PEmitCallbacks {
  /** The sink answered with a 2xx status. */
  onSuccess?: () => void;
  /**
   * Network error, timeout, or a final non-2xx status. A 307/308 is followed
   * with the same POST; any other 3xx (and too many redirects) is a failure.
   */
  onFailure?: () => void;
}

export class P2PTelemetry {
  private readonly url: string | undefined;
  private readonly disabled: boolean;
  private readonly packageVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly warnIntervalMs: number;
  private readonly now: () => number;
  /** Sink host for log lines; the full URL is not logged. */
  private readonly sinkHost: string;
  /** When the last "send failed" warning was logged. */
  private lastWarnAt: number | undefined;
  /** Failures not logged since that warning. */
  private unloggedFailures = 0;

  constructor(opts: P2PTelemetryOptions) {
    this.url = opts.url;
    this.disabled = opts.disabled;
    this.packageVersion = opts.packageVersion;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.warnIntervalMs = opts.warnIntervalMs ?? TELEMETRY_FAILURE_BACKOFF_MS;
    this.now = opts.now ?? (() => Date.now());
    this.sinkHost = sinkHostOf(opts.url);
  }

  /**
   * True when emit() will actually attempt a POST. Cheap probe for callers
   * that want to skip building a properties object when telemetry is off
   * (e.g. avoid resolving the user-agent string on every session-create).
   */
  isEnabled(): boolean {
    return !this.disabled && !!this.url;
  }

  /**
   * Fire-and-forget. Returns immediately; the actual POST happens on the
   * next tick. Never throws — any send/network/parse error is swallowed so a
   * flaky telemetry sink can't cascade into request-handler failures. A
   * 307/308 is followed with the same POST and body; any other 3xx, and any
   * other non-2xx final status, counts as a failure. Failures are logged at
   * most once per warnIntervalMs, with a count of the ones not logged.
   * `callbacks` report the outcome; for example, the client.seen caller
   * calls ClientSeenClaim.fail() from onFailure.
   */
  emit(
    event: string,
    properties: Record<string, unknown>,
    callbacks?: P2PEmitCallbacks,
  ): void {
    if (!this.isEnabled()) return;
    void this.send(event, properties).then(
      () => {
        runCallback(callbacks?.onSuccess);
      },
      (err: unknown) => {
        this.warnSendFailed(
          event,
          err instanceof Error ? err.message : String(err),
        );
        runCallback(callbacks?.onFailure);
      },
    );
  }

  /** Log a failed send, at most once per warnIntervalMs for this sink. */
  private warnSendFailed(event: string, reason: string): void {
    const now = this.now();
    if (
      this.lastWarnAt !== undefined &&
      now - this.lastWarnAt < this.warnIntervalMs
    ) {
      this.unloggedFailures += 1;
      return;
    }
    const unlogged = this.unloggedFailures;
    this.lastWarnAt = now;
    this.unloggedFailures = 0;
    console.warn(
      `[p2p-telemetry] send failed: event=${event} sink=${this.sinkHost}: ${reason}` +
        (unlogged > 0 ? ` (${unlogged} earlier failures not logged)` : ""),
    );
  }

  private async send(
    event: string,
    properties: Record<string, unknown>,
  ): Promise<void> {
    const body = JSON.stringify({
      event,
      event_id: randomUUID(),
      ts: Math.floor(Date.now() / 1000),
      properties,
      package: {
        name: "@copilotkit/pathfinder",
        version: this.packageVersion,
      },
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // url is non-undefined here: isEnabled() is checked before send() is
      // ever scheduled. Asserting via the non-null bang keeps the call
      // site clean without an extra runtime check.
      let target = this.url!;
      for (let redirects = 0; ; redirects++) {
        const res = await this.fetchImpl(target, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": `Pathfinder/${this.packageVersion}`,
          },
          body,
          signal: controller.signal,
          // Redirects are followed by the loop below, not by fetch: fetch
          // turns a followed 301/302/303 into a bodyless GET, and the final
          // 200 would hide that the event was dropped.
          redirect: "manual",
        });
        // Only the status matters; cancel the body so the connection is freed.
        // A non-WHATWG fetch may return a body without cancel(); leave it then.
        const resBody: { cancel?: unknown } | null = res.body;
        if (res.body && typeof resBody?.cancel === "function") {
          await res.body.cancel().catch(() => {});
        }
        // A 307/308 keeps the method and body, so re-POST the same event to
        // its Location (for example a sink moved from http to https).
        const location =
          res.status === 307 || res.status === 308
            ? res.headers.get("location")
            : null;
        if (location !== null && redirects < MAX_REDIRECTS) {
          target = new URL(location, target).href;
          continue;
        }
        if (res.status < 200 || res.status > 299) {
          throw new Error(`HTTP ${res.status}`);
        }
        return;
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Run a delivery callback; a throwing callback must not escape emit(). */
function runCallback(cb: (() => void) | undefined): void {
  if (!cb) return;
  try {
    cb();
  } catch (err) {
    console.warn(
      "[p2p-telemetry] callback failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** host[:port] of the sink URL, for log lines. */
function sinkHostOf(url: string | undefined): string {
  if (!url) return "none";
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}
