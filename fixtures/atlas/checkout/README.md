# Fixture checkout (fake `origin/main` tree) — S14 validation gate

A deliberately tiny, hermetic stand-in for a read-only checkout of
`origin/main`, grepped by `src/atlas/validate.ts` (`promoteValidation`) to
source-verify a candidate's `validationTargets`.

What it asserts (see `src/__tests__/atlas-validate.test.ts`):

- `src/db/atlas.ts` contains the symbol `upsertAtlasSeedCandidate`.
- `src/runtime/shim.ts` contains the symbol `TwoLayerShim`.
- The §7 worked-proof negative symbol appears NOWHERE in this tree (a candidate
  whose validationTarget is that absent symbol yields 0 grep hits, stays
  `unverified`, and — being an architecture fact — is marked `approvable=false`).

IMPORTANT: because the gate does a REAL recursive text grep over this whole
tree, the negative-case symbol must not appear in ANY file here — not even in a
comment or this README. Do not write that token anywhere under
`fixtures/atlas/checkout/`, or the source-verify grep will spuriously match it.

This tree is intentionally outside the TypeScript build (`tsconfig.json`
excludes `fixtures/`); the `.ts` files here are grep targets, not compiled code.
