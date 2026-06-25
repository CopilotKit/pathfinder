// atlas harvest write-fragment --stdin CLI integration tests (spec §4.2.1, T8a-e + T11).
//
// Invokes the BUILT CLI as a subprocess via `node dist/atlas-cli.js harvest
// write-fragment ...`, feeds it stdin, and asserts the exit-code matrix
// 0/1/2/3/4 plus side effects:
//   T8a — exit 0 with explicit --stem: file lands at the expected path.
//   T8b — exit 0 with derived stem (no --stem): file lands at the
//         canonical-key-derived stem path.
//   T8c — exit 1 on bad stdin JSON: stderr names the JSON parse failure.
//   T8d — exit 3 on base-schema failure (missing required field).
//   T8e — exit 4 on episodic invariant failure (needsReview=false).
//   T11 — exit 2 on stem collision (second write to the same stem).
//
// Each test runs inside its own tempdir so concurrent test execution does not
// cross-pollute fragments. The dist build is assumed already done by
// `npm run build` (test suite's standard prerequisite); a fast guard at the top
// fails loud if dist/atlas-cli.js is missing rather than running tests against
// a stale or absent build artifact.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { claimSlug } from "../atlas/canonicalize.js";
import { isEpisodicInvariantIssue } from "../atlas/harvest-cli.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CLI_PATH = path.join(REPO_ROOT, "dist", "atlas-cli.js");

// A baseline CandidateFragment that passes CandidateFragmentSchema. Tests
// shallow-clone + mutate to produce schema-failing / episodic-failing inputs.
function baseFragment(overrides: Record<string, unknown> = {}): unknown {
  return {
    sourcetype: "github-pr",
    subsystem: "cpk-runtime",
    claimSlugHint: "explicit-hint-wins",
    source_name: "github-pr",
    repo_url: "https://github.com/CopilotKit/CopilotKit",
    ref: "main",
    title: "Some distilled claim about the runtime",
    content: "why/how prose",
    provenance: {
      source: "github-pr",
      date: "2026-06-08",
      classification: {
        sensitivity: "internal",
        knowledge_type: "architecture",
        audience: "all-staff",
        validation_status: "source-verified",
        confidence: "high",
        provenance_class: "primary",
        freshness: { as_of: "2026-06-08" },
      },
    },
    evidence: [],
    needsReview: false,
    validationTargets: [],
    ...overrides,
  };
}

// Run the CLI with the provided stdin and argv tail. Returns the raw spawn
// result so each test can assert exit code + stderr/stdout shape.
function runCli(args: string[], stdin: string) {
  return spawnSync("node", [CLI_PATH, "harvest", "write-fragment", ...args], {
    input: stdin,
    encoding: "utf-8",
  });
}

describe("atlas harvest write-fragment --stdin CLI (spec §4.2 / T8 + T11)", () => {
  let runsDir: string;
  const runId = "test-run";

  beforeAll(() => {
    // Fail loud if the dist build is missing — running these tests against an
    // absent build artifact would be a silent green-on-nothing pass.
    if (!fs.existsSync(CLI_PATH)) {
      throw new Error(
        `dist build is missing (${CLI_PATH}); run \`npm run build\` first`,
      );
    }
  });

  beforeEach(() => {
    runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-wf-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(runsDir, { recursive: true, force: true });
    } catch {
      // Tempdir cleanup is best-effort; OS tempdir reaper handles leftovers.
    }
  });

  // T8a — explicit --stem, valid input → exit 0, file present at expected path.
  it("T8a: exits 0 and writes the fragment when --stem is explicit", () => {
    const stem = "explicit-stem";
    const result = runCli(
      ["--run-id", runId, "--runs-dir", runsDir, "--stem", stem],
      JSON.stringify(baseFragment()),
    );
    expect(result.status).toBe(0);
    const expected = path.join(runsDir, runId, "fragments", `${stem}.json`);
    expect(fs.existsSync(expected)).toBe(true);
    // stdout reports the absolute path the file was written to.
    expect(result.stdout.trim()).toBe(path.resolve(expected));
    const written = JSON.parse(fs.readFileSync(expected, "utf-8"));
    expect(written.sourcetype).toBe("github-pr");
    expect(written.subsystem).toBe("cpk-runtime");
  });

  // T8b — no --stem, valid input → exit 0, file present at claimSlug-derived path.
  it("T8b: exits 0 and derives the stem from canonical-key components when --stem is omitted", () => {
    const result = runCli(
      ["--run-id", runId, "--runs-dir", runsDir],
      JSON.stringify(baseFragment()),
    );
    expect(result.status).toBe(0);
    // The derived stem is claimSlug("<sourcetype>:<subsystem>:<claim-slug>"), where
    // the inner claim-slug comes from claimSlugHint (preferred) or title.
    const inner = claimSlug("explicit-hint-wins");
    const expectedStem = claimSlug(`github-pr:cpk-runtime:${inner}`);
    const expected = path.join(
      runsDir,
      runId,
      "fragments",
      `${expectedStem}.json`,
    );
    expect(fs.existsSync(expected)).toBe(true);
    expect(result.stdout.trim()).toBe(path.resolve(expected));
  });

  // T8c — non-JSON stdin → exit 1, stderr mentions JSON.
  it("T8c: exits 1 on un-parseable stdin", () => {
    const result = runCli(
      ["--run-id", runId, "--runs-dir", runsDir, "--stem", "bad-json"],
      "not-json{",
    );
    expect(result.status).toBe(1);
    expect(result.stderr.toLowerCase()).toMatch(/json/);
    // The fragments dir for this run should not have been created on a bail
    // BEFORE the schema step.
    const fragsDir = path.join(runsDir, runId, "fragments");
    expect(fs.existsSync(fragsDir)).toBe(false);
  });

  // T8d — valid JSON, missing required field (no `content`) → exit 3.
  it("T8d: exits 3 when the input fails CandidateFragmentSchema", () => {
    const bad = baseFragment();
    delete (bad as { content?: unknown }).content;
    const result = runCli(
      ["--run-id", runId, "--runs-dir", runsDir, "--stem", "schema-bad"],
      JSON.stringify(bad),
    );
    expect(result.status).toBe(3);
    expect(result.stderr.toLowerCase()).toMatch(/schema|content/);
    const expected = path.join(runsDir, runId, "fragments", "schema-bad.json");
    expect(fs.existsSync(expected)).toBe(false);
  });

  // T8e — episodic input with needsReview=false → exit 4 (episodic invariant).
  it("T8e: exits 4 on an episodic invariant violation (needsReview=false)", () => {
    // An episodic fragment that satisfies the BASE schema but violates the
    // episodic refinements: needsReview must be true, provenance_class must be
    // "derived", confidence must be "low", validation_status must be
    // "unverified". We flip needsReview only — the rest are episodic-shaped
    // already — so the first failing invariant is needsReview.
    const episodic = baseFragment({
      sourcetype: "episodic",
      needsReview: false, // ← the failing invariant
      provenance: {
        source: "episodic",
        date: "2026-06-08",
        classification: {
          sensitivity: "internal",
          knowledge_type: "architecture",
          audience: "all-staff",
          validation_status: "unverified",
          confidence: "low",
          provenance_class: "derived",
          freshness: { as_of: "2026-06-08" },
        },
      },
    });
    const result = runCli(
      ["--run-id", runId, "--runs-dir", runsDir, "--stem", "episodic-bad"],
      JSON.stringify(episodic),
    );
    expect(result.status).toBe(4);
    expect(result.stderr.toLowerCase()).toMatch(/needsreview|episodic/);
    const expected = path.join(
      runsDir,
      runId,
      "fragments",
      "episodic-bad.json",
    );
    expect(fs.existsSync(expected)).toBe(false);
  });

  // T11 — second write to same stem → exit 2 with EEXIST-style error.
  it("T11: exits 2 on stem collision (second write to the same stem)", () => {
    const args = [
      "--run-id",
      runId,
      "--runs-dir",
      runsDir,
      "--stem",
      "collide-me",
    ];
    const first = runCli(args, JSON.stringify(baseFragment()));
    expect(first.status).toBe(0);
    const second = runCli(args, JSON.stringify(baseFragment()));
    expect(second.status).toBe(2);
    // Tighten beyond `/already exists/i`: kernel mkdir-EEXIST text ALSO contains
    // "file already exists", so a regression that re-collapses the mkdir+write
    // try-blocks would silently pass with the loose regex. Pin to OUR exit-2
    // wording — `${stem}.json already exists at ${filePath}` — which the kernel
    // EEXIST string does NOT emit.
    expect(second.stderr).toMatch(/\.json already exists at /);
  });

  // T-1 boundary tests: episodic + base-schema (invalid_type / invalid_enum_value)
  // failures must route to exit 3, not exit 4. The exit-4 lane is reserved for
  // refinement (code: "custom") issues from EpisodicCandidateFragmentSchema's
  // `.refine(...)` calls. A wrong-typed `needsReview` (string instead of bool)
  // surfaces as `invalid_type` from the BASE schema and is a schema-validation
  // failure, NOT an episodic invariant violation.

  // Build an episodic fragment that satisfies the four refinements (so the only
  // failure surfaced is the caller-injected base-schema breakage).
  function baseEpisodicFragment(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      sourcetype: "episodic",
      subsystem: "cpk-runtime",
      claimSlugHint: "episodic-claim",
      source_name: "episodic",
      repo_url: "https://github.com/CopilotKit/CopilotKit",
      ref: "main",
      title: "An episodic observation",
      content: "why/how prose",
      provenance: {
        source: "episodic",
        date: "2026-06-08",
        classification: {
          sensitivity: "internal",
          knowledge_type: "architecture",
          audience: "all-staff",
          validation_status: "unverified",
          confidence: "low",
          provenance_class: "derived",
          freshness: { as_of: "2026-06-08" },
        },
      },
      evidence: [],
      needsReview: true,
      validationTargets: [],
      ...overrides,
    };
  }

  // T-1.a — episodic + needsReview as a string → invalid_type → exit 3 (NOT 4).
  it("T-1.a: exits 3 when episodic needsReview is a string (base-schema invalid_type)", () => {
    const bad = baseEpisodicFragment({ needsReview: "true" });
    const result = runCli(
      ["--run-id", runId, "--runs-dir", runsDir, "--stem", "t1a"],
      JSON.stringify(bad),
    );
    expect(result.status).toBe(3);
    expect(result.stderr.toLowerCase()).toMatch(/schema/);
  });

  // T-1.b — episodic + confidence as a number → invalid_type → exit 3 (NOT 4).
  it("T-1.b: exits 3 when episodic confidence is a number (base-schema invalid_type)", () => {
    const bad = baseEpisodicFragment();
    (
      bad.provenance as { classification: Record<string, unknown> }
    ).classification.confidence = 5;
    const result = runCli(
      ["--run-id", runId, "--runs-dir", runsDir, "--stem", "t1b"],
      JSON.stringify(bad),
    );
    expect(result.status).toBe(3);
    expect(result.stderr.toLowerCase()).toMatch(/schema/);
  });

  // T-1.c — episodic + confidence as a non-enum string → invalid_enum_value → exit 3.
  it("T-1.c: exits 3 when episodic confidence is a non-enum string (base-schema invalid_enum_value)", () => {
    const bad = baseEpisodicFragment();
    (
      bad.provenance as { classification: Record<string, unknown> }
    ).classification.confidence = "made-up";
    const result = runCli(
      ["--run-id", runId, "--runs-dir", runsDir, "--stem", "t1c"],
      JSON.stringify(bad),
    );
    expect(result.status).toBe(3);
    expect(result.stderr.toLowerCase()).toMatch(/schema/);
  });

  // T-1.d (positive) — episodic fragments that satisfy the base schema but
  // fail exactly ONE of the four `.refine(...)` invariants must each route to
  // exit 4 with stderr naming the offending field. Parametrized over all four
  // invariants — needsReview, provenance_class, confidence, validation_status
  // — so a future regression that shrinks EPISODIC_INVARIANT_FIELDS (e.g. back
  // to needsReview-only) is caught. Each case mutates `baseEpisodicFragment()`
  // (which satisfies all four refinements) along exactly ONE axis.
  it.each([
    {
      field: "needsReview",
      stem: "t1d-needsreview",
      mutate: (frag: Record<string, unknown>) => {
        frag.needsReview = false;
      },
    },
    {
      field: "provenance_class",
      stem: "t1d-provclass",
      mutate: (frag: Record<string, unknown>) => {
        (
          frag.provenance as { classification: Record<string, unknown> }
        ).classification.provenance_class = "primary";
      },
    },
    {
      field: "confidence",
      stem: "t1d-confidence",
      mutate: (frag: Record<string, unknown>) => {
        (
          frag.provenance as { classification: Record<string, unknown> }
        ).classification.confidence = "high";
      },
    },
    {
      field: "validation_status",
      stem: "t1d-valstatus",
      mutate: (frag: Record<string, unknown>) => {
        (
          frag.provenance as { classification: Record<string, unknown> }
        ).classification.validation_status = "source-verified";
      },
    },
  ])(
    "T-1.d: exits 4 when episodic violates the $field invariant (refinement custom-issue)",
    ({ field, stem, mutate }) => {
      const bad = baseEpisodicFragment();
      mutate(bad);
      const result = runCli(
        ["--run-id", runId, "--runs-dir", runsDir, "--stem", stem],
        JSON.stringify(bad),
      );
      expect(result.status).toBe(4);
      // stderr must name the offending field — the ZodError's issue path
      // includes the field name verbatim. Asserts that the gate genuinely
      // covers THIS invariant (not just that exit 4 fired for some reason).
      expect(result.stderr).toContain(field);
      // Sanity: the "episodic invariant violation" label is always present.
      expect(result.stderr.toLowerCase()).toContain("episodic invariant");
    },
  );

  // M-2 — AND-case routing: a fragment that fails BOTH a base-schema
  // constraint (confidence as number → invalid_type) AND an episodic
  // refinement (needsReview=false → custom) must route to exit 3. Per
  // spec §4.2.1, a base-schema failure means the fragment isn't valid
  // CandidateFragment shape at all — the refinement verdict is moot, so
  // exit 3 (base-schema) wins over exit 4 (refinement) in the AND case.
  it("M-2: exits 3 when episodic input fails BOTH base-schema (confidence=number) AND a refinement (needsReview=false)", () => {
    const bad = baseEpisodicFragment({ needsReview: false });
    (
      bad.provenance as { classification: Record<string, unknown> }
    ).classification.confidence = 5;
    const result = runCli(
      ["--run-id", runId, "--runs-dir", runsDir, "--stem", "m2"],
      JSON.stringify(bad),
    );
    expect(result.status).toBe(3);
    expect(result.stderr.toLowerCase()).toMatch(/expected|invalid|schema/);
  });

  // M-4 — `--stdin` is accepted as a no-op flag for spec-literal
  // invocation compatibility. The literal invocation in §4.2.1 reads
  // `atlas harvest write-fragment --run-id <id> --fragment-id <stem>
  // --stdin`, so the CLI must accept `--stdin` without erroring. stdin
  // is always read regardless of the flag.
  it("M-4: exits 0 when --stdin is passed as a no-op flag (spec-literal invocation)", () => {
    const result = runCli(
      [
        "--run-id",
        runId,
        "--runs-dir",
        runsDir,
        "--stem",
        "m4-stdin",
        "--stdin",
      ],
      JSON.stringify(baseFragment()),
    );
    expect(result.status).toBe(0);
    const expected = path.join(runsDir, runId, "fragments", "m4-stdin.json");
    expect(fs.existsSync(expected)).toBe(true);
  });

  // T-5 — mkdir failure vs write EEXIST must be disambiguated. If the
  // `<runs-dir>/<run-id>/fragments` PATH already exists as a regular file,
  // mkdirSync({recursive:true}) raises EEXIST. That is NOT a stem collision;
  // it is an operator-environment problem (exit 1). Only an EEXIST from the
  // write step (file at the resolved stem path exists) is a stem collision.
  it("T-5: exits 1 when the fragments dir path is occupied by a regular file (mkdir-class failure, NOT exit 2)", () => {
    // Pre-create `<runsDir>/<runId>/fragments` as a file so mkdirSync trips
    // EEXIST against a non-dir.
    const runDir = path.join(runsDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "fragments"), "occupied\n");

    const result = runCli(
      ["--run-id", runId, "--runs-dir", runsDir, "--stem", "t5"],
      JSON.stringify(baseFragment()),
    );
    expect(result.status).toBe(1);
    // Error is named as a mkdir-class failure (not a write-class one) and
    // identifies the fragments directory path. The exit-2 message format is
    // `${stem}.json already exists at ${filePath}` — assert that the stem
    // wording is absent so a regression that re-collapses the two try-blocks
    // (mis-routing mkdir-EEXIST as a stem collision) is caught.
    expect(result.stderr.toLowerCase()).toMatch(/mkdir/);
    expect(result.stderr.toLowerCase()).toMatch(/fragments/);
    expect(result.stderr).not.toMatch(/\.json already exists at /);
  });

  // T-R4-4 — `--stem` value is interpolated into a filesystem path. Without a
  // filesystem-safe regex gate, `--stem ../../evil` yields a write OUTSIDE the
  // fragments directory. Per spec §4.2.1 exit-code matrix, this is the
  // operator/input class — exit 1 with stem-validation error wording, BEFORE
  // the mkdir/write attempt.
  it("T-R4-4: exits 1 when --stem contains path-traversal characters (../, /, leading dot, etc.)", () => {
    // Spec §4.2.1: filesystem-safe stems only. Operator/LLM-generated stems with
    // `../`, `/`, leading-dot, or other path-traversal sequences must be rejected
    // BEFORE the mkdir/write attempt to prevent writes outside <fragmentsDir>.
    const traversalStem = "../../evil";
    const result = runCli(
      ["--run-id", runId, "--runs-dir", runsDir, "--stem", traversalStem],
      JSON.stringify(baseFragment()),
    );
    expect(result.status).toBe(1);
    expect(result.stderr.toLowerCase()).toMatch(/stem|invalid|traversal/);
    // The error message should name the stem-validation failure, not a mkdir/write error.
    expect(result.stderr).not.toMatch(/mkdir/);
    expect(result.stderr).not.toMatch(/\.json already exists at /);
  });

  it("T-R4-4: accepts a filesystem-safe stem (alphanumeric + . _ -)", () => {
    // Safe stem characters: A-Z a-z 0-9 . _ - (no path separators, no leading dot,
    // no traversal sequences).
    const result = runCli(
      ["--run-id", runId, "--runs-dir", runsDir, "--stem", "valid-stem.123_ok"],
      JSON.stringify(baseFragment()),
    );
    expect(result.status).toBe(0);
  });

  // T-R5-2 — STEM_PATTERN negative-test coverage hardening. T-R4-4 covers ONE
  // axis (leading-dot traversal). A regex weakening that admits `/` mid-string
  // or other path-component shapes would not be caught by T-R4-4 alone. These
  // three tests pin the additional STEM_PATTERN rejection axes so any future
  // edit that broadens the character class produces a visible regression.
  it("T-R5-2: exits 1 when --stem contains a mid-string path separator (foo/bar)", () => {
    // Mid-string `/` is the most dangerous regex-weakening vector: a stem like
    // `foo/bar` would write to `<fragmentsDir>/foo/bar.json` and could be
    // chained with `..` to escape. STEM_PATTERN's `[A-Za-z0-9._-]` body class
    // does NOT include `/`, so this must reject.
    const result = runCli(
      ["--run-id", runId, "--runs-dir", runsDir, "--stem", "foo/bar"],
      JSON.stringify(baseFragment()),
    );
    expect(result.status).toBe(1);
    expect(result.stderr.toLowerCase()).toMatch(/stem|invalid/);
    expect(result.stderr).not.toMatch(/mkdir/);
  });

  it("T-R5-2: exits 1 when --stem has a leading path separator (/absolute/path)", () => {
    // A leading `/` would resolve `path.join(fragmentsDir, "/absolute/path.json")`
    // to an absolute escape. STEM_PATTERN's leading-character anchor requires
    // `[A-Za-z0-9]`, so this must reject.
    const result = runCli(
      ["--run-id", runId, "--runs-dir", runsDir, "--stem", "/absolute/path"],
      JSON.stringify(baseFragment()),
    );
    expect(result.status).toBe(1);
    expect(result.stderr.toLowerCase()).toMatch(/stem|invalid/);
    expect(result.stderr).not.toMatch(/mkdir/);
  });

  it("T-R5-2: exits 1 when --stem has a leading double-dot (..foo)", () => {
    // The leading-character anchor `[A-Za-z0-9]` excludes `.`, so a stem
    // starting with `..` (the classic traversal prefix) is rejected by the
    // leading-anchor — independently of any body-position `..` permissiveness.
    const result = runCli(
      ["--run-id", runId, "--runs-dir", runsDir, "--stem", "..foo"],
      JSON.stringify(baseFragment()),
    );
    expect(result.status).toBe(1);
    expect(result.stderr.toLowerCase()).toMatch(/stem|invalid/);
    expect(result.stderr).not.toMatch(/mkdir/);
  });
});

// Direct unit tests on the `isEpisodicInvariantIssue` predicate. These exist
// because the AND-case precedence rule (any non-custom issue downgrades the
// whole ZodError to exit 3) is not exercisable through the CLI integration
// path: Zod's base-parse short-circuits on `invalid_type` BEFORE refinements
// run, so a real fragment can never produce a mixed-code ZodError via the
// episodic-parse codepath. The predicate, however, is a defensive guard for
// the spec contract (§4.2.1) and any future code that COULD pass a mixed
// ZodError (e.g. a custom parse path that runs base + refinements together).
// Test (c) is the regression-armor for that contract.
describe("isEpisodicInvariantIssue: AND-case precedence direct unit tests", () => {
  it("returns FALSE for a pure base-schema failure (invalid_type only)", () => {
    const err = new z.ZodError([
      {
        code: z.ZodIssueCode.invalid_type,
        expected: "boolean",
        received: "string",
        path: ["needsReview"],
        message: "Expected boolean, received string",
      },
    ]);
    expect(isEpisodicInvariantIssue(err)).toBe(false);
  });

  it("returns TRUE for a pure refinement failure (custom only, path matches EPISODIC_INVARIANT_FIELDS)", () => {
    const err = new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ["needsReview"],
        message: "needsReview must be true when validation_status is pending",
      },
    ]);
    expect(isEpisodicInvariantIssue(err)).toBe(true);
  });

  it("returns FALSE for a mixed-code ZodError (custom + invalid_type) — base-schema wins per §4.2.1 precedence", () => {
    const err = new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ["needsReview"],
        message: "needsReview must be true when validation_status is pending",
      },
      {
        code: z.ZodIssueCode.invalid_type,
        expected: "number",
        received: "string",
        path: ["confidence"],
        message: "Expected number, received string",
      },
    ]);
    expect(isEpisodicInvariantIssue(err)).toBe(false);
  });

  it("returns FALSE for a custom issue whose path-last is NOT in EPISODIC_INVARIANT_FIELDS", () => {
    const err = new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ["title"],
        message: "title must not contain a subsystem delimiter",
      },
    ]);
    expect(isEpisodicInvariantIssue(err)).toBe(false);
  });

  // Positive per-invariant coverage. The existing (b) case above pins
  // needsReview; the next three pin the remaining three EPISODIC_INVARIANT_FIELDS
  // (provenance_class, confidence, validation_status). Path shapes mirror the
  // refines on EpisodicCandidateFragmentSchema in src/atlas/types.ts — the three
  // classification-nested refines emit FULL nested paths
  // (["provenance","classification",<field>]), while needsReview uses the
  // single-element path. The predicate matches on path[path.length-1], so the
  // leaf form would also suffice; using the actual refine path-shape keeps
  // these tests faithful to what production ZodErrors look like.
  it("returns TRUE for a pure custom failure on provenance_class invariant (nested path)", () => {
    const err = new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ["provenance", "classification", "provenance_class"],
        message: "episodic requires provenance_class=derived",
      },
    ]);
    expect(isEpisodicInvariantIssue(err)).toBe(true);
  });

  it("returns TRUE for a pure custom failure on confidence invariant (nested path)", () => {
    const err = new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ["provenance", "classification", "confidence"],
        message: "episodic requires confidence=low (clamped)",
      },
    ]);
    expect(isEpisodicInvariantIssue(err)).toBe(true);
  });

  it("returns TRUE for a pure custom failure on validation_status invariant (nested path)", () => {
    const err = new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ["provenance", "classification", "validation_status"],
        message: "episodic requires validation_status=unverified",
      },
    ]);
    expect(isEpisodicInvariantIssue(err)).toBe(true);
  });

  // Defensive edge case: an empty-issues ZodError. The predicate's
  // `issues.length === 0` early-return must hold — an empty ZodError carries
  // no invariant signal and must NOT route to exit 4. Routes to exit 3 (base
  // lane) by default per §4.2.1.
  it("returns FALSE for an empty-issues ZodError (defensive edge case)", () => {
    const err = new z.ZodError([]);
    expect(isEpisodicInvariantIssue(err)).toBe(false);
  });
});
