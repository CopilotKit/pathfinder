// Distillation gate (Theme A.1) tests — the WHY-vs-WHAT core.
//
// ORG RULE: the JUDGE is LLM-backed, so its tests use aimock — never vi.fn /
// vi.mock stubs for the model call. We spin up an in-process aimock server
// (@copilotkit/aimock's `LLMock`), point a real `OpenAIDistiller` at it via
// baseURL, and let `enforceDistillation` drive the REAL judge → REAL model call
// → REAL parse path. The deterministic pre-filter and the marker-emit are
// exercised on that real surface.
//
// The CRITICAL COUPLING under test is A.1 → A.2 (S8 → S4): a restatement verdict
// must stamp `RESTATEMENT_MARKER` onto a carrier `promoteValidation` (validate.ts)
// reads, so the downstream approvability recompute floors it at
// `approvable=false`. We assert that end-to-end (gate → validate) rather than
// just that a token string appears — the value is the FLOOR firing.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LLMock, type Fixture } from "@copilotkit/aimock";

import { OpenAIDistiller } from "../atlas/llm.js";
import {
  enforceDistillation,
  stripGitHubMetadataHeader,
  REWRITTEN_FROM_RESTATEMENT_MARKER,
  type DistillationJudge,
} from "../atlas/distillation-gate.js";
import { promoteValidation } from "../atlas/validate.js";
import type { ValidationContext } from "../atlas/validate.js";
import type { FeatureRegistry } from "../atlas/adapters/showcase.js";
import { RESTATEMENT_MARKER } from "../atlas/types.js";
import type { Candidate, KnowledgeType } from "../atlas/types.js";

// A stable substring of the distillation system prompt in llm.ts — gates every
// fixture to the judge operation (never colliding with episodic/exclusion).
const DISTILL_SYSTEM_MARKER = "WHY-vs-WHAT judge";

// ── Candidate fixtures drawn from the plan's Step-1/Step-2 examples ─────────────

// The real leaked "stack/component inventory" restatement: pure WHAT, no why/how.
// The judge should rule this a `restatement` (no salvageable claim).
const INVENTORY_TITLE =
  "Adds shared-state, human-in-the-loop, and gen-ui components";
const INVENTORY_CONTENT =
  "This change adds the shared-state, human-in-the-loop, and generative-ui " +
  "components to the demo app. The stack now includes Next.js, the CopilotKit " +
  "runtime, and the LangGraph adapter.";

// A genuine why/how claim: explains a mechanism/consequence. Judge → distilled.
const WHY_TITLE = "Runtime drains the tool queue before the terminal message";
const WHY_CONTENT =
  "The runtime drains the tool queue before emitting the terminal assistant " +
  "message so partial tool state never leaks to the client; a half-applied tool " +
  "result would otherwise desync the frontend snapshot from the server.";

// A salvageable candidate: WHAT title, but the body carries extractable why/how.
// Judge → rewritten (returns a distilled title/content).
const SALVAGE_MARKER = "SALVAGE-WINDOW";
const SALVAGE_TITLE = "PR #42 changes the reconnect backoff";
const SALVAGE_CONTENT =
  `${SALVAGE_MARKER}: the reconnect backoff was changed because a fixed 1s ` +
  "retry stampeded the gateway on a mass disconnect; exponential backoff with " +
  "jitter spreads the reconnect load so the gateway is not thundering-herded.";
const SALVAGE_REWRITE_TITLE =
  "Reconnect uses exponential backoff with jitter to avoid a thundering herd on the gateway";
const SALVAGE_REWRITE_CONTENT =
  "A fixed 1s reconnect retry stampeded the gateway on a mass disconnect. " +
  "Exponential backoff with jitter spreads reconnect load over time so a mass " +
  "disconnect no longer thundering-herds the gateway.";

// A salvageable candidate whose judge REASON deliberately embeds the `"; "`
// carrier delimiter. The rewritten breadcrumb (`distilled-from-restatement:<reason>`)
// must NOT fragment into fake tokens: the marker is a whole-token contract the
// downstream validate reader (and the gate's own idempotency dedup) splits on
// `"; "`. This exercises the exact defect — a delimiter-bearing reason.
const DELIM_SALVAGE_MARKER = "DELIM-REASON-CASE";
const DELIM_SALVAGE_TITLE = "PR #99 reworks the retry policy";
const DELIM_SALVAGE_CONTENT =
  `${DELIM_SALVAGE_MARKER}: the retry policy was reworked because the old one ` +
  "hammered the gateway; the new one backs off.";
const DELIM_REWRITE_TITLE = "Retry policy backs off to avoid hammering the gateway";
const DELIM_REWRITE_CONTENT =
  "The old retry policy hammered the gateway on failure. The new policy backs " +
  "off exponentially so a failure burst no longer overwhelms the gateway.";
// The load-bearing part: this reason string CONTAINS the `"; "` delimiter.
const DELIM_REASON =
  "the body explains why the retry policy changed; it cites the gateway load problem";
// The delimiter-safe form the gate stamps: the semicolon-run collapses to a
// single space so the breadcrumb token can never fragment on the `"; "` carrier
// delimiter. (Mirrors distillation-gate's sanitizeCarrierText.)
const DELIM_REASON_SANITIZED =
  "the body explains why the retry policy changed it cites the gateway load problem";

// A salvageable candidate whose judge returns an EMPTY reason. The gate must NOT
// emit a bare-colon `distilled-from-restatement:` token — it emits the fixed
// bare marker instead (finding #2).
const EMPTY_REASON_MARKER = "EMPTY-REASON-CASE";
const EMPTY_REASON_TITLE = "PR #7 tweaks the cache TTL";
const EMPTY_REASON_CONTENT =
  `${EMPTY_REASON_MARKER}: the cache TTL was raised because cold-start misses ` +
  "hammered the origin; a longer TTL smooths the origin load.";
const EMPTY_REASON_REWRITE_TITLE =
  "Cache TTL raised to smooth origin load on cold-start misses";
const EMPTY_REASON_REWRITE_CONTENT =
  "Cold-start cache misses hammered the origin. A longer TTL keeps entries warm " +
  "so a burst of misses no longer overwhelms the origin.";

// A re-run non-determinism case: the SAME rewritten content is re-judged on a
// second pass, but the model returns a DIFFERENT reason than the first pass. The
// idempotency dedup must key on the STABLE class prefix (not the reason text) so
// no duplicate breadcrumb accrues (finding #1). Two fixtures: first pass (gated
// on the salvage marker) and re-run pass (gated on the rewritten content phrase).
const NONDET_MARKER = "NONDET-REASON-CASE";
const NONDET_TITLE = "PR #55 changes the flush interval";
const NONDET_CONTENT =
  `${NONDET_MARKER}: the flush interval was shortened because buffered writes ` +
  "lost data on crash; a shorter interval bounds the data-loss window.";
const NONDET_REWRITE_TITLE =
  "Flush interval shortened to bound the crash data-loss window";
const NONDET_REWRITE_CONTENT =
  "Buffered writes lost data on a crash. A shorter flush interval bounds the " +
  "data-loss window so a crash drops far fewer buffered writes.";
const NONDET_REASON_FIRST = "the body explains the crash data-loss tradeoff";
const NONDET_REASON_SECOND =
  "on re-read the rationale is the durability-vs-latency tradeoff";

// A candidate a PRIOR run ruled a pure `restatement` (so it carries a stale
// RESTATEMENT_MARKER on validated_against), but THIS run's judge flips it to
// `rewritten` — the salvage-defeated-by-stale-marker case. The gate must strip
// the stale floor marker so validate no longer floors the salvaged candidate.
const FLIP_MARKER = "FLIP-RESTATEMENT-TO-REWRITTEN";
const FLIP_TITLE = "PR #123 changes the batch size";
const FLIP_CONTENT =
  `${FLIP_MARKER}: the batch size was raised because tiny batches thrashed the ` +
  "queue; a larger batch amortizes the per-flush overhead.";
const FLIP_REWRITE_TITLE =
  "Batch size raised to amortize per-flush overhead and stop queue thrash";
const FLIP_REWRITE_CONTENT =
  "Tiny batches thrashed the queue with per-flush overhead. A larger batch " +
  "amortizes that overhead so the queue no longer thrashes under load.";
const FLIP_REASON = "the body explains the batching tradeoff";

// restatement→distilled flip: a candidate a PRIOR run ruled `restatement` (so it
// carries a stale RESTATEMENT_MARKER), but THIS run's judge rules it a genuine
// `distilled` why/how claim. The gate must strip the stale floor marker uniformly
// on the distilled path (not just rewritten) so validate no longer floors it.
const FLIP_DISTILLED_MARKER = "FLIP-RESTATEMENT-TO-DISTILLED";
const FLIP_DISTILLED_TITLE = "Retry budget bounds cascading gateway failures";
const FLIP_DISTILLED_CONTENT =
  `${FLIP_DISTILLED_MARKER}: the retry budget was added because unbounded ` +
  "retries turned a single slow dependency into a cascading gateway outage; a " +
  "budget caps the amplification so one slow dependency cannot take down the fleet.";

// rewritten→restatement flip: a candidate a PRIOR run ruled `rewritten` (so it
// carries a stale `distilled-from-restatement` salvage breadcrumb AND the prior
// run's salvaged why/how title/content), but THIS run's judge rules it a pure
// `restatement`. The gate must stamp the floor marker AND clean the contradictory
// salvage breadcrumb (slot1a-b finding).
const FLIP_TO_RESTATEMENT_MARKER = "FLIP-REWRITTEN-TO-RESTATEMENT";
const FLIP_TO_RESTATEMENT_TITLE = "PR #200 lists the new endpoints";
const FLIP_TO_RESTATEMENT_CONTENT =
  `${FLIP_TO_RESTATEMENT_MARKER}: the PR adds the /health and /ready endpoints ` +
  "to the service. The routes are now registered on the router.";

// distilled→restatement flip: a candidate a PRIOR run ruled `distilled` (no
// salvage breadcrumb, no floor marker) that THIS run's judge rules a pure
// `restatement`. Confirms the floor marker is stamped on the flip (baseline flip
// arm, distinct from the rewritten→restatement breadcrumb-cleanup arm).
const FLIP_DISTILLED_TO_RESTATEMENT_MARKER = "FLIP-DISTILLED-TO-RESTATEMENT";
const FLIP_DISTILLED_TO_RESTATEMENT_TITLE = "PR #201 bumps the dependency";
const FLIP_DISTILLED_TO_RESTATEMENT_CONTENT =
  `${FLIP_DISTILLED_TO_RESTATEMENT_MARKER}: the PR bumps the http client ` +
  "dependency to the latest patch release.";

const fixtures: Fixture[] = [
  // Salvageable → rewritten (gated on the salvage marker in the user payload).
  {
    match: {
      systemMessage: DISTILL_SYSTEM_MARKER,
      userMessage: SALVAGE_MARKER,
    },
    response: {
      content: JSON.stringify({
        verdict: "rewritten",
        reason: "the body explains why exponential backoff was adopted",
        title: SALVAGE_REWRITE_TITLE,
        content: SALVAGE_REWRITE_CONTENT,
      }),
    },
  },
  // Pure WHAT inventory → restatement (gated on the inventory content substring).
  {
    match: {
      systemMessage: DISTILL_SYSTEM_MARKER,
      userMessage: "shared-state, human-in-the-loop",
    },
    response: {
      content: JSON.stringify({
        verdict: "restatement",
        reason: "a bare component/stack inventory with no reasoning",
      }),
    },
  },
  // Genuine why/how claim → distilled (gated on a distinctive content substring).
  {
    match: {
      systemMessage: DISTILL_SYSTEM_MARKER,
      userMessage: "drains the tool queue",
    },
    response: {
      content: JSON.stringify({
        verdict: "distilled",
        reason: "explains the mechanism and its consequence",
      }),
    },
  },
  // Salvageable → rewritten, but with a reason that EMBEDS the `"; "` delimiter.
  {
    match: {
      systemMessage: DISTILL_SYSTEM_MARKER,
      userMessage: DELIM_SALVAGE_MARKER,
    },
    response: {
      content: JSON.stringify({
        verdict: "rewritten",
        reason: DELIM_REASON,
        title: DELIM_REWRITE_TITLE,
        content: DELIM_REWRITE_CONTENT,
      }),
    },
  },
  // Re-run of the delimiter case: the gate re-judges the ALREADY-rewritten
  // content on a second pass. It returns the SAME rewritten verdict+reason so
  // the idempotency dedup is what must prevent a duplicate breadcrumb — not a
  // different verdict. Gated on a distinctive phrase of the rewritten content.
  {
    match: {
      systemMessage: DISTILL_SYSTEM_MARKER,
      userMessage: "backs off exponentially",
    },
    response: {
      content: JSON.stringify({
        verdict: "rewritten",
        reason: DELIM_REASON,
        title: DELIM_REWRITE_TITLE,
        content: DELIM_REWRITE_CONTENT,
      }),
    },
  },
  // Salvageable → rewritten with an EMPTY reason (finding #2).
  {
    match: {
      systemMessage: DISTILL_SYSTEM_MARKER,
      userMessage: EMPTY_REASON_MARKER,
    },
    response: {
      content: JSON.stringify({
        verdict: "rewritten",
        reason: "",
        title: EMPTY_REASON_REWRITE_TITLE,
        content: EMPTY_REASON_REWRITE_CONTENT,
      }),
    },
  },
  // restatement→rewritten flip: THIS run's judge salvages a candidate a prior
  // run had marked a pure restatement (gated on the flip marker).
  {
    match: {
      systemMessage: DISTILL_SYSTEM_MARKER,
      userMessage: FLIP_MARKER,
    },
    response: {
      content: JSON.stringify({
        verdict: "rewritten",
        reason: FLIP_REASON,
        title: FLIP_REWRITE_TITLE,
        content: FLIP_REWRITE_CONTENT,
      }),
    },
  },
  // Non-determinism first pass: gated on the salvage marker, reason #1.
  {
    match: {
      systemMessage: DISTILL_SYSTEM_MARKER,
      userMessage: NONDET_MARKER,
    },
    response: {
      content: JSON.stringify({
        verdict: "rewritten",
        reason: NONDET_REASON_FIRST,
        title: NONDET_REWRITE_TITLE,
        content: NONDET_REWRITE_CONTENT,
      }),
    },
  },
  // Non-determinism re-run pass: gated on a distinctive phrase of the rewritten
  // content, but the model now returns a DIFFERENT reason (reason #2). The dedup
  // must NOT append a second breadcrumb despite the changed reason text.
  {
    match: {
      systemMessage: DISTILL_SYSTEM_MARKER,
      userMessage: "drops far fewer buffered writes",
    },
    response: {
      content: JSON.stringify({
        verdict: "rewritten",
        reason: NONDET_REASON_SECOND,
        title: NONDET_REWRITE_TITLE,
        content: NONDET_REWRITE_CONTENT,
      }),
    },
  },
  // restatement→distilled flip: THIS run's judge rules a genuine distilled claim
  // (gated on the flip marker).
  {
    match: {
      systemMessage: DISTILL_SYSTEM_MARKER,
      userMessage: FLIP_DISTILLED_MARKER,
    },
    response: {
      content: JSON.stringify({
        verdict: "distilled",
        reason: "explains the cascading-failure mechanism and the budget's effect",
      }),
    },
  },
  // rewritten→restatement flip: THIS run's judge rules a pure restatement (gated
  // on the flip marker).
  {
    match: {
      systemMessage: DISTILL_SYSTEM_MARKER,
      userMessage: FLIP_TO_RESTATEMENT_MARKER,
    },
    response: {
      content: JSON.stringify({
        verdict: "restatement",
        reason: "a bare endpoint inventory with no reasoning",
      }),
    },
  },
  // distilled→restatement flip: THIS run's judge rules a pure restatement (gated
  // on the flip marker).
  {
    match: {
      systemMessage: DISTILL_SYSTEM_MARKER,
      userMessage: FLIP_DISTILLED_TO_RESTATEMENT_MARKER,
    },
    response: {
      content: JSON.stringify({
        verdict: "restatement",
        reason: "a bare dependency-bump note with no reasoning",
      }),
    },
  },
];

// ── Candidate builder ───────────────────────────────────────────────────────────

function makeCandidate(over: {
  title: string;
  content: string;
  knowledge_type?: KnowledgeType;
  subsystem?: string;
}): Candidate {
  const subsystem = over.subsystem ?? "runtime";
  return {
    sourcetype: "github-pr",
    subsystem,
    claimSlugHint: "claim",
    source_name: "atlas",
    repo_url: "https://github.com/CopilotKit/pathfinder",
    ref: "main",
    title: over.title,
    content: over.content,
    provenance: {
      source: "github-pr",
      url: "https://github.com/CopilotKit/pathfinder/pull/1",
      date: "2026-06-01",
      classification: {
        sensitivity: "public",
        // architecture is a BEHAVIOR_KNOWLEDGE_TYPE, so it is the strongest
        // demonstration that the RESTATEMENT floor is what forces
        // approvable=false (independent of the behavior-unverified path).
        knowledge_type: over.knowledge_type ?? "architecture",
        audience: "all-staff",
        validation_status: "unverified",
        confidence: "high",
        provenance_class: "primary",
        freshness: { as_of: "2026-06-01" },
      },
    },
    canonical_key: `github-pr:${subsystem}:claim`,
    rankScore: 1,
    approvable: true,
    evidence: [],
    needsReview: false,
    validationTargets: [],
  };
}

// A validation context pointed at a checkout whose grep can promote the
// candidate's targets — but our candidates carry NO validationTargets, and the
// registry is empty, so nothing source/showcase-verifies. This isolates the
// RESTATEMENT floor as the sole driver of approvable=false.
const EMPTY_REGISTRY: FeatureRegistry = { categories: [] };
function ctxOn(checkoutDir: string): ValidationContext {
  return { checkoutDir, featureRegistry: EMPTY_REGISTRY };
}

describe("stripGitHubMetadataHeader (deterministic pre-filter, no LLM)", () => {
  it("strips a leading GitHub WHAT-metadata header block, leaving the why/how prose", () => {
    const withHeader = [
      "# PR #42: Add reconnect backoff",
      "",
      "Repository: CopilotKit/pathfinder",
      "Head branch: feat/backoff",
      "Author: someone",
      "URL: https://github.com/CopilotKit/pathfinder/pull/42",
      "",
      "The reconnect backoff was changed because a fixed retry stampeded the gateway.",
    ].join("\n");
    expect(stripGitHubMetadataHeader(withHeader)).toBe(
      "The reconnect backoff was changed because a fixed retry stampeded the gateway.",
    );
  });

  it("returns prose unchanged when there is no metadata header (the normal batch case)", () => {
    const prose =
      "The runtime drains the tool queue: partial state would desync the client.";
    expect(stripGitHubMetadataHeader(prose)).toBe(prose);
  });

  it("does NOT strip a legitimate human heading like '# Design decision #3:' (finding #3)", () => {
    // A real human `#` heading that happens to contain `#<digits>:` must survive
    // untouched — only the actual `# PR #N:` / `# Issue #N:` WHAT-metadata header
    // (the two kindLabels the GitHub adapter emits) is the strip target.
    const humanHeading = [
      "# Design decision #3: why we drain the queue first",
      "",
      "We drain the tool queue before the terminal message so partial state never leaks.",
    ].join("\n");
    // Unchanged — the whole block, heading included, reaches the judge.
    expect(stripGitHubMetadataHeader(humanHeading)).toBe(humanHeading);
  });

  it("strips an '# Issue #N:' WHAT-metadata header too (the other kindLabel)", () => {
    const withIssueHeader = [
      "# Issue #17: reconnect storms",
      "",
      "Repository: CopilotKit/pathfinder",
      "URL: https://github.com/CopilotKit/pathfinder/issues/17",
      "",
      "Reconnect storms overwhelmed the gateway because retries were unbounded.",
    ].join("\n");
    expect(stripGitHubMetadataHeader(withIssueHeader)).toBe(
      "Reconnect storms overwhelmed the gateway because retries were unbounded.",
    );
  });
});

describe("enforceDistillation (aimock-backed real judge)", () => {
  const mock = new LLMock({ port: 0, logLevel: "silent" });
  let judge: DistillationJudge;

  beforeAll(async () => {
    for (const f of fixtures) mock.addFixture(f);
    await mock.start();
    const distiller = new OpenAIDistiller({
      baseURL: `${mock.url}/v1`,
      apiKey: "mock",
    });
    judge = { judge: (c) => distiller.judgeDistillation(c) };
  });

  afterAll(async () => {
    await mock.stop();
  });

  beforeEach(() => {
    mock.resetMatchCounts();
  });

  it("NEVER drops: same-length, same-order output, and inputs are not mutated", async () => {
    const inputs = [
      makeCandidate({ title: WHY_TITLE, content: WHY_CONTENT, subsystem: "a" }),
      makeCandidate({
        title: INVENTORY_TITLE,
        content: INVENTORY_CONTENT,
        subsystem: "b",
      }),
    ];
    const frozenTitles = inputs.map((c) => c.title);
    const frozenValidatedAgainst = inputs.map(
      (c) => c.provenance.validated_against,
    );

    const out = await enforceDistillation(inputs, { judge });

    expect(out).toHaveLength(inputs.length);
    expect(out.map((c) => c.subsystem)).toEqual(["a", "b"]);
    // Inputs untouched (pure transform).
    expect(inputs.map((c) => c.title)).toEqual(frozenTitles);
    expect(inputs.map((c) => c.provenance.validated_against)).toEqual(
      frozenValidatedAgainst,
    );
  });

  it("distilled candidate → NO restatement floor; approvability decided by the behavior/unverified rule ALONE", async () => {
    // A `distilled` verdict emits NO restatement marker, so validate's A.2
    // restatement floor never fires. Whatever approvable ends up being is
    // decided ENTIRELY by the SEPARATE behavior/unverified rule — proven two
    // ways below (behavior variant vs. non-behavior variant), both with the
    // marker path confirmed OFF.
    const cand = makeCandidate({ title: WHY_TITLE, content: WHY_CONTENT });
    const [gated] = await enforceDistillation([cand], { judge });

    // No restatement marker emitted.
    expect(gated.provenance.validated_against ?? "").not.toContain(
      RESTATEMENT_MARKER,
    );

    // BEHAVIOR variant (architecture, unverified, no targets, empty registry):
    // it does NOT source/showcase-verify, so it stays `unverified`. Because the
    // restatement floor did NOT fire (no marker), the ONLY thing that can make
    // it non-approvable is the behavior/unverified rule — and it does. This is
    // the meaningful, true behavior of a distilled behavior candidate: it is
    // approvable=false via the BEHAVIOR path, NOT via the restatement floor.
    const validated = await promoteValidation(gated, ctxOn(process.cwd()));
    expect(validated.provenance.classification.validation_status).toBe(
      "unverified",
    );
    // The discriminator: the marker is absent, so approvable=false here is the
    // behavior/unverified rule, not the restatement floor.
    expect(validated.provenance.validated_against ?? "").not.toContain(
      RESTATEMENT_MARKER,
    );
    expect(validated.approvable).toBe(false);

    // NON-BEHAVIOR variant (operational): the behavior/unverified rule does NOT
    // apply, and (again) no restatement marker — so it STAYS approvable. This
    // isolates the behavior rule above as the sole reason the behavior variant
    // was floored, and confirms the marker path stayed off on both.
    const nonBehavior = makeCandidate({
      title: WHY_TITLE,
      content: WHY_CONTENT,
      knowledge_type: "operational",
    });
    const [gatedNonBehavior] = await enforceDistillation([nonBehavior], {
      judge,
    });
    expect(gatedNonBehavior.provenance.validated_against ?? "").not.toContain(
      RESTATEMENT_MARKER,
    );
    const validatedNonBehavior = await promoteValidation(
      gatedNonBehavior,
      ctxOn(process.cwd()),
    );
    expect(validatedNonBehavior.approvable).toBe(true);
  });

  it("pure-WHAT restatement → RESTATEMENT_MARKER emitted → validate floors approvable=false", async () => {
    // The CRITICAL A.1→A.2 coupling. Use an `operational` (NON-behavior) type so
    // the ONLY thing that can set approvable=false is the restatement floor —
    // isolating the marker as the discriminator.
    const cand = makeCandidate({
      title: INVENTORY_TITLE,
      content: INVENTORY_CONTENT,
      knowledge_type: "operational",
    });

    const [gated] = await enforceDistillation([cand], { judge });

    // The marker is stamped onto the carrier S4 reads (validated_against, a
    // "; "-joined whole-token list).
    const tokens = (gated.provenance.validated_against ?? "").split("; ");
    expect(tokens).toContain(RESTATEMENT_MARKER);
    // Not dropped.
    expect(gated.title).toBe(INVENTORY_TITLE);

    // The FLOOR fires end-to-end: validate recomputes approvable=false purely
    // because of the marker (operational is not a behavior type, no targets, so
    // no other path could set it false).
    const validated = await promoteValidation(gated, ctxOn(process.cwd()));
    expect(validated.approvable).toBe(false);
  });

  it("salvageable candidate → rewritten why/how title+content + salvage provenance marker", async () => {
    const cand = makeCandidate({
      title: SALVAGE_TITLE,
      content: SALVAGE_CONTENT,
      knowledge_type: "design-rationale",
    });

    const [gated] = await enforceDistillation([cand], { judge });

    // Content/title swapped for the judge's why/how rewrite.
    expect(gated.title).toBe(SALVAGE_REWRITE_TITLE);
    expect(gated.content).toBe(SALVAGE_REWRITE_CONTENT);
    // Salvage breadcrumb — NOT the restatement floor.
    expect(gated.provenance.validated_against ?? "").toContain(
      REWRITTEN_FROM_RESTATEMENT_MARKER,
    );
    expect(gated.provenance.validated_against ?? "").not.toContain(
      RESTATEMENT_MARKER,
    );

    // A rewritten (salvaged) candidate is NOT floored by the restatement rule.
    // (design-rationale IS a behavior type and stays unverified here, so it will
    // be unapprovable via the BEHAVIOR path — but crucially NOT via the
    // restatement floor. Prove the marker path stayed off by re-running as a
    // non-behavior type.)
    const nonBehavior = makeCandidate({
      title: SALVAGE_TITLE,
      content: SALVAGE_CONTENT,
      knowledge_type: "operational",
    });
    const [gatedNonBehavior] = await enforceDistillation([nonBehavior], {
      judge,
    });
    const validated = await promoteValidation(
      gatedNonBehavior,
      ctxOn(process.cwd()),
    );
    expect(validated.approvable).toBe(true);
  });

  it("restatement→rewritten flip strips a PRIOR run's stale RESTATEMENT_MARKER so validate no longer floors the salvage", async () => {
    // A candidate a PRIOR run ruled a pure `restatement`: it carries the stale
    // floor marker on validated_against. THIS run's judge flips it to
    // `rewritten`. Use an `operational` (NON-behavior) type so the ONLY thing
    // that could floor approvable=false is the restatement marker — isolating
    // the stale marker as the sole discriminator.
    const cand = makeCandidate({
      title: FLIP_TITLE,
      content: FLIP_CONTENT,
      knowledge_type: "operational",
    });
    // Simulate the prior `restatement` run's stamp (alongside a pre-existing real
    // token, to prove we strip ONLY the marker whole-token, not the neighbor).
    cand.provenance.validated_against = `other-token; ${RESTATEMENT_MARKER}`;

    const [gated] = await enforceDistillation([cand], { judge });

    // Salvaged: title/content swapped for the judge's why/how rewrite.
    expect(gated.title).toBe(FLIP_REWRITE_TITLE);
    expect(gated.content).toBe(FLIP_REWRITE_CONTENT);

    const tokens = (gated.provenance.validated_against ?? "").split("; ");
    // The stale floor marker is GONE (this is the fix).
    expect(tokens).not.toContain(RESTATEMENT_MARKER);
    // The pre-existing unrelated token survives (we strip ONLY the marker).
    expect(tokens).toContain("other-token");
    // The salvage breadcrumb is present.
    expect(tokens).toContain(`${REWRITTEN_FROM_RESTATEMENT_MARKER}:${FLIP_REASON}`);
    // No empty tokens accrued.
    expect(tokens.every((t) => t.length > 0)).toBe(true);

    // RED before the fix / GREEN after: with the stale marker stripped, validate's
    // A.2 floor no longer fires, so the salvaged operational candidate is
    // approvable. (Pre-fix the stale marker survived and validate floored it
    // false — the salvage silently defeated.)
    const validated = await promoteValidation(gated, ctxOn(process.cwd()));
    expect(validated.approvable).toBe(true);
  });

  it("a GENUINE current-run restatement STILL stamps the marker and floors approvable=false (strip is rewritten-only)", async () => {
    // Guard: the strip must NOT bleed onto the `restatement` verdict path. A
    // candidate the judge rules a pure restatement THIS run must still be
    // floored. (operational so the marker is the sole discriminator.)
    const cand = makeCandidate({
      title: INVENTORY_TITLE,
      content: INVENTORY_CONTENT,
      knowledge_type: "operational",
    });

    const [gated] = await enforceDistillation([cand], { judge });

    const tokens = (gated.provenance.validated_against ?? "").split("; ");
    expect(tokens).toContain(RESTATEMENT_MARKER);

    const validated = await promoteValidation(gated, ctxOn(process.cwd()));
    expect(validated.approvable).toBe(false);
  });

  it("rewritten reason containing the '; ' delimiter → breadcrumb stays ONE intact token (no fragmentation)", async () => {
    const cand = makeCandidate({
      title: DELIM_SALVAGE_TITLE,
      content: DELIM_SALVAGE_CONTENT,
      knowledge_type: "operational",
    });

    const [gated] = await enforceDistillation([cand], { judge });

    const carrier = gated.provenance.validated_against ?? "";
    const tokens = carrier.split("; ");
    const expectedToken = `${REWRITTEN_FROM_RESTATEMENT_MARKER}:${DELIM_REASON_SANITIZED}`;

    // The breadcrumb is ONE whole token the validate reader will match — the
    // reason's embedded "; " must NOT have fragmented it into fake sub-tokens.
    expect(tokens).toContain(expectedToken);
    // Exactly one carrier token: no fragments, no empties.
    expect(tokens).toHaveLength(1);
    expect(tokens.every((t) => t.length > 0)).toBe(true);
    // The single token itself carries no residual "; " delimiter that would
    // re-fragment on any downstream whole-token split.
    expect(tokens[0]).not.toContain("; ");
  });

  it("re-running the gate over an already-annotated rewritten candidate is IDEMPOTENT (no duplicate-marker growth)", async () => {
    const cand = makeCandidate({
      title: DELIM_SALVAGE_TITLE,
      content: DELIM_SALVAGE_CONTENT,
      knowledge_type: "operational",
    });

    // First pass stamps the breadcrumb. Re-running the gate over the ALREADY
    // rewritten candidate must be a true no-op on the carrier — the model still
    // returns the delimiter-bearing reason, and the whole-token dedup must
    // recognize the existing token rather than append a duplicate.
    const [once] = await enforceDistillation([cand], { judge });
    const [twice] = await enforceDistillation([once], { judge });

    const tokensOnce = (once.provenance.validated_against ?? "").split("; ");
    const tokensTwice = (twice.provenance.validated_against ?? "").split("; ");
    const expectedToken = `${REWRITTEN_FROM_RESTATEMENT_MARKER}:${DELIM_REASON_SANITIZED}`;

    // Idempotent: the re-run carrier equals the first-run carrier.
    expect(twice.provenance.validated_against).toBe(
      once.provenance.validated_against,
    );
    // The breadcrumb appears exactly once after two passes.
    expect(tokensTwice.filter((t) => t === expectedToken)).toHaveLength(1);
    // No token count growth across the re-run.
    expect(tokensTwice).toHaveLength(tokensOnce.length);
    // No empty tokens ever accrue.
    expect(tokensTwice.every((t) => t.length > 0)).toBe(true);
  });

  it("rewritten with an EMPTY reason → bare fixed marker, NO trailing-colon token (finding #2)", async () => {
    const cand = makeCandidate({
      title: EMPTY_REASON_TITLE,
      content: EMPTY_REASON_CONTENT,
      knowledge_type: "operational",
    });

    const [gated] = await enforceDistillation([cand], { judge });

    const carrier = gated.provenance.validated_against ?? "";
    const tokens = carrier.split("; ");

    // The breadcrumb is the FIXED bare marker — not a bare-colon `…:` token.
    expect(tokens).toContain(REWRITTEN_FROM_RESTATEMENT_MARKER);
    expect(tokens).not.toContain(`${REWRITTEN_FROM_RESTATEMENT_MARKER}:`);
    // No token ends with a dangling colon (no empty reason payload).
    expect(tokens.every((t) => !t.endsWith(":"))).toBe(true);
    expect(tokens.every((t) => t.length > 0)).toBe(true);
  });

  it("re-run with a DIFFERENT judge reason is IDEMPOTENT — dedup keys on the stable class prefix, not the reason (finding #1)", async () => {
    const cand = makeCandidate({
      title: NONDET_TITLE,
      content: NONDET_CONTENT,
      knowledge_type: "operational",
    });

    // First pass: reason #1. Re-run over the ALREADY-rewritten candidate: the
    // model now returns a DIFFERENT reason (#2). The dedup MUST recognize the
    // existing breadcrumb by its class prefix and NOT append a duplicate — even
    // though the reason text changed. (The prior exact-token dedup would MISS on
    // the changed reason and grow the carrier unbounded.)
    const [once] = await enforceDistillation([cand], { judge });
    const [twice] = await enforceDistillation([once], { judge });

    // The carrier is BYTE-IDENTICAL across runs regardless of the reason text.
    expect(twice.provenance.validated_against).toBe(
      once.provenance.validated_against,
    );

    const tokensTwice = (twice.provenance.validated_against ?? "").split("; ");
    // Exactly ONE breadcrumb of the class after two passes (no growth).
    const breadcrumbs = tokensTwice.filter(
      (t) =>
        t === REWRITTEN_FROM_RESTATEMENT_MARKER ||
        t.startsWith(`${REWRITTEN_FROM_RESTATEMENT_MARKER}:`),
    );
    expect(breadcrumbs).toHaveLength(1);
    // The first-pass reason is the one preserved (first-write-wins).
    expect(breadcrumbs[0]).toContain(NONDET_REASON_FIRST);
    expect(tokensTwice.every((t) => t.length > 0)).toBe(true);
  });

  // ── Verdict-flip matrix (structural stale-provenance hygiene) ────────────────
  //
  // A re-run can flip a candidate's verdict; the carrier from the PRIOR run must
  // never contradict the NEW one. The fix strips the stale RESTATEMENT_MARKER
  // UNIFORMLY on every non-restatement verdict (so a per-branch fix that missed
  // `distilled` can't recur), and cleans the stale salvage breadcrumb on the
  // restatement verdict. This matrix asserts every flip transition end-to-end
  // through validate.

  it("MATRIX restatement→distilled: stale RESTATEMENT_MARKER stripped so validate no longer floors (the recurring bug — distilled branch)", async () => {
    // The exact defect the structural fix closes: r3-2 fixed the marker strip on
    // the `rewritten` branch but NOT `distilled`. A candidate a PRIOR run ruled a
    // restatement carries the stale floor marker; THIS run's judge rules it a
    // genuine distilled claim. Pre-fix the distilled branch did `{ ...c }` and
    // left the stale marker → validate floored approvable=false FOREVER.
    // operational (non-behavior) so the marker is the SOLE discriminator.
    const cand = makeCandidate({
      title: FLIP_DISTILLED_TITLE,
      content: FLIP_DISTILLED_CONTENT,
      knowledge_type: "operational",
    });
    // Prior `restatement` run's stamp, alongside a real neighbor token.
    cand.provenance.validated_against = `other-token; ${RESTATEMENT_MARKER}`;

    const [gated] = await enforceDistillation([cand], { judge });

    // Distilled: title/content unchanged (no rewrite on this verdict).
    expect(gated.title).toBe(FLIP_DISTILLED_TITLE);
    expect(gated.content).toBe(FLIP_DISTILLED_CONTENT);

    const tokens = (gated.provenance.validated_against ?? "").split("; ");
    // The stale floor marker is GONE (the structural fix).
    expect(tokens).not.toContain(RESTATEMENT_MARKER);
    // The unrelated neighbor token survives (strip ONLY the marker whole-token).
    expect(tokens).toContain("other-token");
    // No salvage breadcrumb on a distilled verdict.
    expect(gated.provenance.validated_against ?? "").not.toContain(
      REWRITTEN_FROM_RESTATEMENT_MARKER,
    );
    expect(tokens.every((t) => t.length > 0)).toBe(true);

    // RED before / GREEN after: floor no longer fires → approvable.
    const validated = await promoteValidation(gated, ctxOn(process.cwd()));
    expect(validated.approvable).toBe(true);
  });

  it("MATRIX restatement→distilled with the marker as the ONLY carrier token → validated_against dropped entirely", async () => {
    // Edge: the stale marker is the sole token. Stripping it must DROP the
    // optional field (canonical "no carrier" shape), not leave an empty string.
    const cand = makeCandidate({
      title: FLIP_DISTILLED_TITLE,
      content: FLIP_DISTILLED_CONTENT,
      knowledge_type: "operational",
    });
    cand.provenance.validated_against = RESTATEMENT_MARKER;

    const [gated] = await enforceDistillation([cand], { judge });

    expect(gated.provenance.validated_against).toBeUndefined();
    const validated = await promoteValidation(gated, ctxOn(process.cwd()));
    expect(validated.approvable).toBe(true);
  });

  it("MATRIX rewritten→restatement: stamps the floor marker AND cleans the stale salvage breadcrumb (slot1a-b)", async () => {
    // A candidate a PRIOR run ruled `rewritten` carries the salvage breadcrumb
    // (and the prior run's salvaged title/content). THIS run's judge rules it a
    // pure restatement. The gate must stamp the floor marker AND strip the
    // contradictory `distilled-from-restatement` breadcrumb so the provenance
    // does not simultaneously claim floor-and-salvage. operational so the marker
    // is the sole approvability discriminator.
    const cand = makeCandidate({
      title: FLIP_TO_RESTATEMENT_TITLE,
      content: FLIP_TO_RESTATEMENT_CONTENT,
      knowledge_type: "operational",
    });
    // Prior `rewritten` run's stamp: the salvage breadcrumb alongside a neighbor.
    cand.provenance.validated_against = `other-token; ${REWRITTEN_FROM_RESTATEMENT_MARKER}:some prior reason`;

    const [gated] = await enforceDistillation([cand], { judge });

    const tokens = (gated.provenance.validated_against ?? "").split("; ");
    // The floor marker is stamped.
    expect(tokens).toContain(RESTATEMENT_MARKER);
    // The contradictory salvage breadcrumb is GONE (slot1a-b fix).
    expect(gated.provenance.validated_against ?? "").not.toContain(
      REWRITTEN_FROM_RESTATEMENT_MARKER,
    );
    // The unrelated neighbor token survives.
    expect(tokens).toContain("other-token");
    expect(tokens.every((t) => t.length > 0)).toBe(true);

    // The floor fires end-to-end.
    const validated = await promoteValidation(gated, ctxOn(process.cwd()));
    expect(validated.approvable).toBe(false);
  });

  it("MATRIX rewritten→restatement cleans the BARE breadcrumb variant too (no reason payload)", async () => {
    const cand = makeCandidate({
      title: FLIP_TO_RESTATEMENT_TITLE,
      content: FLIP_TO_RESTATEMENT_CONTENT,
      knowledge_type: "operational",
    });
    // Bare breadcrumb (empty-reason variant) as the sole prior token.
    cand.provenance.validated_against = REWRITTEN_FROM_RESTATEMENT_MARKER;

    const [gated] = await enforceDistillation([cand], { judge });

    const tokens = (gated.provenance.validated_against ?? "").split("; ");
    expect(tokens).toContain(RESTATEMENT_MARKER);
    expect(tokens).not.toContain(REWRITTEN_FROM_RESTATEMENT_MARKER);
    expect(tokens.every((t) => t.length > 0)).toBe(true);
  });

  it("MATRIX distilled→restatement: floor marker stamped on the flip (baseline arm)", async () => {
    const cand = makeCandidate({
      title: FLIP_DISTILLED_TO_RESTATEMENT_TITLE,
      content: FLIP_DISTILLED_TO_RESTATEMENT_CONTENT,
      knowledge_type: "operational",
    });

    const [gated] = await enforceDistillation([cand], { judge });

    const tokens = (gated.provenance.validated_against ?? "").split("; ");
    expect(tokens).toContain(RESTATEMENT_MARKER);
    const validated = await promoteValidation(gated, ctxOn(process.cwd()));
    expect(validated.approvable).toBe(false);
  });

  it("MATRIX restatement→rewritten: stale floor stripped, salvage breadcrumb stamped (re-asserted in the matrix)", async () => {
    // The transition r3-2 fixed per-branch — re-asserted here so the matrix
    // covers ALL four verdict-flip transitions in one place.
    const cand = makeCandidate({
      title: FLIP_TITLE,
      content: FLIP_CONTENT,
      knowledge_type: "operational",
    });
    cand.provenance.validated_against = `other-token; ${RESTATEMENT_MARKER}`;

    const [gated] = await enforceDistillation([cand], { judge });

    const tokens = (gated.provenance.validated_against ?? "").split("; ");
    expect(tokens).not.toContain(RESTATEMENT_MARKER);
    expect(tokens).toContain("other-token");
    expect(tokens).toContain(`${REWRITTEN_FROM_RESTATEMENT_MARKER}:${FLIP_REASON}`);
    expect(tokens.every((t) => t.length > 0)).toBe(true);

    const validated = await promoteValidation(gated, ctxOn(process.cwd()));
    expect(validated.approvable).toBe(true);
  });

  it("a malformed carrier with empty segments does not accrue empty tokens on annotation", async () => {
    // A pre-existing carrier that is malformed (leading/trailing/adjacent
    // delimiters yield empty segments after split). The gate must not preserve
    // those empties when it appends a new token.
    const cand = makeCandidate({
      title: INVENTORY_TITLE,
      content: INVENTORY_CONTENT,
      knowledge_type: "operational",
    });
    cand.provenance.validated_against = "; existing-token; ; ";

    const [gated] = await enforceDistillation([cand], { judge });
    const tokens = (gated.provenance.validated_against ?? "").split("; ");

    // The restatement marker is present as a whole token.
    expect(tokens).toContain(RESTATEMENT_MARKER);
    // The pre-existing real token survives.
    expect(tokens).toContain("existing-token");
    // No empty tokens accrued from the malformed carrier.
    expect(tokens.every((t) => t.length > 0)).toBe(true);
  });
});
