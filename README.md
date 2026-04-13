# pathfinder [![npm version](https://img.shields.io/npm/v/@copilotkit/pathfinder)](https://www.npmjs.com/package/@copilotkit/pathfinder)

The knowledge server for AI agents — index your docs, code, Notion pages, Slack threads, and Discord forums into searchable, agent-accessible knowledge via MCP. One config file, one command, works with any AI coding agent.

## Quick Start

```bash
npx @copilotkit/pathfinder init
npx @copilotkit/pathfinder serve
```

Or with Docker:

```bash
docker pull ghcr.io/copilotkit/pathfinder
docker run -v ./pathfinder.yaml:/app/pathfinder.yaml \
  -v ./docs:/app/docs -p 3001:3001 \
  ghcr.io/copilotkit/pathfinder
```

Then connect your AI agent:

```json
{
  "mcpServers": {
    "my-docs": { "url": "http://localhost:3001/mcp" }
  }
}
```

## Try It — Pathfinder on Its Own Docs

This documentation is indexed by a live Pathfinder instance. Connect your agent to try it:

```bash
# Claude Code
claude mcp add pathfinder-docs --transport http https://mcp.pathfinder.copilotkit.dev/mcp
```

```json
// Claude Desktop / Cursor / any MCP client
{
  "mcpServers": {
    "pathfinder-docs": {
      "url": "https://mcp.pathfinder.copilotkit.dev/mcp"
    }
  }
}
```

## What It Does

Pathfinder indexes your GitHub repos — docs (Markdown, MDX, HTML) and source code — into a PostgreSQL vector database. Supports OpenAI, Ollama, and local transformers.js embeddings — no API key required for local providers. It serves configurable search and filesystem exploration tools via [MCP](https://modelcontextprotocol.io), so AI agents can search your docs semantically and browse files with bash commands.

| Tool Type | What It Does | Example |
|-----------|-------------|---------|
| **Search** | Semantic search over indexed content | `search-docs("how to authenticate")` |
| **Bash** | Virtual filesystem with find, grep, cat, ls | `explore-docs("cat /docs/quickstart.mdx")` |
| **Collect** | Structured data collection from agents | `submit-feedback(rating: "helpful")` |
| **Knowledge** | Browse/search FAQ pairs from conversational sources | `knowledge-base("how to deploy")` |

## Features

- **[Semantic Search](https://pathfinder.copilotkit.dev/search)** — pgvector RAG with configurable chunk sizes, overlap, and score thresholds
- **[Filesystem Exploration](https://pathfinder.copilotkit.dev/search)** — QuickJS WASM sandbox with session state, `qmd` semantic grep, `related` files
- **[8 Source Types](https://pathfinder.copilotkit.dev/config)** — Markdown, code, raw-text, HTML, document (PDF/DOCX), Slack, Discord, Notion — with pluggable chunker registry
- **[Multiple Embedding Providers](https://pathfinder.copilotkit.dev/config)** — OpenAI, Ollama (local HTTP), or transformers.js (zero external deps, CPU-only)
- **[Config-Driven](https://pathfinder.copilotkit.dev/config)** — Everything in one `pathfinder.yaml`: sources, tools, embedding, indexing, webhooks
- **[Client Setup](https://pathfinder.copilotkit.dev/clients)** — Claude Desktop, Claude Code, Cursor, Codex, VS Code, any Streamable HTTP client
- **[Docker + Railway](https://pathfinder.copilotkit.dev/deploy)** — Container image, docker-compose, Railway one-click
- **[Conversational Sources](https://pathfinder.copilotkit.dev/config)** — Slack threads and Discord forums distilled into searchable Q&A pairs
- **[Auto-Generated Endpoints](https://pathfinder.copilotkit.dev/usage)** — `/llms.txt`, `/llms-full.txt`, `/faq.txt`, `/.well-known/skills/default/skill.md`
- **[Webhook Reindexing](https://pathfinder.copilotkit.dev/deploy)** — GitHub push triggers incremental reindex
- **[IP Rate Limiting](https://pathfinder.copilotkit.dev/config)** — Per-IP session caps and configurable TTL
- **[Analytics](https://pathfinder.copilotkit.dev/analytics)** — Query logging, top queries, empty results, latency metrics at `/analytics`

## CLI

```bash
# Scaffold config
npx @copilotkit/pathfinder init

# Auto-generate config from an existing docs site
npx @copilotkit/pathfinder init --from <url>

# Start server (uses PGlite if no DATABASE_URL)
npx @copilotkit/pathfinder serve

# Validate config, env vars, and source connectivity
npx @copilotkit/pathfinder validate

# Docker with Postgres
docker compose up
```

## Switching from Mintlify?

Step-by-step migration guide: **[Migrate from Mintlify](https://pathfinder.copilotkit.dev/migrate-from-mintlify)**

## Documentation

**[https://pathfinder.copilotkit.dev](https://pathfinder.copilotkit.dev)**

## License

Pathfinder is source-available under the [Elastic License 2.0 (ELv2)](LICENSE) with an **Additional Use Grant**.

**You can:** use it, modify it, self-host it, host it for your project's docs, run it for your company, contribute to it — all free.

**One restriction:** you can't sell Pathfinder as a standalone product or service. That's it.

See [LICENSING.md](LICENSING.md) for plain-English details.
