import { describe, it, expect } from "vitest";
import {
  generateIndexMd,
  generateSearchTipsMd,
} from "../mcp/tools/bash-virtual-files.js";

describe("generateIndexMd", () => {
  it("generates a table of contents from file tree", () => {
    const fileTree: Record<string, string> = {
      "/docs/quickstart.mdx": "# Quickstart",
      "/docs/guides/streaming.mdx": "# Streaming",
      "/docs/guides/auth.mdx": "# Authentication",
      "/code/src/index.ts": "export {}",
    };
    const result = generateIndexMd(fileTree);
    expect(result).toContain("# INDEX");
    expect(result).toContain("quickstart.mdx");
    expect(result).toContain("guides/");
    expect(result).toContain("streaming.mdx");
    expect(result).toContain("auth.mdx");
    expect(result).toContain("index.ts");
  });

  it("returns header with empty file count for empty tree", () => {
    const result = generateIndexMd({});
    expect(result).toContain("# INDEX");
    expect(result).toContain("0 files");
  });

  it("shows file count", () => {
    const fileTree: Record<string, string> = {
      "/a.md": "a",
      "/b.md": "b",
      "/c.md": "c",
    };
    const result = generateIndexMd(fileTree);
    expect(result).toContain("3 files");
  });
});

describe("generateSearchTipsMd", () => {
  it("generates search tips mentioning available tools", () => {
    const result = generateSearchTipsMd(["search-docs", "search-code"]);
    expect(result).toContain("# SEARCH TIPS");
    expect(result).toContain("search-docs");
    expect(result).toContain("search-code");
  });

  it("works with no search tools", () => {
    const result = generateSearchTipsMd([]);
    expect(result).toContain("# SEARCH TIPS");
    expect(result).toContain("grep");
  });
});
