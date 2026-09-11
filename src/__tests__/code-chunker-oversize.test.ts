import { describe, it, expect } from "vitest";
import { chunkCode } from "../indexing/chunking/code.js";
import type { SourceConfig } from "../types.js";

// Regression for the ten-day `code`-source wedge on mcp.copilotkit.ai.
//
// The named failing item was CopilotKit's
// packages/web-inspector/dev/threads-state-lab.ts. Production logged:
//
//   [pipeline:code] Failed to index packages/web-inspector/dev/threads-state-lab.ts:
//     BadRequestError: 400 Invalid 'input[2]': maximum input length is 8192 tokens.
//
// `input[2]` — the THIRD chunk — was 35,964 characters covering lines 159-1121
// of a 1121-line file, because the chunker's block-state tracker got stuck.
// The trigger is line 262:
//
//   wsUrl: `ws://127.0.0.1:5177/inspector-lab-runtime/${key}/realtime`,
//
// `stripStringsAndLineComments` tracked ' and " but NOT ` , so the `//` inside
// the template literal read as a line comment. The rest of the line (including
// the CLOSING backtick) was discarded, leaving an ODD backtick count, so the
// tracker latched `inTemplateString = true` and never cleared it. Every
// subsequent blank line was rejected as a split point, so the remaining ~960
// lines collapsed into one chunk that blew past the embedding model's token
// limit — which failed the item, held the source's state token, and froze the
// index.
//
// Two invariants are pinned here:
//   1. a `//` (or `/*`) inside a template literal must not latch the tracker;
//   2. no chunk may exceed the hard size backstop, whatever the source looks
//      like — a chunker that cannot find split points must still bound output.

const CODE_CONFIG = {
  name: "code",
  type: "code",
  chunk: { target_lines: 80, overlap_lines: 10 },
} as unknown as SourceConfig;

/** Reproduce the production file's shape: a URL-in-template-literal, then a
 *  long tail of ordinary blank-line-separated declarations. */
function buildFileWithUrlInTemplateLiteral(tailBlocks: number): string {
  const head = [
    "const ENABLE_URL =",
    '  "https://intelligence.copilotkit.ai/intelligence/enable";',
    "",
    "function runtimeInfo(key: string) {",
    "  return {",
    "    wsUrl: `ws://127.0.0.1:5177/inspector-lab-runtime/${key}/realtime`,",
    "  };",
    "}",
    "",
  ];
  const tail: string[] = [];
  for (let i = 0; i < tailBlocks; i++) {
    tail.push(
      `export const SCENARIO_${i} = {`,
      `  id: "scenario-${i}",`,
      `  label: "Scenario number ${i} with a reasonably long descriptive label",`,
      `  description: "Fixture payload ${i} used by the threads state lab dev harness",`,
      "};",
      "",
    );
  }
  return head.concat(tail).join("\n");
}

describe("code chunker: template literals and the hard size backstop", () => {
  it("does not treat `//` inside a template literal as a line comment", () => {
    // 200 tail blocks = 1200 lines. With the bug, EVERY line after the wsUrl
    // line is swallowed into a single chunk because the tracker believes it is
    // still inside a template literal, so no blank line qualifies as a split
    // point.
    const content = buildFileWithUrlInTemplateLiteral(200);
    const chunks = chunkCode(
      content,
      "packages/web-inspector/dev/threads-state-lab.ts",
      CODE_CONFIG,
    );

    // ~1200 lines at target_lines 80 must produce many chunks, not two.
    expect(chunks.length).toBeGreaterThan(10);

    // And no single chunk may swallow the whole tail.
    const largest = Math.max(...chunks.map((c) => c.content.length));
    expect(largest).toBeLessThan(15_000);
  });

  it("bounds chunk size even when the source offers NO split points", () => {
    // A file with no blank lines at all: the mechanical fallback splits on
    // target_lines, but nothing bounds the CHARACTER size of those lines. A
    // single 80-line range of long lines still overflows the embedding model.
    const longLine = "  ".concat("const x = ", '"'.padEnd(600, "y"), '";');
    const content = Array.from({ length: 400 }, () => longLine).join("\n");
    const chunks = chunkCode(
      content,
      "packages/dense/no-blank-lines.ts",
      CODE_CONFIG,
    );

    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(12_000);
    }
  });

  it("still splits an ordinary file on blank-line boundaries", () => {
    // Guard against "fixed the latch by never entering template state at all".
    const content = buildFileWithUrlInTemplateLiteral(40);
    const chunks = chunkCode(content, "packages/a/b.ts", CODE_CONFIG);
    expect(chunks.length).toBeGreaterThan(1);
    // Chunks stay line-addressable and in order.
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startLine ?? 0).toBeGreaterThan(
        chunks[i - 1].startLine ?? 0,
      );
    }
  });

  it("keeps a genuine multi-line template literal intact as one region", () => {
    // The latch exists for a reason: a blank line INSIDE a template literal is
    // not a safe split point. Fixing the `//` case must not lose that.
    const content = [
      "const q = `",
      "SELECT 1",
      "",
      "FROM t",
      "`;",
      "",
      "const after = 1;",
      "",
    ].join("\n");
    const chunks = chunkCode(content, "a.ts", CODE_CONFIG);
    // Short file — one chunk, and crucially no crash / no latch leaking out.
    expect(chunks).toHaveLength(1);
  });
});
