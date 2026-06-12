import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── T9 — Refinement-coverage stale-doc guard (spec §4.1.1 / §7.9) ─────────────
//
// `zod-to-json-schema` silently drops every `.refine(...)`, `.superRefine(...)`,
// `.transform(...)`, and `.regex(...)` it cannot translate. The orchestration
// shell hands the JSON-Schema'd document to the structured-output call, so
// every Zod runtime predicate that does NOT round-trip into JSON Schema MUST
// be wired into a post-pass Zod parse in the `atlas harvest write-fragment
// --stdin` CLI helper (spec §4.2.1 STEP 2 + §4.6). Otherwise the predicate is
// "silently lost" and malformed fragments land on disk.
//
// This test future-guards against the silent-drop class of bug: it walks
// `src/atlas/types.ts`, counts every `.refine(`, `.superRefine(`, and
// `.transform(` token IN CODE (comments stripped), then counts the rows in
// the refinement-coverage table in `docs/atlas/refinement-coverage.md`, and
// asserts the two counts agree. If a contributor adds a new refinement to
// `types.ts` without adding a corresponding doc row (and therefore without
// thinking about where to wire it into the post-pass), the test fails with
// a stale-doc message that names the drift.

const REPO_ROOT = resolve(__dirname, "..", "..");
const TYPES_PATH = resolve(REPO_ROOT, "src", "atlas", "types.ts");
const DOC_PATH = resolve(REPO_ROOT, "docs", "atlas", "refinement-coverage.md");

// Strip `/* ... */` block comments and `// ...` line comments from a TS source
// string. We strip block comments first (they may span multiple lines and
// could contain `//` inside them); then we strip line comments. This is not a
// full TypeScript tokenizer, but it is sufficient to keep the refinement
// counter from picking up the in-source future-edit note that mentions
// `.refine(...)` inside a `//` comment on line ~163 of `types.ts`.
function stripComments(src: string): string {
  // Remove /* ... */ (non-greedy, multiline).
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, "");
  // Remove // ... to end of line.
  const noLine = noBlock.replace(/\/\/[^\n]*/g, "");
  return noLine;
}

// Count non-overlapping occurrences of a regex needle in `body`.
function countOccurrences(body: string, needle: RegExp): number {
  const matches = body.match(needle);
  return matches === null ? 0 : matches.length;
}

// Count rows in the FIRST GitHub-flavored markdown table in `doc` that has the
// expected refinement-coverage header (`| Refinement | Schema |`). The row
// count EXCLUDES the header row and the `|---|---|...|` separator row.
function countTableRows(doc: string): number {
  const lines = doc.split("\n");
  let inTable = false;
  let sawSeparator = false;
  let rowCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inTable) {
      // The header row we're targeting: `| Refinement | Schema | JSON-Schema-expressible? | Post-pass note |`
      if (/^\|\s*Refinement\s*\|\s*Schema\s*\|/i.test(trimmed)) {
        inTable = true;
      }
      continue;
    }
    // Inside the table.
    if (!sawSeparator) {
      // The separator line: `|---|---|---|---|`
      if (/^\|\s*-+\s*(\|\s*-+\s*)+\|?$/.test(trimmed)) {
        sawSeparator = true;
      }
      continue;
    }
    // Data row OR end of table. A data row starts with `|`. A blank line or a
    // non-`|` line ends the table.
    if (trimmed.startsWith("|")) {
      rowCount += 1;
      continue;
    }
    if (trimmed === "") {
      break;
    }
    // Some other content — treat as end of table.
    break;
  }
  return rowCount;
}

describe("atlas refinement coverage (T9 — stale-doc guard)", () => {
  it("doc table row count matches source refinement count", () => {
    const typesSrc = readFileSync(TYPES_PATH, "utf8");
    const docSrc = readFileSync(DOC_PATH, "utf8");

    const codeOnly = stripComments(typesSrc);
    const refineCount = countOccurrences(codeOnly, /\.refine\(/g);
    const superRefineCount = countOccurrences(codeOnly, /\.superRefine\(/g);
    const transformCount = countOccurrences(codeOnly, /\.transform\(/g);
    const sourceCount = refineCount + superRefineCount + transformCount;

    const tableRows = countTableRows(docSrc);

    expect(
      tableRows,
      `refinement-coverage.md is stale — ${sourceCount} source refinements ` +
        `(refine=${refineCount}, superRefine=${superRefineCount}, transform=${transformCount}) ` +
        `vs ${tableRows} table rows. Update docs/atlas/refinement-coverage.md.`,
    ).toBe(sourceCount);
  });

  it("doc Summary block reports a Total count that matches source", () => {
    // A second, weaker assertion: the human-readable Summary block in the
    // doc lists the total refinement count. If a contributor updates the
    // table but forgets to update the summary numerals, that's also drift.
    const typesSrc = readFileSync(TYPES_PATH, "utf8");
    const docSrc = readFileSync(DOC_PATH, "utf8");

    const codeOnly = stripComments(typesSrc);
    const sourceCount =
      countOccurrences(codeOnly, /\.refine\(/g) +
      countOccurrences(codeOnly, /\.superRefine\(/g) +
      countOccurrences(codeOnly, /\.transform\(/g);

    // Match `Total refinements / transforms in \`src/atlas/types.ts\`: **N**`
    const totalMatch = docSrc.match(
      /Total refinements[^\n]*\*\*\s*(\d+)\s*\*\*/i,
    );
    expect(
      totalMatch,
      "refinement-coverage.md is missing a `Total refinements ... **N**` summary line.",
    ).not.toBeNull();
    const docTotal = Number(totalMatch![1]);
    expect(
      docTotal,
      `refinement-coverage.md summary is stale — source has ${sourceCount} ` +
        `refinements, summary says ${docTotal}. ` +
        `Update docs/atlas/refinement-coverage.md.`,
    ).toBe(sourceCount);
  });
});
