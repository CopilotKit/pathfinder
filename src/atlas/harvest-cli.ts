#!/usr/bin/env node
//
// Atlas HARVEST DRIVER (plan S18). This is the in-process driver CLI that runs
// the deterministic Tiers 2-3 of the harvest over a fragment corpus on disk and
// drives the live ratification / index endpoints. It is the SINGLE ASSEMBLY
// POINT for the leaf-adapter registry: it imports all seven per-source adapters
// (S3-S9) and builds the `LeafAdapterRegistry` per the S2 contract — there is NO
// shared `src/atlas/adapters/index.ts` (S3-S9 each own only their own adapter
// file and never edit a shared index, which avoids 7-slot file contention).
//
// NOTE: `src/atlas-cli.ts` is the consumer-side Atlas retrieval CLI
// (agent-facing search over Pathfinder MCP) — a different surface with its own
// env conventions. This driver now ALSO mounts there as the `atlas harvest`
// verb: atlas-cli forwards the remaining argv to `runAtlasHarvestCli`, so
// `atlas harvest run --run-id ...` behaves exactly like running this module
// directly (`npx tsx src/atlas/harvest-cli.ts run --run-id ...`).
//
// Pipeline (the spec §4 data-flow), per `run`:
//
//   RunStore.readFragments(runId)
//     → writeManifest                     (record fragmentCount; preserve prior ruleSet; skipped on --dry-run)
//     → aggregate                         (Tier-2 cluster/dedup/fuse)
//     → finalizeClassification (per frag) (normalize the 7-dim flag-set)
//     → canonicalize                      (Tier-3 key/dedup/supersede/rank)
//     → enforceDistillation               (A.1 why-vs-what gate — BEFORE rag-dedup)
//     → dedupAgainstRagCorpus             (RAG-dedup gate — BEFORE validate)
//     → promoteValidation (per candidate) (validation gate; rankScore recomputed after)
//     → toSeedEntryRow → upsertAtlasSeedCandidate  (only when --upsert; --dry-run writes NOTHING)
//
// Subcommands:
//   run      --run-id <id> --checkout <dir> --feature-registry <path> [--upsert] [--dry-run]   run the pipeline (preview / write pending rows; needs --token|ANALYTICS_TOKEN)
//   artifact --run-id <id> --parent <pageId> --checkout <dir> --feature-registry <path>        generate the Notion approval artifact (needs --notion-token|NOTION_TOKEN)
//   sync     --page <pageId> --actor <name>         read the edited page → enact approve/reject (needs BOTH --token|ANALYTICS_TOKEN and --notion-token|NOTION_TOKEN)
//   reindex  [--scope full|source|repo] [--source <s>] [--repo <url>]   queue a (scoped) reindex (needs --token|ANALYTICS_TOKEN)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError, Option } from "commander";
import { Client } from "@notionhq/client";

// ── The seven leaf adapters — imported HERE and nowhere else (assembly point) ──
import { memoryAdapter } from "./adapters/memory.js";
import { githubAdapter } from "./adapters/github.js";
import { notionAdapter } from "./adapters/notion.js";
import { linearAdapter } from "./adapters/linear.js";
import { episodicAdapter } from "./adapters/episodic.js";
import { sourceCommentAdapter } from "./adapters/source-comment.js";
import { showcaseAdapter } from "./adapters/showcase.js";
import type { LeafAdapterRegistry } from "./adapters/types.js";

// ── Pipeline stages ────────────────────────────────────────────────────────────
import { aggregate } from "./aggregate.js";
import { finalizeClassification } from "./classify.js";
import { canonicalize, recomputeRankScore } from "./canonicalize.js";
import { dedupAgainstRagCorpus, type RagDedupContext } from "./rag-dedup.js";
import {
  enforceDistillation,
  type DistillationJudge,
} from "./distillation-gate.js";
import { promoteValidation, type ValidationContext } from "./validate.js";
import { loadValidationContext } from "./validate-checkout.js";
import {
  toSeedEntryRow,
  type Candidate,
  type CorpusHit,
  type DistillDeltaResult,
} from "./types.js";
import {
  RunStore,
  CorruptRunManifestError,
  type RunManifest,
  type ExclusionRule,
} from "./run-store.js";
import { AtlasHttpClient } from "./client.js";
import { generateApprovalArtifact } from "./artifact/generate.js";
import { syncApprovalArtifact } from "./artifact/sync.js";
import { OpenAIDistiller, type LlmDistiller } from "./llm.js";

// ── Storage layer (EXISTING, origin/main) ──────────────────────────────────────
import { upsertAtlasSeedCandidate } from "../db/atlas.js";
import { searchChunks } from "../db/queries.js";

// ── Registry assembly (THE single place the map is populated) ───────────────────

// Build the populated `LeafAdapterRegistry`. The github adapter produces BOTH
// `github-pr` and `github-issue` fragments, so it is registered under both keys.
// The showcase adapter's declared sourcetype is `derived` (its fragments are a
// derived fusion of manifest + registry); source-comment is `agent-doc`. Each
// distinct adapter object appears once per sourcetype it serves.
export function buildLeafAdapterRegistry(): LeafAdapterRegistry {
  return {
    memory: memoryAdapter,
    episodic: episodicAdapter,
    "github-pr": githubAdapter,
    "github-issue": githubAdapter,
    "notion-doc": notionAdapter,
    "linear-doc": linearAdapter,
    "agent-doc": sourceCommentAdapter,
    derived: showcaseAdapter,
  };
}

// ── runHarvest — the testable pipeline core ─────────────────────────────────────

// Injectable pipeline steps (testing seam). Production leaves these unset and the
// real `dedupAgainstRagCorpus` / `promoteValidation` are used; tests pass order-
// recording wrappers to prove the rag-dedup-before-validate ordering (spec §4).
export interface RunHarvestDeps {
  dedup?: (cands: Candidate[], ctx: RagDedupContext) => Promise<Candidate[]>;
  validate?: (cand: Candidate, ctx: ValidationContext) => Promise<Candidate>;
}

export interface RunHarvestOptions {
  // The run id whose fragments are read from `<runsDir>/<runId>/fragments/*.json`.
  runId: string;
  // Root directory under which per-run directories live. Defaults to `./runs`.
  runsDir?: string;
  // Write pending rows via the existing upsert. When false/omitted the pipeline
  // runs as a PREVIEW (no DB writes).
  upsert?: boolean;
  // When true, the pipeline runs end-to-end but writes NOTHING (overrides
  // upsert). Lets a run be inspected without mutating the DB.
  dryRun?: boolean;
  // The Atlas HTTP client whose `search` the rag-dedup gate probes. Required —
  // the CLI builds one from baseUrl/token; tests inject a mocked client.
  ragClient: Pick<AtlasHttpClient, "search">;
  // Minimum LEXICAL (verbatim) corpus-overlap similarity for the rag-dedup gate
  // pre-filter (forwarded to RagDedupContext.minOverlap).
  minOverlap?: number;
  // NET-NEW (Theme B) semantic-dedup seams — top-level, NOT part of `deps`
  // (which carries only the deterministic dedup/validate transform seams).
  // `embed`/`distillDelta` are LLM seams and `vectorSearch` is a DB seam, so
  // like `judge` they are wired separately. When omitted, `runHarvest` defaults
  // to a real OpenAIDistiller-backed embed/distillDelta (honors OPENAI_BASE_URL)
  // and a searchChunks-backed vectorSearch; tests inject fixtures.
  //
  // Embed a text into a dense vector for the semantic probe.
  embed?: (text: string) => Promise<number[]>;
  // Cosine top-k retrieval over the corpus vector index.
  vectorSearch?: (vector: number[], k: number) => Promise<CorpusHit[]>;
  // Rewrite an overlapping candidate's content to its net-new delta.
  distillDelta?: (
    cand: Candidate,
    overlaps: CorpusHit[],
  ) => Promise<DistillDeltaResult>;
  // The validation context (read-only origin/main checkout + feature registry).
  // Required — the CLI assembles it from disk; tests inject a fixture context.
  validationContext: ValidationContext;
  // The A.1 distillation-gate judge (why-vs-what). NET-NEW top-level field, NOT
  // part of `deps` (which carries only the dedup/validate pipeline seams): the
  // gate's judge is an LLM seam, not a deterministic transform, so it is wired
  // separately. When omitted, `runHarvest` defaults to a real OpenAIDistiller-
  // backed judge (honors OPENAI_BASE_URL so tests can redirect to aimock);
  // tests inject a fixture judge here.
  judge?: DistillationJudge;
  // Testing seam (see RunHarvestDeps).
  deps?: RunHarvestDeps;
}

export interface RunHarvestResult {
  // Number of fragments read off disk.
  fragmentCount: number;
  // Number of finalized canonical candidates after aggregate/canonicalize.
  candidateCount: number;
  // Number of rows written via upsertAtlasSeedCandidate (0 unless --upsert and
  // NOT --dry-run).
  upsertedCount: number;
}

// ── The SHARED candidate-processing pipeline ────────────────────────────────────
//
// The single ordered candidate-transform sequence — aggregate → classify →
// canonicalize → distillation gate → rag-dedup → validate → re-rank — that BOTH
// the `run --upsert` path (runHarvest) and the approval-artifact path
// (buildArtifactCandidates) MUST run to produce IDENTICAL candidates. It is
// extracted into ONE function so the two callers are byte-identical by
// construction: they cannot diverge on which stages run or in what order.
//
// This is a ROOT-CAUSE fix for a recurring class of bug: the artifact path kept
// re-deriving its own copy of these stages and drifting from the upsert path
// (first it skipped the distillation gate; then, once that was added, it still
// skipped rag-dedup). Because the Theme-B SEMANTIC rag-dedup is NO LONGER
// mark-only — `applyDistillDelta` REWRITES `content` on a delta verdict and sets
// `approvable=false` on a no-delta verdict, both fields the approval page binds
// to — any path that skips rag-dedup renders content/approvable that differs
// from what `run --upsert` persists. Sharing the pipeline makes that class of
// divergence structurally impossible: there is only one pipeline.
//
// It reads fragments off disk, runs every substantive transform (each of which
// lives in its own module — this only wires them in the spec §4 order), and
// returns the fully-processed candidates. Persistence (upsert) and manifest
// bookkeeping are the CALLER's concern (runHarvest does them; the artifact path
// only renders) — this function writes NOTHING to the DB, so it is safe to call
// on both a --dry-run/preview and the artifact path.
export interface ProcessCandidatePipelineOptions {
  // The run id whose fragments are read from `<runsDir>/<runId>/fragments/*.json`.
  runId: string;
  // Root directory of the run corpora. Defaults to `./runs`.
  runsDir?: string;
  // The RunStore the fragments are read through. Injectable so a caller that
  // already built one (runHarvest, for its manifest work) shares the SAME store.
  store: RunStore;
  // The A.1 distillation-gate judge (why-vs-what).
  judge: DistillationJudge;
  // The live RAG-corpus lexical probe (rag-dedup pre-filter).
  ragClient: Pick<AtlasHttpClient, "search">;
  // Lexical verbatim-overlap threshold for the rag-dedup pre-filter.
  minOverlap?: number;
  // Theme-B semantic-dedup seams.
  embed: (text: string) => Promise<number[]>;
  vectorSearch: (vector: number[], k: number) => Promise<CorpusHit[]>;
  distillDelta: (
    cand: Candidate,
    overlaps: CorpusHit[],
  ) => Promise<DistillDeltaResult>;
  // The validation context (read-only origin/main checkout + feature registry).
  validationContext: ValidationContext;
  // Testing seams: override the deterministic dedup/validate transforms. Default
  // to the real dedupAgainstRagCorpus / promoteValidation.
  dedup?: (cands: Candidate[], ctx: RagDedupContext) => Promise<Candidate[]>;
  validate?: (cand: Candidate, ctx: ValidationContext) => Promise<Candidate>;
}

export async function processCandidatePipeline(
  opts: ProcessCandidatePipelineOptions,
): Promise<Candidate[]> {
  const dedup = opts.dedup ?? dedupAgainstRagCorpus;
  const validate = opts.validate ?? promoteValidation;

  // 1. Read the Tier-1 fragment corpus off disk.
  const fragments = opts.store.readFragments(opts.runId);

  // 2-4. Tier-2 aggregate → finalize classification → Tier-3 canonicalize.
  const candidates = canonicalize(
    aggregate(fragments).map((f) => finalizeClassification(f)),
  );

  // 4b. Distillation gate (A.1) — BETWEEN canonicalize and rag-dedup. Judges each
  //     candidate's why-vs-what quality: a pure WHAT restatement is stamped with
  //     RESTATEMENT_MARKER (the floor S4's validate reads → approvable=false), a
  //     salvageable claim is rewritten into why/how prose, a distilled claim
  //     passes untouched. NEVER drops; same-length output; input never mutated.
  const distilled = await enforceDistillation(candidates, { judge: opts.judge });

  // 5. RAG-dedup gate — BEFORE validate (spec §4). Detects corpus overlap
  //    (lexical verbatim pre-filter + semantic pgvector retrieval) and RESOLVES
  //    it via distill-to-delta. It is NO LONGER mark-only: on a SEMANTIC overlap
  //    a delta verdict REWRITES `content` and a no-delta verdict sets
  //    `approvable=false` (applyDistillDelta) — both fields the approval decision
  //    binds to. It NEVER drops. Running it HERE, on the SHARED pipeline, is what
  //    keeps the artifact's content/approvable identical to what `run --upsert`
  //    persists.
  //
  //    Pre-embed cost signal (spec §B fix (d)): the vector probe embeds each
  //    candidate that survives the lexical pre-filter — one embedding call
  //    apiece. Emit the estimated upper bound now that candidateCount is known,
  //    so a large run's embedding spend is visible before it is incurred.
  if (distilled.length > 0) {
    console.warn(
      `[rag-dedup] semantic dedup will embed up to ${distilled.length} candidate(s) ` +
        `(one /v1/embeddings call each for candidates surviving the lexical pre-filter)`,
    );
  }
  const ragCtx: RagDedupContext = {
    client: opts.ragClient,
    ...(opts.minOverlap !== undefined ? { minOverlap: opts.minOverlap } : {}),
    embed: opts.embed,
    vectorSearch: opts.vectorSearch,
    distillDelta: opts.distillDelta,
  };
  const deduped = await dedup(distilled, ragCtx);

  // 6. Validation gate — promote validation_status + enforce approvability.
  //    validate can PROMOTE validation_status — the DOMINANT rank weight — so
  //    recompute each candidate's rankScore afterwards: the ARTIFACT path
  //    (generate's §11.1 per-subsystem sort) is what orders by the promoted
  //    value rather than the stale canonicalize-time one, and the run path
  //    stays symmetric with it. One freshness snapshot for the whole phase
  //    (matching canonicalize's own hoist) — a per-call Date.now() default
  //    would let epsilon clock skew across iterations jitter the relative
  //    ordering (fix11 AA12).
  const validated: Candidate[] = [];
  const now = Date.now();
  for (const cand of deduped) {
    validated.push(
      recomputeRankScore(await validate(cand, opts.validationContext), now),
    );
  }
  return validated;
}

// The seams the shared pipeline needs that BOTH callers default IDENTICALLY when
// left unset: the distillation-gate judge and the Theme-B semantic-dedup
// embed/vectorSearch/distillDelta. Injected by tests; left unset in production so
// the real OpenAIDistiller / searchChunks defaults below are wired. Extracting
// the DEFAULTING here (rather than duplicating it in runHarvest and
// buildArtifactCandidates) is part of the same anti-divergence guarantee: the
// two callers cannot default a seam differently, because they don't default it
// themselves — this one resolver does. Production leaves them unset → the real
// OpenAIDistiller-backed judge/embed/distillDelta (honoring OPENAI_BASE_URL) and
// the searchChunks-backed vectorSearch; the lazy `buildLlm()` per-call keeps a
// preview/dry-run that never reaches the gate (empty corpus) from needing an
// OpenAI key. `dedup`/`validate` are deterministic-transform testing seams,
// passed through unchanged.
interface SharedPipelineSeamOverrides {
  judge?: DistillationJudge;
  embed?: (text: string) => Promise<number[]>;
  vectorSearch?: (vector: number[], k: number) => Promise<CorpusHit[]>;
  distillDelta?: (
    cand: Candidate,
    overlaps: CorpusHit[],
  ) => Promise<DistillDeltaResult>;
  dedup?: (cands: Candidate[], ctx: RagDedupContext) => Promise<Candidate[]>;
  validate?: (cand: Candidate, ctx: ValidationContext) => Promise<Candidate>;
}

function resolveSharedPipelineSeams(overrides: SharedPipelineSeamOverrides): {
  judge: DistillationJudge;
  embed: (text: string) => Promise<number[]>;
  vectorSearch: (vector: number[], k: number) => Promise<CorpusHit[]>;
  distillDelta: (
    cand: Candidate,
    overlaps: CorpusHit[],
  ) => Promise<DistillDeltaResult>;
  dedup?: (cands: Candidate[], ctx: RagDedupContext) => Promise<Candidate[]>;
  validate?: (cand: Candidate, ctx: ValidationContext) => Promise<Candidate>;
} {
  return {
    judge: overrides.judge ?? {
      judge: (c) => buildLlm().judgeDistillation(c),
    },
    embed: overrides.embed ?? ((text: string) => buildLlm().embed(text)),
    vectorSearch: overrides.vectorSearch ?? defaultVectorSearch,
    distillDelta:
      overrides.distillDelta ??
      ((cand: Candidate, overlaps: CorpusHit[]) =>
        buildLlm().distillDelta({
          title: cand.title,
          content: cand.content,
          overlaps: overlaps.map((h) => ({ content: h.content })),
        })),
    ...(overrides.dedup ? { dedup: overrides.dedup } : {}),
    ...(overrides.validate ? { validate: overrides.validate } : {}),
  };
}

// Run the deterministic harvest pipeline over a run directory of fragments and
// (optionally) write the resulting candidates as `pending` atlas_seed_entries.
// Pure orchestration: every substantive transform lives in its own module; this
// just wires them in the spec §4 order. The rag-dedup gate runs BEFORE validate.
export async function runHarvest(
  opts: RunHarvestOptions,
): Promise<RunHarvestResult> {
  const runsDir = opts.runsDir ?? path.resolve("runs");

  // 1. Read the Tier-1 fragment corpus off disk. The SAME RunStore is threaded
  //    through to the shared pipeline below, so both read the identical corpus.
  const store = new RunStore(runsDir);
  const fragments = store.readFragments(opts.runId);

  // 1b. Record the run manifest — fragmentCount is what was just read; a prior
  //     manifest's ruleSet (the run's FINAL rule set, persisted by sync §11.5)
  //     is preserved, never clobbered. A corrupt prior manifest must not wedge
  //     the harvest: treat it as "no prior" and let writeManifest's repair path
  //     (which warns, naming the path) overwrite it. SKIPPED entirely on
  //     --dry-run, which writes NOTHING (not even the manifest). The resolved
  //     `ruleSet` is captured so the run-completion marker write (step 7b) can
  //     re-persist it unchanged rather than re-reading a possibly-just-written
  //     manifest.
  let manifestRuleSet: ExclusionRule[] = [];
  if (!opts.dryRun) {
    let prior: RunManifest | undefined;
    try {
      prior = store.readManifest(opts.runId);
    } catch (err) {
      if (!(err instanceof CorruptRunManifestError)) throw err;
      prior = undefined;
    }
    manifestRuleSet = prior?.ruleSet ?? [];
    store.writeManifest(opts.runId, {
      fragmentCount: fragments.length,
      ruleSet: manifestRuleSet,
    });
  }

  // 2-6. The SHARED candidate-processing pipeline (aggregate → classify →
  //      canonicalize → distillation gate → rag-dedup → validate → re-rank).
  //      This is the IDENTICAL sequence buildArtifactCandidates runs — they call
  //      the SAME function, so the artifact's candidates cannot diverge from the
  //      rows this path upserts. Seams (judge / rag-dedup / semantic / validate)
  //      are resolved via the shared resolver so both callers default them the
  //      SAME way. The SAME RunStore is threaded in so both read one corpus.
  const validated = await processCandidatePipeline({
    runId: opts.runId,
    ...(opts.runsDir ? { runsDir: opts.runsDir } : {}),
    store,
    ragClient: opts.ragClient,
    ...(opts.minOverlap !== undefined ? { minOverlap: opts.minOverlap } : {}),
    validationContext: opts.validationContext,
    ...resolveSharedPipelineSeams({
      ...(opts.judge ? { judge: opts.judge } : {}),
      ...(opts.embed ? { embed: opts.embed } : {}),
      ...(opts.vectorSearch ? { vectorSearch: opts.vectorSearch } : {}),
      ...(opts.distillDelta ? { distillDelta: opts.distillDelta } : {}),
      ...(opts.deps?.dedup ? { dedup: opts.deps.dedup } : {}),
      ...(opts.deps?.validate ? { validate: opts.deps.validate } : {}),
    }),
  });

  // 7. Persist — only when --upsert AND not --dry-run.
  let upsertedCount = 0;
  const willWrite = Boolean(opts.upsert) && !opts.dryRun;
  if (willWrite) {
    for (const cand of validated) {
      await upsertAtlasSeedCandidate(toSeedEntryRow(cand));
      upsertedCount += 1;
    }
  }

  // 7b. Run-completion marker (C.4) — stamp `completedAt` + the `upsertedCount`
  //     just written into the manifest, but ONLY after a successful upsert. Its
  //     absence is the signal that a run is partial/aborted (crashed mid-upsert)
  //     or was a preview/dry-run that never persisted — so a preview run (no
  //     `--upsert`) and a `--dry-run` leave NO marker. `fragmentCount`/`ruleSet`
  //     are re-persisted unchanged (the marker never clobbers them), and
  //     `writeManifest` preserves `createdAt` and advances `updatedAt`. Written
  //     via the same `writeManifest` seam, so a re-run is idempotent: it simply
  //     re-stamps a fresh `completedAt`/`upsertedCount` over the prior marker.
  if (willWrite) {
    store.writeManifest(opts.runId, {
      fragmentCount: fragments.length,
      ruleSet: manifestRuleSet,
      completedAt: new Date().toISOString(),
      upsertedCount,
    });
  }

  return {
    fragmentCount: fragments.length,
    candidateCount: validated.length,
    upsertedCount,
  };
}

// ── Artifact candidate building ─────────────────────────────────────────────────

export interface BuildArtifactCandidatesOptions {
  // The run id whose fragments are read off disk.
  runId: string;
  // Root directory of the run corpora. Defaults to `./runs`.
  runsDir?: string;
  // The SAME validation context the `run` command builds. Required — the
  // artifact MUST run the identical validation stage as `run --upsert` so the
  // rendered `approvable`/`validation_status` matches the upserted rows.
  validationContext: ValidationContext;
  // The live RAG-corpus lexical probe. The artifact MUST run the SAME rag-dedup
  // gate `run --upsert` runs: the Theme-B semantic dedup REWRITES `content` and
  // sets `approvable=false` (applyDistillDelta), so skipping it would diverge the
  // artifact's content/approvable from the rows the approval page promises to
  // match. Required — the CLI's `artifact` command builds it from --url/--token
  // exactly as `run` does; tests inject a search stub.
  ragClient: Pick<AtlasHttpClient, "search">;
  // Lexical verbatim-overlap threshold for the rag-dedup pre-filter (matches
  // `run`'s --min-overlap).
  minOverlap?: number;
  // Theme-B semantic-dedup seams. Wired exactly like `runHarvest`: injected by
  // tests, else defaulted to the real OpenAIDistiller (embed/distillDelta) and a
  // searchChunks-backed vectorSearch, via the SAME shared resolver runHarvest
  // uses — so the two paths default them identically.
  embed?: (text: string) => Promise<number[]>;
  vectorSearch?: (vector: number[], k: number) => Promise<CorpusHit[]>;
  distillDelta?: (
    cand: Candidate,
    overlaps: CorpusHit[],
  ) => Promise<DistillDeltaResult>;
  // Testing seams: override the deterministic dedup/validate transforms
  // (default to dedupAgainstRagCorpus / promoteValidation).
  dedup?: (cands: Candidate[], ctx: RagDedupContext) => Promise<Candidate[]>;
  validate?: (cand: Candidate, ctx: ValidationContext) => Promise<Candidate>;
  // The A.1 distillation-gate judge (why-vs-what). Wired exactly like
  // `runHarvest`'s `judge`: injected by tests, else a real OpenAIDistiller-
  // backed judge (honors OPENAI_BASE_URL). The artifact MUST run the SAME
  // distillation gate `run --upsert` runs, or a restatement/rewritten candidate
  // diverges from the rows the approval page promises to match.
  judge?: DistillationJudge;
}

// Build the ranked candidate set the approval artifact renders. It runs the
// EXACT SAME candidate-processing pipeline as `run --upsert` — by calling the
// SHARED `processCandidatePipeline` both paths use (aggregate → classify →
// canonicalize → distillation gate → rag-dedup → validate → re-rank) — so the
// rendered content / approvable / validation_status are IDENTICAL to the rows
// `run --upsert` persists, by construction. This is the root-cause fix for the
// recurring divergence: the two paths cannot drift on which stages run or in
// what order, because there is only ONE pipeline. In particular the rag-dedup
// gate now RUNS here (it used to be skipped): the Theme-B semantic dedup is no
// longer mark-only — `applyDistillDelta` REWRITES `content` on a delta verdict
// and floors `approvable=false` on a no-delta verdict, both of which the
// approval page binds to. The artifact never writes DB rows itself — persistence
// is `run --upsert`'s job; this only reads fragments and renders.
export async function buildArtifactCandidates(
  opts: BuildArtifactCandidatesOptions,
): Promise<Candidate[]> {
  // Defensive library-entry guard: this function receives an already-assembled
  // ValidationContext (the CLI's `artifact` command enforces the --checkout /
  // --feature-registry flags and builds it via loadValidationContext before
  // calling here). A context is required so the rendered approvable/status
  // matches what `run --upsert` writes.
  if (!opts.validationContext) {
    throw new Error(
      "atlas-harvest artifact: buildArtifactCandidates requires a " +
        "ValidationContext so the rendered approvable/status matches what " +
        "`run --upsert` writes.",
    );
  }
  const runsDir = opts.runsDir ?? path.resolve("runs");
  const store = new RunStore(runsDir);
  // Delegate to the SHARED pipeline — identical to runHarvest's steps 2-6.
  // Seams (judge / semantic-dedup / dedup / validate) default via the SAME
  // resolver runHarvest uses, so neither path can default a seam differently.
  return processCandidatePipeline({
    runId: opts.runId,
    ...(opts.runsDir ? { runsDir: opts.runsDir } : {}),
    store,
    ragClient: opts.ragClient,
    ...(opts.minOverlap !== undefined ? { minOverlap: opts.minOverlap } : {}),
    validationContext: opts.validationContext,
    ...resolveSharedPipelineSeams({
      ...(opts.judge ? { judge: opts.judge } : {}),
      ...(opts.embed ? { embed: opts.embed } : {}),
      ...(opts.vectorSearch ? { vectorSearch: opts.vectorSearch } : {}),
      ...(opts.distillDelta ? { distillDelta: opts.distillDelta } : {}),
      ...(opts.dedup ? { dedup: opts.dedup } : {}),
      ...(opts.validate ? { validate: opts.validate } : {}),
    }),
  });
}

// ── min-overlap parsing ─────────────────────────────────────────────────────────

// Parse + validate the `--min-overlap` flag. A bare `Number(...)` yields NaN for
// a non-numeric flag, and rag-dedup's `overlap < NaN` is always false — so the
// gate's pass-through branch never fires and EVERY probed candidate with a best
// hit gets MARKED (annotation noise across the whole corpus), regardless of how
// weak the overlap is. Fail LOUD instead: the value must be a finite number
// within [0,1].
export function parseMinOverlap(raw: string): number {
  // `Number("")` (and whitespace-only) is 0 — finite and in [0,1] — so an
  // empty flag value (e.g. `--min-overlap "$UNSET_VAR"` under shell quoting)
  // would otherwise SILENTLY set the threshold to 0 and mark every probed
  // candidate with any best hit. An explicit "0" still parses below.
  if (raw.trim() === "") {
    throw new Error(
      `atlas-harvest: --min-overlap must be a finite number in [0,1], got "${raw}".`,
    );
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      `atlas-harvest: --min-overlap must be a finite number in [0,1], got "${raw}".`,
    );
  }
  return value;
}

// ── CLI plumbing ─────────────────────────────────────────────────────────────--

type WriteFn = (text: string) => void;

// NOTE: advisory console.warn output deliberately bypasses this injected io (it goes to process stderr).
interface HarvestCliIo {
  stdout?: WriteFn;
  stderr?: WriteFn;
}

// Resolve the bearer token + base URL the harvest drives the live endpoints
// with. Conventions: PATHFINDER_BASE_URL (defaulting to the local dev server)
// and ANALYTICS_TOKEN — the same bearer the server's ratification routes
// authenticate with (src/server.ts). NOTE: src/atlas-cli.ts uses its OWN,
// different env conventions (ATLAS_MCP_URL / ATLAS_TOKEN); the harvest does
// not mirror those.
const DEFAULT_BASE_URL = "http://localhost:3001";

// Exported for tests. When BOTH the --url flag and PATHFINDER_BASE_URL are
// absent, warn before falling back: `sync` ENACTS approve/reject through the
// client this URL builds, so a forgotten env var would otherwise ratify
// against a local dev server with zero signal (Y11). Empty/whitespace-only
// values count as ABSENT (the module's trim-nullify empty-is-absent rule,
// now shared with resolveToken) — `PATHFINDER_BASE_URL=""` must hit this
// warn-and-fallback path, not be returned silently as an unparseable base
// URL that only surfaces later as an opaque fetch error (fix10 Z2, X8 class).
export function resolveBaseUrl(flag?: string): string {
  const resolved =
    (flag?.trim() || undefined) ??
    (process.env.PATHFINDER_BASE_URL?.trim() || undefined);
  if (resolved !== undefined) return resolved;
  console.warn(
    `[atlas] no --url flag and PATHFINDER_BASE_URL is unset — falling back to ` +
      `${DEFAULT_BASE_URL} (a local dev server). Pass --url or set ` +
      `PATHFINDER_BASE_URL to target the real Pathfinder instance.`,
  );
  return DEFAULT_BASE_URL;
}

// Exported for tests. Empty/whitespace-only values count as ABSENT (the
// module's trim-nullify empty-is-absent rule, shared with resolveBaseUrl) —
// a whitespace-only --token or ANALYTICS_TOKEN would otherwise be truthy,
// dodge the throw below, and ship as `Bearer "   "` (an opaque 401 later
// instead of the loud configuration error here) (fix11 AA2).
export function resolveToken(flag?: string): string {
  const token =
    (flag?.trim() || undefined) ??
    (process.env.ANALYTICS_TOKEN?.trim() || undefined);
  if (!token) {
    throw new Error(
      "atlas-harvest: a bearer token is required — pass --token or set ANALYTICS_TOKEN.",
    );
  }
  return token;
}

function buildHttpClient(flags: {
  url?: string;
  token?: string;
}): AtlasHttpClient {
  return new AtlasHttpClient({
    baseUrl: resolveBaseUrl(flags.url),
    token: resolveToken(flags.token),
  });
}

function buildLlm(): LlmDistiller {
  // Reuses the openai dep; honors OPENAI_BASE_URL so it can be redirected.
  return new OpenAIDistiller();
}

// Default vectorSearch seam: cosine top-k retrieval over the SAME chunks corpus
// the indexer writes (db/queries.ts:searchChunks), mapped to the CorpusHit shape
// the rag-dedup gate + distill-to-delta consume. `similarity` is 1 - cosine
// distance in [0,1] (searchChunks already coerces it to a finite number).
async function defaultVectorSearch(
  vector: number[],
  k: number,
): Promise<CorpusHit[]> {
  const rows = await searchChunks(vector, k);
  return rows.map((r) => ({
    similarity: r.similarity,
    content: r.content,
    id: r.id,
    title: r.title,
    sourceUrl: r.source_url,
    sourceName: r.source_name,
  }));
}

interface RunCliOptions {
  runId?: string;
  runsDir?: string;
  upsert?: boolean;
  dryRun?: boolean;
  url?: string;
  token?: string;
  checkout?: string;
  featureRegistry?: string;
  minOverlap?: string;
}

async function runCommand(
  options: RunCliOptions,
  write: WriteFn,
): Promise<void> {
  if (!options.runId)
    throw new Error("atlas-harvest run: --run-id is required");
  if (!options.checkout) {
    throw new Error(
      "atlas-harvest run: --checkout <dir> is required (read-only origin/main checkout for validation)",
    );
  }
  if (!options.featureRegistry) {
    throw new Error(
      "atlas-harvest run: --feature-registry <path> is required (showcase feature-registry JSON)",
    );
  }

  const validationContext = loadValidationContext({
    checkoutDir: options.checkout,
    featureRegistryPath: options.featureRegistry,
  });

  const result = await runHarvest({
    runId: options.runId,
    ...(options.runsDir ? { runsDir: options.runsDir } : {}),
    upsert: Boolean(options.upsert),
    dryRun: Boolean(options.dryRun),
    ragClient: buildHttpClient(options),
    ...(options.minOverlap !== undefined
      ? { minOverlap: parseMinOverlap(options.minOverlap) }
      : {}),
    validationContext,
  });

  const mode = options.dryRun
    ? "dry-run"
    : options.upsert
      ? "upsert"
      : "preview";
  write(
    `atlas-harvest run [${mode}] run-id=${options.runId}: ` +
      `${result.fragmentCount} fragments → ${result.candidateCount} candidates ` +
      `→ ${result.upsertedCount} upserted\n`,
  );
}

interface ArtifactCliOptions {
  runId?: string;
  parent?: string;
  runsDir?: string;
  priorRunId?: string;
  notionToken?: string;
  checkout?: string;
  featureRegistry?: string;
  // The artifact now runs the SAME rag-dedup gate as `run` (see
  // buildArtifactCandidates), so it needs the SAME live-endpoint credentials
  // (--url/--token) and the SAME --min-overlap knob `run` takes.
  url?: string;
  token?: string;
  minOverlap?: string;
}

async function artifactCommand(
  options: ArtifactCliOptions,
  write: WriteFn,
): Promise<void> {
  if (!options.runId)
    throw new Error("atlas-harvest artifact: --run-id is required");
  if (!options.parent)
    throw new Error("atlas-harvest artifact: --parent <pageId> is required");
  // The artifact MUST run the SAME validation stage as `run --upsert` so the
  // rendered approvable/validation_status matches the rows the lead's approval
  // will eventually upsert. That requires the same checkout + feature-registry.
  if (!options.checkout) {
    throw new Error(
      "atlas-harvest artifact: --checkout <dir> is required (read-only origin/main checkout for validation, matching `run`)",
    );
  }
  if (!options.featureRegistry) {
    throw new Error(
      "atlas-harvest artifact: --feature-registry <path> is required (showcase feature-registry JSON, matching `run`)",
    );
  }

  const notionToken = options.notionToken ?? process.env.NOTION_TOKEN;
  if (!notionToken) {
    throw new Error(
      "atlas-harvest artifact: a Notion token is required — pass --notion-token or set NOTION_TOKEN.",
    );
  }

  // Advisory, not a gate (mirrors sync's --run-id warn): without a prior run id
  // the page's Exclusion-Rules section seeds from DEFAULT_EXCLUSION_RULES,
  // silently dropping the rule-set the lead curated on the previous run (§11.5
  // rule continuity). Legitimate on a genuine FIRST run — hence a warn.
  if (!options.priorRunId) {
    console.warn(
      "[atlas] artifact: --prior-run-id not provided — the Exclusion-Rules section seeds from defaults, not a prior run's edited rule-set",
    );
  }

  const validationContext = loadValidationContext({
    checkoutDir: options.checkout,
    featureRegistryPath: options.featureRegistry,
  });

  // Re-run the deterministic pipeline to obtain the ranked candidates the
  // artifact lists. buildArtifactCandidates calls the SHARED
  // processCandidatePipeline that `run --upsert` uses, so the rendered
  // content / approvable / validation_status match the rows the lead's
  // approval will upsert — INCLUDING the rag-dedup gate (whose Theme-B
  // semantic dedup rewrites content / floors approvable). That gate needs the
  // live RAG-corpus probe, so build the SAME HTTP client `run` does and pass
  // the SAME --min-overlap knob. The artifact never writes DB rows itself.
  const runsDir = options.runsDir ?? path.resolve("runs");
  const store = new RunStore(runsDir);
  const candidates = await buildArtifactCandidates({
    runId: options.runId,
    runsDir,
    validationContext,
    ragClient: buildHttpClient(options),
    ...(options.minOverlap !== undefined
      ? { minOverlap: parseMinOverlap(options.minOverlap) }
      : {}),
  });

  const artifact = await generateApprovalArtifact({
    notion: new Client({ auth: notionToken }),
    parentPageId: options.parent,
    runId: options.runId,
    candidates,
    rules: [],
    runStore: store,
    ...(options.priorRunId ? { priorRunId: options.priorRunId } : {}),
  });

  write(
    `atlas-harvest artifact run-id=${options.runId}: created page ${artifact.pageId} ${artifact.url}\n`,
  );
}

interface SyncCliOptions {
  page?: string;
  actor?: string;
  runId?: string;
  runsDir?: string;
  url?: string;
  token?: string;
  notionToken?: string;
}

async function syncCommand(
  options: SyncCliOptions,
  write: WriteFn,
): Promise<void> {
  if (!options.page)
    throw new Error("atlas-harvest sync: --page <pageId> is required");
  if (!options.actor)
    throw new Error("atlas-harvest sync: --actor <name> is required");

  const notionToken = options.notionToken ?? process.env.NOTION_TOKEN;
  if (!notionToken) {
    throw new Error(
      "atlas-harvest sync: a Notion token is required — pass --notion-token or set NOTION_TOKEN.",
    );
  }

  // §11.5: the run's FINAL exclusion-rule set is persisted into the run
  // manifest only when sync knows which run it belongs to. Without --run-id
  // the lead's edited rules are still ENFORCED for this sync, but the next
  // run's artifact cannot seed from them — warn so the omission is a choice,
  // not a silent loss.
  if (!options.runId) {
    console.warn(
      "[atlas] sync: --run-id not provided — the final exclusion-rule set will NOT be persisted to a run manifest (next run's artifact cannot seed from it)",
    );
  }

  const runsDir = options.runsDir ?? path.resolve("runs");
  const result = await syncApprovalArtifact({
    notion: new Client({ auth: notionToken }),
    pageId: options.page,
    client: buildHttpClient(options),
    actor: options.actor,
    llm: buildLlm(),
    ...(options.runId
      ? { runStore: new RunStore(runsDir), runId: options.runId }
      : {}),
  });

  write(
    `atlas-harvest sync page=${options.page}: ` +
      `${result.approved.length} approved, ${result.rejected.length} rejected, ` +
      `${result.excluded.length} excluded-by-rule, ` +
      `${result.conflicted.length} conflicted\n`,
  );
}

interface ReindexCliOptions {
  scope?: "full" | "source" | "repo";
  source?: string;
  repo?: string;
  url?: string;
  token?: string;
}

async function reindexCommand(
  options: ReindexCliOptions,
  write: WriteFn,
): Promise<void> {
  const scope = options.scope ?? "full";
  // Fail loud when a scoped reindex is missing its target — a "source" reindex
  // with no --source (or "repo" with no --repo) would otherwise queue a job
  // that silently does nothing useful.
  if (scope === "source" && !options.source) {
    throw new Error(
      "atlas-harvest reindex: --scope source requires --source <s>.",
    );
  }
  if (scope === "repo" && !options.repo) {
    throw new Error(
      "atlas-harvest reindex: --scope repo requires --repo <url>.",
    );
  }
  await buildHttpClient(options).reindex({
    scope,
    ...(options.source ? { source: options.source } : {}),
    ...(options.repo ? { repo: options.repo } : {}),
  });
  write(
    `atlas-harvest reindex queued: scope=${scope}` +
      `${options.source ? ` source=${options.source}` : ""}` +
      `${options.repo ? ` repo=${options.repo}` : ""}\n`,
  );
}

// Format a CLI error for stderr, walking the `{cause}` chain (bounded depth).
// Several pipeline failures deliberately attach the underlying error as
// `cause` — e.g. rag-dedup's consecutive-probe fail-fast wraps the ACTUAL
// network error (the thing you need to diagnose url/auth). Printing only the
// outer `.message` would discard exactly that diagnosis.
const MAX_CAUSE_DEPTH = 5;

export function formatCliError(error: unknown): string {
  const messageOf = (e: unknown): string =>
    e instanceof Error ? e.message : String(e);
  let out = messageOf(error);
  let cause: unknown = error instanceof Error ? error.cause : undefined;
  // `!= null` (not `!== undefined`): an explicit `cause: null` is non-undefined
  // and would print a useless "caused by: null" hop.
  for (let depth = 0; cause != null && depth < MAX_CAUSE_DEPTH; depth++) {
    out += `\n  caused by: ${messageOf(cause)}`;
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return out;
}

export async function runAtlasHarvestCli(
  argv: string[] = process.argv.slice(2),
  io: HarvestCliIo = {},
): Promise<number> {
  const writeOut = io.stdout ?? ((text: string) => process.stdout.write(text));
  const writeErr = io.stderr ?? ((text: string) => process.stderr.write(text));

  const program = new Command();
  program
    .name("atlas-harvest")
    .description(
      "Atlas harvest driver — runs the deterministic pipeline over a fragment " +
        "corpus and drives the live ratification / index endpoints.",
    )
    .exitOverride()
    .configureOutput({
      writeOut,
      writeErr,
      outputError: (text, write) => write(text),
    });

  program
    .command("run")
    .description(
      "Run the in-process pipeline (aggregate → classify → canonicalize → " +
        "rag-dedup → validate) over a run's fragments; with --upsert, write " +
        "pending rows.",
    )
    .requiredOption("--run-id <id>", "Run id whose fragments are processed")
    .option(
      "--runs-dir <dir>",
      "Root directory of run corpora (default: ./runs)",
    )
    .option("--upsert", "Write the resulting candidates as pending rows")
    .option(
      "--dry-run",
      "Run the pipeline but write NOTHING (overrides --upsert)",
    )
    .option(
      "--checkout <dir>",
      "Read-only origin/main checkout for source-verify",
    )
    .option("--feature-registry <path>", "Showcase feature-registry JSON path")
    .option("--min-overlap <n>", "RAG-dedup overlap threshold in [0,1]")
    .option(
      "--url <url>",
      "Pathfinder base URL (for the rag-dedup search probe)",
    )
    .option("--token <token>", "Bearer token (ANALYTICS_TOKEN)")
    .action(async (options: RunCliOptions) => {
      await runCommand(options, writeOut);
    });

  program
    .command("artifact")
    .description("Generate the per-run Notion approval artifact")
    .requiredOption("--run-id <id>", "Run id the artifact is for")
    .requiredOption("--parent <pageId>", "Parent Notion page id")
    .option(
      "--runs-dir <dir>",
      "Root directory of run corpora (default: ./runs)",
    )
    .option(
      "--checkout <dir>",
      "Read-only origin/main checkout for source-verify (must match `run`)",
    )
    .option(
      "--feature-registry <path>",
      "Showcase feature-registry JSON path (must match `run`)",
    )
    .option("--prior-run-id <id>", "Prior run id to seed exclusion rules from")
    .option("--notion-token <token>", "Notion integration token (NOTION_TOKEN)")
    .option("--min-overlap <n>", "RAG-dedup overlap threshold in [0,1] (matches `run`)")
    .option(
      "--url <url>",
      "Pathfinder base URL (for the rag-dedup search probe, matching `run`)",
    )
    .option("--token <token>", "Bearer token (ANALYTICS_TOKEN, matching `run`)")
    .action(async (options: ArtifactCliOptions) => {
      await artifactCommand(options, writeOut);
    });

  program
    .command("sync")
    .description(
      "Read the edited approval page and enact approve/reject via the live endpoints",
    )
    .requiredOption("--page <pageId>", "Approval page id to sync")
    .requiredOption(
      "--actor <name>",
      "Attribution stamped on each ratification",
    )
    .option("--run-id <id>", "Run id to persist the final rule-set into")
    .option(
      "--runs-dir <dir>",
      "Root directory of run corpora (default: ./runs)",
    )
    .option("--url <url>", "Pathfinder base URL")
    .option("--token <token>", "Bearer token (ANALYTICS_TOKEN)")
    .option("--notion-token <token>", "Notion integration token (NOTION_TOKEN)")
    .action(async (options: SyncCliOptions) => {
      await syncCommand(options, writeOut);
    });

  program
    .command("reindex")
    .description("Queue a (scoped) reindex via POST /admin/reindex")
    .addOption(
      // `.choices()` so a typo'd scope fails at parse time with the allowed
      // values, instead of silently queueing a bogus-scope reindex.
      new Option("--scope <scope>", "Reindex scope")
        .choices(["full", "source", "repo"])
        .default("full"),
    )
    .option("--source <s>", "Source name (for --scope source)")
    .option("--repo <url>", "Repo url (for --scope repo)")
    .option("--url <url>", "Pathfinder base URL")
    .option("--token <token>", "Bearer token (ANALYTICS_TOKEN)")
    .action(async (options: ReindexCliOptions) => {
      await reindexCommand(options, writeOut);
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    writeErr(`error: ${formatCliError(error)}\n`);
    return 1;
  }
}

// ── Entrypoint guard (mirrors src/atlas-cli.ts) ─────────────────────────────────

export function isHarvestCliEntrypoint(
  moduleUrl: string,
  argvPath: string | undefined,
): boolean {
  if (!argvPath) return false;
  return (
    resolveEntrypointPath(fileURLToPath(moduleUrl)) ===
    resolveEntrypointPath(argvPath)
  );
}

function resolveEntrypointPath(candidatePath: string): string {
  const normalizedPath = path.resolve(candidatePath);
  try {
    return fs.realpathSync(normalizedPath);
  } catch {
    return normalizedPath;
  }
}

if (isHarvestCliEntrypoint(import.meta.url, process.argv[1])) {
  runAtlasHarvestCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`error: ${formatCliError(error)}\n`);
      process.exitCode = 1;
    });
}
