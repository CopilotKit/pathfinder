import { describe, it, expect, vi } from "vitest";
import {
  parseGrepCommand,
  parseQmdCommand,
  vectorGrep,
} from "../mcp/tools/bash-grep.js";

describe("parseGrepCommand", () => {
  it("parses basic grep command", () => {
    const result = parseGrepCommand('grep "useCoAgent" /docs');
    expect(result).toEqual({
      isGrep: true,
      pattern: "useCoAgent",
      flags: [],
      paths: ["/docs"],
    });
  });
  it("parses grep with flags", () => {
    const result = parseGrepCommand('grep -rn "pattern" /docs /code');
    expect(result).toEqual({
      isGrep: true,
      pattern: "pattern",
      flags: ["-rn"],
      paths: ["/docs", "/code"],
    });
  });
  it("parses grep with separate flags", () => {
    const result = parseGrepCommand('grep -r -l "pattern" /');
    expect(result).toEqual({
      isGrep: true,
      pattern: "pattern",
      flags: ["-r", "-l"],
      paths: ["/"],
    });
  });
  it("parses grep with unquoted pattern", () => {
    const result = parseGrepCommand("grep useCoAgent /docs");
    expect(result).toEqual({
      isGrep: true,
      pattern: "useCoAgent",
      flags: [],
      paths: ["/docs"],
    });
  });
  it("returns isGrep false for non-grep commands", () => {
    expect(parseGrepCommand("cat /docs/file.md").isGrep).toBe(false);
    expect(parseGrepCommand('find / -name "*.ts"').isGrep).toBe(false);
    expect(parseGrepCommand("ls /docs").isGrep).toBe(false);
  });
  it("handles piped grep (not intercepted)", () => {
    expect(parseGrepCommand("cat file.ts | grep pattern").isGrep).toBe(false);
  });
  it("parses grep with single-quoted pattern", () => {
    const result = parseGrepCommand("grep -r 'useCoAgent' /docs");
    expect(result).toEqual({
      isGrep: true,
      pattern: "useCoAgent",
      flags: ["-r"],
      paths: ["/docs"],
    });
  });
  it("handles grep with no path (defaults to /)", () => {
    const result = parseGrepCommand('grep "pattern"');
    expect(result).toEqual({
      isGrep: true,
      pattern: "pattern",
      flags: [],
      paths: ["/"],
    });
  });
  it("handles flags with arguments (-m 5)", () => {
    const result = parseGrepCommand('grep -m 5 "pattern" /docs');
    expect(result).toEqual({
      isGrep: true,
      pattern: "pattern",
      flags: ["-m", "5"],
      paths: ["/docs"],
    });
  });
  it("handles -e flag with argument", () => {
    // KNOWN LIMITATION, pinned as-is: parseGrepCommand treats -e as a generic
    // flag that takes an argument, so "pattern" is stored as the flag's
    // argument and "/docs" becomes the pattern. Real grep uses the -e argument
    // as the pattern and "/docs" as the path. This test records the current
    // parser output; it does not say that output is correct.
    const result = parseGrepCommand('grep -e "pattern" /docs');
    expect(result).toEqual({
      isGrep: true,
      pattern: "/docs",
      flags: ["-e", "pattern"],
      paths: ["/"],
    });
  });
  it("handles -A flag with argument", () => {
    const result = parseGrepCommand('grep -A 3 "pattern" /docs');
    expect(result).toEqual({
      isGrep: true,
      pattern: "pattern",
      flags: ["-A", "3"],
      paths: ["/docs"],
    });
  });
});

describe("parseQmdCommand", () => {
  it("parses qmd with double-quoted query", () => {
    expect(parseQmdCommand('qmd "how to use hooks"')).toEqual({
      isQmd: true,
      query: "how to use hooks",
    });
  });
  it("parses qmd with single-quoted query", () => {
    expect(parseQmdCommand("qmd 'streaming agents'")).toEqual({
      isQmd: true,
      query: "streaming agents",
    });
  });
  it("parses qmd with unquoted query", () => {
    expect(parseQmdCommand("qmd streaming agents")).toEqual({
      isQmd: true,
      query: "streaming agents",
    });
  });
  it("rejects bare qmd with no query", () => {
    expect(parseQmdCommand("qmd")).toEqual({ isQmd: false, query: "" });
    expect(parseQmdCommand("qmd  ")).toEqual({ isQmd: false, query: "" });
  });
  it("rejects piped qmd commands", () => {
    expect(parseQmdCommand('qmd "query" | head')).toEqual({
      isQmd: false,
      query: "",
    });
    expect(parseQmdCommand('qmd "query" && echo done')).toEqual({
      isQmd: false,
      query: "",
    });
    expect(parseQmdCommand('qmd "query"; rm -rf /')).toEqual({
      isQmd: false,
      query: "",
    });
  });
  it("rejects non-qmd commands", () => {
    expect(parseQmdCommand("grep pattern").isQmd).toBe(false);
    expect(parseQmdCommand("cat file.txt").isQmd).toBe(false);
  });
  it("rejects empty quoted query", () => {
    expect(parseQmdCommand('qmd ""')).toEqual({ isQmd: false, query: "" });
    expect(parseQmdCommand("qmd ''")).toEqual({ isQmd: false, query: "" });
  });
});

describe("vectorGrep", () => {
  const mockEmbeddingClient = {
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    embedBatch: vi.fn(),
  };
  const mockSearchChunks = vi.fn().mockResolvedValue([
    {
      id: 1,
      source_name: "docs",
      source_url: null,
      title: "Streaming",
      content: "How to use useCoAgent for streaming.",
      repo_url: null,
      file_path: "guides/streaming.mdx",
      start_line: 5,
      end_line: 10,
      language: null,
      similarity: 0.92,
    },
  ]);
  const mockTextSearch = vi.fn().mockResolvedValue([
    {
      id: 2,
      source_name: "docs",
      source_url: null,
      title: "Hooks",
      content: "The useCoAgent hook provides state management.",
      repo_url: null,
      file_path: "api/hooks.mdx",
      start_line: 1,
      end_line: 5,
      language: null,
      similarity: 0.0,
    },
  ]);

  it("returns formatted grep-like output", async () => {
    const result = await vectorGrep({
      pattern: "useCoAgent",
      sourceName: "docs",
      embeddingClient: mockEmbeddingClient as any,
      searchChunksFn: mockSearchChunks,
      textSearchFn: mockTextSearch,
    });
    expect(result.stdout).toContain("useCoAgent");
    expect(result.exitCode).toBe(0);
    expect(mockEmbeddingClient.embed).toHaveBeenCalledWith("useCoAgent");
  });

  it("returns exit code 1 when no matches found", async () => {
    mockSearchChunks.mockResolvedValueOnce([]);
    mockTextSearch.mockResolvedValueOnce([]);
    const result = await vectorGrep({
      pattern: "nonexistent_xyz",
      sourceName: "docs",
      embeddingClient: mockEmbeddingClient as any,
      searchChunksFn: mockSearchChunks,
      textSearchFn: mockTextSearch,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
  });

  // A driver-shaped error: SQL text plus the connection target. None of it
  // may reach the client, but all of it must reach the server log.
  const driverError = () =>
    new Error(
      "connect ECONNREFUSED 10.1.2.3:5432 (postgres://pf:pw@db.internal/pathfinder): " +
        "SELECT id, content FROM chunks ORDER BY embedding <=> $1",
    );
  const leaks = [
    "SELECT",
    "chunks",
    "ECONNREFUSED",
    "10.1.2.3",
    "5432",
    "postgres://",
    "db.internal",
  ];

  // The semantic half has two steps that can fail: embed() (the provider) and
  // the chunk query (the DB). Each must give the same generic client warning,
  // keep the text-search results, and log the original error on the server.
  it.each([
    {
      failing: "embed()",
      embed: () => Promise.reject(driverError()),
      searchChunks: mockSearchChunks,
    },
    {
      failing: "the chunk search",
      embed: () => Promise.resolve([0.1, 0.2, 0.3]),
      searchChunks: (() =>
        Promise.reject(driverError())) as typeof mockSearchChunks,
    },
  ])(
    "handles semantic search failure gracefully when $failing fails",
    async ({ embed, searchChunks }) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = await vectorGrep({
          pattern: "useCoAgent",
          sourceName: "docs",
          embeddingClient: { embed: vi.fn(embed), embedBatch: vi.fn() } as any,
          searchChunksFn: vi.fn(searchChunks),
          textSearchFn: mockTextSearch,
        });
        // Text search still works, so its results are returned.
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(
          "/api/hooks.mdx:1:The useCoAgent hook provides state management.\n",
        );
        expect(result.stderr).toBe("[warning: semantic search unavailable]\n");
        for (const leak of leaks) {
          expect(result.stderr).not.toContain(leak);
          expect(result.stdout).not.toContain(leak);
        }
        // The full error stays server-side.
        expect(warn).toHaveBeenCalledTimes(1);
        const [label, logged] = warn.mock.calls[0];
        expect(label).toBe("[bash-grep] Semantic search failed:");
        expect(logged).toBeInstanceOf(Error);
        expect((logged as Error).message).toBe(driverError().message);
      } finally {
        warn.mockRestore();
      }
    },
  );

  it("handles text search failure gracefully", async () => {
    const textError = new Error("DB timeout");
    const failTextSearch = vi.fn().mockRejectedValue(textError);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await vectorGrep({
        pattern: "useCoAgent",
        sourceName: "docs",
        embeddingClient: mockEmbeddingClient as any,
        searchChunksFn: mockSearchChunks,
        textSearchFn: failTextSearch,
      });
      // Semantic search still works
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("useCoAgent");
      expect(result.stderr).toBe("[warning: text search unavailable]\n");
      expect(warn.mock.calls).toEqual([
        ["[bash-grep] Text search failed:", textError],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("returns exit 2 with a generic error when both searches fail", async () => {
    const embedError = new Error("API down");
    const textError = new Error("DB down");
    const failEmbed = {
      embed: vi.fn().mockRejectedValue(embedError),
      embedBatch: vi.fn(),
    };
    const failTextSearch = vi.fn().mockRejectedValue(textError);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await vectorGrep({
        pattern: "useCoAgent",
        sourceName: "docs",
        embeddingClient: failEmbed as any,
        searchChunksFn: vi.fn().mockResolvedValue([]),
        textSearchFn: failTextSearch,
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe(
        "grep: search unavailable. Please try again later.\n",
      );
      expect(result.stdout).toBe("");
      // Both original errors stay server-side.
      expect(warn.mock.calls).toEqual([
        ["[bash-grep] Semantic search failed:", embedError],
        ["[bash-grep] Text search failed:", textError],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("deduplicates results by chunk ID", async () => {
    const sharedResult = {
      id: 99,
      source_name: "docs",
      source_url: null,
      title: "Shared",
      content: "useCoAgent is used here.",
      repo_url: null,
      file_path: "guides/shared.mdx",
      start_line: 1,
      end_line: 5,
      language: null,
      similarity: 0.85,
    };
    const dupeSearch = vi.fn().mockResolvedValue([sharedResult]);
    const dupeText = vi
      .fn()
      .mockResolvedValue([{ ...sharedResult, similarity: 0.0 }]);
    const result = await vectorGrep({
      pattern: "useCoAgent",
      sourceName: "docs",
      embeddingClient: mockEmbeddingClient as any,
      searchChunksFn: dupeSearch,
      textSearchFn: dupeText,
    });
    // Should only appear once despite being in both result sets
    const matches = result.stdout
      .split("\n")
      .filter((l) => l.includes("shared.mdx"));
    expect(matches.length).toBe(1);
  });

  it("filters out chunks that dont actually contain the pattern", async () => {
    const irrelevantResult = {
      id: 50,
      source_name: "docs",
      source_url: null,
      title: "Irrelevant",
      content: "This talks about something else entirely.",
      repo_url: null,
      file_path: "guides/other.mdx",
      start_line: 1,
      end_line: 3,
      language: null,
      similarity: 0.8,
    };
    const search = vi.fn().mockResolvedValue([irrelevantResult]);
    const result = await vectorGrep({
      pattern: "useCoAgent",
      sourceName: "docs",
      embeddingClient: mockEmbeddingClient as any,
      searchChunksFn: search,
      textSearchFn: vi.fn().mockResolvedValue([]),
    });
    expect(result.exitCode).toBe(1); // No actual content match
  });
});
