# @copilotkit/pathfinder

## 1.15.1

### Patch Changes

- **OAuth Bearer 401s emit RFC 9728 `resource_metadata` discovery hint on `WWW-Authenticate`** — wires the previously-dead `unauthorizedWithDiscovery` helper into all three `bearerMiddleware` failure paths. Discovery endpoint (`/.well-known/oauth-protected-resource`) was already live. Adds `[oauth] bearer_failure reason={empty_token|invalid_signature|expired|aud_mismatch|malformed_token} ip=<ip>` observability logs at every Bearer-401 path. Additive header change, backward compatible — spec-compliant clients ignore unknown attributes.
- **RFC 6750 §3.1 conformance**: the `WWW-Authenticate` header now retains `error="invalid_token"` alongside `resource_metadata=` and `scope="mcp"`. Per RFC 6750 §3.1 the `error=` attribute MUST be in the header when a Bearer token is presented and invalid; the helper previously dropped it (kept only in the JSON body). Strengthened `assertDiscoveryHeader` test helper now pins this invariant on all four RFC 9728 paths (empty Bearer, invalid signature, expired, aud mismatch).

## 1.15.0

### Minor Changes

- **OAuth phishing-resistance hardening**: GET `/authorize` now renders a server-rendered consent screen (HMAC-bound nonce, `CSP frame-ancestors 'none'`, `X-Frame-Options DENY`, `Referrer-Policy no-referrer`) instead of auto-approving. POST `/authorize/consent` re-validates the bound payload field-by-field and builds the final redirect URL from the nonce-bound `redirect_uri`, not the form body — the phishing-resistance invariant.
- **`redirect_uri` policy validator**: `/register` and consent re-validate every URI against a hardened policy — `https`-only except loopback (`localhost`, `127.0.0.0/8`, `[::1]`); rejects 0.0.0.0/8, RFC1918, link-local (`fe80::/10`), ULA, IPv4-mapped private; max 2048 chars per URI, max 10 URIs per client.
- **Client cap with TTL eviction**: 10,000 total / 100 per-IP cap on registered clients; lazy sweep on every register (>30d unused or >7d never-used-after-registration). `Retry-After` returned with 429 (per-IP) or 503 (total).
- **OAuth trusted-IP plumbing**: `oauthClientIp(req)` resolves the client IP via a setter-injection seam wired at server bootstrap, gating `X-Forwarded-For` and `X-Forwarded-Proto` on the same trust-proxy boundary as the rest of the server. `originOf()` no longer accepts attacker-controlled `X-Forwarded-Proto` when the proxy isn't trusted.
- **`PATHFINDER_CONSENT_HMAC_KEY` config**: New env var carrying the HMAC key for consent-nonce signing. Comma-separated for rotation (first key signs, all keys verify). ≥32 hex chars per entry. Fail-loud in production when unset; dev fallback generates an ephemeral key per process and warns.

## 1.14.0

### Minor Changes

- **`atlas` CLI**: New first-party command-line client shipped as `bin.atlas`. `atlas search` queries a Pathfinder knowledge server and `atlas feedback` submits feedback on results, with hardened `tools/call` response handling.
- **`prepublishOnly` Build Guard**: Added a `prepublishOnly` script so the published tarball always ships a fresh `dist/` (including `dist/atlas-cli.js`), preventing stale or missing build output from being released.
- **Atlas Foundation**: Off-by-default codebase-knowledge layer — additive schema, ratification endpoints, gardener, and webhook PR ingestion. Disabled unless explicitly enabled, so existing deployments are unaffected.

## 1.13.3

### Patch Changes

- **Webhook Delivery Tracking**: `webhook_deliveries` DB table logs every GitHub push webhook receipt with payload size, source, and processing outcome. 30-day retention cleanup in nightly cycle.
- **Queue Dedup & Concurrent Drain**: Reindex queue deduplicates redundant jobs for the same source. Concurrent drain allows parallel reindex of independent repos (max 3).
- **Webhook Body Size Fix**: `express.raw()` limit raised from default 100KB to 25MB — large GitHub push payloads (monorepos with many commits) were silently rejected with 413.
- **Audit Alert Dedup**: Reindex audit Slack alerts only fire on new or changed findings, preventing repeated alerts for the same stale data on every reindex cycle.

## 1.13.2

### Patch Changes

- **Post-Reindex Health Audit**: Automated integrity checks run after each reindex cycle — detects stale files in the index, scope leaks (files outside `config.path`), and chunk count divergence between DB and disk. Alerts via Slack webhook (`SLACK_WEBHOOK_URL` env var) when issues are found. Read-only — no automatic deletions.
- **Response Compression**: Added gzip/deflate/brotli compression via `compression` middleware for all HTTP responses. Text typically compresses 70-85%, especially beneficial for `/llms-full.txt`.
- **Stale Chunk Cleanup**: `fullAcquire` now detects and removes orphaned chunks from deleted files. Handles walkRoot-missing and git-rename cases. `incrementalAcquire` hardened with `config.path` scoping, `skipDirs` enforcement, and error handling on `--name-status` diff.

## 1.13.1

### Patch Changes

- **Streamable HTTP JSON Response**: Enabled `enableJsonResponse` on the Streamable HTTP MCP transport for compatibility with clients that cannot parse SSE-formatted responses (notably OpenAI Codex CLI). Fully MCP spec-compliant — the spec allows servers to return either `application/json` or `text/event-stream` for single-message responses

## 1.13.0

### Minor Changes

- **Global Session Cap**: New `server.max_sessions` config (default: 1000). Returns HTTP 503 with `CapacityPayload` when the total concurrent session count across all IPs exceeds the cap. Logs a warning at 80% utilization.
- **Two-Tier TTL**: New `server.session_unused_ttl_minutes` config (default: 15). Sessions that never invoke a tool are reaped at the shorter TTL; sessions that have invoked a tool use the existing `session_ttl_minutes` (default: 30). "Used" is tracked at the tool-invocation level, not the protocol-message level.
- **Lazy Workspace Allocation**: Workspace directories are no longer created eagerly at session init. Bash tools already create them lazily per-operation, so sessions that never invoke bash tools incur zero filesystem I/O.
- **Observability**: Session close logs show count as percentage of cap. Reaper tick logs show used/unused breakdown.

## 1.12.0

### Minor Changes

- **MCP OAuth 2.1**: Full OAuth ceremonial flow so claude.ai (and other MCP clients) can authenticate against the public Pathfinder server. Anonymous OAuth — RFC-compliant endpoints (`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/register`, `/authorize`, `/token`) with auto-approve and JWT issuance. PKCE S256 required.
- **Dynamic Client Registration** (RFC 7591): claude.ai and other MCP clients auto-register; no manual client provisioning
- **HS256 JWT**: Hand-rolled with `node:crypto` — no new dependencies
- **Opportunistic bearer auth on `/mcp`**: Valid JWT accepted, invalid rejected, missing allowed (backward compatible)
- **Per-endpoint rate limiting**: 10/min `/register`, 30/min `/authorize` and `/token` per IP
- **Required env var**: `MCP_JWT_SECRET` (32+ bytes) — production throws on startup if missing

## 1.11.1

### Patch Changes

- **Analytics Filter UX**: Tool type pills (All / Search / Explore) and source sub-filters for drilling into query data without losing the big picture
- **Tool Counts Endpoint**: New `/api/analytics/tool-counts` for query volume by tool type
- **Filterable API**: All analytics endpoints accept `tool_type` and `source` query params
- **Dev Mode Auth Bypass**: Analytics dashboard and API skip token auth when `NODE_ENV=development`
- **Backfill-Safe Stats**: Avg result count and latency stats exclude reconstructed log data (`result_count=-1`)
- **Always-On Logging**: Query logging fires unconditionally — `analytics.enabled` only gates dashboard access
- **CI Fix**: Slack webhook curl in all workflows wrapped in if-guards to prevent failures when `SLACK_WEBHOOK` is unset

## 1.11.0

### Minor Changes

- **Analytics Dashboard**: Built-in query analytics with embedded Chart.js dashboard at `/analytics`. Track query volume, latency (avg + p95), empty result rates, top queries, and queries by source
- **Query Logging**: Fire-and-forget instrumentation in search and knowledge tool handlers. Logs query text, result count, top similarity score, latency, source, and session ID
- **Analytics REST API**: Three endpoints (`/api/analytics/summary`, `/queries`, `/empty-queries`) with Bearer token authentication via config or `ANALYTICS_TOKEN` env var
- **Analytics Config**: New `analytics` section in pathfinder.yaml with `enabled`, `log_queries`, `token`, and `retention_days` fields. Fully optional and backwards compatible
- **Auto-Cleanup**: Old query_log rows automatically pruned during nightly reindex cycle based on `retention_days` (default 90)
- **PGlite Compatible**: p95 latency computed in application code (not SQL `percentile_cont`) for PGlite compatibility

## 1.10.0

### Minor Changes

- **Auto-Generate from URL**: `pathfinder init --from <url>` crawls a docs site and generates a working pathfinder.yaml
- **Site Crawler**: Sitemap-first discovery with robots.txt and recursive link following fallbacks, rate limiting, SPA detection
- **Config Generator**: Auto-detects source type, derives base URL, generates complete YAML config

## 1.9.0

### Minor Changes

- **PDF/DOCX Ingestion**: New `document` source type for indexing PDF and DOCX files with page-break and section-aware chunking
- **Content Extractors**: Optional peer dependencies `pdf-parse` (PDF) and `mammoth` (DOCX), dynamically imported only when configured
- **Scanned PDF Detection**: Warns when a PDF produces very little text, indicating a scanned document

## 1.8.0

### Minor Changes

- **Hybrid Search**: Combine vector similarity and full-text keyword search using Reciprocal Rank Fusion (RRF). Three search modes: `vector` (default, unchanged), `keyword` (tsvector-based full-text), `hybrid` (both + RRF merge)
- **Keyword Search Upgrade**: Replaced ILIKE with PostgreSQL tsvector/tsquery for proper full-text search with ranking via ts_rank
- **search_mode Config**: New `search_mode` field on search tools — set to `'vector'`, `'keyword'`, or `'hybrid'` (defaults to `'vector'` for backwards compatibility)
- **tsvector Schema Migration**: Adds `tsv` tsvector column with GIN index for fast full-text search, with PGlite-safe trigger fallback

## 1.7.0

### Minor Changes

- **Local Embedding Support**: Drop the OpenAI dependency — use Ollama or local transformers.js for embeddings. Three providers: openai (existing), ollama (HTTP API), local (@xenova/transformers, zero external deps)
- **EmbeddingProvider Interface**: Abstracted embedding generation behind a provider interface with factory. Pluggable architecture for future providers
- **Conditional API Keys**: OPENAI_API_KEY only required when embedding.provider is "openai" — Ollama and local providers need no API keys
- **Dimension Mismatch Detection**: Startup check warns when configured dimensions don't match existing vector index

### Patch Changes

- Format all source files with prettier
- Make Slack webhook notifications non-fatal in CI

## 1.6.2

### Patch Changes

- Move CopilotKit deployment configs to deploy/ directory
- Rename fixture configs from mcp-docs to pathfinder
- Remove internal operations runbook from repo
- Clean up stale mcp-docs references in comments and scripts

## 1.6.1

### Patch Changes

- Add Additional Use Grant — explicitly permits hosting Pathfinder for your own or your organization's documentation
- Add LICENSING.md with plain-English license summary

## 1.6.0

### Minor Changes

- **Notion Data Provider**: Index Notion pages and database entries as searchable markdown documents. Recursive block-to-markdown conversion, database property serialization as YAML frontmatter, configurable page depth, self-throttled API client (340ms/req)
- **Deleted Page Detection**: Two-pass incremental acquire detects pages that were deleted, archived, or had integration access revoked — removes stale chunks automatically

### Patch Changes

- Improve test coverage from 53% to 75% lines across the project (1044 → 1698 tests)
- Add comprehensive tests for markdown, code, and raw-text chunkers, file provider, config, validation, search/knowledge tools, webhooks, schema, url-derivation, embeddings
- Update homepage hero text and docs site styling
- Add `getIndexedItemIds` query for provider-level deletion detection

## 1.5.0

### Minor Changes

- **Data Provider Abstraction**: Refactored SourceIndexer into DataProvider interface + IndexingPipeline, enabling API-based sources alongside file-based sources
- **Slack Data Provider**: Index Slack threads as searchable Q&A knowledge via LLM distillation (gpt-4o-mini). Configurable channels, confidence threshold, emoji-triggered reindexing
- **Discord Data Provider**: Index Discord text channels (LLM distillation) and forum channels (direct Q&A extraction at confidence 1.0). Forum posts are inherently Q&A-shaped — no LLM needed
- **FAQ Endpoint** (`/faq.txt`): Serves Q&A pairs from all FAQ-category sources, filtered by confidence at query time. Advertised via Link header
- **Knowledge MCP Tool**: New `knowledge` tool type with browse mode (full FAQ listing) and search mode (vector search scoped to FAQ sources)
- **`pathfinder validate` CLI Command**: Validates YAML config, checks env vars, probes source connectivity. Exit code 1 on errors
- **Q&A Chunker**: Renamed from slack-specific to source-agnostic, registered for both slack and discord source types

### Patch Changes

- Fix bash filesystem empty after fresh deploy when DB already has current index state
- Fix pathfinder-docs Railway service missing deployment trigger
- Always refresh bash instances after startup index check completes
- Rename "Migrate" to "Switch" in docs nav (matches aimock)
- Update docs: config reference (Slack, Discord, Knowledge tool, jump links), usage (FAQ endpoint, validate command), deploy (new env vars), README

## 1.4.0

### Minor Changes

- Add HTML source type for indexing static HTML documentation sites (cheerio-based parser)
- Content container auto-detection (main, article, [role="main"], .content, #content)
- Heading-boundary chunking with headingPath tracking (h1-h3)
- Code block preservation, list formatting, table formatting in HTML extraction
- Add pathfinder-docs.yaml for dogfooding Pathfinder on its own documentation

### Patch Changes

- Generalize smoke test script for any Pathfinder instance
- Add mobile hamburger nav menu to all docs pages
- Simplify README to match aimock style, add npm metadata (repository, homepage, keywords)
- Fix Dockerfile to copy pathfinder.yaml for production deploy
- Fix schema migration: remove version index from generateSchema (was failing on existing databases)

## 1.1.0

### Minor Changes

- Rename project from mcp-docs to Pathfinder
- Add agentic retrieval: session state, vector grep, virtual files, related command, telemetry
- Add configurable bash tool options (grep_strategy, workspace, virtual_files)
- Add Pathfinder landing page and documentation site
- Add Mintlify migration tutorial
- Add GitHub Actions for Pages deployment, releases, and Docker publishing
- Add versioning infrastructure with CHANGELOG

## 1.0.0

### Initial Release

- Semantic search over documentation and code via pgvector + OpenAI embeddings
- Bash tool filesystem exploration via just-bash virtual filesystem
- Feedback collection tools with YAML-defined schemas
- Config-driven via pathfinder.yaml
- Webhook-triggered reindexing from GitHub push events
- Nightly auto-reindex on configurable schedule
- Docker deployment support
- Elastic License 2.0
