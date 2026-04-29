import { describe, it, expect, vi } from "vitest";
import { P2PTelemetry } from "../p2p-telemetry.js";

/**
 * Build a P2PTelemetry instance with a mocked fetch so tests can assert on
 * the outbound request without hitting the network. Defaults to enabled
 * (url set, disabled=false) so individual tests opt out by overriding.
 */
function build(
  overrides: {
    url?: string | undefined;
    disabled?: boolean;
    fetchResult?: Response | Promise<Response> | (() => Promise<Response>);
    fetchReject?: unknown;
  } = {},
) {
  const fetchMock = vi.fn(async (): Promise<Response> => {
    if (overrides.fetchReject !== undefined) throw overrides.fetchReject;
    if (typeof overrides.fetchResult === "function") {
      return overrides.fetchResult();
    }
    return (
      (overrides.fetchResult as Response | undefined) ??
      new Response("", { status: 202 })
    );
  });
  const telemetry = new P2PTelemetry({
    url: "url" in overrides ? overrides.url : "https://sink.example/ingest",
    disabled: overrides.disabled ?? false,
    packageVersion: "9.9.9-test",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { telemetry, fetchMock };
}

describe("P2PTelemetry", () => {
  it("no-ops when url is undefined", async () => {
    const { telemetry, fetchMock } = build({ url: undefined });
    expect(telemetry.isEnabled()).toBe(false);
    telemetry.emit("pathfinder.session.created", { client_ip: "1.2.3.4" });
    // Yield once so any accidentally-scheduled async work would run.
    await new Promise((r) => setImmediate(r));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no-ops when disabled even if url is set", async () => {
    const { telemetry, fetchMock } = build({ disabled: true });
    expect(telemetry.isEnabled()).toBe(false);
    telemetry.emit("pathfinder.session.created", { client_ip: "1.2.3.4" });
    await new Promise((r) => setImmediate(r));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts a single JSON event with the expected envelope", async () => {
    const { telemetry, fetchMock } = build();
    telemetry.emit("pathfinder.session.created", {
      client_ip: "203.0.113.7",
      transport: "sse",
    });
    // Wait for the fire-and-forget send to land.
    await new Promise((r) => setImmediate(r));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // vi.fn typings give .mock.calls a default tuple of []; cast to the
    // actual fetch signature so we can destructure positionally without
    // suppressing legitimate type errors elsewhere.
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("https://sink.example/ingest");
    expect(call[1].method).toBe("POST");

    const body = JSON.parse(String(call[1].body));
    expect(body.event).toBe("pathfinder.session.created");
    expect(body.event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(typeof body.ts).toBe("number");
    expect(body.properties).toEqual({
      client_ip: "203.0.113.7",
      transport: "sse",
    });
    expect(body.package).toEqual({
      name: "@copilotkit/pathfinder",
      version: "9.9.9-test",
    });
  });

  it("does not throw when fetch rejects", async () => {
    const { telemetry, fetchMock } = build({
      fetchReject: new Error("network down"),
    });
    // emit itself is sync and must not propagate the eventual rejection.
    expect(() =>
      telemetry.emit("pathfinder.session.created", { client_ip: "1.2.3.4" }),
    ).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not throw when fetch returns a non-2xx status", async () => {
    // Tier 1 is best-effort: a 500 from the lambda is logged but not
    // surfaced to the caller — request handlers must not be coupled to
    // telemetry health.
    const { telemetry } = build({
      fetchResult: new Response("boom", { status: 500 }),
    });
    expect(() =>
      telemetry.emit("pathfinder.session.created", { client_ip: "1.2.3.4" }),
    ).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });

  it("aborts the request after timeoutMs", async () => {
    const fetchMock = vi.fn(
      async (_url: unknown, init: unknown): Promise<Response> => {
        const signal = (init as RequestInit).signal as AbortSignal;
        // Resolve only when aborted, so the test can assert the timer fires.
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    );
    const telemetry = new P2PTelemetry({
      url: "https://sink.example/ingest",
      disabled: false,
      packageVersion: "9.9.9-test",
      fetch: fetchMock as unknown as typeof fetch,
      timeoutMs: 10,
    });

    telemetry.emit("pathfinder.session.created", { client_ip: "1.2.3.4" });
    // Give the fake fetch enough time to register the abort listener and
    // the timeout to fire. 50ms covers both with margin.
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
