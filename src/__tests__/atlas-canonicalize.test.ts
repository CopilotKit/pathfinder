import { describe, it, expect } from "vitest";
import {
  CANONICAL_KEY_PREFIX,
  canonicalize,
  claimSlug,
  recomputeRankScore,
} from "../atlas/canonicalize.js";
import {
  BEHAVIOR_KNOWLEDGE_TYPES,
  CandidateSchema,
  parseCanonicalKey,
  RAG_NO_DELTA_MARKER,
} from "../atlas/types.js";
import type {
  CandidateFragment,
  Classification,
  ValidationStatus,
  KnowledgeType,
  Confidence,
} from "../atlas/types.js";

// ── Fragment builder ──────────────────────────────────────────────────────────
// A minimal, valid CandidateFragment with overridable fields, so each test
// states only the dimensions it exercises (sourcetype/subsystem/title/date/
// validation_status/confidence/knowledge_type/evidence).

interface FragmentOverrides {
  sourcetype?: CandidateFragment["sourcetype"];
  subsystem?: string;
  claimSlugHint?: string;
  title?: string;
  content?: string;
  date?: string;
  validation_status?: ValidationStatus;
  knowledge_type?: KnowledgeType;
  confidence?: Confidence;
  provenance_class?: Classification["provenance_class"];
  evidence?: CandidateFragment["evidence"];
}

function makeFragment(o: FragmentOverrides = {}): CandidateFragment {
  const validation_status = o.validation_status ?? "source-verified";
  const knowledge_type = o.knowledge_type ?? "architecture";
  const confidence = o.confidence ?? "high";
  const date = o.date ?? "2026-06-08";
  return {
    sourcetype: o.sourcetype ?? "github-pr",
    subsystem: o.subsystem ?? "cpk-runtime",
    claimSlugHint: o.claimSlugHint,
    source_name: "github-pr",
    repo_url: "https://github.com/CopilotKit/CopilotKit",
    ref: "main",
    title: o.title ?? "Some distilled claim about the runtime",
    content: o.content ?? "why/how prose",
    provenance: {
      source: "github-pr",
      date,
      classification: {
        sensitivity: "internal",
        knowledge_type,
        audience: "all-staff",
        validation_status,
        confidence,
        provenance_class: o.provenance_class ?? "primary",
        freshness: { as_of: date },
      },
    },
    evidence: o.evidence ?? [],
    needsReview: false,
    validationTargets: [],
  };
}

describe("canonicalize — canonical_key assignment", () => {
  it("assigns canonical_key in <CANONICAL_KEY_PREFIX>:<subsystem>:<claim-slug> form (C.2)", () => {
    // The first segment is a STABLE constant (CANONICAL_KEY_PREFIX), NOT the
    // sourcetype — the canonical_key keys on claim identity (spec §C.2).
    const out = canonicalize([
      makeFragment({
        sourcetype: "github-pr",
        subsystem: "cpk-runtime",
        claimSlugHint: "two-layer-shim-to-v2-engine",
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].canonical_key).toBe(
      `${CANONICAL_KEY_PREFIX}:cpk-runtime:two-layer-shim-to-v2-engine`,
    );
    const parts = parseCanonicalKey(out[0].canonical_key);
    expect(parts.sourcetype).toBe(CANONICAL_KEY_PREFIX);
    expect(parts.subsystem).toBe("cpk-runtime");
    expect(parts.claimSlug).toBe("two-layer-shim-to-v2-engine");
  });

  it("derives the claim-slug from the title when claimSlugHint is absent", () => {
    const out = canonicalize([
      makeFragment({
        sourcetype: "notion-doc",
        subsystem: "agui-protocol",
        claimSlugHint: undefined,
        title: "Interrupt resume links via interruptId, NOT parentRunId!",
      }),
    ]);
    const parts = parseCanonicalKey(out[0].canonical_key);
    // First segment is the stable prefix, independent of the notion-doc source.
    expect(parts.sourcetype).toBe(CANONICAL_KEY_PREFIX);
    expect(parts.subsystem).toBe("agui-protocol");
    // Slug is lower-kebab, punctuation stripped, words joined by '-'.
    expect(parts.claimSlug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(parts.claimSlug).toContain("interrupt");
    expect(parts.claimSlug).toContain("resume");
    // No stray separator characters from the punctuation in the title.
    expect(parts.claimSlug).not.toContain(",");
    expect(parts.claimSlug).not.toContain("!");
    expect(parts.claimSlug).not.toContain(" ");
  });

  it("prefers claimSlugHint over the title when both are present", () => {
    const out = canonicalize([
      makeFragment({
        claimSlugHint: "explicit-hint-wins",
        title: "A totally different title that should be ignored",
      }),
    ]);
    expect(parseCanonicalKey(out[0].canonical_key).claimSlug).toBe(
      "explicit-hint-wins",
    );
  });

  it("produces output that validates against CandidateSchema", () => {
    const out = canonicalize([makeFragment()]);
    expect(() => CandidateSchema.parse(out[0])).not.toThrow();
    expect(typeof out[0].rankScore).toBe("number");
    expect(typeof out[0].approvable).toBe("boolean");
  });
});

describe("canonicalize — global dedup + supersession", () => {
  it("collapses two fragments at the same subsystem+claim into ONE candidate (newer supersedes by date)", () => {
    const older = makeFragment({
      subsystem: "agui-adk",
      claimSlugHint: "occ-concurrency-handling",
      date: "2026-01-01",
      content: "OLD rationale",
    });
    const newer = makeFragment({
      subsystem: "agui-adk",
      claimSlugHint: "occ-concurrency-handling",
      date: "2026-05-12",
      content: "NEW rationale",
    });
    const out = canonicalize([older, newer]);
    expect(out).toHaveLength(1);
    // The survivor is the SUPERSEDING (newer) fragment.
    expect(out[0].content).toBe("NEW rationale");
    expect(out[0].provenance.date).toBe("2026-05-12");
    expect(out[0].canonical_key).toBe(
      `${CANONICAL_KEY_PREFIX}:agui-adk:occ-concurrency-handling`,
    );
  });

  it("supersession is order-independent (newer wins even when listed first)", () => {
    const newer = makeFragment({
      subsystem: "agui-adk",
      claimSlugHint: "occ-concurrency-handling",
      date: "2026-05-12",
      content: "NEW rationale",
    });
    const older = makeFragment({
      subsystem: "agui-adk",
      claimSlugHint: "occ-concurrency-handling",
      date: "2026-01-01",
      content: "OLD rationale",
    });
    const out = canonicalize([newer, older]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("NEW rationale");
  });

  it("COLLAPSES fragments that differ ONLY in sourcetype (claim-identity keying, C.2)", () => {
    // C.2: the canonical_key keys on claim identity (subsystem + claim slug),
    // NOT the sourcetype prefix — so the SAME claim seen from two sources at the
    // same subsystem+claim now shares ONE canonical_key and collapses via
    // supersession. This is the deliberate cross-source-collision shift the C.2
    // slot owns (spec §C.2): the whole point is that a claim's identity does not
    // depend on which source it was harvested from. (Pre-C.2 these produced two
    // keys `github-pr:…` / `notion-doc:…`; now both key on claim identity.)
    const a = makeFragment({
      sourcetype: "github-pr",
      subsystem: "agui-adk",
      claimSlugHint: "occ-concurrency-handling",
      date: "2026-01-01",
      content: "from github",
    });
    const b = makeFragment({
      sourcetype: "notion-doc",
      subsystem: "agui-adk",
      claimSlugHint: "occ-concurrency-handling",
      date: "2026-05-12",
      content: "from notion",
    });
    const out = canonicalize([a, b]);
    expect(out).toHaveLength(1);
    // The survivor is the newer (superseding) fragment, regardless of source.
    expect(out[0].content).toBe("from notion");
  });

  it("does NOT collapse fragments that differ in subsystem or claim", () => {
    const out = canonicalize([
      makeFragment({ subsystem: "agui-adk", claimSlugHint: "claim-one" }),
      makeFragment({ subsystem: "agui-adk", claimSlugHint: "claim-two" }),
      makeFragment({ subsystem: "cpk-runtime", claimSlugHint: "claim-one" }),
    ]);
    expect(out).toHaveLength(3);
  });
});

describe("canonicalize — canonical_key is stable across solo→fused re-keying (C.2)", () => {
  it("a solo run and a later FUSED run for the same claim share ONE canonical_key", () => {
    // The bug (spec §C.2): run 1 harvests a claim SOLO (sourcetype `memory`) and
    // run 2 re-harvests it after it GAINS a fusing source (aggregate re-stamps
    // sourcetype `derived`). Pre-fix, canonicalize built the key from sourcetype,
    // so run 1 → `memory:<sub>:<slug>` and run 2 → `derived:<sub>:<slug>` never
    // collided at the DB upsert → run 2 added a NEW pending row instead of
    // superseding. Keying on claim identity (subsystem + claim slug) makes both
    // runs resolve to the SAME canonical_key.
    const [solo] = canonicalize([
      makeFragment({
        sourcetype: "memory",
        subsystem: "agui-protocol",
        claimSlugHint: "interrupt-resume-keying",
        date: "2026-06-01",
      }),
    ]);
    const [fused] = canonicalize([
      makeFragment({
        sourcetype: "derived",
        subsystem: "agui-protocol",
        claimSlugHint: "interrupt-resume-keying",
        date: "2026-06-02",
      }),
    ]);
    // Same claim identity → same canonical_key, so the upsert (ON CONFLICT
    // canonical_key) supersedes run 1 instead of inserting a duplicate.
    expect(solo.canonical_key).toBe(fused.canonical_key);
  });

  it("within one run, a solo and its fused twin for the same claim collapse to ONE row", () => {
    // The intra-run projection of the same invariant: a solo `memory` fragment
    // and a `derived` fused fragment for the same subsystem+claim now share a
    // key, so canonicalize emits ONE candidate (the newer supersedes) rather
    // than two rows that differ only by source prefix.
    const solo = makeFragment({
      sourcetype: "memory",
      subsystem: "agui-protocol",
      claimSlugHint: "interrupt-resume-keying",
      date: "2026-06-01",
      content: "SOLO",
    });
    const fused = makeFragment({
      sourcetype: "derived",
      subsystem: "agui-protocol",
      claimSlugHint: "interrupt-resume-keying",
      date: "2026-06-02",
      content: "FUSED",
    });
    const out = canonicalize([solo, fused]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("FUSED");
  });

  it("the canonical_key still round-trips through parseCanonicalKey (subsystem recoverable)", () => {
    // The key format stays 3-segment `<prefix>:<subsystem>:<claim-slug>` so
    // sync.ts's subsystem recovery (parseCanonicalKey) keeps working — only the
    // volatile sourcetype first segment is replaced by a stable constant.
    const [c] = canonicalize([
      makeFragment({
        sourcetype: "memory",
        subsystem: "agui-protocol",
        claimSlugHint: "interrupt-resume-keying",
      }),
    ]);
    const parts = parseCanonicalKey(c.canonical_key);
    expect(parts.subsystem).toBe("agui-protocol");
    expect(parts.claimSlug).toBe("interrupt-resume-keying");
  });
});

describe("canonicalize — NOTHING is silently dropped (count invariant)", () => {
  it("count out == count in minus exact same-key duplicates", () => {
    const fragments = [
      // group A: 3 fragments, same key → 1 survivor (2 dups removed)
      makeFragment({
        subsystem: "agui-adk",
        claimSlugHint: "a",
        date: "2026-01-01",
      }),
      makeFragment({
        subsystem: "agui-adk",
        claimSlugHint: "a",
        date: "2026-02-01",
      }),
      makeFragment({
        subsystem: "agui-adk",
        claimSlugHint: "a",
        date: "2026-03-01",
      }),
      // group B: 2 fragments, same key → 1 survivor (1 dup removed)
      makeFragment({
        subsystem: "cpk-runtime",
        claimSlugHint: "b",
        date: "2026-01-01",
      }),
      makeFragment({
        subsystem: "cpk-runtime",
        claimSlugHint: "b",
        date: "2026-02-01",
      }),
      // group C: 1 unique fragment
      makeFragment({ subsystem: "pathfinder-auth", claimSlugHint: "c" }),
    ];
    const exactDups = 2 + 1; // duplicates beyond the first per key
    const out = canonicalize(fragments);
    expect(out).toHaveLength(fragments.length - exactDups);
    expect(out).toHaveLength(3);
  });

  it("never drops a low-confidence or unverified candidate (only reorders)", () => {
    const fragments = [
      makeFragment({
        subsystem: "s1",
        claimSlugHint: "k1",
        confidence: "low",
        validation_status: "unverified",
        knowledge_type: "architecture",
      }),
      makeFragment({
        subsystem: "s2",
        claimSlugHint: "k2",
        confidence: "high",
        validation_status: "showcase-verified",
      }),
      makeFragment({
        subsystem: "s3",
        claimSlugHint: "k3",
        confidence: "medium",
        validation_status: "source-verified",
      }),
    ];
    const out = canonicalize(fragments);
    // All three distinct keys survive — ranking orders, it never machine-drops.
    expect(out).toHaveLength(3);
    expect(new Set(out.map((c) => c.canonical_key)).size).toBe(3);
  });

  it("returns an empty array for empty input", () => {
    expect(canonicalize([])).toEqual([]);
  });
});

describe("canonicalize — rank ordering", () => {
  it("orders showcase-verified / high-confidence candidates first", () => {
    const weak = makeFragment({
      subsystem: "s-weak",
      claimSlugHint: "weak",
      validation_status: "unverified",
      confidence: "low",
      knowledge_type: "operational",
    });
    const strong = makeFragment({
      subsystem: "s-strong",
      claimSlugHint: "strong",
      validation_status: "showcase-verified",
      confidence: "high",
    });
    const middle = makeFragment({
      subsystem: "s-mid",
      claimSlugHint: "mid",
      validation_status: "source-verified",
      confidence: "medium",
    });
    const out = canonicalize([weak, strong, middle]);
    expect(out).toHaveLength(3);
    // Strongest first, weakest last.
    expect(out[0].canonical_key).toContain("s-strong");
    expect(out[out.length - 1].canonical_key).toContain("s-weak");
    // rankScore is monotonically non-increasing across the output.
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].rankScore).toBeGreaterThanOrEqual(out[i].rankScore);
    }
  });

  it("ranks a showcase-verified candidate above a source-verified one, all else equal", () => {
    const showcase = makeFragment({
      subsystem: "s",
      claimSlugHint: "showcase",
      validation_status: "showcase-verified",
    });
    const source = makeFragment({
      subsystem: "s",
      claimSlugHint: "source",
      validation_status: "source-verified",
    });
    const out = canonicalize([source, showcase]);
    const showcaseRow = out.find((c) => c.canonical_key.includes("showcase"))!;
    const sourceRow = out.find((c) => c.canonical_key.includes("source"))!;
    expect(showcaseRow.rankScore).toBeGreaterThan(sourceRow.rankScore);
  });

  it("ranks deeper evidence higher, all else equal", () => {
    const deep = makeFragment({
      subsystem: "s",
      claimSlugHint: "deep",
      evidence: [
        { kind: "changed_file", path: "a.ts" },
        { kind: "changed_file", path: "b.ts" },
        { kind: "linked_issue", url: "issues/1" },
      ],
    });
    const shallow = makeFragment({
      subsystem: "s",
      claimSlugHint: "shallow",
      evidence: [],
    });
    const out = canonicalize([shallow, deep]);
    const deepRow = out.find((c) => c.canonical_key.includes("deep"))!;
    const shallowRow = out.find((c) => c.canonical_key.includes("shallow"))!;
    expect(deepRow.rankScore).toBeGreaterThan(shallowRow.rankScore);
  });

  it("a rag-corpus-overlap fused_from mark is rank-NEUTRAL; a genuine fused_from still deepens evidence", () => {
    // The §6.2 dedup gate appends a fused_from evidence item whose ref carries
    // the rag-corpus-overlap: prefix. That item is an audit annotation about
    // the CORPUS, not corroboration for the claim — counting it would make a
    // corpus duplicate outrank its un-duplicated twin (the §6.2 inversion).
    const marked = makeFragment({
      subsystem: "s",
      claimSlugHint: "marked",
      evidence: [
        {
          kind: "fused_from",
          ref: "rag-corpus-overlap:https://docs.example.com/runtime",
        },
      ],
    });
    const bare = makeFragment({
      subsystem: "s",
      claimSlugHint: "bare",
      evidence: [],
    });
    // A GENUINE fused_from (aggregator provenance — a canonical-key-shaped ref)
    // is real corroboration and must keep counting toward evidence depth.
    const genuine = makeFragment({
      subsystem: "s",
      claimSlugHint: "genuine",
      evidence: [{ kind: "fused_from", ref: "source-comment:s:resume-keying" }],
    });
    const out = canonicalize([marked, bare, genuine]);
    const row = (slug: string) =>
      out.find((c) => c.canonical_key.endsWith(`:${slug}`))!;
    expect(row("marked").rankScore).toBe(row("bare").rankScore);
    expect(row("genuine").rankScore).toBeGreaterThan(row("bare").rankScore);
  });

  it("a rag-dedup no-delta floor marker is rank-NEUTRAL (does not inflate evidence depth)", () => {
    // The §6.2 no-delta gate stamps the RAG_NO_DELTA_MARKER floor as a fused_from
    // evidence ref on a pure corpus DUPLICATE. That marker is a provenance floor
    // trace, NOT corroboration for the claim — counting it would inflate the
    // duplicate's rankScore so it OUT-RANKS its un-duplicated twin (the §6.2 rank
    // inversion). It must be excluded from the evidence-depth count exactly like
    // the rag-corpus-overlap: prefix already is.
    const floored = makeFragment({
      subsystem: "s",
      claimSlugHint: "floored",
      evidence: [{ kind: "fused_from", ref: RAG_NO_DELTA_MARKER }],
    });
    const bare = makeFragment({
      subsystem: "s",
      claimSlugHint: "bare-nd",
      evidence: [],
    });
    const out = canonicalize([floored, bare]);
    const row = (slug: string) =>
      out.find((c) => c.canonical_key.endsWith(`:${slug}`))!;
    // The floor marker must NOT count: the floored duplicate ties its bare twin.
    expect(row("floored").rankScore).toBe(row("bare-nd").rankScore);
  });

  it("ranks a more recent fact higher, all else equal", () => {
    const recent = makeFragment({
      subsystem: "s",
      claimSlugHint: "recent",
      date: "2026-06-01",
    });
    const old = makeFragment({
      subsystem: "s",
      claimSlugHint: "old",
      date: "2020-01-01",
    });
    const out = canonicalize([old, recent]);
    const recentRow = out.find((c) => c.canonical_key.includes("recent"))!;
    const oldRow = out.find((c) => c.canonical_key.includes("old"))!;
    expect(recentRow.rankScore).toBeGreaterThan(oldRow.rankScore);
  });
});

describe("canonicalize — deterministic ordering on rankScore ties", () => {
  it("breaks rankScore ties by canonical_key (stable, engine-independent)", () => {
    // Three fragments that are identical on every rankScore input (same source
    // strength, recency, evidence depth, validation, confidence) but differ in
    // claim slug → identical rankScore, distinct canonical_key. The output MUST
    // be ordered by canonical_key so it is deterministic across engines.
    const fragments = [
      makeFragment({ subsystem: "s", claimSlugHint: "charlie" }),
      makeFragment({ subsystem: "s", claimSlugHint: "alpha" }),
      makeFragment({ subsystem: "s", claimSlugHint: "bravo" }),
    ];
    const out = canonicalize(fragments);
    expect(out).toHaveLength(3);
    // All tie on rankScore.
    expect(new Set(out.map((c) => c.rankScore)).size).toBe(1);
    // Tiebreak is canonical_key ascending.
    expect(out.map((c) => c.canonical_key)).toEqual([
      `${CANONICAL_KEY_PREFIX}:s:alpha`,
      `${CANONICAL_KEY_PREFIX}:s:bravo`,
      `${CANONICAL_KEY_PREFIX}:s:charlie`,
    ]);
  });
});

describe("canonicalize — recency uses the shared date normalizer", () => {
  it("treats two distinct unparseable-dated facts identically (shared mid-weight)", () => {
    // Both route through dateToEpochMs (=== NEGATIVE_INFINITY), so they take the
    // same neutral mid-weight recency and — all else equal — the same rankScore.
    // (Pre-fix, recency used its own Date.parse + NaN check; this asserts the two
    //  date consumers now share ONE normalizer and agree on the undated weight.)
    const garbageA = makeFragment({
      subsystem: "s",
      claimSlugHint: "garbage-a",
      date: "not-a-real-date",
    });
    const garbageB = makeFragment({
      subsystem: "s",
      claimSlugHint: "garbage-b",
      date: "also-not-a-date",
    });
    const out = canonicalize([garbageA, garbageB]);
    const rowA = out.find((c) => c.canonical_key.includes("garbage-a"))!;
    const rowB = out.find((c) => c.canonical_key.includes("garbage-b"))!;
    expect(rowA.rankScore).toBe(rowB.rankScore);
  });

  it("ranks a dated fact above an unparseable-dated one (undated normalizes oldest)", () => {
    // dateToEpochMs maps an unparseable date to the neutral mid-weight, while a
    // real recent date scores ~1 (> 0.5), so the dated fact ranks strictly higher.
    const dated = makeFragment({
      subsystem: "s",
      claimSlugHint: "dated",
      date: "2026-06-08",
    });
    const unparseable = makeFragment({
      subsystem: "s",
      claimSlugHint: "unparseable",
      date: "garbage",
    });
    const out = canonicalize([dated, unparseable]);
    const datedRow = out.find((c) => c.canonical_key.includes("dated"))!;
    const unparseableRow = out.find((c) =>
      c.canonical_key.includes("unparseable"),
    )!;
    expect(datedRow.rankScore).toBeGreaterThan(unparseableRow.rankScore);
  });
});

describe("canonicalize — supersession agrees across mixed date shapes", () => {
  it("a full-ISO date supersedes an earlier date-only date at the same key", () => {
    // Same calendar day, but the ISO timestamp is strictly later than midnight
    // of the date-only fragment. The numeric comparator must pick the ISO one.
    const dateOnly = makeFragment({
      subsystem: "agui-adk",
      claimSlugHint: "occ",
      date: "2026-06-09",
      content: "DATE-ONLY",
    });
    const fullIso = makeFragment({
      subsystem: "agui-adk",
      claimSlugHint: "occ",
      date: "2026-06-09T12:00:00Z",
      content: "FULL-ISO",
    });
    const out = canonicalize([dateOnly, fullIso]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("FULL-ISO");
  });
});

describe("canonicalize — punctuation-only titles get a stable hash-fallback slug", () => {
  it("two punctuation-only-titled fragments in one subsystem do NOT collapse", () => {
    // Both titles slug to "" under the naive normalizer, so the two DISTINCT
    // claims would share `<sourcetype>:<subsystem>:` and one would be silently
    // dropped via supersession — violating the "nothing is silently dropped"
    // invariant. The hash fallback keeps them distinct.
    const a = makeFragment({
      claimSlugHint: undefined,
      title: "!!!",
      content: "claim A prose",
    });
    const b = makeFragment({
      claimSlugHint: undefined,
      title: "???",
      content: "claim B prose",
    });
    const out = canonicalize([a, b]);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((c) => c.canonical_key)).size).toBe(2);
    for (const c of out) {
      // The claim segment is never empty.
      expect(parseCanonicalKey(c.canonical_key).claimSlug).not.toBe("");
    }
  });

  it("the fallback is stable: the SAME punctuation-only title still collapses", () => {
    const older = makeFragment({
      claimSlugHint: undefined,
      title: "!!!",
      date: "2026-01-01",
      content: "OLD",
    });
    const newer = makeFragment({
      claimSlugHint: undefined,
      title: "!!!",
      date: "2026-05-12",
      content: "NEW",
    });
    const out = canonicalize([older, newer]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("NEW");
  });
});

describe("claimSlug — non-ASCII letter-bearing residue gets a djb2 discriminator (fix11)", () => {
  it("two claims distinguished ONLY by CJK words do NOT share a slug", () => {
    // The naive ASCII slug strips the CJK words — the distinguishing claim
    // semantics — so both titles would collapse to "fix-the-bug": same cluster
    // key (spurious fuse in aggregate) AND same canonical_key (silent
    // supersession in canonicalize). The djb2 discriminator keeps them apart.
    expect(claimSlug("Fix the 缓存 bug")).not.toBe(
      claimSlug("Fix the 排序 bug"),
    );
  });

  it("keeps the readable ASCII residue as the slug prefix, hash appended", () => {
    expect(claimSlug("Fix the 缓存 bug")).toMatch(/^fix-the-bug-[a-z0-9]+$/);
  });

  it("is deterministic (cross-run and cross-tier stable)", () => {
    expect(claimSlug("Fix the 缓存 bug")).toBe(claimSlug("Fix the 缓存 bug"));
  });

  it("emoji decoration does NOT trigger the discriminator (decoration is not claim semantics)", () => {
    // 🚀 is a symbol, not a letter/digit — stripping it loses nothing, so the
    // decorated title must still fuse with its bare twin.
    expect(claimSlug("Fix cache 🚀")).toBe("fix-cache");
    expect(claimSlug("Fix cache 🚀")).toBe(claimSlug("Fix cache"));
  });

  it("pure-ASCII slugs are byte-unchanged", () => {
    expect(
      claimSlug("Interrupt resume links via interruptId, NOT parentRunId!"),
    ).toBe("interrupt-resume-links-via-interruptid-not-parentrunid");
    expect(claimSlug("two-layer-shim-to-v2-engine")).toBe(
      "two-layer-shim-to-v2-engine",
    );
  });

  it("a fully-non-ASCII claim still gets the bare hash fallback (empty residue, as before)", () => {
    expect(claimSlug("缓存")).toMatch(/^[a-z0-9]+$/);
    expect(claimSlug("缓存")).not.toBe(claimSlug("排序"));
  });

  it("two CJK-distinguished titles do NOT collapse via supersession in canonicalize", () => {
    const out = canonicalize([
      makeFragment({
        claimSlugHint: undefined,
        title: "Fix the 缓存 bug",
        content: "claim A prose",
      }),
      makeFragment({
        claimSlugHint: undefined,
        title: "Fix the 排序 bug",
        content: "claim B prose",
      }),
    ]);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((c) => c.canonical_key)).size).toBe(2);
  });
});

describe("claimSlug — the djb2 discriminator hashes NORMALIZED semantics, not raw bytes (fix12)", () => {
  it("case variants of the same CJK-bearing claim share ONE slug (and keep fusing)", () => {
    // github's decapitalize heuristic vs notion's verbatim title produce
    // exactly this variance: same claim, different case. Case is not claim
    // semantics — a raw-input hash would split them into two slugs (duplicate
    // pending rows instead of fusing).
    expect(claimSlug("Fix the 缓存 bug")).toBe(claimSlug("fix the 缓存 bug"));
  });

  it("emoji decoration on a CJK-bearing claim does not change the slug", () => {
    // Decoration is not claim semantics either — the decorated variant must
    // hash (and slug) identically to its bare twin.
    expect(claimSlug("Fix the 缓存 bug")).toBe(
      claimSlug("Fix the 缓存 bug 🚀"),
    );
  });

  it("CJK-DISTINGUISHED claims still get distinct slugs (fix11 pin)", () => {
    expect(claimSlug("Fix the 缓存 bug")).not.toBe(
      claimSlug("Fix the 排序 bug"),
    );
  });

  it("decoration without lost semantics still takes the slug-only path (fix11 pin)", () => {
    expect(claimSlug("Fix cache 🚀")).toBe("fix-cache");
  });

  it("pure-ASCII slug output is byte-stable (never takes the hash path)", () => {
    expect(
      claimSlug("Interrupt resume links via interruptId, NOT parentRunId!"),
    ).toBe("interrupt-resume-links-via-interruptid-not-parentrunid");
    expect(claimSlug("two-layer-shim-to-v2-engine")).toBe(
      "two-layer-shim-to-v2-engine",
    );
  });

  it("DISTINCT punctuation-only claims still get distinct fallback slugs (fix5 pin)", () => {
    // A punctuation-only input has NO letters/digits — the normalized
    // projection is empty, so there are no semantics to capture; the fallback
    // hash must still keep distinct degenerate claims apart.
    expect(claimSlug("!!!")).not.toBe(claimSlug("???"));
  });
});

describe("canonicalize — approvable (binding validation gate)", () => {
  it("marks an UNVERIFIED architecture fact as NOT approvable", () => {
    const out = canonicalize([
      makeFragment({
        knowledge_type: "architecture",
        validation_status: "unverified",
      }),
    ]);
    expect(out[0].approvable).toBe(false);
  });

  it("marks an UNVERIFIED design-rationale fact as NOT approvable", () => {
    const out = canonicalize([
      makeFragment({
        knowledge_type: "design-rationale",
        validation_status: "unverified",
      }),
    ]);
    expect(out[0].approvable).toBe(false);
  });

  it("marks a SOURCE-VERIFIED architecture fact as approvable", () => {
    const out = canonicalize([
      makeFragment({
        knowledge_type: "architecture",
        validation_status: "source-verified",
      }),
    ]);
    expect(out[0].approvable).toBe(true);
  });

  it("marks an UNVERIFIED non-behavior fact (operational) as approvable (gate is behavior/arch only)", () => {
    const out = canonicalize([
      makeFragment({
        knowledge_type: "operational",
        validation_status: "unverified",
      }),
    ]);
    expect(out[0].approvable).toBe(true);
  });

  it("does NOT drop a not-approvable candidate — it stays in the output", () => {
    const out = canonicalize([
      makeFragment({
        subsystem: "s",
        claimSlugHint: "unverified-arch",
        knowledge_type: "architecture",
        validation_status: "unverified",
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].approvable).toBe(false);
  });
});

describe("canonicalize — empty-string claimSlugHint falls back to the title (fix6)", () => {
  it("two empty-hint fragments with distinct titles get DISTINCT canonical keys", () => {
    // The schema admits claimSlugHint: "" (z.string().optional(), no .min), so a
    // nullish (??) fallback keeps "" and claimSlug("") hashes EVERY empty-hint
    // fragment to the SAME constant djb2 slug ("45h") — unrelated claims collapse
    // to one canonical_key and one is silently superseded. The fallback must be
    // truthy so an empty hint routes to the title like an absent one.
    const a = makeFragment({
      claimSlugHint: "",
      title: "Runtime engine uses a two-layer shim",
      content: "claim A prose",
    });
    const b = makeFragment({
      claimSlugHint: "",
      title: "Railway deploys retry with backoff",
      content: "claim B prose",
    });
    const out = canonicalize([a, b]);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((c) => c.canonical_key)).size).toBe(2);
    for (const c of out) {
      // Neither key carries the degenerate djb2("") slug.
      expect(parseCanonicalKey(c.canonical_key).claimSlug).not.toBe("45h");
    }
  });

  it("an empty hint behaves exactly like an absent hint (title-derived slug)", () => {
    const [fromEmpty] = canonicalize([makeFragment({ claimSlugHint: "" })]);
    const [fromAbsent] = canonicalize([
      makeFragment({ claimSlugHint: undefined }),
    ]);
    expect(fromEmpty.canonical_key).toBe(fromAbsent.canonical_key);
  });
});

describe("recomputeRankScore — re-scores a candidate after post-canonicalize mutation (fix6)", () => {
  it("a validate-promoted candidate gets a strictly higher rankScore (pure, input unmutated)", () => {
    // validation_status is the DOMINANT rank weight (3× unverified). A consumer
    // that promotes it after canonicalize assigned the score (e.g. the validate
    // step) must be able to recompute, or the review queue sorts by the stale
    // value while the badge shows the promoted status (§11.1 ordering).
    const [candidate] = canonicalize([
      makeFragment({
        validation_status: "unverified",
        knowledge_type: "operational",
      }),
    ]);
    const promoted = {
      ...candidate,
      provenance: {
        ...candidate.provenance,
        classification: {
          ...candidate.provenance.classification,
          validation_status: "showcase-verified" as const,
        },
      },
    };
    const rescored = recomputeRankScore(promoted, Date.now());
    expect(rescored.rankScore).toBeGreaterThan(candidate.rankScore);
    // Pure: the input candidate is not mutated.
    expect(promoted.rankScore).toBe(candidate.rankScore);
    // Everything except rankScore carries through unchanged.
    expect(rescored.canonical_key).toBe(candidate.canonical_key);
    expect(rescored.provenance.classification.validation_status).toBe(
      "showcase-verified",
    );
  });

  it("defaults `now` to the current time", () => {
    const [candidate] = canonicalize([makeFragment()]);
    const rescored = recomputeRankScore(candidate);
    expect(typeof rescored.rankScore).toBe("number");
    expect(rescored.rankScore).toBeGreaterThan(0);
  });
});

describe("canonicalize — purity", () => {
  it("is a pure function (does not mutate its input array or fragments)", () => {
    const fragments = [
      // No claimSlugHint override — the builder leaves the key PRESENT with
      // value undefined, the exact shape a JSON snapshot cannot represent.
      makeFragment({ subsystem: "s", title: "Claim one" }),
      makeFragment({
        subsystem: "s",
        claimSlugHint: "two",
        evidence: [{ kind: "changed_file", path: "a.ts" }],
      }),
    ];
    // structuredClone + toStrictEqual, NOT a JSON round-trip + toEqual: JSON
    // drops undefined-VALUED keys (claimSlugHint above), so a mutation that
    // adds/removes such a key would slip past a JSON snapshot, and toEqual
    // treats { k: undefined } and {} as equal.
    const snapshot = structuredClone(fragments);
    canonicalize(fragments);
    expect(fragments).toStrictEqual(snapshot);
  });
});

describe("canonicalize — tie-break is codepoint order, not locale collation (fix6)", () => {
  it("orders equal-rank candidates by UTF-16 code unit ('B' sorts before 'a')", () => {
    // Determinism is an explicit module contract ("engine-independent"), and
    // default-locale localeCompare is environment-dependent (ICU collation
    // orders "alpha" before "Beta"; codepoint order puts "B" 0x42 before "a"
    // 0x61). The tiebreak must be a plain codepoint comparison.
    const out = canonicalize([
      makeFragment({ subsystem: "alpha", claimSlugHint: "k" }),
      makeFragment({ subsystem: "Beta", claimSlugHint: "k" }),
    ]);
    expect(out).toHaveLength(2);
    // The two candidates tie on rankScore (identical rank inputs).
    expect(new Set(out.map((c) => c.rankScore)).size).toBe(1);
    expect(out.map((c) => c.canonical_key)).toEqual([
      `${CANONICAL_KEY_PREFIX}:Beta:k`,
      `${CANONICAL_KEY_PREFIX}:alpha:k`,
    ]);
  });
});

describe("BEHAVIOR_KNOWLEDGE_TYPES — the §7 gate set has ONE definition (types.ts)", () => {
  it("the exported set is the enum-complement of the exempt process/etiquette types (A.4)", () => {
    // Pin the contract-level export: canonicalize (approvable), validate
    // (promotion gating), and artifact sync (re-derived approvable) all import
    // this ONE set, so the three §7 gate sites can never silently drift. A.4
    // widened the gate to ALL fact/behavior types — the complement of the three
    // exempt {process, operational, org-culture} types (spec §A.4) — so every
    // falsifiable knowledge type is guilty-until-validated when unverified.
    expect([...BEHAVIOR_KNOWLEDGE_TYPES].sort()).toEqual([
      "architecture",
      "design-rationale",
      "gtm",
      "ownership",
      "product",
      "protocol",
      "root-cause",
      "security",
    ]);
  });
});
