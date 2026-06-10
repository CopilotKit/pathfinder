// Atlas memory-store leaf adapter (Tier-1, pure, no LLM).
//
// Maps ONE memory file (a `~/.claude/.../memory/<prefix>_<slug>.md` file with
// YAML frontmatter + markdown body) to zero-or-one `CandidateFragment`, per
// spec §6.1. It is a pure function of one unit (the Tier-1 "one unit each"
// rule, §4) and never touches a shared adapter index — the populated
// `LeafAdapterRegistry` is assembled only in the S18 driver.
//
// Two responsibilities:
//   1. KEEP/DROP classifier keyed on the filename prefix (reference_/project_/
//      feedback_). reference_ and project_ are durable company knowledge → KEEP.
//      feedback_ is mixed: agent-facing operational/infra/codebase why-how is
//      KEEP; pure interaction etiquette (e.g. an availability-signal wording
//      preference) carries no transferable company knowledge → DROP (return []).
//   2. frontmatter → fragment field mapping: name → distilled title,
//      description → provenance.validated_against (and backstops an empty
//      body as content), body → why/how content, originSessionId →
//      provenance, with a conservative first-pass classification.

import { parse as parseYaml } from "yaml";

import type {
  CandidateFragment,
  Classification,
  Provenance,
} from "../types.js";
import { scanSensitivity } from "./sensitivity-scan.js";
import type { AdapterContext, LeafAdapter } from "./types.js";

// ── Input unit ────────────────────────────────────────────────────────────────

// One memory file as the S18 driver hands it over: the filename (which carries
// the reference_/project_/feedback_ prefix the classifier keys on and the slug
// the subsystem/claim-slug derive from) and the raw file contents (frontmatter
// + body).
export interface MemoryFileUnit {
  filename: string;
  contents: string;
}

// ── Frontmatter shape (the stable memory-file convention) ──────────────────────
//
// Real memory files carry `name` / `description` / `type` / `originSessionId`.
// All are read defensively (a hand-written file may omit one) — parsing must
// never throw on a missing optional key.
interface MemoryFrontmatter {
  name?: unknown;
  description?: unknown;
  type?: unknown;
  originSessionId?: unknown;
}

const PREFIXES = ["reference_", "project_", "feedback_"] as const;
type Prefix = (typeof PREFIXES)[number];

// ── Frontmatter / body split ───────────────────────────────────────────────────

// Split a memory file into its YAML frontmatter block and the markdown body.
// Frontmatter is the leading `---\n...\n---` fence; everything after is body.
// A file with no fence yields empty frontmatter and the whole text as body.
//
// Hand-edited files are an explicit input class, so the fence regex tolerates
// an EMPTY frontmatter block (`---\n---\n`, the inner group is optional) and
// trailing whitespace on either fence line. Each fence must still be its own
// line — an inline `---` inside a frontmatter value never closes the block.
function splitFrontmatter(
  contents: string,
  filename: string,
): {
  frontmatter: MemoryFrontmatter;
  body: string;
} {
  const normalized = contents.replace(/^﻿/, "");
  const match = normalized.match(
    /^---[^\S\n]*\r?\n(?:([\s\S]*?)\r?\n)?---[^\S\n]*(?:\r?\n([\s\S]*))?$/,
  );
  if (!match) {
    // A file that OPENS a fence but never closes it falls here — otherwise
    // indistinguishable from "no fence at all", with the YAML lines silently
    // absorbed into the body. Degrading (whole file as body) is the right
    // behavior for a hand-edited file, but never SILENTLY: warn with the
    // filename so an operator can find and repair it.
    if (/^---[^\S\n]*\r?\n/.test(normalized)) {
      console.warn(
        `[atlas/adapters/memory] unterminated frontmatter fence in ${filename} — treating the entire file as body`,
      );
    }
    return { frontmatter: {}, body: normalized.trim() };
  }
  const body = (match[2] ?? "").trim();
  // Malformed YAML (a hand-edited tab indent, an unterminated quote) must not
  // crash the unit — the module's defensive-parsing contract. Degrade to empty
  // frontmatter and keep the body, but never SILENTLY: warn with the filename
  // so an operator can find and repair the hand-edited file.
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch (err) {
    console.warn(
      `[atlas/adapters/memory] malformed YAML frontmatter in ${filename} — degrading to empty frontmatter: ${err instanceof Error ? err.message : String(err)}`,
    );
    parsed = undefined;
  }
  // YAML can parse to a scalar/array (e.g. a fence containing only `- a\n- b`,
  // or a bare string). Only a plain object is a valid frontmatter map; anything
  // else (null, array, scalar) yields empty frontmatter rather than a bad cast.
  const frontmatter: MemoryFrontmatter =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as MemoryFrontmatter)
      : {};
  return { frontmatter, body };
}

// ── Filename → prefix / slug ────────────────────────────────────────────────────

// Strip directory + `.md`, returning the bare basename (e.g.
// `feedback_nextjs_bundles_node_modules`).
function baseName(filename: string): string {
  const last = filename.split("/").pop() ?? filename;
  return last.replace(/\.md$/i, "");
}

function prefixOf(base: string): Prefix | undefined {
  return PREFIXES.find((p) => base.startsWith(p));
}

// The slug is the basename with its classifying prefix removed, normalized to
// kebab-case (underscores → hyphens). Used for both the subsystem hint and the
// claim-slug hint that feeds the canonical key.
function slugOf(base: string, prefix: Prefix | undefined): string {
  const withoutPrefix = prefix ? base.slice(prefix.length) : base;
  return withoutPrefix.replace(/_/g, "-");
}

// ── feedback_ KEEP/DROP heuristic ───────────────────────────────────────────────
//
// reference_/project_ are always KEEP. feedback_ is the only mixed bucket. We
// KEEP a feedback note when it carries agent-facing operational / infra /
// codebase why-how (commands, file paths, tooling, build/deploy/CI mechanics,
// code constructs) and DROP it when it is pure interaction etiquette / a
// stylistic preference with no transferable technical substance.
//
// Signal-based, not allow-listed: presence of a technical signal (a real code
// path, a shell/tooling token, an infra/build term, a fenced/inline code span)
// is evidence of operational substance; an etiquette/preference marker with NO
// technical signal is evidence of pure etiquette. Substance wins ties — a note
// that is BOTH ("user preference" AND a real command) is operational and kept.

// Operational / infra / codebase signals — any one present ⇒ technical substance.
const OPERATIONAL_SIGNALS: RegExp[] = [
  /`[^`]+`/, //                         inline code / commands / paths
  /```/, //                             fenced code block
  /\b\w[\w-]*\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|json|ya?ml|sh|sql|md)\b/i, // a real filename
  /(^|[\s(])\/[\w./-]+/, //             an absolute path
  /\bnode_modules\b|\.next\b|\bdist\b/, // build-output / bundling internals
  /\b(npm|npx|pnpm|yarn|git|gh|docker|tsc|vitest|railway|curl|psql)\b/i, // tooling (dropped bare "op": false-matches English)
  /\b(build|deploy|deployment|ci|cd|pipeline|workflow|webhook|migration|schema|chunk|bundle|container|rebuild)\b/i, // infra/build vocabulary
  // Code constructs — require code-shaped context, not bare English words.
  // `function foo`, `import …`, `export …`, `class Foo`, `interface Foo` are
  // code; bare "function"/"const"/"async" in etiquette prose are not.
  /\b(?:function|class|interface)\s+\w/,
  /\b(?:import|export)\s+/,
  /\b(?:async\s+function|await\s+\w)/,
];

// A feedback note is KEPT when it carries operational/infra/codebase why-how —
// i.e. at least one technical signal is present. Substance wins ties: a note
// that is BOTH a stated preference AND a real command/path is operational and
// kept. A feedback note with no technical signal (pure etiquette, a stylistic
// preference, an availability-signal wording) is NOT transferable company
// knowledge and is dropped.
function feedbackIsKeep(
  name: string,
  description: string,
  body: string,
): boolean {
  const haystack = `${name}\n${description}\n${body}`;
  return OPERATIONAL_SIGNALS.some((re) => re.test(haystack));
}

// ── String coercion ─────────────────────────────────────────────────────────────

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// Date-only ISO stamp (YYYY-MM-DD), derived from the injected clock so the
// adapter is deterministic under test — matches the §12 worked-row date shape.
function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

// ── First-pass sensitivity scan (credential / customer-identifying) ──────────────
//
// Defense-in-depth mirror of notion.ts's careful first pass: a memory note that
// embeds a raw credential or customer-identifying GTM detail must NOT default to
// `internal` (which the DEFAULT_EXCLUSION_RULES let through — they drop only
// proprietary/secret). The scan itself lives in the shared sensitivity-scan
// module (extracted verbatim from here; github/linear apply it too). Memory
// calls it WITHOUT the bare-credential-mention option, so a curated note that
// merely names "API keys" in prose keeps its original, context-qualified
// behavior.

// ── First-pass classification ────────────────────────────────────────────────────
//
// Conservative defaults: memory facts are `internal` (never public) until the
// validate stage promotes them, `unverified` (S14 promotes), `medium`
// confidence (a deliberately-recorded fact, not a guess). reference_/project_
// are PRIMARY (the memory note IS the authored source of record); feedback_
// notes are DERIVED. knowledge_type defaults to the catch-all `operational`.
// Sensitivity is the conservative `internal` baseline UNLESS the credential /
// customer-identifying scan escalates it (defense-in-depth, mirroring notion.ts).
function firstPassClassification(
  prefix: Prefix | undefined,
  now: Date,
  sensitivity: Classification["sensitivity"],
): Classification {
  const provenanceClass: Classification["provenance_class"] =
    prefix === "reference_" || prefix === "project_" ? "primary" : "derived";
  return {
    sensitivity,
    knowledge_type: "operational",
    audience: "all-staff",
    validation_status: "unverified",
    confidence: "medium",
    provenance_class: provenanceClass,
    freshness: { as_of: isoDate(now) },
  };
}

// ── Adapter ──────────────────────────────────────────────────────────────────────

export const memoryAdapter: LeafAdapter<MemoryFileUnit> = {
  sourcetype: "memory",

  async extract(
    unit: MemoryFileUnit,
    ctx: AdapterContext,
  ): Promise<CandidateFragment[]> {
    const base = baseName(unit.filename);
    const prefix = prefixOf(base);
    const { frontmatter, body } = splitFrontmatter(
      unit.contents,
      unit.filename,
    );

    const name = asString(frontmatter.name);
    const description = asString(frontmatter.description);
    const originSessionId = asString(frontmatter.originSessionId);

    // KEEP/DROP gate. reference_/project_ always KEEP. feedback_ KEEPs only
    // operational/infra/codebase why-how. Unknown/absent prefix → DROP (the
    // memory store only emits the three known prefixes).
    if (prefix === "feedback_") {
      if (!feedbackIsKeep(name, description, body)) {
        return [];
      }
    } else if (prefix !== "reference_" && prefix !== "project_") {
      return [];
    }

    // body is the why/how prose; description backstops an empty body.
    const content = body || description;

    // Content-free guard: a KEPT-by-prefix file whose resolved content is
    // empty/whitespace carries no transferable knowledge — emit nothing, matching
    // the sibling adapters (episodic / source-comment / showcase).
    if (content.trim().length === 0) {
      return [];
    }

    const slug = slugOf(base, prefix);

    // `slug` is BOTH the subsystem and the claimSlugHint — STRUCTURAL
    // canonical-key components (<sourcetype>:<subsystem>:<claim-slug>). A
    // bare-prefix filename ("reference_.md") slugs to "" and would mint a
    // degenerate `memory::` key silently, far downstream from the
    // identifiable producer. Fail loud at intake instead, mirroring the
    // notion/github/showcase sibling guards.
    if (slug === "") {
      throw new Error(
        `[atlas/adapters/memory] filename yields an empty slug for ` +
          `${unit.filename} — every memory file must carry a non-empty slug ` +
          `after its reference_/project_/feedback_ prefix.`,
      );
    }

    // First-pass sensitivity scan over name/description/body (defense-in-depth,
    // mirrors notion.ts). Escalates internal → secret/proprietary when a raw
    // credential or customer-identifying GTM detail is embedded; an op:// pointer
    // is SAFE and stays internal.
    const sensitivity = scanSensitivity(name, description, body);

    const provenance: Provenance = {
      // The session that authored the memory note is the primary source.
      source: originSessionId
        ? `memory:${unit.filename} (session ${originSessionId})`
        : `memory:${unit.filename}`,
      date: isoDate(ctx.now),
      // description is the distilled human-written summary of the fact — the
      // single free-text provenance slot carries it forward for the reviewer.
      validated_against: description || undefined,
      classification: firstPassClassification(prefix, ctx.now, sensitivity),
    };

    const fragment: CandidateFragment = {
      sourcetype: "memory",
      subsystem: slug,
      claimSlugHint: slug,
      source_name: unit.filename,
      // name is the already-distilled claim title — NOT the raw filename.
      title: name || slug,
      content,
      provenance,
      evidence: [],
      needsReview: false,
      validationTargets: [],
    };

    return [fragment];
  },
};
