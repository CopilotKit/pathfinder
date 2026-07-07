// Audience/relevance gate tests (Atlas corpus-scoping, spec §4/§8).
//
// The gate has two deterministic pre-screen paths (no LLM) and one injected-judge
// path. Per the org rule the JUDGE is the ONLY LLM seam — but these tests exercise
// (a) the deterministic pre-screens (which never call the judge) and (b) the
// verdict-routing behavior of `enforceAudienceRelevance` (borderline → needsReview,
// internal-ops → INTERNAL_OPS_MARKER stamp → approvable floor). For (b) we drive
// the judge path with a DETERMINISTIC fake AudienceJudge stub, NOT a real LLM: the
// aimock-backed real-judge coverage lives in atlas-llm.test.ts (§8). The stub also
// lets us assert the pre-screen paths NEVER call the judge (call-count === 0).
//
// The CRITICAL COUPLING under test is S2 → S0/S4: an internal-ops verdict must
// stamp INTERNAL_OPS_MARKER onto the SAME `provenance.validated_against` carrier
// the shared floor predicate reads, so `isApprovableFloored` (the S0 predicate
// validate + canonicalize both consume) returns true. We assert the FLOOR firing,
// not just that a token string appears.

import { describe, expect, it } from "vitest";

import {
  enforceAudienceRelevance,
  type AudienceJudge,
  type AudienceVerdict,
} from "../atlas/audience-gate.js";
import { INTERNAL_OPS_MARKER, isApprovableFloored } from "../atlas/types.js";
import type { Candidate, KnowledgeType } from "../atlas/types.js";

// A deterministic fake judge: returns a fixed verdict and counts its calls so a
// test can assert the deterministic pre-screen never reached the LLM seam.
function fakeJudge(
  verdict: AudienceVerdict,
): AudienceJudge & { calls: number } {
  const j = {
    calls: 0,
    async judge(): Promise<AudienceVerdict> {
      j.calls += 1;
      return verdict;
    },
  };
  return j;
}

// A judge that MUST NOT be called — throws if the gate ever reaches it. Used to
// prove a deterministic pre-screen path bypasses the LLM seam entirely.
const throwingJudge: AudienceJudge = {
  async judge(): Promise<AudienceVerdict> {
    throw new Error(
      "judge must not be called on a deterministic pre-screen path",
    );
  },
};

function makeCandidate(over: {
  title: string;
  content: string;
  knowledge_type?: KnowledgeType;
  subsystem?: string;
}): Candidate {
  const subsystem = over.subsystem ?? "runtime";
  return {
    sourcetype: "github-pr",
    subsystem,
    claimSlugHint: "claim",
    source_name: "atlas",
    repo_url: "https://github.com/CopilotKit/pathfinder",
    ref: "main",
    title: over.title,
    content: over.content,
    provenance: {
      source: "github-pr",
      url: "https://github.com/CopilotKit/pathfinder/pull/1",
      date: "2026-06-01",
      classification: {
        sensitivity: "public",
        knowledge_type: over.knowledge_type ?? "architecture",
        audience: "all-staff",
        validation_status: "unverified",
        confidence: "high",
        provenance_class: "primary",
        freshness: { as_of: "2026-06-01" },
      },
    },
    canonical_key: `github-pr:${subsystem}:claim`,
    rankScore: 1,
    approvable: true,
    evidence: [],
    needsReview: false,
    validationTargets: [],
  };
}

describe("enforceAudienceRelevance — deterministic pre-screen (no LLM)", () => {
  it("scopes a railway-* subsystem + operational + deploy vocab candidate to internal-ops WITHOUT calling the judge", async () => {
    const judge = fakeJudge({ kind: "relevant" });
    const cand = makeCandidate({
      title: "Redeployed the web service",
      content:
        "We redeployed the web service on Railway after the config change landed.",
      knowledge_type: "operational",
      subsystem: "railway-web",
    });
    const [out] = await enforceAudienceRelevance([cand], { judge });
    expect(judge.calls).toBe(0);
    // Internal-ops → INTERNAL_OPS_MARKER stamped → S0 floor predicate fires.
    expect(isApprovableFloored(out)).toBe(true);
    expect(out.provenance.validated_against).toContain(INTERNAL_OPS_MARKER);
  });

  it("passes an architecture candidate carrying a product-portable specific as relevant WITHOUT calling the judge", async () => {
    const cand = makeCandidate({
      title: "Admin reindex requires an authenticated POST",
      content:
        "The reindex job is triggered via POST /admin/reindex; an unauthenticated call returns 401.",
      knowledge_type: "architecture",
      subsystem: "runtime",
    });
    // throwingJudge proves the pre-screen bypassed the LLM seam entirely.
    const [out] = await enforceAudienceRelevance([cand], {
      judge: throwingJudge,
    });
    expect(isApprovableFloored(out)).toBe(false);
    expect(out.needsReview).toBe(false);
    expect(out.provenance.validated_against ?? "").not.toContain(
      INTERNAL_OPS_MARKER,
    );
  });

  // ── Finding 1: PRODUCT_PORTABLE_SPECIFIC_RE must match ONLY genuine
  //    product-portable specifics, not ordinary prose. ──────────────────────
  it("does NOT clear-relevant an internal root-cause candidate whose only 'specifics' are an incidental 4xx/5xx count and a prose parenthetical — it reaches the judge", async () => {
    // knowledge_type is clear-relevant-eligible (root-cause) so ONLY the
    // over-broad regex could force the bypass. The body has an incidental
    // "503 candidates" integer and an ordinary "orchestrator (see …)"
    // parenthetical — neither is a product-portable specific. This candidate
    // must reach the judge (which rules it internal-ops), NOT be force-passed.
    const judge = fakeJudge({
      kind: "internal-ops",
      reason: "internal root-cause narrative, no external-builder utility",
    });
    const cand = makeCandidate({
      title: "Root cause of the July starvation incident",
      content:
        "The orchestrator (see the incident timeline) starved because 503 candidates " +
        "piled up behind a single replica; we promoted more capacity to drain them.",
      knowledge_type: "root-cause",
      subsystem: "harvest",
    });
    const [out] = await enforceAudienceRelevance([cand], { judge });
    expect(judge.calls).toBe(1); // reached the judge, was NOT clear-relevant
    expect(isApprovableFloored(out)).toBe(true);
    expect(out.provenance.validated_against).toContain(INTERNAL_OPS_MARKER);
  });

  it("does NOT clear-relevant an internal-ops candidate whose bare 4xx/5xx code sits next to incidental prose words ('code'/'error'/'status'), not real HTTP context — it reaches the judge", async () => {
    // Finding 4 (floor escape): STATUS_VERB included bare "code"/"error"/
    // "status", so ordinary internal-ops prose ("during code review we saw 503
    // candidates") matched HTTP_STATUS_IN_CONTEXT_RE and took the clear-relevant
    // bypass — escaping the fail-restrictive judge. A bare 4xx/5xx must only
    // qualify as an HTTP status in GENUINE HTTP context (returns/responds/HTTP/
    // status code), never because an incidental word like "code" happens to sit
    // within a few characters of the number.
    const judge = fakeJudge({
      kind: "internal-ops",
      reason: "internal code-review narrative, no external-builder utility",
    });
    const cand = makeCandidate({
      title: "Code-review triage note",
      content:
        "During code review we saw 503 candidates queued behind the reindex; " +
        "the error status was noted and we drained them by hand.",
      knowledge_type: "root-cause",
      subsystem: "harvest",
    });
    const [out] = await enforceAudienceRelevance([cand], { judge });
    expect(judge.calls).toBe(1); // reached the judge, was NOT clear-relevant
    expect(isApprovableFloored(out)).toBe(true);
    expect(out.provenance.validated_against).toContain(INTERNAL_OPS_MARKER);
  });

  it("still clear-relevants a genuine HTTP status in real context ('returns 401' / '401 error code') WITHOUT calling the judge", async () => {
    // Finding 4 guardrail: tightening STATUS_VERB must PRESERVE real HTTP-status
    // true-positives. A status verb ("returns 401") and the "error code"/"status
    // code" noun phrase (in either order) are genuine HTTP context and must
    // still take the clear-relevant bypass on a clear-relevant knowledge_type.
    for (const content of [
      "The admin endpoint returns 401 when the token is missing.",
      "A stale token yields a 401 error code the client must refetch on.",
    ]) {
      const cand = makeCandidate({
        title: "HTTP status contract",
        content,
        knowledge_type: "protocol",
        subsystem: "runtime",
      });
      const [out] = await enforceAudienceRelevance([cand], {
        judge: throwingJudge,
      });
      expect(isApprovableFloored(out)).toBe(false);
      expect(out.needsReview).toBe(false);
    }
  });

  it("still clear-relevants a genuine API-call product-portable specific (useCoAgent(...) / runHarvest(...)) WITHOUT calling the judge", async () => {
    for (const content of [
      "Register the agent with `useCoAgent({ name })` on the client.",
      "The harvest driver entrypoint is runHarvest(opts) — call it per run.",
    ]) {
      const cand = makeCandidate({
        title: "API usage",
        content,
        knowledge_type: "protocol",
        subsystem: "runtime",
      });
      const [out] = await enforceAudienceRelevance([cand], {
        judge: throwingJudge,
      });
      expect(isApprovableFloored(out)).toBe(false);
      expect(out.needsReview).toBe(false);
    }
  });
});

describe("enforceAudienceRelevance — injected judge path", () => {
  it("sets needsReview for a borderline judge verdict", async () => {
    // A candidate that clears NEITHER pre-screen (process knowledge_type, no
    // deploy vocab, no infra subsystem, not a clear-relevant knowledge_type) so
    // it falls through to the injected judge.
    const judge = fakeJudge({
      kind: "borderline",
      reason: "advanced internals",
    });
    const cand = makeCandidate({
      title: "How the harvest run bookkeeping works",
      content:
        "The harvest driver tracks per-run bookkeeping for the pipeline.",
      knowledge_type: "process",
      subsystem: "harvest",
    });
    const [out] = await enforceAudienceRelevance([cand], { judge });
    expect(judge.calls).toBe(1);
    expect(out.needsReview).toBe(true);
    // Borderline does NOT floor approvable.
    expect(isApprovableFloored(out)).toBe(false);
  });

  it("stamps INTERNAL_OPS_MARKER and floors approvable for an internal-ops judge verdict", async () => {
    const judge = fakeJudge({
      kind: "internal-ops",
      reason: "pure deploy log",
    });
    const cand = makeCandidate({
      title: "PR closeout bookkeeping",
      content: "PR #142 shipped X and the closeout note was filed.",
      knowledge_type: "process",
      subsystem: "harvest",
    });
    const [out] = await enforceAudienceRelevance([cand], { judge });
    expect(judge.calls).toBe(1);
    expect(out.provenance.validated_against).toContain(INTERNAL_OPS_MARKER);
    // The marker must be READ by the shared S0 floor predicate, not just written.
    expect(isApprovableFloored(out)).toBe(true);
  });

  // ── Finding 2: verdict-flip hygiene — a candidate a PRIOR run scoped to
  //    internal-ops carries INTERNAL_OPS_MARKER; a re-run that flips it to
  //    relevant/borderline must STRIP the stale marker so it is not
  //    stale-floored forever (mirrors distillation-gate's stripRestatementMarker).
  it("strips a stale INTERNAL_OPS_MARKER when a re-run judges the candidate relevant", async () => {
    const judge = fakeJudge({ kind: "relevant" });
    const cand = makeCandidate({
      title: "Now-relevant claim",
      content: "Some prose the pre-screen cannot classify, judged relevant.",
      knowledge_type: "process",
      subsystem: "harvest",
    });
    // Simulate the prior run's internal-ops stamp already on the carrier.
    cand.provenance.validated_against = INTERNAL_OPS_MARKER;
    const [out] = await enforceAudienceRelevance([cand], { judge });
    expect(judge.calls).toBe(1);
    expect(isApprovableFloored(out)).toBe(false);
    expect(out.provenance.validated_against ?? "").not.toContain(
      INTERNAL_OPS_MARKER,
    );
  });

  it("strips a stale INTERNAL_OPS_MARKER when a re-run judges the candidate borderline (preserving co-resident tokens)", async () => {
    const judge = fakeJudge({ kind: "borderline", reason: "some utility" });
    const cand = makeCandidate({
      title: "Now-borderline claim",
      content: "Some prose the pre-screen cannot classify, judged borderline.",
      knowledge_type: "process",
      subsystem: "harvest",
    });
    // A co-resident, unrelated token must survive; only the stale floor goes.
    cand.provenance.validated_against = `${INTERNAL_OPS_MARKER}; some-other-token`;
    const [out] = await enforceAudienceRelevance([cand], { judge });
    expect(judge.calls).toBe(1);
    expect(out.needsReview).toBe(true);
    expect(isApprovableFloored(out)).toBe(false);
    expect(out.provenance.validated_against ?? "").not.toContain(
      INTERNAL_OPS_MARKER,
    );
    expect(out.provenance.validated_against).toContain("some-other-token");
  });

  // ── Finding (conf 80): the stale-marker strip must be DUAL-CARRIER. The S0
  //    floor predicate (hasFloorMarker) reads INTERNAL_OPS_MARKER from EITHER
  //    `provenance.validated_against` OR a `fused_from` evidence ref. A prior run
  //    can stamp the marker on the fused_from carrier (an idiom the S0 marker
  //    supports); a re-run that flips the candidate to relevant/borderline must
  //    un-floor it on BOTH carriers, or the "applied UNIFORMLY … no verdict-flip
  //    path can leave a stale floor" invariant is not delivered.
  it("strips a stale INTERNAL_OPS_MARKER carried as a fused_from evidence ref when a re-run judges the candidate relevant", async () => {
    const judge = fakeJudge({ kind: "relevant" });
    const cand = makeCandidate({
      title: "Now-relevant claim (fused_from carrier)",
      content: "Some prose the pre-screen cannot classify, judged relevant.",
      knowledge_type: "process",
      subsystem: "harvest",
    });
    // Prior run stamped the floor marker on the fused_from evidence carrier.
    cand.evidence = [{ kind: "fused_from", ref: INTERNAL_OPS_MARKER }];
    const [out] = await enforceAudienceRelevance([cand], { judge });
    expect(judge.calls).toBe(1);
    // Must un-floor on BOTH carriers.
    expect(isApprovableFloored(out)).toBe(false);
    expect(
      out.evidence.some(
        (e) => e.kind === "fused_from" && e.ref === INTERNAL_OPS_MARKER,
      ),
    ).toBe(false);
  });

  it("strips a stale INTERNAL_OPS_MARKER fused_from ref when a re-run judges the candidate borderline (preserving co-resident evidence)", async () => {
    const judge = fakeJudge({ kind: "borderline", reason: "some utility" });
    const cand = makeCandidate({
      title: "Now-borderline claim (fused_from carrier)",
      content: "Some prose the pre-screen cannot classify, judged borderline.",
      knowledge_type: "process",
      subsystem: "harvest",
    });
    // A co-resident, unrelated fused_from ref must survive; only the floor goes.
    cand.evidence = [
      { kind: "fused_from", ref: INTERNAL_OPS_MARKER },
      { kind: "fused_from", ref: "some-other-ref" },
      { kind: "changed_file", path: "src/atlas/audience-gate.ts" },
    ];
    const [out] = await enforceAudienceRelevance([cand], { judge });
    expect(judge.calls).toBe(1);
    expect(out.needsReview).toBe(true);
    expect(isApprovableFloored(out)).toBe(false);
    expect(
      out.evidence.some(
        (e) => e.kind === "fused_from" && e.ref === INTERNAL_OPS_MARKER,
      ),
    ).toBe(false);
    // Co-resident evidence survives (whole-ref match, no over-strip).
    expect(
      out.evidence.some(
        (e) => e.kind === "fused_from" && e.ref === "some-other-ref",
      ),
    ).toBe(true);
    expect(
      out.evidence.some(
        (e) =>
          e.kind === "changed_file" && e.path === "src/atlas/audience-gate.ts",
      ),
    ).toBe(true);
  });
});

describe("enforceAudienceRelevance — NEVER-DROP contract", () => {
  it("returns a same-length, same-order output and never mutates the input", async () => {
    const judge = fakeJudge({ kind: "relevant" });
    const inputs = [
      makeCandidate({
        title: "Redeployed web",
        content: "We redeployed the web service on Railway.",
        knowledge_type: "operational",
        subsystem: "railway-web",
      }),
      makeCandidate({
        title: "POST /admin/reindex returns 401 unauthenticated",
        content: "POST /admin/reindex returns 401 when unauthenticated.",
        knowledge_type: "architecture",
        subsystem: "runtime",
      }),
      makeCandidate({
        title: "Fall-through to the judge",
        content: "Some prose the pre-screen cannot classify.",
        knowledge_type: "process",
        subsystem: "harvest",
      }),
    ];
    const before = inputs.map((c) => c.canonical_key);
    const out = await enforceAudienceRelevance(inputs, { judge });
    expect(out).toHaveLength(inputs.length);
    expect(out.map((c) => c.canonical_key)).toEqual(before);
    // Input candidates are not mutated in place (fresh objects returned).
    expect(inputs[0]?.provenance.validated_against).toBeUndefined();
  });
});
