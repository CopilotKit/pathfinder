import { describe, it, expect, vi, beforeEach } from "vitest";

// Follow-up coverage to strip-nul-bytes.test.ts (PR #114, chunk write path).
// PR #114 sanitized the chunks INSERT/DELETE paths; this file pins the same
// invariant on every OTHER text-typed bind on Postgres TEXT/JSONB columns that
// is fed by caller input. Mirrors the existing test's mocking pattern: a
// pooled client capture for transactional code and a pool.query capture for
// direct queries.

const clientQuery = vi.fn();
const clientRelease = vi.fn();
const connect = vi.fn(async () => ({
  query: clientQuery,
  release: clientRelease,
}));
const poolQuery = vi.fn();

vi.mock("../db/client.js", () => ({
  getPool: () => ({ connect, query: poolQuery }),
}));

vi.mock("pgvector", () => ({
  default: { toSql: (v: unknown) => v },
}));

// Import AFTER mocking so queries.ts binds to the mocked getPool.
import {
  insertCollectedData,
  recordWebhookDelivery,
  upsertIndexState,
  textSearchChunks,
  getIndexedItemIds,
  getIndexState,
  searchChunks,
  getFaqChunks,
} from "../db/queries.js";

const NUL = "\x00";

beforeEach(() => {
  poolQuery.mockReset();
  poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  clientQuery.mockReset();
  clientRelease.mockReset();
  connect.mockClear();
  clientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

describe("insertCollectedData NUL sanitization", () => {
  it("strips NUL from tool_name AND from every string in the JSONB data blob (keys + values, nested)", async () => {
    // collected_data is fed by user MCP input (collect.ts) and raw shell
    // command strings (bash-telemetry.ts). A NUL anywhere in the JSONB blob
    // (including object keys) errors the cast with `invalid byte sequence
    // for encoding "UTF8": 0x00` and fails the INSERT. The deep sanitizer
    // must walk the entire structure.
    await insertCollectedData(`bash${NUL}-telemetry`, {
      cmd: `printf '${NUL}' | xxd`,
      nested: { [`key${NUL}A`]: `v${NUL}` },
      arr: [`a${NUL}b`, "ok"],
    });

    expect(poolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(String(sql)).toContain("INSERT INTO collected_data");

    const [toolName, dataJson] = params as [string, string];
    expect(toolName).toBe("bash-telemetry");
    expect(toolName).not.toContain(NUL);

    // JSON.stringify escapes a literal NUL to the 6-char sequence \\u0000.
    // The meaningful assertion is on the escape, not on the literal byte
    // (the escape would still fail the jsonb cast on the wire). Same lesson
    // as PR #114's metadata jsonb assertion.
    expect(dataJson).not.toContain(NUL);
    expect(dataJson).not.toContain("\\u0000");
    const parsed = JSON.parse(dataJson);
    expect(parsed).toEqual({
      cmd: "printf '' | xxd",
      nested: { keyA: "v" },
      arr: ["ab", "ok"],
    });
  });
});

describe("recordWebhookDelivery NUL sanitization", () => {
  it("strips NUL from every text bind (source, event_type, repo, decision, reason)", async () => {
    // Webhook payloads are partly attacker-influenced — event_type/repo/reason
    // come from incoming HTTP bodies. The function is fire-and-forget (the
    // outer try/catch swallows errors), so an unsanitized NUL would surface
    // as a silently dropped tracking row, not a visible failure. Pin the
    // sanitization at the bind site so we never write — or attempt to write —
    // a NUL into webhook_deliveries.
    await recordWebhookDelivery({
      source: `git${NUL}hub`,
      event_type: `pull${NUL}_request`,
      repo: `CopilotKit/${NUL}pathfinder`,
      decision: `acce${NUL}pted`,
      reason: `ok ${NUL} done`,
      payload_size: 42,
    });

    expect(poolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(String(sql)).toContain("INSERT INTO webhook_deliveries");
    const [source, eventType, repo, decision, reason, size] =
      params as unknown[];

    expect(source).toBe("github");
    expect(eventType).toBe("pull_request");
    expect(repo).toBe("CopilotKit/pathfinder");
    expect(decision).toBe("accepted");
    expect(reason).toBe("ok  done");
    expect(size).toBe(42);

    for (const v of [source, eventType, repo, decision, reason]) {
      expect(String(v)).not.toContain(NUL);
    }
  });

  it("preserves null optional fields (does not stringify null through the sanitizer)", async () => {
    await recordWebhookDelivery({
      source: "github",
      decision: "rejected",
      // event_type / repo / reason / payload_size omitted
    });

    const [, params] = poolQuery.mock.calls[0];
    const [, eventType, repo, , reason, size] = params as unknown[];
    expect(eventType).toBeNull();
    expect(repo).toBeNull();
    expect(reason).toBeNull();
    expect(size).toBeNull();
  });
});

describe("upsertIndexState NUL sanitization", () => {
  it("strips NUL from every text bind, including the poison-pill error_message path", async () => {
    // The highest-risk column is error_message: it's populated with raw
    // upstream errors. If a chunks-INSERT fails with `invalid byte sequence
    // for encoding "UTF8": 0x00`, the orchestrator persists the error string
    // — which literally contains the offending 0x00 byte — into index_state.
    // Without sanitization, the index_state UPDATE itself re-trips the same
    // encoding rejection, turning a transient failure into a poison-pill
    // loop. Sanitize all binds; pin error_message explicitly.
    await upsertIndexState({
      source_type: `git${NUL}hub`,
      source_key: `repo${NUL}-key`,
      last_commit_sha: `sha${NUL}123`,
      last_indexed_at: new Date(0),
      status: "error",
      error_message: `invalid byte sequence for encoding "UTF8": 0x${NUL}00`,
    });

    expect(poolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(String(sql)).toContain("INSERT INTO index_state");
    const [sourceType, sourceKey, sha, , status, errMsg] = params as unknown[];
    expect(sourceType).toBe("github");
    expect(sourceKey).toBe("repo-key");
    expect(sha).toBe("sha123");
    expect(status).toBe("error");
    expect(String(errMsg)).not.toContain(NUL);
    expect(String(errMsg)).toBe(
      'invalid byte sequence for encoding "UTF8": 0x00',
    );

    for (const v of [sourceType, sourceKey, sha, status, errMsg]) {
      expect(String(v)).not.toContain(NUL);
    }
  });

  it("preserves null optional fields", async () => {
    await upsertIndexState({
      source_type: "github",
      source_key: "k",
      last_commit_sha: null,
      last_indexed_at: null,
      status: "idle",
      error_message: null,
    });

    const [, params] = poolQuery.mock.calls[0];
    const [, , sha, lastAt, , err] = params as unknown[];
    expect(sha).toBeNull();
    expect(lastAt).toBeNull();
    expect(err).toBeNull();
  });

  it("defaults status to 'idle' (sanitizer must not perturb the default-substitution)", async () => {
    // The implementation uses `state.status ?? "idle"`; the sanitizer wraps
    // that expression. Pin the default still flows through cleanly.
    await upsertIndexState({
      source_type: "github",
      source_key: "k",
      last_commit_sha: null,
      last_indexed_at: null,
      // status omitted intentionally — exercises the `?? "idle"` default path
      error_message: null,
    });
    const [, params] = poolQuery.mock.calls[0];
    expect((params as unknown[])[4]).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------
//
// Readers matter because the chunks table is WRITTEN with stripNulBytes
// applied (PR #114), so the stored values are sanitized. An unsanitized reader
// bind has two failure modes:
//   (a) crash the SELECT with `invalid byte sequence for encoding "UTF8":
//       0x00` (Postgres rejects 0x00 in TEXT binds identically to INSERT/UPDATE
//       — `plainto_tsquery`'s input is a TEXT bind on the wire);
//   (b) return zero rows because the WHERE comparand carries a NUL while the
//       stored value does not — silent inconsistency that's far worse than a
//       loud encoding error.

describe("textSearchChunks NUL sanitization", () => {
  it("strips NUL from pattern, sourceName, and version binds", async () => {
    await textSearchChunks(`query${NUL}text`, 5, `src${NUL}name`, `v${NUL}1`);

    expect(poolQuery).toHaveBeenCalledTimes(1);
    const [, params] = poolQuery.mock.calls[0];
    const [pattern, source, version, limit] = params as unknown[];
    expect(pattern).toBe("querytext");
    expect(source).toBe("srcname");
    expect(version).toBe("v1");
    expect(limit).toBe(5);
    for (const v of [pattern, source, version]) {
      expect(String(v)).not.toContain(NUL);
    }
  });

  it("early-returns on empty pattern without binding (no query issued)", async () => {
    // Guards the existing pattern.trim() short-circuit — the sanitizer must
    // not change that behavior.
    const out = await textSearchChunks("   ", 5);
    expect(out).toEqual([]);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it("early-returns on NUL-only pattern without binding (no query issued)", async () => {
    // A NUL-only pattern survives `pattern.trim()` (NUL is not whitespace),
    // then sanitizes to "" — issuing a useless plainto_tsquery DB roundtrip
    // against an empty string. Sanitize FIRST, then check empty/whitespace.
    const out = await textSearchChunks(`${NUL}${NUL}${NUL}`, 5);
    expect(out).toEqual([]);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it("omits the source_name filter when sourceName is NUL-only (sanitize-then-truthy)", async () => {
    // Truthy check on the RAW sourceName lets `"\x00"` through; sanitization
    // then produces `""`, and the WHERE filter becomes `source_name = ''` —
    // which matches zero rows because the writer stores NUL-stripped
    // (non-empty) values. The keyword half of hybridSearchChunks's RRF merge
    // is silently zeroed out on NUL-bearing source filters. Eager-sanitize
    // at function entry and skip the filter when the sanitized result is
    // empty — same discipline as searchChunks.
    await textSearchChunks("query", 5, `${NUL}${NUL}`);
    expect(poolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(String(sql)).not.toMatch(/source_name\s*=\s*\$/);
    // Only the tsquery pattern bind and the limit bind survive.
    const paramArr = params as unknown[];
    expect(paramArr.length).toBe(2);
    for (const v of paramArr) {
      expect(String(v)).not.toBe("");
    }
  });

  it("omits the version filter when version is NUL-only (sanitize-then-truthy)", async () => {
    await textSearchChunks("query", 5, undefined, `${NUL}${NUL}`);
    expect(poolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(String(sql)).not.toMatch(/version\s*=\s*\$/);
    const paramArr = params as unknown[];
    expect(paramArr.length).toBe(2);
    for (const v of paramArr) {
      expect(String(v)).not.toBe("");
    }
  });
});

describe("getIndexedItemIds NUL sanitization", () => {
  it("strips NUL from the source_name bind", async () => {
    await getIndexedItemIds(`ag-ui${NUL}code`);
    expect(poolQuery).toHaveBeenCalledTimes(1);
    const [, params] = poolQuery.mock.calls[0];
    expect((params as unknown[])[0]).toBe("ag-uicode");
    expect(String((params as unknown[])[0])).not.toContain(NUL);
  });
});

describe("getIndexState NUL sanitization", () => {
  it("strips NUL from sourceType and sourceKey binds", async () => {
    await getIndexState(`git${NUL}hub`, `repo${NUL}-key`);
    expect(poolQuery).toHaveBeenCalledTimes(1);
    const [, params] = poolQuery.mock.calls[0];
    const [t, k] = params as unknown[];
    expect(t).toBe("github");
    expect(k).toBe("repo-key");
    for (const v of [t, k]) expect(String(v)).not.toContain(NUL);
  });
});

describe("searchChunks NUL sanitization", () => {
  it("strips NUL from sourceName and version binds (vector embedding param untouched)", async () => {
    await searchChunks([0.1, 0.2], 10, `src${NUL}name`, `v${NUL}1`);
    expect(poolQuery).toHaveBeenCalledTimes(1);
    const [, params] = poolQuery.mock.calls[0];
    // params[0] = embedding (pgvector.toSql passthrough), $2 = sourceName,
    // $3 = version, $4 = limit
    const [, source, version, limit] = params as unknown[];
    expect(source).toBe("srcname");
    expect(version).toBe("v1");
    expect(limit).toBe(10);
    for (const v of [source, version]) {
      expect(String(v)).not.toContain(NUL);
    }
  });

  it("does not bind a sanitized sourceName when the caller passes undefined (filter skipped)", async () => {
    // Sanitization must not synthesize a bind where there wasn't one — the
    // sourceName / version filters are conditional. A NUL-stripping helper
    // applied before the conditional check would have inadvertently added an
    // empty-string source filter; the fix's `if (sourceName)` guard runs first.
    await searchChunks([0.1], 10);
    const [, params] = poolQuery.mock.calls[0];
    // Only the embedding and the limit bind ($2) — no source/version.
    expect((params as unknown[]).length).toBe(2);
  });

  it("omits the source_name filter when sourceName is NUL-only (sanitize-then-truthy)", async () => {
    // Truthy check on the RAW input lets `"\x00"` through; sanitization then
    // produces `""`, and the WHERE filter becomes `source_name = ''` — which
    // matches zero rows because the writer stores NUL-stripped (non-empty)
    // values. Mirror the textSearchChunks discipline: sanitize FIRST, then
    // skip the filter when empty.
    await searchChunks([0.1, 0.2], 10, `${NUL}${NUL}`);
    expect(poolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(String(sql)).not.toMatch(/source_name\s*=\s*\$/);
    // No empty-string source_name bind smuggled in: only embedding + limit.
    expect((params as unknown[]).length).toBe(2);
  });

  it("omits the version filter when version is NUL-only (sanitize-then-truthy)", async () => {
    await searchChunks([0.1, 0.2], 10, undefined, `${NUL}${NUL}`);
    expect(poolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(String(sql)).not.toMatch(/version\s*=\s*\$/);
    expect((params as unknown[]).length).toBe(2);
  });
});

describe("getFaqChunks NUL sanitization", () => {
  it("strips NUL from every source_name in the array bind", async () => {
    await getFaqChunks([`docs${NUL}-a`, "docs-b", `docs${NUL}-c`], 0.5, 20);

    expect(poolQuery).toHaveBeenCalledTimes(1);
    const [, params] = poolQuery.mock.calls[0];
    const [a, b, c, minConf, limit] = params as unknown[];
    expect(a).toBe("docs-a");
    expect(b).toBe("docs-b");
    expect(c).toBe("docs-c");
    expect(minConf).toBe(0.5);
    expect(limit).toBe(20);
    for (const v of [a, b, c]) {
      expect(String(v)).not.toContain(NUL);
    }
  });

  it("empty sourceNames input returns early (no query issued)", async () => {
    const out = await getFaqChunks([], 0.0);
    expect(out).toEqual([]);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it("returns [] without issuing a query when every sourceName is NUL-only (sanitize-then-filter)", async () => {
    // sourceNames.map(stripNulBytes) on `["\x00", "\x00\x00"]` would yield
    // `["", ""]`, then bind those to `WHERE source_name IN ('', '')` — which
    // matches zero rows because the writer never stores empty source_name.
    // Filter empty entries AFTER sanitization; if nothing remains, skip the
    // query entirely (same semantic as the existing `length === 0` guard).
    const out = await getFaqChunks([`${NUL}`, `${NUL}${NUL}`], 0.5, 20);
    expect(out).toEqual([]);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it("drops NUL-only entries from the IN bind list while keeping real source names", async () => {
    // Mixed-list case: one real source, one NUL-only. The NUL-only entry must
    // not survive as `""` in the params, or it pollutes the IN clause with a
    // never-matching empty-string comparand. Real entries flow through
    // sanitized as before.
    await getFaqChunks([`docs-a`, `${NUL}`, `docs-b`], 0.5, 20);
    expect(poolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = poolQuery.mock.calls[0];
    // Two placeholders only — the NUL-only entry was dropped.
    expect(String(sql)).toMatch(/source_name IN \(\$1, \$2\)/);
    const [a, b, minConf, limit] = params as unknown[];
    expect(a).toBe("docs-a");
    expect(b).toBe("docs-b");
    expect(minConf).toBe(0.5);
    expect(limit).toBe(20);
    for (const v of params as unknown[]) {
      expect(String(v)).not.toContain(NUL);
    }
    // Pin no empty-string entry slipped through.
    for (const v of [a, b]) expect(v).not.toBe("");
  });
});
