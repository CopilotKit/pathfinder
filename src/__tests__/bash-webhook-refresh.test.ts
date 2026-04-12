import { describe, it, expect } from "vitest";
import { rebuildBashInstance } from "../mcp/tools/bash-fs.js";
import type { SourceConfig } from "../types.js";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

describe("rebuildBashInstance", () => {
  it("creates a new Bash instance from sources", async () => {
    // Create a temp dir with test files
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-"));
    fs.writeFileSync(path.join(tmpDir, "test.md"), "# Test");

    const source: SourceConfig = {
      name: "test",
      type: "markdown",
      path: tmpDir,
      file_patterns: ["**/*.md"],
      chunk: { target_tokens: 600, overlap_tokens: 50 },
    };

    const { bash, fileCount } = await rebuildBashInstance([source]);
    expect(fileCount).toBe(1);

    const result = await bash.exec("cat /test.md", { cwd: "/" });
    expect(result.stdout).toContain("# Test");

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("returns empty instance for nonexistent source path", async () => {
    const source: SourceConfig = {
      name: "missing",
      type: "markdown",
      path: "/nonexistent/path/abc123",
      file_patterns: ["**/*.md"],
      chunk: { target_tokens: 600, overlap_tokens: 50 },
    };

    const { bash, fileCount } = await rebuildBashInstance([source]);
    expect(fileCount).toBe(0);
  });
});
