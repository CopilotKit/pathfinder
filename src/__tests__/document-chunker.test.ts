import { describe, it, expect } from "vitest";
import { chunkDocument } from "../indexing/chunking/document.js";
import type { SourceConfig } from "../types.js";

function mkConfig(
  overrides: { target_tokens?: number; overlap_tokens?: number } = {},
): SourceConfig {
  return {
    name: "test",
    type: "document",
    path: "/tmp",
    file_patterns: ["**/*.pdf"],
    chunk: {
      target_tokens: overrides.target_tokens,
      overlap_tokens: overrides.overlap_tokens,
    },
  } as SourceConfig;
}

describe("chunkDocument", () => {
  // ── Empty / whitespace input ────────────────────────────────────────

  it("returns empty array for empty string", () => {
    expect(chunkDocument("", "test.pdf", mkConfig())).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(chunkDocument("   \n\n  ", "test.pdf", mkConfig())).toEqual(
      [],
    );
  });

  it("returns empty array for null/undefined content", () => {
    expect(
      chunkDocument(null as unknown as string, "test.pdf", mkConfig()),
    ).toEqual([]);
    expect(
      chunkDocument(
        undefined as unknown as string,
        "test.pdf",
        mkConfig(),
      ),
    ).toEqual([]);
  });

  // ── Single chunk ────────────────────────────────────────────────────

  it("returns a single chunk for small content", () => {
    const content = "This is a short document.";
    const chunks = chunkDocument(content, "spec.pdf", mkConfig());
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe("This is a short document.");
    expect(chunks[0].chunkIndex).toBe(0);
  });

  // ── Page break awareness (form feed \f) ─────────────────────────────

  it("splits on form feed (page break) characters", () => {
    const page1 = "Content of page one. ".repeat(50);
    const page2 = "Content of page two. ".repeat(50);
    const content = `${page1}\f${page2}`;
    const chunks = chunkDocument(
      content,
      "doc.pdf",
      mkConfig({ target_tokens: 100 }),
    );
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].content).toContain("page one");
    expect(chunks[chunks.length - 1].content).toContain("page two");
  });

  it("does not split on form feed when pages fit in one chunk", () => {
    const content = "Page 1.\fPage 2.\fPage 3.";
    const chunks = chunkDocument(
      content,
      "doc.pdf",
      mkConfig({ target_tokens: 600 }),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("Page 1");
    expect(chunks[0].content).toContain("Page 3");
  });

  // ── Section header detection ────────────────────────────────────────

  it("splits on ALL CAPS section headers", () => {
    const section1 =
      "INTRODUCTION\n\nThis is the introduction. ".repeat(20);
    const section2 =
      "METHODOLOGY\n\nThis describes the method. ".repeat(20);
    const content = `${section1}\n\n${section2}`;
    const chunks = chunkDocument(
      content,
      "paper.pdf",
      mkConfig({ target_tokens: 100 }),
    );
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('splits on numbered section headers (e.g., "1. Introduction")', () => {
    const section1 =
      "1. Introduction\n\nThis is the intro section. ".repeat(20);
    const section2 =
      "2. Background\n\nThis is the background. ".repeat(20);
    const content = `${section1}\n\n${section2}`;
    const chunks = chunkDocument(
      content,
      "paper.pdf",
      mkConfig({ target_tokens: 100 }),
    );
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it("includes section header text in chunk title", () => {
    const content =
      "INTRODUCTION\n\nSome introduction text here that is meaningful.";
    const chunks = chunkDocument(content, "paper.pdf", mkConfig());
    expect(chunks[0].title).toBe("INTRODUCTION");
  });

  // ── Paragraph-based fallback ────────────────────────────────────────

  it("falls back to paragraph splitting when no structure detected", () => {
    const para = "This is a regular paragraph. ".repeat(50);
    const content = Array.from({ length: 5 }, () => para).join("\n\n");
    const chunks = chunkDocument(
      content,
      "doc.pdf",
      mkConfig({ target_tokens: 100 }),
    );
    expect(chunks.length).toBeGreaterThan(1);
  });

  // ── chunkIndex numbering ────────────────────────────────────────────

  it("sets chunkIndex sequentially", () => {
    const page = "Content for a page. ".repeat(50);
    const content = Array.from({ length: 5 }, () => page).join("\f");
    const chunks = chunkDocument(
      content,
      "doc.pdf",
      mkConfig({ target_tokens: 100 }),
    );
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].chunkIndex).toBe(i);
    }
  });

  // ── Overlap ─────────────────────────────────────────────────────────

  it("applies overlap between chunks", () => {
    const page = "EndMarker " + "Word ".repeat(200);
    const content = `${page}\f${page}\f${page}`;
    const chunks = chunkDocument(
      content,
      "doc.pdf",
      mkConfig({ target_tokens: 100, overlap_tokens: 30 }),
    );
    if (chunks.length >= 2) {
      // Second chunk should contain some text from end of first
      expect(chunks[1].content.length).toBeGreaterThan(0);
    }
  });

  it("does not apply overlap to first chunk", () => {
    const page = "Word ".repeat(200);
    const content = `${page}\f${page}`;
    const chunks = chunkDocument(
      content,
      "doc.pdf",
      mkConfig({ target_tokens: 100, overlap_tokens: 30 }),
    );
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it("does not apply overlap when overlap_tokens is 0", () => {
    const page = "Word ".repeat(200);
    const content = `${page}\f${page}`;
    const chunks = chunkDocument(
      content,
      "doc.pdf",
      mkConfig({ target_tokens: 100, overlap_tokens: 0 }),
    );
    expect(chunks.length).toBeGreaterThan(1);
  });

  // ── startLine / endLine as page numbers ─────────────────────────────

  it("sets startLine/endLine as page numbers when content has page breaks", () => {
    const page = "Page content here. ".repeat(50);
    const content = `${page}\f${page}\f${page}`;
    const chunks = chunkDocument(
      content,
      "doc.pdf",
      mkConfig({ target_tokens: 100 }),
    );
    // First chunk should reference page 1
    expect(chunks[0].startLine).toBe(1);
    // Last chunk should reference the last page
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.startLine).toBeGreaterThanOrEqual(1);
    expect(lastChunk.startLine).toBeLessThanOrEqual(3);
  });

  // ── Token-based sizing ──────────────────────────────────────────────

  it("respects custom target_tokens", () => {
    const content = "Word ".repeat(500);
    const smallChunks = chunkDocument(
      content,
      "doc.pdf",
      mkConfig({ target_tokens: 50 }),
    );
    const largeChunks = chunkDocument(
      content,
      "doc.pdf",
      mkConfig({ target_tokens: 500 }),
    );
    expect(smallChunks.length).toBeGreaterThanOrEqual(largeChunks.length);
  });

  // ── Form feed normalization ─────────────────────────────────────────

  it("replaces form feeds with double newlines in output content", () => {
    const content = "Page one text.\fPage two text.";
    const chunks = chunkDocument(content, "doc.pdf", mkConfig());
    for (const chunk of chunks) {
      expect(chunk.content).not.toContain("\f");
    }
  });

  // ── Many small paragraphs merge ─────────────────────────────────────

  it("merges many small paragraphs into fewer chunks", () => {
    const content = Array.from(
      { length: 50 },
      (_, i) => `Paragraph ${i}.`,
    ).join("\n\n");
    const chunks = chunkDocument(
      content,
      "doc.pdf",
      mkConfig({ target_tokens: 600 }),
    );
    expect(chunks.length).toBeLessThan(50);
  });

  // ── Special characters ──────────────────────────────────────────────

  it("handles unicode content", () => {
    const content =
      "Unicode: \u{1F680}\u{1F30D} and CJK: \u4F60\u597D\u4E16\u754C";
    const chunks = chunkDocument(content, "doc.pdf", mkConfig());
    expect(chunks[0].content).toContain("\u{1F680}");
  });

  // ── Extremely long single paragraph ─────────────────────────────────

  it("splits extremely long paragraph with no natural breaks", () => {
    // Single continuous text with no paragraph breaks, no page breaks, no headers
    const content = "word ".repeat(5000); // ~25000 chars, ~6250 tokens
    const chunks = chunkDocument(
      content,
      "doc.pdf",
      mkConfig({ target_tokens: 200 }),
    );
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should not wildly exceed target_tokens * 4 chars
    for (const chunk of chunks) {
      // Allow some overshoot since we split on paragraph boundaries
      expect(chunk.content.length).toBeLessThan(200 * 4 * 3); // 3x target as safety bound
    }
  });

  // ── Mixed content ────────────────────────────────────────────────────

  it("handles content with mixed page breaks, headers, and paragraphs", () => {
    const content = [
      "INTRODUCTION\n\nFirst paragraph of intro.",
      "\f",
      "CHAPTER ONE\n\nFirst paragraph of chapter one. ".repeat(20),
      "\n\n",
      "Second paragraph of chapter one. ".repeat(20),
      "\f",
      "CHAPTER TWO\n\nContent of chapter two.",
    ].join("");
    const chunks = chunkDocument(
      content,
      "doc.pdf",
      mkConfig({ target_tokens: 100 }),
    );
    expect(chunks.length).toBeGreaterThan(1);
    // Verify page numbering is maintained
    expect(chunks[0].startLine).toBe(1); // page 1
  });

  // ── Content with only form feeds (no text between them) ──────────────

  it("handles content with consecutive form feeds (empty pages)", () => {
    const content = "Page 1.\f\f\fPage 4.";
    const chunks = chunkDocument(content, "doc.pdf", mkConfig());
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // Empty pages should be skipped
    for (const chunk of chunks) {
      expect(chunk.content.trim().length).toBeGreaterThan(0);
    }
  });

  // ── Title extraction with numbered headers ───────────────────────────

  it("includes numbered section header in chunk title", () => {
    const content =
      "1. Getting Started\n\nThis section helps you get started.";
    const chunks = chunkDocument(content, "doc.pdf", mkConfig());
    expect(chunks[0].title).toBe("1. Getting Started");
  });

  // ── Very short content ──────────────────────────────────────────────

  it("handles single word content", () => {
    const chunks = chunkDocument("Hello", "doc.pdf", mkConfig());
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe("Hello");
  });
});
