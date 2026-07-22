#!/usr/bin/env tsx
/// <reference types="node" />
/**
 * monthly-gap-analysis.ts
 *
 * Bi-weekly (30-day lookback) Pathfinder gap-analysis pipeline. Designed to run
 * from a scheduled GitHub Action WITHOUT polluting production analytics:
 *
 *   - It READS the analytics JSON API (GET /api/analytics/{summary,queries,
 *     empty-queries}?days=30). It does NOT reproduce queries against the live
 *     MCP — that is what self-inflated the first manual run.
 *   - It strips synthetic/internal probe rows (see cluster.ts) before counting.
 *   - It deterministically clusters the top + empty queries, then runs ONE
 *     LLM pass to classify and rank the gaps into a markdown report.
 *   - It creates a new dated Notion page each run and, only when NEW
 *     high-severity gaps appear vs the prior run, posts a Slack alert.
 *
 * Secrets / env (all optional for a dry run — missing ones degrade gracefully):
 *   PATHFINDER_ANALYTICS_TOKEN  Bearer token for the analytics API. If unset,
 *                               the script logs "skipping live fetch" and
 *                               exits 0 so CI lint passes without secrets.
 *   ANTHROPIC_API_KEY           Anthropic key for the single summarization pass.
 *                               If unset, a deterministic fallback report is
 *                               produced from the clusters (no LLM call).
 *   NOTION_TOKEN                Notion integration token. If unset, the Notion
 *                               publish step is skipped.
 *   NOTION_PARENT_PAGE_ID       Parent page under which a new dated report page
 *                               is created each run. Defaults to Plans/Proposals.
 *   SLACK_WEBHOOK               Incoming-webhook URL the script posts the gap
 *                               report (new high-severity gaps) to. The gap
 *                               report is a successful-run signal, so the
 *                               WORKFLOW maps the #engr org-level secret into it
 *                               (SLACK_WEBHOOK: ${{ secrets.SLACK_WEBHOOK_ENGR }}),
 *                               so a CI run posts to #engr while a local run
 *                               must export SLACK_WEBHOOK itself or the alert is
 *                               a silent no-op. If unset, no Slack alert. (Run
 *                               FAILURES are surfaced as a red CI run, not Slack.)
 *
 * Other env:
 *   ANALYTICS_BASE_URL          Override the analytics host (default prod).
 *   GAP_ANALYSIS_DAYS           Lookback window in days (default 30). Must be a
 *                               positive integer or it falls back to 30.
 *   GAP_STATE_PATH              Path to the prior-run state JSON (for new-gap
 *                               diffing across runs). Default /tmp/...
 *   ANTHROPIC_MODEL             Override the model id.
 *
 * Usage:
 *   npx tsx scripts/gap-analysis/monthly-gap-analysis.ts
 *   npx tsx scripts/gap-analysis/monthly-gap-analysis.ts --report /tmp/gap.md
 *   npx tsx scripts/gap-analysis/monthly-gap-analysis.ts --dry-run
 *
 * --dry-run suppresses the durable state-file write (the uploaded artifact
 * lineage) and ALL external side effects (Notion publish, Slack alert) even
 * when the secrets are present. A `--report <path>` you explicitly request is
 * STILL written under --dry-run — it is a requested local output (a preview),
 * not an external side effect.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clusterQueries,
  filterSynthetic,
  normalizeQueryKey,
  type EmptyQuery,
  type QueryCluster,
  type QueryRow,
  type TopQuery,
} from "./cluster.js";

// ── Config ───────────────────────────────────────────────────────────────────

const ANALYTICS_BASE_URL = (
  process.env.ANALYTICS_BASE_URL ?? "https://mcp.copilotkit.ai"
).replace(/\/+$/, "");

/**
 * Parse the GAP_ANALYSIS_DAYS lookback window strictly. The value must be a
 * positive integer within the analytics API's accepted range; anything else
 * (negatives, zero, fractions like "15.9", non-numeric junk, OR a value above
 * the server's MAX_DAYS) falls back to the 30-day default with a warning rather
 * than silently truncating or passing a bad value to the analytics API (a
 * negative — or an out-of-range-large — `days` makes the server 400 and aborts
 * the whole pipeline, which contradicts this function's purpose of protecting
 * the API).
 */
export function parseDays(raw: string | undefined): number {
  const DEFAULT_DAYS = 30;
  // Mirror the analytics API's server-side cap (MAX_DAYS). A syntactically valid
  // integer above this still 400s, so it is treated as out-of-range here.
  const MAX_DAYS = 100000;
  if (raw === undefined || raw.trim() === "") return DEFAULT_DAYS;
  const trimmed = raw.trim();
  // Strict integer: optional sign handled by the range check below. Reject any
  // input that isn't purely digits so "15.9" does not truncate to 15.
  if (!/^-?\d+$/.test(trimmed)) {
    console.warn(
      `[gap] GAP_ANALYSIS_DAYS="${raw}" is not a valid integer — using default ${DEFAULT_DAYS}.`,
    );
    return DEFAULT_DAYS;
  }
  const days = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(days) || days <= 0) {
    console.warn(
      `[gap] GAP_ANALYSIS_DAYS="${raw}" must be a positive integer — using default ${DEFAULT_DAYS}.`,
    );
    return DEFAULT_DAYS;
  }
  if (days > MAX_DAYS) {
    console.warn(
      `[gap] GAP_ANALYSIS_DAYS="${raw}" exceeds the analytics API max of ${MAX_DAYS} — using default ${DEFAULT_DAYS}.`,
    );
    return DEFAULT_DAYS;
  }
  return days;
}

const DAYS = parseDays(process.env.GAP_ANALYSIS_DAYS);
const ANALYTICS_TOKEN = process.env.PATHFINDER_ANALYTICS_TOKEN ?? "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const ANTHROPIC_MODEL =
  process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
const NOTION_TOKEN = process.env.NOTION_TOKEN ?? "";
const NOTION_PARENT_PAGE_ID =
  process.env.NOTION_PARENT_PAGE_ID ?? "3793aa38-1852-80a5-89d3-c3d37147aa22";
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK ?? "";

/**
 * Resolve the prior-run state file path at call time (not module load) so the
 * CI workflow and the unit tests can both override GAP_STATE_PATH. The workflow
 * downloads the prior run's `gap-analysis-state` artifact to — and re-uploads
 * from — this same stable location.
 */
function statePath(): string {
  return (
    process.env.GAP_STATE_PATH ?? "/tmp/pathfinder-gap-analysis-state.json"
  );
}

const DRY_RUN = process.argv.includes("--dry-run");

// Cap how many clusters we feed the LLM and how many empty clusters we surface
// so the single pass stays cheap and the report stays scannable.
const MAX_TOP_CLUSTERS = 25;
const MAX_EMPTY_CLUSTERS = 25;

// ── Types ────────────────────────────────────────────────────────────────────

export interface AnalyticsSummary {
  total_queries: number;
  total_queries_window: number;
  empty_result_count_window: number;
  empty_result_rate_window: number;
  avg_latency_ms_window: number;
  p95_latency_ms_window: number;
  queries_by_source?: Array<{ source_name: string; count: number }>;
  earliest_query_day?: string | null;
}

export interface Gap {
  title: string;
  severity: "high" | "medium" | "low";
  evidence: string;
  recommendation: string;
}

export interface RunState {
  generated_at: string;
  /**
   * Stable, normalized keys (see normalizeQueryKey) of the high-severity gaps
   * from this run. Keyed on the normalized form rather than the raw title so a
   * run-to-run TRIVIAL rewording of the same underlying gap (casing,
   * punctuation, stop words, word order) maps to the same key and does NOT
   * re-alert. A SUBSTANTIAL semantic rephrasing (different significant tokens)
   * yields a different key and may re-alert — this is not semantic dedup. The
   * raw titles are kept alongside for human-readable debugging.
   */
  high_severity_keys: string[];
  /** Raw titles parallel to high_severity_keys, for readability only. */
  high_severity_titles: string[];
}

// ── Analytics fetch ──────────────────────────────────────────────────────────

/**
 * Resolve the `--report <path>` argument from an argv array. Pure (argv passed
 * in) so it is unit-testable. Returns null when `--report` is absent, has no
 * following token, OR the following token is itself a flag (starts with `--`):
 * `--report --dry-run` must NOT write a file literally named "--dry-run".
 */
export function reportPathArgFrom(argv: readonly string[]): string | null {
  const idx = argv.indexOf("--report");
  if (idx === -1 || idx + 1 >= argv.length) return null;
  const next = argv[idx + 1];
  if (next.startsWith("--")) {
    console.warn(
      `[gap] --report expects a file path but got the flag "${next}" — ignoring --report.`,
    );
    return null;
  }
  return resolve(next);
}

function reportPathArg(): string | null {
  return reportPathArgFrom(process.argv);
}

async function fetchJson<T>(path: string): Promise<T> {
  const url = `${ANALYTICS_BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${ANALYTICS_TOKEN}`,
      Accept: "application/json",
      "User-Agent": "pathfinder-gap-analysis",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Analytics fetch failed: ${res.status} ${res.statusText} for ${path}${
        body ? ` — ${body.slice(0, 200)}` : ""
      }`,
    );
  }
  return (await res.json()) as T;
}

interface AnalyticsBundle {
  summary: AnalyticsSummary;
  topQueries: TopQuery[];
  emptyQueries: EmptyQuery[];
}

async function fetchAnalytics(): Promise<AnalyticsBundle> {
  const q = `?days=${DAYS}&limit=200`;
  console.log(
    `[gap] Fetching analytics from ${ANALYTICS_BASE_URL} (days=${DAYS})…`,
  );
  // Sequential is fine — three small GETs, and it keeps the failure message
  // pointed at the exact endpoint that broke.
  const summary = await fetchJson<AnalyticsSummary>(
    `/api/analytics/summary?days=${DAYS}`,
  );
  const topQueries = await fetchJson<TopQuery[]>(`/api/analytics/queries${q}`);
  const emptyQueries = await fetchJson<EmptyQuery[]>(
    `/api/analytics/empty-queries${q}`,
  );
  return { summary, topQueries, emptyQueries };
}

// ── Clustering ───────────────────────────────────────────────────────────────

export interface ClusteredAnalytics {
  topClusters: QueryCluster[];
  emptyClusters: QueryCluster[];
  syntheticDropped: number;
}

function clusterBundle(bundle: AnalyticsBundle): ClusteredAnalytics {
  const topRaw = bundle.topQueries.length;
  const emptyRaw = bundle.emptyQueries.length;

  const topFiltered = filterSynthetic(bundle.topQueries);
  const emptyFiltered = filterSynthetic(bundle.emptyQueries);
  const syntheticDropped =
    topRaw - topFiltered.length + (emptyRaw - emptyFiltered.length);

  const topRows: QueryRow[] = topFiltered.map((q) => ({
    query_text: q.query_text,
    tool_name: q.tool_name,
    count: q.count,
  }));
  const emptyRows: QueryRow[] = emptyFiltered.map((q) => ({
    query_text: q.query_text,
    tool_name: q.tool_name,
    count: q.count,
  }));

  return {
    topClusters: clusterQueries(topRows).slice(0, MAX_TOP_CLUSTERS),
    emptyClusters: clusterQueries(emptyRows).slice(0, MAX_EMPTY_CLUSTERS),
    syntheticDropped,
  };
}

// ── LLM summarization (single pass) ──────────────────────────────────────────

export function buildLlmPrompt(
  summary: AnalyticsSummary,
  clustered: ClusteredAnalytics,
): string {
  // Cluster representative and member query_text are arbitrary end-user MCP
  // query text (untrusted). JSON.stringify yields a safely-quoted, escaped
  // string (embedded quotes/newlines become \" and \n) so a query like
  // `how to "deploy" prod` or one carrying an injected newline cannot break the
  // quoting and inject pseudo-instructions into this classification pass.
  const fmtClusters = (cs: QueryCluster[]) =>
    cs
      .map(
        (c, i) =>
          `${i + 1}. ${JSON.stringify(c.representative)} — ${c.totalCount} hits` +
          (c.members.length > 1
            ? ` (variants: ${c.members
                .slice(0, 4)
                .map((m) => JSON.stringify(m.query_text))
                .join(", ")})`
            : ""),
      )
      .join("\n");

  return [
    "You are analyzing usage of Pathfinder, an MCP knowledge server for AI agents.",
    "Below are clustered, de-duplicated query analytics for the last",
    `${DAYS} days. Synthetic/internal probe queries have already been removed.`,
    "",
    "## Overall",
    `- Total queries in window: ${summary.total_queries_window}`,
    `- Empty-result rate: ${(summary.empty_result_rate_window * 100).toFixed(1)}%`,
    `- Empty-result count: ${summary.empty_result_count_window}`,
    "",
    "## Top query clusters (highest demand)",
    fmtClusters(clustered.topClusters) || "(none)",
    "",
    "## Empty-result query clusters (demand we FAILED to answer — strongest gap signal)",
    fmtClusters(clustered.emptyClusters) || "(none)",
    "",
    "## Task",
    "Identify the most important DOCUMENTATION / KNOWLEDGE gaps. A gap is a topic",
    "users repeatedly ask about that returns empty or low-quality results.",
    "Prioritize the empty-result clusters. For each gap, assign a severity of",
    '"high", "medium", or "low" (high = frequent + empty + core use case).',
    "",
    "Respond with ONLY a JSON array, no prose, no markdown fence. Each element:",
    '{ "title": string, "severity": "high"|"medium"|"low", "evidence": string, "recommendation": string }',
    "Order the array by severity (high first) then by frequency. Max 15 gaps.",
  ].join("\n");
}

/**
 * Run the single LLM classification pass. The Anthropic SDK is imported
 * dynamically so that a dry run (no ANTHROPIC_API_KEY) never needs the
 * dependency resolved at module load. Returns null on any failure so the
 * caller can fall back to a deterministic report — the pipeline must never
 * hard-fail on the LLM step.
 */
async function classifyGapsWithLlm(
  summary: AnalyticsSummary,
  clustered: ClusteredAnalytics,
): Promise<Gap[] | null> {
  if (!ANTHROPIC_API_KEY) {
    console.log(
      "[gap] ANTHROPIC_API_KEY unset — using deterministic fallback report.",
    );
    return null;
  }
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const prompt = buildLlmPrompt(summary, clustered);
    console.log(
      `[gap] Running single LLM classification pass (${ANTHROPIC_MODEL})…`,
    );
    const resp = await client.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    return parseGapJson(text);
  } catch (err) {
    console.warn(
      `[gap] LLM classification failed, falling back: ${String(err)}`,
    );
    return null;
  }
}

/**
 * Yield EVERY balanced, top-level JSON array span in raw model output, in text
 * order.
 *
 * Scans character-by-character tracking bracket depth (and skipping over string
 * literals so a `]` inside a JSON string value does not close the array early),
 * emitting the substring of each `[ … ]` whose depth returns to zero. Yielding
 * every span (rather than just the first) lets the caller try each candidate and
 * pick the first that JSON-parses into a usable gap array — a single-shot
 * "first balanced span" picks the WRONG array when a prose preamble holds a
 * bracketed phrase (`Here are the gaps [ranked]: [{…}]`) or the wrapper object
 * lists a non-gaps array first (`{"reasoning":[…],"gaps":[…]}`).
 */
function* balancedArraySpans(text: string): Generator<string> {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "]") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          yield text.slice(start, i + 1);
          start = -1;
        }
      }
    }
  }
}

/**
 * True when `value` is a usable gap object: a non-null object bearing a
 * non-empty string `title`. This is the SAME admission test parseGapJson's
 * per-item loop applies, hoisted so the recovery layer can prefer a candidate
 * array that actually contains gaps over one that merely happens to be the first
 * bracketed span in the text (or the first array-valued property of a wrapper).
 */
function isGapObject(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const title = (value as Record<string, unknown>).title;
  return typeof title === "string" && title.trim() !== "";
}

/**
 * Scan the original text for the FIRST balanced top-level [...] span that parses
 * into a NON-EMPTY array of valid gap objects. Trying every span (not just the
 * first) is what makes recovery order-independent: a prose preamble's bracketed
 * phrase, or a leading non-gaps array, is skipped in favor of the real gaps
 * array that follows. Returns null when no span qualifies.
 */
function firstGapArrayFromText(text: string): unknown[] | null {
  for (const span of balancedArraySpans(text)) {
    let reparsed: unknown;
    try {
      reparsed = JSON.parse(span);
    } catch {
      // Bracketed span present but not valid JSON (e.g. `[ranked]`) — skip it
      // and keep scanning for a span that is a real gap array.
      continue;
    }
    if (Array.isArray(reparsed) && reparsed.some(isGapObject)) {
      return reparsed;
    }
  }
  return null;
}

/**
 * Coerce a raw `severity` field to one of the three canonical levels.
 * Case-insensitive, and maps "critical" → "high" so a higher-than-our-scale
 * label still alerts. An unrecognized or absent value is treated conservatively
 * as "medium" (never silently downgraded to "low", which would mute a real gap)
 * and logged so the mismatch is traceable.
 */
function coerceSeverity(raw: unknown): Gap["severity"] {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (value === "high" || value === "critical") return "high";
  if (value === "medium") return "medium";
  if (value === "low") return "low";
  console.warn(
    `[gap] Unrecognized gap severity "${String(raw)}" — treating as "medium" (not silently downgrading to low).`,
  );
  return "medium";
}

// Property names a model commonly wraps the gap array under, in preference
// order. Checked BEFORE any heuristic so an explicitly-named `gaps` array always
// wins over a sibling array (e.g. a `summary` of title-bearing objects).
const GAP_ARRAY_KEYS = ["gaps", "result", "items"] as const;

/**
 * Recover the gap array from a JSON OBJECT the model wrapped it in (it disobeyed
 * the "ONLY a JSON array" instruction), e.g. {"gaps":[...]} or {"result":[...]}.
 *
 * Order-INDEPENDENT strategy (JSON key order is non-deterministic, so a fixed
 * "first array property" rule picks the wrong array when gaps is emitted after a
 * reasoning/notes array):
 *   (a) Prefer an array-valued property explicitly named gaps, then result, then
 *       items.
 *   (b) Else, among ALL array-valued properties, prefer one whose elements
 *       include a valid gap object (string `title`). If exactly one array exists
 *       it is taken even without a title (preserves the legacy single-array
 *       wrapper contract, e.g. {"result":["a string"]} → that array → the
 *       caller's no-valid-gaps fallback fires with its own warning).
 *   (c) Else, scan the original text for the first balanced [...] span that
 *       parses into a non-empty array of gap objects.
 * Returns null when none qualifies so the caller can fall back (with a traceable
 * warning).
 */
function recoverWrappedArray(parsed: unknown, text: string): unknown[] | null {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    // (a) Explicit gap-array property names win regardless of key order.
    for (const key of GAP_ARRAY_KEYS) {
      if (Array.isArray(obj[key])) {
        return obj[key] as unknown[];
      }
    }
    const arrayValues = Object.values(obj).filter((v): v is unknown[] =>
      Array.isArray(v),
    );
    // (b) Prefer an array that actually carries gap objects (string title).
    const titled = arrayValues.find((arr) => arr.some(isGapObject));
    if (titled) return titled;
    // Exactly one array-valued property → unambiguously the wrapped array, even
    // if its elements aren't gap objects (the caller's no-valid-gaps path then
    // engages the fallback with a distinct warning).
    if (arrayValues.length === 1) {
      return arrayValues[0];
    }
  }
  // (c) Fall back to the first text span that parses into a real gap array.
  return firstGapArrayFromText(text);
}

/** Extract and validate the gap JSON array from raw model output. */
export function parseGapJson(text: string): Gap[] | null {
  let parsed: unknown;
  let parsedWholeText = true;
  // Fast path: the model obeyed the "ONLY a JSON array" instruction. Parsing
  // the whole text first means a valid array followed by trailing prose that
  // happens to contain a `]` is not over-captured (the old first-`[`…last-`]`
  // slice failed exactly that case and silently fell back to deterministic).
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    parsedWholeText = false;
    // Slow path: tolerate a ```json fence or a prose preamble by scanning the
    // text for the FIRST balanced top-level [...] span that parses into a real
    // gap array. Trying every span (not just the first) skips a bracketed prose
    // phrase like `Here are the gaps [ranked]:` and finds the gap array that
    // follows.
    const recovered = firstGapArrayFromText(text);
    if (recovered !== null) {
      parsed = recovered;
    } else {
      // No qualifying gap array. Distinguish two cases for traceability:
      // - At least one bracketed span existed but none was a parseable gap
      //   array → this is a fallback worth signalling distinctly in the logs.
      // - No bracketed span at all → the no-content case; stay quiet so an empty
      //   or prose-only response isn't noisy.
      const hadBracketedSpan = !balancedArraySpans(text).next().done;
      if (hadBracketedSpan) {
        console.warn(
          "[gap] LLM returned text but no parseable JSON array — falling back to deterministic",
        );
      }
      return null;
    }
  }
  // The fast-path JSON.parse can succeed on a JSON OBJECT that WRAPS the array
  // (the model disobeying "ONLY a JSON array"): {"gaps":[...]} or {"result":[...]}.
  // Returning null here would silently discard a usable LLM array with no log —
  // violating the design that every fallback is traceable. Recover the array
  // order-independently (recoverWrappedArray: a gaps/result/items property, else
  // an array of title-bearing objects, else the first balanced text span that is
  // a gap array) — then run it through the SAME validation/coercion below. Only
  // if recovery fails do we fall back, with a DISTINCT warning consistent with
  // the other fallback-signalling logs.
  let items: unknown[];
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (!parsedWholeText) {
    // Slow path already resolved `parsed` to a recovered gap array above.
    items = parsed as unknown[];
  } else {
    const recovered = recoverWrappedArray(parsed, text);
    if (recovered === null) {
      console.warn(
        "[gap] LLM returned a JSON object with no recoverable gap array — falling back to deterministic",
      );
      return null;
    }
    items = recovered;
  }
  const gaps: Gap[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.title !== "string" || rec.title.trim() === "") continue;
    gaps.push({
      title: rec.title.trim(),
      severity: coerceSeverity(rec.severity),
      evidence: typeof rec.evidence === "string" ? rec.evidence : "",
      recommendation:
        typeof rec.recommendation === "string" ? rec.recommendation : "",
    });
  }
  // A genuinely empty array ([]) is a valid "no gaps" answer and stays []. But a
  // NON-empty array that yielded ZERO valid gap objects (e.g. ["a string"]) is
  // not a usable LLM result — returning [] here would make the caller treat the
  // run as a successful LLM classification (usedLlm=true) and SKIP the
  // deterministic fallback, rendering "No gaps identified" + "Classification:
  // LLM" while real empty-clusters exist. Return null so the fallback engages.
  if (items.length > 0 && gaps.length === 0) {
    console.warn(
      "[gap] LLM returned a non-empty array with no valid gap objects — falling back to deterministic",
    );
    return null;
  }
  return gaps;
}

// Cap the gap list — for BOTH the LLM and the deterministic (no-LLM) path — to
// match the LLM prompt's "Max 15" instruction, so every path emits the same
// scale of report (and at most a 15-bullet Slack alert) rather than an
// unbounded LLM list or up to MAX_EMPTY_CLUSTERS (25) deterministic gaps.
export const MAX_GAPS = 15;

/**
 * Cap a (already-sorted, high-first) gap list at MAX_GAPS. Applied to the LLM
 * path too — a verbose model can ignore the prompt's "Max 15" and return more,
 * which would balloon the report and the Slack alert.
 */
export function capGaps(gaps: Gap[]): Gap[] {
  return gaps.slice(0, MAX_GAPS);
}

/**
 * Deterministic fallback when no LLM is available: treat each empty-result
 * cluster as a gap, with severity derived from its frequency. Keeps the
 * pipeline useful (and CI green) without an API key. Clusters arrive
 * count-desc, so the top MAX_GAPS are the highest-demand gaps.
 */
export function deterministicGaps(clustered: ClusteredAnalytics): Gap[] {
  return clustered.emptyClusters.slice(0, MAX_GAPS).map((c) => {
    const severity: Gap["severity"] =
      c.totalCount >= 10 ? "high" : c.totalCount >= 3 ? "medium" : "low";
    return {
      title: c.representative,
      severity,
      evidence: `${c.totalCount} empty-result hits across ${c.members.length} phrasing(s).`,
      recommendation:
        "Add or improve documentation/knowledge coverage for this topic.",
    };
  });
}

// ── Report rendering ─────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<Gap["severity"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

function sortGaps(gaps: Gap[]): Gap[] {
  return [...gaps].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
}

function renderMarkdown(
  summary: AnalyticsSummary,
  clustered: ClusteredAnalytics,
  gaps: Gap[],
  usedLlm: boolean,
): string {
  const now = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`# CopilotKit Docs (MCP) Gap Analysis — ${now}`);
  lines.push("");
  lines.push(
    `Window: last ${DAYS} days · Source: analytics API (read-only) · ` +
      `Classification: ${usedLlm ? "LLM" : "deterministic fallback"}`,
  );
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Total queries: ${summary.total_queries_window}`);
  lines.push(
    `- Empty-result rate: ${(summary.empty_result_rate_window * 100).toFixed(1)}% ` +
      `(${summary.empty_result_count_window} queries)`,
  );
  lines.push(
    `- Synthetic/internal rows excluded: ${clustered.syntheticDropped} ` +
      `(the totals above come straight from the analytics API and still ` +
      `include synthetic probe rows; the ${clustered.syntheticDropped} are ` +
      `excluded only from the clustering below)`,
  );
  lines.push("");

  const sorted = sortGaps(gaps);
  lines.push("## Ranked gaps");
  lines.push("");
  if (sorted.length === 0) {
    lines.push("No gaps identified this period.");
  } else {
    for (const g of sorted) {
      lines.push(`### [${g.severity.toUpperCase()}] ${g.title}`);
      if (g.evidence) lines.push(`- Evidence: ${g.evidence}`);
      if (g.recommendation) lines.push(`- Recommendation: ${g.recommendation}`);
      lines.push("");
    }
  }

  lines.push("## Top query clusters");
  lines.push("");
  if (clustered.topClusters.length === 0) {
    lines.push("(none)");
  } else {
    lines.push("| Cluster | Hits | Variants |");
    lines.push("| --- | --- | --- |");
    for (const c of clustered.topClusters) {
      lines.push(
        `| ${c.representative} | ${c.totalCount} | ${c.members.length} |`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

// ── State diff (new high-severity gaps vs prior run) ─────────────────────────

export function readPriorState(): RunState | null {
  const path = statePath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<RunState>;
    // Require the normalized-key array; a file missing it (older format or
    // corrupt) is treated as no prior state → first run.
    if (Array.isArray(parsed?.high_severity_keys)) {
      return {
        generated_at:
          typeof parsed.generated_at === "string" ? parsed.generated_at : "",
        high_severity_keys: parsed.high_severity_keys,
        high_severity_titles: Array.isArray(parsed.high_severity_titles)
          ? parsed.high_severity_titles
          : [],
      };
    }
    return null;
  } catch (err) {
    console.warn(`[gap] Could not read prior state: ${String(err)}`);
    return null;
  }
}

export function writeState(gaps: Gap[]): RunState {
  const highGaps = gaps.filter((g) => g.severity === "high");
  const state: RunState = {
    generated_at: new Date().toISOString(),
    // Normalized keys are the durable identity used for new-gap diffing; the
    // raw titles ride alongside purely for human-readable debugging.
    high_severity_keys: highGaps.map((g) => normalizeQueryKey(g.title)),
    high_severity_titles: highGaps.map((g) => g.title),
  };
  try {
    // Create the parent directory so the write can't ENOENT when the dir is
    // absent — the state file must not depend on the workflow's `mkdir -p`
    // having run (a local run, or a workflow change, could skip it).
    mkdirSync(dirname(statePath()), { recursive: true });
    writeFileSync(statePath(), JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    // Do NOT swallow this. A missing state file breaks the run-to-run lineage
    // (the next run cold-starts and re-alerts every high gap), and — worse —
    // alerting on gaps we failed to record causes repeat storms. Surface it at
    // error level and re-throw so the caller skips the Slack alert.
    console.error(`[gap] Could not persist state: ${String(err)}`);
    throw err;
  }
  return state;
}

/**
 * Write the current run's state on the early-exit (no-analytics-token) path so
 * EVERY successful run still uploads a non-empty `gap-analysis-state` artifact.
 * Otherwise an early-exit run is "success" but leaves no artifact, and the next
 * run's download finds nothing and silently cold-starts → re-alerts every high
 * gap. Skipped under --dry-run to keep the durable state write (and thus the
 * artifact lineage) side-effect-free; an explicitly requested --report is still
 * written, as it is a local preview rather than an external side effect.
 */
export function writeEarlyExitState(dryRun: boolean): void {
  if (dryRun) {
    console.log("[gap] [DRY RUN] Would persist empty run state.");
    return;
  }
  try {
    writeState([]);
    console.log("[gap] Persisted empty run state (no-analytics-token path).");
  } catch (err) {
    // Surface but don't fail the no-secrets smoke run over it.
    console.error(`[gap] Could not persist early-exit state: ${String(err)}`);
  }
}

/**
 * Persist this run's state and only THEN (and only if persistence succeeded)
 * post the new-high-severity Slack alert. Dependency-injected so the
 * ordering/guard contract is unit-testable without the network. The order is
 * load-bearing: we must never alert on a gap we failed to record, or the next
 * run re-detects it as "new" and the alert repeats.
 */
export async function persistAndMaybeAlert(opts: {
  newHigh: string[];
  slackText: string;
  writeStateFn: () => Promise<void> | void;
  postSlackFn: (text: string) => Promise<void> | void;
}): Promise<void> {
  try {
    await opts.writeStateFn();
  } catch (err) {
    console.error(
      `[gap] State not persisted — SKIPPING Slack alert to avoid a repeat-alert storm: ${String(err)}`,
    );
    return;
  }
  if (opts.newHigh.length > 0) {
    await opts.postSlackFn(opts.slackText);
  } else {
    console.log(
      "[gap] No new high-severity gaps vs prior run — no Slack alert.",
    );
  }
}

/**
 * High-severity gap titles present now but absent from the prior run, compared
 * on the STABLE normalized key (see normalizeQueryKey) rather than the raw
 * title. The LLM rephrases gap titles run-to-run; keying on the normalized form
 * means a TRIVIALLY reworded title for the same underlying gap (casing,
 * punctuation, stop words, word order) is NOT reported as new — which would
 * otherwise produce a recurring false-positive Slack storm. The collapse is only
 * as strong as the normalization: a SUBSTANTIAL semantic rephrasing (different
 * significant tokens) reduces to a different key and may still be reported as
 * new. A null prior (first run, or missing/corrupt state) reports every high
 * gap.
 */
export function newHighSeverityGaps(
  current: Gap[],
  prior: RunState | null,
): string[] {
  const priorKeys = new Set(prior?.high_severity_keys ?? []);
  return current
    .filter(
      (g) =>
        g.severity === "high" && !priorKeys.has(normalizeQueryKey(g.title)),
    )
    .map((g) => g.title);
}

/**
 * Collapse gaps from the CURRENT run that share the same normalized key (see
 * normalizeQueryKey), keeping the first occurrence of each key. Without this, a
 * single run that surfaces several trivially-reworded titles of the same gap
 * (e.g. "Auth setup" / "authentication SETUP" / "auth  setup") produces
 * redundant Slack bullets AND duplicate stored keys in writeState — so the next
 * run's diff and this run's alert both double-count the same underlying gap.
 * Applied to the current run before alerting and before persisting state.
 */
export function dedupHighSeverityByKey(gaps: Gap[]): Gap[] {
  const seen = new Set<string>();
  const out: Gap[] = [];
  for (const g of gaps) {
    const key = normalizeQueryKey(g.title);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  return out;
}

/**
 * Render the Slack bullet list for the new high-severity gaps, capped at
 * MAX_GAPS independently of the report cap so a long list can't produce an
 * unbounded alert. Overflow beyond the cap is summarized as "…and N more"
 * rather than silently dropped. Returns "" for an empty list.
 */
export function buildSlackBullets(titles: readonly string[]): string {
  if (titles.length === 0) return "";
  const shown = titles.slice(0, MAX_GAPS);
  const lines = shown.map((t) => `• ${t}`);
  const overflow = titles.length - shown.length;
  if (overflow > 0) {
    lines.push(`…and ${overflow} more`);
  }
  return lines.join("\n");
}

// ── Notion + Slack side effects ──────────────────────────────────────────────

// Notion API limits the rich_text content of a single block to 2000 chars, and
// caps both pages.create children and blocks.children.append at 100 blocks per
// request. markdownToNotionBlocks/batchBlocks honor both.
export const NOTION_RICH_TEXT_LIMIT = 2000;
export const NOTION_MAX_BLOCKS_PER_REQUEST = 100;

/** A Notion rich_text "text" object. */
interface NotionRichText {
  type: "text";
  text: { content: string };
}

/** A minimal Notion block object (one of our supported block types). */
type NotionBlockType =
  | "heading_1"
  | "heading_2"
  | "heading_3"
  | "bulleted_list_item"
  | "paragraph"
  | "table";

interface NotionBlock {
  object: "block";
  type: NotionBlockType;
  [key: string]: unknown;
}

interface NotionTableRow {
  type: "table_row";
  table_row: { cells: NotionRichText[][] };
}

interface NotionTableBlock extends NotionBlock {
  type: "table";
  table: {
    table_width: number;
    has_column_header: boolean;
    has_row_header: boolean;
    children: NotionTableRow[];
  };
}

/** Max DATA rows (excluding header) emitted per Notion table. */
export const NOTION_MAX_TABLE_ROWS = 100;

/**
 * Split a single line's text into <=NOTION_RICH_TEXT_LIMIT-char rich_text spans.
 * A Notion block's rich_text content is capped at 2000 chars per object, so a
 * line longer than that must be carried across multiple rich_text objects in the
 * SAME block (preserving the block type) rather than truncated. A line at or
 * under the cap yields a single span. Empty input yields one empty span so the
 * block always carries a (valid) rich_text array.
 */
function lineToRichText(line: string): NotionRichText[] {
  if (line.length <= NOTION_RICH_TEXT_LIMIT) {
    return [{ type: "text", text: { content: line } }];
  }
  const spans: NotionRichText[] = [];
  for (let i = 0; i < line.length; i += NOTION_RICH_TEXT_LIMIT) {
    spans.push({
      type: "text",
      text: { content: line.slice(i, i + NOTION_RICH_TEXT_LIMIT) },
    });
  }
  return spans;
}

function makeBlock(type: NotionBlockType, text: string): NotionBlock {
  return {
    object: "block",
    type,
    [type]: { rich_text: lineToRichText(text) },
  };
}

/** A markdown table row line starts and ends with a pipe (after trimming). */
function isTableLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length > 1;
}

/** A `| --- | :--: |`-style separator row that delimits header from body. */
function isSeparatorRow(line: string): boolean {
  return splitTableRow(line).every((c) => /^:?-{1,}:?$/.test(c.trim()));
}

/**
 * Split one `| a | b |` line into its cell strings (drops the outer pipes).
 * Splits on UNESCAPED pipes only, so a `\|` inside a cell stays part of that
 * cell.
 */
function splitTableRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  // Negative lookbehind: a `|` not preceded by a backslash is a delimiter.
  return t.split(/(?<!\\)\|/);
}

/**
 * Un-escape a markdown table cell (Notion cells are not markdown, so a `\|`
 * escape must be undone) and trim surrounding space.
 */
function tableCellText(raw: string): string {
  return raw.replace(/\\\|/g, "|").trim();
}

function makeTableRow(cells: string[]): NotionTableRow {
  return {
    type: "table_row",
    table_row: { cells: cells.map((c) => lineToRichText(tableCellText(c))) },
  };
}

/**
 * Build a native Notion `table` block from a contiguous run of `|...|` lines.
 * The separator row is dropped; the first remaining row is the header. Tables
 * are capped at NOTION_MAX_TABLE_ROWS data rows (a trailing truncation note is
 * the caller's responsibility) and every cell respects the rich_text cap.
 */
function tableRunToBlock(run: string[]): {
  block: NotionTableBlock;
  truncatedFrom: number | null;
} {
  const rows = run.filter((l) => !isSeparatorRow(l)).map(splitTableRow);
  const width = rows.reduce((max, r) => Math.max(max, r.length), 0);
  const header = rows[0] ?? [];
  const dataRows = rows.slice(1);
  const totalData = dataRows.length;
  const keptData =
    totalData > NOTION_MAX_TABLE_ROWS
      ? dataRows.slice(0, NOTION_MAX_TABLE_ROWS)
      : dataRows;

  // Pad ragged rows to a uniform width so Notion accepts the table.
  const pad = (cells: string[]): string[] =>
    cells.length >= width
      ? cells
      : [...cells, ...Array(width - cells.length).fill("")];

  const children: NotionTableRow[] = [
    makeTableRow(pad(header)),
    ...keptData.map((r) => makeTableRow(pad(r))),
  ];

  return {
    block: {
      object: "block",
      type: "table",
      table: {
        table_width: width,
        has_column_header: true,
        has_row_header: false,
        children,
      },
    },
    truncatedFrom: totalData > NOTION_MAX_TABLE_ROWS ? totalData : null,
  };
}

/**
 * Convert a markdown report into native Notion block objects so the published
 * page renders headings, bullet lists, and tables instead of the literal
 * `#`/`-`/`|` source. Line-by-line mapping:
 *   `# `   → heading_1   `## ` → heading_2   `### ` → heading_3
 *   `- `/`* ` → bulleted_list_item
 *   a contiguous run of `|...|` lines → one native `table` block (separator row
 *     dropped, first row as header); tables longer than NOTION_MAX_TABLE_ROWS
 *     data rows are capped with a trailing truncation note
 *   blank line → skipped (Notion spacing comes from block structure)
 *   anything else → paragraph
 * The report's FIRST line is a redundant top-level `# CopilotKit Docs (MCP) Gap Analysis —
 * <date>` H1 that duplicates the page title (set via properties.title); it is
 * dropped so the page doesn't show a duplicate heading. Only the leading line is
 * dropped — a later H1 still renders. Every block respects the 2000-char
 * rich_text cap (see lineToRichText).
 */
export function markdownToNotionBlocks(markdown: string): NotionBlock[] {
  const blocks: NotionBlock[] = [];
  const rawLines = markdown.split("\n");

  for (let idx = 0; idx < rawLines.length; idx++) {
    const line = rawLines[idx];
    // Drop the leading duplicate-title H1 line (only the very first line).
    if (idx === 0 && line.startsWith("# ")) continue;

    // Gather a contiguous run of table lines and emit one table block.
    if (isTableLine(line)) {
      const run: string[] = [];
      while (idx < rawLines.length && isTableLine(rawLines[idx])) {
        run.push(rawLines[idx]);
        idx++;
      }
      idx--; // step back: the for-loop's idx++ re-consumes the non-table line
      const { block, truncatedFrom } = tableRunToBlock(run);
      blocks.push(block);
      if (truncatedFrom !== null) {
        blocks.push(
          makeBlock(
            "paragraph",
            `(table truncated to first ${NOTION_MAX_TABLE_ROWS} rows of ${truncatedFrom})`,
          ),
        );
      }
      continue;
    }

    if (line.trim() === "") continue; // blank → no empty paragraph block
    if (line.startsWith("### ")) {
      blocks.push(makeBlock("heading_3", line.slice(4)));
    } else if (line.startsWith("## ")) {
      blocks.push(makeBlock("heading_2", line.slice(3)));
    } else if (line.startsWith("# ")) {
      blocks.push(makeBlock("heading_1", line.slice(2)));
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      blocks.push(makeBlock("bulleted_list_item", line.slice(2)));
    } else {
      blocks.push(makeBlock("paragraph", line));
    }
  }
  return blocks;
}

/**
 * Split a block list into batches of at most `size` blocks. Notion's
 * pages.create children and blocks.children.append are both capped at 100 blocks
 * per request, so a report exceeding that must be created with the first batch
 * and appended in subsequent batches. Order is preserved; an empty list yields
 * no batches.
 */
export function batchBlocks<T>(blocks: T[], size: number): T[][] {
  if (size <= 0) {
    throw new Error(
      `batchBlocks: size must be a positive integer, got ${size}`,
    );
  }
  const batches: T[][] = [];
  for (let i = 0; i < blocks.length; i += size) {
    batches.push(blocks.slice(i, i + size));
  }
  return batches;
}

async function publishToNotion(
  title: string,
  markdown: string,
): Promise<string | null> {
  if (!NOTION_TOKEN) {
    console.log("[gap] NOTION_TOKEN unset — skipping Notion publish.");
    return null;
  }
  if (DRY_RUN) {
    console.log("[gap] [DRY RUN] Would publish report to Notion.");
    return null;
  }
  try {
    const { Client } = await import("@notionhq/client");
    const notion = new Client({ auth: NOTION_TOKEN });
    // Render the markdown report into native Notion blocks (headings, bullets)
    // so the page reads as a formatted report rather than raw `#`/`-` markdown.
    const blocks = markdownToNotionBlocks(markdown);
    // Both pages.create and blocks.children.append cap children at 100 per
    // request — create the page with the first batch, then append the rest.
    const batches = batchBlocks(blocks, NOTION_MAX_BLOCKS_PER_REQUEST);
    const firstBatch = batches[0] ?? [];
    const page = (await notion.pages.create({
      parent: { page_id: NOTION_PARENT_PAGE_ID },
      properties: {
        title: { title: [{ type: "text", text: { content: title } }] },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      children: firstBatch as any,
    })) as { id: string; url?: string };
    for (const batch of batches.slice(1)) {
      await notion.blocks.children.append({
        block_id: page.id,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        children: batch as any,
      });
    }
    console.log(`[gap] Published to Notion: ${page.url ?? "(no url)"}`);
    return page.url ?? null;
  } catch (err) {
    // A failed publish means the Slack alert won't carry a report link — surface
    // it at error level (not warn) so it stands out in the workflow logs.
    console.error(`[gap] Notion publish failed: ${String(err)}`);
    return null;
  }
}

/**
 * Split `text` into chunks no longer than `size`, preferring line boundaries so
 * Notion paragraph blocks don't break mid-line. Whole lines are accumulated up
 * to the limit; a single line longer than the limit (rare for a gap report) is
 * the only case that is hard-split, and even then on a raw character boundary
 * only as a last resort. Always returns at least one chunk (`[""]` for empty
 * input) so an empty report still produces a valid block.
 */
export function chunkText(text: string, size: number): string[] {
  // A non-positive size is a programming error, not a runtime condition.
  // Returning the text un-chunked would push an over-2000-char block to Notion
  // and get rejected inside a swallowed catch — fail loud here instead.
  if (size <= 0) {
    throw new Error(`chunkText: size must be a positive integer, got ${size}`);
  }
  const out: string[] = [];
  let current = "";

  const flush = () => {
    if (current.length > 0) {
      out.push(current);
      current = "";
    }
  };

  for (const line of text.split("\n")) {
    if (line.length > size) {
      // Single over-long line: flush what we have, then hard-split the line.
      flush();
      for (let i = 0; i < line.length; i += size) {
        out.push(line.slice(i, i + size));
      }
      continue;
    }
    // +1 accounts for the "\n" that rejoins this line to the previous one.
    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (candidate.length > size) {
      flush();
      current = line;
    } else {
      current = candidate;
    }
  }
  flush();

  return out.length > 0 ? out : [""];
}

async function postSlack(text: string): Promise<void> {
  if (!SLACK_WEBHOOK) {
    console.log("[gap] SLACK_WEBHOOK unset — skipping Slack alert.");
    return;
  }
  if (DRY_RUN) {
    console.log("[gap] [DRY RUN] Would post Slack alert.");
    return;
  }
  try {
    const res = await fetch(SLACK_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.warn(`[gap] Slack POST failed: ${res.status} ${res.statusText}`);
    } else {
      console.log("[gap] Slack alert sent.");
    }
  } catch (err) {
    console.warn(`[gap] Slack POST error: ${String(err)}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== Pathfinder Gap Analysis ===");

  if (!ANALYTICS_TOKEN) {
    // Dry/no-secrets mode: this is the expected state in CI lint before the
    // user provisions secrets. Exit 0 so the workflow's smoke step is green.
    console.log(
      "[gap] PATHFINDER_ANALYTICS_TOKEN unset — skipping live fetch (dry/no-secrets mode). Exiting 0.",
    );
    const reportPath = reportPathArg();
    if (reportPath) {
      writeFileSync(
        reportPath,
        "# CopilotKit Docs (MCP) Gap Analysis\n\nSkipped: PATHFINDER_ANALYTICS_TOKEN not set.\n",
        "utf-8",
      );
    }
    // Still persist a (curr-run, empty) state so this "success" run uploads a
    // gap-analysis-state artifact and the state lineage doesn't break. Without
    // this, the next run's download finds nothing and silently cold-starts,
    // re-alerting every high-severity gap. Guarded so --dry-run stays clean.
    writeEarlyExitState(DRY_RUN);
    return;
  }

  const bundle = await fetchAnalytics();
  const clustered = clusterBundle(bundle);
  console.log(
    `[gap] ${clustered.topClusters.length} top clusters, ` +
      `${clustered.emptyClusters.length} empty clusters, ` +
      `${clustered.syntheticDropped} synthetic rows dropped.`,
  );

  let gaps = await classifyGapsWithLlm(bundle.summary, clustered);
  const usedLlm = gaps !== null;
  if (!gaps) gaps = deterministicGaps(clustered);
  // Sort high-first, collapse any trivially-reworded duplicates of the same gap
  // (so the report, the alert, and the persisted state all see one entry per
  // underlying gap), THEN bound the list — dedup-before-cap keeps up to MAX_GAPS
  // *distinct* gaps rather than letting duplicates eat slots. The LLM path is
  // otherwise uncapped: a verbose model can blow past the prompt's "Max 15".
  gaps = capGaps(dedupHighSeverityByKey(sortGaps(gaps)));

  const reportTitle = `CopilotKit Docs (MCP) Gap Analysis — ${new Date()
    .toISOString()
    .slice(0, 10)}`;
  const markdown = renderMarkdown(bundle.summary, clustered, gaps, usedLlm);

  const reportPath = reportPathArg();
  if (reportPath) {
    // Create the report's parent directory so the write can't ENOENT when the
    // requested path points at a not-yet-existing dir — only the state dir is
    // mkdir'd (via writeState), so mirror that here for the --report preview.
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, markdown, "utf-8");
    console.log(`[gap] Report written to ${reportPath}`);
  }

  const prior = readPriorState();
  const newHigh = newHighSeverityGaps(gaps, prior);

  const notionUrl = await publishToNotion(reportTitle, markdown);

  const slackText =
    `:rotating_light: Pathfinder gap analysis: ${newHigh.length} new HIGH-severity ` +
    `gap(s) this month:\n` +
    buildSlackBullets(newHigh) +
    (notionUrl
      ? `\n<${notionUrl}|Full report>`
      : NOTION_TOKEN && !DRY_RUN
        ? "\n_(report publish failed — see workflow logs)_"
        : "");

  // Persist state BEFORE alerting, and only alert if persistence succeeded.
  // writeState is guarded behind !DRY_RUN so the durable state write and the
  // external Slack post are both side-effect-free under --dry-run (postSlack
  // already self-short-circuits under --dry-run). The --report file above is
  // intentionally NOT guarded: it is a requested local preview, not a side
  // effect. In dry-run we skip writeState entirely, so there is no failure
  // that should suppress the (already no-op) alert path.
  await persistAndMaybeAlert({
    newHigh,
    slackText,
    writeStateFn: () => {
      if (DRY_RUN) {
        console.log("[gap] [DRY RUN] Would persist run state.");
        return;
      }
      writeState(gaps);
    },
    postSlackFn: postSlack,
  });

  console.log("[gap] Done.");
}

// Only run the pipeline when invoked directly (npx tsx … / node …), not when
// imported by the unit tests, which exercise the pure exported helpers above.
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error("[gap] Fatal error:", err);
    process.exit(1);
  });
}
