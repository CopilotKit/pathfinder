// GitHub webhook handler for push-event-driven incremental re-indexing.
// Fully config-driven: uses webhook.repo_sources and webhook.path_triggers
// from pathfinder.yaml to determine which pushes trigger reindexing.

import crypto from "node:crypto";
import type { Request, Response } from "express";
import { getConfig, getServerConfig } from "../config.js";
import { upsertAtlasSeedCandidate } from "../db/atlas.js";
import { recordWebhookDelivery } from "../db/queries.js";
import { isAtlasSourceConfig } from "../types.js";
import {
  extractAtlasPullRequestSeedCandidates,
  type AtlasPullRequestPayload,
} from "./atlas.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PushCommit {
  added: string[];
  modified: string[];
  removed: string[];
}

interface PushPayload {
  ref: string;
  after: string;
  before: string;
  repository: {
    clone_url: string;
    default_branch: string;
    full_name: string;
  };
  commits: PushCommit[];
}

export interface GitHubWebhookResult {
  queuedReindex: boolean;
  affectedSourceNames: string[];
}

const NO_REINDEX: GitHubWebhookResult = {
  queuedReindex: false,
  affectedSourceNames: [],
};

type HeaderValue = string | string[] | undefined;

type NormalizedHeader =
  | { ok: true; value: string | undefined }
  | { ok: false; reason: string };

type DuplicateHeader = Extract<NormalizedHeader, { ok: false }>;

/**
 * Minimal interface for the orchestrator dependency.  The full
 * IndexingOrchestrator lives in ../indexing/orchestrator.ts — we only
 * depend on the subset we actually call so the webhook handler can function
 * independently.
 */
export interface ReindexOrchestrator {
  queueIncrementalReindex(repoUrl: string): void;
  queueSourceReindex(sourceName: string): void;
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

function verifySignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  const signatureBuffer = Buffer.from(signatureHeader, "utf-8");
  const expectedBuffer = Buffer.from(expected, "utf-8");

  // timingSafeEqual requires equal byte lengths, not equal JS string lengths.
  if (signatureBuffer.length !== expectedBuffer.length) return false;

  return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
}

function normalizeSingleHeader(
  value: HeaderValue,
  headerName: string,
  rawHeaders: readonly string[] | undefined,
): NormalizedHeader {
  if (Array.isArray(value)) {
    return {
      ok: false,
      reason: `duplicate ${headerName} header`,
    };
  }
  if (countRawHeaders(rawHeaders, headerName) > 1) {
    return {
      ok: false,
      reason: `duplicate ${headerName} header`,
    };
  }
  return { ok: true, value };
}

function countRawHeaders(
  rawHeaders: readonly string[] | undefined,
  headerName: string,
): number {
  if (!Array.isArray(rawHeaders)) return 0;

  let count = 0;
  const normalizedHeaderName = headerName.toLowerCase();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() === normalizedHeaderName) {
      count += 1;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Push-event helpers
// ---------------------------------------------------------------------------

function isDefaultBranchPush(payload: PushPayload): boolean {
  const branch = payload.ref.replace("refs/heads/", "");
  return branch === payload.repository.default_branch;
}

function normalizePathTrigger(trigger: string): string {
  return trigger.replace(/^\.?\//, "").replace(/\/+$/, "");
}

function matchesPathTrigger(filePath: string, trigger: string): boolean {
  const normalizedTrigger = normalizePathTrigger(trigger);
  if (normalizedTrigger.length === 0) return true;

  const normalizedPath = filePath.replace(/^\.?\//, "");
  return (
    normalizedPath === normalizedTrigger ||
    normalizedPath.startsWith(`${normalizedTrigger}/`)
  );
}

/**
 * Check if any committed files match any of the given path prefixes.
 * An empty prefixes array means "match everything" (no path filtering).
 */
function touchesPaths(payload: PushPayload, prefixes: string[]): boolean {
  if (prefixes.length === 0) return true;

  for (const commit of payload.commits) {
    const allPaths = [...commit.added, ...commit.modified, ...commit.removed];
    if (
      allPaths.some((p) =>
        prefixes.some((prefix) => matchesPathTrigger(p, prefix)),
      )
    ) {
      return true;
    }
  }
  return false;
}

function hasPathTriggers(
  pathTriggers: Record<string, string[]> | undefined,
  sourceName: string,
): boolean {
  return (pathTriggers?.[sourceName] ?? []).length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPushCommit(value: unknown): value is PushCommit {
  if (typeof value !== "object" || value == null) return false;
  const commit = value as Record<string, unknown>;
  return (
    isStringArray(commit.added) &&
    isStringArray(commit.modified) &&
    isStringArray(commit.removed)
  );
}

function isPushPayload(value: unknown): value is PushPayload {
  if (typeof value !== "object" || value == null) return false;
  const payload = value as Record<string, unknown>;
  const repository = payload.repository;
  if (typeof repository !== "object" || repository == null) return false;
  const repo = repository as Record<string, unknown>;
  return (
    typeof payload.ref === "string" &&
    typeof payload.after === "string" &&
    typeof payload.before === "string" &&
    typeof repo.clone_url === "string" &&
    typeof repo.default_branch === "string" &&
    typeof repo.full_name === "string" &&
    Array.isArray(payload.commits) &&
    payload.commits.every(isPushCommit)
  );
}

function recordPullRequestDelivery(
  delivery: Parameters<typeof recordWebhookDelivery>[0],
): void {
  // Delivery tracking is non-blocking audit telemetry; webhook correctness
  // depends on signature validation and seed writes, not analytics persistence.
  recordWebhookDelivery(delivery).catch(() => {});
}

// ---------------------------------------------------------------------------
// Factory: create a handler wired to a specific orchestrator instance
// ---------------------------------------------------------------------------

export function createWebhookHandler(orchestrator: ReindexOrchestrator) {
  return async function handleGithubWebhook(
    req: Request,
    res: Response,
  ): Promise<GitHubWebhookResult> {
    const cfg = getConfig();

    // -- Signature verification ----------------------------------------
    // The route MUST be configured with express.raw() so req.body is a
    // Buffer.  If it isn't, bail out — we cannot safely verify the HMAC.
    const rawBody = Buffer.isBuffer(req.body) ? req.body : null;
    const payloadSize = rawBody?.length;
    if (!rawBody) {
      console.error(
        "[webhook] req.body is not a Buffer — ensure the route uses express.raw()",
      );
      recordWebhookDelivery({
        source: "github",
        decision: "error",
        reason: "req.body not a Buffer",
        payload_size: payloadSize,
      }).catch(() => {});
      res
        .status(500)
        .json({ error: "Server misconfiguration: raw body not available" });
      return NO_REINDEX;
    }

    if (!cfg.githubWebhookSecret?.trim()) {
      console.log(
        "[webhook] Rejecting request — webhook secret not configured",
      );
      recordWebhookDelivery({
        source: "github",
        decision: "error",
        reason: "webhook secret not configured",
        payload_size: payloadSize,
      }).catch(() => {});
      res.status(403).json({ error: "Forbidden" });
      return NO_REINDEX;
    }

    const signatureHeader = normalizeSingleHeader(
      req.headers["x-hub-signature-256"],
      "x-hub-signature-256",
      req.rawHeaders,
    );
    const eventHeader = normalizeSingleHeader(
      req.headers["x-github-event"],
      "x-github-event",
      req.rawHeaders,
    );
    const deliveryHeader = normalizeSingleHeader(
      req.headers["x-github-delivery"],
      "x-github-delivery",
      req.rawHeaders,
    );

    const duplicateHeader = [
      signatureHeader,
      eventHeader,
      deliveryHeader,
    ].find((header): header is DuplicateHeader => !header.ok);
    if (duplicateHeader) {
      recordWebhookDelivery({
        source: "github",
        decision: "error",
        reason: duplicateHeader.reason,
        payload_size: payloadSize,
      }).catch(() => {});
      res.status(400).json({
        error: "Duplicate GitHub webhook header",
        header: duplicateHeader.reason
          .replace(/^duplicate /, "")
          .replace(/ header$/, ""),
      });
      return NO_REINDEX;
    }

    const signature = signatureHeader.ok ? signatureHeader.value : undefined;
    if (!verifySignature(rawBody, signature, cfg.githubWebhookSecret)) {
      recordWebhookDelivery({
        source: "github",
        decision: "error",
        reason: "invalid signature",
        payload_size: payloadSize,
      }).catch(() => {});
      res.status(401).json({ error: "Invalid or missing webhook signature" });
      return NO_REINDEX;
    }

    // -- Event routing -------------------------------------------------
    const event = eventHeader.ok ? eventHeader.value : undefined;
    if (event === "pull_request") {
      let payload: AtlasPullRequestPayload;
      try {
        payload = JSON.parse(
          rawBody.toString("utf-8"),
        ) as AtlasPullRequestPayload;
      } catch {
        recordPullRequestDelivery({
          source: "github",
          event_type: "pull_request",
          decision: "error",
          reason: "malformed JSON",
          payload_size: payloadSize,
        });
        res.status(400).json({ error: "Malformed JSON payload" });
        return NO_REINDEX;
      }

      const repoFullName = payload.repository?.full_name;
      if (typeof repoFullName !== "string" || repoFullName.length === 0) {
        recordPullRequestDelivery({
          source: "github",
          event_type: "pull_request",
          decision: "error",
          reason: "missing repository.full_name",
          payload_size: payloadSize,
        });
        res.status(400).json({ error: "Malformed Atlas pull_request payload" });
        return NO_REINDEX;
      }

      const serverCfg = getServerConfig();
      const webhookCfg = serverCfg.webhook;
      const sourceNames = webhookCfg?.repo_sources?.[repoFullName] ?? [];
      if (sourceNames.length === 0) {
        recordPullRequestDelivery({
          source: "github",
          event_type: "pull_request",
          repo: repoFullName,
          decision: "ignored",
          reason: "repo not in webhook config",
          payload_size: payloadSize,
        });
        res
          .status(200)
          .json({ ignored: true, reason: "repo not in webhook config" });
        return NO_REINDEX;
      }

      const configuredSourceNames = new Set(sourceNames);
      const atlasSources = serverCfg.sources
        .filter(isAtlasSourceConfig)
        .filter((source) => configuredSourceNames.has(source.name));

      if (atlasSources.length === 0) {
        recordPullRequestDelivery({
          source: "github",
          event_type: "pull_request",
          repo: repoFullName,
          decision: "ignored",
          reason: "repo has no atlas sources",
          payload_size: payloadSize,
        });
        res
          .status(200)
          .json({ ignored: true, reason: "repo has no atlas sources" });
        return NO_REINDEX;
      }

      let extraction;
      try {
        extraction = extractAtlasPullRequestSeedCandidates(
          payload,
          atlasSources,
          deliveryHeader.ok ? deliveryHeader.value : undefined,
        );
      } catch (error) {
        recordPullRequestDelivery({
          source: "github",
          event_type: "pull_request",
          repo: repoFullName,
          decision: "error",
          reason:
            error instanceof Error
              ? `malformed Atlas pull_request payload: ${error.message}`
              : "malformed Atlas pull_request payload",
          payload_size: payloadSize,
        });
        res.status(400).json({ error: "Malformed Atlas pull_request payload" });
        return NO_REINDEX;
      }

      if (!extraction.isMergedPullRequest) {
        recordPullRequestDelivery({
          source: "github",
          event_type: "pull_request",
          repo: repoFullName,
          decision: "ignored",
          reason: "not a merged pull request",
          payload_size: payloadSize,
        });
        res
          .status(200)
          .json({ ignored: true, reason: "not a merged pull request" });
        return NO_REINDEX;
      }

      if (extraction.baseBranch !== extraction.defaultBranch) {
        recordPullRequestDelivery({
          source: "github",
          event_type: "pull_request",
          repo: repoFullName,
          decision: "ignored",
          reason: "not the default branch",
          payload_size: payloadSize,
        });
        res
          .status(200)
          .json({ ignored: true, reason: "not the default branch" });
        return NO_REINDEX;
      }

      for (const candidate of extraction.candidates) {
        await upsertAtlasSeedCandidate(candidate);
      }

      recordPullRequestDelivery({
        source: "github",
        event_type: "pull_request",
        repo: repoFullName,
        decision: "queued",
        payload_size: payloadSize,
      });
      res.status(200).json({
        queued: true,
        atlas_seed_candidates: extraction.candidates.length,
      });
      return NO_REINDEX;
    }

    if (event !== "push") {
      recordWebhookDelivery({
        source: "github",
        event_type: event ?? "unknown",
        decision: "ignored",
        reason: "not a push event",
        payload_size: payloadSize,
      }).catch(() => {});
      res.status(200).json({ ignored: true, reason: "not a push event" });
      return NO_REINDEX;
    }

    // -- Parse payload -------------------------------------------------
    let payload: PushPayload;
    try {
      payload = JSON.parse(rawBody.toString("utf-8")) as PushPayload;
    } catch {
      recordWebhookDelivery({
        source: "github",
        event_type: "push",
        decision: "error",
        reason: "malformed JSON",
        payload_size: payloadSize,
      }).catch(() => {});
      res.status(400).json({ error: "Malformed JSON payload" });
      return NO_REINDEX;
    }

    if (!isPushPayload(payload)) {
      recordWebhookDelivery({
        source: "github",
        event_type: "push",
        decision: "error",
        reason: "malformed push payload",
        payload_size: payloadSize,
      }).catch(() => {});
      res.status(400).json({ error: "Malformed push payload" });
      return NO_REINDEX;
    }

    if (!isDefaultBranchPush(payload)) {
      recordWebhookDelivery({
        source: "github",
        event_type: "push",
        repo: payload.repository.full_name,
        decision: "ignored",
        reason: "not the default branch",
        payload_size: payloadSize,
      }).catch(() => {});
      res.status(200).json({ ignored: true, reason: "not the default branch" });
      return NO_REINDEX;
    }

    const repoFullName = payload.repository.full_name;
    const repoUrl = payload.repository.clone_url;
    const sha = payload.after;

    // -- Config-driven dispatch ----------------------------------------
    const webhookCfg = getServerConfig().webhook;
    const sourceNames = webhookCfg?.repo_sources?.[repoFullName] ?? [];

    if (sourceNames.length === 0) {
      console.log(
        `[webhook] Push to ${repoFullName} at ${sha.slice(0, 8)} — repo not in webhook config, ignoring`,
      );
      recordWebhookDelivery({
        source: "github",
        event_type: "push",
        repo: repoFullName,
        decision: "ignored",
        reason: "repo not in webhook config",
        payload_size: payloadSize,
      }).catch(() => {});
      res
        .status(200)
        .json({ ignored: true, reason: "repo not in webhook config" });
      return NO_REINDEX;
    }

    // Check path triggers for each source. If any source's triggers match
    // (or it has no triggers, meaning "match all"), queue a reindex.
    const affectedSourceNames: string[] = [];
    for (const sourceName of sourceNames) {
      const triggers = webhookCfg?.path_triggers?.[sourceName] ?? [];
      if (touchesPaths(payload, triggers)) {
        affectedSourceNames.push(sourceName);
      }
    }

    if (affectedSourceNames.length === 0) {
      console.log(
        `[webhook] Push to ${repoFullName} at ${sha.slice(0, 8)} — ` +
          `no path triggers matched, ignoring`,
      );
      recordWebhookDelivery({
        source: "github",
        event_type: "push",
        repo: repoFullName,
        decision: "ignored",
        reason: "no path triggers matched",
        payload_size: payloadSize,
      }).catch(() => {});
      res
        .status(200)
        .json({ ignored: true, reason: "no path triggers matched" });
      return NO_REINDEX;
    }

    console.log(
      `[webhook] Push to ${repoFullName} ` +
        `(${payload.repository.default_branch}) at ${sha.slice(0, 8)} — queuing reindex`,
    );

    recordWebhookDelivery({
      source: "github",
      event_type: "push",
      repo: repoFullName,
      decision: "queued",
      payload_size: payloadSize,
    }).catch(() => {});
    const shouldReindexWholeRepo =
      affectedSourceNames.length === sourceNames.length ||
      affectedSourceNames.some(
        (sourceName) => !hasPathTriggers(webhookCfg?.path_triggers, sourceName),
      );
    if (shouldReindexWholeRepo) {
      orchestrator.queueIncrementalReindex(repoUrl);
    } else {
      for (const sourceName of affectedSourceNames) {
        orchestrator.queueSourceReindex(sourceName);
      }
    }
    res.status(200).json({ queued: true });
    return {
      queuedReindex: true,
      affectedSourceNames,
    };
  };
}
