# Design: Close the local-embeddings half of pathfinder #88

**Status:** DRAFT (pending spec review → Notion → user approval)
**Date:** 2026-06-25
**Context:** Issue #88. The schema half (minimal RAG configs validate) shipped in v1.16.0. The local-embeddings half did not: `@xenova/transformers` is an optional peer dep absent from the published Docker image, so `provider: local` fails — and fails *silently* in the common path. This design closes that gap.

## Problem (verified empirically)

1. **Silent runtime failure + contradictory CLI semantics.** `validate.ts:189-201` does check for `@xenova/transformers` when `embedding.provider === "local"`, but the handling is incoherent:
   - The check pushes to `result.errors[]` (`validate.ts:204-208`), and `cli.ts:105` exits `1` whenever `result.errors.length > 0` — so `validate` **exits non-zero (1)** on a missing dep, even though `formatValidationResult` (`validate.ts:381-400`) *prints* it under "Optional Dependencies … no hard errors." It's labeled a warning but behaves like an error.
   - It only runs **after schema validation passes** — `getServerConfig()` throwing causes an early `return` at `validate.ts:58-59`, so a schema-invalid config never reaches the dep check (this is why the #88 repro never surfaced it).
   - **`serve` startup does not check at all** — the failure is lazy, thrown at first embed (`embeddings.ts:292-294`).
   Net: a user on the default image with `provider: local` boots a healthy-looking server that explodes on the first indexing/search call; and `validate`'s warning-vs-error semantics are self-contradictory.

2. **No supported Docker path for local embeddings.** The dep is commented out in the Dockerfile (`Dockerfile:30-31`); the default `:latest`/`:v*` image (`node:20-slim`, `npm ci --omit=dev`) cannot do local embeddings, and docs only say "install it yourself," which is awkward for image users.

## Goals / Non-goals

**Goals**
- Make `provider: local` without the dep fail **loudly and early**, with an actionable message.
- Provide a **supported Docker image** that can do local embeddings out of the box, without bloating the default image.
- Update docs so a local-embeddings user knows exactly which image / install step to use.

**Non-goals (YAGNI)**
- Pre-downloading embedding models into the image (the ~300MB model download stays lazy at runtime; model choice varies). Possible future enhancement, explicitly out of scope.
- Bundling `pdf-parse`/`mammoth` (document extraction) — same optional-dep pattern, but not part of #88.
- Changing the default image's contents.

## Design

Three independent units.

### Unit 1 — Fail loud at startup (kills the silent failure)
- Add an **eager preflight** in the `serve`/startup path: when `embedding.provider === "local"`, attempt to resolve `@xenova/transformers` at boot. If missing, **exit non-zero immediately** with the actionable message (install the dep **or** use the `-local` image — see Unit 2). Reuse the existing message wording from `embeddings.ts:292` extended with the image hint.
- Fix `validate`'s contradictory semantics: introduce a separate `result.warnings[]` field and route the optional-dep check there instead of `result.errors[]`. `cli.ts:105` then exits **0** when only warnings are present (`validate` is a static linter — it should report the missing dep but not hard-fail a config the user may run elsewhere). The "Optional Dependencies" display section stays; only the exit code is corrected. We do **not** attempt to surface the dep warning on a schema-invalid config — the schema early-return (`validate.ts:58-59`) stays; once the schema half (1.16.0) is fixed, valid configs reach the check, and the real enforcement is the startup guard below. (Dropping the earlier "independent of schema errors" idea as YAGNI.)
- **Interface:** a single `resolveLocalEmbeddingDep()` helper (returns present/absent) used by both paths — startup throws/exits on absent, `validate` appends to `warnings`. One purpose, testable in isolation.
- **Tests (red-green):** (a) startup with `provider: local` + dep absent → process exits non-zero with the actionable message (RED today: boots fine, throws later at first embed); (b) startup with `provider: local` + dep present → boots; (c) startup with non-local provider + dep absent → boots (no false positive); (d) `validate` on a **schema-valid** `provider: local` config + dep absent → prints the warning and **exits 0** (RED today: exits 1).

### Unit 2 — `-local` Docker image variant
- **Dockerfile:** add `ARG INCLUDE_LOCAL_EMBEDDINGS=false` to the prod stage; after `npm ci --omit=dev`, conditionally `RUN` `npm install @xenova/transformers` when the arg is `true`. Default build unchanged (slim).
- **Pipeline (`publish-docker.yml`):** convert the single docker build into a **matrix** of two variants:
  - default (slim): no build-arg → tags `:latest`, `:<ref>` **only**
  - local: `INCLUDE_LOCAL_EMBEDDINGS=true` → tags `:latest-local`, `:<ref>-local` **only**
  Tagging is disjoint by design: `:latest`/`:<ref>` always point at the slim default digest, never at the `-local` digest. Both multi-arch (linux/amd64,arm64), both pushed in the same run. Slack-notify once per run (summarize both).
- **Cadence:** build both variants on **every release** (keeps `-local` in lockstep with `:latest`). Tradeoff: ~doubles the docker build wall-clock and storage. Acceptable given build caching (`type=gha`); if it becomes a problem, the matrix can later gate `-local` behind manual dispatch. Flagged, not silently chosen.
- **Dependency:** Unit 2 stacks on **PR #130** (the workflow_call/job-dependency pipeline fix), verified **OPEN/unmerged as of 2026-06-25** (`0871f60` not on `main`; main's `publish-release.yml` has no docker job). Plan: merge #130 first, then build this on fresh `main`. Unit 1 (startup guard) and the install-step half of Unit 3 do **not** depend on #130 and can ship independently if #130 stalls; only the `-local` image (Unit 2) and the docs lines that point at it require it.
- **Tests:** local `docker build --build-arg INCLUDE_LOCAL_EMBEDDINGS=true` succeeds and `require.resolve('@xenova/transformers')` returns PRESENT inside it; default build still ABSENT. CI matrix run green; post-merge, verify `:latest-local` digest exists and the dep is present (the red-green mirror of the dry-run that proved it absent today).

### Unit 3 — Docs
- `docs/deploy/index.html:448-449` (the "optional peer deps not bundled" note): add that `ghcr.io/copilotkit/pathfinder:latest-local` ships with `@xenova/transformers` preinstalled; default image users wanting local embeddings should use it (or install the dep in a derived image).
- `docs/config/index.html:1442` (the `local` embedding provider section): cross-reference the `-local` image as the Docker-native alternative to `npm install @xenova/transformers`.
- `README.md` Docker + embeddings mentions (lines ~12, ~53, ~93): one-line pointer to the `-local` image for local embeddings.

## Rollout / sequencing
1. #130 merges (pipeline fix) — prerequisite.
2. This change (rebased on #130): Unit 1 + Unit 2 + Unit 3 in one PR.
3. Release as a **minor** bump (new shippable capability: the `-local` image + startup guard). Auto-publishes via the #130 pipeline; verify both image variants land.
4. Comment on #88 with the resolution (schema fix in 1.16.0; `-local` image + startup guard in the new version).

## Risks
- **Build time/storage doubling** — mitigated by gha cache; gate-behind-dispatch is the escape hatch.
- **Startup guard over-eager** — must only trigger for `provider: local`; covered by test (c).
- **#130 not merged** — hard prerequisite; do not start Unit 2 against stale `main`.
