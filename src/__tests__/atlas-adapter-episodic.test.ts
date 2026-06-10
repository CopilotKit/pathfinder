// Atlas episodic transcript-window adapter tests (plan S6).
//
// ORG RULE: LLM-touching tests use aimock — never vi.fn / vi.mock stubs for the
// model call. The episodic adapter is the ONLY adapter that requires `ctx.llm`
// (it distills a raw transcript window into why/how prose via the S1
// `LlmDistiller` seam). So this suite mirrors the S1 distiller test
// (atlas-llm.test.ts): spin up an in-process aimock server, point a real
// `OpenAIDistiller` at it, hand THAT to the adapter as `ctx.llm`, feed a fixture
// transcript window, and assert the adapter returns ONE distilled fragment
// carrying the source conversation path as `thread` evidence, with the episodic
// invariants (needsReview=true, validation_status="unverified") preserved.
//
// aimock matches the distiller's deterministic system prompt via `systemMessage`
// (the fixed prompt text from llm.ts) so the fixture fires only for the episodic
// distill call. A `Fixture` response `content` must be a STRING (aimock's
// in-process `addFixture` does not JSON.stringify object content — only the
// string form satisfies its text-response guard, per S1's finding), so we hand
// aimock the JSON.stringified payload, which the distiller then JSON.parses.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LLMock, type Fixture } from "@copilotkit/aimock";

import { ZodError } from "zod";

import { episodicAdapter } from "../atlas/adapters/episodic.js";
import type { EpisodicWindowUnit } from "../atlas/adapters/episodic.js";
import type { AdapterContext } from "../atlas/adapters/types.js";
import { OpenAIDistiller } from "../atlas/llm.js";
import { CandidateFragmentSchema, type Sensitivity } from "../atlas/types.js";

// Stable substring drawn from the deterministic episodic system prompt in
// llm.ts. Gates the fixture to exactly the episodic distill operation.
const EPISODIC_SYSTEM_MARKER = "knowledge-distillation engine";

// The distilled-fragment JSON the "model" returns for the episodic call.
const EPISODIC_MODEL_OUTPUT = {
  title:
    "ADK runs use optimistic concurrency; a stale run token yields a 409 the client must refetch-and-retry",
  content:
    "When an ADK agent run is updated, the server compares the caller's run token against the persisted one. A mismatch means another writer advanced the run, so the server returns 409 rather than clobbering state. Clients must refetch the current run and retry, which is why the run lifecycle treats 409 as a normal control-flow signal rather than an error.",
  subsystem: "adk-occ",
  knowledge_type: "architecture",
  validationTargets: ["src/runs/optimistic.ts", "RunToken"],
};

// A model output that OMITS `subsystem` entirely — used to prove the window's
// subsystem hint actually reaches the distill context (the hint path is only
// exercised when the model has no subsystem of its own to win with).
const NO_SUBSYSTEM_MARKER = "NO-SUBSYSTEM-WINDOW";
const EPISODIC_NO_SUBSYSTEM_OUTPUT = {
  title: "Run updates retry on 409 because the run token is optimistic",
  content:
    "Run updates carry an optimistic run token; a stale token yields a 409 and the client refetches and retries. The retry is normal control flow, not an error.",
  knowledge_type: "architecture",
  validationTargets: [],
};

const fixtures: Fixture[] = [
  // Omitted-subsystem variant — listed BEFORE the catch-all so the more
  // specific (system + user) match wins.
  {
    match: {
      systemMessage: EPISODIC_SYSTEM_MARKER,
      userMessage: NO_SUBSYSTEM_MARKER,
    },
    response: { content: JSON.stringify(EPISODIC_NO_SUBSYSTEM_OUTPUT) },
  },
  {
    match: { systemMessage: EPISODIC_SYSTEM_MARKER },
    response: { content: JSON.stringify(EPISODIC_MODEL_OUTPUT) },
  },
];

// A real-shaped episodic transcript window the way the S18 driver / S19 harness
// will hand it over: the source conversation path, the window date, and the raw
// transcript text.
const CONV_PATH =
  "~/.claude/projects/-Users-jpr5/sessions/2026-06-07-adk-run-409.jsonl";
const WINDOW: EpisodicWindowUnit = {
  convPath: CONV_PATH,
  date: "2026-06-07",
  text: "Alice: why do we get 409s on run updates?\nBob: optimistic concurrency — the run token is stale, refetch and retry.",
  subsystem: "adk-occ",
};

describe("episodic leaf adapter (aimock)", () => {
  const mock = new LLMock({ port: 0, logLevel: "silent" });
  let llm: OpenAIDistiller;
  let ctx: AdapterContext;

  beforeAll(async () => {
    for (const f of fixtures) mock.addFixture(f);
    await mock.start();
    // A real distiller pointed at aimock IS the `ctx.llm` the adapter calls — no
    // vi.fn stub. A fixed `now` keeps provenance dates deterministic.
    llm = new OpenAIDistiller({
      baseURL: `${mock.url}/v1`,
      apiKey: "mock",
      now: () => new Date("2026-06-08T00:00:00.000Z"),
    });
    // AdapterContext.llm is the concrete S1 LlmDistiller, which OpenAIDistiller
    // implements — no cast needed. This IS the real distiller the adapter calls
    // (pointed at aimock), not a stub.
    ctx = { now: new Date("2026-06-08T00:00:00.000Z"), llm };
  });

  afterAll(async () => {
    await mock.stop();
  });

  beforeEach(() => {
    mock.resetMatchCounts();
  });

  it("declares the episodic sourcetype", () => {
    expect(episodicAdapter.sourcetype).toBe("episodic");
  });

  it("distills one transcript window into exactly one fragment", async () => {
    const out = await episodicAdapter.extract(WINDOW, ctx);
    expect(out).toHaveLength(1);
  });

  it("returns a schema-valid fragment with the distilled claim mapped through", async () => {
    const [fragment] = await episodicAdapter.extract(WINDOW, ctx);

    // The returned shape parses against the S0 contract.
    expect(() => CandidateFragmentSchema.parse(fragment)).not.toThrow();

    // The distilled claim (title/content/validationTargets) comes straight from
    // the LLM seam — the adapter does not rewrite it.
    expect(fragment.sourcetype).toBe("episodic");
    expect(fragment.title).toBe(EPISODIC_MODEL_OUTPUT.title);
    expect(fragment.content).toBe(EPISODIC_MODEL_OUTPUT.content);
    expect(fragment.validationTargets).toEqual([
      "src/runs/optimistic.ts",
      "RunToken",
    ]);
  });

  it("attaches the source conversation path as `thread` evidence", async () => {
    const [fragment] = await episodicAdapter.extract(WINDOW, ctx);

    const threadEvidence = fragment.evidence.filter((e) => e.kind === "thread");
    expect(threadEvidence).toHaveLength(1);
    // The conv path must be recoverable from the evidence body so a reviewer can
    // trace the fragment back to its source transcript.
    expect(threadEvidence[0]).toMatchObject({ kind: "thread" });
    if (threadEvidence[0]?.kind === "thread") {
      expect(threadEvidence[0].body).toContain(CONV_PATH);
    }
  });

  it("preserves the episodic invariants: needsReview + unverified + derived", async () => {
    const [fragment] = await episodicAdapter.extract(WINDOW, ctx);

    // Episodic knowledge is never self-verifying (spec §6 / plan S6).
    expect(fragment.needsReview).toBe(true);
    expect(fragment.provenance.classification.validation_status).toBe(
      "unverified",
    );
    expect(fragment.provenance.classification.provenance_class).toBe("derived");
  });

  it("threads the window date + conv path into the distill context (provenance)", async () => {
    const [fragment] = await episodicAdapter.extract(WINDOW, ctx);

    // The window date is handed to the distiller as `asOf`, so it lands on
    // provenance freshness rather than the injected clock.
    expect(fragment.provenance.classification.freshness.as_of).toBe(
      "2026-06-07",
    );
    // The conv path is the provenance url + source label so the fragment is
    // traceable to its transcript.
    expect(fragment.provenance.url).toBe(CONV_PATH);
    expect(fragment.provenance.source).toBe(CONV_PATH);
    // The top-level provenance.date carries the SAME window date as
    // freshness.as_of — canonicalize.ts reads provenance.date (not
    // freshness.as_of) for recency() and supersedes(), so a fragment without
    // it would get neutral recency and never win supersession.
    expect(fragment.provenance.date).toBe("2026-06-07");
    expect(fragment.provenance.date).toBe(
      fragment.provenance.classification.freshness.as_of,
    );
  });

  it("uses the window subsystem hint when the model omits a subsystem", async () => {
    // This fixture's model output has NO `subsystem` field, so the only way the
    // fragment can carry one is via the window hint threaded through the
    // distill context (model output wins, else the hint, else "unknown").
    const hintWindow: EpisodicWindowUnit = {
      convPath: CONV_PATH,
      date: "2026-06-07",
      text: `Transcript window ${NO_SUBSYSTEM_MARKER}: why 409s retry.`,
      subsystem: "run-lifecycle-hint",
    };
    const [fragment] = await episodicAdapter.extract(hintWindow, ctx);
    expect(fragment.subsystem).toBe("run-lifecycle-hint");
  });

  it("emits nothing (and burns no LLM call) for an empty/whitespace window", async () => {
    // A content-free window cannot yield a durable claim — distilling it would
    // burn an LLM call and emit a knowledge-free fragment. Match the sibling
    // adapters (linear / source-comment / showcase) and emit nothing.
    mock.clearRequests();

    const emptyWindow: EpisodicWindowUnit = {
      convPath: CONV_PATH,
      date: "2026-06-07",
      text: "",
    };
    await expect(episodicAdapter.extract(emptyWindow, ctx)).resolves.toEqual(
      [],
    );

    const whitespaceWindow: EpisodicWindowUnit = {
      convPath: CONV_PATH,
      date: "2026-06-07",
      text: "   \n\t  ",
    };
    await expect(
      episodicAdapter.extract(whitespaceWindow, ctx),
    ).resolves.toEqual([]);

    // No request ever reached the model.
    expect(mock.getRequests()).toHaveLength(0);
  });

  // Helper: build a distiller that returns an episodic fragment with a chosen
  // sensitivity (and an escalated confidence:"high" to prove the confidence
  // clamp still fires). Lets each sensitivity case share one stub.
  //
  // AIMOCK EXEMPTION (deliberate): this hand-rolled object stubs the
  // `LlmDistiller` SEAM (the adapter's ctx.llm interface), NOT the model HTTP
  // call — there is no LLM request to record/replay here. The org "aimock for
  // LLM-touching tests" rule (file header) governs mocking the MODEL CALL,
  // which the suite above does via a real OpenAIDistiller pointed at aimock.
  // This stub exists solely to feed the adapter adversarial distiller OUTPUT
  // (escalated confidence / chosen sensitivity) and prove the adapter's own
  // clamp logic — input shapes a real distiller pinned by aimock fixtures
  // cannot produce.
  //
  // The parameter is a bare `string | undefined` cast through the seam: the
  // threat model is an UNTYPED LlmDistiller implementation, so the stub must be
  // able to hand the adapter an out-of-enum sensitivity (e.g. "confidential")
  // or none at all.
  function distillerWithSensitivity(
    sensitivity: string | undefined,
  ): AdapterContext["llm"] {
    return {
      async distillEpisodicWindow() {
        return {
          sourcetype: "episodic",
          subsystem: "adk-occ",
          source_name: CONV_PATH,
          title: "leaky title",
          content: "leaky content prose explaining a durable claim.",
          provenance: {
            source: CONV_PATH,
            url: CONV_PATH,
            date: "2026-06-07",
            classification: {
              sensitivity: sensitivity as Sensitivity,
              knowledge_type: "architecture",
              audience: "all-staff",
              validation_status: "unverified",
              confidence: "high",
              provenance_class: "derived",
              freshness: { as_of: "2026-06-07" },
            },
          },
          evidence: [],
          needsReview: true,
          validationTargets: [],
        };
      },
      async evaluateEnglishExclusionRule() {
        return { excluded: false };
      },
    };
  }

  it("clamps confidence to low but FLOORS sensitivity at internal (never downgrades a stronger signal)", async () => {
    // The safe, restrictive-direction episodic invariants (confidence:"low") are
    // non-negotiable (spec §6 / plan S6) and the adapter must clamp a distiller
    // that escalates confidence. But sensitivity is a SECURITY label: forcing it
    // to "internal" would REMOVE a "secret"/"proprietary" restriction and leak
    // sensitive content past DEFAULT_EXCLUSION_RULES. So sensitivity is floored
    // at "internal" (never "public"), but a stronger distiller signal is kept.

    // public → floored up to internal.
    const [pubFrag] = await episodicAdapter.extract(WINDOW, {
      now: new Date("2026-06-08T00:00:00.000Z"),
      llm: distillerWithSensitivity("public"),
    });
    expect(pubFrag.provenance.classification.confidence).toBe("low");
    expect(pubFrag.provenance.classification.sensitivity).toBe("internal");

    // internal → unchanged (confidence still clamps).
    const [intFrag] = await episodicAdapter.extract(WINDOW, {
      now: new Date("2026-06-08T00:00:00.000Z"),
      llm: distillerWithSensitivity("internal"),
    });
    expect(intFrag.provenance.classification.confidence).toBe("low");
    expect(intFrag.provenance.classification.sensitivity).toBe("internal");

    // secret → PRESERVED (the data-leak regression: must NOT downgrade to internal).
    const [secretFrag] = await episodicAdapter.extract(WINDOW, {
      now: new Date("2026-06-08T00:00:00.000Z"),
      llm: distillerWithSensitivity("secret"),
    });
    expect(secretFrag.provenance.classification.confidence).toBe("low");
    expect(secretFrag.provenance.classification.sensitivity).toBe("secret");

    // proprietary → PRESERVED (also stronger than internal); confidence still
    // clamps — the clamp must hold on EVERY sensitivity variant.
    const [propFrag] = await episodicAdapter.extract(WINDOW, {
      now: new Date("2026-06-08T00:00:00.000Z"),
      llm: distillerWithSensitivity("proprietary"),
    });
    expect(propFrag.provenance.classification.confidence).toBe("low");
    expect(propFrag.provenance.classification.sensitivity).toBe("proprietary");
  });

  it("REJECTS an out-of-enum distiller sensitivity loudly instead of laundering it to internal", async () => {
    // mostRestrictiveSensitivity ranks by SENSITIVITY_ORDER.indexOf, which
    // treats an unrecognized value as LOWEST (indexOf === -1). An unguarded
    // clamp would therefore pre-sanitize an out-of-enum sensitivity like
    // "confidential" to "internal" — the LEAK direction — and the fail-loud
    // CandidateFragmentSchema.parse below it would never see the bad value.
    // The adapter must instead let the raw value reach the parse, which
    // rejects it with a Zod enum error.
    await expect(
      episodicAdapter.extract(WINDOW, {
        now: new Date("2026-06-08T00:00:00.000Z"),
        llm: distillerWithSensitivity("confidential"),
      }),
    ).rejects.toThrow(ZodError);
    await expect(
      episodicAdapter.extract(WINDOW, {
        now: new Date("2026-06-08T00:00:00.000Z"),
        llm: distillerWithSensitivity("confidential"),
      }),
    ).rejects.toThrow(/sensitivity/);
  });

  it("defaults an OMITTED distiller sensitivity to internal (the floor, not a throw)", async () => {
    // Regression pin for the enum-membership guard: `undefined` means the
    // distiller asserted NO sensitivity, which is the documented "ordinary
    // internal knowledge" default — it must keep flooring to "internal", not
    // start rejecting.
    const [frag] = await episodicAdapter.extract(WINDOW, {
      now: new Date("2026-06-08T00:00:00.000Z"),
      llm: distillerWithSensitivity(undefined),
    });
    expect(frag.provenance.classification.sensitivity).toBe("internal");
  });

  it("throws a clear error when ctx.llm is absent (episodic REQUIRES the LLM)", async () => {
    const noLlmCtx: AdapterContext = {
      now: new Date("2026-06-08T00:00:00.000Z"),
    };
    await expect(episodicAdapter.extract(WINDOW, noLlmCtx)).rejects.toThrow(
      /llm/i,
    );
  });
});
