// Content extractors — convert binary document formats to plain text.
// PDF and DOCX libraries are optional peer dependencies, loaded dynamically.

import fs from "node:fs";
import path from "node:path";

/**
 * Extract text content from a file. For non-document source types, reads
 * the file as UTF-8. For document types, delegates to format-specific
 * extractors based on file extension.
 */
export interface ExtractionResult {
  content: string;
  metadata?: Record<string, unknown>;
}

export async function extractContent(
  filePath: string,
  sourceType: string,
): Promise<ExtractionResult> {
  if (sourceType !== "document") {
    const content = await fs.promises.readFile(filePath, "utf-8");
    return { content };
  }

  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".pdf":
      return extractPdf(filePath);
    case ".docx":
      return extractDocx(filePath);
    default: {
      const content = await fs.promises.readFile(filePath, "utf-8");
      return { content };
    }
  }
}

/**
 * Extract text and metadata from a PDF file using pdf-parse.
 * Warns if the PDF produces very little text (likely a scanned document).
 */
async function extractPdf(filePath: string): Promise<ExtractionResult> {
  let pdfParse: (
    buffer: Buffer,
  ) => Promise<{
    text: string;
    numpages: number;
    info: Record<string, unknown>;
  }>;

  try {
    const mod = await import("pdf-parse");
    pdfParse = mod.default;
  } catch {
    throw new Error(
      `Cannot extract PDF: install pdf-parse to index PDF files.\n` +
        `  npm install pdf-parse\n` +
        `  # or: pnpm add pdf-parse`,
    );
  }

  const buffer = await fs.promises.readFile(filePath);
  const result = await pdfParse(buffer);

  // Warn about likely scanned PDFs (very little text for multi-page docs)
  if (result.numpages >= 1 && result.text.trim().length < 50) {
    console.warn(
      `[content-extractor] ${filePath}: PDF has ${result.numpages} pages but produced very little text ` +
        `(${result.text.trim().length} chars). This may be a scanned document without a text layer.`,
    );
  }

  // Extract metadata from PDF info dict
  const metadata: Record<string, unknown> = {};
  if (result.info?.Title) metadata.title = result.info.Title;
  if (result.info?.Author) metadata.author = result.info.Author;
  if (result.info?.CreationDate)
    metadata.creationDate = result.info.CreationDate;
  if (result.numpages) metadata.pageCount = result.numpages;

  return {
    content: result.text,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

/**
 * Extract text from a DOCX file using mammoth.
 */
async function extractDocx(filePath: string): Promise<ExtractionResult> {
  let mammoth: {
    extractRawText: (options: {
      path: string;
    }) => Promise<{ value: string; messages: unknown[] }>;
  };

  try {
    const mod = await import("mammoth");
    mammoth = mod.default;
  } catch {
    throw new Error(
      `Cannot extract DOCX: install mammoth to index DOCX files.\n` +
        `  npm install mammoth\n` +
        `  # or: pnpm add mammoth`,
    );
  }

  const result = await mammoth.extractRawText({ path: filePath });

  if (result.messages && result.messages.length > 0) {
    console.warn(
      `[content-extractor] ${filePath}: mammoth reported ${result.messages.length} warning(s):`,
      result.messages,
    );
  }

  return { content: result.value };
}
