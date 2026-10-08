import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Bash } from "just-bash";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import fs from "fs";
import os from "os";
import path from "path";
import {
  formatBytes,
  generateSkillMd,
  onlyFor,
  toolList,
} from "../skill-md.js";
import {
  registerBashTool,
  MODERN_WORKSPACE_REFUSAL,
} from "../mcp/tools/bash.js";
import { BashSessionState } from "../mcp/tools/bash-session.js";
import {
  WorkspaceManager,
  WORKSPACE_MAX_BYTES_PER_SESSION,
} from "../workspace.js";
import type { BashToolConfig, ChunkResult, ServerConfig } from "../types.js";

// qmd and related query the chunk index. One chunk stands in for it, so the
// real bash tool can run them without a database.
const { CHUNK } = vi.hoisted(() => {
  const chunk: ChunkResult = {
    id: 1,
    source_name: "docs",
    source_url: null,
    title: null,
    content: "Save notes under /workspace on old clients.",
    repo_url: null,
    file_path: "guide.md",
    start_line: 1,
    end_line: 1,
    language: null,
    similarity: 0.9,
    cosine_similarity: 0.9,
  };
  return { CHUNK: chunk };
});
vi.mock("../db/queries.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db/queries.js")>()),
  searchChunks: vi.fn(async () => [CHUNK]),
  textSearchChunks: vi.fn(async () => [CHUNK]),
}));

// The kill switch (PATHFINDER_MODERN_PROTOCOL) defaults off, so OFF is the
// production default. ON also serves 2026-07-28 connections.
const OFF = { modernProtocol: false };
const ON = { modernProtocol: true };

function makeConfig(
  overrides: {
    tools?: ServerConfig["tools"];
    sources?: ServerConfig["sources"];
  } = {},
): ServerConfig {
  const defaultSources: ServerConfig["sources"] = [
    {
      name: "docs",
      type: "markdown",
      path: "/data/docs",
      file_patterns: ["*.mdx"],
      chunk: { target_tokens: 500 },
    },
  ];

  const defaultTools: ServerConfig["tools"] = [
    {
      name: "search_docs",
      type: "search",
      description: "Search docs",
      source: "docs",
      default_limit: 5,
      max_limit: 20,
      result_format: "docs",
      search_mode: "vector",
    },
    {
      name: "explore",
      type: "bash",
      description: "Explore filesystem",
      sources: ["docs"],
    },
    {
      name: "submit_feedback",
      type: "collect",
      description: "Submit feedback",
      response: "Thanks!",
      schema: {
        rating: { type: "number", required: true },
      },
    },
  ];

  const config: ServerConfig = {
    server: { name: "Test Server", version: "1.0.0", trust_proxy: false },
    sources: overrides.sources ?? defaultSources,
    tools: overrides.tools ?? defaultTools,
    embedding: {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
    },
    indexing: {
      auto_reindex: true,
      reindex_hour_utc: 4,
      stale_threshold_hours: 24,
    },
  };
  return config;
}

/** A bash tool named `name` over the docs source. */
function bashTool(name: string, bash?: BashToolConfig["bash"]): BashToolConfig {
  return {
    name,
    type: "bash",
    description: "Explore filesystem",
    sources: ["docs"],
    ...(bash ? { bash } : {}),
  };
}

function bashConfig(...tools: BashToolConfig[]): ServerConfig {
  return makeConfig({ tools });
}

/** Every line of `md` that starts with `prefix`. */
function linesStartingWith(md: string, prefix: string): string[] {
  return md.split("\n").filter((l) => l.startsWith(prefix));
}

/** The lines of the "#### Workspace" section, heading excluded. */
function workspaceSection(md: string): string[] {
  const lines = md.split("\n");
  const start = lines.indexOf("#### Workspace");
  if (start < 0) return [];
  const end = lines.indexOf("", start);
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

/** The catch-all line after "Every"; `except` is the exceptions clause. */
function catchAllRest(except = ""): string {
  return `other command whose text contains "/workspace" fails, even when it names another path (for example \`cat /docs/workspace-setup.mdx\` or \`grep -r "/workspace" /docs\`)${except}. \`ls\` of a path that starts with /workspace, such as \`ls /workspaces/\`, is read as a store listing and does not show the docs`;
}

/**
 * The command-form lines of the Workspace section; `modern` is the switch and
 * `except` the catch-all's exceptions clause.
 */
function workspaceLegacyLines(modern: boolean, except = ""): string[] {
  return [
    '- Save: `echo "content" > /workspace/notes.md` or `cat /path/to/file.mdx > /workspace/notes.md` (the command must start with echo or cat; it saves the output of the part before `>` and replaces the file)',
    "- Read: `cat /workspace/notes.md`, `head /workspace/notes.md` or `tail /workspace/notes.md` (no flags; each returns the whole file)",
    "- List: `ls /workspace/` or `ls /workspace/subdir/` (one flag group such as `-la` is accepted and ignored)",
    modern
      ? `- On 2025-era (session) connections, every ${catchAllRest(except)}`
      : `- Every ${catchAllRest(except)}`,
    `- The store is private to your session, is deleted when the session ends, and accepts at most ${formatBytes(WORKSPACE_MAX_BYTES_PER_SESSION)} of writes per session (rewriting a file counts again)`,
  ];
}

const MODERN_WORKSPACE_LINE =
  "- /workspace is available only on 2025-era (session) connections. On 2026-07-28 connections a command that reads or writes a path at or under /workspace fails, unless the docs tree has its own /workspace directory (the path then reads those docs). Other text that contains /workspace, such as /docs/workspace-setup.mdx, is not affected";

describe("skill.md generation", () => {
  it("includes all three tool sections when search, bash, and collect are present", () => {
    const result = generateSkillMd(makeConfig(), ON);

    expect(result).toContain("### Semantic Search");
    expect(result).toContain("**search_docs**");
    expect(result).toContain("### Filesystem Exploration");
    expect(result).toContain("**explore**");
    expect(result).toContain("### Data Collection");
    expect(result).toContain("**submit_feedback**");
  });

  it("omits Semantic Search section when config has bash-only tools", () => {
    const result = generateSkillMd(bashConfig(bashTool("explore")), ON);

    expect(result).not.toContain("### Semantic Search");
    expect(result).toContain("### Filesystem Exploration");
    expect(result).not.toContain("### Data Collection");
  });

  it("names no era anywhere when the switch is off (the production default)", () => {
    const result = generateSkillMd(
      bashConfig(
        bashTool("explore", {
          workspace: true,
          session_state: true,
          grep_strategy: "vector",
        }),
      ),
      OFF,
    );

    expect(result).not.toContain("2026-07-28");
    expect(result).not.toContain("2025-era");
  });

  describe("/workspace", () => {
    it("switch off: describes the command forms, with no era note", () => {
      const result = generateSkillMd(
        bashConfig(bashTool("explore", { workspace: true })),
        OFF,
      );

      expect(workspaceSection(result)).toEqual([
        "- `/workspace/` is a store for intermediate results. It is not part of the filesystem: only the commands below can reach it",
        ...workspaceLegacyLines(false),
      ]);
      expect(linesStartingWith(result, "- The filesystem is")).toEqual([
        "- The filesystem is read-only except /tmp. /tmp is private scratch space: it lasts for your session. Writes to /dev/null and /dev/zero succeed and are discarded",
      ]);
      expect(linesStartingWith(result, "- /workspace/ accepts")).toEqual([
        "- /workspace/ accepts only the commands listed under Workspace",
      ]);
      expect(result).not.toContain("writable");
    });

    it("switch on: adds the 2025-era-only note once", () => {
      const result = generateSkillMd(
        bashConfig(bashTool("explore", { workspace: true })),
        ON,
      );

      expect(workspaceSection(result)).toEqual([
        "- `/workspace/` is a store for intermediate results. It is not part of the filesystem: only the commands below can reach it",
        ...workspaceLegacyLines(true),
        MODERN_WORKSPACE_LINE,
      ]);
      expect(linesStartingWith(result, "- The filesystem is")).toEqual([
        "- The filesystem is read-only except /tmp. /tmp is private scratch space: on 2025-era (session) connections it lasts for your session; on 2026-07-28 connections it is discarded after each call. Writes to /dev/null and /dev/zero succeed and are discarded",
      ]);
      expect(linesStartingWith(result, "- /workspace/ accepts")).toEqual([
        "- /workspace/ accepts only the commands listed under Workspace (only on 2025-era (session) connections)",
      ]);
      expect(result).not.toContain("writable");
      expect(result).not.toContain("visible to other clients");
    });

    it("names the tools when only some bash tools have the workspace (switch off)", () => {
      const result = generateSkillMd(
        bashConfig(bashTool("explore", { workspace: true }), bashTool("plain")),
        OFF,
      );

      expect(workspaceSection(result)[0]).toBe(
        "- `/workspace/` is a store for intermediate results (only for `explore`). It is not part of the filesystem: only the commands below can reach it",
      );
      expect(linesStartingWith(result, "- /workspace/ accepts")).toEqual([
        "- /workspace/ accepts only the commands listed under Workspace (only for `explore`)",
      ]);
    });

    it("names the tools and the era when only some bash tools have the workspace (switch on)", () => {
      const result = generateSkillMd(
        bashConfig(bashTool("explore", { workspace: true }), bashTool("plain")),
        ON,
      );

      expect(linesStartingWith(result, "- /workspace/ accepts")).toEqual([
        "- /workspace/ accepts only the commands listed under Workspace (only for `explore`, and only on 2025-era (session) connections)",
      ]);
    });

    it("names cd, qmd and related as exceptions when the workspace tool has them", () => {
      const result = generateSkillMd(
        bashConfig(
          bashTool("explore", {
            workspace: true,
            session_state: true,
            grep_strategy: "hybrid",
          }),
        ),
        OFF,
      );

      expect(linesStartingWith(result, "- Every other")).toEqual([
        `- Every ${catchAllRest(", except a `cd` with no other command, such as `cd /docs/workspace-guides/`, and `qmd` and `related`")}`,
      ]);
    });

    it("scopes each exception to the workspace tools that have it", () => {
      const result = generateSkillMd(
        bashConfig(
          bashTool("explore", { workspace: true, session_state: true }),
          bashTool("semantic", { workspace: true, grep_strategy: "vector" }),
          // No workspace: its qmd and session state do not matter here.
          bashTool("plain", { session_state: true, grep_strategy: "vector" }),
        ),
        ON,
      );

      expect(
        linesStartingWith(result, "- On 2025-era (session) connections, every"),
      ).toEqual([
        `- On 2025-era (session) connections, every ${catchAllRest(", except a `cd` with no other command, such as `cd /docs/workspace-guides/` (only for `explore`), and `qmd` and `related` (only for `semantic`)")}`,
      ]);
    });
  });

  describe("cd", () => {
    const cdLines = (md: string) => linesStartingWith(md, "- `cd ");

    it("does not claim cd persists when no bash tool has session_state", () => {
      for (const options of [ON, OFF]) {
        expect(cdLines(generateSkillMd(makeConfig(), options))).toEqual([
          "- `cd /path/` — change working directory (does not persist between calls; use absolute paths or `cd X && <cmd>`)",
        ]);
      }
    });

    it("switch on: limits cd persistence to 2025-era session connections", () => {
      const result = generateSkillMd(
        bashConfig(bashTool("explore", { session_state: true })),
        ON,
      );

      expect(cdLines(result)).toEqual([
        "- `cd /path/` — change working directory (persists across calls only on 2025-era (session) connections; on 2026-07-28 connections it does not persist, so use absolute paths or `cd X && <cmd>`)",
      ]);
    });

    it("switch off: cd persists on a session_state tool", () => {
      const result = generateSkillMd(
        bashConfig(bashTool("explore", { session_state: true })),
        OFF,
      );

      expect(cdLines(result)).toEqual([
        "- `cd /path/` — change working directory (persists across calls)",
      ]);
    });

    it("switch on: names the tools when only some keep the working directory", () => {
      const result = generateSkillMd(
        bashConfig(
          bashTool("explore", { session_state: true }),
          bashTool("plain"),
        ),
        ON,
      );

      expect(cdLines(result)).toEqual([
        "- `cd /path/` — change working directory (persists across calls only for `explore`, and only on 2025-era (session) connections; otherwise it does not persist, so use absolute paths or `cd X && <cmd>`)",
      ]);
    });

    it("switch off: names the tools when only some keep the working directory", () => {
      const result = generateSkillMd(
        bashConfig(
          bashTool("explore", { session_state: true }),
          bashTool("plain"),
        ),
        OFF,
      );

      expect(cdLines(result)).toEqual([
        "- `cd /path/` — change working directory (persists across calls only for `explore`; otherwise it does not persist, so use absolute paths or `cd X && <cmd>`)",
      ]);
    });
  });

  describe("/tmp", () => {
    const fsLines = (md: string) => linesStartingWith(md, "- The filesystem");

    it("switch on: says each tool has its own /tmp when there is more than one bash tool", () => {
      const result = generateSkillMd(
        bashConfig(bashTool("explore"), bashTool("plain")),
        ON,
      );

      expect(fsLines(result)).toEqual([
        "- The filesystem is read-only except /tmp. /tmp is private scratch space: on 2025-era (session) connections it lasts for your session (each tool has its own /tmp); on 2026-07-28 connections it is discarded after each call. Writes to /dev/null and /dev/zero succeed and are discarded",
      ]);
    });

    it("switch off: says each tool has its own /tmp when there is more than one bash tool", () => {
      const result = generateSkillMd(
        bashConfig(bashTool("explore"), bashTool("plain")),
        OFF,
      );

      expect(fsLines(result)).toEqual([
        "- The filesystem is read-only except /tmp. /tmp is private scratch space: it lasts for your session (each tool has its own /tmp). Writes to /dev/null and /dev/zero succeed and are discarded",
      ]);
    });

    it("leaves out the per-tool note with one bash tool", () => {
      const result = generateSkillMd(bashConfig(bashTool("explore")), OFF);

      expect(result).not.toContain("each tool has its own /tmp");
    });
  });

  it("output with workspace off and the switch on matches the snapshot", () => {
    const config = makeConfig();
    const result = generateSkillMd(config, ON);

    expect(result).not.toContain("/workspace");
    expect(result).toMatchInlineSnapshot(`
      "# Test Server

      Pathfinder is an MCP server providing semantic search and filesystem exploration over documentation and code.

      ## Available Tools

      ### Semantic Search
      - **search_docs**: Search indexed content by meaning. Use for conceptual queries like "how does auth work?"

      ### Filesystem Exploration
      - **explore**: Run bash commands (find, grep, cat, ls, head, tail, cd) over a virtual filesystem of docs/code

      #### Supported Commands
      - \`find / -name "*.mdx"\` — find files by pattern
      - \`grep -rl "pattern" /path\` — search file contents (standard grep, all flags work)
      - \`cat /path/to/file.mdx\` — read file contents
      - \`ls /path/\` — list directory contents
      - \`cd /path/\` — change working directory (does not persist between calls; use absolute paths or \`cd X && <cmd>\`)

      ### Data Collection
      - **submit_feedback**: Submit structured data

      ## When to Use Search vs Explore

      | Need | Tool |
      |------|------|
      | Conceptual question ("how does X work?") | \`search_docs\` |
      | Find exact code or config | \`explore\` (grep) |
      | Browse directory structure | \`explore\` (find, ls) |
      | Read a specific file | \`explore\` (cat) |

      ## Sources

      - docs (markdown)

      ## Limitations

      - The filesystem is read-only except /tmp. /tmp is private scratch space: on 2025-era (session) connections it lasts for your session; on 2026-07-28 connections it is discarded after each call. Writes to /dev/null and /dev/zero succeed and are discarded
      - File content is from the last index update, not real-time
      - Pipes in bash commands are limited to basic patterns"
    `);
  });

  describe("qmd and related", () => {
    const QMD =
      '- `qmd "natural language query"` — semantic search via embeddings (returns file:line:content)';
    const RELATED =
      "- `related /path/to/file.mdx` — find semantically similar files";

    it.each(["vector", "hybrid"] as const)(
      "lists qmd and related when grep_strategy is %s",
      (grep_strategy) => {
        const result = generateSkillMd(
          bashConfig(bashTool("explore", { grep_strategy })),
          OFF,
        );

        expect(linesStartingWith(result, "- `qmd ")).toEqual([QMD]);
        expect(linesStartingWith(result, "- `related ")).toEqual([RELATED]);
        expect(linesStartingWith(result, "| Semantic code search")).toEqual([
          "| Semantic code search | `explore` (qmd) |",
        ]);
      },
    );

    it("does not mention qmd or related when grep_strategy is memory", () => {
      const result = generateSkillMd(
        bashConfig(bashTool("explore", { grep_strategy: "memory" })),
        OFF,
      );

      expect(result).not.toContain("qmd");
      expect(result).not.toContain("related");
      expect(result).not.toContain("Semantic code search");
    });

    it("names the tools when only some bash tools have embeddings", () => {
      const result = generateSkillMd(
        bashConfig(
          bashTool("explore", { grep_strategy: "hybrid" }),
          bashTool("plain", { grep_strategy: "memory" }),
        ),
        ON,
      );

      expect(linesStartingWith(result, "- `qmd ")).toEqual([
        '- `qmd "natural language query"` — semantic search via embeddings (returns file:line:content; only for `explore`)',
      ]);
      expect(linesStartingWith(result, "- `related ")).toEqual([
        "- `related /path/to/file.mdx` — find semantically similar files (only for `explore`)",
      ]);
    });
  });

  it("lists all sources by name and type", () => {
    const config = makeConfig({
      sources: [
        {
          name: "docs",
          type: "markdown",
          path: "/data/docs",
          file_patterns: ["*.mdx"],
          chunk: { target_tokens: 500 },
        },
        {
          name: "sdk",
          type: "code",
          path: "/data/sdk",
          file_patterns: ["*.ts"],
          chunk: { target_lines: 50 },
        },
        {
          name: "notes",
          type: "raw-text",
          path: "/data/notes",
          file_patterns: ["*.txt"],
          chunk: { target_tokens: 300 },
        },
      ],
    });
    const result = generateSkillMd(config, ON);

    expect(result).toContain("## Sources");
    expect(result).toContain("- docs (markdown)");
    expect(result).toContain("- sdk (code)");
    expect(result).toContain("- notes (raw-text)");
  });
});

describe("skill.md tool lists", () => {
  it("toolList keeps names apart from a following comma clause", () => {
    expect(toolList([])).toBe("");
    expect(toolList(["a"])).toBe("`a`");
    expect(toolList(["a", "b"])).toBe("`a` and `b`");
    expect(toolList(["a", "b", "c"])).toBe("`a`, `b` and `c`");
  });

  it("onlyFor names some tools, is undefined for all, and throws for none", () => {
    expect(onlyFor(["a", "b"], ["a", "b", "c"])).toBe("only for `a` and `b`");
    expect(onlyFor(["a", "b"], ["a", "b"])).toBeUndefined();
    expect(() => onlyFor([], ["a"])).toThrow(RangeError);
  });

  it("formatBytes gives whole MB as MB and anything else as bytes", () => {
    expect(formatBytes(WORKSPACE_MAX_BYTES_PER_SESSION)).toBe("1 MB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3 MB");
    expect(formatBytes(1024)).toBe("1024 bytes");
  });

  describe("two of three bash tools have every feature", () => {
    // Both workspace tools keep cd and have qmd, so no exception is scoped.
    const EVERY_FEATURE_EXCEPT =
      ", except a `cd` with no other command, such as `cd /docs/workspace-guides/`, and `qmd` and `related`";
    const full = { session_state: true, workspace: true } as const;
    const config = bashConfig(
      bashTool("docs-a", { ...full, grep_strategy: "vector" }),
      bashTool("docs-b", { ...full, grep_strategy: "hybrid" }),
      bashTool("docs-plain"),
    );

    it("switch on: each scoped line names both tools", () => {
      const result = generateSkillMd(config, ON);

      expect(linesStartingWith(result, "- `cd ")).toEqual([
        "- `cd /path/` — change working directory (persists across calls only for `docs-a` and `docs-b`, and only on 2025-era (session) connections; otherwise it does not persist, so use absolute paths or `cd X && <cmd>`)",
      ]);
      expect(linesStartingWith(result, "- `qmd ")).toEqual([
        '- `qmd "natural language query"` — semantic search via embeddings (returns file:line:content; only for `docs-a` and `docs-b`)',
      ]);
      expect(linesStartingWith(result, "- `related ")).toEqual([
        "- `related /path/to/file.mdx` — find semantically similar files (only for `docs-a` and `docs-b`)",
      ]);
      expect(workspaceSection(result)).toEqual([
        "- `/workspace/` is a store for intermediate results (only for `docs-a` and `docs-b`). It is not part of the filesystem: only the commands below can reach it",
        ...workspaceLegacyLines(true, EVERY_FEATURE_EXCEPT),
        MODERN_WORKSPACE_LINE,
      ]);
      expect(linesStartingWith(result, "- /workspace/ accepts")).toEqual([
        "- /workspace/ accepts only the commands listed under Workspace (only for `docs-a` and `docs-b`, and only on 2025-era (session) connections)",
      ]);
    });

    it("switch off: each scoped line names both tools", () => {
      const result = generateSkillMd(config, OFF);

      expect(linesStartingWith(result, "- `cd ")).toEqual([
        "- `cd /path/` — change working directory (persists across calls only for `docs-a` and `docs-b`; otherwise it does not persist, so use absolute paths or `cd X && <cmd>`)",
      ]);
      expect(linesStartingWith(result, "- `qmd ")).toEqual([
        '- `qmd "natural language query"` — semantic search via embeddings (returns file:line:content; only for `docs-a` and `docs-b`)',
      ]);
      expect(linesStartingWith(result, "- `related ")).toEqual([
        "- `related /path/to/file.mdx` — find semantically similar files (only for `docs-a` and `docs-b`)",
      ]);
      expect(workspaceSection(result)).toEqual([
        "- `/workspace/` is a store for intermediate results (only for `docs-a` and `docs-b`). It is not part of the filesystem: only the commands below can reach it",
        ...workspaceLegacyLines(false, EVERY_FEATURE_EXCEPT),
      ]);
      expect(linesStartingWith(result, "- /workspace/ accepts")).toEqual([
        "- /workspace/ accepts only the commands listed under Workspace (only for `docs-a` and `docs-b`)",
      ]);
    });

    it("the table names the configured tools and scopes the qmd row", () => {
      const result = generateSkillMd(config, OFF);

      expect(linesStartingWith(result, "| ").slice(1)).toEqual([
        "| Find exact code or config | `docs-a`, `docs-b` and `docs-plain` (grep) |",
        "| Browse directory structure | `docs-a`, `docs-b` and `docs-plain` (find, ls) |",
        "| Read a specific file | `docs-a`, `docs-b` and `docs-plain` (cat) |",
        "| Semantic code search | `docs-a` and `docs-b` (qmd) |",
      ]);
    });
  });

  it("the qmd suffix names the tool with the switch off", () => {
    const result = generateSkillMd(
      bashConfig(
        bashTool("explore", { grep_strategy: "vector" }),
        bashTool("plain"),
      ),
      OFF,
    );

    expect(linesStartingWith(result, "- `qmd ")).toEqual([
      '- `qmd "natural language query"` — semantic search via embeddings (returns file:line:content; only for `explore`)',
    ]);
    expect(linesStartingWith(result, "- `related ")).toEqual([
      "- `related /path/to/file.mdx` — find semantically similar files (only for `explore`)",
    ]);
  });

  it("the Workspace header names the tool with partial scope and the switch on", () => {
    const result = generateSkillMd(
      bashConfig(bashTool("explore", { workspace: true }), bashTool("plain")),
      ON,
    );

    expect(workspaceSection(result)).toEqual([
      "- `/workspace/` is a store for intermediate results (only for `explore`). It is not part of the filesystem: only the commands below can reach it",
      ...workspaceLegacyLines(true),
      MODERN_WORKSPACE_LINE,
    ]);
  });

  it("the table has no bash rows without bash tools and no search row without search tools", () => {
    const searchOnly = generateSkillMd(
      makeConfig({ tools: [makeConfig().tools[0]] }),
      OFF,
    );
    expect(linesStartingWith(searchOnly, "| ").slice(1)).toEqual([
      '| Conceptual question ("how does X work?") | `search_docs` |',
    ]);

    const bashOnly = generateSkillMd(bashConfig(bashTool("explore")), OFF);
    expect(linesStartingWith(bashOnly, "| ").slice(1)).toEqual([
      "| Find exact code or config | `explore` (grep) |",
      "| Browse directory structure | `explore` (find, ls) |",
      "| Read a specific file | `explore` (cat) |",
    ]);

    const collectOnly = generateSkillMd(
      makeConfig({ tools: [makeConfig().tools[2]] }),
      OFF,
    );
    expect(collectOnly).not.toContain("## When to Use Search vs Explore");
    expect(collectOnly).not.toContain("| Need |");
  });

  it("the conceptual row names knowledge tools, also with no search tool", () => {
    const faq: ServerConfig["tools"][number] = {
      name: "faq",
      type: "knowledge",
      description: "Answered questions",
      sources: ["docs"],
      min_confidence: 0.7,
      default_limit: 20,
      max_limit: 100,
    };

    const knowledgeOnly = generateSkillMd(makeConfig({ tools: [faq] }), OFF);
    expect(linesStartingWith(knowledgeOnly, "| ").slice(1)).toEqual([
      '| Conceptual question ("how does X work?") | `faq` |',
    ]);

    const both = generateSkillMd(
      makeConfig({ tools: [makeConfig().tools[0], faq] }),
      OFF,
    );
    expect(linesStartingWith(both, "| Conceptual")).toEqual([
      '| Conceptual question ("how does X work?") | `search_docs` and `faq` |',
    ]);
  });
});

// The Workspace text is checked against the real bash tool: every command it
// names runs through registerBashTool on both eras, so a change to the
// interception in bash.ts that makes the text wrong fails here.
describe("served Workspace commands against the real bash tool", () => {
  const TOOL: BashToolConfig = bashTool("explore", {
    session_state: true,
    workspace: true,
  });
  const LONG = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n");
  const DOCS = {
    "/path/to/file.mdx": `${LONG}\n`,
    "/docs/workspace-setup.mdx": "# Workspace setup guide\n",
    "/docs/guide.md": "Save notes under /workspace on old clients.\n",
    "/docs/big.mdx": "x".repeat(600 * 1024),
    "/workspaces/readme.md": "plural workspaces dir\n",
    "/docs/workspace-guides/intro.md": "# Intro\n",
  };
  const served = workspaceSection(
    generateSkillMd(bashConfig(TOOL), { modernProtocol: true }),
  );
  /** The code spans of the served line that starts with `prefix`. */
  function spans(prefix: string): string[] {
    const line = served.find((l) => l.startsWith(prefix));
    if (line === undefined) throw new Error(`no served line ${prefix}`);
    return [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  }
  const save = spans("- Save:").filter((c) => c.includes("/workspace"));
  const read = spans("- Read:");
  const list = spans("- List:").filter((c) => c.startsWith("ls "));
  const catchAll = spans("- On 2025-era (session) connections, every");
  const others = catchAll.filter(
    (c) => c.startsWith("cat ") || c.startsWith("grep "),
  );
  const lsOther = catchAll.filter((c) => c.startsWith("ls /"));

  let tmpDir: string;
  const closers: Array<() => Promise<void>> = [];
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pathfinder-skillmd-"));
  });
  afterAll(async () => {
    for (const close of closers) await close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function tool(
    era: "legacy" | "modern",
    files: Record<string, string> = DOCS,
    config: BashToolConfig = TOOL,
  ): Promise<(command: string) => Promise<string>> {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    // The production default quota (server.ts passes no size).
    const workspace = new WorkspaceManager(
      fs.mkdtempSync(path.join(tmpDir, `${era}-`)),
    );
    registerBashTool(server, config, new Bash({ files, cwd: "/" }), {
      // bash.ts uses session state only on a session_state tool.
      ...(config.bash?.session_state
        ? { sessionState: new BashSessionState() }
        : {}),
      // mcp/server.ts passes an embedding client only for vector or hybrid.
      ...(config.bash?.grep_strategy === "vector" ||
      config.bash?.grep_strategy === "hybrid"
        ? {
            embeddingClient: {
              embed: async () => [0.1, 0.2],
              embedBatch: async (texts: string[]) =>
                texts.map(() => [0.1, 0.2]),
            },
          }
        : {}),
      workspace,
      // A real modern connection has no session id.
      getSessionId: () => (era === "legacy" ? "skill-md-sid" : undefined),
      era,
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
    closers.push(async () => {
      await client.close();
      await server.close();
    });
    return async (command) => {
      const result = await client.callTool({
        name: "explore",
        arguments: { command },
      });
      return (result.content as Array<{ text: string }>)[0].text;
    };
  }

  it("serves the commands this test runs", () => {
    expect(save).toEqual([
      'echo "content" > /workspace/notes.md',
      "cat /path/to/file.mdx > /workspace/notes.md",
    ]);
    expect(read).toEqual([
      "cat /workspace/notes.md",
      "head /workspace/notes.md",
      "tail /workspace/notes.md",
    ]);
    expect(list).toEqual(["ls /workspace/", "ls /workspace/subdir/"]);
    expect(others).toEqual([
      "cat /docs/workspace-setup.mdx",
      'grep -r "/workspace" /docs',
    ]);
    expect(lsOther).toEqual(["ls /workspaces/"]);
  });

  it("2025-era: each served form works as the text says", async () => {
    const run = await tool("legacy");

    // Save: echo, then cat of a docs file, which replaces the first save.
    expect(await run(save[0])).toContain("Written to /workspace/notes.md");
    expect(await run(read[0])).toBe(`$ ${read[0]}\ncontent\n`);
    expect(await run(save[1])).toContain("Written to /workspace/notes.md");
    // Read: cat, head and tail each return the whole 15-line file.
    for (const command of read) {
      expect(await run(command)).toBe(`$ ${command}\n${LONG}\n`);
    }
    expect(await run("head -n 2 /workspace/notes.md")).toContain(
      "workspace: supported operations are:",
    );
    // List: the store, a subdirectory, and one ignored flag group.
    expect(await run('echo "x" > /workspace/subdir/f.md')).toContain(
      "Written to",
    );
    expect(await run(list[0])).toBe(`$ ${list[0]}\nnotes.md\nsubdir`);
    expect(await run(list[1])).toBe(`$ ${list[1]}\nf.md`);
    expect(await run("ls -la /workspace/")).toBe(
      "$ ls -la /workspace/\nnotes.md\nsubdir",
    );
  });

  it("2025-era: every other command whose text contains /workspace fails", async () => {
    const run = await tool("legacy");

    for (const command of [
      ...others,
      "find /workspace",
      "mkdir /workspace/d",
    ]) {
      const text = await run(command);
      expect(text).toContain("workspace: supported operations are:");
      expect(text).toContain("[exit code 1]");
    }
    // ls of /workspaces/ is read as a store listing: the docs file is not shown.
    expect(await run(lsOther[0])).toBe(`$ ${lsOther[0]}`);
  });

  it("2025-era: the served exceptions run as usual, only on the tools named", async () => {
    const ALL: BashToolConfig = bashTool("explore", {
      session_state: true,
      workspace: true,
      grep_strategy: "vector",
    });
    const line = workspaceSection(
      generateSkillMd(bashConfig(ALL), { modernProtocol: true }),
    ).find((l) => l.startsWith("- On 2025-era (session) connections, every"));
    const named = [...(line ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const cd = named.filter((c) => c.startsWith("cd "));
    expect(cd).toEqual(["cd /docs/workspace-guides/"]);
    expect(named).toContain("qmd");
    expect(named).toContain("related");
    const qmd = 'qmd "/workspace"';
    const related = "related /docs/workspace-setup.mdx";

    const run = await tool("legacy", DOCS, ALL);
    expect(await run(cd[0])).toBe(`$ ${cd[0]}`);
    expect(await run(qmd)).toBe(
      `$ ${qmd}\n/guide.md:1:Save notes under /workspace on old clients.\n`,
    );
    expect(await run(related)).toContain("/docs/guide.md");
    expect(await run(related)).not.toContain("[exit code");

    // A workspace tool without session_state or embeddings fails all three.
    const plain = await tool(
      "legacy",
      DOCS,
      bashTool("explore", { workspace: true }),
    );
    for (const command of [cd[0], qmd, related]) {
      const text = await plain(command);
      expect(text).toContain("workspace: supported operations are:");
      expect(text).toContain("[exit code 1]");
    }
  });

  it("2025-era: the quota is cumulative and a rewrite counts again", async () => {
    const run = await tool("legacy");
    const write = "cat /docs/big.mdx > /workspace/big.md";

    expect(WORKSPACE_MAX_BYTES_PER_SESSION).toBeLessThan(2 * 600 * 1024);
    expect(await run(write)).toContain("Written to /workspace/big.md");
    expect(await run(write)).toContain("workspace: quota exceeded");
  });

  it("2026-07-28: every served /workspace form fails, and other text is not affected", async () => {
    const run = await tool("modern");

    for (const command of [...save, ...read, ...list]) {
      const text = await run(command);
      expect(text).toContain(MODERN_WORKSPACE_REFUSAL);
      expect(text).toContain("[exit code 1]");
    }
    expect(await run(others[0])).toBe(
      `$ ${others[0]}\n# Workspace setup guide\n`,
    );
    expect(await run(others[1])).toBe(
      `$ ${others[1]}\n/docs/guide.md:Save notes under /workspace on old clients.\n`,
    );
    expect(await run(lsOther[0])).toBe(`$ ${lsOther[0]}\nreadme.md\n`);
  });

  it("2026-07-28: a docs tree with its own /workspace reads those docs", async () => {
    const run = await tool("modern", {
      ...DOCS,
      "/workspace/notes.md": "docs-owned notes\n",
    });

    expect(await run(read[0])).toBe(`$ ${read[0]}\ndocs-owned notes\n`);
  });
});
