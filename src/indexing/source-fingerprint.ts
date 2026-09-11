// Fingerprint of a source's effective CRAWL configuration.
//
// The orchestrator's acquisition branch used to key only on "are there new
// commits". That silently loses every config-scope change: widening
// `file_patterns`, moving `path`, or changing `url_derivation` leaves the
// commit sha untouched, so the incremental path diffs HEAD against itself,
// walks nothing, writes zero rows — and reports success. Persisting this
// fingerprint alongside `last_commit_sha` lets the orchestrator notice that
// the *question* changed even when the *answer's inputs* (the commits) did
// not, and take a full walk.
//
// Scope: the fields folded in here are exactly those that determine WHICH
// items get enumerated and HOW their paths/URLs are derived. Fields that only
// affect how already-enumerated content is rendered downstream — `chunk`
// sizing, `version`, `category`, `distiller_model` — are deliberately
// EXCLUDED: changing them does not make a previously-invisible item visible,
// so they must not force a full re-walk of every source.

import { createHash } from "node:crypto";

import type { SourceConfig } from "../types.js";

/**
 * Bump when the *definition* of the fingerprint changes (a field is added to
 * or removed from the covered set). A bump makes every stored fingerprint
 * mismatch, which costs one full walk per source — the same cost as the
 * NULL-fingerprint path, and for the same reason: we can no longer prove the
 * stored value answers the current question.
 */
const FINGERPRINT_VERSION = 1;

/**
 * Order-insensitive normalization for fields that are semantically a SET, so
 * cosmetic reordering in the YAML does not force a needless full walk.
 */
function asSet(values: readonly string[] | undefined): string[] | undefined {
  return values === undefined ? undefined : [...values].sort();
}

/**
 * Fields covered per source type. Everything listed changes enumeration or
 * path/URL output.
 */
function fingerprintPayload(config: SourceConfig): Record<string, unknown> {
  switch (config.type) {
    case "markdown":
    case "code":
    case "raw-text":
    case "html":
    case "document":
      return {
        type: config.type,
        repo: config.repo ?? null,
        branch: config.branch ?? null,
        path: config.path,
        base_url: config.base_url ?? null,
        // url_derivation.strip_prefix may be a LIST, and that list is ORDERED
        // — the first candidate that matches is the one stripped — so it is
        // NOT sorted. Reordering it genuinely changes the derived URLs.
        url_derivation: config.url_derivation
          ? {
              strip_prefix: config.url_derivation.strip_prefix ?? null,
              strip_suffix: config.url_derivation.strip_suffix ?? null,
              strip_route_groups:
                config.url_derivation.strip_route_groups ?? null,
              strip_index: config.url_derivation.strip_index ?? null,
            }
          : null,
        file_patterns: asSet(config.file_patterns),
        exclude_patterns: asSet(config.exclude_patterns) ?? null,
        skip_dirs: asSet(config.skip_dirs) ?? null,
        max_file_size: config.max_file_size ?? null,
      };
    case "slack":
      return {
        type: config.type,
        channels: asSet(config.channels),
        trigger_emoji: config.trigger_emoji,
        min_thread_replies: config.min_thread_replies,
        confidence_threshold: config.confidence_threshold,
      };
    case "discord":
      return {
        type: config.type,
        guild_id: config.guild_id,
        channels: [...config.channels].map((c) => `${c.id}:${c.type}`).sort(),
        min_thread_replies: config.min_thread_replies,
        confidence_threshold: config.confidence_threshold,
      };
    case "notion":
      return {
        type: config.type,
        root_pages: asSet(config.root_pages),
        databases: asSet(config.databases),
        max_depth: config.max_depth,
        include_properties: config.include_properties,
      };
    case "atlas":
      return {
        type: config.type,
        seed_path: config.seed_path ?? null,
        cache_namespace: config.cache_namespace ?? null,
        repositories: (config.repositories ?? [])
          .map((r) =>
            JSON.stringify({
              repo_url: r.repo_url,
              refs: asSet(r.refs) ?? null,
              subsystems: asSet(r.subsystems) ?? null,
            }),
          )
          .sort(),
      };
  }
}

/**
 * Deterministic JSON: object keys sorted at EVERY depth, arrays left in order.
 *
 * Not `JSON.stringify(value, sortedKeys)` — passing a key array as the
 * replacer filters keys at every level against that ONE list, which silently
 * drops nested objects' contents (url_derivation would serialize as `{}`,
 * making a strip_prefix change invisible to the fingerprint).
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Stable hex fingerprint of a source's effective crawl configuration.
 *
 * Stable across process restarts and across cosmetic reordering of set-valued
 * fields; changes whenever a covered field changes.
 */
export function computeSourceConfigFingerprint(config: SourceConfig): string {
  const canonical = canonicalJson(fingerprintPayload(config));
  return createHash("sha256")
    .update(`v${FINGERPRINT_VERSION}:${canonical}`)
    .digest("hex")
    .slice(0, 32);
}

/** Why the orchestrator chose full vs incremental acquisition. */
export type AcquisitionReason =
  | "no-prior-state"
  | "no-stored-config-fingerprint"
  | "config-changed"
  | "config-unchanged";

export interface AcquisitionDecision {
  mode: "full" | "incremental";
  reason: AcquisitionReason;
}

/**
 * Decide how to acquire, given the persisted state and the current config
 * fingerprint.
 *
 * A NULL/missing stored fingerprint means "unknown" — we cannot prove the
 * indexed content matches the current config, so we take ONE full walk and
 * persist the fingerprint. It is a one-time cost per source on the first run
 * after this ships, not a per-boot cost: the fingerprint is written on
 * success, so the next run compares equal and goes incremental.
 */
export function decideAcquisition(
  storedSha: string | null | undefined,
  storedFingerprint: string | null | undefined,
  currentFingerprint: string,
): AcquisitionDecision {
  if (!storedSha) return { mode: "full", reason: "no-prior-state" };
  if (!storedFingerprint)
    return { mode: "full", reason: "no-stored-config-fingerprint" };
  if (storedFingerprint !== currentFingerprint)
    return { mode: "full", reason: "config-changed" };
  return { mode: "incremental", reason: "config-unchanged" };
}
