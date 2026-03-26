# MCP Docs Server — Operations Runbook

## Service URLs
- Production: https://mcp-docs.up.railway.app
- Health: https://mcp-docs.up.railway.app/health
- MCP endpoint: https://mcp-docs.up.railway.app/mcp
- Railway dashboard: https://railway.com/project/4cce72cc-cf76-42e1-a597-c04c851b39cf

## Quick Checks

### Health & Index Status
```bash
curl -s https://mcp-docs.up.railway.app/health | python3 -m json.tool
```

Response includes: uptime, indexing status, doc/code chunk counts, per-source index state with last indexed time, commit SHA, and errors.

### Is indexing running?
Check the `indexing` field in the health response. If true, a full or incremental reindex is in progress.

### View logs
```bash
railway logs --service mcp-server --lines 200
```

### Check deployment status
```bash
railway service status --all --json
```

## Common Operations

### Force a full reindex
```bash
railway run npx tsx scripts/seed-index.ts
```
Or docs-only / code-only:
```bash
railway run npx tsx scripts/seed-index.ts --docs-only
railway run npx tsx scripts/seed-index.ts --code-only
```

### Test search quality (against production)
```bash
npx tsx scripts/test-search.ts --url https://mcp-docs.up.railway.app/mcp "how to use useCopilotAction"
npx tsx scripts/test-search.ts --url https://mcp-docs.up.railway.app/mcp --type code "CopilotRuntime"
```

### Restart the service
```bash
railway service restart --service mcp-server
```

### Redeploy from latest commit
```bash
railway service redeploy --service mcp-server
```

### View/set environment variables
```bash
railway variable list --service mcp-server
railway variable set KEY=value --service mcp-server
```

### Connect to production database
```bash
export PATH="/opt/homebrew/opt/libpq/bin:$PATH"  # if psql not in PATH
railway connect Postgres
```

### Check vector index health
```sql
-- In psql via railway connect:
SELECT count(*) FROM doc_chunks;
SELECT count(*) FROM code_chunks;
SELECT count(DISTINCT repo_url) FROM code_chunks;
SELECT * FROM index_state;
```

## Nightly Reindex
- Enabled by default (AUTO_REINDEX_ENABLED=true)
- Runs at 3:00 UTC (configurable via AUTO_REINDEX_CRON_HOUR)
- Skips if indexing is already in progress
- Logs: `[orchestrator] Starting nightly reindex`

## Custom Domain Setup
1. Railway dashboard -> mcp-server -> Settings -> Custom Domain
2. Add: mcp.copilotkit.ai
3. Railway provides a CNAME target
4. Update DNS: CNAME mcp.copilotkit.ai -> Railway target
5. Wait for SSL provisioning
6. Verify: `curl -v https://mcp.copilotkit.ai/health`

## Webhook Setup
```bash
./scripts/setup-webhooks.sh
```
Only CopilotKit/CopilotKit needs a webhook (all demo repos consolidated there).

## Troubleshooting

### "Missing required environment variables" on startup
Check Railway variables: `railway variable list --service mcp-server`

### Search returns empty results
Index may not be seeded. Check health endpoint for chunk counts. If zero, run seed-index.

### Embedding API errors during indexing
Check OPENAI_API_KEY is valid. The client retries rate limit errors automatically (3 retries with exponential backoff). Check logs for `[embeddings]` messages.

### pgvector extension missing
Connect to Postgres and run: `CREATE EXTENSION IF NOT EXISTS vector;`

### Disk space issues during indexing
The server clones repos to /tmp. Railway containers have ephemeral storage. Shallow clones (--depth=1) keep this under 1GB.
