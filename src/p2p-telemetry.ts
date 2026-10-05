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
}

const DEFAULT_TIMEOUT_MS = 3_000;

/** Event emitted on the modern (stateless) leg, about once per client per window (best-effort; at most `max` keys tracked, LRU). */
export const CLIENT_SEEN_EVENT = "pathfinder.client.seen";

const CLIENT_SEEN_DEFAULT_MAX = 10_000;
const CLIENT_SEEN_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface ClientSeenDeduperOptions {
  /** Max tracked keys; the least-recently-seen key is evicted at the cap. */
  max?: number;
  /** Suppression window per key. */
  ttlMs?: number;
  /** Injectable clock (ms) for tests. */
  now?: () => number;
}

/**
 * Decides whether a (ip, user-agent) pair should emit CLIENT_SEEN_EVENT.
 * First sight returns true; repeats within ttlMs return false; once ttlMs
 * has elapsed the key emits again. Bounded LRU (Map insertion order).
 */
export class ClientSeenDeduper {
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  /** key -> last-emit time. Re-inserted on every sighting to keep LRU order. */
  private readonly seen = new Map<string, number>();

  constructor(opts: ClientSeenDeduperOptions = {}) {
    this.max = opts.max ?? CLIENT_SEEN_DEFAULT_MAX;
    this.ttlMs = opts.ttlMs ?? CLIENT_SEEN_DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  shouldEmit(ip: string, userAgent: string): boolean {
    const key = ip + "\u0000" + userAgent;
    const now = this.now();
    const last = this.seen.get(key);
    // Delete first so a re-set moves the key to the most-recent end.
    this.seen.delete(key);
    if (last !== undefined && now - last < this.ttlMs) {
      // Repeat inside the window: refresh recency, keep the original emit time.
      this.seen.set(key, last);
      return false;
    }
    this.seen.set(key, now);
    while (this.seen.size > this.max) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return true;
  }
}

export class P2PTelemetry {
  private readonly url: string | undefined;
  private readonly disabled: boolean;
  private readonly packageVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: P2PTelemetryOptions) {
    this.url = opts.url;
    this.disabled = opts.disabled;
    this.packageVersion = opts.packageVersion;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
   * next tick. Never throws — any send/network/parse error is swallowed
   * after a single warn-level log so a flaky telemetry sink can't cascade
   * into request-handler failures.
   */
  emit(event: string, properties: Record<string, unknown>): void {
    if (!this.isEnabled()) return;
    void this.send(event, properties).catch((err) => {
      console.warn(
        "[p2p-telemetry] send failed:",
        err instanceof Error ? err.message : String(err),
      );
    });
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
      await this.fetchImpl(this.url!, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": `Pathfinder/${this.packageVersion}`,
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
