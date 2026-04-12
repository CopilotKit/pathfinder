#!/usr/bin/env tsx
/// <reference types="node" />
/**
 * update-competitive-matrix.ts
 *
 * Fetches competitor READMEs from GitHub, extracts feature signals via keyword
 * matching, and compares against the comparison table in docs/index.html.
 * When evidence of new capabilities is found, updates the table and outputs a
 * markdown summary.
 *
 * Usage:
 *   npx tsx scripts/update-competitive-matrix.ts                        # update in place
 *   npx tsx scripts/update-competitive-matrix.ts --dry-run               # show changes only
 *   npx tsx scripts/update-competitive-matrix.ts --summary out.md        # write markdown summary
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

interface Competitor {
  /** Display name matching the <th> text in the HTML table */
  name: string;
  /** GitHub owner/repo */
  repo: string;
}

interface FeatureRule {
  /** Row label as it appears in the first <td> of each <tr> */
  rowLabel: string;
  /** Patterns to search for (case-insensitive) */
  keywords: string[];
}

interface DetectedChange {
  competitor: string;
  capability: string;
  from: string;
  to: string;
}

// ── Configuration ────────────────────────────────────────────────────────────

const COMPETITORS: Competitor[] = [
  { name: "Mintlify", repo: "mintlify/mintlify-cli" },
  { name: "mcp-ragdocs", repo: "hannesrudolph/mcp-ragdocs" },
  { name: "mcp-local-rag", repo: "shinpr/mcp-local-rag" },
  { name: "mcp-rag-server", repo: "Daniel-Barta/mcp-rag-server" },
];

const FEATURE_RULES: FeatureRule[] = [
  {
    rowLabel: "Semantic search",
    keywords: ["vector", "embedding", "semantic", "similarity"],
  },
  {
    rowLabel: "Filesystem exploration",
    keywords: ["filesystem", "bash", "shell", "find", "grep", "cat", "ls"],
  },
  {
    rowLabel: "Multi-source",
    keywords: ["multi.*source", "multiple.*source", "code.*doc"],
  },
  {
    rowLabel: "Slack",
    keywords: ["slack", "slack.*api", "slack.*bot"],
  },
  {
    rowLabel: "Discord",
    keywords: ["discord", "discord.*bot", "discord.*api"],
  },
  {
    rowLabel: "Notion",
    keywords: ["notion", "notion.*api", "notion.*page"],
  },
  {
    rowLabel: "Webhook reindex",
    keywords: ["webhook", "auto.*reindex", "push.*trigger"],
  },
  {
    rowLabel: "Knowledge/FAQ",
    keywords: ["knowledge", "faq", "q&a", "question.*answer"],
  },
  {
    rowLabel: "Zero-infra",
    keywords: ["no.*database", "zero.*config", "no.*setup", "pglite", "local.*only"],
  },
  {
    rowLabel: "llms.txt",
    keywords: ["llms\\.txt", "llms-full"],
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");
const DOCS_PATH = resolve(import.meta.dirname ?? __dirname, "../docs/index.html");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const HEADERS: Record<string, string> = {
  Accept: "application/vnd.github.v3+json",
  "User-Agent": "pathfinder-competitive-matrix-updater",
  ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
};

async function fetchReadme(repo: string): Promise<string> {
  const url = `https://api.github.com/repos/${repo}/readme`;
  console.log(`  Fetching README from ${repo}...`);
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    console.warn(`  WARNING: Failed to fetch README for ${repo}: ${res.status} ${res.statusText}`);
    return "";
  }
  const json = (await res.json()) as { content?: string; encoding?: string };
  if (json.content && json.encoding === "base64") {
    return Buffer.from(json.content, "base64").toString("utf-8");
  }
  return "";
}

async function fetchPackageJson(repo: string): Promise<string> {
  const url = `https://api.github.com/repos/${repo}/contents/package.json`;
  console.log(`  Fetching package.json from ${repo}...`);
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) return "";
  const json = (await res.json()) as { content?: string; encoding?: string };
  if (json.content && json.encoding === "base64") {
    return Buffer.from(json.content, "base64").toString("utf-8");
  }
  return "";
}

function extractFeatures(text: string): Record<string, boolean> {
  const lower = text.toLowerCase();
  const result: Record<string, boolean> = {};
  for (const rule of FEATURE_RULES) {
    const found = rule.keywords.some((kw) => {
      const pattern = new RegExp(kw.toLowerCase(), "i");
      return pattern.test(lower);
    });
    result[rule.rowLabel] = found;
  }
  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// ── HTML Matrix Parsing & Updating ───────────────────────────────────────────

/**
 * Parses the comparison table from docs/index.html.
 * Returns a map: competitorName -> { rowLabel -> cellHTML }
 *
 * The table uses class="comp-table" with <th> headers and <td> cells.
 * The first column is "Capability", second is "Pathfinder", and
 * remaining columns are competitors.
 */
function parseCurrentMatrix(html: string): {
  headers: string[];
  rows: Map<string, Map<string, string>>;
} {
  const tableMatch = html.match(/<table class="comp-table">([\s\S]*?)<\/table>/);
  if (!tableMatch) {
    throw new Error("Could not find comp-table in HTML");
  }
  const tableHtml = tableMatch[1];

  // Extract header names from <th> elements
  const thRegex = /<th[^>]*>(.*?)<\/th>/g;
  const allHeaders: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = thRegex.exec(tableHtml)) !== null) {
    allHeaders.push(m[1].trim());
  }
  // allHeaders[0] = "Capability", allHeaders[1] = "Pathfinder", allHeaders[2..] = competitors
  const competitorHeaders = allHeaders.slice(1); // skip "Capability"

  // Extract rows from <tbody>
  const rows = new Map<string, Map<string, string>>();
  const tbody = tableHtml.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
  const trIter = new RegExp(/<tr>([\s\S]*?)<\/tr>/g);
  let tr: RegExpExecArray | null;

  while ((tr = trIter.exec(tbody)) !== null) {
    const tds: string[] = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let td: RegExpExecArray | null;
    while ((td = tdRegex.exec(tr[1])) !== null) {
      tds.push(td[1].trim());
    }
    if (tds.length < 2) continue;

    const rowLabel = tds[0];
    const rowMap = new Map<string, string>();
    for (let i = 1; i < tds.length && i - 1 < competitorHeaders.length; i++) {
      rowMap.set(competitorHeaders[i - 1], tds[i]);
    }
    rows.set(rowLabel, rowMap);
  }

  return { headers: competitorHeaders, rows };
}

/**
 * Computes changes: finds competitor cells that currently indicate "No" / cross
 * but where the keyword scan detected the feature. Only upgrades, never downgrades.
 */
function computeChanges(
  matrix: { headers: string[]; rows: Map<string, Map<string, string>> },
  competitorFeatures: Map<string, Record<string, boolean>>,
): DetectedChange[] {
  const changes: DetectedChange[] = [];

  for (const [compName, features] of competitorFeatures) {
    for (const [rowLabel, detected] of Object.entries(features)) {
      if (!detected) continue;

      const row = matrix.rows.get(rowLabel);
      if (!row) continue;

      const currentCell = row.get(compName);
      if (!currentCell) continue;

      // Only upgrade cells that contain the cross mark (&#10007; or the actual character)
      const isCross = currentCell.includes("&#10007;") || currentCell.includes("\u2717");
      if (isCross) {
        changes.push({
          competitor: compName,
          capability: rowLabel,
          from: "No",
          to: "Yes",
        });
      }
    }
  }

  return changes;
}

/**
 * Applies detected changes to the HTML by finding the exact table cells
 * and replacing cross marks with check marks.
 */
function applyChanges(html: string, changes: DetectedChange[]): string {
  if (changes.length === 0) return html;

  // Parse the table to determine column indices
  const tableMatch = html.match(/<table class="comp-table">([\s\S]*?)<\/table>/);
  if (!tableMatch) return html;
  const tableHtml = tableMatch[1];

  const thRegex = /<th[^>]*>(.*?)<\/th>/g;
  const allHeaders: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = thRegex.exec(tableHtml)) !== null) {
    allHeaders.push(m[1].trim());
  }
  // Column index in <td> array: "Capability" = 0, "Pathfinder" = 1, competitors = 2+
  const compColumnIndex = (name: string): number => {
    const idx = allHeaders.indexOf(name);
    return idx === -1 ? -1 : idx; // index in <td> array matches <th> array
  };

  let result = html;

  for (const change of changes) {
    const colIdx = compColumnIndex(change.competitor);
    if (colIdx === -1) continue;

    // Find the <tr> containing this capability row by matching the first <td> text
    const rowPattern = new RegExp(
      `(<tr><td>${escapeRegex(change.capability)}</td>)([\\s\\S]*?)(</tr>)`,
    );
    const rowMatch = result.match(rowPattern);
    if (!rowMatch) continue;

    const prefix = rowMatch[1];
    const cellsHtml = rowMatch[2];
    const suffix = rowMatch[3];

    // Find the Nth <td> in cellsHtml (colIdx - 1 because the first <td> is already in prefix)
    const targetTdIdx = colIdx - 1; // 0-based within the remaining cells
    let tdCount = 0;
    const tdReplace = cellsHtml.replace(
      /<td[^>]*>[\s\S]*?<\/td>/g,
      (fullMatch) => {
        const currentIdx = tdCount++;
        if (currentIdx === targetTdIdx && fullMatch.includes("cross")) {
          // Replace cross with check
          return fullMatch
            .replace(/class="cross"/, `class="check"`)
            .replace(/&#10007;[\s\S]*/, `&#10003;</span></td>`);
        }
        return fullMatch;
      },
    );

    result = result.replace(rowPattern, prefix + tdReplace + suffix);
  }

  return result;
}

// ── Summary Writing ──────────────────────────────────────────────────────────

function parseSummaryArg(): string | null {
  const idx = process.argv.indexOf("--summary");
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  return resolve(process.argv[idx + 1]);
}

function writeSummary(summaryPath: string, changes: DetectedChange[]): void {
  let md: string;

  if (changes.length === 0) {
    md = "No competitive matrix changes detected this week.\n";
  } else {
    const lines: string[] = [];
    lines.push("## Competitive Matrix Changes");
    lines.push("");
    lines.push("| Competitor | Capability | Change |");
    lines.push("| --- | --- | --- |");
    for (const ch of changes) {
      lines.push(`| ${ch.competitor} | ${ch.capability} | ${ch.from} -> ${ch.to} |`);
    }
    lines.push("");
    md = lines.join("\n");
  }

  writeFileSync(summaryPath, md, "utf-8");
  console.log(`\nSummary written to ${summaryPath}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== Competitive Matrix Updater ===\n");

  if (DRY_RUN) {
    console.log("  [DRY RUN] No files will be modified.\n");
  }

  // 1. Fetch competitor data
  const competitorFeatures = new Map<string, Record<string, boolean>>();

  for (const comp of COMPETITORS) {
    console.log(`\n--- ${comp.name} (${comp.repo}) ---`);
    const [readme, pkg] = await Promise.all([fetchReadme(comp.repo), fetchPackageJson(comp.repo)]);

    if (!readme && !pkg) {
      console.log(`  No data fetched, skipping.`);
      continue;
    }

    const combined = `${readme}\n${pkg}`;
    const features = extractFeatures(combined);
    competitorFeatures.set(comp.name, features);

    // Log detected features
    const detected = Object.entries(features)
      .filter(([, v]) => v)
      .map(([k]) => k);
    if (detected.length > 0) {
      console.log(`  Detected features: ${detected.join(", ")}`);
    } else {
      console.log(`  No features detected from keywords.`);
    }
  }

  // 2. Read current HTML
  console.log(`\nReading ${DOCS_PATH}...`);
  const html = readFileSync(DOCS_PATH, "utf-8");

  // 3. Parse current matrix
  let matrix: ReturnType<typeof parseCurrentMatrix>;
  try {
    matrix = parseCurrentMatrix(html);
  } catch (err) {
    console.error(`Failed to parse comparison table: ${err}`);
    console.log("The comparison table may need competitor columns added before this script can update them.");
    // Still write summary with detected features even if table parse fails
    const summaryPath = parseSummaryArg();
    if (summaryPath) {
      const lines: string[] = [];
      lines.push("## Competitive Matrix Scan Results");
      lines.push("");
      lines.push("Could not parse comparison table. Detected features per competitor:");
      lines.push("");
      for (const [name, features] of competitorFeatures) {
        const detected = Object.entries(features)
          .filter(([, v]) => v)
          .map(([k]) => k);
        lines.push(`### ${name}`);
        if (detected.length > 0) {
          lines.push(detected.map((d) => `- ${d}`).join("\n"));
        } else {
          lines.push("- No features detected");
        }
        lines.push("");
      }
      writeFileSync(summaryPath, lines.join("\n"), "utf-8");
      console.log(`\nSummary written to ${summaryPath}`);
    }
    return;
  }

  console.log(
    `Parsed ${matrix.rows.size} capability rows, ${matrix.headers.length} columns.`,
  );

  // 4. Compute changes
  const changes = computeChanges(matrix, competitorFeatures);

  const summaryPath = parseSummaryArg();

  if (changes.length === 0) {
    console.log("\nNo changes detected. Competitive matrix is up to date.");
    if (summaryPath) writeSummary(summaryPath, changes);
    return;
  }

  console.log(`\n${changes.length} change(s) detected:`);
  for (const ch of changes) {
    console.log(`  ${ch.competitor} / ${ch.capability}: ${ch.from} -> ${ch.to}`);
  }

  if (summaryPath) writeSummary(summaryPath, changes);

  if (DRY_RUN) {
    console.log("\n[DRY RUN] Would update docs/index.html with the above changes.");
    return;
  }

  // 5. Apply changes to index.html
  const updated = applyChanges(html, changes);
  writeFileSync(DOCS_PATH, updated, "utf-8");
  console.log("\nUpdated docs/index.html successfully.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
