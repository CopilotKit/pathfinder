// Atlas candidate + classification contract (FOUNDATIONAL).
//
// This is the single source of truth every Atlas harvest slot imports: the
// CandidateFragment / Candidate / Classification Zod schemas & TS types, the
// canonical-key builder/parser, the five classification-flag enums, and the
// provenance(object)/evidence(array) shapes matching spec §9.3 and the worked
// rows §12.1–§12.8 EXACTLY. Zod schemas provide runtime validation;
// TypeScript types are inferred from them (matching the src/types.ts idiom).
//
// The `mostRestrictiveSensitivity` pure helper lives here (contract-level) so
// the aggregator (S10) and the classifier (S11) both import it from this file
// with no import cycle.

import { z } from "zod";
import type { UpsertAtlasSeedCandidateInput } from "../db/atlas.js";

// ── Classification flag enums (5 enum dims of the 7-dimension flag-set;
//    `audience` is a free string, `freshness` an object) ──────────────────────

export const Sensitivity = z.enum([
  "public",
  "internal",
  "proprietary",
  "secret",
]);
export const KnowledgeType = z.enum([
  "architecture",
  "design-rationale",
  "root-cause",
  "ownership",
  "operational",
  "protocol",
  "security",
  "process",
  "product",
  "gtm",
  "org-culture",
]);
// The §7 gate set: behavior/architecture knowledge that stays `unverified` is
// guilty-until-validated and is NOT approvable (spec §7 proof: the CopilotNext
// case). Defined ONCE here, next to the KnowledgeType enum it ranges over —
// canonicalize (approvable), validate (promotion gating), and artifact sync
// (re-derived approvable) all import this set, so the three gate sites can
// never silently drift.
export const BEHAVIOR_KNOWLEDGE_TYPES: ReadonlySet<KnowledgeType> =
  new Set<KnowledgeType>(["architecture", "design-rationale"]);

export const ValidationStatus = z.enum([
  "unverified",
  "source-verified",
  "showcase-verified",
]);
export const Confidence = z.enum(["high", "medium", "low"]);
export const ProvenanceClass = z.enum(["primary", "derived"]);

// ── Classification + provenance + evidence schemas ────────────────────────────

export const ClassificationSchema = z.object({
  sensitivity: Sensitivity,
  knowledge_type: KnowledgeType,
  audience: z.string().default("all-staff"),
  validation_status: ValidationStatus,
  confidence: Confidence,
  provenance_class: ProvenanceClass,
  freshness: z.object({
    as_of: z.string(),
    re_verify_by: z.string().optional(),
  }),
});

// EvidenceItemSchema governs the BATCH CandidateFragment evidence ONLY. It does
// NOT govern the existing webhook output (which keeps its own
// `[{ type: "pull_request", url, title, body }]` shape — see S3). It matches the
// §9.3 evidence array for batch fragments exactly.
export const EvidenceItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("changed_file"), path: z.string() }),
  z.object({ kind: z.literal("linked_issue"), url: z.string() }),
  z.object({ kind: z.literal("thread"), body: z.string() }),
  z.object({ kind: z.literal("fused_from"), ref: z.string() }),
]);

export const ProvenanceSchema = z.object({
  source: z.string(),
  url: z.string().optional(),
  date: z.string().optional(),
  commit: z.string().optional(),
  version: z.string().optional(),
  validated_against: z.string().optional(),
  classification: ClassificationSchema,
});

// ── Candidate fragment (Tier-1 leaf output, not yet canonicalized) ────────────

// The raw object shape, kept un-refined so `CandidateSchema` can `.extend()` it
// (a refinement returns a ZodEffects, which has no `.extend`). The subsystem
// delimiter guard below is applied to BOTH the fragment and the candidate.
const CandidateFragmentObject = z.object({
  sourcetype: z.enum([
    "memory",
    "episodic",
    "github-pr",
    "github-issue",
    "notion-doc",
    "linear-doc",
    "agent-doc",
    "derived",
  ]),
  subsystem: z.string(),
  claimSlugHint: z.string().optional(),
  source_name: z.string(),
  repo_url: z.string().optional(),
  ref: z.string().optional(),
  // BATCH fragments: distilled claim, NOT the source title. (The webhook path
  // is EXEMPT — it keeps the raw "PR #N: <title>". See B2/M1.)
  title: z.string(),
  content: z.string(), // why/how prose
  provenance: ProvenanceSchema,
  evidence: z.array(EvidenceItemSchema).default([]),
  needsReview: z.boolean().default(false), // episodic → true
  validationTargets: z.array(z.string()).default([]), // symbols/paths for validate.ts
});

// `subsystem` is a STRUCTURAL component of the canonical key
// (<sourcetype>:<subsystem>:<claim-slug>) — a ':' would silently mis-parse on the
// round-trip, and the Notion approval-marker delimiters '⟦'/'⟧' (U+27E6/U+27E7)
// would corrupt the marker round-trip (extractCanonicalKey slices the embedded
// key at the first '⟧' after the open marker, so a stray delimiter truncates
// the parsed key → the sync ratifies a key the server never stored → permanent
// idempotent-409 conflict). Adapters set `subsystem` directly on the fragment,
// so reject all three at INTAKE (where the producing adapter is identifiable)
// rather than letting it blow up later mid-pipeline. (`sourcetype` is already
// constrained to a delimiter-free enum.) Shared so the fragment AND the
// finalized candidate enforce the same invariant.
const subsystemHasNoDelimiter = (f: { subsystem: string }): boolean =>
  !f.subsystem.includes(":") &&
  !f.subsystem.includes("⟦") &&
  !f.subsystem.includes("⟧");
const SUBSYSTEM_NO_DELIMITER_ISSUE = {
  message:
    "subsystem must not contain ':' (a canonical-key delimiter) or '⟦'/'⟧' " +
    "(the approval-marker delimiters)",
  path: ["subsystem"],
};

export const CandidateFragmentSchema = CandidateFragmentObject.refine(
  subsystemHasNoDelimiter,
  SUBSYSTEM_NO_DELIMITER_ISSUE,
);

// ── Candidate (Tier-3 finalized row, 1:1 with an atlas_seed_entries row) ───────

export const CandidateSchema = CandidateFragmentObject.extend({
  canonical_key: z.string(), // <sourcetype>:<subsystem>:<claim-slug>
  rankScore: z.number(),
  approvable: z.boolean(), // false if behavior/arch fact stays unverified
}).refine(subsystemHasNoDelimiter, SUBSYSTEM_NO_DELIMITER_ISSUE);

// ── Inferred TypeScript types (explicitly exported so downstream
//    `keyof Classification` etc. resolve) ─────────────────────────────────────

export type Classification = z.infer<typeof ClassificationSchema>;
export type Sensitivity = z.infer<typeof Sensitivity>;
export type KnowledgeType = z.infer<typeof KnowledgeType>;
export type ValidationStatus = z.infer<typeof ValidationStatus>;
export type Confidence = z.infer<typeof Confidence>;
export type ProvenanceClass = z.infer<typeof ProvenanceClass>;
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type CandidateFragment = z.infer<typeof CandidateFragmentSchema>;
export type Candidate = z.infer<typeof CandidateSchema>;

// ── Canonical-key builder / parser ────────────────────────────────────────────

// Mirrors `subsystemHasNoDelimiter` above for the OTHER two key components:
// the Notion approval-marker delimiters '⟦'/'⟧' (U+27E6/U+27E7) corrupt the
// marker round-trip wherever they land in the key — extractCanonicalKey slices
// the embedded key at the first '⟧' after the open marker — so unlike ':'
// (structural in the first two components only), they are forbidden in ALL
// THREE components, including the claim-slug.
const componentHasNoMarkerDelimiter = (component: string): boolean =>
  !component.includes("⟦") && !component.includes("⟧");

// Build a canonical key of the form `<sourcetype>:<subsystem>:<claim-slug>`.
//
// `sourcetype` and `subsystem` are the two STRUCTURAL components: parseCanonicalKey
// splits on the first two colons, so a ':' in either would silently mis-parse on
// the round-trip (subsystem truncated, claim-slug corrupted). Reject it loudly. The
// claim-slug MAY contain colons — everything after the second colon is preserved
// intact by parseCanonicalKey. The approval-marker delimiters '⟦'/'⟧' are
// rejected in ALL THREE components (see componentHasNoMarkerDelimiter).
export function buildCanonicalKey(
  sourcetype: string,
  subsystem: string,
  claimSlug: string,
): string {
  if (sourcetype.includes(":")) {
    throw new Error(
      `Invalid sourcetype "${sourcetype}": canonical-key sourcetype must not contain ':' (it is a structural delimiter)`,
    );
  }
  if (subsystem.includes(":")) {
    throw new Error(
      `Invalid subsystem "${subsystem}": canonical-key subsystem must not contain ':' (it is a structural delimiter)`,
    );
  }
  for (const [name, value] of [
    ["sourcetype", sourcetype],
    ["subsystem", subsystem],
    ["claim-slug", claimSlug],
  ] as const) {
    if (!componentHasNoMarkerDelimiter(value)) {
      throw new Error(
        `Invalid ${name} "${value}": canonical-key components must not contain '⟦' or '⟧' (the approval-marker delimiters)`,
      );
    }
  }
  return `${sourcetype}:${subsystem}:${claimSlug}`;
}

// Inverse of buildCanonicalKey. Splits on the first two ':' separators so a
// claim-slug that itself contains ':' is preserved intact (canonical keys are
// `<sourcetype>:<subsystem>:<claim-slug>`, and only the first two colons are
// structural).
export function parseCanonicalKey(key: string): {
  sourcetype: string;
  subsystem: string;
  claimSlug: string;
} {
  const firstColon = key.indexOf(":");
  const secondColon = key.indexOf(":", firstColon + 1);
  if (firstColon === -1 || secondColon === -1) {
    throw new Error(
      `Invalid canonical key "${key}": expected <sourcetype>:<subsystem>:<claim-slug>`,
    );
  }
  return {
    sourcetype: key.slice(0, firstColon),
    subsystem: key.slice(firstColon + 1, secondColon),
    claimSlug: key.slice(secondColon + 1),
  };
}

// ── Sensitivity ordering helper (contract-level; reused by aggregate + classify) ─

// Least → most restrictive. The index in this array IS the restrictiveness
// rank, so `mostRestrictiveSensitivity` just picks the higher-indexed value.
const SENSITIVITY_ORDER: Sensitivity[] = [
  "public",
  "internal",
  "proprietary",
  "secret",
];

// Return the more restrictive of two sensitivities
// (public < internal < proprietary < secret). Pure helper, no side effects.
export function mostRestrictiveSensitivity(
  a: Sensitivity,
  b: Sensitivity,
): Sensitivity {
  return SENSITIVITY_ORDER.indexOf(a) >= SENSITIVITY_ORDER.indexOf(b) ? a : b;
}

// ── Date normalization (contract-level; reused by aggregate + canonicalize) ────

// Normalize a provenance date string to epoch milliseconds for comparison. Both
// the aggregator (fuseCluster's newest-by-date selection) and the canonicalizer
// (supersedes) MUST agree on which fragment is "newer", so they share THIS one
// comparator rather than each rolling their own (string localeCompare vs numeric
// Date.parse disagreed when date shapes were mixed — date-only "2026-06-09" vs
// full ISO "2026-06-09T12:00:00Z"). A missing or unparseable date sorts as the
// oldest possible (-Infinity) so a dated fact always wins over an undated one.
export function dateToEpochMs(date: string | undefined): number {
  if (!date) return Number.NEGATIVE_INFINITY;
  const ts = Date.parse(date);
  return Number.isNaN(ts) ? Number.NEGATIVE_INFINITY : ts;
}

// Compare two provenance dates by normalized epoch ms. Returns a NEGATIVE number
// when `a` is newer than `b` (so an Array.sort comparator sorts newest-first),
// positive when `a` is older, 0 when equal/both-undated. The single source of
// truth for date recency across the harvest tiers.
//
// Equal (or both-non-finite) inputs MUST return exactly 0: naively computing
// `dateToEpochMs(b) - dateToEpochMs(a)` yields `(-Infinity) - (-Infinity)` = NaN
// for two undated/unparseable inputs, and a NaN comparator makes
// Array.prototype.sort implementation-defined/unstable — which defeats the
// determinism this helper exists to provide. `-Infinity === -Infinity` is true,
// so the equality guard collapses both-undated to 0.
export function compareDatesDesc(
  a: string | undefined,
  b: string | undefined,
): number {
  const ma = dateToEpochMs(a);
  const mb = dateToEpochMs(b);
  if (ma === mb) return 0;
  return mb - ma;
}

// ── Bridge to the EXISTING storage layer ──────────────────────────────────────

// Map a finalized Candidate (snake_case contract fields) onto the REAL
// camelCase input shape consumed by the existing `upsertAtlasSeedCandidate`
// (origin/main src/db/atlas.ts). `provenance` and `evidence` are persisted as
// JSONB, so they map onto the loose `Record<string, unknown>` / `unknown[]`
// storage types verbatim (byte-compatible — see the §12 round-trip tests).
export function toSeedEntryRow(c: Candidate): UpsertAtlasSeedCandidateInput {
  return {
    canonicalKey: c.canonical_key,
    sourceName: c.source_name,
    repoUrl: c.repo_url,
    ref: c.ref,
    subsystem: c.subsystem,
    title: c.title,
    content: c.content,
    provenance: c.provenance,
    evidence: c.evidence,
  };
}
