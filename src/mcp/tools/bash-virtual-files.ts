export function generateIndexMd(fileTree: Record<string, string>): string {
  const paths = Object.keys(fileTree).sort();
  const lines: string[] = [
    `# INDEX`,
    ``,
    `${paths.length} files available in this virtual filesystem.`,
    ``,
  ];
  if (paths.length === 0) return lines.join("\n");
  const tree: Record<string, string[]> = {};
  for (const p of paths) {
    const parts = p.split("/").filter(Boolean);
    if (parts.length === 1) {
      if (!tree["/"]) tree["/"] = [];
      tree["/"].push(parts[0]);
    } else {
      const dir = "/" + parts.slice(0, -1).join("/") + "/";
      if (!tree[dir]) tree[dir] = [];
      tree[dir].push(parts[parts.length - 1]);
    }
  }
  const sortedDirs = Object.keys(tree).sort();
  for (const dir of sortedDirs) {
    lines.push(`## ${dir}`);
    for (const file of tree[dir].sort()) {
      lines.push(`- ${file}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function generateSearchTipsMd(searchToolNames: string[]): string {
  const lines: string[] = [
    `# SEARCH TIPS`,
    ``,
    `## Bash Commands`,
    '- `find / -name "*.ts"` — discover files by pattern',
    '- `grep -r "pattern" /` — search file contents',
    "- `cat /path/to/file` — read a specific file",
    "- `head -n 50 /path/to/file` — read first N lines",
    "- `ls /path/` — list directory contents",
    ``,
  ];
  if (searchToolNames.length > 0) {
    lines.push(`## Semantic Search Tools`);
    lines.push(`For broader, meaning-based search, use these companion tools:`);
    lines.push(``);
    for (const name of searchToolNames) {
      lines.push(
        `- **${name}** — semantic vector search (finds related content even without exact keyword match)`,
      );
    }
    lines.push(``);
    lines.push(
      `**Tip:** Use grep for exact matches, search tools for conceptual queries.`,
    );
  }
  lines.push(`## Workflow`);
  lines.push(
    "1. Start with `find` or `ls` to understand the directory structure",
  );
  lines.push('2. Use `grep -rl "keyword"` to locate files mentioning a topic');
  lines.push("3. Use `cat` to read the full content of relevant files");
  lines.push(`4. Read INDEX.md for a full file listing`);
  return lines.join("\n");
}
