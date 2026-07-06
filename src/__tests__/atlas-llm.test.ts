// LLM distiller seam tests (plan S1).
//
// ORG RULE: LLM-touching tests use aimock — never vi.fn / vi.mock stubs for the
// model call. We spin up an in-process aimock server (@copilotkit/aimock's
// `LLMock`), point the OpenAI client's baseURL at it, and assert the distiller
// maps the model's JSON output onto the typed CandidateFragment / ExclusionVerdict
// shapes. No real network, fully deterministic.
//
// aimock matches our deterministic prompts via `systemMessage` (the fixed system
// prompt text) so a fixture only fires for the intended operation. A `Fixture`'s
// response `content` must be a STRING (aimock's in-process `addFixture` does not
// JSON.stringify object content the way file-loaded fixtures do — only the
// string form satisfies aimock's text-response guard), so we hand aimock the
// JSON.stringified payload, which our distiller then JSON.parses — exercising the
// real parse → typed-result path.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { LLMock, type Fixture } from "@copilotkit/aimock";

import { OpenAIDistiller } from "../atlas/llm.js";
import { CandidateFragmentSchema } from "../atlas/types.js";

// Stable substrings drawn from the deterministic system prompts in llm.ts. These
// gate each fixture to exactly one operation.
const EPISODIC_SYSTEM_MARKER = "knowledge-distillation engine";
const EXCLUSION_SYSTEM_MARKER = "exclusion-rule judge";

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

// A SECRET-flagged episodic window: the model judged the transcript to contain
// secret material. The distiller must PRESERVE that (floor at internal, keep a
// stronger signal) rather than downgrade it to "internal" — a downgrade would
// strip the restriction and leak the content past the secret exclusion rule.
// Gated on a distinct user-message marker so this fixture never collides with
// the default episodic fixture above.
const SECRET_TRANSCRIPT_MARKER = "ROOT-CREDENTIAL-ROTATION";
const EPISODIC_SECRET_MODEL_OUTPUT = {
  title: "The prod root credential rotates weekly via the sealed rotation job",
  content:
    "The production root credential is rotated weekly by a sealed rotation job; the prior secret is revoked immediately on rotation, so any leaked copy is short-lived. This is why on-call runbooks must re-fetch the credential rather than cache it.",
  subsystem: "secrets-ops",
  knowledge_type: "security",
  sensitivity: "secret",
  validationTargets: [],
};

// A CASE/WHITESPACE-variant window: the model returns "Secret" with stray
// casing/padding (and a padded, cased knowledge_type). Models do this
// nondeterministically; an exact-match lookup would silently DOWNGRADE the
// secret signal to "internal" — the same leak the secret-preservation tests
// guard against, just via formatting instead of omission.
const CASED_SENSITIVITY_MARKER = "CASED-SECRET-WINDOW";
const EPISODIC_CASED_MODEL_OUTPUT = {
  title: "Staging signing keys live in the sealed ops vault, not the repo",
  content:
    "The staging signing keys are stored only in the sealed ops vault and injected at deploy time; they were removed from the repo after the 2025 audit. This is why local builds must fetch a short-lived dev key instead of reading a checked-in one.",
  subsystem: "secrets-ops",
  knowledge_type: " Security ",
  sensitivity: " Secret ",
  validationTargets: [],
};

// An UNRECOGNIZED sensitivity value: not a valid enum member even after
// trim/lowercase. The distiller must NOT silently floor it to "internal"
// (under-classification) — it warns and floors in the MOST restrictive
// direction ("secret") so unclassifiable model judgments never leak.
const UNRECOGNIZED_SENSITIVITY_MARKER = "UNRECOGNIZED-SENSITIVITY-WINDOW";
const EPISODIC_UNRECOGNIZED_MODEL_OUTPUT = {
  title: "Vendor contract renewals are negotiated on a fiscal-Q3 cycle",
  content:
    "All vendor contract renewals are batched into the fiscal Q3 negotiation window so procurement can leverage combined volume. This is why mid-cycle renewal asks are deferred to the batch.",
  subsystem: "procurement",
  knowledge_type: "operational",
  sensitivity: "classified",
  validationTargets: [],
};

// A model subsystem containing ':' (a canonical-key structural delimiter) plus
// padded/blank validationTargets entries. CandidateFragmentSchema rejects ':'
// in subsystem, so without sanitization the distiller's "always parses against
// CandidateFragmentSchema" promise is false on nondeterministic model output.
const COLON_SUBSYSTEM_MARKER = "COLON-SUBSYSTEM-WINDOW";
const EPISODIC_COLON_SUBSYSTEM_OUTPUT = {
  title: "Harvest runs are sharded by adapter to bound LLM spend per run",
  content:
    "Each harvest run shards its work by leaf adapter so a runaway distillation in one source type cannot exhaust the LLM budget of the whole run. This is why per-adapter caps live in the driver, not the adapters.",
  subsystem: "  atlas:harvest  ",
  knowledge_type: "architecture",
  validationTargets: ["  scripts/atlas-harvest.ts  ", "   "],
};

// A model subsystem containing the Notion approval-marker delimiters '⟦'/'⟧'
// (U+27E6/U+27E7). fix8's CandidateFragmentSchema refine rejects them in
// subsystem alongside ':', so without sanitization a marker-bearing model
// subsystem re-breaks the same "always parses against CandidateFragmentSchema"
// promise the ':' case protects.
const MARKER_SUBSYSTEM_MARKER = "MARKER-SUBSYSTEM-WINDOW";
const EPISODIC_MARKER_SUBSYSTEM_OUTPUT = {
  title: "Approval markers wrap canonical keys on the Notion review page",
  content:
    "The Notion sync embeds each candidate's canonical key between '⟦' and '⟧' so hand edits to the surrounding prose cannot corrupt the machine-readable key. extractCanonicalKey slices at the first close delimiter.",
  subsystem: "atlas⟦x⟧y",
  knowledge_type: "architecture",
  validationTargets: [],
};

// A model response that OMITS subsystem, so the CALLER's ctx.subsystem hint is
// what lands in the fragment. The hint is just as untrusted for the ':'
// structural delimiter as model output — the "always parses against
// CandidateFragmentSchema" promise covers caller input too.
const NO_SUBSYSTEM_MARKER = "NO-SUBSYSTEM-WINDOW";
const EPISODIC_NO_SUBSYSTEM_OUTPUT = {
  title: "Per-adapter LLM caps live in the harvest driver, not the adapters",
  content:
    "The harvest driver owns the per-adapter LLM spend caps so a runaway distillation in one source type cannot exhaust the budget of the whole run. Adapters stay cap-unaware, which keeps them testable in isolation.",
  knowledge_type: "architecture",
  validationTargets: [],
};

// The verdicts the "model" returns for the two exclusion-rule calls.
const EXCLUSION_EXCLUDE_OUTPUT = {
  excluded: true,
  reason: "Candidate exposes a customer name, which the rule forbids.",
};
const EXCLUSION_KEEP_OUTPUT = {
  excluded: false,
  reason: "Candidate is a generic architecture fact with no customer data.",
};

// Markers for windows whose "model" response is VALID JSON but NOT an object —
// the distiller must fail loud (same path as a parse failure), never treat a
// bare string / null / array as the expected shape.
const BARE_STRING_MARKER = "BARE-STRING-WINDOW";
const NULL_JSON_MARKER = "NULL-JSON-WINDOW";

// An embedding-input marker whose fixture returns a vector of the WRONG length
// (not this.embeddingDimensions). embed() must SURFACE that (fail loud) rather
// than pass a wrong-dimension vector downstream where it fails opaquely in
// vectorSearch and is swallowed as a silent `semanticFailed`, degrading semantic
// dedup invisibly. A distinct dimension count (7) pins "wrong length", not empty.
const WRONG_DIM_EMBED_MARKER = "WRONG-DIM-EMBED-INPUT";

const fixtures: Fixture[] = [
  // Episodic distillation — model returns a bare JSON string (valid JSON, wrong
  // type). Listed before the catch-all episodic fixture so the specific match wins.
  {
    match: {
      systemMessage: EPISODIC_SYSTEM_MARKER,
      userMessage: BARE_STRING_MARKER,
    },
    response: { content: JSON.stringify("just a bare string, not an object") },
  },
  // Episodic distillation — model returns JSON null.
  {
    match: {
      systemMessage: EPISODIC_SYSTEM_MARKER,
      userMessage: NULL_JSON_MARKER,
    },
    response: { content: "null" },
  },
  // Exclusion rule — model returns a JSON array instead of a verdict object.
  {
    match: {
      systemMessage: EXCLUSION_SYSTEM_MARKER,
      userMessage: "array verdict rule",
    },
    response: { content: "[true]" },
  },
  // Episodic distillation — SECRET: gate on the episodic system prompt AND the
  // secret-transcript marker in the user payload. Listed BEFORE the catch-all
  // episodic fixture so the more specific (system + user) match wins.
  {
    match: {
      systemMessage: EPISODIC_SYSTEM_MARKER,
      userMessage: SECRET_TRANSCRIPT_MARKER,
    },
    response: { content: JSON.stringify(EPISODIC_SECRET_MODEL_OUTPUT) },
  },
  // Episodic distillation — cased/padded "  Secret " sensitivity. Listed before
  // the catch-all episodic fixture so the more specific match wins.
  {
    match: {
      systemMessage: EPISODIC_SYSTEM_MARKER,
      userMessage: CASED_SENSITIVITY_MARKER,
    },
    response: { content: JSON.stringify(EPISODIC_CASED_MODEL_OUTPUT) },
  },
  // Episodic distillation — unrecognized "classified" sensitivity. Listed
  // before the catch-all episodic fixture so the more specific match wins.
  {
    match: {
      systemMessage: EPISODIC_SYSTEM_MARKER,
      userMessage: UNRECOGNIZED_SENSITIVITY_MARKER,
    },
    response: { content: JSON.stringify(EPISODIC_UNRECOGNIZED_MODEL_OUTPUT) },
  },
  // Episodic distillation — ':'-bearing subsystem + padded validationTargets.
  // Listed before the catch-all episodic fixture so the more specific match wins.
  {
    match: {
      systemMessage: EPISODIC_SYSTEM_MARKER,
      userMessage: COLON_SUBSYSTEM_MARKER,
    },
    response: { content: JSON.stringify(EPISODIC_COLON_SUBSYSTEM_OUTPUT) },
  },
  // Episodic distillation — '⟦'/'⟧'-bearing subsystem (approval-marker
  // delimiters). Listed before the catch-all episodic fixture so the more
  // specific match wins.
  {
    match: {
      systemMessage: EPISODIC_SYSTEM_MARKER,
      userMessage: MARKER_SUBSYSTEM_MARKER,
    },
    response: { content: JSON.stringify(EPISODIC_MARKER_SUBSYSTEM_OUTPUT) },
  },
  // Episodic distillation — model OMITS subsystem so the caller hint applies.
  // Listed before the catch-all episodic fixture so the more specific match wins.
  {
    match: {
      systemMessage: EPISODIC_SYSTEM_MARKER,
      userMessage: NO_SUBSYSTEM_MARKER,
    },
    response: { content: JSON.stringify(EPISODIC_NO_SUBSYSTEM_OUTPUT) },
  },
  // Episodic distillation: gate on the episodic system prompt.
  {
    match: { systemMessage: EPISODIC_SYSTEM_MARKER },
    response: { content: JSON.stringify(EPISODIC_MODEL_OUTPUT) },
  },
  // Exclusion rule — EXCLUDE: gate on the exclusion system prompt AND the
  // customer-name rule text appearing in the (user) payload.
  {
    match: {
      systemMessage: EXCLUSION_SYSTEM_MARKER,
      userMessage: "customer names",
    },
    response: { content: JSON.stringify(EXCLUSION_EXCLUDE_OUTPUT) },
  },
  // Exclusion rule — KEEP: gate on the exclusion system prompt AND a different
  // rule text so it never collides with the EXCLUDE fixture.
  {
    match: {
      systemMessage: EXCLUSION_SYSTEM_MARKER,
      userMessage: "secret API keys",
    },
    response: { content: JSON.stringify(EXCLUSION_KEEP_OUTPUT) },
  },
  // Exclusion rule — padded reason: the model wraps its justification in stray
  // whitespace; the verdict must carry the trimmed reason.
  {
    match: {
      systemMessage: EXCLUSION_SYSTEM_MARKER,
      userMessage: "padded reason rule",
    },
    response: {
      content: JSON.stringify({
        excluded: false,
        reason: "  Candidate is a generic fact.  ",
      }),
    },
  },
  // Embedding — WRONG dimension: the "model" returns a 7-element vector even
  // though embed() requested this.embeddingDimensions (1536). embed() must
  // surface the mismatch (fail loud), not pass a wrong-length vector downstream.
  {
    match: { inputText: WRONG_DIM_EMBED_MARKER },
    response: { embedding: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7] },
  },
];

describe("OpenAIDistiller (aimock)", () => {
  const mock = new LLMock({ port: 0, logLevel: "silent" });
  let distiller: OpenAIDistiller;

  beforeAll(async () => {
    for (const f of fixtures) mock.addFixture(f);
    await mock.start();
    // Point the OpenAI client at aimock. A fixed `now` keeps provenance dates
    // deterministic.
    distiller = new OpenAIDistiller({
      baseURL: `${mock.url}/v1`,
      apiKey: "mock",
      now: () => new Date("2026-06-08T00:00:00.000Z"),
    });
  });

  afterAll(async () => {
    await mock.stop();
  });

  beforeEach(() => {
    mock.resetMatchCounts();
  });

  describe("distillEpisodicWindow", () => {
    it("maps the model's JSON output onto a typed, schema-valid CandidateFragment", async () => {
      const fragment = await distiller.distillEpisodicWindow(
        "Alice: why do we get 409s on run updates?\nBob: optimistic concurrency — the run token is stale, refetch and retry.",
        {
          sourceName: "session-abc",
          subsystem: "adk-occ",
          url: "file:///t.jsonl",
        },
      );

      // The returned shape parses against the S0 contract.
      expect(() => CandidateFragmentSchema.parse(fragment)).not.toThrow();

      // Mapped fields come from the model output.
      expect(fragment.sourcetype).toBe("episodic");
      expect(fragment.title).toBe(EPISODIC_MODEL_OUTPUT.title);
      expect(fragment.content).toBe(EPISODIC_MODEL_OUTPUT.content);
      expect(fragment.subsystem).toBe("adk-occ");
      expect(fragment.validationTargets).toEqual([
        "src/runs/optimistic.ts",
        "RunToken",
      ]);

      // Episodic invariants are hard-coded by the distiller (plan S6).
      expect(fragment.needsReview).toBe(true);
      expect(fragment.provenance.classification.validation_status).toBe(
        "unverified",
      );
      // Sensitivity is FLOORED at "internal" when the model omits it (this
      // fixture has no sensitivity field) — never "public", but a stronger
      // model signal is preserved (see the secret-window test below).
      expect(fragment.provenance.classification.sensitivity).toBe("internal");
      expect(fragment.provenance.classification.knowledge_type).toBe(
        "architecture",
      );
      expect(fragment.provenance.classification.provenance_class).toBe(
        "derived",
      );

      // Provenance is stamped from ctx + the injected clock. When ctx omits an
      // explicit asOf, the distiller derives a date-only (YYYY-MM-DD) default —
      // matching every leaf adapter's shape so downstream date dedup/aggregation
      // compares like with like (no full-ISO timestamp on the default path).
      expect(fragment.provenance.source).toBe("session-abc");
      expect(fragment.provenance.url).toBe("file:///t.jsonl");
      expect(fragment.provenance.classification.freshness.as_of).toBe(
        "2026-06-08",
      );
      // provenance.date is derived from the same default and stays in lockstep.
      expect(fragment.provenance.date).toBe("2026-06-08");
    });

    it("PRESERVES a secret sensitivity flagged by the model (no downgrade to internal)", async () => {
      // Regression + data-leak guard: a prior fix hard-set sensitivity to
      // "internal". If the model judges the transcript "secret", forcing
      // "internal" strips the restriction and the content leaks past the secret
      // exclusion rule. The distiller must floor at internal but KEEP the
      // stronger signal.
      const fragment = await distiller.distillEpisodicWindow(
        `Transcript discussing ${SECRET_TRANSCRIPT_MARKER}: the prod root credential rotation.`,
        { sourceName: "session-secret", subsystem: "secrets-ops" },
      );

      expect(() => CandidateFragmentSchema.parse(fragment)).not.toThrow();
      // The secret label is preserved — NOT downgraded to "internal".
      expect(fragment.provenance.classification.sensitivity).toBe("secret");
      // The other episodic invariants still hold (safe, restrictive direction).
      expect(fragment.needsReview).toBe(true);
      expect(fragment.provenance.classification.confidence).toBe("low");
      expect(fragment.provenance.classification.validation_status).toBe(
        "unverified",
      );
      expect(fragment.provenance.classification.provenance_class).toBe(
        "derived",
      );
    });

    it("normalizes a cased/padded model sensitivity ('  Secret ') instead of silently downgrading it", async () => {
      // Models nondeterministically vary casing/whitespace. An exact-match
      // enum lookup treats " Secret " as unrecognized and floors it to
      // "internal" — the same data-leak downgrade the preservation guarantee
      // forbids. trim+lowercase must run BEFORE the enum lookup.
      const fragment = await distiller.distillEpisodicWindow(
        `Transcript window ${CASED_SENSITIVITY_MARKER}: staging signing keys.`,
        { sourceName: "session-cased", subsystem: "secrets-ops" },
      );

      expect(() => CandidateFragmentSchema.parse(fragment)).not.toThrow();
      expect(fragment.provenance.classification.sensitivity).toBe("secret");
      // knowledge_type gets the same trim/lowercase normalization.
      expect(fragment.provenance.classification.knowledge_type).toBe(
        "security",
      );
    });

    it("WARNS and floors an unrecognized non-empty sensitivity to 'secret' (MOST restrictive direction)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const fragment = await distiller.distillEpisodicWindow(
          `Transcript window ${UNRECOGNIZED_SENSITIVITY_MARKER}: vendor renewals.`,
          { sourceName: "session-unrecognized", subsystem: "procurement" },
        );

        // Unclassifiable ≠ harmless: floor in the MOST restrictive direction
        // (finding 5) — never silently to "internal", and not merely
        // "proprietary". A sensitivity the model asserted but we cannot
        // interpret must default to the most protective label so an
        // unclassifiable secret can never leak past the exclusion rules.
        expect(fragment.provenance.classification.sensitivity).toBe("secret");
        // The warning names the discarded value so the operator can see what
        // the model actually said.
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("classified"),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("sanitizes a ':'-bearing model subsystem and trims validationTargets so the fragment stays schema-valid", async () => {
      // ':' is a canonical-key structural delimiter; CandidateFragmentSchema
      // rejects it in subsystem. The distiller promises the returned fragment
      // "always parses against CandidateFragmentSchema" — that must hold for
      // nondeterministic model output too.
      const fragment = await distiller.distillEpisodicWindow(
        `Transcript window ${COLON_SUBSYSTEM_MARKER}: harvest sharding.`,
        { sourceName: "session-colon", subsystem: "atlas-harvest-hint" },
      );

      expect(() => CandidateFragmentSchema.parse(fragment)).not.toThrow();
      expect(fragment.subsystem).toBe("atlas-harvest");
      // Padded entries are trimmed; whitespace-only entries are dropped.
      expect(fragment.validationTargets).toEqual(["scripts/atlas-harvest.ts"]);
    });

    it("sanitizes a '⟦'/'⟧'-bearing model subsystem (approval-marker delimiters) so the fragment stays schema-valid", async () => {
      // fix8's CandidateFragmentSchema refine rejects the Notion approval-marker
      // delimiters '⟦'/'⟧' in subsystem alongside ':'. The distiller's "always
      // parses against CandidateFragmentSchema" promise must hold for a
      // marker-bearing model subsystem too — sanitize, don't blow up later.
      const fragment = await distiller.distillEpisodicWindow(
        `Transcript window ${MARKER_SUBSYSTEM_MARKER}: approval-marker delimiters.`,
        { sourceName: "session-marker", subsystem: "atlas-marker-hint" },
      );

      expect(() => CandidateFragmentSchema.parse(fragment)).not.toThrow();
      expect(fragment.subsystem).toBe("atlas-x-y");
    });

    it("sanitizes a ':'-bearing CALLER subsystem hint when the model omits subsystem", async () => {
      // Same "always parses against CandidateFragmentSchema" promise as the
      // model-output case above, but exercised through the ctx.subsystem
      // fallback: the model omits subsystem, the caller hint carries the ':'
      // structural delimiter — it must be sanitized, not passed through.
      const fragment = await distiller.distillEpisodicWindow(
        `Transcript window ${NO_SUBSYSTEM_MARKER}: driver-owned LLM caps.`,
        { sourceName: "session-caller-hint", subsystem: "atlas:harvest" },
      );

      expect(() => CandidateFragmentSchema.parse(fragment)).not.toThrow();
      expect(fragment.subsystem).toBe("atlas-harvest");
    });

    it("defaults sourceName/subsystem when ctx omits them", async () => {
      const fragment = await distiller.distillEpisodicWindow(
        "Some transcript text mentioning a 409 retry.",
        {},
      );
      // model output carries subsystem "adk-occ"; with no ctx subsystem the
      // model's value wins.
      expect(fragment.subsystem).toBe("adk-occ");
      expect(fragment.source_name).toBe("episodic-memory");
      expect(() => CandidateFragmentSchema.parse(fragment)).not.toThrow();
    });
  });

  describe("non-object JSON guard (fail-loud)", () => {
    it("rejects a bare-string JSON response from distillEpisodicWindow", async () => {
      await expect(
        distiller.distillEpisodicWindow(
          `Transcript window ${BARE_STRING_MARKER}.`,
          {},
        ),
      ).rejects.toThrow(
        "[atlas/llm] expected a JSON object from model during distillEpisodicWindow, got string",
      );
    });

    it("rejects a JSON null response from distillEpisodicWindow", async () => {
      await expect(
        distiller.distillEpisodicWindow(
          `Transcript window ${NULL_JSON_MARKER}.`,
          {},
        ),
      ).rejects.toThrow(
        "[atlas/llm] expected a JSON object from model during distillEpisodicWindow, got null",
      );
    });

    it("rejects a JSON array response from evaluateEnglishExclusionRule", async () => {
      await expect(
        distiller.evaluateEnglishExclusionRule("array verdict rule", {
          title: "Some candidate",
          content: "Some content",
        }),
      ).rejects.toThrow(
        "[atlas/llm] expected a JSON object from model during evaluateEnglishExclusionRule, got array",
      );
    });
  });

  describe("embed (dimension guard, fail-loud)", () => {
    it("SURFACES a wrong-dimension embedding rather than passing it downstream silently", async () => {
      // Bucket (a) finding: embed() only guarded against an empty/non-array
      // vector, NOT a wrong-LENGTH one. A vector whose length !=
      // this.embeddingDimensions would pass this guard, then fail opaquely in
      // vectorSearch (a pgvector dimension mismatch) where the rag-dedup gate
      // swallows it as a counted-but-generic `semanticFailed`, silently degrading
      // semantic dedup. embed() must FAIL LOUD on the mismatch so a
      // wrong-dimension embedding provider is a visible, diagnosable error at the
      // source. aimock returns a 7-element vector for this input while embed
      // requested 1536.
      await expect(
        distiller.embed(`text needing embedding ${WRONG_DIM_EMBED_MARKER}`),
      ).rejects.toThrow(/dimension/i);
    });
  });

  describe("evaluateEnglishExclusionRule", () => {
    it("returns a typed excluded=true verdict with reason", async () => {
      const verdict = await distiller.evaluateEnglishExclusionRule(
        "Exclude anything that names specific customer names.",
        {
          title: "How Acme Corp configured their interrupt flow",
          content: "Acme Corp wired the gen-ui interrupt to...",
          subsystem: "gen-ui",
        },
      );
      expect(verdict.excluded).toBe(true);
      expect(verdict.reason).toBe(EXCLUSION_EXCLUDE_OUTPUT.reason);
    });

    it("returns a typed excluded=false verdict when the rule does not apply", async () => {
      const verdict = await distiller.evaluateEnglishExclusionRule(
        "Exclude anything containing secret API keys.",
        {
          title: "State-render bridge re-renders on snapshot",
          content: "The bridge subscribes to state snapshots and...",
          subsystem: "react-core",
        },
      );
      expect(verdict.excluded).toBe(false);
      expect(verdict.reason).toBe(EXCLUSION_KEEP_OUTPUT.reason);
    });

    it("trims a whitespace-padded model reason", async () => {
      const verdict = await distiller.evaluateEnglishExclusionRule(
        "padded reason rule",
        {
          title: "Some candidate",
          content: "Some content",
        },
      );
      expect(verdict.excluded).toBe(false);
      expect(verdict.reason).toBe("Candidate is a generic fact.");
    });
  });
});

describe("OpenAIDistiller constructor (API-key guard, no LLM calls)", () => {
  // These tests exercise ONLY client construction — no model call, so no aimock
  // fixture is involved. Env is mutated per-test and restored afterEach.
  const ORIG_API_KEY = process.env.OPENAI_API_KEY;
  const ORIG_BASE_URL = process.env.OPENAI_BASE_URL;

  afterEach(() => {
    if (ORIG_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = ORIG_API_KEY;
    if (ORIG_BASE_URL === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = ORIG_BASE_URL;
  });

  it("throws a descriptive missing-config error when no apiKey and no mock baseURL is configured", () => {
    // Without this guard the client silently defaults to apiKey "mock" and the
    // operator gets a confusing 401 at the FIRST REAL model call instead of a
    // clear error at construction (fail-loud discipline).
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    expect(() => new OpenAIDistiller()).toThrow(/OPENAI_API_KEY/);
  });

  it("defaults apiKey to 'mock' when an explicit mock baseURL is passed", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    expect(
      () => new OpenAIDistiller({ baseURL: "http://127.0.0.1:9/v1" }),
    ).not.toThrow();
  });

  it("defaults apiKey to 'mock' when OPENAI_BASE_URL points at a mock server", () => {
    delete process.env.OPENAI_API_KEY;
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:9/v1";
    expect(() => new OpenAIDistiller()).not.toThrow();
  });

  it("falls through an EMPTY-STRING OPENAI_API_KEY to 'mock' when a baseURL is configured", () => {
    // .env templates commonly ship OPENAI_API_KEY="" — an empty string is
    // non-nullish, so a `??` chain would keep it and the !apiKey guard would
    // tell the operator to SET a var that IS set, despite the mock baseURL.
    process.env.OPENAI_API_KEY = "";
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:9/v1";
    expect(() => new OpenAIDistiller()).not.toThrow();
  });

  it("still fails loud on an empty-string OPENAI_API_KEY with NO baseURL", () => {
    process.env.OPENAI_API_KEY = "";
    delete process.env.OPENAI_BASE_URL;
    expect(() => new OpenAIDistiller()).toThrow(/OPENAI_API_KEY/);
  });

  it("accepts an explicit apiKey with no baseURL", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    expect(() => new OpenAIDistiller({ apiKey: "sk-test" })).not.toThrow();
  });

  it("fails loud on a REAL (non-local) baseURL with a missing key — does NOT ship the 'mock' sentinel", () => {
    // A real auth-requiring proxy configured via OPENAI_BASE_URL with the key
    // forgotten must NOT silently default apiKey to "mock" (which surfaces as an
    // opaque 401 downstream at the first model call). Only a CLEARLY-LOCAL /
    // aimock baseURL may use the "mock" sentinel; an arbitrary real endpoint
    // must fail loud at construction (fail-loud discipline).
    delete process.env.OPENAI_API_KEY;
    process.env.OPENAI_BASE_URL = "https://api.some-real-proxy.example.com/v1";
    expect(() => new OpenAIDistiller()).toThrow(/OPENAI_API_KEY/);
  });

  it("fails loud on an explicit real https baseURL passed as an option with no key", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    expect(
      () =>
        new OpenAIDistiller({ baseURL: "https://proxy.internal.example.com/v1" }),
    ).toThrow(/OPENAI_API_KEY/);
  });

  it("still defaults to 'mock' for a localhost baseURL with no key (aimock case preserved)", () => {
    // Regression guard: the local/aimock convenience must survive the fix.
    delete process.env.OPENAI_API_KEY;
    process.env.OPENAI_BASE_URL = "http://localhost:9/v1";
    expect(() => new OpenAIDistiller()).not.toThrow();
  });
});
