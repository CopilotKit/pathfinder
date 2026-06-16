import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Chunk } from "../types.js";

// Mock the db client to intercept the pooled-client lifecycle and observe the
// exact positional params replaceChunksForFile binds to each INSERT. Mirrors
// replace-chunks.test.ts so the binding pattern stays consistent across the
// queries.ts test suite.
const clientQuery = vi.fn();
const clientRelease = vi.fn();
const connect = vi.fn(async () => ({
  query: clientQuery,
  release: clientRelease,
}));
// Pool-level query, used by deleteChunksByFile/deleteChunksBySource (these
// don't `connect()` a client — they go through pool.query directly).
const poolQuery = vi.fn();

vi.mock("../db/client.js", () => ({
  getPool: () => ({ connect, query: poolQuery }),
}));

vi.mock("pgvector", () => ({
  default: { toSql: (v: unknown) => v },
}));

// Import AFTER mocking so queries.ts binds to the mocked getPool.
import {
  replaceChunksForFile,
  deleteChunksByFile,
  deleteChunksBySource,
  stripNulBytes,
  stripNulBytesDeep,
  upsertChunks,
} from "../db/queries.js";

function mkChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    source_name: "ag-ui-code",
    source_url: null,
    title: "validate.ts",
    content: "body",
    embedding: [0.1, 0.2, 0.3],
    repo_url: null,
    file_path: "sdks/typescript/packages/a2ui-toolkit/src/validate.ts",
    start_line: null,
    end_line: null,
    language: "typescript",
    chunk_index: 0,
    metadata: {},
    commit_sha: "94f8f06d",
    version: null,
    ...overrides,
  };
}

describe("stripNulBytes (unit)", () => {
  it("drops a literal NUL byte from the middle of a string", () => {
    // The exact pattern that bricked ag-ui-code: a join("\x00") separator
    // landing inside indexed content. Drop, don't escape.
    expect(stripNulBytes('cyc.join("\x00")')).toBe('cyc.join("")');
  });

  it("returns the input string identity-equal when no NUL is present (hot path)", () => {
    // The fast-fail branch — most chunks never contain a NUL, so the helper
    // must not allocate a new string for them. Identity-equality pins that.
    const s = "ordinary indexed content";
    expect(stripNulBytes(s)).toBe(s);
  });

  it("drops multiple NULs and adjacent runs", () => {
    expect(stripNulBytes("a\x00\x00b\x00c")).toBe("abc");
  });

  it("leaves the empty string untouched", () => {
    expect(stripNulBytes("")).toBe("");
  });
});

describe("replaceChunksForFile NUL sanitization (integration)", () => {
  beforeEach(() => {
    clientQuery.mockReset();
    clientRelease.mockReset();
    connect.mockClear();
    clientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  function insertCalls() {
    return clientQuery.mock.calls.filter((c) =>
      String(c[0]).includes("INSERT INTO chunks"),
    );
  }

  it("strips NUL from content before binding the INSERT param (the regression)", async () => {
    // This is the exact failure mode that took ag-ui-code RED: a chunk whose
    // content contains "\x00" (from validate.ts's `cyc.join("\x00")`) hits
    // Postgres and errors with `invalid byte sequence for encoding "UTF8": 0x00`,
    // failing the INSERT, holding the source's state token, and blocking every
    // downstream diff from landing. The fix must sanitize at chunk-insert time.
    const dirty = 'const key = cyc.join("\x00");';
    await replaceChunksForFile("ag-ui-code", "validate.ts", [
      mkChunk({ content: dirty }),
    ]);

    const inserts = insertCalls();
    expect(inserts).toHaveLength(1);
    // content is the 4th positional param (1-indexed $4) per INSERT_CHUNK_SQL.
    const contentParam = inserts[0][1][3] as string;
    expect(contentParam).not.toContain("\x00");
    expect(contentParam).toBe('const key = cyc.join("");');
  });

  it("strips NUL from every text-typed param and from metadata jsonb", async () => {
    await replaceChunksForFile("src\x00name", "file\x00.ts", [
      mkChunk({
        source_name: "src\x00name",
        source_url: "https://example.com/\x00",
        title: "T\x00itle",
        content: "bo\x00dy",
        repo_url: "https://r.example/\x00",
        file_path: "file\x00.ts",
        language: "type\x00script",
        commit_sha: "sh\x00a",
        version: "v\x001",
        metadata: {
          headingPath: ["a\x00b", "c"],
          extra: { nested: "x\x00y" },
        },
      }),
    ]);

    const inserts = insertCalls();
    expect(inserts).toHaveLength(1);
    const params = inserts[0][1] as unknown[];

    // Every text param ($1, $2, $3, $4, $6, $7, $10, $13, $14) is sanitized.
    expect(params[0]).toBe("srcname"); // source_name
    expect(params[1]).toBe("https://example.com/"); // source_url
    expect(params[2]).toBe("Title"); // title
    expect(params[3]).toBe("body"); // content
    expect(params[5]).toBe("https://r.example/"); // repo_url
    expect(params[6]).toBe("file.ts"); // file_path
    expect(params[9]).toBe("typescript"); // language
    expect(params[12]).toBe("sha"); // commit_sha
    expect(params[13]).toBe("v1"); // version

    // metadata is serialized to JSON ($12) with every string member sanitized.
    const metadataJson = params[11] as string;
    expect(metadataJson).not.toContain("\\u0000");
    const parsed = JSON.parse(metadataJson);
    expect(parsed).toEqual({
      headingPath: ["ab", "c"],
      extra: { nested: "xy" },
    });

    // And the BEGIN→DELETE→INSERT→COMMIT contract is unchanged.
    const issued = clientQuery.mock.calls.map((c) => String(c[0]));
    expect(issued[0]).toBe("BEGIN");
    expect(issued).toContain("COMMIT");
    expect(issued).not.toContain("ROLLBACK");
  });

  it("strips NUL from object KEYS (jsonb rejects 0x00 in keys identically to values)", async () => {
    // Postgres jsonb rejects \x00 in keys the same way it rejects it in values.
    // If a future indexer derives a metadata key from source content (or any
    // upstream populates one), an unsanitized NUL in the key would survive
    // JSON.stringify (as the 6-char escape ` `), reach $12 of
    // INSERT_CHUNK_SQL, and fail the jsonb cast — recreating the exact bug
    // this PR is meant to close. The sanitizer must walk keys too.
    await replaceChunksForFile("docs", "a.md", [
      mkChunk({
        metadata: {
          "bad\x00key": "v\x00",
          nested: { "deep\x00bad": "w\x00" },
        },
      }),
    ]);

    const inserts = insertCalls();
    expect(inserts).toHaveLength(1);
    const params = inserts[0][1] as unknown[];
    const metadataJson = params[11] as string;

    // The JSON.stringify of a NUL in a key produces the 6-char escape
    // ` ` (backslash-u-0-0-0-0). That escape MUST NOT appear: it would
    // reach the jsonb cast and fail. Assert against both the literal byte
    // and the escape form.
    expect(metadataJson).not.toContain("\x00");
    expect(metadataJson).not.toContain("\\u0000");

    const parsed = JSON.parse(metadataJson);
    // Keys are sanitized; values still sanitized too.
    expect(Object.keys(parsed).sort()).toEqual(["badkey", "nested"]);
    expect(Object.keys(parsed.nested)).toEqual(["deepbad"]);
  });

  it("strips NUL from DELETE bind params (the asymmetric-binding regression)", async () => {
    // The atomic-replace invariant: DELETE and INSERT in the same transaction
    // must target the SAME sanitized identifier. If the DELETE binds raw
    // sourceName/filePath while INSERT binds stripNulBytes(...), a NUL-bearing
    // input either (a) crashes the DELETE with `invalid byte sequence for
    // encoding "UTF8": 0x00`, or (b) deletes a different row set than the
    // INSERT writes into. Both break atomic replacement.
    const NUL = "\x00";
    const dirtySource = `ag-ui${NUL}code`;
    const dirtyPath = `val${NUL}idate.ts`;
    await replaceChunksForFile(dirtySource, dirtyPath, [
      mkChunk({ source_name: dirtySource, file_path: dirtyPath }),
    ]);

    const deletes = clientQuery.mock.calls.filter((c) =>
      String(c[0]).includes("DELETE FROM chunks"),
    );
    expect(deletes).toHaveLength(1);
    const deleteParams = deletes[0][1] as unknown[];
    expect(deleteParams[0]).toBe("ag-uicode"); // source_name sanitized
    expect(deleteParams[1]).toBe("validate.ts"); // file_path sanitized
    expect(String(deleteParams[0])).not.toContain(NUL);
    expect(String(deleteParams[1])).not.toContain(NUL);
  });

  it("preserves null fields as null (does not stringify null through the sanitizer)", async () => {
    // The optional text fields (source_url, title, repo_url, language,
    // commit_sha, version) accept null. The sanitizer must not promote null
    // to a string — node-pg would bind "null" instead of SQL NULL.
    await replaceChunksForFile("docs", "a.md", [
      mkChunk({
        source_url: null,
        title: null,
        repo_url: null,
        language: null,
        commit_sha: null,
        version: null,
      }),
    ]);

    const inserts = insertCalls();
    const params = inserts[0][1] as unknown[];
    expect(params[1]).toBeNull(); // source_url
    expect(params[2]).toBeNull(); // title
    expect(params[5]).toBeNull(); // repo_url
    expect(params[9]).toBeNull(); // language
    expect(params[12]).toBeNull(); // commit_sha
    expect(params[13]).toBeNull(); // version
  });
});

describe("stripNulBytesDeep (identity-preservation contract)", () => {
  // The function's JSDoc promises "Returns the input unchanged when nothing
  // needed sanitizing — avoids reallocating arrays and objects on the common
  // path where source content never carries a NUL." That's a referential
  // identity guarantee on the no-NUL hot path: the returned value must be the
  // SAME reference as the input. Without this, every metadata blob allocates
  // a fresh tree per indexed chunk in the (overwhelmingly common) NUL-free
  // case — a docstring/code contract drift.
  it("returns the same array reference when no nested string carries a NUL", () => {
    const clean = ["a", "b", ["c", "d"], { x: "y" }];
    expect(stripNulBytesDeep(clean)).toBe(clean);
  });

  it("returns the same object reference when no nested string carries a NUL", () => {
    const clean = {
      headingPath: ["a", "b"],
      nested: { deep: "v" },
      n: 1,
      flag: true,
      empty: null,
    };
    expect(stripNulBytesDeep(clean)).toBe(clean);
  });

  it("returns a NEW reference (and sanitizes) when any nested string carries a NUL", () => {
    const dirty = { outer: { inner: "a\x00b" } };
    const result = stripNulBytesDeep(dirty) as typeof dirty;
    expect(result).not.toBe(dirty);
    expect(result.outer).not.toBe(dirty.outer);
    expect(result.outer.inner).toBe("ab");
  });
});

describe("stripNulBytesDeep safety under adversarial input (cycles + deep nesting)", () => {
  // The only consumer of stripNulBytesDeep that doesn't control its input is
  // insertCollectedData (queries.ts:651): MCP tool-call payloads land here as
  // arbitrary JSON-shaped JS values produced by external clients. A recursive
  // tree walk on such input is a stack-overflow waiting to happen — either
  // the client constructs a self-referential structure (cycle) or simply
  // feeds a deeply-nested object. Pre-fix the recursive impl in queries.ts
  // would throw `RangeError: Maximum call stack size exceeded` on both
  // shapes, bricking the INSERT in exactly the way the JSON.stringify ->
  // stripNulBytesDeep swap was supposed to prevent. Iterative walk closes
  // the regression by construction.
  it("does not throw on a self-referential object (cycle root)", () => {
    const a: Record<string, unknown> = { x: "ok\x00cyc" };
    a.self = a;
    // Must not stack-overflow. The visible NUL on `x` is stripped.
    const out = stripNulBytesDeep(a) as Record<string, unknown>;
    expect(out).not.toBe(a);
    expect(out.x).toBe("okcyc");
    // The output preserves the cycle structurally — `self` points back at
    // the cloned root (NOT at the input). This matches the docstring: the
    // function's contract is "do not stack-overflow", not "flatten cycles".
    expect(out.self).toBe(out);
  });

  it("does not throw on a cycle that requires no sanitization (identity NOT preserved on cycle)", () => {
    // A clean cycle would, in the no-cycle case, return the input
    // referentially. With cycles present and a NUL elsewhere in the tree,
    // the detect pass still trips needsClean and we clone — verify that the
    // walk terminates regardless of whether the dirty string is reached
    // before or after the back-edge.
    const a: Record<string, unknown> = { dirty: "x\x00y" };
    const b: Record<string, unknown> = { ref: a };
    a.back = b;
    const out = stripNulBytesDeep(a) as Record<string, unknown>;
    expect(out).not.toBe(a);
    expect(out.dirty).toBe("xy");
    const outBack = out.back as Record<string, unknown>;
    expect(outBack).not.toBe(b);
    expect(outBack.ref).toBe(out); // back-edge rewritten onto the clone
  });

  it("does not throw on a 10,000-level deeply nested linear object", () => {
    // Construct a 10k-deep linear chain. Pre-fix this stack-overflows on
    // V8's default ~10k call-stack budget the moment the walker descends
    // through every level. Iterative walk pays only heap, not stack.
    let cur: Record<string, unknown> = { leaf: "deep\x00leaf" };
    for (let i = 0; i < 10000; i++) cur = { a: cur };
    // Must not throw.
    const out = stripNulBytesDeep(cur);
    // Descend the output non-recursively to verify both that we got a clean
    // mirror back AND that the deepest string was sanitized.
    let node: unknown = out;
    for (let i = 0; i < 10000; i++) {
      node = (node as Record<string, unknown>).a;
    }
    expect((node as Record<string, unknown>).leaf).toBe("deepleaf");
  });

  it("does not throw on a deeply nested array (mirror shape via Array.isArray branch)", () => {
    // Same idea as the deep-object test, but exercising the array branch of
    // the iterative walker — a deeply nested `[[[ ... ]]]` chain.
    let curArr: unknown[] = ["deep\x00leaf"];
    for (let i = 0; i < 10000; i++) curArr = [curArr];
    const out = stripNulBytesDeep(curArr) as unknown[];
    let node: unknown = out;
    for (let i = 0; i < 10000; i++) {
      node = (node as unknown[])[0];
    }
    expect((node as unknown[])[0]).toBe("deepleaf");
  });
});

describe("stripNulBytesDeep prototype-setter trap (the __proto__ key drop)", () => {
  // A NUL-bearing key like "__proto__\x00" sanitizes to "__proto__". Assigning
  // through bracket notation on a plain {} invokes the __proto__ setter — when
  // the value isn't an object/null, the engine silently discards the
  // assignment, dropping the entry on the floor. The fix uses
  // Object.create(null) as the output container so the bracket assignment
  // creates an own data property instead of invoking the setter. This pins
  // the "all keys sanitized correctly" contract the PR claims, and prevents
  // silent metadata loss for any source whose upstream feeds a `__proto__`
  // (or other well-known prototype property) key into the chunk pipeline.
  it("does not drop a sanitized __proto__ key with a string value", () => {
    const input = { "__proto__\x00": "leak", normal: "ok" };
    const out = stripNulBytesDeep(input) as Record<string, unknown>;

    // The sanitized key MUST be a real own property — not silently consumed
    // by the prototype setter.
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(true);
    expect(out["__proto__"]).toBe("leak");
    // The companion key survives unchanged.
    expect(out["normal"]).toBe("ok");
  });

  it("survives JSON round-trip for a sanitized __proto__ key (chunkInsertParams path)", () => {
    // stripNulBytesDeep's only consumer (chunkInsertParams) feeds the result
    // into JSON.stringify. JSON.stringify walks own enumerable properties on
    // a null-prototype object identically to a plain object, so the
    // __proto__ key MUST round-trip end-to-end.
    const input = { "__proto__\x00": "leak", normal: "ok" };
    const out = stripNulBytesDeep(input);
    const json = JSON.stringify(out);
    expect(json).toContain('"__proto__":"leak"');
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(
      true,
    );
    expect(parsed["__proto__"]).toBe("leak");
    expect(parsed["normal"]).toBe("ok");
  });

  it("does not drop a sanitized 'constructor' key (sibling well-known property)", () => {
    // Object.create(null) also protects against the analogous trap on every
    // other Object.prototype data property — `constructor`, `toString`, etc.
    // These never invoke a setter, but assigning them on a plain {} would
    // shadow the inherited builtin in a way that some consumers find
    // surprising. Using a null-prototype output uniformly removes the class
    // of pitfalls.
    const input = { "constructor\x00": "evil", normal: "ok" };
    const out = stripNulBytesDeep(input) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(out, "constructor")).toBe(true);
    expect(out["constructor"]).toBe("evil");
    expect(out["normal"]).toBe("ok");
  });
});

describe("stripNulBytesDeep non-plain-object leaf semantics (Date/Buffer/RegExp)", () => {
  // J1 (recurring CR finding): the walker reallocates every container it
  // visits as `Object.create(null)` or a fresh array, enumerating via
  // `Object.entries`. For a Date/Buffer/RegExp nested INSIDE a dirty subtree,
  // `Object.entries(date)` returns `[]` (no own enumerable props) and the
  // value gets silently replaced with an empty null-prototype object — its
  // `toJSON()` semantics are lost. This is path-dependent corruption: a Date
  // next to a NUL-bearing sibling is destroyed; a Date in a clean subtree is
  // preserved by the identity-hot-path early-return.
  //
  // The fix: treat non-plain objects (prototype is neither Object.prototype
  // nor null) as opaque leaves — pass them through by reference, do NOT
  // walk, do NOT reallocate. This restores `JSON.stringify`'s delegation to
  // the value's `toJSON()` for Dates and to its native serializer for Buffer
  // / class instances.

  it("preserves a Date when a sibling string carries a NUL (dirty-path)", () => {
    const ts = new Date("2024-01-01T00:00:00Z");
    const input = { ts, bad: "n\x00ul" };
    const out = stripNulBytesDeep(input) as { ts: unknown; bad: string };
    // Sanitization of the dirty sibling still happens.
    expect(out.bad).toBe("nul");
    // The Date survives intact: same reference AND same ISO serialization
    // through JSON.stringify (which is the realistic consumer path via
    // chunkInsertParams). Pre-fix, the walker would reallocate `ts` as an
    // empty `Object.create(null)` and JSON.stringify would emit `"{}"`.
    expect(out.ts).toBeInstanceOf(Date);
    expect(out.ts).toBe(ts);
    expect((out.ts as Date).toISOString()).toBe("2024-01-01T00:00:00.000Z");
    expect(JSON.stringify(out)).toContain('"ts":"2024-01-01T00:00:00.000Z"');
  });

  it("preserves a Buffer when a sibling string carries a NUL (dirty-path)", () => {
    const buf = Buffer.from("hello");
    const input = { buf, bad: "n\x00ul" };
    const out = stripNulBytesDeep(input) as { buf: unknown; bad: string };
    expect(out.bad).toBe("nul");
    // Pre-fix: `out.buf` would be `{}` (Object.entries(Buffer) returns [];
    // Buffer's own enumerable props are the numeric indices, but the walker
    // would still reallocate as `Object.create(null)` and not preserve
    // Buffer semantics). Post-fix: same reference, IS-A Buffer.
    expect(Buffer.isBuffer(out.buf)).toBe(true);
    expect(out.buf).toBe(buf);
    expect((out.buf as Buffer).toString("utf8")).toBe("hello");
  });

  it("preserves a RegExp when a sibling string carries a NUL (dirty-path)", () => {
    const re = /abc/g;
    const input = { re, bad: "n\x00ul" };
    const out = stripNulBytesDeep(input) as { re: unknown; bad: string };
    expect(out.bad).toBe("nul");
    // Pre-fix: `out.re` would be `{}`. Post-fix: same reference, IS-A RegExp.
    expect(out.re).toBeInstanceOf(RegExp);
    expect(out.re).toBe(re);
    expect((out.re as RegExp).source).toBe("abc");
    expect((out.re as RegExp).flags).toBe("g");
  });

  it("preserves a non-plain leaf nested under multiple dirty containers", () => {
    // Depth check: the walker must treat the non-plain object as a leaf at
    // ANY depth, not just at the root level. A Date deep under two dirty
    // wrapping objects must survive the same way.
    const ts = new Date("2025-06-01T12:34:56Z");
    const input = {
      outer: { dirty: "x\x00y", inner: { ts, alsoDirty: "p\x00q" } },
    };
    const out = stripNulBytesDeep(input) as {
      outer: {
        dirty: string;
        inner: { ts: unknown; alsoDirty: string };
      };
    };
    expect(out.outer.dirty).toBe("xy");
    expect(out.outer.inner.alsoDirty).toBe("pq");
    expect(out.outer.inner.ts).toBeInstanceOf(Date);
    expect(out.outer.inner.ts).toBe(ts);
  });

  it("preserves a non-plain leaf inside a dirty array element", () => {
    // Array branch coverage — symmetric to the object branch above.
    const ts = new Date("2026-01-01T00:00:00Z");
    const input = ["clean", "n\x00ul", ts];
    const out = stripNulBytesDeep(input) as unknown[];
    expect(out[0]).toBe("clean");
    expect(out[1]).toBe("nul");
    expect(out[2]).toBeInstanceOf(Date);
    expect(out[2]).toBe(ts);
  });
});

describe("standalone delete-by-file/by-source NUL sanitization", () => {
  beforeEach(() => {
    poolQuery.mockReset();
    poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("deleteChunksByFile strips NUL from both bind params", async () => {
    // Same invariant as replaceChunksForFile: text-typed bindings on DELETE
    // must pass through stripNulBytes, or Postgres rejects the statement with
    // `invalid byte sequence for encoding "UTF8": 0x00`. Standalone deletes
    // run on pool.query (no implicit transaction), but the encoding constraint
    // is identical.
    const NUL = "\x00";
    await deleteChunksByFile(`ag-ui${NUL}code`, `val${NUL}idate.ts`);
    expect(poolQuery).toHaveBeenCalledTimes(1);
    const [, params] = poolQuery.mock.calls[0];
    expect((params as unknown[])[0]).toBe("ag-uicode");
    expect((params as unknown[])[1]).toBe("validate.ts");
  });

  it("deleteChunksBySource strips NUL from the source_name bind param", async () => {
    const NUL = "\x00";
    await deleteChunksBySource(`ag-ui${NUL}code`);
    expect(poolQuery).toHaveBeenCalledTimes(1);
    const [, params] = poolQuery.mock.calls[0];
    expect((params as unknown[])[0]).toBe("ag-uicode");
  });
});

describe("upsertChunks NUL sanitization (integration)", () => {
  beforeEach(() => {
    clientQuery.mockReset();
    clientRelease.mockReset();
    connect.mockClear();
    clientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  function insertCalls() {
    return clientQuery.mock.calls.filter((c) =>
      String(c[0]).includes("INSERT INTO chunks"),
    );
  }

  it("strips NUL from every text-typed param and metadata jsonb on upsert", async () => {
    // Mirror of the replaceChunksForFile coverage: the same chunkInsertParams
    // sanitization contract must hold on the upsertChunks path, otherwise a
    // NUL byte reaching the batch INSERT would error out the whole transaction
    // (the same ag-ui-code failure mode, just via the ON-CONFLICT upsert path).
    await upsertChunks([
      mkChunk({
        source_name: "src\x00name",
        source_url: "https://example.com/\x00",
        title: "T\x00itle",
        content: "bo\x00dy",
        repo_url: "https://r.example/\x00",
        file_path: "file\x00.ts",
        language: "type\x00script",
        commit_sha: "sh\x00a",
        version: "v\x001",
        metadata: {
          headingPath: ["a\x00b", "c"],
          extra: { nested: "x\x00y" },
        },
      }),
    ]);

    const inserts = insertCalls();
    expect(inserts).toHaveLength(1);
    const params = inserts[0][1] as unknown[];

    // Every text param is NUL-free.
    expect(params[0]).toBe("srcname"); // source_name
    expect(params[1]).toBe("https://example.com/"); // source_url
    expect(params[2]).toBe("Title"); // title
    expect(params[3]).toBe("body"); // content
    expect(params[5]).toBe("https://r.example/"); // repo_url
    expect(params[6]).toBe("file.ts"); // file_path
    expect(params[9]).toBe("typescript"); // language
    expect(params[12]).toBe("sha"); // commit_sha
    expect(params[13]).toBe("v1"); // version

    // metadata is serialized to JSON and contains no \u0000 escape.
    // JSON.stringify escapes a literal NUL to the 6-char sequence \u0000,
    // so the meaningful assertion is on the escape, not on the literal byte.
    const metadataJson = params[11] as string;
    expect(metadataJson).not.toContain("\\u0000");
    const parsed = JSON.parse(metadataJson);
    expect(parsed).toEqual({
      headingPath: ["ab", "c"],
      extra: { nested: "xy" },
    });

    // The BEGIN/COMMIT transaction contract is preserved on the clean path
    // (no ROLLBACK) -- guards the single-pooled-client lifecycle that the
    // batched upsert relies on.
    const issued = clientQuery.mock.calls.map((c) => String(c[0]));
    expect(issued[0]).toBe("BEGIN");
    expect(issued).toContain("COMMIT");
    expect(issued).not.toContain("ROLLBACK");
  });

  it("preserves null optional fields on upsert (does not stringify null)", async () => {
    // The sanitizer must not promote null to "null" -- node-pg would then bind
    // the string "null" instead of SQL NULL. Same contract as on replaceChunksForFile.
    await upsertChunks([
      mkChunk({
        source_url: null,
        title: null,
        repo_url: null,
        language: null,
        commit_sha: null,
        version: null,
      }),
    ]);

    const inserts = insertCalls();
    const params = inserts[0][1] as unknown[];
    expect(params[1]).toBeNull(); // source_url
    expect(params[2]).toBeNull(); // title
    expect(params[5]).toBeNull(); // repo_url
    expect(params[9]).toBeNull(); // language
    expect(params[12]).toBeNull(); // commit_sha
    expect(params[13]).toBeNull(); // version
  });
});
