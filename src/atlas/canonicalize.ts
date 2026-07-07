// Atlas Tier-3 canonicalizer + ranker.
//
// The top tier of the harvest pipeline (spec §4, §9.1). It takes the
// aggregator's CandidateFragment[] and turns each into a finalized Candidate by:
//
//   1. assigning a canonical_key = <CANONICAL_KEY_PREFIX>:<subsystem>:<claim-slug>
//      (the claim-slug is derived from claimSlugHint, falling back to the title).
//      The first segment is a STABLE CONSTANT — NOT the fragment's sourcetype —
//      so a claim keys on its IDENTITY (subsystem + claim), independent of which
//      source it was harvested from or whether it was fused (spec §C.2). This is
//      what makes the key stable across a solo→fused re-key across runs (see
//      CANONICAL_KEY_PREFIX below and the cross-source-collision note there),
//   2. GLOBAL DEDUP + SUPERSESSION — fragments that collapse to the same
//      canonical_key are reduced to ONE survivor: the SUPERSEDING (newest, by
//      provenance.date) fragment (§9.1 canonical statement),
//   3. computing a rankScore (source-strength × recency × evidence-depth ×
//      validation × confidence) used to ORDER the human review queue,
//   4. setting `approvable` — a behavior/architecture fact that stays
//      `unverified` is NOT approvable (the binding validation gate, §7/§10).
//
// ORDERING ONLY. canonicalize never machine-drops a candidate: the ONLY rows it
// removes are exact same-canonical_key duplicates (and the survivor is the
// superseding one). Confidence/ranking re-orders; only the human gate and the
// exclusion-rule engine (S13) remove rows (§10 bar 1).

import {
  BEHAVIOR_KNOWLEDGE_TYPES,
  buildCanonicalKey,
  dateToEpochMs,
  RAG_NO_DELTA_MARKER,
} from "./types.js";
import { hasRestatementMarker } from "./validate.js";
import type {
  Candidate,
  CandidateFragment,
  Confidence,
  ValidationStatus,
} from "./types.js";

// The STABLE first segment of every canonical_key (spec §C.2). The canonical_key
// keys on CLAIM IDENTITY — subsystem + claim slug — NOT on the fragment's
// sourcetype. Using a source-independent constant here (rather than
// `fragment.sourcetype`) is the whole fix: aggregate re-stamps a claim's
// sourcetype `derived` the moment it fuses, so a sourcetype-derived key flipped
// `memory:<sub>:<slug>` → `derived:<sub>:<slug>` between a solo run and a later
// fused run — two keys that never collided at the DB upsert (ON CONFLICT
// canonical_key, db/atlas.ts), so run 2 inserted a DUPLICATE pending row instead
// of superseding run 1. A constant prefix collapses both to one key.
//
// The key format stays 3-segment `<prefix>:<subsystem>:<claim-slug>` so
// parseCanonicalKey keeps recovering the subsystem (the MIDDLE segment) for
// sync.ts's exclusion-rule matching — only the volatile first segment changed.
//
// CROSS-SOURCE COLLISION (the deliberate blast radius, spec §C.2 note): because
// the prefix no longer carries source semantics, two fragments at the SAME
// subsystem+claim but DIFFERENT sourcetypes (e.g. an unfused github-pr and an
// unfused notion-doc stating the same claim) now share ONE canonical_key and
// collapse via supersession — where they previously produced two distinct keys.
// This is intended: a claim's identity does not depend on which source observed
// it. The full claim-id redesign remains out of scope; this is the targeted
// duplication fix.
export const CANONICAL_KEY_PREFIX = "claim";

// ── Claim-slug derivation ─────────────────────────────────────────────────────

// Normalize a claim fragment (a claimSlugHint or a title) into a stable,
// human-readable lower-kebab slug: lowercase, non-alphanumerics collapsed to a
// single '-', leading/trailing separators trimmed. Used as the third
// canonical_key segment when no explicit claimSlugHint is supplied.
//
// EXPORTED + SHARED: the aggregator's clusterKey MUST normalize a claim the
// SAME way this does, or the two tiers disagree on claim identity — two titles
// that differ only by punctuation ("Foo: bar" vs "Foo bar") would get different
// cluster keys (never fuse) but the SAME canonical_key (canonicalize then drops
// one via supersession, losing the unfused member's evidence). Owning this here
// (canonicalize), not in types.ts, keeps the contract module dependency-free.
//
// A claim that normalizes to EMPTY (punctuation-only / non-ASCII title with no
// hint) falls back to a short content-derived djb2 hash (like the aggregator's
// contentDiscriminator) so distinct claims never share the degenerate
// `<sourcetype>:<subsystem>:` key — which would silently collapse unrelated
// fragments via supersession, violating the "nothing is silently dropped"
// invariant. The hash is deterministic, so the same claim still slugs
// identically across both tiers and across runs.
//
// The same guard applies to PARTIAL residue loss: an input whose non-ASCII
// LETTERS/DIGITS were stripped (e.g. "Fix the 缓存 bug" → "fix-the-bug") has
// lost claim semantics, so two claims distinguished only by those characters
// ("Fix the 缓存 bug" / "Fix the 排序 bug") would otherwise share one slug —
// the same silent collapse the empty-residue fallback exists to prevent. The
// djb2 discriminator is APPENDED to the slug in that case.
//
// The discriminator hashes a NORMALIZED projection of the input (lowercased,
// everything but letters/digits stripped), NOT the raw bytes: it must capture
// lost claim SEMANTICS only. Case, spacing, punctuation and decoration are
// not semantics, so variants of the same claim ("Fix the 缓存 bug" / "fix the
// 缓存 bug" / "Fix the 缓存 bug 🚀") hash identically and keep fusing, while
// claims distinguished by non-ASCII letters/digits ("缓存" vs "排序") still
// differ. Decoration (emoji, punctuation, symbols) is NOT claim semantics:
// stripping it loses nothing, so "Fix cache 🚀" still slugs to "fix-cache"
// and fuses with "Fix cache". Pure-ASCII inputs never take the hash path
// (slug-only, as before the discriminator existed).
export function claimSlug(fragment: string): string {
  const slug = fragment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Claim semantics survive the ASCII slug only if the stripped residue holds
  // no letters/digits (after removing ASCII alphanumerics, anything matching
  // \p{L}/\p{N} is a non-ASCII letter or digit the slug lost).
  const lostSemantics = /[\p{L}\p{N}]/u.test(
    fragment.replace(/[a-zA-Z0-9]/g, ""),
  );
  if (slug && !lostSemantics) return slug;
  // Hash the normalized semantic projection (see the header comment). A
  // projection with NO letters/digits at all (punctuation/emoji-only input)
  // has no semantics to capture — hash the raw input instead so DISTINCT
  // degenerate claims ("!!!" vs "???") still get distinct fallback slugs.
  const normalized = fragment.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const hashInput = normalized || fragment;
  let h = 5381;
  for (let i = 0; i < hashInput.length; i++) {
    h = (h * 33) ^ hashInput.charCodeAt(i);
  }
  // >>> 0 forces an unsigned 32-bit int; base-36 keeps the slug compact.
  const hash = (h >>> 0).toString(36);
  return slug ? `${slug}-${hash}` : hash;
}

// The claim-slug prefers an explicit hint and falls back to the title. The
// fallback is TRUTHY (||, not ??): the schema admits claimSlugHint: "" and a
// nullish fallback would keep "", routing EVERY empty-hint fragment to
// claimSlug("") — the same constant djb2 slug — so unrelated claims would share
// one canonical_key and silently supersede each other. An empty hint counts as
// absent. A claimSlugHint is assumed already slug-shaped but is normalized
// anyway so the canonical_key is uniform regardless of which source supplied it.
function deriveClaimSlug(fragment: CandidateFragment): string {
  return claimSlug(fragment.claimSlugHint || fragment.title);
}

// ── Rank weighting ────────────────────────────────────────────────────────────
//
// rankScore is a product of independent factors, each ≥ 0; a higher score sorts
// EARLIER in the review queue (spec §4, §11.1: strongest / showcase-verified /
// high-confidence first). The weights only ORDER the queue — they never drop a
// candidate, so the absolute magnitudes matter only relative to one another.

// Validation status is the dominant signal — a showcase-verified fact has been
// proven end-to-end; an unverified one is guilty-until-validated (§7).
const VALIDATION_WEIGHT: Record<ValidationStatus, number> = {
  "showcase-verified": 3,
  "source-verified": 2,
  unverified: 1,
};

const CONFIDENCE_WEIGHT: Record<Confidence, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

// Source strength: a fact stated at a primary source outranks a derived/fused
// one, all else equal (provenance_class, §8.1).
function sourceStrength(fragment: CandidateFragment): number {
  return fragment.provenance.classification.provenance_class === "primary"
    ? 2
    : 1;
}

// Recency: a smooth age-decay factor in (0, 1]. A fact dated today scores ~1; an
// older fact decays toward (but never reaches) 0, so recency re-orders without
// ever zeroing a candidate out. An undated fact takes a neutral mid weight so it
// is neither boosted nor buried purely for lacking a date.
const RECENCY_HALF_LIFE_DAYS = 365;
function recency(fragment: CandidateFragment, now: number): number {
  // Use the SHARED date normalizer so every date consumer (recency, supersedes,
  // the aggregator's newest-by-date) agrees on one parse. A missing or
  // unparseable date normalizes to NEGATIVE_INFINITY → neutral mid-weight, so an
  // undated fact is neither boosted nor buried purely for lacking a date.
  const ts = dateToEpochMs(fragment.provenance.date);
  if (ts === Number.NEGATIVE_INFINITY) return 0.5;
  const ageDays = Math.max(0, (now - ts) / (1000 * 60 * 60 * 24));
  // Exponential half-life decay: 1.0 at age 0, 0.5 at one half-life, etc.
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

// Evidence depth: more corroborating evidence items rank higher. Diminishing,
// bounded boost (1 + log1p(count)) so a single strong fact is never buried under
// a weakly-corroborated one purely on evidence count.
//
// Rank-neutral §6.2 duplication marks: the rag-dedup gate stamps TWO kinds of
// `fused_from` evidence on a corpus-overlapping candidate, neither of which is
// corroboration for the claim — counting either would make a corpus DUPLICATE
// outrank its un-duplicated twin (inverting §6.2). Filter BOTH out of the depth
// count; genuine fused_from refs (aggregator provenance — canonical-key-shaped)
// still count.
//
//   1. RAG_CORPUS_OVERLAP_REF_PREFIX: an AUDIT annotation about the corpus,
//      appended on EVERY overlap verdict (delta included).
//   2. RAG_NO_DELTA_MARKER: the DEDICATED no-delta floor trace, stamped as a
//      fused_from ref on a pure corpus duplicate (rag-dedup's floorNoDelta). It
//      is a provenance floor, not evidence — the SAME constant the emitter and
//      validate reader import, so the exclusion can never drift from the stamp.
function evidenceDepth(fragment: CandidateFragment): number {
  const corroborating = fragment.evidence.filter(
    (e) =>
      !(
        e.kind === "fused_from" &&
        (e.ref.startsWith(RAG_CORPUS_OVERLAP_REF_PREFIX) ||
          e.ref === RAG_NO_DELTA_MARKER)
      ),
  );
  return 1 + Math.log1p(corroborating.length);
}

// Ref prefix the rag-dedup gate stamps on the `fused_from` evidence item (and
// the matching provenance.validated_against marker) it appends on RAG-corpus
// overlap. Owned HERE — next to the evidenceDepth filter that must recognize
// it — and imported by rag-dedup's annotateOverlap so the stamp and the rank
// filter can never drift apart.
export const RAG_CORPUS_OVERLAP_REF_PREFIX = "rag-corpus-overlap:";

function computeRankScore(fragment: CandidateFragment, now: number): number {
  const { validation_status, confidence } = fragment.provenance.classification;
  // A RESTATEMENT-floored candidate (approvable=false; see validate.ts) carries
  // no NEW verifiable claim. The validate gate still PROMOTES its
  // validation_status when its symbols grep-verify (the status is display-truth
  // — the symbols really do exist), but that promotion must NOT lift the rank:
  // otherwise the restatement would OUT-RANK a genuine claim purely on the
  // dominant validation weight, surfacing restatement noise above real why/how
  // in the ranked artifact (§11.1). Floor the validation weight to `unverified`
  // for a restatement, consistent with its approvable=false floor — the SAME
  // predicate the approvability floor uses, so status-display and rank can never
  // drift apart.
  const validationWeight = hasRestatementMarker(fragment)
    ? VALIDATION_WEIGHT.unverified
    : VALIDATION_WEIGHT[validation_status];
  return (
    sourceStrength(fragment) *
    recency(fragment, now) *
    evidenceDepth(fragment) *
    validationWeight *
    CONFIDENCE_WEIGHT[confidence]
  );
}

// Recompute a finalized Candidate's rankScore (pure — returns a new Candidate;
// the input is never mutated). Exported for post-canonicalize consumers that
// change a rank INPUT after the score was assigned — e.g. the validate step
// promoting validation_status, the DOMINANT rank weight — so the review queue
// is ordered by the promoted value rather than the stale one (§11.1).
export function recomputeRankScore(
  candidate: Candidate,
  now: number = Date.now(),
): Candidate {
  return { ...candidate, rankScore: computeRankScore(candidate, now) };
}

// ── Approvability gate ────────────────────────────────────────────────────────
//
// Behavior/architecture knowledge that stays `unverified` is guilty-until-
// validated and is NOT approvable (spec §7 proof: the CopilotNext case). The
// candidate is still emitted — `approvable=false` renders it non-checkable in
// the approval artifact (S16); it is NOT dropped here. The gate SET itself
// (BEHAVIOR_KNOWLEDGE_TYPES) is the single contract-level definition imported
// from types.ts, shared with validate.ts and the artifact sync.

function isApprovable(fragment: CandidateFragment): boolean {
  const { knowledge_type, validation_status } =
    fragment.provenance.classification;
  if (
    BEHAVIOR_KNOWLEDGE_TYPES.has(knowledge_type) &&
    validation_status === "unverified"
  ) {
    return false;
  }
  return true;
}

// ── Supersession comparison ───────────────────────────────────────────────────

// Returns true if `candidate` supersedes `incumbent` — i.e. it is the newer
// fact at the same canonical_key and should replace it. Newer = later
// provenance.date. A dated fact supersedes an undated one; between two undated
// (or equal-dated) fragments the incumbent is kept (stable, first-seen wins) so
// supersession is deterministic and order-independent for distinct dates.
function supersedes(
  candidate: CandidateFragment,
  incumbent: CandidateFragment,
): boolean {
  // Use the SAME normalized epoch-ms comparator as the aggregator's
  // newest-by-date selection so the two tiers never disagree on the survivor
  // when date shapes are mixed (date-only vs full ISO). A missing/unparseable
  // date normalizes to -Infinity, so a dated fact supersedes an undated one and
  // ties (equal epoch, incl. both-undated) keep the incumbent (first-seen wins).
  return (
    dateToEpochMs(candidate.provenance.date) >
    dateToEpochMs(incumbent.provenance.date)
  );
}

// ── canonicalize ──────────────────────────────────────────────────────────────

// Assign canonical_key, globally dedup with supersession, compute rankScore and
// approvable, and return candidates ordered strongest-first.
//
// ORDERING ONLY — never drops a candidate except exact same-canonical_key
// duplicates (and the survivor is the superseding one). For every group of
// fragments sharing a canonical_key, exactly one Candidate is emitted; all
// distinct keys are preserved. count(out) === count(distinct canonical_keys).
export function canonicalize(fragments: CandidateFragment[]): Candidate[] {
  const now = Date.now();

  // Global dedup + supersession: collapse same-canonical_key fragments to the
  // single superseding (newest) survivor. Insertion order of first-seen keys is
  // preserved by Map iteration order (later re-sorted by rankScore).
  const survivors = new Map<string, CandidateFragment>();
  for (const fragment of fragments) {
    const key = buildCanonicalKey(
      // STABLE first segment (spec §C.2): key on claim identity, NOT sourcetype,
      // so a solo→fused re-key resolves to the same key and run 2 supersedes
      // rather than duplicating. See CANONICAL_KEY_PREFIX for the blast radius.
      CANONICAL_KEY_PREFIX,
      fragment.subsystem,
      deriveClaimSlug(fragment),
    );
    const incumbent = survivors.get(key);
    if (!incumbent || supersedes(fragment, incumbent)) {
      survivors.set(key, fragment);
    }
  }

  // Finalize each survivor into a Candidate, then order strongest-first.
  const candidates: Candidate[] = [];
  for (const [canonical_key, fragment] of survivors) {
    candidates.push({
      ...fragment,
      canonical_key,
      rankScore: computeRankScore(fragment, now),
      approvable: isApprovable(fragment),
    });
  }

  // Order strongest-first, then break rankScore ties by canonical_key so the
  // ordering is deterministic and engine-independent (Array.sort stability is
  // not enough — equal-score rows would otherwise keep their Map insertion
  // order, which varies with input ordering, breaking the determinism contract).
  // The tiebreak is a CODEPOINT comparison, not localeCompare: default-locale
  // collation depends on the runtime's ICU build/locale, which would break the
  // engine-independence claim.
  candidates.sort((a, b) => {
    if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
    if (a.canonical_key < b.canonical_key) return -1;
    if (a.canonical_key > b.canonical_key) return 1;
    return 0;
  });
  return candidates;
}
