import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import {
  P2PTelemetry,
  ClientSeenDeduper,
  CLIENT_SEEN_EVENT,
  TELEMETRY_FAILURE_BACKOFF_MS,
} from "../p2p-telemetry.js";

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
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("does not throw when fetch returns a non-2xx status, and reports a failure", async () => {
    // Tier 1 is best-effort: a 500 from the lambda is logged but not
    // surfaced to the caller — request handlers must not be coupled to
    // telemetry health.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { telemetry, fetchMock } = build({
      fetchResult: new Response("boom", { status: 500 }),
    });
    const onFailure = vi.fn();
    const onSuccess = vi.fn();
    expect(() =>
      telemetry.emit(
        "pathfinder.session.created",
        { client_ip: "1.2.3.4" },
        { onFailure, onSuccess },
      ),
    ).not.toThrow();
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("HTTP 500");
  });

  it("cancels the response body so the connection is freed", async () => {
    const res = new Response("ignored", { status: 202 });
    const cancel = vi.spyOn(res.body!, "cancel");
    const { telemetry } = build({ fetchResult: res });
    const onSuccess = vi.fn();
    telemetry.emit(
      "pathfinder.session.created",
      { client_ip: "1.2.3.4" },
      { onSuccess },
    );
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("still counts a 2xx as delivered when cancelling the body rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = new Response("ignored", { status: 202 });
    const cancel = vi
      .spyOn(res.body!, "cancel")
      .mockRejectedValue(new Error("cancel failed"));
    const { telemetry } = build({ fetchResult: res });
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    telemetry.emit(
      "pathfinder.session.created",
      { client_ip: "1.2.3.4" },
      { onSuccess, onFailure },
    );
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("accepts a null callbacks argument without an unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const ok = build();
      const bad = build({ fetchResult: new Response("x", { status: 500 }) });
      // An untyped (JS) caller can pass null.
      const nullCallbacks = null as unknown as undefined;
      ok.telemetry.emit("pathfinder.session.created", {}, nullCallbacks);
      bad.telemetry.emit("pathfinder.session.created", {}, nullCallbacks);
      await new Promise((r) => setTimeout(r, 20));
      expect(ok.fetchMock).toHaveBeenCalledTimes(1);
      expect(bad.fetchMock).toHaveBeenCalledTimes(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("counts a 2xx whose body has no cancel() (node-fetch style) as a success", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const nodeStyle = {
      ok: true,
      status: 200,
      body: { pipe: () => {} },
    } as unknown as Response;
    const { telemetry } = build({ fetchResult: nodeStyle });
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    telemetry.emit("pathfinder.session.created", {}, { onSuccess, onFailure });
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(onFailure).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("asks fetch not to follow redirects", async () => {
    const { telemetry, fetchMock } = build();
    telemetry.emit("pathfinder.session.created", {});
    await new Promise((r) => setImmediate(r));
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[1].redirect).toBe("manual");
  });

  it("a throwing callback is logged and does not escape emit()", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { telemetry } = build();
      telemetry.emit(
        "pathfinder.session.created",
        {},
        {
          onSuccess: () => {
            throw new Error("callback boom");
          },
        },
      );
      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
      expect(warn.mock.calls[0]).toEqual([
        "[p2p-telemetry] callback failed:",
        "callback boom",
      ]);
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("aborts the request after timeoutMs", async () => {
    const fetchMock = vi.fn(
      async (_url: unknown, init: unknown): Promise<Response> => {
        const signal = (init as RequestInit).signal as AbortSignal;
        // Settle (reject) only when aborted, so the test can assert the timer fires.
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const telemetry = new P2PTelemetry({
      url: "https://sink.example/ingest",
      disabled: false,
      packageVersion: "9.9.9-test",
      fetch: fetchMock as unknown as typeof fetch,
      timeoutMs: 10,
    });
    const onFailure = vi.fn();
    const onSuccess = vi.fn();

    telemetry.emit(
      "pathfinder.session.created",
      { client_ip: "1.2.3.4" },
      { onFailure, onSuccess },
    );
    // The fake fetch settles only when the timeout aborts it.
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
    expect(onSuccess).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("aborted");
  });
});

describe("ClientSeenDeduper", () => {
  const HOUR = 3_600_000;
  const UA = "claude-code/1.0";

  it("exposes the event name", () => {
    expect(CLIENT_SEEN_EVENT).toBe("pathfinder.client.seen");
  });

  it("returns true on first sight and false on repeats within ttl", () => {
    let t = 1_000;
    const d = new ClientSeenDeduper({ now: () => t });
    expect(d.shouldEmit("1.2.3.4", UA)).toBe(true);
    expect(d.shouldEmit("1.2.3.4", UA)).toBe(false);
    t += 5 * HOUR;
    expect(d.shouldEmit("1.2.3.4", UA)).toBe(false);
  });

  it("keys on ip and user-agent together", () => {
    const d = new ClientSeenDeduper({ now: () => 0 });
    expect(d.shouldEmit("1.2.3.4", UA)).toBe(true);
    expect(d.shouldEmit("1.2.3.5", UA)).toBe(true);
    expect(d.shouldEmit("1.2.3.4", "other")).toBe(true);
    // NUL separator: ("a", "bc") must not collide with ("ab", "c")
    expect(d.shouldEmit("a", "bc")).toBe(true);
    expect(d.shouldEmit("ab", "c")).toBe(true);
  });

  it("24h boundary: 23:59:59 -> false, 24:00:00 -> true", () => {
    let t = 0;
    const d = new ClientSeenDeduper({ now: () => t });
    expect(d.shouldEmit("1.2.3.4", UA)).toBe(true);
    t = 24 * HOUR - 1_000;
    expect(d.shouldEmit("1.2.3.4", UA)).toBe(false);
    t = 24 * HOUR;
    expect(d.shouldEmit("1.2.3.4", UA)).toBe(true);
    // window restarts from the re-emit
    t = 24 * HOUR + 1_000;
    expect(d.shouldEmit("1.2.3.4", UA)).toBe(false);
  });

  it("honours a custom ttlMs", () => {
    let t = 0;
    const d = new ClientSeenDeduper({ ttlMs: 100, now: () => t });
    expect(d.shouldEmit("ip", UA)).toBe(true);
    t = 99;
    expect(d.shouldEmit("ip", UA)).toBe(false);
    t = 100;
    expect(d.shouldEmit("ip", UA)).toBe(true);
  });

  it("evicts the least-recently-seen key at max", () => {
    const d = new ClientSeenDeduper({ max: 2, now: () => 0 });
    expect(d.shouldEmit("a", UA)).toBe(true);
    expect(d.shouldEmit("b", UA)).toBe(true);
    // touch a so b becomes least recently seen
    expect(d.shouldEmit("a", UA)).toBe(false);
    expect(d.shouldEmit("c", UA)).toBe(true); // evicts b
    expect(d.shouldEmit("a", UA)).toBe(false); // a survived
    expect(d.shouldEmit("b", UA)).toBe(true); // b was evicted
  });

  it("works with default options", () => {
    const d = new ClientSeenDeduper();
    expect(d.shouldEmit("1.1.1.1", UA)).toBe(true);
    expect(d.shouldEmit("1.1.1.1", UA)).toBe(false);
  });

  it("claim.fail() holds the key back only for the failure window", () => {
    let t = 0;
    const d = new ClientSeenDeduper({ failureTtlMs: 300_000, now: () => t });
    const claim = d.claim("ip", UA);
    expect(claim).toBeDefined();
    t = 1_000;
    claim?.fail();
    // The failure window runs from the fail() call.
    t = 1_000 + 300_000 - 1;
    expect(d.claim("ip", UA)).toBeUndefined();
    t = 1_000 + 300_000;
    expect(d.claim("ip", UA)).toBeDefined();
  });

  it("defaults the failure window to TELEMETRY_FAILURE_BACKOFF_MS", () => {
    let t = 0;
    const d = new ClientSeenDeduper({ now: () => t });
    d.claim("ip", UA)?.fail();
    t = TELEMETRY_FAILURE_BACKOFF_MS - 1;
    expect(d.shouldEmit("ip", UA)).toBe(false);
    t = TELEMETRY_FAILURE_BACKOFF_MS;
    expect(d.shouldEmit("ip", UA)).toBe(true);
    expect(TELEMETRY_FAILURE_BACKOFF_MS).toBe(5 * 60 * 1000);
  });

  it("a stale claim.fail() does not touch a newer record", () => {
    let t = 0;
    const d = new ClientSeenDeduper({
      ttlMs: 1_000,
      failureTtlMs: 10,
      now: () => t,
    });
    const old = d.claim("ip", UA);
    t = 1_000; // ttl ran out while the old send was in flight
    const newer = d.claim("ip", UA);
    expect(newer).toBeDefined();
    t = 1_001;
    old?.fail();
    // Past the failure window, still inside the newer record's ttl.
    t = 1_500;
    expect(d.claim("ip", UA)).toBeUndefined();
  });

  it("a claim.fail() after LRU eviction and re-claim does not touch the new record", () => {
    let t = 0;
    const d = new ClientSeenDeduper({ max: 1, failureTtlMs: 10, now: () => t });
    const old = d.claim("a", UA);
    expect(d.claim("b", UA)).toBeDefined(); // evicts a
    expect(d.claim("a", UA)).toBeDefined(); // a again, new record
    old?.fail();
    t = 100; // past the failure window
    expect(d.claim("a", UA)).toBeUndefined();
  });
});

/**
 * A real node:http telemetry sink that answers every POST with `status` (and
 * any other method, such as a followed redirect, with 200).
 * Used with the real global fetch so the HTTP status check is exercised on
 * the wire, not through a fake Response.
 */
async function startStubSink(status: number): Promise<{
  url: string;
  hits: () => number;
  requests: () => { method: string; path: string }[];
  setStatus: (s: number) => void;
  stop: () => Promise<void>;
}> {
  let current = status;
  const seen: { method: string; path: string }[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push({ method: req.method ?? "", path: req.url ?? "" });
      // A redirect points at a path that would answer 200 to a GET.
      res.statusCode = req.method === "POST" ? current : 200;
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.setHeader("Location", "/landed");
      }
      res.end("x");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("stub sink has no TCP address");
  }
  return {
    url: `http://127.0.0.1:${addr.port}/telemetry`,
    hits: () => seen.length,
    requests: () => [...seen],
    setStatus: (s) => {
      current = s;
    },
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * A real node:http sink whose POST /telemetry answers `status` with a
 * Location header (`location`, default /landed; null sends none). Every other request answers
 * 200. Records the method, path and body of each request.
 */
async function startRedirectSink(
  status: number,
  location: string | null = "/landed",
): Promise<{
  url: string;
  requests: () => { method: string; path: string; body: string }[];
  stop: () => Promise<void>;
}> {
  const seen: { method: string; path: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", path: req.url ?? "", body });
      if (req.url === "/telemetry") {
        res.statusCode = status;
        if (location !== null) res.setHeader("Location", location);
      } else {
        res.statusCode = 200;
      }
      res.end("x");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("redirect sink has no TCP address");
  }
  return {
    url: `http://127.0.0.1:${addr.port}/telemetry`,
    requests: () => [...seen],
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("P2PTelemetry delivery status (real HTTP stub)", () => {
  const UA = "claude-code/1.0";
  const IP = "1.2.3.4";
  let stop: (() => Promise<void>) | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await stop?.();
    stop = undefined;
  });

  it("treats a 500 as a failure: warns with the event, sink host and status, and calls onFailure", async () => {
    const sink = await startStubSink(500);
    stop = sink.stop;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const telemetry = new P2PTelemetry({
      url: sink.url,
      disabled: false,
      packageVersion: "9.9.9-test",
    });
    const onFailure = vi.fn();
    const onSuccess = vi.fn();
    telemetry.emit(
      "pathfinder.session.created",
      { client_ip: IP },
      { onFailure, onSuccess },
    );
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
    expect(warn.mock.calls).toEqual([
      [
        `[p2p-telemetry] send failed: event=pathfinder.session.created sink=${new URL(sink.url).host}: HTTP 500`,
      ],
    ]);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("a 2xx calls onSuccess and logs nothing", async () => {
    const sink = await startStubSink(204);
    stop = sink.stop;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const telemetry = new P2PTelemetry({
      url: sink.url,
      disabled: false,
      packageVersion: "9.9.9-test",
    });
    const onFailure = vi.fn();
    const onSuccess = vi.fn();
    telemetry.emit(
      CLIENT_SEEN_EVENT,
      { client_ip: IP },
      { onFailure, onSuccess },
    );
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(onFailure).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(sink.requests()).toEqual([{ method: "POST", path: "/telemetry" }]);
  });

  it("treats a 302 as a failure and does not follow it as a bodyless GET", async () => {
    const sink = await startStubSink(302);
    stop = sink.stop;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const telemetry = new P2PTelemetry({
      url: sink.url,
      disabled: false,
      packageVersion: "9.9.9-test",
    });
    const onFailure = vi.fn();
    const onSuccess = vi.fn();
    telemetry.emit(
      CLIENT_SEEN_EVENT,
      { client_ip: IP },
      { onFailure, onSuccess },
    );
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
    expect(onSuccess).not.toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain("HTTP 302");
    // Give a followed redirect time to land, then check that none did.
    await new Promise((r) => setTimeout(r, 50));
    expect(sink.requests()).toEqual([{ method: "POST", path: "/telemetry" }]);
  });

  it.each([307, 308])(
    "follows a %i with the same POST and body, and calls onSuccess",
    async (code) => {
      const sink = await startRedirectSink(code);
      stop = sink.stop;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const telemetry = new P2PTelemetry({
        url: sink.url,
        disabled: false,
        packageVersion: "9.9.9-test",
      });
      const onFailure = vi.fn();
      const onSuccess = vi.fn();
      telemetry.emit(
        CLIENT_SEEN_EVENT,
        { client_ip: IP, user_agent: UA },
        { onFailure, onSuccess },
      );
      await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
      expect(onFailure).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      const reqs = sink.requests();
      expect(reqs.map((r) => `${r.method} ${r.path}`)).toEqual([
        "POST /telemetry",
        "POST /landed",
      ]);
      // The redirected POST carries the same event, byte for byte.
      expect(reqs[1].body).toBe(reqs[0].body);
      const body = JSON.parse(reqs[1].body) as {
        event: string;
        properties: Record<string, unknown>;
      };
      expect(body.event).toBe(CLIENT_SEEN_EVENT);
      expect(body.properties).toEqual({ client_ip: IP, user_agent: UA });
    },
  );

  it.each([
    ["a 307 with no Location", 307, null, 1],
    ["a 307 loop", 307, "/telemetry", 6],
  ])("treats %s as a failure", async (_name, code, location, posts) => {
    const sink = await startRedirectSink(code, location);
    stop = sink.stop;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const telemetry = new P2PTelemetry({
      url: sink.url,
      disabled: false,
      packageVersion: "9.9.9-test",
    });
    const onFailure = vi.fn();
    const onSuccess = vi.fn();
    telemetry.emit(
      CLIENT_SEEN_EVENT,
      { client_ip: IP },
      { onFailure, onSuccess },
    );
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
    expect(onSuccess).not.toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain(`HTTP ${code}`);
    expect(sink.requests()).toHaveLength(posts);
  });

  it.each([
    [299, "onSuccess"],
    [300, "onFailure"],
  ] as const)("a %i calls %s", async (code, expected) => {
    const sink = await startStubSink(code);
    stop = sink.stop;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const telemetry = new P2PTelemetry({
      url: sink.url,
      disabled: false,
      packageVersion: "9.9.9-test",
    });
    const onFailure = vi.fn();
    const onSuccess = vi.fn();
    telemetry.emit(
      CLIENT_SEEN_EVENT,
      { client_ip: IP },
      { onFailure, onSuccess },
    );
    const called = expected === "onSuccess" ? onSuccess : onFailure;
    const notCalled = expected === "onSuccess" ? onFailure : onSuccess;
    await vi.waitFor(() => expect(called).toHaveBeenCalledTimes(1));
    expect(notCalled).not.toHaveBeenCalled();
    expect(sink.requests()).toEqual([{ method: "POST", path: "/telemetry" }]);
  });

  it("logs at most one failure warning per window per sink, then reports the unlogged count", async () => {
    const sink = await startStubSink(500);
    stop = sink.stop;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let t = 0;
    const telemetry = new P2PTelemetry({
      url: sink.url,
      disabled: false,
      packageVersion: "9.9.9-test",
      now: () => t,
    });
    const onFailure = vi.fn();
    for (let i = 0; i < 4; i++) {
      telemetry.emit(CLIENT_SEEN_EVENT, { client_ip: IP }, { onFailure });
    }
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(4));
    expect(warn).toHaveBeenCalledTimes(1);

    // Still inside the window: no new warning.
    t = TELEMETRY_FAILURE_BACKOFF_MS - 1;
    telemetry.emit(CLIENT_SEEN_EVENT, { client_ip: IP }, { onFailure });
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(5));
    expect(warn).toHaveBeenCalledTimes(1);

    // Next window: one warning that counts the 4 failures not logged.
    t = TELEMETRY_FAILURE_BACKOFF_MS;
    telemetry.emit(CLIENT_SEEN_EVENT, { client_ip: IP }, { onFailure });
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(6));
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1][0])).toContain(
      "(4 earlier failures not logged)",
    );
  });

  it("client.seen: a failed send backs the key off, a later 200 holds it for the TTL", async () => {
    const sink = await startStubSink(500);
    stop = sink.stop;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const telemetry = new P2PTelemetry({
      url: sink.url,
      disabled: false,
      packageVersion: "9.9.9-test",
    });
    let t = 0;
    const d = new ClientSeenDeduper({ now: () => t });

    /** One send for a claim; resolves "ok" or "failed" when it settles. */
    function send(): Promise<"ok" | "failed"> | undefined {
      const claim = d.claim(IP, UA);
      if (!claim) return undefined;
      return new Promise((resolve) =>
        telemetry.emit(
          CLIENT_SEEN_EVENT,
          { client_ip: IP, user_agent: UA },
          {
            onSuccess: () => resolve("ok"),
            onFailure: () => {
              claim.fail();
              resolve("failed");
            },
          },
        ),
      );
    }

    expect(await send()).toBe("failed");
    // Inside the backoff: no send.
    t = TELEMETRY_FAILURE_BACKOFF_MS - 1;
    expect(send()).toBeUndefined();

    sink.setStatus(200);
    t = TELEMETRY_FAILURE_BACKOFF_MS;
    expect(await send()).toBe("ok");
    // The delivered record is held for the 24h TTL, not the backoff.
    t += 23 * 60 * 60 * 1000;
    expect(send()).toBeUndefined();
    expect(sink.hits()).toBe(2);
  });
});
