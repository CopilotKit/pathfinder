# Atlas Harvest — local sandbox runbook

This is the operator runbook for standing up a **fully local, zero-cost
sandbox** of the Atlas seed-harvest loop: a throwaway pgvector database, a
Pathfinder server on a prod-derived config with an **empty corpus** (no real
indexing, no OpenAI calls — a dummy embedding key suffices), a tiny
hand-written fragment corpus, and the full `harvest run → ratify → reindex`
loop exercised against it. For what the pipeline IS — tiers, adapters,
fragments, the Notion artifact — see [README.md](./README.md); this document
only covers wiring the sandbox around it.

Pick a **sandbox home** outside the repo (e.g. `~/pathfinder-sandbox/`) and
keep everything non-repo there: `sandbox.yaml`, `runs/`, `server.log`. Never
commit any of it.

## Prerequisites

- Docker (for the pgvector container).
- Node ≥ 20; build the worktree once: `npm ci && npm run build` (produces
  `dist/index.js` and `dist/atlas-cli.js`).
- A checkout of this repo to run the server and CLI from. A detached
  `origin/main` worktree works well:
  `git fetch origin main && git worktree add .claude/worktrees/atlas-sandbox origin/main --detach`.
- No real credentials. `OPENAI_API_KEY` is a dummy, `ANALYTICS_TOKEN` is any
  string (no minimum length), `MCP_JWT_SECRET` is random per start.

## 1. Database

Port 5432 is commonly taken by another local postgres — check with
`lsof -i :5432` first, and map the container to **5433**:

```
docker run -d --name atlas-sandbox-db -p 5433:5432 \
  -e POSTGRES_USER=mcp -e POSTGRES_PASSWORD=mcp_local -e POSTGRES_DB=mcp_docs \
  pgvector/pgvector:pg16
```

```
DATABASE_URL=postgresql://mcp:mcp_local@localhost:5433/mcp_docs
```

The schema migrates automatically at server boot — there is no manual
migration step.

## 2. Sandbox config

`sandbox.yaml` is a **derivation of the prod deploy config**
(`deploy/copilotkit-docs.yaml`), not a from-scratch config. Start from the
prod file and apply these deltas:

| #   | Prod                                            | Sandbox                                                                                                                                                                                 | Why                                                                                                                                           |
| --- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `server.name`, `allowlist`, `trust_proxy: true` | name suffixed `-sandbox`; allowlist and trust_proxy **dropped**                                                                                                                         | Crawler-IP allowlist and proxy trust are Railway-edge concerns                                                                                |
| 2   | 4 file sources over real docs/code repos        | same 4 source names/types/chunking, but `repo` → `https://github.com/CopilotKit/pathfinder.git`, `path: "."`, and `file_patterns` deliberately **non-matching** (`**/*.sandbox-none.*`) | Startup `checkAndIndex` clones one small repo and indexes **0 chunks per source** — zero embedding calls, so the dummy key is never exercised |
| 3   | no `type: atlas` source                         | `type: atlas` source block **added**                                                                                                                                                    | Step-6 prerequisite — `POST /admin/reindex` 400s `unknown_source` for `--source atlas` without it                                             |
| 4   | `indexing.auto_reindex: true`                   | `false`                                                                                                                                                                                 | No nightly reindex in the sandbox                                                                                                             |
| 5   | `webhook:` block (repo_sources/path_triggers)   | **removed**                                                                                                                                                                             | No webhook surface locally                                                                                                                    |
| 6   | tools (4 search + 2 bash + 1 collect)           | identical structure, descriptions shortened                                                                                                                                             | Keep the tool surface real                                                                                                                    |

The two snippets that matter. Each file source keeps its prod shape but
matches nothing:

```yaml
sources:
  - name: docs
    type: markdown
    repo: https://github.com/CopilotKit/pathfinder.git
    path: "."
    file_patterns:
      - "**/*.sandbox-none.mdx"
    chunk:
      target_tokens: 600
      overlap_tokens: 50
  # ... code / ag-ui-docs / ag-ui-code follow the same pattern
```

And the atlas source block (shape template: `pathfinder.example.yaml`):

```yaml
- name: atlas
  type: atlas
  seed_path: .pathfinder/atlas/seed
  cache_namespace: pathfinder-sandbox
  repositories:
    - repo_url: https://github.com/CopilotKit/pathfinder.git
      refs: ["main"]
  chunk:
    target_tokens: 800
    overlap_tokens: 80
```

Expect `Found 0 files for full acquire (... excluded by patterns)` per file
source at boot — that is the design, not a failure.

## 3. Server

Run `node dist/index.js` from the built checkout with this environment:

| Variable            | Value                                                | Notes                                                                                                                  |
| ------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`      | `postgresql://mcp:mcp_local@localhost:5433/mcp_docs` | The Step-1 container                                                                                                   |
| `PATHFINDER_CONFIG` | `<sandbox>/sandbox.yaml`                             | Absolute path                                                                                                          |
| `ANALYTICS_TOKEN`   | `sandbox-smoke`                                      | The bearer for every API call below; any string works                                                                  |
| `OPENAI_API_KEY`    | `sandbox-dummy`                                      | Must be SET (search tools + `embedding.provider: openai` exist in the config) but is never called over an empty corpus |
| `PORT`              | `3001`                                               |                                                                                                                        |
| `NODE_ENV`          | `production`                                         | **Required to exercise the 401 path** — in dev mode `bearerTokenAuth` bypasses the token check for localhost requests  |
| `MCP_JWT_SECRET`    | random (`openssl rand -hex 32`)                      | **Required whenever `NODE_ENV=production`** — startup is fatal without it. The two settings travel together            |

On macOS, daemonize via Python — `nohup` + `disown` dies with a spawning
subagent shell, and **`env=env` must be passed explicitly** (omitting it
silently drops `PATHFINDER_CONFIG` and the server dies with
`No pathfinder.yaml found`):

```
python3 -c "
import subprocess, os, secrets
env = dict(os.environ)
env.update({
  'DATABASE_URL': 'postgresql://mcp:mcp_local@localhost:5433/mcp_docs',
  'PATHFINDER_CONFIG': '<sandbox>/sandbox.yaml',
  'ANALYTICS_TOKEN': 'sandbox-smoke',
  'OPENAI_API_KEY': 'sandbox-dummy',
  'PORT': '3001',
  'NODE_ENV': 'production',
  'MCP_JWT_SECRET': secrets.token_hex(32),
})
log = open('<sandbox>/server.log', 'ab')
p = subprocess.Popen(['node', 'dist/index.js'],
  cwd='<checkout>',
  stdout=log, stderr=log, env=env, start_new_session=True)
print('PID', p.pid)
"
```

Poll `curl -s http://localhost:3001/health` until 200, then prove the bearer
gate both ways:

```
curl -s -H "Authorization: Bearer sandbox-smoke" "http://localhost:3001/api/search?text=hello"
#   → 200 {"hits":[]}
curl -s "http://localhost:3001/api/search?text=hello"
#   → 401 {"error":"unauthorized",...}   (only with NODE_ENV=production)
```

`/api/search` is lexical (tsvector over `chunks`) — no embedding call, so it
works with the dummy key at any corpus state.

## 4. Seed fragments

Instead of running the leaf fleet (README Step 1), hand-write a tiny fragment
corpus under the run-store layout:

```
<sandbox>/runs/_smoke/
  manifest.json
  fragments/
    <fragment-id>.json    # one CandidateFragment each
```

The validation-passing recipe for hand-written fragments:

- `knowledge_type: operational` with `validationTargets: []` passes the
  fixtures checkout (`fixtures/atlas/checkout`). The candidate stays
  `unverified`, which is still **approvable** for non-behavior knowledge
  types — only architecture/design-rationale are gated by §7.
- Use **distinct `subsystem` values** per fragment, or Tier-2 fuses them into
  one candidate.
- Keep the corpus at **≤4 fragments** if no live server will back the
  rag-dedup probes (the 5-consecutive-probe-failure abort — see the README's
  Smoke-ramp section). With the Step-3 server up, probes round-trip for real
  and there is no cap.
- The schema is `CandidateFragmentSchema` in `src/atlas/types.ts`; the worked
  example in `leaf-prompt.md` is sufficient as a template.

A complete working fragment:

```json
{
  "sourcetype": "memory",
  "subsystem": "sandbox-database",
  "claimSlugHint": "sandbox-db-runs-on-5433",
  "source_name": "memory/feedback_sandbox_db_port.md",
  "title": "Sandbox pgvector database runs on host port 5433",
  "content": "The local atlas sandbox runs pgvector/pgvector:pg16 in a dedicated container mapped to host port 5433 because port 5432 is occupied by another local postgres. DATABASE_URL must therefore point at localhost:5433 with user mcp and database mcp_docs.",
  "provenance": {
    "source": "memory:memory/feedback_sandbox_db_port.md",
    "date": "2026-06-10",
    "classification": {
      "sensitivity": "internal",
      "knowledge_type": "operational",
      "audience": "engineering",
      "validation_status": "unverified",
      "confidence": "medium",
      "provenance_class": "derived",
      "freshness": { "as_of": "2026-06-10" }
    }
  },
  "evidence": [],
  "needsReview": false,
  "validationTargets": []
}
```

`manifest.json` (schema: `RunManifestSchema` in `src/atlas/run-store.ts`):

```json
{
  "runId": "_smoke",
  "createdAt": "2026-06-10T00:00:00.000Z",
  "updatedAt": "2026-06-10T00:00:00.000Z",
  "fragmentCount": 3,
  "ruleSet": []
}
```

The driver rewrites `updatedAt` on each run, and strictly speaking the run
works without a pre-existing manifest (`readManifest` returns undefined) —
creating it just matches the run-store layout.

## 5. Dry-run + upsert

Dry-run needs only the bearer and the base URL:

```
ANALYTICS_TOKEN=sandbox-smoke PATHFINDER_BASE_URL=http://localhost:3001 \
  node dist/atlas-cli.js harvest run --run-id _smoke \
  --runs-dir <sandbox>/runs --dry-run \
  --checkout fixtures/atlas/checkout \
  --feature-registry fixtures/atlas/showcase/feature-registry.json
#   → atlas-harvest run [dry-run] run-id=_smoke: 3 fragments → 3 candidates → 0 upserted
```

`--upsert` additionally needs `PATHFINDER_CONFIG`, `DATABASE_URL`, and
`OPENAI_API_KEY` (it loads the full server config for the DB write path;
missing config → `No pathfinder.yaml found`, missing key →
`Missing required environment variables`; the dummy key is fine):

```
OPENAI_API_KEY=sandbox-dummy \
PATHFINDER_CONFIG=<sandbox>/sandbox.yaml \
DATABASE_URL=postgresql://mcp:mcp_local@localhost:5433/mcp_docs \
ANALYTICS_TOKEN=sandbox-smoke PATHFINDER_BASE_URL=http://localhost:3001 \
  node dist/atlas-cli.js harvest run --run-id _smoke \
  --runs-dir <sandbox>/runs --upsert \
  --checkout fixtures/atlas/checkout \
  --feature-registry fixtures/atlas/showcase/feature-registry.json
#   → atlas-harvest run [upsert] run-id=_smoke: 3 fragments → 3 candidates → 3 upserted
```

## 6. Ratification

The sandbox ratifies via the HTTP API directly (the Notion artifact/sync leg
is optional — see below). List the pending rows:

```
curl -s -H "Authorization: Bearer sandbox-smoke" "http://localhost:3001/api/atlas/candidates"
#   → {"candidates":[ ...pending rows... ]}
```

Approve one by canonical key:

```
curl -s -X POST -H "Authorization: Bearer sandbox-smoke" -H "X-Atlas-Actor: sandbox" \
  -H "Content-Type: application/json" \
  -d '{"canonicalKey":"memory:sandbox-database:sandbox-db-runs-on-5433"}' \
  "http://localhost:3001/api/atlas/candidates/approve"
#   → 200 {"candidate":{...,"status":"approved","approvedBy":"sandbox",...},"reindexQueued":true}
```

Two semantics worth knowing:

- **Approve auto-queues a reindex** for the candidate's `source_name`
  (`"reindexQueued":true` in the response). When that isn't a configured
  source — as with the `memory/...` source_names here — the server logs a
  harmless `source-reindex: source "..." not found in config` warning.
- **Re-approving the same key → 409** `atlas_candidate_not_approveable`. This
  is the idempotent no-op the README's `sync` step relies on; a 409 means the
  row is already settled, not that something broke.

## 7. Reindex

```
ANALYTICS_TOKEN=sandbox-smoke node dist/atlas-cli.js harvest reindex \
  --scope source --source atlas --url http://localhost:3001
#   → atlas-harvest reindex queued: scope=source source=atlas
```

The server log shows `Source re-index queued for atlas` followed by
`Indexing complete for atlas`. Then:

```
curl -s -H "Authorization: Bearer sandbox-smoke" "http://localhost:3001/api/search?text=pgvector+sandbox+5433"
#   → 200 {"hits":[]}
```

**Empty `hits:[]` is the green path here, by design.** `AtlasDataProvider`
indexes only approved seed rows whose `source_name` equals the atlas source's
config name (`atlas`) — see `listIndexableAtlasContent` in `src/db/atlas.ts`.
The smoke fragments carry `memory/...` source_names, so the approved row
produces 0 chunks and the reindex completes trivially. Getting real hits
requires a fragment with `source_name: atlas` AND a real embedding key, since
non-empty chunk batches go through the OpenAI provider. At that point the
sandbox stops being free — which is why this runbook stops at the empty-hits
proof.

## 8. Optional: artifact + sync

The Notion leg (README Steps 3-5) is not part of the core sandbox loop and
needs real credentials:

- `atlas harvest artifact` and `atlas harvest sync` require a real
  `NOTION_TOKEN` (a workspace + parent page to write under), plus the same
  `--checkout`/`--feature-registry` flags as `run`. `sync` additionally runs
  the English-rule LLM pass, so it needs a real `OPENAI_API_KEY` — or aimock
  via `OPENAI_BASE_URL`.
- Step 7 wire-on (the `atlas-search` tool in YAML) is pointless over an empty
  corpus; skip it.

## 9. Teardown

```
kill <server PID>
docker rm -f atlas-sandbox-db
rm -rf <sandbox>
```

## Gotchas

- **`env=env` on Popen.** The single most likely silent failure: forgetting
  to pass `env=env` to `subprocess.Popen` drops `PATHFINDER_CONFIG` and the
  server dies at boot with `No pathfinder.yaml found`.
- **Port conflicts.** 5432 is commonly held by another local postgres; the
  runbook maps the container to 5433 for that reason. Check the server port
  (3001) too before starting.
- **Localhost bearer bypass.** With `NODE_ENV` unset, `bearerTokenAuth` skips
  the token check for localhost requests, so the 401-without-bearer check
  cannot be validated. Set `NODE_ENV=production` — and remember that
  production mode makes `MCP_JWT_SECRET` mandatory (fatal at startup
  otherwise).
- **Unknown-source warning on approve.** The auto-queued reindex for a
  candidate whose `source_name` isn't in the config logs
  `source-reindex: source "..." not found in config`. Harmless; the explicit
  Step-7 reindex against the configured `atlas` source is the one that
  matters.
