// Atlas showcase leaf adapter (S9) + the validation-oracle linkage.
//
// A showcase "integration" (one of showcase/<integration>/) declares — in its
// manifest.yaml — which feature-registry PILLS it supports. The central
// showcase/shared/feature-registry.json lists every pill (across ~56 pills in a
// handful of categories) with a SUPPORT STATUS: a pill is `green` (shipping &
// D6-passing), `quarantined` (a known-broken / flaky feature, e.g.
// `gen-ui-interrupt`), or `not_supported`. This adapter fuses those two
// artifacts into ONE CandidateFragment describing the integration's feature
// support — knowledge that is SYNTHESIZED (not copied verbatim) from the two
// sources, hence `sourcetype: "derived"` / `provenance_class: "derived"`
// (parallel to the source-comment adapter, §6).
//
// This module ALSO OWNS the `FeatureRegistry` TYPE and the `lookupPill` helper.
// The S14 validation gate (`src/atlas/validate.ts`) imports both: it maps a
// candidate's claim to a feature-registry pill and only promotes the candidate to
// `showcase-verified` when the pill is `green` — a quarantined or unsupported
// pill must NOT count as verified (the §7 worked proof: a quarantined
// `gen-ui-interrupt` pill is not showcase-verified).
//
// Pure function of one unit (the Tier-1 "one unit each" rule, §4): the parsed
// manifest + the parsed registry come in as the `ShowcaseUnit`; loading/parsing
// the manifest.yaml and feature-registry.json off disk is the caller's job (the
// harvest driver / test harness). `ctx.llm` is unused here.

import type { CandidateFragment } from "../types.js";
import type { AdapterContext, LeafAdapter } from "./types.js";
import { sanitizeEnvRefs } from "./sanitize-env-refs.js";

// ── Feature-registry shape (owned here; imported by S14 validate.ts) ───────────
//
// Modeled on the real `showcase/shared/feature-registry.json`: a small set of
// CATEGORIES, each holding PILLS. A pill carries a stable `id` (the slug used in
// manifests and D6 runs), an optional human `name`, and a support `status`.

// The support status of a single feature pill. `green` = shipping & D6-passing
// (the only status that counts as showcase-verified); `quarantined` = a
// known-broken/flaky feature held back; `not_supported` = not available.
// The runtime value set and the `PillStatus` type are kept in lockstep by
// deriving the type from the array — validate-checkout's registry guard
// (fix10 Z3) enforces membership against this array, so a registry carrying
// e.g. `"Green"`/`"shipped"` fails loud at load instead of silently never
// matching `isShowcaseGreen`'s `status === "green"` comparison.
export const PILL_STATUSES = ["green", "quarantined", "not_supported"] as const;
export type PillStatus = (typeof PILL_STATUSES)[number];

// One feature pill in the registry.
export interface FeaturePill {
  // Stable slug — the value a manifest's `features` list and a D6 run reference.
  id: string;
  // Optional human-readable display name (shown in the showcase UI chips).
  name?: string;
  // Support status — drives showcase-verification.
  status: PillStatus;
}

// A group of related pills (e.g. "Generative UI", "Human in the Loop").
export interface FeatureCategory {
  id: string;
  name?: string;
  pills: FeaturePill[];
}

// The whole feature registry — the parsed shape of
// `showcase/shared/feature-registry.json`.
export interface FeatureRegistry {
  // Optional schema/version marker carried by the real file.
  version?: string;
  categories: FeatureCategory[];
}

// ── Showcase integration manifest + the adapter's input unit ───────────────────

// The parsed shape of a showcase integration's `manifest.yaml`: the integration's
// identity plus the feature-registry pill ids it declares support for.
export interface ShowcaseManifest {
  // Stable integration slug (e.g. `langgraph-python`) — becomes the subsystem.
  integration: string;
  // Human-readable integration name (e.g. "LangGraph (Python)").
  name?: string;
  // Optional source-repo URL + free-text description carried by the manifest.
  repo_url?: string;
  description?: string;
  // The feature-registry pill ids this integration declares support for.
  features: string[];
}

// One unit the showcase adapter extracts from: a single integration's manifest
// paired with the central feature registry (so the adapter can resolve declared
// pills to their support status). Satisfies the `LeafAdapter` `extract` unit.
export interface ShowcaseUnit {
  manifest: ShowcaseManifest;
  registry: FeatureRegistry;
}

// ── Pill lookup (the validation-oracle helper; imported by S14 validate.ts) ────

// Resolve a free-text/slug `claim` to a feature-registry pill and its support
// status. A pill matches when the claim equals its exact `id`, OR (case-
// insensitively) its `id` or display `name` (S14 feeds a candidate's claim text,
// which may be a slug or a human name). The conditions are OR'd, so for a given
// claim the FIRST pill in iteration order that satisfies any condition wins.
// Returns `undefined` when no pill matches — the caller treats a non-match as
// "not showcase-verifiable" rather than failing.
export function lookupPill(
  registry: FeatureRegistry,
  claim: string,
): { pill: string; status: PillStatus } | undefined {
  const needle = claim.trim().toLowerCase();
  // An empty/whitespace claim has no meaningful pill to match. Without this
  // guard `needle === ""` would spuriously match a pill whose `id` is an empty
  // string (`pill.id.toLowerCase() === ""`). An empty NAME can never match —
  // the `pill.name &&` truthy short-circuit already rejects it. Bail early.
  if (needle === "") return undefined;
  for (const category of registry.categories) {
    for (const pill of category.pills) {
      if (
        pill.id === claim ||
        pill.id.toLowerCase() === needle ||
        (pill.name && pill.name.toLowerCase() === needle)
      ) {
        return { pill: pill.id, status: pill.status };
      }
    }
  }
  return undefined;
}

// ── Adapter ────────────────────────────────────────────────────────────────────

// Dedupe the manifest's declared feature list: trim-aware and case-insensitive
// on the pill id (matching lookupPill's trimmed, case-insensitive resolution),
// order-preserving, first occurrence wins — and the surviving value is the
// TRIMMED slug, so a whitespace-padded declaration never leaks padding into the
// title count, body, fused_from evidence refs, or (when allGreen) the
// validation targets. Blank
// (empty/whitespace-only) declarations reference no pill at all and are dropped
// outright — without this they would render a degenerate "- : unknown" body row
// and inflate the declared-feature count.
function dedupeFeatures(features: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const feature of features) {
    const trimmed = feature.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

// Build the "feature support" prose for the fragment body: one line per declared
// pill with its resolved support status (so the body is a faithful, self-contained
// statement of what the integration supports and at what maturity). A declared
// feature that does NOT resolve to any registry pill is reported as `unknown`
// (distinct from a pill that exists with `not_supported` status — the former is a
// dangling/typo'd reference, the latter a real "available but unsupported" pill).
// Takes the DEDUPED feature list (see dedupeFeatures); only called for a
// non-empty list: `extract` returns [] for a manifest with no declared features
// (a content-free fragment carries no knowledge).
function describeFeatureSupport(
  name: string,
  registry: FeatureRegistry,
  features: string[],
): string {
  const header = `${name} integration feature support:`;
  const lines = features.map((feature) => {
    const found = lookupPill(registry, feature);
    const status = found ? found.status : "unknown";
    return `- ${feature}: ${status}`;
  });
  return [header, ...lines].join("\n");
}

// The showcase leaf adapter. Produces exactly one fragment per integration: a
// `derived` knowledge candidate about which feature-registry pills the integration
// supports. The fragment is showcase-verified ONLY when EVERY declared pill is
// `green`; if any declared pill is `quarantined` / `not_supported` / unknown, the
// fragment stays `unverified` and is flagged for review (the §7 proof — a
// quarantined `gen-ui-interrupt` pill must not be treated as verified).
export const showcaseAdapter: LeafAdapter<ShowcaseUnit> = {
  // NOTE: the `derived` sourcetype NAMESPACE is shared with Tier-3 fusion —
  // aggregate.ts's fuseCluster also mints `derived:<subsystem>:<slug>` keys.
  // That sharing cannot collide harmfully: a key collision requires the same
  // subsystem AND the same claim slug, which by clusterKey's definition means
  // the two fragments state the SAME claim — and fusing / upsert-dedupe is the
  // designed outcome for same-claim rows, not corruption.
  sourcetype: "derived",

  async extract(
    unit: ShowcaseUnit,
    ctx: AdapterContext,
  ): Promise<CandidateFragment[]> {
    const { manifest, registry } = unit;

    // `integration` becomes the fragment's `subsystem` — a STRUCTURAL
    // canonical-key component (<sourcetype>:<subsystem>:<claim-slug>) — so an
    // empty/blank value would yield a degenerate key far downstream, away from
    // the identifiable producer. Fail loud at intake instead (mirrors the
    // notion adapter's unit.subsystem guard).
    if (manifest.integration.trim() === "") {
      throw new Error(
        `[atlas/adapters/showcase] manifest.integration is empty/blank for ` +
          `manifest "${manifest.name ?? "(unnamed)"}" — every ShowcaseManifest ` +
          `must carry a non-empty integration slug.`,
      );
    }

    // The guard above trim-CHECKS the integration; the kept value must be the
    // TRIMMED slug too. `subsystem` and `claimSlugHint` are STRUCTURAL
    // canonical-key components and `source_name` is a path — a padded
    // " langgraph " passing the guard must never land padded in any of them.
    const integration = manifest.integration.trim();

    const asOf = ctx.now.toISOString().slice(0, 10); // YYYY-MM-DD
    // Display name for the title/body: the manifest's name, trimmed; a missing
    // or blank/whitespace-only name falls back to the trimmed integration slug.
    const name = (manifest.name ?? integration).trim() || integration;

    // Dedupe ONCE at intake (trim-aware, blank-dropping); every downstream
    // consumer (title count, body, fused_from evidence refs, and — when
    // allGreen — the validation targets) uses this list so a duplicated or
    // padded declaration never inflates any of them.
    const features = dedupeFeatures(manifest.features);

    // A manifest whose declarations dedupe/filter to NOTHING (none declared,
    // or only blank entries) carries no feature-support knowledge — emitting a
    // fragment would produce a content-free `unverified`/`needsReview` row.
    // Skip it entirely (matching how the episodic / source-comment adapters
    // return [] for empty input). Checked on the DEDUPED list, not the raw
    // one: `[""]` declares nothing.
    if (features.length === 0) {
      return [];
    }

    // Resolve every declared pill; the integration is fully verified only when
    // each declared pill resolves to a `green` status.
    const resolved = features.map((feature) => lookupPill(registry, feature));
    const allGreen =
      resolved.length > 0 && resolved.every((r) => r?.status === "green");

    // CONTRACT NOTE (self-claimed verification): stamping `showcase-verified`
    // here at intake is the DESIGNED exception to S14-owned promotion — the
    // claim is gated on allGreen (every declared pill resolved green in the
    // registry), which IS the showcase verification oracle. validate.ts's
    // STATUS_RANK only promotes UP, never demotes, so S14 cannot undo it.
    const validation_status = allGreen ? "showcase-verified" : "unverified";
    const needsReview = !allGreen;

    // SINGLE SOURCE OF TRUTH for what the S14 gate may re-check: a candidate
    // hands validate.ts its declared pills ONLY when the integration is fully
    // green. A non-green candidate (quarantined / not_supported / unknown pill
    // anywhere in its declared set) emits NO targets — any target it carried
    // could fall through the S14 pill-skip into `grepTreeForSymbol`, substring/
    // token-match somewhere in the checkout, and spuriously promote the
    // candidate to `source-verified`, back-dooring the §7 quarantine (the
    // recurring gate-over-promotion bug). When allGreen holds, every declared
    // feature resolved to a green registry pill (that is what allGreen means),
    // so the deduped declared list is safe to emit — no second filter /
    // re-derivation path exists. Emit a COPY (never the manifest's array by
    // reference) so a downstream mutation of the targets cannot corrupt the
    // manifest. The body (describeFeatureSupport) still lists every declared
    // feature, so a human sees quarantined/unknown ones.
    const validationTargets = allGreen ? [...features] : [];

    // §3.3: sanitize the emitted content (and provenance.source) through the
    // shared env-reference pass immediately before returning the fragment. The
    // feature-support prose is registry-derived and low-risk, but the pass is
    // applied uniformly across the fleet so no adapter is a leak gap.
    const { content: sanitizedContent, source: sanitizedSource } =
      sanitizeEnvRefs(
        describeFeatureSupport(name, registry, features),
        "showcase",
      );

    const fragment: CandidateFragment = {
      sourcetype: "derived",
      subsystem: integration,
      claimSlugHint: `${integration}-feature-support`,
      source_name: `showcase/${integration}/manifest.yaml`,
      repo_url: manifest.repo_url,
      // `ref` is a git-ref field across the adapter fleet (branch / SHA). The
      // integration slug is NOT a git ref — it already lives in `subsystem` and
      // `source_name` — so the field stays unset for derived showcase knowledge.
      ref: undefined,
      // "declares", not "supports": the manifest is a declaration; a declared
      // pill may be quarantined/unknown, so "supports N" would overclaim. The
      // count is the UNIQUE declared features.
      title: `${name} declares ${features.length} showcase feature(s)`,
      content: sanitizedContent,
      provenance: {
        source: sanitizedSource,
        url: manifest.repo_url,
        date: asOf,
        validated_against: "showcase/shared/feature-registry.json",
        classification: {
          sensitivity: "public",
          knowledge_type: "product",
          audience: "all-staff",
          validation_status,
          confidence: allGreen ? "high" : "medium",
          provenance_class: "derived",
          freshness: { as_of: asOf },
        },
      },
      // `fused_from` provenance refs: the registry pills this DERIVED claim
      // was fused from — an audit surface, NOT what the S14 gate re-checks
      // (that is `validationTargets` below). Always emitted, allGreen or not,
      // so even an unverified fragment stays traceable to its pills.
      evidence: features.map((feature) => ({
        kind: "fused_from",
        ref: `feature-registry:${feature}`,
      })),
      needsReview,
      // Derived above, gated by allGreen — see the single-source-of-truth
      // note. THESE (not the evidence refs) are the symbols the S14
      // validation gate re-checks against the live feature-registry + D6
      // status via `lookupPill`.
      validationTargets,
    };

    return [fragment];
  },
};
