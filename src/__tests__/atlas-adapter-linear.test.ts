import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { linearAdapter } from "../atlas/adapters/linear.js";
import type { LinearDocUnit } from "../atlas/adapters/linear.js";
import { CandidateFragmentSchema } from "../atlas/types.js";
import type { AdapterContext } from "../atlas/adapters/types.js";

// Fixtures live OUTSIDE src/ (tsconfig rootDir is src), so resolve from the repo
// root relative to this test file.
const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "atlas",
  "linear",
);

function loadUnit(name: string): LinearDocUnit {
  return JSON.parse(
    readFileSync(join(FIXTURE_DIR, name), "utf8"),
  ) as LinearDocUnit;
}

// Deterministic clock — provenance dates / freshness.as_of derive from ctx.now,
// never `new Date()` inline (adapter-contract guarantee).
const ctx: AdapterContext = { now: new Date("2026-06-08T00:00:00.000Z") };

describe("linearAdapter", () => {
  it("declares the linear-doc sourcetype", () => {
    expect(linearAdapter.sourcetype).toBe("linear-doc");
  });

  describe("design-doc unit (ownership/boundary rationale)", () => {
    it("produces exactly one fragment carrying the ownership rationale", async () => {
      const unit = loadUnit("design-doc-runtime-ownership.json");
      const frags = await linearAdapter.extract(unit, ctx);

      expect(frags).toHaveLength(1);
      const frag = frags[0];

      // Every fragment must be schema-valid (byte-compatible with storage).
      expect(() => CandidateFragmentSchema.parse(frag)).not.toThrow();

      expect(frag.sourcetype).toBe("linear-doc");
      // subsystem comes from the doc's area/subsystem.
      expect(frag.subsystem).toBe("cpk-runtime");
      // The distilled claim is the doc title (NOT a raw dump).
      expect(frag.title).toBe(unit.title);
      // why/how content is distilled from Problem + Why + Non-Goals.
      expect(frag.content).toContain("Problem");
      expect(frag.content).toContain(unit.problem);
      expect(frag.content).toContain(unit.why);
      // Non-goals carry the boundary rationale.
      expect(frag.content).toContain("Non-Goals");
      expect(frag.content).toContain(unit.nonGoals![0]);
    });

    it("sets provenance.url to the Linear URL and source to linear", async () => {
      const unit = loadUnit("design-doc-runtime-ownership.json");
      const [frag] = await linearAdapter.extract(unit, ctx);

      expect(frag.provenance.source).toBe("linear-doc");
      expect(frag.provenance.url).toBe(unit.url);
      // The doc's own updatedAt is the most accurate provenance date and wins
      // over the harvest clock; freshness.as_of tracks it.
      expect(frag.provenance.date).toBe(unit.updatedAt);
      expect(frag.provenance.classification.freshness.as_of).toBe(
        unit.updatedAt,
      );
    });

    it("falls back to ctx.now for the date when the doc carries no updatedAt", async () => {
      const unit = loadUnit("design-doc-runtime-ownership.json");
      // Strip the doc-supplied date → deterministic ctx.now fallback.
      const { updatedAt: _omit, ...withoutDate } = unit;
      const [frag] = await linearAdapter.extract(withoutDate, ctx);

      expect(frag.provenance.date).toBe("2026-06-08");
      expect(frag.provenance.classification.freshness.as_of).toBe("2026-06-08");
    });

    it("classifies a doc with an explicit ownership knowledge_type", async () => {
      const unit = loadUnit("design-doc-runtime-ownership.json");
      const [frag] = await linearAdapter.extract(unit, ctx);

      const c = frag.provenance.classification;
      expect(c.knowledge_type).toBe("ownership");
      // Linear company docs are internal by default (never public).
      expect(c.sensitivity).toBe("internal");
      // A first-pass adapter never claims verification.
      expect(c.validation_status).toBe("unverified");
      expect(c.provenance_class).toBe("primary");
    });

    it("maps cited source files to changed_file evidence", async () => {
      const unit = loadUnit("design-doc-runtime-ownership.json");
      const [frag] = await linearAdapter.extract(unit, ctx);

      const citedPaths = frag.evidence
        .filter((e) => e.kind === "changed_file")
        .map((e) => (e as { kind: "changed_file"; path: string }).path);

      // Literal expected arrays (NOT `unit.citedFiles`): the adapter passes the
      // caller's array through, so comparing against the unit's own reference
      // would be vacuous — it could never catch aliasing or mutation bugs.
      const expectedFiles = [
        "packages/runtime/src/v2/runtime/core/runtime.ts:348",
        "packages/runtime/src/v2/runtime/engines/sse-runtime.ts",
        "packages/runtime/src/v2/runtime/engines/intelligence-runtime.ts",
      ];
      expect(citedPaths).toEqual(expectedFiles);
      // Cited files also become validation targets for the validate stage.
      expect(frag.validationTargets).toEqual(expectedFiles);
      // The fragment must carry a COPY, never the caller's array by reference.
      expect(frag.validationTargets).not.toBe(unit.citedFiles);
    });

    it("trims cited files, drops blank entries, and never writes through to the caller's unit", async () => {
      const unit: LinearDocUnit = {
        url: "https://linear.app/copilotkit/document/cited-files-hygiene-1",
        title: "Cited-files hygiene doc",
        problem: "p",
        why: "w",
        subsystem: "cpk-runtime",
        citedFiles: ["  src/a.ts  ", "", "   ", "src/b.ts"],
      };
      const [frag] = await linearAdapter.extract(unit, ctx);

      expect(frag.validationTargets).toEqual(["src/a.ts", "src/b.ts"]);
      const citedPaths = frag.evidence
        .filter((e) => e.kind === "changed_file")
        .map((e) => (e as { kind: "changed_file"; path: string }).path);
      expect(citedPaths).toEqual(["src/a.ts", "src/b.ts"]);

      // Write-through probe on an ALREADY-CLEAN unit: with the trimming
      // fixture above, the cleaned list can never alias `unit.citedFiles`
      // (the lengths differ), so a push-then-compare there could never fail.
      // A clean fixture is where a regression to pass-through/aliasing
      // (`validationTargets: unit.citedFiles`) is actually observable.
      const cleanUnit: LinearDocUnit = {
        url: "https://linear.app/copilotkit/document/cited-files-hygiene-2",
        title: "Cited-files hygiene doc (clean)",
        problem: "p",
        why: "w",
        subsystem: "cpk-runtime",
        citedFiles: ["src/a.ts", "src/b.ts"],
      };
      const [cleanFrag] = await linearAdapter.extract(cleanUnit, ctx);
      expect(cleanFrag.validationTargets).not.toBe(cleanUnit.citedFiles);
      // Mutating the fragment's targets must not mutate the caller's unit.
      cleanFrag.validationTargets.push("mutated.ts");
      expect(cleanUnit.citedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    });

    it("emits a Notion dedup-hint in evidence AND provenance so later dedup can collapse the cross-link", async () => {
      const unit = loadUnit("design-doc-runtime-ownership.json");
      const [frag] = await linearAdapter.extract(unit, ctx);

      // provenance carries the cross-linked Notion URL so the Tier-2/Tier-3
      // dedup can collapse the Linear doc against its Notion twin.
      expect(frag.provenance.validated_against).toContain(unit.notionCrossLink);

      // A thread evidence entry names the cross-link explicitly (human-readable
      // dedup hint surfaced in the approval artifact).
      const hint = frag.evidence.find(
        (e) =>
          e.kind === "thread" && /notion/i.test((e as { body: string }).body),
      );
      expect(hint).toBeDefined();
      expect((hint as { kind: "thread"; body: string }).body).toContain(
        unit.notionCrossLink!,
      );
    });
  });

  describe("minimal project unit (only problem + why)", () => {
    it("produces a fragment without non-goals, cited files, or a Notion hint", async () => {
      const unit = loadUnit("project-minimal.json");
      const frags = await linearAdapter.extract(unit, ctx);

      expect(frags).toHaveLength(1);
      const frag = frags[0];
      expect(() => CandidateFragmentSchema.parse(frag)).not.toThrow();

      expect(frag.content).toContain(unit.problem);
      expect(frag.content).toContain(unit.why);
      // No non-goals section when the unit has none.
      expect(frag.content).not.toContain("Non-Goals");
      // No cited files → no changed_file evidence and no validation targets.
      expect(
        frag.evidence.filter((e) => e.kind === "changed_file"),
      ).toHaveLength(0);
      expect(frag.validationTargets).toEqual([]);
      // No cross-link → no Notion dedup hint, validated_against absent.
      expect(
        frag.evidence.some(
          (e) =>
            e.kind === "thread" && /notion/i.test((e as { body: string }).body),
        ),
      ).toBe(false);
      expect(frag.provenance.validated_against).toBeUndefined();
    });

    it("falls back to a default subsystem when the unit names none", async () => {
      const unit = loadUnit("project-minimal.json");
      const [frag] = await linearAdapter.extract(unit, ctx);
      // Neither subsystem nor area set → conservative default, never empty.
      expect(frag.subsystem.length).toBeGreaterThan(0);
      expect(frag.subsystem).toBe("uncategorized");
    });

    it("defaults knowledge_type to design-rationale for an untyped design doc", async () => {
      const unit = loadUnit("project-minimal.json");
      const [frag] = await linearAdapter.extract(unit, ctx);
      expect(frag.provenance.classification.knowledge_type).toBe(
        "design-rationale",
      );
    });
  });

  it("falls back to a non-empty title naming the doc URL when the title is blank", async () => {
    const unit: LinearDocUnit = {
      url: "https://linear.app/copilotkit/document/blank-title-1",
      title: "   ",
      problem: "p",
      why: "w",
      subsystem: "cpk-runtime",
    };
    const [frag] = await linearAdapter.extract(unit, ctx);
    // A blank title would yield a degenerate canonical key (empty claim slug);
    // fall back to something non-empty that still identifies the doc.
    expect(frag.title.trim().length).toBeGreaterThan(0);
    expect(frag.title).toContain(unit.url);
  });

  it("trims a padded title before using it", async () => {
    const unit: LinearDocUnit = {
      url: "https://linear.app/copilotkit/document/padded-title-1",
      title: "  Padded title doc  ",
      problem: "p",
      why: "w",
      subsystem: "cpk-runtime",
    };
    const [frag] = await linearAdapter.extract(unit, ctx);
    expect(frag.title).toBe("Padded title doc");
  });

  it("rejects a whitespace-only subsystem (falls back rather than emit a degenerate key)", async () => {
    const unit: LinearDocUnit = {
      url: "https://linear.app/copilotkit/document/ws-subsystem-1",
      title: "Whitespace-subsystem doc",
      problem: "p",
      why: "w",
      // Whitespace-only subsystem must NOT be admitted (would yield the
      // degenerate canonical key `linear-doc:   :slug`).
      subsystem: "   ",
    };
    const [frag] = await linearAdapter.extract(unit, ctx);
    expect(frag.subsystem).toBe("uncategorized");
  });

  it("trims a padded subsystem before using it", async () => {
    const unit: LinearDocUnit = {
      url: "https://linear.app/copilotkit/document/padded-subsystem-1",
      title: "Padded-subsystem doc",
      problem: "p",
      why: "w",
      subsystem: "  cpk-runtime  ",
    };
    const [frag] = await linearAdapter.extract(unit, ctx);
    expect(frag.subsystem).toBe("cpk-runtime");
  });

  it("rejects a whitespace-only area fallback", async () => {
    const unit: LinearDocUnit = {
      url: "https://linear.app/copilotkit/document/ws-area-1",
      title: "Whitespace-area doc",
      problem: "p",
      why: "w",
      area: "   ",
    };
    const [frag] = await linearAdapter.extract(unit, ctx);
    expect(frag.subsystem).toBe("uncategorized");
  });

  it("derives subsystem from the doc area when subsystem is absent", async () => {
    const unit: LinearDocUnit = {
      url: "https://linear.app/copilotkit/document/area-only-1",
      title: "Area-only doc",
      problem: "p",
      why: "w",
      area: "Protocol",
    };
    const [frag] = await linearAdapter.extract(unit, ctx);
    // area slugified into a subsystem.
    expect(frag.subsystem).toBe("protocol");
  });

  describe("content-free unit (no Problem/Why/Non-Goals)", () => {
    it("emits NO fragment when only a title is present", async () => {
      // distillContent yields "" — a fragment here would carry no knowledge,
      // matching the episodic/source-comment/showcase "content-free → []" rule.
      const unit: LinearDocUnit = {
        url: "https://linear.app/copilotkit/document/title-only-1",
        title: "A doc with a title but no decision content",
        subsystem: "cpk-runtime",
      };
      const frags = await linearAdapter.extract(unit, ctx);
      expect(frags).toEqual([]);
    });

    it("emits NO fragment when Problem/Why are whitespace-only and there are no Non-Goals", async () => {
      const unit: LinearDocUnit = {
        url: "https://linear.app/copilotkit/document/whitespace-content-1",
        title: "Whitespace-content doc",
        problem: "   ",
        why: "\n\t ",
        nonGoals: [],
      };
      const frags = await linearAdapter.extract(unit, ctx);
      expect(frags).toEqual([]);
    });
  });

  describe("first-pass sensitivity scan (shared credential/GTM scan)", () => {
    // The adapter must not hardcode sensitivity:"internal" — a raw credential
    // or customer-identifying GTM detail in a Linear doc body would land
    // `internal` and the deterministic DEFAULT_EXCLUSION_RULES layer
    // (sensitivity ≥ proprietary) would never fire. The scan runs over the
    // title + the distilled content (what the fragment actually emits).
    it("escalates a doc tying a named customer to contract value to proprietary", async () => {
      const unit = loadUnit("project-minimal.json");
      unit.problem = "The ACME contract value is at risk ahead of the renewal.";
      const [frag] = await linearAdapter.extract(unit, ctx);
      expect(frag.provenance.classification.sensitivity).toBe("proprietary");
    });

    it("escalates a doc whose problem text mentions credentials to secret", async () => {
      const unit = loadUnit("project-minimal.json");
      unit.problem =
        "Rotate the API keys named in the deploy doc; the old ones leaked.";
      const [frag] = await linearAdapter.extract(unit, ctx);
      expect(frag.provenance.classification.sensitivity).toBe("secret");
    });

    it("treats an op:// 1Password pointer as SAFE (stays internal)", async () => {
      const unit = loadUnit("project-minimal.json");
      unit.why =
        "Read the deploy value from op://DevOps/Linear/api_token at release time.";
      const [frag] = await linearAdapter.extract(unit, ctx);
      expect(frag.provenance.classification.sensitivity).toBe("internal");
    });
  });
});
