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
  - `ag-ui` — `ag-ui-protocol/ag-ui`
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
   confirm the fragments parse (Zod) and Tiers 2-3 produce candidates. Against
   a reachable Pathfinder server (bearer-gated `GET /api/search` +
   `ANALYTICS_TOKEN`) the ramp has no fragment cap; only a SERVERLESS dry-run
   must stay at ≤4 fragments or stub the search route, since serverless runs
   fail fast at 5 consecutive rag-probe failures (see the README's
   "Smoke-ramp" section).
3. Widen that shard, then add the next shard, re-running the dry-run gate each
   widening.

This catches a malformed-fragment / wrong-`*Unit`-shape defect at ~4 units
instead of after a thousand-unit fleet.

---

## Concrete enumeration recipe (the pinned real-run scope)

The shards above describe each source family in prose ("merged PRs",
"signal-bearing transcript sessions", "ratified decision pages"). That prose is
the CONTRACT — it does not by itself pin a reproducible scope, which was the
main real-run blocker. This section pins the scope to concrete values so a real
full harvest yields an **explicit, finite, enumerable** candidate set that the
dry-run can count deterministically, without re-deriving "what counts as
signal-bearing" from scratch each run.

### Pinned cutoff

```
CUTOFF=2026-06-01          # gh search qualifier: merged:>=2026-06-01
AS_OF=2026-07-06           # calendar date this recipe's counts were enumerated
```

`CUTOFF` is the single knob that bounds the history-bearing shards (PRs,
issues). It is a fixed calendar date, NOT "last N days" — a relative window is
non-reproducible. Bump it deliberately per run and record the new value + a
fresh `AS_OF` here; the counts below are the enumeration snapshot taken at
`AS_OF`, so a later re-enumeration at the same `CUTOFF` may report a few more
merged PRs (history only grows forward of the cutoff) — that drift is expected
and the dry-run count is re-derived, not assumed.

### Named source sets + reproducible enumeration commands

Each source family below gives (a) the exact command that enumerates its units
and (b) the bounded count observed at `AS_OF`. The commands ARE the
enumeration — re-running them reproduces the set.

#### PRs (Shard 2) — three repos, one sub-shard each

> **Repo path note.** The live AG-UI repo is `ag-ui-protocol/ag-ui` — the
> legacy `CopilotKit/ag-ui` path no longer resolves. The Shard 2 sub-shards and
> the enumeration commands below both use the `ag-ui-protocol/ag-ui` slug.

```
gh pr list --repo CopilotKit/pathfinder   --state merged --search "merged:>=$CUTOFF" --limit 2000 --json number,title,mergedAt
gh pr list --repo ag-ui-protocol/ag-ui    --state merged --search "merged:>=$CUTOFF" --limit 2000 --json number,title,mergedAt
gh pr list --repo CopilotKit/CopilotKit   --state merged --search "merged:>=$CUTOFF" --limit 2000 --json number,title,mergedAt
```

One leaf per PR number in the returned list. Enumerated at `AS_OF`:

| Repo                     | Merged PRs | PR-number range |
| ------------------------ | ---------- | --------------- |
| `CopilotKit/pathfinder`  | 37         | #92 – #133      |
| `ag-ui-protocol/ag-ui`   | 152        | #1215 – #2116   |
| `CopilotKit/CopilotKit`  | 463        | #4519 – #5809   |
| **PR subtotal**          | **652**    |                 |

#### Issues (Shard 3) — co-scheduled with each repo's PR sub-shard

```
gh issue list --repo <repo> --state all --search "closed:>=$CUTOFF reason:completed" --limit 2000 --json number,title
```

Not counted into the pinned dry-run total below (issues are a curated,
signal-bearing subset the lead selects from the enumerated list — root-cause
writeups / design discussions only, not every closed issue). Enumerate, then
curate; the curated list is recorded in the run's `manifest.json`.

#### Memory store (Shard 1)

```
ls "$HOME/.claude/projects/-Users-jpr5/memory"/{reference_,project_,feedback_}*.md
```

One leaf per file. Excludes `MEMORY.md` and the `MEMORY_<domain>.md` Tier-2
index files (the adapter's prefix gate drops anything outside the three
prefixes). Enumerated at `AS_OF`:

| Prefix        | Files |
| ------------- | ----- |
| `reference_`  | 157   |
| `project_`    | 56    |
| `feedback_`   | 412   |
| **Memory subtotal** | **625** |

#### Episodic sessions (Shard 6) — named set

The episodic shard is scoped to the **named handoff sessions**, not the raw
~11k transcript files (which are unbounded and mostly noise). The handoff INDEX
is the enumeration anchor — each handoff names one signal-bearing session:

```
ls "$HOME/.claude/projects/-Users-jpr5/handoffs"/*.md
```

Enumerated at `AS_OF`: **128 named sessions**. Each session is then sliced into
bounded windows (one window = one leaf, per Shard 6); the window count per
session is bounded by the session length, so the leaf count is
`128 sessions → N windows` where `N` is finite and materialized when the shard
enumerates windows. The 128-session set is the pinned, reproducible input; the
window fan-out is deterministic given the sessions.

#### Notion (Shard 4) — named page set

MCP-gated (only agents hold the `Notion` MCP), so the enumeration is an MCP
query rather than a shell command. Pinned scope: **ratified decision / ADR
pages under the CopilotKit engineering Notion space**, anchored at the
`Plans / Proposals` root
(`3173aa38-1852-80e4-91fd-f528aec5e528`). Enumeration query (run via the Notion
MCP `notion-search` / `notion-query-data-sources` at run time, filtered to that
parent subtree):

```
notion-search: parent-subtree of 3173aa38-1852-80e4-91fd-f528aec5e528,
               object=page, status in {ratified, decided, ADR}
```

The resulting page-id list is materialized into the run's `manifest.json` at
enumeration time so the set is frozen for that run (Notion is mutable; the
frozen id list is the reproducible unit set). One leaf per page; the adapter
splits a multi-decision page into N fragments.

#### Linear (Shard 5) — named doc set

MCP-gated (`Linear` MCP). Pinned scope: **Linear design docs + project briefs
carrying ownership/boundary rationale**. Enumeration query (run via the Linear
MCP `list_documents` + `list_projects` at run time):

```
Linear list_documents + list_projects, filtered to design-doc / project-brief
docs updated:>=$CUTOFF
```

As with Notion, the resolved doc/project id list is frozen into the run's
`manifest.json` at enumeration time. One leaf per doc/project.

#### Source-comment blocks (Shard 7) & Showcase (Shard 8)

These enumerate from the CopilotKit / ag-ui **source trees** and the
`showcase/` tree respectively (not from this pathfinder repo). Enumerate at run
time against a checkout of each source tree:

```
# Source-comment blocks: load-bearing "The Problem / The Solution" design blocks
grep -rn "The Problem" <source-checkout>/**   # then curate to design blocks
# Showcase: one leaf per integration manifest
find <showcase-checkout>/showcase -name manifest.yaml
```

Counts are checkout-dependent and materialized at run time; not part of the
pinned dry-run total below (which covers the sources reachable from this
runbook's host).

### Deterministic dry-run count (verification)

Enumerated at `AS_OF=2026-07-06`, `CUTOFF=2026-06-01`, the host-reachable
source sets yield a bounded, finite candidate set:

| Source family          | Pinned unit count | Enumeration                                  |
| ---------------------- | ----------------- | -------------------------------------------- |
| PRs (3 repos)          | 652               | `gh pr list --search "merged:>=$CUTOFF"`     |
| Memory files           | 625               | `ls {reference_,project_,feedback_}*.md`     |
| Episodic sessions      | 128               | `ls handoffs/*.md`                            |
| **Host-reachable total** | **1405 source units** | (before per-leaf KEEP/DROP + window fan-out) |

Notion, Linear, Issues, Source-comments, and Showcase are enumerated at run
time (MCP-gated or checkout-dependent) and their frozen id/file lists are
recorded in the run's `manifest.json`; they add to the total but are not
host-pinnable from this runbook. The **1405** figure counts enumerated SOURCE
units, not leaf units: the 128 episodic entries are transcript *sessions*
(`ls handoffs/*.md`), and the episodic shard fans each session out into one or
more bounded *windows* (one window = one leaf), so the eventual episodic leaf
count is ≥ 128 and the final leaf total is only known after window fan-out. The
**1405** source-unit figure is the reproducible dry-run floor: re-running the
three enumeration commands above at the same `CUTOFF` reproduces it (modulo
forward history growth on the PR shards, which only increases it).

To reproduce the count in one pass:

```
CUTOFF=2026-06-01
prs=$( for r in CopilotKit/pathfinder ag-ui-protocol/ag-ui CopilotKit/CopilotKit; do \
         gh pr list --repo "$r" --state merged --search "merged:>=$CUTOFF" --limit 2000 --json number; \
       done | python3 -c "import sys,json; print(sum(len(json.loads(l)) for l in sys.stdin if l.strip()))" )
mem=$( ls "$HOME/.claude/projects/-Users-jpr5/memory"/reference_*.md \
          "$HOME/.claude/projects/-Users-jpr5/memory"/project_*.md \
          "$HOME/.claude/projects/-Users-jpr5/memory"/feedback_*.md 2>/dev/null | wc -l )
epi=$( ls "$HOME/.claude/projects/-Users-jpr5/handoffs"/*.md 2>/dev/null | wc -l )
echo "PRs=$prs memory=$mem episodic=$epi total=$((prs+mem+epi))"
```

This total is the **input** count (one leaf per unit); the number of fragments
that reach the DB is lower after each leaf applies its adapter's KEEP/DROP
contract (e.g. a `feedback_` file with no operational why-how emits no
fragment) and higher on the Notion shard (multi-decision pages split). The
dry-run (`atlas harvest run --dry-run`, README Step 2 / Smoke-ramp) then
confirms the fragments this scope produces parse and flow through Tiers 2-3.
