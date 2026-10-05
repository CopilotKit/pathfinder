import type { ServerConfig } from "./types.js";

export function generateSkillMd(config: ServerConfig): string {
  const searchTools = config.tools
    .filter((t) => t.type === "search")
    .map((t) => t.name);
  const bashTools = config.tools
    .filter((t) => t.type === "bash")
    .map((t) => t.name);
  const collectTools = config.tools
    .filter((t) => t.type === "collect")
    .map((t) => t.name);
  const sources = config.sources.map((s) => `${s.name} (${s.type})`);
  const hasWorkspace = config.tools.some(
    (t) => t.type === "bash" && t.bash?.workspace === true,
  );
  // cd persists only through BashSessionState, which bash.ts enables only for
  // a 2025-era (session) connection on a tool with session_state: true.
  const hasSessionState = config.tools.some(
    (t) => t.type === "bash" && t.bash?.session_state === true,
  );
  const hasQmd = config.tools.some(
    (t) =>
      t.type === "bash" &&
      t.bash?.grep_strategy &&
      t.bash.grep_strategy !== "memory",
  );

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
    lines.push(
      hasSessionState
        ? "- `cd /path/` — change working directory (persists across calls only on 2025-era (session) connections; on 2026-07-28 connections it does not persist, so use absolute paths or `cd X && <cmd>`)"
        : "- `cd /path/` — change working directory (does not persist between calls; use absolute paths or `cd X && <cmd>`)",
    );
    if (hasQmd) {
      lines.push(
        '- `qmd "natural language query"` — semantic search via embeddings (returns file:line:content)',
      );
    }
    lines.push(
      "- `related /path/to/file.mdx` — find semantically similar files",
    );
    if (hasWorkspace) {
      lines.push("");
      lines.push("#### Workspace");
      lines.push(
        "- `/workspace/` is a writable area for saving intermediate results",
      );
      lines.push('- Use `echo "content" > /workspace/notes.md` to save files');
      lines.push("- Workspace is session-scoped and size-limited");
      lines.push(
        "- /workspace is available only on 2025-era (session) connections.",
      );
    }
    lines.push("");
  }

  if (collectTools.length > 0) {
    lines.push("### Data Collection");
    for (const name of collectTools)
      lines.push(`- **${name}**: Submit structured data`);
    lines.push("");
  }

  lines.push("## When to Use Search vs Explore");
  lines.push("");
  lines.push("| Need | Tool |");
  lines.push("|------|------|");
  lines.push('| Conceptual question ("how does X work?") | search |');
  lines.push("| Find exact code or config | explore (grep) |");
  lines.push("| Browse directory structure | explore (find, ls) |");
  lines.push("| Read a specific file | explore (cat) |");
  if (hasQmd) lines.push("| Semantic code search | explore (qmd) |");
  lines.push("");

  lines.push("## Sources");
  lines.push("");
  for (const s of sources) lines.push(`- ${s}`);
  lines.push("");

  lines.push("## Limitations");
  lines.push("");
  if (bashTools.length > 0) {
    lines.push(
      "- The filesystem is read-only except /tmp, which is private scratch space: on 2025-era (session) connections it lasts for your session; on 2026-07-28 connections it is discarded after each call",
    );
    if (hasWorkspace) {
      lines.push(
        "- /workspace/ is writable and private to your session (2025-era connections only)",
      );
    }
  }
  lines.push("- File content is from the last index update, not real-time");
  lines.push("- Pipes in bash commands are limited to basic patterns");

  return lines.join("\n");
}
