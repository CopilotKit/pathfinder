// Harvest-driver CLI integration tests (plan S18 / §4 data-flow).
//
// S18 is the DRIVER slot: `scripts/atlas-harvest.ts` is the SINGLE assembly
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
} from "../../scripts/atlas-harvest.js";

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
      validationContext: emptyValidationContext(checkoutDir),
    });

    // Two distinct canonical candidates → two writes.
    expect(result.candidateCount).toBe(2);
    expect(result.upsertedCount).toBe(2);

    const pending = await listPendingAtlasSeedCandidates();
    expect(pending.map((p) => p.canonicalKey).sort()).toEqual(
      [
        "github-pr:indexer:incremental-reindex",
        "github-pr:runtime:tools-before-stream",
      ].sort(),
    );
    // All rows are pending.
    expect(pending.every((p) => p.status === "pending")).toBe(true);
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

    // The artifact candidate set (post-validation).
    const artifactCands = await buildArtifactCandidates({
      runId,
      runsDir,
      validationContext: ctx,
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

  it("buildArtifactCandidates fails loud when the validation context is missing", async () => {
    const runId = "run-parity-2";
    seedRunDir(runsDir, runId, [fragment()]);
    await expect(
      buildArtifactCandidates({
        runId,
        runsDir,
        // @ts-expect-error intentionally omit validationContext
        validationContext: undefined,
      }),
    ).rejects.toThrow();
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

    const cands = await buildArtifactCandidates({
      runId,
      runsDir,
      validationContext: emptyValidationContext(checkoutDir),
      validate: validateStub,
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

  beforeAll(() => {
    runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-artifact-warn-"));
    checkoutDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "atlas-artifact-warnco-"),
    );
    registryPath = path.join(checkoutDir, "feature-registry.json");
    fs.writeFileSync(registryPath, `${JSON.stringify({ categories: [] })}\n`);
    seedRunDir(runsDir, runId, [fragment()]);
  });

  afterAll(() => {
    fs.rmSync(runsDir, { recursive: true, force: true });
    fs.rmSync(checkoutDir, { recursive: true, force: true });
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
    expect(warn).not.toHaveBeenCalled();
  });
});
