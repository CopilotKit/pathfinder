// Document chunker — page-break and section-aware chunking for PDF/DOCX text.

import { type ChunkOutput, type SourceConfig } from "../../types.js";

const DEFAULT_TARGET_TOKENS = 600;
const DEFAULT_OVERLAP_TOKENS = 50;

/** Pattern for ALL CAPS section headers (at least 3 uppercase letters, standalone line). */
const ALL_CAPS_HEADER_RE = /^[A-Z][A-Z\s]{2,}[A-Z]$/;

/** Pattern for numbered section headers: "1.", "1.2", "1.2.3", "Section 1:", etc. */
const NUMBERED_HEADER_RE = /^(?:\d+\.(?:\d+\.)*\s+\S|Section\s+\d)/i;

/**
 * Detect if a line is a section header.
 * Returns the header text if detected, null otherwise.
 */
function detectSectionHeader(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 100) return null;

  if (ALL_CAPS_HEADER_RE.test(trimmed)) return trimmed;
  if (NUMBERED_HEADER_RE.test(trimmed)) return trimmed;

  return null;
}

/**
 * Represents a logical section of a document.
 */
interface DocumentSection {
  title: string | null;
  content: string;
  pageNumber: number | null;
}

/**
 * Split extracted document text into logical sections using:
 * 1. Form feed characters (\f) as page boundaries
 * 2. ALL CAPS or numbered section headers as section boundaries
 * 3. Double newlines as paragraph boundaries (fallback)
 */
function splitIntoSections(content: string): DocumentSection[] {
  // Split on form feeds first to get pages
  const pages = content.split("\f");
  const hasPageBreaks = pages.length > 1;

  const sections: DocumentSection[] = [];

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const pageText = pages[pageIdx].trim();
    if (!pageText) continue;

    const pageNumber = hasPageBreaks ? pageIdx + 1 : null;
    const lines = pageText.split("\n");

    let currentTitle: string | null = null;
    let currentLines: string[] = [];

    function flush() {
      const text = currentLines.join("\n").trim();
      if (text) {
        sections.push({
          title: currentTitle,
          content: text,
          pageNumber,
        });
      }
      currentLines = [];
    }

    for (const line of lines) {
      const header = detectSectionHeader(line);
      if (header) {
        flush();
        currentTitle = header;
        continue;
      }
      currentLines.push(line);
    }

    flush();
  }

  return sections;
}

/**
 * Chunk document text into embedding-friendly chunks.
 * Follows the ChunkerFn signature: (content, filePath, config) => ChunkOutput[]
 *
 * Splitting priority:
 * 1. Page breaks (form feed \f) — natural boundaries from PDF extraction
 * 2. Section headers (ALL CAPS, numbered sections) — structural boundaries
 * 3. Paragraph breaks (double newline) — text-level boundaries
 * 4. Token-count splitting — fallback for long unstructured blocks
 */
export function chunkDocument(
  content: string,
  _filePath: string,
  config: SourceConfig,
): ChunkOutput[] {
  if (!content || !content.trim()) {
    return [];
  }

  const targetChars =
    (config.chunk?.target_tokens ?? DEFAULT_TARGET_TOKENS) * 4;
  const overlapChars =
    (config.chunk?.overlap_tokens ?? DEFAULT_OVERLAP_TOKENS) * 4;

  const sections = splitIntoSections(content);

  if (sections.length === 0) {
    return [];
  }

  // Merge small consecutive sections until target size is reached
  const merged: {
    content: string;
    title: string | null;
    pageNumber: number | null;
  }[] = [];
  let current = "";
  let currentTitle: string | null = sections[0].title;
  let currentPage: number | null = sections[0].pageNumber;

  for (const section of sections) {
    const text = section.content;
    const separator = current ? "\n\n" : "";

    // Start new chunk when:
    // - Adding this section would exceed target
    // - This section has its own title (preserve section boundaries)
    const sizeExceeded =
      current && current.length + separator.length + text.length > targetChars;
    const hasNewTitle = section.title !== null && current.length > 0;

    if (sizeExceeded || hasNewTitle) {
      if (current.trim()) {
        merged.push({
          content: current,
          title: currentTitle,
          pageNumber: currentPage,
        });
      }
      current = text;
      currentTitle = section.title ?? currentTitle;
      currentPage = section.pageNumber;
    } else {
      if (!current) {
        currentTitle = section.title;
        currentPage = section.pageNumber;
      }
      current = current ? current + separator + text : text;
    }
  }
  if (current.trim()) {
    merged.push({
      content: current,
      title: currentTitle,
      pageNumber: currentPage,
    });
  }

  // Split any oversized chunks on paragraph boundaries
  const sized: {
    content: string;
    title: string | null;
    pageNumber: number | null;
  }[] = [];
  for (const chunk of merged) {
    if (chunk.content.length <= targetChars) {
      sized.push(chunk);
      continue;
    }

    const paragraphs = chunk.content
      .split(/\n\n+/)
      .filter((p) => p.trim().length > 0);
    let buf = "";
    for (const para of paragraphs) {
      const sep = buf ? "\n\n" : "";
      if (buf && buf.length + sep.length + para.length > targetChars) {
        sized.push({
          content: buf,
          title: chunk.title,
          pageNumber: chunk.pageNumber,
        });
        buf = para;
      } else {
        buf = buf ? buf + sep + para : para;
      }
    }
    if (buf.trim()) {
      sized.push({
        content: buf,
        title: chunk.title,
        pageNumber: chunk.pageNumber,
      });
    }
  }

  // Split any remaining oversized chunks on word boundaries (fallback for
  // single long paragraphs with no \n\n breaks)
  const final: typeof sized = [];
  for (const chunk of sized) {
    if (chunk.content.length <= targetChars) {
      final.push(chunk);
      continue;
    }
    // Split on word boundaries
    const words = chunk.content.split(/\s+/);
    let buf = "";
    for (const word of words) {
      const sep = buf ? " " : "";
      if (buf && buf.length + sep.length + word.length > targetChars) {
        final.push({
          content: buf,
          title: chunk.title,
          pageNumber: chunk.pageNumber,
        });
        buf = word;
      } else {
        buf = buf ? buf + sep + word : word;
      }
    }
    if (buf.trim()) {
      final.push({
        content: buf,
        title: chunk.title,
        pageNumber: chunk.pageNumber,
      });
    }
  }

  // Apply overlap
  const chunks: ChunkOutput[] = [];
  for (let i = 0; i < final.length; i++) {
    let chunkContent = final[i].content;

    if (i > 0 && overlapChars > 0) {
      const prevContent = final[i - 1].content;
      const overlapText = prevContent.slice(-overlapChars);
      const breakPoint = overlapText.lastIndexOf("\n");
      const cleanOverlap =
        breakPoint > 0 ? overlapText.slice(breakPoint) : overlapText;
      chunkContent = cleanOverlap + "\n\n" + chunkContent;
    }

    // Strip form feeds from final output
    chunkContent = chunkContent
      .replace(/\f/g, "\n\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    chunks.push({
      content: chunkContent,
      title: final[i].title ?? undefined,
      chunkIndex: i,
      startLine: final[i].pageNumber ?? undefined,
      endLine: final[i].pageNumber ?? undefined,
    });
  }

  return chunks;
}
