// GitHub webhook handler for push-event-driven incremental re-indexing

import crypto from "node:crypto";
import type { Request, Response } from "express";
import { getConfig } from "../config.js";

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
 * IndexingOrchestrator lives in ../indexing/orchestrator.ts (Task 5) — we only
 * depend on the subset we actually call so the webhook handler can function
 * even while the orchestrator is still under development.
 */
export interface ReindexOrchestrator {
    queueIncrementalReindex(repoUrl: string): void;
    queueDocsReindex?(repoUrl: string): void;
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

function verifySignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
    if (!signatureHeader) return false;

    const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

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

function touchesDocs(payload: PushPayload): boolean {
    for (const commit of payload.commits) {
        const allPaths = [...commit.added, ...commit.modified, ...commit.removed];
        if (allPaths.some((p) => p.startsWith("docs/"))) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Factory: create a handler wired to a specific orchestrator instance
// ---------------------------------------------------------------------------

export function createWebhookHandler(orchestrator: ReindexOrchestrator) {
    return async function handleGithubWebhook(req: Request, res: Response): Promise<void> {
        const cfg = getConfig();

        // -- Signature verification ----------------------------------------
        // The route MUST be configured with express.raw() so req.body is a
        // Buffer.  If it isn't, bail out — we cannot safely verify the HMAC.
        const rawBody = Buffer.isBuffer(req.body) ? req.body : null;
        if (!rawBody) {
            console.error("[webhook] req.body is not a Buffer — ensure the route uses express.raw()");
            res.status(500).json({ error: "Server misconfiguration: raw body not available" });
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

        const repoUrl = payload.repository.clone_url;
        const sha = payload.after;

        console.log(
            `[webhook] Push to ${payload.repository.full_name} ` +
            `(${payload.repository.default_branch}) at ${sha.slice(0, 8)} — queuing reindex`,
        );

        // -- Dispatch reindexing (fire-and-forget) -------------------------
        orchestrator.queueIncrementalReindex(repoUrl);

        // For the CopilotKit/CopilotKit repo, also queue a docs reindex when
        // files under docs/ were touched.
        if (
            payload.repository.full_name === "CopilotKit/CopilotKit" &&
            touchesDocs(payload) &&
            orchestrator.queueDocsReindex
        ) {
            console.log("[webhook] docs/ changed in CopilotKit/CopilotKit — queuing docs reindex");
            orchestrator.queueDocsReindex(repoUrl);
        }

        res.status(200).json({ queued: true });
    };
}

// ---------------------------------------------------------------------------
// Standalone export for backward compatibility
// ---------------------------------------------------------------------------

let _lazyOrchestrator: ReindexOrchestrator | null = null;

function createStubOrchestrator(): ReindexOrchestrator {
    return {
        queueIncrementalReindex(repoUrl: string) {
            console.log(`[webhook/stub] Would queue incremental reindex for ${repoUrl}`);
        },
        queueDocsReindex(repoUrl: string) {
            console.log(`[webhook/stub] Would queue docs reindex for ${repoUrl}`);
        },
    };
}

async function getLazyOrchestrator(): Promise<ReindexOrchestrator> {
    if (!_lazyOrchestrator) {
        try {
            // Dynamic import with runtime check — the orchestrator module may
            // not export IndexingOrchestrator yet (Task 5).
            const mod = await import("../indexing/orchestrator.js") as Record<string, unknown>;
            if (typeof mod.IndexingOrchestrator === "function") {
                _lazyOrchestrator = new (mod.IndexingOrchestrator as new () => ReindexOrchestrator)();
            } else {
                const nodeEnv = process.env.NODE_ENV || 'development';
                if (nodeEnv === 'production') {
                    throw new Error("[webhook] IndexingOrchestrator export is missing or not a constructor");
                }
                console.warn("[webhook] IndexingOrchestrator not available, using no-op stub");
                _lazyOrchestrator = createStubOrchestrator();
            }
        } catch (err) {
            const nodeEnv = process.env.NODE_ENV || 'development';
            if (nodeEnv === 'production') {
                throw new Error(`[webhook] Failed to import orchestrator in production: ${err}`);
            }
            console.warn("[webhook] Failed to import orchestrator, using no-op stub");
            _lazyOrchestrator = createStubOrchestrator();
        }
    }
    return _lazyOrchestrator!;
}

/**
 * Standalone handler that lazily creates its own orchestrator.  This preserves
 * the original export signature so index.ts can import and call it directly
 * without changes (though the factory form is preferred for testability).
 */
export async function handleGithubWebhook(req: Request, res: Response): Promise<void> {
    const orchestrator = await getLazyOrchestrator();
    const handler = createWebhookHandler(orchestrator);
    return handler(req, res);
}
