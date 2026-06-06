import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { chunkMarkdown } from "../indexing/chunking/markdown.js";
import { inlineSnippetImports } from "../indexing/chunking/snippets.js";
import type { SourceConfig } from "../types.js";

// Helper to build a minimal markdown SourceConfig.
function mkConfig(
  overrides: { target_tokens?: number; overlap_tokens?: number } = {},
): SourceConfig {
  return {
    name: "test",
    type: "markdown",
    path: "/tmp",
    file_patterns: ["**/*.mdx"],
    chunk: {
      target_tokens: overrides.target_tokens,
      overlap_tokens: overrides.overlap_tokens,
    },
  } as SourceConfig;
}

/**
 * Build a CopilotKit-style docs tree in a temp dir:
 *
 *   <root>/docs/snippets/<snippetRelPath>
 *   <root>/docs/content/docs/<hostRelPath>
 *
 * The `@/` alias maps to the docs project root (`<root>/docs`), so
 * `@/snippets/foo.mdx` resolves to `<root>/docs/snippets/foo.mdx`.
 *
 * Returns the absolute path of the host file.
 */
function buildDocsTree(
  root: string,
  hostRelPath: string,
  hostContent: string,
  snippets: Record<string, string>,
): string {
  const docsRoot = path.join(root, "docs");
  for (const [rel, body] of Object.entries(snippets)) {
    const abs = path.join(docsRoot, "snippets", rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, "utf-8");
  }
  const hostAbs = path.join(docsRoot, "content", "docs", hostRelPath);
  fs.mkdirSync(path.dirname(hostAbs), { recursive: true });
  fs.writeFileSync(hostAbs, hostContent, "utf-8");
  return hostAbs;
}

describe("inlineSnippetImports", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pf-snippet-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("inlines a self-closing snippet component referenced via @/ alias", () => {
    const snippetBody =
      "## Overview\n\nCopilotKit V2 consolidates the frontend into a single package.";
    const hostContent = [
      "---",
      "title: Migrate to V2",
      "---",
      'import MigrateToV2 from "@/snippets/shared/troubleshooting/migrate-to-v2.mdx";',
      "",
      "<MigrateToV2 components={props.components} />",
      "",
    ].join("\n");

    const hostAbs = buildDocsTree(
      tmp,
      "(root)/migration-guides/migrate-to-v2.mdx",
      hostContent,
      { "shared/troubleshooting/migrate-to-v2.mdx": snippetBody },
    );

    const result = inlineSnippetImports(hostContent, hostAbs);

    expect(result).toContain(
      "CopilotKit V2 consolidates the frontend into a single package",
    );
    // The import statement and JSX usage should no longer be present
    expect(result).not.toContain('from "@/snippets');
    expect(result).not.toContain("<MigrateToV2");
  });

  it("recursively inlines snippets that import other snippets (bounded)", () => {
    const inner = "### Inner Snippet\n\nDeeply nested inlined content here.";
    const outer = [
      "## Outer Snippet",
      "",
      'import Inner from "@/snippets/inner.mdx";',
      "",
      "<Inner />",
      "",
    ].join("\n");
    const hostContent = [
      "---",
      "title: Host",
      "---",
      'import Outer from "@/snippets/outer.mdx";',
      "",
      "<Outer />",
    ].join("\n");

    const hostAbs = buildDocsTree(tmp, "guide.mdx", hostContent, {
      "outer.mdx": outer,
      "inner.mdx": inner,
    });

    const result = inlineSnippetImports(hostContent, hostAbs);

    expect(result).toContain("Outer Snippet");
    expect(result).toContain("Deeply nested inlined content here");
  });

  it("leaves the original usage and skips when the snippet file is missing", () => {
    const hostContent = [
      'import Missing from "@/snippets/does-not-exist.mdx";',
      "",
      "<Missing />",
      "",
      "Body text after.",
    ].join("\n");

    const hostAbs = buildDocsTree(tmp, "guide.mdx", hostContent, {});

    // Must not throw, and must not lose the rest of the document.
    const result = inlineSnippetImports(hostContent, hostAbs);
    expect(result).toContain("Body text after.");
  });

  it("preserves prose between a self-closing and a paired use of the same snippet", () => {
    const snippetBody = "## Snippet Body\n\nReusable inlined snippet content.";
    const hostContent = [
      "---",
      "title: Host",
      "---",
      'import Reused from "@/snippets/reused.mdx";',
      "",
      "<Reused />",
      "",
      "PROSE-BETWEEN-USES should not be deleted.",
      "",
      "<Reused>ignored inner</Reused>",
      "",
    ].join("\n");

    const hostAbs = buildDocsTree(tmp, "guide.mdx", hostContent, {
      "reused.mdx": snippetBody,
    });

    const result = inlineSnippetImports(hostContent, hostAbs);

    // The between-text must survive (regression: paired regex used to swallow
    // from the self-closing tag through the first closing tag, deleting it).
    expect(result).toContain("PROSE-BETWEEN-USES should not be deleted.");
    // Both uses must be replaced by the snippet body.
    expect(result).not.toContain("<Reused");
    expect(result).not.toContain("ignored inner");
    const bodyOccurrences =
      result.split("Reusable inlined snippet content.").length - 1;
    expect(bodyOccurrences).toBe(2);
  });

  it("guards against import cycles", () => {
    const a = ['import B from "@/snippets/b.mdx";', "", "A-body", "<B />"].join(
      "\n",
    );
    const b = ['import A from "@/snippets/a.mdx";', "", "B-body", "<A />"].join(
      "\n",
    );
    const hostContent = ['import A from "@/snippets/a.mdx";', "", "<A />"].join(
      "\n",
    );

    const hostAbs = buildDocsTree(tmp, "guide.mdx", hostContent, {
      "a.mdx": a,
      "b.mdx": b,
    });

    // Should terminate (not infinite-loop) and include the bodies it can.
    const result = inlineSnippetImports(hostContent, hostAbs);
    expect(result).toContain("A-body");
  });
});

describe("chunkMarkdown with snippet inlining", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pf-snippet-chunk-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("produces chunk text containing the inlined snippet body", () => {
    const snippetBody =
      "## Overview\n\nCopilotKit V2 consolidates the frontend into a single package. Both hooks and UI components are now exported from one place.";
    const hostContent = [
      "---",
      "title: Migrate to V2",
      "---",
      'import MigrateToV2 from "@/snippets/shared/troubleshooting/migrate-to-v2.mdx";',
      "",
      "<MigrateToV2 components={props.components} />",
      "",
    ].join("\n");

    const hostAbs = buildDocsTree(
      tmp,
      "(root)/migration-guides/migrate-to-v2.mdx",
      hostContent,
      { "shared/troubleshooting/migrate-to-v2.mdx": snippetBody },
    );

    const chunks = chunkMarkdown(hostContent, hostAbs, mkConfig());

    // Before the fix this page indexes as empty (0 chunks); after, the snippet
    // body must be present in the produced chunk text.
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const joined = chunks.map((c) => c.content).join("\n");
    expect(joined).toContain(
      "CopilotKit V2 consolidates the frontend into a single package",
    );
  });
});
