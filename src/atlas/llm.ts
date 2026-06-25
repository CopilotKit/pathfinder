// Atlas LLM distiller seam.
//
// The single place the Atlas harvest talks to an LLM. Two narrow operations:
//
//   1. distillEpisodicWindow  — turn a window of raw episodic-memory transcript
//      text into a distilled CandidateFragment (why/how prose + a claim title),
//      ALWAYS flagged needsReview + validation_status="unverified" (episodic
//      knowledge is never self-verifying — spec §6 / plan S6).
//   2. evaluateEnglishExclusionRule — judge a single candidate against one
//      plain-English exclusion rule, returning a typed { excluded, reason }
//      verdict (plan §4.8 / S13).
//
// `OpenAIDistiller` reuses the existing `openai` dependency (the same client the
// indexing distiller uses, src/indexing/distiller.ts) and honors
// `OPENAI_BASE_URL` so tests route to aimock (org rule: LLM-touching tests use
// aimock, never vi.fn stubs). Prompts are deterministic (fixed system text,
// temperature 0) and responses are requested as JSON objects, then parsed into
// the typed shapes below.

import OpenAI from "openai";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";

import type { CandidateFragment, Classification } from "./types.js";
import { mostRestrictiveSensitivity } from "./types.js";

// ── Public types ──────────────────────────────────────────────────────────────

// Context handed to distillEpisodicWindow so the distiller can stamp provenance
// without re-deriving it from the transcript. All fields are optional; the
// distiller fills sensible defaults (source_name/subsystem) when omitted so the
// returned fragment always parses against CandidateFragmentSchema.
export interface DistillContext {
  // Logical source label written into the fragment + provenance (e.g. an agent
  // session id or transcript name). Defaults to "episodic-memory".
  sourceName?: string;
  // Subsystem hint for the fragment. Defaults to "unknown" when the caller has
  // no better grouping; the aggregator (S10) re-groups later.
  subsystem?: string;
  // Optional provenance URL (e.g. the transcript file path / session link).
  url?: string;
  // Optional ISO date the underlying transcript is "as of" (provenance
  // freshness.as_of). Defaults to the distiller's `now` at call time.
  asOf?: string;
}

// The distilled-fragment shape returned by distillEpisodicWindow. It is exactly
// a CandidateFragment (the S0 contract type) so the episodic adapter (S6) can
// return it straight through with no remapping.
export type DistilledFragment = CandidateFragment;

// Verdict returned by evaluateEnglishExclusionRule.
export interface ExclusionVerdict {
  excluded: boolean;
  reason?: string;
}

// What a candidate looks like to an exclusion-rule evaluation. Kept structural
// (not the full Candidate) so callers can pass either a CandidateFragment or a
// finalized Candidate — only these fields drive the English-rule judgment.
export interface ExclusionCandidate {
  title: string;
  content: string;
  subsystem?: string;
  classification?: Classification;
}

// The seam every LLM-touching Atlas stage depends on. S6 (episodic adapter) uses
// distillEpisodicWindow; S13 (exclusion engine) uses evaluateEnglishExclusionRule.
export interface LlmDistiller {
  // Distill a window of raw episodic transcript text into a single distilled
  // CandidateFragment (needsReview=true, validation_status="unverified").
  distillEpisodicWindow(
    text: string,
    ctx: DistillContext,
  ): Promise<DistilledFragment>;

  // Judge one candidate against one plain-English exclusion rule.
  evaluateEnglishExclusionRule(
    rule: string,
    candidate: ExclusionCandidate,
  ): Promise<ExclusionVerdict>;
}

// ── OpenAI implementation ───────────────────────────────────────────────────--

export interface OpenAIDistillerOptions {
  // Inject a pre-built client (tests pass one pointed at aimock). When omitted a
  // client is constructed; it honors OPENAI_BASE_URL (and the explicit baseURL
  // below) so it can be redirected to aimock without code changes.
  client?: OpenAI;
  // Forwarded to `new OpenAI({ apiKey })` when no client is injected.
  apiKey?: string;
  // Forwarded to `new OpenAI({ baseURL })`. Falls back to OPENAI_BASE_URL. The
  // OpenAI v4 client already reads OPENAI_BASE_URL itself, but threading it here
  // keeps the seam explicit and testable.
  baseURL?: string;
  // Chat model. Mirrors the indexing distiller default.
  model?: string;
  // Injectable clock so the distiller's default provenance dates are
  // deterministic in tests.
  now?: () => Date;
}

const DEFAULT_MODEL = "gpt-4o-mini";

// Deterministic system prompts. Kept as module constants (not interpolated with
// per-call data) so fixture matching is stable and re-runs are reproducible.
const EPISODIC_SYSTEM_PROMPT = `You are a knowledge-distillation engine for an engineering org's institutional memory.

Given a window of raw conversation / session transcript text, distill the single most important durable engineering claim it contains: the why/how behind a decision, root cause, architecture choice, or operational fact.

Return JSON with EXACTLY this structure:
{
  "title": "<one-line distilled claim, NOT a copy of any source heading>",
  "content": "<1-3 paragraphs of why/how prose explaining the claim>",
  "subsystem": "<short subsystem/area slug, or omit if unknown>",
  "knowledge_type": "<one of: architecture, design-rationale, root-cause, ownership, operational, protocol, security, process, product, gtm, org-culture>",
  "sensitivity": "<one of: internal, proprietary, secret — omit for ordinary internal knowledge>",
  "validationTargets": ["<symbol or path a reviewer could grep to verify, zero or more>"]
}

Rules:
- The title is a CLAIM, not a transcript quote.
- content is prose, not bullet fragments.
- Set "sensitivity" to "secret" if the claim exposes credentials/keys/tokens or other secret material, "proprietary" if it exposes confidential business/customer specifics, otherwise omit it (the default is internal). NEVER under-classify sensitive material.
- If no durable engineering claim is present, still return the structure with your best summary and an empty validationTargets array.
- Do not invent symbols/paths for validationTargets — only include ones actually referenced in the text.`;

const EXCLUSION_SYSTEM_PROMPT = `You are an exclusion-rule judge for an engineering knowledge corpus.

You are given ONE plain-English exclusion rule and ONE candidate knowledge entry. Decide whether the rule says this candidate should be EXCLUDED from the corpus.

Return JSON with EXACTLY this structure:
{
  "excluded": <true if the rule applies and the candidate should be dropped, else false>,
  "reason": "<one short sentence justifying the decision>"
}

Rules:
- Judge ONLY against the provided rule, nothing else.
- Be conservative: only exclude when the rule clearly applies.`;

// Parse-or-throw helper. The seam fails loud on malformed model output rather
// than silently returning a degraded result (fail-loud discipline) — a bad LLM
// response in a knowledge-harvest is a defect to surface, not swallow. Both
// callers expect a JSON OBJECT, so valid-but-wrong-type JSON (a bare string,
// number, boolean, null, or array) is rejected here too — otherwise it would
// surface as a misleading "omitted field" error or a raw TypeError on null.
function parseJsonContent(
  raw: string | null | undefined,
  where: string,
): Record<string, unknown> {
  if (raw == null || raw.trim() === "") {
    throw new Error(`[atlas/llm] empty response from model during ${where}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[atlas/llm] failed to parse JSON response during ${where}: ${msg}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const got =
      parsed === null
        ? "null"
        : Array.isArray(parsed)
          ? "array"
          : typeof parsed;
    throw new Error(
      `[atlas/llm] expected a JSON object from model during ${where}, got ${got}`,
    );
  }
  return parsed as Record<string, unknown>;
}

// Returns the TRIMMED string, or undefined for non-strings and
// empty/whitespace-only strings — model output routinely carries stray padding.
function asString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed;
}

// Sanitize a MODEL-emitted subsystem: ':' is a structural component delimiter
// of the canonical key (<sourcetype>:<subsystem>:<claim-slug>) and '⟦'/'⟧'
// (U+27E6/U+27E7) are the Notion approval-marker delimiters — and
// CandidateFragmentSchema rejects ALL THREE in `subsystem`. Replace each with
// '-' so a nondeterministic "atlas:harvest" (or "atlas⟦x⟧y") still yields a
// schema-valid fragment. Returns undefined when sanitization leaves nothing
// usable, so the caller falls through to its hint/default chain.
function sanitizeSubsystem(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const cleaned = v.replace(/[:⟦⟧]/g, "-").trim();
  return cleaned === "" ? undefined : cleaned;
}

// The knowledge_type enum values, mirrored from S0's KnowledgeType. Used to
// validate the model's claimed type and fall back deterministically.
const KNOWLEDGE_TYPES = new Set<Classification["knowledge_type"]>([
  "architecture",
  "design-rationale",
  "root-cause",
  "ownership",
  "operational",
  "protocol",
  "security",
  "process",
  "product",
  "gtm",
  "org-culture",
]);

function coerceKnowledgeType(v: unknown): Classification["knowledge_type"] {
  // Normalize before the enum lookup — models nondeterministically vary
  // casing/whitespace ("Architecture ", " security").
  const normalized = typeof v === "string" ? v.trim().toLowerCase() : undefined;
  if (
    normalized &&
    KNOWLEDGE_TYPES.has(normalized as Classification["knowledge_type"])
  ) {
    return normalized as Classification["knowledge_type"];
  }
  // Episodic distillations are explanatory by nature; default to design-rationale.
  return "design-rationale";
}

// The sensitivity enum values, mirrored from S0's Sensitivity. Used to validate
// the model's claimed sensitivity before flooring it.
const SENSITIVITIES = new Set<Classification["sensitivity"]>([
  "public",
  "internal",
  "proprietary",
  "secret",
]);

// Coerce the model's `sensitivity` to a valid Sensitivity, FLOORED at
// "internal". Episodic knowledge is at least internal (never "public"), but a
// model-flagged "secret"/"proprietary" MUST be preserved — forcing "internal"
// would strip the restriction and leak sensitive content past the exclusion
// rules. The value is trim/lowercase-normalized BEFORE the enum lookup so a
// nondeterministic " Secret " never dodges preservation on formatting alone.
//
// An omitted/empty value means "ordinary internal knowledge" (the prompt's
// documented default). An unrecognized NON-EMPTY value is different: the model
// asserted SOME sensitivity we cannot interpret, so silently flooring to
// "internal" would under-classify — warn (naming the discarded value) and
// floor in the RESTRICTIVE direction, "proprietary".
function coerceEpisodicSensitivity(v: unknown): Classification["sensitivity"] {
  if (v == null || (typeof v === "string" && v.trim() === "")) {
    return "internal";
  }
  const normalized = typeof v === "string" ? v.trim().toLowerCase() : undefined;
  if (
    normalized &&
    SENSITIVITIES.has(normalized as Classification["sensitivity"])
  ) {
    return mostRestrictiveSensitivity(
      normalized as Classification["sensitivity"],
      "internal",
    );
  }
  console.warn(
    `[atlas/llm] unrecognized model sensitivity ${JSON.stringify(v)} — flooring to "proprietary" (restrictive direction)`,
  );
  return "proprietary";
}

export class OpenAIDistiller implements LlmDistiller {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly now: () => Date;

  constructor(options: OpenAIDistillerOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.now = options.now ?? (() => new Date());
    if (options.client) {
      this.client = options.client;
    } else {
      // baseURL falls back to OPENAI_BASE_URL so aimock interception works with
      // zero config in tests (the env var is set by useAimock / the CLI).
      const baseURL = options.baseURL ?? process.env.OPENAI_BASE_URL;
      // An explicit baseURL is presumed to be a mock/proxy (in this repo it is
      // only ever aimock) that ignores the key, so "mock" is a safe placeholder
      // there; a misconfigured real proxy still fails loud with a 401. Only the
      // no-baseURL case (the real API, where a defaulted "mock" key would
      // surface as a confusing 401 at the FIRST model call) fails loud at
      // construction instead (fail-loud discipline). Truthy `||` (not `??`):
      // .env templates commonly ship OPENAI_API_KEY="" — an empty string is
      // non-nullish and would defeat the baseURL→"mock" fallback, making the
      // guard below demand a var that IS set.
      const apiKey =
        options.apiKey ||
        process.env.OPENAI_API_KEY ||
        (baseURL ? "mock" : undefined);
      if (!apiKey) {
        throw new Error(
          "[atlas/llm] OpenAIDistiller: no API key configured — set " +
            "OPENAI_API_KEY (or pass `apiKey`), or point OPENAI_BASE_URL at a " +
            "mock server for tests.",
        );
      }
      // When a baseURL is configured it is, in this repo, only ever a local
      // aimock/proxy server (see the comment above). Under the full test suite
      // every aimock-backed file runs its own in-process server in parallel
      // (src + the built dist copy, so ~2x the servers), and the OpenAI SDK's
      // node-fetch pools keep-alive sockets. Under that contention a server can
      // close an idle pooled socket exactly as a request reuses it, which
      // node-fetch surfaces as `FetchError: ... Premature close` — a flaky,
      // load-dependent failure across every aimock test (deterministic in CI).
      // Pinning a non-keep-alive agent for the mock/proxy case forces a fresh
      // socket per request, removing the reuse race. Production (no baseURL →
      // real OpenAI over HTTPS) keeps the SDK's default keep-alive agent.
      const httpAgent = baseURL
        ? baseURL.startsWith("https:")
          ? new HttpsAgent({ keepAlive: false })
          : new HttpAgent({ keepAlive: false })
        : undefined;
      this.client = new OpenAI({
        apiKey,
        ...(baseURL ? { baseURL } : {}),
        ...(httpAgent ? { httpAgent } : {}),
      });
    }
  }

  async distillEpisodicWindow(
    text: string,
    ctx: DistillContext,
  ): Promise<DistilledFragment> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: EPISODIC_SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    });

    const parsed = parseJsonContent(
      response.choices[0]?.message?.content,
      "distillEpisodicWindow",
    );

    const title = asString(parsed.title);
    const content = asString(parsed.content);
    if (!title || !content) {
      throw new Error(
        "[atlas/llm] distillEpisodicWindow: model omitted required title/content",
      );
    }

    // An explicit ctx.asOf passes through unchanged; the default is sliced to
    // date-only (YYYY-MM-DD) to match every leaf adapter's shape, so downstream
    // canonicalize/aggregate date comparison and dedup compare like with like.
    const asOf = ctx.asOf ?? this.now().toISOString().slice(0, 10);
    const sourceName = ctx.sourceName ?? "episodic-memory";
    // The model's subsystem wins over the caller hint (it has read the actual
    // window), but it is nondeterministic output, so sanitize it: asString
    // trims, and the three delimiters CandidateFragmentSchema rejects in
    // subsystem — ':' (a STRUCTURAL canonical-key delimiter) and '⟦'/'⟧' (the
    // Notion approval-marker delimiters) — are each replaced with '-'.
    // Without this, a delimiter-bearing model subsystem blows up the "returned
    // fragment always parses against CandidateFragmentSchema" promise mid-
    // pipeline. ctx.subsystem is caller-owned (the adapters/driver) but
    // sanitized for the same delimiters — the parse promise covers caller
    // input too.
    const subsystem =
      sanitizeSubsystem(asString(parsed.subsystem)) ??
      sanitizeSubsystem(asString(ctx.subsystem)) ??
      "unknown";
    const knowledgeType = coerceKnowledgeType(parsed.knowledge_type);
    // Sensitivity is floored at "internal" but PRESERVES a stronger model
    // signal ("secret"/"proprietary"). See coerceEpisodicSensitivity.
    const sensitivity = coerceEpisodicSensitivity(parsed.sensitivity);
    const validationTargets = Array.isArray(parsed.validationTargets)
      ? parsed.validationTargets
          .map((t) => (typeof t === "string" ? t.trim() : t))
          .filter((t): t is string => typeof t === "string" && t !== "")
      : [];

    // Episodic fragments are ALWAYS unverified + needsReview + low-confidence
    // + derived (plan S6) — the distiller hard-codes those restrictive-direction
    // invariants regardless of model output. Sensitivity is the exception: it is
    // a SECURITY label, so it is floored at "internal" (never "public") but
    // PRESERVES a stronger model-flagged signal — forcing "internal" would
    // downgrade a "secret"/"proprietary" judgment and leak the content.
    const classification: Classification = {
      sensitivity,
      knowledge_type: knowledgeType,
      audience: "all-staff",
      validation_status: "unverified",
      confidence: "low",
      provenance_class: "derived",
      freshness: { as_of: asOf },
    };

    const fragment: DistilledFragment = {
      sourcetype: "episodic",
      subsystem,
      source_name: sourceName,
      title,
      content,
      provenance: {
        source: sourceName,
        ...(ctx.url ? { url: ctx.url } : {}),
        date: asOf,
        classification,
      },
      evidence: [],
      needsReview: true,
      validationTargets,
    };

    return fragment;
  }

  async evaluateEnglishExclusionRule(
    rule: string,
    candidate: ExclusionCandidate,
  ): Promise<ExclusionVerdict> {
    const userPayload = JSON.stringify({
      rule,
      candidate: {
        title: candidate.title,
        content: candidate.content,
        subsystem: candidate.subsystem,
        classification: candidate.classification,
      },
    });

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: EXCLUSION_SYSTEM_PROMPT },
        { role: "user", content: userPayload },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    });

    const parsed = parseJsonContent(
      response.choices[0]?.message?.content,
      "evaluateEnglishExclusionRule",
    );

    if (typeof parsed.excluded !== "boolean") {
      throw new Error(
        "[atlas/llm] evaluateEnglishExclusionRule: model omitted boolean `excluded`",
      );
    }

    // Use the checked (trimmed) value itself, not the raw parsed field.
    const reason = asString(parsed.reason);
    return {
      excluded: parsed.excluded,
      ...(reason ? { reason } : {}),
    };
  }
}
