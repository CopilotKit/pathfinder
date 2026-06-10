import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AtlasHttpClient } from "../atlas/client.js";

// The Atlas HTTP client is a thin wrapper over the EXISTING live routes
// (the ratification endpoints in src/server.ts + the /admin/reindex op + the
// search probe used by rag-dedup). HTTP is a NON-LLM external — mocking the
// global `fetch` with vi.fn is allowed per the org rule (only LLM calls
// require aimock). These unit tests assert that each method hits the right
// path + verb, attaches the bearer ANALYTICS_TOKEN, sets X-Atlas-Actor on the
// ratification mutations, and treats a 409 on approve/reject as an idempotent
// no-op rather than an error.

const BASE_URL = "https://pathfinder.example.test";
const TOKEN = "analytics-token-abc";

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// A 200 OK whose body is NOT valid JSON — e.g. an upstream proxy returning an
// HTML interstitial, or an empty body. `res.json()` throws a bare SyntaxError
// here, which the client must wrap with action + status + a body slice.
function textResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html" },
  });
}

function captureFetch(handler: (call: CapturedCall) => Response): {
  calls: CapturedCall[];
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const calls: CapturedCall[] = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers: Record<string, string> = {};
      const rawHeaders = init?.headers as Record<string, string> | undefined;
      if (rawHeaders) {
        for (const [k, v] of Object.entries(rawHeaders)) {
          headers[k.toLowerCase()] = v;
        }
      }
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      const call: CapturedCall = {
        url,
        method: init?.method ?? "GET",
        headers,
        body,
      };
      calls.push(call);
      return handler(call);
    },
  );
  return { calls, fetchMock };
}

describe("AtlasHttpClient", () => {
  let client: AtlasHttpClient;

  beforeEach(() => {
    client = new AtlasHttpClient({ baseUrl: BASE_URL, token: TOKEN });
  });

  afterEach(() => {
    // restoreAllMocks() does NOT undo vi.stubGlobal — the global `fetch` stub
    // set in each test must be torn down explicitly, or it leaks past this file
    // (a reused vitest worker fork inherits the canned fetch and corrupts
    // unrelated tests, e.g. server.ts import-time HTTP).
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("listCandidates", () => {
    it("GETs /api/atlas/candidates with the bearer token and returns the candidates array", async () => {
      const { calls, fetchMock } = captureFetch(() =>
        jsonResponse(200, {
          candidates: [
            {
              canonicalKey: "runtime:why",
              sourceName: "atlas",
              status: "pending",
            },
          ],
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const result = await client.listCandidates();

      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe("GET");
      expect(calls[0].url).toBe(`${BASE_URL}/api/atlas/candidates`);
      expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(result).toEqual([
        { canonicalKey: "runtime:why", sourceName: "atlas", status: "pending" },
      ]);
    });

    it("passes a ?source= query param when a source filter is given", async () => {
      const { calls, fetchMock } = captureFetch(() =>
        jsonResponse(200, { candidates: [] }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await client.listCandidates({ source: "atlas" });

      expect(calls[0].url).toBe(
        `${BASE_URL}/api/atlas/candidates?source=atlas`,
      );
    });

    it("throws on a non-OK response", async () => {
      const { fetchMock } = captureFetch(() =>
        jsonResponse(500, { error: "boom" }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(client.listCandidates()).rejects.toThrow(/500/);
    });

    it("surfaces a contextful error (not a bare SyntaxError) when a 200 body is not JSON", async () => {
      const { fetchMock } = captureFetch(() =>
        textResponse(200, "<html><body>502 Bad Gateway</body></html>"),
      );
      vi.stubGlobal("fetch", fetchMock);

      const err = await client.listCandidates().then(
        () => {
          throw new Error("expected listCandidates to reject");
        },
        (e: unknown) => e as Error,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err.name).not.toBe("SyntaxError");
      // The wrapped error names the action, the status, and a body slice.
      expect(err.message).toMatch(/list atlas candidates/);
      expect(err.message).toMatch(/200/);
      expect(err.message).toMatch(/502 Bad Gateway/);
    });

    // A 200 whose JSON body lacks the `candidates` array is a broken endpoint
    // (wrong route, proxy JSON error page, contract drift) — returning [] would
    // silently disable every downstream consumer. Fail loud, naming the action.
    it("throws (naming the action) on a 200 body without a candidates array", async () => {
      const { fetchMock } = captureFetch(() => jsonResponse(200, {}));
      vi.stubGlobal("fetch", fetchMock);

      await expect(client.listCandidates()).rejects.toThrow(
        /list atlas candidates/,
      );
    });

    it("throws when the 200 body's candidates key is not an array", async () => {
      const { fetchMock } = captureFetch(() =>
        jsonResponse(200, { candidates: "nope" }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(client.listCandidates()).rejects.toThrow(
        /list atlas candidates/,
      );
    });

    it("returns [] for an explicit empty candidates array", async () => {
      const { fetchMock } = captureFetch(() =>
        jsonResponse(200, { candidates: [] }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(client.listCandidates()).resolves.toEqual([]);
    });
  });

  describe("approve", () => {
    it("POSTs /api/atlas/candidates/approve with the bearer + X-Atlas-Actor header and the canonicalKey body", async () => {
      const { calls, fetchMock } = captureFetch(() =>
        jsonResponse(200, {
          candidate: { canonicalKey: "runtime:why", status: "approved" },
          reindexQueued: true,
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const enacted = await client.approve(
        { canonicalKey: "runtime:why" },
        "reviewer@example.test",
      );

      // The server enacted the approval → resolves true.
      expect(enacted).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe("POST");
      expect(calls[0].url).toBe(`${BASE_URL}/api/atlas/candidates/approve`);
      expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(calls[0].headers["x-atlas-actor"]).toBe("reviewer@example.test");
      expect(calls[0].headers["content-type"]).toMatch(/application\/json/);
      expect(calls[0].body).toEqual({ canonicalKey: "runtime:why" });
    });

    it("forwards an optional reason in the body", async () => {
      const { calls, fetchMock } = captureFetch(() =>
        jsonResponse(200, { candidate: {}, reindexQueued: false }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await client.approve(
        { canonicalKey: "runtime:why", reason: "looks good" },
        "reviewer@example.test",
      );

      expect(calls[0].body).toEqual({
        canonicalKey: "runtime:why",
        reason: "looks good",
      });
    });

    it("treats a 409 (not pending / missing) as an idempotent no-op, NOT an error — and resolves FALSE (not enacted)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { calls, fetchMock } = captureFetch(() =>
        jsonResponse(409, { error: "atlas_candidate_not_approveable" }),
      );
      vi.stubGlobal("fetch", fetchMock);

      // The swallowed 409 means the server REFUSED the enactment (already
      // settled / missing) — the no-op must not throw, but it must report
      // `false` so callers never tally the key as enacted.
      await expect(
        client.approve(
          { canonicalKey: "already:done" },
          "reviewer@example.test",
        ),
      ).resolves.toBe(false);
      expect(calls).toHaveLength(1);
      // The swallowed 409 is logged (greppable) with the canonical_key + action,
      // but logging must NOT change the no-op behavior.
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = warn.mock.calls[0].map(String).join(" ");
      expect(logged).toMatch(/\[atlas\]/);
      expect(logged).toMatch(/already:done/);
      expect(logged).toMatch(/approve/);
    });

    it("throws with context on an UNEXPECTED 409 (not the AtlasSeedNotPendingError marker)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { fetchMock } = captureFetch(() =>
        jsonResponse(409, { error: "some_other_conflict" }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const err = await client
        .approve({ canonicalKey: "runtime:why" }, "reviewer@example.test")
        .then(
          () => {
            throw new Error("expected approve to reject on an unexpected 409");
          },
          (e: unknown) => e as Error,
        );
      expect(err.message).toMatch(/409/);
      expect(err.message).toMatch(/runtime:why/);
      // An unexpected 409 is a real failure — not the swallowed-no-op log path.
      expect(warn).not.toHaveBeenCalled();
    });

    it("throws on a non-409 error response", async () => {
      const { fetchMock } = captureFetch(() =>
        jsonResponse(401, { error: "unauthorized" }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        client.approve(
          { canonicalKey: "runtime:why" },
          "reviewer@example.test",
        ),
      ).rejects.toThrow(/401/);
    });
  });

  describe("reject", () => {
    it("POSTs /api/atlas/candidates/reject with the bearer + X-Atlas-Actor header and a reason", async () => {
      const { calls, fetchMock } = captureFetch(() =>
        jsonResponse(200, {
          candidate: { canonicalKey: "runtime:why", status: "rejected" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const enacted = await client.reject(
        { canonicalKey: "runtime:why", reason: "incorrect inference" },
        "reviewer@example.test",
      );

      // The server enacted the rejection → resolves true.
      expect(enacted).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe("POST");
      expect(calls[0].url).toBe(`${BASE_URL}/api/atlas/candidates/reject`);
      expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(calls[0].headers["x-atlas-actor"]).toBe("reviewer@example.test");
      expect(calls[0].body).toEqual({
        canonicalKey: "runtime:why",
        reason: "incorrect inference",
      });
    });

    it("treats a 409 (not pending / missing) as an idempotent no-op — and resolves FALSE (not enacted)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { calls, fetchMock } = captureFetch(() =>
        jsonResponse(409, { error: "atlas_candidate_not_rejectable" }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        client.reject(
          { canonicalKey: "already:done" },
          "reviewer@example.test",
        ),
      ).resolves.toBe(false);
      expect(calls).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  describe("reindex", () => {
    it("POSTs /admin/reindex with the bearer token and a full-scope body", async () => {
      const { calls, fetchMock } = captureFetch(() =>
        jsonResponse(202, { queued: "full" }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await client.reindex({ scope: "full" });

      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe("POST");
      expect(calls[0].url).toBe(`${BASE_URL}/admin/reindex`);
      expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(calls[0].body).toEqual({ scope: "full" });
    });

    it("forwards a source-scoped reindex body", async () => {
      const { calls, fetchMock } = captureFetch(() =>
        jsonResponse(202, { queued: { source: "atlas" } }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await client.reindex({ scope: "source", source: "atlas" });

      expect(calls[0].body).toEqual({ scope: "source", source: "atlas" });
    });

    it("forwards a repo-scoped reindex body", async () => {
      const { calls, fetchMock } = captureFetch(() =>
        jsonResponse(202, { queued: { repo: "https://github.com/x/y" } }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await client.reindex({
        scope: "repo",
        repo: "https://github.com/x/y",
      });

      expect(calls[0].body).toEqual({
        scope: "repo",
        repo: "https://github.com/x/y",
      });
    });

    it("throws on a non-2xx reindex response", async () => {
      const { fetchMock } = captureFetch(() =>
        jsonResponse(503, { error: "orchestrator_unavailable" }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(client.reindex({ scope: "full" })).rejects.toThrow(/503/);
    });
  });

  describe("search", () => {
    it("probes the live search endpoint with the query text and returns the hits", async () => {
      const hits = [
        {
          id: 1,
          content: "Existing corpus passage about the runtime.",
          title: "Runtime",
          sourceUrl: "https://example.test/runtime",
          sourceName: "atlas",
          score: 0.91,
        },
      ];
      const { calls, fetchMock } = captureFetch(() =>
        jsonResponse(200, { hits }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const result = await client.search({ text: "runtime shape" });

      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe("GET");
      expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
      const url = new URL(calls[0].url);
      expect(url.pathname).toBe("/api/search");
      expect(url.searchParams.get("text")).toBe("runtime shape");
      expect(result).toEqual(hits);
    });

    it("passes source + limit query params when provided", async () => {
      const { calls, fetchMock } = captureFetch(() =>
        jsonResponse(200, { hits: [] }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await client.search({ text: "abc", source: "atlas", limit: 5 });

      const url = new URL(calls[0].url);
      expect(url.searchParams.get("text")).toBe("abc");
      expect(url.searchParams.get("source")).toBe("atlas");
      expect(url.searchParams.get("limit")).toBe("5");
    });

    it("throws on a non-OK search response", async () => {
      const { fetchMock } = captureFetch(() =>
        jsonResponse(500, { error: "boom" }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(client.search({ text: "abc" })).rejects.toThrow(/500/);
    });

    it("surfaces a contextful error (not a bare SyntaxError) when a 200 body is not JSON", async () => {
      const { fetchMock } = captureFetch(() =>
        textResponse(200, "not json at all"),
      );
      vi.stubGlobal("fetch", fetchMock);

      const err = await client.search({ text: "abc" }).then(
        () => {
          throw new Error("expected search to reject");
        },
        (e: unknown) => e as Error,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err.name).not.toBe("SyntaxError");
      expect(err.message).toMatch(/probe atlas search/);
      expect(err.message).toMatch(/200/);
      expect(err.message).toMatch(/not json at all/);
    });

    // A wrong-shaped 200 (no `hits` array) silently returning [] would disable
    // rag-dedup entirely — the probe target is not yet a confirmed live route,
    // so this is exactly the failure mode that must be LOUD.
    it("throws (naming the action) on a 200 body without a hits array", async () => {
      const { fetchMock } = captureFetch(() => jsonResponse(200, {}));
      vi.stubGlobal("fetch", fetchMock);

      await expect(client.search({ text: "abc" })).rejects.toThrow(
        /probe atlas search/,
      );
    });

    it("throws when the 200 body's hits key is not an array", async () => {
      const { fetchMock } = captureFetch(() =>
        jsonResponse(200, { hits: { weird: true } }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(client.search({ text: "abc" })).rejects.toThrow(
        /probe atlas search/,
      );
    });

    it("returns [] for an explicit empty hits array", async () => {
      const { fetchMock } = captureFetch(() => jsonResponse(200, { hits: [] }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(client.search({ text: "abc" })).resolves.toEqual([]);
    });
  });

  describe("base URL handling", () => {
    it("strips a trailing slash from the base URL so paths are not doubled", async () => {
      const trailing = new AtlasHttpClient({
        baseUrl: `${BASE_URL}/`,
        token: TOKEN,
      });
      const { calls, fetchMock } = captureFetch(() =>
        jsonResponse(200, { candidates: [] }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await trailing.listCandidates();

      expect(calls[0].url).toBe(`${BASE_URL}/api/atlas/candidates`);
    });
  });
});
