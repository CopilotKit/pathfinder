# Pathfinder v1.2 — CLI, Docker, Docs, Telemetry

## Overview

Pathfinder v1.1.0 shipped with agentic retrieval features, a website, and npm/Docker publishing infrastructure. But the install experience is broken: `npm install` doesn't set up a server, the migration page says `git clone`, and there's no CLI. This spec covers making Pathfinder actually installable and usable through proper CLI and Docker paths, updating all documentation, wiring up telemetry, and planning Mintlify gap closure.

## 1. CLI (`src/cli.ts`)

**Two commands:**

### `pathfinder init`

- Creates `pathfinder.yaml` from the bundled example template
- Creates `.env` from `.env.example`
- Prompts: "Where are your docs?" → fills in `sources[0].path`
- Output: "Run `pathfinder serve` to start"

### `pathfinder serve`

- Loads config, starts the Express server (refactors existing `src/index.ts` startup logic into importable function)
- Bash-only by default — if no `DATABASE_URL` in env, skip search tools and indexing entirely. Filesystem exploration works with zero external deps.
- When Postgres is configured via DATABASE_URL + embedding config in yaml, full semantic search + indexing kicks in
- Flags: `--port` (override config), `--config` (path to yaml, default: `./pathfinder.yaml`)

### package.json changes

- Add `"bin": { "pathfinder": "dist/cli.js" }`
- Add `commander` dependency for argument parsing
- Ensure `.npmignore` includes the CLI entry point in published package

### Refactoring

- Extract server startup from `src/index.ts` into `src/server.ts` (or similar) so both `cli.ts serve` and the existing `index.ts` can call it
- `src/index.ts` becomes a thin wrapper that calls the server startup (backwards compatible)
- `src/cli.ts` parses args and calls the same startup function

## 2. Docker

### Dockerfile update

- Change prod entrypoint from `CMD ["node", "dist/index.js"]` to `CMD ["node", "dist/cli.js", "serve"]`
- Docker internally uses the CLI, same code path

### Published image (`ghcr.io/copilotkit/pathfinder`)

- `publish-docker.yml` workflow already exists targeting this registry
- First build triggered by pushing a `v1.2.0` tag
- Multi-arch: linux/amd64 + linux/arm64

### Production docker-compose

- New `docker-compose.yml` (rename current to `docker-compose.dev.yml`) that uses the published image:

```yaml
services:
  db:
    image: pgvector/pgvector:pg16
    ...
  app:
    image: ghcr.io/copilotkit/pathfinder:latest
    ports: ["3001:3001"]
    volumes:
      - ./pathfinder.yaml:/app/pathfinder.yaml
    env_file: .env
    depends_on: [db]
```

### Zero-dep quick start (bash-only, no Postgres)

```
docker run -v ./pathfinder.yaml:/app/pathfinder.yaml -p 3001:3001 ghcr.io/copilotkit/pathfinder
```

## 3. Documentation Update

Three pages, all sharing the same dark theme (#0a0a0f bg, #00ccff accent), nav, and footer.

### Homepage (`docs/index.html`)

- Hero install box changes to show two paths (tabbed or side-by-side):
  - CLI: `$ npx @copilotkit/pathfinder init`
  - Docker: `$ docker pull ghcr.io/copilotkit/pathfinder`
- Link to new docs page for full setup instructions
- Terminal animation already updated to show qmd

### New install/setup page (`docs/docs.html`)

- Modeled after aimock's docs page structure
- Two "Quick Start" paths side by side in cards:
  - **CLI path**: `npx @copilotkit/pathfinder init` → edit pathfinder.yaml → `npx @copilotkit/pathfinder serve`
  - **Docker path**: `docker pull ghcr.io/copilotkit/pathfinder` → create pathfinder.yaml → docker run (or docker-compose for full stack with Postgres)
- Deeper sections:
  - Configuration: pathfinder.yaml walkthrough (sources, tools, embedding)
  - Adding Semantic Search: how to add Postgres + OpenAI key to unlock vector search and qmd
  - MCP Client Setup: how to connect from Claude Desktop, Cursor, etc.
  - Environment Variables: DATABASE_URL, OPENAI_API_KEY, GITHUB_TOKEN, etc.
  - qmd: the semantic search command and how it works

### Migration page (`docs/migrate-from-mintlify.html`)

- Step 1 changes from `git clone` to CLI/Docker quick start paths
- Update grep references for qmd where applicable
- Keep concept mapping table and "What's Different" section
- Fix any stale references

## 4. Telemetry Wiring

### BashTelemetry class

Already exists at `src/mcp/tools/bash-telemetry.ts` — fully implemented with buffer management, overflow protection, and retry-safe flush. Just not instantiated.

### Wiring points in `registerBashTool()` (`src/mcp/tools/bash.ts`)

- After `bash.exec(command)` → `telemetry.recordCommand(command)` for all commands
- On grep returning exitCode 1 (no matches) → `telemetry.recordGrepMiss(pattern, command)`
- On cat/head/tail file reads → `telemetry.recordFileAccess(filePath, command)`

### Instantiation in `src/index.ts` (or `src/server.ts` after refactor)

- Create `BashTelemetry` instance with insert function writing to `collected_data` table
- Pass to `registerBashTool()` via `BashToolOptions.telemetry`
- Set up periodic flush interval (every 60 seconds)
- Flush on graceful shutdown (SIGTERM/SIGINT handler)

### Interface change

Add `telemetry?: BashTelemetry` to `BashToolOptions` interface.

## 5. Mintlify Gap Closure (Plan Only)

Not implemented in this round. Deliverable is a Notion proposal analyzing:

- What ChromaFS offers that Pathfinder doesn't
- Which gaps are worth closing vs. which are out of scope (hosted docs, UI dashboard)
- Priority-ordered list of features to build
- Estimated effort for each

## Implementation Order

1. CLI (src/cli.ts, refactor src/index.ts → src/server.ts)
2. Docker (update Dockerfile entrypoint, new production docker-compose)
3. Docs (new docs.html page, update index.html hero, update migration page)
4. Telemetry (wire BashTelemetry into registerBashTool)
5. Mintlify gap analysis (Notion proposal only)

## Testing

- **CLI**: unit tests for `init` (scaffolding) and `serve` (server startup in bash-only mode)
- **Docker**: build the image locally, verify `docker run` works in bash-only mode
- **Telemetry**: existing tests cover BashTelemetry class; add integration test for wiring
- **Docs**: visual inspection via local server
