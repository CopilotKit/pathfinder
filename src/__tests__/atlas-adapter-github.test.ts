import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  githubAdapter,
  distillBodyToContent,
  type GitHubPrOrIssueUnit,
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

  it("emits TRIMMED branch labels in content for padded base/head refs", async () => {
    const unit = loadFixture("pr.json");
    prFields(unit).baseRef = " main ";
    prFields(unit).headRef = " feature/agent-bridge ";
    const [fragment] = await githubAdapter.extract(unit, ctx);
    expect(fragment.content).toMatch(/^Base branch: main$/m);
    expect(fragment.content).toMatch(/^Head branch: feature\/agent-bridge$/m);
  });

  it("falls back to the default branch for a whitespace-only baseRef and emits NO dangling branch labels", async () => {
    const unit = loadFixture("pr.json");
    prFields(unit).baseRef = "   ";
    prFields(unit).headRef = " \t";
    const [fragment] = await githubAdapter.extract(unit, ctx);
    expect(fragment.ref).toBe("main");
    // A whitespace-only branch is "no branch" — the truthy guard inside the
    // shared builder must see null, never a padded-whitespace string, so no
    // dangling "Base branch: " / "Head branch: " label line is emitted.
    expect(fragment.content).not.toContain("Base branch:");
    expect(fragment.content).not.toContain("Head branch:");
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

// Type-level guard: the adapter conforms to the LeafAdapter contract.
const _typecheck: CandidateFragment["sourcetype"] = githubAdapter.sourcetype;
void _typecheck;
