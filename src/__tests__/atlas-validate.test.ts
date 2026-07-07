// Unit/integration tests for the Atlas validation gate (S14).
//
// `promoteValidation(candidate, ctx)` is the BINDING validation gate (spec §7):
//   1. source-verify — for each of a candidate's `validationTargets`, grep a
//      read-only checkout of origin/main; ANY hit promotes `unverified` →
//      `source-verified`.
//   2. showcase-verify — map the candidate's claim to a feature-registry pill via
//      the S9 `lookupPill` oracle; a `green` pill promotes to `showcase-verified`
//      (a quarantined / not_supported / unknown pill does NOT).
//   3. BINDING RULE — an architecture / design-rationale candidate that stays
//      `unverified` is marked `approvable=false` (the §7 CopilotNext proof).
//
// All cases run against a hermetic FIXTURE CHECKOUT under
// fixtures/atlas/checkout (a tiny fake origin/main tree) — NO network, NO git.
// Paths resolve relative to this test file (cwd-independent).

import {
  describe,
  it,
  expect,
  vi,
  afterEach,
  beforeAll,
  afterAll,
} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promoteValidation } from "../atlas/validate.js";
import type { ValidationContext } from "../atlas/validate.js";
import { recomputeRankScore } from "../atlas/canonicalize.js";
import {
  CandidateSchema,
  RAG_NO_DELTA_MARKER,
  RESTATEMENT_MARKER,
} from "../atlas/types.js";
import type {
  Candidate,
  Classification,
  KnowledgeType,
  ValidationStatus,
} from "../atlas/types.js";
import type { FeatureRegistry } from "../atlas/adapters/showcase.js";

// ── Fixture checkout dir (the fake origin/main tree this slot owns) ────────────

const checkoutDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "atlas",
  "checkout",
);

// ── Feature registry (injected, no disk/network) ──────────────────────────────
// Mirrors the real showcase/shared/feature-registry.json shape: a green pill and
// the quarantined `gen-ui-interrupt` pill (the §7 quarantine proof).

const featureRegistry: FeatureRegistry = {
  version: "1",
  categories: [
    {
      id: "agentic-chat",
      name: "Agentic Chat",
      pills: [{ id: "agentic-chat", name: "Agentic Chat", status: "green" }],
    },
    {
      id: "generative-ui",
      name: "Generative UI",
      pills: [
        { id: "gen-ui", name: "Generative UI", status: "green" },
        {
          id: "gen-ui-interrupt",
          name: "Generative UI Interrupt",
          status: "quarantined",
        },
      ],
    },
  ],
};

const ctx: ValidationContext = { checkoutDir, featureRegistry };

// ── Candidate builder ─────────────────────────────────────────────────────────
// A minimal, valid Candidate with overridable dimensions, so each test states
// only the fields it exercises.

interface CandidateOverrides {
  subsystem?: string;
  title?: string;
  validation_status?: ValidationStatus;
  knowledge_type?: KnowledgeType;
  provenance_class?: Classification["provenance_class"];
  validationTargets?: string[];
  approvable?: boolean;
}

function makeCandidate(o: CandidateOverrides = {}): Candidate {
  const validation_status = o.validation_status ?? "unverified";
  const knowledge_type = o.knowledge_type ?? "architecture";
  const date = "2026-06-08";
  return {
    sourcetype: "github-pr",
    subsystem: o.subsystem ?? "cpk-runtime",
    claimSlugHint: undefined,
    source_name: "github-pr",
    repo_url: "https://github.com/CopilotKit/CopilotKit",
    ref: "main",
    title: o.title ?? "Some distilled claim about the runtime",
    content: "why/how prose",
    provenance: {
      source: "github-pr",
      date,
      classification: {
        sensitivity: "internal",
        knowledge_type,
        audience: "all-staff",
        validation_status,
        confidence: "high",
        provenance_class: o.provenance_class ?? "primary",
        freshness: { as_of: date },
      },
    },
    evidence: [],
    needsReview: false,
    validationTargets: o.validationTargets ?? [],
    canonical_key: `github-pr:${o.subsystem ?? "cpk-runtime"}:some-claim`,
    rankScore: 1,
    approvable: o.approvable ?? true,
  };
}

describe("promoteValidation — source verification (grep fixture checkout)", () => {
  it("promotes unverified → source-verified when a validationTarget symbol exists in the checkout", async () => {
    // `TwoLayerShim` lives in fixtures/atlas/checkout/src/runtime/shim.ts.
    const candidate = makeCandidate({
      validationTargets: ["TwoLayerShim"],
    });
    const out = await promoteValidation(candidate, ctx);

    expect(out.provenance.classification.validation_status).toBe(
      "source-verified",
    );
    // An architecture fact that IS source-verified is approvable.
    expect(out.approvable).toBe(true);
    // The result is still a valid Candidate.
    expect(() => CandidateSchema.parse(out)).not.toThrow();
  });

  it("promotes when a validationTarget is a path that exists in the checkout", async () => {
    const candidate = makeCandidate({
      validationTargets: ["src/db/atlas.ts"],
    });
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).toBe(
      "source-verified",
    );
  });

  it("promotes when ANY one of several validationTargets is found", async () => {
    const candidate = makeCandidate({
      validationTargets: ["NoSuchSymbolXYZ", "upsertAtlasSeedCandidate"],
    });
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).toBe(
      "source-verified",
    );
  });

  it("does NOT source-verify a trivially short / common symbol target", async () => {
    // `id` (len 2) appears as a SUBSTRING all over the tree ("candidate",
    // "Idempotent", "validation", …). A raw substring grep would falsely
    // source-verify; short/common targets must never source-verify.
    const candidate = makeCandidate({
      knowledge_type: "operational",
      validationTargets: ["id"],
    });
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).toBe("unverified");
  });

  it("does NOT source-verify a symbol target that only appears as a substring (word-boundary match)", async () => {
    // `Two` appears ONLY inside the camelCase identifier `TwoLayerShim`, never
    // as a standalone token. A raw substring grep would falsely source-verify;
    // identifier-style targets must match on word boundaries.
    const candidate = makeCandidate({
      knowledge_type: "operational",
      validationTargets: ["Two"],
    });
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).toBe("unverified");
  });
});

describe("promoteValidation — §7 worked proof (CopilotNext: 0 hits)", () => {
  it("a CopilotNext architecture candidate yields 0 grep hits → stays unverified → approvable=false", async () => {
    // `CopilotNext` appears NOWHERE in the fixture checkout tree (by design).
    const candidate = makeCandidate({
      subsystem: "cpk-next",
      title: "CopilotNext replaces the runtime entrypoint",
      knowledge_type: "architecture",
      validationTargets: ["CopilotNext"],
      // canonicalize would have set this true pre-validation; the gate flips it.
      approvable: true,
    });
    const out = await promoteValidation(candidate, ctx);

    expect(out.provenance.classification.validation_status).toBe("unverified");
    // BINDING: an architecture fact that stays unverified is NOT approvable.
    expect(out.approvable).toBe(false);
  });

  it("a design-rationale candidate that stays unverified is also not approvable", async () => {
    const candidate = makeCandidate({
      knowledge_type: "design-rationale",
      validationTargets: ["CopilotNext"],
    });
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).toBe("unverified");
    expect(out.approvable).toBe(false);
  });

  it("a product candidate that stays unverified is NOT approvable (S1 widened the gate set)", async () => {
    // S1 widened BEHAVIOR_KNOWLEDGE_TYPES to the enum-complement of
    // {process, operational, org-culture}, so `product` is now GATED: an
    // unverified product fact is a guilty-until-validated claim and is NOT
    // auto-approvable. (Previously the gate fired only for
    // architecture/design-rationale; this asserts the NEW correct behavior.)
    const candidate = makeCandidate({
      knowledge_type: "product",
      validationTargets: ["CopilotNext"],
    });
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).toBe("unverified");
    expect(out.approvable).toBe(false);
  });

  it("an EXEMPT process/operational candidate that stays unverified REMAINS approvable", async () => {
    // The three exempt process/etiquette types {process, operational,
    // org-culture} are OUT of the gate set: an unverified operational note is
    // still auto-approvable.
    const candidate = makeCandidate({
      knowledge_type: "operational",
      validationTargets: ["CopilotNext"],
    });
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).toBe("unverified");
    expect(out.approvable).toBe(true);
  });
});

describe("promoteValidation — showcase verification (pill + status)", () => {
  it("promotes to showcase-verified when the claim maps to a green pill", async () => {
    const candidate = makeCandidate({
      knowledge_type: "product",
      title: "agentic-chat",
      validationTargets: ["agentic-chat"],
    });
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).toBe(
      "showcase-verified",
    );
  });

  it("a quarantined pill (gen-ui-interrupt) is NOT showcase-verified", async () => {
    // §7 quarantine proof: the quarantined pill must not count as verified. The
    // target also does not exist in the checkout, so it cannot be source-verified
    // either → stays unverified.
    const candidate = makeCandidate({
      knowledge_type: "product",
      title: "gen-ui-interrupt",
      validationTargets: ["gen-ui-interrupt"],
    });
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).not.toBe(
      "showcase-verified",
    );
    expect(out.provenance.classification.validation_status).toBe("unverified");
  });

  it("is NOT showcase-verified when ANY declared pill is quarantined (even if another is green)", async () => {
    // §7 invariant: showcase-verified ONLY when EVERY declared pill is green. A
    // green pill listed first must not mask a quarantined pill listed later.
    const candidate = makeCandidate({
      knowledge_type: "product",
      title: "feature support",
      validationTargets: ["agentic-chat", "gen-ui-interrupt"],
    });
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).not.toBe(
      "showcase-verified",
    );
  });

  it("is NOT showcase-verified when an earlier claim resolves green but a later declared pill is quarantined", async () => {
    // False-positive guard for the old first-resolves-wins logic: the title
    // resolves to a green pill first; the old code would short-circuit to
    // verified and never see the quarantined validationTarget.
    const candidate = makeCandidate({
      knowledge_type: "product",
      title: "agentic-chat",
      validationTargets: ["gen-ui-interrupt"],
    });
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).not.toBe(
      "showcase-verified",
    );
  });

  it("showcase-verified outranks source-verified for a green pill that is also a source symbol", async () => {
    // `upsertAtlasSeedCandidate` exists in the checkout (source-verifiable) AND
    // is not a pill; a green-pill claim should reach the stronger showcase tier.
    const candidate = makeCandidate({
      knowledge_type: "product",
      title: "agentic-chat",
      validationTargets: ["upsertAtlasSeedCandidate", "agentic-chat"],
    });
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).toBe(
      "showcase-verified",
    );
  });
});

describe("promoteValidation — §7 quarantine-bypass (showcase slugs are not source-grepped)", () => {
  // A registry whose QUARANTINED pill slugs coincide with things that DO exist
  // in the fixture checkout — a real source symbol and a real repo path. If the
  // gate were to source-grep these showcase slugs, the candidate would be
  // promoted to `source-verified` despite its pill being quarantined, defeating
  // the §7 quarantine. The fix: a validationTarget that resolves to a registry
  // pill is validated ONLY by the green-pill check, never by the filesystem grep.
  const quarantineRegistry: FeatureRegistry = {
    version: "1",
    categories: [
      {
        id: "shimmed",
        name: "Shimmed",
        pills: [
          // Slug coincides with the `TwoLayerShim` symbol in the checkout.
          { id: "TwoLayerShim", name: "Two Layer Shim", status: "quarantined" },
          // Slug coincides with a real repo path in the checkout.
          {
            id: "src/db/atlas.ts",
            name: "Atlas DB",
            status: "quarantined",
          },
        ],
      },
    ],
  };
  const quarantineCtx: ValidationContext = {
    checkoutDir,
    featureRegistry: quarantineRegistry,
  };

  it("a showcase/derived candidate whose validationTarget slug is a QUARANTINED pill stays unverified (NOT source-verified)", async () => {
    // `TwoLayerShim` is a real source symbol in the checkout AND a quarantined
    // pill slug. It must NOT source-verify (the slug is a showcase claim, not a
    // code symbol to grep), and a quarantined pill is not showcase-verified.
    const candidate = makeCandidate({
      knowledge_type: "product",
      title: "feature support",
      validationTargets: ["TwoLayerShim"],
    });
    const out = await promoteValidation(candidate, quarantineCtx);
    expect(out.provenance.classification.validation_status).toBe("unverified");
  });

  it("a quarantined pill slug that is also a real repo PATH is not back-doored to source-verified", async () => {
    // `src/db/atlas.ts` exists in the checkout AND is a quarantined pill slug.
    // The path-existence check must be skipped for pill-resolving targets.
    const candidate = makeCandidate({
      knowledge_type: "product",
      title: "feature support",
      validationTargets: ["src/db/atlas.ts"],
    });
    const out = await promoteValidation(candidate, quarantineCtx);
    expect(out.provenance.classification.validation_status).toBe("unverified");
  });

  it("a NON-pill code symbol still source-verifies even when other targets are pills", async () => {
    // `upsertAtlasSeedCandidate` is a genuine code symbol (not a pill) and must
    // still grep-promote; only the pill-resolving target is skipped.
    const candidate = makeCandidate({
      knowledge_type: "product",
      title: "feature support",
      validationTargets: ["TwoLayerShim", "upsertAtlasSeedCandidate"],
    });
    const out = await promoteValidation(candidate, quarantineCtx);
    expect(out.provenance.classification.validation_status).toBe(
      "source-verified",
    );
  });
});

describe("promoteValidation — §7 title is not a showcase claim", () => {
  // A registry whose green pill's display NAME is a common English phrase that
  // can appear verbatim in a candidate's free-text title. Resolving pills from
  // `title` would spuriously promote any candidate whose prose happens to
  // contain a pill name. The fix: resolve showcase pills only from
  // `claimSlugHint` + `validationTargets`, never from the free-text title.
  const titleRegistry: FeatureRegistry = {
    version: "1",
    categories: [
      {
        id: "human-loop",
        name: "Human in the Loop",
        pills: [
          {
            id: "human-in-the-loop",
            name: "Human in the Loop",
            status: "green",
          },
        ],
      },
    ],
  };
  const titleCtx: ValidationContext = {
    checkoutDir,
    featureRegistry: titleRegistry,
  };

  it("a candidate whose TITLE matches a green pill's name is NOT showcase-verified on that basis", async () => {
    // The distilled title is EXACTLY the green pill's display name (lookupPill
    // matches name case-insensitively), but no claimSlugHint / validationTarget
    // resolves to a pill → must NOT be showcase-verified.
    const candidate = makeCandidate({
      knowledge_type: "product",
      title: "Human in the Loop",
      validationTargets: [],
    });
    const out = await promoteValidation(candidate, titleCtx);
    expect(out.provenance.classification.validation_status).not.toBe(
      "showcase-verified",
    );
    expect(out.provenance.classification.validation_status).toBe("unverified");
  });
});

describe("promoteValidation — approvable is RECOMPUTED from the promoted status", () => {
  it("a behavior candidate entering approvable=false that PROMOTES to source-verified exits approvable=true", async () => {
    // canonicalize runs BEFORE the gate and sets approvable=false on an
    // unverified architecture fact. Once the gate promotes it, approvability
    // must be recomputed from the PROMOTED status — preserving the stale
    // incoming false would leave every successfully-validated behavior
    // candidate permanently non-checkable in the approval artifact.
    const candidate = makeCandidate({
      knowledge_type: "architecture",
      validation_status: "unverified",
      validationTargets: ["TwoLayerShim"],
      approvable: false,
    });
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).toBe(
      "source-verified",
    );
    expect(out.approvable).toBe(true);
  });

  it("a design-rationale candidate entering approvable=false that showcase-verifies exits approvable=true", async () => {
    const candidate = makeCandidate({
      knowledge_type: "design-rationale",
      validation_status: "unverified",
      validationTargets: ["agentic-chat"],
      approvable: false,
    });
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).toBe(
      "showcase-verified",
    );
    expect(out.approvable).toBe(true);
  });

  it("a behavior candidate that STAYS unverified remains approvable=false", async () => {
    const candidate = makeCandidate({
      knowledge_type: "architecture",
      validation_status: "unverified",
      validationTargets: ["CopilotNext"],
      approvable: false,
    });
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).toBe("unverified");
    expect(out.approvable).toBe(false);
  });

  it("an EXEMPT operational candidate keeps approvable=true even when it stays unverified", async () => {
    // S1 widened the gate set to the enum-complement of the three exempt types;
    // an unverified `operational` note is still exempt → approvable stays true.
    const candidate = makeCandidate({
      knowledge_type: "operational",
      validation_status: "unverified",
      validationTargets: ["CopilotNext"],
      approvable: true,
    });
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).toBe("unverified");
    expect(out.approvable).toBe(true);
  });

  it("a now-gated product candidate that stays unverified is recomputed approvable=false", async () => {
    // A product fact enters approvable=true from canonicalize but is now in the
    // widened gate set; staying unverified recomputes it to non-approvable.
    const candidate = makeCandidate({
      knowledge_type: "product",
      validation_status: "unverified",
      validationTargets: ["CopilotNext"],
      approvable: true,
    });
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).toBe("unverified");
    expect(out.approvable).toBe(false);
  });
});

describe("promoteValidation — purity / no mutation", () => {
  it("does not mutate the input candidate", async () => {
    const candidate = makeCandidate({ validationTargets: ["TwoLayerShim"] });
    const before = candidate.provenance.classification.validation_status;
    await promoteValidation(candidate, ctx);
    expect(candidate.provenance.classification.validation_status).toBe(before);
    expect(candidate.provenance.classification.validation_status).toBe(
      "unverified",
    );
  });

  it("with no validationTargets and no pill match, the candidate is unchanged status-wise", async () => {
    const candidate = makeCandidate({
      knowledge_type: "operational",
      validationTargets: [],
    });
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).toBe("unverified");
    expect(out.approvable).toBe(true);
  });
});

describe("promoteValidation — degenerate root targets never source-verify", () => {
  it('a target resolving to the checkout root ("./") does NOT source-verify', async () => {
    // The checkout root always exists, so a degenerate path target ("./") would
    // spuriously promote a behavior candidate past the §7 gate without naming
    // anything in the tree.
    const candidate = makeCandidate({ validationTargets: ["./"] });
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).toBe("unverified");
    expect(out.approvable).toBe(false);
  });

  it('a target resolving to the checkout root via "a/.." does NOT source-verify', async () => {
    const candidate = makeCandidate({ validationTargets: ["a/.."] });
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).toBe("unverified");
    expect(out.approvable).toBe(false);
  });

  it('a bare "." target does NOT source-verify (too short for a symbol, not a path)', async () => {
    const candidate = makeCandidate({ validationTargets: ["."] });
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).toBe("unverified");
    expect(out.approvable).toBe(false);
  });
});

describe("promoteValidation — descendant walk errors are triaged by errno (fix8 X9)", () => {
  // W13 made only the ROOT readdir loud; a DESCENDANT failure must not silently
  // degrade the §7 gate either. Triage by errno class:
  //   EMFILE/ENFILE → throw (the rest of the walk would silently skip too);
  //   ENOENT       → quiet skip (entry vanished mid-walk, benign race);
  //   anything else (EACCES, EIO, …) → warn naming the path, then skip.
  //
  // These cases run against their OWN hermetic temp checkout (not the shared
  // fixture): the grep short-circuits on the first hit, and the shared
  // fixture's README names every fixture symbol at the ROOT — so walk order
  // would decide whether the stubbed subtree is ever visited. The temp tree
  // keeps exactly one symbol per subtree and the mock delegates readdir in
  // SORTED order, making the visit order deterministic:
  //
  //   tmpRoot/src/blocked/needle.ts  → SymbolInBlockedSubtree
  //   tmpRoot/src/readable/found.ts  → SymbolInReadableSubtree
  const realReaddirSync = fs.readdirSync;
  const realStatSync = fs.statSync;
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-validate-errno-"));
    fs.mkdirSync(path.join(tmpRoot, "src", "blocked"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, "src", "blocked", "needle.ts"),
      "export const SymbolInBlockedSubtree = 1;\n",
    );
    fs.mkdirSync(path.join(tmpRoot, "src", "readable"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, "src", "readable", "found.ts"),
      "export const SymbolInReadableSubtree = 1;\n",
    );
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function errnoError(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`${code}: stubbed filesystem failure`), {
      code,
    });
  }

  // Delegate to the real readdir (the walk always passes withFileTypes: true)
  // in SORTED name order so "blocked" is always visited before "readable".
  function readdirSorted(p: fs.PathLike): fs.Dirent[] {
    return realReaddirSync(p, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  }

  function tmpCtx(): ValidationContext {
    return { checkoutDir: tmpRoot, featureRegistry };
  }

  it("a descendant readdir EMFILE THROWS instead of silently skipping the subtree", async () => {
    vi.spyOn(fs, "readdirSync").mockImplementation(((p: fs.PathLike) => {
      if (p.toString().endsWith(`${path.sep}src`)) {
        throw errnoError("EMFILE");
      }
      return readdirSorted(p);
    }) as unknown as typeof fs.readdirSync);

    // The needle exists nowhere → the walk must enumerate src and hit the stub.
    const candidate = makeCandidate({
      validationTargets: ["SymbolNotAnywhereInTheTree"],
    });
    await expect(promoteValidation(candidate, tmpCtx())).rejects.toThrow(
      /file descriptors/,
    );
  });

  it("a descendant stat/read ENFILE THROWS too (file-level fd exhaustion)", async () => {
    // The walk always calls statSync(full) with no options.
    vi.spyOn(fs, "statSync").mockImplementation(((p: fs.PathLike) => {
      if (p.toString().startsWith(tmpRoot + path.sep)) {
        throw errnoError("ENFILE");
      }
      return realStatSync(p);
    }) as unknown as typeof fs.statSync);

    const candidate = makeCandidate({
      validationTargets: ["SymbolInReadableSubtree"],
    });
    await expect(promoteValidation(candidate, tmpCtx())).rejects.toThrow(
      /file descriptors/,
    );
  });

  it("an EACCES subdirectory WARNS with the path and the walk continues over the readable remainder", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(fs, "readdirSync").mockImplementation(((p: fs.PathLike) => {
      if (p.toString().endsWith(path.join("src", "blocked"))) {
        throw errnoError("EACCES");
      }
      return readdirSorted(p);
    }) as unknown as typeof fs.readdirSync);

    // The needle lives in src/readable — OUTSIDE the unreadable src/blocked
    // subtree (visited FIRST, by sorted order) — so the walk must warn for
    // src/blocked and still find the symbol in the readable remainder.
    const candidate = makeCandidate({
      validationTargets: ["SymbolInReadableSubtree"],
    });
    const out = await promoteValidation(candidate, tmpCtx());
    expect(out.provenance.classification.validation_status).toBe(
      "source-verified",
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(path.join("src", "blocked")),
    );
  });

  it("an ENOENT subdirectory (vanished mid-walk) is skipped QUIETLY — no warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(fs, "readdirSync").mockImplementation(((p: fs.PathLike) => {
      if (p.toString().endsWith(path.join("src", "blocked"))) {
        throw errnoError("ENOENT");
      }
      return readdirSorted(p);
    }) as unknown as typeof fs.readdirSync);

    const candidate = makeCandidate({
      validationTargets: ["SymbolInReadableSubtree"],
    });
    const out = await promoteValidation(candidate, tmpCtx());
    expect(out.provenance.classification.validation_status).toBe(
      "source-verified",
    );
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("promoteValidation — path-target stat errors are triaged by errno (fix11 AA5)", () => {
  // The PATH-existence branch of the §7 source-verify gate must obey the same
  // W13 fail-loud rule as the symbol-grep walk: a filesystem failure must not
  // silently degrade the gate. `fs.existsSync` maps EVERY errno
  // (EMFILE/EACCES/EIO, …) to `false` — the candidate would be quietly
  // unverified with no signal. Unlike the walk (which has a readable remainder
  // to continue over), a path target has exactly ONE probe, so any errno other
  // than plain absence (ENOENT/ENOTDIR) must THROW naming the target.
  const realStatSync = fs.statSync;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function errnoError(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`${code}: stubbed filesystem failure`), {
      code,
    });
  }

  it("an EACCES stat on the path target THROWS loudly naming the target", async () => {
    // The fixture file genuinely exists — only the stubbed errno stands
    // between the gate and a verify. existsSync would swallow it to `false`.
    const target = "src/db/atlas.ts";
    const resolved = path.resolve(checkoutDir, target);
    vi.spyOn(fs, "statSync").mockImplementation(((p: fs.PathLike) => {
      if (p.toString() === resolved) {
        throw errnoError("EACCES");
      }
      return realStatSync(p);
    }) as unknown as typeof fs.statSync);

    const candidate = makeCandidate({ validationTargets: [target] });
    await expect(promoteValidation(candidate, ctx)).rejects.toThrow(
      /src\/db\/atlas\.ts/,
    );
  });

  it("a MISSING path target (ENOENT) stays a quiet false — unverified, no throw", async () => {
    const candidate = makeCandidate({
      validationTargets: ["src/db/no-such-file.ts"],
    });
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).toBe("unverified");
    expect(out.approvable).toBe(false);
  });

  it("a path target through a FILE segment (ENOTDIR) stays a quiet false", async () => {
    // src/db/atlas.ts is a file; descending "into" it stats ENOTDIR — plain
    // absence, not a degraded gate.
    const candidate = makeCandidate({
      validationTargets: ["src/db/atlas.ts/nope.ts"],
    });
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).toBe("unverified");
  });

  it("an EXISTING path target still source-verifies (stat success path)", async () => {
    const candidate = makeCandidate({ validationTargets: ["src/db/atlas.ts"] });
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).toBe(
      "source-verified",
    );
  });
});

describe("promoteValidation — SKIP_DIRS path targets never source-verify (fix8 X16)", () => {
  // The symbol grep deliberately skips SKIP_DIRS (vendored/build/VCS trees);
  // the PATH-existence branch must present the same gate surface — a target
  // like "node_modules/foo/index.js" is not project source and must not
  // promote a candidate past §7 just because the file exists on disk.
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "atlas-validate-skipdirs-"),
    );
    fs.mkdirSync(path.join(tmpRoot, "node_modules", "fake-pkg"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpRoot, "node_modules", "fake-pkg", "index.js"),
      "module.exports = {};\n",
    );
    fs.mkdirSync(path.join(tmpRoot, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, "src", "x.ts"),
      "export const realProjectSource = 1;\n",
    );
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("an EXISTING node_modules path target does NOT source-verify", async () => {
    const tmpCtx: ValidationContext = { checkoutDir: tmpRoot, featureRegistry };
    // The file genuinely exists — only the SKIP_DIRS rule keeps it unverified.
    expect(
      fs.existsSync(path.join(tmpRoot, "node_modules", "fake-pkg", "index.js")),
    ).toBe(true);
    const candidate = makeCandidate({
      validationTargets: ["node_modules/fake-pkg/index.js"],
    });
    const out = await promoteValidation(candidate, tmpCtx);
    expect(out.provenance.classification.validation_status).toBe("unverified");
  });

  it("a real source path in the same checkout still source-verifies", async () => {
    const tmpCtx: ValidationContext = { checkoutDir: tmpRoot, featureRegistry };
    const candidate = makeCandidate({ validationTargets: ["src/x.ts"] });
    const out = await promoteValidation(candidate, tmpCtx);
    expect(out.provenance.classification.validation_status).toBe(
      "source-verified",
    );
  });
});

describe("promoteValidation — definition-aware grep (A.4): mention ≠ declaration", () => {
  // The source-verify grep must promote ONLY when a CODE file DECLARES the
  // needle. A symbol that appears only inside a comment (or a string literal /
  // call site) is NOT a declaration — it is prose about a symbol, not proof the
  // symbol exists in the tree — and must not source-verify (the §7 bypass a
  // root-cause claim naming a comment-only symbol would exploit).
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "atlas-validate-defaware-"),
    );
    fs.mkdirSync(path.join(tmpRoot, "src"), { recursive: true });
    // The needle `CommentOnlySymbol` appears ONLY inside a comment — never as a
    // declaration. A definition-aware grep must not source-verify it.
    fs.writeFileSync(
      path.join(tmpRoot, "src", "note.ts"),
      "// This module relates to CommentOnlySymbol but never declares it.\n" +
        "export const somethingElse = 1;\n",
    );
    // A genuine declaration to prove the grep still promotes real ones.
    fs.writeFileSync(
      path.join(tmpRoot, "src", "real.ts"),
      "export function ActuallyDeclaredSymbol(): void {}\n",
    );
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function tmpCtx(): ValidationContext {
    return { checkoutDir: tmpRoot, featureRegistry };
  }

  it("a symbol that appears ONLY in a comment does NOT source-verify", async () => {
    const candidate = makeCandidate({
      knowledge_type: "architecture",
      validationTargets: ["CommentOnlySymbol"],
    });
    const out = await promoteValidation(candidate, tmpCtx());
    expect(out.provenance.classification.validation_status).toBe("unverified");
    // Architecture fact staying unverified → not approvable.
    expect(out.approvable).toBe(false);
  });

  it("a genuinely DECLARED symbol still source-verifies (definition-aware regression)", async () => {
    const candidate = makeCandidate({
      knowledge_type: "architecture",
      validationTargets: ["ActuallyDeclaredSymbol"],
    });
    const out = await promoteValidation(candidate, tmpCtx());
    expect(out.provenance.classification.validation_status).toBe(
      "source-verified",
    );
  });
});

describe("promoteValidation — code-file-extension allowlist (A.4): docs/data don't source-verify", () => {
  // A DECL_RE-shaped hit inside a `.md`/`.json`/`.txt` fixture is doc/data
  // prose, not project source. Only real code files (CODE_FILE_EXTENSIONS) may
  // source-verify a symbol target.
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "atlas-validate-extallow-"),
    );
    // A `.md` file whose text is EXACTLY a TS-style declaration (DECL_RE would
    // match its shape), but a `.md` is not a code file → must not source-verify.
    fs.writeFileSync(
      path.join(tmpRoot, "DESIGN.md"),
      "# Design\n\n```ts\nexport class MarkdownOnlyDeclSymbol {}\n```\n",
    );
    // A `.json` fixture that happens to contain the declaration text too.
    fs.writeFileSync(
      path.join(tmpRoot, "data.json"),
      '{ "note": "export const JsonOnlyDeclSymbol = 1;" }\n',
    );
    // A real code file with a genuine declaration (control).
    fs.mkdirSync(path.join(tmpRoot, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, "src", "real.ts"),
      "export const RealCodeDeclSymbol = 1;\n",
    );
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function tmpCtx(): ValidationContext {
    return { checkoutDir: tmpRoot, featureRegistry };
  }

  it("a symbol declared only inside a .md fixture does NOT source-verify", async () => {
    const candidate = makeCandidate({
      knowledge_type: "architecture",
      validationTargets: ["MarkdownOnlyDeclSymbol"],
    });
    const out = await promoteValidation(candidate, tmpCtx());
    expect(out.provenance.classification.validation_status).toBe("unverified");
    expect(out.approvable).toBe(false);
  });

  it("a symbol appearing only inside a .json fixture does NOT source-verify", async () => {
    const candidate = makeCandidate({
      knowledge_type: "architecture",
      validationTargets: ["JsonOnlyDeclSymbol"],
    });
    const out = await promoteValidation(candidate, tmpCtx());
    expect(out.provenance.classification.validation_status).toBe("unverified");
  });

  it("a symbol declared in a real .ts code file still source-verifies", async () => {
    const candidate = makeCandidate({
      knowledge_type: "architecture",
      validationTargets: ["RealCodeDeclSymbol"],
    });
    const out = await promoteValidation(candidate, tmpCtx());
    expect(out.provenance.classification.validation_status).toBe(
      "source-verified",
    );
  });
});

describe("promoteValidation — RESTATEMENT_MARKER is a hard approvable=false floor (A.2)", () => {
  // The A.1 distillation gate (S8) stamps RESTATEMENT_MARKER on a candidate its
  // LLM judge ruled a pure restatement of already-indexed content. Such a
  // candidate carries no NEW verifiable claim, so it must be approvable=false
  // even if its symbols grep-verify — the marker is a floor the source-verify
  // recompute cannot lift. S4 reads the SAME imported literal S8 emits (O2), via
  // the same carrier idioms rag-dedup uses: provenance.validated_against and/or
  // a `fused_from` evidence ref.

  function withValidatedAgainst(c: Candidate, marker: string): Candidate {
    return {
      ...c,
      provenance: {
        ...c.provenance,
        validated_against: marker,
      },
    };
  }

  it("a restatement candidate (validated_against marker) with grep-verifiable symbols is approvable=false", async () => {
    // `TwoLayerShim` IS declared in the shared fixture checkout → would normally
    // source-verify and (as an architecture fact) become approvable=true. The
    // restatement marker pins approvable=false regardless.
    const base = makeCandidate({
      knowledge_type: "architecture",
      validationTargets: ["TwoLayerShim"],
    });
    const candidate = withValidatedAgainst(base, RESTATEMENT_MARKER);
    const out = await promoteValidation(candidate, ctx);
    // The grep still promotes the status (the marker only gates approvability).
    expect(out.provenance.classification.validation_status).toBe(
      "source-verified",
    );
    expect(out.approvable).toBe(false);
  });

  it("the marker is recognized among other '; '-joined validated_against tokens", async () => {
    const base = makeCandidate({
      knowledge_type: "product",
      validationTargets: ["TwoLayerShim"],
    });
    const candidate = withValidatedAgainst(
      base,
      `rag-corpus-overlap:some-ref; ${RESTATEMENT_MARKER}`,
    );
    const out = await promoteValidation(candidate, ctx);
    expect(out.approvable).toBe(false);
  });

  it("the marker is recognized via a fused_from evidence ref", async () => {
    const base = makeCandidate({
      knowledge_type: "architecture",
      validationTargets: ["TwoLayerShim"],
    });
    const candidate: Candidate = {
      ...base,
      evidence: [{ kind: "fused_from", ref: RESTATEMENT_MARKER }],
    };
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).toBe(
      "source-verified",
    );
    expect(out.approvable).toBe(false);
  });

  it("a NON-restatement candidate (marker absent) with grep-verifiable symbols stays approvable=true", async () => {
    // Control: without the marker, a source-verified architecture fact is
    // approvable — the floor only fires when the marker is present.
    const candidate = makeCandidate({
      knowledge_type: "architecture",
      validationTargets: ["TwoLayerShim"],
    });
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).toBe(
      "source-verified",
    );
    expect(out.approvable).toBe(true);
  });

  it("a validated_against overlap marker that is NOT the restatement marker does not gate approvability", async () => {
    // Whole-token match, not substring: an unrelated marker must not trip the
    // floor.
    const base = makeCandidate({
      knowledge_type: "architecture",
      validationTargets: ["TwoLayerShim"],
    });
    const candidate = withValidatedAgainst(base, "rag-corpus-overlap:some-ref");
    const out = await promoteValidation(candidate, ctx);
    expect(out.approvable).toBe(true);
  });
});

describe("promoteValidation — composes the rag-dedup no-delta floor (dedicated marker)", () => {
  // The rag-dedup no-delta gate floors a pure corpus-DUPLICATE candidate to
  // `approvable=false` (nothing net-new to re-seed) and stamps a DEDICATED floor
  // marker RAG_NO_DELTA_MARKER (via applyDistillDelta) on BOTH carriers:
  // provenance.validated_against and a `fused_from` evidence ref — the SAME dual
  // idiom RESTATEMENT_MARKER uses. Before this fix, promoteValidation RECOMPUTED
  // `approvable` purely from the promoted status and honored ONLY the restatement
  // marker, so a no-delta duplicate whose symbols grep-verify was clobbered back
  // to approvable=true — silently defeating dedup's "duplicates aren't
  // approvable" guarantee. The structural fix COMPOSES all dedicated floor
  // markers: the recompute may LOWER approvability but must never RAISE it above
  // a value an upstream GATE already floored it to. A dedicated marker is
  // unambiguous — unlike the generic corpus-overlap ANNOTATION (stamped for every
  // overlap verdict, delta included, where the candidate stays approvable) — so
  // it fires the floor regardless of the incoming flag, while a pure canonicalize
  // status-rule floor (no marker) is still lifted on promotion.

  // The generic `rag-corpus-overlap:` annotation annotateOverlap stamps for EVERY
  // overlap verdict (delta INCLUDED) — present on a no-delta duplicate too, but
  // NOT itself a floor signal.
  const OVERLAP_REF = "rag-corpus-overlap:https://example.com/pr/1";

  // Shape a candidate exactly as rag-dedup's no-delta path leaves it: the
  // approvable=false floor, the generic overlap annotation, AND the dedicated
  // RAG_NO_DELTA_MARKER floor marker — on both carriers.
  function asNoDeltaDuplicate(c: Candidate): Candidate {
    return {
      ...c,
      approvable: false,
      provenance: {
        ...c.provenance,
        validated_against: `${OVERLAP_REF}; ${RAG_NO_DELTA_MARKER}`,
      },
      evidence: [
        ...c.evidence,
        { kind: "fused_from", ref: OVERLAP_REF },
        { kind: "fused_from", ref: RAG_NO_DELTA_MARKER },
      ],
    };
  }

  it("a no-delta corpus-duplicate whose symbols grep-verify stays approvable=false", async () => {
    // `TwoLayerShim` IS declared in the fixture checkout → source-verifies →
    // an architecture fact would normally recompute to approvable=true. The
    // dedicated no-delta floor marker must survive the recompute.
    const candidate = asNoDeltaDuplicate(
      makeCandidate({
        knowledge_type: "architecture",
        validationTargets: ["TwoLayerShim"],
      }),
    );
    const out = await promoteValidation(candidate, ctx);
    // Status still promotes (display truth — the symbol really exists).
    expect(out.provenance.classification.validation_status).toBe(
      "source-verified",
    );
    // The upstream floor survives — NOT clobbered back to true.
    expect(out.approvable).toBe(false);
  });

  it("the no-delta floor is recognized via the fused_from evidence ref alone", async () => {
    // rag-dedup carries the marker on BOTH validated_against and a fused_from
    // evidence ref; the reader must recognize either. Here only the evidence ref
    // carries it.
    const base = makeCandidate({
      knowledge_type: "architecture",
      validationTargets: ["TwoLayerShim"],
    });
    const candidate: Candidate = {
      ...base,
      approvable: false,
      evidence: [{ kind: "fused_from", ref: RAG_NO_DELTA_MARKER }],
    };
    const out = await promoteValidation(candidate, ctx);
    expect(out.approvable).toBe(false);
  });

  it("a no-delta duplicate mapping to a GREEN pill (showcase-verifies) still stays approvable=false", async () => {
    // Even the strongest verification tier must not raise approvability above an
    // upstream floor.
    const candidate = asNoDeltaDuplicate(
      makeCandidate({
        knowledge_type: "product",
        title: "agentic-chat",
        validationTargets: ["agentic-chat"],
      }),
    );
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).toBe(
      "showcase-verified",
    );
    expect(out.approvable).toBe(false);
  });

  it("a restatement marker floors even with incoming approvable=true (unconditional dedicated floor)", async () => {
    // The distillation gate stamps RESTATEMENT_MARKER but does NOT pre-set
    // `approvable`, so a restatement typically arrives approvable=true. The
    // dedicated marker is the floor — it fires regardless of the incoming flag
    // even though its symbols grep-verify (preserving the original restatement
    // floor).
    const base = makeCandidate({
      knowledge_type: "architecture",
      validationTargets: ["TwoLayerShim"],
      approvable: true, // distillation gate leaves the flag untouched
    });
    const candidate: Candidate = {
      ...base,
      provenance: { ...base.provenance, validated_against: RESTATEMENT_MARKER },
    };
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).toBe(
      "source-verified",
    );
    expect(out.approvable).toBe(false);
  });

  it("an ANNOTATED delta (overlap annotation, NO no-delta marker) is NOT floored", async () => {
    // A `delta` verdict carries the SAME generic overlap annotation as a no-delta
    // duplicate (annotateOverlap runs for every overlap verdict) but keeps its
    // net-new content and does NOT get the dedicated no-delta marker. It also
    // inherits canonicalize's status-rule floor (approvable=false, unverified
    // architecture) — which the gate must LIFT on promotion. The generic overlap
    // annotation alone must NOT floor it: a source-verified architecture delta
    // remains approvable.
    const base = makeCandidate({
      knowledge_type: "architecture",
      validation_status: "unverified",
      validationTargets: ["TwoLayerShim"],
      approvable: false, // canonicalize status-rule floor, carried by the delta
    });
    const candidate: Candidate = {
      ...base,
      provenance: { ...base.provenance, validated_against: OVERLAP_REF },
      evidence: [...base.evidence, { kind: "fused_from", ref: OVERLAP_REF }],
    };
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).toBe(
      "source-verified",
    );
    expect(out.approvable).toBe(true);
  });

  it("a canonicalize status-rule floor (approvable=false, NO marker) is LIFTED on promotion", async () => {
    // The load-bearing preserved path: canonicalize floors an unverified
    // behavior fact to approvable=false PURELY from the status rule (no marker).
    // Once the gate promotes it (source-verifies), that floor must LIFT —
    // otherwise every genuinely-validated behavior fact stays permanently
    // non-checkable. The composed floor must NOT clobber this.
    const candidate = makeCandidate({
      knowledge_type: "architecture",
      validation_status: "unverified",
      validationTargets: ["TwoLayerShim"],
      approvable: false, // canonicalize status-rule floor, NO upstream marker
    });
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).toBe(
      "source-verified",
    );
    expect(out.approvable).toBe(true);
  });
});

describe("promoteValidation — a restatement floor also floors the rank contribution (A.2)", () => {
  // The dominant rank factor (canonicalize's VALIDATION_WEIGHT) is derived from
  // validation_status. A RESTATEMENT-floored candidate (approvable=false) whose
  // symbols happen to grep-verify has its status promoted to source-verified —
  // but it carries NO new verifiable claim, so it must NOT gain rank from that
  // promotion. Otherwise the restatement out-ranks a GENUINE claim purely on the
  // validation-status weight, surfacing restatement noise above real why/how in
  // the ranked artifact. The floor on approvable must extend to the rank
  // contribution: a restatement-floored candidate ranks as if unverified.

  function withValidatedAgainst(c: Candidate, marker: string): Candidate {
    return {
      ...c,
      provenance: { ...c.provenance, validated_against: marker },
    };
  }

  const NOW = new Date("2026-06-09").getTime();

  it("a source-verified RESTATEMENT does NOT out-rank a genuine source-verified claim on the validation weight", async () => {
    // Both candidates source-verify (their symbol `TwoLayerShim` /
    // `upsertAtlasSeedCandidate` is declared in the fixture checkout) and share
    // every other rank input (same date, confidence, provenance_class, evidence).
    // The ONLY difference is the restatement marker on one of them. A restatement
    // must not rank AT OR ABOVE a genuine claim — its promoted status must not
    // lift its rank.
    const genuine = recomputeRankScore(
      await promoteValidation(
        makeCandidate({
          knowledge_type: "architecture",
          validationTargets: ["upsertAtlasSeedCandidate"],
        }),
        ctx,
      ),
      NOW,
    );
    const restatement = recomputeRankScore(
      await promoteValidation(
        withValidatedAgainst(
          makeCandidate({
            knowledge_type: "architecture",
            validationTargets: ["TwoLayerShim"],
          }),
          RESTATEMENT_MARKER,
        ),
        ctx,
      ),
      NOW,
    );

    // Both promote to source-verified for DISPLAY truth (the symbols do exist).
    expect(genuine.provenance.classification.validation_status).toBe(
      "source-verified",
    );
    expect(restatement.provenance.classification.validation_status).toBe(
      "source-verified",
    );
    // But the restatement is approvable=false and must NOT out-rank the genuine
    // claim: its rank contribution is floored to the unverified weight.
    expect(restatement.approvable).toBe(false);
    expect(restatement.rankScore).toBeLessThan(genuine.rankScore);
  });

  it("a restatement floored to the unverified rank weight ranks like an unverified genuine claim", async () => {
    // A restatement that grep-verifies must rank NO HIGHER than a genuine claim
    // that stays unverified (both should get the unverified validation weight).
    const genuineUnverified = recomputeRankScore(
      await promoteValidation(
        makeCandidate({
          knowledge_type: "operational", // exempt → stays approvable even unverified
          validationTargets: ["CopilotNext"], // not in the tree → stays unverified
        }),
        ctx,
      ),
      NOW,
    );
    const restatement = recomputeRankScore(
      await promoteValidation(
        withValidatedAgainst(
          makeCandidate({
            knowledge_type: "operational",
            validationTargets: ["TwoLayerShim"], // grep-verifies
          }),
          RESTATEMENT_MARKER,
        ),
        ctx,
      ),
      NOW,
    );

    expect(genuineUnverified.provenance.classification.validation_status).toBe(
      "unverified",
    );
    expect(restatement.provenance.classification.validation_status).toBe(
      "source-verified",
    );
    // Same rank inputs otherwise; the restatement's floored validation weight
    // must equal the unverified genuine claim's — never exceed it.
    expect(restatement.rankScore).toBeLessThanOrEqual(
      genuineUnverified.rankScore,
    );
  });

  it("a NON-restatement source-verified claim keeps its full (promoted) rank weight", async () => {
    // Control: without the marker, a source-verified claim DOES benefit from the
    // promotion — it out-ranks an unverified twin. The floor fires ONLY for
    // restatements.
    const sourceVerified = recomputeRankScore(
      await promoteValidation(
        makeCandidate({
          knowledge_type: "operational",
          validationTargets: ["TwoLayerShim"],
        }),
        ctx,
      ),
      NOW,
    );
    const unverified = recomputeRankScore(
      await promoteValidation(
        makeCandidate({
          knowledge_type: "operational",
          validationTargets: ["CopilotNext"],
        }),
        ctx,
      ),
      NOW,
    );
    expect(sourceVerified.provenance.classification.validation_status).toBe(
      "source-verified",
    );
    expect(sourceVerified.rankScore).toBeGreaterThan(unverified.rankScore);
  });
});

describe("promoteValidation — unreadable checkout root fails LOUD", () => {
  it("a nonexistent checkout root THROWS instead of silently yielding all-unverified", async () => {
    // A vanished/unreadable checkout root must not silently disable the §7
    // source-verify gate (every symbol target quietly unverified); it must
    // surface as a loud failure naming the root.
    const badCtx: ValidationContext = {
      checkoutDir: path.join(checkoutDir, "no-such-dir-xyz"),
      featureRegistry,
    };
    const candidate = makeCandidate({ validationTargets: ["TwoLayerShim"] });
    await expect(promoteValidation(candidate, badCtx)).rejects.toThrow(
      /checkout root/,
    );
  });
});
