import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatFaqResults } from "../mcp/tools/knowledge.js";
import type { FaqChunkResult } from "../types.js";

// Test the formatter directly (no need to mock DB for this)
function makeFaqResult(overrides: Partial<FaqChunkResult>): FaqChunkResult {
  return {
    id: 1,
    source_name: "slack-support",
    source_url: "https://slack.com/archives/C123/p456",
    title: "How to configure headers?",
    content:
      "Q: How to configure headers?\n\nA: Use the headers property in the constructor.",
    repo_url: null,
    file_path: "C123:456:0",
    start_line: null,
    end_line: null,
    language: null,
    similarity: 0.92,
    metadata: { channel: "C123", confidence: 0.85 },
    confidence: 0.85,
    ...overrides,
  };
}

describe("formatFaqResults", () => {
  it('returns "No FAQ results found." for empty array', () => {
    expect(formatFaqResults([])).toBe("No FAQ results found.");
  });

  it("formats a single result with QUESTION/ANSWER/SOURCE/CONFIDENCE", () => {
    const results = [makeFaqResult({})];
    const output = formatFaqResults(results);
    expect(output).toContain("Q&A 1");
    expect(output).toContain("QUESTION: How to configure headers?");
    expect(output).toContain(
      "ANSWER: Use the headers property in the constructor.",
    );
    expect(output).toContain("SOURCE: https://slack.com/archives/C123/p456");
    expect(output).toContain("CONFIDENCE: 0.85");
  });

  it("formats multiple results with numbered headers", () => {
    const results = [
      makeFaqResult({ id: 1, title: "Q1", confidence: 0.9 }),
      makeFaqResult({ id: 2, title: "Q2", confidence: 0.8 }),
    ];
    const output = formatFaqResults(results);
    expect(output).toContain("Q&A 1");
    expect(output).toContain("Q&A 2");
  });

  it("uses file_path as SOURCE fallback when source_url is null", () => {
    const results = [
      makeFaqResult({ source_url: null, file_path: "C123:456:0" }),
    ];
    const output = formatFaqResults(results);
    expect(output).toContain("SOURCE: C123:456:0");
  });

  it("uses (untitled) when title is null", () => {
    const results = [makeFaqResult({ title: null })];
    const output = formatFaqResults(results);
    expect(output).toContain("QUESTION: (untitled)");
  });

  it("extracts answer from Q/A format content", () => {
    const results = [
      makeFaqResult({
        content: "Q: What is X?\n\nA: X is a thing that does Y and Z.",
      }),
    ];
    const output = formatFaqResults(results);
    expect(output).toContain("ANSWER: X is a thing that does Y and Z.");
  });

  it("falls back to full content when Q/A format not found", () => {
    const results = [
      makeFaqResult({
        content: "Just some plain text answer.",
      }),
    ];
    const output = formatFaqResults(results);
    expect(output).toContain("ANSWER: Just some plain text answer.");
  });
});

// Test the tool registration with mocked dependencies
describe("registerKnowledgeTool", () => {
  const mockQuery = vi.fn();
  const mockEmbed = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    mockQuery.mockReset();
    mockEmbed.mockReset();
  });

  it("registers a tool with the correct name and description", async () => {
    // Mock DB
    vi.doMock("../../db/queries.js", () => ({
      getFaqChunks: mockQuery,
      searchChunks: vi.fn(),
    }));

    const { registerKnowledgeTool } = await import("../mcp/tools/knowledge.js");

    const toolArgs: Array<[string, string, unknown, unknown]> = [];
    const mockServer = {
      tool: (...args: unknown[]) => {
        toolArgs.push(args as [string, string, unknown, unknown]);
      },
    };

    const toolConfig = {
      name: "get-faq",
      type: "knowledge" as const,
      description: "Get FAQ content",
      sources: ["slack-support"],
      min_confidence: 0.7,
      default_limit: 20,
      max_limit: 100,
    };

    const embeddingClient = { embed: mockEmbed };

    registerKnowledgeTool(
      mockServer as never,
      embeddingClient as never,
      toolConfig,
    );

    expect(toolArgs).toHaveLength(1);
    expect(toolArgs[0][0]).toBe("get-faq");
    expect(toolArgs[0][1]).toBe("Get FAQ content");
  });
});
