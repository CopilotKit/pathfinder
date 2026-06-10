// Atlas HTTP client — a thin, typed wrapper over the Pathfinder server routes
// (§4.10, §11.3, §14). The harvest NEVER re-implements ratification: it drives
// the same endpoints the human reviewer's tooling does —
//
//   GET  /api/atlas/candidates          → list pending candidates (live)
//   POST /api/atlas/candidates/approve  → approve (X-Atlas-Actor attribution; live)
//   POST /api/atlas/candidates/reject   → reject  (X-Atlas-Actor attribution; live)
//   POST /admin/reindex                 → queue a (scoped) reindex (live)
//   GET  /api/search                    → RAG-corpus probe for rag-dedup. NOT an
//                                         existing live route on the server today
//                                         — the runtime probe target is a plan
//                                         open item, to be wired/confirmed before
//                                         the first live harvest run.
//
// Every request carries the bearer ANALYTICS_TOKEN (the same token the
// ratification routes authenticate with — see src/server.ts). Approving or
// rejecting a candidate that is already settled (or never existed) returns a
// 409 from the server (the AtlasSeedNotPendingError surface); the harvest
// treats that as an IDEMPOTENT no-op, not an error, so a re-run of the sync
// step does not throw on rows a prior run already enacted.

// A single RAG search hit returned by the live search probe. Shape mirrors the
// indexable chunk surface (src/types.ts ChunkResult) so rag-dedup (S21) can
// compare a candidate against already-indexed corpus content. Optional fields
// tolerate endpoints that omit scoring/attribution metadata.
export interface SearchHit {
  id?: number;
  content: string;
  title?: string | null;
  sourceUrl?: string | null;
  sourceName?: string;
  score?: number;
}

// A pending candidate as returned by GET /api/atlas/candidates. The server
// serializes the camelCase AtlasSeedEntry shape (canonicalKey, sourceName,
// status, …); we keep this loose so the client does not couple to every column
// — callers that need the full row narrow it themselves.
export interface PendingCandidate {
  canonicalKey: string;
  sourceName: string;
  status: string;
  [key: string]: unknown;
}

export interface AtlasHttpClientOptions {
  baseUrl: string;
  token: string;
}

export interface RatifyInput {
  canonicalKey: string;
  reason?: string;
}

export interface ReindexScope {
  scope: "full" | "source" | "repo";
  source?: string;
  repo?: string;
}

export interface SearchQuery {
  text: string;
  source?: string;
  limit?: number;
}

const ACTOR_HEADER = "X-Atlas-Actor";

export class AtlasHttpClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(opts: AtlasHttpClientOptions) {
    // Normalize away a trailing slash so `${baseUrl}${path}` never doubles the
    // separator (a doubled slash can 404 or bypass route matching).
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
  }

  // GET /api/atlas/candidates[?source=<name>]
  // `source` is an OPTIONAL filter and `""` counts as ABSENT (the module's
  // empty-is-absent rule): `{ source: "" }` lists ALL candidates, exactly like
  // omitting it. Pass undefined or a non-empty source name to filter.
  async listCandidates(opts?: {
    source?: string;
  }): Promise<PendingCandidate[]> {
    const query = opts?.source
      ? `?source=${encodeURIComponent(opts.source)}`
      : "";
    const res = await this.fetch(`/api/atlas/candidates${query}`, {
      method: "GET",
    });
    await this.assertOk(res, "list atlas candidates");
    const body = await this.parseJson<{ candidates?: unknown }>(
      res,
      "list atlas candidates",
    );
    // A 200 whose body lacks the `candidates` array (wrong route, proxy JSON
    // error page, contract drift) is a broken endpoint — returning [] would
    // silently present "nothing pending" to every consumer. Fail loud; `[]` is
    // reserved for an EXPLICIT empty array from the server.
    if (!Array.isArray(body?.candidates)) {
      throw new Error(
        `Atlas list atlas candidates returned an unexpected 200 body (no "candidates" array): ${JSON.stringify(body).slice(0, 200)}`,
      );
    }
    return body.candidates as PendingCandidate[];
  }

  // POST /api/atlas/candidates/approve — idempotent: a 409 (already settled or
  // missing) is a no-op, not an error. Resolves `true` when the server ENACTED
  // the approval, `false` when the idempotent 409 was swallowed (the server
  // refused — already settled / missing), so callers never tally a refused
  // enactment as approved.
  async approve(input: RatifyInput, actor: string): Promise<boolean> {
    return this.ratify(
      "/api/atlas/candidates/approve",
      input,
      actor,
      "approve",
    );
  }

  // POST /api/atlas/candidates/reject — idempotent: a 409 is a no-op. Resolves
  // `true` when enacted, `false` when the idempotent 409 was swallowed.
  async reject(input: RatifyInput, actor: string): Promise<boolean> {
    return this.ratify("/api/atlas/candidates/reject", input, actor, "reject");
  }

  // POST /admin/reindex — queues a full/source/repo-scoped reindex. The server
  // replies 202 Accepted with `{ queued: ... }`; we only care that it was
  // accepted, so the return is void.
  async reindex(scope: ReindexScope): Promise<void> {
    const res = await this.fetch("/admin/reindex", {
      method: "POST",
      body: scope,
    });
    await this.assertOk(res, "queue atlas reindex");
  }

  // GET /api/search — probe the RAG corpus for overlap with a candidate. Used
  // by the rag-dedup stage (S21) to find verbatim/near-verbatim matches against
  // already-indexed content. NOTE: this route does not exist on the server yet
  // (see the header) — the probe target must be wired/confirmed before live
  // runs, which is exactly why a wrong-shaped 200 below fails LOUD instead of
  // quietly disabling rag-dedup.
  async search(query: SearchQuery): Promise<SearchHit[]> {
    const params = new URLSearchParams({ text: query.text });
    if (query.source) params.set("source", query.source);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const res = await this.fetch(`/api/search?${params.toString()}`, {
      method: "GET",
    });
    await this.assertOk(res, "probe atlas search");
    const body = await this.parseJson<{ hits?: unknown }>(
      res,
      "probe atlas search",
    );
    // Same fail-loud contract as listCandidates: a 200 without a `hits` array
    // means the probe endpoint is broken/misrouted; [] would silently disable
    // rag-dedup (every candidate would look novel).
    if (!Array.isArray(body?.hits)) {
      throw new Error(
        `Atlas probe atlas search returned an unexpected 200 body (no "hits" array): ${JSON.stringify(body).slice(0, 200)}`,
      );
    }
    return body.hits as SearchHit[];
  }

  // Shared ratification path. A 409 carrying the server's
  // AtlasSeedNotPendingError marker (`atlas_candidate_not_<action>able`) means
  // the row is already approved/rejected or never existed — an idempotent no-op
  // for a re-run, so we swallow it (but LOG it, greppable, with the
  // canonical_key + action) and resolve FALSE so the caller knows the server
  // did NOT enact this ratification. A 409 WITHOUT that marker is an unexpected
  // conflict we must NOT silently swallow — we surface it with context. Any
  // other non-OK status is a real failure and throws via assertOk. Resolves
  // TRUE only when the server actually enacted the action.
  private async ratify(
    path: string,
    input: RatifyInput,
    actor: string,
    action: "approve" | "reject",
  ): Promise<boolean> {
    const res = await this.fetch(path, {
      method: "POST",
      actor,
      body: input,
    });
    if (res.status === 409) {
      const detail = await this.readBody(res);
      // The documented 409 surface is AtlasSeedNotPendingError, serialized as
      // `{ error: "atlas_candidate_not_<action>able", ... }`. Only no-op when
      // that marker is present; any other 409 is unexpected and throws.
      //
      // LOCKSTEP: this template MUST stay byte-identical to the server's
      // serialization in handleAtlasRatificationError (server.ts). For
      // action="approve" it yields "atlas_candidate_not_approveable" — yes,
      // "approveable" (sic) rather than dictionary "approvable" — but BOTH
      // sides derive it mechanically from `${action}able`, so the wire is
      // consistent. Do NOT "fix" the spelling on one side only: change both
      // in lockstep or not at all, or every not-pending 409 stops being
      // recognized and THROWS instead of no-opping.
      if (detail.includes(`atlas_candidate_not_${action}able`)) {
        console.warn(
          `[atlas] swallowed idempotent 409 on ${action} for canonical_key="${input.canonicalKey}" (AtlasSeedNotPendingError — already settled or missing)`,
        );
        return false;
      }
      throw new Error(
        `Atlas ${action} atlas candidate "${input.canonicalKey}" got an unexpected HTTP 409${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
    }
    await this.assertOk(
      res,
      `${action} atlas candidate "${input.canonicalKey}"`,
    );
    return true;
  }

  private async fetch(
    path: string,
    opts: { method: string; body?: unknown; actor?: string },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    if (opts.actor) headers[ACTOR_HEADER] = opts.actor;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(`${this.baseUrl}${path}`, {
      method: opts.method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  }

  // Mirror src/atlas-cli.ts's error idiom: surface the status + a bounded slice
  // of the response body so a failed harvest call is greppable and actionable.
  private async assertOk(res: Response, action: string): Promise<void> {
    if (res.ok) return;
    const detail = await this.readBody(res);
    throw new Error(
      `Atlas ${action} failed: HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }

  // Read a response body as text without throwing — a consumed/unreadable body
  // is not itself the failure we are reporting on, so we degrade to "".
  private async readBody(res: Response): Promise<string> {
    try {
      return await res.text();
    } catch {
      // body already consumed or unreadable — the status alone is actionable.
      return "";
    }
  }

  // Parse a known-OK response as JSON, wrapping a parse failure with the same
  // action + status + body-slice context as assertOk. A non-JSON 200 (an
  // upstream proxy's HTML interstitial, an empty body) otherwise throws an
  // opaque SyntaxError with no indication of which call or endpoint failed.
  private async parseJson<T>(res: Response, action: string): Promise<T> {
    const text = await this.readBody(res);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(
        `Atlas ${action} returned a non-JSON response: HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : " (empty body)"}`,
      );
    }
  }
}
