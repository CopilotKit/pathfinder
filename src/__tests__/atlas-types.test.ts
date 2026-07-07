import { describe, it, expect } from "vitest";
import {
  CandidateFragmentSchema,
  CandidateSchema,
  ProvenanceSchema,
  EvidenceItemSchema,
  KnowledgeType,
  BEHAVIOR_KNOWLEDGE_TYPES,
  RESTATEMENT_MARKER,
  buildCanonicalKey,
  parseCanonicalKey,
  mostRestrictiveSensitivity,
  compareDatesDesc,
  toSeedEntryRow,
} from "../atlas/types.js";
import type {
  Candidate,
  Sensitivity,
  KnowledgeType as KnowledgeTypeT,
  DistillationVerdict,
} from "../atlas/types.js";
// Type-only import: this slot has NO runtime DB. The `satisfies` assertions in
// the toSeedEntryRow tests prove (at COMPILE time) that the harvest output
// conforms to the REAL storage-layer input shape.
import { z } from "zod";
import type { UpsertAtlasSeedCandidateInput } from "../db/atlas.js";

// ── Spec §12 worked example rows (verbatim JSONB shapes) ──────────────────────
// These are the eight reviewer-ready rows from spec §12.1–§12.8 of
// 2026-06-08-atlas-seed-strategy.md. They are storage-layer rows
// (AtlasSeedEntry-shaped): canonical_key / source_name / repo_url / ref /
// subsystem / title / content / provenance{...,classification} / evidence[] /
// status. Parsing their `provenance` through ProvenanceSchema and their
// `evidence` through EvidenceItemSchema verbatim is the strongest guarantee
// that harvest output is byte-compatible with the existing storage layer.

const ROW_12_1 = {
  canonical_key: "derived:agui-adk:occ-concurrency-handling",
  source_name: "github-saga",
  repo_url: "https://github.com/ag-ui-protocol/ag-ui",
  ref: "main",
  subsystem: "agui-adk",
  title:
    "ADK integration uses optimistic concurrency control on agent-run state; concurrent updates retry rather than lock",
  content:
    "The ADK integration adopted optimistic concurrency control (OCC) for agent-run state after a class of lost-update bugs. Concurrent state mutations detect a version conflict and retry rather than holding a lock, trading a small retry cost for deadlock-freedom. This is why ADK run-state writes are version-checked and idempotent, and why callers must tolerate a retried apply.",
  provenance: {
    source: "github-saga",
    url: "https://github.com/ag-ui-protocol/ag-ui/issues/1732",
    date: "2026-05-12",
    validated_against:
      "showcase/integrations/google-adk (manifest.yaml) + D6 pill green",
    classification: {
      sensitivity: "internal",
      knowledge_type: "architecture",
      audience: "all-staff",
      validation_status: "showcase-verified",
      confidence: "high",
      provenance_class: "derived",
      freshness: { as_of: "2026-05-12", re_verify_by: "2026-09-12" },
    },
  },
  evidence: [
    { kind: "linked_issue", url: "issues/1732" },
    { kind: "fused_from", ref: "github-issue:agui-adk:1732" },
    { kind: "fused_from", ref: "github-pr:agui-adk:1746" },
    { kind: "fused_from", ref: "github-issue:agui-adk:1753" },
    { kind: "fused_from", ref: "github-issue:agui-adk:1754" },
    {
      kind: "thread",
      body: "root-cause narrative in #1732; #1754 notes 'same OCC shape'",
    },
  ],
  status: "pending",
};

const ROW_12_2 = {
  canonical_key:
    "derived:cpk-react-core:coagent-state-render-messageid-binding",
  source_name: "source-comment",
  repo_url: "https://github.com/CopilotKit/CopilotKit",
  ref: "main",
  subsystem: "cpk-react-core",
  title:
    "Co-agent state-render output is bound to the triggering messageId so re-renders stay attached to the correct message",
  content:
    "The state-render bridge binds each render to the messageId that triggered it. Without this binding, asynchronous state updates would re-render against the wrong message as the conversation advances, detaching custom UI from its message. This is an intentional coupling, not an incidental one.",
  provenance: {
    source: "source-comment",
    url: "https://github.com/CopilotKit/CopilotKit/blob/main/packages/react-core/src/hooks/use-coagent-state-render-bridge.tsx#L24-L45",
    date: "2026-06-08",
    validated_against:
      "packages/react-core/.../use-coagent-state-render-bridge.tsx:24-45",
    classification: {
      sensitivity: "internal",
      knowledge_type: "architecture",
      audience: "engineering",
      validation_status: "source-verified",
      confidence: "high",
      provenance_class: "derived",
      freshness: { as_of: "2026-06-08", re_verify_by: "2026-09-08" },
    },
  },
  evidence: [
    {
      kind: "changed_file",
      path: "packages/react-core/.../use-coagent-state-render-bridge.tsx:24-45",
    },
    {
      kind: "changed_file",
      path: "packages/react-core/.../use-copilot-action.ts:222",
    },
    {
      kind: "changed_file",
      path: "packages/react-core/.../use-frontend-tool.ts:93",
    },
  ],
  status: "pending",
};

const ROW_12_3 = {
  canonical_key: "derived:agui-protocol:interrupt-terminal-run-lifecycle",
  source_name: "concept-doc",
  repo_url: "https://github.com/ag-ui-protocol/ag-ui",
  ref: "main",
  subsystem: "agui-protocol",
  title:
    "An interrupt terminates the current run lifecycle; resumption is a NEW run, not a continuation of the interrupted one",
  content:
    "In the AG-UI protocol an interrupt is terminal for the in-flight run: the run lifecycle ends, and resuming proceeds as a new run. The client verify state machine enforces this — events after a terminal interrupt belong to the next run. This is why integrations must not append events to an interrupted run and must re-establish run context on resume.",
  provenance: {
    source: "concept-doc",
    url: "https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/concepts/interrupts.mdx",
    date: "2026-06-08",
    validated_against:
      "client/verify/verify.ts (terminal-run-lifecycle invariant)",
    classification: {
      sensitivity: "public",
      knowledge_type: "protocol",
      audience: "all-staff",
      validation_status: "source-verified",
      confidence: "high",
      provenance_class: "derived",
      freshness: { as_of: "2026-06-08", re_verify_by: "2026-09-08" },
    },
  },
  evidence: [
    { kind: "changed_file", path: "docs/concepts/interrupts.mdx" },
    { kind: "changed_file", path: "client/verify/verify.ts" },
    { kind: "fused_from", ref: "concept-doc:agui-protocol:interrupts" },
    {
      kind: "fused_from",
      ref: "source-comment:agui-protocol:verify-state-machine",
    },
  ],
  status: "pending",
};

const ROW_12_4 = {
  canonical_key: "memory:testing-sse:buffer-replay-timing-invariant",
  source_name: "memory-store",
  repo_url: "https://github.com/ag-ui-protocol/ag-ui",
  ref: "main",
  subsystem: "testing-sse",
  title:
    "A buffered-then-dumped SSE stream is byte-identical to a truly streamed one; assert wall-clock spread, not payload, to prove streaming",
  content:
    "When testing streaming via aimock, a response that is buffered and then dumped all at once is byte-for-byte identical to one that was genuinely streamed token-by-token. Payload assertions therefore cannot prove streaming behavior. The correct invariant is to assert the wall-clock spread between chunk arrivals — genuine streaming shows temporal spacing; a buffered dump arrives in one burst. This is why streaming tests assert timing, not bytes.",
  provenance: {
    source: "memory-store",
    url: "file:///Users/jpr5/.local/share/copilotkit/memory/store/feedback_streaming_tests_assert_timing.md",
    date: "2026-05-30",
    validated_against: "aimock streaming harness (wall-clock spread assertion)",
    classification: {
      sensitivity: "internal",
      knowledge_type: "operational",
      audience: "engineering",
      validation_status: "source-verified",
      confidence: "high",
      provenance_class: "primary",
      freshness: { as_of: "2026-05-30", re_verify_by: "2026-11-30" },
    },
  },
  evidence: [
    { kind: "thread", body: "feedback_streaming_tests_assert_timing" },
  ],
  status: "pending",
};

const ROW_12_5 = {
  canonical_key:
    "github-pr:cpk-runtime:copilotruntime-two-layer-shim-to-v2-engine",
  source_name: "github-pr",
  repo_url: "https://github.com/CopilotKit/CopilotKit",
  ref: "main",
  subsystem: "cpk-runtime",
  title:
    "@copilotkit/runtime's public CopilotRuntime is a two-layer compat shim: public CopilotRuntime (lib/runtime) -> v2 CopilotRuntime (v2/runtime/core/runtime.ts:348, itself a shim) -> CopilotSseRuntime/CopilotIntelligenceRuntime engines",
  content:
    "The runtime is a TWO-LAYER compatibility-shim chain. The public CopilotRuntime export in packages/runtime/src/lib/runtime/copilot-runtime.ts is a compat shim that delegates to the v2 CopilotRuntime at packages/runtime/src/v2/runtime/core/runtime.ts:348. That v2 CopilotRuntime is ITSELF a compat shim — it selects the real engines, CopilotSseRuntime and CopilotIntelligenceRuntime. So the delegation chain is: public CopilotRuntime -> v2 CopilotRuntime (a shim) -> CopilotSseRuntime / CopilotIntelligenceRuntime (the real engines). STALE-TERM WARNING: 'CopilotNext' is NOT a live code symbol (0 source-symbol hits; it appears only in historical CHANGELOG entries under packages/react-core/CHANGELOG.md and packages/runtime/CHANGELOG.md), and 'CopilotRuntimeVNext' is an internal import alias appearing in exactly one file (lib/runtime/copilot-runtime.ts) — it is NOT a package, export, or architectural tier. Do not describe the runtime using either term. Validation against current source corrected three stale artifacts that each got this wrong: a Notion audit doc, a local branch, and the copilotkit-dev-workflow skill (which still markets 'V1-wraps-V2').",
  provenance: {
    source: "github-pr",
    url: "https://github.com/CopilotKit/CopilotKit/blob/main/packages/runtime/src/v2/runtime/core/runtime.ts#L348",
    date: "2026-06-08",
    validated_against:
      "packages/runtime/src/v2/runtime/core/runtime.ts:348 (grep on freshly-fetched origin/main)",
    classification: {
      sensitivity: "internal",
      knowledge_type: "architecture",
      audience: "engineering",
      validation_status: "source-verified",
      confidence: "high",
      provenance_class: "primary",
      freshness: { as_of: "2026-06-08", re_verify_by: "2026-09-08" },
    },
  },
  evidence: [
    {
      kind: "changed_file",
      path: "packages/runtime/src/lib/runtime/copilot-runtime.ts",
    },
    {
      kind: "changed_file",
      path: "packages/runtime/src/v2/runtime/core/runtime.ts:348",
    },
    {
      kind: "thread",
      body: "CopilotNext = 0 source-symbol hits (CHANGELOG-only, 2 files); CopilotRuntimeVNext = 6 hits in one file (alias only); v2 CopilotRuntime at runtime.ts:348 is itself a shim selecting CopilotSseRuntime/CopilotIntelligenceRuntime; v2/ is a real current dir",
    },
  ],
  status: "pending",
};

const ROW_12_6 = {
  canonical_key:
    "notion-doc:agui-protocol:interrupt-resume-via-interruptid-not-parentrunid",
  source_name: "notion-doc",
  repo_url: "https://github.com/ag-ui-protocol/ag-ui",
  ref: "main",
  subsystem: "agui-protocol",
  title:
    "Interrupt resume links via interruptId, NOT parentRunId — parentRunId is a branching primitive and would conflate resume with branch",
  content:
    "The Interrupts design decided that a resume is linked to its interrupt via interruptId rather than parentRunId. parentRunId is a branching primitive (it expresses run lineage / forking); reusing it for resume would conflate 'continue this interrupted run' with 'branch from this run', breaking both semantics. interruptId is therefore the resume handle. Rejected alternative: link resume via parentRunId (rejected for the conflation above).",
  provenance: {
    source: "notion-doc",
    url: "https://www.notion.so/copilotkit/Interrupts-Proposal-Design-Decisions-Reasoning",
    date: "2026-04-18",
    validated_against:
      "ag-ui interrupt resume path (interruptId handle on main)",
    classification: {
      sensitivity: "internal",
      knowledge_type: "design-rationale",
      audience: "engineering",
      validation_status: "source-verified",
      confidence: "high",
      provenance_class: "primary",
      freshness: { as_of: "2026-04-18", re_verify_by: "2026-09-08" },
    },
  },
  evidence: [
    {
      kind: "thread",
      body: "Interrupts Proposal — Design Decisions & Reasoning (decision: resume keying)",
    },
    { kind: "fused_from", ref: "notion-doc:agui-protocol:interrupts-adr" },
  ],
  status: "pending",
};

const ROW_12_7 = {
  canonical_key: "memory:railway-deploy:image-entrypoint-shell-escape",
  source_name: "memory-store",
  repo_url: "https://github.com/CopilotKit/pathfinder",
  ref: "main",
  subsystem: "railway-deploy",
  title:
    "Railway image entrypoints must escape shell metacharacters; an unescaped value in the start command silently breaks the boot",
  content:
    "When configuring a Railway service start command from an image, shell metacharacters in the value must be escaped — an unescaped character is interpreted by the shell and silently breaks the container boot rather than failing loudly. This is why pathfinder's Railway start command quotes/escapes its arguments. Operational fact, version-pinned to the documented incident.",
  provenance: {
    source: "memory-store",
    url: "file:///Users/jpr5/.local/share/copilotkit/memory/store/feedback_railway_image_shell_escape.md",
    date: "2026-05-15",
    validated_against:
      "pathfinder Railway service config (escaped start command)",
    classification: {
      sensitivity: "internal",
      knowledge_type: "operational",
      audience: "engineering",
      validation_status: "source-verified",
      confidence: "high",
      provenance_class: "primary",
      freshness: { as_of: "2026-05-15", re_verify_by: "2026-11-15" },
    },
  },
  evidence: [{ kind: "thread", body: "feedback_railway_image_shell_escape" }],
  status: "pending",
};

const ROW_12_8 = {
  canonical_key: "github-pr:pathfinder-auth:ratification-single-bearer-token",
  source_name: "github-pr",
  repo_url: "https://github.com/CopilotKit/pathfinder",
  ref: "main",
  subsystem: "pathfinder-auth",
  title:
    "Atlas candidate ratification and admin reindex share ONE bearer token (ANALYTICS_TOKEN); actor identity is carried separately via X-Atlas-Actor",
  content:
    "The Atlas admin surface (candidate approve/reject, reindex, index-stats) is gated by a single bearer token reused from analytics (ANALYTICS_TOKEN) rather than a dedicated Atlas credential. Reviewer identity is NOT derived from the token — it is passed explicitly in the X-Atlas-Actor header and recorded in the approval-audit columns. This is a deliberate simplification: one secret to manage, with audit attribution decoupled from authentication. A future hardening would split the token per-capability.",
  provenance: {
    source: "github-pr",
    url: "https://github.com/CopilotKit/pathfinder/pull/98",
    date: "2026-06-08",
    validated_against: "src/db/atlas.ts:368-415 (pending-guard) on origin/main",
    classification: {
      sensitivity: "internal",
      knowledge_type: "security",
      audience: "engineering",
      validation_status: "source-verified",
      confidence: "high",
      provenance_class: "primary",
      freshness: { as_of: "2026-06-08", re_verify_by: "2026-09-08" },
    },
  },
  evidence: [
    { kind: "changed_file", path: "src/db/atlas.ts:368-415" },
    { kind: "changed_file", path: "src/db/atlas.ts:607-700" },
    { kind: "linked_issue", url: "PR #97" },
    {
      kind: "thread",
      body: "approve/reject guard on status='pending' -> 409 AtlasSeedNotPendingError",
    },
  ],
  status: "pending",
};

const WORKED_ROWS = [
  { name: "12.1 ag-ui ADK OCC saga", row: ROW_12_1 },
  { name: "12.2 react-core state-render-bridge", row: ROW_12_2 },
  { name: "12.3 ag-ui interrupt terminal-run-lifecycle", row: ROW_12_3 },
  { name: "12.4 aimock SSE buffer-replay-timing", row: ROW_12_4 },
  { name: "12.5 CopilotRuntime two-layer shim", row: ROW_12_5 },
  { name: "12.6 Notion ADR interrupt resume keying", row: ROW_12_6 },
  { name: "12.7 Railway operational fact", row: ROW_12_7 },
  { name: "12.8 Pathfinder ratification-auth", row: ROW_12_8 },
] as const;

// Promote a §12 storage-layer row to a full Tier-3 Candidate by supplying the
// harvest-only fields the storage row does not carry (sourcetype, rankScore,
// approvable). The first segment of the canonical_key is the sourcetype.
function rowToCandidateInput(row: (typeof WORKED_ROWS)[number]["row"]) {
  const sourcetype = row.canonical_key.split(":")[0];
  return {
    sourcetype,
    subsystem: row.subsystem,
    source_name: row.source_name,
    repo_url: row.repo_url,
    ref: row.ref,
    title: row.title,
    content: row.content,
    provenance: row.provenance,
    evidence: row.evidence,
    canonical_key: row.canonical_key,
    rankScore: 1,
    approvable: true,
  };
}

describe("ProvenanceSchema (spec §12 provenance round-trip)", () => {
  it.each(WORKED_ROWS)(
    "parses the provenance of $name verbatim (byte-compatible)",
    ({ row }) => {
      const parsed = ProvenanceSchema.parse(row.provenance);
      // Re-serializing the parsed provenance must equal the original JSONB blob
      // exactly — this is what the storage layer persists and reads back.
      expect(parsed).toEqual(row.provenance);
    },
  );

  it("requires the classification sub-object", () => {
    const { classification, ...withoutClassification } = ROW_12_1.provenance;
    expect(() => ProvenanceSchema.parse(withoutClassification)).toThrow();
  });
});

describe("EvidenceItemSchema (spec §12 evidence array round-trip)", () => {
  it.each(WORKED_ROWS)(
    "parses every evidence item of $name verbatim",
    ({ row }) => {
      const parsed = z.array(EvidenceItemSchema).parse(row.evidence);
      expect(parsed).toEqual(row.evidence);
    },
  );

  it("accepts all four evidence kinds", () => {
    expect(
      EvidenceItemSchema.parse({ kind: "changed_file", path: "a/b.ts" }),
    ).toEqual({ kind: "changed_file", path: "a/b.ts" });
    expect(
      EvidenceItemSchema.parse({ kind: "linked_issue", url: "issues/1" }),
    ).toEqual({ kind: "linked_issue", url: "issues/1" });
    expect(EvidenceItemSchema.parse({ kind: "thread", body: "hi" })).toEqual({
      kind: "thread",
      body: "hi",
    });
    expect(
      EvidenceItemSchema.parse({ kind: "fused_from", ref: "x:y:z" }),
    ).toEqual({ kind: "fused_from", ref: "x:y:z" });
  });

  it("rejects an unknown evidence kind", () => {
    expect(() =>
      EvidenceItemSchema.parse({ kind: "screenshot", url: "x" }),
    ).toThrow();
  });
});

describe("CandidateSchema (spec §12 rows as Tier-3 candidates)", () => {
  it.each(WORKED_ROWS)("accepts a Candidate built from $name", ({ row }) => {
    const candidate = CandidateSchema.parse(rowToCandidateInput(row));
    expect(candidate.canonical_key).toBe(row.canonical_key);
    expect(candidate.source_name).toBe(row.source_name);
    expect(candidate.provenance).toEqual(row.provenance);
    expect(candidate.evidence).toEqual(row.evidence);
  });

  it("defaults audience to all-staff inside classification", () => {
    const prov = {
      source: "x",
      classification: {
        sensitivity: "internal",
        knowledge_type: "architecture",
        validation_status: "unverified",
        confidence: "low",
        provenance_class: "derived",
        freshness: { as_of: "2026-06-08" },
      },
    };
    const parsed = ProvenanceSchema.parse(prov);
    expect(parsed.classification.audience).toBe("all-staff");
  });

  it("defaults evidence/needsReview/validationTargets on a fragment", () => {
    const candidate = CandidateSchema.parse({
      sourcetype: "memory",
      subsystem: "testing-sse",
      source_name: "memory-store",
      title: "t",
      content: "c",
      provenance: ROW_12_4.provenance,
      canonical_key: "memory:testing-sse:x",
      rankScore: 0,
      approvable: false,
    });
    expect(candidate.evidence).toEqual([]);
    expect(candidate.needsReview).toBe(false);
    expect(candidate.validationTargets).toEqual([]);
  });

  it("rejects an unknown sourcetype", () => {
    expect(() =>
      CandidateSchema.parse({
        ...rowToCandidateInput(ROW_12_1),
        sourcetype: "twitter",
      }),
    ).toThrow();
  });
});

describe("buildCanonicalKey / parseCanonicalKey", () => {
  it("builds <sourcetype>:<subsystem>:<claim-slug>", () => {
    expect(
      buildCanonicalKey("derived", "agui-adk", "occ-concurrency-handling"),
    ).toBe("derived:agui-adk:occ-concurrency-handling");
  });

  it("parses back to the three components (inverse round-trip)", () => {
    const key = "derived:agui-adk:occ-concurrency-handling";
    const parts = parseCanonicalKey(key);
    expect(parts).toEqual({
      sourcetype: "derived",
      subsystem: "agui-adk",
      claimSlug: "occ-concurrency-handling",
    });
    expect(
      buildCanonicalKey(parts.sourcetype, parts.subsystem, parts.claimSlug),
    ).toBe(key);
  });

  it("round-trips every §12 canonical_key", () => {
    for (const { row } of WORKED_ROWS) {
      const parts = parseCanonicalKey(row.canonical_key);
      expect(
        buildCanonicalKey(parts.sourcetype, parts.subsystem, parts.claimSlug),
      ).toBe(row.canonical_key);
    }
  });

  it("preserves a claim-slug that itself contains a colon (key has >3 segments)", () => {
    const key = parseCanonicalKey("github-pr:cpk-runtime:two-layer:shim");
    expect(key.sourcetype).toBe("github-pr");
    expect(key.subsystem).toBe("cpk-runtime");
    expect(key.claimSlug).toBe("two-layer:shim");
    expect(
      buildCanonicalKey(key.sourcetype, key.subsystem, key.claimSlug),
    ).toBe("github-pr:cpk-runtime:two-layer:shim");
  });
});

describe("mostRestrictiveSensitivity", () => {
  const order: Sensitivity[] = ["public", "internal", "proprietary", "secret"];

  it("returns the more restrictive of two values (ordering public<internal<proprietary<secret)", () => {
    expect(mostRestrictiveSensitivity("public", "internal")).toBe("internal");
    expect(mostRestrictiveSensitivity("internal", "public")).toBe("internal");
    expect(mostRestrictiveSensitivity("internal", "proprietary")).toBe(
      "proprietary",
    );
    expect(mostRestrictiveSensitivity("proprietary", "secret")).toBe("secret");
    expect(mostRestrictiveSensitivity("public", "secret")).toBe("secret");
  });

  it("is commutative across every pair", () => {
    for (const a of order) {
      for (const b of order) {
        expect(mostRestrictiveSensitivity(a, b)).toBe(
          mostRestrictiveSensitivity(b, a),
        );
      }
    }
  });

  it("is idempotent for equal inputs", () => {
    for (const s of order) {
      expect(mostRestrictiveSensitivity(s, s)).toBe(s);
    }
  });
});

describe("compareDatesDesc (deterministic date recency)", () => {
  it("returns exactly 0 for two undated/unparseable inputs (stable sort)", () => {
    // (-Infinity) - (-Infinity) is NaN; a NaN comparator makes Array.sort
    // implementation-defined. The helper exists to guarantee determinism, so
    // both-undated MUST compare as exactly 0.
    expect(compareDatesDesc(undefined, undefined)).toBe(0);
    expect(compareDatesDesc("not-a-date", "also-not-a-date")).toBe(0);
    expect(compareDatesDesc(undefined, "garbage")).toBe(0);
  });

  it("orders a dated value before an undated one (dated is newer)", () => {
    // Descending: a dated value must sort before (negative result) an undated.
    expect(compareDatesDesc("2026-06-09", undefined)).toBeLessThan(0);
    expect(compareDatesDesc(undefined, "2026-06-09")).toBeGreaterThan(0);
  });

  it("orders the newer of two dated values first", () => {
    expect(compareDatesDesc("2026-06-09", "2026-01-01")).toBeLessThan(0);
    expect(compareDatesDesc("2026-01-01", "2026-06-09")).toBeGreaterThan(0);
  });

  it("returns 0 for equal dates", () => {
    expect(compareDatesDesc("2026-06-09", "2026-06-09")).toBe(0);
  });

  it("never returns NaN for any pair (sort determinism invariant)", () => {
    const inputs: (string | undefined)[] = [
      undefined,
      "garbage",
      "2026-06-09",
      "2026-01-01T00:00:00Z",
    ];
    for (const a of inputs) {
      for (const b of inputs) {
        expect(Number.isNaN(compareDatesDesc(a, b))).toBe(false);
      }
    }
  });
});

describe("buildCanonicalKey delimiter validation", () => {
  it("throws when sourcetype contains a ':' (structural delimiter)", () => {
    expect(() => buildCanonicalKey("github:pr", "agui-adk", "occ")).toThrow();
  });

  it("throws when subsystem contains a ':' (structural delimiter)", () => {
    expect(() => buildCanonicalKey("github-pr", "agui:adk", "occ")).toThrow();
  });

  it("still allows (and round-trips) a claim-slug containing ':'", () => {
    const key = buildCanonicalKey("github-pr", "cpk-runtime", "two-layer:shim");
    expect(key).toBe("github-pr:cpk-runtime:two-layer:shim");
    const parts = parseCanonicalKey(key);
    expect(parts).toEqual({
      sourcetype: "github-pr",
      subsystem: "cpk-runtime",
      claimSlug: "two-layer:shim",
    });
  });

  // The Notion approval-marker delimiters '⟦'/'⟧' (U+27E6/U+27E7) corrupt the
  // marker round-trip wherever they land in the key — extractCanonicalKey
  // slices the embedded key at the first '⟧' — so unlike ':', they are
  // forbidden in ALL THREE components, including the claim-slug.
  it("throws when sourcetype contains '⟦' (approval-marker delimiter)", () => {
    expect(() => buildCanonicalKey("a⟦b", "x", "y")).toThrow(/approval-marker/);
  });

  it("throws when subsystem contains '⟧' (approval-marker delimiter)", () => {
    expect(() => buildCanonicalKey("github-pr", "agui⟧adk", "occ")).toThrow(
      /approval-marker/,
    );
  });

  it("throws when the claim-slug contains '⟧' (approval-marker delimiter — the ':' allowance does NOT extend here)", () => {
    expect(() => buildCanonicalKey("github-pr", "auth", "a⟧b")).toThrow(
      /approval-marker/,
    );
  });

  it("throws when the claim-slug contains '⟦' (approval-marker delimiter)", () => {
    expect(() => buildCanonicalKey("github-pr", "auth", "a⟦b")).toThrow(
      /approval-marker/,
    );
  });
});

describe("CandidateFragmentSchema subsystem delimiter guard (fail-loud at intake)", () => {
  // A minimal valid fragment (the §12 rows are storage-layer rows, not fragments;
  // build a fragment shape directly so the subsystem can be varied).
  function fragmentInput(subsystem: string) {
    return {
      sourcetype: "github-pr",
      subsystem,
      source_name: "CopilotKit/pathfinder",
      title: "claim",
      content: "why/how prose",
      provenance: ROW_12_4.provenance,
    };
  }

  // The canonical-key delimiter is ':'. Adapters set `subsystem` directly on the
  // fragment, so a ':' must be rejected at INTAKE (where the producer is
  // identifiable) rather than blowing up later at canonicalization.
  it("rejects a fragment whose subsystem contains a ':'", () => {
    expect(() =>
      CandidateFragmentSchema.parse(fragmentInput("agui:adk")),
    ).toThrow();
  });

  it("accepts the colon-free subsystems used by existing fixtures", () => {
    for (const sub of ["agui-adk", "cpk-react-core", "org/repo"]) {
      expect(() =>
        CandidateFragmentSchema.parse(fragmentInput(sub)),
      ).not.toThrow();
    }
  });

  // The Notion approval-marker delimiters '⟦'/'⟧' (U+27E6/U+27E7) are equally
  // structural: extractCanonicalKey slices the embedded key at the first '⟧'
  // after the open marker, so either character inside subsystem truncates the
  // parsed key on the round-trip → permanent idempotent-409 conflict.
  it("rejects a fragment whose subsystem contains '⟦' or '⟧' (approval-marker delimiters)", () => {
    for (const sub of ["a⟦b", "a⟧b"]) {
      expect(() => CandidateFragmentSchema.parse(fragmentInput(sub))).toThrow(
        /approval-marker/,
      );
    }
  });

  it("propagates the marker-delimiter guard to CandidateSchema", () => {
    expect(() =>
      CandidateSchema.parse({
        ...rowToCandidateInput(ROW_12_1),
        subsystem: "a⟧b",
      }),
    ).toThrow();
  });

  it("propagates the guard to CandidateSchema (which extends the fragment)", () => {
    expect(() =>
      CandidateSchema.parse({
        ...rowToCandidateInput(ROW_12_1),
        subsystem: "agui:adk",
      }),
    ).toThrow();
  });
});

describe("toSeedEntryRow (compile-time conformance to UpsertAtlasSeedCandidateInput)", () => {
  it.each(WORKED_ROWS)(
    "maps $name snake_case fields to the camelCase storage input",
    ({ row }) => {
      const candidate = CandidateSchema.parse(rowToCandidateInput(row));
      // COMPILE-TIME conformance: the return type must satisfy the REAL
      // storage-layer input interface (type-only import, no runtime DB).
      const seedRow = toSeedEntryRow(
        candidate,
      ) satisfies UpsertAtlasSeedCandidateInput;
      expect(seedRow.canonicalKey).toBe(row.canonical_key);
      expect(seedRow.sourceName).toBe(row.source_name);
      expect(seedRow.repoUrl).toBe(row.repo_url);
      expect(seedRow.ref).toBe(row.ref);
      expect(seedRow.subsystem).toBe(row.subsystem);
      expect(seedRow.title).toBe(row.title);
      expect(seedRow.content).toBe(row.content);
      // The JSONB blobs must round-trip byte-equal to the §12 row.
      expect(seedRow.provenance).toEqual(row.provenance);
      expect(seedRow.evidence).toEqual(row.evidence);
    },
  );

  it("produces an object assignable to UpsertAtlasSeedCandidateInput", () => {
    const candidate: Candidate = CandidateSchema.parse(
      rowToCandidateInput(ROW_12_1),
    );
    const seedRow: UpsertAtlasSeedCandidateInput = toSeedEntryRow(candidate);
    expect(seedRow.canonicalKey).toBe(ROW_12_1.canonical_key);
  });
});

// ── S1 (Theme A.4 set-extension): BEHAVIOR_KNOWLEDGE_TYPES is the §7 gate set ──
// The extended set is the ENUM-COMPLEMENT of the three exempt process/etiquette
// types {process, operational, org-culture}. Defining it as the complement (all
// KnowledgeType values MINUS the exempt three) is drift-proof: adding a new
// knowledge_type to the enum defaults it INTO the gated set unless it is
// explicitly exempted, which is the safe direction for a guilty-until-validated
// approvability gate.
describe("BEHAVIOR_KNOWLEDGE_TYPES (§7 gate set = enum-complement of the exempt three)", () => {
  const EXEMPT: KnowledgeTypeT[] = ["process", "operational", "org-culture"];
  const EXPECTED_GATED: KnowledgeTypeT[] = [
    "architecture",
    "design-rationale",
    "root-cause",
    "ownership",
    "protocol",
    "security",
    "product",
    "gtm",
  ];

  it("contains exactly the eight gated fact/behavior types", () => {
    expect([...BEHAVIOR_KNOWLEDGE_TYPES].sort()).toEqual(
      [...EXPECTED_GATED].sort(),
    );
  });

  it("includes every gated type", () => {
    for (const t of EXPECTED_GATED) {
      expect(BEHAVIOR_KNOWLEDGE_TYPES.has(t)).toBe(true);
    }
  });

  it("excludes each of the three exempt process/etiquette types", () => {
    for (const t of EXEMPT) {
      expect(BEHAVIOR_KNOWLEDGE_TYPES.has(t)).toBe(false);
    }
  });

  it("is the exact enum-complement of the exempt three (drift-proof)", () => {
    const allTypes = KnowledgeType.options as KnowledgeTypeT[];
    const complement = allTypes.filter((t) => !EXEMPT.includes(t)).sort();
    expect([...BEHAVIOR_KNOWLEDGE_TYPES].sort()).toEqual(complement);
    // Every enum value is accounted for: gated ∪ exempt = all 11.
    expect(BEHAVIOR_KNOWLEDGE_TYPES.size + EXEMPT.length).toBe(allTypes.length);
  });
});

// ── S1 (Theme A.1): DistillationVerdict discriminated union narrows on `kind` ──
describe("DistillationVerdict (A.1 judge output union)", () => {
  it("narrows on `kind` for each variant (compile + runtime)", () => {
    const distilled: DistillationVerdict = { kind: "distilled" };
    const rewritten: DistillationVerdict = {
      kind: "rewritten",
      title: "distilled why",
      content: "the why prose",
      reason: "extracted the rationale",
    };
    const restatement: DistillationVerdict = {
      kind: "restatement",
      reason: "just restates the what",
    };

    // Runtime exercise of the compile-time narrowing.
    for (const v of [distilled, rewritten, restatement]) {
      switch (v.kind) {
        case "distilled":
          expect(v.kind).toBe("distilled");
          break;
        case "rewritten":
          expect(v.title).toBe("distilled why");
          expect(v.content).toBe("the why prose");
          expect(v.reason).toBe("extracted the rationale");
          break;
        case "restatement":
          expect(v.reason).toBe("just restates the what");
          break;
        default: {
          // Exhaustiveness: every kind is handled above.
          const _exhaustive: never = v;
          throw new Error(
            `unreachable verdict: ${JSON.stringify(_exhaustive)}`,
          );
        }
      }
    }
  });
});

// ── S1 (O2): RESTATEMENT_MARKER is the ONE shared literal S8 emits + S4 reads ──
describe("RESTATEMENT_MARKER (O2 shared literal)", () => {
  it("exports the exact restatement marker literal", () => {
    expect(RESTATEMENT_MARKER).toBe("distillation:restatement");
  });
});

// ── S1 (Theme C.1): approvable is a persisted field on the storage input, and
//    toSeedEntryRow threads it through from the Candidate ──────────────────────
describe("toSeedEntryRow persists the C.1 approvable field", () => {
  it("threads candidate.approvable onto the storage input", () => {
    const candidate: Candidate = CandidateSchema.parse({
      ...rowToCandidateInput(ROW_12_1),
      approvable: false,
    });
    const seedRow: UpsertAtlasSeedCandidateInput = toSeedEntryRow(candidate);
    expect(seedRow.approvable).toBe(false);
    expect(seedRow.approvable).toBe(candidate.approvable);
  });

  it("carries approvable=true through for an approvable candidate", () => {
    const candidate: Candidate = CandidateSchema.parse(
      rowToCandidateInput(ROW_12_5),
    );
    const seedRow = toSeedEntryRow(candidate);
    expect(seedRow.approvable).toBe(true);
    expect(seedRow.approvable).toBe(candidate.approvable);
  });
});
