import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { walkSourceFiles } from "../indexing/utils.js";
import type { FileSourceConfig } from "../types.js";

describe("walkSourceFiles", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "walk-source-test-"),
    );
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  function makeSourceConfig(
    overrides: Partial<FileSourceConfig> = {},
  ): FileSourceConfig {
    return {
      name: "test-source",
      type: "markdown",
      path: tmpDir,
      file_patterns: ["**/*.md"],
      chunk: { target_tokens: 500, overlap_tokens: 50 },
      ...overrides,
    } as FileSourceConfig;
  }

  async function writeFile(relPath: string, content: string): Promise<void> {
    const absPath = path.join(tmpDir, relPath);
    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
    await fs.promises.writeFile(absPath, content);
  }

  it("returns matching files from a local source directory", async () => {
    await writeFile("README.md", "# Hello");
    await writeFile("docs/guide.md", "# Guide");
    await writeFile("docs/nested/deep.md", "# Deep");

    const config = makeSourceConfig();
    const result = await walkSourceFiles(config, "/unused");

    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(3);
    expect(result.has("README.md")).toBe(true);
    expect(result.has(path.join("docs", "guide.md"))).toBe(true);
    expect(result.has(path.join("docs", "nested", "deep.md"))).toBe(true);
  });

  it("excludes files that don't match file_patterns", async () => {
    await writeFile("README.md", "# Hello");
    await writeFile("index.ts", "export const x = 1;");
    await writeFile("styles.css", "body {}");

    const config = makeSourceConfig({ file_patterns: ["**/*.md"] });
    const result = await walkSourceFiles(config, "/unused");

    expect(result.size).toBe(1);
    expect(result.has("README.md")).toBe(true);
    expect(result.has("index.ts")).toBe(false);
    expect(result.has("styles.css")).toBe(false);
  });

  it("excludes files in skip_dirs", async () => {
    await writeFile("README.md", "# Hello");
    await writeFile("node_modules/pkg/README.md", "# Pkg");
    await writeFile("vendor/lib/README.md", "# Lib");
    await writeFile(".git/objects/README.md", "# Git");

    // node_modules and .git are in the default skip list; add vendor
    const config = makeSourceConfig({ skip_dirs: ["vendor"] });
    const result = await walkSourceFiles(config, "/unused");

    expect(result.size).toBe(1);
    expect(result.has("README.md")).toBe(true);
    expect(result.has(path.join("node_modules", "pkg", "README.md"))).toBe(
      false,
    );
    expect(result.has(path.join("vendor", "lib", "README.md"))).toBe(false);
    expect(result.has(path.join(".git", "objects", "README.md"))).toBe(false);
  });

  it("returns empty set when directory doesn't exist", async () => {
    const config = makeSourceConfig({
      path: path.join(tmpDir, "nonexistent"),
    });
    const result = await walkSourceFiles(config, "/unused");

    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
  });

  it("respects max_file_size", async () => {
    const smallContent = "# Small file";
    const largeContent = "x".repeat(200_000); // 200KB > default 100KB

    await writeFile("small.md", smallContent);
    await writeFile("large.md", largeContent);

    const config = makeSourceConfig();
    const result = await walkSourceFiles(config, "/unused");

    expect(result.size).toBe(1);
    expect(result.has("small.md")).toBe(true);
    expect(result.has("large.md")).toBe(false);
  });

  it("respects custom max_file_size", async () => {
    const content = "x".repeat(200_000); // 200KB

    await writeFile("big.md", content);

    // With a higher limit, the file should be included
    const config = makeSourceConfig({ max_file_size: 300_000 });
    const result = await walkSourceFiles(config, "/unused");

    expect(result.size).toBe(1);
    expect(result.has("big.md")).toBe(true);
  });

  it("handles git source path resolution", async () => {
    // Simulate a cloned repo structure: cloneDir/repoName/path/files
    const cloneDir = path.join(tmpDir, "clones");
    const repoDir = path.join(cloneDir, "my-repo");
    const docsDir = path.join(repoDir, "docs");

    await fs.promises.mkdir(docsDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(docsDir, "guide.md"),
      "# Guide content",
    );
    await fs.promises.writeFile(
      path.join(docsDir, "api.md"),
      "# API reference",
    );

    const config = makeSourceConfig({
      repo: "https://github.com/org/my-repo.git",
      path: "docs",
    });
    const result = await walkSourceFiles(config, cloneDir);

    expect(result.size).toBe(2);
    // Paths should be relative to repoDir, not docsDir
    expect(result.has(path.join("docs", "guide.md"))).toBe(true);
    expect(result.has(path.join("docs", "api.md"))).toBe(true);
  });
});
