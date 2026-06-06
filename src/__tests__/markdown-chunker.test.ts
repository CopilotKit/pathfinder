import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chunkMarkdown } from "../indexing/chunking/markdown.js";
import type { SourceConfig } from "../types.js";

// Helper to build a minimal SourceConfig for markdown chunking
function mkConfig(
  overrides: { target_tokens?: number; overlap_tokens?: number } = {},
): SourceConfig {
  return {
    name: "test",
    type: "markdown",
    path: "/tmp",
    file_patterns: ["*.md"],
    chunk: {
      target_tokens: overrides.target_tokens,
      overlap_tokens: overrides.overlap_tokens,
    },
  } as SourceConfig;
}

describe("chunkMarkdown", () => {
  // ── Empty / whitespace input ────────────────────────────────────────

  it("returns empty array for empty string", () => {
    expect(chunkMarkdown("", "test.md", mkConfig())).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(chunkMarkdown("   \n\n  ", "test.md", mkConfig())).toEqual([]);
  });

  it("returns empty array for null/undefined content", () => {
    expect(chunkMarkdown(null as any, "test.md", mkConfig())).toEqual([]);
    expect(chunkMarkdown(undefined as any, "test.md", mkConfig())).toEqual([]);
  });

  it("returns empty array when content is only frontmatter with no body", () => {
    const content = "---\ntitle: Empty\n---\n";
    expect(chunkMarkdown(content, "test.md", mkConfig())).toEqual([]);
  });

  // ── Frontmatter parsing ─────────────────────────────────────────────

  it("extracts title from frontmatter", () => {
    const content = "---\ntitle: My Title\n---\n\nSome body text here.";
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0].title).toBe("My Title");
  });

  it("extracts title from quoted frontmatter", () => {
    const content = '---\ntitle: "Quoted Title"\n---\n\nBody text.';
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    expect(chunks[0].title).toBe("Quoted Title");
  });

  it("extracts title from single-quoted frontmatter", () => {
    const content = "---\ntitle: 'Single Quoted'\n---\n\nBody text.";
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    expect(chunks[0].title).toBe("Single Quoted");
  });

  it("falls back to first heading when no frontmatter title", () => {
    const content = "# My Heading\n\nSome content.";
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    expect(chunks[0].title).toBe("My Heading");
  });

  it('empty double-quoted frontmatter title (title: "") falls back to the heading', () => {
    // The frontmatter regex's two independent `["']?` plus a `(.+?)` that needs
    // ≥1 char turns `title: ""` into the stray quote `"`, which is truthy and
    // defeats the heading/filename fallback. An empty title must be treated as
    // ABSENT so the first heading wins.
    const content = '---\ntitle: ""\n---\n\n# Real Heading\n\nBody text.';
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    expect(chunks[0].title).toBe("Real Heading");
    expect(chunks[0].title).not.toBe('"');
  });

  it("empty single-quoted frontmatter title (title: '') falls back to the heading", () => {
    const content = "---\ntitle: ''\n---\n\n# Real Heading\n\nBody text.";
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    expect(chunks[0].title).toBe("Real Heading");
    expect(chunks[0].title).not.toBe("'");
  });

  it("bare empty frontmatter title (title:) falls back to the heading", () => {
    const content = "---\ntitle:\n---\n\n# Real Heading\n\nBody text.";
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    expect(chunks[0].title).toBe("Real Heading");
  });

  it("empty frontmatter title falls back to filename when no heading", () => {
    const content = '---\ntitle: ""\n---\n\nJust prose, no heading at all.';
    const chunks = chunkMarkdown(content, "docs/guide.md", mkConfig());
    expect(chunks[0].title).toBe("guide.md");
  });

  it("preserves internal quotes in a frontmatter title (no balanced wrap)", () => {
    // `title: 5'6" tall` has internal quotes but is not wrapped in balanced
    // surrounding quotes, so the value is kept literal (no edge-quote stripping).
    const content = "---\ntitle: 5'6\" tall\n---\n\nBody text.";
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    expect(chunks[0].title).toBe("5'6\" tall");
  });

  it("falls back to filename when no title or heading", () => {
    const content = "Just some plain text without any heading.";
    const chunks = chunkMarkdown(content, "docs/guide.md", mkConfig());
    expect(chunks[0].title).toBe("guide.md");
  });

  it("does not adopt a TAB-indented `#` line as the title (CommonMark: tab = code)", () => {
    // Per CommonMark a leading tab counts as 4 columns, so `\t# Heading` is an
    // indented code line, NOT an ATX heading — it must never be adopted as the
    // title (the title is embedded into the retrieval vector). The other heading
    // detectors allow only 0-3 *spaces*; the title extractor must agree. The
    // tab-indented line is placed AFTER a leading prose paragraph (not at the
    // very start) so the document-leading-whitespace trim does not strip the tab
    // before extraction — the regex itself must reject the tab indent. With no
    // real heading anywhere, the title falls back to the filename.
    const content = [
      "Intro prose with no heading at all here.",
      "",
      "\t# Tabbed line is code, not a heading",
      "",
      "More body text.",
    ].join("\n");
    const chunks = chunkMarkdown(content, "docs/guide.md", mkConfig());
    expect(chunks[0].title).toBe("guide.md");
    expect(chunks[0].title).not.toBe("Tabbed line is code, not a heading");
  });

  it("still adopts a 0-3-SPACE-indented `#` line as the title", () => {
    // The complement of the tab case: 1-3 leading *spaces* before the hashes is
    // a valid CommonMark ATX heading and must still be adopted as the title.
    // Also prose-first so the space indent survives to the extractor and the
    // 0-3-space path is genuinely exercised (not trimmed to column 0).
    const content = [
      "Intro prose with no heading at all here.",
      "",
      "   # Three Space Indented Heading",
      "",
      "Body under the heading.",
    ].join("\n");
    const chunks = chunkMarkdown(content, "docs/guide.md", mkConfig());
    expect(chunks[0].title).toBe("Three Space Indented Heading");
  });

  it("does not promote a TAB-indented `#` line at the DOCUMENT START to a heading", () => {
    // Regression: stripMdx's final `.trim()` stripped the leading whitespace of
    // the document's first content line BEFORE the spaces-only heading detector
    // ran, so a doc that OPENS with `\t# X` (CommonMark indented code, NOT a
    // heading) had its tab removed and was wrongly promoted to title/headingPath.
    // The trim must strip only blank lines, preserving the first line's indent.
    const content = "\t# NotAHeading\n\nbody text here.";
    const chunks = chunkMarkdown(content, "docs/guide.md", mkConfig());
    expect(chunks[0].title).toBe("guide.md");
    expect(chunks[0].title).not.toBe("NotAHeading");
    expect(chunks[0].headingPath).toEqual([]);
  });

  it("does not promote a 4-space-indented `#` line at the DOCUMENT START to a heading", () => {
    // 4 leading spaces = CommonMark indented code, not a heading — even when it
    // is the document's first line (where the leading trim used to strip it).
    const content = "    # FourSpaces\n\nbody text here.";
    const chunks = chunkMarkdown(content, "docs/guide.md", mkConfig());
    expect(chunks[0].title).toBe("guide.md");
    expect(chunks[0].title).not.toBe("FourSpaces");
    expect(chunks[0].headingPath).toEqual([]);
  });

  it("still adopts a 2-space-indented `#` line at the DOCUMENT START as a heading", () => {
    // The valid complement: 0–3 leading spaces is a real ATX heading, including
    // when it is the document's very first line. Preserving the first line's
    // indent must not break this.
    const content = "  # TwoSpaces\n\nbody text here.";
    const chunks = chunkMarkdown(content, "docs/guide.md", mkConfig());
    expect(chunks[0].title).toBe("TwoSpaces");
    expect(chunks[0].headingPath).toContain("TwoSpaces");
  });

  it("falls back to full path when filename extraction fails", () => {
    const content = "Plain text.";
    const chunks = chunkMarkdown(content, "noext", mkConfig());
    expect(chunks[0].title).toBe("noext");
  });

  it("strips frontmatter from chunk content", () => {
    const content = "---\ntitle: Test\nother: value\n---\n\nActual body.";
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    expect(chunks[0].content).not.toContain("---");
    expect(chunks[0].content).toContain("Actual body");
  });

  // ── MDX stripping ───────────────────────────────────────────────────

  it("strips import statements", () => {
    const content =
      "import Foo from 'bar';\n\nSome text after the removed line.";
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    expect(chunks[0].content).not.toContain("from 'bar'");
    expect(chunks[0].content).toContain("Some text after the removed line");
  });

  it("strips self-closing JSX tags", () => {
    const content =
      'Before\n\n<Component prop="val" />\n\nAfter the component.';
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    expect(chunks[0].content).not.toContain("<Component");
    expect(chunks[0].content).toContain("Before");
    expect(chunks[0].content).toContain("After the component");
  });

  it("strips JSX wrapper tags but keeps inner content", () => {
    const content = "<Wrapper>\nInner content here\n</Wrapper>";
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    expect(chunks[0].content).toContain("Inner content here");
    expect(chunks[0].content).not.toContain("<Wrapper");
    expect(chunks[0].content).not.toContain("</Wrapper");
  });

  it("strips nested JSX tags", () => {
    const content = "<Outer><Inner>Deep content</Inner></Outer>";
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    expect(chunks[0].content).toContain("Deep content");
    expect(chunks[0].content).not.toContain("<Outer");
    expect(chunks[0].content).not.toContain("<Inner");
  });

  it("strips member-expression JSX tags but keeps inner content", () => {
    const content = "<Tabs.Tab>\nTabbed content here\n</Tabs.Tab>";
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    expect(chunks[0].content).toContain("Tabbed content here");
    expect(chunks[0].content).not.toContain("<Tabs.Tab");
    expect(chunks[0].content).not.toContain("</Tabs.Tab");
  });

  it("strips self-closing member-expression JSX tags", () => {
    const content = 'Before\n\n<motion.div prop="x" />\n\nAfter the motion.';
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    expect(chunks[0].content).not.toContain("<motion.div");
    expect(chunks[0].content).toContain("Before");
    expect(chunks[0].content).toContain("After the motion");
  });

  it("strips self-closing JSX tags with underscores in the name", () => {
    const content = "Before\n\n<Foo_Bar />\n\nAfter the foobar.";
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    expect(chunks[0].content).not.toContain("<Foo_Bar");
    expect(chunks[0].content).toContain("Before");
    expect(chunks[0].content).toContain("After the foobar");
  });

  it("strips paired JSX tags with dollar-sign names but keeps inner content", () => {
    const content = "<Motion$ >\nDollar inner content\n</Motion$>";
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    expect(chunks[0].content).toContain("Dollar inner content");
    expect(chunks[0].content).not.toContain("<Motion$");
    expect(chunks[0].content).not.toContain("</Motion$");
  });

  // ── MDX stripping: fence- and code-span-awareness ───────────────────
  //
  // stripMdx ran its import/JSX strip passes over the ENTIRE body before any
  // fence segmentation, so code/imports/JSX INSIDE fenced blocks (the highest-
  // value retrieval content Pathfinder serves) and inside inline code spans was
  // destroyed. The strip passes must be masked by fences (and inline spans).

  it("preserves an import statement inside a fenced code block verbatim", () => {
    const content = [
      "## How to import",
      "",
      "```ts",
      "import { Client } from '@my/sdk';",
      "const c = new Client();",
      "```",
      "",
      "Prose after.",
    ].join("\n");
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    const joined = chunks.map((c) => c.content).join("\n");
    // The fenced import must survive verbatim, NOT be stripped as an MDX import.
    expect(joined).toContain("import { Client } from '@my/sdk';");
    expect(joined).toContain("const c = new Client();");
  });

  it("preserves JSX (with `>` in an attribute value) inside a fenced block", () => {
    const content = [
      "## Render",
      "",
      "```tsx",
      'const el = <Callout type="a>b">hello</Callout>;',
      "```",
      "",
      "End.",
    ].join("\n");
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    const joined = chunks.map((c) => c.content).join("\n");
    expect(joined).toContain('const el = <Callout type="a>b">hello</Callout>;');
  });

  it("preserves JSX-looking content inside an inline code span", () => {
    const content =
      "## Inline\n\nUse `<div>x</div>` and `<Comp prop='y' />` in your text.";
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    const joined = chunks.map((c) => c.content).join("\n");
    expect(joined).toContain("`<div>x</div>`");
    expect(joined).toContain("`<Comp prop='y' />`");
  });

  it("does not treat a col-0 inline triple-backtick span as a code fence (drops later headings)", () => {
    // CommonMark §4.5: a backtick code-fence info string may NOT contain a
    // backtick. A col-0 line like ```js``` text is therefore an INLINE code
    // span, not a fence opener. The buggy matchFenceOpen opened a phantom fence
    // with no closing line, running it to EOF and masking every following
    // heading as "code" — so `## Beta` was dropped from the heading path. Each
    // section is padded past the target so the splitter cuts on the headings and
    // `## Beta` opens its own chunk (its heading then enters that chunk's path).
    const big = "Word ".repeat(120).trim();
    const content = [
      "## Alpha",
      "",
      big,
      "",
      "```js``` quick inline example, prose after.",
      "",
      "## Beta",
      "",
      big,
    ].join("\n");
    const chunks = chunkMarkdown(
      content,
      "test.md",
      mkConfig({ target_tokens: 100, overlap_tokens: 0 }),
    );
    const allHeadings = new Set(chunks.flatMap((c) => c.headingPath ?? []));
    // The later heading must survive (not be swallowed by a phantom fence).
    expect(allHeadings.has("Beta")).toBe(true);
    // The inline span line is preserved verbatim (not masked away as a fence).
    const joined = chunks.map((c) => c.content).join("\n");
    expect(joined).toContain("```js``` quick inline example, prose after.");
    // And no chunk may carry a half-open fence. Counting applies the CommonMark
    // info-string rule (a backtick "fence" whose info string contains a backtick
    // is an INLINE span, not a fence opener), so the inline ```js``` line is not
    // miscounted as an unbalanced delimiter.
    const realFenceCount = (text: string): number => {
      let count = 0;
      for (const line of text.split("\n")) {
        const m = line.match(/^ {0,3}(`{3,}|~{3,})([^\n]*)$/);
        if (m && !m[2].includes(m[1][0])) count++;
      }
      return count;
    };
    for (const chunk of chunks) {
      expect(realFenceCount(chunk.content) % 2).toBe(0);
    }
  });

  it("does not mispair backtick delimiters around a stray backtick (destroys inline code)", () => {
    // maskInlineCode must pair an opening run of N backticks with the next run
    // of EXACTLY N backticks (CommonMark). A stray/odd backtick between two
    // genuine single-backtick spans must not cause the second span's content to
    // be left unmasked and then gutted by the JSX strip pass. Both `<Foo/>` and
    // `<Bar/>` must survive verbatim.
    const content = [
      "## H",
      "",
      "Use `<Foo/>` here.",
      "",
      "Then a stray ` backtick in prose.",
      "",
      "And `<Bar/>` there.",
    ].join("\n");
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    const joined = chunks.map((c) => c.content).join("\n");
    expect(joined).toContain("<Foo/>");
    expect(joined).toContain("<Bar/>");
  });

  it("does not pair inline-code backticks across an ATX heading block boundary", () => {
    // Per CommonMark, block parsing precedes inline parsing: an ATX heading is
    // its own block and an inline code span cannot cross it. maskInlineCode runs
    // AFTER maskHeadingLines (heading lines are already opaque sentinel tokens),
    // so the closer-search must treat a heading-line boundary as a hard stop —
    // mirroring the existing blank-line (paragraph break) guard. Otherwise the
    // lone backtick on the `alpha` line wrongly pairs with the lone backtick on
    // the `beta` line, forming a spurious code span ACROSS `## Middle Heading`;
    // that span masks `<StripA />` so it survives the JSX strip. Correctly, the
    // `alpha`-line backtick has no valid same-block closer (the heading ends the
    // block), so it is literal text and the prose JSX `<StripA />` must be
    // stripped. `<StripB />` (after the heading) is on its own block and is
    // always stripped.
    const content = [
      "## H",
      "",
      "alpha ` one and <StripA /> tag",
      "## Middle Heading",
      "beta ` two and <StripB /> tag",
    ].join("\n");
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    const joined = chunks.map((c) => c.content).join("\n");
    // The intervening heading still binds as a heading line (masked verbatim,
    // not swallowed into a spurious cross-heading code span).
    expect(joined).toContain("## Middle Heading");
    // Prose JSX on the lines adjacent to the heading is stripped (the spurious
    // cross-heading code span must not protect it).
    expect(joined).not.toContain("<StripA />");
    expect(joined).not.toContain("<StripB />");
  });

  it("preserves inline-code JSX across a soft line break with no intervening heading", () => {
    // Control for the cross-heading hard-stop fix: the SAME shape WITHOUT an
    // intervening heading legitimately forms ONE code span — a code span may
    // contain a soft line break, so the two lone backticks pair across the
    // newline and the span content (including its JSX) is correctly preserved.
    // Only a HEADING-line boundary is a hard stop; a soft line break is not.
    const content = [
      "## H",
      "",
      "alpha ` one and <Keep /> tag",
      "beta ` two and <Drop /> tag",
    ].join("\n");
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    const joined = chunks.map((c) => c.content).join("\n");
    // The two lone backticks pair into a span; its inner JSX is preserved.
    expect(joined).toContain("<Keep />");
    // The trailing single backtick has no closer, so prose after it is stripped.
    expect(joined).not.toContain("<Drop />");
  });

  it("does not let a side-effect import delete content up to the next import", () => {
    // `import "./x.css";` (no `from`) must be removed on its own; the lazy
    // `[\s\S]*?from` must NOT jump to the next import's `from`, deleting the
    // heading + prose between the two imports.
    const content = [
      'import "./reset.css";',
      "",
      "## Setup",
      "",
      "Important prose between two imports that must survive.",
      "",
      "import { X } from '@/x';",
      "",
      "Trailing prose.",
    ].join("\n");
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    const joined = chunks.map((c) => c.content).join("\n");
    expect(joined).toContain("Setup");
    expect(joined).toContain(
      "Important prose between two imports that must survive.",
    );
    expect(joined).toContain("Trailing prose.");
    // Both import statements are gone.
    expect(joined).not.toContain('import "./reset.css";');
    expect(joined).not.toContain("import { X } from '@/x';");
  });

  it("does not delete a prose line that merely looks import-like", () => {
    // An English sentence starting with "import" and containing " from " is
    // prose, not an MDX import statement.
    const content =
      'You can import a value from "the library" without ceremony, easily.';
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    expect(chunks[0].content).toContain(
      'You can import a value from "the library" without ceremony, easily.',
    );
  });

  it("does not let a from-import strip span a blank line", () => {
    // The from-import regex uses `\s+` around `from`, and `\s` matches newlines,
    // so `import Config\n\nfrom "y";` is wrongly treated as ONE import statement
    // and the whole `import Config\n\nfrom "y";` span (across the blank line) is
    // deleted. The blank line means it is NOT a single import statement; the
    // inter-token whitespace must forbid a newline so the dangling lines stay as
    // literal text.
    const content = [
      "First real paragraph that must survive.",
      "",
      "import Config",
      "",
      'from "the-module";',
      "",
      "Second real paragraph that must survive.",
    ].join("\n");
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    const joined = chunks.map((c) => c.content).join("\n");
    expect(joined).toContain("First real paragraph that must survive.");
    expect(joined).toContain("Second real paragraph that must survive.");
    // The dangling `import Config` / `from "the-module";` lines span a blank
    // line, so they are NOT a single import statement and must NOT be stripped —
    // the over-broad `\s+from` (with `\s` matching `\n`) deleted the whole span.
    expect(joined).toContain("import Config");
    expect(joined).toContain('from "the-module";');
  });

  it("still strips a normal single-line from-import", () => {
    // Regression guard for the blank-line fix: a real single-line import must
    // still be stripped.
    const content = 'import X from "./y";\n\nProse after the import line.';
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    const joined = chunks.map((c) => c.content).join("\n");
    expect(joined).not.toContain('import X from "./y";');
    expect(joined).toContain("Prose after the import line.");
  });

  it("does not let an unclosed from-import brace swallow following headings/prose", () => {
    // BUG B1: the named-import alternative `\{[^}]*\}` uses `[^}]`, which also
    // matches a newline. An `import {` whose closing `}` is lines away greedily
    // consumes the intervening ATX heading(s) and prose, deleting them silently
    // (no warning). The brace content must be bounded to a single line so a
    // dangling `{` cannot devour subsequent markdown lines.
    const content = [
      "import {",
      "## Eaten Heading",
      "Eaten prose.",
      '} from "@x";',
      "",
      "## Survivor",
      "",
      "Surviving prose.",
    ].join("\n");
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    const joined = chunks.map((c) => c.content).join("\n");
    // The heading + prose that fell between the dangling `{` and its far-away
    // `}` must SURVIVE in served content (they are markdown, not an import).
    expect(joined).toContain("Eaten Heading");
    expect(joined).toContain("Eaten prose.");
    // The "Survivor" heading must NOT become the document title: at the buggy
    // HEAD the brace swallows everything up to `} from "@x";`, so the first
    // surviving heading ("Survivor") is promoted to the title.
    expect(chunks[0].title).not.toBe("Survivor");
    // The real survivor section is still present too.
    expect(joined).toContain("Survivor");
    expect(joined).toContain("Surviving prose.");
  });

  it("strips a TypeScript `import type` declaration", () => {
    // BUG B2: the from-import clause grammar lacks the TS `type` modifier, so
    // `import type { Config } from "x"` (and `import type Foo` / `import type
    // * as NS`) are not stripped and leak into served content. Add an optional
    // `type` modifier after `import`.
    const content = [
      'import type { Config } from "@/types";',
      'import type Foo from "m";',
      'import type * as NS from "m";',
      "",
      "## Section",
      "",
      "Body prose that must survive.",
    ].join("\n");
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    const joined = chunks.map((c) => c.content).join("\n");
    expect(joined).not.toContain("import type { Config }");
    expect(joined).not.toContain("import type Foo");
    expect(joined).not.toContain("import type * as NS");
    // The real content is unaffected.
    expect(joined).toContain("Section");
    expect(joined).toContain("Body prose that must survive.");
  });

  it("strips a self-closing JSX tag whose attribute value contains `>`", () => {
    // OUTSIDE a fence, a self-closing tag must still be stripped even when an
    // attribute value contains `>` (the old `[^>]*` truncated at the inner `>`).
    const content = 'Before\n\n<Callout type="a>b" />\n\nAfter the callout.';
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    expect(chunks[0].content).not.toContain("<Callout");
    expect(chunks[0].content).not.toContain("a>b");
    expect(chunks[0].content).toContain("Before");
    expect(chunks[0].content).toContain("After the callout");
  });

  // ── MDX stripping: heading-awareness (component tags in headings) ────
  //
  // The MDX JSX/import strip passes are GLOBAL regexes that historically ran over
  // ATX heading lines too, deleting a `<Component/>`/`<Tag>..</Tag>` that NAMES a
  // component inside a heading. Since title, headingPath, and served content all
  // derive from the post-strip body, the heading was corrupted everywhere. The
  // strip must treat heading lines as protected regions (like fenced/inline code).

  it("preserves a self-closing component tag in the MIDDLE of an ATX heading", () => {
    const content = "## The <CopilotKit /> Provider\n\nBody text under it.";
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    // Title must retain the tag verbatim (no "The  Provider" with the tag gone).
    expect(chunks[0].title).toBe("The <CopilotKit /> Provider");
    // headingPath entry likewise retains the tag.
    const allHeadings = new Set(chunks.flatMap((c) => c.headingPath ?? []));
    expect(allHeadings.has("The <CopilotKit /> Provider")).toBe(true);
    // Served content keeps the heading line intact.
    expect(chunks[0].content).toContain("## The <CopilotKit /> Provider");
  });

  it("preserves a tag-only ATX heading (heading does not vanish)", () => {
    const content = "## <Badge />\n\nBody under the badge heading.";
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    // The whole heading is a component tag — it must NOT be deleted (which would
    // make the title fall back to the filename and drop the heading entirely).
    expect(chunks[0].title).toBe("<Badge />");
    const allHeadings = new Set(chunks.flatMap((c) => c.headingPath ?? []));
    expect(allHeadings.has("<Badge />")).toBe(true);
    expect(chunks[0].content).toContain("## <Badge />");
  });

  it("preserves a component tag at the END of an ATX heading", () => {
    const content = "## Install <Badge />\n\nBody under the heading.";
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    expect(chunks[0].title).toBe("Install <Badge />");
    const allHeadings = new Set(chunks.flatMap((c) => c.headingPath ?? []));
    expect(allHeadings.has("Install <Badge />")).toBe(true);
    expect(chunks[0].content).toContain("## Install <Badge />");
  });

  it("preserves a paired component tag in an ATX heading verbatim", () => {
    const content = "## Use <Tag>x</Tag> here\n\nBody under the heading.";
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    // A paired tag in a heading must not be reduced to its inner content.
    expect(chunks[0].title).toBe("Use <Tag>x</Tag> here");
    expect(chunks[0].content).toContain("## Use <Tag>x</Tag> here");
  });

  it("still strips a JSX tag in a PROSE line (heading-awareness is line-scoped)", () => {
    // Regression guard: making the strip heading-aware must NOT stop it from
    // stripping JSX on ordinary prose lines.
    const content = "## Heading\n\nUse the <Component /> in your prose here.";
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    expect(chunks[0].content).not.toContain("<Component");
    expect(chunks[0].content).toContain("Use the");
    expect(chunks[0].content).toContain("in your prose here");
    // And the heading itself is unaffected.
    expect(chunks[0].title).toBe("Heading");
  });

  it("still preserves fenced and inline code under heading-aware stripping", () => {
    // Regression guard: heading-awareness must not regress fence/inline-span
    // masking (the prior fixes for those must keep holding).
    const content = [
      "## The <CopilotKit /> Provider",
      "",
      "Inline `<div>x</div>` survives.",
      "",
      "```tsx",
      "const el = <Widget />;",
      "```",
      "",
      "Trailing prose with a <Stripped /> tag.",
    ].join("\n");
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    const joined = chunks.map((c) => c.content).join("\n");
    expect(joined).toContain("## The <CopilotKit /> Provider");
    expect(joined).toContain("`<div>x</div>`");
    expect(joined).toContain("const el = <Widget />;");
    expect(joined).not.toContain("<Stripped");
  });

  // ── Heading-text precision: closing-`#` and `{#anchor}` ─────────────

  it("strips a trailing closing-`#` sequence from the title", () => {
    const content = "## Heading ##\n\nBody text under the heading.";
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    expect(chunks[0].title).toBe("Heading");
  });

  it("strips a single trailing `#` from the title", () => {
    const content = "# Title #\n\nBody text under the heading.";
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    expect(chunks[0].title).toBe("Title");
  });

  it("strips a docs `{#anchor}` from the title", () => {
    const content = "## Config {#configuration}\n\nBody under the heading.";
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    expect(chunks[0].title).toBe("Config");
  });

  it("strips closing-`#`/anchor from headingPath entries too", () => {
    // Force a split so a later chunk opens with each tricky heading and its
    // headingPath is inspectable.
    const big = "Word ".repeat(300).trim();
    const content = [
      "## Intro",
      "",
      big,
      "",
      "## Setup ##",
      "",
      big,
      "",
      "## Options {#opts}",
      "",
      big,
    ].join("\n");
    const chunks = chunkMarkdown(
      content,
      "test.md",
      mkConfig({ target_tokens: 100, overlap_tokens: 0 }),
    );
    const allHeadings = new Set(chunks.flatMap((c) => c.headingPath ?? []));
    expect(allHeadings.has("Setup")).toBe(true);
    expect(allHeadings.has("Options")).toBe(true);
    expect(allHeadings.has("Setup ##")).toBe(false);
    expect(allHeadings.has("Options {#opts}")).toBe(false);
  });

  // ── Basic chunking ──────────────────────────────────────────────────

  it("returns a single chunk for small content", () => {
    const content = "# Title\n\nShort paragraph.";
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].content).toContain("Short paragraph");
  });

  it("sets chunkIndex sequentially", () => {
    // Generate content large enough to produce multiple chunks
    const sections = Array.from(
      { length: 10 },
      (_, i) =>
        `## Section ${i}\n\n${"Lorem ipsum dolor sit amet. ".repeat(100)}`,
    ).join("\n\n");
    const chunks = chunkMarkdown(
      sections,
      "test.md",
      mkConfig({ target_tokens: 100 }),
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].chunkIndex).toBe(i);
    }
  });

  // ── Heading-based splitting ─────────────────────────────────────────

  it("splits on h2 headings", () => {
    const section = "Word ".repeat(200);
    const content = `## Section A\n\n${section}\n\n## Section B\n\n${section}`;
    const chunks = chunkMarkdown(
      content,
      "test.md",
      mkConfig({ target_tokens: 100 }),
    );
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it("splits on h3 headings when h2 sections are still large", () => {
    const para = "Word ".repeat(200);
    const content = `## Big Section\n\n### Sub A\n\n${para}\n\n### Sub B\n\n${para}`;
    const chunks = chunkMarkdown(
      content,
      "test.md",
      mkConfig({ target_tokens: 100 }),
    );
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it("splits on a 1-3-space-indented ATX heading that is the ONLY boundary", () => {
    // CommonMark allows 0-3 leading spaces before the hashes. The heading
    // *detectors* (extractFirstHeading / getHeadingPathAtPosition) already honor
    // that, but the heading *splitter* (splitOnHeading) historically anchored at
    // column 0 only, so a 1-3-space-indented heading was NOT used as a section
    // boundary even though it fed the headingPath — the detectors disagreed.
    //
    // This doc is constructed so the indented `## Section Two` heading is the
    // SOLE available split boundary: there are no blank lines (so paragraph
    // splitting yields a single part and cannot pre-empt the heading split), and
    // each body is several short lines. With a column-0-only splitter the whole
    // doc falls through to the line-split fallback, which never re-attaches a
    // heading marker, so `## Section Two` ends up fused mid-chunk instead of
    // opening its own chunk. An indent-aware splitter cuts cleanly at the
    // heading. We assert via the chunk *boundary* (a chunk opens with the
    // indented heading) — decoupled from the implementation regex.
    const body1 = Array.from(
      { length: 8 },
      (_, i) => `Alpha line ${i} content here.`,
    ).join("\n");
    const body2 = Array.from(
      { length: 8 },
      (_, i) => `Beta line ${i} content here.`,
    ).join("\n");
    const content = ["  ## Section One", body1, "  ## Section Two", body2].join(
      "\n",
    );

    const chunks = chunkMarkdown(
      content,
      "test.md",
      mkConfig({ target_tokens: 100, overlap_tokens: 0 }),
    );

    // The indented heading must create a clean section boundary: some chunk
    // opens with it (leading indent is trimmed off the stored content).
    const opensWithSectionTwo = chunks.some((c) =>
      c.content.startsWith("## Section Two"),
    );
    expect(opensWithSectionTwo).toBe(true);

    // And both indented headings must still feed the heading path (detector
    // consistency: split boundary AND headingPath agree).
    const allHeadings = new Set(chunks.flatMap((c) => c.headingPath ?? []));
    expect(allHeadings.has("Section One")).toBe(true);
    expect(allHeadings.has("Section Two")).toBe(true);
  });

  // ── Heading path tracking ───────────────────────────────────────────

  it("tracks heading path for chunks under h2", () => {
    // A large intro section precedes "## Getting Started", so the splitter emits
    // the Getting Started section as its own chunk that OPENS with the heading
    // (i.e. not at offset 0 of the document). That chunk must carry its own
    // leading heading in its path — it is not enough for only the body chunk
    // after the heading to be tagged.
    const big = "Word ".repeat(300).trim();
    const content = `## Intro\n\n${big}\n\n## Getting Started\n\n${big}`;
    const chunks = chunkMarkdown(
      content,
      "test.md",
      mkConfig({ target_tokens: 100, overlap_tokens: 0 }),
    );
    const startedChunk = chunks.find((c) =>
      c.content.startsWith("## Getting Started"),
    );
    expect(startedChunk).toBeDefined();
    expect(startedChunk!.headingPath).toContain("Getting Started");
  });

  it("tracks nested heading hierarchy", () => {
    // Put a preceding section before the nested Parent/Child headings so the
    // Child section lands in a chunk that does not begin at offset 0. The chunk
    // that OPENS with "### Child" must carry the full hierarchy (both Parent and
    // its own Child heading) — exercising inclusion of a chunk's own leading
    // heading in addition to its ancestors.
    const big = "Word ".repeat(300).trim();
    const content = `## Preamble\n\n${big}\n\n## Parent\n\n### Child\n\n${big}`;
    const chunks = chunkMarkdown(
      content,
      "test.md",
      mkConfig({ target_tokens: 100, overlap_tokens: 0 }),
    );
    const childChunk = chunks.find((c) => c.content.startsWith("### Child"));
    expect(childChunk).toBeDefined();
    expect(childChunk!.headingPath).toContain("Parent");
    expect(childChunk!.headingPath).toContain("Child");
  });

  it("does not treat a heading-like line inside a fenced code block as a real heading", () => {
    // A `## Example` line lives INSIDE a fenced code block. Heading-path
    // computation must skip fenced regions, so this fake heading must never
    // appear in any chunk's headingPath (the headingPath is embedded into the
    // retrieval vector, so a fake heading pollutes search).
    const content = [
      "## Real Heading",
      "",
      "Some prose before the code block.",
      "",
      "```md",
      "## Example",
      "This line is documentation shown inside a code fence.",
      "```",
      "",
      "Prose after the code block lives under Real Heading only.",
    ].join("\n");

    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    for (const chunk of chunks) {
      expect(chunk.headingPath).not.toContain("Example");
    }
    // Sanity: the genuine heading is still tracked.
    const anyHasReal = chunks.some((c) =>
      (c.headingPath ?? []).includes("Real Heading"),
    );
    expect(anyHasReal).toBe(true);
  });

  it("does not treat a heading-like line inside a TILDE fenced code block as a real heading", () => {
    // CommonMark/MDX allow `~~~` tilde fences in addition to backtick fences.
    // A `## Example` line inside a `~~~` block is documentation, not a heading,
    // so it must never enter any chunk's headingPath, and the tilde code block
    // must not be split across chunks (it is a single atomic segment).
    const filler = "Word ".repeat(120).trim();
    const content = [
      "## Real Heading",
      "",
      filler,
      "",
      "~~~md",
      "## Example",
      "This line is documentation shown inside a tilde code fence.",
      "~~~",
      "",
      filler,
    ].join("\n");

    const chunks = chunkMarkdown(
      content,
      "test.md",
      mkConfig({ target_tokens: 80, overlap_tokens: 0 }),
    );

    for (const chunk of chunks) {
      expect(chunk.headingPath ?? []).not.toContain("Example");
    }
    // The tilde code block stays intact in a single chunk (fence open + the
    // documentation heading line + fence close together, never severed).
    const intact = chunks.some(
      (c) =>
        c.content.includes("~~~md") &&
        c.content.includes("## Example") &&
        c.content.includes("tilde code fence"),
    );
    expect(intact).toBe(true);
    // Sanity: the genuine heading is still tracked somewhere.
    const anyHasReal = chunks.some((c) =>
      (c.headingPath ?? []).includes("Real Heading"),
    );
    expect(anyHasReal).toBe(true);
  });

  it("does not inject a fake heading when a chunk boundary lands mid-fenced-block", () => {
    // Build content so a chunk boundary (`position`) lands INSIDE a fenced code
    // block that contains a `#`-prefixed line before that boundary. If heading
    // detection re-segments a truncated slice that severs the fence, the
    // unclosed fence is misread as text and the in-fence `#`-line is injected as
    // a fake heading. Detection must segment the FULL content and filter by
    // absolute offset so the fence stays closed and the fake heading is ignored.
    const filler = "Word ".repeat(200).trim();
    const longCodeLine = "x = ".repeat(400).trim();
    const content = [
      "## Genuine",
      "",
      filler,
      "",
      "```python",
      "# not-a-heading inside the fence",
      longCodeLine,
      "more code line one",
      "more code line two",
      "```",
      "",
      filler,
    ].join("\n");

    const chunks = chunkMarkdown(
      content,
      "test.md",
      mkConfig({ target_tokens: 60, overlap_tokens: 0 }),
    );

    for (const chunk of chunks) {
      expect(chunk.headingPath ?? []).not.toContain(
        "not-a-heading inside the fence",
      );
    }
  });

  it("includes a chunk's own leading heading in its heading path", () => {
    // A chunk that begins with its own heading must include that heading in its
    // headingPath. Build sections large enough to split so a later chunk opens
    // with its own "## Beta" heading.
    const para = "Word ".repeat(300).trim();
    const content = `## Alpha\n\n${para}\n\n## Beta\n\n${para}`;
    const chunks = chunkMarkdown(
      content,
      "test.md",
      mkConfig({ target_tokens: 100, overlap_tokens: 0 }),
    );
    // Find the chunk whose content opens with the Beta heading.
    const betaChunk = chunks.find((c) => c.content.startsWith("## Beta"));
    expect(betaChunk).toBeDefined();
    expect(betaChunk!.headingPath).toContain("Beta");
  });

  it("binds the correct heading path when identical text repeats under different headings", () => {
    // Two sections contain a byte-identical paragraph, but the second
    // occurrence lives under an additional (deeper) heading. Heading-path
    // assignment locates each chunk by searching for its text in the source;
    // if the search cursor is not advanced past a matched chunk, the second
    // occurrence re-finds the FIRST position and inherits the WRONG heading
    // path. Since the heading path is embedded into the retrieval vector, a
    // mis-bind degrades search — so this must resolve to the deeper section.
    const repeated = "Install the package then configure the client object. "
      .repeat(2)
      .trim();
    const filler = "Another shared block of text that appears multiple times. "
      .repeat(3)
      .trim();
    const content = [
      "## Common",
      "",
      filler,
      "",
      "## Delta",
      "",
      repeated, // first occurrence: directly under Delta
      "",
      "#### Setup",
      "",
      filler,
      "",
      repeated, // second occurrence: under Delta -> Setup
    ].join("\n");

    const chunks = chunkMarkdown(
      content,
      "test.md",
      mkConfig({ target_tokens: 100, overlap_tokens: 0 }),
    );

    // The last chunk whose body is the repeated paragraph is the one that
    // physically lives under "#### Setup", so its heading path must include
    // BOTH "Delta" and "Setup" — not just "Delta" (the first occurrence's
    // shallower path).
    const repeatedChunks = chunks.filter((c) => c.content.trim() === repeated);
    expect(repeatedChunks.length).toBeGreaterThanOrEqual(1);
    const setupChunk = repeatedChunks[repeatedChunks.length - 1];
    expect(setupChunk.headingPath).toContain("Delta");
    expect(setupChunk.headingPath).toContain("Setup");
  });

  // ── Code block preservation ─────────────────────────────────────────

  it("does not split inside fenced code blocks", () => {
    const codeBlock =
      '```python\ndef hello():\n    print("hello")\n\n\n    return True\n```';
    const content = `## Intro\n\n${codeBlock}\n\nAfter code.`;
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    // At least one chunk should contain the complete code block
    const hasCompleteBlock = chunks.some(
      (c) =>
        c.content.includes("def hello()") && c.content.includes("return True"),
    );
    expect(hasCompleteBlock).toBe(true);
  });

  it("preserves triple-backtick code blocks with language tag", () => {
    const content =
      "# Title\n\n```typescript\nconst x = 1;\nconst y = 2;\n```\n\nEnd.";
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    const hasBlock = chunks.some((c) => c.content.includes("const x = 1"));
    expect(hasBlock).toBe(true);
  });

  // ── Overlap ─────────────────────────────────────────────────────────

  it("applies overlap without corrupting line boundaries of chunk content", () => {
    // Each section ends in a long single line of words (no newline in the last
    // `overlapChars`). With a naive overlap that prepends the raw partial tail
    // with no separator, the previous tail jams directly onto the next chunk's
    // leading content — e.g. "## Section 0" + "Word..." becomes
    // "## Section 0Word..." and a body tail fuses onto the next heading as
    // "...Word## Section 1". Both push a heading off its own line and fuse
    // words. The overlap must drop the partial leading line and join with a
    // separator so every heading stays at line-start.
    const sections = Array.from(
      { length: 5 },
      (_, i) => `## Section ${i}\n\n${"Word ".repeat(200).trim()}`,
    ).join("\n\n");
    const chunks = chunkMarkdown(
      sections,
      "test.md",
      mkConfig({ target_tokens: 100, overlap_tokens: 20 }),
    );
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // Across ALL chunks, every "## Section <n>" heading must occupy its own
    // physical line: nothing fused before "##" and only the heading text after
    // it. This catches both the head-fusion ("## Section 0Word") and the
    // tail-fusion ("Word## Section 1") signatures of the overlap bug.
    for (const chunk of chunks) {
      // No non-whitespace, non-`#` character may immediately precede an ATX
      // heading marker (`##`..`######` + space). The `[^\n#]` guard is what
      // keeps a legitimate deeper heading (e.g. an h3 `### Foo`, where the char
      // before the final `##…` IS a `#`) from being misread as tail-fusion —
      // the old `/\S#{2}\s/` matched ANY two `#`, so `### Foo` would falsely
      // trip it. This scans for the real tail-fusion signature ("Word## …").
      expect(chunk.content).not.toMatch(/^[^\n#]+#{2,6}\s/m);
      // A heading line must be exactly "## Section <n>" with nothing fused after
      // the number (the next char is end-of-line or end-of-string).
      const headingLines = chunk.content.match(/^#{2,}.*$/gm) ?? [];
      for (const line of headingLines) {
        expect(line).toMatch(/^#{2,6} Section \d+$/);
      }
    }
  });

  it("does not apply overlap when overlap_tokens is 0", () => {
    const sections = Array.from(
      { length: 5 },
      (_, i) => `## Section ${i}\n\n${"Word ".repeat(200)}`,
    ).join("\n\n");
    const chunks = chunkMarkdown(
      sections,
      "test.md",
      mkConfig({ target_tokens: 100, overlap_tokens: 0 }),
    );
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("ACTUALLY applies overlap for single-line prose paragraphs", () => {
    // The dominant markdown content shape is a paragraph that is ONE physical
    // line (no embedded newline). The buggy applyOverlap took the last `\n` in
    // the overlap window and, finding none in a single-line chunk, dropped the
    // overlap entirely — making overlap a NO-OP for the most common content. A
    // word-boundary tail of the previous chunk must actually be prepended.
    const paragraphs = Array.from(
      { length: 12 },
      (_, i) =>
        `Paragraph ${i} ${`distinctword${i}word `.repeat(40).trim()} endmarker${i}`,
    ).join("\n\n");
    const chunks = chunkMarkdown(
      paragraphs,
      "test.md",
      mkConfig({ target_tokens: 60, overlap_tokens: 20 }),
    );
    expect(chunks.length).toBeGreaterThan(2);
    // At least one chunk[i] (i>=1) must contain a trailing fragment of the
    // previous chunk's content — the `endmarker<n>` token from the chunk that
    // ended before it. This is the coverage that was missing and hid the bug.
    let foundCarriedTail = false;
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1].content;
      const prevMarker = prev.match(/endmarker\d+/g)?.pop();
      if (prevMarker && chunks[i].content.includes(prevMarker)) {
        // The marker from the previous chunk's tail leaked into this chunk —
        // overlap was actually applied.
        foundCarriedTail = true;
        break;
      }
    }
    expect(foundCarriedTail).toBe(true);
  });

  it("overlap size roughly scales with overlap_tokens for single-line prose", () => {
    const paragraphs = Array.from(
      { length: 12 },
      (_, i) => `Paragraph ${i} ${"wordy ".repeat(60).trim()}`,
    ).join("\n\n");
    const small = chunkMarkdown(
      paragraphs,
      "test.md",
      mkConfig({ target_tokens: 60, overlap_tokens: 5 }),
    );
    const large = chunkMarkdown(
      paragraphs,
      "test.md",
      mkConfig({ target_tokens: 60, overlap_tokens: 40 }),
    );
    // Larger overlap_tokens ⇒ more total bytes across chunks (the overlapped
    // tails are bigger). With zero overlap applied (the bug), both would be
    // byte-identical and this sum comparison would be equal.
    const totalSmall = small.reduce((n, c) => n + c.content.length, 0);
    const totalLarge = large.reduce((n, c) => n + c.content.length, 0);
    expect(totalLarge).toBeGreaterThan(totalSmall);
  });

  it("overlap on single-line prose never exceeds the requested window", () => {
    // The prepended tail must roughly honor overlapChars (overlap_tokens * 4) —
    // it must not dump the entire previous chunk. We allow generous slack for
    // the word-boundary snap and the "\n\n" separator.
    const overlapTokens = 10;
    const paragraphs = Array.from(
      { length: 10 },
      (_, i) => `Para ${i} ${"token ".repeat(80).trim()}`,
    ).join("\n\n");
    const chunks = chunkMarkdown(
      paragraphs,
      "test.md",
      mkConfig({ target_tokens: 60, overlap_tokens: overlapTokens }),
    );
    const overlapChars = overlapTokens * 4;
    // For each chunk[i>=1], the leading prepended fragment (before the "\n\n"
    // that separates it from the chunk's real content) must be ≤ overlapChars
    // plus modest slack for word-boundary snapping.
    for (let i = 1; i < chunks.length; i++) {
      const content = chunks[i].content;
      const sep = content.indexOf("\n\n");
      if (sep === -1) continue; // no overlap prepended on this boundary
      const lead = content.slice(0, sep);
      // The prepended overlap must not blow past the requested window.
      expect(lead.length).toBeLessThanOrEqual(overlapChars + 20);
    }
  });

  // The tail's START must snap to a word boundary so the embedded/served text
  // does not begin in the middle of a word. The source is built from a VARIED-
  // LENGTH vocabulary so an arbitrary overlapChars window almost never lands on
  // a word boundary by accident — a uniform "alphabeta " filler aligns to a
  // boundary at certain overlap_tokens and hides a dead word-boundary snap. We
  // parametrize over several overlap_tokens (incl. the production default 50) so
  // a genuine mid-word cut is exercised. The FIRST whitespace-delimited token of
  // every prepended overlap must be a COMPLETE word from the vocabulary — never
  // a suffix like "enta" cut from the middle of "documentation".
  for (const overlapTokens of [16, 18, 24, 50]) {
    it(`overlap does not start mid-word for single-line prose (overlap_tokens=${overlapTokens})`, () => {
      const vocab = new Set([
        "Para",
        "the",
        "quick",
        "brown",
        "fox",
        "jumps",
        "over",
        "lazy",
        "dog",
        "documentation",
        "configuration",
        "alphabeta",
        "x",
      ]);
      const words = [
        "the",
        "quick",
        "brown",
        "fox",
        "jumps",
        "over",
        "the",
        "lazy",
        "dog",
        "documentation",
        "x",
        "configuration",
        "alphabeta",
      ];
      const paragraphs = Array.from({ length: 8 }, (_, i) => {
        const body = Array.from(
          { length: 90 },
          (_, j) => words[(i + j) % words.length],
        ).join(" ");
        return `Para ${i} ${body}`;
      }).join("\n\n");
      const chunks = chunkMarkdown(
        paragraphs,
        "test.md",
        mkConfig({ target_tokens: 60, overlap_tokens: overlapTokens }),
      );
      for (let i = 1; i < chunks.length; i++) {
        const content = chunks[i].content;
        const sep = content.indexOf("\n\n");
        if (sep === -1) continue;
        const lead = content.slice(0, sep).trim();
        if (lead === "") continue;
        const firstToken = lead.split(/\s+/)[0];
        // A purely numeric token (the paragraph index) is also a whole word.
        const isWholeWord = vocab.has(firstToken) || /^\d+$/.test(firstToken);
        expect(
          isWholeWord,
          `overlap lead began mid-word: "${firstToken}"`,
        ).toBe(true);
      }
    });
  }

  it("strips literal PUA sentinels from input so they cannot corrupt chunks", () => {
    // The chunker masks inline-code spans with U+E000/U+E001 and heading lines
    // with U+E002/U+E003. A hostile/exotic source that contains those literal
    // code points — especially in a sentinel SHAPE like `<E002>0<E003>` — would
    // collide with the placeholder namespace: the heading-restore pass would
    // rewrite the prose sequence into heading index 0's text. chunkMarkdown must
    // strip all four code points up front so no sentinel survives into a served
    // chunk and no collision can occur.
    const OPEN_H = String.fromCharCode(0xe002);
    const CLOSE_H = String.fromCharCode(0xe003);
    const OPEN_C = String.fromCharCode(0xe000);
    const CLOSE_C = String.fromCharCode(0xe001);
    const doc = [
      "# Real Heading",
      "",
      // A literal heading-sentinel SHAPE pointing at index 0 — the exact
      // collision the input strip must neutralize.
      `Prose with a literal ${OPEN_H}0${CLOSE_H} sentinel and a ${OPEN_C}1${CLOSE_C} code sentinel.`,
    ].join("\n");
    const chunks = chunkMarkdown(
      doc,
      "test.md",
      mkConfig({ target_tokens: 60, overlap_tokens: 0 }),
    );
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      // No PUA sentinel may survive into the served chunk text.
      expect(/[\u{E000}-\u{E003}]/u.test(chunk.content)).toBe(false);
      // The prose must NOT have been rewritten into the real heading's text.
      if (chunk.content.includes("Prose with a literal")) {
        expect(chunk.content).not.toContain("Real Heading sentinel");
      }
    }
    // The genuine heading still binds correctly (the strip only removed the
    // literal sentinels, not the real `#` heading).
    expect(chunks[0].headingPath).toContain("Real Heading");
  });

  // ── Chunk config parameters ─────────────────────────────────────────

  it("uses default target_tokens when not specified", () => {
    const content = "Short content.";
    const config = mkConfig();
    delete (config as any).chunk.target_tokens;
    const chunks = chunkMarkdown(content, "test.md", config);
    expect(chunks).toHaveLength(1);
  });

  it("respects custom target_tokens for smaller chunks", () => {
    // Use paragraphs so the splitter has boundaries to split on
    const para = "Word ".repeat(100);
    const content = Array.from({ length: 10 }, () => para).join("\n\n");
    const smallChunks = chunkMarkdown(
      content,
      "test.md",
      mkConfig({ target_tokens: 50 }),
    );
    const largeChunks = chunkMarkdown(
      content,
      "test.md",
      mkConfig({ target_tokens: 500 }),
    );
    expect(smallChunks.length).toBeGreaterThan(largeChunks.length);
  });

  // ── Paragraph splitting ─────────────────────────────────────────────

  it("splits on paragraph boundaries when headings are not enough", () => {
    const paragraphs = Array.from(
      { length: 20 },
      (_, i) => `Paragraph ${i}: ${"Word ".repeat(50)}`,
    ).join("\n\n");
    const chunks = chunkMarkdown(
      paragraphs,
      "test.md",
      mkConfig({ target_tokens: 100 }),
    );
    expect(chunks.length).toBeGreaterThan(1);
  });

  // ── Special characters ──────────────────────────────────────────────

  it("handles content with special regex characters", () => {
    const content =
      "## Title\n\nContent with $pecial ch@racters: [brackets] (parens) {braces} *stars*";
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0].content).toContain("$pecial");
  });

  it("handles content with unicode characters", () => {
    const content =
      "## Unicode\n\nContent with emoji: \u{1F680}\u{1F30D}\u{1F4DA} and CJK: \u4F60\u597D\u4E16\u754C";
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    expect(chunks[0].content).toContain("\u{1F680}");
  });

  // ── Windows line endings ────────────────────────────────────────────

  it("handles CRLF line endings in frontmatter", () => {
    const content = "---\r\ntitle: CRLF Test\r\n---\r\n\r\nBody text.";
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    expect(chunks[0].title).toBe("CRLF Test");
    expect(chunks[0].content).toContain("Body text");
  });

  it("detects headings and fences in a CRLF-authored body (no frontmatter)", () => {
    // CRITICAL: the single-line predicates use `$`/`.` (which do not match `\r`)
    // and the chunker splits on `\n` only, leaving a trailing `\r` on every
    // line. Without normalization a CRLF doc gets title=filename, headingPath=[]
    // on every chunk, and a code fence runs to EOF. chunkMarkdown must normalize
    // `\r\n` → `\n` once up front so heading + fence detection work. Each section
    // is padded past the target so the splitter cuts on the headings and the
    // post-fence `## Second` opens its own chunk (its heading then enters that
    // chunk's path) — proving the CRLF fence closed rather than running to EOF.
    const big = "Word ".repeat(120).trim();
    const content = [
      "## Title",
      "",
      big,
      "",
      "```js",
      "const x = 1;",
      "```",
      "",
      "## Second",
      "",
      big,
    ].join("\r\n");
    const chunks = chunkMarkdown(
      content,
      "test.md",
      mkConfig({ target_tokens: 100, overlap_tokens: 0 }),
    );
    // (a) Title comes from the first heading, not the filename.
    expect(chunks[0].title).toBe("Title");
    // (b) headingPath is populated (not the degraded []).
    const allHeadings = new Set(chunks.flatMap((c) => c.headingPath ?? []));
    expect(allHeadings.has("Title")).toBe(true);
    // (c) The CRLF fence is closed/atomic — the following heading surfaces as
    //     its own boundary instead of being collapsed into the fence-to-EOF.
    expect(allHeadings.has("Second")).toBe(true);
    // No chunk carries a half-open fence.
    for (const chunk of chunks) {
      const fenceDelims = (
        chunk.content.match(/^ {0,3}(?:`{3,}|~{3,})/gm) ?? []
      ).length;
      expect(fenceDelims % 2).toBe(0);
    }
  });

  // ── Line splitting fallback ─────────────────────────────────────────

  it("falls back to line splitting for very long paragraphs", () => {
    // Single paragraph with many lines but no headings or double newlines
    const lines = Array.from(
      { length: 50 },
      (_, i) => `Line ${i} with some content.`,
    ).join("\n");
    const chunks = chunkMarkdown(
      lines,
      "test.md",
      mkConfig({ target_tokens: 20 }),
    );
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("preserves single-newline structure and heading path in the line-split fallback", () => {
    // A single heading-tagged paragraph with NO blank-line boundaries that is
    // long enough (well over targetChars) to force the line-split fallback.
    // The fallback must NOT double the source single newlines (content fidelity
    // — embeddings/snippets must match source), and because the produced chunk
    // text must remain a verbatim substring of the source, indexOf still binds
    // the heading path (otherwise it degrades to []).
    const body = Array.from({ length: 200 }, (_, i) => `Line ${i} text.`).join(
      "\n",
    );
    const content = `## Long Section\n\n${body}`;
    const chunks = chunkMarkdown(
      content,
      "test.md",
      mkConfig({ target_tokens: 100, overlap_tokens: 0 }),
    );

    // Must have actually split into multiple chunks via the line-split path.
    expect(chunks.length).toBeGreaterThan(1);

    // (a) Content fidelity: adjacent source lines stay single-newline-joined in
    //     the produced chunk text — never blank-line ("\n\n") separated, which
    //     is the newline-doubling signature.
    const joined = chunks.map((c) => c.content).join("\n");
    expect(joined).toContain("Line 1 text.\nLine 2 text.");
    expect(joined).not.toContain("Line 1 text.\n\nLine 2 text.");

    // (b) Heading retention: the line-split body chunks must keep their heading
    //     path (the section heading), not degrade to [].
    const bodyChunks = chunks.filter((c) => /Line \d+ text\./.test(c.content));
    expect(bodyChunks.length).toBeGreaterThan(0);
    for (const chunk of bodyChunks) {
      expect(chunk.headingPath).toContain("Long Section");
    }
  });

  // ── Very long single line ───────────────────────────────────────────

  it("handles a very long single line", () => {
    const content = "A".repeat(10000);
    const chunks = chunkMarkdown(
      content,
      "test.md",
      mkConfig({ target_tokens: 50 }),
    );
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // Content should be preserved even if it cannot be split further
  });

  // ── Multiple frontmatter fields ─────────────────────────────────────

  it("handles frontmatter with many fields", () => {
    const content =
      "---\ntitle: Multi\nauthor: Test\ndate: 2024-01-01\ntags: [a, b]\n---\n\nBody.";
    const chunks = chunkMarkdown(content, "test.md", mkConfig());
    expect(chunks[0].title).toBe("Multi");
  });

  // ── Content after MDX stripping is empty ────────────────────────────

  it("returns empty when content after MDX stripping is only whitespace", () => {
    const content = "import Foo from 'bar';\nimport Baz from 'qux';";
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    expect(chunks).toEqual([]);
  });
});

// ── Heading-path detection precision ──────────────────────────────────────
//
// The chunker embeds headingPath into the retrieval vector, so a missed or
// fabricated heading directly degrades search. These pin the `\s+`-after-hashes
// imprecision in getHeadingPathAtPosition: `\s` includes `\n`, so a `##` line
// with no inline text skips the newline and captures the NEXT line as the
// heading text, injecting a fake heading into the path.

describe("chunkMarkdown heading-path precision", () => {
  // Force the doc to split so a chunk STARTS after the heading-of-interest: a
  // chunk's headingPath only includes a heading it opens with or that precedes
  // it. We pad each section past targetChars so the next `##` heading begins a
  // fresh chunk whose headingPath we can inspect.
  const PAD = "Filler sentence. ".repeat(120); // > 600-char default split size

  it("does not inject the next line as a heading for a bare `##` line", () => {
    // A line that is only `##` (no inline text). `\s+` would skip the newline
    // and capture the FOLLOWING body line as the heading text; the `[ \t]+\S`
    // requirement rejects it.
    const content = [
      "## Real Heading",
      "",
      PAD,
      "",
      "##", // bare hashes, no text
      "Injected body line should NOT become a heading.",
      "",
      PAD,
      "",
      "## Tail Heading",
      "",
      "Tail body.",
    ].join("\n");

    const chunks = chunkMarkdown(
      content,
      "test.md",
      mkConfig({ target_tokens: 100, overlap_tokens: 0 }),
    );

    // No chunk's headingPath may contain the body line that followed the bare
    // `##` (the fake-heading injection signature).
    for (const chunk of chunks) {
      expect(chunk.headingPath).not.toContain(
        "Injected body line should NOT become a heading.",
      );
    }
    // Sanity: the real headings around it are still captured somewhere.
    const allHeadings = new Set(chunks.flatMap((c) => c.headingPath ?? []));
    expect(allHeadings.has("Real Heading")).toBe(true);
    expect(allHeadings.has("Tail Heading")).toBe(true);
  });

  it("does not treat a `##` line with only trailing spaces as a heading", () => {
    // `## ` followed by only spaces/tabs is whitespace-only heading text — not a
    // real heading. The `\S.*` requirement (non-space first char) excludes it.
    const content = [
      "## Anchor Heading",
      "",
      PAD,
      "",
      "##   ", // hashes + only trailing spaces
      "Spaces-only-heading body line.",
      "",
      PAD,
      "",
      "## Closing Heading",
      "",
      "Closing body.",
    ].join("\n");

    const chunks = chunkMarkdown(
      content,
      "test.md",
      mkConfig({ target_tokens: 100, overlap_tokens: 0 }),
    );

    // The whitespace-only heading text must never appear (empty string or the
    // following body line) in any headingPath.
    for (const chunk of chunks) {
      expect(chunk.headingPath).not.toContain("");
      expect(chunk.headingPath).not.toContain("Spaces-only-heading body line.");
    }
  });
});

// ── CHUNKER STRUCTURAL INVARIANTS (the convergence lever) ─────────────────
//
// The chunker has multiple split + heading-extraction paths (splitOnHeading,
// splitPreservingCodeBlocks, recursiveSplit's line-split fallback,
// getHeadingPathAtPosition, extractFirstHeading) that each enforce its
// invariants. Prior rounds patched one path at a time and the next round found
// another. Rather than pin one point, this table-driven property test runs
// chunkMarkdown over a corpus of varied markdown and asserts, for EVERY produced
// chunk, the WHOLE class of invariants with an INDEPENDENT oracle (the oracle
// re-derives heading/fence facts directly, never via the production functions):
//
//   (I1) FENCE INTEGRITY: no chunk contains an unbalanced/half-open code fence,
//        and no fenced code block (``` or ~~~) is split across chunk boundaries.
//   (I2) VERBATIM FIDELITY: each chunk's raw (pre-overlap) text is a verbatim
//        substring of the cleaned body, so no "heading-path lookup failed"
//        degradation warning ever fires.
//   (I3) HEADING SOUNDNESS + COMPLETENESS: every headingPath entry is a real ATX
//        heading (CommonMark: 0–3 leading spaces, 1–6 `#`, space/tab, non-space
//        text) located OUTSIDE fenced code; and every real heading that owns
//        indexable body is captured by at least one chunk.
//   (I4) TITLE SOUNDNESS: the derived title is a real ATX heading outside fences
//        (never a `#`-comment inside a fence), or the filename fallback.
//
// headingPath and title are embedded into the retrieval vector, and a severed
// fence corrupts stored chunk text, so each invariant directly guards search
// quality. Setext headings (`Title\n====`) are a KNOWN unsupported limitation
// and are intentionally NOT asserted here (out of scope).
describe("chunkMarkdown structural invariants", () => {
  // Independent oracle helpers re-derive CommonMark heading/fence facts
  // line-by-line. They MUST NOT import or reuse the module's internal predicate
  // (that would re-couple oracle and production and let production bugs hide).
  // The oracle encodes CORRECT CommonMark so it DISAGREES with buggy production
  // (RED) and AGREES with fixed production (GREEN).

  // An OPENING fence is 0–3 leading spaces, then a run of ≥3 backticks or ≥3
  // tildes (CommonMark allows the same 0–3-space indent as a heading; column 0
  // is not required). Returns the fence char + run length, or null.
  //
  // CommonMark §4.5: the info string after a BACKTICK fence run may NOT contain
  // a backtick (otherwise the line is an inline code span, not a fence opener);
  // a TILDE fence's info string may contain backticks but not tildes. The oracle
  // encodes this so it does not share production's historical blind spot of
  // opening a phantom fence on a col-0 inline ```lang``` text span.
  function matchFenceOpen(line: string): { char: string; len: number } | null {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})([^\n]*)$/);
    if (!m) return null;
    const char = m[1][0];
    const info = m[2];
    if (info.includes(char)) return null;
    return { char, len: m[1].length };
  }

  // A CLOSING fence is the SAME fence char, 0–3-space indent, a run of LENGTH
  // ≥ the opener (CommonMark permits a longer closing fence), and only trailing
  // spaces/tabs after the run (no info string on a closing fence).
  function isFenceClose(
    line: string,
    open: { char: string; len: number },
  ): boolean {
    const fenceChar = open.char === "`" ? "`" : "~";
    const re = new RegExp(`^ {0,3}(\\${fenceChar}{${open.len},})[ \\t]*$`);
    return re.test(line);
  }

  // Strip a CommonMark trailing closing-`#` sequence and a Docusaurus/Nextra
  // `{#anchor}` from captured heading text, mirroring the production predicate
  // but RE-DERIVED here (not imported). `## H ##` → "H"; `## C {#cfg}` → "C".
  // The closing `#`-run must be preceded by whitespace (or be the whole text);
  // `foo###` (no preceding space) keeps its hashes per CommonMark.
  function normalizeHeadingText(text: string): string {
    let t = text.trim();
    // Order matters and MUST match production stripHeadingText: strip the
    // trailing closing-`#` sequence FIRST, then the `{#anchor}`. Reversing the
    // order disagrees on `## X {#a} ##` (anchor-first leaves "X {#a}", hash-first
    // yields "X"), which would make I3-soundness falsely fail against correct
    // production output.
    // Trailing closing-`#` sequence, only when preceded by a space/tab. Uses
    // `[ \t]` (NOT `\s`) to mirror production stripHeadingText EXACTLY — a `\s`
    // class would also match exotic whitespace (\f, \v, unicode spaces) before a
    // closing `#`/{#anchor}, diverging from production on those inputs.
    t = t.replace(/(^|[ \t])#+[ \t]*$/, "$1").trimEnd();
    // Trailing {#anchor} (optionally followed by spaces/tabs) — docs convention.
    t = t.replace(/[ \t]*\{#[^}]*\}[ \t]*$/, "").trimEnd();
    return t;
  }

  // Independent oracle: compute the set of REAL ATX heading texts in a document,
  // masking fenced code blocks. A heading is a 0–3-space-indented line of 1–6
  // `#`, then ≥1 space/tab, then non-space text (4+ leading spaces is a code
  // line, not a heading). An UNCLOSED opening fence runs to END OF INPUT, so a
  // `#`-line after it is NOT a heading. Captured text has its closing-`#` run
  // and `{#anchor}` stripped. Drives both the I3 heading check and I4 title.
  function realHeadings(doc: string): Set<string> {
    const out = new Set<string>();
    let fence: { char: string; len: number } | null = null;
    for (const line of doc.split("\n")) {
      if (fence) {
        // Inside a fence: only a same-char run of length ≥ opener closes it.
        if (isFenceClose(line, fence)) fence = null;
        continue;
      }
      const open = matchFenceOpen(line);
      if (open) {
        fence = open;
        continue;
      }
      const m = line.match(/^ {0,3}(#{1,6})[ \t]+(\S.*?)\s*$/);
      if (m) {
        const text = normalizeHeadingText(m[2]);
        if (text) out.add(text);
      }
    }
    return out;
  }

  // Independent oracle: is the fence state balanced (every opened fence closed)
  // at the END of `text`? A chunk whose code fence is half-open means a fenced
  // block was severed across the chunk boundary. Re-derived line-by-line, not
  // via segmentCodeBlocks; honors 0–3-space-indented fences and ≥-length close.
  function fenceBalanced(text: string): boolean {
    let fence: { char: string; len: number } | null = null;
    for (const line of text.split("\n")) {
      if (fence) {
        if (isFenceClose(line, fence)) fence = null;
      } else {
        const open = matchFenceOpen(line);
        if (open) fence = open;
      }
    }
    return fence === null;
  }

  // Independent oracle: extract every fenced code block's INTERIOR content
  // (the lines BETWEEN the opening and closing fence, joined by "\n"), masking
  // by the same CommonMark fence rules. Used by I6 to assert fenced content
  // survives stripMdx/chunking verbatim. An unclosed fence runs to EOF.
  function fencedInteriors(doc: string): string[] {
    const blocks: string[] = [];
    let fence: { char: string; len: number } | null = null;
    let body: string[] = [];
    for (const line of doc.split("\n")) {
      if (fence) {
        if (isFenceClose(line, fence)) {
          blocks.push(body.join("\n"));
          fence = null;
          body = [];
        } else {
          body.push(line);
        }
      } else {
        const open = matchFenceOpen(line);
        if (open) {
          fence = open;
          body = [];
        }
      }
    }
    // Unclosed fence: its accumulated interior still counts (runs to EOF).
    if (fence) blocks.push(body.join("\n"));
    return blocks;
  }

  interface Case {
    name: string;
    doc: string;
    // Real headings that MUST be captured (have body after them). Optional —
    // omit for cases that only assert "no fake heading / fence break leaks in".
    mustCapture?: string[];
    // Headings that MUST OPEN a chunk (I5 split-boundary completeness). Only the
    // levels recursiveSplit cuts on (h2/h3) are split boundaries, and only when
    // the section is large enough to force a split — so this is an explicit,
    // per-case opt-in (NOT "every heading"): an h4+ heading or a small section
    // legitimately stays fused. Populated for the separator-bug cases (TAB /
    // indent) where a boundary that production wrongly dropped must reappear.
    mustOpenChunk?: string[];
    // Substrings that MUST survive verbatim in some chunk (I6 reinforcement for
    // fenced code / inline spans that stripMdx must not gut). Beyond the generic
    // fencedInteriors() I6 check, these pin specific tokens (imports, JSX) that
    // the over-broad strip passes historically destroyed.
    mustPreserveVerbatim?: string[];
    // Substrings that MUST NOT be a heading-path entry / title in any chunk
    // (fence-interior `#`-lines, prose that looked import-like, etc.).
    mustNotBeHeading?: string[];
    // Expected derived title (frontmatter-free), when the case pins it (e.g.
    // closing-`#`/anchor stripping). Omit to use the generic I4 soundness check.
    expectTitle?: string;
  }

  const PAD = "Filler sentence. ".repeat(120); // forces a split per section
  // An oversized (> 2400-char) GAPLESS fenced block (no blank lines inside) that
  // also contains a `#`-comment line — the F1 line-split-fallback bug shreds
  // this across chunks (severing the fence, collapsing internal newlines) unless
  // the fallback treats the code block as one atomic unit.
  const OVERSIZED_GAPLESS_CODE = [
    "```python",
    "# configure_client is a comment, not a heading",
    Array.from(
      { length: 120 },
      (_, i) => `setting_${i} = value_${i} * ${i}`,
    ).join("\n"),
    "```",
  ].join("\n");

  const cases: Case[] = [
    {
      name: "oversized gapless fenced block with an inner `#`-comment line",
      doc: [
        "## Sigma",
        "",
        OVERSIZED_GAPLESS_CODE,
        "",
        "Body after the block.",
      ].join("\n"),
      mustCapture: ["Sigma"],
    },
    {
      name: "doc STARTS with a fenced block whose first line is `# something`",
      doc: [
        "```md",
        "# something that only looks like a heading",
        "more example markdown",
        "```",
        "",
        "Prose body following the leading fenced block.",
      ].join("\n"),
      // No real heading owns body here — the only `#`-line is inside the fence,
      // so the title must fall back to the filename (I4), not the in-fence line.
    },
    {
      name: "`#`-line inside a tilde (~~~) fence is not a heading",
      doc: [
        "## Eta",
        "",
        PAD,
        "",
        "~~~",
        "# Tilde-fenced comment, not a heading",
        "~~~",
        "",
        "Body after the tilde block.",
      ].join("\n"),
      mustCapture: ["Eta"],
    },
    {
      name: "1-3-space-indented ATX heading is captured",
      doc: [
        "   ### Indented Three Spaces",
        "",
        "Body under the indented heading here.",
      ].join("\n"),
      mustCapture: ["Indented Three Spaces"],
    },
    {
      name: "indented headings deep enough to force a split are all captured",
      doc: [
        "  ## Two Space Heading",
        "",
        PAD,
        "",
        "  ## Another Indented Heading",
        "",
        PAD,
      ].join("\n"),
      mustCapture: ["Two Space Heading", "Another Indented Heading"],
      mustOpenChunk: ["Another Indented Heading"],
    },
    {
      name: "bare `##`-only line does not inject the next line",
      doc: [
        "## Alpha",
        "",
        PAD,
        "",
        "##",
        "Body after bare hashes.",
        "",
        PAD,
        "",
        "## Beta",
        "",
        "Beta body.",
      ].join("\n"),
      mustCapture: ["Alpha", "Beta"],
    },
    {
      name: "`##` with only trailing spaces is not a heading",
      doc: [
        "## Gamma",
        "",
        PAD,
        "",
        "##   ",
        "Body after spaces-only hashes.",
        "",
        PAD,
        "",
        "## Delta",
        "",
        "Delta body.",
      ].join("\n"),
      mustCapture: ["Gamma", "Delta"],
    },
    {
      name: "`## Heading` directly after a closing backtick fence (single newline)",
      doc: [
        "## Epsilon",
        "",
        PAD,
        "",
        "```js",
        "const x = 1;",
        "```",
        "## After Backtick Fence",
        "",
        "Body under the post-fence heading.",
      ].join("\n"),
      mustCapture: ["Epsilon", "After Backtick Fence"],
    },
    {
      // The Bug-1 repro shape: a fenced code block that ENDS a section, then a
      // blank line, then the next heading. With the production-default overlap
      // (overlap_tokens > 0), the section's chunk ENDS with the lone closing
      // fence delimiter line, and applyOverlap prepends that delimiter to the
      // FOLLOWING chunk — opening it with a fence that never closes (half-open).
      // Under overlap_tokens: 0 this case is benign; the parametrized run at the
      // production default (50) is what makes it bite. The filler is sized so the
      // fence lands at a chunk boundary at target_tokens: 100.
      name: "fenced block ENDS a section, immediately followed by a heading (overlap repro)",
      doc: [
        "## Kappa",
        "",
        "Word ".repeat(100).trim(),
        "",
        "```js",
        "const a = 1;",
        "const b = 2;",
        "const c = 3;",
        "```",
        "",
        "## Lambda",
        "",
        "Word ".repeat(60).trim(),
      ].join("\n"),
      mustCapture: ["Kappa", "Lambda"],
    },
    {
      name: "`#`-line inside a backtick fence is not a heading",
      doc: [
        "## Zeta",
        "",
        PAD,
        "",
        "```sh",
        "# This is a shell comment, not a heading",
        "## Neither is this",
        "```",
        "",
        "Body after the fenced block.",
      ].join("\n"),
      mustCapture: ["Zeta"],
    },
    {
      name: "4-space-indented `#`-line is not a heading",
      doc: [
        "## Theta",
        "",
        PAD,
        "",
        "    # Indented four spaces — a code line, not a heading",
        "",
        "Body after the indented line.",
      ].join("\n"),
      mustCapture: ["Theta"],
    },
    {
      name: "deeply nested `#`/`##`/`###` hierarchy",
      doc: [
        "# Top",
        "",
        PAD,
        "",
        "## Middle",
        "",
        PAD,
        "",
        "### Leaf",
        "",
        "Leaf body content here.",
      ].join("\n"),
      mustCapture: ["Top", "Middle", "Leaf"],
    },
    {
      name: "duplicate body text under different headings binds the right path",
      doc: [
        "## Common",
        "",
        "A shared block of prose appearing more than once. ".repeat(3).trim(),
        "",
        "## Outer",
        "",
        "Repeated paragraph bound to its own section. ".repeat(2).trim(),
        "",
        "#### Inner",
        "",
        PAD,
        "",
        "Repeated paragraph bound to its own section. ".repeat(2).trim(),
      ].join("\n"),
      mustCapture: ["Common", "Outer", "Inner"],
    },
    {
      // A legitimately nested heading whose text equals its parent's: `# Setup`
      // containing `## Setup`. The body under the inner heading correctly binds
      // headingPath ["Setup", "Setup"] — two consecutive same-text entries that
      // are a REAL ancestor chain, not a fabricated repeat. The I3 soundness
      // check must ACCEPT this (it cannot distinguish legit same-text nesting
      // from a fabricated duplicate, so it must not reject consecutive repeats).
      name: "same-named nested heading binds a same-text ancestor chain",
      doc: [
        "# Setup",
        "",
        PAD,
        "",
        "## Setup",
        "",
        "Inner setup body content here.",
      ].join("\n"),
      mustCapture: ["Setup"],
    },
    {
      name: "chunk boundary landing mid-fence (large code block)",
      doc: [
        "## Iota",
        "",
        "```js",
        // A code block far larger than targetChars so the splitter is forced to
        // cut inside it — no `#`-line in here may ever surface as a heading and
        // the fence must never be severed.
        Array.from(
          { length: 80 },
          (_, i) => `// line ${i} # not a heading inside code`,
        ).join("\n"),
        "```",
        "",
        "Body after the oversized fenced block.",
      ].join("\n"),
      mustCapture: ["Iota"],
    },
    {
      name: "normal prose with no tricky structure",
      doc: [
        "# Plain Title",
        "",
        "Just some ordinary prose with no fences or odd headings. "
          .repeat(5)
          .trim(),
      ].join("\n"),
      mustCapture: ["Plain Title"],
    },
    {
      // stripMdx CRITICAL: a fenced ```tsx block containing an `import` and a
      // self-closing JSX tag whose attribute value contains a `>` must pass
      // through VERBATIM — the import/JSX strip passes must be masked inside
      // fences. Historically stripMdx ran its regexes over the whole body first,
      // gutting this highest-value retrieval content.
      name: "fenced tsx block with import + JSX (attr contains `>`) survives verbatim",
      doc: [
        "## Usage",
        "",
        "Render the component like so:",
        "",
        "```tsx",
        "import { Widget } from 'my-lib';",
        'import "./styles.css";',
        'export const App = () => <Widget label="a>b" mode="x" />;',
        "```",
        "",
        "Done.",
      ].join("\n"),
      mustCapture: ["Usage"],
      mustPreserveVerbatim: [
        "import { Widget } from 'my-lib';",
        'import "./styles.css";',
        'export const App = () => <Widget label="a>b" mode="x" />;',
      ],
    },
    {
      // An UNCLOSED opening fence runs to END OF INPUT: every line after it
      // (including a `#`-line) is code, not a heading. The chunker must not
      // inject the in-fence `#`-line as a fake heading, and must not sever the
      // (unclosed) fenced region. The oracle treats the fence as open to EOF.
      name: "unclosed fence runs to EOF; inner `#`-line is not a heading",
      doc: [
        "## Mu",
        "",
        "Intro prose before the unterminated fence block here.",
        "",
        "```js",
        "// no closing fence below — everything to EOF is code",
        "# this is not a heading, it is inside the open fence",
        "const x = 1;",
      ].join("\n"),
      mustCapture: ["Mu"],
      mustNotBeHeading: ["this is not a heading, it is inside the open fence"],
    },
    {
      // A LONGER closing fence (CommonMark allows the close to be ≥ the opener):
      // a ```` (4-backtick) opener closed by a ````` (5-backtick) line. The
      // chunker must recognize this close (not run the fence to EOF) and keep the
      // following `## After Long Fence` heading as a real boundary/heading.
      name: "longer closing fence (4-backtick open, 5-backtick close)",
      doc: [
        "## Nu",
        "",
        PAD,
        "",
        "````md",
        "```js still inside the outer fence```",
        "# inner line is not a heading",
        "`````",
        "",
        "## After Long Fence",
        "",
        "Body under the post-long-fence heading.",
      ].join("\n"),
      mustCapture: ["Nu", "After Long Fence"],
      mustOpenChunk: ["After Long Fence"],
      mustNotBeHeading: ["inner line is not a heading"],
    },
    {
      // TAB-separated heading as the ONLY split boundary: `##\tHeading` uses a
      // TAB (not a space) after the hashes. CommonMark accepts a tab separator,
      // so it is a real heading AND must be a split boundary (splitOnHeading
      // historically required a literal space). No blank lines, so paragraph
      // splitting cannot pre-empt; the tab heading is the sole boundary.
      name: "TAB-separated heading is a real boundary (splitOnHeading)",
      // No blank lines, so paragraph splitting yields a single part and cannot
      // pre-empt the heading split — the TAB-separated `##\t…` heading is the
      // SOLE available boundary. Each section is sized well past targetChars
      // (target_tokens:100 ⇒ 400 chars) so a split is actually forced; a
      // column-0-and-space-only splitter leaves the whole doc fused and both
      // completeness (I3) and boundary (I5) fail.
      doc: [
        "##\tFirst Tab Section",
        ...Array.from(
          { length: 16 },
          (_, i) =>
            `Alpha line ${i} carries enough content to grow the section.`,
        ),
        "##\tSecond Tab Section",
        ...Array.from(
          { length: 16 },
          (_, i) =>
            `Beta line ${i} carries enough content to grow the section.`,
        ),
      ].join("\n"),
      mustCapture: ["First Tab Section", "Second Tab Section"],
      mustOpenChunk: ["Second Tab Section"],
    },
    {
      // 0–3-space INDENTED oversized fence: an indented (2-space) ``` fence that
      // is far larger than targetChars. The fence must be recognized despite the
      // indent (segmentCodeBlocks historically required column 0), kept atomic
      // (not severed), and its inner `#`-line must not become a heading.
      name: "indented (2-space) oversized fence kept atomic, inner `#` not a heading",
      doc: [
        "## Xi",
        "",
        "  ```python",
        "  # indented-fence comment is not a heading",
        ...Array.from({ length: 80 }, (_, i) => `  value_${i} = ${i} * 2`),
        "  ```",
        "",
        "Body after the indented fenced block.",
      ].join("\n"),
      mustCapture: ["Xi"],
      mustNotBeHeading: ["indented-fence comment is not a heading"],
    },
    {
      // Heading-text precision: a closing-`#` sequence (`## Heading ##`) and a
      // docs `{#anchor}` (`## Config {#configuration}`) must be stripped from the
      // captured heading text (title + headingPath). The oracle independently
      // strips them, so production must agree.
      name: "closing-`#` sequence and `{#anchor}` are stripped from heading text",
      doc: [
        "## Heading ##",
        "",
        PAD,
        "",
        "## Config {#configuration}",
        "",
        "Body under the anchored heading here.",
      ].join("\n"),
      mustCapture: ["Heading", "Config"],
      mustNotBeHeading: [
        "Heading ##",
        "Config {#configuration}",
        "{#configuration}",
      ],
    },
    {
      // Title-precision variant: the document's FIRST heading carries a closing
      // `#` sequence; the derived title must be the stripped text "Welcome", not
      // "Welcome #". Pins extractFirstHeading's use of the shared predicate.
      name: "title from a heading with a trailing closing-`#` is stripped",
      doc: [
        "# Welcome #",
        "",
        "Some introductory prose under the welcome heading.",
      ].join("\n"),
      mustCapture: ["Welcome"],
      expectTitle: "Welcome",
    },
    {
      // stripMdx side-effect-import bug: a side-effect import (`import "./x.css";`
      // with no `from`) before a heading must NOT cause the over-broad lazy
      // `[\s\S]*?from` to swallow everything up to the NEXT import's `from`,
      // deleting the heading + prose in between. Heading + prose must survive.
      name: "side-effect import before a heading does not delete the heading/prose",
      doc: [
        'import "./globals.css";',
        "",
        "## Configuration",
        "",
        "Prose that must survive the side-effect import strip.",
        "",
        "import { Helper } from '@/components/Helper';",
        "",
        "More prose after the second (from-)import.",
      ].join("\n"),
      mustCapture: ["Configuration"],
      mustPreserveVerbatim: [
        "Prose that must survive the side-effect import strip.",
        "More prose after the second (from-)import.",
      ],
    },
    {
      // stripMdx prose-import bug: an ordinary English sentence that happens to
      // start with "import" and contain " from " ("import a value from ...") is
      // PROSE, not an MDX import statement, and must NOT be deleted. The import
      // regex must match a single logical import statement, not arbitrary prose.
      name: "prose line that looks import-like is not deleted",
      doc: [
        "## Notes",
        "",
        'You can import a value from "the library" in your own code.',
        "",
        "And the rest of the prose continues normally afterwards.",
      ].join("\n"),
      mustCapture: ["Notes"],
      mustPreserveVerbatim: [
        'You can import a value from "the library" in your own code.',
      ],
    },
    {
      // Inline code span: `<div>x</div>` inside single backticks is inline code
      // and must survive verbatim — the JSX strip must not run inside inline
      // spans. Secondary to fenced masking but in scope.
      name: "inline code span with JSX-looking content survives verbatim",
      doc: [
        "## Inline",
        "",
        "Use the `<div>x</div>` element, and also `import X from 'y'` inline.",
        "",
        "Trailing prose.",
      ].join("\n"),
      mustCapture: ["Inline"],
      mustPreserveVerbatim: ["`<div>x</div>`", "`import X from 'y'`"],
    },
    {
      // Bug 1: a col-0 line ```js``` text is an INLINE code span (CommonMark
      // §4.5: a backtick fence info string may not contain a backtick), NOT a
      // fence opener. The buggy production opened a phantom fence that ran to
      // EOF, masking the SECOND heading as in-fence "code" and dropping it. The
      // second heading must be captured and no half-open fence may leak.
      name: "col-0 inline triple-backtick span is not a fence (later heading survives)",
      doc: [
        "## Alpha",
        "",
        PAD,
        "",
        "```js``` quick inline example, prose after.",
        "",
        "## Beta",
        "",
        PAD,
      ].join("\n"),
      mustCapture: ["Alpha", "Beta"],
      mustOpenChunk: ["Beta"],
    },
    {
      // Bug 5: a heading carrying BOTH a `{#anchor}` and a trailing closing-`#`
      // sequence (`## X {#a} ##`). Production stripHeadingText and the oracle
      // normalizeHeadingText must agree on the stripped text "X" (both strip the
      // closing-`#` run FIRST, then the anchor). Before the alignment the oracle
      // produced "X {#a}" and disagreed with production's "X".
      name: "heading with both `{#anchor}` and trailing closing-`#` strips to bare text",
      doc: [
        "## X {#a} ##",
        "",
        "Body under the anchored, hash-closed heading here.",
      ].join("\n"),
      mustCapture: ["X"],
      mustNotBeHeading: ["X {#a}", "X {#a} ##", "{#a}"],
    },
    {
      // Bug-S6: a doc whose FIRST content line is a 4-space-indented fence
      // (`    ```lang`). CommonMark treats 4+ leading spaces as INDENTED CODE, so
      // this is NOT a column-0 fence opener — it must not be promoted to a
      // half-open phantom fence in the SERVED chunk text (the final chunk trim
      // historically stripped the doc's leading indent, turning `    ```lang`
      // into a column-0 ` ```lang ` whose still-indented closing `    ``` ` no
      // longer closes it). The heading after the indented block must still be a
      // real captured boundary. PAD forces a split so `## Heading…` opens its own
      // chunk and enters that chunk's headingPath.
      name: "doc-start 4-space-indented fence is not a column-0 fence (heading still captured)",
      doc: [
        "    ```lang",
        "    indented code-ish content here",
        "    ```",
        "",
        "## Heading After Indented Block",
        "",
        PAD,
      ].join("\n"),
      mustCapture: ["Heading After Indented Block"],
      mustOpenChunk: ["Heading After Indented Block"],
    },
  ];

  // Run the WHOLE corpus under both overlap settings: 0 (overlap disabled) AND
  // the production default of 50 (overlap_tokens default × 4 = 200 overlap
  // chars). Earlier rounds only ever exercised the corpus at overlap_tokens: 0,
  // so applyOverlap was never run against fences — a fenced block ending a
  // section had its lone closing-fence line prepended onto the next chunk by
  // overlap, injecting a half-open fence that the I1 oracle catches only when
  // overlap is actually applied. Parametrizing over both keeps the soundness /
  // completeness / fidelity checks honest on the real production path too.
  const OVERLAP_SETTINGS = [0, 50];

  // Run the WHOLE corpus under BOTH line-ending conventions: the canonical LF
  // form AND a `\r\n`-joined CRLF variant (Windows / core.autocrlf authoring).
  // CRLF historically broke EVERY heading + fence detector ($/. do not match
  // `\r`, and the chunker split on `\n` only), so a CRLF doc degraded to
  // title=filename and headingPath=[] on every chunk and any fence ran to EOF.
  // chunkMarkdown must normalize `\r\n` → `\n` up front, after which the CRLF
  // variant must satisfy the identical structural invariants. The oracle is
  // always computed on the normalized (LF) doc — it models the post-normalization
  // content — while chunkMarkdown receives the raw (possibly CRLF) variant.
  const LINE_ENDINGS: Array<{ label: string; apply: (doc: string) => string }> =
    [
      { label: "LF", apply: (doc) => doc },
      { label: "CRLF", apply: (doc) => doc.replace(/\n/g, "\r\n") },
    ];

  for (const overlap of OVERLAP_SETTINGS) {
    for (const eol of LINE_ENDINGS) {
      for (const tc of cases) {
        it(`invariant holds (overlap_tokens=${overlap}, ${eol.label}): ${tc.name}`, () => {
          // Oracle facts come from the NORMALIZED (LF) doc — chunkMarkdown
          // normalizes CRLF → LF before any detection, so the expected headings,
          // fence balance, and interiors are those of the LF form.
          const allowed = realHeadings(tc.doc);

          // Capture any degradation warning the chunker emits (I2): the
          // heading-path lookup only fails when a chunk's raw text is NOT a
          // verbatim substring of the cleaned body, so a fired warning is a
          // direct verbatim-fidelity break.
          const warnings: string[] = [];
          const originalWarn = console.warn;
          console.warn = (...args: unknown[]) => {
            warnings.push(args.join(" "));
          };
          let chunks;
          try {
            chunks = chunkMarkdown(
              eol.apply(tc.doc),
              "test.md",
              mkConfig({ target_tokens: 100, overlap_tokens: overlap }),
            );
          } finally {
            console.warn = originalWarn;
          }
          expect(chunks.length).toBeGreaterThan(0);

          // (I1) FENCE INTEGRITY: when the SOURCE doc has balanced fences, every
          //      chunk must too (no half-open fence ⇒ no fenced block severed
          //      across a chunk boundary, and no overlap-injected lone fence
          //      delimiter opening a chunk). A doc with a deliberately UNCLOSED
          //      fence (runs to EOF) legitimately yields one trailing unbalanced
          //      chunk — that is the correct atomic behavior, not a severed
          //      block — so this per-chunk balance check is skipped there; that
          //      case is guarded instead by I3 soundness, mustNotBeHeading, I6.
          if (fenceBalanced(tc.doc)) {
            for (const chunk of chunks) {
              expect(fenceBalanced(chunk.content)).toBe(true);
            }
          }

          // (I2) VERBATIM FIDELITY: no "heading-path lookup failed" warning
          //      fired, i.e. every raw chunk remained a verbatim substring of
          //      the body.
          const degraded = warnings.filter((w) =>
            w.includes("heading-path lookup failed"),
          );
          expect(degraded).toEqual([]);

          // (I3) SOUNDNESS: no chunk's headingPath contains anything that is not
          //      a real ATX heading outside fences. This catches fence-leak,
          //      bare-`##`, whitespace-only, and indented-`#` fabrications.
          const seen = new Set<string>();
          for (const chunk of chunks) {
            const path = chunk.headingPath ?? [];
            for (const h of path) {
              expect(h).not.toBe("");
              expect(allowed.has(h)).toBe(true);
              seen.add(h);
            }
            // NOTE: we intentionally do NOT assert path[i] !== path[i-1]. A
            // legitimately nested heading whose text equals its parent's (e.g.
            // `# Setup` containing `## Setup`) yields a REAL ancestor chain
            // ["Setup", "Setup"]; a consecutive-duplicate check cannot tell that
            // legit same-text nesting apart from a fabricated repeat, so it would
            // false-FAIL on correct output. Soundness is already enforced by the
            // allowed-set membership check above.
          }

          // (I3) COMPLETENESS: every real heading that owns body content is
          //      captured by at least one chunk (none silently missed).
          for (const h of tc.mustCapture ?? []) {
            expect(allowed.has(h)).toBe(true); // oracle self-check
            expect(seen.has(h)).toBe(true);
          }

          // (I4) TITLE SOUNDNESS: the derived title (with no frontmatter, this
          //      is extractFirstHeading's result or the filename fallback) is
          //      either a real ATX heading outside fences or the filename —
          //      never an in-fence `#`-comment line, and never empty/undefined.
          const title = chunks[0].title;
          expect(typeof title).toBe("string");
          expect(allowed.has(title ?? "") || title === "test.md").toBe(true);
          if (tc.expectTitle !== undefined) {
            expect(title).toBe(tc.expectTitle);
          }

          // (I5) SPLIT-BOUNDARY COMPLETENESS: each heading named in
          //      mustOpenChunk OPENS some chunk (it is a clean section boundary,
          //      not fused mid-chunk). A chunk "opens with" a heading when,
          //      after trimming leading blank lines, its first non-empty line is
          //      that heading (modulo CommonMark indent / closing-`#` /
          //      `{#anchor}`). This catches the splitOnHeading separator bug: a
          //      TAB- or indent-separated heading that feeds the path but is NOT
          //      used as a boundary stays fused inside a chunk and fails here.
          //
          //      Overlap prepends a cleaned tail line to the FOLLOWING chunk,
          //      which can push the opening heading off line 1 of the stored
          //      content, so this boundary check runs only at overlap=0 (the
          //      boundary is unambiguous there). I3-completeness already guards
          //      capture under both overlap settings.
          if (overlap === 0) {
            const opensWith = (chunk: string, heading: string): boolean => {
              const lines = chunk.split("\n");
              let i = 0;
              while (i < lines.length && lines[i].trim() === "") i++;
              if (i >= lines.length) return false;
              const m = lines[i].match(/^ {0,3}(#{1,6})[ \t]+(\S.*?)\s*$/);
              if (!m) return false;
              return normalizeHeadingText(m[2]) === heading;
            };
            for (const h of tc.mustOpenChunk ?? []) {
              expect(allowed.has(h)).toBe(true); // oracle self-check
              const opened = chunks.some((c) => opensWith(c.content, h));
              expect(opened, `heading "${h}" should open some chunk`).toBe(
                true,
              );
            }
          }

          // (I6) FENCED-CONTENT PRESERVATION: for each fenced code block in the
          //      input, its exact interior (imports, JSX, inline-looking text)
          //      appears VERBATIM in some chunk's output. This is the direct
          //      guard on the stripMdx CRITICAL: the import/JSX strip passes
          //      must be masked inside fences so code survives untouched. We
          //      assert each non-empty interior LINE is a substring of some
          //      chunk (line-level keeps the check robust to atomic-block
          //      re-joining while still proving no in-fence line was deleted or
          //      rewritten). Chunk content is always normalized to LF, so the
          //      LF-derived interior lines match under the CRLF variant too.
          for (const interior of fencedInteriors(tc.doc)) {
            for (const line of interior.split("\n")) {
              if (line.trim() === "") continue;
              const present = chunks.some((c) => c.content.includes(line));
              expect(present, `fenced line not preserved: ${line}`).toBe(true);
            }
          }

          // Per-case reinforcement: explicit verbatim tokens (imports / JSX /
          // inline spans) the over-broad strip historically destroyed.
          for (const frag of tc.mustPreserveVerbatim ?? []) {
            const present = chunks.some((c) => c.content.includes(frag));
            expect(present, `must preserve verbatim: ${frag}`).toBe(true);
          }

          // Per-case reinforcement: strings that must NEVER be a heading-path
          // entry or the title (fence-interior `#`-lines, un-stripped
          // closing-`#`/anchor text, import-looking prose, etc.).
          for (const notHeading of tc.mustNotBeHeading ?? []) {
            expect(seen.has(notHeading)).toBe(false);
            expect(title).not.toBe(notHeading);
          }
        });
      }
    }
  }
});

// ── Regression LEVERS: invariant property + timing guards ───────────────────
//
// These three levers exist to make four load-bearing bugs UNREINTRODUCIBLE:
//   1. ReDoS in the MDX JSX-strip regexes (catastrophic backtracking on a
//      prop-heavy paired/self-closing tag) + the `{expr > val}` strip gap.
//   2. The multi-line overlap branch prepending an unbalanced inline-code tail.
//   3. A side-effect `import "x";` whose `\s+` spanned a newline (content loss).
//   4. The line-split fallback severing an inline code span across a soft break.
// Each lever is RED at the pre-fix HEAD and GREEN once the four fixes land.
describe("chunkMarkdown regression levers", () => {
  // Independent oracle (NOT imported from production): count inline-code
  // backticks that fall OUTSIDE fenced-code regions. A balanced source inline
  // span (`` `x` `` — two backticks) must never be SEVERED by splitting/overlap
  // such that one chunk carries an odd number of backticks in its served text
  // (i.e. opens a span it never closes). Fenced regions are masked first because
  // their backticks are fence delimiters / verbatim code, not inline spans.
  function fenceOpenLen(line: string): { char: string; len: number } | null {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})([^\n]*)$/);
    if (!m) return null;
    const char = m[1][0];
    // CommonMark §4.5: a backtick fence's info string may not contain a backtick
    // (then the line is an inline span, not a fence opener); a tilde fence's may
    // not contain a tilde. Mirrors production matchFenceOpen, re-derived here.
    if (m[2].includes(char)) return null;
    return { char, len: m[1].length };
  }
  function fenceCloses(
    line: string,
    open: { char: string; len: number },
  ): boolean {
    const fc = open.char === "`" ? "`" : "~";
    return new RegExp(`^ {0,3}(\\${fc}{${open.len},})[ \\t]*$`).test(line);
  }
  function inlineBacktickCountOutsideFences(text: string): number {
    let open: { char: string; len: number } | null = null;
    let count = 0;
    for (const line of text.split("\n")) {
      if (open) {
        if (fenceCloses(line, open)) open = null;
        continue; // fence-delimiter / in-fence line: not inline backticks
      }
      const o = fenceOpenLen(line);
      if (o) {
        open = o;
        continue;
      }
      for (const ch of line) if (ch === "`") count++;
    }
    return count;
  }

  // Independent oracle (NOT imported from production): is EVERY inline code span
  // OUTSIDE fenced regions closed by EOF, pairing runs by EXACT length? The
  // parity oracle above (inlineBacktickCountOutsideFences) only catches a
  // SINGLE-backtick imbalance — a double-backtick `` `` `` span splits into two
  // chunks each carrying a balanced-PARITY but unbalanced-RUN delimiter (each
  // chunk has 2 backticks, parity even, yet one chunk has a dangling `` ``
  // opener and the other a dangling `` `` closer). CommonMark §6.1: a run of N
  // backticks opens a span closed only by a run of EXACTLY N. We mask fenced
  // regions (their backticks are fence delimiters / verbatim code, not inline)
  // and then, across the remaining text, require that no inline run is left
  // open. Returns true when balanced. Mirrors production maskInlineCode's
  // run-length pairing, RE-DERIVED here so a production bug cannot hide.
  function inlineCodeBalancedExactRun(text: string): boolean {
    // First, blank out fenced regions so their backticks are not scanned.
    let open: { char: string; len: number } | null = null;
    const nonFenceLines: string[] = [];
    for (const line of text.split("\n")) {
      if (open) {
        if (fenceCloses(line, open)) open = null;
        nonFenceLines.push(""); // in-fence content masked out
        continue;
      }
      const o = fenceOpenLen(line);
      if (o) {
        open = o;
        nonFenceLines.push(""); // fence-delimiter line masked out
        continue;
      }
      nonFenceLines.push(line);
    }
    const s = nonFenceLines.join("\n");
    // Pair inline backtick runs by EXACT length over the masked text. A run of
    // N opens a span that only a later run of EXACTLY N closes (a run of a
    // different length inside an open span is literal content). We do NOT honor
    // CommonMark's blank-line/heading span boundaries here on purpose: this
    // oracle's job is to detect a DELIMITER left dangling in served chunk text,
    // and the strictest "is there any unclosed run" check is the one that flags
    // a severed multi-backtick span. If a run is left open at EOF, unbalanced.
    let i = 0;
    const n = s.length;
    while (i < n) {
      if (s[i] !== "`") {
        i++;
        continue;
      }
      let runEnd = i;
      while (runEnd < n && s[runEnd] === "`") runEnd++;
      const runLen = runEnd - i;
      // Look for a closing run of EXACTLY runLen after this opener.
      let scan = runEnd;
      let close = -1;
      while (scan < n) {
        if (s[scan] !== "`") {
          scan++;
          continue;
        }
        let candEnd = scan;
        while (candEnd < n && s[candEnd] === "`") candEnd++;
        if (candEnd - scan === runLen) {
          close = scan;
          break;
        }
        scan = candEnd;
      }
      if (close === -1) return false; // opener with no exact-length closer
      i = close + runLen;
    }
    return true;
  }

  // Independent oracle (NOT imported from production): is the fence state
  // balanced (every opened fence closed) at the END of `text`? A chunk whose
  // code fence is half-open means a fenced block was severed across the chunk
  // boundary. Re-derived line-by-line via the local fence predicates above.
  function fenceBalancedOracle(text: string): boolean {
    let open: { char: string; len: number } | null = null;
    for (const line of text.split("\n")) {
      if (open) {
        if (fenceCloses(line, open)) open = null;
      } else {
        const o = fenceOpenLen(line);
        if (o) open = o;
      }
    }
    return open === null;
  }

  // ── LEVER 1: inline-backtick balance is preserved across split + overlap ──
  //
  // Corpus of docs whose SOURCE inline code spans are all balanced (even
  // backticks). For each doc × overlap_tokens{0,50} × line-ending{LF,CRLF},
  // every produced chunk must carry an EVEN number of inline backticks OUTSIDE
  // fenced regions — no chunk may open an inline span it never closes in its
  // served text. The corpus MUST include the S4 (overlap) and S7 (line-split)
  // shapes; both sever a complete source span at the pre-fix HEAD.
  //
  // S4 — a soft-wrapped (single-newline-joined, no blank-line) paragraph large
  // enough to split, with a COMPLETE inline span in the MIDDLE. At
  // overlap_tokens=50 the multi-line overlap branch retains whole lines from a
  // window that BEGINS inside the span, prepending its lone CLOSING backtick to
  // the next chunk (Bug 2). At overlap_tokens=0 the span stays atomic.
  const SPAN_S4 = [
    "## Intro",
    "",
    ...Array.from({ length: 60 }, (_, i) =>
      i === 30
        ? "Open the span here `SPAN_OPEN_MARKER and it keeps going on this line with words."
        : i === 31
          ? "Still inside the span on this line with more words before it eventually closes up."
          : i === 32
            ? "Finally the span SPAN_CLOSE_MARKER` closes right here and then prose continues fine."
            : `Soft wrapped line ${i} carries prose to grow this paragraph along nicely here ok.`,
    ),
  ].join("\n");

  // S7 — an oversized (> targetChars), GAPLESS (no blank lines) block with a
  // COMPLETE inline span crossing a soft line break, whose two halves are each
  // long enough that the line-split fallback's merge MUST break between them,
  // landing the opening and closing backticks in adjacent chunks (Bug 4). RED at
  // overlap_tokens=0 (the line-split fallback is independent of overlap).
  const SPAN_HALF_A = "word ".repeat(50).trim();
  const SPAN_HALF_B = "term ".repeat(50).trim();
  const SPAN_S7 = [
    "## CodeTalk",
    "",
    "Lead prose line that opens the gapless block with content before the span begins okay here now.",
    `Inline span begins now \`SPANOPEN ${SPAN_HALF_A}`,
    `${SPAN_HALF_B} SPANCLOSE\` and then the span has closed and prose keeps going onward after it here.`,
    "Trailing prose line continues the gapless block with more content after the inline span closes.",
  ].join("\n");

  // A2 — a DOUBLE-backtick inline span (`` `` … `` ``, CommonMark §6.1, used when
  // the inline code itself contains a backtick) crossing a soft line break in an
  // oversized GAPLESS paragraph. The two halves are each long enough that the
  // line-split fallback's merge MUST break between them, landing the `` `` ``
  // opener and the `` `` `` closer in adjacent chunks. At the pre-fix HEAD the
  // grouping/guard parity decision (`backtickCount % 2`) sees TWO backticks on
  // the opening line → parity EVEN immediately → the unit is flushed mid-span, so
  // each chunk carries a balanced-PARITY (2) but unbalanced-RUN dangling `` ``
  // delimiter. The parity oracle CANNOT see this; the exact-run oracle does. RED
  // at overlap_tokens=0 (line-split is overlap-independent) AND 50.
  const DBL_HALF_A = "alpha ".repeat(45).trim();
  const DBL_HALF_B = "omega ".repeat(45).trim();
  const SPAN_DBL = [
    "## DoubleTick",
    "",
    "Lead prose that opens the gapless block before the double-backtick span begins here for sure.",
    `Here the span opens \`\`DBLOPEN ${DBL_HALF_A}`,
    `${DBL_HALF_B} DBLCLOSE\`\` and now the double-backtick span has closed while prose keeps flowing on.`,
    "Trailing prose line continues the gapless block with more content after the double-backtick span.",
  ].join("\n");

  // A1 — a SINGLE interior code-fence delimiter (a lone ```` ``` ````) inside a
  // compact `~~~`-wrapped block (the real Markdown way to DISPLAY a fence
  // delimiter: wrap it in `~~~`), followed GAPLESSLY by a trailing prose line and
  // preceded gaplessly by a short intro line. The block is small enough that, at
  // overlap_tokens=50 (window = 200 chars), the multi-line overlap window for the
  // FOLLOWING chunk spans the WHOLE `~~~ … ``` … ~~~` block: the retained lines
  // are fence-BALANCED (the `~~~` opens and closes), yet carry the interior
  // ```` ``` ```` (3 backticks, ODD total) — and the window's LAST line is the
  // trailing prose, NOT a fence delimiter, so guard (a) (last-line-only) misses
  // it. At the pre-fix HEAD the FENCE-UNAWARE parity guard (b) misclassifies the
  // interior ```` ``` ```` as an open inline span and DROPS up to and including
  // it, severing the outer fence's opening `~~~` and leaving the closing `~~~` as
  // a phantom opener → a HALF-OPEN fence in the served chunk. After the drop the
  // backtick count is even, so the "if still odd" fallback never fires. The
  // interior backticks are all INSIDE the `~~~` fence, so the inline-backtick
  // oracles correctly see ZERO inline backticks. RED at overlap_tokens=50,
  // balanced at 0.
  const A1_PROSE = Array.from(
    { length: 14 },
    (_, i) =>
      `Lead prose line ${i} fills this section out so the chunk boundary lands well.`,
  );
  const SPAN_INTERIOR_FENCE = [
    "## FenceDisplay",
    "",
    ...A1_PROSE,
    "",
    "Intro line right before the tilde block here.",
    "~~~md",
    "Type this to close a fence:",
    "```",
    "done now",
    "~~~",
    "Tail prose right after the closing tilde fence keeps going on a gapless line here for sure.",
    "",
    "## NextSection",
    "",
    "Body prose for the next section so it owns indexable content of its own here now.",
  ].join("\n");

  const balanceCorpus: Array<{ name: string; doc: string }> = [
    { name: "S4 overlap-tail carries a lone backtick", doc: SPAN_S4 },
    { name: "S7 line-split severs an inline span", doc: SPAN_S7 },
    {
      name: "A2 double-backtick span severed across a soft break",
      doc: SPAN_DBL,
    },
    {
      name: "A1 interior ``` fence inside a ~~~ block (overlap window opens in-fence)",
      doc: SPAN_INTERIOR_FENCE,
    },
    {
      // A complete inline span on a single short line — the simplest balanced
      // shape; must remain balanced regardless of overlap / line-ending.
      name: "single-line complete inline span",
      doc: [
        "## Simple",
        "",
        "Use the `inline_code` token in the middle of this prose sentence here.",
        "",
        "More prose to follow afterward in a second paragraph for substance.",
      ].join("\n"),
    },
    {
      // A complete span adjacent to a fenced block: the fence's backticks must
      // be excluded by the oracle, and the inline span must stay balanced.
      name: "inline span next to a fenced block",
      doc: [
        "## Mixed",
        "",
        "Inline `tok` before a fence.",
        "",
        "```js",
        "const x = 1;",
        "```",
        "",
        "Inline `tok2` after the fence.",
      ].join("\n"),
    },
  ];

  const BALANCE_OVERLAPS = [0, 50];
  const BALANCE_EOLS: Array<{ label: string; apply: (s: string) => string }> = [
    { label: "LF", apply: (s) => s },
    { label: "CRLF", apply: (s) => s.replace(/\n/g, "\r\n") },
  ];

  for (const overlap of BALANCE_OVERLAPS) {
    for (const eol of BALANCE_EOLS) {
      for (const tc of balanceCorpus) {
        it(`inline-backtick balance holds (overlap_tokens=${overlap}, ${eol.label}): ${tc.name}`, () => {
          // Oracle self-check: the SOURCE doc has balanced inline backticks
          // (parity AND exact-run) and balanced fences, so any imbalance in a
          // produced chunk is a SEVERANCE introduced by splitting/overlap, never
          // pre-existing source imbalance.
          expect(
            inlineBacktickCountOutsideFences(tc.doc) % 2,
            "source corpus must have balanced inline backticks (parity)",
          ).toBe(0);
          expect(
            inlineCodeBalancedExactRun(tc.doc),
            "source corpus must have balanced inline code spans (exact run)",
          ).toBe(true);
          expect(
            fenceBalancedOracle(tc.doc),
            "source corpus must have balanced fences",
          ).toBe(true);

          const chunks = chunkMarkdown(
            eol.apply(tc.doc),
            "test.md",
            mkConfig({ target_tokens: 100, overlap_tokens: overlap }),
          );
          expect(chunks.length).toBeGreaterThan(0);
          for (const chunk of chunks) {
            const n = inlineBacktickCountOutsideFences(chunk.content);
            expect(
              n % 2,
              `chunk has unbalanced inline backticks parity (${n}): ${JSON.stringify(
                chunk.content.slice(0, 120),
              )}`,
            ).toBe(0);
            // A2: exact-run-length pairing catches a severed multi-backtick span
            // that parity misses (each half has an even count but a dangling
            // run). RED at HEAD for the double-backtick corpus shape.
            expect(
              inlineCodeBalancedExactRun(chunk.content),
              `chunk leaves a multi-backtick delimiter unbalanced: ${JSON.stringify(
                chunk.content.slice(0, 160),
              )}`,
            ).toBe(true);
            // A1: no chunk may carry a half-open code fence (the guard-(b) drop
            // must never sever a balanced fence). RED at HEAD for the interior-
            // ```-fence corpus shape at overlap_tokens=50.
            expect(
              fenceBalancedOracle(chunk.content),
              `chunk carries a half-open fence: ${JSON.stringify(
                chunk.content.slice(0, 200),
              )}`,
            ).toBe(true);
          }
        });
      }
    }
  }

  // ── LEVER 2: ReDoS timing + `{expr > val}` strip completeness ────────────
  //
  // A doc carrying BOTH a paired JSX component AND a self-closing JSX component
  // each with 30–50 well-formed attributes must chunk in well under a small
  // budget. At the pre-fix HEAD the paired regex `(?:"[^"]*"|'[^']*'|[^>])*` is
  // ambiguous (a quoted attr matches BOTH alternatives), so a prop-heavy paired
  // tag backtracks exponentially (~doubling per attribute: 17 attrs ≈ 0.6s, ~20
  // hangs) — far past 500ms. The MAX_STRIP_PASSES cap does NOT help: the blowup
  // is inside ONE .replace(). The fix is a linear, single-pass JSX tag scanner.
  it("strips prop-heavy paired AND self-closing JSX tags without catastrophic backtracking", () => {
    const manyAttrs = (n: number): string =>
      Array.from({ length: n }, (_, i) => `attr${i}="value${i}"`).join(" ");
    const paired = `<Paired ${manyAttrs(40)}>inner paired content</Paired>`;
    const selfClosing = `<SelfClose ${manyAttrs(40)} />`;
    // Order is load-bearing for the RED proof: the self-closing tag comes FIRST
    // (the self-closing pass consumes it cleanly), then the PAIRED tag with NO
    // trailing `/>` after it. With the order reversed, the self-closing pass'
    // global scan would greedily match from `<Paired` to the later `/>` and
    // delete the paired tag as a side effect BEFORE the paired regex runs,
    // masking the hang. As written, the paired regex faces the 40-attr paired
    // tag and backtracks exponentially (well past minutes) at the pre-fix HEAD.
    const content = [
      "## Heavy",
      "",
      "Intro prose before the components.",
      "",
      selfClosing,
      "",
      paired,
      "",
      "Outro prose after the components.",
    ].join("\n");

    const start = Date.now();
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    const elapsed = Date.now() - start;

    // Linear scanner ⇒ trivially under budget. The exponential regex blows
    // well past this (it hangs for minutes) on a 40-attr paired tag, so at the
    // pre-fix HEAD this test fails by TIMING OUT under vitest's testTimeout
    // before ever reaching the assertions below.
    expect(
      elapsed,
      `stripping prop-heavy JSX took ${elapsed}ms (catastrophic backtracking?)`,
    ).toBeLessThan(500);

    const joined = chunks.map((c) => c.content).join("\n");
    // Both component tags are stripped; the paired tag's inner content is kept.
    expect(joined).not.toContain("<Paired");
    expect(joined).not.toContain("</Paired");
    expect(joined).not.toContain("<SelfClose");
    expect(joined).toContain("inner paired content");
    expect(joined).toContain("Intro prose before the components.");
    expect(joined).toContain("Outro prose after the components.");
  });

  it("strips a self-closing JSX tag whose attribute is a JSX expression containing `>`", () => {
    // `<Foo a={b > c} />` — the `>` lives inside an unquoted JSX EXPRESSION,
    // not a quoted string. At the pre-fix HEAD `[^>]*` truncates at that `>`, so
    // the tag is NOT matched and SURVIVES into the served text. The linear
    // scanner tracks `{…}` expression depth so the inner `>` no longer ends the
    // tag, and the whole self-closing tag is stripped.
    const content = [
      "Before the foo component here.",
      "",
      "<Foo a={b > c} />",
      "",
      "After the foo component here.",
    ].join("\n");
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    const joined = chunks.map((c) => c.content).join("\n");
    expect(joined).not.toContain("<Foo");
    expect(joined).not.toContain("b > c");
    expect(joined).toContain("Before the foo component here.");
    expect(joined).toContain("After the foo component here.");
  });

  // ── LEVER 3: a side-effect import spanning a newline must not eat prose ───
  //
  // Mirrors the existing from-import blank-line test: a side-effect
  // `import "x";` (no `from`) on its OWN line, then a blank line, then a
  // quoted-string line, with prose on both sides. At the pre-fix HEAD the
  // side-effect-import regex used `import\s+['"]…`, and `\s` matches a newline,
  // so `import\n\n"./x.css";` was treated as ONE statement and the whole span
  // (including any masked prose between, and the surrounding blank lines) was
  // collapsed — destroying content. The fix is `[ \t]+`, keeping the statement
  // on a single logical line. The dangling `import` / quoted-string lines (which
  // are NOT a single import) and the surrounding prose must all survive.
  it("does not let a side-effect import strip span a blank line", () => {
    const content = [
      "First real paragraph that must survive the side-effect import strip.",
      "",
      "import",
      "",
      '"./styles.css";',
      "",
      "Second real paragraph that must survive the side-effect import strip.",
    ].join("\n");
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    const joined = chunks.map((c) => c.content).join("\n");
    expect(joined).toContain(
      "First real paragraph that must survive the side-effect import strip.",
    );
    expect(joined).toContain(
      "Second real paragraph that must survive the side-effect import strip.",
    );
    // The `import` / `"./styles.css";` lines span a blank line, so they are NOT
    // a single side-effect import statement and must NOT be stripped — the
    // over-broad `import\s+['"]…` (with `\s` matching `\n`) deleted the span.
    expect(joined).toContain("import");
    expect(joined).toContain('"./styles.css";');
  });

  it("still strips a normal single-line side-effect import", () => {
    // Regression guard for the blank-line fix: a real single-line side-effect
    // import must still be stripped.
    const content =
      'import "./globals.css";\n\nProse after the side-effect import.';
    const chunks = chunkMarkdown(content, "test.mdx", mkConfig());
    const joined = chunks.map((c) => c.content).join("\n");
    expect(joined).not.toContain('import "./globals.css";');
    expect(joined).toContain("Prose after the side-effect import.");
  });
});

// ── Inlined-snippet byte normalization ──────────────────────────────────────
//
// chunkMarkdown normalizes the HOST content up front: CRLF → LF and the four PUA
// sentinels U+E000–U+E003 are stripped BEFORE any parsing/masking. But snippet
// imports (`@/snippets/*.mdx`) are inlined AFTER that, by inlineSnippetImports,
// which reads each snippet file RAW from disk (fs.readFileSync, no line-ending
// normalization, no PUA strip) and injects those bytes into the body. stripMdx
// does not strip `\r` either, so a CRLF- or PUA-authored snippet would otherwise
// bypass BOTH host normalizations:
//   - CRLF: the single-line heading/fence predicates ($/. do not match `\r`)
//     fail on the inlined snippet lines, so the snippet's headings degrade to
//     headingPath=[], the title falls back to the filename, and `\r` leaks into
//     served chunk content — SILENTLY (the inlined text is still a verbatim
//     substring of the post-inline body, so the heading-path warning never
//     fires).
//   - PUA: a literal sentinel in a snippet survives into the masking passes,
//     breaking the "placeholder namespace is exclusively ours downstream"
//     guarantee and potentially surviving into a served chunk.
// chunkMarkdown must re-apply BOTH normalizations to the inlined body so
// reinjected snippet bytes match the host's normalization.
//
// These tests exercise the REAL snippet path: a temp dir holds a `snippets/`
// subtree (so inlineSnippetImports' findAliasRoot locates the `@/` alias root)
// plus a host doc that imports the snippet. The bad bytes are written RAW to the
// snippet file so they only ever enter the pipeline through fs.readFileSync —
// exactly the path that bypasses the host normalization. A real temp file (over
// a module mock) verifies the on-disk read end-to-end and matches this suite's
// mock-free convention.
describe("chunkMarkdown inlined-snippet byte normalization", () => {
  const tmpDirs: string[] = [];

  function makeProject(
    snippetRelPath: string,
    snippetBytes: string,
  ): {
    hostAbsPath: string;
    hostBody: string;
  } {
    // A unique project root containing snippets/ (the alias root marker) and a
    // docs/ subdir holding the host page. findAliasRoot walks up from the host
    // dir until it finds an ancestor containing snippets/, so the host must live
    // BELOW the root that holds snippets/.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-snippet-test-"));
    tmpDirs.push(root);
    const snippetAbs = path.join(root, "snippets", snippetRelPath);
    fs.mkdirSync(path.dirname(snippetAbs), { recursive: true });
    // Write RAW bytes — no normalization — so the bad bytes only enter via the
    // inlineSnippetImports fs.readFileSync path.
    fs.writeFileSync(snippetAbs, snippetBytes, "utf-8");
    const docsDir = path.join(root, "docs");
    fs.mkdirSync(docsDir, { recursive: true });
    const hostAbsPath = path.join(docsDir, "host.mdx");
    const hostBody = [
      `import Snippet from "@/snippets/${snippetRelPath}";`,
      "",
      "Host intro paragraph before the snippet.",
      "",
      "<Snippet />",
      "",
      "Host outro paragraph after the snippet.",
    ].join("\n");
    return { hostAbsPath, hostBody };
  }

  afterEach(() => {
    while (tmpDirs.length) {
      const dir = tmpDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes CRLF in an inlined snippet (headings captured, title from snippet, no \\r leaks)", () => {
    // The snippet is CRLF-authored: two `##` headings + a fenced code block, all
    // with `\r\n` line endings. Padding pushes each section past the target so
    // the splitter cuts on the snippet's headings (and the post-fence heading
    // opens its own chunk, proving the fence closed rather than running to EOF).
    const big = "Word ".repeat(120).trim();
    const snippetBytes = [
      "## Snippet Alpha",
      "",
      big,
      "",
      "```js",
      "const fromSnippet = 1;",
      "```",
      "",
      "## Snippet Beta",
      "",
      big,
    ].join("\r\n");
    const { hostAbsPath, hostBody } = makeProject(
      "shared/crlf-snippet.mdx",
      snippetBytes,
    );

    const chunks = chunkMarkdown(
      hostBody,
      "host.mdx",
      mkConfig({ target_tokens: 100, overlap_tokens: 0 }),
      hostAbsPath,
    );
    expect(chunks.length).toBeGreaterThan(0);

    // (a) The snippet's headings ARE captured — headingPath is NOT the degraded
    //     [] that a trailing-`\r` line produces.
    const allHeadings = new Set(chunks.flatMap((c) => c.headingPath ?? []));
    expect(allHeadings.has("Snippet Alpha")).toBe(true);
    expect(allHeadings.has("Snippet Beta")).toBe(true);

    // (b) The derived title is the snippet's first heading (the host has no
    //     frontmatter and no heading of its own), NOT the filename fallback.
    expect(chunks[0].title).toBe("Snippet Alpha");
    expect(chunks[0].title).not.toBe("host.mdx");

    // (c) No `\r` survives into any served chunk content.
    for (const chunk of chunks) {
      expect(chunk.content.includes("\r")).toBe(false);
    }
  });

  it("strips a literal PUA sentinel that arrives via an inlined snippet", () => {
    // The snippet prose carries the four masking sentinels (U+E000–U+E003),
    // including a heading-sentinel SHAPE pointing at index 0 — the same
    // collision the host-side strip neutralizes, but arriving through the
    // raw-read snippet path that bypasses it.
    const OPEN_H = String.fromCharCode(0xe002);
    const CLOSE_H = String.fromCharCode(0xe003);
    const OPEN_C = String.fromCharCode(0xe000);
    const CLOSE_C = String.fromCharCode(0xe001);
    const snippetBytes = [
      "## Snippet Heading",
      "",
      `Snippet prose with a literal ${OPEN_H}0${CLOSE_H} sentinel and a ${OPEN_C}1${CLOSE_C} code sentinel.`,
    ].join("\n");
    const { hostAbsPath, hostBody } = makeProject(
      "shared/pua-snippet.mdx",
      snippetBytes,
    );

    const chunks = chunkMarkdown(
      hostBody,
      "host.mdx",
      mkConfig({ target_tokens: 80, overlap_tokens: 0 }),
      hostAbsPath,
    );
    expect(chunks.length).toBeGreaterThan(0);

    // No PUA sentinel may survive into any served chunk content.
    for (const chunk of chunks) {
      expect(/[\u{E000}-\u{E003}]/u.test(chunk.content)).toBe(false);
    }
  });
});
