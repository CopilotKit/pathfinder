import type { FaqChunkResult } from "./types.js";

interface FaqSource {
  name: string;
  confidenceThreshold: number;
}

/**
 * Generate the /faq.txt content from FAQ chunks.
 * Groups Q&A pairs by source, with source headings.
 */
export function generateFaqTxt(
  chunks: FaqChunkResult[],
  serverName: string,
  faqSources: FaqSource[],
): string {
  const lines: string[] = [`# ${serverName} — Frequently Asked Questions`, ""];

  // Group chunks by source_name
  const bySource = new Map<string, FaqChunkResult[]>();
  for (const chunk of chunks) {
    if (!bySource.has(chunk.source_name)) bySource.set(chunk.source_name, []);
    bySource.get(chunk.source_name)!.push(chunk);
  }

  // Emit each source section in the order of faqSources config
  let hasContent = false;
  for (const source of faqSources) {
    const sourceChunks = bySource.get(source.name);
    if (!sourceChunks || sourceChunks.length === 0) continue;

    hasContent = true;
    lines.push(`## ${source.name}`, "");

    for (const chunk of sourceChunks) {
      // Content is stored as "Q: ...\n\nA: ..."
      lines.push(chunk.content);
      lines.push("");
    }
  }

  if (!hasContent) {
    lines.push("No FAQ content available yet.");
    lines.push("");
  }

  return lines.join("\n");
}
