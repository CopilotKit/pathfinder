// GitHub webhook handler for push-event-driven incremental re-indexing.
// Fully config-driven: uses webhook.repo_sources and webhook.path_triggers
// from pathfinder.yaml to determine which pushes trigger reindexing.

import crypto from "node:crypto";
import type { Request, Response } from "express";
import { getConfig, getServerConfig } from "../config.js";

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

/**
 * Minimal interface for the orchestrator dependency.  The full
 * IndexingOrchestrator lives in ../indexing/orchestrator.ts — we only
 * depend on the subset we actually call so the webhook handler can function
 * independently.
 */
export interface ReindexOrchestrator {
  queueIncrementalReindex(repoUrl: string): void;
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

  // Both strings must be the same length for timingSafeEqual
  if (signatureHeader.length !== expected.length) return false;

  return crypto.timingSafeEqual(
    Buffer.from(signatureHeader, "utf-8"),
    Buffer.from(expected, "utf-8"),
  );
}

// ---------------------------------------------------------------------------
// Push-event helpers
// ---------------------------------------------------------------------------

function isDefaultBranchPush(payload: PushPayload): boolean {
  const branch = payload.ref.replace("refs/heads/", "");
  return branch === payload.repository.default_branch;
}

/**
 * Check if any committed files match any of the given path prefixes.
 * An empty prefixes array means "match everything" (no path filtering).
 */
function touchesPaths(payload: PushPayload, prefixes: string[]): boolean {
  if (prefixes.length === 0) return true;

  for (const commit of payload.commits) {
    const allPaths = [...commit.added, ...commit.modified, ...commit.removed];
    if (allPaths.some((p) => prefixes.some((prefix) => p.startsWith(prefix)))) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Factory: create a handler wired to a specific orchestrator instance
// ---------------------------------------------------------------------------

export function createWebhookHandler(orchestrator: ReindexOrchestrator) {
  return async function handleGithubWebhook(
    req: Request,
    res: Response,
  ): Promise<void> {
    const cfg = getConfig();

    // -- Signature verification ----------------------------------------
    // The route MUST be configured with express.raw() so req.body is a
    // Buffer.  If it isn't, bail out — we cannot safely verify the HMAC.
    const rawBody = Buffer.isBuffer(req.body) ? req.body : null;
    if (!rawBody) {
      console.error(
        "[webhook] req.body is not a Buffer — ensure the route uses express.raw()",
      );
      res
        .status(500)
        .json({ error: "Server misconfiguration: raw body not available" });
      return;
    }

    if (!cfg.githubWebhookSecret?.trim()) {
      console.log(
        "[webhook] Rejecting request — webhook secret not configured",
      );
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const signature = req.headers["x-hub-signature-256"] as string | undefined;
    if (!verifySignature(rawBody, signature, cfg.githubWebhookSecret)) {
      res.status(401).json({ error: "Invalid or missing webhook signature" });
      return;
    }

    // -- Event routing -------------------------------------------------
    const event = req.headers["x-github-event"] as string | undefined;
    if (event !== "push") {
      res.status(200).json({ ignored: true, reason: "not a push event" });
      return;
    }

    // -- Parse payload -------------------------------------------------
    let payload: PushPayload;
    try {
      payload = JSON.parse(rawBody.toString("utf-8")) as PushPayload;
    } catch {
      res.status(400).json({ error: "Malformed JSON payload" });
      return;
    }

    if (!isDefaultBranchPush(payload)) {
      res.status(200).json({ ignored: true, reason: "not the default branch" });
      return;
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
      res
        .status(200)
        .json({ ignored: true, reason: "repo not in webhook config" });
      return;
    }

    // Check path triggers for each source. If any source's triggers match
    // (or it has no triggers, meaning "match all"), queue a reindex.
    let shouldReindex = false;
    for (const sourceName of sourceNames) {
      const triggers = webhookCfg?.path_triggers?.[sourceName] ?? [];
      if (touchesPaths(payload, triggers)) {
        shouldReindex = true;
        break; // one reindex covers all sources from the same repo
      }
    }

    if (!shouldReindex) {
      console.log(
        `[webhook] Push to ${repoFullName} at ${sha.slice(0, 8)} — ` +
          `no path triggers matched, ignoring`,
      );
      res
        .status(200)
        .json({ ignored: true, reason: "no path triggers matched" });
      return;
    }

    console.log(
      `[webhook] Push to ${repoFullName} ` +
        `(${payload.repository.default_branch}) at ${sha.slice(0, 8)} — queuing reindex`,
    );

    orchestrator.queueIncrementalReindex(repoUrl);
    res.status(200).json({ queued: true });
  };
}
