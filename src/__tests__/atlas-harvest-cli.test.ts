// Harvest-driver CLI integration tests (plan S18 / §4 data-flow).
//
// S18 is the DRIVER slot: `src/atlas/harvest-cli.ts` is the SINGLE assembly
// point for the leaf-adapter registry AND the in-process pipeline that turns a
// run directory of CandidateFragment JSON files into `pending` atlas_seed_entries
// rows. This suite drives the exported `runHarvest(opts)` directly (no
// subprocess) against a REAL test Postgres (PGlite via `__setPoolForTesting`,
// mirroring atlas-upsert-integration.test.ts / atlas-db.test.ts — the org rule
// is explicit: never mock the DB for SQL semantics).
//
// What is asserted:
//   1. Registry assembly — `buildLeafAdapterRegistry()` wires all seven
//      adapters; every CandidateFragment sourcetype resolves via `getAdapter`.
//   2. `run --upsert` — a fixture run dir flows through the full pipeline and
//      writes `pending` rows (one per canonical candidate).
//   3. `--dry-run` writes NOTHING — the same run with `dryRun:true` leaves the
//      table empty.
//   4. PIPELINE ORDER — rag-dedup runs BEFORE validate (spec §4 data-flow). We
//      inject order-recording wrappers around the dedup + validate steps and
//      assert dedup is observed first.
//   5. RUN MANIFEST — `runHarvest` records the run manifest (fragmentCount;
//      prior ruleSet preserved; corrupt manifest repaired) and a --dry-run
//      writes NO manifest at all.
//   6. POST-VALIDATE RE-RANK — a candidate whose validation_status is promoted
//      by the validate stage gets its rankScore recomputed (§11.1 ordering).
//   7. SYNC SUMMARY — the sync CLI summary line reports the `conflicted` count
//      (non-enacted idempotent-409 ratifications) alongside approved/rejected/
//      excluded. The sync module itself is mocked here (its semantics are
//      covered by atlas-artifact-sync.test.ts); this only asserts CLI plumbing.
//
// NO aimock here: the `run` pipeline (readFragments → aggregate → classify →
// canonicalize → rag-dedup → validate → upsert) has NO LLM sub-step — episodic
// distillation and english-rule exclusion happen in OTHER phases (Tier-1 leaf
// fleet / the sync step), not on the upsert path. The only external seam on the
// run path is the rag-dedup live search probe, which is a non-LLM HTTP call and
// is mocked with a vi.fn AtlasHttpClient.search per the org rule.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";

import { __setPoolForTesting, __resetPoolForTesting } from "../db/client.js";
import { generatePostSchemaMigration } from "../db/schema.js";
import { listPendingAtlasSeedCandidates } from "../db/atlas.js";
import { getAdapter } from "../atlas/adapters/types.js";
import type { AtlasHttpClient } from "../atlas/client.js";
import type {
  Candidate,
  CandidateFragment,
  CorpusHit,
  ValidationStatus,
} from "../atlas/types.js";
import type { FeatureRegistry } from "../atlas/adapters/showcase.js";
import type { ValidationContext } from "../atlas/validate.js";
import type { ExclusionRule } from "../atlas/exclude.js";
import { RunStore } from "../atlas/run-store.js";
import { buildCandidateBlocks } from "../atlas/artifact/notion-blocks.js";
import { generateApprovalArtifact } from "../atlas/artifact/generate.js";
import { syncApprovalArtifact } from "../atlas/artifact/sync.js";

import {
  buildLeafAdapterRegistry,
  runHarvest,
  buildArtifactCandidates,
  parseMinOverlap,
  resolveBaseUrl,
  resolveToken,
  formatCliError,
  runAtlasHarvestCli,
  type RunHarvestDeps,
} from "../atlas/harvest-cli.js";
import type { DistillationJudge } from "../atlas/distillation-gate.js";

// The sync MODULE is mocked file-wide: the sync-summary CLI test below asserts
// only the driver's output plumbing — sync's own enactment semantics live in
// atlas-artifact-sync.test.ts. No other test in this file touches sync.
vi.mock("../atlas/artifact/sync.js", () => ({
  syncApprovalArtifact: vi.fn(),
}));

// Likewise the artifact GENERATE module: the artifact-CLI warn test below
// asserts only the driver's plumbing (the warn fires and the command still
// runs) — generation semantics live in atlas-artifact-generate.test.ts. No
// other test in this file calls generateApprovalArtifact (the FIX 1 parity
// suite uses buildArtifactCandidates directly).
vi.mock("../atlas/artifact/generate.js", () => ({
  generateApprovalArtifact: vi.fn(),
}));

// ── Real-Postgres (PGlite) harness — identical to atlas-upsert-integration ──────

const ATLAS_DDL_MARKER = "-- Atlas durable seed knowledge.";

function extractAtlasDdl(): string {
  const sql = generatePostSchemaMigration();
  const idx = sql.indexOf(ATLAS_DDL_MARKER);
  if (idx < 0) {
    throw new Error(`Could not locate "${ATLAS_DDL_MARKER}" in schema SQL`);
  }
  return sql.slice(idx);
}

function poolFromPglite(db: PGlite) {
  return {
    query: (text: string, params?: unknown[]) => db.query(text, params),
    connect: async () => ({
      query: (text: string, params?: unknown[]) => db.query(text, params),
      release: () => {},
    }),
    end: async () => db.close(),
  };
}

// ── Fixture fragments ──────────────────────────────────────────────────────────
//
// Two distinct fragments in different subsystems so canonicalize emits two
// distinct canonical_keys (no fusion, no dedup) → exactly two pending rows.

function fragment(over: Partial<CandidateFragment> = {}): CandidateFragment {
  return {
    sourcetype: "github-pr",
    subsystem: "runtime",
    claimSlugHint: "tools-before-stream",
    source_name: "atlas",
    repo_url: "https://github.com/CopilotKit/pathfinder",
    ref: "main",
    title: "Runtime drains the tool queue before the terminal message",
    content:
      "The runtime drains the tool queue before emitting the terminal " +
      "assistant message so partial tool state never leaks to the client.",
    provenance: {
      source: "github-pr",
      url: "https://github.com/CopilotKit/pathfinder/pull/42",
      date: "2026-06-01",
      classification: {
        sensitivity: "public",
        knowledge_type: "operational",
        audience: "all-staff",
        validation_status: "unverified",
        confidence: "high",
        provenance_class: "primary",
        freshness: { as_of: "2026-06-01" },
      },
    },
    evidence: [{ kind: "changed_file", path: "src/runtime/stream.ts" }],
    needsReview: false,
    validationTargets: [],
    ...over,
  };
}

// Write a set of fragments to <runsDir>/<runId>/fragments/<i>.json so
// RunStore.readFragments picks them up.
function seedRunDir(
  runsDir: string,
  runId: string,
  fragments: CandidateFragment[],
): void {
  const dir = path.join(runsDir, runId, "fragments");
  fs.mkdirSync(dir, { recursive: true });
  fragments.forEach((f, i) => {
    fs.writeFileSync(
      path.join(dir, `${String(i).padStart(4, "0")}.json`),
      `${JSON.stringify(f, null, 2)}\n`,
      "utf-8",
    );
  });
}

// A feature registry with no green pills, so no candidate is showcase-verified
// and the validation outcome is deterministic (source-verify drives status).
const EMPTY_REGISTRY: FeatureRegistry = { categories: [] };

// A validation context pointed at an EMPTY checkout dir (no validationTargets on
// the fixtures, so nothing source-verifies — statuses stay as the fixtures set).
function emptyValidationContext(checkoutDir: string): ValidationContext {
  return { checkoutDir, featureRegistry: EMPTY_REGISTRY };
}

// A mocked Atlas HTTP client whose `search` returns no hits (so rag-dedup passes
// every candidate through unchanged — HTTP seam, non-LLM, vi.fn per org rule).
function makeSearchClient(): {
  client: AtlasHttpClient;
  search: ReturnType<typeof vi.fn>;
} {
  const search = vi.fn(async () => []);
  const client = { search } as unknown as AtlasHttpClient;
  return { client, search };
}

// A pass-through distillation judge: rules every candidate `distilled` (a
// no-op). Injected into `runHarvest` in the tests below that exercise
// NON-distillation concerns (upsert/manifest/dedup-ordering) so the pipeline
// does not construct a real OpenAIDistiller (which would need an API key). The
// distillation gate's own behavior is covered in atlas-distillation-gate.test.ts.
const passThroughJudge: DistillationJudge = {
  judge: async () => ({ kind: "distilled" }),
};

// No-op semantic-dedup seams (Theme B). Injected alongside `passThroughJudge`
// into the tests that exercise NON-dedup concerns (upsert/manifest/ordering) so
// `runHarvest` does not construct a real OpenAIDistiller for the embed/distill
// default (which would need an API key). vectorSearch returns no hits ⇒ the
// semantic path finds no overlap ⇒ every candidate passes through unchanged,
// preserving these suites' pre-Theme-B pass-through expectations. The semantic
// gate's own behavior is covered in atlas-rag-dedup.test.ts. `embed`/
// `distillDelta` are inert here (vectorSearch's empty result short-circuits
// before distill), but supplied so no default OpenAIDistiller is constructed.
const passThroughSemanticDedup = {
  embed: async () => [0],
  vectorSearch: async () => [],
  distillDelta: async () => ({ kind: "no-overlap" as const }),
};

describe("atlas-harvest driver — registry assembly", () => {
  it("assembles a registry resolving every CandidateFragment sourcetype", () => {
    const registry = buildLeafAdapterRegistry();
    // Every sourcetype that has a dedicated leaf adapter must resolve.
    const sourcetypes: CandidateFragment["sourcetype"][] = [
      "memory",
      "episodic",
      "github-pr",
      "github-issue",
      "notion-doc",
      "linear-doc",
      "agent-doc",
      "derived",
    ];
    for (const st of sourcetypes) {
      const adapter = getAdapter(registry, st);
      expect(adapter).toBeDefined();
      expect(typeof adapter.extract).toBe("function");
    }
  });

  it("registers all seven distinct adapters", () => {
    const registry = buildLeafAdapterRegistry();
    // Seven adapters; github covers two sourcetypes (pr + issue), showcase is
    // the `derived` adapter, source-comment is `agent-doc`.
    // Filter falsy BEFORE counting — `a && a.extract` would let a missing
    // adapter contribute `undefined` to the Set and still count toward 7.
    const distinct = new Set(
      Object.values(registry)
        .map((a) => a?.extract)
        .filter(Boolean),
    );
    // memory, github, notion, linear, episodic, source-comment, showcase = 7.
    expect(distinct.size).toBe(7);
  });
});

describe("atlas-harvest driver — run pipeline (real PGlite)", () => {
  let db: PGlite;
  let runsDir: string;
  let checkoutDir: string;

  beforeAll(async () => {
    db = new PGlite();
    await db.waitReady;
    await db.exec(extractAtlasDdl());
    __setPoolForTesting(poolFromPglite(db));

    runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-harvest-runs-"));
    checkoutDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-harvest-co-"));
  });

  afterAll(async () => {
    __resetPoolForTesting();
    await db.close();
    fs.rmSync(runsDir, { recursive: true, force: true });
    fs.rmSync(checkoutDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.query("DELETE FROM atlas_cache_pages");
    await db.query("DELETE FROM atlas_seed_entries");
  });

  it("run --upsert writes a pending row per canonical candidate", async () => {
    const runId = "run-upsert";
    seedRunDir(runsDir, runId, [
      fragment(),
      fragment({
        subsystem: "indexer",
        claimSlugHint: "incremental-reindex",
        title: "Indexer reindexes only changed sources",
        content: "The indexer diffs the state token to reindex incrementally.",
      }),
    ]);

    const { client } = makeSearchClient();
    const result = await runHarvest({
      runId,
      runsDir,
      upsert: true,
      ragClient: client,
      judge: passThroughJudge,
      ...passThroughSemanticDedup,
      validationContext: emptyValidationContext(checkoutDir),
    });

    // Two distinct canonical candidates → two writes.
    expect(result.candidateCount).toBe(2);
    expect(result.upsertedCount).toBe(2);

    const pending = await listPendingAtlasSeedCandidates();
    expect(pending.map((p) => p.canonicalKey).sort()).toEqual(
      [
        "claim:indexer:incremental-reindex",
        "claim:runtime:tools-before-stream",
      ].sort(),
    );
    // All rows are pending.
    expect(pending.every((p) => p.status === "pending")).toBe(true);
  });

  it("stamps a completion marker (completedAt + upsertedCount) on a successful upsert", async () => {
    // A successful --upsert run must leave a manifest that DISTINGUISHES a
    // completed run from a partial/aborted one: the completion marker
    // (`completedAt` timestamp + the `upsertedCount` actually written) is stamped
    // AFTER the upsert loop finishes. Absence of the marker signals an incomplete
    // run. The marker never clobbers the manifest's fragmentCount/ruleSet.
    const runId = "run-completion-marker";
    seedRunDir(runsDir, runId, [
      fragment(),
      fragment({
        subsystem: "indexer",
        claimSlugHint: "incremental-reindex",
        title: "Indexer reindexes only changed sources",
        content: "The indexer diffs the state token to reindex incrementally.",
      }),
    ]);

    const { client } = makeSearchClient();
    const before = Date.now();
    const result = await runHarvest({
      runId,
      runsDir,
      upsert: true,
      ragClient: client,
      judge: passThroughJudge,
      ...passThroughSemanticDedup,
      validationContext: emptyValidationContext(checkoutDir),
    });
    const after = Date.now();

    expect(result.upsertedCount).toBe(2);

    const manifest = new RunStore(runsDir).readManifest(runId);
    expect(manifest).toBeDefined();
    // The pre-upsert manifest fields survive.
    expect(manifest!.fragmentCount).toBe(2);
    expect(manifest!.ruleSet).toEqual([]);
    // The completion marker is present and matches what was written.
    expect(manifest!.upsertedCount).toBe(2);
    expect(manifest!.completedAt).toBeDefined();
    const completedAtMs = Date.parse(manifest!.completedAt!);
    expect(Number.isNaN(completedAtMs)).toBe(false);
    expect(completedAtMs).toBeGreaterThanOrEqual(before);
    expect(completedAtMs).toBeLessThanOrEqual(after);
  });

  it("leaves NO completion marker on a preview (no --upsert) run — partial-state is distinguishable", async () => {
    // A preview run reaches the manifest write (step 1b) but never upserts, so it
    // must NOT carry a completion marker — the marker's absence is what lets an
    // operator tell a completed run from one that stopped before persisting.
    const runId = "run-no-marker-preview";
    seedRunDir(runsDir, runId, [fragment()]);

    const { client } = makeSearchClient();
    const result = await runHarvest({
      runId,
      runsDir,
      ragClient: client,
      judge: passThroughJudge,
      ...passThroughSemanticDedup,
      validationContext: emptyValidationContext(checkoutDir),
    });

    expect(result.upsertedCount).toBe(0);
    const manifest = new RunStore(runsDir).readManifest(runId);
    expect(manifest).toBeDefined();
    expect(manifest!.fragmentCount).toBe(1);
    // No upsert happened → no completion marker.
    expect(manifest!.completedAt).toBeUndefined();
    expect(manifest!.upsertedCount).toBeUndefined();
  });

  it("--dry-run writes NOTHING to the database", async () => {
    const runId = "run-dry";
    seedRunDir(runsDir, runId, [fragment()]);

    const { client } = makeSearchClient();
    const result = await runHarvest({
      runId,
      runsDir,
      upsert: true,
      dryRun: true,
      ragClient: client,
      judge: passThroughJudge,
      ...passThroughSemanticDedup,
      validationContext: emptyValidationContext(checkoutDir),
    });

    // The pipeline still produced a candidate, but nothing was written.
    expect(result.candidateCount).toBe(1);
    expect(result.upsertedCount).toBe(0);

    const pending = await listPendingAtlasSeedCandidates();
    expect(pending).toHaveLength(0);
  });

  it("does NOT upsert when --upsert is omitted (preview only)", async () => {
    const runId = "run-preview";
    seedRunDir(runsDir, runId, [fragment()]);

    const { client } = makeSearchClient();
    const result = await runHarvest({
      runId,
      runsDir,
      ragClient: client,
      judge: passThroughJudge,
      ...passThroughSemanticDedup,
      validationContext: emptyValidationContext(checkoutDir),
    });

    expect(result.candidateCount).toBe(1);
    expect(result.upsertedCount).toBe(0);
    expect(await listPendingAtlasSeedCandidates()).toHaveLength(0);
  });

  it("runs rag-dedup BEFORE validate (pipeline order)", async () => {
    const runId = "run-order";
    seedRunDir(runsDir, runId, [fragment()]);

    const order: string[] = [];
    const { client, search } = makeSearchClient();

    // Wrap the two steps with order-recording shims. They delegate to the real
    // implementations (injected as defaults inside runHarvest) but stamp the
    // observed call order so we can prove dedup precedes validate.
    const deps: RunHarvestDeps = {
      dedup: async (cands: Candidate[], dctx) => {
        order.push("rag-dedup");
        // Delegate to the real dedup so the search probe is actually exercised.
        const { dedupAgainstRagCorpus } = await import("../atlas/rag-dedup.js");
        return dedupAgainstRagCorpus(cands, dctx);
      },
      validate: async (cand: Candidate, vctx) => {
        order.push("validate");
        const { promoteValidation } = await import("../atlas/validate.js");
        return promoteValidation(cand, vctx);
      },
    };

    await runHarvest({
      runId,
      runsDir,
      ragClient: client,
      judge: passThroughJudge,
      ...passThroughSemanticDedup,
      validationContext: emptyValidationContext(checkoutDir),
      deps,
    });

    // The rag-dedup search probe was hit, and dedup was observed before the
    // first validate call.
    expect(search).toHaveBeenCalled();
    expect(order[0]).toBe("rag-dedup");
    expect(order.indexOf("rag-dedup")).toBeLessThan(order.indexOf("validate"));
  });

  it("promotes source-verified status when a validationTarget exists in the checkout", async () => {
    // Write a file the fragment's validationTarget references, so validate
    // promotes unverified → source-verified — proving validate actually runs
    // on the pipeline (not bypassed) and its result reaches the upsert.
    const runId = "run-validate";
    const symbolFile = path.join(checkoutDir, "src", "runtime", "stream.ts");
    fs.mkdirSync(path.dirname(symbolFile), { recursive: true });
    fs.writeFileSync(symbolFile, "export const drainToolQueue = () => {};\n");

    seedRunDir(runsDir, runId, [
      fragment({ validationTargets: ["drainToolQueue"] }),
    ]);

    const { client } = makeSearchClient();
    const result = await runHarvest({
      runId,
      runsDir,
      upsert: true,
      ragClient: client,
      judge: passThroughJudge,
      ...passThroughSemanticDedup,
      validationContext: emptyValidationContext(checkoutDir),
    });

    expect(result.upsertedCount).toBe(1);
    const pending = await listPendingAtlasSeedCandidates();
    const status = (
      pending[0]!.provenance as {
        classification?: { validation_status?: ValidationStatus };
      }
    ).classification?.validation_status;
    expect(status).toBe("source-verified");
  });
});

describe("atlas-harvest driver — artifact/run pipeline parity (FIX 1)", () => {
  let runsDir: string;
  let checkoutDir: string;

  beforeAll(() => {
    runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-harvest-art-"));
    checkoutDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "atlas-harvest-artco-"),
    );
  });

  afterAll(() => {
    fs.rmSync(runsDir, { recursive: true, force: true });
    fs.rmSync(checkoutDir, { recursive: true, force: true });
  });

  it("artifact candidates carry the SAME approvable/validation_status as the validated run candidates", async () => {
    // A behavior/architecture fact with NO resolvable validationTarget stays
    // unverified → validate marks it approvable=false. The PRE-validation
    // canonicalize output would (per the canonicalize approvability gate) also
    // mark it non-approvable, so to make the divergence observable we use a
    // validationTarget that DOES resolve in the checkout: validate promotes it
    // to source-verified (and keeps it approvable). The artifact MUST reflect
    // that promoted status, not the pre-validation `unverified`.
    const runId = "run-parity";
    const symbolFile = path.join(checkoutDir, "src", "runtime", "stream.ts");
    fs.mkdirSync(path.dirname(symbolFile), { recursive: true });
    fs.writeFileSync(symbolFile, "export const drainToolQueue = () => {};\n");

    seedRunDir(runsDir, runId, [
      fragment({
        provenance: {
          source: "github-pr",
          url: "https://github.com/CopilotKit/pathfinder/pull/42",
          date: "2026-06-01",
          classification: {
            sensitivity: "public",
            knowledge_type: "architecture",
            audience: "all-staff",
            validation_status: "unverified",
            confidence: "high",
            provenance_class: "primary",
            freshness: { as_of: "2026-06-01" },
          },
        },
        validationTargets: ["drainToolQueue"],
      }),
    ]);

    const ctx = emptyValidationContext(checkoutDir);

    // The artifact candidate set (post-validation). A pass-through distillation
    // judge + no-op rag-dedup seams are injected so the artifact path does not
    // construct a real OpenAIDistiller — the distillation gate's OWN behavior is
    // exercised in the dedicated parity tests above and the SEMANTIC-dedup parity
    // in the dedicated aimock suite below; this test isolates the validate-stage
    // parity, so rag-dedup is a no-op here (empty search + empty vectorSearch).
    const { client: parityClient } = makeSearchClient();
    const artifactCands = await buildArtifactCandidates({
      runId,
      runsDir,
      validationContext: ctx,
      judge: passThroughJudge,
      ragClient: parityClient,
      ...passThroughSemanticDedup,
    });
    expect(artifactCands).toHaveLength(1);

    // Cross-check against what the validate stage produces (the run path).
    const { promoteValidation } = await import("../atlas/validate.js");
    const { canonicalize } = await import("../atlas/canonicalize.js");
    const { aggregate } = await import("../atlas/aggregate.js");
    const { finalizeClassification } = await import("../atlas/classify.js");
    const { RunStore } = await import("../atlas/run-store.js");
    const fragments = new RunStore(runsDir).readFragments(runId);
    const canon = canonicalize(
      aggregate(fragments).map((f) => finalizeClassification(f)),
    );
    const runCand = await promoteValidation(canon[0]!, ctx);

    const artifactCand = artifactCands[0]!;
    expect(artifactCand.provenance.classification.validation_status).toBe(
      runCand.provenance.classification.validation_status,
    );
    expect(artifactCand.provenance.classification.validation_status).toBe(
      "source-verified",
    );
    expect(artifactCand.approvable).toBe(runCand.approvable);

    // And the artifact's status DIFFERS from the pre-validation canonical
    // candidate — proving validate actually ran on the artifact path.
    expect(canon[0]!.provenance.classification.validation_status).toBe(
      "unverified",
    );
  });

  it("runs the distillation gate — a restatement renders approvable=false, matching what run --upsert persists", async () => {
    // The distillation gate (enforceDistillation) runs on the run/upsert path
    // between canonicalize and validate: a `restatement` verdict stamps
    // RESTATEMENT_MARKER, which validate reads as a hard approvable=false floor.
    // The artifact path MUST run the SAME gate so the approval page's approvable
    // matches what `run --upsert` persists — otherwise a restatement renders
    // approvable=true on the page while the upsert writes approvable=false.
    const runId = "run-distill-restatement";
    const symbolFile = path.join(checkoutDir, "src", "runtime", "stream.ts");
    fs.mkdirSync(path.dirname(symbolFile), { recursive: true });
    fs.writeFileSync(symbolFile, "export const drainToolQueue = () => {};\n");

    // A behavior fact WITH a resolvable validationTarget: without the gate it
    // source-verifies and stays approvable=true; the restatement marker is the
    // ONLY thing that floors it to approvable=false, so it isolates the gate.
    seedRunDir(runsDir, runId, [
      fragment({
        provenance: {
          source: "github-pr",
          url: "https://github.com/CopilotKit/pathfinder/pull/42",
          date: "2026-06-01",
          classification: {
            sensitivity: "public",
            knowledge_type: "architecture",
            audience: "all-staff",
            validation_status: "unverified",
            confidence: "high",
            provenance_class: "primary",
            freshness: { as_of: "2026-06-01" },
          },
        },
        validationTargets: ["drainToolQueue"],
      }),
    ]);

    // A judge that rules EVERY candidate a pure restatement.
    const restatementJudge: DistillationJudge = {
      judge: async () => ({ kind: "restatement", reason: "pure WHAT" }),
    };

    const ctx = emptyValidationContext(checkoutDir);

    // Artifact path — with the SAME judge the run path uses. No-op rag-dedup
    // seams isolate the distillation-gate parity this test targets.
    const { client: restatementClient } = makeSearchClient();
    const artifactCands = await buildArtifactCandidates({
      runId,
      runsDir,
      validationContext: ctx,
      judge: restatementJudge,
      ragClient: restatementClient,
      ...passThroughSemanticDedup,
    });
    expect(artifactCands).toHaveLength(1);

    // Cross-check against what the run --upsert path (enforceDistillation →
    // validate) produces for the same candidate + judge.
    const { promoteValidation } = await import("../atlas/validate.js");
    const { enforceDistillation } =
      await import("../atlas/distillation-gate.js");
    const { canonicalize } = await import("../atlas/canonicalize.js");
    const { aggregate } = await import("../atlas/aggregate.js");
    const { finalizeClassification } = await import("../atlas/classify.js");
    const { RunStore } = await import("../atlas/run-store.js");
    const fragments = new RunStore(runsDir).readFragments(runId);
    const canon = canonicalize(
      aggregate(fragments).map((f) => finalizeClassification(f)),
    );
    const distilled = await enforceDistillation(canon, {
      judge: restatementJudge,
    });
    const runCand = await promoteValidation(distilled[0]!, ctx);

    // The run path floors the restatement to approvable=false.
    expect(runCand.approvable).toBe(false);
    // The artifact path MUST match — this is the divergence the fix closes.
    expect(artifactCands[0]!.approvable).toBe(runCand.approvable);
    expect(artifactCands[0]!.approvable).toBe(false);
  });

  it("runs the distillation gate — a rewritten candidate carries the salvaged prose, matching what run --upsert persists", async () => {
    // A `rewritten` verdict swaps the candidate's title/content for the judge's
    // why/how rewrite on the run/upsert path. The artifact must render the SAME
    // rewritten prose the upsert persists, not the pre-gate original.
    const runId = "run-distill-rewritten";
    const REWRITTEN_TITLE = "Why the runtime drains the tool queue first";
    const REWRITTEN_CONTENT =
      "Draining the queue before the terminal message prevents partial tool " +
      "state from leaking to the client — the ordering is the safety invariant.";

    seedRunDir(runsDir, runId, [fragment()]);

    const rewriteJudge: DistillationJudge = {
      judge: async () => ({
        kind: "rewritten",
        title: REWRITTEN_TITLE,
        content: REWRITTEN_CONTENT,
        reason: "salvaged into why/how prose",
      }),
    };

    const ctx = emptyValidationContext(checkoutDir);

    // No-op rag-dedup seams isolate the distillation-gate rewrite parity here.
    const { client: rewriteClient } = makeSearchClient();
    const artifactCands = await buildArtifactCandidates({
      runId,
      runsDir,
      validationContext: ctx,
      judge: rewriteJudge,
      ragClient: rewriteClient,
      ...passThroughSemanticDedup,
    });
    expect(artifactCands).toHaveLength(1);

    // Cross-check against the run --upsert path (enforceDistillation → validate).
    const { promoteValidation } = await import("../atlas/validate.js");
    const { enforceDistillation } =
      await import("../atlas/distillation-gate.js");
    const { canonicalize } = await import("../atlas/canonicalize.js");
    const { aggregate } = await import("../atlas/aggregate.js");
    const { finalizeClassification } = await import("../atlas/classify.js");
    const { RunStore } = await import("../atlas/run-store.js");
    const fragments = new RunStore(runsDir).readFragments(runId);
    const canon = canonicalize(
      aggregate(fragments).map((f) => finalizeClassification(f)),
    );
    const distilled = await enforceDistillation(canon, { judge: rewriteJudge });
    const runCand = await promoteValidation(distilled[0]!, ctx);

    // The run path adopts the salvaged prose.
    expect(runCand.title).toBe(REWRITTEN_TITLE);
    expect(runCand.content).toBe(REWRITTEN_CONTENT);
    // The artifact path MUST match — this is the divergence the fix closes.
    expect(artifactCands[0]!.title).toBe(runCand.title);
    expect(artifactCands[0]!.content).toBe(runCand.content);
    expect(artifactCands[0]!.title).toBe(REWRITTEN_TITLE);
    expect(artifactCands[0]!.content).toBe(REWRITTEN_CONTENT);
  });

  it("buildArtifactCandidates fails loud when the validation context is missing", async () => {
    const runId = "run-parity-2";
    seedRunDir(runsDir, runId, [fragment()]);
    const { client } = makeSearchClient();
    await expect(
      buildArtifactCandidates({
        runId,
        runsDir,
        ragClient: client,
        // @ts-expect-error intentionally omit validationContext
        validationContext: undefined,
      }),
    ).rejects.toThrow();
  });
});

// ── STRUCTURAL parity: the artifact runs the SAME rag-dedup gate as --upsert ──
//
// ROOT-CAUSE regression guard. The artifact-candidate path (buildArtifactCandidates)
// and the upsert path (runHarvest --upsert) now share ONE pipeline
// (processCandidatePipeline), so the rag-dedup gate runs on BOTH. Before the
// structural fix the artifact path SKIPPED rag-dedup — which was harmless while
// rag-dedup was mark-only, but the Theme-B SEMANTIC dedup now REWRITES `content`
// (delta verdict, applyDistillDelta) and FLOORS `approvable=false` (no-delta
// verdict). So a candidate the semantic gate rewrites/floors on the upsert path
// would render its PRE-dedup content + approvable on the approval page — the
// exact divergence this suite pins shut.
//
// Both paths are driven with the SAME seams: a lexical search stub returning a
// hit at LOW containment (survives the pre-filter), a vectorSearch stub pinning
// the cosine ABOVE the semantic threshold (so the semantic path fires), and a
// REAL OpenAIDistiller pointed at an in-process aimock (org rule: never a vi.fn
// for the LLM call). The upserted row is read back from real PGlite and compared
// field-for-field to the artifact candidate.
describe("atlas-harvest driver — artifact/upsert SEMANTIC rag-dedup parity (structural)", () => {
  let db: PGlite;
  let runsDir: string;
  let checkoutDir: string;
  let LLMockCtor: typeof import("@copilotkit/aimock").LLMock;
  let OpenAIDistillerCtor: typeof import("../atlas/llm.js").OpenAIDistiller;

  // A corpus passage and a PARAPHRASE of it: they share almost no [a-z0-9]
  // tokens, so the lexical containment stays below the verbatim threshold (the
  // candidate survives the lexical pre-filter) and only the SEMANTIC layer
  // catches the overlap — the exact case rag-dedup's rewrite path exists for.
  const CORPUS_PASSAGE =
    "The runtime keeps a thin v1 compatibility shim that forwards calls into " +
    "the v2 engine so existing apps run unchanged.";
  const PARAPHRASE =
    "Legacy applications continue operating without modification because a " +
    "lightweight adapter relays first-generation requests onto the newer core.";
  const DELTA_MARKER = "SEMANTIC-DELTA-WINDOW";
  const DELTA_CONTENT =
    `${DELTA_MARKER}: the adapter additionally records a per-call migration ` +
    "metric the v2 core does not, so operators can track legacy traffic decay.";

  beforeAll(async () => {
    db = new PGlite();
    await db.waitReady;
    await db.exec(extractAtlasDdl());
    __setPoolForTesting(poolFromPglite(db));
    runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-harvest-semdedup-"));
    checkoutDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "atlas-harvest-semdedupco-"),
    );
    ({ LLMock: LLMockCtor } = await import("@copilotkit/aimock"));
    ({ OpenAIDistiller: OpenAIDistillerCtor } =
      await import("../atlas/llm.js"));
  });

  afterAll(async () => {
    __resetPoolForTesting();
    await db.close();
    fs.rmSync(runsDir, { recursive: true, force: true });
    fs.rmSync(checkoutDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.query("DELETE FROM atlas_cache_pages");
    await db.query("DELETE FROM atlas_seed_entries");
  });

  // A single fragment whose content is the paraphrase — a semantic (not lexical)
  // corpus duplicate. Given a resolvable validationTarget it source-verifies and
  // stays approvable=true UNLESS the semantic gate rewrites/floors it.
  function paraphraseFragment(): CandidateFragment {
    const symbolFile = path.join(checkoutDir, "src", "runtime", "shim.ts");
    fs.mkdirSync(path.dirname(symbolFile), { recursive: true });
    fs.writeFileSync(symbolFile, "export const forwardToV2 = () => {};\n");
    return fragment({
      claimSlugHint: "v1-compat-shim",
      title: "Legacy app compatibility via a relay adapter",
      content: PARAPHRASE,
      provenance: {
        source: "github-pr",
        url: "https://github.com/CopilotKit/pathfinder/pull/99",
        date: "2026-06-01",
        classification: {
          sensitivity: "public",
          knowledge_type: "architecture",
          audience: "all-staff",
          validation_status: "unverified",
          confidence: "high",
          provenance_class: "primary",
          freshness: { as_of: "2026-06-01" },
        },
      },
      validationTargets: ["forwardToV2"],
    });
  }

  // A lexical search stub returning the corpus passage as a hit. Containment of
  // the paraphrase's tokens against it is well below 0.8 → survives the
  // pre-filter and routes into the semantic layer.
  function lexicalClient(): Pick<AtlasHttpClient, "search"> {
    return {
      search: vi.fn(async () => [
        {
          content: CORPUS_PASSAGE,
          id: 7,
          title: "Indexed v1→v2 shim passage",
          sourceUrl: "https://example.test/corpus/shim",
          sourceName: "docs",
        },
      ]),
    } as unknown as Pick<AtlasHttpClient, "search">;
  }

  // A vectorSearch seam pinning the cosine ABOVE the semantic threshold so the
  // semantic path decides overlap deterministically (the DB boundary).
  function vectorSearchAbove(similarity = 0.95) {
    return vi.fn(async () => [
      {
        similarity,
        content: CORPUS_PASSAGE,
        id: 7,
        title: "Indexed v1→v2 shim passage",
        sourceUrl: "https://example.test/corpus/shim",
        sourceName: "docs",
      },
    ]);
  }

  it("a semantic-dedup REWRITE renders identically on the artifact and the upserted row (delta verdict)", async () => {
    const runId = "run-semdedup-delta";
    seedRunDir(runsDir, runId, [paraphraseFragment()]);

    const mock = new LLMockCtor({ port: 0, logLevel: "silent" });
    // The DELTA distiller sees the paraphrase and returns net-new delta prose.
    mock.addFixture({
      match: {
        systemMessage: "knowledge-DELTA distiller",
        userMessage: PARAPHRASE,
      },
      response: {
        content: JSON.stringify({
          verdict: "delta",
          reason: "the migration metric is not covered by the corpus passage",
          content: DELTA_CONTENT,
        }),
      },
    });
    await mock.start();
    try {
      const distiller = new OpenAIDistillerCtor({
        baseURL: `${mock.url}/v1`,
        apiKey: "mock",
      });
      // The SAME seams for both paths — this is the parity contract.
      const seams = {
        ragClient: lexicalClient(),
        embed: (t: string) => distiller.embed(t),
        vectorSearch: vectorSearchAbove(),
        distillDelta: (c: Candidate, overlaps: CorpusHit[]) =>
          distiller.distillDelta({
            title: c.title,
            content: c.content,
            overlaps: overlaps.map((h) => ({ content: h.content })),
          }),
      };
      const ctx = emptyValidationContext(checkoutDir);

      // Artifact path (renders from fully-processed candidates; writes nothing).
      const artifactCands = await buildArtifactCandidates({
        runId,
        runsDir,
        validationContext: ctx,
        judge: passThroughJudge,
        ...seams,
        vectorSearch: vectorSearchAbove(),
      });
      expect(artifactCands).toHaveLength(1);
      const artifactCand = artifactCands[0]!;

      // Upsert path — SAME seams. Reads the persisted row back from PGlite.
      await runHarvest({
        runId,
        runsDir,
        upsert: true,
        validationContext: ctx,
        judge: passThroughJudge,
        ...seams,
        vectorSearch: vectorSearchAbove(),
      });
      const pending = await listPendingAtlasSeedCandidates();
      expect(pending).toHaveLength(1);
      const row = pending[0]!;

      // The gate REWROTE content to the net-new delta on BOTH paths.
      expect(artifactCand.content).toBe(DELTA_CONTENT);
      // PARITY: artifact content === upserted-row content (was DIVERGENT before
      // the structural fix — artifact skipped rag-dedup and rendered PARAPHRASE).
      expect(artifactCand.content).toBe(row.content);
      // A delta remains → still approvable on both paths.
      expect(artifactCand.approvable).toBe(true);
      expect(row.approvable).toBe(true);
      expect(artifactCand.approvable).toBe(row.approvable);
    } finally {
      await mock.stop();
    }
  });

  it("a semantic overlap annotates provenance/evidence identically on artifact and upserted row (no-delta)", async () => {
    // A no-delta verdict keeps content intact but STILL annotates the overlap
    // (validated_against marker + fused_from evidence) — the rank-neutral
    // corpus-overlap trail rag-dedup stamps. Before the structural fix the
    // artifact SKIPPED rag-dedup, so the artifact carried NO such annotation
    // while the upserted row did — divergent. The shared pipeline makes the
    // annotation appear identically on both. (approvable is NOT asserted here:
    // promoteValidation recomputes it from the promoted validation_status after
    // rag-dedup, so the no-delta floor's visibility is a separate validate-order
    // concern; this test pins the annotation + content parity the gate owns.)
    const runId = "run-semdedup-nodelta";
    seedRunDir(runsDir, runId, [paraphraseFragment()]);

    const mock = new LLMockCtor({ port: 0, logLevel: "silent" });
    // A no-delta verdict: the paraphrase adds nothing net-new over the corpus.
    mock.addFixture({
      match: {
        systemMessage: "knowledge-DELTA distiller",
        userMessage: PARAPHRASE,
      },
      response: {
        content: JSON.stringify({
          verdict: "no-delta",
          reason: "fully covered by the indexed corpus passage",
        }),
      },
    });
    await mock.start();
    try {
      const distiller = new OpenAIDistillerCtor({
        baseURL: `${mock.url}/v1`,
        apiKey: "mock",
      });
      const seams = {
        ragClient: lexicalClient(),
        embed: (t: string) => distiller.embed(t),
        distillDelta: (c: Candidate, overlaps: CorpusHit[]) =>
          distiller.distillDelta({
            title: c.title,
            content: c.content,
            overlaps: overlaps.map((h) => ({ content: h.content })),
          }),
      };
      const ctx = emptyValidationContext(checkoutDir);

      const artifactCands = await buildArtifactCandidates({
        runId,
        runsDir,
        validationContext: ctx,
        judge: passThroughJudge,
        ...seams,
        vectorSearch: vectorSearchAbove(),
      });
      expect(artifactCands).toHaveLength(1);
      const artifactCand = artifactCands[0]!;

      await runHarvest({
        runId,
        runsDir,
        upsert: true,
        validationContext: ctx,
        judge: passThroughJudge,
        ...seams,
        vectorSearch: vectorSearchAbove(),
      });
      const pending = await listPendingAtlasSeedCandidates();
      expect(pending).toHaveLength(1);
      const row = pending[0]!;

      // The semantic overlap was ANNOTATED on the artifact (was ABSENT before
      // the fix — the artifact skipped rag-dedup entirely).
      expect(artifactCand.provenance.validated_against).toContain(
        "rag-corpus-overlap:https://example.test/corpus/shim",
      );
      expect(artifactCand.evidence.some((e) => e.kind === "fused_from")).toBe(
        true,
      );
      // PARITY: the same annotation reaches the upserted row.
      const rowValidatedAgainst = (
        row.provenance as { validated_against?: string }
      ).validated_against;
      expect(rowValidatedAgainst).toBe(
        artifactCand.provenance.validated_against,
      );
      // no-delta keeps content intact — identical on both paths.
      expect(artifactCand.content).toBe(PARAPHRASE);
      expect(artifactCand.content).toBe(row.content);
    } finally {
      await mock.stop();
    }
  });
});

describe("atlas-harvest driver — min-overlap parsing (FIX 2)", () => {
  it("rejects a non-numeric --min-overlap", () => {
    expect(() => parseMinOverlap("abc")).toThrow(/min-overlap/);
  });

  it("rejects an out-of-range --min-overlap (>1)", () => {
    expect(() => parseMinOverlap("1.5")).toThrow(/min-overlap/);
  });

  it("rejects a negative --min-overlap", () => {
    expect(() => parseMinOverlap("-0.1")).toThrow(/min-overlap/);
  });

  it("accepts a valid in-range --min-overlap", () => {
    expect(parseMinOverlap("0.8")).toBe(0.8);
    expect(parseMinOverlap("0")).toBe(0);
    expect(parseMinOverlap("1")).toBe(1);
  });

  // Y10: `Number("")` is 0 — finite and in [0,1] — so an empty flag value
  // (e.g. `--min-overlap "$UNSET_VAR"` under shell quoting) would silently set
  // the threshold to 0 and MARK every probed candidate with any best hit.
  it("rejects an empty --min-overlap (Y10)", () => {
    expect(() => parseMinOverlap("")).toThrow(/min-overlap/);
  });

  it("rejects a whitespace-only --min-overlap (Y10)", () => {
    expect(() => parseMinOverlap("  ")).toThrow(/min-overlap/);
  });
});

describe("atlas-harvest driver — resolveBaseUrl localhost fallback warns (Y11)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("warns naming the fallback URL when neither --url nor PATHFINDER_BASE_URL is set", () => {
    vi.stubEnv("PATHFINDER_BASE_URL", undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(resolveBaseUrl(undefined)).toBe("http://localhost:3001");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("http://localhost:3001"),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("PATHFINDER_BASE_URL"),
    );
  });

  it("is silent when PATHFINDER_BASE_URL is set", () => {
    vi.stubEnv("PATHFINDER_BASE_URL", "https://pathfinder.example.com");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(resolveBaseUrl(undefined)).toBe("https://pathfinder.example.com");
    expect(warn).not.toHaveBeenCalled();
  });

  it("is silent when the --url flag is passed (flag wins over env)", () => {
    vi.stubEnv("PATHFINDER_BASE_URL", "https://pathfinder.example.com");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(resolveBaseUrl("https://flag.example.com")).toBe(
      "https://flag.example.com",
    );
    expect(warn).not.toHaveBeenCalled();
  });

  // fix10 Z2: empty/whitespace-only values are ABSENT (the module's own
  // empty-string-is-absent rule, same as resolveToken) — a blank
  // PATHFINDER_BASE_URL must trigger the Y11 fallback warn, not be returned
  // silently as an unparseable base URL.
  it("treats an empty-string PATHFINDER_BASE_URL as absent — warns and falls back (fix10 Z2)", () => {
    vi.stubEnv("PATHFINDER_BASE_URL", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(resolveBaseUrl(undefined)).toBe("http://localhost:3001");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("PATHFINDER_BASE_URL"),
    );
  });

  it("treats a whitespace-only PATHFINDER_BASE_URL as absent — warns and falls back (fix10 Z2)", () => {
    vi.stubEnv("PATHFINDER_BASE_URL", "   ");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(resolveBaseUrl(undefined)).toBe("http://localhost:3001");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("PATHFINDER_BASE_URL"),
    );
  });

  it("trims a padded --url flag and stays silent (fix10 Z2)", () => {
    vi.stubEnv("PATHFINDER_BASE_URL", undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(resolveBaseUrl(" http://x ")).toBe("http://x");
    expect(warn).not.toHaveBeenCalled();
  });
});

// fix11 AA2: resolveToken shares resolveBaseUrl's trim-nullify empty-is-absent
// rule — a whitespace-only token would otherwise be truthy, pass the throw
// guard, and ship as `Bearer "   "` (an opaque 401 later instead of the loud
// configuration error here).
describe("atlas-harvest driver — resolveToken trim-nullifies empty/whitespace inputs (fix11 AA2)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws the bearer-token error for a whitespace-only ANALYTICS_TOKEN (fix11 AA2)", () => {
    vi.stubEnv("ANALYTICS_TOKEN", "   ");
    expect(() => resolveToken(undefined)).toThrow(/bearer token is required/);
  });

  it("trims a padded --token flag (fix11 AA2)", () => {
    vi.stubEnv("ANALYTICS_TOKEN", undefined);
    expect(resolveToken("  tok  ")).toBe("tok");
  });

  it("still throws when ANALYTICS_TOKEN is the empty string (regression pin)", () => {
    vi.stubEnv("ANALYTICS_TOKEN", "");
    expect(() => resolveToken(undefined)).toThrow(/bearer token is required/);
  });

  it("falls through a whitespace-only --token flag to ANALYTICS_TOKEN (fix11 AA2)", () => {
    vi.stubEnv("ANALYTICS_TOKEN", "env-tok");
    expect(resolveToken("   ")).toBe("env-tok");
  });
});

describe("atlas-harvest driver — reindex --scope is validated by commander", () => {
  it("rejects an unknown --scope value with the allowed choices", async () => {
    const errOut: string[] = [];
    const code = await runAtlasHarvestCli(
      ["reindex", "--scope", "bogus", "--token", "test-token"],
      { stdout: () => {}, stderr: (t) => errOut.push(t) },
    );

    expect(code).not.toBe(0);
    expect(errOut.join("")).toContain("full, source, repo");
  });
});

describe("atlas-harvest driver — run manifest (V80)", () => {
  let runsDir: string;
  let checkoutDir: string;

  beforeAll(() => {
    runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-harvest-man-"));
    checkoutDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "atlas-harvest-manco-"),
    );
  });

  afterAll(() => {
    fs.rmSync(runsDir, { recursive: true, force: true });
    fs.rmSync(checkoutDir, { recursive: true, force: true });
  });

  it("runHarvest records the manifest with the fragment count", async () => {
    const runId = "run-manifest";
    seedRunDir(runsDir, runId, [
      fragment(),
      fragment({
        subsystem: "indexer",
        claimSlugHint: "incremental-reindex",
        title: "Indexer reindexes only changed sources",
        content: "The indexer diffs the state token to reindex incrementally.",
      }),
    ]);

    const { client } = makeSearchClient();
    await runHarvest({
      runId,
      runsDir,
      ragClient: client,
      judge: passThroughJudge,
      ...passThroughSemanticDedup,
      validationContext: emptyValidationContext(checkoutDir),
    });

    const manifest = new RunStore(runsDir).readManifest(runId);
    expect(manifest).toBeDefined();
    expect(manifest!.fragmentCount).toBe(2);
    expect(manifest!.ruleSet).toEqual([]);
  });

  it("preserves the prior manifest's ruleSet across a re-run", async () => {
    const runId = "run-manifest-rules";
    seedRunDir(runsDir, runId, [fragment()]);
    const store = new RunStore(runsDir);
    const ruleSet: ExclusionRule[] = [
      { kind: "flag", dimension: "sensitivity", equals: "secret" },
    ];
    store.writeManifest(runId, { fragmentCount: 0, ruleSet });

    const { client } = makeSearchClient();
    await runHarvest({
      runId,
      runsDir,
      ragClient: client,
      judge: passThroughJudge,
      ...passThroughSemanticDedup,
      validationContext: emptyValidationContext(checkoutDir),
    });

    const manifest = store.readManifest(runId);
    expect(manifest!.fragmentCount).toBe(1);
    expect(manifest!.ruleSet).toEqual(ruleSet);
  });

  it("repairs a corrupt manifest instead of aborting the harvest", async () => {
    const runId = "run-manifest-corrupt";
    seedRunDir(runsDir, runId, [fragment()]);
    fs.writeFileSync(
      path.join(runsDir, runId, "manifest.json"),
      "{not json",
      "utf-8",
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { client } = makeSearchClient();
      const result = await runHarvest({
        runId,
        runsDir,
        ragClient: client,
        judge: passThroughJudge,
        ...passThroughSemanticDedup,
        validationContext: emptyValidationContext(checkoutDir),
      });
      expect(result.fragmentCount).toBe(1);
    } finally {
      warn.mockRestore();
    }

    const manifest = new RunStore(runsDir).readManifest(runId);
    expect(manifest!.fragmentCount).toBe(1);
    expect(manifest!.ruleSet).toEqual([]);
  });

  it("--dry-run writes NO manifest", async () => {
    const runId = "run-manifest-dry";
    seedRunDir(runsDir, runId, [fragment()]);

    const { client } = makeSearchClient();
    await runHarvest({
      runId,
      runsDir,
      dryRun: true,
      ragClient: client,
      judge: passThroughJudge,
      ...passThroughSemanticDedup,
      validationContext: emptyValidationContext(checkoutDir),
    });

    expect(fs.existsSync(path.join(runsDir, runId, "manifest.json"))).toBe(
      false,
    );
    expect(new RunStore(runsDir).readManifest(runId)).toBeUndefined();
  });
});

describe("atlas-harvest driver — post-validate re-rank (V57)", () => {
  let runsDir: string;
  let checkoutDir: string;

  beforeAll(() => {
    runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-harvest-rank-"));
    checkoutDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "atlas-harvest-rankco-"),
    );
  });

  afterAll(() => {
    fs.rmSync(runsDir, { recursive: true, force: true });
    fs.rmSync(checkoutDir, { recursive: true, force: true });
  });

  it("a validate-promoted candidate outranks its unpromoted twin and sorts first in its artifact group", async () => {
    // Two twins with IDENTICAL rank inputs (date, evidence, confidence,
    // provenance_class, validation_status) differing only in claim slug/title.
    // The stale twin's canonical_key sorts FIRST alphabetically, so with equal
    // (stale) scores it would also render first — the promoted twin can only
    // sort first if the post-validate recompute actually happened.
    const runId = "run-rerank";
    seedRunDir(runsDir, runId, [
      fragment({ claimSlugHint: "a-stale-twin", title: "Stale twin claim" }),
      fragment({
        claimSlugHint: "z-promoted-twin",
        title: "Promoted twin claim",
      }),
    ]);

    // Validate stub: promotes ONLY the z-promoted-twin unverified →
    // showcase-verified (the DOMINANT rank weight, 3× vs 1×).
    const validateStub = async (cand: Candidate): Promise<Candidate> =>
      cand.canonical_key.endsWith(":z-promoted-twin")
        ? {
            ...cand,
            provenance: {
              ...cand.provenance,
              classification: {
                ...cand.provenance.classification,
                validation_status: "showcase-verified",
              },
            },
          }
        : cand;

    const { client: rerankClient } = makeSearchClient();
    const cands = await buildArtifactCandidates({
      runId,
      runsDir,
      validationContext: emptyValidationContext(checkoutDir),
      validate: validateStub,
      // Pass-through distillation judge so this re-rank test does not construct a
      // real OpenAIDistiller (the gate's behavior is covered by the parity tests).
      judge: passThroughJudge,
      // No-op rag-dedup seams keep this re-rank test isolated to the rank stage.
      ragClient: rerankClient,
      ...passThroughSemanticDedup,
    });

    const promoted = cands.find((c) =>
      c.canonical_key.endsWith(":z-promoted-twin"),
    )!;
    const stale = cands.find((c) => c.canonical_key.endsWith(":a-stale-twin"))!;
    expect(promoted).toBeDefined();
    expect(stale).toBeDefined();
    // Strictly higher — the canonicalize-time score was computed from the
    // pre-promotion status and would be EQUAL for these twins.
    expect(promoted.rankScore).toBeGreaterThan(stale.rankScore);

    // And the artifact group (same subsystem) renders the promoted twin first.
    const rendered = buildCandidateBlocks(cands).map((b) => JSON.stringify(b));
    const promotedIdx = rendered.findIndex((t) =>
      t.includes("Promoted twin claim"),
    );
    const staleIdx = rendered.findIndex((t) => t.includes("Stale twin claim"));
    expect(promotedIdx).toBeGreaterThan(-1);
    expect(staleIdx).toBeGreaterThan(-1);
    expect(promotedIdx).toBeLessThan(staleIdx);
  });
});

describe("atlas-harvest driver — sync CLI summary (conflicted count)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(syncApprovalArtifact).mockReset();
  });

  it("reports the conflicted count alongside approved/rejected/excluded", async () => {
    // buildLlm() constructs an OpenAIDistiller before sync runs; a mock baseURL
    // satisfies its fail-loud key check without a real key (never called —
    // syncApprovalArtifact is mocked).
    vi.stubEnv("OPENAI_BASE_URL", "http://localhost:9");
    vi.mocked(syncApprovalArtifact).mockResolvedValue({
      approved: ["k1"],
      rejected: ["k2"],
      excluded: [],
      conflicted: ["k3", "k4"],
    });

    const out: string[] = [];
    const code = await runAtlasHarvestCli(
      [
        "sync",
        "--page",
        "page-1",
        "--actor",
        "jordan",
        "--token",
        "test-token",
        "--notion-token",
        "notion-token",
        // Pin the base URL so resolveBaseUrl's localhost-fallback warn (Y11)
        // never fires here, regardless of ambient PATHFINDER_BASE_URL.
        "--url",
        "http://localhost:3001",
      ],
      { stdout: (t) => out.push(t), stderr: (t) => out.push(t) },
    );

    expect(code).toBe(0);
    expect(out.join("")).toContain(
      "1 approved, 1 rejected, 0 excluded-by-rule, 2 conflicted",
    );
  });
});

describe("atlas-harvest driver — sync without --run-id warns (W24)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(syncApprovalArtifact).mockReset();
    vi.restoreAllMocks();
  });

  const emptySyncResult = {
    approved: [],
    rejected: [],
    excluded: [],
    conflicted: [],
  };

  function syncArgs(extra: string[] = []): string[] {
    return [
      "sync",
      "--page",
      "page-1",
      "--actor",
      "jordan",
      "--token",
      "test-token",
      "--notion-token",
      "notion-token",
      // Pin the base URL so resolveBaseUrl's localhost-fallback warn (Y11)
      // never fires here — the warn assertions below must observe ONLY the
      // --run-id advisory, regardless of ambient PATHFINDER_BASE_URL.
      "--url",
      "http://localhost:3001",
      ...extra,
    ];
  }

  it("warns that the final rule set will NOT be persisted, and still runs the sync", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "http://localhost:9");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(syncApprovalArtifact).mockResolvedValue(emptySyncResult);

    const out: string[] = [];
    const code = await runAtlasHarvestCli(syncArgs(), {
      stdout: (t) => out.push(t),
      stderr: (t) => out.push(t),
    });

    expect(code).toBe(0);
    // The sync itself still ran (the warn is advisory, not a gate).
    expect(syncApprovalArtifact).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("--run-id not provided"),
    );
  });

  it("does NOT warn when --run-id is provided", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "http://localhost:9");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(syncApprovalArtifact).mockResolvedValue(emptySyncResult);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-sync-warn-"));
    try {
      const code = await runAtlasHarvestCli(
        syncArgs(["--run-id", "run-1", "--runs-dir", tmp]),
        { stdout: () => {}, stderr: () => {} },
      );
      expect(code).toBe(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("atlas-harvest driver — CLI error printer walks the cause chain (W27)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(syncApprovalArtifact).mockReset();
    vi.restoreAllMocks();
  });

  it("prints the {cause} chain to stderr, not just the outer message", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "http://localhost:9");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // rag-dedup's fail-fast deliberately attaches the ACTUAL network error as
    // {cause}; the printer must surface it or the diagnosis (url/auth) is lost.
    vi.mocked(syncApprovalArtifact).mockRejectedValue(
      new Error("outer boom", { cause: new Error("inner network down") }),
    );

    const errOut: string[] = [];
    const code = await runAtlasHarvestCli(
      [
        "sync",
        "--page",
        "page-1",
        "--actor",
        "jordan",
        "--token",
        "test-token",
        "--notion-token",
        "notion-token",
        // Pin the base URL so resolveBaseUrl's localhost-fallback warn (Y11)
        // never fires here, regardless of ambient PATHFINDER_BASE_URL.
        "--url",
        "http://localhost:3001",
      ],
      { stdout: () => {}, stderr: (t) => errOut.push(t) },
    );

    expect(code).toBe(1);
    const text = errOut.join("");
    expect(text).toContain("outer boom");
    expect(text).toContain("caused by: inner network down");
  });

  it("formatCliError bounds the cause walk and stringifies non-Error causes", () => {
    // 8 nested causes → only the first 5 hops print (bounded depth).
    let err = new Error("hop-8");
    for (let i = 7; i >= 1; i--) err = new Error(`hop-${i}`, { cause: err });
    const deep = formatCliError(new Error("outer", { cause: err }));
    expect(deep).toContain("caused by: hop-5");
    expect(deep).not.toContain("hop-6");

    // A non-Error cause is stringified, not dropped.
    expect(formatCliError(new Error("outer", { cause: "raw string" }))).toBe(
      "outer\n  caused by: raw string",
    );
  });

  it("skips an explicit `cause: null` (no 'caused by: null' line)", () => {
    // `cause: null` is non-undefined, so a `!== undefined` loop condition would
    // print a useless "caused by: null" hop.
    expect(formatCliError(new Error("outer", { cause: null }))).toBe("outer");
  });
});

describe("atlas-harvest driver — artifact without --prior-run-id warns (X12)", () => {
  let runsDir: string;
  let checkoutDir: string;
  let registryPath: string;
  const runId = "run-artifact-warn";

  // The `artifact` CLI command runs buildArtifactCandidates for real, which now
  // runs the distillation gate (the same one `run --upsert` runs) and — with no
  // judge injection point on the CLI — constructs a real OpenAIDistiller-backed
  // judge. Per the org rule we point it at an in-process aimock server (never a
  // vi.fn stub for the model call) rather than a real API. The fragment's
  // content is already a why/how claim, so the fixture returns the `distilled`
  // verdict (keep as-is). These tests only assert the driver's warn plumbing;
  // aimock keeps the LLM seam honest without a real key.
  let mock: import("@copilotkit/aimock").LLMock;

  beforeAll(async () => {
    runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-artifact-warn-"));
    checkoutDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "atlas-artifact-warnco-"),
    );
    registryPath = path.join(checkoutDir, "feature-registry.json");
    fs.writeFileSync(registryPath, `${JSON.stringify({ categories: [] })}\n`);
    seedRunDir(runsDir, runId, [fragment()]);

    const { LLMock } = await import("@copilotkit/aimock");
    mock = new LLMock({ port: 0, logLevel: "silent" });
    // The distillation judge sees the WHY-vs-WHAT system prompt; the fragment is
    // a distilled claim, so respond with the `distilled` verdict for any user
    // message under that system prompt.
    mock.addFixture({
      match: { systemMessage: "WHY-vs-WHAT judge" },
      response: { content: JSON.stringify({ verdict: "distilled" }) },
    });
    await mock.start();
    process.env.OPENAI_BASE_URL = `${mock.url}/v1`;
    process.env.OPENAI_API_KEY = "mock";
  });

  afterAll(async () => {
    fs.rmSync(runsDir, { recursive: true, force: true });
    fs.rmSync(checkoutDir, { recursive: true, force: true });
    await mock.stop();
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    vi.mocked(generateApprovalArtifact).mockReset();
    vi.restoreAllMocks();
  });

  function artifactArgs(extra: string[] = []): string[] {
    return [
      "artifact",
      "--run-id",
      runId,
      "--parent",
      "parent-page",
      "--runs-dir",
      runsDir,
      "--checkout",
      checkoutDir,
      "--feature-registry",
      registryPath,
      "--notion-token",
      "notion-token",
      // The artifact command now runs the SAME rag-dedup gate as `run`, so it
      // builds an HTTP client for the lexical probe — which requires a bearer
      // token. Point --url at an unroutable port so the probe fails fast (a
      // single blip, well under the soft-disable streak): the candidate rides
      // through un-annotated and the semantic path is never reached (so no DB
      // pool is needed). These tests only assert the driver's warn plumbing.
      "--token",
      "test-analytics-token",
      "--url",
      "http://127.0.0.1:1",
      ...extra,
    ];
  }

  it("warns that the Exclusion-Rules section seeds from defaults, and still generates the artifact", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(generateApprovalArtifact).mockResolvedValue({
      pageId: "page-1",
      url: "https://notion.so/page-1",
    });

    const out: string[] = [];
    const code = await runAtlasHarvestCli(artifactArgs(), {
      stdout: (t) => out.push(t),
      stderr: (t) => out.push(t),
    });

    expect(code).toBe(0);
    // The artifact itself still generated (the warn is advisory, not a gate).
    expect(generateApprovalArtifact).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("--prior-run-id not provided"),
    );
  });

  it("does NOT warn when --prior-run-id is provided", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(generateApprovalArtifact).mockResolvedValue({
      pageId: "page-1",
      url: "https://notion.so/page-1",
    });

    const code = await runAtlasHarvestCli(
      artifactArgs(["--prior-run-id", "run-prior"]),
      { stdout: () => {}, stderr: () => {} },
    );

    expect(code).toBe(0);
    // The ADVISORY --prior-run-id warn must not fire when the flag IS provided.
    // (Other, unrelated warns may fire — the artifact now runs the rag-dedup
    // gate, whose lexical probe against the deliberately-unroutable --url fails
    // fast and emits a run-level probe-metric warn; that is expected here and is
    // not what this test guards.)
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("--prior-run-id not provided"),
    );
  });
});
