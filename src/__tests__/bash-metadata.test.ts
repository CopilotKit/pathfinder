import { describe, it, expect } from "vitest";
import { buildFileMetadata, formatLsLong } from "../mcp/tools/bash-fs.js";

describe("buildFileMetadata", () => {
  it("computes size and line count for each file", () => {
    const files: Record<string, string> = {
      "/docs/a.md": "# Title\nLine 2\nLine 3\n",
      "/docs/b.md": "short",
    };
    const meta = buildFileMetadata(files);
    expect(meta["/docs/a.md"]).toBeDefined();
    expect(meta["/docs/a.md"].size).toBe(
      Buffer.byteLength("# Title\nLine 2\nLine 3\n", "utf-8"),
    );
    expect(meta["/docs/a.md"].lines).toBe(3);
    expect(meta["/docs/b.md"].size).toBe(5);
    expect(meta["/docs/b.md"].lines).toBe(1);
  });

  it("returns empty object for empty files map", () => {
    expect(buildFileMetadata({})).toEqual({});
  });

  it("handles empty string content", () => {
    const meta = buildFileMetadata({ "/empty.md": "" });
    expect(meta["/empty.md"].size).toBe(0);
    expect(meta["/empty.md"].lines).toBe(0);
  });
});

describe("formatLsLong", () => {
  it("formats files with size and line count", () => {
    const meta = {
      "/docs/a.md": { size: 1024, lines: 50 },
      "/docs/b.md": { size: 256, lines: 10 },
    };
    const output = formatLsLong("/docs", ["/docs/a.md", "/docs/b.md"], meta);
    expect(output).toContain("a.md");
    expect(output).toContain("b.md");
    expect(output).toContain("1024");
    expect(output).toContain("50 lines");
  });

  it("includes subdirectories", () => {
    const meta = { "/docs/guides/a.md": { size: 100, lines: 5 } };
    const output = formatLsLong("/docs", ["/docs/guides/a.md"], meta);
    expect(output).toContain("guides/");
  });

  it("handles root directory", () => {
    const meta = {
      "/a.md": { size: 10, lines: 1 },
      "/b.md": { size: 20, lines: 2 },
    };
    const output = formatLsLong("/", ["/a.md", "/b.md"], meta);
    expect(output).toContain("a.md");
    expect(output).toContain("b.md");
  });
});
