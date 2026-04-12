import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { FileDataProvider } from "../indexing/providers/file.js";
import type { FileSourceConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Mock simple-git — used for all remote-repo (git) code paths
// ---------------------------------------------------------------------------

const mockGitInstance = {
  clone: vi.fn().mockResolvedValue(undefined),
  pull: vi.fn().mockResolvedValue(undefined),
  revparse: vi.fn().mockResolvedValue("abc123"),
  diff: vi.fn().mockResolvedValue(""),
  fetch: vi.fn().mockResolvedValue(undefined),
  listRemote: vi.fn().mockResolvedValue("abc123\tHEAD"),
};

vi.mock("simple-git", () => ({
  simpleGit: vi.fn(() => mockGitInstance),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe("FileDataProvider", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fp-test-"));
    await fs.promises.writeFile(
      path.join(tmpDir, "readme.md"),
      "# Hello\nWorld",
    );
    await fs.promises.writeFile(
      path.join(tmpDir, "guide.md"),
      "# Guide\nContent here",
    );
    await fs.promises.writeFile(
      path.join(tmpDir, "style.css"),
      "body { color: red; }",
    );
    await fs.promises.mkdir(path.join(tmpDir, "sub"), { recursive: true });
    await fs.promises.writeFile(
      path.join(tmpDir, "sub", "nested.md"),
      "# Nested",
    );
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  function makeLocalConfig(
    overrides?: Partial<FileSourceConfig>,
  ): FileSourceConfig {
    return {
      name: "test",
      type: "markdown",
      path: tmpDir,
      file_patterns: ["**/*.md"],
      chunk: { target_tokens: 600, overlap_tokens: 50 },
      ...overrides,
    };
  }

  function makeGitConfig(
    overrides?: Partial<FileSourceConfig>,
  ): FileSourceConfig {
    return {
      name: "test-git",
      type: "markdown",
      repo: "https://github.com/org/repo.git",
      path: "docs",
      file_patterns: ["**/*.md"],
      chunk: { target_tokens: 600, overlap_tokens: 50 },
      ...overrides,
    };
  }

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  describe("constructor", () => {
    it("throws when given a non-file source config", () => {
      const slackConfig = {
        name: "slack-src",
        type: "slack" as const,
        channels: [{ id: "C1", name: "general" }],
        chunk: {},
      };
      expect(
        () => new FileDataProvider(slackConfig as any, { cloneDir: "/tmp" }),
      ).toThrow("FileDataProvider cannot handle slack source type");
    });

    it("merges custom skip_dirs with defaults", async () => {
      await fs.promises.mkdir(path.join(tmpDir, "custom_skip"), {
        recursive: true,
      });
      await fs.promises.writeFile(
        path.join(tmpDir, "custom_skip", "file.md"),
        "# Skip me",
      );
      const provider = new FileDataProvider(
        makeLocalConfig({ skip_dirs: ["custom_skip"] }),
        { cloneDir: "/tmp/test-clones" },
      );
      const result = await provider.fullAcquire();
      const ids = result.items.map((i) => i.id);
      expect(ids).not.toContain("custom_skip/file.md");
    });

    it("uses custom max_file_size", async () => {
      // Write a file larger than 10 bytes
      await fs.promises.writeFile(path.join(tmpDir, "big.md"), "x".repeat(200));
      const provider = new FileDataProvider(
        makeLocalConfig({ max_file_size: 10 }),
        { cloneDir: "/tmp/test-clones" },
      );
      const result = await provider.fullAcquire();
      const ids = result.items.map((i) => i.id);
      expect(ids).not.toContain("big.md");
    });
  });

  // -----------------------------------------------------------------------
  // fullAcquire — local sources
  // -----------------------------------------------------------------------

  describe("fullAcquire (local)", () => {
    it("returns matching files as ContentItems", async () => {
      const provider = new FileDataProvider(makeLocalConfig(), {
        cloneDir: "/tmp/test-clones",
      });
      const result = await provider.fullAcquire();
      expect(result.items.length).toBe(3);
      expect(result.removedIds).toEqual([]);
      expect(result.stateToken).toMatch(/^local-/);
      const ids = result.items.map((i) => i.id).sort();
      expect(ids).toContain("readme.md");
      expect(ids).toContain("guide.md");
      expect(ids).toContain("sub/nested.md");
      const readme = result.items.find((i) => i.id === "readme.md");
      expect(readme?.content).toBe("# Hello\nWorld");
    });

    it("excludes non-matching patterns", async () => {
      const provider = new FileDataProvider(makeLocalConfig(), {
        cloneDir: "/tmp/test-clones",
      });
      const result = await provider.fullAcquire();
      const ids = result.items.map((i) => i.id);
      expect(ids).not.toContain("style.css");
    });

    it("filters out low-semantic-value content", async () => {
      const svgContent = "M0,0 L100,100 C50,50 200.5,300.7 ".repeat(100);
      await fs.promises.writeFile(path.join(tmpDir, "data.md"), svgContent);
      const provider = new FileDataProvider(makeLocalConfig(), {
        cloneDir: "/tmp/test-clones",
      });
      const result = await provider.fullAcquire();
      const ids = result.items.map((i) => i.id);
      expect(ids).not.toContain("data.md");
    });

    it("throws when local path does not exist", async () => {
      const provider = new FileDataProvider(
        makeLocalConfig({ path: "/nonexistent/surely/missing" }),
        { cloneDir: "/tmp/test-clones" },
      );
      await expect(provider.fullAcquire()).rejects.toThrow(
        "Local source path does not exist",
      );
    });

    it("skips default skip_dirs (node_modules, dist, build, .git)", async () => {
      for (const dir of ["node_modules", "dist", "build", ".git"]) {
        await fs.promises.mkdir(path.join(tmpDir, dir), { recursive: true });
        await fs.promises.writeFile(
          path.join(tmpDir, dir, "file.md"),
          "# Skipped",
        );
      }
      const provider = new FileDataProvider(makeLocalConfig(), {
        cloneDir: "/tmp/test-clones",
      });
      const result = await provider.fullAcquire();
      const ids = result.items.map((i) => i.id);
      expect(ids).not.toContain("node_modules/file.md");
      expect(ids).not.toContain("dist/file.md");
      expect(ids).not.toContain("build/file.md");
      expect(ids).not.toContain(".git/file.md");
    });

    it("handles exclude_patterns", async () => {
      const provider = new FileDataProvider(
        makeLocalConfig({ exclude_patterns: ["**/nested.md"] }),
        { cloneDir: "/tmp/test-clones" },
      );
      const result = await provider.fullAcquire();
      const ids = result.items.map((i) => i.id);
      expect(ids).not.toContain("sub/nested.md");
      expect(ids).toContain("readme.md");
    });

    it("handles file read errors gracefully", async () => {
      // Create a file then make it unreadable
      const unreadable = path.join(tmpDir, "unreadable.md");
      await fs.promises.writeFile(unreadable, "# Secret");
      await fs.promises.chmod(unreadable, 0o000);
      const provider = new FileDataProvider(makeLocalConfig(), {
        cloneDir: "/tmp/test-clones",
      });
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const result = await provider.fullAcquire();
      // Should still return other files, not crash
      expect(result.items.length).toBeGreaterThanOrEqual(3);
      const ids = result.items.map((i) => i.id);
      expect(ids).not.toContain("unreadable.md");
      consoleSpy.mockRestore();
      // Restore permissions for cleanup
      await fs.promises.chmod(unreadable, 0o644);
    });
  });

  // -----------------------------------------------------------------------
  // fullAcquire — git (remote) sources
  // -----------------------------------------------------------------------

  describe("fullAcquire (git)", () => {
    it("clones a repo and walks the configured path", async () => {
      // Set up the cloneDir so it exists, and create the expected repo structure
      const cloneDir = path.join(tmpDir, "clones");
      await fs.promises.mkdir(cloneDir, { recursive: true });

      const repoDir = path.join(cloneDir, "repo");
      const docsDir = path.join(repoDir, "docs");
      await fs.promises.mkdir(docsDir, { recursive: true });
      await fs.promises.writeFile(path.join(docsDir, "index.md"), "# Index");
      // Create .git so ensureRepo sees existing clone
      await fs.promises.mkdir(path.join(repoDir, ".git"), { recursive: true });

      const provider = new FileDataProvider(makeGitConfig(), { cloneDir });
      const result = await provider.fullAcquire();

      expect(result.stateToken).toBe("abc123");
      expect(result.items.length).toBe(1);
      expect(result.items[0].id).toBe("docs/index.md");
    });

    it("returns empty items when walkRoot does not exist", async () => {
      const cloneDir = path.join(tmpDir, "clones");
      await fs.promises.mkdir(cloneDir, { recursive: true });

      const repoDir = path.join(cloneDir, "repo");
      await fs.promises.mkdir(path.join(repoDir, ".git"), { recursive: true });
      // No docs/ subdirectory — walkRoot won't exist

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const provider = new FileDataProvider(makeGitConfig(), { cloneDir });
      const result = await provider.fullAcquire();

      expect(result.items).toEqual([]);
      expect(result.removedIds).toEqual([]);
      expect(result.stateToken).toBe("abc123");
      warnSpy.mockRestore();
    });

    it("uses github token in authenticated URL", async () => {
      const { simpleGit } = await import("simple-git");

      const cloneDir = path.join(tmpDir, "clones");
      await fs.promises.mkdir(cloneDir, { recursive: true });
      // No .git dir so it will attempt a fresh clone
      mockGitInstance.clone.mockResolvedValue(undefined);

      const provider = new FileDataProvider(makeGitConfig(), {
        cloneDir,
        githubToken: "ghp_secret123",
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        await provider.fullAcquire();
      } catch {
        // May fail because cloned dir won't actually exist, that's fine
      }

      // The clone call should use the authenticated URL
      expect(mockGitInstance.clone).toHaveBeenCalledWith(
        "https://x-access-token:ghp_secret123@github.com/org/repo.git",
        "repo",
        expect.any(Array),
      );
      warnSpy.mockRestore();
    });

    it("passes --branch flag when config has branch", async () => {
      const cloneDir = path.join(tmpDir, "clones");
      await fs.promises.mkdir(cloneDir, { recursive: true });
      mockGitInstance.clone.mockResolvedValue(undefined);

      const provider = new FileDataProvider(
        makeGitConfig({ branch: "develop" }),
        { cloneDir },
      );
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        await provider.fullAcquire();
      } catch {
        // Clone won't create real dir
      }

      expect(mockGitInstance.clone).toHaveBeenCalledWith(
        expect.any(String),
        "repo",
        ["--depth=1", "--branch", "develop"],
      );
      warnSpy.mockRestore();
    });

    it("re-clones when pull fails (corrupted repo)", async () => {
      const cloneDir = path.join(tmpDir, "clones");
      const repoDir = path.join(cloneDir, "repo");
      await fs.promises.mkdir(path.join(repoDir, ".git"), { recursive: true });

      mockGitInstance.pull.mockRejectedValueOnce(new Error("corrupted"));
      mockGitInstance.clone.mockResolvedValue(undefined);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const provider = new FileDataProvider(makeGitConfig(), { cloneDir });

      try {
        await provider.fullAcquire();
      } catch {
        // May fail downstream
      }

      expect(mockGitInstance.clone).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // incrementalAcquire
  // -----------------------------------------------------------------------

  describe("incrementalAcquire", () => {
    it("falls back to fullAcquire for local sources", async () => {
      const provider = new FileDataProvider(makeLocalConfig(), {
        cloneDir: "/tmp/test-clones",
      });
      const result = await provider.incrementalAcquire("old-token");
      expect(result.items.length).toBe(3);
    });

    it("returns empty when HEAD matches lastStateToken (no new commits)", async () => {
      const cloneDir = path.join(tmpDir, "clones");
      const repoDir = path.join(cloneDir, "repo");
      await fs.promises.mkdir(path.join(repoDir, ".git"), { recursive: true });

      mockGitInstance.revparse.mockResolvedValue("abc123");

      const provider = new FileDataProvider(makeGitConfig(), { cloneDir });
      const result = await provider.incrementalAcquire("abc123");

      expect(result.items).toEqual([]);
      expect(result.removedIds).toEqual([]);
      expect(result.stateToken).toBe("abc123");
    });

    it("returns changed files when HEAD differs from lastStateToken", async () => {
      const cloneDir = path.join(tmpDir, "clones");
      const repoDir = path.join(cloneDir, "repo");
      await fs.promises.mkdir(path.join(repoDir, ".git"), { recursive: true });
      // Create a file that matches the diff output
      await fs.promises.mkdir(path.join(repoDir, "docs"), { recursive: true });
      await fs.promises.writeFile(
        path.join(repoDir, "docs/updated.md"),
        "# Updated content",
      );

      mockGitInstance.revparse.mockResolvedValue("def456");
      mockGitInstance.diff
        .mockResolvedValueOnce("docs/updated.md\n") // --name-only
        .mockResolvedValueOnce("M\tdocs/updated.md\n"); // --name-status

      const provider = new FileDataProvider(makeGitConfig(), { cloneDir });
      const result = await provider.incrementalAcquire("abc123");

      expect(result.stateToken).toBe("def456");
      expect(result.items.length).toBe(1);
      expect(result.items[0].id).toBe("docs/updated.md");
      expect(result.removedIds).toEqual([]);
    });

    it("reports deleted files in removedIds", async () => {
      const cloneDir = path.join(tmpDir, "clones");
      const repoDir = path.join(cloneDir, "repo");
      await fs.promises.mkdir(path.join(repoDir, ".git"), { recursive: true });

      mockGitInstance.revparse.mockResolvedValue("def456");
      mockGitInstance.diff
        .mockResolvedValueOnce("docs/deleted.md\n") // --name-only
        .mockResolvedValueOnce("D\tdocs/deleted.md\n"); // --name-status

      const provider = new FileDataProvider(makeGitConfig(), { cloneDir });
      const result = await provider.incrementalAcquire("abc123");

      expect(result.stateToken).toBe("def456");
      expect(result.items).toEqual([]);
      expect(result.removedIds).toEqual(["docs/deleted.md"]);
    });

    it("returns empty when no matching changes detected", async () => {
      const cloneDir = path.join(tmpDir, "clones");
      const repoDir = path.join(cloneDir, "repo");
      await fs.promises.mkdir(path.join(repoDir, ".git"), { recursive: true });

      mockGitInstance.revparse.mockResolvedValue("def456");
      // Changed file doesn't match *.md pattern
      mockGitInstance.diff.mockResolvedValueOnce("src/index.ts\n");

      const provider = new FileDataProvider(makeGitConfig(), { cloneDir });
      const result = await provider.incrementalAcquire("abc123");

      expect(result.items).toEqual([]);
      expect(result.removedIds).toEqual([]);
    });

    it("falls back to fullAcquire when git diff fails", async () => {
      const cloneDir = path.join(tmpDir, "clones");
      const repoDir = path.join(cloneDir, "repo");
      const docsDir = path.join(repoDir, "docs");
      await fs.promises.mkdir(path.join(repoDir, ".git"), { recursive: true });
      await fs.promises.mkdir(docsDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(docsDir, "fallback.md"),
        "# Fallback",
      );

      mockGitInstance.revparse.mockResolvedValue("def456");
      mockGitInstance.diff.mockRejectedValueOnce(new Error("diff failed"));

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const provider = new FileDataProvider(makeGitConfig(), { cloneDir });
      const result = await provider.incrementalAcquire("abc123");

      // Should have fallen back to fullAcquire
      expect(result.items.length).toBe(1);
      expect(result.stateToken).toBe("def456");
      warnSpy.mockRestore();
    });

    it("silently handles unshallow errors for already-unshallowed repos", async () => {
      const cloneDir = path.join(tmpDir, "clones");
      const repoDir = path.join(cloneDir, "repo");
      await fs.promises.mkdir(path.join(repoDir, ".git"), { recursive: true });

      mockGitInstance.revparse.mockResolvedValue("def456");
      mockGitInstance.fetch.mockRejectedValueOnce(
        new Error("--unshallow on a complete repository does not make sense"),
      );
      mockGitInstance.diff
        .mockResolvedValueOnce("") // no changed files
        .mockResolvedValueOnce("");

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const provider = new FileDataProvider(makeGitConfig(), { cloneDir });
      // Should not warn for expected unshallow error
      const result = await provider.incrementalAcquire("abc123");

      // Check that warn was NOT called with the unshallow message
      const unshallowWarns = warnSpy.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].includes("unshallow"),
      );
      expect(unshallowWarns).toHaveLength(0);
      warnSpy.mockRestore();
    });

    it("warns on unexpected fetch --unshallow errors", async () => {
      const cloneDir = path.join(tmpDir, "clones");
      const repoDir = path.join(cloneDir, "repo");
      await fs.promises.mkdir(path.join(repoDir, ".git"), { recursive: true });

      mockGitInstance.revparse.mockResolvedValue("def456");
      mockGitInstance.fetch.mockRejectedValueOnce(new Error("network timeout"));
      mockGitInstance.diff.mockResolvedValueOnce("").mockResolvedValueOnce("");

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const provider = new FileDataProvider(makeGitConfig(), { cloneDir });
      await provider.incrementalAcquire("abc123");

      const fetchWarns = warnSpy.mock.calls.filter(
        (call) =>
          typeof call[0] === "string" && call[0].includes("unshallow failed"),
      );
      expect(fetchWarns.length).toBeGreaterThan(0);
      warnSpy.mockRestore();
    });

    it("skips files exceeding maxFileSize in incremental acquire", async () => {
      const cloneDir = path.join(tmpDir, "clones");
      const repoDir = path.join(cloneDir, "repo");
      await fs.promises.mkdir(path.join(repoDir, ".git"), { recursive: true });
      await fs.promises.mkdir(path.join(repoDir, "docs"), { recursive: true });
      // Write a file larger than the default 100KB
      await fs.promises.writeFile(
        path.join(repoDir, "docs/huge.md"),
        "x".repeat(200_000),
      );

      mockGitInstance.revparse.mockResolvedValue("def456");
      mockGitInstance.diff
        .mockResolvedValueOnce("docs/huge.md\n")
        .mockResolvedValueOnce("M\tdocs/huge.md\n");

      const provider = new FileDataProvider(makeGitConfig(), { cloneDir });
      const result = await provider.incrementalAcquire("abc123");

      expect(result.items).toEqual([]);
    });

    it("skips low-semantic-value files in incremental acquire", async () => {
      const cloneDir = path.join(tmpDir, "clones");
      const repoDir = path.join(cloneDir, "repo");
      await fs.promises.mkdir(path.join(repoDir, ".git"), { recursive: true });
      await fs.promises.mkdir(path.join(repoDir, "docs"), { recursive: true });
      const svgContent = "M0,0 L100,100 C50,50 200.5,300.7 ".repeat(100);
      await fs.promises.writeFile(
        path.join(repoDir, "docs/svg.md"),
        svgContent,
      );

      mockGitInstance.revparse.mockResolvedValue("def456");
      mockGitInstance.diff
        .mockResolvedValueOnce("docs/svg.md\n")
        .mockResolvedValueOnce("M\tdocs/svg.md\n");

      const provider = new FileDataProvider(makeGitConfig(), { cloneDir });
      const result = await provider.incrementalAcquire("abc123");

      expect(result.items).toEqual([]);
    });

    it("skips files that no longer exist on disk", async () => {
      const cloneDir = path.join(tmpDir, "clones");
      const repoDir = path.join(cloneDir, "repo");
      await fs.promises.mkdir(path.join(repoDir, ".git"), { recursive: true });
      // docs/gone.md is listed as modified but doesn't exist on disk

      mockGitInstance.revparse.mockResolvedValue("def456");
      mockGitInstance.diff
        .mockResolvedValueOnce("docs/gone.md\n")
        .mockResolvedValueOnce("M\tdocs/gone.md\n");

      const provider = new FileDataProvider(makeGitConfig(), { cloneDir });
      const result = await provider.incrementalAcquire("abc123");

      expect(result.items).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // getCurrentStateToken
  // -----------------------------------------------------------------------

  describe("getCurrentStateToken", () => {
    it("returns local hash for local sources", async () => {
      const provider = new FileDataProvider(makeLocalConfig(), {
        cloneDir: "/tmp/test-clones",
      });
      const token = await provider.getCurrentStateToken();
      expect(token).toMatch(/^local-/);
    });

    it("returns null when local path does not exist", async () => {
      const provider = new FileDataProvider(
        makeLocalConfig({ path: "/nonexistent/path" }),
        { cloneDir: "/tmp/test-clones" },
      );
      const token = await provider.getCurrentStateToken();
      expect(token).toBeNull();
    });

    it("returns consistent hashes for unchanged local files", async () => {
      const provider = new FileDataProvider(makeLocalConfig(), {
        cloneDir: "/tmp/test-clones",
      });
      const token1 = await provider.getCurrentStateToken();
      const token2 = await provider.getCurrentStateToken();
      expect(token1).toBe(token2);
    });

    it("returns different hash when local files change", async () => {
      const provider = new FileDataProvider(makeLocalConfig(), {
        cloneDir: "/tmp/test-clones",
      });
      const token1 = await provider.getCurrentStateToken();
      // Wait a tiny bit to ensure mtime changes
      await new Promise((r) => setTimeout(r, 50));
      await fs.promises.writeFile(path.join(tmpDir, "readme.md"), "# Changed");
      const token2 = await provider.getCurrentStateToken();
      expect(token1).not.toBe(token2);
    });

    it("uses ls-remote for git sources", async () => {
      mockGitInstance.listRemote.mockResolvedValue("deadbeef\tHEAD");

      const provider = new FileDataProvider(makeGitConfig(), {
        cloneDir: "/tmp/test-clones",
      });
      const token = await provider.getCurrentStateToken();
      expect(token).toBe("deadbeef");
    });

    it("uses authenticated URL for ls-remote when githubToken provided", async () => {
      mockGitInstance.listRemote.mockResolvedValue("deadbeef\tHEAD");

      const provider = new FileDataProvider(makeGitConfig(), {
        cloneDir: "/tmp/test-clones",
        githubToken: "ghp_tok",
      });
      const token = await provider.getCurrentStateToken();
      expect(token).toBe("deadbeef");
      expect(mockGitInstance.listRemote).toHaveBeenCalledWith([
        "https://x-access-token:ghp_tok@github.com/org/repo.git",
        "HEAD",
      ]);
    });

    it("falls back to local HEAD when ls-remote fails and clone exists", async () => {
      const cloneDir = path.join(tmpDir, "clones");
      const repoDir = path.join(cloneDir, "repo");
      await fs.promises.mkdir(repoDir, { recursive: true });

      mockGitInstance.listRemote.mockRejectedValue(new Error("network error"));
      mockGitInstance.revparse.mockResolvedValue("localhead");

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const provider = new FileDataProvider(makeGitConfig(), { cloneDir });
      const token = await provider.getCurrentStateToken();

      expect(token).toBe("localhead");
      warnSpy.mockRestore();
    });

    it("returns null when ls-remote fails and clone dir does not exist", async () => {
      mockGitInstance.listRemote.mockRejectedValue(new Error("network error"));

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const provider = new FileDataProvider(makeGitConfig(), {
        cloneDir: "/tmp/nonexistent-clones-xyz",
      });
      const token = await provider.getCurrentStateToken();

      expect(token).toBeNull();
      warnSpy.mockRestore();
    });

    it("returns null when ls-remote and local HEAD both fail", async () => {
      const cloneDir = path.join(tmpDir, "clones");
      const repoDir = path.join(cloneDir, "repo");
      await fs.promises.mkdir(repoDir, { recursive: true });

      mockGitInstance.listRemote.mockRejectedValue(new Error("network error"));
      mockGitInstance.revparse.mockRejectedValue(new Error("not a git repo"));

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const provider = new FileDataProvider(makeGitConfig(), { cloneDir });
      const token = await provider.getCurrentStateToken();

      expect(token).toBeNull();
      warnSpy.mockRestore();
    });

    it("returns null when ls-remote returns empty string", async () => {
      mockGitInstance.listRemote.mockResolvedValue("");

      const provider = new FileDataProvider(makeGitConfig(), {
        cloneDir: "/tmp/test-clones",
      });
      const token = await provider.getCurrentStateToken();
      expect(token).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // walkFiles edge cases
  // -----------------------------------------------------------------------

  describe("walkFiles (via fullAcquire)", () => {
    it("handles unreadable directories gracefully", async () => {
      const unreadableDir = path.join(tmpDir, "secret");
      await fs.promises.mkdir(unreadableDir);
      await fs.promises.writeFile(
        path.join(unreadableDir, "file.md"),
        "# Secret",
      );
      await fs.promises.chmod(unreadableDir, 0o000);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const provider = new FileDataProvider(makeLocalConfig(), {
        cloneDir: "/tmp/test-clones",
      });
      const result = await provider.fullAcquire();

      // Should still return other files
      expect(result.items.length).toBeGreaterThanOrEqual(3);
      warnSpy.mockRestore();
      // Restore permissions for cleanup
      await fs.promises.chmod(unreadableDir, 0o755);
    });

    it("handles stat errors on individual files during walk", async () => {
      // Create a broken symlink — readdir will list it but stat will fail
      const brokenLink = path.join(tmpDir, "broken.md");
      await fs.promises.symlink("/nonexistent/target", brokenLink);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const provider = new FileDataProvider(makeLocalConfig(), {
        cloneDir: "/tmp/test-clones",
      });
      const result = await provider.fullAcquire();

      // Should still return the valid files, skipping the broken symlink
      expect(result.items.length).toBeGreaterThanOrEqual(3);
      const ids = result.items.map((i) => i.id);
      expect(ids).not.toContain("broken.md");
      warnSpy.mockRestore();
    });

    it("skips files exceeding max_file_size during walk", async () => {
      await fs.promises.writeFile(
        path.join(tmpDir, "huge.md"),
        "x".repeat(200_000),
      );
      const provider = new FileDataProvider(makeLocalConfig(), {
        cloneDir: "/tmp/test-clones",
      });
      const result = await provider.fullAcquire();
      const ids = result.items.map((i) => i.id);
      expect(ids).not.toContain("huge.md");
    });
  });

  // -----------------------------------------------------------------------
  // repoNameFromUrl (tested indirectly via git operations)
  // -----------------------------------------------------------------------

  describe("repoNameFromUrl (indirect)", () => {
    it("strips .git suffix from repo URL", async () => {
      const cloneDir = path.join(tmpDir, "clones");
      await fs.promises.mkdir(cloneDir, { recursive: true });

      const provider = new FileDataProvider(
        makeGitConfig({ repo: "https://github.com/org/my-repo.git" }),
        { cloneDir },
      );
      mockGitInstance.clone.mockResolvedValue(undefined);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await provider.fullAcquire();
      } catch {
        // Expected
      }

      // Clone should use "my-repo" as the directory name (without .git)
      expect(mockGitInstance.clone).toHaveBeenCalledWith(
        expect.any(String),
        "my-repo",
        expect.any(Array),
      );
      warnSpy.mockRestore();
    });

    it("handles URLs without .git suffix", async () => {
      const cloneDir = path.join(tmpDir, "clones");
      await fs.promises.mkdir(cloneDir, { recursive: true });

      const provider = new FileDataProvider(
        makeGitConfig({ repo: "https://github.com/org/my-repo" }),
        { cloneDir },
      );
      mockGitInstance.clone.mockResolvedValue(undefined);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await provider.fullAcquire();
      } catch {
        // Expected
      }

      expect(mockGitInstance.clone).toHaveBeenCalledWith(
        expect.any(String),
        "my-repo",
        expect.any(Array),
      );
      warnSpy.mockRestore();
    });
  });
});
