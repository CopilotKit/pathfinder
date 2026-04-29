// P2P telemetry client — fire-and-forget POSTs to a CopilotKit-hosted
// telemetry-sink Lambda which fans out to downstream services for
// company deanonymization.
//
// Active only on the hosted pathfinder.copilotkit.dev instance: when
// PATHFINDER_TELEMETRY_URL is unset, every emit() is a no-op so OSS
// self-hosters send nothing. Emits a single event,
// `pathfinder.session.created`, carrying the originating MCP client's IP
// so the Lambda can attribute the session to a company downstream.
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
