// Atlas Linear doc/project leaf adapter (Tier-1, deterministic, no LLM).
//
// Maps ONE Linear document or project — the "one unit each" Tier-1 rule (spec
// §4 / §4.2) — into a single CandidateFragment. Linear design docs and project
// briefs are where ownership/boundary rationale lives: the Problem / Why /
// Non-Goals sections are distilled into the fragment's why/how `content`, the
// doc's cited source files/tables become `changed_file` evidence (and
// validation targets for the validate stage, S14), the subsystem is taken from
// the doc's `subsystem`/`area`, and `provenance.url` is the Linear URL.
//
// Dedup-hint vs Notion: Linear docs frequently cross-link a Notion ADR for the
// same decision. When the unit names that cross-link, the adapter records it in
// BOTH `provenance.validated_against` (machine-collapsible by Tier-2/Tier-3
// dedup, §4.4/§4.5) and a `thread` evidence entry (human-readable in the
// approval artifact) so a later dedup pass can collapse the Linear/Notion twin
// rather than emit two near-identical candidates.
//
// Pure function: derives every date from `ctx.now` (deterministic under test),
// never mutates the input, takes no build-time dependency on the LLM seam.

import type { CandidateFragment } from "../types.js";
import { sanitizeEnvRefs } from "./sanitize-env-refs.js";
import { scanSensitivity } from "./sensitivity-scan.js";
import type { AdapterContext, LeafAdapter } from "./types.js";

// ── The Linear unit shape (one document or project) ───────────────────────────
//
// A structured projection of a Linear document/project — NOT the raw Linear MCP
// payload. The leaf fleet (S19) is responsible for projecting the MCP response
// down to this shape before handing it to the adapter, so the adapter stays a
// pure, testable function over a small explicit unit.
export interface LinearDocUnit {
  // Canonical Linear URL → becomes provenance.url.
  url: string;
  // Human title → becomes the distilled fragment `title` (the claim).
  title: string;
  // The decision context. Distilled into the fragment's why/how content.
  problem?: string;
  // The rationale ("why we decided X"). The heart of the fragment content.
  why?: string;
  // Boundary rationale — what we deliberately did NOT do. Each entry is rendered
  // under a "Non-Goals" heading so the boundary survives into the corpus.
  nonGoals?: string[];
  // Source files / tables the doc cites → changed_file evidence + validation
  // targets (the validate stage greps these against origin/main).
  citedFiles?: string[];
  // A cross-linked Notion ADR/doc for the SAME decision, if any → dedup hint.
  notionCrossLink?: string;
  // Owning subsystem. Preferred over `area`. Either → fragment.subsystem.
  subsystem?: string;
  // Linear "area"/team label; slugified into a subsystem when `subsystem` is
  // absent.
  area?: string;
  // Last-updated calendar date (YYYY-MM-DD), if the doc carries one. Falls back
  // to ctx.now.
  updatedAt?: string;
  // An explicit knowledge_type override (e.g. "ownership"). Defaults to
  // "design-rationale" — the dominant shape of a Linear design doc.
  knowledgeType?: CandidateFragment["provenance"]["classification"]["knowledge_type"];
}

// Date-only ISO stamp (YYYY-MM-DD) — matches the §12 worked-row date shape
// (calendar dates, not full timestamps). Mirrors classify.ts's isoDate.
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Slugify a free-text area label into a subsystem token (lowercase,
// non-alphanumerics → single hyphen, trimmed). "Runtime" → "runtime",
// "React Core" → "react-core".
function slugifyArea(area: string): string {
  return area
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Resolve the subsystem: explicit `subsystem` wins, else slugified `area`, else
// the conservative non-empty default (never an empty string — downstream
// canonical keys are `<sourcetype>:<subsystem>:<slug>`).
function resolveSubsystem(unit: LinearDocUnit): string {
  // Trim before testing: a whitespace-only subsystem (`"   "`) would otherwise
  // pass `.length > 0` and yield a degenerate canonical key
  // (`linear-doc:   :slug`). Use the trimmed value when it is non-empty.
  const subsystem = unit.subsystem?.trim();
  if (subsystem && subsystem.length > 0) return subsystem;
  // slugifyArea already trims, so a whitespace-only area collapses to "" and
  // falls through to the default below.
  if (unit.area && unit.area.trim().length > 0) {
    const slug = slugifyArea(unit.area);
    if (slug.length > 0) return slug;
  }
  return "uncategorized";
}

// Resolve the fragment title: the trimmed doc title when non-empty, else a
// non-empty fallback naming the doc URL. Mirrors github's `titleOrFallback` —
// a blank title would yield a degenerate canonical key (empty claim slug).
function titleOrFallback(rawTitle: string, fallback: string): string {
  const trimmed = rawTitle.trim();
  return trimmed !== "" ? trimmed : fallback;
}

// Distill Problem / Why / Non-Goals into the fragment's why/how prose. Sections
// are only emitted when they carry non-whitespace prose, so a minimal project
// (problem+why only) yields no "Non-Goals" heading, and a whitespace-only field
// (`"   "`) contributes no degenerate `Problem:    ` heading.
function distillContent(unit: LinearDocUnit): string {
  const sections: string[] = [];
  if (unit.problem && unit.problem.trim().length > 0) {
    sections.push(`Problem: ${unit.problem.trim()}`);
  }
  if (unit.why && unit.why.trim().length > 0) {
    sections.push(`Why: ${unit.why.trim()}`);
  }
  if (unit.nonGoals && unit.nonGoals.length > 0) {
    const goals = unit.nonGoals
      .map((g) => g.trim())
      .filter((g) => g.length > 0);
    if (goals.length > 0) {
      const bullets = goals.map((g) => `- ${g}`).join("\n");
      sections.push(`Non-Goals:\n${bullets}`);
    }
  }
  return sections.join("\n\n");
}

// ── The adapter ───────────────────────────────────────────────────────────────

export const linearAdapter: LeafAdapter<LinearDocUnit> = {
  sourcetype: "linear-doc",

  async extract(
    unit: LinearDocUnit,
    ctx: AdapterContext,
  ): Promise<CandidateFragment[]> {
    // Content-free guard: a unit with no Problem/Why/Non-Goals distills to "",
    // which would emit a knowledge-free fragment. Match the sibling adapters —
    // episodic returns [] for an empty/whitespace window before spending an
    // LLM call, and source-comment / showcase likewise return [] for
    // content-free units — and emit nothing instead.
    const content = distillContent(unit);
    if (content.trim().length === 0) {
      return [];
    }

    const date = unit.updatedAt ?? isoDate(ctx.now);
    const subsystem = resolveSubsystem(unit);

    // Shared credential/GTM scan over what the fragment actually emits (the
    // title + the distilled Problem/Why/Non-Goals content) — never a hardcoded
    // `internal`, so the deterministic DEFAULT_EXCLUSION_RULES layer
    // (sensitivity ≥ proprietary) can fire on a leaked credential / customer
    // detail. Bare credential MENTIONS escalate too: Linear doc bodies are
    // high-volume third-party text, so the over-flag direction wins (the
    // exclusion stage is the safety net).
    const sensitivity = scanSensitivity(unit.title, "", content, {
      bareCredentialMentions: true,
    });

    // Cited files → changed_file evidence + validation targets. Trim each
    // entry and drop blanks (a whitespace-only path is not a grep-able target).
    const citedFiles = (unit.citedFiles ?? [])
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
    const evidence: CandidateFragment["evidence"] = citedFiles.map((path) => ({
      kind: "changed_file",
      path,
    }));

    // Notion dedup-hint: a thread evidence entry naming the cross-link, plus the
    // cross-link recorded in provenance.validated_against (machine-collapsible).
    const validatedAgainst = unit.notionCrossLink
      ? `Linear doc cross-links Notion ADR ${unit.notionCrossLink} — dedup candidate (collapse Linear/Notion twin)`
      : undefined;
    if (unit.notionCrossLink) {
      evidence.push({
        kind: "thread",
        body: `dedup-hint: cross-links Notion doc ${unit.notionCrossLink} (same decision — later dedup may collapse this Linear/Notion pair)`,
      });
    }

    // §3.3: sanitize the emitted content (and provenance.source) through the
    // shared env-reference pass immediately before returning the fragment, so a
    // machine-local path / session UUID / private ref in the distilled
    // Problem/Why/Non-Goals prose is rewritten before it enters the pipeline.
    const { content: sanitizedContent, source: sanitizedSource } =
      sanitizeEnvRefs(content, "linear-doc");

    const fragment: CandidateFragment = {
      sourcetype: "linear-doc",
      subsystem,
      source_name: "linear-doc",
      repo_url: undefined,
      ref: undefined,
      title: titleOrFallback(unit.title, `Linear doc ${unit.url}`),
      content: sanitizedContent,
      provenance: {
        source: sanitizedSource,
        url: unit.url,
        date,
        validated_against: validatedAgainst,
        classification: {
          // Company design docs are internal until the shared first-pass scan
          // proves otherwise (it only ever ESCALATES — never `public`).
          sensitivity,
          // Default to design-rationale (the dominant Linear-doc shape); an
          // explicit unit.knowledgeType (e.g. "ownership") overrides.
          knowledge_type: unit.knowledgeType ?? "design-rationale",
          audience: "engineering",
          // A first-pass adapter never claims verification; the validate stage
          // (S14) promotes via the cited-file targets.
          validation_status: "unverified",
          confidence: "medium",
          // The Linear doc is the primary statement of the decision.
          provenance_class: "primary",
          freshness: { as_of: date },
        },
      },
      evidence,
      needsReview: false,
      // Cited files double as validation targets for the validate stage. Emit
      // a COPY: aliasing the cleaned list (or the caller's array) would let a
      // downstream mutation of the targets corrupt the evidence/unit.
      // Targets verify against the run's SINGLE checkout (S14 is
      // single-checkout by design) — a target citing another repo simply never
      // greps true there.
      validationTargets: [...citedFiles],
    };

    return [fragment];
  },
};
