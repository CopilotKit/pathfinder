// Line-based code splitter

export interface CodeChunk {
    content: string;
    startLine: number;
    endLine: number;
    language: string;
    chunkIndex: number;
}

const TARGET_LINES = 80;
const OVERLAP_LINES = 10;

/**
 * Map file extension to language name.
 */
function detectLanguage(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const languageMap: Record<string, string> = {
        ts: 'typescript',
        tsx: 'typescript',
        js: 'javascript',
        jsx: 'javascript',
        mjs: 'javascript',
        cjs: 'javascript',
        py: 'python',
        rb: 'ruby',
        go: 'go',
        rs: 'rust',
        java: 'java',
        kt: 'kotlin',
        swift: 'swift',
        c: 'c',
        cpp: 'cpp',
        h: 'c',
        hpp: 'cpp',
        cs: 'csharp',
        md: 'markdown',
        mdx: 'markdown',
        json: 'json',
        yaml: 'yaml',
        yml: 'yaml',
        toml: 'toml',
        sql: 'sql',
        sh: 'shell',
        bash: 'shell',
        zsh: 'shell',
        css: 'css',
        scss: 'scss',
        html: 'html',
        xml: 'xml',
    };

    return languageMap[ext] || ext || 'text';
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
 * Check whether the character at `pos` is escaped by counting preceding
 * backslashes.  An odd number means the character is escaped.
 */
function isEscaped(line: string, pos: number): boolean {
    let backslashes = 0;
    for (let j = pos - 1; j >= 0 && line[j] === '\\'; j--) {
        backslashes++;
    }
    return backslashes % 2 === 1;
}

/**
 * Strip string literals and single-line comments from a line so that
 * block-comment and template-string detection only fires on real syntax.
 */
function stripStringsAndLineComments(line: string): string {
    let result = '';
    let inSingle = false;
    let inDouble = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];

        if (!inSingle && !inDouble && ch === '/' && line[i + 1] === '/') {
            break; // rest of line is a single-line comment
        }

        if (!inDouble && ch === "'" && !isEscaped(line, i)) {
            inSingle = !inSingle;
        } else if (!inSingle && ch === '"' && !isEscaped(line, i)) {
            inDouble = !inDouble;
        }

        if (!inSingle && !inDouble) {
            result += ch;
        }
    }

    return result;
}

function trackBlockState(line: string, state: BlockState): BlockState {
    const newState = { ...state };
    const stripped = stripStringsAndLineComments(line);

    if (newState.inBlockComment) {
        if (stripped.includes('*/')) {
            newState.inBlockComment = false;
        }
        return newState;
    }

    if (newState.inTemplateString) {
        // Count unescaped backticks
        const backticks = (stripped.match(/(?<!\\)`/g) || []).length;
        if (backticks % 2 === 1) {
            newState.inTemplateString = false;
        }
        return newState;
    }

    // Check for block comment start (not on same line as end)
    if (stripped.includes('/*') && !stripped.includes('*/')) {
        newState.inBlockComment = true;
    } else if (!newState.inBlockComment) {
        // Only check template strings if we didn't just enter a block comment
        const backticks = (stripped.match(/(?<!\\)`/g) || []).length;
        if (backticks % 2 === 1) {
            newState.inTemplateString = true;
        }
    }

    // Python triple-quote strings — run on original line since stripping is JS-oriented
    if (!newState.inBlockComment && !newState.inTemplateString) {
        if (line.includes('"""') || line.includes("'''")) {
            const tripleDouble = (line.match(/"""/g) || []).length;
            const tripleSingle = (line.match(/'''/g) || []).length;
            if ((tripleDouble % 2 === 1) || (tripleSingle % 2 === 1)) {
                newState.inBlockComment = true; // reuse flag for python docstrings
            }
        }
    }

    return newState;
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
        if (i > 0 && lines[i].trim() === '' && lines[i - 1].trim() === '') {
            if (!state.inBlockComment && !state.inTemplateString &&
                !prevState.inBlockComment && !prevState.inTemplateString) {
                safePoints.add(i);
            }
        }

        // A single blank line is a secondary split point
        if (lines[i].trim() === '' && !state.inBlockComment && !state.inTemplateString) {
            safePoints.add(i);
        }
    }

    return safePoints;
}

/**
 * Format a range of lines with line numbers and a file breadcrumb.
 */
function formatChunk(lines: string[], startLine: number, filePath: string): string {
    const breadcrumb = `// File: ${filePath}`;
    const maxLineNum = startLine + lines.length - 1;
    const padWidth = String(maxLineNum).length;

    const numbered = lines.map((line, i) => {
        const lineNum = String(startLine + i).padStart(padWidth, ' ');
        return `${lineNum} | ${line}`;
    });

    return breadcrumb + '\n' + numbered.join('\n');
}

/**
 * Split lines into groups at double-newline boundaries, respecting block state.
 */
function splitAtBoundaries(lines: string[], targetLines: number): Array<{ start: number; end: number }> {
    if (lines.length <= targetLines) {
        return [{ start: 0, end: lines.length - 1 }];
    }

    const safePoints = findSplitPoints(lines);
    const ranges: Array<{ start: number; end: number }> = [];
    let rangeStart = 0;

    // Prefer double-newline boundaries first
    const doubleNewlines: number[] = [];
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '' && lines[i - 1].trim() === '' && safePoints.has(i)) {
            doubleNewlines.push(i);
        }
    }

    // Try splitting on double-newline boundaries
    if (doubleNewlines.length > 0) {
        const splitPoints = selectSplitPoints(doubleNewlines, lines.length, targetLines);
        for (const point of splitPoints) {
            if (point > rangeStart) {
                ranges.push({ start: rangeStart, end: point - 1 });
                rangeStart = point;
            }
        }
        ranges.push({ start: rangeStart, end: lines.length - 1 });

        // Check if any range is still too large
        const needsRefinement = ranges.some(r => (r.end - r.start + 1) > targetLines * 1.5);
        if (!needsRefinement) return ranges;
    }

    // Fall back to single blank line boundaries
    const blankLines = Array.from(safePoints).sort((a, b) => a - b);
    if (blankLines.length > 0) {
        const refinedRanges: Array<{ start: number; end: number }> = [];
        rangeStart = 0;

        const splitPoints = selectSplitPoints(blankLines, lines.length, targetLines);
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
function selectSplitPoints(candidates: number[], _totalLines: number, targetLines: number): number[] {
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
export function chunkCode(content: string, filePath: string): CodeChunk[] {
    if (!content || !content.trim()) {
        return [];
    }

    const language = detectLanguage(filePath);
    const lines = content.split('\n');

    // Remove trailing empty line if file ends with newline
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }

    if (lines.length === 0) {
        return [];
    }

    // Split into ranges
    const ranges = splitAtBoundaries(lines, TARGET_LINES);

    // Apply overlap and build chunks
    const chunks: CodeChunk[] = [];

    for (let i = 0; i < ranges.length; i++) {
        let { start, end } = ranges[i];

        // Apply overlap from previous chunk
        if (i > 0 && OVERLAP_LINES > 0) {
            const overlapStart = Math.max(ranges[i - 1].end - OVERLAP_LINES + 1, ranges[i - 1].start);
            start = Math.min(start, overlapStart);
        }

        const chunkLines = lines.slice(start, end + 1);
        const startLine = start + 1; // 1-indexed
        const endLine = end + 1;     // 1-indexed

        chunks.push({
            content: formatChunk(chunkLines, startLine, filePath),
            startLine,
            endLine,
            language,
            chunkIndex: chunks.length,
        });
    }

    return chunks;
}
