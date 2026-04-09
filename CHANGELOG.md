# @copilotkit/pathfinder

## 1.6.0

### Minor Changes

- **Notion Data Provider**: Index Notion pages and database entries as searchable markdown documents. Recursive block-to-markdown conversion, database property serialization as YAML frontmatter, configurable page depth, self-throttled API client (340ms/req)
- **Deleted Page Detection**: Two-pass incremental acquire detects pages that were deleted, archived, or had integration access revoked — removes stale chunks automatically
- **License Change**: Switched from MIT to Elastic License 2.0 (ELv2) — free to use, modify, and self-host; one restriction on reselling as a hosted service

### Patch Changes

- Improve test coverage from 53% to 75% lines across the project (1044 → 1698 tests)
- Add comprehensive tests for markdown, code, and raw-text chunkers, file provider, config, validation, search/knowledge tools, webhooks, schema, url-derivation, embeddings
- Update homepage hero text and license references across all docs pages
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
- MIT License
