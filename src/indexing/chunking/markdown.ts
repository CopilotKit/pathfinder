// Recursive markdown/MDX splitter

import { type ChunkOutput, type SourceConfig } from "../../types.js";
import { inlineSnippetImports } from "./snippets.js";

const DEFAULT_TARGET_TOKENS = 600;
const DEFAULT_OVERLAP_TOKENS = 50;

// ── Shared CommonMark predicates ───────────────────────────────────────────
//
// The chunker has several detection paths — extractFirstHeading,
// getHeadingPathAtPosition, splitOnHeading, segmentCodeBlocks — that historically
// each carried its OWN regex and disagreed on CommonMark edge cases (indent,
// separator, closing-`#` sequences, fence length/indent). The constants and
// helpers below are the SINGLE source of truth they all build on, so they cannot
// drift apart.

// ATX heading indent: 0–3 leading SPACES only. A leading tab counts as 4 columns
// in CommonMark, so a tab-indented `#` line is an indented code line, NOT a
// heading. (This is why the fragment is ` {0,3}`, never `[ \t]{0,3}`.)
const HEADING_INDENT = " {0,3}";
// Separator between the `#`-run and the heading text: one-or-more space OR tab
// (CommonMark). Using `[ \t]+` (not `\s+`) keeps the separator on the same line:
// a bare `#`/`##` line with no inline text must NOT skip the newline and adopt
// the following line as its text.
const HEADING_SEP = "[ \\t]+";

// Single-line form of the shared heading predicate (no `g`/`m`; the input is one
// line with no embedded newline). Capture group 1 is the `#`-run, group 2 is the
// raw heading text (still carrying any trailing closing-`#` sequence / `{#anchor}`,
// which stripHeadingText removes). `.*` is safe because a single line has no `\n`.
const HEADING_LINE_RE = new RegExp(
  `^${HEADING_INDENT}(#{1,6})${HEADING_SEP}(\\S.*)$`,
);

/**
 * The ONE shared heading predicate. Given a SINGLE line (no embedded newline),
 * return its CommonMark ATX heading level + normalized text, or null. All
 * text-extracting callers (extractFirstHeading, getHeadingPathAtPosition's
 * leading-line check, and its line-by-line scan) funnel through this, so they
 * cannot disagree on indent / separator / closing-`#` / `{#anchor}`. splitOnHeading
 * does not extract text, so it shares the same HEADING_INDENT + HEADING_SEP
 * fragments via a level-specific boundary lookahead (see splitOnHeading).
 */
function matchHeadingLine(
  line: string,
): { level: number; text: string } | null {
  const m = HEADING_LINE_RE.exec(line);
  if (!m) return null;
  const level = m[1].length;
  const text = stripHeadingText(m[2]);
  if (!text) return null;
  return { level, text };
}

/**
 * Return the heading the slice OPENS with (its first line), or null. Used to
 * extend the heading-path scan to include a chunk's own leading heading without
 * matching a heading that appears later in the slice.
 */
function matchLeadingHeading(
  slice: string,
): { level: number; text: string } | null {
  const nl = slice.indexOf("\n");
  const firstLine = nl === -1 ? slice : slice.slice(0, nl);
  return matchHeadingLine(firstLine);
}

/**
 * Normalize captured ATX heading text to its CommonMark display form:
 *  - strip an optional trailing closing `#`-sequence (`## Heading ##` → "Heading";
 *    `# Title #` → "Title"). The closing run must be preceded by whitespace (or be
 *    the whole text), so `foo###` keeps its hashes per CommonMark.
 *  - strip a trailing docs anchor `{#some-id}` (Docusaurus/Nextra), so the
 *    embedded title/headingPath does not carry anchor noise.
 *
 * title and headingPath are embedded into the retrieval vector, so all three
 * heading detectors route their captured text through this one function and thus
 * agree on the final text.
 *
 * ORDER IS LOAD-BEARING: the closing-`#` sequence is stripped FIRST, then the
 * `{#anchor}`. On `## X {#a} ##` this yields "X"; reversing the two passes
 * (anchor-first) would leave "X {#a}". The test oracle's normalizeHeadingText
 * MUST mirror this exact order or the two disagree and the structural-invariant
 * soundness check falsely fails.
 */
function stripHeadingText(raw: string): string {
  let text = raw.trim();
  // Trailing closing `#`-sequence (preceded by whitespace, or the whole text).
  text = text.replace(/(^|[ \t])#+[ \t]*$/, "$1").trimEnd();
  // Trailing docs anchor `{#anchor}` (optionally followed by spaces/tabs).
  text = text.replace(/[ \t]*\{#[^}]*\}[ \t]*$/, "").trimEnd();
  return text;
}

interface FenceMarker {
  char: string; // "`" or "~"
  len: number; // run length of the opening fence
}

/**
 * Shared fence-open predicate. An OPENING code fence is 0–3 leading spaces, then
 * a run of ≥3 backticks or ≥3 tildes (CommonMark allows the same 0–3-space indent
 * as a heading; column 0 is NOT required). Returns the fence char + run length,
 * or null.
 *
 * CommonMark §4.5: a BACKTICK fence's info string may NOT contain a backtick
 * (otherwise the line is an inline code span, e.g. `` ```js``` inline ``, not a
 * fence opener); a TILDE fence's info string may contain backticks but not
 * tildes. Rejecting such lines here is what stops a col-0 inline triple-backtick
 * span from opening a phantom fence that runs to EOF and masks every following
 * heading as "code".
 */
function matchFenceOpen(line: string): FenceMarker | null {
  const m = line.match(/^ {0,3}(`{3,}|~{3,})([^\n]*)$/);
  if (!m) return null;
  const char = m[1][0];
  // The info string (rest of the line after the opening run) must not contain
  // the fence character: backticks are forbidden in a backtick fence's info
  // string, tildes in a tilde fence's. A real opener's info string is just a
  // language tag (no fence char), so this never rejects a genuine fence.
  if (m[2].includes(char)) return null;
  return { char, len: m[1].length };
}

/**
 * Shared fence-close predicate. A CLOSING fence uses the SAME fence char, 0–3
 * leading spaces, a run of length GREATER-OR-EQUAL to the opener (CommonMark
 * permits a longer closing fence), and only trailing spaces/tabs after the run
 * (a closing fence carries no info string).
 */
function isFenceClose(line: string, open: FenceMarker): boolean {
  const fenceChar = open.char === "`" ? "\\`" : "~";
  const re = new RegExp(`^ {0,3}(${fenceChar}{${open.len},})[ \\t]*$`);
  return re.test(line);
}

/**
 * Parse YAML frontmatter from markdown content.
 * Returns the title (if found) and the content with frontmatter stripped.
 */
function parseFrontmatter(content: string): {
  title: string | null;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { title: null, body: content };

  const frontmatter = match[1];
  const body = content.slice(match[0].length);

  // Capture the raw title value (everything after `title:` on its line), then
  // strip ONLY a BALANCED pair of surrounding quotes. The prior regex used two
  // INDEPENDENT `["']?` around a `(.+?)` that required ≥1 char, so `title: ""`
  // captured a stray `"` (and `title: ''` a stray `'`), which is truthy and
  // defeats the `fmTitle || extractFirstHeading || filename` fallback — embedding
  // a lone quote as the title. The `(["'])([\s\S]*)\1` backreference strips a
  // quote pair only when BOTH ends match; the GREEDY `[\s\S]*` makes the
  // backreference bind to the LAST same-quote char, so only the OUTERMOST
  // balanced pair is removed (e.g. `"a "b" c"` → `a "b" c`). An unbalanced or
  // absent quote leaves the value literal (so `5'6" tall` keeps its internal
  // quotes). An empty or whitespace-only result is treated as ABSENT (null) so
  // the heading/filename fallback applies.
  const titleMatch = frontmatter.match(/^title:[ \t]*(.*?)[ \t]*$/m);
  let title: string | null = null;
  if (titleMatch) {
    const raw = titleMatch[1];
    const quoted = raw.match(/^(["'])([\s\S]*)\1$/);
    const value = (quoted ? quoted[2] : raw).trim();
    title = value === "" ? null : value;
  }
  return {
    title,
    body,
  };
}

/**
 * Extract the first heading from content to use as fallback title.
 *
 * Fenced code is masked first (via segmentCodeBlocks): a `#`-prefixed line inside
 * a ``` or ~~~ fence is example/documentation text, not a heading, so a doc that
 * OPENS with a fenced block whose first line is `# something` must not adopt that
 * line as its title. The heading match uses the SHARED predicate (matchHeadingLine
 * → stripHeadingText), so the indent rule (0–3 spaces, never a tab), the
 * space-or-tab separator, and the closing-`#`/`{#anchor}` stripping are identical
 * to getHeadingPathAtPosition. The first heading found scanning non-code segments
 * in order wins.
 */
function extractFirstHeading(content: string): string | null {
  for (const segment of segmentCodeBlocks(content)) {
    if (segment.isCodeBlock) continue;
    for (const line of segment.text.split("\n")) {
      const heading = matchHeadingLine(line);
      if (heading) return heading.text;
    }
  }
  return null;
}

/**
 * Strip MDX-specific syntax: import statements and JSX component tags.
 * Preserves text content inside JSX tags.
 *
 * The strip passes are FENCE- and CODE-SPAN-AWARE: they run ONLY over non-code
 * segments (fenced ``` / ~~~ blocks pass through VERBATIM via segmentCodeBlocks),
 * and within a non-code segment the inline code spans (single/multi backtick
 * `` `...` ``) are masked so JSX/import-looking text inside them survives too.
 * Fenced code (e.g. a ```tsx block with `import {X} from 'y'` and `<Component/>`)
 * is the highest-value retrieval content Pathfinder serves, so it must never be
 * gutted by the MDX strip.
 */
function stripMdx(content: string): string {
  const out = segmentCodeBlocks(content)
    .map((segment) =>
      segment.isCodeBlock ? segment.text : stripNonCodeMdx(segment.text),
    )
    .join("");
  return trimBlankEdges(out);
}

/**
 * Trim leading/trailing BLANK LINES (and trailing whitespace) while PRESERVING
 * the first content line's intra-line leading indentation.
 *
 * A plain `.trim()` here strips the leading whitespace of the document's FIRST
 * content line before the spaces-only ATX-heading detectors run, so a doc whose
 * first non-blank line is `\t# X` or `    # X` (4+ spaces / tab = CommonMark
 * INDENTED CODE, NOT a heading) would have its indent removed and be wrongly
 * promoted to a heading/title — violating the file's `HEADING_INDENT = " {0,3}"`
 * invariant. Removing only WHOLE leading blank lines (`^(?:[ \t]*\n)+`) keeps
 * the prior "leading blank lines are ignored" behavior while letting the 0–3
 * vs 4+ space rule govern the first line too; trailing whitespace is stripped as
 * before, so the verbatim-substring binding downstream is unaffected.
 */
function trimBlankEdges(text: string): string {
  // Remove leading lines that are entirely blank (spaces/tabs then a newline),
  // but NOT the intra-line indentation of the first line that has content.
  const noLeadingBlankLines = text.replace(/^(?:[ \t]*\n)+/, "");
  // Strip trailing whitespace (incl. trailing newlines), matching .trim()'s end.
  return noLeadingBlankLines.replace(/\s+$/, "");
}

/**
 * Trim a produced chunk's edges for the SERVED/indexed content. Like `.trim()`
 * (the prior behavior) it removes leading blank lines + leading whitespace and
 * all trailing whitespace, EXCEPT it preserves a 4+-space (CommonMark
 * INDENTED-CODE) indent on the first content line.
 *
 * A plain `.trim()` strips the leading indent of a chunk whose first content line
 * is 4-space-indented — e.g. a doc that OPENS with `    ```lang` (CommonMark
 * indented code, NOT a fence) — turning it into a COLUMN-0 ` ```lang ` whose
 * still-indented closing `    ``` ` no longer closes it, leaving a HALF-OPEN
 * fence in the served chunk text. A 0–3-space (cosmetic) leading indent is still
 * stripped, so an indented HEADING like `  ## Section` continues to be served at
 * column 0 (preserving the existing stored-content contract); only a 4+-space
 * (semantic, indented-code) leading run is kept so the 0–3 vs 4+ space rule keeps
 * governing the served content. Trailing whitespace is always stripped, matching
 * `.trim()`'s end.
 */
function trimChunkEdges(text: string): string {
  // Drop whole leading blank lines first (spaces/tabs then newline).
  const noLeadingBlankLines = text.replace(/^(?:[ \t]*\n)+/, "");
  // The first content line is CommonMark INDENTED CODE when it starts with 4+
  // spaces OR a tab (a tab counts as 4 columns). Preserve that semantic indent;
  // otherwise strip leading whitespace as .trim() did (so a 0–3-space cosmetic
  // indent on a heading is still served at column 0).
  const isIndentedCode = /^(?: {4}|\t)/.test(noLeadingBlankLines);
  const body = isIndentedCode
    ? noLeadingBlankLines
    : noLeadingBlankLines.replace(/^\s+/, "");
  return body.replace(/\s+$/, "");
}

interface JsxTag {
  kind: "self" | "open" | "close";
  name: string;
  // [start, end) byte range of the whole tag in the source string.
  start: number;
  end: number;
}

/**
 * Try to parse a JSX tag whose `<` is at `text[start]`. Returns the parsed tag
 * (self-closing, opening, or closing) and its end offset, or null when the run
 * starting at `<` is not a well-formed JSX component tag (so the caller emits
 * the `<` as literal text).
 *
 * This is the LINEAR-time replacement for the two backtracking strip regexes.
 * It walks the tag exactly once: a component name (`[A-Za-z_$][A-Za-z0-9_$.]*`,
 * covering member expressions like `Tabs.Tab` / `motion.div` and `_`/`$`), then
 * an attribute region whose `>`/`/>` terminator is found by tracking nesting
 * state instead of an ambiguous alternation:
 *   - inside a `"…"` or `'…'` string, a `>` (or `/`) is literal — this is what
 *     lets `<Callout type="a>b" />` keep the quoted `>`;
 *   - inside a `{…}` JSX expression (brace-depth > 0, with nested braces and
 *     quoted strings honored), a `>` is literal — this strips `<Foo a={b > c}/>`,
 *     which the old `[^>]*` truncated at the inner `>` and left behind;
 *   - at the top level, the FIRST `>` ends the tag, and a `/` immediately before
 *     it marks a self-closing tag.
 * Because every character is consumed at most once with O(1) state, total work
 * is linear in the tag length regardless of attribute count — no backtracking.
 */
function parseJsxTagAt(text: string, start: number): JsxTag | null {
  const n = text.length;
  let i = start + 1; // past "<"
  const isClose = text[i] === "/";
  if (isClose) i++;

  // Component name. JSX components start uppercase or `_`/`$`, but the strip has
  // always matched a leading lowercase too via the class below; keep that class
  // so member expressions and the existing accepted names parse identically.
  if (i >= n || !/[A-Za-z_$]/.test(text[i])) return null;
  const nameStart = i;
  i++;
  while (i < n && /[A-Za-z0-9_$.]/.test(text[i])) i++;
  const name = text.slice(nameStart, i);

  if (isClose) {
    // `</Name>` — only whitespace allowed before the closing `>`.
    while (i < n && /\s/.test(text[i])) i++;
    if (i < n && text[i] === ">") {
      return { kind: "close", name, start, end: i + 1 };
    }
    return null;
  }

  // Opening or self-closing tag: scan the attribute region for the terminating
  // `>` / `/>`, tracking quote and `{…}` expression nesting so an inner `>` is
  // not mistaken for the tag end.
  let braceDepth = 0;
  let quote: '"' | "'" | "`" | null = null;
  while (i < n) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      i++;
      continue;
    }
    if (ch === "{") {
      braceDepth++;
      i++;
      continue;
    }
    if (ch === "}") {
      if (braceDepth > 0) braceDepth--;
      i++;
      continue;
    }
    if (braceDepth > 0) {
      // Inside a JSX expression: `>` and `/` are literal.
      i++;
      continue;
    }
    if (ch === ">") {
      const selfClosing = i > start && text[i - 1] === "/";
      return { kind: selfClosing ? "self" : "open", name, start, end: i + 1 };
    }
    i++;
  }
  // Reached EOF without a terminating `>`: not a complete tag.
  return null;
}

/**
 * Strip JSX component tags from a (heading- and inline-code-masked) text in a
 * SINGLE linear pass: self-closing `<Name … />` tags are removed entirely, and a
 * matched `<Name …>inner</Name>` pair is reduced to `inner` (innermost-out, so
 * nested pairs are all unwrapped). An OPENING tag with no matching same-name
 * closer, or a CLOSING tag with no opener, is left VERBATIM — preserving the old
 * regexes' behavior (the paired regex required a `\1` close; the self-closing
 * regex required `/>`), so a lone `<Wrapper>` with no `</Wrapper>` is not eaten.
 *
 * Linear time: parseJsxTagAt consumes each tag's characters once with O(1)
 * state, and the matching uses a stack of open-tag positions, so there is no
 * catastrophic backtracking on any attribute count (the bug the old
 * `(?:"[^"]*"|'[^']*'|[^>])*` alternation introduced).
 */
function stripJsxTags(text: string): string {
  const n = text.length;
  // First, locate every well-formed tag (linear scan). Characters NOT part of a
  // tag are literal text. A `<` that does not parse as a tag is literal too.
  const tags: JsxTag[] = [];
  let i = 0;
  while (i < n) {
    if (text[i] === "<") {
      const tag = parseJsxTagAt(text, i);
      if (tag) {
        tags.push(tag);
        i = tag.end;
        continue;
      }
    }
    i++;
  }
  if (tags.length === 0) return text;

  // Decide which tag ranges to DROP (their markup is removed; any text between a
  // matched open/close pair is kept). Self-closing tags always drop. For paired
  // tags, match each close to the NEAREST preceding unmatched open of the same
  // name (mirrors the lazy `<Name>…?</Name>` regex), via a stack.
  const drop = new Set<number>(); // indices into `tags` whose markup is removed
  const openStack: number[] = []; // indices of currently-open `open` tags
  for (let t = 0; t < tags.length; t++) {
    const tag = tags[t];
    if (tag.kind === "self") {
      drop.add(t);
    } else if (tag.kind === "open") {
      openStack.push(t);
    } else {
      // close: find the nearest open of the same name on the stack.
      let k = openStack.length - 1;
      while (k >= 0 && tags[openStack[k]].name !== tag.name) k--;
      if (k >= 0) {
        drop.add(openStack[k]); // matched open
        drop.add(t); // this close
        openStack.length = k; // unmatched opens above it stay (verbatim)
      }
      // An unmatched close stays verbatim (not added to `drop`).
    }
  }

  // Rebuild: emit literal text, skip dropped tag ranges, and emit the verbatim
  // source of any tag we did not drop (unmatched open/close).
  let out = "";
  let cursor = 0;
  for (let t = 0; t < tags.length; t++) {
    const tag = tags[t];
    out += text.slice(cursor, tag.start); // literal text before this tag
    if (!drop.has(t)) {
      out += text.slice(tag.start, tag.end); // keep an unmatched tag verbatim
    }
    cursor = tag.end;
  }
  out += text.slice(cursor);
  return out;
}

/**
 * Apply the MDX strip passes to a single NON-code segment. ATX heading lines and
 * inline code spans are masked with placeholders first so their (possibly
 * JSX/import-looking) content is preserved verbatim, then restored after the
 * passes.
 *
 * HEADING-AWARENESS (load-bearing): the JSX/import strip regexes are global and
 * NOT line-anchored, so without protection a `<Component/>` / `<Tag>..</Tag>`
 * that NAMES a component INSIDE an ATX heading (`## The <CopilotKit /> Provider`,
 * `## <Badge />`) would be stripped — corrupting the heading in title, headingPath
 * AND served content (all derive from the post-strip body). CopilotKit docs
 * routinely name components in headings, so heading lines are masked (like inline
 * code and fenced code) and pass through VERBATIM. Heading lines are masked FIRST
 * (on the original text) so any inline code inside a heading is hidden as part of
 * the opaque heading unit; the remaining prose is then inline-masked and stripped
 * normally, so JSX on PROSE lines is still removed.
 */
function stripNonCodeMdx(text: string): string {
  const { masked: headingMasked, restore: restoreHeadings } =
    maskHeadingLines(text);
  const { masked, restore } = maskInlineCode(headingMasked);
  let result = masked;

  // Strip side-effect imports first: `import "./x.css";` (no `from`). Handled
  // separately from `from`-imports so the lazy body of a `from`-import can never
  // jump across a side-effect import. The inter-token whitespace is `[ \t]+`
  // (NOT `\s+`): `\s` matches a newline, so the old `\s+` let `import\n\n"./x"`
  // match as ONE statement across a blank line and deleted the whole span
  // (destroying any prose masked between). `[ \t]+` keeps the statement on a
  // single logical line, so a newline (let alone a blank line) can never be
  // spanned — mirroring the `from`-import fix below.
  result = result.replace(/^import[ \t]+['"][^'"]+['"];?[ \t]*$/gm, "");

  // Strip a single `from`-import statement, including the optional TypeScript
  // `type` modifier (`import type { Config } from "x"`, `import type Default from
  // "m"`, `import type * as NS from "m"`). The import CLAUSE between `import`
  // (and the optional `type`) and `from` is constrained to a real binding
  // grammar — `{ named }`, `* as NS`, or a default identifier optionally followed
  // by `, { named }`. The inter-token whitespace is `[ \t]+` (NOT `\s+`): `\s`
  // matches a newline, so the old `\s+` around `from` let `import Config\n\nfrom
  // "y";` match as ONE statement and deleted the whole span across the blank
  // line. Using `[ \t]+` keeps the statement on a single logical line.
  //
  // BRACE CONTENT IS LINE-BOUNDED: each named-import brace is `\{[^}\n]*\}`, NOT
  // `\{[^}]*\}`. `[^}]` ALSO matches a newline, so a dangling `import {` whose
  // closing `}` is lines away greedily consumed the intervening ATX headings and
  // prose and DELETED them silently (no warning) — `import {\n## Heading\nprose\n}
  // from "x";` ate the heading + prose. Excluding `\n` from the brace content
  // means an unclosed `{` cannot swallow subsequent lines: the `{named}`
  // alternative only matches when the closing `}` is on the SAME line as the
  // opening `{`. CONSEQUENCE (intentional, minimal): a WELL-FORMED multi-line
  // brace import (`import Foo, {\n X,\n} from "y";`) is no longer stripped — its
  // identifiers are on separate lines, so `[^}\n]*` does not span them. That is
  // an accepted trade: the hard requirement is that an `import {` must NEVER
  // delete markdown headings/prose, and the existing import tests only require
  // SINGLE-LINE brace imports to strip (which still do). A left-in multi-line
  // import is cosmetically present in served text but causes no CONTENT LOSS.
  //
  // This (a) cannot span a blank line or jump to a LATER import's `from` (each
  // alternative is bounded: braces stop at the first `}` OR the line end, a
  // default is a single identifier), and (b) does not match prose like
  // `import a value from "x"` (two bare words is not a valid import clause), so
  // ordinary sentences are not deleted.
  result = result.replace(
    /^import[ \t]+(?:type[ \t]+)?(?:\{[^}\n]*\}|\*[ \t]+as[ \t]+[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*(?:[ \t]*,[ \t]*\{[^}\n]*\})?)[ \t]+from[ \t]+['"][^'"]+['"];?[ \t]*$/gm,
    "",
  );

  // Strip JSX component tags (self-closing `<Name ... />` removed entirely;
  // paired `<Name ...>inner</Name>` reduced to its inner content, innermost-out)
  // via a SINGLE LINEAR scan — see stripJsxTags. This replaces the prior pair of
  // regexes whose attribute run `(?:"[^"]*"|'[^']*'|[^>])*` was ambiguous (a
  // quoted attr matched BOTH alternatives), giving exponential backtracking that
  // hung on a prop-heavy paired tag or a no-close opener with ~18+ attributes —
  // a blow-up INSIDE one `.replace()` that no outer pass cap could bound. The
  // scanner is linear in the input length on any attribute count, and (unlike
  // the old `[^>]*`) tracks `{…}` JSX-expression depth so a `>` inside an
  // unquoted expression (`<Foo a={b > c} />`) no longer truncates the tag.
  result = stripJsxTags(result);

  // Clean up excessive blank lines left by stripping (within this segment only,
  // so a fenced block's internal blank lines in a NEIGHBOURING code segment are
  // never collapsed).
  result = result.replace(/\n{3,}/g, "\n\n");

  // Restore inline code spans first, then heading lines (headings were masked
  // first, on the original text, so they must be restored last to re-emit the
  // verbatim heading — including any inline code it contained).
  return restoreHeadings(restore(result));
}

// Private-Use-Area sentinels delimiting a masked ATX HEADING line. Distinct from
// the inline-code sentinels (U+E000/U+E001) so the two maskers never collide.
const HEADING_OPEN = String.fromCharCode(0xe002);
const HEADING_CLOSE = String.fromCharCode(0xe003);

/**
 * Mask whole ATX heading lines with sentinel-delimited placeholders so the MDX
 * strip passes leave them untouched, preserving a component tag that NAMES a
 * component inside a heading (`## The <CopilotKit /> Provider`, `## <Badge />`).
 * Returns the masked text and a restore() that re-inserts the original heading
 * lines verbatim.
 *
 * A line is masked when it is a CommonMark ATX heading per the SHARED predicate
 * (matchHeadingLine → HEADING_LINE_RE): 0–3 leading spaces, 1–6 `#`, a space/tab
 * separator, then non-space text. Only the line's CONTENT is replaced; the
 * surrounding newlines are preserved, so block structure (and the later
 * `\n{3,}` collapse) is unaffected. Non-heading (prose) lines pass through so
 * JSX/imports in prose are still stripped.
 */
function maskHeadingLines(text: string): {
  masked: string;
  restore: (s: string) => string;
} {
  const headings: string[] = [];
  const masked = text
    .split("\n")
    .map((line) => {
      if (!matchHeadingLine(line)) return line;
      const token = `${HEADING_OPEN}${headings.length}${HEADING_CLOSE}`;
      headings.push(line);
      return token;
    })
    .join("\n");

  const restoreRe = new RegExp(`${HEADING_OPEN}(\\d+)${HEADING_CLOSE}`, "g");
  // Pass the original match through unchanged when the captured index is out of
  // range (defensive: a sentinel-shaped sequence we did not emit must never map
  // to `undefined`). chunkMarkdown strips literal PUA sentinels from input up
  // front, so this only guards against an internal invariant break.
  const restore = (s: string): string =>
    s.replace(restoreRe, (_m, idx) => headings[Number(idx)] ?? _m);
  return { masked, restore };
}

// Private-Use-Area sentinels delimiting an inline-code-span placeholder. PUA
// code points (U+E000, U+E001) cannot appear in real markdown source, so a
// placeholder like `<E000>3<E001>` can never collide with document text. Built
// via fromCharCode so the source file stays plain ASCII.
const CODESPAN_OPEN = String.fromCharCode(0xe000);
const CODESPAN_CLOSE = String.fromCharCode(0xe001);

/**
 * Mask inline code spans with sentinel-delimited placeholders so the MDX strip
 * passes leave their content untouched. Returns the masked text and a restore()
 * that re-inserts the original spans verbatim.
 *
 * CommonMark inline-code rule (§6.1): a code span opens with a backtick RUN of
 * length N and closes with a backtick run of EXACTLY length N — a longer run is
 * NOT a valid closer, and the opening/closing runs must not be flanked by more
 * backticks (the run-length is delimited by a non-backtick on the outer side).
 * A single `/(`+)([\s\S]*?)\1/` regex does NOT enforce the exact-length rule
 * (`\1` only requires the same TEXT, and greedy `(`+)` + backtracking mispairs
 * delimiters around a stray/odd backtick), leaving a real span unmasked so the
 * JSX/import strip then guts it. This scanner pairs runs by exact length so a
 * stray backtick between two genuine spans can no longer mis-delimit them.
 *
 * Inline parsing also never crosses a BLANK LINE or an ATX HEADING line:
 * CommonMark runs block parsing first, so a blank line splits text into separate
 * paragraphs and a heading is its own block — a code span cannot span either
 * boundary. Without this, a stray backtick on one line would wrongly pair with a
 * backtick beyond the boundary, exposing the intervening content (e.g. `<Bar/>`)
 * to the JSX strip. maskHeadingLines runs FIRST, so heading lines are already
 * opaque HEADING_OPEN…HEADING_CLOSE tokens here; the closer-search therefore
 * stops at a paragraph break AND at a heading-sentinel boundary.
 */
function maskInlineCode(text: string): {
  masked: string;
  restore: (s: string) => string;
} {
  const spans: string[] = [];
  let out = "";
  let i = 0;
  const n = text.length;

  // True when a blank line (paragraph break) begins at the newline `text[p]`:
  // the run of whitespace starting at p contains a SECOND newline before any
  // non-whitespace char. A code span cannot cross such a boundary.
  const blankLineAt = (p: number): boolean => {
    let q = p + 1; // skip the first newline
    while (q < n && (text[q] === " " || text[q] === "\t")) q++;
    return q < n && text[q] === "\n";
  };

  while (i < n) {
    if (text[i] !== "`") {
      out += text[i];
      i++;
      continue;
    }
    // Measure the opening backtick run [i, openEnd).
    let openEnd = i;
    while (openEnd < n && text[openEnd] === "`") openEnd++;
    const runLen = openEnd - i;

    // Find the next backtick run of EXACTLY runLen (not part of a longer run),
    // without crossing a blank line (paragraph break) OR an ATX heading line.
    let close = -1;
    let scan = openEnd;
    while (scan < n) {
      if (text[scan] === "\n" && blankLineAt(scan)) {
        // Paragraph break before any valid closer: this opening run cannot close.
        break;
      }
      if (text[scan] === HEADING_OPEN) {
        // ATX heading block boundary before any valid closer. maskHeadingLines
        // ran first, so a heading line is now an opaque HEADING_OPEN…
        // HEADING_CLOSE token; reaching its HEADING_OPEN means a closer would lie
        // on the far side of a heading block. CommonMark parses blocks before
        // inlines, so an inline code span cannot cross a heading — this opening
        // run therefore cannot close (mirrors the blank-line guard above).
        break;
      }
      if (text[scan] !== "`") {
        scan++;
        continue;
      }
      let candEnd = scan;
      while (candEnd < n && text[candEnd] === "`") candEnd++;
      if (candEnd - scan === runLen) {
        close = scan;
        break;
      }
      // A run of a different length cannot close this span; skip past it whole
      // (a longer/shorter run is not a valid closer and its backticks are
      // consumed so they cannot be re-read as a closer of the wrong length).
      scan = candEnd;
    }

    if (close === -1) {
      // No valid closer: this opening run is literal text, not a span opener.
      // Emit the run verbatim and continue scanning AFTER it.
      out += text.slice(i, openEnd);
      i = openEnd;
      continue;
    }

    // [i, close+runLen) is a complete code span (opening run + content + closer).
    const full = text.slice(i, close + runLen);
    const token = `${CODESPAN_OPEN}${spans.length}${CODESPAN_CLOSE}`;
    spans.push(full);
    out += token;
    i = close + runLen;
  }

  const restoreRe = new RegExp(`${CODESPAN_OPEN}(\\d+)${CODESPAN_CLOSE}`, "g");
  // Pass the original match through unchanged when the captured index is out of
  // range (defensive — see maskHeadingLines): a sentinel-shaped sequence we did
  // not emit must never map to `undefined`.
  const restore = (s: string): string =>
    s.replace(restoreRe, (_m, idx) => spans[Number(idx)] ?? _m);
  return { masked: out, restore };
}

/**
 * Split content while preserving code blocks intact.
 * Returns segments that are either code blocks or regular text.
 */
interface ContentSegment {
  text: string;
  isCodeBlock: boolean;
}

/**
 * Partition `content` into alternating non-code and fenced-code segments. Uses
 * the SHARED fence predicates (matchFenceOpen / isFenceClose) line-by-line —
 * NOT a single backreference regex — so it correctly handles every CommonMark
 * fence shape the heading detectors must agree with:
 *   - opening fences indented 0–3 spaces (column 0 is not required);
 *   - a closing fence whose run is LONGER than the opener (close len ≥ open len);
 *   - an UNCLOSED opening fence, which runs to END OF INPUT (the remainder is all
 *     code, so its `#` lines are never injected as fake headings).
 *
 * Segment boundaries are byte-exact: a code segment spans from the opening
 * fence's first column through the closing fence line's last NON-newline char,
 * so the newline AFTER the closing fence stays in the following non-code segment
 * (a `^`-anchored heading scan therefore still sees a heading that directly
 * follows the closing fence). Concatenating all segment texts reproduces
 * `content` verbatim.
 */
function segmentCodeBlocks(content: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  let lastIndex = 0; // start of the not-yet-emitted region
  let pos = 0; // running offset at the start of the current line
  let open: FenceMarker | null = null;
  let blockStart = 0; // offset of the opening fence (when inside a fence)

  // Walk one line at a time (a "line" excludes its trailing "\n"). `pos <=
  // content.length` lets a trailing newline still yield one final empty line.
  while (pos <= content.length) {
    const nl = content.indexOf("\n", pos);
    const lineEnd = nl === -1 ? content.length : nl; // excludes the "\n"
    const line = content.slice(pos, lineEnd);

    if (open) {
      if (isFenceClose(line, open)) {
        // Emit the preceding non-code text (if any), then the code block up to
        // the END of this closing-fence line (the trailing "\n" stays outside).
        if (blockStart > lastIndex) {
          segments.push({
            text: content.slice(lastIndex, blockStart),
            isCodeBlock: false,
          });
        }
        segments.push({
          text: content.slice(blockStart, lineEnd),
          isCodeBlock: true,
        });
        lastIndex = lineEnd;
        open = null;
      }
    } else {
      const m = matchFenceOpen(line);
      if (m) {
        open = m;
        blockStart = pos;
      }
    }

    if (nl === -1) break;
    pos = nl + 1;
  }

  // An UNCLOSED opening fence runs to END OF INPUT: emit any preceding text and
  // the remainder as one code segment.
  if (open) {
    if (blockStart > lastIndex) {
      segments.push({
        text: content.slice(lastIndex, blockStart),
        isCodeBlock: false,
      });
    }
    segments.push({ text: content.slice(blockStart), isCodeBlock: true });
    lastIndex = content.length;
  } else if (lastIndex < content.length) {
    segments.push({ text: content.slice(lastIndex), isCodeBlock: false });
  }

  return segments;
}

/**
 * Split text on a delimiter, but never split inside code blocks.
 */
function splitPreservingCodeBlocks(
  content: string,
  delimiter: string | RegExp,
): string[] {
  const segments = segmentCodeBlocks(content);
  const parts: string[] = [];
  let current = "";

  for (const segment of segments) {
    if (segment.isCodeBlock) {
      current += segment.text;
    } else {
      // String.prototype.split accepts both a string and a RegExp separator, so
      // a single call handles both delimiter forms (the prior string/RegExp
      // ternary had two identical branches).
      const subParts = segment.text.split(delimiter);

      if (subParts.length === 1) {
        current += subParts[0];
      } else {
        // First sub-part continues the current accumulator
        current += subParts[0];
        for (let i = 1; i < subParts.length; i++) {
          parts.push(current);
          // Re-attach a string heading delimiter (defensive: the sole caller
          // passes the paragraph RegExp `/\n\n+/`, so this branch is not
          // exercised today; it preserves correctness if a `#`-prefixed string
          // delimiter is ever passed).
          if (typeof delimiter === "string" && delimiter.startsWith("#")) {
            current = delimiter + subParts[i];
          } else {
            current = subParts[i];
          }
        }
      }
    }
  }
  if (current) {
    parts.push(current);
  }

  return parts.filter((p) => p.trim().length > 0);
}

interface HeadingInfo {
  level: number;
  text: string;
}

/**
 * Track heading hierarchy up to a given position in the original content.
 *
 * Headings are detected only outside fenced code blocks (segmentCodeBlocks masks
 * fenced regions): a `#`-prefixed line inside a ``` fence is documentation/example
 * text, not a real heading, and must never enter a chunk's headingPath (the path
 * is embedded into the retrieval vector). The heading match uses the SHARED
 * single-line predicate (matchHeadingLine), so indent (0–3 spaces), separator
 * (space OR tab), and closing-`#`/`{#anchor}` stripping are identical to
 * extractFirstHeading and splitOnHeading — they cannot disagree.
 *
 * The scan also includes the heading that the chunk at `position` opens with:
 * when a chunk begins with its own heading, that heading belongs in its
 * headingPath even though it sits at `position` rather than strictly before it.
 */
function getHeadingPathAtPosition(
  fullContent: string,
  position: number,
): string[] {
  // Include the chunk's own leading heading line: if the content at `position`
  // OPENS with a heading, extend the scanned region to the end of that line so
  // the chunk's opening heading is captured (not just its ancestors). The
  // shared leading-line predicate only matches a heading on the slice's FIRST
  // line — a heading later in the chunk is found by the normal scan once a
  // subsequent chunk starts there.
  let scanEnd = position;
  if (matchLeadingHeading(fullContent.slice(position))) {
    const eol = fullContent.indexOf("\n", position);
    scanEnd = eol === -1 ? fullContent.length : eol;
  }

  const headings: HeadingInfo[] = [];

  // Segment the FULL content ONCE (fences intact) and collect only heading
  // matches whose ABSOLUTE offset in fullContent is < scanEnd. Slicing to
  // scanEnd BEFORE segmenting could sever a fenced block: the truncated slice
  // would end in an unclosed fence that segmentCodeBlocks then runs to EOF,
  // misreading the in-fence region and injecting a `#`-line inside it as a fake
  // heading. Segmenting the full content keeps every fence intact; the
  // absolute-offset filter then bounds the scan to the chunk's position.
  //
  // The scan walks each non-code segment line-by-line through the SHARED
  // matchHeadingLine predicate (tracking each line's absolute offset), so it
  // agrees byte-for-byte with the title extractor and the split boundary.
  let segmentStart = 0;
  for (const segment of segmentCodeBlocks(fullContent)) {
    const thisSegmentStart = segmentStart;
    segmentStart += segment.text.length;

    if (segment.isCodeBlock) continue;
    // Skip whole segments that start at or beyond scanEnd entirely.
    if (thisSegmentStart >= scanEnd) continue;

    let lineOffset = 0; // offset of the current line WITHIN this segment
    for (const line of segment.text.split("\n")) {
      const absoluteIndex = thisSegmentStart + lineOffset;
      lineOffset += line.length + 1; // +1 for the "\n" split removed
      if (absoluteIndex >= scanEnd) break;

      const heading = matchHeadingLine(line);
      if (!heading) continue;

      // Remove headings at same or deeper level (new section at this level)
      while (
        headings.length > 0 &&
        headings[headings.length - 1].level >= heading.level
      ) {
        headings.pop();
      }
      headings.push({ level: heading.level, text: heading.text });
    }
  }

  return headings.map((h) => h.text);
}

/**
 * Split text on heading boundaries at a specific level.
 * Re-attaches the heading marker to each section.
 *
 * The boundary is the SHARED heading predicate fixed at `level` hashes, so it
 * agrees with extractFirstHeading and getHeadingPathAtPosition on indent (0–3
 * spaces) and separator (space OR tab). Two historical disagreements are closed
 * here: (a) the boundary was anchored at column 0 only, so a 1–3-space-indented
 * heading fed the headingPath but was NOT a section boundary; (b) it required a
 * literal SPACE after the hashes, so a TAB-separated heading (`##\tHeading`) was
 * not a boundary. Because the separator `[ \t]+` must follow EXACTLY `level`
 * hashes, a deeper heading (e.g. `###` for a level-2 split) does NOT match — its
 * third `#` is not a space/tab — so it is split at its own level instead.
 */
function splitOnHeading(content: string, level: number): string[] {
  const regex = new RegExp(
    `(?=^${HEADING_INDENT}#{${level}}${HEADING_SEP})`,
    "gm",
  );

  const segments = segmentCodeBlocks(content);
  const parts: string[] = [];
  let current = "";

  for (const segment of segments) {
    if (segment.isCodeBlock) {
      current += segment.text;
    } else {
      const subParts = segment.text.split(regex);
      if (subParts.length === 1) {
        current += subParts[0];
      } else {
        current += subParts[0];
        for (let i = 1; i < subParts.length; i++) {
          if (current.trim()) parts.push(current);
          current = subParts[i];
        }
      }
    }
  }
  if (current.trim()) parts.push(current);

  return parts;
}

/**
 * Recursively split content to fit within target chunk size.
 * Priority: h2 -> h3 -> paragraph -> line
 */
function recursiveSplit(
  content: string,
  targetChars: number,
  depth: number = 0,
): string[] {
  if (content.length <= targetChars) {
    return [content];
  }

  let parts: string[];

  if (depth === 0) {
    parts = splitOnHeading(content, 2);
    if (parts.length > 1) {
      return parts.flatMap((p) => recursiveSplit(p, targetChars, 1));
    }
  }

  if (depth <= 1) {
    parts = splitOnHeading(content, 3);
    if (parts.length > 1) {
      return parts.flatMap((p) => recursiveSplit(p, targetChars, 2));
    }
  }

  if (depth <= 2) {
    parts = splitPreservingCodeBlocks(content, /\n\n+/);
    if (parts.length > 1) {
      return mergeSmallParts(parts, targetChars).flatMap((p) =>
        recursiveSplit(p, targetChars, 3),
      );
    }
  }

  // Fence-aware line-split fallback. A raw `content.split("\n")` here would
  // shred an oversized fenced code block across chunk boundaries (severing its
  // open/close fences) and collapse its internal blank lines — both break the
  // verbatim-substring fidelity that lets chunkMarkdown's `indexOf(rawText)`
  // bind the heading path, degrading it to []. So the split keeps each fenced
  // code block ATOMIC: a code block is emitted as its own unit (whole, even when
  // it alone exceeds targetChars), and only non-code text is line-split.
  //
  // Each fenced segment maps to ONE unit; each non-code segment maps to its
  // individual lines (split on `\n`). Because segmentCodeBlocks leaves the
  // newline that joins a code block to its neighbours attached to the
  // surrounding non-code segment, `.join("\n")` of these units reproduces the
  // source verbatim; mergeSmallParts (called with "\n") re-inserts exactly one
  // newline between consecutive units — skipping the separator whenever a unit
  // already ends in a newline — so the reassembled chunk text stays a verbatim
  // substring of the source. Newline FIDELITY is therefore handled downstream by
  // mergeSmallParts, not by any per-unit "never-break" bookkeeping here.
  //
  // INLINE-SPAN ATOMICITY: fenced blocks are kept whole above, but an INLINE
  // code span (`` `…` ``) can also straddle a soft line break, and a per-line
  // split would land its two halves in adjacent units. When mergeSmallParts'
  // boundary then falls between them, one chunk carries an unbalanced backtick —
  // it opens an inline span it never closes in served text. So consecutive
  // non-code lines whose JOIN sits inside an OPEN inline-code run (the backticks
  // seen since the current unit began are odd) are kept in the SAME unit. A
  // grouped unit is exactly its lines `\n`-joined — identical to what merging
  // those lines with "\n" would yield — so the verbatim-substring invariant is
  // unchanged. A blank line (paragraph break) always ends a unit: CommonMark
  // inline parsing never crosses it, so an odd count there is an unclosed source
  // span, not a span we may keep swallowing lines to balance.
  const segments = segmentCodeBlocks(content);
  const units: string[] = [];
  for (const segment of segments) {
    if (segment.isCodeBlock) {
      units.push(segment.text);
      continue;
    }
    const lines = segment.text.split("\n");
    let group: string[] = [];
    const flush = () => {
      if (group.length > 0) {
        units.push(group.join("\n"));
        group = [];
      }
    };
    for (const line of lines) {
      // A blank line is a paragraph boundary: CommonMark inline parsing never
      // crosses it, so it ALWAYS ends the current unit (an inline span still open
      // here is an unclosed source span, not one we may keep swallowing lines for).
      if (line.trim() === "") {
        flush();
        units.push(line);
        continue;
      }
      group.push(line);
      // Close the unit only at a balance point (no inline span left open). The
      // test is FENCE-AWARE + EXACT-RUN-LENGTH (inlineCodeOpenAtEnd), not a raw
      // backtick parity: a parity test flushed mid-span on a double-backtick
      // `` `` … `` `` span (2 backticks on the opening line ⇒ even ⇒ flush),
      // landing the opener and closer in adjacent units; and it miscounted a
      // ```` ``` ```` fence delimiter (3 backticks, odd) as an open inline span.
      // If a span is still open, keep the next line in this same unit so it stays
      // whole.
      if (!inlineCodeOpenAtEnd(group.join("\n"))) flush();
    }
    flush(); // trailing group with an unclosed source span emitted as-is
  }

  if (units.length > 1) {
    return mergeSmallParts(units, targetChars, "\n");
  }

  // Content is a single very long line (or one indivisible code block); return
  // as-is.
  return [content];
}

/**
 * Merge adjacent small parts until they approach the target size.
 *
 * @param joinSeparator - String inserted between two merged parts. Defaults to
 *   a blank line ("\n\n") for paragraph-level callers, which rejoin paragraphs.
 *   The line-split fallback passes "\n" so single-newline structure (and thus
 *   verbatim-substring fidelity with the source) is preserved. A part that
 *   already ends in a newline is joined with no extra separator regardless.
 */
function mergeSmallParts(
  parts: string[],
  targetSize: number,
  joinSeparator: string = "\n\n",
): string[] {
  const merged: string[] = [];
  let current = "";

  for (const part of parts) {
    const separator = current && !current.endsWith("\n") ? joinSeparator : "";
    if (
      current &&
      current.length + separator.length + part.length > targetSize
    ) {
      merged.push(current);
      current = part;
    } else {
      current = current ? current + separator + part : part;
    }
  }
  if (current.trim()) {
    merged.push(current);
  }

  return merged;
}

/**
 * Is an inline code span still OPEN at the END of `text`? Used by the
 * inline-code-balance guards (overlap rebalance, single-line tail rebalance, and
 * the line-split fallback grouping) to decide whether a unit/overlap window would
 * leave an unbalanced inline-code delimiter in served/embedded chunk text.
 *
 * This replaces the old `backtickCount(...) % 2` parity test, which was wrong on
 * two counts and produced two load-bearing bugs:
 *
 *  - FENCE-UNAWARE: a parity count includes a code-FENCE delimiter (```` ``` ````
 *    = 3 backticks, ODD). When an overlap window's retained lines contain a
 *    ```` ``` ```` line that is INTERIOR to a balanced fence (e.g. a `~~~`-wrapped
 *    ```` ``` ```` block — the real-Markdown way to DISPLAY a fence delimiter),
 *    the parity guard misclassified it as an open inline span and dropped up to
 *    and including it, severing the surrounding fence's OPENING delimiter and
 *    leaving its CLOSING delimiter as a phantom opener → a HALF-OPEN fence.
 *  - PARITY-ONLY (not exact-run-length): a double-backtick `` `` … `` `` span
 *    (CommonMark §6.1, used when inline code itself contains a backtick) puts 2
 *    backticks on its opening line → parity EVEN immediately → the span was
 *    flushed/severed mid-way, landing its opener and closer in adjacent chunks.
 *
 * So this helper is BOTH fence-aware (inline backticks are only counted OUTSIDE
 * fenced regions, via the SHARED matchFenceOpen / isFenceClose predicates) AND
 * exact-run-length (a run of N backticks opens a span closed only by a later run
 * of EXACTLY N — mirroring maskInlineCode). It returns true iff some inline run
 * is left open when the text ends. The test oracle re-derives this same
 * CommonMark rule INDEPENDENTLY (it must not import production, so a production
 * bug cannot hide), but all three PRODUCTION guard sites funnel through this one
 * helper so they cannot drift from each other.
 */
function inlineCodeOpenAtEnd(text: string): boolean {
  // Mask out fenced regions first: their backticks are fence delimiters or
  // verbatim in-fence code, NOT inline-code spans. Re-derive fence state
  // line-by-line via the shared predicates so this agrees with segmentCodeBlocks.
  let fence: FenceMarker | null = null;
  const scanLines: string[] = [];
  for (const line of text.split("\n")) {
    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
      scanLines.push(""); // in-fence content masked out
      continue;
    }
    const m = matchFenceOpen(line);
    if (m) {
      fence = m;
      scanLines.push(""); // fence-delimiter line masked out
      continue;
    }
    scanLines.push(line);
  }
  // A line-split unit can END inside an unclosed fence (the closing delimiter is
  // in a later unit); that is a FENCE imbalance, handled by the fence guards, not
  // an inline-code one. Treat the in-fence remainder as masked (already "" above).
  const s = scanLines.join("\n");

  // Pair inline backtick runs by EXACT length over the masked text. A run of N
  // opens a span that only a later run of EXACTLY N closes; a run of a different
  // length inside an open span is literal content. If a run is left open when the
  // text ends, an inline span is unclosed.
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
    if (close === -1) return true; // opener with no exact-length closer: span open
    i = close + runLen;
  }
  return false;
}

/**
 * Take a word-boundary-snapped tail of a SINGLE-LINE chunk for overlap, honoring
 * `maxChars` without exceeding it and without beginning mid-word.
 *
 * The previous chunk for the dominant markdown shape (a prose paragraph) is ONE
 * physical line, so there is no newline boundary to cut on. The old code dropped
 * the overlap entirely in that case, making overlap a no-op for the most common
 * content. Pass the FULL `line` (the whole previous chunk): we take its last
 * `maxChars` as the candidate window, and ONLY when that slice cut THROUGH a word
 * — i.e. the character immediately BEFORE the window is non-whitespace, so the
 * window's first character is the tail of a partial word — do we snap the START
 * FORWARD past the partial leading word to the next word boundary (never "phabeta"
 * from a cut through "alphabeta"). When the slice happens to land exactly on a
 * word boundary (the preceding char is whitespace, or the whole line is ≤
 * maxChars), the window already begins on a whole word and is kept intact, so a
 * complete leading word is never dropped by the word-boundary snap
 * (`wordBoundaryTail("aa bb cc", 5)` ⇒ "bb cc", not "cc"). If the snapped tail
 * has an unbalanced backtick count (it begins/ends inside an inline code span),
 * rebalance by dropping everything up to and including the first backtick run so
 * the prepended overlap can never open an unclosed inline span — guard (b). This
 * is a best-effort rebalance: it may discard a COMPLETE leading word that
 * precedes the first backtick (not merely a partial code fragment). Returns ""
 * when no safe word-boundary tail remains.
 */
function wordBoundaryTail(line: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  const window = line.slice(-maxChars);
  // A genuine mid-word cut means the char IMMEDIATELY BEFORE the retained window
  // (`line[line.length - maxChars - 1]`) is non-whitespace: the slice severed a
  // word, so `window` starts on a partial word. Only then advance past the
  // partial leading word (to the next whitespace, then past the whitespace) so
  // the tail starts on a whole word. When the preceding char is whitespace (or
  // the line is no longer than the window, so there is no preceding char), the
  // window already begins on a word boundary and is kept verbatim.
  let start = 0;
  const cutMidWord = /\S/.test(line[line.length - maxChars - 1] ?? " ");
  if (cutMidWord) {
    while (start < window.length && /\S/.test(window[start])) start++;
    while (start < window.length && /\s/.test(window[start])) start++;
  }
  let tail = window.slice(start).trim();
  if (!tail) return "";

  // Guard (b): never prepend a tail that leaves an inline-code span open. The
  // balance test is EXACT-RUN-LENGTH (inlineCodeOpenAtEnd), not a backtick parity:
  // a parity test treated a double-backtick `` `` … `` `` fragment as balanced
  // (2 backticks ⇒ even) even when only its opener or only its closer is present.
  // If the tail leaves a span open, drop everything up to and including the first
  // backtick run to rebalance. This best-effort rebalance may discard a COMPLETE
  // leading word before that first run, not just a partial code fragment. If a
  // span is still open after the drop, bail. (wordBoundaryTail operates on a
  // SINGLE physical line, so there is no fenced region here — the fence-awareness
  // of inlineCodeOpenAtEnd is inert on this path and only the exact-run-length
  // pairing matters.)
  if (inlineCodeOpenAtEnd(tail)) {
    const firstTick = tail.indexOf("`");
    if (firstTick >= 0) {
      let after = firstTick;
      while (after < tail.length && tail[after] === "`") after++;
      tail = tail.slice(after).trim();
    }
    if (inlineCodeOpenAtEnd(tail)) return "";
  }
  return tail;
}

/**
 * Apply overlap between consecutive chunks.
 *
 * The overlap is always joined to the next chunk with a BLANK-LINE separator
 * (`\n\n`) so the next chunk's content stays at line-start — this is what keeps a
 * leading heading on its own line and prevents "Word## Heading" fusion even when
 * the overlap is a partial line. Two shapes are handled:
 *
 *  - the window contains a newline: snap the START to the FIRST newline in the
 *    window and keep all WHOLE lines after it, so the overlap is ≈ overlapChars
 *    (not just the final line). If those lines contain a half-open fence, fall
 *    back to the last line only (the prior behavior) to preserve fence integrity.
 *  - the window has NO newline (single-line prose, the dominant shape): take a
 *    word-boundary-snapped tail (see wordBoundaryTail) so overlap is actually
 *    applied instead of dropped.
 *
 * GUARDS: (a) a fence-delimiter overlap line is dropped (matchFenceOpen) so
 * overlap never opens a fence; (b) an unbalanced inline-code tail is rebalanced
 * or dropped — in BOTH the single-line path (wordBoundaryTail) and the
 * multi-line path (a dedicated inline-backtick rebalance, since a retained
 * multi-line window can begin inside a span; the fence-balance fallback does NOT
 * cover inline backticks); the heading-path binding uses the PRE-overlap
 * rawChunks[i] in chunkMarkdown, so it is unaffected by what is prepended here
 * (guard c).
 */
function applyOverlap(chunks: string[], overlapChars: number): string[] {
  if (chunks.length <= 1 || overlapChars <= 0) return chunks;

  const result: string[] = [chunks[0]];
  for (let i = 1; i < chunks.length; i++) {
    const prevChunk = chunks[i - 1];
    const overlapText = prevChunk.slice(-overlapChars);

    let cleanOverlap: string;
    const firstNl = overlapText.indexOf("\n");
    if (firstNl >= 0) {
      // Retain all WHOLE lines from the first newline boundary in the window so
      // the overlap approximates overlapChars rather than only the final line.
      cleanOverlap = overlapText.slice(firstNl + 1).trimEnd();
      // Guard (d): if retaining multiple lines introduces a half-open fence
      // (the window started inside a fenced block, or ends on a lone opener),
      // fall back to the LAST line only — the conservative prior behavior.
      if (!fenceBalancedLines(cleanOverlap)) {
        const lastNl = overlapText.lastIndexOf("\n");
        cleanOverlap = overlapText.slice(lastNl + 1).trimEnd();
      }
      // Guard (b), multi-line: the retained window can BEGIN inside an INLINE
      // code span (the slice from the first newline started mid-span), so the
      // retained lines may leave an inline span open — prepending them would open
      // an inline span the next chunk never closes in served text. The balance
      // test is FENCE-AWARE + EXACT-RUN-LENGTH (inlineCodeOpenAtEnd), NOT a raw
      // backtick parity. This is load-bearing here: a parity count includes a
      // ```` ``` ```` fence delimiter that is INTERIOR to a balanced fence (e.g. a
      // `~~~`-wrapped ```` ``` ```` block) — odd parity — so the old guard
      // misclassified it as an open inline span and dropped up to and including
      // it, SEVERING the surrounding fence's opening delimiter and leaving its
      // closing delimiter as a phantom opener (a HALF-OPEN fence). Because
      // inlineCodeOpenAtEnd masks fenced regions, that interior delimiter is no
      // longer mistaken for inline, and parity-even multi-backtick spans are
      // caught by exact-run-length. When a span IS genuinely open: drop everything
      // up to and including the first backtick run to rebalance; if still open,
      // fall back to the LAST line only; if THAT still leaves a span open, drop
      // the overlap entirely.
      if (inlineCodeOpenAtEnd(cleanOverlap)) {
        const firstTick = cleanOverlap.indexOf("`");
        if (firstTick >= 0) {
          let after = firstTick;
          while (after < cleanOverlap.length && cleanOverlap[after] === "`")
            after++;
          cleanOverlap = cleanOverlap.slice(after).trimEnd();
        }
        if (inlineCodeOpenAtEnd(cleanOverlap)) {
          const lastNl = overlapText.lastIndexOf("\n");
          cleanOverlap = overlapText.slice(lastNl + 1).trimEnd();
        }
        if (inlineCodeOpenAtEnd(cleanOverlap)) {
          cleanOverlap = "";
        }
      }
      // Guard (b) belt-and-suspenders: ANY inline-backtick rebalance drop above
      // could, in a pathological interleaving, have removed a fence delimiter and
      // thereby UNbalanced the retained fences (the exact A1 failure mode if the
      // fence-aware count ever under-counts). Re-check fence balance after the
      // drop; if it broke, fall back to the LAST line only, and if even that is
      // fence-unbalanced, drop the overlap entirely. A guard-(b) drop can then
      // never emit a half-open fence.
      if (!fenceBalancedLines(cleanOverlap)) {
        const lastNl = overlapText.lastIndexOf("\n");
        cleanOverlap = overlapText.slice(lastNl + 1).trimEnd();
        if (!fenceBalancedLines(cleanOverlap)) {
          cleanOverlap = "";
        }
      }
    } else {
      // Single physical line: take a word-boundary tail so overlap is applied.
      // Pass the FULL previous chunk (not the pre-sliced window): wordBoundaryTail
      // slices its own last-overlapChars window AND inspects the char just before
      // it to detect a real mid-word cut. Passing the already-sliced overlapText
      // would make that look-back read the window's own first char, so the snap
      // could never fire and the overlap would begin mid-word.
      cleanOverlap = wordBoundaryTail(prevChunk, overlapChars);
    }

    // Guard (a): when the (last) overlap line is itself a code-fence delimiter —
    // the previous chunk ENDS with an opening/closing fence (CommonMark: 0–3
    // leading spaces then a run of ≥3 backticks or ≥3 tildes) — prepending it
    // would OPEN a fence in the next chunk that never closes, corrupting the
    // embedded/served chunk text. Checks the LAST line so a multi-line overlap
    // whose final line is a lone fence opener is also caught. For conservative
    // simplicity this drops the ENTIRE prepended overlap (not just the offending
    // final line), so in the multi-line branch several preceding prose lines are
    // discarded along with the fence delimiter.
    const lastLine = cleanOverlap.slice(cleanOverlap.lastIndexOf("\n") + 1);
    if (matchFenceOpen(lastLine)) {
      cleanOverlap = "";
    }

    result.push(cleanOverlap ? `${cleanOverlap}\n\n${chunks[i]}` : chunks[i]);
  }

  return result;
}

/**
 * Is the fence state balanced (every opened fence closed) at the END of `text`?
 * Used by applyOverlap's multi-line retention guard so a retained overlap window
 * that began inside a fenced block (or ends on a lone opener) is not prepended
 * with a half-open fence. Re-derives state line-by-line via the SHARED fence
 * predicates (matchFenceOpen / isFenceClose), so it agrees with segmentCodeBlocks.
 */
function fenceBalancedLines(text: string): boolean {
  let open: FenceMarker | null = null;
  for (const line of text.split("\n")) {
    if (open) {
      if (isFenceClose(line, open)) open = null;
    } else {
      const m = matchFenceOpen(line);
      if (m) open = m;
    }
  }
  return open === null;
}

/**
 * Split markdown/MDX content into embedding-friendly chunks.
 *
 * @param content - The full markdown/MDX file content
 * @param filePath - Path to the source file (used for metadata)
 * @param config - Source configuration (chunk sizing, etc.)
 * @param absoluteFilePath - Absolute filesystem path of the source file, when
 *   available. Used to resolve and inline MDX `@/snippets/*` imports before
 *   stripping. Falls back to `filePath` when that is itself absolute. When no
 *   absolute path is available, snippet inlining is skipped.
 * @returns Array of ChunkOutput objects
 */
export function chunkMarkdown(
  content: string,
  filePath: string,
  config: SourceConfig,
  absoluteFilePath?: string,
): ChunkOutput[] {
  if (!content || !content.trim()) {
    return [];
  }

  // Normalize line endings to LF ONCE, before any parsing/stripping/detection.
  // The single-line heading/fence predicates use `$` and `.` (which do not match
  // `\r`, a JS line terminator) and the chunker splits lines on `\n` only, so a
  // CRLF (Windows / core.autocrlf) document would otherwise leave a trailing
  // `\r` on every line: HEADING_LINE_RE fails on "## H\r", isFenceClose fails on
  // "```\r" (fence runs to EOF), and every chunk degrades to title=filename /
  // headingPath=[]. chunkMarkdown is the registered chunker for BOTH "markdown"
  // and "notion" sources with no upstream normalization, so it must do this. All
  // downstream `indexOf` then operates on this normalized content, keeping the
  // verbatim-substring invariant consistent.
  content = content.replace(/\r\n?/g, "\n");

  // Strip the 4 Private-Use-Area sentinels (U+E000–U+E003) that mask inline-code
  // spans and heading lines during the strip passes. They cannot appear in real
  // markdown, but a hostile/exotic source containing the literal code points
  // would otherwise collide with our placeholders — a masked span could restore
  // to the wrong text, or a literal sentinel-shaped sequence could survive into a
  // served chunk. Remove them ONCE here, before any masking, so the placeholder
  // namespace is exclusively ours downstream.
  content = content.replace(/[\u{E000}-\u{E003}]/gu, "");

  const targetChars =
    (config.chunk?.target_tokens ?? DEFAULT_TARGET_TOKENS) * 4;
  const overlapChars =
    (config.chunk?.overlap_tokens ?? DEFAULT_OVERLAP_TOKENS) * 4;

  // Parse frontmatter
  const { title: fmTitle, body } = parseFrontmatter(content);

  // Inline MDX snippet imports (@/snippets/*) before stripping, so
  // snippet-composed pages index with their real content instead of empty.
  // Prefer an explicit absolute path; fall back to filePath when it is already
  // absolute. inlineSnippetImports safely no-ops on non-absolute paths.
  //
  // Re-apply BOTH host normalizations (CRLF→LF and the PUA-sentinel strip) to
  // the inlined body. inlineSnippetImports reads each snippet file RAW from disk
  // (fs.readFileSync, no line-ending normalization, no sentinel strip) and
  // injects those bytes AFTER the line-1310/1319 passes already ran on the host
  // content, and stripMdx below does not touch `\r` or the sentinels. Without
  // re-normalizing here, a CRLF- or PUA-authored snippet would bypass both host
  // passes: a trailing `\r` makes the single-line heading/fence predicates (`$`
  // and `.` do not match `\r`) fail on the inlined snippet lines — degrading
  // that snippet's headingPath to [] and the title to the filename, and leaking
  // `\r` into served/embedded content — while a literal U+E000–U+E003 sentinel
  // would survive into the masking passes and break the "placeholder namespace
  // is exclusively ours downstream" guarantee. Normalizing the inlined body the
  // same way the host content was keeps the whole post-inline body uniform.
  const snippetBasePath = absoluteFilePath ?? filePath;
  const inlinedBody = inlineSnippetImports(body, snippetBasePath)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u{E000}-\u{E003}]/gu, "");

  // Strip MDX syntax
  const cleanBody = stripMdx(inlinedBody);

  if (!cleanBody.trim()) {
    return [];
  }

  // Determine title
  const title =
    fmTitle ||
    extractFirstHeading(cleanBody) ||
    filePath.split("/").pop() ||
    filePath;

  // Recursively split the content
  const rawChunks = recursiveSplit(cleanBody, targetChars);

  // Apply overlap
  const overlappedChunks = applyOverlap(rawChunks, overlapChars);

  // Build heading paths by finding where each raw chunk starts in the original
  const chunks: ChunkOutput[] = [];
  let searchFrom = 0;

  for (let i = 0; i < overlappedChunks.length; i++) {
    // Trim chunk edges WITHOUT promoting a 4-space-indented doc-start fence to a
    // column-0 fence. A plain .trim() strips the leading indentation of a chunk
    // whose first content line is 4-space-indented (CommonMark INDENTED CODE) —
    // e.g. a doc that OPENS with `    ```lang` — turning it into a COLUMN-0
    // ` ```lang ` whose still-indented closing `    ``` ` no longer closes it,
    // leaving a half-open fence in the SERVED chunk text. trimChunkEdges strips a
    // 0–3-space (cosmetic) leading indent as before but PRESERVES a 4+-space
    // (semantic, indented-code) one, so the 0–3 vs 4+ space rule keeps governing.
    const chunkText = trimChunkEdges(overlappedChunks[i]);
    if (!chunkText) continue;

    // Find the position of this chunk's primary content in the clean body
    // Use the raw (non-overlapped) chunk to find position. Trim the same way as
    // chunkText so the verbatim-substring indexOf binding stays consistent (both
    // remain contiguous substrings of cleanBody). The `|| chunkText` fallback
    // guards an all-blank rawChunks[i] (trimChunkEdges → "") so rawText is never
    // the empty string (which indexOf would "find" at searchFrom and mis-bind).
    const rawText = (rawChunks[i] && trimChunkEdges(rawChunks[i])) || chunkText;
    const pos = cleanBody.indexOf(rawText, searchFrom);
    const headingPath =
      pos >= 0 ? getHeadingPathAtPosition(cleanBody, pos) : [];
    if (pos >= 0) {
      // Advance past the matched chunk. Using `pos` alone leaves the cursor at
      // the start of this match, so when a later chunk has byte-identical text
      // (repeated boilerplate / duplicate sections) the next indexOf re-finds
      // THIS position and the later chunk inherits the wrong heading path.
      searchFrom = pos + rawText.length;
    } else {
      // The chunk text was expected to be a verbatim substring of cleanBody
      // (that invariant is what lets indexOf bind the heading path). When it is
      // not, headingPath silently degrades to [] and the embedded retrieval
      // anchor is lost — warn loudly so a future break of the invariant is
      // visible rather than quietly degrading search quality. The index reported
      // is the RAW chunk loop index `i` (chunks.length skips empty chunks via
      // the `continue` above, so it is NOT the raw position of this chunk).
      console.warn(
        `[chunker] heading-path lookup failed for ${filePath} chunk ${i}: ` +
          `chunk text is not a verbatim substring of the cleaned body; headingPath degraded to []`,
      );
      // Still advance the cursor past this chunk's length. Leaving searchFrom
      // unmoved on a miss lets a LATER chunk with byte-identical text re-bind an
      // EARLIER occurrence's heading path (the duplicate-text cascade the hit
      // branch above guards). Advancing by rawText.length keeps the cursor
      // monotonically ahead so a subsequent duplicate is matched at its own
      // (later) position rather than re-finding a stale earlier one.
      searchFrom += rawText.length;
    }

    chunks.push({
      content: chunkText,
      title,
      headingPath,
      chunkIndex: chunks.length,
    });
  }

  return chunks;
}
