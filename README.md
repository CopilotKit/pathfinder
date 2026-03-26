# CopilotKit MCP Docs Server

Self-hosted MCP server for semantic search over CopilotKit documentation and code.

## Quick Start

```bash
# 1. Start services
docker compose up -d

# 2. Seed the index
npm run seed-index

# 3. Test search
npm run test-search
```

## Architecture

```
                   MCP Clients (Claude, IDEs)
                          |
                     MCP Protocol
                          |
               +----------+----------+
               |   Express Server    |
               |   (port 3001)       |
               +----+------+--------+
                    |      |
          +---------+      +----------+
          |                           |
   +------+------+          +--------+--------+
   | MCP Tools   |          | Webhooks        |
   | search-docs |          | GitHub push     |
   | search-code |          | (re-index)      |
   +------+------+          +--------+--------+
          |                           |
          +----------+  +-------------+
                     |  |
              +------+--+------+
              | pgvector (pg16)|
              | embeddings     |
              +---------+------+
                        |
              +---------+------+
              | OpenAI API     |
              | (embeddings)   |
              +----------------+
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `search-docs` | Semantic search over CopilotKit documentation (guides, API references, tutorials) |
| `search-code` | Semantic search over CopilotKit source code (implementations, types, patterns) |

## Development

```bash
# Prerequisites: Docker, Node.js 20+, OpenAI API key

# Start Postgres + app in dev mode (hot reload)
docker compose up

# Run integration tests
npm run integration-test
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key for embeddings |
| `DATABASE_URL` | Yes | Postgres connection string |
| `GITHUB_TOKEN` | No | GitHub token for repo access |
| `GITHUB_WEBHOOK_SECRET` | No | Secret for webhook verification |

## Deployment

Deployed on [Railway](https://railway.app). See `railway.toml` for config.

## Setup Instructions

See [Setup Instructions](https://www.notion.so/32f3aa3818528140a9dec22e2043cff5) for a detailed guide.
