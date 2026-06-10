// Unit tests for the Atlas showcase adapter (S9).
//
// Covers three things the slot owns:
//   1. `extract(unit, ctx)` — a showcase integration (its parsed manifest.yaml +
//      the parsed feature-registry.json pill list) → a CandidateFragment about
//      the integration's feature support (LeafAdapter contract).
//   2. The exported `FeatureRegistry` TYPE — shape modeled on the real
//      showcase/shared/feature-registry.json (categories + pills + status); S14's
//      validation gate imports it.
//   3. `lookupPill(registry, claim)` — the validation-oracle helper S14 uses for
//      showcase-verification: green for a supported pill, quarantined for the
//      `gen-ui-interrupt` pill.
//
// Fixtures (feature-registry.json + manifest.yaml) are read from disk and parsed
// with the same `yaml` dep the repo uses, exercising the real parse path. Paths
// resolve relative to this test file (hermetic, cwd-independent).

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  showcaseAdapter,
  lookupPill,
  type FeatureRegistry,
  type ShowcaseManifest,
  type ShowcaseUnit,
} from "../atlas/adapters/showcase.js";
import type { AdapterContext } from "../atlas/adapters/types.js";
import { CandidateFragmentSchema } from "../atlas/types.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "atlas",
  "showcase",
);

function loadRegistry(): FeatureRegistry {
  const raw = fs.readFileSync(
    path.join(fixturesDir, "feature-registry.json"),
    "utf-8",
  );
  return JSON.parse(raw) as FeatureRegistry;
}

function loadManifest(): ShowcaseManifest {
  const raw = fs.readFileSync(path.join(fixturesDir, "manifest.yaml"), "utf-8");
  return parseYaml(raw) as ShowcaseManifest;
}

function loadUnit(): ShowcaseUnit {
  return { manifest: loadManifest(), registry: loadRegistry() };
}

const ctx: AdapterContext = { now: new Date("2026-06-08T00:00:00.000Z") };

describe("showcaseAdapter.extract", () => {
  it("conforms to the LeafAdapter contract", () => {
    expect(showcaseAdapter.sourcetype).toBe("derived");
    expect(typeof showcaseAdapter.extract).toBe("function");
  });

  it("maps a showcase integration → one fragment about feature support", async () => {
    const fragments = await showcaseAdapter.extract(loadUnit(), ctx);
    expect(fragments).toHaveLength(1);

    const [fragment] = fragments;
    // The fragment must validate against the S0 contract schema.
    expect(() => CandidateFragmentSchema.parse(fragment)).not.toThrow();

    // Showcase knowledge is synthesized from manifest + registry → "derived".
    expect(fragment.sourcetype).toBe("derived");
    expect(fragment.provenance.classification.provenance_class).toBe("derived");
    expect(fragment.provenance.classification.knowledge_type).toBe("product");
    // Subsystem is the integration identity.
    expect(fragment.subsystem).toBe("langgraph-python");
    // The claim says what the manifest DECLARES (the fixture includes a
    // quarantined pill, so "supports" would overclaim); pills in body.
    expect(fragment.title).toBe(
      "LangGraph (Python) declares 5 showcase feature(s)",
    );
    expect(fragment.content).toContain("agentic-chat");
    // `ref` is a git-ref field in every adapter; the integration slug is NOT a
    // git ref and already lives in subsystem/source_name. It must stay unset.
    expect(fragment.ref).toBeUndefined();
  });

  it("records the declared pills as validationTargets when every pill is green", async () => {
    const unit = loadUnit();
    // Drop the quarantined pill so the integration is fully green.
    unit.manifest.features = unit.manifest.features.filter(
      (f) => f !== "gen-ui-interrupt",
    );
    const [fragment] = await showcaseAdapter.extract(unit, ctx);
    // Pills the manifest declares — re-checked by the S14 validation gate.
    // Literal expected array (NOT `unit.manifest.features`): comparing against
    // the manifest's own reference would be vacuous when the adapter aliases it.
    expect(fragment.validationTargets).toEqual([
      "agentic-chat",
      "agentic-chat-stream",
      "gen-ui",
      "hitl",
    ]);
    // The fragment must carry a COPY, never the manifest's array by reference
    // (a downstream mutation of the targets must not corrupt the manifest).
    expect(fragment.validationTargets).not.toBe(unit.manifest.features);
    fragment.validationTargets.push("mutated-pill");
    expect(unit.manifest.features).toEqual([
      "agentic-chat",
      "agentic-chat-stream",
      "gen-ui",
      "hitl",
    ]);
  });

  it("dedupes duplicate declared features (case-insensitive, order-preserving) across title, body, evidence, and targets", async () => {
    const unit = loadUnit();
    unit.manifest.features = [
      "agentic-chat",
      "Agentic-Chat",
      "hitl",
      "agentic-chat",
    ];
    const [fragment] = await showcaseAdapter.extract(unit, ctx);

    // Title counts UNIQUE declared features, first occurrence wins.
    expect(fragment.title).toBe(
      "LangGraph (Python) declares 2 showcase feature(s)",
    );
    // Body lists each unique feature exactly once.
    expect(fragment.content.split("\n")).toEqual([
      "LangGraph (Python) integration feature support:",
      "- agentic-chat: green",
      "- hitl: green",
    ]);
    // fused_from evidence is not inflated by duplicates.
    expect(fragment.evidence).toEqual([
      { kind: "fused_from", ref: "feature-registry:agentic-chat" },
      { kind: "fused_from", ref: "feature-registry:hitl" },
    ]);
    // Both unique pills are green → allGreen → deduped targets.
    expect(fragment.validationTargets).toEqual(["agentic-chat", "hitl"]);
  });

  it("dedupes whitespace-padded duplicate features and emits the trimmed value everywhere", async () => {
    const unit = loadUnit();
    // A padded re-declaration of the same pill must collapse into ONE entry —
    // and the surviving value must be the TRIMMED slug (a padded slug would
    // otherwise leak into the title count, body, fused_from, and targets).
    unit.manifest.features = ["agentic-chat", " Agentic-Chat "];
    const [fragment] = await showcaseAdapter.extract(unit, ctx);

    expect(fragment.title).toBe(
      "LangGraph (Python) declares 1 showcase feature(s)",
    );
    expect(fragment.content.split("\n")).toEqual([
      "LangGraph (Python) integration feature support:",
      "- agentic-chat: green",
    ]);
    expect(fragment.evidence).toEqual([
      { kind: "fused_from", ref: "feature-registry:agentic-chat" },
    ]);
    // The pill is green → allGreen → the (trimmed) target is emitted.
    expect(fragment.validationTargets).toEqual(["agentic-chat"]);
  });

  it("emits the trimmed slug when the only declaration is whitespace-padded", async () => {
    const unit = loadUnit();
    unit.manifest.features = ["  hitl  "];
    const [fragment] = await showcaseAdapter.extract(unit, ctx);

    expect(fragment.content).toContain("- hitl: green");
    expect(fragment.evidence).toEqual([
      { kind: "fused_from", ref: "feature-registry:hitl" },
    ]);
    expect(fragment.validationTargets).toEqual(["hitl"]);
  });

  it("returns [] when every declared feature is blank (no '- : unknown' row)", async () => {
    // A blank declaration references no pill at all; without filtering it
    // passes the length guard and renders a degenerate "- : unknown" body row
    // with title "declares 1 feature(s)".
    const unit = loadUnit();
    unit.manifest.features = [""];
    expect(await showcaseAdapter.extract(unit, ctx)).toEqual([]);

    unit.manifest.features = ["   "];
    expect(await showcaseAdapter.extract(unit, ctx)).toEqual([]);
  });

  it("drops blank declarations from a mixed feature list", async () => {
    const unit = loadUnit();
    unit.manifest.features = ["", "agentic-chat", "   "];
    const [fragment] = await showcaseAdapter.extract(unit, ctx);

    expect(fragment.title).toBe(
      "LangGraph (Python) declares 1 showcase feature(s)",
    );
    expect(fragment.content.split("\n")).toEqual([
      "LangGraph (Python) integration feature support:",
      "- agentic-chat: green",
    ]);
    expect(fragment.validationTargets).toEqual(["agentic-chat"]);
  });

  it("emits NO validationTargets when the integration is not fully green (gate-over-promotion)", async () => {
    // The fixture manifest declares the quarantined `gen-ui-interrupt` pill →
    // allGreen is false. A non-green candidate must hand the S14 gate ZERO
    // targets: any target it carries could grep-match in the checkout and
    // promote the candidate to `source-verified`, back-dooring the §7
    // quarantine. The gate decision lives HERE, once — not in validate.ts.
    const [fragment] = await showcaseAdapter.extract(loadUnit(), ctx);
    expect(fragment.validationTargets).toEqual([]);
  });

  it("emits NO validationTargets when a declared feature resolves to no registry pill (§7 back-door)", async () => {
    // A typo'd / renamed / removed feature slug resolves to no pill → the
    // integration cannot be allGreen → no targets at all. The unknown slug
    // (and every other slug) never reaches the S14 source grep, where it could
    // substring/token-match somewhere in the checkout and spuriously promote
    // this candidate to `source-verified`, defeating the §7 quarantine.
    const unit = loadUnit();
    // Make every remaining pill green so the unknown slug is the ONLY thing
    // blocking allGreen — proving the gate, not the quarantined fixture pill.
    unit.manifest.features = unit.manifest.features.filter(
      (f) => f !== "gen-ui-interrupt",
    );
    unit.manifest.features = [
      ...unit.manifest.features,
      "totally-unknown-pill",
    ];
    const [fragment] = await showcaseAdapter.extract(unit, ctx);

    expect(fragment.validationTargets).toEqual([]);
    // The body still lists the unknown feature so a human sees it (as `unknown`).
    expect(fragment.content).toContain("totally-unknown-pill: unknown");
    // An unknown feature is not green → the fragment stays unverified/needsReview.
    expect(fragment.provenance.classification.validation_status).toBe(
      "unverified",
    );
    expect(fragment.needsReview).toBe(true);
  });

  it("derives provenance date + freshness from ctx.now (deterministic)", async () => {
    const [fragment] = await showcaseAdapter.extract(loadUnit(), ctx);
    expect(fragment.provenance.classification.freshness.as_of).toBe(
      "2026-06-08",
    );
  });

  it("marks the fragment unverified when a declared feature is quarantined", async () => {
    // The fixture manifest declares `gen-ui-interrupt`, which is quarantined →
    // the integration is NOT fully showcase-verified, so the first-pass status
    // stays `unverified` and the fragment is flagged for review.
    const [fragment] = await showcaseAdapter.extract(loadUnit(), ctx);
    expect(fragment.provenance.classification.validation_status).toBe(
      "unverified",
    );
    expect(fragment.needsReview).toBe(true);
  });

  it("marks the fragment showcase-verified when every declared feature is green", async () => {
    const unit = loadUnit();
    // Drop the quarantined pill from this integration's declared features.
    unit.manifest.features = unit.manifest.features.filter(
      (f) => f !== "gen-ui-interrupt",
    );
    const [fragment] = await showcaseAdapter.extract(unit, ctx);
    expect(fragment.provenance.classification.validation_status).toBe(
      "showcase-verified",
    );
    expect(fragment.needsReview).toBe(false);
  });
});

describe("lookupPill", () => {
  it("returns green for a supported pill", () => {
    const registry = loadRegistry();
    expect(lookupPill(registry, "agentic-chat")).toEqual({
      pill: "agentic-chat",
      status: "green",
    });
  });

  it("returns quarantined for the gen-ui-interrupt pill", () => {
    const registry = loadRegistry();
    expect(lookupPill(registry, "gen-ui-interrupt")).toEqual({
      pill: "gen-ui-interrupt",
      status: "quarantined",
    });
  });

  it("returns not_supported for a pill marked unsupported", () => {
    const registry = loadRegistry();
    expect(lookupPill(registry, "shared-state-experimental")).toEqual({
      pill: "shared-state-experimental",
      status: "not_supported",
    });
  });

  it("matches a pill by its human name (case-insensitive)", () => {
    const registry = loadRegistry();
    // S14 feeds a free-text claim; the helper resolves it by id OR display name.
    expect(lookupPill(registry, "Generative UI Interrupt")).toEqual({
      pill: "gen-ui-interrupt",
      status: "quarantined",
    });
  });

  it("returns undefined for a claim that matches no pill", () => {
    const registry = loadRegistry();
    expect(lookupPill(registry, "no-such-feature")).toBeUndefined();
  });

  it("returns undefined for an empty/whitespace claim (never matches a name-less pill)", () => {
    // A registry whose pill carries an empty name must NOT be matched by an
    // empty/whitespace claim (needle === "" must not collide with name === "").
    const registry: FeatureRegistry = {
      categories: [
        {
          id: "c",
          pills: [{ id: "p1", name: "", status: "green" }],
        },
      ],
    };
    expect(lookupPill(registry, "")).toBeUndefined();
    expect(lookupPill(registry, "   ")).toBeUndefined();
  });
});

describe("showcaseAdapter.extract — blank integration", () => {
  it("throws loud when manifest.integration is empty/blank (structural canonical-key component)", async () => {
    // `integration` becomes the fragment's subsystem — a STRUCTURAL
    // canonical-key component. A blank value would yield a degenerate key far
    // downstream; fail loud at intake instead (mirrors the notion adapter's
    // unit.subsystem guard).
    const unit = loadUnit();
    unit.manifest.integration = "   ";
    await expect(showcaseAdapter.extract(unit, ctx)).rejects.toThrow(
      /\[atlas\/adapters\/showcase\].*integration is empty\/blank.*LangGraph \(Python\)/,
    );

    unit.manifest.integration = "";
    await expect(showcaseAdapter.extract(unit, ctx)).rejects.toThrow(
      /integration is empty\/blank/,
    );
  });
});

describe("showcaseAdapter.extract — padded integration is used TRIMMED everywhere", () => {
  it("emits the trimmed integration in subsystem, claimSlugHint, and source_name", async () => {
    // The blank guard trim-CHECKS the integration; the kept value must be the
    // TRIMMED slug too — `subsystem` and `claimSlugHint` are STRUCTURAL
    // canonical-key components, so a padded " langgraph-python " would land
    // padding in the canonical key (and in the source_name path).
    const unit = loadUnit();
    unit.manifest.integration = "  langgraph-python  ";
    const [fragment] = await showcaseAdapter.extract(unit, ctx);

    expect(fragment.subsystem).toBe("langgraph-python");
    expect(fragment.claimSlugHint).toBe("langgraph-python-feature-support");
    expect(fragment.source_name).toBe(
      "showcase/langgraph-python/manifest.yaml",
    );
  });

  it("falls back to the TRIMMED integration for the title/body name when the manifest has no name", async () => {
    const unit = loadUnit();
    unit.manifest.integration = "  langgraph-python  ";
    delete unit.manifest.name;
    const [fragment] = await showcaseAdapter.extract(unit, ctx);

    expect(fragment.title).toBe(
      "langgraph-python declares 5 showcase feature(s)",
    );
    expect(fragment.content.split("\n")[0]).toBe(
      "langgraph-python integration feature support:",
    );
  });

  it("trims a padded manifest name (and falls back to the integration when the name is blank)", async () => {
    const unit = loadUnit();
    unit.manifest.name = "  LangGraph (Python)  ";
    const [fragment] = await showcaseAdapter.extract(unit, ctx);
    expect(fragment.title).toBe(
      "LangGraph (Python) declares 5 showcase feature(s)",
    );

    const blankNameUnit = loadUnit();
    blankNameUnit.manifest.name = "   ";
    const [blankNameFragment] = await showcaseAdapter.extract(
      blankNameUnit,
      ctx,
    );
    expect(blankNameFragment.title).toBe(
      "langgraph-python declares 5 showcase feature(s)",
    );
  });
});

describe("showcaseAdapter.extract — empty manifest", () => {
  it("returns [] for a manifest with no declared features (no content-free fragment)", async () => {
    const manifest: ShowcaseManifest = {
      integration: "empty-integration",
      name: "Empty Integration",
      features: [],
    };
    const unit: ShowcaseUnit = { manifest, registry: loadRegistry() };
    const fragments = await showcaseAdapter.extract(unit, ctx);
    expect(fragments).toEqual([]);
  });
});
