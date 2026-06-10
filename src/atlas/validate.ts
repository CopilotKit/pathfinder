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
import { BEHAVIOR_KNOWLEDGE_TYPES } from "./types.js";
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
// token-bounded matcher (`matchesSymbolToken`) hits it everywhere — so it
// would falsely promote candidates, defeating the §7 validation gate.
const MIN_SYMBOL_TARGET_LEN = 3;

// Files larger than this are never worth reading per-target/per-candidate: a
// checked-in lockfile / bundle / fixture blob would be slurped fully into memory
// for every grep, and a feature-claim symbol does not live in such artifacts.
// Skipping them keeps the source-verify scan bounded.
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB

// Escape a string for safe interpolation into a RegExp.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Match `needle` as a whole identifier token in `text` — bounded on both sides
// by a non-identifier character (or start/end of input). Avoids the substring
// false positives that a raw `text.includes(needle)` produces (e.g. "Two"
// spuriously matching "TwoLayerShim", or "state" matching "stateful").
function matchesSymbolToken(text: string, needle: string): boolean {
  const re = new RegExp(
    `(?<![A-Za-z0-9_$])${escapeRegExp(needle)}(?![A-Za-z0-9_$])`,
  );
  return re.test(text);
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
// regular file's text contains `needle` as a whole identifier token (NOT a raw
// substring — see `matchesSymbolToken`). Files larger than `MAX_GREP_FILE_BYTES`
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
    if (matchesSymbolToken(text, needle)) return true;
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
    // source-verify) and match the rest on identifier word boundaries.
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
  const approvable = !(isBehavior && promoted === "unverified");

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
