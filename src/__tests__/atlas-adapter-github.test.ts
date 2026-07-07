import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  githubAdapter,
  distillBodyToContent,
  type GitHubPrOrIssueUnit,
  type GitHubPullRequestUnit,
} from "../atlas/adapters/github.js";
import {
  CandidateFragmentSchema,
  type CandidateFragment,
} from "../atlas/types.js";
import type { AdapterContext } from "../atlas/adapters/types.js";

// Fixtures live under fixtures/ (outside src/, so they are read via fs rather
// than imported — matching the repo's fixtures/ idiom). Resolved relative to
// this file (not process.cwd()) like the sibling adapter suites, so the suite
// is runnable from any working directory.
const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "atlas",
  "github",
);

function loadFixture(name: string): GitHubPrOrIssueUnit {
  const file = path.join(FIXTURE_DIR, name);
  return JSON.parse(readFileSync(file, "utf8")) as GitHubPrOrIssueUnit;
}

const ctx: AdapterContext = { now: new Date("2026-06-08T00:00:00.000Z") };

// A.3: the WHAT-metadata header the batch adapter lifts off `content` is
// retained as a provenance `thread`-kind evidence entry (the WHAT-header block
// begins with the `# <kind> #N:` title line). Extract that entry's body so the
// relocation can be asserted positively.
function whatHeaderBody(fragment: CandidateFragment): string {
  const entry = fragment.evidence.find(
    (e): e is { kind: "thread"; body: string } =>
      e.kind === "thread" && /^# (?:PR|Issue) #\d+:/.test(e.body),
  );
  if (entry == null) {
    throw new Error("no WHAT-header provenance evidence entry on fragment");
  }
  return entry.body;
}

describe("githubAdapter — batch PR + issue leaf adapter", () => {
  it("declares the github-pr sourcetype", () => {
    expect(githubAdapter.sourcetype).toBe("github-pr");
  });

  describe("pull request unit", () => {
    it("produces exactly one fragment that validates against CandidateFragmentSchema", async () => {
      const unit = loadFixture("pr.json");
      const fragments = await githubAdapter.extract(unit, ctx);
      expect(fragments).toHaveLength(1);
      // The richer batch contract must parse cleanly.
      expect(() => CandidateFragmentSchema.parse(fragments[0])).not.toThrow();
    });

    it("emits a DISTILLED claim title, NOT the raw `PR #N:` title", async () => {
      const unit = loadFixture("pr.json");
      const [fragment] = await githubAdapter.extract(unit, ctx);
      // distilled-claim title: derived from the PR's substance, never the raw
      // `PR #1337: ...` webhook-style prefix.
      expect(fragment.title).not.toMatch(/^PR #/);
      expect(fragment.title.toLowerCase()).toContain("agent bridge");
    });

    it("distills body → why/how content with boilerplate stripped", async () => {
      const unit = loadFixture("pr.json");
      const [fragment] = await githubAdapter.extract(unit, ctx);
      // why/how prose is preserved …
      expect(fragment.content).toContain("centralizes retry + tracing");
      expect(fragment.content).toContain("AgentBridge");
      // … boilerplate sections + HTML comments are stripped.
      expect(fragment.content).not.toContain("Test plan");
      expect(fragment.content).not.toContain("Checklist");
      expect(fragment.content).not.toContain("CONTRIBUTING");
      expect(fragment.content).not.toContain("HTML comment");
      expect(fragment.content).not.toContain("<!--");
    });

    it("builds a kind-discriminated EvidenceItem[] from changed files, linked issues, and review threads", async () => {
      const unit = loadFixture("pr.json");
      const [fragment] = await githubAdapter.extract(unit, ctx);
      const kinds = fragment.evidence.map((e) => e.kind);
      expect(kinds).toContain("changed_file");
      expect(kinds).toContain("linked_issue");
      expect(kinds).toContain("thread");

      const changedFiles = fragment.evidence.filter(
        (e): e is { kind: "changed_file"; path: string } =>
          e.kind === "changed_file",
      );
      expect(changedFiles.map((e) => e.path)).toContain(
        "packages/runtime/src/agent-bridge.ts",
      );

      const linked = fragment.evidence.filter(
        (e): e is { kind: "linked_issue"; url: string } =>
          e.kind === "linked_issue",
      );
      expect(linked.map((e) => e.url)).toContain(
        "https://github.com/CopilotKit/copilotkit/issues/1290",
      );

      const threads = fragment.evidence.filter(
        (e): e is { kind: "thread"; body: string } => e.kind === "thread",
      );
      expect(threads.length).toBeGreaterThan(0);
    });

    it("carries github provenance (source/url/commit) onto the fragment", async () => {
      const unit = loadFixture("pr.json");
      const [fragment] = await githubAdapter.extract(unit, ctx);
      expect(fragment.sourcetype).toBe("github-pr");
      expect(fragment.source_name).toBe("atlas");
      expect(fragment.repo_url).toBe(
        "https://github.com/CopilotKit/copilotkit.git",
      );
      expect(fragment.provenance.source).toBe("github");
      expect(fragment.provenance.url).toBe(
        "https://github.com/CopilotKit/copilotkit/pull/1337",
      );
      expect(fragment.provenance.commit).toBe("feedface1234567890abcdef");
    });

    it("sets the top-level provenance.date equal to the freshness as_of so canonicalize recency/supersession works", async () => {
      const unit = loadFixture("pr.json");
      const [fragment] = await githubAdapter.extract(unit, ctx);
      // canonicalize.ts reads provenance.date (NOT freshness.as_of) for both
      // recency() and supersedes(); without it a github fragment gets the
      // neutral recency and never wins supersession. The two must agree.
      const asOf = fragment.provenance.classification?.freshness?.as_of;
      expect(fragment.provenance.date).toBe("2026-06-08");
      expect(fragment.provenance.date).toBe(asOf);
    });

    it("records the changed files + linked issue as validation targets", async () => {
      const unit = loadFixture("pr.json");
      const [fragment] = await githubAdapter.extract(unit, ctx);
      expect(fragment.validationTargets).toContain(
        "packages/runtime/src/agent-bridge.ts",
      );
    });
  });

  describe("issue unit", () => {
    it("produces one fragment with github-issue sourcetype that validates", async () => {
      const unit = loadFixture("issue.json");
      const fragments = await githubAdapter.extract(unit, ctx);
      expect(fragments).toHaveLength(1);
      const [fragment] = fragments;
      expect(fragment.sourcetype).toBe("github-issue");
      expect(() => CandidateFragmentSchema.parse(fragment)).not.toThrow();
    });

    it("emits a distilled title and why/how content for an issue", async () => {
      const unit = loadFixture("issue.json");
      const [fragment] = await githubAdapter.extract(unit, ctx);
      expect(fragment.title).not.toMatch(/^Issue #/);
      expect(fragment.title.toLowerCase()).toContain("retry");
      expect(fragment.content).toContain("Centralize retry");
      expect(fragment.content).not.toContain("<!--");
    });

    it("links the related PR as linked_issue evidence", async () => {
      const unit = loadFixture("issue.json");
      const [fragment] = await githubAdapter.extract(unit, ctx);
      const linked = fragment.evidence.filter(
        (e): e is { kind: "linked_issue"; url: string } =>
          e.kind === "linked_issue",
      );
      expect(linked.map((e) => e.url)).toContain(
        "https://github.com/CopilotKit/copilotkit/pull/1337",
      );
    });

    it("sets the top-level provenance.date equal to the freshness as_of (issue)", async () => {
      const unit = loadFixture("issue.json");
      const [fragment] = await githubAdapter.extract(unit, ctx);
      const asOf = fragment.provenance.classification?.freshness?.as_of;
      expect(fragment.provenance.date).toBe("2026-06-08");
      expect(fragment.provenance.date).toBe(asOf);
    });

    // ── validationTargets: cited files/paths make an issue source-verifiable ──
    //
    // Unlike a PR (which carries `changedFiles`), an issue has no structured
    // file list — its files are cited in prose. A.4: lift concrete repo-relative
    // paths + bare code/config filenames the issue names (across title +
    // distilled body + comment threads) into `validationTargets` so the
    // validation gate (S14) has something to grep on origin/main → promotable.
    // Target-less issue prose keeps an EMPTY list by design (it then stays
    // unverified and human-gated — same posture as the PR path with no files).
    describe("validationTargets (cited files/paths)", () => {
      // A minimal issue unit whose body cites concrete files.
      function issueUnit(body: string): GitHubPrOrIssueUnit {
        return {
          kind: "issue",
          sourceName: "atlas",
          repo: {
            fullName: "CopilotKit/copilotkit",
            cloneUrl: "https://github.com/CopilotKit/copilotkit.git",
            defaultBranch: "main",
          },
          issue: {
            number: 1290,
            title: "Retry logic is duplicated across provider adapters",
            body,
            htmlUrl: "https://github.com/CopilotKit/copilotkit/issues/1290",
            author: "reporter",
            state: "closed",
          },
        };
      }

      it("lifts a cited repo-relative path into validationTargets", async () => {
        const unit = issueUnit(
          "The retry loop in src/atlas/rag-dedup.ts drifted from the one in " +
            "src/db/atlas.ts and they no longer agree.",
        );
        const [fragment] = await githubAdapter.extract(unit, ctx);
        expect(fragment.validationTargets).toContain("src/atlas/rag-dedup.ts");
        expect(fragment.validationTargets).toContain("src/db/atlas.ts");
      });

      it("lifts a bare code/config filename cited in the body", async () => {
        const unit = issueUnit(
          "The backoff constant lives in vitest.config.ts and needs updating.",
        );
        const [fragment] = await githubAdapter.extract(unit, ctx);
        expect(fragment.validationTargets).toContain("vitest.config.ts");
      });

      it("does NOT return a copy aliased to the unit's changedFiles input array (defensive copy)", async () => {
        // A PR carries a STRUCTURAL source array (`unit.changedFiles`) that the
        // fragment's validationTargets are lifted from — the aliasing risk this
        // test names. (The issue path has no persistent source array; its
        // targets are lifted from prose into a fresh set.) Mirror the showcase
        // suite: assert the returned array is a COPY, then MUTATE it and prove
        // the source array is unchanged — a mere `push()`-doesn't-throw check is
        // vacuously true for any non-frozen array and cannot fail for aliasing.
        const unit = loadFixture("pr.json");
        // pr.json is a PR unit — `changedFiles` is a PR-only field on the union.
        const prUnit = unit as GitHubPullRequestUnit;
        const before = [...(prUnit.changedFiles ?? [])];
        const [fragment] = await githubAdapter.extract(unit, ctx);
        // The fragment must carry a COPY, never the unit's array by reference.
        expect(fragment.validationTargets).not.toBe(prUnit.changedFiles);
        fragment.validationTargets.push("mutated.ts");
        // Mutating the returned array must not corrupt the unit's source array.
        expect(prUnit.changedFiles).toEqual(before);
      });

      it("does NOT capture prose runtime tokens (node.js / next.js) as file targets", async () => {
        // Over-capture guard: ISSUE_FILE_TARGET_RE matched any dotted prose
        // token ending in a known extension, so prose like "node.js"/"next.js"
        // became a bogus file target that could spuriously source-verify.
        const unit = issueUnit(
          "We run on node.js and the frontend uses next.js — nothing else changed.",
        );
        const [fragment] = await githubAdapter.extract(unit, ctx);
        expect(fragment.validationTargets).not.toContain("node.js");
        expect(fragment.validationTargets).not.toContain("next.js");
        expect(fragment.validationTargets).toStrictEqual([]);
      });

      it("STILL captures a genuine cited path amid prose runtime tokens", async () => {
        // The tightening must not drop real citations: a repo-relative path is
        // still lifted even when a prose runtime token sits alongside it.
        const unit = issueUnit(
          "We run on node.js; the drift is in src/atlas/rag-dedup.ts.",
        );
        const [fragment] = await githubAdapter.extract(unit, ctx);
        expect(fragment.validationTargets).toContain("src/atlas/rag-dedup.ts");
        expect(fragment.validationTargets).not.toContain("node.js");
      });

      it("leaves target-less issue prose with an EMPTY validationTargets (stays unverified → human page)", async () => {
        // The stock fixture body is pure why/how prose that names no file.
        const unit = loadFixture("issue.json");
        const [fragment] = await githubAdapter.extract(unit, ctx);
        expect(fragment.validationTargets).toStrictEqual([]);
      });

      it("does NOT lift a bogus symbol target from prose (files-only caller)", async () => {
        // Files-only over-capture guard: github calls the shared lift in
        // FILES-ONLY mode ({ files: true }), so a `word(` fragment in prose
        // must NOT become a symbol target. `undefined ?? true` used to leave
        // the symbol lift on, minting a bogus `logic` target that could
        // spuriously source-verify a fragment.
        const unit = issueUnit(
          "The retry logic (backoff caps at 30s) regressed after the merge.",
        );
        const [fragment] = await githubAdapter.extract(unit, ctx);
        expect(fragment.validationTargets).not.toContain("logic");
        expect(fragment.validationTargets).toStrictEqual([]);
      });

      it("STILL captures a genuine cited path when prose also carries a `word(`", async () => {
        // The files-only tightening must not drop real file citations even
        // when a symbol-shaped `word(` sits alongside in the prose.
        const unit = issueUnit(
          "The retry logic (backoff) drift is in src/atlas/rag-dedup.ts.",
        );
        const [fragment] = await githubAdapter.extract(unit, ctx);
        expect(fragment.validationTargets).toContain("src/atlas/rag-dedup.ts");
        expect(fragment.validationTargets).not.toContain("logic");
      });
    });
  });
});

describe("blank repo.fullName guard (fail-loud intake)", () => {
  // `repo.fullName` is the fragment's `subsystem` — a STRUCTURAL canonical-key
  // component (<sourcetype>:<subsystem>:<claim-slug>). The schema's z.string()
  // admits blanks silently (only the ':' refine fails loud), so a blank value
  // would flow into a degenerate `github-pr::<slug>` key far downstream. The
  // adapter must fail loud at intake instead, like notion/showcase do.
  it("throws loud on an empty fullName for a PR unit", async () => {
    const unit = loadFixture("pr.json");
    unit.repo.fullName = "";
    await expect(githubAdapter.extract(unit, ctx)).rejects.toThrow(
      /\[atlas\/adapters\/github\].*fullName is empty\/blank/,
    );
  });

  it("throws loud on a whitespace-only fullName for an issue unit", async () => {
    const unit = loadFixture("issue.json");
    unit.repo.fullName = "   ";
    await expect(githubAdapter.extract(unit, ctx)).rejects.toThrow(
      /\[atlas\/adapters\/github\].*fullName is empty\/blank/,
    );
  });
});

describe("distillBodyToContent — the NARROW shared helper (B2)", () => {
  it("strips HTML comments and boilerplate sections, keeping why/how prose", () => {
    const body =
      "Real prose here.\n\n## Test plan\n\n- [x] did it\n\n<!-- secret -->\n\n## Checklist\n\n- [ ] changeset";
    const out = distillBodyToContent(body);
    expect(out).toContain("Real prose here.");
    expect(out).not.toContain("Test plan");
    expect(out).not.toContain("Checklist");
    expect(out).not.toContain("<!--");
  });

  it("returns a stable fallback for an empty/missing body", () => {
    expect(distillBodyToContent(null)).toBe("(No body provided.)");
    expect(distillBodyToContent("")).toBe("(No body provided.)");
    expect(distillBodyToContent("   \n  ")).toBe("(No body provided.)");
  });

  it("is a pure function of its input (idempotent, no side effects)", () => {
    const body = "Keep me.\n<!-- drop -->\n## Checklist\n- [ ] x";
    const a = distillBodyToContent(body);
    const b = distillBodyToContent(body);
    expect(a).toBe(b);
  });

  it("drops the CONTRIBUTING acknowledgement checklist line but keeps prose that merely contains the word 'contributing'", () => {
    const body =
      "The slow GC was the largest contributing factor to the OOM.\n" +
      "We made it easier to contribute to the registry.\n" +
      "- [x] I have read the CONTRIBUTING doc";
    const out = distillBodyToContent(body);
    // Substantive prose containing the substring "contribut..." is preserved.
    expect(out).toContain("contributing factor to the OOM");
    expect(out).toContain("easier to contribute to the registry");
    // The acknowledgement checklist line is still dropped.
    expect(out).not.toContain("CONTRIBUTING");
  });

  it("keeps a substantive BULLET that merely contains the word 'contributing' (U1)", () => {
    const body =
      "- The largest contributing factor was the stale cache\n" +
      "- [x] I have read the CONTRIBUTING document\n" +
      "* Read the CONTRIBUTING guidelines before opening this PR — done\n" +
      "- We made contributing to the registry easier";
    const out = distillBodyToContent(body);
    // Substantive bullets survive: a list marker + "contributing" is NOT
    // enough to drop a line — only the acknowledgement shape is.
    expect(out).toContain("largest contributing factor was the stale cache");
    expect(out).toContain("contributing to the registry easier");
    // The template acknowledgement lines (ack phrase + CONTRIBUTING) drop.
    expect(out).not.toContain("I have read the CONTRIBUTING document");
    expect(out).not.toContain("Read the CONTRIBUTING guidelines");
  });

  it("does not treat `#` lines inside code fences as headings (U2)", () => {
    const body =
      "Real prose here.\n" +
      "```bash\n" +
      "# Test plan\n" +
      "echo run-the-suite\n" +
      "```\n" +
      "More prose after the fence.\n" +
      "## Test plan\n" +
      "- [x] actually boilerplate";
    const out = distillBodyToContent(body);
    // The fenced `# Test plan` comment is preserved verbatim — it is shell
    // content, not a markdown heading, so it must not toggle section dropping.
    expect(out).toContain("```bash\n# Test plan\necho run-the-suite\n```");
    expect(out).toContain("More prose after the fence.");
    // The REAL boilerplate heading outside the fence still drops its section.
    expect(out).not.toContain("## Test plan");
    expect(out).not.toContain("actually boilerplate");
  });

  it("does NOT latch the fence state on an unclosed fence inside a DROPPED boilerplate section", () => {
    // The slot3a execution probe: a boilerplate section containing an UNCLOSED
    // fence. If the fence toggle fired while droppingSection, `inFence` would
    // latch true, every later line (including the `## Rationale` heading) would
    // take the in-fence branch, the heading could never re-parse, and the rest
    // of the body would be silently lost. Fences inside a dropped section must
    // drop WITH the section without touching the fence state.
    const body =
      "Real intro prose.\n" +
      "## Test plan\n" +
      "```bash\n" + // unclosed — no terminating fence before the next heading
      "npm test\n" +
      "## Rationale\n" +
      "The bridge owns the retry policy so providers cannot drift.";
    const out = distillBodyToContent(body);
    // The substantive section AFTER the dropped one is preserved.
    expect(out).toContain("## Rationale");
    expect(out).toContain("bridge owns the retry policy");
    expect(out).toContain("Real intro prose.");
    // The boilerplate section (including its unclosed fence content) drops.
    expect(out).not.toContain("npm test");
    expect(out).not.toContain("```bash");
  });

  it("retains trailing real prose after a LAST boilerplate section whose unclosed fence would otherwise swallow it to EOF (S4)", () => {
    // Content-loss bucket (a): the last boilerplate section (`## Test plan`)
    // contains an UNCLOSED fence and is followed by REAL why/how prose with NO
    // subsequent heading. Without the unterminated-fence recovery, the open
    // dropped fence latches `droppingSection` to EOF and every trailing line —
    // real body prose — is silently discarded from the distilled content. The
    // blank-line boundary ends the unterminated fence and exits the drop.
    const body =
      "Intro why prose.\n" +
      "\n" +
      "## Test plan\n" +
      "```bash\n" + // unclosed — no closing fence, no following heading
      "npm test\n" +
      "\n" + // paragraph break → recovery boundary
      "This trailing paragraph is REAL why/how prose that must survive.\n" +
      "It explains the rationale for the change.";
    const out = distillBodyToContent(body);
    // The trailing real prose survives …
    expect(out).toContain(
      "This trailing paragraph is REAL why/how prose that must survive.",
    );
    expect(out).toContain("It explains the rationale for the change.");
    expect(out).toContain("Intro why prose.");
    // … while the boilerplate section's fenced content is still stripped.
    expect(out).not.toContain("npm test");
    expect(out).not.toContain("```bash");
    expect(out).not.toContain("## Test plan");
  });

  it("still drops a whole no-fence boilerplate section that runs to EOF (S4 no-regression)", () => {
    // The recovery is scoped to an OPEN dropped fence only: an ordinary
    // multi-paragraph boilerplate section (no fence) still runs to its next
    // heading / EOF, so a blank line inside it must NOT end the drop.
    const body =
      "Intro why prose.\n\n## Test plan\n\n- [x] ran the suite\n\nStill boilerplate detail.";
    const out = distillBodyToContent(body);
    expect(out).toContain("Intro why prose.");
    expect(out).not.toContain("ran the suite");
    expect(out).not.toContain("Still boilerplate detail.");
    expect(out).not.toContain("## Test plan");
  });

  it("keeps stripping boilerplate after an UNTERMINATED fence opened OUTSIDE a dropped section (F2)", () => {
    // Over-KEEP bucket (a): a fence opens in the REAL content (outside any
    // dropped section) and is never closed before EOF. That latches
    // `inFence = true` all the way to EOF, so the `if (inFence)` branch
    // short-circuits heading parsing and every subsequent line — including a
    // later boilerplate heading that SHOULD be stripped — is silently kept.
    const body =
      "Real rationale prose.\n" +
      "```sh\n" + // opens outside any dropped section, never closed
      "echo build\n" +
      "\n" + // paragraph break → recovery boundary for the open fence
      "## Test plan\n" + // a REAL boilerplate heading that MUST still drop
      "- [x] ran the suite\n" +
      "boilerplate detail line";
    const out = distillBodyToContent(body);
    // The real prose and the fenced content up to the recovery boundary survive.
    expect(out).toContain("Real rationale prose.");
    expect(out).toContain("echo build");
    // The boilerplate section after the unterminated fence still drops.
    expect(out).not.toContain("## Test plan");
    expect(out).not.toContain("ran the suite");
    expect(out).not.toContain("boilerplate detail line");
  });

  it("does NOT invert fence parity when a fence opens inside a dropped section and a `#` line ends the drop (Z1)", () => {
    // The fix9 heading-recovery left a latent parity inversion: a fence that
    // OPENS inside a dropped section does not toggle `inFence`, so a `#` line
    // inside that fence parses as a heading and ends the drop; the fence
    // CLOSER then toggles `inFence` to true while the parser is actually
    // OUTSIDE any fence. With parity inverted, a later REAL fence's `# test
    // plan` comment parses as a boilerplate heading and drops the rest of the
    // body. The parity repair (`inDroppedFence` + heading-recovery setting
    // `inFence = true`) keeps the closer's toggle correct.
    const body =
      "## Test plan\n" +
      "```\n" + // opens INSIDE the dropped section — does not toggle inFence
      "# comment\n" + // parsed as a heading → ends the drop (over-keep)
      "```\n" + // the section fence's CLOSER
      "Real rationale prose.\n" +
      "```sh\n" + // a later REAL fence
      "# test plan\n" + // shell comment — must NOT re-trigger the drop
      "echo hi\n" +
      "```\n" +
      "Closing prose.";
    const out = distillBodyToContent(body);
    // The later real fence's content and everything after it survive.
    expect(out).toContain("echo hi");
    expect(out).toContain("Closing prose.");
    // The prose between the section fence's closer and the real fence is kept.
    expect(out).toContain("Real rationale prose.");
  });

  it("keeps fence parity when a boilerplate heading re-triggers a drop INSIDE a dropped section's still-open fence (dropped→dropped)", () => {
    // Residual of the Z1 parity repair: the boilerplate-heading branch reset
    // `inDroppedFence` on EVERY boilerplate heading, including a `# Test plan`
    // shell comment inside a still-open fence within an already-dropped
    // section (dropped→dropped). The wrong reset made the section fence's
    // CLOSER toggle parity back to true while the parser was actually outside
    // the fence, so the heading-recovery at the next real heading set
    // `inFence = true` spuriously, a later REAL fence's opener toggled it
    // false, and that fence's `# test plan` comment heading-parsed and dropped
    // the rest of the body. Parity must only reset when ENTERING a drop from a
    // non-dropping state.
    const body =
      "## Checklist\n" +
      "```bash\n" + // opens INSIDE the dropped section
      "# Test plan\n" + // boilerplate heading, dropped→dropped — parity must hold
      "```\n" + // the section fence's CLOSER
      "boilerplate line\n" +
      "## Real heading\n" +
      "prose\n" +
      "```sh\n" + // a later REAL fence
      "# test plan\n" + // shell comment — must NOT re-trigger the drop
      "echo hi\n" +
      "```\n" +
      "Closing prose.";
    const out = distillBodyToContent(body);
    // The later real fence's content and everything after it survive.
    expect(out).toContain("echo hi");
    expect(out).toContain("Closing prose.");
    // The substantive section after the dropped one is kept.
    expect(out).toContain("## Real heading");
    expect(out).toContain("prose");
    // The boilerplate section's content drops.
    expect(out).not.toContain("boilerplate line");
  });

  it("keeps fence parity when a real fence has an INTERNAL blank line and closes, then a boilerplate section follows (P3)", () => {
    // Over-KEEP bucket (a) / parity-inversion: the outside-section
    // unterminated-fence recovery fires on a BLANK line inside a LEGITIMATE
    // fenced block that DOES later close. The recovery flips `inFence` false
    // mid-fence; the block's REAL closing ``` then re-toggles `inFence` to
    // true while the parser is actually OUTSIDE any fence — inverting parity
    // for the rest of the body. With parity inverted and NO trailing blank
    // line after the closer, a subsequent boilerplate heading (`## Test plan`)
    // takes the `if (inFence)` branch, so heading parsing is short-circuited
    // and the whole boilerplate section is silently RETAINED as literal
    // content; symmetrically, real trailing prose can be swallowed. Fence
    // parity must be correct regardless of internal blank lines in a real
    // fenced block.
    const body =
      "Real rationale prose.\n" +
      "```sh\n" + // opens outside any dropped section
      "echo one\n" +
      "\n" + // INTERNAL blank line inside the real fence
      "echo two\n" +
      "```\n" + // the REAL closer — NO trailing blank line before the heading
      "## Test plan\n" + // a REAL boilerplate heading that MUST still drop
      "- [x] ran the suite\n" +
      "boilerplate detail line\n" +
      "\n" +
      "## Rationale\n" +
      "This trailing prose is REAL why/how content that must survive.";
    const out = distillBodyToContent(body);
    // The real prose and the whole fenced block survive.
    expect(out).toContain("Real rationale prose.");
    expect(out).toContain("echo one");
    expect(out).toContain("echo two");
    // The boilerplate section after the closed fence STILL drops.
    expect(out).not.toContain("## Test plan");
    expect(out).not.toContain("ran the suite");
    expect(out).not.toContain("boilerplate detail line");
    // Real trailing prose after the boilerplate is retained (not swallowed).
    expect(out).toContain("## Rationale");
    expect(out).toContain(
      "This trailing prose is REAL why/how content that must survive.",
    );
  });

  it("keeps fence parity when an UNTERMINATED fence's blank-line recovery is followed by an INDEPENDENT fenced block, then boilerplate (P3-fix-2)", () => {
    // Over-KEEP bucket (a) / parity-inversion re-introduced by p3-fix-1: the
    // outside-section blank-line recovery arms the closer-absorb for a fence
    // that NEVER really closes. A later INDEPENDENT ```code``` block's OPENER
    // then satisfies the same `absorb && !inFence` condition and gets absorbed
    // WITHOUT setting `inFence = true`. That block's real CLOSER then toggles
    // `inFence` to true while the parser is actually OUTSIDE any fence —
    // inverting parity for the rest of the body, so a subsequent boilerplate
    // heading (`## Test plan`) takes the `if (inFence)` branch and is silently
    // RETAINED. The recovery must not let a NEW block's opener be swallowed by
    // the pending absorb.
    const body =
      "Real rationale prose.\n" +
      "```sh\n" + // opens outside any dropped section, NEVER closed (unterminated)
      "echo build\n" +
      "\n" + // paragraph break → recovery boundary for the open fence
      "Prose between the fences that must survive.\n" +
      "```js\n" + // OPENER of an INDEPENDENT, well-formed fenced block
      "const x = 1;\n" +
      "```\n" + // CLOSER of that independent block
      "## Test plan\n" + // a REAL boilerplate heading that MUST still drop
      "- [x] ran the suite\n" +
      "boilerplate detail line\n" +
      "\n" +
      "## Rationale\n" +
      "This trailing prose is REAL why/how content that must survive.";
    const out = distillBodyToContent(body);
    // The real prose survives, and so does the independent block's content.
    expect(out).toContain("Real rationale prose.");
    expect(out).toContain("echo build");
    expect(out).toContain("Prose between the fences that must survive.");
    expect(out).toContain("const x = 1;");
    // The boilerplate section after the independent block STILL drops.
    expect(out).not.toContain("## Test plan");
    expect(out).not.toContain("ran the suite");
    expect(out).not.toContain("boilerplate detail line");
    // Real trailing prose after the boilerplate is retained (not swallowed).
    expect(out).toContain("## Rationale");
    expect(out).toContain(
      "This trailing prose is REAL why/how content that must survive.",
    );
  });

  it("keeps stripping to EOF after a truly-unterminated fence with an internal blank line and NO later fence marker (EOF protection)", () => {
    // EOF-protection invariant: a fence opens outside any dropped section,
    // contains an internal blank line, and NEVER closes — no later ``` marker
    // at all. The blank-line recovery must resume heading-parsing so a trailing
    // boilerplate heading still strips, and parity must NOT latch `inFence`
    // true to EOF.
    const body =
      "Why prose.\n" +
      "```sh\n" + // unterminated fence, no closer anywhere
      "echo one\n" +
      "\n" + // internal blank line → recovery boundary
      "echo two\n" +
      "## Test plan\n" + // boilerplate heading AFTER the recovery — must drop
      "- [x] ran it\n" +
      "boilerplate tail";
    const out = distillBodyToContent(body);
    expect(out).toContain("Why prose.");
    expect(out).toContain("echo one");
    expect(out).toContain("echo two");
    expect(out).not.toContain("## Test plan");
    expect(out).not.toContain("ran it");
    expect(out).not.toContain("boilerplate tail");
  });

  it("keeps fence parity after a DROPPED section's unterminated fence recovers and a later fence marker follows, then boilerplate + real prose (P3-fix-3)", () => {
    // Over-KEEP + content-LOSS bucket (a) / parity-inversion: symmetric sibling
    // of P3-fix-2, but the unterminated fence opens INSIDE a dropped boilerplate
    // section. The dropped-section blank-line recovery (`inDroppedFence` branch,
    // L310) exits the drop but — before p3-fix-3 — failed to arm the sticky
    // `recoveredOutsideFence` flag that its OUTSIDE-section sibling (L282) arms.
    // So a later fence marker toggled `inFence` TRUE while the parser is
    // actually OUTSIDE any fence, inverting parity for the rest of the body:
    // a subsequent boilerplate heading (`## Test plan`) took the `if (inFence)`
    // branch and was silently OVER-KEPT, and — symmetrically, with a second
    // marker — real trailing why/how prose is swallowed to EOF. The
    // dropped-section recovery must arm the sticky flag exactly like the
    // outside-section recovery, so every post-recovery ``` is kept as literal
    // content and NEVER re-toggles parity.
    const body =
      "Why prose.\n" +
      "## Screenshots\n" + // boilerplate heading → drop starts
      "```sh\n" + // opens INSIDE the dropped section, unterminated
      "echo build\n" +
      "\n" + // paragraph break → dropped-section recovery boundary (L310)
      "Middle prose keep me.\n" +
      "```\n" + // a later fence marker — must NOT re-toggle parity post-recovery
      "## Test plan\n" + // a REAL boilerplate heading that MUST still drop
      "- [x] ran it\n" +
      "boilerplate tail\n" +
      "\n" +
      "## Rationale\n" +
      "Closing prose. This trailing why/how content must survive.";
    const out = distillBodyToContent(body);
    // Real prose before and between fences survives.
    expect(out).toContain("Why prose.");
    expect(out).toContain("Middle prose keep me.");
    // The boilerplate section after the recovery STILL drops (no over-keep).
    expect(out).not.toContain("## Test plan");
    expect(out).not.toContain("ran it");
    expect(out).not.toContain("boilerplate tail");
    // Real trailing prose after the boilerplate is retained (not dropped to EOF).
    expect(out).toContain("## Rationale");
    expect(out).toContain(
      "Closing prose. This trailing why/how content must survive.",
    );
  });

  it("skips the CONTRIBUTING ack drop inside code fences (U2)", () => {
    const body =
      "Prose.\n" + "```\n" + "- [x] I have read the CONTRIBUTING doc\n" + "```";
    const out = distillBodyToContent(body);
    // Inside a fence the line is literal content (e.g. a template example),
    // not the boilerplate checklist item.
    expect(out).toContain("- [x] I have read the CONTRIBUTING doc");
  });
});

describe("ref fallback (U3)", () => {
  it("falls back to the repo default branch when baseRef is an empty string", async () => {
    const unit = loadFixture("pr.json");
    (unit as { pullRequest: { baseRef?: string | null } }).pullRequest.baseRef =
      "";
    const [fragment] = await githubAdapter.extract(unit, ctx);
    // `"" ?? default` keeps the empty string; the ref must instead fall back
    // truthily, matching buildGitHubSeedContent's own truthy branch guards.
    expect(fragment.ref).toBe("main");
  });

  it("keeps a real baseRef as the ref", async () => {
    const unit = loadFixture("pr.json");
    const [fragment] = await githubAdapter.extract(unit, ctx);
    expect(fragment.ref).toBe("main");
    (unit as { pullRequest: { baseRef?: string | null } }).pullRequest.baseRef =
      "release/1.x";
    const [fragment2] = await githubAdapter.extract(unit, ctx);
    expect(fragment2.ref).toBe("release/1.x");
  });
});

describe("ref + branch-label whitespace normalization (V35)", () => {
  function prFields(unit: GitHubPrOrIssueUnit): {
    baseRef?: string | null;
    headRef?: string | null;
  } {
    return (
      unit as {
        pullRequest: { baseRef?: string | null; headRef?: string | null };
      }
    ).pullRequest;
  }

  it("stores a TRIMMED ref for a padded baseRef", async () => {
    const unit = loadFixture("pr.json");
    prFields(unit).baseRef = " main ";
    const [fragment] = await githubAdapter.extract(unit, ctx);
    // The trim() check must not return the UNTRIMMED original — a padded
    // " main " ref breaks downstream ref comparisons/checkouts.
    expect(fragment.ref).toBe("main");
  });

  it("emits TRIMMED branch labels in the WHAT-header provenance for padded base/head refs", async () => {
    const unit = loadFixture("pr.json");
    prFields(unit).baseRef = " main ";
    prFields(unit).headRef = " feature/agent-bridge ";
    const [fragment] = await githubAdapter.extract(unit, ctx);
    // A.3: the WHAT-metadata header (branch labels et al.) lives on provenance
    // evidence, NOT in the distilled `content`. The trim normalization still
    // applies before the label is rendered.
    const header = whatHeaderBody(fragment);
    expect(header).toMatch(/^Base branch: main$/m);
    expect(header).toMatch(/^Head branch: feature\/agent-bridge$/m);
    // …and the trimmed labels must NOT bleed back into the seed content.
    expect(fragment.content).not.toContain("Base branch:");
    expect(fragment.content).not.toContain("Head branch:");
  });

  it("falls back to the default branch for a whitespace-only baseRef and emits NO dangling branch labels", async () => {
    const unit = loadFixture("pr.json");
    prFields(unit).baseRef = "   ";
    prFields(unit).headRef = " \t";
    const [fragment] = await githubAdapter.extract(unit, ctx);
    expect(fragment.ref).toBe("main");
    // A whitespace-only branch is "no branch" — the truthy guard inside the
    // WHAT-header builder must see null, never a padded-whitespace string, so
    // no dangling "Base branch: " / "Head branch: " label line is emitted in
    // the header provenance (or, a fortiori, in content).
    const header = whatHeaderBody(fragment);
    expect(header).not.toContain("Base branch:");
    expect(header).not.toContain("Head branch:");
    expect(fragment.content).not.toContain("Base branch:");
    expect(fragment.content).not.toContain("Head branch:");
  });

  // ── A.3: WHAT-metadata header lifted off `content` ──────────────────────────
  //
  // The batch seed `content` must be the DISTILLED why/how prose ONLY — the
  // WHAT-metadata header (Repository/branch/commit/author/URL) inflated a bare
  // restatement into looking substantive to the distillation gate (S8). A.3
  // relocates it: OUT of `content`, ONTO provenance evidence (relocated, not
  // dropped — criterion 4).
  it("does NOT inject the WHAT-metadata header into the PR seed content", async () => {
    const unit = loadFixture("pr.json");
    const [fragment] = await githubAdapter.extract(unit, ctx);
    expect(fragment.content).not.toContain("Repository:");
    expect(fragment.content).not.toContain("URL:");
    expect(fragment.content).not.toContain("Base branch:");
    expect(fragment.content).not.toContain("Head branch:");
    expect(fragment.content).not.toContain("Merge commit:");
    expect(fragment.content).not.toContain("Author:");
    expect(fragment.content).not.toContain("Merged by:");
    // The `# PR #N: <title>` header line is webhook-only; the batch content
    // must not carry it either.
    expect(fragment.content).not.toMatch(/^# PR #/m);
  });

  it("does NOT inject the WHAT-metadata header into the issue seed content", async () => {
    const unit = loadFixture("issue.json");
    const [fragment] = await githubAdapter.extract(unit, ctx);
    expect(fragment.content).not.toContain("Repository:");
    expect(fragment.content).not.toContain("URL:");
    expect(fragment.content).not.toContain("Author:");
    expect(fragment.content).not.toMatch(/^# Issue #/m);
  });

  it("POSITIVELY retains the WHAT-metadata facts on the PR fragment as provenance (relocated, not dropped)", async () => {
    const unit = loadFixture("pr.json");
    const [fragment] = await githubAdapter.extract(unit, ctx);
    const header = whatHeaderBody(fragment);
    // Every fact the header carried must survive the lift — a regression that
    // DROPS the facts (rather than relocating them) fails here.
    expect(header).toMatch(/^# PR #1337: /m);
    expect(header).toMatch(/^Repository: CopilotKit\/copilotkit$/m);
    expect(header).toMatch(
      /^URL: https:\/\/github\.com\/CopilotKit\/copilotkit\/pull\/1337$/m,
    );
    expect(header).toMatch(/^Merge commit: feedface1234567890abcdef$/m);
    // The header is carried as evidence, so the facts remain queryable on the
    // fragment after they leave `content`.
    expect(
      fragment.evidence.some(
        (e) => e.kind === "thread" && /^Repository:/m.test(e.body),
      ),
    ).toBe(true);
  });
});

describe("first-pass sensitivity scan (shared credential/GTM scan)", () => {
  // The batch adapter must not hardcode sensitivity:"internal" — a raw
  // credential or customer-identifying GTM detail in a PR/issue body would
  // land `internal` and the deterministic DEFAULT_EXCLUSION_RULES layer
  // (sensitivity ≥ proprietary) would never fire, leaving only the LLM
  // english-rule layer guarding the leak. The scan runs over EVERYTHING the
  // fragment actually emits: title + the DISTILLED body + the verbatim
  // reviewThread bodies and linkedIssue URLs that land in `evidence` (rendered
  // onto the approval page); the webhook path is untouched (B2
  // byte-equivalence).
  it("escalates a PR whose body mentions rotating API keys to secret", async () => {
    const unit = loadFixture("pr.json");
    (unit as { pullRequest: { body?: string | null } }).pullRequest.body =
      "We must rotate the API keys for the staging fleet before cutover.";
    const [fragment] = await githubAdapter.extract(unit, ctx);
    expect(fragment.provenance.classification.sensitivity).toBe("secret");
  });

  it("escalates an issue tying a named customer to contract value to proprietary", async () => {
    const unit = loadFixture("issue.json");
    (unit as { issue: { body?: string | null } }).issue.body =
      "The ACME contract value is at risk ahead of the renewal.";
    const [fragment] = await githubAdapter.extract(unit, ctx);
    expect(fragment.provenance.classification.sensitivity).toBe("proprietary");
  });

  it("treats an op:// 1Password pointer as SAFE (stays internal)", async () => {
    const unit = loadFixture("pr.json");
    (unit as { pullRequest: { body?: string | null } }).pullRequest.body =
      "Read the value from op://DevOps/MyService/api_token at deploy time.";
    const [fragment] = await githubAdapter.extract(unit, ctx);
    expect(fragment.provenance.classification.sensitivity).toBe("internal");
  });

  it("keeps an ordinary PR at internal", async () => {
    const unit = loadFixture("pr.json");
    const [fragment] = await githubAdapter.extract(unit, ctx);
    expect(fragment.provenance.classification.sensitivity).toBe("internal");
  });

  it("escalates a PR whose title/body are clean but a reviewThread mentions rotating API keys", async () => {
    // The fragment emits every reviewThread body VERBATIM as `thread` evidence
    // (rendered onto the approval page), so the scan haystack must include
    // them — a credential pasted in a review comment must not dodge the scan.
    const unit = loadFixture("pr.json");
    (unit as { pullRequest: { body?: string | null } }).pullRequest.body =
      "Routine refactor of the provider registry.";
    unit.reviewThreads = [
      "Before merging: we must rotate the API keys for the staging fleet.",
    ];
    const [fragment] = await githubAdapter.extract(unit, ctx);
    expect(fragment.provenance.classification.sensitivity).toBe("secret");
  });

  it("escalates an ISSUE whose comment thread embeds a credential assignment", async () => {
    // Same haystack rule on the issue path — its `reviewThreads` are issue
    // comment threads and they land in `thread` evidence verbatim too.
    const unit = loadFixture("issue.json");
    unit.reviewThreads = [
      "Repro: set api_key=sk-test-12345 in .env and hit the endpoint.",
    ];
    const [fragment] = await githubAdapter.extract(unit, ctx);
    expect(fragment.provenance.classification.sensitivity).toBe("secret");
  });

  it("escalates a PR whose linked-issue URL embeds a credential assignment", async () => {
    // linkedIssues land verbatim as `linked_issue` evidence URLs, so the scan
    // haystack must include them as well.
    const unit = loadFixture("pr.json");
    (unit as { pullRequest: { body?: string | null } }).pullRequest.body =
      "Routine refactor of the provider registry.";
    unit.linkedIssues = [
      "https://internal.example.com/runbook?api_key=abcdef0123456789",
    ];
    const [fragment] = await githubAdapter.extract(unit, ctx);
    expect(fragment.provenance.classification.sensitivity).toBe("secret");
  });

  // The scan must run over the RAW body — the full unstripped PR/issue text —
  // NOT the DISTILLED `content` that distillBodyToContent produces. A credential
  // that lives ONLY inside a section distillBodyToContent strips (Test plan /
  // Checklist / How to test / Screenshots) or inside an HTML comment is REMOVED
  // before it reaches the distilled `content`; scanning `content` would classify
  // such a fragment `internal` and it would dodge DEFAULT_EXCLUSION_RULES and
  // leak. memory.ts and notion.ts scan the raw body/section — github must too.
  it("escalates a PR whose ONLY credential sits inside a stripped 'Test plan' section", async () => {
    const unit = loadFixture("pr.json");
    (unit as { pullRequest: { body?: string | null } }).pullRequest.body =
      "Routine refactor of the provider registry.\n\n" +
      "## Test plan\n\n" +
      "- Run the suite with ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 exported.";
    const [fragment] = await githubAdapter.extract(unit, ctx);
    // The credential is gone from the distilled content …
    expect(fragment.content).not.toContain("ghp_");
    // … but it MUST still be detected off the raw body and escalated.
    expect(fragment.provenance.classification.sensitivity).toBe("secret");
  });

  it("escalates a PR whose ONLY credential sits inside an HTML comment", async () => {
    const unit = loadFixture("pr.json");
    (unit as { pullRequest: { body?: string | null } }).pullRequest.body =
      "Routine refactor of the provider registry.\n\n" +
      "<!-- deploy note: api_key=sk-live-abcdef0123456789 -->";
    const [fragment] = await githubAdapter.extract(unit, ctx);
    expect(fragment.content).not.toContain("sk-live");
    expect(fragment.provenance.classification.sensitivity).toBe("secret");
  });

  it("escalates an ISSUE whose ONLY credential sits inside a stripped 'Checklist' section", async () => {
    const unit = loadFixture("issue.json");
    (unit as { issue: { body?: string | null } }).issue.body =
      "The provider registry occasionally drops a retry.\n\n" +
      "## Checklist\n\n" +
      "- [ ] rotate api_key=sk-live-abcdef0123456789 after deploy";
    const [fragment] = await githubAdapter.extract(unit, ctx);
    expect(fragment.content).not.toContain("sk-live");
    expect(fragment.provenance.classification.sensitivity).toBe("secret");
  });

  it("escalates an ISSUE whose ONLY credential sits inside an HTML comment", async () => {
    const unit = loadFixture("issue.json");
    (unit as { issue: { body?: string | null } }).issue.body =
      "The provider registry occasionally drops a retry.\n\n" +
      "<!-- ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -->";
    const [fragment] = await githubAdapter.extract(unit, ctx);
    expect(fragment.content).not.toContain("ghp_");
    expect(fragment.provenance.classification.sensitivity).toBe("secret");
  });
});

describe("padded repo.fullName → TRIMMED subsystem", () => {
  // The intake guard trims fullName for the CHECK only; the `subsystem` field
  // — a STRUCTURAL canonical-key component
  // (<sourcetype>:<subsystem>:<claim-slug>) — must carry the TRIMMED value
  // too, or a padded " owner/repo " mints a padded canonical key downstream.
  it("uses the trimmed fullName as the PR fragment's subsystem", async () => {
    const unit = loadFixture("pr.json");
    unit.repo.fullName = " CopilotKit/copilotkit ";
    const [fragment] = await githubAdapter.extract(unit, ctx);
    expect(fragment.subsystem).toBe("CopilotKit/copilotkit");
  });

  it("uses the trimmed fullName as the issue fragment's subsystem", async () => {
    const unit = loadFixture("issue.json");
    unit.repo.fullName = " CopilotKit/copilotkit ";
    const [fragment] = await githubAdapter.extract(unit, ctx);
    expect(fragment.subsystem).toBe("CopilotKit/copilotkit");
  });
});

describe("distillBodyToContent title-prefix interplay is unaffected; distillTitle", () => {
  // distillTitle is not exported; exercise it through the adapter's fragment.title.
  async function titleFor(rawTitle: string): Promise<string> {
    const unit = loadFixture("pr.json");
    (unit as { pullRequest: { title: string } }).pullRequest.title = rawTitle;
    const [fragment] = await githubAdapter.extract(unit, ctx);
    return fragment.title;
  }

  it("strips a conventional-commit type prefix", async () => {
    expect(await titleFor("feat: add the agent bridge")).toBe(
      "add the agent bridge",
    );
    expect(await titleFor("fix(runtime): patch the agent bridge")).toBe(
      "patch the agent bridge",
    );
  });

  it("preserves a natural-language 'Word:' prefix that is NOT a conventional-commit type", async () => {
    expect(await titleFor("Note: explains the agent bridge why")).toBe(
      "Note: explains the agent bridge why",
    );
    expect(await titleFor("Add: the agent bridge")).toBe(
      "Add: the agent bridge",
    );
  });

  it("falls back to a non-empty title when distillation strips the whole title (PR)", async () => {
    // A `[scope]`-only title distills to "", which would yield a degenerate
    // canonical key (`github-pr:<repo>:`). Guard it: fall back to the trimmed
    // raw title when that is non-empty.
    expect(await titleFor("[wip]")).toBe("[wip]");
    // A `[scope]`-only title with trailing whitespace also distills to "", but
    // the raw TRIMMED title is non-empty → fall back to the trimmed raw title.
    expect(await titleFor("[chore] ")).toBe("[chore]");
    // Whitespace-only: distilled AND trimmed raw are both empty → fall back to
    // the `PR #<number>` form (pr.json fixture is #1337).
    expect(await titleFor("   ")).toBe("PR #1337");
  });
});

// Env-reference sanitization (spec §3.3): every adapter runs its emitted
// `content` (and `provenance.source` where set) through `sanitizeEnvRefs`
// before returning from extract(). A machine-local `/Users/<user>/…` path in
// the PR body must be rewritten to its repo-relative tail, and a bare session
// UUID must be stripped, so neither leaks into the external corpus.
describe("githubAdapter — env-reference sanitization (§3.3)", () => {
  it("sanitizes a /Users/ path + session UUID out of the emitted content", async () => {
    const unit = loadFixture("pr.json");
    (unit as GitHubPullRequestUnit).pullRequest.body =
      "We patched the bug in " +
      "/Users/jpr5/proj/cpk/pathfinder/src/atlas/distillation-gate.ts " +
      "during session e654541f-dcb7-4152-8ee8-f669848555ee — see the fix.";
    const [fragment] = await githubAdapter.extract(unit, ctx);

    // E1: the machine-local prefix is stripped; the repo-relative tail survives.
    expect(fragment.content).toContain("src/atlas/distillation-gate.ts");
    expect(fragment.content).not.toContain("/Users/jpr5");
    // E2: the bare session UUID is gone.
    expect(fragment.content).not.toContain(
      "e654541f-dcb7-4152-8ee8-f669848555ee",
    );
  });
});

// Type-level guard: the adapter conforms to the LeafAdapter contract.
const _typecheck: CandidateFragment["sourcetype"] = githubAdapter.sourcetype;
void _typecheck;
