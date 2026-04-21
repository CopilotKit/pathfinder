import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildBashFilesMap } from "../mcp/tools/bash-fs.js";
import type { SourceConfig } from "../types.js";

describe("buildBashFilesMap", () => {
  it("builds files map for a single source (no prefix)", async () => {
    const sources: SourceConfig[] = [
      {
        name: "docs",
        type: "markdown",
        path: "fixtures/breeze-api/docs",
        file_patterns: ["**/*.md"],
        chunk: { target_tokens: 600, overlap_tokens: 50 },
      },
    ];
    const map = await buildBashFilesMap(sources);
    const keys = Object.keys(map);
    expect(keys.length).toBeGreaterThan(0);
    // Single source: no prefix, paths start with /
    for (const key of keys) {
      expect(key).toMatch(/^\//);
      expect(key).not.toMatch(/^\/docs\//);
      expect(key).toMatch(/\.md$/);
    }
  });

  it("builds files map for multiple sources (with prefix)", async () => {
    const sources: SourceConfig[] = [
      {
        name: "docs",
        type: "markdown",
        path: "fixtures/breeze-api/docs",
        file_patterns: ["**/*.md"],
        chunk: { target_tokens: 600, overlap_tokens: 50 },
      },
      {
        name: "code",
        type: "code",
        path: "fixtures/breeze-api",
        file_patterns: ["**/*.js"],
        chunk: { target_lines: 80, overlap_lines: 10 },
      },
    ];
    const map = await buildBashFilesMap(sources);
    const keys = Object.keys(map);
    expect(keys.length).toBeGreaterThan(0);
    // Multi source: prefixed with /{source_name}/
    const docKeys = keys.filter((k) => k.startsWith("/docs/"));
    const codeKeys = keys.filter((k) => k.startsWith("/code/"));
    expect(docKeys.length).toBeGreaterThan(0);
    expect(codeKeys.length).toBeGreaterThan(0);
  });

  it("excludes files matching exclude_patterns", async () => {
    const sources: SourceConfig[] = [
      {
        name: "code",
        type: "code",
        path: "fixtures/breeze-api",
        file_patterns: ["**/*.js", "**/*.md"],
        exclude_patterns: ["**/*.md"],
        chunk: { target_lines: 80, overlap_lines: 10 },
      },
    ];
    const map = await buildBashFilesMap(sources);
    const keys = Object.keys(map);
    for (const key of keys) {
      expect(key).not.toMatch(/\.md$/);
    }
  });

  it("file contents are strings", async () => {
    const sources: SourceConfig[] = [
      {
        name: "docs",
        type: "markdown",
        path: "fixtures/breeze-api/docs",
        file_patterns: ["**/*.md"],
        chunk: { target_tokens: 600, overlap_tokens: 50 },
      },
    ];
    const map = await buildBashFilesMap(sources);
    for (const val of Object.values(map)) {
      expect(typeof val).toBe("string");
      expect(val.length).toBeGreaterThan(0);
    }
  });

  it("returns empty map for nonexistent path", async () => {
    const sources: SourceConfig[] = [
      {
        name: "ghost",
        type: "markdown",
        path: "fixtures/nonexistent",
        file_patterns: ["**/*.md"],
        chunk: { target_tokens: 600, overlap_tokens: 50 },
      },
    ];
    const map = await buildBashFilesMap(sources);
    expect(Object.keys(map)).toHaveLength(0);
  });

  describe("missing-path warnings", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("does NOT warn when a repo-backed source's clone directory is not yet populated", async () => {
      // Simulates the startup race: the orchestrator hasn't cloned yet,
      // so the resolved path doesn't exist — but that's expected and should
      // not fire a misleading "path does not exist" warning.
      const sources: SourceConfig[] = [
        {
          name: "pathfinder-docs",
          type: "markdown",
          repo: "https://github.com/CopilotKit/pathfinder",
          path: "docs",
          file_patterns: ["**/*.md"],
          chunk: { target_tokens: 600, overlap_tokens: 50 },
        },
      ];
      const map = await buildBashFilesMap(sources, {
        cloneDir: "/tmp/does-not-exist-pathfinder-test",
      });
      expect(Object.keys(map)).toHaveLength(0);
      const missingPathWarnings = warnSpy.mock.calls.filter((call: unknown[]) =>
        String(call[0] ?? "").includes("path does not exist"),
      );
      expect(missingPathWarnings).toHaveLength(0);
    });

    it("DOES warn when a local (no-repo) source's path does not exist", async () => {
      // True misconfiguration: user pointed at a path that doesn't exist
      // and there's no repo to later populate it. Must still fire.
      const sources: SourceConfig[] = [
        {
          name: "local-ghost",
          type: "markdown",
          path: "fixtures/definitely-not-here-" + Date.now(),
          file_patterns: ["**/*.md"],
          chunk: { target_tokens: 600, overlap_tokens: 50 },
        },
      ];
      const map = await buildBashFilesMap(sources);
      expect(Object.keys(map)).toHaveLength(0);
      const missingPathWarnings = warnSpy.mock.calls.filter((call: unknown[]) =>
        String(call[0] ?? "").includes("path does not exist"),
      );
      expect(missingPathWarnings.length).toBeGreaterThan(0);
    });
  });
});
