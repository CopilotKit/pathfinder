// Line-based code splitter

import { type ChunkOutput, type SourceConfig } from "../../types.js";

export interface CodeChunk {
  content: string;
  startLine: number;
  endLine: number;
  language: string;
  chunkIndex: number;
}

const DEFAULT_TARGET_LINES = 80;
const DEFAULT_OVERLAP_LINES = 10;

/**
 * Map file extension to language name.
 */
function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const languageMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    md: "markdown",
    mdx: "markdown",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    sql: "sql",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    css: "css",
    scss: "scss",
    html: "html",
    xml: "xml",
  };

  return languageMap[ext] || ext || "text";
}

/**
 * Check if a line is inside a multi-line string literal or comment block.
 * Uses simple heuristic tracking of block comment delimiters.
 */
interface BlockState {
  inBlockComment: boolean;
  inTemplateString: boolean;
}

/**
 * Advance the cross-line block state by scanning one line character by
 * character.
 *
 * This is a single left-to-right pass rather than the two-stage
 * "strip strings, then count backticks" it replaces. That older shape had a
 * fatal ordering bug: the stripper knew about `'` and `"` but NOT about
 * backticks, so a `//` inside a template literal —
 *
 *   wsUrl: `ws://127.0.0.1:5177/inspector-lab-runtime/${key}/realtime`,
 *
 * — read as the start of a line comment. Everything after `ws:` was discarded,
 * including the CLOSING backtick, which left an odd backtick count and latched
 * `inTemplateString` for the remainder of the file. With the latch stuck, no
 * blank line qualified as a split point ever again, so ~960 lines collapsed
 * into a single chunk that exceeded the embedding model's token limit. That
 * one chunk failed to embed, which held the source's state token, which froze
 * mcp.copilotkit.ai's `code` source at commit 0d0ea901 for ten days.
 *
 * Scanning in one pass keeps the quote/template/comment contexts mutually
 * exclusive, which is the only way `//` can be classified correctly.
 *
 * Single-quote and double-quote strings are treated as line-local (JS does not
 * carry them across lines without an explicit continuation); template literals
 * and block comments carry across lines via the returned state. `${…}`
 * interpolations are treated as literal template text — expressions there can
 * technically contain nested strings and comments, but bounding the chunk size
 * (see MAX_CHUNK_CHARS) is the backstop for anything this heuristic misreads.
 */
function trackBlockState(line: string, state: BlockState): BlockState {
  let { inBlockComment, inTemplateString } = state;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];
    const next = line[i + 1];

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (inTemplateString) {
      // A backslash escapes the next character, so `\`` does not close.
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        inTemplateString = false;
      }
      i++;
      continue;
    }

    if (ch === "/" && next === "/") {
      // Real line comment — nothing after it can change the block state.
      break;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === "`") {
      inTemplateString = true;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      // Consume the whole string literal on this line. An unterminated one
      // (the line ends first) is treated as ended, matching the line-local
      // assumption above.
      const quote = ch;
      i++;
      while (i < line.length) {
        if (line[i] === "\\") {
          i += 2;
          continue;
        }
        if (line[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    i++;
  }

  // Python triple-quoted strings reuse the block-comment flag. Checked on the
  // ORIGINAL line because the scan above is JS-oriented, and only when the JS
  // scan left us in neutral territory.
  if (!inBlockComment && !inTemplateString) {
    if (line.includes('"""') || line.includes("'''")) {
      const tripleDouble = (line.match(/"""/g) || []).length;
      const tripleSingle = (line.match(/'''/g) || []).length;
      if (tripleDouble % 2 === 1 || tripleSingle % 2 === 1) {
        inBlockComment = true;
      }
    }
  }

  return { inBlockComment, inTemplateString };
}

/**
 * Determine safe split points: lines where we're not inside a block comment
 * or string literal, and that represent logical boundaries.
 */
function findSplitPoints(lines: string[]): Set<number> {
  const safePoints = new Set<number>();
  let state: BlockState = { inBlockComment: false, inTemplateString: false };

  for (let i = 0; i < lines.length; i++) {
    const prevState = { ...state };
    state = trackBlockState(lines[i], state);

    // A double-newline boundary is a safe split point
    if (i > 0 && lines[i].trim() === "" && lines[i - 1].trim() === "") {
      if (
        !state.inBlockComment &&
        !state.inTemplateString &&
        !prevState.inBlockComment &&
        !prevState.inTemplateString
      ) {
        safePoints.add(i);
      }
    }

    // A single blank line is a secondary split point
    if (
      lines[i].trim() === "" &&
      !state.inBlockComment &&
      !state.inTemplateString
    ) {
      safePoints.add(i);
    }
  }

  return safePoints;
}

/**
 * Format a range of lines with line numbers and a file breadcrumb.
 */
function formatChunk(
  lines: string[],
  startLine: number,
  filePath: string,
): string {
  const breadcrumb = `// File: ${filePath}`;
  const maxLineNum = startLine + lines.length - 1;
  const padWidth = String(maxLineNum).length;

  const numbered = lines.map((line, i) => {
    const lineNum = String(startLine + i).padStart(padWidth, " ");
    return `${lineNum} | ${line}`;
  });

  return breadcrumb + "\n" + numbered.join("\n");
}

/**
 * Hard upper bound on a single chunk's formatted size, in characters.
 *
 * Every split heuristic above is advisory: `splitAtBoundaries` looks for blank
 * lines, and when a file has none for hundreds of lines (generated code, an
 * icon table, a long object literal) it falls back to slicing on `targetLines`
 * — which bounds LINES, not characters. Nothing downstream tolerates an
 * unbounded chunk: the embedding model rejects anything over 8192 tokens, and
 * that rejection is a non-retryable 400 that used to freeze the whole source.
 *
 * 12,000 characters is deliberately conservative. Source code runs roughly
 * 3-4 characters per token, so this lands near 3,000-4,000 tokens — well
 * inside the limit even for unusually dense content, and small enough that a
 * chunk still embeds to a focused vector rather than an averaged blur.
 */
const MAX_CHUNK_CHARS = 12_000;

/**
 * Format a line range into one or more chunks, none exceeding
 * {@link MAX_CHUNK_CHARS}.
 *
 * Splits by LINES first so chunks stay line-addressable (start/end line
 * numbers keep pointing at real code). A single line that is itself over the
 * cap — a minified bundle, an inlined data URI — cannot be split that way, so
 * it is sliced by characters as a last resort; those slices share the line's
 * number, which is the honest answer for content that occupies one line.
 */
function emitBounded(
  lines: string[],
  startLine: number,
  endLine: number,
  filePath: string,
  language: string,
): Array<Omit<ChunkOutput, "chunkIndex">> {
  const content = formatChunk(lines, startLine, filePath);
  if (content.length <= MAX_CHUNK_CHARS) {
    return [{ content, startLine, endLine, language }];
  }

  if (lines.length > 1) {
    const mid = Math.ceil(lines.length / 2);
    return [
      ...emitBounded(
        lines.slice(0, mid),
        startLine,
        startLine + mid - 1,
        filePath,
        language,
      ),
      ...emitBounded(
        lines.slice(mid),
        startLine + mid,
        endLine,
        filePath,
        language,
      ),
    ];
  }

  // One line, over the cap. Slice the raw line and re-format each slice so
  // every emitted chunk carries the breadcrumb and stays under the bound.
  const overhead = content.length - lines[0].length;
  const sliceSize = Math.max(1, MAX_CHUNK_CHARS - overhead);
  const out: Array<Omit<ChunkOutput, "chunkIndex">> = [];
  for (let i = 0; i < lines[0].length; i += sliceSize) {
    out.push({
      content: formatChunk(
        [lines[0].slice(i, i + sliceSize)],
        startLine,
        filePath,
      ),
      startLine,
      endLine,
      language,
    });
  }
  return out;
}

/**
 * Split lines into groups at double-newline boundaries, respecting block state.
 */
function splitAtBoundaries(
  lines: string[],
  targetLines: number,
): Array<{ start: number; end: number }> {
  if (lines.length <= targetLines) {
    return [{ start: 0, end: lines.length - 1 }];
  }

  const safePoints = findSplitPoints(lines);
  const ranges: Array<{ start: number; end: number }> = [];
  let rangeStart = 0;

  // Prefer double-newline boundaries first
  const doubleNewlines: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (
      lines[i].trim() === "" &&
      lines[i - 1].trim() === "" &&
      safePoints.has(i)
    ) {
      doubleNewlines.push(i);
    }
  }

  // Try splitting on double-newline boundaries
  if (doubleNewlines.length > 0) {
    const splitPoints = selectSplitPoints(
      doubleNewlines,
      lines.length,
      targetLines,
    );
    for (const point of splitPoints) {
      if (point > rangeStart) {
        ranges.push({ start: rangeStart, end: point - 1 });
        rangeStart = point;
      }
    }
    ranges.push({ start: rangeStart, end: lines.length - 1 });

    // Check if any range is still too large
    const needsRefinement = ranges.some(
      (r) => r.end - r.start + 1 > targetLines * 1.5,
    );
    if (!needsRefinement) return ranges;
  }

  // Fall back to single blank line boundaries
  const blankLines = Array.from(safePoints).sort((a, b) => a - b);
  if (blankLines.length > 0) {
    const refinedRanges: Array<{ start: number; end: number }> = [];
    rangeStart = 0;

    const splitPoints = selectSplitPoints(
      blankLines,
      lines.length,
      targetLines,
    );
    for (const point of splitPoints) {
      if (point > rangeStart) {
        refinedRanges.push({ start: rangeStart, end: point - 1 });
        rangeStart = point;
      }
    }
    refinedRanges.push({ start: rangeStart, end: lines.length - 1 });
    return refinedRanges;
  }

  // No good split points; split mechanically on line boundaries
  const mechanicalRanges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < lines.length; i += targetLines) {
    mechanicalRanges.push({
      start: i,
      end: Math.min(i + targetLines - 1, lines.length - 1),
    });
  }
  return mechanicalRanges;
}

/**
 * Select split points from candidates that best partition the content
 * into chunks near the target size.
 */
function selectSplitPoints(
  candidates: number[],
  _totalLines: number,
  targetLines: number,
): number[] {
  const selected: number[] = [];
  let lastSplit = 0;

  for (const candidate of candidates) {
    const distance = candidate - lastSplit;
    if (distance >= targetLines) {
      selected.push(candidate);
      lastSplit = candidate;
    }
  }

  return selected;
}

/**
 * Split code content into embedding-friendly chunks with line numbers.
 *
 * @param content - The full source file content
 * @param filePath - Path to the source file
 * @returns Array of CodeChunk objects
 */
export function chunkCode(
  content: string,
  filePath: string,
  config: SourceConfig,
): ChunkOutput[] {
  if (!content || !content.trim()) {
    return [];
  }

  const targetLines = config.chunk?.target_lines ?? DEFAULT_TARGET_LINES;
  const overlapLines = config.chunk?.overlap_lines ?? DEFAULT_OVERLAP_LINES;

  const language = detectLanguage(filePath);
  const lines = content.split("\n");

  // Remove trailing empty line if file ends with newline
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  if (lines.length === 0) {
    return [];
  }

  // Split into ranges
  const ranges = splitAtBoundaries(lines, targetLines);

  // Apply overlap and build chunks
  const chunks: ChunkOutput[] = [];

  for (let i = 0; i < ranges.length; i++) {
    let { start, end } = ranges[i];

    // Apply overlap from previous chunk
    if (i > 0 && overlapLines > 0) {
      const overlapStart = Math.max(
        ranges[i - 1].end - overlapLines + 1,
        ranges[i - 1].start,
      );
      start = Math.min(start, overlapStart);
    }

    const chunkLines = lines.slice(start, end + 1);
    const startLine = start + 1; // 1-indexed
    const endLine = end + 1; // 1-indexed

    // Emit through the size backstop rather than pushing directly: a range
    // that is fine by LINE count can still be enormous by character count.
    for (const emitted of emitBounded(
      chunkLines,
      startLine,
      endLine,
      filePath,
      language,
    )) {
      chunks.push({ ...emitted, chunkIndex: chunks.length });
    }
  }

  return chunks;
}
