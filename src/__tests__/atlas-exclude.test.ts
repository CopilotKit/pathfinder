// Exclusion-rule engine tests (plan S13 / §4.8).
//
// Two rule kinds, two test strategies in one file:
//
//   • flag rules  → evaluated DIRECTLY on `candidate.provenance.classification`
//     (no LLM). These tests are PURE — no aimock, no network — and assert that
//     e.g. `sensitivity:proprietary` / `sensitivity:secret` candidates are
//     dropped while others survive.
//
//   • english rules → routed through `llm.evaluateEnglishExclusionRule`. ORG
//     RULE: LLM-touching tests use aimock — never vi.fn / vi.mock stubs. We spin
//     up an in-process aimock server (`LLMock`), point a real `OpenAIDistiller`
//     at it (mirroring atlas-llm.test.ts), and gate fixtures on the deterministic
//     exclusion system prompt plus a candidate-only sentinel (see the fixture
//     block below for why the rule text alone can't gate). Fixture `content` is a
//     JSON STRING (aimock's in-process `addFixture` only satisfies the
//     text-response guard for string content), which the distiller then
//     JSON.parses — exercising the real parse → typed-verdict path.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LLMock, type Fixture } from "@copilotkit/aimock";

import {
  DEFAULT_EXCLUSION_RULES,
  applyExclusions,
  type ExclusionRule,
} from "../atlas/exclude.js";
import { OpenAIDistiller } from "../atlas/llm.js";
import type { Candidate, Classification } from "../atlas/types.js";

// Stable substring from llm.ts's deterministic exclusion system prompt; gates
// every english-rule fixture to the exclusion operation (never the episodic one).
const EXCLUSION_SYSTEM_MARKER = "exclusion-rule judge";

// ── Candidate fixture builder ───────────────────────────────────────────────--
//
// A finalized Candidate (S0 contract): a CandidateFragment + canonical_key /
// rankScore / approvable. We only vary the fields the exclusion engine reads
// (title, content, subsystem, provenance.classification); everything else is a
// stable, schema-valid default.

function classification(over: Partial<Classification> = {}): Classification {
  return {
    sensitivity: "internal",
    knowledge_type: "architecture",
    audience: "all-staff",
    validation_status: "source-verified",
    confidence: "high",
    provenance_class: "primary",
    freshness: { as_of: "2026-06-08T00:00:00.000Z" },
    ...over,
  };
}

function makeCandidate(over: {
  title?: string;
  content?: string;
  subsystem?: string;
  canonical_key?: string;
  classification?: Partial<Classification>;
}): Candidate {
  const subsystem = over.subsystem ?? "generic";
  const title = over.title ?? "A generic architecture fact";
  return {
    sourcetype: "agent-doc",
    subsystem,
    source_name: "test",
    title,
    content: over.content ?? "Some why/how prose explaining the claim.",
    provenance: {
      source: "test",
      date: "2026-06-08T00:00:00.000Z",
      classification: classification(over.classification),
    },
    evidence: [],
    needsReview: false,
    validationTargets: [],
    canonical_key:
      over.canonical_key ?? `agent-doc:${subsystem}:${title.slice(0, 12)}`,
    rankScore: 1,
    approvable: true,
  };
}

// ── Pure flag-rule tests (NO LLM) ──────────────────────────────────────────────

describe("applyExclusions — flag rules (pure, no LLM)", () => {
  // A distiller that throws if any english-rule call is made — proves the flag
  // path never touches the LLM seam.
  const throwingLlm = {
    distillEpisodicWindow: () => {
      throw new Error("distillEpisodicWindow must not be called by flag rules");
    },
    evaluateEnglishExclusionRule: () => {
      throw new Error(
        "evaluateEnglishExclusionRule must not be called for flag rules",
      );
    },
    judgeDistillation: () => {
      throw new Error("judgeDistillation must not be called by flag rules");
    },
    embed: () => {
      throw new Error("embed must not be called by flag rules");
    },
    distillDelta: () => {
      throw new Error("distillDelta must not be called by flag rules");
    },
  };

  it("drops a candidate whose classification[dimension] === equals", async () => {
    const proprietary = makeCandidate({
      title: "Proprietary pricing model internals",
      subsystem: "pricing",
      classification: { sensitivity: "proprietary" },
    });
    const internal = makeCandidate({
      title: "Internal architecture note",
      subsystem: "core",
      classification: { sensitivity: "internal" },
    });

    const rule: ExclusionRule = {
      kind: "flag",
      dimension: "sensitivity",
      equals: "proprietary",
    };

    const { kept, excluded } = await applyExclusions(
      [proprietary, internal],
      [rule],
      throwingLlm,
    );

    expect(kept).toHaveLength(1);
    expect(kept[0]!.canonical_key).toBe(internal.canonical_key);
    expect(excluded).toHaveLength(1);
    expect(excluded[0]!.candidate.canonical_key).toBe(
      proprietary.canonical_key,
    );
    expect(excluded[0]!.rule).toEqual(rule);
  });

  it("evaluates flag rules over a non-sensitivity dimension", async () => {
    const derived = makeCandidate({
      title: "A derived claim",
      classification: { provenance_class: "derived" },
    });
    const primary = makeCandidate({
      title: "A primary claim",
      classification: { provenance_class: "primary" },
    });

    const rule: ExclusionRule = {
      kind: "flag",
      dimension: "provenance_class",
      equals: "derived",
    };

    const { kept, excluded } = await applyExclusions(
      [derived, primary],
      [rule],
      throwingLlm,
    );

    expect(kept.map((c) => c.canonical_key)).toEqual([primary.canonical_key]);
    expect(excluded.map((e) => e.candidate.canonical_key)).toEqual([
      derived.canonical_key,
    ]);
  });

  it("keeps everything when no flag rule matches", async () => {
    const a = makeCandidate({ title: "Public fact A" });
    const b = makeCandidate({ title: "Public fact B" });

    const rule: ExclusionRule = {
      kind: "flag",
      dimension: "sensitivity",
      equals: "secret",
    };

    const { kept, excluded } = await applyExclusions(
      [a, b],
      [rule],
      throwingLlm,
    );

    expect(kept).toHaveLength(2);
    expect(excluded).toHaveLength(0);
  });

  it("DEFAULT_EXCLUSION_RULES drops proprietary AND secret candidates directly", async () => {
    const proprietary = makeCandidate({
      title: "Proprietary internals",
      classification: { sensitivity: "proprietary" },
    });
    const secret = makeCandidate({
      title: "A secret value doc",
      classification: { sensitivity: "secret" },
    });
    const internal = makeCandidate({
      title: "An internal architecture fact",
      classification: { sensitivity: "internal" },
    });

    // Only the flag rules in the default set; the english rules in the default
    // set never fire here because the throwingLlm would blow up — and these
    // generic candidates don't trip them. To keep this test pure, pass ONLY the
    // flag subset of the defaults.
    const flagDefaults = DEFAULT_EXCLUSION_RULES.filter(
      (r): r is Extract<ExclusionRule, { kind: "flag" }> => r.kind === "flag",
    );

    const { kept, excluded } = await applyExclusions(
      [proprietary, secret, internal],
      flagDefaults,
      throwingLlm,
    );

    expect(kept.map((c) => c.canonical_key)).toEqual([internal.canonical_key]);
    expect(excluded.map((e) => e.candidate.canonical_key).sort()).toEqual(
      [proprietary.canonical_key, secret.canonical_key].sort(),
    );
  });

  it("exposes DEFAULT_EXCLUSION_RULES covering proprietary, secret, creds, and customer GTM", () => {
    // Flag rules drop proprietary + secret.
    const flagRules = DEFAULT_EXCLUSION_RULES.filter((r) => r.kind === "flag");
    const droppedSensitivities = flagRules
      .filter((r) => r.dimension === "sensitivity")
      .map((r) => r.equals)
      .sort();
    expect(droppedSensitivities).toEqual(["proprietary", "secret"]);

    // English rules cover credentials + customer-identifying GTM.
    const englishRules = DEFAULT_EXCLUSION_RULES.filter(
      (r): r is Extract<ExclusionRule, { kind: "english" }> =>
        r.kind === "english",
    );
    expect(englishRules.length).toBeGreaterThanOrEqual(2);
    const joined = englishRules.map((r) => r.text.toLowerCase()).join(" | ");
    expect(joined).toMatch(/credential|secret|api key|token|password/);
    expect(joined).toMatch(/customer|client|account/);
  });
});

// ── English-rule tests (aimock) ────────────────────────────────────────────────
//
// FIXTURE GATING — the subtlety that makes this realistic:
//
// The user payload aimock sees is `JSON.stringify({ rule, candidate })`, so the
// RULE text is present on EVERY call for a given rule, regardless of candidate.
// Gating the EXCLUDE verdict on the rule text alone would (wrongly) exclude every
// candidate. So we gate the EXCLUDE verdict on a sentinel that lives ONLY in the
// MATCHING candidate's content (`ATHENA_SENTINEL`), never in the rule text, and
// add a catch-all KEEP fixture (same system marker, no candidate gate) LAST.
// matchFixture is first-match-wins in array order (router.ts), so a candidate
// carrying the sentinel hits EXCLUDE; any other candidate falls through to KEEP.
// This models the real LLM: "is THIS candidate about the thing the rule names?"

const ATHENA_RULE = "Exclude anything about the Athena customer engagement.";
// Sentinel embedded in the matching candidate's content; absent from the rule.
const ATHENA_SENTINEL = "PROJECT-ATHENA-DEAL";

const EXCLUDE_VERDICT = {
  excluded: true,
  reason: "Candidate describes the Athena engagement, which the rule forbids.",
};
const KEEP_VERDICT = {
  excluded: false,
  reason: "Candidate is unrelated to the rule.",
};

const fixtures: Fixture[] = [
  // EXCLUDE — gate on the exclusion system prompt AND the candidate-only sentinel
  // (so ONLY the Athena candidate trips it, not every candidate seeing the rule).
  // Listed FIRST so it wins over the catch-all below.
  {
    match: {
      systemMessage: EXCLUSION_SYSTEM_MARKER,
      userMessage: ATHENA_SENTINEL,
    },
    response: { content: JSON.stringify(EXCLUDE_VERDICT) },
  },
  // KEEP (catch-all) — any exclusion-rule call whose candidate lacks the sentinel
  // gets excluded=false. Last in order so it only fires when EXCLUDE didn't match.
  {
    match: { systemMessage: EXCLUSION_SYSTEM_MARKER },
    response: { content: JSON.stringify(KEEP_VERDICT) },
  },
];

// The credential english rule as it ships in DEFAULT_EXCLUSION_RULES. Pulled from
// the default set so the test tracks the real rule text the engine sees.
const CRED_RULE = DEFAULT_EXCLUSION_RULES.find(
  (r): r is Extract<ExclusionRule, { kind: "english" }> =>
    r.kind === "english" && /credential|api key|token|password/i.test(r.text),
)!;

describe("applyExclusions — english rules (aimock)", () => {
  const mock = new LLMock({ port: 0, logLevel: "silent" });
  let llm: OpenAIDistiller;

  beforeAll(async () => {
    for (const f of fixtures) mock.addFixture(f);
    await mock.start();
    llm = new OpenAIDistiller({
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

  it("excludes the candidate the english rule matches, keeps the others", async () => {
    const athena = makeCandidate({
      title: "How we shipped the Athena gateway",
      content: `During the ${ATHENA_SENTINEL} we wired the gateway to the new flow.`,
      subsystem: "gateway",
      canonical_key: "agent-doc:gateway:athena",
    });
    const other = makeCandidate({
      title: "State-render bridge re-renders on snapshot",
      content: "The bridge subscribes to state snapshots and re-renders.",
      subsystem: "react-core",
      canonical_key: "agent-doc:react-core:bridge",
    });

    const rule: ExclusionRule = { kind: "english", text: ATHENA_RULE };

    const { kept, excluded } = await applyExclusions(
      [athena, other],
      [rule],
      llm,
    );

    expect(kept.map((c) => c.canonical_key)).toEqual([other.canonical_key]);
    expect(excluded).toHaveLength(1);
    expect(excluded[0]!.candidate.canonical_key).toBe(athena.canonical_key);
    expect(excluded[0]!.rule).toEqual(rule);
  });

  it("keeps a candidate when the english rule's verdict is excluded=false", async () => {
    const cand = makeCandidate({
      title: "A generic architecture fact",
      content: "Nothing sensitive here.",
      canonical_key: "agent-doc:generic:keep",
    });

    const rule: ExclusionRule = { kind: "english", text: ATHENA_RULE };

    const { kept, excluded } = await applyExclusions([cand], [rule], llm);

    expect(kept.map((c) => c.canonical_key)).toEqual([cand.canonical_key]);
    expect(excluded).toHaveLength(0);
  });

  it("mixes flag + english rules: flag drops directly, english via LLM", async () => {
    const proprietary = makeCandidate({
      title: "Proprietary internals",
      subsystem: "pricing",
      canonical_key: "agent-doc:pricing:prop",
      classification: { sensitivity: "proprietary" },
    });
    const athena = makeCandidate({
      title: "Athena rollout notes",
      content: `Notes from the ${ATHENA_SENTINEL} kickoff.`,
      subsystem: "gateway",
      canonical_key: "agent-doc:gateway:athena2",
    });
    const keeper = makeCandidate({
      title: "A safe internal fact",
      content: "Generic safe content.",
      subsystem: "core",
      canonical_key: "agent-doc:core:safe",
    });

    const rules: ExclusionRule[] = [
      { kind: "flag", dimension: "sensitivity", equals: "proprietary" },
      { kind: "english", text: ATHENA_RULE },
    ];

    const { kept, excluded } = await applyExclusions(
      [proprietary, athena, keeper],
      rules,
      llm,
    );

    expect(kept.map((c) => c.canonical_key)).toEqual([keeper.canonical_key]);
    expect(excluded.map((e) => e.candidate.canonical_key).sort()).toEqual(
      [proprietary.canonical_key, athena.canonical_key].sort(),
    );
    // The proprietary candidate was excluded by the FLAG rule (no LLM), the
    // Athena one by the ENGLISH rule.
    const propEntry = excluded.find(
      (e) => e.candidate.canonical_key === proprietary.canonical_key,
    )!;
    expect(propEntry.rule.kind).toBe("flag");
    const athenaEntry = excluded.find(
      (e) => e.candidate.canonical_key === athena.canonical_key,
    )!;
    expect(athenaEntry.rule.kind).toBe("english");
  });

  it("a candidate excluded by the first matching rule is not double-counted", async () => {
    // proprietary candidate would also match an english rule, but flag-rule
    // exclusion short-circuits — it appears exactly once in `excluded`.
    const propAthena = makeCandidate({
      title: "Proprietary Athena internals",
      content: `${ATHENA_SENTINEL}, proprietary.`,
      subsystem: "gateway",
      canonical_key: "agent-doc:gateway:propathena",
      classification: { sensitivity: "proprietary" },
    });

    const rules: ExclusionRule[] = [
      { kind: "flag", dimension: "sensitivity", equals: "proprietary" },
      { kind: "english", text: ATHENA_RULE },
    ];

    const { kept, excluded } = await applyExclusions([propAthena], rules, llm);

    expect(kept).toHaveLength(0);
    expect(excluded).toHaveLength(1);
    expect(excluded[0]!.rule.kind).toBe("flag");
  });
});

// ── Deterministic credential pre-filter (D.2, fail-restrictive) ─────────────────
//
// The conservative LLM prompt biases the credential english rule toward
// UNDER-exclusion — a leak risk. The fix has two layers, both exercised here
// against the REAL engine + a real aimock-backed distiller:
//
//   1. A deterministic regex pre-filter drops a candidate whose text carries a
//      recognizable credential (sk-, ghp_, AKIA, PEM header) BEFORE the LLM is
//      consulted — so a credential is excluded even if the model under-flags.
//   2. Fail-CLOSED is preserved: an LLM error on an ambiguous (non-regex)
//      credential candidate must ABORT, never silently approve.
//
// The catch-all KEEP fixture above models the CONSERVATIVE LLM: for any candidate
// it does not affirmatively recognize, it returns excluded=false. That is exactly
// the under-flagging the pre-filter must defeat.

describe("applyExclusions — deterministic credential pre-filter (D.2)", () => {
  const mock = new LLMock({ port: 0, logLevel: "silent" });
  let llm: OpenAIDistiller;

  beforeAll(async () => {
    for (const f of fixtures) mock.addFixture(f);
    await mock.start();
    llm = new OpenAIDistiller({
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

  it("drops a ghp_ token the conservative LLM would keep — NO LLM consulted", async () => {
    // This candidate carries a GitHub PAT but no ATHENA_SENTINEL, so the LLM
    // (conservative catch-all) would return excluded=false and LEAK it. The regex
    // pre-filter must drop it deterministically, without an LLM call.
    const leak = makeCandidate({
      title: "How we rotated the CI token",
      content:
        "We regenerated the deploy PAT to ghp_ABCDEFghijkl0123456789MNOPqrstuvWX01 and updated CI.",
      subsystem: "ci",
      canonical_key: "agent-doc:ci:leak",
    });

    const { kept, excluded } = await applyExclusions([leak], [CRED_RULE], llm);

    expect(kept).toHaveLength(0);
    expect(excluded).toHaveLength(1);
    expect(excluded[0]!.candidate.canonical_key).toBe(leak.canonical_key);
    expect(excluded[0]!.rule).toEqual(CRED_RULE);
  });

  it("drops sk-, AKIA, and PEM-header credentials the conservative LLM would keep", async () => {
    const openaiKey = makeCandidate({
      title: "Local dev setup",
      content:
        "Export OPENAI_API_KEY=sk-ABCDEFGHIJKLMNOPQRSTUVWXabcdefghij0123456789AB before running.",
      canonical_key: "agent-doc:dev:openai",
    });
    const awsKey = makeCandidate({
      title: "S3 uploader notes",
      content: "Set AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE in the environment.",
      canonical_key: "agent-doc:dev:aws",
    });
    const pem = makeCandidate({
      title: "Signing key handoff",
      content:
        "The key is:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
      canonical_key: "agent-doc:dev:pem",
    });

    const { kept, excluded } = await applyExclusions(
      [openaiKey, awsKey, pem],
      [CRED_RULE],
      llm,
    );

    expect(kept).toHaveLength(0);
    expect(excluded.map((e) => e.candidate.canonical_key).sort()).toEqual(
      [openaiKey.canonical_key, awsKey.canonical_key, pem.canonical_key].sort(),
    );
    for (const e of excluded) expect(e.rule).toEqual(CRED_RULE);
  });

  it("does NOT pre-filter a clean candidate — falls through to the LLM (kept)", async () => {
    // No credential pattern → the pre-filter abstains, the conservative LLM
    // catch-all returns excluded=false, candidate is kept.
    const clean = makeCandidate({
      title: "How the retry backoff works",
      content: "We use exponential backoff with jitter capped at 30s.",
      canonical_key: "agent-doc:core:backoff",
    });

    const { kept, excluded } = await applyExclusions([clean], [CRED_RULE], llm);

    expect(kept.map((c) => c.canonical_key)).toEqual([clean.canonical_key]);
    expect(excluded).toHaveLength(0);
  });

  it("does NOT pre-filter a NON-credential english rule (only cred rules pre-filter)", async () => {
    // A ghp_ token in a candidate must NOT be dropped by the pre-filter when the
    // active rule is unrelated to credentials (e.g. the Athena GTM rule). The
    // pre-filter is scoped to credential-oriented rules only.
    const hasToken = makeCandidate({
      title: "Unrelated note that happens to mention a token",
      content: "Old rotated value was ghp_ABCDEFghijkl0123456789MNOPqrstuvWX01.",
      canonical_key: "agent-doc:core:tokenmention",
    });

    const rule: ExclusionRule = { kind: "english", text: ATHENA_RULE };
    const { kept, excluded } = await applyExclusions([hasToken], [rule], llm);

    // Falls through to the conservative LLM (no Athena sentinel) → kept.
    expect(kept.map((c) => c.canonical_key)).toEqual([hasToken.canonical_key]);
    expect(excluded).toHaveLength(0);
  });
});

// ── Fail-CLOSED preservation (SECURITY) ─────────────────────────────────────────
//
// An LLM error on an ambiguous credential candidate (no regex hit) must ABORT the
// exclusion pass — never silently approve. We point the distiller at a dead
// endpoint so the real client throws, and assert applyExclusions rejects.

describe("applyExclusions — fail-CLOSED on LLM error (SECURITY)", () => {
  it("aborts (throws) when the LLM errors on an ambiguous cred candidate", async () => {
    // A distiller whose LLM call rejects, mirroring a live API/transport error.
    const failingLlm = {
      distillEpisodicWindow: () => {
        throw new Error("must not be called");
      },
      evaluateEnglishExclusionRule: async () => {
        throw new Error("[atlas/llm] simulated LLM transport failure");
      },
      judgeDistillation: () => {
        throw new Error("must not be called");
      },
      embed: () => {
        throw new Error("must not be called");
      },
      distillDelta: () => {
        throw new Error("must not be called");
      },
    };

    // Ambiguous: talks about credentials in prose but carries NO regex-detectable
    // token, so the pre-filter abstains and the LLM path is exercised.
    const ambiguous = makeCandidate({
      title: "Where our service credentials live",
      content: "The credentials are stored in the vault, not in this doc.",
      canonical_key: "agent-doc:sec:ambiguous",
    });

    await expect(
      applyExclusions([ambiguous], [CRED_RULE], failingLlm),
    ).rejects.toThrow(/simulated LLM transport failure/);
  });
});
