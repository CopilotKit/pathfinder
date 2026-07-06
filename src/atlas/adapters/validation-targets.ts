// Shared cited-target extraction (symbols/paths a decision or fact names).
//
// Three deterministic adapters (notion.ts, memory.ts, github.ts) lift the
// concrete repo-relative PATHS + code SYMBOLS a unit cites into a fragment's
// `validationTargets`, so the validation gate (S14) has something to grep on
// origin/main → source-verified → promotable. The three lifts were
// near-identical and each over-captured in the SAME two ways:
//
//   • the SYMBOL lift (`word(`) matched language KEYWORDS (`if (x)`,
//     `for (…)`, `while (…)`, `switch (…)`, `return (…)`) as if they named a
//     code entity — a spurious target that could source-verify a decision that
//     cites nothing real, wrongly flipping it approvable;
//   • the FILE lift (any dotted token ending in a known extension) matched
//     PROSE runtime/framework tokens (`node.js`, `next.js`, `nuxt.js`) as if
//     they were files — again a spurious, wrongly-approvable target.
//
// Factoring the lift here (mirrors sensitivity-scan.ts's extract-the-shared-
// screen doctrine) gives ONE place to fix both over-captures consistently:
//   • the symbol matcher excludes a language-keyword denylist;
//   • the bare-filename matcher requires either a path separator (that is the
//     PATH form, handled separately) OR a structurally file-shaped bare token —
//     a compound `stem.qualifier.ext` (e.g. `vitest.config.ts`) — so a plain
//     single-dot prose token (`node.js`) does not qualify. A single-dot bare
//     token only qualifies when it is NOT a known prose runtime/framework name.
//
// This is a PURE deterministic regex lift — NO LLM. Output is a Set-deduped
// array; callers sort (notion) or preserve insertion order (memory/github) as
// their pinned suites require, so this module returns the deduped targets and
// leaves ordering to the caller.

// ── Language-keyword denylist (symbol over-capture) ───────────────────────────
//
// A `word(` citation names a call/definition ("dedupAgainstRagCorpus()"), NOT a
// language keyword that is merely followed by a paren in ordinary code prose
// (`if (x)`, `switch (mode)`). These reserved words are never a project symbol
// worth source-verifying, so they are excluded from the symbol lift. Kept as a
// denylist (rather than an allowlist of "looks like a real identifier") because
// the universe of real symbol names is open; only the closed set of keywords
// that syntactically take a trailing `(` needs excluding.
const LANGUAGE_KEYWORDS = new Set<string>([
  "if",
  "for",
  "while",
  "switch",
  "return",
  "catch",
  "function",
  "await",
  "do",
  "else",
  "typeof",
  "instanceof",
  "new",
  "delete",
  "void",
  "yield",
  "throw",
  "in",
  "of",
  "case",
  "with",
  "super",
]);

// ── Known prose runtime/framework tokens (bare-file over-capture) ─────────────
//
// A single-dot bare token whose stem is a well-known runtime/framework name and
// whose extension coincides with a code extension (`node.js`, `next.js`) is
// PROSE, not a repo file — it must not become a bogus file target. A compound
// bare filename (`vitest.config.ts`, two-or-more dots) is structurally file-
// shaped and is kept; a repo-relative PATH (with a "/") is kept by the path
// lift. Only the single-dot bare case needs this screen.
const PROSE_RUNTIME_TOKENS = new Set<string>([
  "node.js",
  "next.js",
  "nuxt.js",
  "nest.js",
  "vue.js",
  "three.js",
  "d3.js",
  "backbone.js",
  "ember.js",
]);

// ── SYMBOL form: an identifier IMMEDIATELY followed by "()" ───────────────────
//
// A call/definition citation ("claimSlug()", "dedupAgainstRagCorpus(...)"). The
// trailing-paren requirement is deliberately conservative: it names a code
// entity a reader spelled as a call, not an ordinary capitalized word. Language
// keywords that also take a trailing paren are filtered out below. The stored
// target is the bare identifier (validate.ts greps the symbol name).
const CITED_SYMBOL_RE = /\b([A-Za-z_$][\w$]*)\s*\(/g;

// ── PATH form: a "/"-bearing token ending in a code/config extension ──────────
//
// validate.ts treats a "/"-bearing target as a path oracle (`isPathLike`), so
// requiring a slash + extension keeps prose like "the auth/session boundary"
// from minting a bogus path target. The extension set matches the memory/github
// FILE forms (a superset of validate's CODE_FILE_EXTENSIONS — a `.md`/`.json`
// path is still a legitimate citation the gate can attempt).
//
// The lookbehind deliberately EXCLUDES "/" from its negated class, and the
// capture group carries an optional leading "/", so an absolute-path citation
// (`/src/db/atlas.ts`) is captured WITH its full directory context. When "/"
// was in the negated lookbehind class the match at the first segment was
// rejected and the lift degraded to the bare filename (`atlas.ts`), stripping
// the directory context the path oracle needs. Word/dot/dash chars stay
// excluded from the lookbehind so mid-token starts (over-capture of prose like
// "and/or") are still rejected.
const CITED_PATH_RE =
  /(?<![\w.-])(\/?(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|json|ya?ml|sh|sql|md))\b/g;

// ── BARE FILE form: a filename with a code/config extension, no path sep ──────
//
// A bare `vitest.config.ts` cited in prose is a legitimate file target. But a
// bare single-dot prose token (`node.js`) is NOT — see PROSE_RUNTIME_TOKENS.
const CITED_FILE_RE =
  /\b[\w-]+(?:\.[\w-]+)*\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|json|ya?ml|sh|sql|md)\b/g;

// True when a bare (no "/") filename token is structurally file-shaped rather
// than a prose runtime name. A compound token (`a.b.ext`, ≥2 dots) is always a
// file; a single-dot token (`node.js`) is a file only when it is not a known
// prose runtime/framework name.
function isBareFileTarget(token: string): boolean {
  const dotCount = (token.match(/\./g) ?? []).length;
  if (dotCount >= 2) return true;
  return !PROSE_RUNTIME_TOKENS.has(token.toLowerCase());
}

// Which target shapes a caller wants lifted. notion cites symbols AND paths
// (its decisions name calls and files); memory/github issues cite files/paths
// only (their prose names files, never bare calls). Selecting per-caller keeps
// each adapter's captured surface identical to before EXCEPT for the two
// over-captures this module removes.
//
// The flags are OPT-IN: a mode runs only when its flag is explicitly `true`.
// An unset flag is OFF, NOT defaulted-on — a files-only caller ({ files: true })
// must not silently re-enable the symbol lift (the `undefined ?? true` bug that
// let a `word(` fragment in files-only prose, e.g. "the retry logic (…", mint a
// bogus `logic` symbol target). The whole-object default below keeps the
// both-enabled behaviour for callers (notion) that pass nothing at all.
export interface ValidationTargetOptions {
  symbols?: boolean;
  files?: boolean;
}

// Extract the deduped cited validation targets from `text`. Returns a Set-
// deduped array in first-seen order; callers sort if their pinned output
// requires it. Language keywords (symbol lift) and prose runtime tokens (bare-
// file lift) are excluded — that is the whole point of this shared module.
//
// A caller that passes NOTHING gets both modes (the default object below); a
// caller that passes an explicit options object gets ONLY the modes it set to
// `true` (opt-in) — an unset flag stays off.
export function extractValidationTargets(
  text: string,
  options: ValidationTargetOptions = { symbols: true, files: true },
): string[] {
  const out = new Set<string>();

  if (options.files) {
    // Paths first, so a bare filename already captured as a path tail can be
    // recognized as redundant below.
    for (const m of text.matchAll(CITED_PATH_RE)) {
      if (m[1]) out.add(m[1]);
    }
    for (const m of text.matchAll(CITED_FILE_RE)) {
      const bare = m[0];
      if (!isBareFileTarget(bare)) continue;
      // A bare filename already captured as the tail of a path token is
      // redundant; keep the more specific path form.
      const coveredByPath = [...out].some(
        (t) => t.includes("/") && t.endsWith(`/${bare}`),
      );
      if (!coveredByPath) out.add(bare);
    }
  }

  if (options.symbols) {
    for (const m of text.matchAll(CITED_SYMBOL_RE)) {
      const sym = m[1];
      if (!sym) continue;
      if (LANGUAGE_KEYWORDS.has(sym.toLowerCase())) continue;
      out.add(sym);
    }
  }

  return [...out];
}
