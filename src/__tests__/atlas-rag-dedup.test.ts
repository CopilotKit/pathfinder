import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dedupAgainstRagCorpus,
  candidateProbeQueryText,
  MAX_PROBE_TEXT_ENCODED_BYTES,
  wireEncodedLength,
} from "../atlas/rag-dedup.js";
import type { RagDedupContext } from "../atlas/rag-dedup.js";
import type { AtlasHttpClient, SearchHit } from "../atlas/client.js";
import { recomputeRankScore } from "../atlas/canonicalize.js";
import { promoteValidation } from "../atlas/validate.js";
import type { ValidationContext } from "../atlas/validate.js";
import { CandidateSchema, RAG_NO_DELTA_MARKER } from "../atlas/types.js";
import type { Candidate } from "../atlas/types.js";
import type { FeatureRegistry } from "../atlas/adapters/showcase.js";

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

  // A candidate whose 2048-char leading slice is composed so the two encoders
  // DIVERGE across the byte budget: `!` is literal (1 char) under
  // encodeURIComponent but `%21` (3 chars) on the wire (URLSearchParams /
  // wireEncodedLength). Composition mirrors the X2 pin — a large `!` run plus a
  // CJK tail (9x under BOTH) — sized so the leading slice measures UNDER the
  // budget under encodeURIComponent (so an encodeURIComponent-bounded build
  // does NOT shrink it) yet well OVER it on the wire. That is exactly the
  // over-budget case an encodeURIComponent gate lets slip past 414-free while
  // the real wire rejects it. Only a wireEncodedLength-bounded implementation
  // shrinks the probe enough to fit the wire. The ASCII title clears the token
  // floor so the candidate is probed. Content is deliberately > the 2048-char
  // slice so the slice is the load-bearing surface.
  //
  //   sliced 2048 = title (~56) + "\n" + 1481 "!" + 510 CJK  (≈2048 chars)
  //   encodeURIComponent ≈ 56 + 3 + 1481*1 + 510*9 ≈ 6130  ≤ 6144  (no shrink)
  //   wire (URLSearchParams) ≈ 56 + 1 + 1481*3 + 510*9 ≈ 9110 > 6144 (rejected)
  function divergentCandidate(i: number): Candidate {
    return makeCandidate({
      canonical_key: `github-pr:cpk-runtime:divergent-${i}`,
      title: `knowledge base duplicate detection probe divergent ${i}`,
      content: "!".repeat(1481) + "気".repeat(700),
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

  it("a batch of 5 `!'()~`-divergent wire-heavy candidates against a wire-length-rejecting stub does NOT trip the consecutive-failure fail-fast", async () => {
    // The stub plays the server's role at the URL-length limit: an over-long
    // encoded query is rejected (as 414/431 would be). With char-only
    // truncation EVERY probe rejects ⇒ 5 consecutive probe failures ⇒ the
    // fail-fast aborts the run with the wrong diagnosis. With byte-aware
    // truncation every probe fits and the batch completes.
    //
    // CRUCIAL: the stub gates on the REAL wire encoder `client.search` uses
    // (wireEncodedLength / URLSearchParams), NOT encodeURIComponent. The two
    // DIVERGE on ` ` and `!'()~`, so an encodeURIComponent-gated stub would let
    // an over-wire-budget `!'()~`-dense probe slip past 414-free — silently
    // under-guarding this fail-fast. The batch MIXES CJK-heavy candidates (the
    // two encoders agree) with `!'()~`-divergent candidates (they diverge ~3x)
    // so this stub genuinely exercises the divergent over-budget case: with an
    // encodeURIComponent-bounded implementation the divergent probes exceed the
    // WIRE budget and this stub rejects them; only a wireEncodedLength-bounded
    // implementation keeps every probe under the wire budget so the batch
    // completes.
    const searchMock = vi.fn(async (q: { text: string }) => {
      if (wireEncodedLength(q.text) > MAX_PROBE_TEXT_ENCODED_BYTES) {
        throw new Error("414 URI Too Long");
      }
      return [] as SearchHit[];
    });
    const client = { search: searchMock } as unknown as AtlasHttpClient;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // ALL 5 candidates are `!'()~`-divergent (each over the WIRE budget but
    // under the encodeURIComponent budget on its 2048-char slice). Under an
    // encodeURIComponent-bounded implementation every probe over-shoots the
    // wire budget ⇒ 5 CONSECUTIVE 414s ⇒ the fail-fast trips and the gate
    // soft-disables. Under the correct wireEncodedLength-bounded implementation
    // every probe is shrunk to fit the wire, so NONE fail and the fail-fast
    // never trips. (CJK bodies would agree between the two encoders and can't
    // discriminate the bug — the divergent bodies are what make the stub's
    // encoder choice load-bearing.)
    const cands = Array.from({ length: 5 }, (_, i) => divergentCandidate(i));

    const out = await dedupAgainstRagCorpus(cands, { client });

    expect(out).toHaveLength(5);
    expect(searchMock).toHaveBeenCalledTimes(5);
    for (const c of out) {
      expect(c.provenance.validated_against).toBeUndefined();
    }
    // The fail-fast must NOT have tripped: with byte-aware (wire) truncation
    // every probe fits, so the gate is never soft-disabled. This is the
    // assertion that genuinely fails if the implementation regresses to an
    // encodeURIComponent bound (5 consecutive 414s ⇒ "dedup gate disabled").
    const warned = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(warned).not.toContain("dedup gate disabled");
    expect(errSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errSpy.mockRestore();
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

describe("dedupAgainstRagCorpus — empty/whitespace probe text is skipped, not sent nor counted as a failure (finding 3)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does NOT send an empty/whitespace probe query and counts it as SKIPPED, not a probe FAILURE", async () => {
    // Finding (3): a candidate that clears the MIN_CANDIDATE_TOKENS floor (on
    // its FULL body) but whose truncated PROBE text is empty/whitespace must NOT
    // be sent — an empty query draws a server 400 the per-candidate catch would
    // MIScount as a probe FAILURE, which (in a batch) can trip the false
    // "endpoint down" fail-fast. The gate must skip empty probe text: don't send
    // it, and count it as SKIPPED (never issued a probe), not FAILED.
    //
    // The gate reads the probe text via ctx.candidateProbeQueryText — an
    // injectable seam (defaulting to the module's candidateProbeQueryText) — so
    // the test can pin the exact whitespace-probe condition the guard defends,
    // independent of the truncation math. Five such candidates: under the OLD
    // behavior (empty query sent → 400 → counted failure) the streak would trip
    // and soft-disable; under the fix nothing is sent, nothing fails.
    function tokenRich(i: number): Candidate {
      return makeCandidate({
        canonical_key: `github-pr:cpk-runtime:ws-probe-${i}`,
      });
    }
    const cands = Array.from({ length: 5 }, (_, i) => tokenRich(i));

    const searchMock = vi.fn(async (q: { text: string }) => {
      if (q.text.trim() === "") throw new Error("400 Bad Request: empty query");
      return [] as SearchHit[];
    });
    const client = { search: searchMock } as unknown as AtlasHttpClient;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Force the probe text to whitespace for every candidate — the exact
    // condition finding (3) is about.
    const out = await dedupAgainstRagCorpus(cands, {
      client,
      candidateProbeQueryText: () => "   \n\t  ",
    });

    // Never dropped; count invariant intact.
    expect(out).toHaveLength(5);
    // The empty probe was never sent (nor did it throw / get counted).
    expect(searchMock).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    // Gate is NOT soft-disabled — empty probe text is a SKIP, not a failure.
    const warned = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(warned).not.toContain("dedup gate disabled");
    // Surfaced as skipped in the run-level metric (not failed).
    expect(warned).toContain("probesFailed=0");
    expect(warned).toContain("probesSkipped=5");
  });

  it("still probes normally when probe text is non-empty (guard does not over-skip)", async () => {
    // Guard is load-bearing only on empty/whitespace — a normal candidate must
    // still probe. Companion to the skip test above.
    const cand = makeCandidate();
    const { client, searchMock } = clientReturning([]);

    const out = await dedupAgainstRagCorpus([cand], { client });

    expect(out).toHaveLength(1);
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock.mock.calls[0][0].text.trim()).not.toBe("");
  });
});

describe("dedupAgainstRagCorpus — disable-warning denominator is the PROBEABLE count, not cands.length (finding 4)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("the 'N/M probes failed' warning divides by the probeable count, not the total candidate count", async () => {
    // Finding (4): the header defines the ratio over the PROBEABLE candidates
    // (those that cleared the token floor and were reached before soft-disable),
    // but the warning divided by cands.length — so a batch padded with
    // sub-token-floor candidates reported a misleading denominator. Here: 5
    // token-rich candidates whose probes all fail (tripping the streak) PLUS 3
    // sub-token-floor tinies that never probe. Only the 5 are probeable, so the
    // ratio must read 5/5, not 5/8.
    const tinies = Array.from({ length: 3 }, (_, i) =>
      makeCandidate({
        canonical_key: `github-pr:cpk-runtime:tiny-pad-${i}`,
        title: "a",
        content: "b",
      }),
    );
    const probeables = Array.from({ length: 5 }, (_, i) =>
      makeCandidate({
        canonical_key: `github-pr:cpk-runtime:probeable-${i}`,
      }),
    );
    // Interleave the tinies first so they are counted as skipped before the
    // streak trips on the probeables.
    const cands = [...tinies, ...probeables];

    const searchMock = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED — endpoint down");
    });
    const client = { search: searchMock } as unknown as AtlasHttpClient;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const out = await dedupAgainstRagCorpus(cands, { client });

    expect(out).toHaveLength(8);
    // Only the 5 token-rich candidates were probed.
    expect(searchMock).toHaveBeenCalledTimes(5);
    const warned = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    // The disable warning's ratio uses the PROBEABLE denominator (5), not 8.
    expect(warned).toContain("dedup gate disabled: 5/5 probes failed");
    expect(warned).not.toContain("5/8 probes failed");
  });
});

describe("dedupAgainstRagCorpus — consecutive probe failures SOFT-disable the gate (C.3)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Token-rich candidates with distinct keys so every one issues a probe.
  function nCandidates(n: number): Candidate[] {
    return Array.from({ length: n }, (_, i) =>
      makeCandidate({
        canonical_key: `github-pr:cpk-runtime:probe-streak-${i}`,
      }),
    );
  }

  it("does NOT abort the harvest after 5 consecutive probe failures — it soft-disables, emits all candidates, and warns loudly (C.3)", async () => {
    // Theme C.3: the OLD behavior hard-threw on the 5th consecutive probe
    // failure, unwinding runHarvest and LOSING every candidate processed so far
    // (the gate runs BEFORE the upsert). The NEW behavior soft-disables: the
    // run still returns ALL candidates (un-annotated) and warns loudly with a
    // "dedup gate disabled: N/M probes failed" run-level message.
    const searchMock = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED — endpoint down");
    });
    const client = { search: searchMock } as unknown as AtlasHttpClient;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // 8 candidates: 5 probes fail (tripping the streak on the 5th), then the
    // gate is soft-disabled so the remaining 3 are passed through WITHOUT a
    // probe.
    const out = await dedupAgainstRagCorpus(nCandidates(8), { client });

    // No throw: the whole batch is returned, count invariant intact.
    expect(out).toHaveLength(8);
    for (const c of out) {
      expect(c.provenance.validated_against).toBeUndefined();
    }
    // Only the first 5 candidates were probed; the streak trip stopped probing.
    expect(searchMock).toHaveBeenCalledTimes(5);

    // The soft-disable is warned LOUDLY with the "dedup gate disabled" message.
    // The ratio uses the PROBEABLE denominator (finding 4): 5 candidates were
    // probed+failed, tripping the streak; the remaining 3 were passed through
    // WITHOUT a probe (soft-disabled), so they are NOT probeable — the ratio is
    // 5/5, not 5/8.
    const warned = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(warned).toContain("dedup gate disabled");
    expect(warned).toContain("5/5 probes failed");
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

    const out = await dedupAgainstRagCorpus(nCandidates(5), { client });

    // The streak was broken by the 5th probe's success — no soft-disable, count
    // invariant intact, the 4 failed-probe candidates ride through un-annotated
    // (each failure logged).
    expect(out).toHaveLength(5);
    expect(searchMock).toHaveBeenCalledTimes(5);
    expect(errSpy).toHaveBeenCalledTimes(4);
    for (const c of out) {
      expect(c.provenance.validated_against).toBeUndefined();
    }
  });

  it("a ≤4-candidate all-probes-down run can never trip the streak, but STILL emits the run-level probe metric — the only disabled-gate signal there (C.3 coverage)", async () => {
    // THE ≤4-CANDIDATE GAP (C.3): a run with fewer than
    // MAX_CONSECUTIVE_PROBE_FAILURES probeable candidates can never reach the
    // consecutive-failure streak, so an endpoint that is down for such a run
    // gets NO fail-fast signal. Before C.3 the gate was silently disabled for
    // those runs with ZERO telemetry — the run looked like a clean success.
    // The fix: emit a run-level probesFailed/probesSkipped metric ALWAYS, so
    // even a 4-candidate all-down run surfaces that the gate covered nothing.
    const searchMock = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED — endpoint down");
    });
    const client = { search: searchMock } as unknown as AtlasHttpClient;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const out = await dedupAgainstRagCorpus(nCandidates(4), { client });

    // All 4 probed and failed; never dropped; count invariant intact.
    expect(out).toHaveLength(4);
    expect(searchMock).toHaveBeenCalledTimes(4);

    // The streak never tripped (4 < 5), so the gate is NOT reported as disabled…
    const warned = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(warned).not.toContain("dedup gate disabled");
    // …but the run-level probe metric IS emitted — the disabled-gate signal for
    // a run too small to trip the streak.
    expect(warned).toContain("run-level probe metric");
    expect(warned).toContain("probesFailed=4");
    expect(warned).toContain("probesSkipped=0");
  });
});

describe("dedupAgainstRagCorpus — a DETERMINISTIC annotation bug PROPAGATES, it is not swallowed (C.3 annotation isolation)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not swallow a deterministic annotateOverlap failure as a pass-through — the bug propagates loudly", async () => {
    // Theme C.3 (annotation isolation): the deterministic lexical annotation
    // path (bestOverlap → annotateOverlap) used to live INSIDE the same
    // try/catch as the network probe, so a CODE bug in annotation was silently
    // swallowed as a per-candidate "pass-through un-annotated" — a green run
    // hiding a real defect. After C.3 that path is OUTSIDE the probe catch, so
    // a deterministic failure PROPAGATES.
    //
    // We reproduce a deterministic annotation failure with a candidate whose
    // `evidence` is not an array: annotateOverlap calls `cand.evidence.some(…)`,
    // which throws a TypeError — a stand-in for any deterministic annotation
    // regression. The probe RESOLVES with a verbatim overlap, so bestOverlap
    // matches and annotateOverlap is reached.
    const cand = makeCandidate();
    // Corrupt evidence deterministically (cast — a malformed in-memory object).
    (cand as unknown as { evidence: unknown }).evidence = null;

    const { client } = clientReturning([verbatimHit(cand.content)]);

    // The deterministic bug propagates (TypeError from `.some` on null) rather
    // than being swallowed into a silent pass-through.
    await expect(dedupAgainstRagCorpus([cand], { client })).rejects.toThrow();
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

// ── SEMANTIC (pgvector) dedup + distill-to-delta (Theme B — S9) ─────────────────
//
// ORG RULE: the embed AND distill calls are LLM-backed, so their tests use
// aimock — never vi.fn stubs for the model call. We spin up an in-process aimock
// server, point a real OpenAIDistiller at it via baseURL, and drive the REAL
// embed (/v1/embeddings) + REAL distillDelta (/v1/chat/completions) surfaces.
// The `vectorSearch` seam is a NON-LLM DB external (cosine over the chunks
// table), so it is a vi.fn returning controlled CorpusHits — this lets the test
// pin the cosine similarity deterministically (the aimock deterministic
// embedding is stable-per-text but its raw cosine between two arbitrary texts is
// not a controllable oracle for a paraphrase; the DB seam is where similarity is
// decided in production, so mocking THAT is the honest boundary).
//
// RED-GREEN (the load-bearing proof for S9): a PARAPHRASE of an indexed corpus
// passage shares almost no [a-z0-9] surface tokens with it, so the LEXICAL
// containment oracle (the old whole gate) does NOT mark it — it rides through as
// a false novel. The SEMANTIC path (embed → vectorSearch cosine ≥ threshold →
// distillDelta) DOES detect the overlap and rewrites the candidate to its
// net-new delta. The RED assertion below pins the lexical miss; the GREEN
// assertions pin the semantic catch + delta rewrite.
describe("dedupAgainstRagCorpus — semantic (pgvector) dedup + distill-to-delta (S9)", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  let LLMockCtor: typeof import("@copilotkit/aimock").LLMock;
  let OpenAIDistillerCtor: typeof import("../atlas/llm.js").OpenAIDistiller;

  // The indexed corpus passage (the "already known" prose) and a PARAPHRASE of
  // it that a real harvest would newly produce. The two share hardly any
  // [a-z0-9] tokens — the lexical oracle's blind spot.
  const CORPUS_PASSAGE =
    "The runtime keeps a thin v1 compatibility shim that forwards calls into " +
    "the v2 engine so existing apps run unchanged.";
  const PARAPHRASE =
    "Legacy applications continue operating without modification because a " +
    "lightweight adapter relays first-generation requests onto the newer core.";
  // The distilled net-new delta the (aimock) model returns for the paraphrase.
  const DELTA_MARKER = "SEMANTIC-DELTA-WINDOW";
  const DELTA_CONTENT =
    `${DELTA_MARKER}: the adapter additionally records a per-call migration ` +
    "metric the v2 core does not, so operators can track legacy traffic decay.";

  beforeAll(async () => {
    ({ LLMock: LLMockCtor } = await import("@copilotkit/aimock"));
    ({ OpenAIDistiller: OpenAIDistillerCtor } =
      await import("../atlas/llm.js"));
  });

  // A vectorSearch seam that returns a single controlled CorpusHit at a pinned
  // cosine similarity — the DB boundary where production decides overlap.
  function vectorSearchReturning(similarity: number) {
    const mock = vi.fn(async () => [
      {
        similarity,
        content: CORPUS_PASSAGE,
        id: 7,
        title: "Indexed v1→v2 shim passage",
        sourceUrl: "https://example.test/corpus/shim",
        sourceName: "docs",
      },
    ]);
    return mock;
  }

  it("RED: the lexical oracle alone does NOT mark a paraphrase of an indexed passage (surface-token miss)", async () => {
    // The candidate is a PARAPHRASE — the live lexical search returns the
    // indexed passage as a hit, but token containment is far below 0.8 because
    // the paraphrase shares almost no surface tokens. With NO semantic seams
    // wired (the old mark-only behavior) the candidate rides through unmarked.
    const cand = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:paraphrase",
      title: "Legacy app compatibility via a relay adapter",
      content: PARAPHRASE,
    });
    const { client } = clientReturning([verbatimHit(CORPUS_PASSAGE)]);

    const out = await dedupAgainstRagCorpus([cand], { client });

    expect(out).toHaveLength(1);
    // The lexical gate MISSED the paraphrase — no overlap annotation.
    expect(out[0].provenance.validated_against).toBeUndefined();
    expect(out[0].evidence.some((e) => e.kind === "fused_from")).toBe(false);
    // And the content is the full (duplicative) paraphrase, un-distilled.
    expect(out[0].content).toBe(PARAPHRASE);
  });

  it("GREEN: the semantic path catches the paraphrase and distills content to its net-new delta", async () => {
    const mock = new LLMockCtor({ port: 0, logLevel: "silent" });
    mock.addFixture({
      match: {
        systemMessage: "knowledge-DELTA distiller",
        userMessage: PARAPHRASE,
      },
      response: {
        content: JSON.stringify({
          verdict: "delta",
          reason: "the migration metric is not covered by the corpus passage",
          content: DELTA_CONTENT,
        }),
      },
    });
    await mock.start();
    try {
      const distiller = new OpenAIDistillerCtor({
        baseURL: `${mock.url}/v1`,
        apiKey: "mock",
      });
      const cand = makeCandidate({
        canonical_key: "github-pr:cpk-runtime:paraphrase",
        title: "Legacy app compatibility via a relay adapter",
        content: PARAPHRASE,
      });
      // Lexical probe finds the passage but at low containment (< 0.8) → survives
      // the pre-filter; the semantic seam then pins the cosine ABOVE threshold.
      const { client } = clientReturning([verbatimHit(CORPUS_PASSAGE)]);
      const vectorSearch = vectorSearchReturning(0.95);

      const out = await dedupAgainstRagCorpus([cand], {
        client,
        embed: (t) => distiller.embed(t),
        vectorSearch,
        distillDelta: (c, overlaps) =>
          distiller.distillDelta({
            title: c.title,
            content: c.content,
            overlaps: overlaps.map((h) => ({ content: h.content })),
          }),
      });

      // The embed roundtrip really hit aimock (real /v1/embeddings), the vector
      // seam was queried, and the overlap was resolved to its delta.
      expect(vectorSearch).toHaveBeenCalledTimes(1);
      const embeddingHits = mock
        .getRequests()
        .filter((e) => e.path.endsWith("/v1/embeddings"));
      expect(embeddingHits.length).toBeGreaterThanOrEqual(1);

      expect(out).toHaveLength(1);
      // Content rewritten to the net-new delta (not the full paraphrase).
      expect(out[0].content).toBe(DELTA_CONTENT);
      // Overlap annotated (rank-neutral) pointing at the corpus passage.
      expect(out[0].provenance.validated_against).toContain(
        "rag-corpus-overlap:https://example.test/corpus/shim",
      );
      expect(out[0].evidence.some((e) => e.kind === "fused_from")).toBe(true);
      // Still approvable (a delta remains) and schema-valid.
      expect(out[0].approvable).toBe(true);
      expect(() => CandidateSchema.parse(out[0])).not.toThrow();
    } finally {
      await mock.stop();
    }
  });

  it("GREEN: a semantic overlap with NO net-new delta floors approvable=false (never dropped)", async () => {
    const mock = new LLMockCtor({ port: 0, logLevel: "silent" });
    const fullyRedundant =
      "A lightweight adapter relays first-generation requests onto the newer " +
      "core so legacy applications keep working with no changes at all.";
    mock.addFixture({
      match: {
        systemMessage: "knowledge-DELTA distiller",
        userMessage: fullyRedundant,
      },
      response: {
        content: JSON.stringify({
          verdict: "no-delta",
          reason: "everything is already covered by the corpus passage",
        }),
      },
    });
    await mock.start();
    try {
      const distiller = new OpenAIDistillerCtor({
        baseURL: `${mock.url}/v1`,
        apiKey: "mock",
      });
      const cand = makeCandidate({
        canonical_key: "github-pr:cpk-runtime:redundant",
        title: "Legacy compatibility relay",
        content: fullyRedundant,
      });
      const { client } = clientReturning([verbatimHit(CORPUS_PASSAGE)]);

      const out = await dedupAgainstRagCorpus([cand], {
        client,
        embed: (t) => distiller.embed(t),
        vectorSearch: vectorSearchReturning(0.93),
        distillDelta: (c, overlaps) =>
          distiller.distillDelta({
            title: c.title,
            content: c.content,
            overlaps: overlaps.map((h) => ({ content: h.content })),
          }),
      });

      expect(out).toHaveLength(1); // NEVER dropped
      expect(out[0].approvable).toBe(false); // floored
      expect(out[0].content).toBe(fullyRedundant); // content untouched (no delta)
      expect(out[0].provenance.validated_against).toContain(
        "rag-corpus-overlap:",
      );
      // The DEDICATED no-delta floor marker is stamped on BOTH carriers, so the
      // downstream validation gate can keep the duplicate non-approvable even
      // after its symbols source-verify (see the integration test below).
      expect(out[0].provenance.validated_against).toContain(
        RAG_NO_DELTA_MARKER,
      );
      expect(
        out[0].evidence.some(
          (e) => e.kind === "fused_from" && e.ref === RAG_NO_DELTA_MARKER,
        ),
      ).toBe(true);
      expect(() => CandidateSchema.parse(out[0])).not.toThrow();
    } finally {
      await mock.stop();
    }
  });

  // INTEGRATION: the rag-dedup no-delta floor must SURVIVE the downstream
  // validation gate. promoteValidation RECOMPUTES `approvable` from the promoted
  // validation_status, so a no-delta corpus-duplicate whose validationTargets
  // source-verify would (before the dedicated-marker fix) be clobbered back to
  // approvable=true — silently defeating dedup's "duplicates aren't approvable"
  // guarantee. This asserts the composed floor end-to-end: real gate output →
  // real promoteValidation → still approvable=false.
  it("GREEN: a no-delta floor SURVIVES promoteValidation even when the duplicate's symbols source-verify", async () => {
    const checkoutDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "atlas-rag-dedup-integ-"),
    );
    fs.mkdirSync(path.join(checkoutDir, "src"), { recursive: true });
    // A genuine declaration so the duplicate's validationTarget source-verifies
    // (which is exactly what would lift the floor if it were not composed).
    fs.writeFileSync(
      path.join(checkoutDir, "src", "shim.ts"),
      "export const forwardToV2 = () => {};\n",
    );
    const featureRegistry: FeatureRegistry = { version: "1", categories: [] };
    const validationCtx: ValidationContext = { checkoutDir, featureRegistry };

    const mock = new LLMockCtor({ port: 0, logLevel: "silent" });
    const fullyRedundant =
      "A lightweight adapter relays first-generation requests onto the newer " +
      "core so legacy applications keep working with no changes at all.";
    mock.addFixture({
      match: {
        systemMessage: "knowledge-DELTA distiller",
        userMessage: fullyRedundant,
      },
      response: {
        content: JSON.stringify({
          verdict: "no-delta",
          reason: "everything is already covered by the corpus passage",
        }),
      },
    });
    await mock.start();
    try {
      const distiller = new OpenAIDistillerCtor({
        baseURL: `${mock.url}/v1`,
        apiKey: "mock",
      });
      const base = makeCandidate({
        canonical_key: "github-pr:cpk-runtime:redundant-integ",
        title: "Legacy compatibility relay",
        content: fullyRedundant,
      });
      // An architecture claim, entering UNVERIFIED, whose symbol IS declared in
      // the checkout → the validation gate promotes it to source-verified and
      // (absent the composed floor) would recompute approvable=true.
      const cand: Candidate = {
        ...base,
        validationTargets: ["forwardToV2"],
        provenance: {
          ...base.provenance,
          classification: {
            ...base.provenance.classification,
            knowledge_type: "architecture",
            validation_status: "unverified",
          },
        },
      };
      const { client } = clientReturning([verbatimHit(CORPUS_PASSAGE)]);

      const deduped = await dedupAgainstRagCorpus([cand], {
        client,
        embed: (t) => distiller.embed(t),
        vectorSearch: vectorSearchReturning(0.93),
        distillDelta: (c, overlaps) =>
          distiller.distillDelta({
            title: c.title,
            content: c.content,
            overlaps: overlaps.map((h) => ({ content: h.content })),
          }),
      });
      expect(deduped).toHaveLength(1);
      expect(deduped[0].approvable).toBe(false); // floored by the gate

      // Now the DOWNSTREAM validation gate. The symbol source-verifies, so the
      // status IS promoted (display truth) — but the composed no-delta floor
      // keeps the duplicate non-approvable.
      const validated = await promoteValidation(deduped[0], validationCtx);
      expect(validated.provenance.classification.validation_status).toBe(
        "source-verified",
      );
      expect(validated.approvable).toBe(false);
    } finally {
      await mock.stop();
      fs.rmSync(checkoutDir, { recursive: true, force: true });
    }
  });

  // REGRESSION (verdict-flip): a no-delta re-run STAMPS the RAG_NO_DELTA_MARKER
  // floor onto BOTH carriers (validated_against token + fused_from evidence ref).
  // A LATER re-run that flips the verdict to `delta` (net-new content now exists)
  // MUST strip that stale floor marker from BOTH carriers — otherwise
  // validate.ts:promoteValidation reads the leftover marker via hasFloorMarker
  // and re-floors approvable=false PERMANENTLY, silently defeating the flip. This
  // mirrors distillation-gate's stripRestatementMarker guarding RESTATEMENT_MARKER
  // on its own non-restatement verdict flips.
  it("REGRESSION: a no-delta→delta re-run STRIPS the stale RAG_NO_DELTA_MARKER from both carriers so promoteValidation does NOT re-floor", async () => {
    const checkoutDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "atlas-rag-dedup-flip-"),
    );
    fs.mkdirSync(path.join(checkoutDir, "src"), { recursive: true });
    // A genuine declaration so the candidate's validationTarget source-verifies
    // (which is exactly what lifts the composed floor when it is NOT floored).
    fs.writeFileSync(
      path.join(checkoutDir, "src", "shim.ts"),
      "export const forwardToV2 = () => {};\n",
    );
    const featureRegistry: FeatureRegistry = { version: "1", categories: [] };
    const validationCtx: ValidationContext = { checkoutDir, featureRegistry };

    const fullyRedundant =
      "A lightweight adapter relays first-generation requests onto the newer " +
      "core so legacy applications keep working with no changes at all.";

    // ── Run 1: no-delta → floor stamped on BOTH carriers ─────────────────────
    const noDeltaMock = new LLMockCtor({ port: 0, logLevel: "silent" });
    noDeltaMock.addFixture({
      match: {
        systemMessage: "knowledge-DELTA distiller",
        userMessage: fullyRedundant,
      },
      response: {
        content: JSON.stringify({
          verdict: "no-delta",
          reason: "everything is already covered by the corpus passage",
        }),
      },
    });
    await noDeltaMock.start();

    let floored: Candidate;
    try {
      const distiller = new OpenAIDistillerCtor({
        baseURL: `${noDeltaMock.url}/v1`,
        apiKey: "mock",
      });
      const base = makeCandidate({
        canonical_key: "github-pr:cpk-runtime:flip",
        title: "Legacy compatibility relay",
        content: fullyRedundant,
      });
      const cand: Candidate = {
        ...base,
        validationTargets: ["forwardToV2"],
        provenance: {
          ...base.provenance,
          classification: {
            ...base.provenance.classification,
            knowledge_type: "architecture",
            validation_status: "unverified",
          },
        },
      };
      const { client } = clientReturning([verbatimHit(CORPUS_PASSAGE)]);
      const out = await dedupAgainstRagCorpus([cand], {
        client,
        embed: (t) => distiller.embed(t),
        vectorSearch: vectorSearchReturning(0.93),
        distillDelta: (c, overlaps) =>
          distiller.distillDelta({
            title: c.title,
            content: c.content,
            overlaps: overlaps.map((h) => ({ content: h.content })),
          }),
      });
      floored = out[0];
      // Sanity: run 1 stamped the floor marker on BOTH carriers.
      expect(floored.approvable).toBe(false);
      expect(floored.provenance.validated_against).toContain(
        RAG_NO_DELTA_MARKER,
      );
      expect(
        floored.evidence.some(
          (e) => e.kind === "fused_from" && e.ref === RAG_NO_DELTA_MARKER,
        ),
      ).toBe(true);
    } finally {
      await noDeltaMock.stop();
    }

    // ── Run 2: delta → adopt net-new content; stale floor marker MUST be gone ──
    const deltaMock = new LLMockCtor({ port: 0, logLevel: "silent" });
    const NET_NEW =
      "FLIP-DELTA: the adapter now emits a per-call migration metric the v2 " +
      "core does not, so operators can track legacy traffic decay over time.";
    deltaMock.addFixture({
      match: {
        systemMessage: "knowledge-DELTA distiller",
        userMessage: fullyRedundant,
      },
      response: {
        content: JSON.stringify({
          verdict: "delta",
          reason: "the migration metric is genuinely net-new",
          content: NET_NEW,
        }),
      },
    });
    await deltaMock.start();
    try {
      const distiller = new OpenAIDistillerCtor({
        baseURL: `${deltaMock.url}/v1`,
        apiKey: "mock",
      });
      const { client } = clientReturning([verbatimHit(CORPUS_PASSAGE)]);
      const rerun = await dedupAgainstRagCorpus([floored], {
        client,
        embed: (t) => distiller.embed(t),
        vectorSearch: vectorSearchReturning(0.93),
        distillDelta: (c, overlaps) =>
          distiller.distillDelta({
            title: c.title,
            content: c.content,
            overlaps: overlaps.map((h) => ({ content: h.content })),
          }),
      });
      const flipped = rerun[0];
      // The re-run adopted the net-new delta content.
      expect(flipped.content).toBe(NET_NEW);
      // The stale floor marker MUST be stripped from BOTH carriers.
      expect(flipped.provenance.validated_against ?? "").not.toContain(
        RAG_NO_DELTA_MARKER,
      );
      expect(
        flipped.evidence.some(
          (e) => e.kind === "fused_from" && e.ref === RAG_NO_DELTA_MARKER,
        ),
      ).toBe(false);
      // And the DOWNSTREAM gate must NOT re-floor: the symbol source-verifies,
      // and with no stale marker the composed floor lifts approvable back to true.
      const validated = await promoteValidation(flipped, validationCtx);
      expect(validated.provenance.classification.validation_status).toBe(
        "source-verified",
      );
      expect(validated.approvable).toBe(true);
      expect(() => CandidateSchema.parse(flipped)).not.toThrow();
    } finally {
      await deltaMock.stop();
      fs.rmSync(checkoutDir, { recursive: true, force: true });
    }
  });

  it("GREEN: a VERBATIM duplicate short-circuits the EMBED round-trip but STILL distills-to-delta (F4)", async () => {
    // A verbatim-overlap candidate is caught by the fast lexical path BEFORE the
    // embed round-trip: embed + vectorSearch must NOT be called (the lexical hit
    // already IS the confirmed overlap — that fast-path win is preserved). But
    // per §6.2 / the module header it must STILL route through distill-to-delta
    // (F4) — the old mark-only short-circuit left a verbatim duplicate fully
    // approvable while a weaker semantic paraphrase got floored. Here distillDelta
    // returns no-overlap, so the candidate is annotated (content/approvability
    // untouched) but the distill seam WAS consulted.
    const cand = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:verbatim",
      content: CORPUS_PASSAGE,
    });
    const { client } = clientReturning([verbatimHit(CORPUS_PASSAGE)]);
    const embed = vi.fn(async () => [1, 2, 3]);
    const vectorSearch = vi.fn(async () => []);
    const distillDelta = vi.fn(async () => ({ kind: "no-overlap" as const }));

    const out = await dedupAgainstRagCorpus([cand], {
      client,
      embed,
      vectorSearch,
      distillDelta,
    });

    expect(out).toHaveLength(1);
    // Fast lexical short-circuit: NO re-embed, NO vector query (the lexical hit
    // already confirmed the overlap)…
    expect(embed).not.toHaveBeenCalled();
    expect(vectorSearch).not.toHaveBeenCalled();
    // …but the distill-to-delta seam IS consulted (F4 — not mark-only).
    expect(distillDelta).toHaveBeenCalledTimes(1);
    // Still marked as a verbatim overlap.
    expect(out[0].provenance.validated_against).toBeTruthy();
    expect(out[0].evidence.some((e) => e.kind === "fused_from")).toBe(true);
  });

  it("GREEN: a degenerate near-empty/whitespace delta is treated as no-delta (approvable=false, content untouched)", async () => {
    // Finding (1): a `delta` verdict whose rewritten content is empty/whitespace
    // is degenerate — adopting it would overwrite the candidate's content with
    // nothing and still seed it approvable. It must be floored to the SAME
    // outcome as an explicit no-delta: annotate the overlap, keep the original
    // content, mark approvable=false, never drop.
    const cand = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:degenerate-delta",
      title: "Legacy app compatibility via a relay adapter",
      content: PARAPHRASE,
    });
    const { client } = clientReturning([verbatimHit(CORPUS_PASSAGE)]);
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);
    const vectorSearch = vectorSearchReturning(0.95);
    // The (injected) distill seam returns a `delta` verdict but with whitespace
    // content — a degenerate rewrite the gate must not adopt.
    const distillDelta = vi.fn(async () => ({
      kind: "delta" as const,
      content: "   \n\t  ",
      reason: "degenerate whitespace delta",
    }));

    const out = await dedupAgainstRagCorpus([cand], {
      client,
      embed,
      vectorSearch,
      distillDelta,
    });

    expect(out).toHaveLength(1); // NEVER dropped
    // Degenerate delta → no-delta outcome: original content preserved…
    expect(out[0].content).toBe(PARAPHRASE);
    // …approvability floored…
    expect(out[0].approvable).toBe(false);
    // …and the overlap still annotated (rank-neutral).
    expect(out[0].provenance.validated_against).toContain(
      "rag-corpus-overlap:",
    );
    expect(() => CandidateSchema.parse(out[0])).not.toThrow();
  });

  it("counts and WARNS a fully-failing semantic layer (embed/vectorSearch/distill throw) — never silent", async () => {
    // Finding (2): when the semantic seams throw, the candidate rides through
    // un-annotated (correct — never a lost row), but the failure was previously
    // counted by NOTHING and warned by NOTHING, so a fully-broken semantic layer
    // reported probesFailed=0/probesSkipped=0 — violating the header's "never
    // silently disabled" claim. The gate must count and surface the degradation.
    const cand = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:semantic-fail",
      title: "Legacy app compatibility via a relay adapter",
      content: PARAPHRASE,
    });
    const { client } = clientReturning([verbatimHit(CORPUS_PASSAGE)]);
    const embed = vi.fn(async () => {
      throw new Error("embed endpoint down");
    });
    const vectorSearch = vi.fn(async () => []);
    const distillDelta = vi.fn(async () => ({ kind: "no-overlap" as const }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const out = await dedupAgainstRagCorpus([cand], {
      client,
      embed,
      vectorSearch,
      distillDelta,
    });

    // Never dropped, rides through un-annotated.
    expect(out).toHaveLength(1);
    expect(out[0].provenance.validated_against).toBeUndefined();
    // The semantic-layer degradation is surfaced (counted + warned), not silent.
    const warned = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(warned).toContain("semanticFailed=1");
    vi.restoreAllMocks();
  });

  it("annotates a vector overlap even when distillDelta returns no-overlap (header's every-overlap-is-annotated guarantee)", async () => {
    // Bucket (a) finding: the vector oracle already flagged this candidate as an
    // overlap (cosine ≥ DEFAULT_MIN_SEMANTIC_OVERLAP), which is the ONLY reason
    // distillDelta was invoked at all. If the injected distillDelta seam returns
    // `no-overlap` — disagreeing with the vector oracle — the OLD behavior passed
    // the candidate through with NO annotation, violating the module header's
    // "every overlapping candidate is ANNOTATED" guarantee: a candidate the
    // semantic layer positively identified as a corpus overlap left no provenance
    // trail of that fact. The fix ANNOTATES it (rank-neutral, content untouched,
    // still approvable — the delta seam declined to trim it) so the corpus match
    // is recorded. Never drops.
    const cand = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:vector-overlap-no-delta-verdict",
      title: "Legacy app compatibility via a relay adapter",
      content: PARAPHRASE,
    });
    const { client } = clientReturning([verbatimHit(CORPUS_PASSAGE)]);
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);
    // Cosine ABOVE threshold → the vector oracle says OVERLAP.
    const vectorSearch = vectorSearchReturning(0.95);
    // …but the distill seam disagrees and returns no-overlap.
    const distillDelta = vi.fn(async () => ({ kind: "no-overlap" as const }));

    const out = await dedupAgainstRagCorpus([cand], {
      client,
      embed,
      vectorSearch,
      distillDelta,
    });

    expect(out).toHaveLength(1); // NEVER dropped
    // It WAS a vector overlap, so it must be annotated even though distillDelta
    // said no-overlap — the every-overlap-is-annotated guarantee.
    expect(out[0].provenance.validated_against).toContain(
      "rag-corpus-overlap:https://example.test/corpus/shim",
    );
    expect(out[0].evidence.some((e) => e.kind === "fused_from")).toBe(true);
    // Content untouched (the delta seam declined to trim) and still approvable
    // (no-overlap is not the no-delta floor).
    expect(out[0].content).toBe(PARAPHRASE);
    expect(out[0].approvable).toBe(true);
    expect(() => CandidateSchema.parse(out[0])).not.toThrow();
  });

  it("CJK candidate (empty lexical token set) is ROUTED to the semantic path instead of being short-circuited out", async () => {
    // Finding (1): a candidate whose [a-z0-9] token set is EMPTY (CJK / other
    // non-Latin prose) has candTokens.size = 0 < MIN_CANDIDATE_TOKENS, so the
    // OLD behavior short-circuited it out (pushed through un-annotated) BEFORE
    // the semantic layer ever ran. But the semantic layer (embeddings) is
    // language-agnostic and was built (§6.2) specifically to catch this CJK /
    // paraphrase overlap. So a CJK candidate with real content must still reach
    // the SEMANTIC path when the semantic seams are wired — not skip the gate.
    const cjkContent =
      "候補の重複検出は照合対象の本文全体で行う必要がある実行環境は互換シムを保持する";
    const cand = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:cjk-semantic-route",
      title: "実行環境の互換シム",
      content: cjkContent,
    });
    // No lexical hit (containment on an empty CJK token set is meaningless).
    const { client } = clientReturning([]);
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);
    const vectorSearch = vectorSearchReturning(0.95);
    const distillDelta = vi.fn(async () => ({ kind: "no-overlap" as const }));

    const out = await dedupAgainstRagCorpus([cand], {
      client,
      embed,
      vectorSearch,
      distillDelta,
    });

    expect(out).toHaveLength(1); // NEVER dropped
    // The load-bearing assertion: the CJK candidate REACHED the semantic path.
    // Under the old short-circuit these would never be called.
    expect(embed).toHaveBeenCalledTimes(1);
    expect(vectorSearch).toHaveBeenCalledTimes(1);
    // The vector oracle flagged the overlap → annotated (rank-neutral).
    expect(out[0].provenance.validated_against).toContain(
      "rag-corpus-overlap:",
    );
    expect(out[0].evidence.some((e) => e.kind === "fused_from")).toBe(true);
    expect(() => CandidateSchema.parse(out[0])).not.toThrow();
  });

  it("a CJK candidate still skips the gate cleanly when the semantic seams are NOT wired (lexical-only fallback)", async () => {
    // Companion to the route test: with NO semantic seams, a CJK candidate
    // (empty lexical token set) cannot be usefully lexically probed, so it
    // rides through un-annotated — never dropped. The client is NOT probed
    // (the empty token set can never clear the containment gate).
    const cand = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:cjk-lexical-fallback",
      title: "実行環境の互換シム",
      content: "候補の重複検出は照合対象の本文全体で行う必要がある",
    });
    const { client, searchMock } = clientReturning([]);

    const out = await dedupAgainstRagCorpus([cand], { client });

    expect(out).toHaveLength(1);
    // No lexical probe: an empty token set can never clear the containment gate.
    expect(searchMock).not.toHaveBeenCalled();
    expect(out[0].provenance.validated_against).toBeUndefined();
  });

  it("a genuinely EMPTY candidate (no content at all) is skipped, not routed to embed", async () => {
    // The floor still guards the genuine-empty case: a candidate with no
    // content whatsoever has nothing to embed, so it must be skipped (never
    // dropped) rather than sent to the semantic seam.
    const cand = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:genuinely-empty",
      title: "",
      content: "",
    });
    const { client, searchMock } = clientReturning([]);
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);
    const vectorSearch = vi.fn(async () => []);
    const distillDelta = vi.fn(async () => ({ kind: "no-overlap" as const }));

    const out = await dedupAgainstRagCorpus([cand], {
      client,
      embed,
      vectorSearch,
      distillDelta,
    });

    expect(out).toHaveLength(1); // NEVER dropped
    // Genuinely empty → nothing to embed; the semantic seams are NOT called.
    expect(searchMock).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(vectorSearch).not.toHaveBeenCalled();
    expect(out[0].provenance.validated_against).toBeUndefined();
  });

  it("an OVERSIZED candidate body is TRUNCATED before embed (not swallowed as a semantic failure)", async () => {
    // Finding (2): the semantic path embedded candidateFullText(cand) — the
    // FULL untruncated body. An oversized candidate exceeds the embedding
    // model's input limit, the seam throws, and the failure is swallowed as
    // semanticFailed → a SILENT skip for exactly the largest (most
    // duplication-prone) candidates. The lexical path already truncates for
    // this reason; the semantic path must too. Here the injected embed seam
    // plays the model's role: it THROWS on an over-budget input, exactly as a
    // real /v1/embeddings 400/413 would. With truncation the embed input is
    // bounded so it never throws and the candidate gets real semantic dedup.
    const EMBED_INPUT_BUDGET = 30_000; // mirror embeddings.ts MAX_CHARS
    const hugeContent = "duplication prone corpus prose ".repeat(3000); // ~93 KB
    const cand = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:oversized-embed",
      content: hugeContent,
    });
    // No verbatim lexical hit (unrelated corpus prose) so it survives to the
    // semantic layer.
    const { client } = clientReturning([
      verbatimHit("A completely unrelated note about billing webhooks."),
    ]);

    let embeddedText = "";
    const embed = vi.fn(async (text: string) => {
      embeddedText = text;
      if (text.length > EMBED_INPUT_BUDGET) {
        throw new Error("400 input exceeds max tokens for this model");
      }
      return [0.1, 0.2, 0.3];
    });
    const vectorSearch = vectorSearchReturning(0.95);
    const distillDelta = vi.fn(async () => ({ kind: "no-overlap" as const }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const out = await dedupAgainstRagCorpus([cand], {
      client,
      embed,
      vectorSearch,
      distillDelta,
    });

    expect(out).toHaveLength(1);
    expect(embed).toHaveBeenCalledTimes(1);
    // The load-bearing assertions: the embed input was TRUNCATED to the budget
    // (not the full ~93 KB body), so the seam did NOT throw…
    expect(embeddedText.length).toBeLessThanOrEqual(EMBED_INPUT_BUDGET);
    expect(embeddedText.length).toBeLessThan(hugeContent.length);
    // …and the candidate got REAL semantic dedup (vector oracle reached +
    // overlap annotated), NOT a swallowed semantic failure.
    expect(vectorSearch).toHaveBeenCalledTimes(1);
    expect(out[0].provenance.validated_against).toContain(
      "rag-corpus-overlap:",
    );
    const warned = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(warned).not.toContain("semanticFailed=1");
    vi.restoreAllMocks();
  });

  it("passes through when the semantic hit is BELOW the cosine threshold (genuinely novel)", async () => {
    const cand = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:novel-semantic",
      title: "Legacy app compatibility via a relay adapter",
      content: PARAPHRASE,
    });
    const { client } = clientReturning([verbatimHit(CORPUS_PASSAGE)]);
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);
    // A weak cosine (0.4) — below DEFAULT_MIN_SEMANTIC_OVERLAP — is NOT overlap.
    const vectorSearch = vectorSearchReturning(0.4);
    const distillDelta = vi.fn(async () => ({ kind: "no-overlap" as const }));

    const out = await dedupAgainstRagCorpus([cand], {
      client,
      embed,
      vectorSearch,
      distillDelta,
    });

    expect(out).toHaveLength(1);
    // Embedded + probed, but the weak hit is not overlap → distill NOT invoked.
    expect(embed).toHaveBeenCalledTimes(1);
    expect(vectorSearch).toHaveBeenCalledTimes(1);
    expect(distillDelta).not.toHaveBeenCalled();
    expect(out[0].content).toBe(PARAPHRASE);
    expect(out[0].provenance.validated_against).toBeUndefined();
  });

  // ── STRUCTURAL fix (1): semantic SILENT-DEGRADE detection ──────────────────
  //
  // A vectorSearch that returns `[]` for EVERY candidate (index empty or
  // misconfigured, not throwing) means ZERO effective semantic dedup — but the
  // per-candidate path treats "no hits" as "genuinely net-new" and passes it
  // through, so `semanticFailed` stays 0 and no warning fires. The gate reports
  // a clean run while the semantic layer was in fact a no-op for the whole
  // batch. This is the semantic parallel of the lexical probe-failure streak,
  // and it must be surfaced so the header's "never silently disabled" holds for
  // the semantic path too.
  it("WARNS a run-level semantic-degraded condition when vectorSearch returns ZERO hits for EVERY semantically-probed candidate (silent-degrade)", async () => {
    // Two candidates that both SURVIVE the lexical pre-filter (unrelated corpus
    // hit) and reach the semantic layer. The vector index is empty/misconfigured
    // so it returns [] for both — zero effective semantic dedup, but no throw.
    const candA = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:degrade-a",
      title: "Legacy app compatibility via a relay adapter",
      content: PARAPHRASE,
    });
    const candB = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:degrade-b",
      title: "A different novel claim entirely about telemetry batching",
      content:
        "The batcher coalesces telemetry frames on a fixed interval to bound " +
        "write amplification against the metrics store under bursty load.",
    });
    const { client } = clientReturning([
      verbatimHit("A completely unrelated note about billing webhooks."),
    ]);
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);
    // The degraded condition: the index returns ZERO hits for every candidate
    // (empty/misconfigured index) WITHOUT throwing.
    const vectorSearch = vi.fn(async () => []);
    const distillDelta = vi.fn(async () => ({ kind: "no-overlap" as const }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const out = await dedupAgainstRagCorpus([candA, candB], {
      client,
      embed,
      vectorSearch,
      distillDelta,
    });

    // Never drops; both ride through un-annotated (no hits to annotate against).
    expect(out).toHaveLength(2);
    // The semantic layer WAS engaged for both (embed + vectorSearch reached).
    expect(embed).toHaveBeenCalledTimes(2);
    expect(vectorSearch).toHaveBeenCalledTimes(2);
    // The load-bearing assertion: the degraded run is SURFACED, not silent.
    const warned = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(warned).toContain("semantic dedup degraded");
    expect(warned).toContain("0 hits");
    vi.restoreAllMocks();
  });

  it("does NOT warn semantic-degraded when at least one semantically-probed candidate got a hit", async () => {
    // Guard against a false-positive: if any semantically-probed candidate got a
    // real hit, the layer is functioning — no degraded warning.
    const candHit = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:has-hit",
      title: "Legacy app compatibility via a relay adapter",
      content: PARAPHRASE,
    });
    const candNoHit = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:no-hit",
      title: "Telemetry batching under bursty load",
      content:
        "The batcher coalesces telemetry frames on a fixed interval to bound " +
        "write amplification against the metrics store under bursty load.",
    });
    const { client } = clientReturning([
      verbatimHit("A completely unrelated note about billing webhooks."),
    ]);
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);
    // First candidate gets a real hit; second gets none. Not fully degraded.
    let call = 0;
    const vectorSearch = vi.fn(async () => {
      call++;
      return call === 1
        ? [
            {
              similarity: 0.95,
              content: CORPUS_PASSAGE,
              id: 7,
              title: "Indexed passage",
              sourceUrl: "https://example.test/corpus/shim",
              sourceName: "docs",
            },
          ]
        : [];
    });
    const distillDelta = vi.fn(async () => ({ kind: "no-overlap" as const }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await dedupAgainstRagCorpus([candHit, candNoHit], {
      client,
      embed,
      vectorSearch,
      distillDelta,
    });

    const warned = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(warned).not.toContain("semantic dedup degraded");
    vi.restoreAllMocks();
  });

  // ── STRUCTURAL fix (2): CJK coverage metric ────────────────────────────────
  //
  // Candidates routed to resolveSemantic via the sub-token-floor CJK path are
  // counted in NEITHER probeable NOR probesSkipped, so an all-CJK healthy run
  // (semantic layer working, everything annotated) emits NO run-level coverage
  // line at all — the operator sees nothing, and "coverage is always visible"
  // fails. Semantic-routed candidates must be counted so a coverage line always
  // fires when the semantic layer did work.
  it("emits a run-level coverage line for an all-CJK healthy run (semantic-routed candidates are counted)", async () => {
    const cjk = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:cjk-coverage",
      title: "実行環境の互換シム",
      content:
        "候補の重複検出は照合対象の本文全体で行う必要がある実行環境は互換シムを保持する",
    });
    // No lexical hit — the CJK candidate is routed straight to the semantic path.
    const { client } = clientReturning([]);
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);
    // Healthy semantic layer: a real overlap hit (so this is NOT the degraded
    // path — the coverage line must fire on a clean semantic run too).
    const vectorSearch = vectorSearchReturning(0.95);
    const distillDelta = vi.fn(async () => ({ kind: "no-overlap" as const }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const out = await dedupAgainstRagCorpus([cjk], {
      client,
      embed,
      vectorSearch,
      distillDelta,
    });

    expect(out).toHaveLength(1);
    // The load-bearing assertion: a coverage line was emitted for this all-CJK
    // healthy run, counting the semantic-routed candidate (previously silent).
    const warned = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(warned).toContain("semanticProbed=1");
    vi.restoreAllMocks();
  });

  // ── STRUCTURAL fix (3): overlapRef carrier sanitize ────────────────────────
  //
  // overlapRef/annotateOverlap fold the ref into the "; "-joined
  // validated_against carrier WITHOUT sanitizing it (asymmetric with the
  // distillation-gate's sanitizeCarrierText). A ref containing the "; " carrier
  // delimiter (e.g. a pathological source URL with a literal "; " in a query
  // string) fragments the marker across two split segments and defeats the
  // whole-token idempotency check — a re-run appends a duplicate on the next run
  // and the validate reader mis-parses the carrier. The ref must be sanitized
  // before folding (mirroring distillation-gate).
  it("SANITIZES an overlap ref containing the '; ' carrier delimiter before folding it into validated_against", async () => {
    const cand = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:pathological-ref",
    });
    // A corpus hit whose sourceUrl carries a literal "; " — overlapRef prefers
    // sourceUrl, so the marker would embed the delimiter verbatim.
    const evilHit: SearchHit = {
      id: 1,
      content: cand.content, // verbatim overlap → marked
      title: "Already-indexed corpus passage",
      sourceUrl: "https://example.test/corpus?a=1; b=2",
      sourceName: "docs",
      score: 0.98,
    };
    const { client } = clientReturning([evilHit]);

    const out = await dedupAgainstRagCorpus([cand], { client });

    expect(out).toHaveLength(1);
    const carrier = out[0].provenance.validated_against ?? "";
    // The marker must be ONE whole "; "-safe token: splitting on the carrier
    // delimiter must yield exactly ONE segment (the marker did not fragment).
    const segments = carrier.split("; ").filter((s) => s.length > 0);
    expect(segments).toHaveLength(1);
    // And the surviving token is still the recognizable overlap marker.
    expect(segments[0]).toContain("rag-corpus-overlap:");

    // Re-run is idempotent: a fragmented carrier would fail the whole-token
    // idempotency check and append a DUPLICATE on the second pass. With a
    // sanitized (non-fragmenting) marker the re-run is a true no-op.
    const rerun = await dedupAgainstRagCorpus([out[0]], { client });
    const rerunSegments = (rerun[0].provenance.validated_against ?? "")
      .split("; ")
      .filter((s) => s.length > 0);
    expect(rerunSegments).toHaveLength(1);
    expect(
      rerun[0].evidence.filter((e) => e.kind === "fused_from"),
    ).toHaveLength(1);
  });

  // ── F4: the LEXICAL verbatim path must DISTILL-TO-DELTA / FLOOR, not mark-only ──
  //
  // §6.2 and the module header state that on EITHER kind of overlap the gate
  // DISTILLS-TO-DELTA (a no-delta corpus duplicate is floored approvable=false).
  // A VERBATIM corpus duplicate is the STRONGEST possible duplicate — yet the OLD
  // lexical pre-filter path was mark-only: it annotated the overlap and returned,
  // SKIPPING the distill/floor the semantic path applies. So a verbatim duplicate
  // stayed FULLY APPROVABLE with full content while a WEAKER semantic paraphrase
  // (same corpus passage) got floored. That directly contradicts the spec. When
  // the distill seam is wired, the verbatim path must route through the SAME
  // distill-to-delta / floor seam (WITHOUT re-embedding — the lexical hit already
  // IS the confirmed overlap). No-delta ⇒ approvable=false, content untouched.
  it("F4 GREEN: a VERBATIM corpus duplicate with a no-delta verdict is FLOORED like a semantic one (not left approvable)", async () => {
    const mock = new LLMockCtor({ port: 0, logLevel: "silent" });
    mock.addFixture({
      match: {
        systemMessage: "knowledge-DELTA distiller",
        userMessage: CORPUS_PASSAGE,
      },
      response: {
        content: JSON.stringify({
          verdict: "no-delta",
          reason: "verbatim corpus duplicate — nothing net-new to seed",
        }),
      },
    });
    await mock.start();
    try {
      const distiller = new OpenAIDistillerCtor({
        baseURL: `${mock.url}/v1`,
        apiKey: "mock",
      });
      // A candidate whose content is a VERBATIM copy of the indexed corpus
      // passage → the lexical pre-filter short-circuits (containment ≥ 0.8).
      const cand = makeCandidate({
        canonical_key: "github-pr:cpk-runtime:verbatim-floor",
        content: CORPUS_PASSAGE,
      });
      const { client } = clientReturning([verbatimHit(CORPUS_PASSAGE)]);
      // The semantic seams ARE wired. The verbatim path must NOT re-embed (the
      // lexical hit already confirmed the overlap), but it MUST distill-to-delta.
      const embed = vi.fn(async (t: string) => distiller.embed(t));
      const vectorSearch = vi.fn(async () => []);

      const out = await dedupAgainstRagCorpus([cand], {
        client,
        embed,
        vectorSearch,
        distillDelta: (c, overlaps) =>
          distiller.distillDelta({
            title: c.title,
            content: c.content,
            overlaps: overlaps.map((h) => ({ content: h.content })),
          }),
      });

      expect(out).toHaveLength(1); // NEVER dropped
      // The load-bearing F4 assertion: a VERBATIM duplicate with no net-new
      // delta is FLOORED approvable=false — exactly like the semantic no-delta
      // case — NOT left fully approvable as the old mark-only path did.
      expect(out[0].approvable).toBe(false);
      // The DEDICATED no-delta floor marker is stamped on BOTH carriers so the
      // downstream validation gate keeps the duplicate non-approvable.
      expect(out[0].provenance.validated_against).toContain(
        RAG_NO_DELTA_MARKER,
      );
      expect(
        out[0].evidence.some(
          (e) => e.kind === "fused_from" && e.ref === RAG_NO_DELTA_MARKER,
        ),
      ).toBe(true);
      // Content untouched (no-delta) and the overlap still annotated.
      expect(out[0].content).toBe(CORPUS_PASSAGE);
      expect(out[0].provenance.validated_against).toContain(
        "rag-corpus-overlap:",
      );
      // The verbatim short-circuit is preserved: no re-embed / re-vector-search
      // (the lexical hit already IS the confirmed overlap).
      expect(embed).not.toHaveBeenCalled();
      expect(vectorSearch).not.toHaveBeenCalled();
      expect(() => CandidateSchema.parse(out[0])).not.toThrow();
    } finally {
      await mock.stop();
    }
  });

  it("F4 GREEN: a VERBATIM duplicate with a net-new delta adopts the delta content and stays approvable", async () => {
    const mock = new LLMockCtor({ port: 0, logLevel: "silent" });
    const DELTA_MARKER_F4 = "VERBATIM-DELTA-WINDOW";
    const VERBATIM_DELTA_CONTENT =
      `${DELTA_MARKER_F4}: the shim additionally emits a deprecation counter ` +
      "the v2 engine does not, so operators can watch v1 traffic wind down.";
    mock.addFixture({
      match: {
        systemMessage: "knowledge-DELTA distiller",
        userMessage: CORPUS_PASSAGE,
      },
      response: {
        content: JSON.stringify({
          verdict: "delta",
          reason: "the deprecation counter is genuinely net-new",
          content: VERBATIM_DELTA_CONTENT,
        }),
      },
    });
    await mock.start();
    try {
      const distiller = new OpenAIDistillerCtor({
        baseURL: `${mock.url}/v1`,
        apiKey: "mock",
      });
      const cand = makeCandidate({
        canonical_key: "github-pr:cpk-runtime:verbatim-delta",
        content: CORPUS_PASSAGE,
      });
      const { client } = clientReturning([verbatimHit(CORPUS_PASSAGE)]);

      const out = await dedupAgainstRagCorpus([cand], {
        client,
        embed: (t) => distiller.embed(t),
        vectorSearch: vi.fn(async () => []),
        distillDelta: (c, overlaps) =>
          distiller.distillDelta({
            title: c.title,
            content: c.content,
            overlaps: overlaps.map((h) => ({ content: h.content })),
          }),
      });

      expect(out).toHaveLength(1);
      // Delta rewrite adopted; still approvable (net-new remains).
      expect(out[0].content).toBe(VERBATIM_DELTA_CONTENT);
      expect(out[0].approvable).toBe(true);
      expect(out[0].provenance.validated_against).toContain(
        "rag-corpus-overlap:",
      );
      expect(() => CandidateSchema.parse(out[0])).not.toThrow();
    } finally {
      await mock.stop();
    }
  });
});
