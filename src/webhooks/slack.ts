// Slack Events API webhook handler for emoji-triggered reindexing.
// Handles URL verification challenges and reaction_added events.

import crypto from "node:crypto";
import type { Request, Response } from "express";
import { getConfig, getServerConfig } from "../config.js";
import { isSlackSourceConfig } from "../types.js";
import { recordWebhookDelivery } from "../db/queries.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface SlackEvent {
  type: string;
  [key: string]: unknown;
}

interface SlackEventPayload {
  type: string; // 'url_verification' | 'event_callback'
  token?: string;
  challenge?: string; // for url_verification
  event?: SlackEvent;
}

interface ReactionAddedEvent extends SlackEvent {
  type: "reaction_added";
  reaction: string;
  item: {
    type: string;
    channel: string;
    ts: string;
  };
}

/**
 * Minimal interface for the orchestrator dependency.
 */
export interface SlackReindexOrchestrator {
  queueSourceReindex(sourceName: string): void;
}

// ── Signature verification ───────────────────────────────────────────────────

export function verifySlackSignature(
  rawBody: Buffer,
  timestamp: string | undefined,
  signature: string | undefined,
  signingSecret: string,
): boolean {
  if (!timestamp || !signature) return false;

  // Reject requests older than 5 minutes (replay protection)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;

  const sigBasestring = `v0:${timestamp}:${rawBody.toString("utf-8")}`;
  const expected =
    "v0=" +
    crypto
      .createHmac("sha256", signingSecret)
      .update(sigBasestring)
      .digest("hex");

  if (signature.length !== expected.length) return false;

  return crypto.timingSafeEqual(
    Buffer.from(signature, "utf-8"),
    Buffer.from(expected, "utf-8"),
  );
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a Slack webhook handler wired to a specific orchestrator instance.
 */
export function createSlackWebhookHandler(
  orchestrator: SlackReindexOrchestrator,
) {
  return async function handleSlackWebhook(
    req: Request,
    res: Response,
  ): Promise<void> {
    const cfg = getConfig();

    // -- Raw body check ------------------------------------------------
    const rawBody = Buffer.isBuffer(req.body) ? req.body : null;
    const payloadSize = rawBody?.length;
    if (!rawBody) {
      console.error(
        "[slack-webhook] req.body is not a Buffer — ensure the route uses express.raw()",
      );
      recordWebhookDelivery({
        source: "slack",
        decision: "error",
        reason: "req.body not a Buffer",
        payload_size: payloadSize,
      }).catch(() => {});
      res
        .status(500)
        .json({ error: "Server misconfiguration: raw body not available" });
      return;
    }

    // -- Parse payload -------------------------------------------------
    let payload: SlackEventPayload;
    try {
      payload = JSON.parse(rawBody.toString("utf-8")) as SlackEventPayload;
    } catch {
      recordWebhookDelivery({
        source: "slack",
        decision: "error",
        reason: "malformed JSON",
        payload_size: payloadSize,
      }).catch(() => {});
      res.status(400).json({ error: "Malformed JSON payload" });
      return;
    }

    // -- URL verification challenge ------------------------------------
    // Slack sends this during app setup; no signature verification needed
    if (payload.type === "url_verification") {
      recordWebhookDelivery({
        source: "slack",
        event_type: "url_verification",
        decision: "ignored",
        reason: "url verification challenge",
        payload_size: payloadSize,
      }).catch(() => {});
      res.status(200).json({ challenge: payload.challenge });
      return;
    }

    // -- Signature verification ----------------------------------------
    if (!cfg.slackSigningSecret?.trim()) {
      console.log(
        "[slack-webhook] Rejecting request — signing secret not configured",
      );
      recordWebhookDelivery({
        source: "slack",
        decision: "error",
        reason: "signing secret not configured",
        payload_size: payloadSize,
      }).catch(() => {});
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const timestamp = req.headers["x-slack-request-timestamp"] as
      | string
      | undefined;
    const signature = req.headers["x-slack-signature"] as string | undefined;

    if (
      !verifySlackSignature(
        rawBody,
        timestamp,
        signature,
        cfg.slackSigningSecret,
      )
    ) {
      recordWebhookDelivery({
        source: "slack",
        decision: "error",
        reason: "invalid signature",
        payload_size: payloadSize,
      }).catch(() => {});
      res.status(401).json({ error: "Invalid or missing Slack signature" });
      return;
    }

    // -- Event routing -------------------------------------------------
    if (payload.type !== "event_callback" || !payload.event) {
      recordWebhookDelivery({
        source: "slack",
        event_type: payload.type,
        decision: "ignored",
        reason: "not an event_callback",
        payload_size: payloadSize,
      }).catch(() => {});
      res
        .status(200)
        .json({ ok: true, ignored: true, reason: "not an event_callback" });
      return;
    }

    const event = payload.event;

    if (event.type === "reaction_added") {
      const reactionEvent = event as ReactionAddedEvent;
      handleReactionAdded(reactionEvent, orchestrator, payloadSize);
      // Respond immediately (Slack requires <3s)
      res.status(200).json({ ok: true });
      return;
    }

    // Unknown event type — acknowledge but ignore
    recordWebhookDelivery({
      source: "slack",
      event_type: event.type,
      decision: "ignored",
      reason: `unhandled event type: ${event.type}`,
      payload_size: payloadSize,
    }).catch(() => {});
    res.status(200).json({
      ok: true,
      ignored: true,
      reason: `unhandled event type: ${event.type}`,
    });
  };
}

// ── Event handlers ───────────────────────────────────────────────────────────

function handleReactionAdded(
  event: ReactionAddedEvent,
  orchestrator: SlackReindexOrchestrator,
  payloadSize?: number,
): void {
  const serverCfg = getServerConfig();

  // Find Slack sources where this reaction matches the trigger emoji
  // and the channel is in the configured channel list
  const matchingSources = serverCfg.sources.filter((s) => {
    if (!isSlackSourceConfig(s)) return false;
    if (s.trigger_emoji !== event.reaction) return false;
    if (!s.channels.includes(event.item.channel)) return false;
    return true;
  });

  if (matchingSources.length === 0) {
    console.log(
      `[slack-webhook] Reaction :${event.reaction}: on ${event.item.channel} ` +
        `— no matching Slack source configured, ignoring`,
    );
    recordWebhookDelivery({
      source: "slack",
      event_type: "reaction_added",
      repo: event.item.channel,
      decision: "ignored",
      reason: "no matching Slack source configured",
      payload_size: payloadSize,
    }).catch(() => {});
    return;
  }

  for (const source of matchingSources) {
    console.log(
      `[slack-webhook] Reaction :${event.reaction}: on ${event.item.channel} ` +
        `— queuing reindex for source "${source.name}"`,
    );
    recordWebhookDelivery({
      source: "slack",
      event_type: "reaction_added",
      repo: event.item.channel,
      decision: "queued",
      payload_size: payloadSize,
    }).catch(() => {});
    orchestrator.queueSourceReindex(source.name);
  }
}
