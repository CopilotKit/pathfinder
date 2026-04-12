// Config + connectivity validation for the pathfinder validate CLI command.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getConfig, getServerConfig } from "./config.js";
import {
  isFileSourceConfig,
  isSlackSourceConfig,
  isDiscordSourceConfig,
  isNotionSourceConfig,
} from "./types.js";
import type { SourceConfig } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ValidationResult {
  configValid: boolean;
  envVars: Array<{ name: string; present: boolean; required: boolean }>;
  sources: Array<{
    name: string;
    type: string;
    valid: boolean;
    details: string;
    channels?: Array<{
      id: string;
      name?: string;
      valid: boolean;
      detail: string;
    }>;
  }>;
  tools: Array<{ name: string; valid: boolean; detail: string }>;
  errors: string[];
}

// ── Validation ──────────────────────────────────────────────────────────────

export async function validateConfig(
  configPath?: string,
): Promise<ValidationResult> {
  const result: ValidationResult = {
    configValid: false,
    envVars: [],
    sources: [],
    tools: [],
    errors: [],
  };

  // Step 1: Config schema validation
  let serverCfg;
  try {
    if (configPath) {
      process.env.PATHFINDER_CONFIG = configPath;
    }
    serverCfg = getServerConfig();
    result.configValid = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`Config validation failed: ${msg}`);
    return result;
  }

  const cfg = getConfig();

  // Step 2: Environment variable checks
  const hasDiscordSource = serverCfg.sources.some((s) => s.type === "discord");
  const hasSlackSource = serverCfg.sources.some((s) => s.type === "slack");
  const hasDiscordTextChannels = serverCfg.sources.some(
    (s) =>
      isDiscordSourceConfig(s) && s.channels.some((c) => c.type === "text"),
  );
  const hasNotionSource = serverCfg.sources.some((s) => s.type === "notion");
  const needsRag = serverCfg.tools.some(
    (t) => t.type === "search" || t.type === "knowledge",
  );

  const envChecks = [
    { name: "DATABASE_URL", present: !!cfg.databaseUrl, required: needsRag },
    {
      name: "OPENAI_API_KEY",
      present: !!cfg.openaiApiKey,
      required: needsRag || hasSlackSource || hasDiscordTextChannels,
    },
    {
      name: "SLACK_BOT_TOKEN",
      present: !!cfg.slackBotToken,
      required: hasSlackSource,
    },
    {
      name: "DISCORD_BOT_TOKEN",
      present: !!cfg.discordBotToken,
      required: hasDiscordSource,
    },
    {
      name: "DISCORD_PUBLIC_KEY",
      present: !!cfg.discordPublicKey,
      required: hasDiscordSource,
    },
    {
      name: "NOTION_TOKEN",
      present: !!cfg.notionToken,
      required: hasNotionSource,
    },
  ];
  result.envVars = envChecks;

  for (const check of envChecks) {
    if (check.required && !check.present) {
      result.errors.push(
        `Missing required environment variable: ${check.name}`,
      );
    }
  }

  // Step 3: Source connectivity probes
  for (const source of serverCfg.sources) {
    try {
      const sourceResult = await validateSource(source);
      result.sources.push(sourceResult);
      if (!sourceResult.valid) {
        result.errors.push(
          `Source "${source.name}" validation failed: ${sourceResult.details}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.sources.push({
        name: source.name,
        type: source.type,
        valid: false,
        details: `Validation error: ${msg}`,
      });
      result.errors.push(`Source "${source.name}" validation error: ${msg}`);
    }
  }

  // Step 4: Tool cross-validation
  const sourceNames = new Set(serverCfg.sources.map((s) => s.name));

  for (const tool of serverCfg.tools) {
    if (tool.type === "search") {
      const valid = sourceNames.has(tool.source);
      result.tools.push({
        name: tool.name,
        valid,
        detail: valid
          ? `→ ${tool.source}`
          : `Source "${tool.source}" not found`,
      });
      if (!valid)
        result.errors.push(
          `Tool "${tool.name}" references missing source "${tool.source}"`,
        );
    } else if (tool.type === "knowledge") {
      const allValid = tool.sources.every((s) => sourceNames.has(s));
      result.tools.push({
        name: tool.name,
        valid: allValid,
        detail: `→ [${tool.sources.join(", ")}]`,
      });
      if (!allValid) {
        const missing = tool.sources.filter((s) => !sourceNames.has(s));
        result.errors.push(
          `Tool "${tool.name}" references missing sources: ${missing.join(", ")}`,
        );
      }
    } else if (tool.type === "bash") {
      const allValid = tool.sources.every((s) => sourceNames.has(s));
      result.tools.push({
        name: tool.name,
        valid: allValid,
        detail: `→ [${tool.sources.join(", ")}]`,
      });
      if (!allValid) {
        const missing = tool.sources.filter((s) => !sourceNames.has(s));
        result.errors.push(
          `Tool "${tool.name}" references missing sources: ${missing.join(", ")}`,
        );
      }
    } else {
      result.tools.push({
        name: tool.name,
        valid: true,
        detail: `type: ${tool.type}`,
      });
    }
  }

  return result;
}

// ── Source validators ──────────────────────────────────────────────────────────

async function validateSource(
  source: SourceConfig,
): Promise<ValidationResult["sources"][0]> {
  if (isFileSourceConfig(source)) {
    return validateFileSource(source);
  }
  if (isSlackSourceConfig(source)) {
    return {
      name: source.name,
      type: "slack",
      valid: true,
      details:
        "Slack validation requires live API probe — skipped in offline mode",
    };
  }
  if (isDiscordSourceConfig(source)) {
    return {
      name: source.name,
      type: "discord",
      valid: true,
      details:
        "Discord validation requires live API probe — skipped in offline mode",
    };
  }
  if (isNotionSourceConfig(source)) {
    return {
      name: source.name,
      type: "notion",
      valid: true,
      details:
        "Notion validation requires live API probe — skipped in offline mode",
    };
  }
  // Exhaustive fallback — should not be reachable with current discriminated union
  const s = source as SourceConfig;
  return {
    name: s.name,
    type: (s as { type: string }).type,
    valid: true,
    details: "Unknown source type",
  };
}

function validateFileSource(
  source: SourceConfig & { path: string; repo?: string },
): ValidationResult["sources"][0] {
  if (source.repo) {
    // Remote repo — would need git ls-remote, skip for basic validation
    return {
      name: source.name,
      type: source.type,
      valid: true,
      details: `Remote repo: ${source.repo}`,
    };
  }

  const resolved = resolve(source.path);
  const exists = existsSync(resolved);
  return {
    name: source.name,
    type: source.type,
    valid: exists,
    details: exists
      ? `Path: ${resolved} — exists`
      : `Path: ${resolved} — not found`,
  };
}

// ── Output formatting ──────────────────────────────────────────────────────────

export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = [];

  lines.push("Pathfinder Config Validation");
  lines.push("============================");
  lines.push("");

  if (result.configValid) {
    lines.push(`Config: valid`);
  } else {
    lines.push(`Config: INVALID`);
  }
  lines.push("");

  lines.push("Environment Variables:");
  for (const env of result.envVars) {
    if (!env.required) continue;
    const status = env.present ? "OK" : "MISSING";
    lines.push(`  ${env.name} ${status}`);
  }
  lines.push("");

  lines.push("Sources:");
  for (const source of result.sources) {
    const status = source.valid ? "OK" : "FAILED";
    lines.push(`  ${source.name} (${source.type}) ${status}`);
    lines.push(`    ${source.details}`);
    if (source.channels) {
      for (const ch of source.channels) {
        const chStatus = ch.valid ? "OK" : "FAILED";
        lines.push(`    ${ch.id} ${chStatus} ${ch.detail}`);
      }
    }
  }
  lines.push("");

  lines.push("Tools:");
  for (const tool of result.tools) {
    const status = tool.valid ? "OK" : "FAILED";
    lines.push(`  ${tool.name} ${status} ${tool.detail}`);
  }
  lines.push("");

  const errorCount = result.errors.length;
  if (errorCount === 0) {
    lines.push(`Result: All validations passed.`);
  } else {
    lines.push(`Result: ${errorCount} error(s) found.`);
    for (const err of result.errors) {
      lines.push(`  - ${err}`);
    }
  }

  return lines.join("\n");
}
