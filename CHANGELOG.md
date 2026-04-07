# @copilotkit/pathfinder

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
