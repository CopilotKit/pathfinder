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
import { CandidateSchema } from "../atlas/types.js";
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

  it("a NON-behavior candidate (e.g. product) that stays unverified REMAINS approvable", async () => {
    // The binding rule only fires for architecture / design-rationale facts.
    const candidate = makeCandidate({
      knowledge_type: "product",
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

  it("a non-behavior candidate keeps approvable=true even when it stays unverified", async () => {
    const candidate = makeCandidate({
      knowledge_type: "product",
      validation_status: "unverified",
      validationTargets: ["CopilotNext"],
      approvable: true,
    });
    const out = await promoteValidation(candidate, ctx);
    expect(out.provenance.classification.validation_status).toBe("unverified");
    expect(out.approvable).toBe(true);
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
