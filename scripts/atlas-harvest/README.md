# Atlas Harvest — running a harvest end-to-end

This directory is the **Tier-1 leaf-fleet agent harness** for the Atlas seed
harvest. It is the _agent-orchestration half_ of the system; the
_deterministic in-process half_ lives in `src/atlas/**` and is driven by
`src/atlas/harvest-cli.ts`.

The two halves meet at one seam: **fragments on disk**. The leaf fleet writes
one `CandidateFragment` JSON per unit into `runs/<run-id>/fragments/`; the
driver reads them back and runs the deterministic Tiers 2-3 over the corpus.

```
SOURCES ──(Tier-1 leaf fleet: blitz agents, 1 unit each)──▶ runs/<run-id>/fragments/*.json
                                                                      │
                                                       atlas harvest run
                                          (Tier-2 aggregate → classify → Tier-3
                                           canonicalize → rag-dedup → validate)
                                                                      │
                                                       --upsert ▶ pending atlas_seed_entries rows
                                                                      │
                                                     atlas harvest artifact
                                                                      │
                                                        Notion approval page (lead edits it)
                                                                      │
                                                       atlas harvest sync
                                            (checked & ¬excluded & approvable → approve;
                                             else → reject; 409 → conflicted)
                                                                      │
                                                      atlas harvest reindex
                                                          (AtlasDataProvider → pgvector)
                                                                      │
                                                  WIRE-ON (LAST, deferred — see below)
```

The contracts these docs describe are the real ones:

- The fragment schema is `CandidateFragmentSchema` in `src/atlas/types.ts`.
- The driver CLI is `src/atlas/harvest-cli.ts`, mounted as the `harvest`
  subcommand of the installed `atlas` binary (read its top-of-file comment for
  the authoritative subcommand list — it is the source of truth, these docs
  mirror it). Invocations below use the installed form, `atlas harvest <sub>
...`; the from-source equivalents are `npx tsx src/atlas/harvest-cli.ts
<sub> ...` (pre-build) and `node dist/atlas-cli.js harvest <sub> ...`
  (post-build).
- The seven adapters live in `src/atlas/adapters/` and are assembled into the
  `LeafAdapterRegistry` in exactly one place — `buildLeafAdapterRegistry()` in
  `src/atlas/harvest-cli.ts`. There is no shared `src/atlas/adapters/index.ts`.

---

## The pieces

| Artifact                   | What it is                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `blitz-manifest.md`        | The source-sharded blitz decomposition for an actual harvest RUN — one shard per source family, each fanning out to tiny one-unit leaf tasks.                            |
| `leaf-prompt.md`           | The per-leaf agent prompt TEMPLATE — handed ONE unit, builds the fragment the matching adapter would emit, writes exactly ONE fragment JSON.                             |
| `src/atlas/harvest-cli.ts` | The in-process driver CLI (not in this dir — it lives in `src/atlas/`, mounted as `atlas harvest`). Runs Tiers 2-3, generates/syncs the Notion artifact, queues reindex. |

---

## Step 0 — Pick a run id and a runs directory

A run is identified by a `--run-id` (e.g. `2026-06-08-full`) and rooted at a
`--runs-dir` (defaults to `./runs`). Everything for a run lives under
`<runs-dir>/<run-id>/`:

```
runs/<run-id>/
  manifest.json          # counts, timestamps, the run's final exclusion-rule SET
  fragments/
    <fragment-id>.json   # one CandidateFragment per leaf unit
```

Choose the runs directory deliberately — the leaf fleet and the driver MUST
agree on it. The leaf prompt template (`leaf-prompt.md`) takes `<run-id>` and
the absolute fragments directory as inputs.

---

## Step 1 — Run the Tier-1 leaf fleet (this harness)

The leaf fleet is launched as a `blitz` fleet from `blitz-manifest.md`. Each
slot is a _shard_ over one source family (memory, PRs per repo, Notion, Linear,
episodic, source comments, showcase); each shard fans out to tiny leaf tasks,
one **unit** per leaf. Every leaf:

1. is handed ONE small unit (one memory file / one PR+issue+reviews / one Notion
   page / one episodic transcript window / one source-comment block / one
   showcase manifest),
2. shapes it into the matching adapter's `*Unit` input,
3. builds the `CandidateFragment` that adapter would emit — leaves are
   out-of-process agents, so the adapter source in `src/atlas/adapters/` is the
   executable contract they emulate, not code they invoke (episodic alone
   routes through the LLM distill path; `buildLeafAdapterRegistry()` is the
   in-process assembly point and stays unwired in this agent-fleet workflow),
4. writes exactly ONE `CandidateFragment` JSON to
   `runs/<run-id>/fragments/<id>.json`.

See `blitz-manifest.md` for the shard structure and bounded concurrency, and
`leaf-prompt.md` for the copy-pasteable per-leaf prompt.

The output of this step is a directory of fragments. Nothing has touched the DB
yet.

> **Incremental ramp (org discipline).** Do NOT launch the full fleet on the
> first run. Start with ONE shard of ~4 units, run Step 2 as a `--dry-run`,
> confirm the fragments parse, then ramp the shards up. The normal path runs
> the dry-run against a reachable Pathfinder server (bearer-gated
> `GET /api/search` + `ANALYTICS_TOKEN`), which imposes no fragment cap; only
> a serverless ramp — no reachable server — needs to stay at ≤4 fragments or
> stub the search route, because serverless dry-runs fail fast at 5
> consecutive rag-probe failures. See "Smoke-ramp" below.

---

## Step 2 — Drive Tiers 2-3 and write pending rows

The driver reads the fragment corpus and runs the deterministic pipeline:
`aggregate → finalizeClassification → canonicalize → dedupAgainstRagCorpus →
promoteValidation`, then (only with `--upsert`) writes each candidate as a
`pending` row via the existing `upsertAtlasSeedCandidate`.

Preview (writes NOTHING):

```
atlas harvest run \
  --run-id <run-id> \
  --checkout <read-only origin/main checkout dir> \
  --feature-registry <showcase feature-registry.json>
```

Write pending rows:

```
atlas harvest run \
  --run-id <run-id> --upsert \
  --checkout <checkout dir> \
  --feature-registry <feature-registry.json>
```

Required flags / env for `run` (enforced by the driver — it throws if missing):

- `--checkout <dir>` — a read-only `origin/main` checkout the validation gate
  greps to source-verify each candidate's `validationTargets`. Reuse the
  indexer's existing clone dir.
- `--feature-registry <path>` — the showcase `feature-registry.json` the
  validation gate maps claims against to showcase-verify them.
- `--token <token>` or `ANALYTICS_TOKEN` — bearer for the live endpoints; the
  rag-dedup gate probes `GET /api/search`.

Base URL (NOT enforced — the driver warns and falls back if missing):

- `--url <url>` or `PATHFINDER_BASE_URL` — the live Pathfinder base URL; when
  neither is set the driver warns and falls back to `http://localhost:3001`.
  **A live server must be reachable** because the
  rag-dedup gate makes one `search` round-trip per candidate (approximately:
  a candidate with too few distinct tokens to ever clear the overlap floor
  skips its probe entirely).

Useful options: `--runs-dir <dir>` (default `./runs`), `--min-overlap <n>`
(rag-dedup similarity threshold in [0,1]), and `--dry-run` (run the whole
pipeline but write NOTHING — overrides `--upsert`). Note that `--dry-run`
still performs LIVE rag-dedup probes against the server — it skips the
writes, not the probes.

The rag-dedup gate **never drops** a candidate; on corpus overlap it _marks_
the candidate (annotates `provenance.validated_against` + a `fused_from`
evidence ref). The validation gate promotes `validation_status`
(`unverified → source-verified → showcase-verified`) and marks a behavior /
architecture fact that stays `unverified` as `approvable=false` (it is still
written; it just renders non-checkable in the approval artifact).

---

## Step 3 — Generate the Notion approval artifact

```
atlas harvest artifact \
  --run-id <run-id> \
  --parent <parent Notion page id> \
  --checkout <read-only origin/main checkout dir> \
  --feature-registry <showcase feature-registry.json> \
  [--prior-run-id <prior run id>]
```

Requires `--notion-token` or `NOTION_TOKEN`. It ALSO requires `--checkout` and
`--feature-registry` — the SAME flags `run` takes (the driver throws if either
is missing). The artifact runs the IDENTICAL validation stage as `run --upsert`
(aggregate → classify → canonicalize → validate; rag-dedup is skipped because it
is mark-only and never changes `approvable`/`validation_status`), so those two
GATE fields — the ones the approval decision binds to — match what
`run --upsert` writes. Note that rag-dedup's annotations (the
`validated_against` provenance marker and the `fused_from` corpus-evidence
item) reach the upserted rows (their provenance/evidence JSONB) but NOT the
artifact page: the provenance/evidence rendered inline is the pre-rag-dedup
view. The annotations are rank-NEUTRAL by design — `evidenceDepth` filters
corpus-overlap refs out of the depth count, so a duplication mark never
changes a candidate's ranking — and rankScore is never persisted to seed rows
anyway (the artifact page's ordering is its only consumer). The artifact
writes no DB rows itself; it re-runs the pipeline only to get the ranked
candidates, then creates a Notion page under
`--parent` with:

- an **exclusion-rules** section on top (seeded from the prior run's manifest
  rules via `--prior-run-id` + `DEFAULT_EXCLUSION_RULES`), editable in place,
- candidates grouped by subsystem into checkbox (`to_do`) sections in ranked
  order, with flags / provenance / evidence inline.

The command prints the created page id + URL.

---

## Step 4 — Lead edits the page (the SSOT for the run)

The lead opens the Notion page and:

- checks the candidates to KEEP, unchecks the rest,
- edits the exclusion-rules section (adds/removes flag-filters or English-rules).

The edited page is the single source of truth for what gets ratified.

---

## Step 5 — Sync the edited page back to the DB

```
atlas harvest sync \
  --page <approval page id> \
  --actor <name> \
  [--run-id <run-id>]
```

Requires `--notion-token`/`NOTION_TOKEN` and `--token`/`ANALYTICS_TOKEN`. This
reads the edited page, parses the rule edits + checkbox states, applies the
exclusion-rule engine (flag-filters + the English-rule LLM pass), and then:

- checked **and not excluded** → `POST /api/atlas/candidates/approve`,
- everything else → `POST /api/atlas/candidates/reject`,

each stamped with `X-Atlas-Actor: <name>` and the bearer token. A checked row
whose candidate reconstructs as non-approvable is **rejected**, not approved —
the checkbox cannot override `approvable=false` (the §7 gate). A 409 from the
server (row already settled / never existed) is treated as an idempotent no-op,
so a re-run of `sync` is safe; those server-refused ratifications are tallied
in a separate `conflicted` bucket rather than being counted as approved or
rejected. Passing `--run-id` persists the run's final exclusion-rule SET into
its manifest so the _next_ run's artifact can seed from it (omit it and the
driver warns that the rule set will NOT be persisted). The command prints
`<approved> approved, <rejected> rejected, <excluded> excluded-by-rule,
<conflicted> conflicted`.

An accidentally **indented** (Tab-nested) candidate checkbox is still
discovered and enacted — the sync warns and asks you to un-indent it — but
**rule bullets must remain top-level: an indented `atlas-rule:` bullet is not
parsed** — the sync warns about it (within the 3-level nested-scan cap the
sync descends; deeper nesting gets only a generic unscanned-children warning)
and asks you to un-indent it, but the rule stays out of enforcement and
next-run seeding until you do.

---

## Step 6 — Reindex

```
atlas harvest reindex [--scope full|source|repo] [--source <s>] [--repo <url>]
```

Requires `--token`/`ANALYTICS_TOKEN`. Queues a (scoped) reindex via
`POST /admin/reindex`; the `AtlasDataProvider` chunks the now-approved rows,
embeds them, and writes pgvector. `--scope source --source atlas` reindexes only
the Atlas source.

> **Prerequisite:** the scoped example above requires a `type: atlas` source
> block to already exist in the server's loaded deploy config
> (`deploy/copilotkit-docs.yaml`) — `POST /admin/reindex` 400s
> `unknown_source` for any source name not in the loaded config. Add the
> source block before running this step (a commented example of the shape
> lives in `pathfinder.example.yaml`). The source block on its own is
> harmless: without the `atlas-search` tool (Step 7) nothing serves the
> indexed rows.

---

## Step 7 (LAST, DEFERRED) — Wire Atlas on in production

Wire-on is the **deferred final step**, done only **after an approved corpus
exists** (i.e. after Steps 1-6 have produced approved, indexed rows). Note the
`type: atlas` **source block** is NOT part of this step — it is a Step-6
prerequisite (see above). What remains here is **YAML-only**: add the
`atlas-search` tool (`type: search`, `search_mode: "hybrid"`,
`source: "atlas"`) to `deploy/copilotkit-docs.yaml`. (Commented examples of
both the source block and the tool already exist in
`pathfinder.example.yaml`.) The `AtlasSourceConfigSchema` already exists in
the server, so nothing in `src/` changes — flipping the tool YAML on is the
whole job.

Do NOT wire Atlas on before an approved corpus exists; an `atlas-search` tool
over an empty/unapproved corpus serves nothing useful.

---

## Smoke-ramp (verify the seam before a real run)

Before launching the fleet, prove the fragment seam on a tiny ramp (the org's
incremental-ramp discipline):

1. Hand-write ~3-4 valid `CandidateFragment` JSON files into a throwaway
   `/tmp/atlas-smoke/_smoke/fragments/` (conform to `CandidateFragmentSchema` in
   `src/atlas/types.ts` — see the worked examples in `leaf-prompt.md`).
2. Dry-run the driver over them, pointing `--runs-dir` at the SAME throwaway
   root the fragments were written under:

   ```
   ANALYTICS_TOKEN=smoke atlas harvest run \
     --run-id _smoke --runs-dir /tmp/atlas-smoke --dry-run \
     --checkout fixtures/atlas/checkout \
     --feature-registry fixtures/atlas/showcase/feature-registry.json
   ```

   The summary line must report the number of fragment files you wrote — e.g.
   `atlas-harvest run [dry-run] run-id=_smoke: 3 fragments → 3 candidates → 0
upserted` for 3 distinct fragments. A `0 fragments` line means the fragments
   directory and `--runs-dir` do not agree (the run read an empty/missing
   corpus) — the smoke pass is vacuous, fix the paths.

The driver loads the validation context up front (`loadValidationContext`), so a
missing/unreadable `--checkout` or `--feature-registry` throws early with a clear
error before any fragment is read. It then reads + parses every fragment against
`CandidateFragmentSchema` and runs Tiers 2-3 (`aggregate → classify →
canonicalize`) **before** the rag-dedup gate. A malformed fragment fails loud at
that read step with a Zod error.

The normal smoke path points at a live server: the live Pathfinder server
exposes the route the gate probes — a bearer-gated `GET /api/search` doing
lexical search over the indexed corpus — so a smoke run with a reachable
server and `ANALYTICS_TOKEN` set round-trips every probe for real and has no
fragment cap.

If you have no live Pathfinder server, the dry-run **aborts** once the
rag-dedup gate (`dedupAgainstRagCorpus`) sees **5 consecutive** failed `search`
probes: each per-candidate probe failure is caught, logged, and passed through,
but a streak of 5 with no intervening success means "endpoint down or
misconfigured" and the gate fails fast rather than silently disabling itself
for the whole run. Two ways to smoke under that constraint:

- keep the serverless smoke at **≤4 fragments** — under the 5-failure
  threshold every probe error is logged per-candidate and the run continues to
  completion; or
- point `--url` at a **stub** server that answers `GET /api/search` (an empty
  hit list is fine), which exercises the rag-dedup round-trip for real and
  works at any corpus size.

Clean up the throwaway `/tmp/atlas-smoke/` after — never commit a run directory.
