// Approval-artifact GENERATE step (spec §11.1; plan §4.9 / S16).
//
// `generateApprovalArtifact` creates ONE Notion page per harvest run that the
// lead reviews and edits:
//
//   1. Exclusion-Rules section ON TOP — an editable bulleted list seeded by
//      merging, in order: the caller-supplied `rules`, then the PRIOR run's
//      manifest rule-set (via RunStore), then `DEFAULT_EXCLUSION_RULES`
//      (deduped; §11.5). The lead adds/edits/deletes rule bullets in place; the
//      sync slot (S17) reads them back.
//   2. Candidates grouped by subsystem into checkbox sections, in RANKED order
//      (rankScore desc — showcase-verified / high-confidence first, §11.1). Each
//      approvable candidate is a `to_do` (checked = approve) carrying its flags,
//      provenance, and evidence inline. An UNVERIFIED behavior fact
//      (approvable=false) is rendered as a NON-checkable note, not a to_do (§7).
//
// The block construction is delegated to notion-blocks.ts (shared with S17); this
// file owns the page assembly + the prior-run rule seeding. Notion is a non-LLM
// external service driven through `@notionhq/client` (mocked in tests per org
// rule — aimock is only for LLM calls).

import type { BlockObjectRequest, Client } from "@notionhq/client";
import type { Candidate } from "../types.js";
import { DEFAULT_EXCLUSION_RULES, type ExclusionRule } from "../exclude.js";
import type { RunStore } from "../run-store.js";
import {
  buildCandidateBlocks,
  buildExclusionRuleBlocks,
  coerceExclusionRule,
} from "./notion-blocks.js";

export interface GenerateApprovalArtifactOptions {
  // The Notion client (typed as the SDK `Client`; tests inject a mock).
  notion: Client;
  // The page under which the run's approval page is created.
  parentPageId: string;
  // This run's id — used as the page title so the artifact is greppable.
  runId: string;
  // The run's ranked candidates (already canonicalized/ranked, §4.5).
  candidates: Candidate[];
  // Caller-supplied seed rules. These are NEVER replaced — `mergeRules` always
  // merges them FIRST (caller intent), then any prior-run rules, then defaults
  // (all deduped). When a `runStore` + `priorRunId` are given, the prior run's
  // manifest rule-set is merged in after these. Pass `[]` to seed purely from
  // prior-run + defaults.
  //
  // Flag rules: only the four enum-valued dimensions are SUPPORTED end-to-end —
  // sensitivity, knowledge_type, validation_status, confidence. A flag rule on
  // freshness / audience / provenance_class RENDERS as a bullet on the page but
  // is warn-rejected by sync's `coerceExclusionRule` on the Notion read-back,
  // so it never enforces anything and never seeds the next run. (Caller rules
  // only — prior-run manifest rules are coerced through `coerceExclusionRule`
  // BEFORE render, so a malformed prior rule never reaches the page.)
  rules: ExclusionRule[];
  // Optional prior-run seeding inputs (§11.5). When both are present and the
  // prior run has a manifest, its `ruleSet` seeds the Exclusion-Rules section.
  runStore?: RunStore;
  priorRunId?: string;
}

export interface GenerateApprovalArtifactResult {
  pageId: string;
  url: string;
}

// Merge rule lists preserving first-seen order and dropping duplicates. Order:
// explicit `rules` first (caller intent), then prior-run rules, then defaults —
// so an edit the lead carried forward via a prior run sorts above the static
// defaults.
//
// The dedup key is built from the rule's FIXED fields, NOT `JSON.stringify(rule)`:
// stringify is object-key-order sensitive, so the SAME flag rule persisted with
// `{dimension, equals, kind}` and supplied with `{kind, dimension, equals}` would
// hash differently and emit a duplicate bullet. A field-derived key collapses
// them regardless of source key order.
function ruleDedupKey(rule: ExclusionRule): string {
  return rule.kind === "flag"
    ? `flag:${rule.dimension}:${rule.equals}`
    : `english:${rule.text}`;
}

function mergeRules(
  ...lists: ReadonlyArray<ReadonlyArray<ExclusionRule>>
): ExclusionRule[] {
  const seen = new Set<string>();
  const merged: ExclusionRule[] = [];
  for (const list of lists) {
    for (const rule of list) {
      const key = ruleDedupKey(rule);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(rule);
    }
  }
  return merged;
}

// Resolve the Exclusion-Rules seed set (§11.5): the prior run's persisted
// manifest rule-set (if a store + prior-run id are supplied), merged with the
// caller-supplied `rules` and the static defaults, deduped. With no prior run,
// this is just `rules ∪ DEFAULT_EXCLUSION_RULES`.
//
// An EXPLICITLY named prior run whose manifest is missing fails loud: the
// operator pointed at a specific run, and silently seeding defaults-only would
// drop every rule the lead curated on that run — the exact loss §11.5 exists to
// prevent. (A corrupt/invalid manifest already throws inside `readManifest`.)
function resolveSeedRules(
  opts: GenerateApprovalArtifactOptions,
): ExclusionRule[] {
  let priorRules: ExclusionRule[] = [];
  if (opts.runStore && opts.priorRunId) {
    const manifest = opts.runStore.readManifest(opts.priorRunId);
    if (!manifest) {
      throw new Error(
        `generateApprovalArtifact: prior run "${opts.priorRunId}" has no manifest in the run store — cannot seed its curated exclusion rules (mistyped run id, or a run that never completed?)`,
      );
    }
    // The run-store Zod-validates manifests on read, so this narrowing is
    // defensive redundancy for hand-edited manifest files: each persisted rule
    // is coerced back to the canonical `ExclusionRule` (anything malformed is
    // dropped with a warning inside `coerceExclusionRule`).
    priorRules = manifest.ruleSet
      .map(coerceExclusionRule)
      .filter((r): r is ExclusionRule => r !== null);
  }
  return mergeRules(opts.rules, priorRules, DEFAULT_EXCLUSION_RULES);
}

// Notion rejects any single pages.create / blocks.children.append request whose
// `children` carries more than 100 top-level blocks — and ALSO budgets the
// request by its TOTAL block count (top-level + nested children), rejecting
// around ~1000 blocks per request. A candidate to_do carries its provenance
// callout + evidence bullets as nested children (notion-blocks.ts caps them at
// ~97 per block), so batching by top-level count alone can still blow the total
// cap (100 evidence-heavy to_dos ≈ 9800 blocks). Batches are therefore budgeted
// on BOTH axes: ≤100 top-level blocks AND a conservative ≤800 total.
const NOTION_MAX_BLOCKS_PER_REQUEST = 100;
const NOTION_MAX_TOTAL_BLOCKS_PER_REQUEST = 800;

// A block-request's total block cost: itself PLUS every nested descendant, at
// any depth. Notion budgets a request by its TOTAL block count across all
// nesting levels, so the cost must recurse: a candidate to_do now carries a
// `toggle` whose OWN paragraph children are a second nesting level (to_do →
// toggle → paragraphs), and counting only the to_do's direct children would
// undercount the request — letting a batch silently exceed the ~1000-block cap
// and 400 the whole append.
function blockCost(block: BlockObjectRequest): number {
  const { type } = block as { type?: string };
  if (!type) return 1;
  const body = (
    block as unknown as Record<
      string,
      { children?: BlockObjectRequest[] } | undefined
    >
  )[type];
  const children = body?.children ?? [];
  let cost = 1;
  for (const child of children) cost += blockCost(child);
  return cost;
}

// Split the ordered block list into request batches obeying both Notion budgets
// (≤100 top-level, ≤800 total incl. nested children). Order-preserving: a batch
// is flushed exactly when the NEXT block would exceed either budget. A candidate
// block now nests a content toggle (whose OWN paragraph children add a second
// level) alongside its provenance callout + ≤~97 evidence bullets, so a single
// block's recursive cost is no longer bounded by a small constant: a candidate
// with a very long body carries many toggle paragraphs. Almost every candidate
// still fits a batch alone (evidence caps the bullets; typical bodies are one or
// two paragraphs), but a pathological body whose recursive blockCost alone
// exceeds the total-block budget could never fit ANY batch — emitting it would
// build a batch Notion 400s. Fail LOUD on that block instead of deferring the
// failure to the API.
function batchBlocks(children: BlockObjectRequest[]): BlockObjectRequest[][] {
  const batches: BlockObjectRequest[][] = [];
  let batch: BlockObjectRequest[] = [];
  let total = 0;
  for (const block of children) {
    const cost = blockCost(block);
    if (cost > NOTION_MAX_TOTAL_BLOCKS_PER_REQUEST) {
      throw new Error(
        `[atlas] a single block's total cost (${cost} blocks incl. nested children) exceeds ` +
          `the Notion per-request budget (${NOTION_MAX_TOTAL_BLOCKS_PER_REQUEST}); ` +
          `it cannot fit any batch and would 400 the append`,
      );
    }
    if (
      batch.length > 0 &&
      (batch.length + 1 > NOTION_MAX_BLOCKS_PER_REQUEST ||
        total + cost > NOTION_MAX_TOTAL_BLOCKS_PER_REQUEST)
    ) {
      batches.push(batch);
      batch = [];
      total = 0;
    }
    batch.push(block);
    total += cost;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

export async function generateApprovalArtifact(
  opts: GenerateApprovalArtifactOptions,
): Promise<GenerateApprovalArtifactResult> {
  const seedRules = resolveSeedRules(opts);

  // Exclusion-Rules section FIRST, then the subsystem-grouped, ranked candidate
  // checkboxes — batched up-front so the create AND every append obey both
  // Notion request budgets.
  const children = [
    ...buildExclusionRuleBlocks(seedRules),
    ...buildCandidateBlocks(opts.candidates),
  ];
  const batches = batchBlocks(children);

  const page = await opts.notion.pages.create({
    parent: { page_id: opts.parentPageId },
    properties: {
      title: {
        title: [
          {
            type: "text",
            text: { content: `Atlas Seed Review — ${opts.runId}` },
          },
        ],
      },
    },
    children: batches[0] ?? [],
  });

  // `pages.create` returns a page object with `id` + `url`. The live create path
  // always returns the full object; a response lacking `url` (a partial/archived
  // shape) is a real anomaly the caller relies on — fail loud rather than hand
  // back a silently-empty URL the lead can't open.
  const pageWithUrl = page as { id: string; url?: string };
  if (!pageWithUrl.url) {
    throw new Error(
      `generateApprovalArtifact: Notion pages.create returned no url for page "${pageWithUrl.id}" (run ${opts.runId})`,
    );
  }

  // Append everything past the create's batch, in order, each batch within
  // both request budgets. Sequential (not parallel) so the page's block order
  // is deterministic — Notion appends in request order per call.
  for (const batch of batches.slice(1)) {
    await opts.notion.blocks.children.append({
      block_id: pageWithUrl.id,
      children: batch,
    });
  }

  return { pageId: pageWithUrl.id, url: pageWithUrl.url };
}
