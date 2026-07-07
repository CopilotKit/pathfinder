// Exclusion-rule engine for the Atlas harvest (spec §8.2/§11, plan §4.8 / S13).
//
// The approval artifact carries an editable Exclusion-Rules section; this module
// is the engine that ENACTS those rules at SYNC, over the candidates the lead
// CHECKED (generate renders ALL candidates — the page is the human review
// surface; rules gate enactment, not render). Two rule kinds:
//
//   • flag rules    — a structured predicate over `provenance.classification`
//     (e.g. drop everything `sensitivity:secret`). Evaluated DIRECTLY, in-process,
//     NO LLM. Deterministic and cheap.
//   • english rules — a plain-English instruction ("exclude anything about the
//     Athena engagement") judged per-candidate by the LLM seam (S1)
//     `evaluateEnglishExclusionRule`. ORG RULE: this is the only LLM touchpoint
//     here, routed through the same `LlmDistiller` seam every Atlas stage shares.
//
// `applyExclusions` partitions the candidates into `kept` and `excluded`, where
// each excluded entry records WHICH rule dropped it (for the artifact's audit
// trail). The FIRST matching rule wins — a candidate dropped by a flag rule
// never pays for an LLM call for that or any later rule, and never appears
// twice in `excluded`. Rules are evaluated in LIST ORDER with NO built-in
// flag-before-english precedence (an english rule listed ahead of a flag rule
// still bills its LLM call), so flag rules should be ordered before english
// rules to keep flag-droppable candidates off the LLM entirely —
// DEFAULT_EXCLUSION_RULES does this.
//
// `ExclusionRule` here is the CANONICAL shape (§4.8) and the single source of
// truth: run-store.ts (S2) imports and re-exports this exact type, and validates
// persisted manifests against a runtime Zod mirror of it on read — the persisted
// and in-memory shapes are identical (run-store's read keeps one documented
// structural cast, only to carry the discriminated-union narrowing TS can't
// infer across `keyof()`).

import type { Candidate, Classification } from "../atlas/types.js";
import type { LlmDistiller } from "../atlas/llm.js";

// ── Rule type (canonical; §4.8) ────────────────────────────────────────────────

// LOCKSTEP (mirror width): run-store.ts's `ExclusionRuleSchema` is a hand-kept
// runtime Zod mirror of this union — it must declare exactly the same variants
// and fields (the same WIDTH) as this type. A variant/field added here and not
// there makes `readManifest` REJECT manifests sync legitimately wrote; one
// added only there is hidden by run-store's read-path cast. Change both
// declarations together.
export type ExclusionRule =
  | { kind: "flag"; dimension: keyof Classification; equals: string }
  | { kind: "english"; text: string };

// ── Default rule set ───────────────────────────────────────────────────────────
//
// Seeds the artifact's Exclusion-Rules section on the very first run (later runs
// seed from the prior run's manifest + these, §11.5). Flag rules drop the two
// most-restrictive sensitivities outright; english rules cover the two fuzzy
// categories that can't be captured by a single flag value: leaked credentials
// and customer-identifying go-to-market material.
export const DEFAULT_EXCLUSION_RULES: ExclusionRule[] = [
  // Proprietary and secret material never belongs in the shared corpus.
  { kind: "flag", dimension: "sensitivity", equals: "proprietary" },
  { kind: "flag", dimension: "sensitivity", equals: "secret" },
  // Credentials / secrets that slipped into prose (API keys, tokens, passwords).
  {
    kind: "english",
    text: "Exclude anything that contains or reveals credentials, secret API keys, access tokens, passwords, or other sensitive secret values.",
  },
  // Customer-identifying GTM: deals, account names, sales context tied to a
  // specific named customer or client.
  {
    kind: "english",
    text: "Exclude go-to-market or sales content that identifies a specific named customer, client, or account (deal details, customer engagements, account-specific commercial terms).",
  },
];

// ── Deterministic credential pre-filter (D.2, fail-restrictive) ─────────────────
//
// The english credential rule is judged by the LLM, whose prompt biases toward
// UNDER-exclusion (a leak risk). To make the credential net FAIL-RESTRICTIVE we
// run a deterministic regex over the candidate's text BEFORE the LLM: if a
// recognizable credential shape is present, the candidate is dropped with NO LLM
// call — so a leaked secret is excluded even when the model under-flags it. This
// is a belt-and-suspenders floor UNDER the (now fail-restrictive) LLM judgment,
// never a replacement for it: a clean candidate falls through to the LLM as
// before, and the LLM's fail-CLOSED error behavior is untouched.

// Recognizable high-confidence credential shapes. Anchored to the token PREFIX
// (provider-issued, unmistakable) or the PEM armor — deliberately narrow to avoid
// dropping prose that merely discusses credentials (that ambiguity is the LLM's
// job). Case-sensitive where the real tokens are (sk-/ghp_/AKIA), matching how
// the providers actually emit them.
const CREDENTIAL_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9]{20,}\b/, // OpenAI-style secret key
  /\bghp_[A-Za-z0-9]{20,}\b/, // GitHub personal access token
  /\bAKIA[A-Z0-9]{16}\b/, // AWS access key id
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private-key armor
];

// True when the candidate's title or content carries a recognizable credential.
function containsCredential(candidate: Candidate): boolean {
  const haystack = `${candidate.title}\n${candidate.content}`;
  return CREDENTIAL_PATTERNS.some((re) => re.test(haystack));
}

// True when a plain-English rule is credential-oriented — i.e. the deterministic
// pre-filter should guard it. Keyed on the credential vocabulary so any custom
// cred rule (not just DEFAULT_EXCLUSION_RULES') is covered, while non-credential
// english rules (e.g. customer-GTM) are left to the LLM alone.
function isCredentialRule(
  rule: Extract<ExclusionRule, { kind: "english" }>,
): boolean {
  return /\b(credential|secret|api\s*key|access\s*token|\btoken\b|password)/i.test(
    rule.text,
  );
}

// ── Flag-rule evaluation (pure, no LLM) ─────────────────────────────────────────

// True when the candidate's classification value at `dimension` equals the
// rule's `equals`. Only scalar string-valued dimensions can match: the one
// object-valued dimension (`freshness`) never equals a string, so it simply
// never matches — no throw, no cast.
function flagRuleMatches(
  candidate: Candidate,
  rule: Extract<ExclusionRule, { kind: "flag" }>,
): boolean {
  const value = candidate.provenance.classification[rule.dimension];
  return typeof value === "string" && value === rule.equals;
}

// ── Engine ──────────────────────────────────────────────────────────────────--

// Partition `cands` into kept vs excluded by applying `rules` in order. Flag
// rules are evaluated directly on `provenance.classification`; english rules call
// `llm.evaluateEnglishExclusionRule(rule.text, candidate)`. The FIRST rule that
// excludes a candidate wins (short-circuit). Rules run in LIST order — there is
// no global flag-before-english precedence (an english rule listed ahead of a
// flag rule still bills its LLM call); within a single flag rule no LLM is ever
// consulted, and DEFAULT_EXCLUSION_RULES orders its flag rules first.
export async function applyExclusions(
  cands: Candidate[],
  rules: ExclusionRule[],
  llm: LlmDistiller,
): Promise<{
  kept: Candidate[];
  excluded: { candidate: Candidate; rule: ExclusionRule }[];
}> {
  const kept: Candidate[] = [];
  const excluded: { candidate: Candidate; rule: ExclusionRule }[] = [];

  for (const candidate of cands) {
    let matchedRule: ExclusionRule | undefined;

    for (const rule of rules) {
      if (rule.kind === "flag") {
        if (flagRuleMatches(candidate, rule)) {
          matchedRule = rule;
          break;
        }
        continue;
      }

      // Credential english rules get a deterministic regex FLOOR first: a
      // recognizable credential shape drops the candidate with NO LLM call, so a
      // leaked secret is excluded even when the (conservative) model under-flags
      // it (D.2 fail-restrictive). Non-credential english rules skip this and go
      // straight to the LLM, and a clean candidate falls through to the LLM below.
      if (isCredentialRule(rule) && containsCredential(candidate)) {
        matchedRule = rule;
        break;
      }

      // english rule → LLM judgment over the candidate's salient fields.
      const verdict = await llm.evaluateEnglishExclusionRule(rule.text, {
        title: candidate.title,
        content: candidate.content,
        subsystem: candidate.subsystem,
        classification: candidate.provenance.classification,
      });
      if (verdict.excluded) {
        matchedRule = rule;
        break;
      }
    }

    if (matchedRule) {
      excluded.push({ candidate, rule: matchedRule });
    } else {
      kept.push(candidate);
    }
  }

  return { kept, excluded };
}
