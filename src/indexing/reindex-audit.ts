import { getConfig, getServerConfig } from "../config.js";
import { getIndexedItemIds } from "../db/queries.js";
import { walkSourceFiles } from "./utils.js";
import { isFileSourceConfig } from "../types.js";
import type { FileSourceConfig } from "../types.js";

// Dedup: only alert when findings change from the previous audit run.
// Key = "source:check:direction", value = count. If the counts match, skip the
// alert. The direction is part of the key because a single source can produce
// BOTH directions of count_divergence in one run (stale rows in the index AND
// unindexed files on disk); keying on "source:check" alone would let one
// overwrite the other and silently suppress its alert.
const lastAuditFindings = new Map<string, number>();

/**
 * Default fraction of a source's walked files that may be absent from the
 * index without the audit reporting a shortfall.
 *
 * Some shortfall is legitimate: the indexer walks and matches a file, then
 * drops it because it carries no semantic content (an SVG, a base64 blob, an
 * empty file). Reporting every such file would put a finding on every source
 * on every reindex, and an alarm that always fires is an alarm that gets
 * muted — which is exactly how the shortfall direction came to be suppressed
 * outright. So the check reports only shortfall ABOVE a per-source baseline.
 *
 * 5% is deliberately loose for an unconfigured source. Once a source is known
 * to index everything it walks, set `unindexed_tolerance: 0` on it and the
 * audit flags the first regression instead.
 */
const DEFAULT_UNINDEXED_TOLERANCE = 0.05;

/**
 * Floor on the tolerance budget, so a small source does not alert on one or
 * two legitimately-empty files (on a 20-file source, 5% rounds down to 1).
 * Bypassed entirely when a source sets `unindexed_tolerance: 0`, which is an
 * explicit request to hear about any shortfall at all.
 */
const MIN_UNINDEXED_FILES = 3;

export function resetAuditCache(): void {
  lastAuditFindings.clear();
}

export interface AuditFinding {
  source: string;
  check: "stale_files" | "scope_leak" | "count_divergence";
  count: number;
  samples: string[];
  direction?: "db_has_more" | "db_has_fewer";
}

export async function runReindexAudit(
  sourceNames: string[],
): Promise<AuditFinding[]> {
  try {
    const serverCfg = getServerConfig();
    const cfg = getConfig();
    const findings: AuditFinding[] = [];

    const sourceNameSet = new Set(sourceNames);
    const fileSources = serverCfg.sources.filter(
      (s): s is FileSourceConfig =>
        isFileSourceConfig(s) && sourceNameSet.has(s.name),
    );

    for (const sourceConfig of fileSources) {
      const diskFiles = await walkSourceFiles(
        sourceConfig,
        cfg.cloneDir,
        cfg.githubToken,
      );
      if (diskFiles === null) {
        console.warn(
          `[reindex-audit] Source "${sourceConfig.name}" walk root not found, skipping audit`,
        );
        continue;
      }
      const dbFiles = await getIndexedItemIds(sourceConfig.name);

      // Check 1 — Stale files: in DB but not on disk
      const stale = [...dbFiles].filter((p) => !diskFiles.has(p));
      if (stale.length > 0) {
        findings.push({
          source: sourceConfig.name,
          check: "stale_files",
          count: stale.length,
          samples: stale.slice(0, 10),
        });
      }

      // Check 2 — Scope leaks (git sources only, skip when path is "." or "")
      if (sourceConfig.repo && sourceConfig.path && sourceConfig.path !== ".") {
        const prefix = sourceConfig.path.replace(/\/$/, "") + "/";
        const leaks = [...dbFiles].filter((p) => !p.startsWith(prefix));
        if (leaks.length > 0) {
          findings.push({
            source: sourceConfig.name,
            check: "scope_leak",
            count: leaks.length,
            samples: leaks.slice(0, 10),
          });
        }
      }

      // Check 3 — Count divergence, both directions.
      const dbCount = dbFiles.size;
      const diskCount = diskFiles.size;
      if (dbCount > diskCount) {
        findings.push({
          source: sourceConfig.name,
          check: "count_divergence",
          count: dbCount - diskCount,
          samples: [],
          direction: "db_has_more",
        });
      }

      // Check 3b — Shortfall: files on disk that the index does not hold.
      //
      // Measured on the SET DIFFERENCE rather than on `diskCount - dbCount`.
      // The raw count difference is a lossy proxy: a source holding one stale
      // row and missing one real file has matching counts and would report
      // nothing, which is the same blindness in miniature. The set difference
      // fires in every case the count comparison would, plus that one — and it
      // yields the actual file paths, so the finding names the files instead of
      // saying "the count is off by 130".
      const unindexed = [...diskFiles].filter((p) => !dbFiles.has(p));
      if (unindexed.length > 0) {
        const tolerance =
          sourceConfig.unindexed_tolerance ?? DEFAULT_UNINDEXED_TOLERANCE;
        const budget = Math.max(
          tolerance > 0 ? MIN_UNINDEXED_FILES : 0,
          Math.floor(diskCount * tolerance),
        );
        if (unindexed.length > budget) {
          findings.push({
            source: sourceConfig.name,
            check: "count_divergence",
            count: unindexed.length,
            samples: unindexed.slice(0, 10),
            direction: "db_has_fewer",
          });
        }
      }
    }

    // Always log findings to console
    for (const f of findings) {
      const detail = f.direction ? ` (${f.direction})` : "";
      const samples =
        f.samples.length > 0 ? `: ${f.samples.slice(0, 5).join(", ")}` : "";
      console.warn(
        `[reindex-audit] ${f.source} — ${f.check}: ${f.count} issues${detail}${samples}`,
      );
    }

    // Only Slack-alert on NEW or CHANGED findings (dedup)
    const newFindings = findings.filter((f) => {
      const key = dedupKey(f);
      const prev = lastAuditFindings.get(key);
      return prev === undefined || prev !== f.count;
    });

    // Update the dedup cache with current findings
    // Clear entries for sources we just audited (so resolved issues don't persist)
    for (const name of sourceNames) {
      for (const [key] of lastAuditFindings) {
        if (key.startsWith(`${name}:`)) lastAuditFindings.delete(key);
      }
    }
    for (const f of findings) {
      lastAuditFindings.set(dedupKey(f), f.count);
    }

    if (newFindings.length > 0 && cfg.slackWebhookUrl) {
      await sendSlackAlert(newFindings, cfg.slackWebhookUrl);
    }

    return findings;
  } catch (err) {
    console.error(
      "[reindex-audit] Audit failed:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/** Dedup identity of a finding: source + check + direction. */
function dedupKey(f: AuditFinding): string {
  return `${f.source}:${f.check}${f.direction ? `:${f.direction}` : ""}`;
}

async function sendSlackAlert(
  findings: AuditFinding[],
  webhookUrl: string,
): Promise<void> {
  const lines = findings.map((f) => {
    let msg = `*${f.source}* — ${f.check}: ${f.count} issues`;
    if (f.direction) msg += ` (${f.direction})`;
    if (f.samples.length > 0) {
      msg += `\n  ${f.samples.join("\n  ")}`;
    }
    return msg;
  });
  const text = `🔍 *Reindex Audit Alert*\n${lines.join("\n\n")}`;
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      console.error(
        `[reindex-audit] Slack webhook returned ${response.status}: ${await response.text().catch(() => "(no body)")}`,
      );
    }
  } catch (err) {
    console.error(
      "[reindex-audit] Failed to send Slack alert:",
      err instanceof Error ? err.message : err,
    );
  }
}
