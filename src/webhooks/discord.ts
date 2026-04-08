// Discord Interactions webhook handler — Ed25519 signature verification + PING handling.
// Intentionally minimal: only handles the PING interaction required for Discord app setup.
// Reaction events (MESSAGE_REACTION_ADD) require the Gateway WebSocket, which we don't use.

import { verifyKey } from 'discord-interactions';
import type { Request, Response } from 'express';
import { getConfig } from '../config.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface DiscordInteraction {
    type: number;  // 1 = PING, 2 = APPLICATION_COMMAND, etc.
    [key: string]: unknown;
}

/**
 * Minimal interface for the orchestrator dependency.
 */
export interface DiscordReindexOrchestrator {
    queueSourceReindex(sourceName: string): void;
}

// ── Signature verification ───────────────────────────────────────────────────

export async function verifyDiscordSignature(
    rawBody: Buffer,
    signature: string | undefined,
    timestamp: string | undefined,
    publicKey: string,
): Promise<boolean> {
    if (!signature || !timestamp) return false;

    try {
        return await verifyKey(rawBody, signature, timestamp, publicKey);
    } catch {
        return false;
    }
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a Discord webhook handler wired to a specific orchestrator instance.
 */
export function createDiscordWebhookHandler(orchestrator: DiscordReindexOrchestrator) {
    return async function handleDiscordWebhook(req: Request, res: Response): Promise<void> {
        const cfg = getConfig();

        // -- Raw body check ------------------------------------------------
        const rawBody = Buffer.isBuffer(req.body) ? req.body : null;
        if (!rawBody) {
            console.error('[discord-webhook] req.body is not a Buffer — ensure the route uses express.raw()');
            res.status(500).json({ error: 'Server misconfiguration: raw body not available' });
            return;
        }

        // -- Signature verification ----------------------------------------
        const signature = req.headers['x-signature-ed25519'] as string | undefined;
        const timestamp = req.headers['x-signature-timestamp'] as string | undefined;

        const publicKey = cfg.discordPublicKey;
        if (!await verifyDiscordSignature(rawBody, signature, timestamp, publicKey)) {
            res.status(401).json({ error: 'Invalid or missing Discord signature' });
            return;
        }

        // -- Parse payload -------------------------------------------------
        let interaction: DiscordInteraction;
        try {
            interaction = JSON.parse(rawBody.toString('utf-8')) as DiscordInteraction;
        } catch {
            res.status(400).json({ error: 'Malformed JSON payload' });
            return;
        }

        // -- PING handling (type: 1) — required by Discord for URL verification
        if (interaction.type === 1) {
            res.status(200).json({ type: 1 });
            return;
        }

        // -- All other interaction types: acknowledge
        res.status(200).json({ ok: true, ignored: true, reason: `unhandled interaction type: ${interaction.type}` });
    };
}
