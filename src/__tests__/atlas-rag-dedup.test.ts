import { describe, it, expect, vi, afterEach } from "vitest";
import {
  dedupAgainstRagCorpus,
  candidateProbeQueryText,
  MAX_PROBE_TEXT_ENCODED_BYTES,
  wireEncodedLength,
} from "../atlas/rag-dedup.js";
import type { RagDedupContext } from "../atlas/rag-dedup.js";
import type { AtlasHttpClient, SearchHit } from "../atlas/client.js";
import { recomputeRankScore } from "../atlas/canonicalize.js";
import { CandidateSchema } from "../atlas/types.js";
import type { Candidate } from "../atlas/types.js";

// ── Unit test for the RAG-corpus dedup gate (S21 / spec §6.2 / §10 bar 6) ──────
//
// The gate probes the live `search-*` RAG corpus (via AtlasHttpClient.search)
// for verbatim/near-verbatim overlap with already-indexed content. On overlap
// it MARKS the candidate as a known overlap — it NEVER silently drops a
// candidate. (Marking fully satisfies the spec bar; the optional LLM
// delta-rewrite is deferred.) The search probe is a NON-LLM external (HTTP), so
// mocking it with vi.fn is allowed per the org rule. The KEY invariants
// asserted: (a) a verbatim hit → still present + annotated, NOT dropped; (b) no
// hit → unchanged pass-through; and the count invariant out.length === in.length
// for every case.

// ── Candidate builder ──────────────────────────────────────────────────────────
// A minimal, valid Candidate with overridable fields, so each test states only
// the dimensions it exercises. Output validates against CandidateSchema.

interface CandidateOverrides {
  canonical_key?: string;
  subsystem?: string;
  title?: string;
  content?: string;
  evidence?: Candidate["evidence"];
  validated_against?: string;
}

function makeCandidate(o: CandidateOverrides = {}): Candidate {
  const date = "2026-06-08";
  const candidate: Candidate = {
    sourcetype: "github-pr",
    subsystem: o.subsystem ?? "cpk-runtime",
    claimSlugHint: undefined,
    source_name: "github-pr",
    repo_url: "https://github.com/CopilotKit/CopilotKit",
    ref: "main",
    title: o.title ?? "Two-layer shim forwards v1 calls to the v2 engine",
    content:
      o.content ??
      "The runtime keeps a thin v1 compatibility shim that forwards calls into the v2 engine so existing apps run unchanged.",
    provenance: {
      source: "github-pr",
      date,
      validated_against: o.validated_against,
      classification: {
        sensitivity: "internal",
        knowledge_type: "architecture",
        audience: "all-staff",
        validation_status: "source-verified",
        confidence: "high",
        provenance_class: "primary",
        freshness: { as_of: date },
      },
    },
    evidence: o.evidence ?? [],
    needsReview: false,
    validationTargets: [],
    canonical_key:
      o.canonical_key ?? "github-pr:cpk-runtime:two-layer-shim-to-v2-engine",
    rankScore: 1,
    approvable: true,
  };
  return candidate;
}

// A SearchHit whose content is a verbatim copy of the candidate content — the
// strongest possible overlap signal. `score` is also high, but the gate must
// not depend on the optional score being present.
function verbatimHit(content: string): SearchHit {
  return {
    id: 1,
    content,
    title: "Already-indexed corpus passage",
    sourceUrl: "https://example.test/corpus",
    sourceName: "docs",
    score: 0.98,
  };
}

// Build a fake AtlasHttpClient whose `search` is a vi.fn returning the supplied
// hits. Only `search` is exercised by the gate; the cast is to the minimal
// surface the gate consumes, not `any`.
function clientReturning(hits: SearchHit[]): {
  client: AtlasHttpClient;
  searchMock: ReturnType<typeof vi.fn>;
} {
  const searchMock = vi.fn(async () => hits);
  const client = { search: searchMock } as unknown as AtlasHttpClient;
  return { client, searchMock };
}

describe("dedupAgainstRagCorpus — no-overlap pass-through", () => {
  it("passes a candidate through UNCHANGED when the corpus has no hit", async () => {
    const cand = makeCandidate();
    const { client, searchMock } = clientReturning([]);
    const ctx: RagDedupContext = { client };

    const out = await dedupAgainstRagCorpus([cand], ctx);

    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1);
    // Unchanged: same content, same title, no overlap annotation added.
    expect(out[0].content).toBe(cand.content);
    expect(out[0].title).toBe(cand.title);
    expect(out[0].evidence).toEqual(cand.evidence);
    expect(out[0].provenance.validated_against).toBeUndefined();
  });

  it("passes through when the only hit is far below the overlap threshold", async () => {
    const cand = makeCandidate();
    const { client } = clientReturning([
      verbatimHit("A completely unrelated note about billing webhooks."),
    ]);
    const ctx: RagDedupContext = { client };

    const out = await dedupAgainstRagCorpus([cand], ctx);

    expect(out).toHaveLength(1);
    expect(out[0].content).toBe(cand.content);
    expect(out[0].provenance.validated_against).toBeUndefined();
  });
});

describe("dedupAgainstRagCorpus — verbatim overlap is MARKED, never dropped", () => {
  it("keeps a candidate that verbatim-overlaps the corpus and annotates it (no LLM ⇒ MARK)", async () => {
    const cand = makeCandidate();
    // Corpus already indexes the exact same prose.
    const { client, searchMock } = clientReturning([verbatimHit(cand.content)]);
    const ctx: RagDedupContext = { client };

    const out = await dedupAgainstRagCorpus([cand], ctx);

    expect(searchMock).toHaveBeenCalledTimes(1);
    // NEVER dropped — still present.
    expect(out).toHaveLength(1);
    expect(out[0].canonical_key).toBe(cand.canonical_key);
    // Annotated as a known overlap: provenance carries a validated_against note
    // AND a fused_from evidence item references the overlapping corpus passage.
    expect(out[0].provenance.validated_against).toBeTruthy();
    const fused = out[0].evidence.filter((e) => e.kind === "fused_from");
    expect(fused.length).toBeGreaterThanOrEqual(1);
    // The output still validates against the finalized Candidate schema.
    expect(() => CandidateSchema.parse(out[0])).not.toThrow();
  });

  it("preserves pre-existing evidence when adding the overlap marker", async () => {
    const cand = makeCandidate({
      evidence: [{ kind: "changed_file", path: "src/runtime/shim.ts" }],
    });
    const { client } = clientReturning([verbatimHit(cand.content)]);
    const ctx: RagDedupContext = { client };

    const out = await dedupAgainstRagCorpus([cand], ctx);

    // Original evidence retained, overlap marker appended (never replaces).
    expect(
      out[0].evidence.some(
        (e) => e.kind === "changed_file" && e.path === "src/runtime/shim.ts",
      ),
    ).toBe(true);
    expect(out[0].evidence.some((e) => e.kind === "fused_from")).toBe(true);
  });

  it("honors a custom minOverlap threshold (a partial hit BETWEEN custom and default is marked only under the custom)", async () => {
    // COMPUTED containment, not guessed: the candidate's full indexable surface
    // (title + content) is exactly 20 distinct tokens, and the hit carries
    // exactly 13 of them (13/20 = 0.65) plus unrelated filler — strictly
    // between the custom 0.5 and the 0.8 DEFAULT. A hit that also cleared the
    // default (the old test used a superset hit ⇒ containment 1.0) would make
    // the option non-load-bearing: a build that IGNORES ctx.minOverlap would
    // still pass. The 0.65 hit makes the custom threshold the ONLY reason the
    // mark fires.
    const tokens = Array.from({ length: 20 }, (_, i) => `overlaptoken${i}`);
    const cand = makeCandidate({
      title: tokens.slice(0, 4).join(" "),
      content: tokens.slice(4).join(" "),
    });
    const partial = verbatimHit(
      `${tokens.slice(0, 13).join(" ")} plus entirely unrelated filler prose about something else`,
    );

    // Marked under the custom 0.5 threshold (0.65 ≥ 0.5).
    const { client } = clientReturning([partial]);
    const out = await dedupAgainstRagCorpus([cand], {
      client,
      minOverlap: 0.5,
    });
    expect(out).toHaveLength(1);
    expect(out[0].provenance.validated_against).toBeTruthy();
    expect(out[0].evidence.some((e) => e.kind === "fused_from")).toBe(true);

    // Companion: the SAME candidate/hit under the DEFAULT ctx is NOT marked
    // (0.65 < 0.8) — proving the custom option above was load-bearing.
    const { client: defaultClient } = clientReturning([partial]);
    const defaultOut = await dedupAgainstRagCorpus([cand], {
      client: defaultClient,
    });
    expect(defaultOut).toHaveLength(1);
    expect(defaultOut[0].provenance.validated_against).toBeUndefined();
    expect(defaultOut[0].evidence.some((e) => e.kind === "fused_from")).toBe(
      false,
    );

    // Margin hardening: bracket the hit's containment from above as well — at
    // minOverlap 0.7 it is NOT marked, pinning the computed 0.65 inside
    // [0.5, 0.7) with margin on both assertion boundaries (a drifted tokenizer
    // or hit edit that nudged containment near a threshold edge would trip one
    // of the three assertions instead of silently passing at the margin).
    const { client: midClient } = clientReturning([partial]);
    const midOut = await dedupAgainstRagCorpus([cand], {
      client: midClient,
      minOverlap: 0.7,
    });
    expect(midOut[0].provenance.validated_against).toBeUndefined();
  });
});

describe("dedupAgainstRagCorpus — batch + count invariant (NEVER drops)", () => {
  it("returns exactly as many candidates as it received (mixed overlap/no-overlap)", async () => {
    const overlapping = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:dup",
      subsystem: "cpk-runtime",
      title: "Duplicated claim already indexed in the corpus",
      content: "Duplicated prose already present verbatim in the corpus.",
    });
    const novel = makeCandidate({
      canonical_key: "github-pr:agui-protocol:novel",
      subsystem: "agui-protocol",
      title: "Brand new insight",
      content: "Brand new insight not present anywhere in the corpus.",
    });
    // search returns a verbatim hit (mirroring the full indexable surface —
    // title + content) for the duplicated one, nothing for novel.
    const searchMock = vi.fn(async (q: { text: string }) =>
      q.text.includes("Duplicated")
        ? [verbatimHit(`${overlapping.title}\n${overlapping.content}`)]
        : [],
    );
    const client = { search: searchMock } as unknown as AtlasHttpClient;
    const ctx: RagDedupContext = { client };

    const out = await dedupAgainstRagCorpus([overlapping, novel], ctx);

    // Count invariant: nothing is ever silently dropped.
    expect(out).toHaveLength(2);
    const keys = new Set(out.map((c) => c.canonical_key));
    expect(keys.has("github-pr:cpk-runtime:dup")).toBe(true);
    expect(keys.has("github-pr:agui-protocol:novel")).toBe(true);
    // The overlapping one is annotated; the novel one is untouched.
    const dup = out.find((c) => c.canonical_key.endsWith(":dup"))!;
    const fresh = out.find((c) => c.canonical_key.endsWith(":novel"))!;
    expect(dup.provenance.validated_against).toBeTruthy();
    expect(fresh.provenance.validated_against).toBeUndefined();
  });

  it("returns an empty array for empty input (and never probes search)", async () => {
    const { client, searchMock } = clientReturning([]);
    const out = await dedupAgainstRagCorpus([], { client });
    expect(out).toEqual([]);
    expect(searchMock).not.toHaveBeenCalled();
  });
});

describe("dedupAgainstRagCorpus — re-annotation is idempotent", () => {
  it("does NOT duplicate the fused_from evidence / overlap marker on a re-run of an already-annotated candidate", async () => {
    const cand = makeCandidate();
    const { client } = clientReturning([verbatimHit(cand.content)]);
    const ctx: RagDedupContext = { client };

    // First pass annotates the overlap.
    const first = await dedupAgainstRagCorpus([cand], ctx);
    expect(first).toHaveLength(1);
    const firstFused = first[0].evidence.filter((e) => e.kind === "fused_from");
    expect(firstFused.length).toBe(1);
    const firstMarker = first[0].provenance.validated_against;
    expect(firstMarker).toBeTruthy();

    // Second pass over the ALREADY-annotated candidate must be a no-op for the
    // overlap mark: re-running the gate cannot append a duplicate evidence item
    // or a duplicate validated_against marker.
    const second = await dedupAgainstRagCorpus([first[0]], ctx);
    expect(second).toHaveLength(1);
    const secondFused = second[0].evidence.filter(
      (e) => e.kind === "fused_from",
    );
    // Still exactly one fused_from for this corpus ref — no duplicate.
    expect(secondFused.length).toBe(1);
    // validated_against marker unchanged (no duplicate marker concatenated).
    expect(second[0].provenance.validated_against).toBe(firstMarker);
    // Output still schema-valid.
    expect(() => CandidateSchema.parse(second[0])).not.toThrow();
  });
});

describe("dedupAgainstRagCorpus — the §6.2 duplication mark is rank-NEUTRAL", () => {
  it("an annotated duplicate does NOT outrank its unannotated twin (recomputed rankScore identical)", async () => {
    // §6.2 inversion guard: the overlap annotation appends a fused_from
    // evidence item; if evidence depth counted it, a corpus DUPLICATE would
    // sort EARLIER in the review queue than the same candidate un-duplicated.
    const cand = makeCandidate();
    const { client } = clientReturning([verbatimHit(cand.content)]);

    const out = await dedupAgainstRagCorpus([cand], { client });
    expect(out[0].evidence.some((e) => e.kind === "fused_from")).toBe(true);

    // Recompute BOTH at the same instant so recency cannot skew the comparison
    // — the only difference between the twins is the overlap annotation.
    const now = Date.now();
    expect(recomputeRankScore(out[0], now).rankScore).toBe(
      recomputeRankScore(cand, now).rankScore,
    );
  });

  it("the overlap fused_from evidence ref carries the rag-corpus-overlap: prefix (the rank filter's predicate)", async () => {
    // The LITERAL prefix is pinned here (not the exported constant) so a drift
    // in either the stamp or the filter constant breaks this test rather than
    // silently re-opening the rank boost.
    const cand = makeCandidate();
    const { client } = clientReturning([verbatimHit(cand.content)]);

    const out = await dedupAgainstRagCorpus([cand], { client });

    const fused = out[0].evidence.filter(
      (e): e is { kind: "fused_from"; ref: string } => e.kind === "fused_from",
    );
    expect(fused).toHaveLength(1);
    expect(fused[0].ref.startsWith("rag-corpus-overlap:")).toBe(true);
  });
});

describe("dedupAgainstRagCorpus — long candidate bodies are truncated before the probe", () => {
  it("bounds the probe text length so a huge body cannot blow the query-string limit", async () => {
    // A candidate whose distilled body is far larger than any safe query-string
    // budget. The probe text the gate sends must be truncated, not the full body.
    const hugeContent = "lorem ipsum dolor sit amet ".repeat(2000); // ~54 KB
    const cand = makeCandidate({ content: hugeContent });

    let probedText = "";
    const searchMock = vi.fn(async (q: { text: string }) => {
      probedText = q.text;
      return [] as SearchHit[];
    });
    const client = { search: searchMock } as unknown as AtlasHttpClient;

    const out = await dedupAgainstRagCorpus([cand], { client });

    expect(out).toHaveLength(1);
    expect(searchMock).toHaveBeenCalledTimes(1);
    // The probe text is bounded well under a typical URL limit (a leading slice
    // is sufficient for the containment heuristic). It must be far smaller than
    // the ~54 KB body.
    expect(probedText.length).toBeGreaterThan(0);
    expect(probedText.length).toBeLessThanOrEqual(2048);
    expect(probedText.length).toBeLessThan(hugeContent.length);
  });
});

describe("dedupAgainstRagCorpus — probe truncation is byte-aware, not just char-aware (W26)", () => {
  // `client.search` percent-encodes the probe text into a GET URL: non-ASCII
  // expands ~9x under encodeURIComponent (one BMP CJK char = 3 UTF-8 bytes =
  // 9 encoded chars), so a 2048-CHAR slice of CJK prose is ~18 KB of URL — the
  // server rejects it (414/431), the per-candidate catch counts it as a PROBE
  // failure, and 5 consecutive non-ASCII candidates abort the run with an
  // "endpoint down" misdiagnosis. The probe text must bound the ENCODED
  // length, not the char count.

  // ≥ MIN_CANDIDATE_TOKENS distinct ASCII tokens in the title (tokenSet only
  // extracts [a-z0-9] runs — CJK contributes no tokens, and a token-poor
  // candidate would skip the probe entirely), with the CJK bulk in content.
  function cjkCandidate(i: number): Candidate {
    return makeCandidate({
      canonical_key: `github-pr:cpk-runtime:cjk-${i}`,
      title: `knowledge base duplicate detection probe ${i}`,
      content:
        `候補の重複検出は照合対象の本文全体で行う必要がある第${i}`.repeat(120), // ~3000 chars of BMP CJK — far past the 2048-char slice
    });
  }

  it("bounds the ENCODED probe-text length for a CJK-heavy candidate", async () => {
    const cand = cjkCandidate(0);
    let probedText = "";
    const searchMock = vi.fn(async (q: { text: string }) => {
      probedText = q.text;
      return [] as SearchHit[];
    });
    const client = { search: searchMock } as unknown as AtlasHttpClient;

    const out = await dedupAgainstRagCorpus([cand], { client });

    expect(out).toHaveLength(1);
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(probedText.length).toBeGreaterThan(0);
    // The wire-relevant bound: the WIRE-encoded length (wireEncodedLength —
    // the implementation's own encoder; encodeURIComponent diverges on ` ` and
    // `!'()~`) stays within the budget (and well under the ~8 KB request-line
    // limit).
    expect(wireEncodedLength(probedText)).toBeLessThanOrEqual(
      MAX_PROBE_TEXT_ENCODED_BYTES,
    );
  });

  it("a batch of 5 CJK-heavy candidates against a URL-length-rejecting stub does NOT trip the consecutive-failure fail-fast", async () => {
    // The stub plays the server's role at the URL-length limit: an over-long
    // encoded query is rejected (as 414/431 would be). With char-only
    // truncation EVERY probe rejects ⇒ 5 consecutive probe failures ⇒ the
    // fail-fast aborts the run with the wrong diagnosis. With byte-aware
    // truncation every probe fits and the batch completes.
    const searchMock = vi.fn(async (q: { text: string }) => {
      if (encodeURIComponent(q.text).length > MAX_PROBE_TEXT_ENCODED_BYTES) {
        throw new Error("414 URI Too Long");
      }
      return [] as SearchHit[];
    });
    const client = { search: searchMock } as unknown as AtlasHttpClient;
    const cands = Array.from({ length: 5 }, (_, i) => cjkCandidate(i));

    const out = await dedupAgainstRagCorpus(cands, { client });

    expect(out).toHaveLength(5);
    expect(searchMock).toHaveBeenCalledTimes(5);
    for (const c of out) {
      expect(c.provenance.validated_against).toBeUndefined();
    }
  });

  it("never sends a lone surrogate when the byte-aware shrink boundary lands inside a surrogate pair (emoji-heavy body)", async () => {
    // Astral chars (emoji) are 2 code units / 4 UTF-8 bytes: the proportional
    // shrink can land between the halves of a pair, and encodeURIComponent
    // THROWS (URIError) on a lone surrogate — which would surface as a probe
    // failure. The probe text must back off to a pair boundary (richText
    // surrogate-split precedent).
    const cand = makeCandidate({
      title: "emoji heavy reaction thread distilled summary",
      content: "😀".repeat(2000), // 4000 code units, all surrogate pairs
    });
    let probedText = "";
    const searchMock = vi.fn(async (q: { text: string }) => {
      probedText = q.text;
      return [] as SearchHit[];
    });
    const client = { search: searchMock } as unknown as AtlasHttpClient;

    const out = await dedupAgainstRagCorpus([cand], { client });

    expect(out).toHaveLength(1);
    expect(searchMock).toHaveBeenCalledTimes(1);
    // encodeURIComponent throws on a lone surrogate — evaluating it proves the
    // boundary is surrogate-safe (the well-formedness oracle); the byte budget
    // is asserted against wireEncodedLength, the implementation's own encoder.
    expect(() => encodeURIComponent(probedText)).not.toThrow();
    expect(wireEncodedLength(probedText)).toBeLessThanOrEqual(
      MAX_PROBE_TEXT_ENCODED_BYTES,
    );
  });

  it("candidateProbeQueryText leaves a short ASCII candidate untouched (no needless truncation)", async () => {
    const cand = makeCandidate();
    expect(candidateProbeQueryText(cand)).toBe(
      `${cand.title}\n${cand.content}`.trim(),
    );
  });
});

describe("dedupAgainstRagCorpus — malformed upstream content (lone MID-STRING surrogate) never aborts the harvest (X1)", () => {
  it("completes, passes the candidate through, and probes with WELL-FORMED text when content embeds lone mid-string surrogates", async () => {
    // candidateProbeQueryText is called OUTSIDE the per-candidate try (a throw
    // there would unwind dedupAgainstRagCorpus → runHarvest, violating the
    // module's never-abort invariant; moving the call INSIDE the try would
    // instead mis-count the throw as a PROBE failure toward the fail-fast
    // streak). So the function must be throw-proof against malformed UTF-16
    // already embedded in upstream title/content — not just at the slice
    // boundary, which is all trimLoneTrailingHighSurrogate covers.
    const cand = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:lone-surrogate",
      title: "malformed upstream content carries a lone surrogate",
      // A lone HIGH surrogate and a lone LOW surrogate, both mid-string.
      content: "prose before \uD800 the gap \uDFFF prose after the surrogates",
    });
    let probedText = "";
    const searchMock = vi.fn(async (q: { text: string }) => {
      probedText = q.text;
      return [] as SearchHit[];
    });
    const client = { search: searchMock } as unknown as AtlasHttpClient;

    const out = await dedupAgainstRagCorpus([cand], { client });

    // Never aborts, never drops: the candidate rides through un-annotated.
    expect(out).toHaveLength(1);
    expect(out[0].canonical_key).toBe("github-pr:cpk-runtime:lone-surrogate");
    expect(out[0].provenance.validated_against).toBeUndefined();
    expect(searchMock).toHaveBeenCalledTimes(1);
    // The probe text is well-formed UTF-16: encodeURIComponent throws URIError
    // on ANY lone surrogate, so not-throwing proves well-formedness.
    expect(() => encodeURIComponent(probedText)).not.toThrow();
    // The surrounding prose survives (sanitized, not truncated at the
    // malformed code unit).
    expect(probedText).toContain("prose before");
    expect(probedText).toContain("prose after the surrogates");
  });
});

describe("candidateProbeQueryText — the byte bound is measured with the WIRE encoder, not encodeURIComponent (X2)", () => {
  it("keeps an `!'()~`-dense mixed-script probe within the real form-urlencoded wire budget", () => {
    // `client.search` serializes the query with `new URLSearchParams({ text })`
    // (form-urlencoded) — NOT encodeURIComponent. The two diverge on
    // `! ' ( ) ~` (kept literal by encodeURIComponent = 1 char each, but
    // percent-encoded on the wire = 3 chars each). Composition COMPUTED so the
    // old encodeURIComponent measure stays ≤ MAX_PROBE_TEXT_ENCODED_BYTES (no
    // shrink fires) while the real wire length blows ~3 KB past it:
    //   sliced 2048 chars = title 33 (28 letters + 5 spaces) + "\n"
    //                     + 1504 "!" + 510 CJK
    //   encodeURIComponent: 28 + 5*3 + 3 + 1504*1 + 510*9 = 6140 ≤ 6144
    //   wire (URLSearchParams): 28 + 5*1 + 3 + 1504*3 + 510*9 = 9138 > 6144
    const cand = makeCandidate({
      title: "bang paren tilde wire bound probe",
      content: "!".repeat(1504) + "気".repeat(600),
    });

    const probedText = candidateProbeQueryText(cand);

    // The wire-relevant bound: the ACTUAL serialized query-value length the
    // client produces must fit the budget.
    const wireValueLength =
      new URLSearchParams({ text: probedText }).toString().length -
      "text=".length;
    expect(wireValueLength).toBeLessThanOrEqual(MAX_PROBE_TEXT_ENCODED_BYTES);
  });

  it("pin: wireEncodedLength measures the EXACT wire value length client.search serializes", () => {
    // Independently constructed expectations (not round-tripped through the
    // helper) so a regression back to encodeURIComponent-measuring trips here:
    // the real divergent set vs encodeURIComponent is `! ' ( ) ~` (literal
    // there, 3 wire chars each) plus the space (%20 there, `+` on the wire).
    expect(wireEncodedLength("!'()~")).toBe(15); // %21%27%28%29%7E
    expect(encodeURIComponent("!'()~").length).toBe(5); // the divergence
    expect(wireEncodedLength("a b")).toBe(3); // a+b
    expect(wireEncodedLength("気")).toBe(9); // %E6%B0%97
    // USVString conversion: never throws on a lone surrogate (→ U+FFFD).
    expect(wireEncodedLength("a\uD800b")).toBe(11); // a%EF%BF%BDb
    // And for a mixed CJK + `!'()~` probe text, the measure IS the length of
    // the serialized value `client.search` puts on the wire.
    const mixed = "気!'()~ 気 probe";
    expect(wireEncodedLength(mixed)).toBe(
      new URLSearchParams({ text: mixed }).toString().length - "text=".length,
    );
  });
});

describe("dedupAgainstRagCorpus — containment is computed over the FULL candidate body, not the truncated probe", () => {
  it("does NOT mark a long candidate whose first ~2 KB overlaps the corpus but whose full body is net-new", async () => {
    // Construct a candidate whose LEADING slice (within MAX_PROBE_TEXT_CHARS,
    // ~2 KB) is shared boilerplate present verbatim in the corpus, but whose
    // BULK (everything after that slice) is unique, net-new prose. If
    // containment were measured over only the truncated probe text, the shared
    // boilerplate opening would dominate the candidate token set and the gate
    // would mis-mark the candidate as a duplicate. Measured over the FULL body,
    // the unique bulk dilutes containment far below threshold ⇒ NOT marked.
    // Boilerplate built from MANY distinct tokens, sized to overfill the ~2 KB
    // probe slice on its own so the truncated probe text the gate sends is
    // ENTIRELY boilerplate (no net-new tail token survives truncation). Each
    // token is distinct so the boilerplate token set is large — measured over
    // the TRUNCATED text alone, containment against the boilerplate-only corpus
    // hit is ~1.0 (the bug); measured over the FULL body it is diluted far
    // below threshold by the net-new tail.
    const sharedBoilerplate = Array.from(
      { length: 300 },
      (_, i) => `boilerplatetoken${i}`,
    ).join(" "); // > 2 KB on its own.
    // A large net-new tail with many DISTINCT tokens the corpus does not have.
    const uniqueTail = Array.from(
      { length: 600 },
      (_, i) => `netnewtoken${i}`,
    ).join(" ");
    const cand = makeCandidate({
      title: "novel",
      content: `${sharedBoilerplate} ${uniqueTail}`,
    });

    // The corpus hit only contains the shared boilerplate — i.e. exactly the
    // leading slice the truncated probe would carry. None of the unique tail.
    const { client, searchMock } = clientReturning([
      verbatimHit(sharedBoilerplate),
    ]);
    const ctx: RagDedupContext = { client };

    const out = await dedupAgainstRagCorpus([cand], ctx);

    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1);
    // Containment over the FULL body is well below the default 0.8 threshold,
    // so the candidate is NOT marked — it rides through unchanged.
    expect(out[0].provenance.validated_against).toBeUndefined();
    expect(out[0].evidence.some((e) => e.kind === "fused_from")).toBe(false);
  });
});

describe("dedupAgainstRagCorpus — sub-threshold-token candidates skip the network probe entirely", () => {
  it("does NOT call client.search for a candidate with fewer than MIN_CANDIDATE_TOKENS distinct tokens", async () => {
    // A candidate whose full title+content has fewer than MIN_CANDIDATE_TOKENS
    // distinct tokens. bestOverlap would discard it anyway (too few tokens to
    // discriminate), so paying an HTTP round-trip to then discard is pure
    // waste. The gate must short-circuit BEFORE the probe and pass it through
    // un-annotated.
    const tiny = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:tiny",
      title: "a a",
      content: "b b",
    });
    const { client, searchMock } = clientReturning([]);
    const ctx: RagDedupContext = { client };

    const out = await dedupAgainstRagCorpus([tiny], ctx);

    // No probe issued for the sub-threshold candidate.
    expect(searchMock).not.toHaveBeenCalled();
    // Still present, un-annotated (NEVER dropped).
    expect(out).toHaveLength(1);
    expect(out[0].canonical_key).toBe("github-pr:cpk-runtime:tiny");
    expect(out[0].provenance.validated_against).toBeUndefined();
  });

  it("probes only the candidates that clear the token floor (mixed batch)", async () => {
    const tiny = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:tiny2",
      title: "x",
      content: "y z",
    });
    const normal = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:normal",
    });
    const { client, searchMock } = clientReturning([]);
    const ctx: RagDedupContext = { client };

    const out = await dedupAgainstRagCorpus([tiny, normal], ctx);

    // Exactly one probe — for the token-rich candidate only.
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(2);
  });
});

describe("dedupAgainstRagCorpus — malformed search hits are skipped, never abort (V61/V64)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not throw when search resolves [{}] — candidate passes through un-annotated with a warn", async () => {
    const cand = makeCandidate();
    // A hit with NO content field at all — a malformed endpoint payload must
    // not unwind the batch (the gate is mark-only; a bad hit is a missed mark,
    // never a lost row).
    const { client } = clientReturning([{} as SearchHit]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const out = await dedupAgainstRagCorpus([cand], { client });

    expect(out).toHaveLength(1);
    expect(out[0].provenance.validated_against).toBeUndefined();
    expect(out[0].evidence.some((e) => e.kind === "fused_from")).toBe(false);
    // The skip is logged (visible, greppable) naming the candidate key.
    expect(warnSpy).toHaveBeenCalled();
    const logged = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("malformed search hit — skipping");
    expect(logged).toContain(cand.canonical_key);
  });

  it("does not throw when search resolves [{ content: 42 }] — non-string content is skipped with a warn", async () => {
    const cand = makeCandidate();
    const { client } = clientReturning([
      { content: 42 } as unknown as SearchHit,
    ]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const out = await dedupAgainstRagCorpus([cand], { client });

    expect(out).toHaveLength(1);
    expect(out[0].provenance.validated_against).toBeUndefined();
    const logged = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("malformed search hit — skipping");
    expect(logged).toContain(cand.canonical_key);
  });

  it("still annotates from the valid hit when the hit array mixes a malformed and a valid overlapping hit", async () => {
    const cand = makeCandidate();
    const { client } = clientReturning([
      { content: 42 } as unknown as SearchHit,
      verbatimHit(cand.content),
    ]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const out = await dedupAgainstRagCorpus([cand], { client });

    expect(out).toHaveLength(1);
    // The malformed hit is skipped, but the VALID overlapping hit still marks.
    expect(out[0].provenance.validated_against).toBeTruthy();
    expect(out[0].evidence.some((e) => e.kind === "fused_from")).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe("dedupAgainstRagCorpus — consecutive probe failures fail fast (V62-lite)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 5 token-rich candidates with distinct keys so every one issues a probe.
  function fiveCandidates(): Candidate[] {
    return Array.from({ length: 5 }, (_, i) =>
      makeCandidate({
        canonical_key: `github-pr:cpk-runtime:probe-streak-${i}`,
      }),
    );
  }

  it("throws a descriptive error after 5 consecutive probe failures (endpoint down ⇒ abort, do not silently disable the gate)", async () => {
    const searchMock = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED — endpoint down");
    });
    const client = { search: searchMock } as unknown as AtlasHttpClient;
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      dedupAgainstRagCorpus(fiveCandidates(), { client }),
    ).rejects.toThrow(
      "rag-dedup probe failed 5 consecutive times — endpoint down or misconfigured (url/auth); aborting rather than silently disabling the dedup gate",
    );
    expect(searchMock).toHaveBeenCalledTimes(5);
  });

  it("does NOT throw when a success interrupts the failure streak (4 failures, then a success)", async () => {
    let calls = 0;
    const searchMock = vi.fn(async () => {
      calls++;
      if (calls <= 4) throw new Error("transient corpus blip");
      return [] as SearchHit[];
    });
    const client = { search: searchMock } as unknown as AtlasHttpClient;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const out = await dedupAgainstRagCorpus(fiveCandidates(), { client });

    // The streak was broken by the 5th probe's success — no fail-fast throw,
    // count invariant intact, the 4 failed-probe candidates ride through
    // un-annotated (each failure logged).
    expect(out).toHaveLength(5);
    expect(searchMock).toHaveBeenCalledTimes(5);
    expect(errSpy).toHaveBeenCalledTimes(4);
    for (const c of out) {
      expect(c.provenance.validated_against).toBeUndefined();
    }
  });
});

describe("dedupAgainstRagCorpus — a probe error never aborts the batch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes a candidate through UN-annotated when its search probe throws, and keeps processing the rest", async () => {
    // A transient network blip on the FIRST candidate's probe must not unwind
    // the whole harvest: that candidate rides through unchanged, and the
    // subsequent candidate is still probed and (here) annotated.
    const flaky = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:flaky-probe",
      title: "Probe blows up for this one",
      content: "Prose whose corpus probe transiently fails.",
    });
    const overlapping = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:dup-after-flaky",
      title: "Duplicated claim already indexed in the corpus",
      content: "Duplicated prose already present verbatim in the corpus.",
    });

    const searchMock = vi.fn(async (q: { text: string }) => {
      if (q.text.includes("transiently fails")) {
        throw new Error("ECONNRESET: transient corpus blip");
      }
      return [verbatimHit(`${overlapping.title}\n${overlapping.content}`)];
    });
    const client = { search: searchMock } as unknown as AtlasHttpClient;
    // Keep the error visible but quiet in the test output.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const out = await dedupAgainstRagCorpus([flaky, overlapping], {
      client,
    });

    // Count invariant holds even through the probe failure.
    expect(out).toHaveLength(2);
    expect(searchMock).toHaveBeenCalledTimes(2);

    // The candidate whose probe threw rides through UN-annotated (unchanged).
    const passed = out.find((c) => c.canonical_key.endsWith(":flaky-probe"))!;
    expect(passed.provenance.validated_against).toBeUndefined();
    expect(passed.content).toBe(flaky.content);
    expect(passed.evidence).toEqual(flaky.evidence);

    // The subsequent candidate was still probed and annotated — the batch
    // did NOT abort on the earlier failure.
    const dup = out.find((c) => c.canonical_key.endsWith(":dup-after-flaky"))!;
    expect(dup.provenance.validated_against).toBeTruthy();

    // The probe error is logged (visible, greppable) with the candidate key.
    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = errSpy.mock.calls[0].join(" ");
    expect(logged).toContain("github-pr:cpk-runtime:flaky-probe");
  });
});
