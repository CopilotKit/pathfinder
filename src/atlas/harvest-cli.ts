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

// ── Schemas (write-fragment subcommand) ────────────────────────────────────────
import {
  CandidateFragmentSchema,
  EpisodicCandidateFragmentSchema,
} from "./types.js";
import { claimSlug } from "./canonicalize.js";

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
import { promoteValidation, type ValidationContext } from "./validate.js";
import { loadValidationContext } from "./validate-checkout.js";
import { toSeedEntryRow, type Candidate } from "./types.js";
import {
  RunStore,
  CorruptRunManifestError,
  type RunManifest,
} from "./run-store.js";
import { AtlasHttpClient } from "./client.js";
import { generateApprovalArtifact } from "./artifact/generate.js";
import { syncApprovalArtifact } from "./artifact/sync.js";
import { OpenAIDistiller, type LlmDistiller } from "./llm.js";

// ── Storage layer (EXISTING, origin/main) ──────────────────────────────────────
import { upsertAtlasSeedCandidate } from "../db/atlas.js";

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
  // Minimum corpus-overlap similarity for the rag-dedup gate (forwarded).
  minOverlap?: number;
  // The validation context (read-only origin/main checkout + feature registry).
  // Required — the CLI assembles it from disk; tests inject a fixture context.
  validationContext: ValidationContext;
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

// Run the deterministic harvest pipeline over a run directory of fragments and
// (optionally) write the resulting candidates as `pending` atlas_seed_entries.
// Pure orchestration: every substantive transform lives in its own module; this
// just wires them in the spec §4 order. The rag-dedup gate runs BEFORE validate.
export async function runHarvest(
  opts: RunHarvestOptions,
): Promise<RunHarvestResult> {
  const runsDir = opts.runsDir ?? path.resolve("runs");
  const dedup = opts.deps?.dedup ?? dedupAgainstRagCorpus;
  const validate = opts.deps?.validate ?? promoteValidation;

  // 1. Read the Tier-1 fragment corpus off disk.
  const store = new RunStore(runsDir);
  const fragments = store.readFragments(opts.runId);

  // 1b. Record the run manifest — fragmentCount is what was just read; a prior
  //     manifest's ruleSet (the run's FINAL rule set, persisted by sync §11.5)
  //     is preserved, never clobbered. A corrupt prior manifest must not wedge
  //     the harvest: treat it as "no prior" and let writeManifest's repair path
  //     (which warns, naming the path) overwrite it. SKIPPED entirely on
  //     --dry-run, which writes NOTHING (not even the manifest).
  if (!opts.dryRun) {
    let prior: RunManifest | undefined;
    try {
      prior = store.readManifest(opts.runId);
    } catch (err) {
      if (!(err instanceof CorruptRunManifestError)) throw err;
      prior = undefined;
    }
    store.writeManifest(opts.runId, {
      fragmentCount: fragments.length,
      ruleSet: prior?.ruleSet ?? [],
    });
  }

  // 2. Tier-2 aggregate (cluster/dedup/fuse).
  const aggregated = aggregate(fragments);

  // 3. Finalize the classification flag-set per fragment.
  const finalized = aggregated.map((f) => finalizeClassification(f));

  // 4. Tier-3 canonicalize (key/dedup/supersede/rank).
  const candidates = canonicalize(finalized);

  // 5. RAG-dedup gate — BEFORE validate (spec §4). Marks/annotates corpus
  //    overlaps; NEVER drops. The rag-dedup ctx carries the live search probe.
  const ragCtx: RagDedupContext = {
    client: opts.ragClient,
    ...(opts.minOverlap !== undefined ? { minOverlap: opts.minOverlap } : {}),
  };
  const deduped = await dedup(candidates, ragCtx);

  // 6. Validation gate — promote validation_status + enforce approvability.
  //    validate can PROMOTE validation_status — the DOMINANT rank weight — so
  //    recompute each candidate's rankScore afterwards: the ARTIFACT path
  //    (generate's §11.1 per-subsystem sort) is what orders by the promoted
  //    value rather than the stale canonicalize-time one. The seed-row upsert
  //    in step 7 persists NO rankScore (toSeedEntryRow carries none) — what
  //    it persists from this phase is validate's status promotion; the
  //    recompute here keeps the run path symmetric with the artifact path's
  //    own re-rank. One freshness snapshot for the whole phase (matching
  //    canonicalize's own hoist) — a per-call Date.now() default would let
  //    epsilon clock skew across iterations jitter the relative ordering
  //    (fix11 AA12).
  const validated: Candidate[] = [];
  const now = Date.now();
  for (const cand of deduped) {
    validated.push(
      recomputeRankScore(await validate(cand, opts.validationContext), now),
    );
  }

  // 7. Persist — only when --upsert AND not --dry-run.
  let upsertedCount = 0;
  const willWrite = Boolean(opts.upsert) && !opts.dryRun;
  if (willWrite) {
    for (const cand of validated) {
      await upsertAtlasSeedCandidate(toSeedEntryRow(cand));
      upsertedCount += 1;
    }
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
  // Testing seam: override the validate step (defaults to promoteValidation).
  validate?: (cand: Candidate, ctx: ValidationContext) => Promise<Candidate>;
}

// Build the ranked candidate set the approval artifact renders, running the
// SAME validation stage as the `run` pipeline (aggregate → classify →
// canonicalize → validate). The rag-dedup gate is intentionally skipped here: it
// is MARK-ONLY (annotates provenance/evidence; never changes `approvable` or
// `validation_status`, see rag-dedup.ts), so omitting it does NOT diverge the
// GATE fields the approval decision binds to (`approvable`/`validation_status`)
// from what `run --upsert` writes. NOTE: rag-dedup's annotations (the
// `validated_against` marker and the `fused_from` corpus-evidence item — rank-neutral:
// the evidence ref is prefixed and filtered from evidence depth, so rankScore is
// unaffected) DO reach the upserted rows but NOT this
// artifact — the provenance/evidence rendered inline on the page is the
// pre-rag-dedup view. The validation gate,
// which DOES set `approvable`/`validation_status`, MUST run — so the artifact the
// lead approves reflects the same pipeline stage as the upserted rows.
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
  const validate = opts.validate ?? promoteValidation;
  const runsDir = opts.runsDir ?? path.resolve("runs");
  const store = new RunStore(runsDir);
  const fragments = store.readFragments(opts.runId);
  const candidates = canonicalize(
    aggregate(fragments).map((f) => finalizeClassification(f)),
  );
  // Re-rank after validation, exactly like `runHarvest` step 6: a promoted
  // validation_status (the dominant rank weight) must be reflected in the
  // rankScore the artifact's per-subsystem groups sort by (§11.1). One
  // freshness snapshot for the whole phase, matching canonicalize's own
  // hoist (fix11 AA12).
  const validated: Candidate[] = [];
  const now = Date.now();
  for (const cand of candidates) {
    validated.push(
      recomputeRankScore(await validate(cand, opts.validationContext), now),
    );
  }
  return validated;
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

  // Re-run the deterministic pipeline THROUGH the validation gate (the same
  // stage `run` applies) to obtain the ranked candidates the artifact lists.
  // rag-dedup is mark-only and never changes approvable/validation_status, so it
  // is intentionally skipped here. The artifact never writes DB rows itself.
  const runsDir = options.runsDir ?? path.resolve("runs");
  const store = new RunStore(runsDir);
  const candidates = await buildArtifactCandidates({
    runId: options.runId,
    runsDir,
    validationContext,
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

// ── write-fragment subcommand (spec §4.2) ──────────────────────────────────────
//
// Read a single CandidateFragment JSON object from stdin, validate it against
// the appropriate family schema (`CandidateFragmentSchema` for non-episodic,
// `EpisodicCandidateFragmentSchema` for episodic — the episodic schema layers
// the four episodic-invariant refinements on top of the base), and write the
// validated (and possibly sensitivity-coerced) fragment EXCLUSIVELY to
// `<runs-dir>/<run-id>/fragments/<stem>.json`.
//
// `--stem` is OPTIONAL: when omitted, the stem is derived from the fragment's
// canonical-key components (`claimSlug(<sourcetype>:<subsystem>:claimSlug(claimSlugHint || title))`)
// so two fragments with the same claim text but different sourcetype/subsystem
// don't collide. The derived stem is itself idempotent across the canonicalize
// path (claimSlug normalizes case/punctuation).
//
// Exit-code matrix (spec §4.2.1):
//   0 — success (fragment written; absolute path printed to stdout)
//   1 — stdin/IO failure (bad JSON, unreadable stdin, write error other than EEXIST)
//   2 — stem collision (file already exists; exclusive-create fails with EEXIST)
//   3 — schema validation failure (base CandidateFragmentSchema rejected the input,
//       OR an episodic input whose Zod error path is NOT one of the four episodic
//       invariants — i.e. a base-schema failure surfaced through the episodic parse)
//   4 — episodic invariant violation (sourcetype === "episodic" AND the Zod error
//       path identifies one of the four episodic invariants: needsReview,
//       provenance_class, confidence, validation_status)
//
// The fail-loud rule: stderr always carries the underlying error message; the
// exit code distinguishes the FAILURE CLASS so the caller (leaf adapter, CI
// gate) can route accordingly.

const EPISODIC_INVARIANT_FIELDS = new Set([
  "needsReview",
  "provenance_class",
  "confidence",
  "validation_status",
]);

interface WriteFragmentCliOptions {
  runId?: string;
  runsDir?: string;
  stem?: string;
}

// Read the entirety of an async iterable stream into a utf-8 string. Bounded
// only by available memory — fragments are small (a few KB each) so a full
// read is fine; streaming-parse would add complexity for zero benefit.
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// Inspect a ZodError's issues and decide whether the parse failure is purely
// an episodic-invariant refinement violation (exit 4) versus a base-schema
// failure that surfaced through the episodic parse (exit 3). The episodic
// schema's refinement paths are authored explicitly (see
// EpisodicCandidateFragmentSchema in types.ts); the four `.refine(...)` calls
// all emit Zod issues with `code: "custom"` (the default for refinements).
//
// Routing rules (per spec §4.2.1):
//   - Per-issue gate: only `code: "custom"` issues whose path-last lands on
//     one of EPISODIC_INVARIANT_FIELDS are candidates for exit 4. invalid_type
//     / invalid_enum_value / invalid_literal / unrecognized_keys etc. are
//     base-schema issues and route to exit 3 even when they land on a
//     refinement-named field.
//   - AND-case precedence: if ANY issue in the same ZodError is a non-custom
//     base-schema issue, the fragment isn't even valid CandidateFragment
//     shape, so the refinement verdict is moot — route to exit 3. Exit 3
//     ALWAYS wins over exit 4 when both apply.
//
// Exported for direct unit-testing of the AND-case precedence predicate;
// production callers reach it through the write-fragment command body below.
export function isEpisodicInvariantIssue(
  error: unknown,
): error is { issues: Array<{ path: (string | number)[]; message: string }> } {
  if (!error || typeof error !== "object") return false;
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues) || issues.length === 0) return false;
  // AND-case precedence: any non-custom issue downgrades the whole ZodError
  // to exit 3. A base-schema failure (invalid_type / invalid_enum_value /
  // invalid_literal / unrecognized_keys / etc.) means the fragment isn't a
  // valid CandidateFragment at all — the episodic-refinement verdict is moot.
  if (issues.some((issue) => (issue as { code?: unknown }).code !== "custom")) {
    return false;
  }
  // All issues are `code: "custom"`. At least one must point at an episodic
  // invariant for this to route to exit 4. A custom issue whose path-last is
  // NOT in EPISODIC_INVARIANT_FIELDS (e.g. the subsystem-delimiter refine on
  // the base CandidateFragmentSchema) is a base-schema-class refinement and
  // still routes to exit 3.
  return issues.some((issue) => {
    const path = (issue as { path?: (string | number)[] }).path;
    if (!Array.isArray(path) || path.length === 0) return false;
    const last = path[path.length - 1];
    return typeof last === "string" && EPISODIC_INVARIANT_FIELDS.has(last);
  });
}

// The write-fragment command body. Returns the exit code per §4.2.1; never
// throws — all failure classes are routed through the exit-code matrix.
export async function writeFragmentCommand(
  options: WriteFragmentCliOptions,
  writeOut: WriteFn,
  writeErr: WriteFn,
  stdinReader: () => Promise<string> = readAllStdin,
): Promise<number> {
  if (!options.runId) {
    writeErr("atlas-harvest write-fragment: --run-id is required\n");
    return 1;
  }
  if (!options.runsDir) {
    writeErr("atlas-harvest write-fragment: --runs-dir is required\n");
    return 1;
  }

  // 1. Read + JSON-parse stdin. Both stdin IO and JSON parse failures are
  //    exit 1 (stdin/IO class).
  let raw: string;
  try {
    raw = await stdinReader();
  } catch (err) {
    writeErr(
      `atlas-harvest write-fragment: stdin read failed: ${formatCliError(err)}\n`,
    );
    return 1;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    writeErr(
      `atlas-harvest write-fragment: stdin JSON parse failed: ${formatCliError(err)}\n`,
    );
    return 1;
  }

  // 2. Pick schema family by the fragment's `sourcetype` field. Inspect
  //    BEFORE parsing — we need the family to decide which schema to run and
  //    which exit-code class (3 vs 4) a failure maps to.
  const sourcetype =
    parsed && typeof parsed === "object"
      ? (parsed as { sourcetype?: unknown }).sourcetype
      : undefined;
  const isEpisodic = sourcetype === "episodic";
  const schema = isEpisodic
    ? EpisodicCandidateFragmentSchema
    : CandidateFragmentSchema;

  // 3. Parse against the chosen schema. On failure:
  //      - non-episodic OR an episodic base-schema failure → exit 3
  //      - episodic invariant refinement failure → exit 4
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const exitCode =
      isEpisodic && isEpisodicInvariantIssue(result.error) ? 4 : 3;
    const label =
      exitCode === 4
        ? "episodic invariant violation"
        : "schema validation failure";
    writeErr(
      `atlas-harvest write-fragment: ${label}: ${formatCliError(result.error)}\n`,
    );
    return exitCode;
  }
  const fragment = result.data as { sourcetype: string; subsystem: string };

  // 4. Resolve the stem — explicit `--stem` wins; otherwise derive from the
  //    fragment's canonical-key components (claimSlug normalizes the joined
  //    `claimSlug(<sourcetype>:<subsystem>:claimSlug(claimSlugHint || title))`
  //    to a filesystem-safe slug).
  let stem: string;
  if (options.stem !== undefined && options.stem !== "") {
    stem = options.stem;
  } else {
    const fragWithClaim = result.data as {
      sourcetype: string;
      subsystem: string;
      claimSlugHint?: string;
      title: string;
    };
    const claim = claimSlug(fragWithClaim.claimSlugHint || fragWithClaim.title);
    stem = claimSlug(
      `${fragWithClaim.sourcetype}:${fragWithClaim.subsystem}:${claim}`,
    );
  }

  // 4a. Filesystem-safe stem gate (spec §4.2.1, T-R4-4, T-R5-2). `--stem`
  //     flows into `path.join(fragmentsDir, ...)` and an unvalidated value
  //     like `../../evil` writes OUTSIDE the fragments directory. The
  //     `STEM_PATTERN` regex below enforces:
  //       - First character must be alphanumeric `[A-Za-z0-9]`. This blocks
  //         leading-dot hidden-file values (`.hidden`), leading-dash
  //         flag-confusable values (`-flag`), AND any leading-`..` traversal
  //         prefix (because `.` is not in the leading char class).
  //       - Subsequent characters limited to `[A-Za-z0-9._-]`. Any path
  //         separator (`/`, `\`) is rejected because it's outside the body
  //         class — so a stem cannot construct a multi-component path at all.
  //     Note: a substring `..` is permitted in the body (e.g. `foo..bar`),
  //     but is operationally safe — with no `/` separator available, it
  //     cannot construct a traversal sequence to escape `fragmentsDir`.
  //     This is the operator/input class — exit 1, BEFORE the mkdir/write
  //     attempt.
  const STEM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  if (!STEM_PATTERN.test(stem)) {
    writeErr(
      `atlas-harvest write-fragment: invalid stem "${stem}" — must match ${STEM_PATTERN}\n`,
    );
    return 1;
  }

  // 5. Write EXCLUSIVELY under `<runs-dir>/<run-id>/fragments/<stem>.json`.
  //    The mkdir step and the write step are intentionally NOT collapsed into
  //    one try/catch — they have DIFFERENT exit-code classes:
  //
  //      - mkdir failure (EEXIST against a non-dir path, EACCES, ENOSPC, ...)
  //        is an operator-environment problem and routes to exit 1.
  //      - writeFileSync EEXIST (file at the resolved stem path already
  //        exists) is the spec-intended "stem collision" case and routes to
  //        exit 2.
  //      - Any other writeFileSync failure (EACCES, ENOSPC, ...) is also
  //        exit 1.
  //
  //    Collapsing them would mis-route mkdir-EEXIST to exit 2 and mis-label
  //    mkdir-class IO errors as "write failed" (wrong syscall name).
  const fragmentsDir = path.join(options.runsDir, options.runId, "fragments");
  const filePath = path.join(fragmentsDir, `${stem}.json`);
  try {
    fs.mkdirSync(fragmentsDir, { recursive: true });
  } catch (err) {
    writeErr(
      `atlas-harvest write-fragment: mkdir failed for fragments dir ${fragmentsDir}: ${formatCliError(err)}\n`,
    );
    return 1;
  }
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(result.data, null, 2)}\n`, {
      encoding: "utf-8",
      flag: "wx",
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      writeErr(
        `atlas-harvest write-fragment: ${stem}.json already exists at ${filePath}\n`,
      );
      return 2;
    }
    writeErr(
      `atlas-harvest write-fragment: write failed for ${filePath}: ${formatCliError(err)}\n`,
    );
    return 1;
  }

  writeOut(`${path.resolve(filePath)}\n`);
  // Fragment received subsystem field — silence unused-var TS lint.
  void fragment;
  return 0;
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

  // The write-fragment subcommand has its OWN exit-code matrix (§4.2.1: 0/1/2/3/4)
  // that the standard commander error path cannot express. The action closes over
  // this slot and the outer return picks it up.
  let writeFragmentExitCode: number | undefined;

  program
    .command("write-fragment")
    .description(
      "Read a CandidateFragment from stdin and write it under " +
        "<runs-dir>/<run-id>/fragments/<stem>.json. When --stem is omitted, " +
        "the stem is derived as " +
        "claimSlug(<sourcetype>:<subsystem>:claimSlug(claimSlugHint || title)). " +
        "Exit codes per spec §4.2.1: 0 ok, 1 stdin/IO, 2 stem collision, " +
        "3 schema, 4 episodic invariant.",
    )
    .requiredOption(
      "--run-id <id>",
      "Run id under which the fragment is written",
    )
    .requiredOption(
      "--runs-dir <dir>",
      "Root directory of run corpora (e.g. ./runs)",
    )
    .option(
      "--stem <stem>",
      "Filesystem-safe fragment stem; if omitted, derived as " +
        "claimSlug(<sourcetype>:<subsystem>:claimSlug(claimSlugHint || title))",
    )
    .option(
      "--stdin",
      "Read fragment from stdin (no-op; stdin is always read — accepted for " +
        "spec-literal invocation compatibility, see §4.2.1)",
    )
    .action(async (options: WriteFragmentCliOptions) => {
      writeFragmentExitCode = await writeFragmentCommand(
        options,
        writeOut,
        writeErr,
      );
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    return writeFragmentExitCode ?? 0;
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
