# Atlas Harvest — Tier-1 leaf-fleet blitz manifest

This is the `blitz` decomposition for an **actual harvest RUN** (not the
codebase build — that is a different, already-shipped plan). It fans the
Tier-1 acquisition out over the whole company's signal-bearing sources with
maximal parallelism. The deterministic reduce/classify/validate half is NOT in
this fleet — it is the in-process driver (`atlas harvest run`) that
runs AFTER the fleet, over the fragments this fleet produces.

## Shape

- **Sharded by source family.** One shard per source family. A shard is a
  _fan-out_: it enumerates its units and launches one tiny **leaf task** per
  unit. Sharding by family keeps each leaf's adapter, MCP surface, and unit
  shape homogeneous, so the leaf prompt (`leaf-prompt.md`) is parameterized by
  family + unit, not rewritten per leaf.
- **One unit per leaf.** Every leaf is handed exactly ONE small unit and emits
  exactly ONE `CandidateFragment` JSON file. This is the Tier-1 "one unit each"
  rule — it bounds each agent's context to a single artifact so it never skims.
- **The seam is fragments on disk.** Every leaf writes to
  `runs/<run-id>/fragments/<id>.json`. Leaves never touch the DB, never call the
  driver, never read each other's output. The driver consumes the directory.
- **Bounded concurrency.** `blitz` caps live slots at **10** (org ceiling).
  Shards and their leaves are scheduled within that cap; a shard with thousands
  of units drains its leaves through the cap rather than launching all at once.
  Per-family rate limits (esp. MCP-gated families: episodic / Notion / Linear)
  are respected by keeping those shards' leaf concurrency low.

## Run parameters (every shard inherits these)

| Param           | Meaning                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `RUN_ID`        | The run id (e.g. `2026-06-08-full`). All shards write under the same run.                                                |
| `FRAGMENTS_DIR` | Absolute path to `runs/<RUN_ID>/fragments/`. The single write target.                                                    |
| `AS_OF`         | The harvest "as of" calendar date (`YYYY-MM-DD`) stamped into provenance freshness for sources that lack their own date. |

## Fragment id convention

Each leaf owns a unique, filesystem-safe, deterministic file stem so parallel
leaves can never collide. The in-process RunStore writer
(`RunStore.writeFragment`) writes exclusively (`wx`) and FAILS LOUD on
collision — a retried leaf must delete its prior fragment file first (or the
run must use a fresh run id), per the run-store error contract. That guarantee
covers ONLY the in-process writer: leaves are out-of-process and write their
fragment files directly, so each leaf must create its file exclusively (fail
if it already exists — see leaf-prompt step 4), and unique stems remain the
fleet's primary collision defense. Recommended:
`<sourcetype>-<stable-unit-key>` (e.g. `github-pr-pathfinder-1746`,
`memory-feedback_nextjs_bundles_node_modules`, `notion-doc-<pageId>-<n>` for the
n-th decision split off a page). The id is the file stem only — the
`CandidateFragment` body carries the real provenance.

---

## The shards

Each shard below names: the **adapter** whose contract its leaves emulate (in
`src/atlas/adapters/` — leaves are out-of-process agents; the adapter source is
the executable contract, not code a leaf invokes),
the **registry sourcetype** key (as wired in `buildLeafAdapterRegistry()` in
`src/atlas/harvest-cli.ts`), the **`*Unit`** shape each leaf assembles, the
**enumeration** that produces the units, and notes.

### Shard 1 — Memory store

- **Adapter:** `memoryAdapter` — registry key `memory`.
- **Unit:** `MemoryFileUnit { filename, contents }`.
- **Enumerate:** the `reference_` / `project_` / `feedback_` `*.md` files under
  the memory store (`~/.claude/projects/.../memory/`). One leaf per file. Do
  NOT enumerate `MEMORY.md` or the Tier-2 `MEMORY_<domain>.md` topic files —
  they are index/consolidation files, not harvest leaves, and the adapter's
  prefix gate DROPS any filename outside the three known prefixes anyway
  (mining Tier-2 topic content would need a memory-adapter extension; deferred).
- **Notes:** the leaf applies the adapter's KEEP/DROP contract (the adapter
  function is pure — emulate its judgment exactly): `reference_`/`project_` are
  always kept; `feedback_` is kept only when it carries operational/infra
  why-how, else the adapter WOULD return `[]` (the leaf then writes no
  fragment). No LLM, no MCP.

### Shard 2 — Pull requests (one sub-shard PER repo)

- **Adapter:** `githubAdapter` — registry keys `github-pr` AND `github-issue`
  (one adapter object serves both; the fragment's own `sourcetype` field
  distinguishes them per unit).
- **Unit:** `GitHubPullRequestUnit { kind:"pull_request", sourceName, repo:{fullName,cloneUrl,defaultBranch}, pullRequest:{number,title,body?,htmlUrl,mergeCommitSha?,baseRef?,headRef?,author?,mergedBy?}, changedFiles?, linkedIssues?, reviewThreads? }`.
- **Sub-shards (one each):**
  - `pathfinder` — `CopilotKit/pathfinder`
  - `ag-ui` — `CopilotKit/ag-ui`
  - `CopilotKit` — `CopilotKit/CopilotKit`
- **Enumerate (per sub-shard):** merged PRs in the repo (signal-bearing
  history). One leaf per PR; the leaf fetches the PR's changed-file list, linked
  issues, and resolved review threads via the GitHub API/`gh` and assembles the
  unit. Heavy PRs (large file lists) stay one-unit-per-leaf — do NOT batch.

### Shard 3 — Issues (folded into the PR shards, or its own sub-shard)

- **Adapter:** `githubAdapter` — registry key `github-issue`.
- **Unit:** `GitHubIssueUnit { kind:"issue", sourceName, repo:{...}, issue:{number,title,body?,htmlUrl,author?,state?}, linkedIssues?, reviewThreads? }`.
- **Enumerate:** signal-bearing issues (root-cause writeups, design discussions)
  per repo. One leaf per issue. Co-scheduled with the matching repo's PR
  sub-shard so a repo's GitHub access stays in one rate-limit bucket.

### Shard 4 — Notion

- **Adapter:** `notionAdapter` — registry key `notion-doc`.
- **Unit:** `NotionPageUnit { url, title, subsystem, repo_url?, ref?, date?, sections:[{heading,body}] }`.
- **Enumerate:** ratified decision pages / ADR sets (e.g. design-decision pages
  under the engineering Notion space). One leaf per **page**. The adapter splits
  a multi-decision page into N fragments by its decision headings, so one page
  can yield several fragments from one leaf.
- **Notes:** MCP-gated (`Notion` MCP) — only agents hold it. Keep leaf
  concurrency low. The adapter does a sensitivity-careful first pass (GTM →
  `proprietary`, customer-identifying → `secret`) but never drops; the exclusion
  stage in the driver is the safety net. May be split into multiple sub-shards
  by Notion space if the page count is large.

### Shard 5 — Linear

- **Adapter:** `linearAdapter` — registry key `linear-doc`.
- **Unit:** `LinearDocUnit { url, title, problem?, why?, nonGoals?, citedFiles?, notionCrossLink?, subsystem?, area?, updatedAt?, knowledgeType? }`.
- **Enumerate:** Linear design docs + project briefs (where ownership/boundary
  rationale lives). One leaf per doc/project. The leaf projects the Linear MCP
  payload down to the `LinearDocUnit` (it does NOT hand the raw payload to the
  adapter).
- **Notes:** MCP-gated (`Linear` MCP). When a doc cross-links a Notion ADR for
  the same decision, set `notionCrossLink` so the adapter records a dedup hint
  the driver's Tier-2/Tier-3 can collapse.

### Shard 6 — Episodic transcripts (windowed; may be several sub-shards)

- **Adapter:** `episodicAdapter` — registry key `episodic`. **The only
  LLM-backed adapter** — its leaf passes a `ctx.llm` (`OpenAIDistiller`).
- **Unit:** `EpisodicWindowUnit { convPath, date, text, subsystem? }`.
- **Enumerate:** signal-bearing transcript sessions, sliced into bounded
  **windows** (one window = one unit). One leaf per window. The leaf reads the
  window via the episodic-memory MCP, then calls the LLM distill path
  (`distillEpisodicWindow`) — NOT a plain adapter call.
- **Notes:** episodic knowledge is NEVER self-verifying — every fragment comes
  out `needsReview=true`, `validation_status="unverified"`,
  `provenance_class="derived"`, `confidence="low"` (clamped — a stronger
  distiller signal is an unsafe escalation), and `sensitivity` floored at
  `"internal"` (any stronger distiller signal is preserved) — the adapter
  re-asserts all of these. LLM calls go
  through the `OPENAI_BASE_URL` seam. Keep concurrency low (LLM + MCP). Split
  into sub-shards by session-date range if the window count is large.

### Shard 7 — Source-comment / agent-doc blocks

- **Adapter:** `sourceCommentAdapter` — registry key `agent-doc`.
- **Unit:** `SourceCommentUnit { filePath, lineStart, lineEnd, commentText, codeRegion, subsystem?, repoUrl?, ref?, sourceUrl? }`.
- **Enumerate:** load-bearing design-block comments ("The Problem / The
  Solution", intentional-coupling rationale written directly above the code it
  justifies) across the CopilotKit/ag-ui source trees. One leaf per
  comment+code block. The leaf slices the comment block and the
  immediately-following code it annotates.
- **Notes:** pure, no LLM. The fragment is `derived` ("derived, never a copy" —
  the claim fuses comment + code), comes out `source-verified` (the comment
  lives at a real `file:line`), and carries the annotated symbols as
  `validationTargets`.

### Shard 8 — Showcase integrations

- **Adapter:** `showcaseAdapter` — registry key `derived`.
- **Unit:** `ShowcaseUnit { manifest: ShowcaseManifest, registry: FeatureRegistry }`
  where `ShowcaseManifest { integration, name?, repo_url?, description?, features:[...] }`.
- **Enumerate:** one leaf per `showcase/<integration>/manifest.yaml`. Each leaf
  parses that integration's manifest AND the central
  `showcase/shared/feature-registry.json`, pairs them into the `ShowcaseUnit`,
  and builds the one `derived` fragment the adapter would emit (fusing them
  into a description of the integration's feature support).
- **Notes:** pure, no LLM. The fragment is `showcase-verified` ONLY when EVERY
  declared pill resolves to a `green` status; if any pill is
  `quarantined`/`not_supported`/unknown it stays `unverified` + `needsReview`.

---

## Concurrency / scheduling summary

| Shard            | Adapter                | Registry key(s) | MCP-gated      | LLM     | Concurrency           |
| ---------------- | ---------------------- | --------------- | -------------- | ------- | --------------------- |
| 1 Memory         | `memoryAdapter`        | `memory`        | no             | no      | high                  |
| 2 PRs (×3 repos) | `githubAdapter`        | `github-pr`     | no (gh/API)    | no      | high, per-repo bucket |
| 3 Issues         | `githubAdapter`        | `github-issue`  | no (gh/API)    | no      | with repo bucket      |
| 4 Notion         | `notionAdapter`        | `notion-doc`    | yes (Notion)   | no      | low                   |
| 5 Linear         | `linearAdapter`        | `linear-doc`    | yes (Linear)   | no      | low                   |
| 6 Episodic       | `episodicAdapter`      | `episodic`      | yes (episodic) | **yes** | low                   |
| 7 Source-comment | `sourceCommentAdapter` | `agent-doc`     | no             | no      | high                  |
| 8 Showcase       | `showcaseAdapter`      | `derived`       | no             | no      | high                  |

Global live-slot cap: **10** (org `blitz` ceiling). Pure shards (1, 2, 3, 7, 8)
can run wide; MCP/LLM shards (4, 5, 6) run narrow to respect rate limits.

## After the fleet

This fleet produces ONLY fragments — it does NOT decompose-then-execute into the
in-process pipeline (blitz and the driver do not compose). When every shard
reports DONE, the fragments dir is the handoff. The orchestrator then runs the
driver over it:

```
atlas harvest run --run-id <RUN_ID> --upsert \
  --checkout <checkout dir> --feature-registry <feature-registry.json>
```

See `README.md` for the full Steps 2-7 (run → artifact → edit → sync → reindex
→ deferred wire-on).

## Incremental ramp (mandatory)

Do NOT launch all shards at full width on the first run. Ramp:

1. Run ONE shard (e.g. Memory) limited to ~4 units → ~4 fragments.
2. `atlas harvest run --run-id <RUN_ID> --dry-run ...` and
   confirm the fragments parse (Zod) and Tiers 2-3 produce candidates
   (serverless dry-runs fail fast at 5 consecutive rag-probe failures — keep
   the serverless ramp at ≤4 fragments or stub the search route; see the
   README's "Smoke-ramp" section).
3. Widen that shard, then add the next shard, re-running the dry-run gate each
   widening.

This catches a malformed-fragment / wrong-`*Unit`-shape defect at ~4 units
instead of after a thousand-unit fleet.
