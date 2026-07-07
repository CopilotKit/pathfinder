// Layer-2 REAL-LLM eval for the distillation judge's REWRITE branch (Theme A.1).
//
// ORG RULE: an aimock REPLAY test cannot prove a PROMPT change — the fixture is
// canned, so it will pass regardless of what the prompt says. Proving that
// DISTILLATION_SYSTEM_PROMPT actually stops the judge from paraphrasing away
// concrete verifiable detail requires exercising the REAL failure surface: a
// REAL OpenAI call through the REAL prompt. This file does exactly that.
//
// It is OPT-IN — gated on `OPENAI_API_KEY`. In normal CI (no key) the whole
// suite is SKIPPED via `describe.skipIf`, so it never spends tokens or flakes on
// missing credentials. It runs only when a real key is present (the red-green
// proof for the prompt fix).
//
// The bug it guards: on a `rewritten` verdict the model used to paraphrase a
// precise HOW/WHAT claim ("POST /admin/:op returns 401 via timingSafeEqual")
// into generic WHY prose ("unified authentication enhances security"), dropping
// every concrete identifier. The fix teaches the judge to RETAIN every
// endpoint/status-code/symbol/config on a rewrite (or fall back to `distilled`
// pass-through when it cannot). So the assertion is: whatever the verdict, the
// returned content must still carry the source's concrete tokens.

import { describe, expect, it } from "vitest";

import { OpenAIDistiller } from "../atlas/llm.js";
import type { DistillationJudgeInput } from "../atlas/llm.js";

// The model the code actually uses (OpenAIDistiller's DEFAULT_MODEL). Pinned so
// the eval exercises the real judge path, not some other model.
const JUDGE_MODEL = "gpt-4o-mini";

// An admin-ops-style fragment carrying dense concrete verifiable detail: an
// endpoint route, four HTTP status codes, a named crypto symbol, a config key,
// and a dropped env-var name. Crucially it is framed as a WHAT-restatement (a
// "PR #N: unify …" title, terse "adds/validates/returns" body with a single
// light "so operators manage one credential" why-hook) — that framing INVITES
// the judge onto the `rewritten` branch instead of `distilled`, which is the
// exact branch that pre-fix paraphrased every specific away into "unify
// authentication … enhances security … simplify access control" (the
// live-observed drop). Verified pre-fix: gpt-4o-mini rules this `rewritten` and
// drops POST /admin/:op, 401, and trust_proxy on every run.
const ADMIN_OPS_INPUT: DistillationJudgeInput = {
  title: "PR #412: unify admin auth on ANALYTICS_TOKEN",
  content:
    "Adds a POST /admin/:op endpoint. Validates the ANALYTICS_TOKEN header " +
    "with timingSafeEqual. Returns 202 on success, 400 on a malformed body, " +
    "401 on a bad token, 503 when overloaded. Sets trust_proxy and rejects an " +
    "unresolved forwarded client IP. Removes the old PATHFINDER_ADMIN_TOKEN " +
    "so operators manage one credential instead of two.",
  knowledge_type: "security",
};

// Assert on token PRESENCE, never exact strings — a rewrite is allowed to
// rephrase the surrounding prose, it just must not DROP the concrete detail.
function expectSpecificsRetained(content: string): void {
  expect(content).toContain("POST /admin/:op");
  expect(content).toContain("timingSafeEqual");
  expect(content).toMatch(/\b401\b/);
  expect(content).toContain("trust_proxy");
}

describe.skipIf(!process.env.OPENAI_API_KEY)(
  "judgeDistillation REWRITE branch preserves concrete specifics (real LLM)",
  () => {
    it("a rewritten verdict RETAINS endpoints/status-codes/symbols/config (or falls back to distilled pass-through)", async () => {
      // No baseURL → the REAL OpenAI API (honors OPENAI_API_KEY). temp 0 and the
      // pinned model make this as reproducible as a real model allows.
      const distiller = new OpenAIDistiller({ model: JUDGE_MODEL });

      const verdict = await distiller.judgeDistillation(ADMIN_OPS_INPUT);

      if (verdict.kind === "rewritten") {
        // The failure surface: on a rewrite the concrete detail must survive.
        expectSpecificsRetained(verdict.content);
      } else if (verdict.kind === "distilled") {
        // Acceptable pass: `distilled` is pure pass-through — the gate keeps the
        // ORIGINAL content, which by construction carries all the specifics. This
        // is the "prefer distilled over a lossy rewrite" fallback the fix adds.
        expectSpecificsRetained(ADMIN_OPS_INPUT.content);
      } else {
        // A `restatement` verdict would DROP this fragment (no salvage), which is
        // wrong for a dense concrete-mechanism claim — fail loud.
        throw new Error(
          `expected distilled or rewritten for a concrete-mechanism claim, got ${verdict.kind}`,
        );
      }
    });
  },
);
