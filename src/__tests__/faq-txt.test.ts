import { describe, it, expect } from "vitest";
import { generateFaqTxt } from "../faq-txt.js";
import type { FaqChunkResult } from "../types.js";

function makeFaqChunk(
  overrides: Partial<FaqChunkResult> & {
    source_name: string;
    content: string;
    confidence: number;
  },
): FaqChunkResult {
  return {
    id: 1,
    source_url: null,
    title: null,
    repo_url: null,
    file_path: "test",
    start_line: null,
    end_line: null,
    language: null,
    similarity: 0,
    metadata: {},
    ...overrides,
  };
}

describe("generateFaqTxt", () => {
  it("generates header with server name", () => {
    const result = generateFaqTxt([], "TestServer", []);
    expect(result).toContain("# TestServer — Frequently Asked Questions");
  });

  it('shows "No FAQ content available" when no chunks', () => {
    const result = generateFaqTxt([], "TestServer", [
      { name: "slack-support", confidenceThreshold: 0.7 },
    ]);
    expect(result).toContain("No FAQ content available yet.");
  });

  it("groups Q&A pairs by source", () => {
    const chunks: FaqChunkResult[] = [
      makeFaqChunk({
        source_name: "slack-support",
        content: "Q: Question 1?\n\nA: Answer 1.",
        confidence: 0.9,
      }),
      makeFaqChunk({
        source_name: "slack-general",
        content: "Q: Question 2?\n\nA: Answer 2.",
        confidence: 0.8,
      }),
    ];
    const sources = [
      { name: "slack-support", confidenceThreshold: 0.7 },
      { name: "slack-general", confidenceThreshold: 0.7 },
    ];
    const result = generateFaqTxt(chunks, "TestServer", sources);
    expect(result).toContain("## slack-support");
    expect(result).toContain("## slack-general");
    expect(result).toContain("Q: Question 1?");
    expect(result).toContain("Q: Question 2?");
  });

  it("preserves source order from config", () => {
    const chunks: FaqChunkResult[] = [
      makeFaqChunk({
        source_name: "slack-general",
        content: "Q: Q2?\n\nA: A2.",
        confidence: 0.8,
      }),
      makeFaqChunk({
        source_name: "slack-support",
        content: "Q: Q1?\n\nA: A1.",
        confidence: 0.9,
      }),
    ];
    const sources = [
      { name: "slack-support", confidenceThreshold: 0.7 },
      { name: "slack-general", confidenceThreshold: 0.7 },
    ];
    const result = generateFaqTxt(chunks, "TestServer", sources);
    const supportIdx = result.indexOf("## slack-support");
    const generalIdx = result.indexOf("## slack-general");
    expect(supportIdx).toBeLessThan(generalIdx);
  });

  it("skips sources with no chunks", () => {
    const chunks: FaqChunkResult[] = [
      makeFaqChunk({
        source_name: "slack-support",
        content: "Q: Q1?\n\nA: A1.",
        confidence: 0.9,
      }),
    ];
    const sources = [
      { name: "slack-support", confidenceThreshold: 0.7 },
      { name: "slack-empty", confidenceThreshold: 0.7 },
    ];
    const result = generateFaqTxt(chunks, "TestServer", sources);
    expect(result).toContain("## slack-support");
    expect(result).not.toContain("## slack-empty");
  });

  it("includes multiple Q&A pairs from same source", () => {
    const chunks: FaqChunkResult[] = [
      makeFaqChunk({
        id: 1,
        source_name: "slack-support",
        content: "Q: First?\n\nA: First answer.",
        confidence: 0.9,
      }),
      makeFaqChunk({
        id: 2,
        source_name: "slack-support",
        content: "Q: Second?\n\nA: Second answer.",
        confidence: 0.8,
      }),
    ];
    const sources = [{ name: "slack-support", confidenceThreshold: 0.7 }];
    const result = generateFaqTxt(chunks, "TestServer", sources);
    expect(result).toContain("Q: First?");
    expect(result).toContain("Q: Second?");
  });
});
