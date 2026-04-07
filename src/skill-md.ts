import type { ServerConfig } from './types.js';

export function generateSkillMd(config: ServerConfig): string {
    const searchTools = config.tools.filter(t => t.type === 'search').map(t => t.name);
    const bashTools = config.tools.filter(t => t.type === 'bash').map(t => t.name);
    const collectTools = config.tools.filter(t => t.type === 'collect').map(t => t.name);
    const sources = config.sources.map(s => `${s.name} (${s.type})`);
    const hasWorkspace = config.tools.some(t => t.type === 'bash' && t.bash?.workspace === true);
    const hasQmd = config.tools.some(t => t.type === 'bash' && t.bash?.grep_strategy && t.bash.grep_strategy !== 'memory');

    const lines: string[] = [
        `# ${config.server.name}`,
        '',
        'Pathfinder is an MCP server providing semantic search and filesystem exploration over documentation and code.',
        '',
        '## Available Tools',
        '',
    ];

    if (searchTools.length > 0) {
        lines.push('### Semantic Search');
        for (const name of searchTools) lines.push(`- **${name}**: Search indexed content by meaning. Use for conceptual queries like "how does auth work?"`);
        lines.push('');
    }

    if (bashTools.length > 0) {
        lines.push('### Filesystem Exploration');
        for (const name of bashTools) lines.push(`- **${name}**: Run bash commands (find, grep, cat, ls, head, tail, cd) over a virtual filesystem of docs/code`);
        lines.push('');
        lines.push('#### Supported Commands');
        lines.push('- `find / -name "*.mdx"` — find files by pattern');
        lines.push('- `grep -rl "pattern" /path` — search file contents (standard grep, all flags work)');
        lines.push('- `cat /path/to/file.mdx` — read file contents');
        lines.push('- `ls /path/` — list directory contents');
        lines.push('- `cd /path/` — change working directory (persists across calls)');
        if (hasQmd) {
            lines.push('- `qmd "natural language query"` — semantic search via embeddings (returns file:line:content)');
        }
        lines.push('- `related /path/to/file.mdx` — find semantically similar files');
        if (hasWorkspace) {
            lines.push('');
            lines.push('#### Workspace');
            lines.push('- `/workspace/` is a writable area for saving intermediate results');
            lines.push('- Use `echo "content" > /workspace/notes.md` to save files');
            lines.push('- Workspace is session-scoped and size-limited');
        }
        lines.push('');
    }

    if (collectTools.length > 0) {
        lines.push('### Data Collection');
        for (const name of collectTools) lines.push(`- **${name}**: Submit structured data`);
        lines.push('');
    }

    lines.push('## When to Use Search vs Explore');
    lines.push('');
    lines.push('| Need | Tool |');
    lines.push('|------|------|');
    lines.push('| Conceptual question ("how does X work?") | search |');
    lines.push('| Find exact code or config | explore (grep) |');
    lines.push('| Browse directory structure | explore (find, ls) |');
    lines.push('| Read a specific file | explore (cat) |');
    if (hasQmd) lines.push('| Semantic code search | explore (qmd) |');
    lines.push('');

    lines.push('## Sources');
    lines.push('');
    for (const s of sources) lines.push(`- ${s}`);
    lines.push('');

    lines.push('## Limitations');
    lines.push('');
    lines.push('- Filesystem is read-only (except /workspace/)');
    lines.push('- File content is from the last index update, not real-time');
    lines.push('- Pipes in bash commands are limited to basic patterns');

    return lines.join('\n');
}
