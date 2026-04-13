# Pathfinder

Pathfinder is an agentic knowledge server. It provides semantic search over documentation and code, plus a sandboxed filesystem for browsing indexed content. Use it to find relevant docs, explore codebases, and save intermediate results.

## Available Tools

Pathfinder exposes four tool types via MCP. The exact tool names depend on the server's configuration, but they follow these patterns:

### search (semantic search)

Finds content by meaning, not just keywords. Use this when you need to understand a concept, find related documentation, or locate code that implements a particular behavior.

**Parameters:**
- `query` (string, required) — Natural-language search query
- `limit` (number, optional) — Maximum number of results

**Example queries:**
- "How do I configure authentication?"
- "Error handling middleware"
- "Database migration workflow"

> **Note:** Some search tools may be configured for hybrid mode (combining vector and keyword search) or keyword-only mode. The tool handles this internally — always provide a natural language query regardless of mode.

### explore (bash/filesystem)

A sandboxed bash shell for browsing the indexed filesystem. Files are read-only (except `/workspace/`). Use this for precise lookups, structural exploration, and when you need exact file contents.

**Parameters:**
- `command` (string, required) — Bash command to execute

**Supported commands:**
| Command | Use for |
|---------|---------|
| `find / -name "*.ts"` | Discover files by pattern |
| `grep -r "pattern" /` | Search file contents for exact matches |
| `cat /path/to/file` | Read a specific file |
| `head -n 50 /path/to/file` | Read first N lines |
| `tail -n 20 /path/to/file` | Read last N lines |
| `ls /path/` | List directory contents |
| `cd /path/` | Change working directory (persists across calls) |

**Special commands:**

- **`qmd <query>`** — Semantic search from within the bash tool. Like `grep` but matches by meaning instead of exact text. Use when grep returns no results or when searching for concepts rather than literal strings.

- **`related <path>`** — Given a file path, finds other files with similar content using vector similarity. Useful for discovering related modules, tests, or documentation.

**Virtual files:**
- `INDEX.md` — Full listing of all files in the virtual filesystem
- `SEARCH_TIPS.md` — Usage hints and available search tools

### collect (feedback)

Submits structured feedback or data back to the server. The exact schema depends on configuration. Use this when you want to report issues, rate content quality, or provide other structured feedback.

### knowledge (FAQ / Q&A)

Browse and search Q&A knowledge extracted from conversational sources (Slack threads, Discord forums, Notion databases with `category: faq`). Use this for questions that are likely answered in community discussions rather than formal documentation.

**Parameters:**
- `query` (string, optional) — Search query. If empty, returns a browsable list of all Q&A pairs.
- `limit` (number, optional) — Maximum number of results
- `min_confidence` (number, optional) — Minimum confidence threshold (0-1)

**Example queries:**
- "How do I handle rate limiting?"
- "What's the recommended way to deploy?"
- "" (empty = browse all FAQ entries)

## When to Use Search vs Explore

| Situation | Tool | Why |
|-----------|------|-----|
| "How does X work?" | **search** | Conceptual query — semantic search excels |
| "Find all files importing module Y" | **explore** (`grep`) | Exact pattern match |
| "What's in the config file?" | **explore** (`cat`) | Need exact file contents |
| "Find docs about authentication" | **search** | Broad topic discovery |
| "What files are related to auth.ts?" | **explore** (`related`) | Vector-similarity file discovery |
| "List all TypeScript files" | **explore** (`find`) | Structural filesystem query |
| grep returned nothing useful | **explore** (`qmd`) or **search** | Fall back to semantic matching |
| "What have people asked about X?" | **knowledge** | Q&A from community conversations |
| Need to save notes for later | **explore** (write to `/workspace/`) | Workspace supports writes |

## Workspace

The `/workspace/` directory is writable. Use it to save intermediate results, notes, or assembled content during a session. Everything else in the filesystem is read-only.

```bash
# Save search results for later reference
echo "# Authentication Notes" > /workspace/auth-notes.md
cat /docs/auth/setup.md >> /workspace/auth-notes.md

# List workspace contents
ls /workspace/
```

Workspace contents are scoped to your session and are cleaned up after the session expires.

## Limitations

- **Read-only filesystem** — All indexed content is read-only. Only `/workspace/` accepts writes.
- **Indexed content, not real-time** — Search results come from the last indexing run, not live file reads. The bash filesystem reflects the same indexed snapshot.
- **Limited pipe support** — Simple pipes work (`grep pattern file | head`), but complex shell constructs (subshells, process substitution, backgrounding) may not.
- **No network access** — The bash sandbox cannot make outbound network requests.
- **Session-scoped state** — Working directory (`cd`) and workspace files persist within a session but not across sessions.
