# Pathfinder

A self-hosted MCP server that provides semantic search over your documentation and code. Configure it with a YAML file, deploy with Docker, and give your AI coding agents instant access to your project's knowledge.

## How It Works

Pathfinder indexes your GitHub repositories — documentation (Markdown/MDX) and source code — into a PostgreSQL vector database using OpenAI embeddings. It exposes configurable search tools via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io), so AI agents like Claude Code can search your docs and code semantically.

## Quick Start

1. **Clone and configure:**
   ```bash
   git clone https://github.com/CopilotKit/pathfinder.git
   cd pathfinder
   cp pathfinder.example.yaml pathfinder.yaml  # edit for your project
   cp .env.example .env                        # add your OPENAI_API_KEY
   ```

2. **Start the server:**
   ```bash
   docker compose up
   ```

3. **Seed the index:**
   ```bash
   docker compose exec app npx tsx scripts/seed-index.ts
   ```

4. **Connect your AI agent:**
   ```json
   {
     "mcpServers": {
       "my-docs": { "url": "http://localhost:3001/mcp" }
     }
   }
   ```

## Configuration

All configuration lives in `pathfinder.yaml`. See [pathfinder.example.yaml](pathfinder.example.yaml) for a minimal starting point.

### Sources

Each source defines what to index:

```yaml
sources:
  - name: docs
    type: markdown        # Built-in: markdown, code, raw-text
    repo: https://github.com/your-org/your-repo.git
    path: docs/
    base_url: https://docs.your-project.com/
    url_derivation:
      strip_prefix: "docs/"
      strip_suffix: ".md"
    file_patterns: ["**/*.md"]
    chunk:
      target_tokens: 600
      overlap_tokens: 50

  - name: code
    type: code
    repo: https://github.com/your-org/your-repo.git
    path: "."
    file_patterns: ["**/*.ts", "**/*.py"]
    exclude_patterns: ["**/test/**", "**/*.test.*"]
    chunk:
      target_lines: 80
      overlap_lines: 10
```

### Tools

Each tool maps to a source and defines the MCP tool interface:

```yaml
tools:
  - name: search-docs
    description: "Search documentation for relevant information."
    source: docs
    default_limit: 5
    max_limit: 20
    result_format: docs
```

### Collect Tools

Collect tools let agents write structured data back to the server. Unlike search tools, they don't query anything — they validate the agent's input against a YAML-defined schema and store it as JSON in the database. Use them to gather signal from agents without writing any code.

The first built-in use case is search feedback: agents report whether search results were helpful, what they tried, and what went wrong. This surfaces broken or misleading documentation quickly. But collect tools are generic — you can define any schema for any use case (e.g., broken link reporting, feature requests, error logging).

```yaml
tools:
  - name: submit-feedback
    type: collect
    description: "Submit feedback on whether search results were helpful."
    response: "Feedback recorded. Thank you."
    schema:
      tool_name:
        type: string
        description: "Which search tool was used"
        required: true
      rating:
        type: enum
        values: ["helpful", "not_helpful"]
        description: "Whether the results were helpful"
        required: true
      comment:
        type: string
        description: "What worked or didn't work"
        required: true
```

Each field in `schema` supports `type` (`string`, `number`, or `enum`), an optional `description` (shown to the agent), `required` (defaults to false), and `values` (required for `enum` fields). The validated input is written as JSONB to the `collected_data` table along with the tool name and a timestamp.

### Bash Tool Options

Bash tools expose source files as a read-only virtual filesystem that agents can explore with standard commands (`find`, `grep`, `cat`, `ls`, `head`). Several options control behavior:

```yaml
tools:
  - name: explore-docs
    type: bash
    description: "Explore documentation files"
    sources: [docs]
    bash:
      session_state: true       # Persistent CWD across commands (default: false)
      grep_strategy: hybrid     # memory | vector | hybrid — enables qmd semantic search (default: memory, no qmd)
      virtual_files: true       # Auto-generate INDEX.md, SEARCH_TIPS.md (default: false)
```

- **session_state**: When enabled, `cd` persists across commands within a session. Agents can run `cd /docs` in one tool call and then `ls` or `cat file.md` in the next without repeating the path.
- **grep_strategy**: Controls whether the `qmd` semantic search command is available. `memory` uses pure in-memory regex only (no `qmd`). `vector` or `hybrid` enable the `qmd` command, which performs semantic search via embeddings plus text `ILIKE`. The `vector` and `hybrid` modes require an `embedding` config block.
- **virtual_files**: Auto-generates `/INDEX.md` (file listing with descriptions) and `/SEARCH_TIPS.md` (usage guidance) at the root of the virtual filesystem.

Agents can also run the `related` command inside bash tools to find semantically similar files across all mounted sources:

```bash
related /docs/concepts/coagents.mdx
```

This returns a ranked list of files from any source that are semantically related to the given file, useful for discovering cross-references between documentation and code.

When `grep_strategy` is set to `vector` or `hybrid`, agents can use the `qmd` command for semantic search:

```bash
qmd "how do I configure authentication"
```

This performs a 2-pass search (semantic embeddings + text ILIKE) with dedup and filtering, and returns file:line:content results. Standard `grep` is never intercepted — it always works with standard flags as agents expect.

**Note:** The virtual filesystem is read-only and shared across all MCP sessions for a given tool. Content refreshes on webhook or server restart.

### Built-in Chunker Types

| Type | Best For | Splits On |
|------|----------|-----------|
| `markdown` | .md, .mdx files | Headings (h2->h3->paragraph->line), preserves code blocks |
| `code` | Source code files | Blank line boundaries, respects block comments/strings |
| `raw-text` | Plain text, logs | Paragraph boundaries (double newline) |

### Embedding

```yaml
embedding:
  provider: openai
  model: text-embedding-3-small
  dimensions: 1536
```

### Indexing

```yaml
indexing:
  auto_reindex: true         # Nightly full reindex
  reindex_hour_utc: 3        # 3 AM UTC
  stale_threshold_hours: 24
```

## Deploying to Production with Docker

The simplest way to run in production:

1. **Configure:**
   ```bash
   cp pathfinder.example.yaml pathfinder.yaml  # edit for your project
   ```

2. **Set environment variables** in `.env`:
   ```
   OPENAI_API_KEY=sk-...
   POSTGRES_PASSWORD=your-secure-password
   GITHUB_WEBHOOK_SECRET=your-webhook-secret
   ```

3. **Deploy:**
   ```bash
   docker compose -f docker-compose.prod.yaml up -d
   ```

4. **Verify:**
   ```bash
   curl http://localhost:3001/health | python3 -m json.tool
   ```

The health endpoint shows index status, chunk counts, and source states.

The server automatically indexes on first boot and runs a nightly reindex at the configured hour.

### GitHub Webhooks (optional)

For real-time re-indexing on push:

1. Add webhook config to `pathfinder.yaml`:
   ```yaml
   webhook:
     repo_sources:
       "your-org/your-repo": [docs, code]
     path_triggers:
       docs: ["docs/"]
       code: []
   ```

2. Configure the webhook on GitHub:
   - URL: `https://your-server/webhooks/github`
   - Secret: same as `GITHUB_WEBHOOK_SECRET`
   - Events: Just `push`

## Deploying to Railway

1. **Run setup:**
   ```bash
   ./scripts/setup.sh       # install deps, build Docker images
   ./scripts/deploy.sh      # create Railway project, set vars, deploy
   ```

2. **Set custom domain** in Railway dashboard

3. **Configure webhooks:**
   ```bash
   ./scripts/setup-webhooks.sh
   ```

See [OPERATIONS.md](OPERATIONS.md) for the full operations runbook.

## Development

```bash
# Local setup
./scripts/setup.sh

# Start dev server (hot reload)
docker compose up

# Seed index
docker compose exec app npx tsx scripts/seed-index.ts

# Run unit tests
npm test

# Test search
docker compose exec app npx tsx scripts/test-search.ts "your query"

# Run integration tests
npx tsx scripts/integration-test.ts

# Run path filter tests
npx tsx scripts/test-path-filter.ts
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key for embeddings |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `GITHUB_WEBHOOK_SECRET` | No | HMAC secret for webhook verification |
| `GITHUB_TOKEN` | No | GitHub token for private repos |
| `PATHFINDER_CONFIG` | No | Path to config file (default: `./pathfinder.yaml`) |
| `PORT` | No | Server port (default: `3001`) |

## License

MIT — see [LICENSE](LICENSE)
