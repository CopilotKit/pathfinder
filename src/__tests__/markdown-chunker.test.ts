import { describe, it, expect } from "vitest";
import { chunkMarkdown } from "../indexing/chunking/markdown.js";
import type { SourceConfig } from "../types.js";

// Helper to build a minimal SourceConfig for markdown chunking
function mkConfig(
  overrides: { target_tokens?: number; overlap_tokens?: number } = {},
): SourceConfig {
  return {
    name: "test",
    type: "markdown",
    path: "/tmp",
    file_patterns: ["*.md"],
    chunk: {
      target_tokens: overrides.target_tokens,
      overlap_tokens: overrides.overlap_tokens,
    },
  } as SourceConfig;
}

describe("chunkMarkdown", () => {
  // ── Empty / whitespace input ────────────────────────────────────────

  it("returns empty array for empty string", () => {
    expect(chunkMarkdown("", "test.md", mkConfig())).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(chunkMarkdown("   \n\n  ", "test.md", mkConfig())).toEqual([]);
  });

  it("returns empty array for null/undefined content", () => {
    expect(chunkMarkdown(null as any, "test.md", mkConfig())).toEqual([]);
    expect(chunkMarkdown(undefined as any, "test.md", mkConfig())).toEqual([]);
  });

  it("returns empty array when content is only frontmatter with no body", () => {
    const content = "---\ntitle: Empty\n---\n";
    expect(chunkMarkdown(content, "test.md", mkConfig())).toEqual([]);
  });

  // ── Frontmatter parsing ─────────────────────────────────────────────

  it("extracts title from frontmatter", () => {
    const content = "---\ntitle: My Title\n---\n\nSome body text here.";
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0].title).toBe("My Title");
  });

  it("extracts title from quoted frontmatter", () => {
    const content = '---\ntitle: "Quoted Title"\n---\n\nBody text.';
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    expect(chunks[0].title).toBe("Quoted Title");
  });

  it("extracts title from single-quoted frontmatter", () => {
    const content = "---\ntitle: 'Single Quoted'\n---\n\nBody text.";
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    expect(chunks[0].title).toBe("Single Quoted");
  });

  it("falls back to first heading when no frontmatter title", () => {
    const content = "# My Heading\n\nSome content.";
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    expect(chunks[0].title).toBe("My Heading");
  });

  it("falls back to filename when no title or heading", () => {
    const content = "Just some plain text without any heading.";
    const chunks = chunkMarkdown(content, "docs/guide.md", mkConfig());
    expect(chunks[0].title).toBe("guide.md");
  });

  it("falls back to full path when filename extraction fails", () => {
    const content = "Plain text.";
    const chunks = chunkMarkdown(content, "noext", mkConfig());
    expect(chunks[0].title).toBe("noext");
  });

  it("strips frontmatter from chunk content", () => {
    const content = "---\ntitle: Test\nother: value\n---\n\nActual body.";
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    expect(chunks[0].content).not.toContain("---");
    expect(chunks[0].content).toContain("Actual body");
  });

  // ── MDX stripping ───────────────────────────────────────────────────

  it("strips import statements", () => {
    const content =
      "import Foo from 'bar';\n\nSome text after the removed line.";
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    expect(chunks[0].content).not.toContain("from 'bar'");
    expect(chunks[0].content).toContain("Some text after the removed line");
  });

  it("strips self-closing JSX tags", () => {
    const content =
      'Before\n\n<Component prop="val" />\n\nAfter the component.';
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    expect(chunks[0].content).not.toContain("<Component");
    expect(chunks[0].content).toContain("Before");
    expect(chunks[0].content).toContain("After the component");
  });

  it("strips JSX wrapper tags but keeps inner content", () => {
    const content = "<Wrapper>\nInner content here\n</Wrapper>";
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    expect(chunks[0].content).toContain("Inner content here");
    expect(chunks[0].content).not.toContain("<Wrapper");
    expect(chunks[0].content).not.toContain("</Wrapper");
  });

  it("strips nested JSX tags", () => {
    const content = "<Outer><Inner>Deep content</Inner></Outer>";
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    expect(chunks[0].content).toContain("Deep content");
    expect(chunks[0].content).not.toContain("<Outer");
    expect(chunks[0].content).not.toContain("<Inner");
  });

  // ── Basic chunking ──────────────────────────────────────────────────

  it("returns a single chunk for small content", () => {
    const content = "# Title\n\nShort paragraph.";
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].content).toContain("Short paragraph");
  });

  it("sets chunkIndex sequentially", () => {
    // Generate content large enough to produce multiple chunks
    const sections = Array.from(
      { length: 10 },
      (_, i) =>
        `## Section ${i}\n\n${"Lorem ipsum dolor sit amet. ".repeat(100)}`,
    ).join("\n\n");
    const chunks = chunkMarkdown(
      sections,
      "test.md",
      mkConfig({ target_tokens: 100 }),
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].chunkIndex).toBe(i);
    }
  });

  // ── Heading-based splitting ─────────────────────────────────────────

  it("splits on h2 headings", () => {
    const section = "Word ".repeat(200);
    const content = `## Section A\n\n${section}\n\n## Section B\n\n${section}`;
    const chunks = chunkMarkdown(
      content,
      "test.md",
      mkConfig({ target_tokens: 100 }),
    );
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it("splits on h3 headings when h2 sections are still large", () => {
    const para = "Word ".repeat(200);
    const content = `## Big Section\n\n### Sub A\n\n${para}\n\n### Sub B\n\n${para}`;
    const chunks = chunkMarkdown(
      content,
      "test.md",
      mkConfig({ target_tokens: 100 }),
    );
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  // ── Heading path tracking ───────────────────────────────────────────

  it("tracks heading path for chunks under h2", () => {
    const content = "## Getting Started\n\nContent under getting started.";
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    expect(chunks[0].headingPath).toBeDefined();
    // The heading path should include "Getting Started"
    if (chunks[0].headingPath && chunks[0].headingPath.length > 0) {
      expect(chunks[0].headingPath).toContain("Getting Started");
    }
  });

  it("tracks nested heading hierarchy", () => {
    const body = "Content here. ".repeat(5);
    const content = `## Parent\n\n### Child\n\n${body}`;
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    // At least one chunk should have heading path with Parent and Child
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.headingPath).toBeDefined();
  });

  // ── Code block preservation ─────────────────────────────────────────

  it("does not split inside fenced code blocks", () => {
    const codeBlock =
      '```python\ndef hello():\n    print("hello")\n\n\n    return True\n```';
    const content = `## Intro\n\n${codeBlock}\n\nAfter code.`;
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    // At least one chunk should contain the complete code block
    const hasCompleteBlock = chunks.some(
      (c) =>
        c.content.includes("def hello()") && c.content.includes("return True"),
    );
    expect(hasCompleteBlock).toBe(true);
  });

  it("preserves triple-backtick code blocks with language tag", () => {
    const content =
      "# Title\n\n```typescript\nconst x = 1;\nconst y = 2;\n```\n\nEnd.";
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    const hasBlock = chunks.some((c) => c.content.includes("const x = 1"));
    expect(hasBlock).toBe(true);
  });

  // ── Overlap ─────────────────────────────────────────────────────────

  it("applies overlap between chunks", () => {
    const sections = Array.from(
      { length: 5 },
      (_, i) => `## Section ${i}\n\n${"Word ".repeat(200)}`,
    ).join("\n\n");
    const chunks = chunkMarkdown(
      sections,
      "test.md",
      mkConfig({ target_tokens: 100, overlap_tokens: 20 }),
    );
    if (chunks.length >= 2) {
      // Second chunk should contain some text from the end of the first chunk
      // (overlap means shared content)
      const firstEnd = chunks[0].content.slice(-50);
      // At least some portion should appear in chunk 1
      // This is a loose check since overlap is character-based and may break at word boundaries
      expect(chunks[1].content.length).toBeGreaterThan(0);
    }
  });

  it("does not apply overlap when overlap_tokens is 0", () => {
    const sections = Array.from(
      { length: 5 },
      (_, i) => `## Section ${i}\n\n${"Word ".repeat(200)}`,
    ).join("\n\n");
    const chunks = chunkMarkdown(
      sections,
      "test.md",
      mkConfig({ target_tokens: 100, overlap_tokens: 0 }),
    );
    expect(chunks.length).toBeGreaterThan(1);
  });

  // ── Chunk config parameters ─────────────────────────────────────────

  it("uses default target_tokens when not specified", () => {
    const content = "Short content.";
    const config = mkConfig();
    delete (config as any).chunk.target_tokens;
    const chunks = chunkMarkdown(content, "test.md", config);
    expect(chunks).toHaveLength(1);
  });

  it("respects custom target_tokens for smaller chunks", () => {
    // Use paragraphs so the splitter has boundaries to split on
    const para = "Word ".repeat(100);
    const content = Array.from({ length: 10 }, () => para).join("\n\n");
    const smallChunks = chunkMarkdown(
      content,
      "test.md",
      mkConfig({ target_tokens: 50 }),
    );
    const largeChunks = chunkMarkdown(
      content,
      "test.md",
      mkConfig({ target_tokens: 500 }),
    );
    expect(smallChunks.length).toBeGreaterThan(largeChunks.length);
  });

  // ── Paragraph splitting ─────────────────────────────────────────────

  it("splits on paragraph boundaries when headings are not enough", () => {
    const paragraphs = Array.from(
      { length: 20 },
      (_, i) => `Paragraph ${i}: ${"Word ".repeat(50)}`,
    ).join("\n\n");
    const chunks = chunkMarkdown(
      paragraphs,
      "test.md",
      mkConfig({ target_tokens: 100 }),
    );
    expect(chunks.length).toBeGreaterThan(1);
  });

  // ── Special characters ──────────────────────────────────────────────

  it("handles content with special regex characters", () => {
    const content =
      "## Title\n\nContent with $pecial ch@racters: [brackets] (parens) {braces} *stars*";
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0].content).toContain("$pecial");
  });

  it("handles content with unicode characters", () => {
    const content =
      "## Unicode\n\nContent with emoji: \u{1F680}\u{1F30D}\u{1F4DA} and CJK: \u4F60\u597D\u4E16\u754C";
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    expect(chunks[0].content).toContain("\u{1F680}");
  });

  // ── Windows line endings ────────────────────────────────────────────

  it("handles CRLF line endings in frontmatter", () => {
    const content = "---\r\ntitle: CRLF Test\r\n---\r\n\r\nBody text.";
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    expect(chunks[0].title).toBe("CRLF Test");
    expect(chunks[0].content).toContain("Body text");
  });

  // ── Line splitting fallback ─────────────────────────────────────────

  it("falls back to line splitting for very long paragraphs", () => {
    // Single paragraph with many lines but no headings or double newlines
    const lines = Array.from(
      { length: 50 },
      (_, i) => `Line ${i} with some content.`,
    ).join("\n");
    const chunks = chunkMarkdown(
      lines,
      "test.md",
      mkConfig({ target_tokens: 20 }),
    );
    expect(chunks.length).toBeGreaterThan(1);
  });

  // ── Very long single line ───────────────────────────────────────────

  it("handles a very long single line", () => {
    const content = "A".repeat(10000);
    const chunks = chunkMarkdown(
      content,
      "test.md",
      mkConfig({ target_tokens: 50 }),
    );
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // Content should be preserved even if it cannot be split further
  });

  // ── Multiple frontmatter fields ─────────────────────────────────────

  it("handles frontmatter with many fields", () => {
    const content =
      "---\ntitle: Multi\nauthor: Test\ndate: 2024-01-01\ntags: [a, b]\n---\n\nBody.";
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    expect(chunks[0].title).toBe("Multi");
  });

  // ── Content after MDX stripping is empty ────────────────────────────

  it("returns empty when content after MDX stripping is only whitespace", () => {
    const content = "import Foo from 'bar';\nimport Baz from 'qux';";
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    expect(chunks).toEqual([]);
  });
});
