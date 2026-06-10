// Atlas classification finalize stage (Tier-3, deterministic).
//
// `finalizeClassification` is the normalizer that runs over a CandidateFragment
// AFTER the leaf adapters (Tier-1) and aggregator (Tier-2) have produced it. The
// upstream stages may leave the 7-dimension classification flag-set
// (sensitivity, knowledge_type, audience, validation_status, confidence,
// provenance_class, freshness) only partially populated; this stage completes
// the set with conservative, schema-valid defaults, preserves every value the
// upstream already set (empty strings count as unset for the two FREE-STRING
// dims — audience and freshness.as_of; enum dims arrive Zod-constrained — see
// the audience/as_of length checks below), and is idempotent
// (finalize(finalize(x)) == finalize(x)).
//
// The sensitivity-combining helper `mostRestrictiveSensitivity` lives in the S0
// contract (../atlas/types.ts) and is the aggregator's tool for fusing two
// fragments' sensitivities — it is intentionally NOT redefined here, because
// finalize normalizes a single fragment's flag-set and has no second value to
// combine.

import type {
  CandidateFragment,
  Classification,
  Confidence,
  KnowledgeType,
  ProvenanceClass,
  Sensitivity,
  ValidationStatus,
} from "../atlas/types.js";

// ── Conservative per-dimension defaults ───────────────────────────────────────
//
// These are deliberately the SAFE end of each dimension: company knowledge is
// `internal` (never `public`) until proven otherwise; `unverified` until the
// validate stage (S14) promotes it; `low` confidence until assessed; `derived`
// unless an adapter marked it `primary`. `audience` defaults to "all-staff"
// (the contract's own schema default). `knowledge_type` has no neutral end, so
// the catch-all `operational` is used for an un-tagged fact.
const DEFAULT_SENSITIVITY: Sensitivity = "internal";
const DEFAULT_KNOWLEDGE_TYPE: KnowledgeType = "operational";
const DEFAULT_AUDIENCE = "all-staff";
const DEFAULT_VALIDATION_STATUS: ValidationStatus = "unverified";
const DEFAULT_CONFIDENCE: Confidence = "low";
const DEFAULT_PROVENANCE_CLASS: ProvenanceClass = "derived";

// Read the incoming classification as a partial set. The TS type declares all
// seven dims as required, but the whole purpose of this stage is to accept a
// runtime-incomplete flag-set and complete it — so we narrow to Partial without
// an `any` cast.
type PartialClassification = Partial<Classification> & {
  freshness?: Partial<Classification["freshness"]>;
};

// Fill the freshness sub-object: keep an already-present `as_of` (idempotency —
// the default must never be regenerated on a re-finalize), only synthesizing one
// when entirely absent. `re_verify_by` stays optional and is preserved if set.
function finalizeFreshness(
  freshness: PartialClassification["freshness"],
  now: Date,
): Classification["freshness"] {
  const asOf =
    typeof freshness?.as_of === "string" && freshness.as_of.length > 0
      ? freshness.as_of
      : isoDate(now);
  const out: Classification["freshness"] = { as_of: asOf };
  if (typeof freshness?.re_verify_by === "string") {
    out.re_verify_by = freshness.re_verify_by;
  }
  return out;
}

// Date-only ISO stamp (YYYY-MM-DD) — matches the §12 worked-row `as_of`/`
// re_verify_by` shape, which are calendar dates, not full timestamps.
function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

// Normalize/complete the 7-dimension classification flag-set on
// `c.provenance.classification`. Pure: returns a new fragment (new provenance,
// new classification object) and never mutates the input. Idempotent: a value
// already set upstream — including a previously-defaulted `as_of` — is preserved
// verbatim, so a second pass is a no-op.
export function finalizeClassification(
  c: CandidateFragment,
): CandidateFragment {
  const now = new Date();
  const current = c.provenance.classification as PartialClassification;

  const classification: Classification = {
    sensitivity: current.sensitivity ?? DEFAULT_SENSITIVITY,
    knowledge_type: current.knowledge_type ?? DEFAULT_KNOWLEDGE_TYPE,
    audience:
      typeof current.audience === "string" && current.audience.length > 0
        ? current.audience
        : DEFAULT_AUDIENCE,
    validation_status: current.validation_status ?? DEFAULT_VALIDATION_STATUS,
    confidence: current.confidence ?? DEFAULT_CONFIDENCE,
    provenance_class: current.provenance_class ?? DEFAULT_PROVENANCE_CLASS,
    freshness: finalizeFreshness(current.freshness, now),
  };

  return {
    ...c,
    provenance: {
      ...c.provenance,
      classification,
    },
  };
}
