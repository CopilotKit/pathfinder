interface ChunkForLlms {
  source_name: string;
  file_path: string;
  title: string | null;
  content: string;
  chunk_index: number;
}

export function generateLlmsTxt(
  chunks: ChunkForLlms[],
  serverName: string,
): string {
  const lines: string[] = [
    `# ${serverName}`,
    "",
    "> Documentation index for AI agents",
    "",
  ];

  // Group by source, deduplicate by file_path, use first chunk's title
  const bySource = new Map<string, Map<string, string>>();
  for (const c of chunks) {
    if (!bySource.has(c.source_name)) bySource.set(c.source_name, new Map());
    const files = bySource.get(c.source_name)!;
    if (!files.has(c.file_path)) {
      files.set(c.file_path, c.title || c.file_path);
    }
  }

  for (const [source, files] of bySource) {
    lines.push(`## ${source}`, "");
    for (const [filePath, title] of files) {
      lines.push(`- ${filePath} — ${title}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function generateLlmsFullTxt(chunks: ChunkForLlms[]): string {
  // Group chunks by file_path, sort by chunk_index, join content
  const byFile = new Map<string, ChunkForLlms[]>();
  for (const c of chunks) {
    if (!byFile.has(c.file_path)) byFile.set(c.file_path, []);
    byFile.get(c.file_path)!.push(c);
  }

  const sections: string[] = [];
  for (const [filePath, fileChunks] of byFile) {
    fileChunks.sort((a, b) => a.chunk_index - b.chunk_index);
    const content = fileChunks.map((c) => c.content).join("\n");
    sections.push(`---\nfile: ${filePath}\n---\n\n${content}`);
  }

  return sections.join("\n\n");
}
