import { getConfig, getServerConfig } from "../config.js";
import { getIndexedItemIds } from "../db/queries.js";
import { walkSourceFiles } from "./utils.js";
import { isFileSourceConfig } from "../types.js";
import type { FileSourceConfig } from "../types.js";

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

      // Check 3 — Count divergence (db_has_more only; db_has_fewer is expected
      // when the indexer filters low-semantic-value files like SVGs, base64, etc.)
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
    }

    if (findings.length > 0) {
      for (const f of findings) {
        const detail = f.direction ? ` (${f.direction})` : "";
        const samples =
          f.samples.length > 0 ? `: ${f.samples.slice(0, 5).join(", ")}` : "";
        console.warn(
          `[reindex-audit] ${f.source} — ${f.check}: ${f.count} issues${detail}${samples}`,
        );
      }
      if (cfg.slackWebhookUrl) {
        await sendSlackAlert(findings, cfg.slackWebhookUrl);
      }
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
