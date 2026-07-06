// Shared first-pass sensitivity scan (credential / customer-identifying GTM).
//
// Extracted VERBATIM from memory.ts so every deterministic adapter that
// stamps a first-pass classification can run the same scan instead of
// hardcoding sensitivity:"internal" — a raw credential or named-customer
// commercial detail that lands `internal` dodges the deterministic
// DEFAULT_EXCLUSION_RULES layer (sensitivity ≥ proprietary), leaving only the
// LLM english-rule layer guarding the leak. The scan is a CONSERVATIVE
// over-flag in the SAFE direction: it can only ESCALATE sensitivity, never
// downgrade — the exclusion stage (S13) is the safety net (module doctrine:
// over-flag-with-exclusion-safety-net).
//
// A raw credential (an embedded API key / token / password / private-key
// block) is the most restrictive → `secret`. A customer-identifying GTM
// signal (a named party tied to commercial terms) → `proprietary`.
//
// Callers: memory.ts (the original — its behavior is pinned by its sensitivity
// suite and must stay byte-identical), github.ts (batch first-pass
// classification over title + RAW body + review-thread/linked-issue evidence —
// the RAW body, not the distilled `content`, so a credential in a stripped
// section still escalates) and linear.ts (batch first-pass classification; the
// webhook path is untouched — B2 byte-equivalence), source-comment.ts (title + raw comment +
// annotated code region — the likeliest credential carrier in the fleet, and
// the only adapter that self-stamps source-verified/high). notion.ts keeps its own page-haystack
// `classifyFirstPass` for knowledge_type and the customer-identifying secret
// tier, but composes this scan ESCALATE-ONLY on top (mostRestrictive of the
// two) so a VALUE-shaped credential on a page — an assignment, a PEM block —
// cannot classify `internal` and dodge DEFAULT_EXCLUSION_RULES.

import type { Sensitivity } from "../types.js";

// op:// is a SAFE 1Password pointer (a reference to where a secret lives, never
// the secret itself). We strip op:// URIs from the haystack BEFORE the credential
// scan so a pointer like `op://Vault/Item/api_token` does NOT false-positive on
// the bare `token`/`api_token` text inside it.
export const OP_POINTER = /\bop:\/\/[^\s`)"']+/gi;

// Raw-credential signals → escalate to `secret`. Patterns are context-qualified
// (an assignment like `api_key=…`/`secret: …`, or a PEM private-key fence) so an
// ordinary mention of the word "token" in prose does not over-flag.
export const CREDENTIAL_SIGNAL: RegExp[] = [
  // `api_key=…`, `api-key: …`, `apikey = …` (assignment-shaped)
  /\bapi[_-]?key\s*[:=]/i,
  // `secret=…`, `secret_key: …`
  /\bsecret(?:[_-]?key)?\s*[:=]/i,
  // `access_token: …`, `auth-token = …`, `api token = …` — a credential-ish
  // keyword prefix is REQUIRED (notion.ts's context-qualified approach), so a
  // benign `token:` in ordinary prose (e.g. a protocol's "resume token:") does
  // NOT over-flag…
  /\b(?:access|auth|api|bearer|refresh|session)[_\- ]?token\s*[:=]/i,
  // …UNLESS the bare assignment's VALUE is secret-shaped: a long opaque run
  // (≥20 token-charset chars, no spaces) after `token[:=]` is an embedded raw
  // credential even without a keyword prefix.
  /\btoken\s*[:=]\s*["'`]?[A-Za-z0-9_./+-]{20,}/i,
  // `password=…`, `passwd: …` — the FULL credential word is required: bare
  // `pass:` is common English prose ("make the tests pass: …") and must not
  // escalate.
  /\bpass(?:word|wd)\s*[:=]/i,
  // PEM private-key block. Key-type header varies (RSA / EC / OPENSSH / DSA /
  // none) — the fence itself IS the credential, so accept any BEGIN…PRIVATE
  // KEY variant.
  /-----BEGIN(?:\s+[A-Z0-9]+)*\s+PRIVATE KEY-----/i,
  // A credential can arrive WITHOUT an assignment shape. The following catch
  // the same class of embedded raw credential the assignment patterns miss;
  // all are context-qualified (require the credential-shaped prefix AND an
  // opaque, credential-length value) so ordinary prose does not over-flag.
  // Escalate-only: they can only raise sensitivity to `secret`.
  //
  // `Authorization: Bearer <opaque>` / a bare `Bearer <opaque>` — the classic
  // API-request credential carrier. An opaque ≥16-char run is required so a
  // capitalized "Bearer bonds" or "the bearer of this note" (short following
  // word) does NOT trip.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  // Well-known high-entropy provider token prefixes (embedded raw credential
  // even without any keyword). GitHub PATs (`ghp_`/`gho_`/`ghs_`/`ghu_`/`ghr_`
  // + a long run, or the newer `github_pat_` form) and `sk-` provider secret
  // keys. The long opaque body is what distinguishes a real token from prose.
  /\bgh[opsur]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9-]{16,}/,
  // AWS access-key id: literal `AKIA` + 16 upper-alnum chars. The fixed prefix
  // + fixed length is specific enough that "AWS" in prose never matches.
  /\bAKIA[0-9A-Z]{16}\b/,
];

// Customer-identifying / GTM signals → escalate to `proprietary`. Mirrors the
// notion.ts heuristic: a named party tied to commercial terms, or explicit GTM
// commercial vocabulary.
export const CUSTOMER_GTM_SIGNAL: RegExp[] = [
  // Singular AND plural — "named customers" / "account names" are exactly as
  // identifying, and a singular-only `\b` match fails before a trailing "s"
  // (under-flag in the LEAK direction).
  /\b(?:named customers?|customer-identif\w+|account names?)\b/i,
  /\b(?:contract value|deal\s+size|deal\s+value|deal\s+flow|arr|acv|pricing|revenue|quota|renewal)\b/i,
];

// Bare credential MENTIONS → escalate to `secret` when the caller opts in.
// No assignment shape required: "rotate the API keys" names real credentials
// even without embedding one. Mirrors notion.ts's CUSTOMER_IDENTIFYING
// credential alternatives (plural forms included — they are exactly as
// identifying). This set is OPT-IN (see ScanSensitivityOptions): the
// high-volume third-party-text adapters (github, linear) use it; memory's
// curated-note scan stays context-qualified so its pinned behavior is
// unchanged.
export const BARE_CREDENTIAL_MENTION: RegExp[] = [
  /\b(?:api[_ -]?keys?|access[_ -]?tokens?|secret[_ -]?keys?|credentials?)\b/i,
];

export interface ScanSensitivityOptions {
  // Also escalate on a bare credential MENTION (BARE_CREDENTIAL_MENTION), not
  // just an assignment-shaped embedded credential. Default false (memory's
  // original, pinned behavior).
  bareCredentialMentions?: boolean;
}

// Decide a first-pass sensitivity from the unit's text parts. Returns the most
// restrictive applicable level; defaults to `internal` for an ordinary note
// (the conservative baseline — never `public`). The three-part signature and
// the `\n` haystack join are memory.ts's original shape, kept byte-identical;
// callers without a middle part pass "".
export function scanSensitivity(
  name: string,
  description: string,
  body: string,
  options: ScanSensitivityOptions = {},
): Sensitivity {
  // Strip SAFE op:// pointers first so they cannot trip the credential scan.
  const haystack = `${name}\n${description}\n${body}`.replace(OP_POINTER, " ");
  if (CREDENTIAL_SIGNAL.some((re) => re.test(haystack))) {
    return "secret";
  }
  if (
    options.bareCredentialMentions &&
    BARE_CREDENTIAL_MENTION.some((re) => re.test(haystack))
  ) {
    return "secret";
  }
  if (CUSTOMER_GTM_SIGNAL.some((re) => re.test(haystack))) {
    return "proprietary";
  }
  return "internal";
}
