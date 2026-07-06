// Atlas validation gate (S14) — the BINDING promotion step (spec §7 / §10).
//
// `promoteValidation(candidate, ctx)` is the last correctness gate before a
// harvested candidate becomes a pending review row. It promotes a candidate's
// `validation_status` along the ladder
//
//     unverified  →  source-verified  →  showcase-verified
//
// using two independent oracles, and enforces the binding approvability rule:
//
//   1. SOURCE-VERIFY — for each of the candidate's `validationTargets` (a symbol
//      name or a repo-relative path), grep a READ-ONLY checkout of origin/main
//      (`ctx.checkoutDir`, a real filesystem walk). ANY hit promotes an
//      `unverified` candidate to `source-verified` — the claim references
//      something that actually exists in the tree.
//   2. SHOWCASE-VERIFY — map the candidate's claim to a feature-registry pill via
//      the S9 `lookupPill` oracle. A `green` pill (shipping & D6-passing) is the
//      strongest signal and promotes to `showcase-verified`. A `quarantined` /
//      `not_supported` / unknown pill does NOT count as verified (the §7
//      quarantine proof: a quarantined `gen-ui-interrupt` pill is not
//      showcase-verified).
//   3. BINDING APPROVABILITY — a behavior/architecture fact
//      (`knowledge_type ∈ {architecture, design-rationale}`) that STILL ends at
//      `unverified` is marked `approvable=false` (the §7 CopilotNext proof). The
//      candidate is never dropped here; `approvable=false` only renders it
//      non-checkable in the approval artifact (S16).
//
// Pure transform: returns a NEW Candidate (and a freshly-built classification
// object) — the input is never mutated. No network; the only I/O is reading the
// injected checkout tree off disk.

import fs from "node:fs";
import path from "node:path";
import { lookupPill } from "./adapters/showcase.js";
import type { FeatureRegistry, PillStatus } from "./adapters/showcase.js";
import {
  BEHAVIOR_KNOWLEDGE_TYPES,
  RAG_NO_DELTA_MARKER,
  RESTATEMENT_MARKER,
} from "./types.js";
import type { Candidate, ValidationStatus } from "./types.js";

// Context handed to the gate: WHERE to source-verify (a read-only origin/main
// checkout) and WHAT to showcase-verify against (the parsed feature registry).
// Assembled by `./validate-checkout.ts` (or directly in tests).
export interface ValidationContext {
  checkoutDir: string;
  featureRegistry: FeatureRegistry;
}

// Behavior/architecture knowledge that stays unverified is guilty-until-
// validated and is NOT approvable (spec §7 proof: the CopilotNext case). The
// gate SET (BEHAVIOR_KNOWLEDGE_TYPES, imported from types.ts) is the single
// contract-level definition, shared with canonicalize and the artifact sync.

// Directories never worth walking when grepping a checkout (vendored/build/VCS
// trees). Keeps the source-verify scan over a real clone bounded and fast.
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
]);

// Ladder ordering so we only ever promote UP, never demote a status an upstream
// stage already assigned (e.g. a leaf adapter that pre-marked showcase-verified).
const STATUS_RANK: Record<ValidationStatus, number> = {
  unverified: 0,
  "source-verified": 1,
  "showcase-verified": 2,
};

function isPathLike(target: string): boolean {
  return target.includes("/") || target.includes(path.sep);
}

// Symbol-style targets shorter than this can never source-verify: a 1-2 char
// needle ("id", "ui") is a common WHOLE identifier token tree-wide — even the
// declaration-aware matcher (`declaresSymbol`) would hit a `const id = …`
// somewhere — so it would falsely promote candidates, defeating the §7
// validation gate.
const MIN_SYMBOL_TARGET_LEN = 3;

// Files larger than this are never worth reading per-target/per-candidate: a
// checked-in lockfile / bundle / fixture blob would be slurped fully into memory
// for every grep, and a feature-claim symbol does not live in such artifacts.
// Skipping them keeps the source-verify scan bounded.
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB

// Source-verify greps ONLY real code files. A `validationTarget` symbol is a
// code declaration (function/const/class/…); a DECL_RE hit inside a `.md`,
// `.json`, `.txt` or other non-code fixture (a doc snippet, a JSON key, a
// changelog entry) is NOT a source declaration and must not promote a candidate
// past §7 — the same fail-safe direction as SKIP_DIRS (vendored/build trees are
// not project source). Extensions are matched lowercased; a file with no
// extension (LICENSE, Makefile, a bare `README`) is never a code declaration
// site and is skipped. Kept as a positive allowlist (rather than a deny-list of
// doc extensions) so a NEW doc/data extension defaults OUT of the grep surface
// — the safe direction for a guilty-until-validated gate.
const CODE_FILE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".swift",
  ".php",
  ".scala",
]);

function isCodeFile(name: string): boolean {
  return CODE_FILE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

// A source-verify match must be a DECLARATION of the needle, not any mention of
// it. Mirrors the `DECL_RE` shape in `adapters/source-comment.ts:182` (the same
// producer/consumer pair — that module EXTRACTS declared symbols, this one
// VERIFIES them) so the two stay in lockstep: a symbol that appears only inside
// a `//`/`#`/JSDoc comment, a string literal, or another symbol's body (a call
// site, an import) is NOT a declaration and must not source-verify — that was
// the §7 bypass (a `root-cause` claim naming a symbol that exists only in a
// prose comment would falsely promote). `<needle>` is escaped and pinned as a
// whole identifier token; the leading `\b` and the trailing identifier-boundary
// lookahead prevent matching a longer declared name that merely starts with the
// needle (e.g. `TwoLayerShim` must not satisfy a `Two` needle).
function declaresSymbol(text: string, needle: string): boolean {
  const re = new RegExp(
    `\\b(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?` +
      `(?:function|const|let|var|class|interface|type|enum)\\s+` +
      `${escapeRegExp(needle)}(?![A-Za-z0-9_$])`,
  );
  return re.test(text);
}

// Escape a string for safe interpolation into a RegExp.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Does `target` exist as a file/dir path inside the checkout? Used for
// validationTargets that name a repo-relative path (e.g. "src/db/atlas.ts")
// rather than a bare symbol.
function pathExistsInCheckout(checkoutDir: string, target: string): boolean {
  const candidate = path.resolve(checkoutDir, target);
  // Guard against a target escaping the checkout via "../" — AND against a
  // degenerate target resolving to the checkout root itself ("./", "a/.."):
  // the root always exists, so accepting it would spuriously source-verify a
  // candidate whose target names nothing in the tree (a §7 gate bypass).
  const root = path.resolve(checkoutDir);
  if (candidate === root || !candidate.startsWith(root + path.sep)) {
    return false;
  }
  // Keep the gate surface consistent with the symbol grep: the grep skips
  // SKIP_DIRS (vendored/build/VCS trees), so a path target inside one
  // (e.g. "node_modules/foo/index.js") must not source-verify either —
  // vendored/build content is not project source and must not promote a
  // candidate past §7 just because the file exists on disk.
  const segments = path.relative(root, candidate).split(path.sep);
  if (segments.some((segment) => SKIP_DIRS.has(segment))) {
    return false;
  }
  // Existence probe via statSync, NOT existsSync: existsSync maps EVERY
  // failure (EMFILE/EACCES/EIO, …) to `false`, silently degrading the §7
  // path-target oracle — the same asymmetry `triageGrepWalkError` (below)
  // exists to prevent on the symbol-grep walk. Unlike the walk, which can
  // warn-and-continue over a readable remainder, a path target has exactly
  // ONE probe, so only plain absence (ENOENT/ENOTDIR — the target or a
  // parent segment simply isn't there) is a quiet `false`; any other errno
  // THROWS loudly naming the target instead of leaving the candidate
  // quietly unverified.
  try {
    fs.statSync(candidate);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new Error(
      `source-verify path check failed for target ${target} (${candidate}) — ` +
        `the candidate would be silently unverified`,
      { cause: err },
    );
  }
}

// Triage a failed filesystem operation on a DESCENDANT entry during the
// source-verify walk, by errno class (the W13 fail-loud rule, one level down —
// a descendant failure must not silently degrade the §7 gate):
//   - EMFILE/ENFILE (fd exhaustion) — every REMAINING entry in the walk would
//     silently skip too, leaving symbols unfound and candidates quietly
//     unverified, so THROW (with the underlying error as `cause`).
//   - ENOENT — the entry vanished mid-walk (e.g. a clone refresh race); a
//     benign skip, no signal needed.
//   - anything else (EACCES, EIO, …) — skip the entry but WARN once, naming
//     the path: the subtree/file is excised from the grep surface and an
//     operator should know the verify ran over an incomplete tree.
function triageGrepWalkError(err: unknown, target: string): void {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === "EMFILE" || code === "ENFILE") {
    throw new Error(
      `source-verify grep exhausted file descriptors at ${target} — the ` +
        `result would be silently incomplete`,
      { cause: err },
    );
  }
  if (code === "ENOENT") return;
  console.warn(
    `[atlas/validate] source-verify grep skipping unreadable ${target}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
  );
}

// Real recursive filesystem grep: walk `dir` and return true as soon as ANY
// CODE file (per CODE_FILE_EXTENSIONS — a `.md`/`.json` fixture is skipped)
// DECLARES `needle` (per `declaresSymbol` — a mere mention in a comment, string,
// or call site does NOT count). Files larger than `MAX_GREP_FILE_BYTES`
// (lockfiles/bundles/fixtures) are skipped before reading; a failed DESCENDANT
// entry is triaged by errno (`triageGrepWalkError`: fd exhaustion throws,
// ENOENT skips quietly, anything else warns + skips). The ROOT is stricter: an
// unreadable/vanished checkout root (EACCES, deleted mid-run) would make EVERY
// symbol target silently unverified — disabling the §7 gate with no signal —
// so ANY root readdir failure THROWS instead of returning all-unverified.
// Stops at the first hit (existence check, not a count).
function grepTreeForSymbol(
  dir: string,
  needle: string,
  isRoot = true,
): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (isRoot) {
      throw new Error(`source-verify grep cannot read checkout root ${dir}`, {
        cause: err,
      });
    }
    triageGrepWalkError(err, dir);
    return false;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (grepTreeForSymbol(full, needle, false)) return true;
      continue;
    }
    if (!entry.isFile()) continue;
    // Only code files carry a source DECLARATION — a DECL_RE hit inside a
    // `.md`/`.json`/`.txt` fixture is doc/data prose, not project source, and
    // must not source-verify (see CODE_FILE_EXTENSIONS).
    if (!isCodeFile(entry.name)) continue;
    let text: string;
    try {
      // Skip oversized files (lockfiles/bundles/fixtures) before reading them
      // fully into memory — they never carry a feature-claim symbol.
      if (fs.statSync(full).size > MAX_GREP_FILE_BYTES) continue;
      text = fs.readFileSync(full, "utf-8");
    } catch (err) {
      triageGrepWalkError(err, full);
      continue;
    }
    // Definition-aware: the needle must be DECLARED here, not merely mentioned
    // (a comment / string / call site does not source-verify).
    if (declaresSymbol(text, needle)) return true;
  }
  return false;
}

// True if ANY validationTarget resolves in the checkout — either as an existing
// repo-relative path or as a symbol that appears somewhere in the tree.
//
// A validationTarget that resolves to a feature-registry pill is a SHOWCASE
// claim (a pill slug like `shared-state` / `human-in-the-loop`), not a code
// symbol. Such slugs appear as identifier-bounded tokens throughout a real
// monorepo's source/docs, so source-grepping them would promote a candidate to
// `source-verified` even when its pill is QUARANTINED — back-dooring the §7
// quarantine. Showcase claims are validated ONLY by the green-pill check
// (`isShowcaseGreen`); here we skip them from the filesystem grep entirely.
function anyTargetFound(ctx: ValidationContext, targets: string[]): boolean {
  const root = path.resolve(ctx.checkoutDir);
  for (const raw of targets) {
    const target = raw.trim();
    if (!target) continue;
    // Skip showcase claims — a target that maps to a registry pill is verified
    // by the green-pill oracle, never by the source-symbol/path grep.
    if (lookupPill(ctx.featureRegistry, target)) continue;
    if (isPathLike(target)) {
      if (pathExistsInCheckout(root, target)) return true;
      continue;
    }
    // Symbol-style target: skip trivially short/common needles (they can never
    // source-verify) and source-verify the rest only where a CODE file DECLARES
    // the symbol (definition-aware; comments/strings/call sites don't count).
    if (target.length < MIN_SYMBOL_TARGET_LEN) continue;
    if (grepTreeForSymbol(root, target)) return true;
  }
  return false;
}

// Map the candidate's claims (claimSlugHint + each validationTarget) to
// feature-registry pills and return whether it is showcase-verified. Per the §7
// invariant — showcase-verified ONLY when EVERY declared pill is green — we
// resolve ALL claims that map to a pill (lookupPill matches by id or human name,
// case-insensitively) and verify only when at least one resolved AND every
// resolved pill is green. A single quarantined / not_supported pill anywhere in
// the claim set blocks verification, regardless of claim order (the §7
// quarantine proof: a quarantined `gen-ui-interrupt` pill is not verified even
// when a green pill is also declared).
//
// The candidate's `title` is DELIBERATELY excluded from the claim set: it is
// free-text distilled prose, and `lookupPill` matches case-insensitively
// against a pill's display `name`. A title that happens to equal a pill name
// would otherwise spuriously resolve to that pill and promote the candidate to
// `showcase-verified`. Showcase claims come only from structured slugs/ids
// (`claimSlugHint`, `validationTargets`), never from the title.
function isShowcaseGreen(ctx: ValidationContext, c: Candidate): boolean {
  const claims = [c.claimSlugHint, ...c.validationTargets];
  const matched: PillStatus[] = [];
  for (const claim of claims) {
    if (!claim) continue;
    const found = lookupPill(ctx.featureRegistry, claim);
    if (found) matched.push(found.status);
  }
  return matched.length > 0 && matched.every((s) => s === "green");
}

// The A.2 restatement floor: S8's distillation-gate stamps `RESTATEMENT_MARKER`
// on a candidate the LLM judge ruled a pure restatement of already-indexed
// content. It follows the SAME carrier idiom the rag-dedup overlap gate uses —
// the marker is written to `provenance.validated_against` (a `"; "`-joined token
// list) and/or as a `fused_from` evidence ref — so this reader checks BOTH,
// matching whole `"; "`-delimited tokens (never a substring: one marker could be
// a prefix of another). A restatement carries no NEW verifiable claim, so its
// symbols happening to grep-verify must NOT lift `approvable` — the marker is a
// hard `approvable=false` floor the source-verify recompute cannot override.
//
// Exported (rather than kept module-private) because the SAME floor must reach
// the RANK path: canonicalize's rankScore is dominated by VALIDATION_WEIGHT
// [validation_status], and this gate PROMOTES validation_status even for a
// restatement (the status is display-truth — the symbols really do exist). If
// the rank read that promoted status, a restatement would OUT-RANK a genuine
// claim purely on the validation weight, surfacing restatement noise above real
// why/how in the ranked artifact. `computeRankScore` imports this predicate to
// floor the validation weight for a restatement, keeping the rank consistent
// with approvable=false. Reads BOTH carrier idioms (validated_against tokens
// and a `fused_from` evidence ref), whole-token matched.
export function hasRestatementMarker(c: Pick<Candidate, "provenance" | "evidence">): boolean {
  return hasFloorMarker(c, RESTATEMENT_MARKER);
}

// Whether the candidate carries a DEDICATED floor marker `marker` on EITHER
// carrier idiom an upstream gate uses: a whole `"; "`-delimited token in
// `provenance.validated_against`, or a `fused_from` evidence ref. Whole-token /
// whole-ref matched (never a substring — one marker could be a prefix of
// another). Shared by the RESTATEMENT_MARKER reader (above) and the composed
// approvability floor (below), which check the two dedicated floor markers the
// upstream gates emit: distillation's RESTATEMENT_MARKER and rag-dedup's
// RAG_NO_DELTA_MARKER.
function hasFloorMarker(
  c: Pick<Candidate, "provenance" | "evidence">,
  marker: string,
): boolean {
  const validatedAgainst = c.provenance.validated_against;
  if (
    validatedAgainst &&
    validatedAgainst.split("; ").some((tok) => tok === marker)
  ) {
    return true;
  }
  return c.evidence.some(
    (e) => e.kind === "fused_from" && e.ref === marker,
  );
}

// Promote a candidate through the validation ladder and enforce the binding
// approvability rule. Returns a NEW Candidate; the input is not mutated.
export async function promoteValidation(
  c: Candidate,
  ctx: ValidationContext,
): Promise<Candidate> {
  const current = c.provenance.classification.validation_status;

  // 1. source-verify (any validationTarget present in the checkout tree).
  let next: ValidationStatus = current;
  if (anyTargetFound(ctx, c.validationTargets)) {
    next = "source-verified";
  }

  // 2. showcase-verify (claim maps to a GREEN feature-registry pill). This is
  //    the strongest tier and supersedes a source-verify promotion.
  if (isShowcaseGreen(ctx, c)) {
    next = "showcase-verified";
  }

  // Only ever move UP the ladder — never demote a status upstream already set.
  const promoted: ValidationStatus =
    STATUS_RANK[next] > STATUS_RANK[current] ? next : current;

  // 3. BINDING approvability — RECOMPUTED from the PROMOTED status, not carried
  //    over from the input: canonicalize runs before this gate and sets
  //    approvable=false on a then-unverified behavior fact, so preserving the
  //    incoming flag would leave every successfully-validated behavior
  //    candidate permanently non-checkable. A behavior/architecture fact still
  //    unverified after promotion is not approvable; everything else is.
  const isBehavior = BEHAVIOR_KNOWLEDGE_TYPES.has(
    c.provenance.classification.knowledge_type,
  );
  // The status-derived rule (canonicalize's isApprovable, recomputed here from
  // the PROMOTED status): a behavior/architecture fact still unverified after
  // promotion is not approvable; everything else clears this rule. This is what
  // LIFTS canonicalize's own pre-validation floor once the gate promotes an
  // unverified behavior fact — that floor is nothing more than this same rule
  // applied at intake, and re-deriving it from the promoted status is the whole
  // point of the recompute.
  const clearsValidationRule = !(isBehavior && promoted === "unverified");

  // COMPOSE upstream FLOORS — the recompute must never RAISE approvability above
  // a value an upstream GATE (not canonicalize's status rule) already floored it
  // to. Two gates floor approvability for reasons the promoted status alone
  // cannot see, and EACH stamps a DEDICATED floor marker so the floor survives
  // this recompute:
  //
  //   - RESTATEMENT_MARKER (S8 distillation gate): a pure restatement of
  //     already-indexed content carries no NEW verifiable claim.
  //   - RAG_NO_DELTA_MARKER (rag-dedup no-delta gate): a pure corpus DUPLICATE
  //     with nothing net-new to re-seed (applyDistillDelta's no-delta floor).
  //
  // The old recompute honored ONLY the restatement marker, so a no-delta
  // duplicate whose symbols grep-verify was clobbered back to approvable=true —
  // silently defeating dedup's "duplicates aren't approvable" guarantee. The
  // structural fix is to compose ALL dedicated floor markers GENERALLY. A
  // dedicated marker is unambiguous: unlike the generic corpus-overlap
  // ANNOTATION (stamped for EVERY overlap verdict, delta included, where the
  // candidate stays approvable), a floor marker is emitted ONLY when the gate
  // truly floors — so it fires the floor regardless of the incoming flag, and
  // canonicalize's pure status-rule floor (which stamps NO marker, e.g. an
  // unverified behavior fact) carries no floor here and is still LIFTED by
  // `clearsValidationRule` on promotion, preserving the successfully-validated-
  // behavior path. Any FUTURE gate that floors approvability just adds its
  // dedicated marker to this set.
  const upstreamFloored =
    hasFloorMarker(c, RESTATEMENT_MARKER) ||
    hasFloorMarker(c, RAG_NO_DELTA_MARKER);

  const approvable = clearsValidationRule && !upstreamFloored;

  return {
    ...c,
    approvable,
    provenance: {
      ...c.provenance,
      classification: {
        ...c.provenance.classification,
        validation_status: promoted,
      },
    },
  };
}
