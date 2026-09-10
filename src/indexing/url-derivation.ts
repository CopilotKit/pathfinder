// Configurable URL derivation from file paths based on source config.

import type { FileSourceConfig } from "../types.js";

/**
 * Derive a public URL from a relative file path using the source's URL derivation rules.
 * Returns null if the source has no base_url or url_derivation configured.
 */
export function deriveUrl(
  filePath: string,
  sourceConfig: FileSourceConfig,
): string | null {
  if (!sourceConfig.base_url || !sourceConfig.url_derivation) return null;

  const d = sourceConfig.url_derivation;
  let slug = filePath;

  if (d.strip_prefix) {
    // Ordered candidates: the first prefix that matches wins, so a more
    // specific prefix must be listed before a shorter one that also
    // matches. A plain string behaves exactly as a one-element list.
    const prefixes =
      typeof d.strip_prefix === "string" ? [d.strip_prefix] : d.strip_prefix;
    for (const prefix of prefixes) {
      if (slug.startsWith(prefix)) {
        slug = slug.slice(prefix.length);
        break;
      }
    }
  }
  if (d.strip_suffix) {
    const re = new RegExp(escapeRegex(d.strip_suffix) + "$");
    slug = slug.replace(re, "");
  }
  if (d.strip_route_groups) {
    slug = slug.replace(/\([^)]+\)\//g, "");
  }
  if (d.strip_index) {
    slug = slug.replace(/\/index$/, "");
    if (slug === "index") slug = "";
  }

  return sourceConfig.base_url + slug;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
