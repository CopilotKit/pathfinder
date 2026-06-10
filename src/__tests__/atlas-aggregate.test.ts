import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { aggregate, fragmentIdentity } from "../atlas/aggregate.js";
import { canonicalize } from "../atlas/canonicalize.js";
import {
  CandidateFragmentSchema,
  EvidenceItemSchema,
  buildCanonicalKey,
} from "../atlas/types.js";
import type { CandidateFragment } from "../atlas/types.js";
import { z } from "zod";

// ── Fixture loader ────────────────────────────────────────────────────────────
// Fixtures live in fixtures/atlas/aggregate/*.json. Each file has a { fragments }
// array of CandidateFragment-shaped objects. We PARSE every fixture fragment
// through the S0 CandidateFragmentSchema so the fixtures are themselves proven to
// be valid contract inputs (and so the defaults — evidence/needsReview/
// validationTargets — are applied exactly as the real pipeline would apply them).

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, "../../fixtures/atlas/aggregate");

function loadFragments(file: string): CandidateFragment[] {
  const raw = JSON.parse(readFileSync(resolve(FIXTURE_DIR, file), "utf8")) as {
    fragments: unknown[];
  };
  return raw.fragments.map((f) => CandidateFragmentSchema.parse(f));
}

// Collect the `fused_from` refs off a fragment's evidence array.
function fusedRefs(fragment: CandidateFragment): string[] {
  return fragment.evidence
    .filter(
      (e): e is { kind: "fused_from"; ref: string } => e.kind === "fused_from",
    )
    .map((e) => e.ref);
}

describe("aggregate — ADK-OCC saga fusion (spec §6.3 / worked row §12.1)", () => {
  const fragments = loadFragments("adk-occ-saga.json");

  it("the fixture is four distinct agui-adk fragments before aggregation", () => {
    expect(fragments).toHaveLength(4);
    expect(new Set(fragments.map((f) => f.subsystem))).toEqual(
      new Set(["agui-adk"]),
    );
  });

  it("fuses the whole saga into ONE higher-order fragment", () => {
    const out = aggregate(fragments);
    expect(out).toHaveLength(1);
    expect(out[0].subsystem).toBe("agui-adk");
  });

  it("marks the fused fragment as derived (synthesized higher-order candidate)", () => {
    const [fused] = aggregate(fragments);
    expect(fused.sourcetype).toBe("derived");
    expect(fused.provenance.classification.provenance_class).toBe("derived");
  });

  it("carries every source as a fused_from evidence ref (the §12.1 ref set)", () => {
    const [fused] = aggregate(fragments);
    const refs = fusedRefs(fused);
    expect(new Set(refs)).toEqual(
      new Set([
        "github-issue:agui-adk:1732",
        "github-pr:agui-adk:1746",
        "github-issue:agui-adk:1753",
        "github-issue:agui-adk:1754",
      ]),
    );
  });

  it("reconciles sensitivity to the MOST restrictive across the saga (public + internal → internal)", () => {
    // #1732 is public; #1746/#1753/#1754 are internal → internal wins.
    const [fused] = aggregate(fragments);
    expect(fused.provenance.classification.sensitivity).toBe("internal");
  });

  it("preserves the source members' own evidence in the fused fragment", () => {
    const [fused] = aggregate(fragments);
    // The PR member contributed a changed_file; it must survive fusion.
    const changedFiles = fused.evidence
      .filter((e) => e.kind === "changed_file")
      .map((e) => (e as { path: string }).path);
    expect(changedFiles).toContain("integrations/google-adk/src/run-state.ts");
  });

  it("emits a fragment that still validates against the S0 contract schema", () => {
    const [fused] = aggregate(fragments);
    expect(() => CandidateFragmentSchema.parse(fused)).not.toThrow();
    expect(() =>
      z.array(EvidenceItemSchema).parse(fused.evidence),
    ).not.toThrow();
  });
});

describe("aggregate — cross-source fusion for one subsystem (spec §4.4)", () => {
  const fragments = loadFragments("cross-source-subsystem.json");

  it("fuses the PR + issue + memory + Notion fragments of one subsystem into ONE, leaving the unrelated fragment alone", () => {
    const out = aggregate(fragments);
    // 4 agui-protocol fragments fuse → 1; the railway-deploy fragment stays → 1.
    expect(out).toHaveLength(2);
    const protocol = out.find((f) => f.subsystem === "agui-protocol");
    const railway = out.find((f) => f.subsystem === "railway-deploy");
    expect(protocol).toBeDefined();
    expect(railway).toBeDefined();
  });

  it("the fused agui-protocol fragment carries all four sources as fused_from", () => {
    const out = aggregate(fragments);
    const protocol = out.find((f) => f.subsystem === "agui-protocol")!;
    const refs = fusedRefs(protocol);
    expect(new Set(refs)).toEqual(
      new Set([
        buildCanonicalKey("notion-doc", "agui-protocol", "interrupts-adr"),
        buildCanonicalKey("github-pr", "agui-protocol", "1801"),
        buildCanonicalKey("github-issue", "agui-protocol", "1799"),
        buildCanonicalKey(
          "memory",
          "agui-protocol",
          "feedback_interrupt_resume_keying",
        ),
      ]),
    );
  });

  it("reconciles sensitivity to the most restrictive (public + internal + proprietary → proprietary)", () => {
    const out = aggregate(fragments);
    const protocol = out.find((f) => f.subsystem === "agui-protocol")!;
    expect(protocol.provenance.classification.sensitivity).toBe("proprietary");
  });

  it("does NOT fuse the unrelated railway-deploy fragment (no fused_from, untouched sourcetype)", () => {
    const out = aggregate(fragments);
    const railway = out.find((f) => f.subsystem === "railway-deploy")!;
    expect(fusedRefs(railway)).toEqual([]);
    expect(railway.sourcetype).toBe("memory");
    expect(railway.provenance.classification.sensitivity).toBe("internal");
  });
});

describe("aggregate — dedup + no spurious cross-subsystem fusion", () => {
  const fragments = loadFragments("dedup-and-unrelated.json");

  it("collapses two byte-identical fragments and keeps the unrelated subsystem separate", () => {
    // 2 identical cpk-runtime fragments + 1 testing-sse fragment.
    expect(fragments).toHaveLength(3);
    const out = aggregate(fragments);
    // cpk-runtime collapses to 1; testing-sse stays 1.
    expect(out).toHaveLength(2);
  });

  it("does not double-count an identical member in fused_from (dedup before fuse)", () => {
    const out = aggregate(fragments);
    const runtime = out.find((f) => f.subsystem === "cpk-runtime")!;
    // Both inputs are the same identity → the group collapses to a single
    // distinct member, so there is no fusion at all: it passes through with
    // NO fused_from refs (an explicit [] — not merely "no duplicates").
    expect(fusedRefs(runtime)).toEqual([]);
  });

  it("a single distinct member passes through unfused (no fused_from, original sourcetype)", () => {
    const out = aggregate(fragments);
    const sse = out.find((f) => f.subsystem === "testing-sse")!;
    expect(fusedRefs(sse)).toEqual([]);
    expect(sse.sourcetype).toBe("memory");
  });

  it("never drops a distinct subsystem (output covers every input subsystem)", () => {
    const out = aggregate(fragments);
    const inSubsystems = new Set(fragments.map((f) => f.subsystem));
    const outSubsystems = new Set(out.map((f) => f.subsystem));
    expect(outSubsystems).toEqual(inSubsystems);
  });
});

// ── Inline fragment builder for fusion-reconciliation tests ──────────────────
// The fixture-driven tests above exercise the worked rows; the tests below need
// to vary individual classification dimensions per member, so they build minimal
// fragments inline (parsed through the schema so defaults apply identically).

import type {
  ValidationStatus,
  Confidence,
  Sensitivity,
} from "../atlas/types.js";

interface MemberOverrides {
  sourcetype?: CandidateFragment["sourcetype"];
  source_name?: string;
  ref?: string;
  repo_url?: string;
  claimSlugHint?: string;
  date?: string;
  validation_status?: ValidationStatus;
  confidence?: Confidence;
  sensitivity?: Sensitivity;
  content?: string;
  evidence?: CandidateFragment["evidence"];
  needsReview?: boolean;
  validationTargets?: string[];
}

function member(o: MemberOverrides = {}): CandidateFragment {
  const date = o.date ?? "2026-06-08";
  return CandidateFragmentSchema.parse({
    sourcetype: o.sourcetype ?? "github-pr",
    subsystem: "agui-adk",
    claimSlugHint: o.claimSlugHint ?? "occ-concurrency-handling",
    source_name: o.source_name ?? "github-pr",
    repo_url: o.repo_url,
    ref: o.ref,
    title: "OCC concurrency handling",
    content: o.content ?? "why/how prose",
    provenance: {
      source: o.source_name ?? "github-pr",
      date,
      classification: {
        sensitivity: o.sensitivity ?? "internal",
        knowledge_type: "architecture",
        audience: "all-staff",
        validation_status: o.validation_status ?? "source-verified",
        confidence: o.confidence ?? "medium",
        provenance_class: "primary",
        freshness: { as_of: date },
      },
    },
    evidence: o.evidence ?? [],
    needsReview: o.needsReview ?? false,
    validationTargets: o.validationTargets ?? [],
  });
}

describe("aggregate — fusion reconciles classification to the strongest member", () => {
  it("reconciles validation_status to the strongest member (not the newest)", () => {
    // The NEWEST member is only source-verified; an older member is
    // showcase-verified → the fused fragment must carry showcase-verified.
    const newest = member({
      ref: "1746",
      date: "2026-06-09",
      validation_status: "source-verified",
    });
    const olderStronger = member({
      ref: "1732",
      date: "2026-01-01",
      validation_status: "showcase-verified",
    });
    const [fused] = aggregate([newest, olderStronger]);
    expect(fused.provenance.classification.validation_status).toBe(
      "showcase-verified",
    );
  });

  it("reconciles confidence to the highest member (not the newest)", () => {
    const newest = member({
      ref: "1746",
      date: "2026-06-09",
      confidence: "low",
    });
    const olderHigher = member({
      ref: "1732",
      date: "2026-01-01",
      confidence: "high",
    });
    const [fused] = aggregate([newest, olderHigher]);
    expect(fused.provenance.classification.confidence).toBe("high");
  });
});

describe("aggregate — fusion preserves github provenance link", () => {
  it("falls back to an older member's repo_url/ref when the newest lacks them", () => {
    // Newest member is a memory fragment with NO repo_url/ref; an older github
    // member carries the saga's provenance link — it must survive fusion.
    const newestNoLink = member({
      sourcetype: "memory",
      source_name: "memory",
      date: "2026-06-09",
      repo_url: undefined,
      ref: undefined,
      claimSlugHint: "occ-concurrency-handling",
    });
    const olderGithub = member({
      sourcetype: "github-pr",
      source_name: "github-pr",
      date: "2026-01-01",
      repo_url: "https://github.com/CopilotKit/CopilotKit",
      ref: "1746",
    });
    const [fused] = aggregate([newestNoLink, olderGithub]);
    expect(fused.repo_url).toBe("https://github.com/CopilotKit/CopilotKit");
    expect(fused.ref).toBe("1746");
  });
});

describe("aggregate — dedupEvidence collapses structurally-identical items", () => {
  it("collapses identical changed_file evidence contributed by two members", () => {
    // Two fused members each carry the same changed_file evidence item; it must
    // collapse to a single evidence entry (structural dedup, first-seen order).
    const a = member({
      ref: "1746",
      evidence: [{ kind: "changed_file", path: "x.ts" }],
    });
    const b = member({
      ref: "1732",
      evidence: [{ kind: "changed_file", path: "x.ts" }],
    });
    const [fused] = aggregate([a, b]);
    const changedFiles = fused.evidence.filter(
      (e) => e.kind === "changed_file",
    );
    expect(changedFiles).toHaveLength(1);
  });
});

// Build a hint-LESS member with an explicit title (the member() helper always
// supplies a default claimSlugHint, so it cannot exercise the title fallback).
function hintlessMember(o: {
  sourcetype: CandidateFragment["sourcetype"];
  source_name: string;
  ref?: string;
  title: string;
  content?: string;
  date?: string;
  // Pass "" to exercise the EMPTY-hint fallback (distinct from absent).
  claimSlugHint?: string;
}): CandidateFragment {
  const date = o.date ?? "2026-06-08";
  return CandidateFragmentSchema.parse({
    sourcetype: o.sourcetype,
    subsystem: "agui-adk",
    claimSlugHint: o.claimSlugHint,
    source_name: o.source_name,
    ref: o.ref,
    title: o.title,
    content: o.content ?? "why/how prose",
    provenance: {
      source: o.source_name,
      date,
      classification: {
        sensitivity: "internal",
        knowledge_type: "architecture",
        audience: "all-staff",
        validation_status: "source-verified",
        confidence: "medium",
        provenance_class: "primary",
        freshness: { as_of: date },
      },
    },
    evidence: [],
    needsReview: false,
    validationTargets: [],
  });
}

describe("aggregate — clusterKey agrees with canonicalize's claim slug (BUG 1)", () => {
  it("fuses two hint-less members whose titles differ only by punctuation", () => {
    // No claimSlugHint → clusterKey falls back to the title. "Foo: bar" and
    // "Foo bar" must produce the SAME claim segment (slugified) so they CLUSTER
    // and FUSE, rather than fusing only in canonicalize via supersession (which
    // would silently drop the unfused member's evidence).
    const a = hintlessMember({
      sourcetype: "github-pr",
      source_name: "github-pr",
      ref: "1",
      title: "Foo: bar",
    });
    const b = hintlessMember({
      sourcetype: "github-issue",
      source_name: "github-issue",
      ref: "2",
      title: "Foo bar",
    });
    const out = aggregate([a, b]);
    expect(out).toHaveLength(1);
    expect(fusedRefs(out[0])).toHaveLength(2);
  });

  it("the fused fragment, canonicalized, drops no member (slug parity across tiers)", () => {
    // aggregate fuses the two punctuation-different titles into one; canonicalize
    // then sees exactly one claim. If aggregate had NOT fused them (raw clusterKey
    // disagreeing with the slug), canonicalize would collapse them via supersession
    // and silently drop one member's evidence — so the fused output stays length 1.
    const a = hintlessMember({
      sourcetype: "github-pr",
      source_name: "github-pr",
      ref: "1",
      title: "Resume keying: interruptId, NOT parentRunId!",
    });
    const b = hintlessMember({
      sourcetype: "github-issue",
      source_name: "github-issue",
      ref: "2",
      title: "Resume keying interruptId NOT parentRunId",
    });
    const out = aggregate([a, b]);
    expect(out).toHaveLength(1);
    expect(fusedRefs(out[0])).toHaveLength(2);
    // PARITY PROVEN END-TO-END: push the fused output through canonicalize —
    // exactly one Candidate survives (no supersession collapse hiding behind
    // the fusion) and BOTH members' fused_from refs ride along, so neither
    // member's evidence is dropped across the tier boundary.
    const candidates = canonicalize(out);
    expect(candidates).toHaveLength(1);
    expect(fusedRefs(candidates[0])).toHaveLength(2);
  });
});

describe("aggregate — fused repo_url + ref come from the SAME member (BUG 2)", () => {
  it("does not splice repo_url from one member and ref from another", () => {
    // Newest member has a repo_url but NO ref; an older member has BOTH. The
    // fused link must be internally consistent: take repo_url AND ref from the
    // first (recency-ordered) member that HAS a repo_url — never a Frankenstein
    // pair (repo_url from A, ref from B) that never co-existed on one source.
    const newestRepoNoRef = member({
      sourcetype: "github-pr",
      source_name: "github-pr",
      date: "2026-06-09",
      repo_url: "https://github.com/CopilotKit/NEWEST",
      ref: undefined,
    });
    const olderBoth = member({
      sourcetype: "github-issue",
      source_name: "github-issue",
      date: "2026-01-01",
      repo_url: "https://github.com/CopilotKit/OLDER",
      ref: "1732",
    });
    const [fused] = aggregate([newestRepoNoRef, olderBoth]);
    // repo_url comes from the newest member that HAS one (the newest).
    expect(fused.repo_url).toBe("https://github.com/CopilotKit/NEWEST");
    // ref MUST come from that SAME member — which had none → undefined, NOT the
    // older member's "1732".
    expect(fused.ref).toBeUndefined();
  });

  it("takes BOTH repo_url and ref from the first recency member that has a repo_url", () => {
    const newestNoLink = member({
      sourcetype: "memory",
      source_name: "memory",
      date: "2026-06-09",
      repo_url: undefined,
      ref: undefined,
    });
    const middleLinked = member({
      sourcetype: "github-pr",
      source_name: "github-pr",
      date: "2026-03-01",
      repo_url: "https://github.com/CopilotKit/MIDDLE",
      ref: "1746",
    });
    const oldestLinked = member({
      sourcetype: "github-issue",
      source_name: "github-issue",
      date: "2026-01-01",
      repo_url: "https://github.com/CopilotKit/OLDEST",
      ref: "1732",
    });
    const [fused] = aggregate([newestNoLink, middleLinked, oldestLinked]);
    // First recency member WITH a repo_url is `middleLinked` → both come from it.
    expect(fused.repo_url).toBe("https://github.com/CopilotKit/MIDDLE");
    expect(fused.ref).toBe("1746");
  });
});

describe("aggregate — byte-identity dedup reconciles sensitivity (BUG 3, leak)", () => {
  it("a secret + internal byte-identical pair survives as secret, not internal", () => {
    // Two byte-identical fragments (same sourcetype+source_name+ref+content) that
    // differ ONLY in sensitivity: one `secret`, one `internal`. Identity-dedup
    // collapses them to ONE distinct member (single-member cluster → no
    // fuseCluster reconciliation), so the survivor's sensitivity MUST be the
    // most-restrictive (secret), or the secret exclusion rule is dodged.
    const secret = member({
      sourcetype: "github-pr",
      source_name: "github-pr",
      ref: "1746",
      content: "identical content",
      sensitivity: "secret",
    });
    const internal = member({
      sourcetype: "github-pr",
      source_name: "github-pr",
      ref: "1746",
      content: "identical content",
      sensitivity: "internal",
    });
    const out = aggregate([secret, internal]);
    expect(out).toHaveLength(1);
    expect(out[0].provenance.classification.sensitivity).toBe("secret");
  });

  it("reconciles to most-restrictive regardless of which duplicate is seen first", () => {
    const internalFirst = member({
      sourcetype: "github-pr",
      source_name: "github-pr",
      ref: "1746",
      content: "identical content",
      sensitivity: "internal",
    });
    const secretSecond = member({
      sourcetype: "github-pr",
      source_name: "github-pr",
      ref: "1746",
      content: "identical content",
      sensitivity: "secret",
    });
    const out = aggregate([internalFirst, secretSecond]);
    expect(out).toHaveLength(1);
    expect(out[0].provenance.classification.sensitivity).toBe("secret");
  });
});

describe("aggregate — ref-less members get distinct fused_from refs (BUG 5)", () => {
  it("two ref-less members of one cluster produce TWO distinct fused_from refs", () => {
    // Both members lack `ref` and share a claimSlugHint. The synthesized
    // fused_from ref must include a per-member discriminator so they do not
    // collapse to one ref in dedupEvidence (which would under-count sources).
    const a = member({
      sourcetype: "github-pr",
      source_name: "github-pr",
      ref: undefined,
      claimSlugHint: "occ-concurrency-handling",
      content: "member A content",
    });
    const b = member({
      sourcetype: "github-pr",
      source_name: "github-pr",
      ref: undefined,
      claimSlugHint: "occ-concurrency-handling",
      content: "member B content",
    });
    const [fused] = aggregate([a, b]);
    expect(fused).toBeDefined();
    expect(fusedRefs(fused)).toHaveLength(2);
    expect(new Set(fusedRefs(fused)).size).toBe(2);
  });

  it("two ref-'' members with distinct content do NOT collapse fused_from (empty ref is absent)", () => {
    // The schema admits ref: "". An empty ref is NOT a stable per-source
    // discriminant — under the module's empty-string-is-absent rule (the
    // repo_url backfill, the truthy hint fallback) it must take the
    // discriminator path. Otherwise BOTH members synthesize
    // buildCanonicalKey(sourcetype, subsystem, "") and dedupEvidence
    // collapses them to one fused_from ref, under-counting sources.
    const a = member({
      sourcetype: "github-pr",
      source_name: "github-pr",
      ref: "",
      claimSlugHint: "occ-concurrency-handling",
      content: "member A content",
    });
    const b = member({
      sourcetype: "github-pr",
      source_name: "github-pr",
      ref: "",
      claimSlugHint: "occ-concurrency-handling",
      content: "member B content",
    });
    const [fused] = aggregate([a, b]);
    expect(fused).toBeDefined();
    expect(fusedRefs(fused)).toHaveLength(2);
    expect(new Set(fusedRefs(fused)).size).toBe(2);
  });
});

describe("aggregate — fused source_name reflects members, not hardcoded github-saga (BUG 6)", () => {
  it("a cross-source cluster fused from only memory + notion members is NOT labeled github-saga", () => {
    // Cross-source fusion is a normal pipeline outcome and can involve zero
    // GitHub members. The fused row must NOT be stamped source_name/provenance
    // .source = "github-saga" when no member is a GitHub source — that mislabels
    // non-GitHub knowledge in the persisted seed row (toSeedEntryRow writes
    // sourceName from source_name).
    const mem = member({
      sourcetype: "memory",
      source_name: "memory",
      content: "memory member content",
    });
    const notion = member({
      sourcetype: "notion-doc",
      source_name: "notion-doc",
      content: "notion member content",
    });
    const [fused] = aggregate([mem, notion]);
    expect(fused.sourcetype).toBe("derived");
    expect(fused.source_name).not.toBe("github-saga");
    expect(fused.provenance.source).not.toBe("github-saga");
    // top-level source_name and provenance.source agree.
    expect(fused.source_name).toBe(fused.provenance.source);
  });
});

describe("aggregate — empty-string repo_url is treated as absent (fix4)", () => {
  it("falls back past a newest member whose repo_url is the empty string", () => {
    // The newest member carries repo_url: "" (an empty link is no link). The
    // link-source lookup must skip it — truthiness, not !== undefined — and
    // take BOTH repo_url and ref from the older member that has a real link.
    const newestEmptyLink = member({
      sourcetype: "github-pr",
      source_name: "github-pr",
      date: "2026-06-09",
      repo_url: "",
      ref: "999",
    });
    const olderLinked = member({
      sourcetype: "github-issue",
      source_name: "github-issue",
      date: "2026-01-01",
      repo_url: "https://github.com/CopilotKit/OLDER",
      ref: "1732",
    });
    const [fused] = aggregate([newestEmptyLink, olderLinked]);
    expect(fused.repo_url).toBe("https://github.com/CopilotKit/OLDER");
    expect(fused.ref).toBe("1732");
  });
});

describe("aggregate — byte-identity dedup reconciles classification metadata (fix4)", () => {
  // Two byte-identical fragments (same sourcetype+source_name+ref+content)
  // collapse to ONE distinct member — a single-member cluster skips
  // fuseCluster's reconciliation — so the dedup collapse itself must reconcile
  // the metadata that fragmentIdentity ignores, exactly like fusion would:
  // validation_status takes the STRONGEST, confidence the HIGHEST, and
  // validationTargets the UNION across the duplicates.
  it("survivor carries the STRONGEST validation_status across duplicates", () => {
    const weaker = member({
      ref: "1746",
      content: "identical content",
      validation_status: "unverified",
    });
    const stronger = member({
      ref: "1746",
      content: "identical content",
      validation_status: "showcase-verified",
    });
    const out = aggregate([weaker, stronger]);
    expect(out).toHaveLength(1);
    expect(out[0].provenance.classification.validation_status).toBe(
      "showcase-verified",
    );
  });

  it("reconciles validation_status regardless of which duplicate is seen first", () => {
    const stronger = member({
      ref: "1746",
      content: "identical content",
      validation_status: "showcase-verified",
    });
    const weaker = member({
      ref: "1746",
      content: "identical content",
      validation_status: "unverified",
    });
    const out = aggregate([stronger, weaker]);
    expect(out).toHaveLength(1);
    expect(out[0].provenance.classification.validation_status).toBe(
      "showcase-verified",
    );
  });

  it("survivor carries the HIGHEST confidence across duplicates", () => {
    const low = member({
      ref: "1746",
      content: "identical content",
      confidence: "low",
    });
    const high = member({
      ref: "1746",
      content: "identical content",
      confidence: "high",
    });
    const out = aggregate([low, high]);
    expect(out).toHaveLength(1);
    expect(out[0].provenance.classification.confidence).toBe("high");
  });

  it("survivor carries the UNION of validationTargets across duplicates", () => {
    const a = member({
      ref: "1746",
      content: "identical content",
      validationTargets: ["src/a.ts", "shared.ts"],
    });
    const b = member({
      ref: "1746",
      content: "identical content",
      validationTargets: ["src/b.ts", "shared.ts"],
    });
    const out = aggregate([a, b]);
    expect(out).toHaveLength(1);
    expect(new Set(out[0].validationTargets)).toEqual(
      new Set(["src/a.ts", "src/b.ts", "shared.ts"]),
    );
  });
});

describe("aggregate — byte-identity dedup unions evidence and keeps the newest date (fix5)", () => {
  // fragmentIdentity covers only sourcetype + source_name + ref + content, so a
  // byte-identical pair can still differ in evidence and provenance.date. The
  // collapse must union the evidence (like fuseCluster) and keep the NEWEST
  // provenance.date — otherwise a dropped duplicate's evidence and recency are
  // silently lost when the cluster collapses to a single member.
  it("survivor carries the UNION of both duplicates' evidence", () => {
    const a = member({
      ref: "1746",
      content: "identical content",
      evidence: [{ kind: "changed_file", path: "a.ts" }],
    });
    const b = member({
      ref: "1746",
      content: "identical content",
      evidence: [{ kind: "linked_issue", url: "issues/9" }],
    });
    const out = aggregate([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].evidence).toEqual(
      expect.arrayContaining([
        { kind: "changed_file", path: "a.ts" },
        { kind: "linked_issue", url: "issues/9" },
      ]),
    );
    expect(out[0].evidence).toHaveLength(2);
  });

  it("structurally-identical evidence shared by both duplicates is not doubled", () => {
    const a = member({
      ref: "1746",
      content: "identical content",
      evidence: [{ kind: "changed_file", path: "shared.ts" }],
    });
    const b = member({
      ref: "1746",
      content: "identical content",
      evidence: [{ kind: "changed_file", path: "shared.ts" }],
    });
    const out = aggregate([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].evidence).toEqual([
      { kind: "changed_file", path: "shared.ts" },
    ]);
  });

  it("survivor carries the NEWER provenance.date when the duplicate is newer", () => {
    const olderIncumbent = member({
      ref: "1746",
      content: "identical content",
      date: "2026-01-01",
    });
    const newerDuplicate = member({
      ref: "1746",
      content: "identical content",
      date: "2026-06-09",
    });
    const out = aggregate([olderIncumbent, newerDuplicate]);
    expect(out).toHaveLength(1);
    expect(out[0].provenance.date).toBe("2026-06-09");
  });

  it("keeps the newer date regardless of which duplicate is seen first", () => {
    const newerIncumbent = member({
      ref: "1746",
      content: "identical content",
      date: "2026-06-09",
    });
    const olderDuplicate = member({
      ref: "1746",
      content: "identical content",
      date: "2026-01-01",
    });
    const out = aggregate([newerIncumbent, olderDuplicate]);
    expect(out).toHaveLength(1);
    expect(out[0].provenance.date).toBe("2026-06-09");
  });
});

describe("aggregate — collapse→fuse output never aliases caller evidence (fix8 X10)", () => {
  it("mutating a fused fragment's evidence item leaves the input fragment untouched", () => {
    // Cluster of 3: an identity-equal pair (a, b — same sourcetype +
    // source_name + ref + content) where the DUPLICATE (b) carries an evidence
    // item, plus one DISTINCT member (c) so fuseCluster runs. The dedup
    // collapse splices b's evidence into the cloned incumbent; without cloning
    // at that splice, fuseCluster's flatMap flows the RAW reference into the
    // returned fragment — mutating the output would mutate the caller's input,
    // violating the module's purity / no-aliasing contract.
    const a = member({
      ref: "1746",
      content: "identical content",
      evidence: [],
    });
    const b = member({
      ref: "1746",
      content: "identical content",
      evidence: [{ kind: "changed_file", path: "dup.ts" }],
    });
    const c = member({
      ref: "1732",
      content: "distinct content",
      evidence: [],
    });

    const out = aggregate([a, b, c]);
    expect(out).toHaveLength(1);
    const fusedItem = out[0].evidence.find(
      (e): e is { kind: "changed_file"; path: string } =>
        e.kind === "changed_file",
    );
    expect(fusedItem).toBeDefined();

    // Mutate the OUTPUT's evidence item …
    fusedItem!.path = "MUTATED-BY-CONSUMER.ts";

    // … the caller's input fragment must be untouched.
    expect(b.evidence).toEqual([{ kind: "changed_file", path: "dup.ts" }]);
  });
});

describe("aggregate — punctuation-only titles do not spuriously cluster (fix5)", () => {
  it("two hint-less members whose titles slug to EMPTY do NOT fuse", () => {
    // Both titles are punctuation-only, so the naive slug is "" for both. The
    // hash fallback in claimSlug must keep the two DISTINCT claims apart —
    // otherwise unrelated fragments share a cluster key and fuse spuriously
    // (and downstream, share a canonical_key and one is silently superseded).
    const a = hintlessMember({
      sourcetype: "github-pr",
      source_name: "github-pr",
      ref: "1",
      title: "!!!",
      content: "claim A prose",
    });
    const b = hintlessMember({
      sourcetype: "github-issue",
      source_name: "github-issue",
      ref: "2",
      title: "???",
      content: "claim B prose",
    });
    const out = aggregate([a, b]);
    expect(out).toHaveLength(2);
    expect(fusedRefs(out[0])).toEqual([]);
    expect(fusedRefs(out[1])).toEqual([]);
  });

  it("the SAME punctuation-only title still clusters (fallback is stable)", () => {
    const a = hintlessMember({
      sourcetype: "github-pr",
      source_name: "github-pr",
      ref: "1",
      title: "!!!",
      content: "claim A prose",
    });
    const b = hintlessMember({
      sourcetype: "github-issue",
      source_name: "github-issue",
      ref: "2",
      title: "!!!",
      content: "claim B prose",
    });
    const out = aggregate([a, b]);
    expect(out).toHaveLength(1);
    expect(fusedRefs(out[0])).toHaveLength(2);
  });
});

describe("aggregate — CJK-distinguished titles land in DISTINCT clusters (fix11)", () => {
  it("two hint-less members whose titles differ only in non-ASCII letters do NOT fuse", () => {
    // Both titles naive-slug to "fix-the-bug": the CJK words ARE the
    // distinguishing claim semantics, and stripping them would collapse two
    // unrelated claims into one cluster (spurious fuse here, then silent
    // supersession downstream in canonicalize). claimSlug's djb2 discriminator
    // for letter-bearing non-ASCII residue keeps the clusters distinct.
    const a = hintlessMember({
      sourcetype: "github-pr",
      source_name: "github-pr",
      ref: "1",
      title: "Fix the 缓存 bug",
      content: "claim A prose",
    });
    const b = hintlessMember({
      sourcetype: "github-issue",
      source_name: "github-issue",
      ref: "2",
      title: "Fix the 排序 bug",
      content: "claim B prose",
    });
    const out = aggregate([a, b]);
    expect(out).toHaveLength(2);
    expect(fusedRefs(out[0])).toEqual([]);
    expect(fusedRefs(out[1])).toEqual([]);
  });

  it("the SAME CJK-bearing title still clusters (discriminator is stable)", () => {
    const a = hintlessMember({
      sourcetype: "github-pr",
      source_name: "github-pr",
      ref: "1",
      title: "Fix the 缓存 bug",
      content: "claim A prose",
    });
    const b = hintlessMember({
      sourcetype: "github-issue",
      source_name: "github-issue",
      ref: "2",
      title: "Fix the 缓存 bug",
      content: "claim B prose",
    });
    const out = aggregate([a, b]);
    expect(out).toHaveLength(1);
    expect(fusedRefs(out[0])).toHaveLength(2);
  });
});

describe("aggregate — case-variant CJK titles land in the SAME cluster (fix12)", () => {
  it("two hint-less members whose titles differ ONLY by ASCII case fuse into one cluster", () => {
    // Same claim, different case (github's decapitalize heuristic vs notion's
    // verbatim title). Case is decoration, not claim semantics — the djb2
    // discriminator hashes a NORMALIZED projection, so both variants get one
    // cluster key and fuse instead of producing duplicate pending rows.
    const a = hintlessMember({
      sourcetype: "github-pr",
      source_name: "github-pr",
      ref: "1",
      title: "Fix the 缓存 bug",
      content: "claim A prose",
    });
    const b = hintlessMember({
      sourcetype: "github-issue",
      source_name: "github-issue",
      ref: "2",
      title: "fix the 缓存 bug",
      content: "claim B prose",
    });
    const out = aggregate([a, b]);
    expect(out).toHaveLength(1);
    expect(fusedRefs(out[0])).toHaveLength(2);
  });
});

describe("aggregate — byte-identity dedup reconciles needsReview (BUG 7, lost flag)", () => {
  it("a needsReview:true + needsReview:false byte-identical pair survives as needsReview:true", () => {
    // Two byte-identical fragments (same sourcetype+source_name+ref+content) that
    // differ ONLY in needsReview. Identity-dedup collapses them to ONE distinct
    // member (single-member cluster → no fuseCluster reconciliation). needsReview
    // is a restrictive-direction signal: once flagged it stays flagged, so the
    // survivor MUST carry needsReview:true even if the incumbent had false.
    const flagged = member({
      sourcetype: "github-pr",
      source_name: "github-pr",
      ref: "1746",
      content: "identical content",
      needsReview: true,
    });
    const unflagged = member({
      sourcetype: "github-pr",
      source_name: "github-pr",
      ref: "1746",
      content: "identical content",
      needsReview: false,
    });
    const out = aggregate([unflagged, flagged]);
    expect(out).toHaveLength(1);
    expect(out[0].needsReview).toBe(true);
  });

  it("reconciles needsReview regardless of which duplicate is seen first", () => {
    const flagged = member({
      sourcetype: "github-pr",
      source_name: "github-pr",
      ref: "1746",
      content: "identical content",
      needsReview: true,
    });
    const unflagged = member({
      sourcetype: "github-pr",
      source_name: "github-pr",
      ref: "1746",
      content: "identical content",
      needsReview: false,
    });
    const out = aggregate([flagged, unflagged]);
    expect(out).toHaveLength(1);
    expect(out[0].needsReview).toBe(true);
  });
});

describe("aggregate — fragmentIdentity joins with a NUL byte, not a space (fix6 pin)", () => {
  // STRUCTURAL FP-KILLER: the join separator in fragmentIdentity IS the NUL
  // byte (0x00). Every editor/grep RENDERS that byte as a space, which has
  // repeatedly caused reviewers to flag the join as a space-join ambiguity.
  // These tests pin the byte so the finding cannot recur. Do NOT re-flag.
  it("the identity separator is \\u0000 (renders as a space in editors/grep)", () => {
    const f = member({ ref: "1746", content: "identical content" });
    const identity = fragmentIdentity(f);
    expect(identity).toContain("\u0000");
    // The four identity components are NUL-delimited, in order.
    expect(identity.split("\u0000")).toEqual([
      "github-pr",
      "github-pr",
      "1746",
      "identical content",
    ]);
  });

  it("space-ambiguous members do NOT collapse (the reason the separator is NUL)", () => {
    // Under a plain space join, {source_name:"a b", ref:"c"} and
    // {source_name:"a", ref:"b c"} would serialize IDENTICALLY and wrongly
    // collapse to one observation. The NUL separator keeps them distinct.
    const f1 = member({
      source_name: "a b",
      ref: "c",
      content: "same content",
    });
    const f2 = member({
      source_name: "a",
      ref: "b c",
      content: "same content",
    });
    expect(fragmentIdentity(f1)).not.toBe(fragmentIdentity(f2));
    const out = aggregate([f1, f2]);
    // Two DISTINCT members of one cluster → they FUSE (two fused_from refs),
    // they do not dedup-collapse to a single observation.
    expect(out).toHaveLength(1);
    expect(fusedRefs(out[0])).toHaveLength(2);
  });
});

describe("aggregate — empty-string claimSlugHint falls back to the title (fix6)", () => {
  it("two empty-hint members with distinct titles form TWO clusters, not one", () => {
    // The schema admits claimSlugHint: "". A nullish (??) fallback keeps "",
    // and claimSlug("") is the djb2 hash of the empty string — the SAME
    // constant slug ("45h") for EVERY empty-hint fragment — so unrelated
    // claims would cluster (and fuse) together. The fallback must be truthy so
    // an empty hint routes to the title, exactly like an absent hint.
    const a = hintlessMember({
      sourcetype: "github-pr",
      source_name: "github-pr",
      ref: "1",
      title: "OCC concurrency handling",
      claimSlugHint: "",
      content: "claim A prose",
    });
    const b = hintlessMember({
      sourcetype: "github-issue",
      source_name: "github-issue",
      ref: "2",
      title: "Railway deploy retries are exponential",
      claimSlugHint: "",
      content: "claim B prose",
    });
    const out = aggregate([a, b]);
    expect(out).toHaveLength(2);
    expect(fusedRefs(out[0])).toEqual([]);
    expect(fusedRefs(out[1])).toEqual([]);
  });

  it("ref-less empty-hint members synthesize fused_from refs from source_name, not a dangling '-'", () => {
    // fusedFromRef's synthesized claim segment must also treat an empty hint as
    // absent: `${""}-${disc}` would emit a segment starting with "-".
    const a = hintlessMember({
      sourcetype: "github-pr",
      source_name: "github-pr",
      title: "OCC concurrency handling",
      claimSlugHint: "",
      content: "member A content",
    });
    const b = hintlessMember({
      sourcetype: "github-pr",
      source_name: "github-pr",
      title: "OCC concurrency handling",
      claimSlugHint: "",
      content: "member B content",
    });
    const [fused] = aggregate([a, b]);
    const refs = fusedRefs(fused);
    expect(refs).toHaveLength(2);
    for (const ref of refs) {
      expect(ref).toContain(":github-pr-");
      expect(ref).not.toContain(":-");
    }
  });
});

describe("aggregate — marker delimiters in unrefined inputs do not abort fusion (fix10 Z5)", () => {
  // buildCanonicalKey (post fix9 Y2) throws on '⟦'/'⟧' in ANY component, but
  // ref/claimSlugHint/source_name are deliberately UNREFINED at intake (only
  // subsystem is) — so a schema-valid exotic ref must not crash the pure
  // `aggregate` mid-fuse. fusedFromRef sanitizes the claim-slug segment
  // locally: fused_from refs are evidence display only and never round-trip
  // through a page marker.
  it("a member with '⟦'/'⟧' in its ref fuses cleanly with a sanitized fused_from segment", () => {
    const exotic = member({ ref: "a⟦b⟧c", content: "member A content" });
    const plain = member({ ref: "a-b-c", content: "member B content" });
    // Completion pin: this must NOT throw (pre-Z5 it aborted in
    // buildCanonicalKey). Collision semantics of the post-sanitization refs
    // are deliberately NOT pinned (U40 stays deferred).
    const out = aggregate([exotic, plain]);
    expect(out).toHaveLength(1);
    const refs = fusedRefs(out[0]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref).not.toMatch(/[⟦⟧]/);
      expect(ref).toContain(":a-b-c");
    }
  });

  it("a ref-less member with '⟦'/'⟧' in its source_name fuses cleanly (synthesized segment path)", () => {
    // No ref and no hint → the synthesized segment is
    // `${source_name}-<discriminator>`, which fed the marker straight into the
    // builder pre-Z5.
    const a = hintlessMember({
      sourcetype: "memory",
      source_name: "weird⟦file⟧name",
      title: "OCC concurrency handling",
      content: "member A content",
    });
    const b = hintlessMember({
      sourcetype: "memory",
      source_name: "weird⟦file⟧name",
      title: "OCC concurrency handling",
      content: "member B content",
    });
    const out = aggregate([a, b]);
    expect(out).toHaveLength(1);
    const refs = fusedRefs(out[0]);
    expect(refs).toHaveLength(2);
    for (const ref of refs) {
      expect(ref).not.toMatch(/[⟦⟧]/);
      expect(ref).toContain(":weird-file-name-");
    }
  });
});

describe("aggregate — byte-identity dedup backfills repo_url + ref (fix6)", () => {
  // repo_url is OUTSIDE fragmentIdentity (ref is inside, so duplicates always
  // agree on ref), so a dropped duplicate can carry a provenance link the
  // incumbent lacks. The collapse must backfill it with the same truthiness
  // rule as fuseCluster's linkSource — and take repo_url + ref as a PAIR.
  it("the survivor keeps a dropped duplicate's repo_url when the incumbent lacks one", () => {
    const incumbent = member({
      ref: "1746",
      content: "identical content",
      repo_url: undefined,
    });
    const duplicate = member({
      ref: "1746",
      content: "identical content",
      repo_url: "https://github.com/CopilotKit/CopilotKit",
    });
    const out = aggregate([incumbent, duplicate]);
    expect(out).toHaveLength(1);
    expect(out[0].repo_url).toBe("https://github.com/CopilotKit/CopilotKit");
    // The pair rule: ref rides along from the same duplicate (identity-equal).
    expect(out[0].ref).toBe("1746");
  });

  it("treats an empty-string incumbent repo_url as absent (truthiness, matching fuseCluster)", () => {
    const incumbent = member({
      ref: "1746",
      content: "identical content",
      repo_url: "",
    });
    const duplicate = member({
      ref: "1746",
      content: "identical content",
      repo_url: "https://github.com/CopilotKit/REAL",
    });
    const out = aggregate([incumbent, duplicate]);
    expect(out).toHaveLength(1);
    expect(out[0].repo_url).toBe("https://github.com/CopilotKit/REAL");
  });

  it("keeps the incumbent's repo_url when it already has one (first-seen wins)", () => {
    const incumbent = member({
      ref: "1746",
      content: "identical content",
      repo_url: "https://github.com/CopilotKit/FIRST",
    });
    const duplicate = member({
      ref: "1746",
      content: "identical content",
      repo_url: "https://github.com/CopilotKit/SECOND",
    });
    const out = aggregate([incumbent, duplicate]);
    expect(out).toHaveLength(1);
    expect(out[0].repo_url).toBe("https://github.com/CopilotKit/FIRST");
  });
});

describe("aggregate — fused member ordering is codepoint-deterministic (fix6)", () => {
  it("orders fused_from refs by UTF-16 code unit, not locale collation", () => {
    // Determinism is a module contract; default-locale localeCompare is
    // environment-dependent (ICU collation orders "alpha" before "Bravo";
    // codepoint order puts "B" 0x42 before "a" 0x61).
    const a = member({ ref: "alpha", content: "A content" });
    const b = member({ ref: "Bravo", content: "B content" });
    const [fused] = aggregate([a, b]);
    expect(fusedRefs(fused)).toEqual([
      "github-pr:agui-adk:Bravo",
      "github-pr:agui-adk:alpha",
    ]);
  });
});

describe("aggregate — edge cases", () => {
  it("returns an empty array for empty input", () => {
    expect(aggregate([])).toEqual([]);
  });

  it("is a pure function (does not mutate its input array or fragments)", () => {
    const fragments = loadFragments("adk-occ-saga.json");
    // structuredClone + toStrictEqual, NOT a JSON round-trip + toEqual: JSON
    // drops undefined-VALUED keys (e.g. an absent ref/claimSlugHint the schema
    // defaults leave as undefined), so a mutation that adds/removes such a key
    // would slip past a JSON snapshot, and toEqual treats { k: undefined } and
    // {} as equal.
    const snapshot = structuredClone(fragments);
    aggregate(fragments);
    expect(fragments).toStrictEqual(snapshot);
  });
});
