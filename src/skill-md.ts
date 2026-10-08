import type { ServerConfig } from "./types.js";
import { WORKSPACE_MAX_BYTES_PER_SESSION } from "./workspace.js";

export interface SkillMdOptions {
  /**
   * Whether the PATHFINDER_MODERN_PROTOCOL kill switch is on, so that
   * 2026-07-28 connections are served. Off: every connection is 2025-era and
   * the text names no era. On: the text describes both eras. Required, so
   * that no caller can describe an era the server does not serve (the switch
   * defaults off, config.ts).
   */
  modernProtocol: boolean;
}

/**
 * `names` as code spans in a list that cannot be read as part of a longer
 * comma list: `a`; `a` and `b`; `a`, `b` and `c`.
 */
export function toolList(names: string[]): string {
  const spans = names.map((n) => `\`${n}\``);
  if (spans.length <= 1) return spans.join("");
  return `${spans.slice(0, -1).join(", ")} and ${spans[spans.length - 1]}`;
}

/**
 * "only for <tools>" when some but not all of `allTools` have a feature, and
 * undefined when all of them do. Throws for an empty list: the text describes
 * a feature only when at least one tool has it.
 */
export function onlyFor(
  featureTools: string[],
  allTools: string[],
): string | undefined {
  if (featureTools.length === 0) {
    throw new RangeError("onlyFor: no tool has the feature");
  }
  return featureTools.length < allTools.length
    ? `only for ${toolList(featureTools)}`
    : undefined;
}

/** A byte count as "N MB" when it is a whole number of MB, else "N bytes". */
export function formatBytes(bytes: number): string {
  const mb = 1024 * 1024;
  return bytes % mb === 0 ? `${bytes / mb} MB` : `${bytes} bytes`;
}

export function generateSkillMd(
  config: ServerConfig,
  options: SkillMdOptions,
): string {
  const modern = options.modernProtocol;
  const searchTools = config.tools
    .filter((t) => t.type === "search")
    .map((t) => t.name);
  // Search and knowledge tools both answer a question by meaning.
  const conceptualTools = config.tools
    .filter((t) => t.type === "search" || t.type === "knowledge")
    .map((t) => t.name);
  const bashTools = config.tools
    .filter((t) => t.type === "bash")
    .map((t) => t.name);
  const collectTools = config.tools
    .filter((t) => t.type === "collect")
    .map((t) => t.name);
  const sources = config.sources.map((s) => `${s.name} (${s.type})`);
  // /workspace is reachable only from a bash tool with workspace: true
  // (mcp/server.ts passes the WorkspaceManager only to those tools).
  const workspaceTools = config.tools
    .filter((t) => t.type === "bash" && t.bash?.workspace === true)
    .map((t) => t.name);
  const hasWorkspace = workspaceTools.length > 0;
  // cd persists only through BashSessionState, which bash.ts enables only for
  // a 2025-era (session) connection on a tool with session_state: true.
  const sessionTools = config.tools
    .filter((t) => t.type === "bash" && t.bash?.session_state === true)
    .map((t) => t.name);
  // qmd and related need an embedding client, which mcp/server.ts passes to
  // a bash tool only for grep_strategy vector or hybrid.
  const qmdTools = config.tools
    .filter(
      (t) =>
        t.type === "bash" &&
        (t.bash?.grep_strategy === "vector" ||
          t.bash?.grep_strategy === "hybrid"),
    )
    .map((t) => t.name);
  const hasQmd = qmdTools.length > 0;

  const lines: string[] = [
    `# ${config.server.name}`,
    "",
    "Pathfinder is an MCP server providing semantic search and filesystem exploration over documentation and code.",
    "",
    "## Available Tools",
    "",
  ];

  if (searchTools.length > 0) {
    lines.push("### Semantic Search");
    for (const name of searchTools)
      lines.push(
        `- **${name}**: Search indexed content by meaning. Use for conceptual queries like "how does auth work?"`,
      );
    lines.push("");
  }

  if (bashTools.length > 0) {
    lines.push("### Filesystem Exploration");
    for (const name of bashTools)
      lines.push(
        `- **${name}**: Run bash commands (find, grep, cat, ls, head, tail, cd) over a virtual filesystem of docs/code`,
      );
    lines.push("");
    lines.push("#### Supported Commands");
    lines.push('- `find / -name "*.mdx"` — find files by pattern');
    lines.push(
      '- `grep -rl "pattern" /path` — search file contents (standard grep, all flags work)',
    );
    lines.push("- `cat /path/to/file.mdx` — read file contents");
    lines.push("- `ls /path/` — list directory contents");
    if (sessionTools.length === 0) {
      lines.push(
        "- `cd /path/` — change working directory (does not persist between calls; use absolute paths or `cd X && <cmd>`)",
      );
    } else {
      // Name the tools when only some of them keep the working directory.
      const cdScope = onlyFor(sessionTools, bashTools);
      if (modern) {
        lines.push(
          cdScope
            ? `- \`cd /path/\` — change working directory (persists across calls ${cdScope}, and only on 2025-era (session) connections; otherwise it does not persist, so use absolute paths or \`cd X && <cmd>\`)`
            : "- `cd /path/` — change working directory (persists across calls only on 2025-era (session) connections; on 2026-07-28 connections it does not persist, so use absolute paths or `cd X && <cmd>`)",
        );
      } else {
        lines.push(
          cdScope
            ? `- \`cd /path/\` — change working directory (persists across calls ${cdScope}; otherwise it does not persist, so use absolute paths or \`cd X && <cmd>\`)`
            : "- `cd /path/` — change working directory (persists across calls)",
        );
      }
    }
    if (hasQmd) {
      // qmd and related run only with an embedding client (bash.ts).
      const qmdScope = onlyFor(qmdTools, bashTools);
      lines.push(
        `- \`qmd "natural language query"\` — semantic search via embeddings (returns file:line:content${qmdScope ? `; ${qmdScope}` : ""})`,
      );
      lines.push(
        `- \`related /path/to/file.mdx\` — find semantically similar files${qmdScope ? ` (${qmdScope})` : ""}`,
      );
    }
    if (hasWorkspace) {
      // Each line matches the 2025-era interception in bash.ts ("Intercept
      // workspace commands"): the write, read and ls patterns, then a
      // catch-all that fails every other command whose text contains
      // "/workspace". bash.ts handles three commands before that catch-all:
      // a bare `cd` on a session_state tool, and `qmd` and `related` on a
      // tool with embeddings. skill-md.test.ts runs these commands through
      // the real tool. On a 2026-07-28 connection bash.ts refuses a
      // /workspace path unless the docs tree has its own /workspace
      // (registerBashTool exec).
      const wsScope = onlyFor(workspaceTools, bashTools);
      const exceptions: string[] = [];
      const wsCdTools = sessionTools.filter((n) => workspaceTools.includes(n));
      if (wsCdTools.length > 0) {
        const scope = onlyFor(wsCdTools, workspaceTools);
        exceptions.push(
          `a \`cd\` with no other command, such as \`cd /docs/workspace-guides/\`${scope ? ` (${scope})` : ""}`,
        );
      }
      const wsQmdTools = qmdTools.filter((n) => workspaceTools.includes(n));
      if (wsQmdTools.length > 0) {
        const scope = onlyFor(wsQmdTools, workspaceTools);
        exceptions.push(`\`qmd\` and \`related\`${scope ? ` (${scope})` : ""}`);
      }
      const except =
        exceptions.length > 0 ? `, except ${exceptions.join(", and ")}` : "";
      lines.push("");
      lines.push("#### Workspace");
      lines.push(
        `- \`/workspace/\` is a store for intermediate results${wsScope ? ` (${wsScope})` : ""}. It is not part of the filesystem: only the commands below can reach it`,
      );
      lines.push(
        '- Save: `echo "content" > /workspace/notes.md` or `cat /path/to/file.mdx > /workspace/notes.md` (the command must start with echo or cat; it saves the output of the part before `>` and replaces the file)',
      );
      lines.push(
        "- Read: `cat /workspace/notes.md`, `head /workspace/notes.md` or `tail /workspace/notes.md` (no flags; each returns the whole file)",
      );
      lines.push(
        "- List: `ls /workspace/` or `ls /workspace/subdir/` (one flag group such as `-la` is accepted and ignored)",
      );
      lines.push(
        `- ${modern ? "On 2025-era (session) connections, every" : "Every"} other command whose text contains "/workspace" fails, even when it names another path (for example \`cat /docs/workspace-setup.mdx\` or \`grep -r "/workspace" /docs\`)${except}. \`ls\` of a path that starts with /workspace, such as \`ls /workspaces/\`, is read as a store listing and does not show the docs`,
      );
      lines.push(
        `- The store is private to your session, is deleted when the session ends, and accepts at most ${formatBytes(WORKSPACE_MAX_BYTES_PER_SESSION)} of writes per session (rewriting a file counts again)`,
      );
      if (modern) {
        lines.push(
          "- /workspace is available only on 2025-era (session) connections. On 2026-07-28 connections a command that reads or writes a path at or under /workspace fails, unless the docs tree has its own /workspace directory (the path then reads those docs). Other text that contains /workspace, such as /docs/workspace-setup.mdx, is not affected",
        );
      }
    }
    lines.push("");
  }

  if (collectTools.length > 0) {
    lines.push("### Data Collection");
    for (const name of collectTools)
      lines.push(`- **${name}**: Submit structured data`);
    lines.push("");
  }

  // Rows name the configured tools, and only the tools that can do the job.
  const tableRows: string[] = [];
  if (conceptualTools.length > 0) {
    tableRows.push(
      `| Conceptual question ("how does X work?") | ${toolList(conceptualTools)} |`,
    );
  }
  if (bashTools.length > 0) {
    const bash = toolList(bashTools);
    tableRows.push(`| Find exact code or config | ${bash} (grep) |`);
    tableRows.push(`| Browse directory structure | ${bash} (find, ls) |`);
    tableRows.push(`| Read a specific file | ${bash} (cat) |`);
  }
  if (hasQmd) {
    tableRows.push(`| Semantic code search | ${toolList(qmdTools)} (qmd) |`);
  }
  if (tableRows.length > 0) {
    lines.push("## When to Use Search vs Explore");
    lines.push("");
    lines.push("| Need | Tool |");
    lines.push("|------|------|");
    lines.push(...tableRows);
    lines.push("");
  }

  lines.push("## Sources");
  lines.push("");
  for (const s of sources) lines.push(`- ${s}`);
  lines.push("");

  lines.push("## Limitations");
  lines.push("");
  if (bashTools.length > 0) {
    // A 2025-era /tmp belongs to one tool registration, and each session
    // registers every tool once (bash.ts sessionTmp).
    const perTool = bashTools.length > 1 ? " (each tool has its own /tmp)" : "";
    const tmpLife = modern
      ? `on 2025-era (session) connections it lasts for your session${perTool}; on 2026-07-28 connections it is discarded after each call`
      : `it lasts for your session${perTool}`;
    // The bash filesystem refuses every write outside /tmp in both eras
    // (bash.ts scratchOnlyFs). /workspace is not a filesystem path.
    lines.push(
      `- The filesystem is read-only except /tmp. /tmp is private scratch space: ${tmpLife}. Writes to /dev/null and /dev/zero succeed and are discarded`,
    );
    if (hasWorkspace) {
      const wsWhere = [
        onlyFor(workspaceTools, bashTools),
        modern ? "only on 2025-era (session) connections" : undefined,
      ]
        .filter((part) => part !== undefined)
        .join(", and ");
      lines.push(
        `- /workspace/ accepts only the commands listed under Workspace${wsWhere && ` (${wsWhere})`}`,
      );
    }
  }
  lines.push("- File content is from the last index update, not real-time");
  lines.push("- Pipes in bash commands are limited to basic patterns");

  return lines.join("\n");
}
