// Atlas episodic transcript-window leaf adapter (Tier-1, LLM-backed).
//
// The ONLY adapter that requires `ctx.llm`. It maps ONE window of raw
// episodic-memory transcript text to ZERO or one `CandidateFragment` (an
// empty/whitespace window emits nothing — see the content-free guard) by handing
// the window to the S1 `LlmDistiller` seam (`distillEpisodicWindow`), which
// distills the why/how prose + a claim title and stamps the episodic
// invariants. The adapter then attaches the source conversation path as
// `thread` evidence so a reviewer can trace the fragment back to its transcript.
//
// Episodic knowledge is NEVER self-verifying (spec §6 / plan S6): every emitted
// fragment carries `needsReview=true`, `validation_status="unverified"`, and
// `provenance_class="derived"`. The distiller hard-codes these; the adapter
// re-asserts them (defensive: it verifies/preserves the invariants rather than
// trusting an arbitrary `LlmDistiller` implementation to have set them).
//
// Like every leaf adapter it is a pure function of one unit (the Tier-1 "one
// unit each" rule, §4) and never touches a shared adapter index — the populated
// `LeafAdapterRegistry` is assembled only in the S18 driver.

import type {
  DistillContext,
  DistilledFragment,
  LlmDistiller,
} from "../llm.js";
import type { CandidateFragment, EvidenceItem } from "../types.js";
import {
  CandidateFragmentSchema,
  mostRestrictiveSensitivity,
  Sensitivity,
} from "../types.js";
import { sanitizeEnvRefs } from "./sanitize-env-refs.js";
import type { AdapterContext, LeafAdapter } from "./types.js";

// ── Input unit ────────────────────────────────────────────────────────────────

// One episodic transcript window as the S18 driver / S19 leaf harness hands it
// over: the source conversation path (the transcript file this window came
// from), the window's "as of" date, the raw transcript text to distill, and an
// optional subsystem hint the harness may already know (the aggregator
// re-groups later, so this is only a hint).
export interface EpisodicWindowUnit {
  // Path/locator of the source conversation transcript (e.g. a session JSONL
  // file path or session link). Carried into both provenance and evidence so
  // the fragment is traceable to its origin.
  convPath: string;
  // ISO date the window's transcript is "as of" (e.g. "2026-06-07"). Threaded
  // to the distiller as `asOf` so provenance freshness reflects the transcript,
  // not the harvest clock.
  date: string;
  // The raw transcript text of this window — what the distiller reads.
  text: string;
  // Optional subsystem hint. Defaults are filled by the distiller (model output
  // wins, else this hint, else "unknown").
  subsystem?: string;
}

// ── Adapter ──────────────────────────────────────────────────────────────────────

// Build the source-trace `thread` evidence entry. The EvidenceItem `thread`
// variant carries a free-text `body` (there is no path slot), so the conv path
// is embedded in the body where a reviewer can read it.
function convPathEvidence(unit: EpisodicWindowUnit): EvidenceItem {
  return {
    kind: "thread",
    body: `Distilled from episodic transcript window: ${unit.convPath} (as of ${unit.date})`,
  };
}

// The episodic adapter REQUIRES ctx.llm. AdapterContext.llm is now typed as the
// concrete S1 `LlmDistiller` (re-exported from ../llm.js — see types.ts), so
// after this guard `ctx.llm` is already an `LlmDistiller`; no cast is needed.
// The distilled result is still re-validated against CandidateFragmentSchema
// below (fail-loud on a malformed distillation rather than a degraded fragment).
function requireDistiller(ctx: AdapterContext): LlmDistiller {
  if (!ctx.llm) {
    throw new Error(
      "[atlas/adapters/episodic] ctx.llm is required — the episodic adapter " +
        "distills transcript windows via the LLM seam and cannot run without it.",
    );
  }
  return ctx.llm;
}

export const episodicAdapter: LeafAdapter<EpisodicWindowUnit> = {
  sourcetype: "episodic",

  async extract(
    unit: EpisodicWindowUnit,
    ctx: AdapterContext,
  ): Promise<CandidateFragment[]> {
    const llm = requireDistiller(ctx);

    // Content-free guard: an empty/whitespace window cannot yield a durable
    // claim — distilling it would burn an LLM call and emit a knowledge-free
    // fragment. Match the sibling adapters (linear / source-comment / showcase)
    // and emit nothing. (Checked AFTER the ctx.llm guard so a misconfigured
    // context still fails loud regardless of unit content.)
    if (unit.text.trim() === "") {
      return [];
    }

    const distillCtx: DistillContext = {
      // The conv path is both the logical source label and the provenance URL so
      // the fragment is traceable to its transcript.
      sourceName: unit.convPath,
      url: unit.convPath,
      // The window date drives provenance freshness (not the harvest clock).
      asOf: unit.date,
      ...(unit.subsystem ? { subsystem: unit.subsystem } : {}),
    };

    const distilled: DistilledFragment = await llm.distillEpisodicWindow(
      unit.text,
      distillCtx,
    );

    // Sensitivity guard for the clamp below: `mostRestrictiveSensitivity` ranks
    // by SENSITIVITY_ORDER.indexOf, which treats an UNRECOGNIZED value as
    // LOWEST (indexOf === -1 loses every comparison) — so clamping an
    // out-of-enum sensitivity would LAUNDER it to "internal", the leak
    // direction, pre-sanitizing exactly what the fail-loud
    // CandidateFragmentSchema.parse below exists to reject. Only clamp values
    // that are absent or enum-valid; pass anything else through raw so the
    // parse throws loudly.
    const rawSensitivity = distilled.provenance.classification.sensitivity;

    // Attach the source conversation path as `thread` evidence (always), on top
    // of whatever the distiller produced.
    const fragment: CandidateFragment = {
      ...distilled,
      sourcetype: "episodic",
      evidence: [...distilled.evidence, convPathEvidence(unit)],
      // Episodic invariants are non-negotiable (spec §6 / plan S6). The
      // OpenAIDistiller hard-codes these, but the adapter accepts ANY
      // LlmDistiller implementation, so re-assert them defensively: a
      // non-OpenAIDistiller could otherwise leak a weaker signal. These are
      // all RESTRICTIVE-direction clamps — never self-verifying, never
      // high-confidence, always derived/needsReview. Confidence is clamped to
      // "low" because a higher distiller signal would be an UNSAFE escalation.
      //
      // Sensitivity is the exception: it is a SECURITY label, so the safe
      // direction is MORE restrictive, not less. Forcing "internal" here would
      // DOWNGRADE a "secret"/"proprietary" signal, stripping the restriction so
      // DEFAULT_EXCLUSION_RULES no longer drop it → sensitive content leaks into
      // the corpus. Instead FLOOR at "internal" (episodic knowledge is at least
      // internal, never "public") while PRESERVING any stronger distiller signal.
      // The floor applies only to absent/enum-valid values (see the
      // rawSensitivity guard above); an out-of-enum value flows through to the
      // schema parse, which rejects it loudly.
      needsReview: true,
      provenance: {
        ...distilled.provenance,
        classification: {
          ...distilled.provenance.classification,
          validation_status: "unverified",
          provenance_class: "derived",
          confidence: "low",
          sensitivity:
            rawSensitivity == null ||
            Sensitivity.options.includes(rawSensitivity)
              ? mostRestrictiveSensitivity(
                  rawSensitivity ?? "internal",
                  "internal",
                )
              : rawSensitivity,
        },
      },
    };

    // §3.3: sanitize the emitted content (and provenance.source) through the
    // shared env-reference pass immediately before returning the fragment. The
    // distiller reads raw transcript text — a machine-local path, session UUID,
    // or private ref can survive into the distilled claim/source, so strip it
    // here at fragment-production time before the contract parse.
    const { content: sanitizedContent, source: sanitizedSource } =
      sanitizeEnvRefs(fragment.content, fragment.provenance.source);
    fragment.content = sanitizedContent;
    fragment.provenance.source = sanitizedSource;

    // Fail loud if the distillation+stamping did not yield a contract-valid
    // fragment (a bad LLM result in a knowledge-harvest is a defect to surface).
    return [CandidateFragmentSchema.parse(fragment)];
  },
};
