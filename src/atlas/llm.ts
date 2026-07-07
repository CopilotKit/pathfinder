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

import type {
  CandidateFragment,
  Classification,
  CorpusHit,
  DistillationVerdict,
  DistillDeltaResult,
  KnowledgeType,
} from "./types.js";
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

// What the distillation judge sees for one candidate. Kept structural (the
// narrow why-vs-what inputs) so callers can pass either a fragment or a finalized
// Candidate — only title/content/knowledge_type drive the verdict.
export interface DistillationJudgeInput {
  title: string;
  content: string;
  knowledge_type: KnowledgeType;
}

// What the distill-to-delta rewrite (Theme B fix (c)) sees for one candidate: its
// title/content plus the overlapping corpus passages the semantic gate found.
// The seam rewrites `content` down to the NET-NEW part the corpus does not
// already cover, or reports no delta (→ approvable=false, never dropped).
export interface DistillDeltaInput {
  title: string;
  content: string;
  overlaps: Pick<CorpusHit, "content">[];
}

// The seam every LLM-touching Atlas stage depends on. S6 (episodic adapter) uses
// distillEpisodicWindow; S13 (exclusion engine) uses evaluateEnglishExclusionRule;
// A.1 (distillation gate) uses judgeDistillation.
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

  // Judge one candidate's WHY-vs-WHAT quality (Theme A.1): distilled (a why/how
  // claim), rewritten (salvageable — returns a why/how rewrite), or restatement
  // (a pure WHAT restatement of already-obvious metadata, no new claim).
  judgeDistillation(
    candidate: DistillationJudgeInput,
  ): Promise<DistillationVerdict>;

  // Embed a text into a dense vector for the semantic (pgvector cosine) dedup
  // probe (Theme B). Reuses the same embedding provider/model the indexer uses
  // so the candidate vector lives in the SAME space as the corpus chunks.
  embed(text: string): Promise<number[]>;

  // Rewrite an overlapping candidate's `content` down to its NET-NEW delta —
  // only the part the overlapping corpus passages do NOT already cover (Theme B
  // fix (c)). Returns `no-delta` when nothing net-new remains (the gate then
  // marks approvable=false, NEVER drops), or `no-overlap` when the seam judges
  // the passages non-overlapping after all (the gate passes through).
  distillDelta(input: DistillDeltaInput): Promise<DistillDeltaResult>;
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
  // Embedding model for the semantic dedup probe (Theme B). Mirrors the
  // indexer's default so candidate vectors share the corpus vector space.
  embeddingModel?: string;
  // Embedding vector dimensions. Mirrors the indexer default (text-embedding-
  // 3-small at 1536). Must match the corpus's stored dimension.
  embeddingDimensions?: number;
  // Injectable clock so the distiller's default provenance dates are
  // deterministic in tests.
  now?: () => Date;
}

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

// Loopback hostnames a local aimock/proxy server runs on. A baseURL pointed at
// one of these is CLEARLY local — the "mock" apiKey sentinel is safe there (the
// server ignores the key). Any OTHER host is treated as a real, auth-requiring
// endpoint: a missing key there must FAIL LOUD at construction rather than ship
// the sentinel and surface as an opaque 401 at the first model call.
const LOOPBACK_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
]);

// True iff `baseURL` is a clearly-local/aimock endpoint (a loopback host). A
// malformed URL is conservatively treated as NON-local: we would rather fail
// loud demanding a key than silently default "mock" against something we cannot
// prove is a mock. Used to gate the "mock" apiKey sentinel — only a local
// baseURL may use it.
function isLocalBaseURL(baseURL: string): boolean {
  let host: string;
  try {
    host = new URL(baseURL).hostname;
  } catch {
    return false;
  }
  return LOOPBACK_HOSTNAMES.has(host.toLowerCase());
}

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
- FAIL-RESTRICTIVE: when the rule targets credentials, secret keys, tokens, passwords, other secret values, or proprietary/customer-identifying material, bias toward EXCLUSION. If you are UNCERTAIN whether such a rule applies, EXCLUDE (set excluded=true) — under-excluding a secret is a leak, which is far worse than dropping a borderline-safe entry. For any OTHER kind of rule, only exclude when the rule clearly applies.`;

const DISTILLATION_SYSTEM_PROMPT = `You are a WHY-vs-WHAT judge for an engineering knowledge corpus.

You are given ONE candidate knowledge entry (title + content + knowledge_type). Institutional-memory knowledge must explain the WHY / HOW behind a decision, root cause, architecture choice, or operational reality — NOT merely RESTATE the WHAT that is already obvious from metadata (which PR merged, what a file is named, that a component was added).

Classify the candidate into EXACTLY ONE verdict:
- "distilled": already a why/how CLAIM (explains reasoning, tradeoffs, mechanism, or consequence). Keep as-is. A claim that already states a CONCRETE MECHANISM — specific endpoints/routes, HTTP status codes, error codes, named functions/methods/symbols, file paths, config keys, or specific numbers — is "distilled": keep it as-is; do NOT rewrite a concrete-mechanism claim up into higher-level rationale.
- "rewritten": the SUBSTANCE is salvageable but the current title/content just restates WHAT happened; a why/how claim can be extracted. Provide the rewrite. The rewrite MUST RETAIN every concrete verifiable detail present in the source — API endpoints/routes, HTTP status codes, error codes, function/method/symbol names, file paths, config keys, and specific numbers. Sharpen the claim by adding the WHY/HOW AROUND those specifics; NEVER drop, generalize, or paraphrase them away. (Concretely: rewriting "POST /admin/:op returns 401 via timingSafeEqual" into "authentication enhances security" is WRONG — the endpoint, the code, and the symbol were all dropped.)
- "restatement": a PURE WHAT restatement (e.g. "adds X/Y/Z components", "PR #N merged", a stack/component inventory) that carries NO new reasoning or verifiable engineering claim. Cannot be salvaged into a why/how claim from the given text.

Return JSON with EXACTLY this structure:
{
  "verdict": "<distilled | rewritten | restatement>",
  "reason": "<one short sentence justifying the verdict>",
  "title": "<REQUIRED only when verdict is rewritten: the distilled why/how claim as a one-line title>",
  "content": "<REQUIRED only when verdict is rewritten: 1-3 paragraphs of why/how prose>"
}

Rules:
- Be conservative about "distilled": if the content only names WHAT (files, components, PRs) with no reasoning, it is NOT distilled.
- Only choose "rewritten" when the given text ACTUALLY contains extractable why/how substance — do NOT invent reasoning that is not present. If nothing is salvageable, choose "restatement".
- PRESERVE-SPECIFICS is mandatory on "rewritten": if you cannot produce a rewrite that keeps EVERY identifier/endpoint/status-code/error-code/symbol/path/config-key/number from the source, return "distilled" instead (pass the original through unchanged). Losing a verifiable specific is worse than leaving the prose slightly WHAT-flavored.
- title/content are REQUIRED for "rewritten" and ignored for the other verdicts.`;

const DISTILL_DELTA_SYSTEM_PROMPT = `You are a knowledge-DELTA distiller for an engineering knowledge corpus.

You are given ONE candidate knowledge entry (title + content) and one or more ALREADY-INDEXED corpus passages that overlap it. Re-seeding content the corpus already covers adds DUPLICATION, not knowledge. Your job is to rewrite the candidate's content down to ONLY the NET-NEW part — the reasoning, mechanism, consequence, or fact the overlapping passages do NOT already state.

Classify into EXACTLY ONE verdict:
- "delta": the candidate carries a net-new part the corpus passages do not cover. Return the rewritten content containing ONLY that net-new part.
- "no-delta": everything substantive in the candidate is already covered by the overlapping passages — there is nothing net-new to add.
- "no-overlap": on inspection the passages do NOT actually overlap the candidate (they are about something else), so no rewrite is warranted.

Return JSON with EXACTLY this structure:
{
  "verdict": "<delta | no-delta | no-overlap>",
  "reason": "<one short sentence justifying the verdict>",
  "content": "<REQUIRED only when verdict is delta: the rewritten net-new prose>"
}

Rules:
- Do NOT invent facts not present in the candidate. The delta is a SUBSET of the candidate's own substance, minus what the corpus already covers.
- Choose "no-delta" only when the candidate is genuinely fully redundant with the passages.
- content is REQUIRED for "delta" and ignored for the other verdicts.`;

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
// floor in the MOST restrictive direction, "secret". A value we cannot
// interpret could just as easily denote a credential/secret as a business
// detail, so the safest default is the strongest label — an unclassifiable
// secret must never leak past the exclusion rules; the reviewer relaxes it at
// ratification if it was over-classified.
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
    `[atlas/llm] unrecognized model sensitivity ${JSON.stringify(v)} — flooring to "secret" (most restrictive direction)`,
  );
  return "secret";
}

export class OpenAIDistiller implements LlmDistiller {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly embeddingModel: string;
  private readonly embeddingDimensions: number;
  private readonly now: () => Date;

  constructor(options: OpenAIDistillerOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.embeddingModel = options.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
    this.embeddingDimensions =
      options.embeddingDimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
    this.now = options.now ?? (() => new Date());
    if (options.client) {
      this.client = options.client;
    } else {
      // baseURL falls back to OPENAI_BASE_URL so aimock interception works with
      // zero config in tests (the env var is set by useAimock / the CLI).
      const baseURL = options.baseURL ?? process.env.OPENAI_BASE_URL;
      // The "mock" apiKey sentinel is only safe against a CLEARLY-LOCAL/aimock
      // baseURL (a loopback host) — that server ignores the key. An ARBITRARY
      // real baseURL (a hosted auth-requiring proxy configured via
      // OPENAI_BASE_URL) with the key forgotten must NOT silently default to
      // "mock": doing so ships an invalid key that surfaces as an opaque 401 at
      // the FIRST model call, far from the misconfiguration. Both the no-baseURL
      // case (the real OpenAI API) and a real-proxy baseURL fail LOUD at
      // construction instead (fail-loud discipline). Truthy `||` (not `??`):
      // .env templates commonly ship OPENAI_API_KEY="" — an empty string is
      // non-nullish and would defeat the local-baseURL→"mock" fallback, making
      // the guard below demand a var that IS set for a local mock server.
      const localMock = Boolean(baseURL) && isLocalBaseURL(baseURL as string);
      const apiKey =
        options.apiKey ||
        process.env.OPENAI_API_KEY ||
        (localMock ? "mock" : undefined);
      if (!apiKey) {
        throw new Error(
          "[atlas/llm] OpenAIDistiller: no API key configured — set " +
            "OPENAI_API_KEY (or pass `apiKey`), or point OPENAI_BASE_URL at a " +
            "LOCAL mock server (a loopback host: localhost / 127.0.0.1 / [::1]) " +
            "for tests. A real (non-loopback) baseURL requires a real key — the " +
            '"mock" sentinel is never used against a real endpoint.',
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

  async judgeDistillation(
    candidate: DistillationJudgeInput,
  ): Promise<DistillationVerdict> {
    const userPayload = JSON.stringify({
      title: candidate.title,
      content: candidate.content,
      knowledge_type: candidate.knowledge_type,
    });

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: DISTILLATION_SYSTEM_PROMPT },
        { role: "user", content: userPayload },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    });

    const parsed = parseJsonContent(
      response.choices[0]?.message?.content,
      "judgeDistillation",
    );

    const verdict = asString(parsed.verdict)?.toLowerCase();
    const reason = asString(parsed.reason) ?? "";

    if (verdict === "distilled") {
      return { kind: "distilled" };
    }
    if (verdict === "restatement") {
      return { kind: "restatement", reason };
    }
    if (verdict === "rewritten") {
      // A "rewritten" verdict is only meaningful with the replacement why/how
      // title+content. A model that claims "rewritten" but omits either field
      // gave us nothing to salvage WITH — treat it as a restatement (the
      // conservative, never-drop-but-not-approvable direction) rather than
      // fabricating empty prose or failing the whole run loud.
      const title = asString(parsed.title);
      const content = asString(parsed.content);
      if (!title || !content) {
        return {
          kind: "restatement",
          reason:
            reason ||
            "model returned rewritten verdict without a title/content rewrite",
        };
      }
      return { kind: "rewritten", title, content, reason };
    }

    throw new Error(
      `[atlas/llm] judgeDistillation: model returned an unrecognized verdict ${JSON.stringify(
        parsed.verdict,
      )} (expected distilled | rewritten | restatement)`,
    );
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.embeddingModel,
      input: text,
      dimensions: this.embeddingDimensions,
      // Explicit float format — see embeddings.ts:embedWithRetry. The SDK v4
      // defaults to base64, which a float-returning proxy (aimock) mis-decodes
      // into a wrong-length vector. Asking for "float" is unambiguous against
      // both the real API and the mock.
      encoding_format: "float",
    });
    const vector = response.data[0]?.embedding;
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error(
        "[atlas/llm] embed: model returned an empty or malformed embedding",
      );
    }
    // Fail LOUD on a wrong-DIMENSION vector. The candidate vector must live in
    // the SAME space as the corpus chunks (this.embeddingDimensions — the
    // dimension the indexer stored and the value we requested above). A
    // wrong-length vector would otherwise pass this guard and fail opaquely
    // downstream in vectorSearch (a pgvector dimension mismatch) where the
    // rag-dedup gate swallows it as a generic `semanticFailed` — silently
    // degrading semantic dedup with no diagnosable signal. Surface it HERE, at
    // the source, naming both lengths so a misconfigured embedding
    // provider/model is a visible error, not an invisible degrade.
    if (vector.length !== this.embeddingDimensions) {
      throw new Error(
        `[atlas/llm] embed: model returned a wrong-dimension embedding — ` +
          `got ${vector.length}, expected ${this.embeddingDimensions} ` +
          `(model ${this.embeddingModel}); refusing to pass a mismatched ` +
          `vector downstream where it would fail opaquely in vectorSearch`,
      );
    }
    return vector as number[];
  }

  async distillDelta(input: DistillDeltaInput): Promise<DistillDeltaResult> {
    const userPayload = JSON.stringify({
      candidate: { title: input.title, content: input.content },
      overlapping_corpus_passages: input.overlaps.map((h) => h.content),
    });

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: DISTILL_DELTA_SYSTEM_PROMPT },
        { role: "user", content: userPayload },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    });

    const parsed = parseJsonContent(
      response.choices[0]?.message?.content,
      "distillDelta",
    );

    const verdict = asString(parsed.verdict)?.toLowerCase();
    const reason = asString(parsed.reason) ?? "";

    if (verdict === "no-overlap") {
      return { kind: "no-overlap" };
    }
    if (verdict === "no-delta") {
      return { kind: "no-delta", reason };
    }
    if (verdict === "delta") {
      // A "delta" verdict is only meaningful with the rewritten net-new prose. A
      // model that claims "delta" but omits `content` gave us nothing to seed —
      // treat it as no-delta (the conservative never-drop-but-not-approvable
      // direction) rather than fabricating prose or failing the whole run loud.
      const content = asString(parsed.content);
      if (!content) {
        return {
          kind: "no-delta",
          reason:
            reason || "model returned delta verdict without rewritten content",
        };
      }
      return { kind: "delta", content, reason };
    }

    throw new Error(
      `[atlas/llm] distillDelta: model returned an unrecognized verdict ${JSON.stringify(
        parsed.verdict,
      )} (expected delta | no-delta | no-overlap)`,
    );
  }
}
