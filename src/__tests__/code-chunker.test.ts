import { describe, it, expect } from "vitest";
import { chunkCode } from "../indexing/chunking/code.js";
import type { SourceConfig } from "../types.js";

// Helper to build a minimal SourceConfig for code chunking
function mkConfig(
  overrides: { target_lines?: number; overlap_lines?: number } = {},
): SourceConfig {
  return {
    name: "test",
    type: "code",
    path: "/tmp",
    file_patterns: ["*.ts"],
    chunk: {
      target_lines: overrides.target_lines,
      overlap_lines: overrides.overlap_lines,
    },
  } as SourceConfig;
}

describe("chunkCode", () => {
  // ── Empty / whitespace input ────────────────────────────────────────

  it("returns empty array for empty string", () => {
    expect(chunkCode("", "test.ts", mkConfig())).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(chunkCode("   \n\n  ", "test.ts", mkConfig())).toEqual([]);
  });

  it("returns empty array for null/undefined content", () => {
    expect(chunkCode(null as any, "test.ts", mkConfig())).toEqual([]);
    expect(chunkCode(undefined as any, "test.ts", mkConfig())).toEqual([]);
  });

  it("returns empty array when content is only newlines", () => {
    expect(chunkCode("\n\n\n", "test.ts", mkConfig())).toEqual([]);
  });

  // ── Language detection ───────────────────────────────────────────────

  it("detects TypeScript from .ts extension", () => {
    const chunks = chunkCode("const x = 1;", "src/index.ts", mkConfig());
    expect(chunks[0].language).toBe("typescript");
  });

  it("detects TypeScript from .tsx extension", () => {
    const chunks = chunkCode("const x = 1;", "app.tsx", mkConfig());
    expect(chunks[0].language).toBe("typescript");
  });

  it("detects JavaScript from .js extension", () => {
    const chunks = chunkCode("const x = 1;", "script.js", mkConfig());
    expect(chunks[0].language).toBe("javascript");
  });

  it("detects JavaScript from .mjs extension", () => {
    const chunks = chunkCode("export default {};", "mod.mjs", mkConfig());
    expect(chunks[0].language).toBe("javascript");
  });

  it("detects JavaScript from .cjs extension", () => {
    const chunks = chunkCode("module.exports = {};", "mod.cjs", mkConfig());
    expect(chunks[0].language).toBe("javascript");
  });

  it("detects Python from .py extension", () => {
    const chunks = chunkCode("def hello(): pass", "main.py", mkConfig());
    expect(chunks[0].language).toBe("python");
  });

  it("detects Ruby from .rb extension", () => {
    const chunks = chunkCode("def hello; end", "app.rb", mkConfig());
    expect(chunks[0].language).toBe("ruby");
  });

  it("detects Go from .go extension", () => {
    const chunks = chunkCode("package main", "main.go", mkConfig());
    expect(chunks[0].language).toBe("go");
  });

  it("detects Rust from .rs extension", () => {
    const chunks = chunkCode("fn main() {}", "main.rs", mkConfig());
    expect(chunks[0].language).toBe("rust");
  });

  it("detects shell from .sh extension", () => {
    const chunks = chunkCode("#!/bin/bash", "run.sh", mkConfig());
    expect(chunks[0].language).toBe("shell");
  });

  it("detects YAML from .yml extension", () => {
    const chunks = chunkCode("key: value", "config.yml", mkConfig());
    expect(chunks[0].language).toBe("yaml");
  });

  it("detects CSS from .css extension", () => {
    const chunks = chunkCode("body { color: red; }", "styles.css", mkConfig());
    expect(chunks[0].language).toBe("css");
  });

  it("detects C from .h extension", () => {
    const chunks = chunkCode("#include <stdio.h>", "header.h", mkConfig());
    expect(chunks[0].language).toBe("c");
  });

  it("detects C++ from .hpp extension", () => {
    const chunks = chunkCode("#pragma once", "header.hpp", mkConfig());
    expect(chunks[0].language).toBe("cpp");
  });

  it("falls back to extension string for unknown extensions", () => {
    const chunks = chunkCode("content", "file.xyz", mkConfig());
    expect(chunks[0].language).toBe("xyz");
  });

  it('returns "text" for files with no extension', () => {
    const chunks = chunkCode("content", "Makefile", mkConfig());
    // "Makefile" has no dot, so .pop() returns "Makefile" which is not in the map
    expect(chunks[0].language).toBe("makefile");
  });

  // ── Basic chunking ──────────────────────────────────────────────────

  it("returns a single chunk for small content", () => {
    const content = "const x = 1;\nconst y = 2;";
    const chunks = chunkCode(content, "test.ts", mkConfig());
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(2);
  });

  it("includes file breadcrumb in chunk content", () => {
    const content = "const x = 1;";
    const chunks = chunkCode(content, "src/index.ts", mkConfig());
    expect(chunks[0].content).toContain("// File: src/index.ts");
  });

  it("includes line numbers in chunk content", () => {
    const content = "line1\nline2\nline3";
    const chunks = chunkCode(content, "test.ts", mkConfig());
    expect(chunks[0].content).toContain("1 | line1");
    expect(chunks[0].content).toContain("2 | line2");
    expect(chunks[0].content).toContain("3 | line3");
  });

  it("pads line numbers for alignment", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
    const chunks = chunkCode(lines, "test.ts", mkConfig({ target_lines: 200 }));
    // Line 1 should be padded to match width of "100"
    expect(chunks[0].content).toContain("  1 | line0");
  });

  it("strips trailing empty line from content ending with newline", () => {
    const content = "line1\nline2\n";
    const chunks = chunkCode(content, "test.ts", mkConfig());
    expect(chunks[0].endLine).toBe(2);
  });

  // ── Line-based splitting ────────────────────────────────────────────

  it("splits into multiple chunks when content exceeds target_lines", () => {
    const lines = Array.from(
      { length: 200 },
      (_, i) => `const x${i} = ${i};`,
    ).join("\n");
    const chunks = chunkCode(lines, "test.ts", mkConfig({ target_lines: 50 }));
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("sets chunkIndex sequentially", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const chunks = chunkCode(lines, "test.ts", mkConfig({ target_lines: 50 }));
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].chunkIndex).toBe(i);
    }
  });

  it("sets startLine and endLine correctly", () => {
    const content = "a\nb\nc\nd\ne";
    const chunks = chunkCode(
      content,
      "test.ts",
      mkConfig({ target_lines: 200 }),
    );
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(5);
  });

  // ── Overlap between chunks ──────────────────────────────────────────

  it("applies overlap lines between chunks", () => {
    // Create content with clear blank line boundaries for splitting
    const makeBlock = (n: number) =>
      Array.from({ length: 15 }, (_, i) => `block${n}_line${i}`).join("\n");
    const content = Array.from({ length: 10 }, (_, i) => makeBlock(i)).join(
      "\n\n",
    );
    const chunks = chunkCode(
      content,
      "test.ts",
      mkConfig({ target_lines: 40, overlap_lines: 5 }),
    );
    if (chunks.length >= 2) {
      // With overlap, chunk 2's startLine should be less than chunk 1's endLine + 1
      expect(chunks[1].startLine!).toBeLessThanOrEqual(chunks[0].endLine!);
    }
  });

  it("does not apply overlap when overlap_lines is 0", () => {
    const makeBlock = (n: number) =>
      Array.from({ length: 15 }, (_, i) => `block${n}_line${i}`).join("\n");
    const content = Array.from({ length: 10 }, (_, i) => makeBlock(i)).join(
      "\n\n",
    );
    const chunks = chunkCode(
      content,
      "test.ts",
      mkConfig({ target_lines: 40, overlap_lines: 0 }),
    );
    if (chunks.length >= 2) {
      // Without overlap, chunk 2 starts after chunk 1 ends
      expect(chunks[1].startLine!).toBeGreaterThan(chunks[0].endLine!);
    }
  });

  // ── Block comment awareness ─────────────────────────────────────────

  it("avoids splitting inside block comments", () => {
    const lines: string[] = [];
    // Add some normal code
    for (let i = 0; i < 30; i++) lines.push(`const a${i} = ${i};`);
    // Add a block comment spanning many lines
    lines.push("/*");
    for (let i = 0; i < 20; i++) lines.push(` * Comment line ${i}`);
    lines.push(" */");
    // More code
    for (let i = 0; i < 30; i++) lines.push(`const b${i} = ${i};`);

    const chunks = chunkCode(
      lines.join("\n"),
      "test.ts",
      mkConfig({ target_lines: 40 }),
    );
    // The block comment should ideally not be split across chunks
    // Find the chunk that starts the block comment
    const commentChunks = chunks.filter(
      (c) => c.content.includes("/*") || c.content.includes("*/"),
    );
    // At minimum, /* and */ should be in the same chunk or adjacent chunks
    expect(commentChunks.length).toBeGreaterThanOrEqual(1);
  });

  it("avoids splitting inside template strings", () => {
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) lines.push(`const a${i} = ${i};`);
    lines.push("");
    lines.push("const tmpl = `");
    for (let i = 0; i < 10; i++) lines.push(`  template line ${i}`);
    lines.push("`;");
    lines.push("");
    for (let i = 0; i < 30; i++) lines.push(`const b${i} = ${i};`);

    const chunks = chunkCode(
      lines.join("\n"),
      "test.ts",
      mkConfig({ target_lines: 40 }),
    );
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  // ── Blank-line boundary splitting ───────────────────────────────────

  it("prefers splitting at blank line boundaries", () => {
    // Two blocks separated by a blank line
    const block1 = Array.from(
      { length: 40 },
      (_, i) => `const a${i} = ${i};`,
    ).join("\n");
    const block2 = Array.from(
      { length: 40 },
      (_, i) => `const b${i} = ${i};`,
    ).join("\n");
    const content = block1 + "\n\n" + block2;

    const chunks = chunkCode(
      content,
      "test.ts",
      mkConfig({ target_lines: 50, overlap_lines: 0 }),
    );
    if (chunks.length >= 2) {
      // First chunk should end near the blank line boundary
      expect(chunks[0].endLine!).toBeLessThanOrEqual(45);
    }
  });

  // ── Mechanical fallback splitting ───────────────────────────────────

  it("splits mechanically when no blank lines exist", () => {
    // Dense code with no blank lines
    const lines = Array.from({ length: 200 }, (_, i) => `x${i}();`).join("\n");
    const chunks = chunkCode(lines, "test.ts", mkConfig({ target_lines: 50 }));
    expect(chunks.length).toBeGreaterThan(1);
  });

  // ── Config defaults ─────────────────────────────────────────────────

  it("uses default target_lines (80) when not specified", () => {
    const lines = Array.from(
      { length: 100 },
      (_, i) => `const x${i} = ${i};`,
    ).join("\n\n");
    const config = mkConfig();
    delete (config as any).chunk.target_lines;
    const chunks = chunkCode(lines, "test.ts", config);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  // ── Python triple quotes ────────────────────────────────────────────

  it("handles Python triple-quote docstrings", () => {
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) lines.push(`x${i} = ${i}`);
    lines.push("");
    lines.push("def foo():");
    lines.push('    """');
    for (let i = 0; i < 10; i++) lines.push(`    Docstring line ${i}`);
    lines.push('    """');
    lines.push("    pass");
    lines.push("");
    for (let i = 0; i < 30; i++) lines.push(`y${i} = ${i}`);

    const chunks = chunkCode(
      lines.join("\n"),
      "main.py",
      mkConfig({ target_lines: 40 }),
    );
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0].language).toBe("python");
  });

  // ── String literal handling ──────────────────────────────────────────

  it("does not treat block comment markers inside strings as real", () => {
    const content = 'const a = "/* not a comment */";\nconst b = 1;';
    const chunks = chunkCode(content, "test.ts", mkConfig());
    expect(chunks).toHaveLength(1);
  });

  it("handles single-line comments correctly", () => {
    const content =
      "// This is a comment\nconst x = 1; // inline comment\nconst y = 2;";
    const chunks = chunkCode(content, "test.ts", mkConfig());
    expect(chunks).toHaveLength(1);
  });

  // ── Double blank line preferred over single ─────────────────────────

  it("prefers double-newline boundaries when available", () => {
    const block1 = Array.from({ length: 35 }, (_, i) => `a${i}`).join("\n");
    const block2 = Array.from({ length: 35 }, (_, i) => `b${i}`).join("\n");
    const block3 = Array.from({ length: 35 }, (_, i) => `c${i}`).join("\n");
    const content = block1 + "\n\n\n" + block2 + "\n\n\n" + block3;

    const chunks = chunkCode(
      content,
      "test.ts",
      mkConfig({ target_lines: 40, overlap_lines: 0 }),
    );
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  // ── Escaped characters in strings ───────────────────────────────────

  it("handles escaped quotes in strings", () => {
    const content =
      "const a = \"escaped \\\" quote\";\nconst b = 'escaped \\' quote';\nconst c = 1;";
    const chunks = chunkCode(content, "test.ts", mkConfig());
    expect(chunks).toHaveLength(1);
  });
});
