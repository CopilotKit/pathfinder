// POST /authorize/consent — the second half of the consent flow.
//
// The GET /authorize handler renders an HTML form (see consent-template.ts)
// whose hidden fields encode every OAuth parameter the user is being asked
// to approve, plus a server-signed nonce that binds those exact parameter
// values. This handler receives the form submission, re-validates the full
// bound set, and either mints an authorization code (approve) or redirects
// with `error=access_denied` (deny).
//
// SECURITY-CRITICAL INVARIANT
// ───────────────────────────
// The final redirect URL is ALWAYS taken from the nonce-bound payload,
// NEVER from the form body. The form body must field-by-field equal the
// payload (step 3) — and step 3 is the very first re-check after MAC
// verification — but even with that gate in place we deliberately read
// `p.redirect_uri` rather than `body.redirect_uri` at the redirect call
// site. This belt-and-suspenders pattern is what makes the flow
// phishing-resistant: even a programming error in the equality loop would
// not let a tampered form body steer the user to an attacker URL.
//
// 8-step pipeline (each step a verification gate; first failure short-
// circuits with a 4xx):
//   1. Per-IP rate limit on the consent endpoint itself.
//   2. Verify the nonce HMAC (multi-key, rotation-tolerant) — MUST precede
//      every other check because the payload is meaningless without an
//      intact MAC.
//   3. Field-by-field equality between form body and nonce payload across
//      the whole bound set. Mismatch ⇒ 400, generic message (we never
//      leak which field mismatched).
//   4. Look up the client in the store. A client deleted between sign and
//      consent ⇒ 400.
//   5. Re-validate the redirect_uri against the current policy AND
//      re-check it's still in the client's registered list — policies may
//      have tightened since the nonce was minted.
//   6. Re-confirm `scope`, `response_type`, `code_challenge_method` are
//      what we still support.
//   7. Decision branch — approve ⇒ mint code; deny ⇒ access_denied.
//   8. Any other decision ⇒ 400.

import type { Request, Response } from "express";
import { getConfig } from "../config.js";
import { clientStore, codeStore } from "./store.js";
import { verifyConsentNonce } from "./consent-nonce.js";
import { validateRedirectUri } from "./redirect-uri-policy.js";
import { oauthClientIp } from "./trusted-client-ip.js";
import { oauthLog } from "./observability.js";
import { consentLimiter, type OAuthRateLimiter } from "./rate-limiter.js";

// Code TTL matches the existing authorize-handler grant lifetime; the
// consent flow does not change the code's lifecycle, only the user-
// approval step that precedes it.
const CODE_TTL_MS = 600_000;
const TOKEN_SCOPE = "mcp";

function enforce(
    limiter: OAuthRateLimiter,
    req: Request,
    res: Response,
): boolean {
    const ip = oauthClientIp(req);
    const r = limiter.check(ip);
    if (!r.ok) {
        res.setHeader("Retry-After", String(r.retryAfterSec ?? 60));
        res.status(429).json({
            error: "rate_limited",
            error_description: "Too many requests — slow down.",
        });
        oauthLog.consentRateLimited({ ip });
        return false;
    }
    return true;
}

// Fields that must be byte-equal between the form body and the nonce
// payload. `exp` and the nonce token itself are NOT in this list — `exp`
// is internal to the MAC, and the nonce token is what gets verified
// rather than compared against itself.
const BOUND_FIELDS = [
    "client_id",
    "redirect_uri",
    "state",
    "code_challenge",
    "code_challenge_method",
    "response_type",
    "scope",
    "resource",
] as const;

export function consentHandler(req: Request, res: Response): void {
    // (1) Rate-limit per IP.
    if (!enforce(consentLimiter, req, res)) return;

    const ip = oauthClientIp(req);
    const body = (req.body ?? {}) as Record<string, string | undefined>;

    // (2) Verify nonce — MAC first, then expiry (the verifier handles the
    // ordering correctly so we don't have to disambiguate here).
    const nonceToken = body.nonce ?? "";
    const v = verifyConsentNonce(nonceToken, getConfig().oauthConsentHmacKeys);
    if (!v.ok) {
        oauthLog.consentNonceInvalid({ reason: v.reason, ip });
        res.status(400).json({
            error: "invalid_request",
            error_description: `consent nonce: ${v.reason}`,
        });
        return;
    }
    const p = v.payload;

    // (3) Field-by-field equality. Generic 400 — do NOT leak which field
    // mismatched, because that would help an attacker iterate on a forged
    // submission. The internal log line carries the field name for
    // operators.
    for (const k of BOUND_FIELDS) {
        const formVal = body[k] ?? "";
        // BOUND_FIELDS is a tuple of string-valued payload keys (the only
        // payload field NOT in the tuple is the numeric `exp`), so the
        // string-narrow is safe by construction.
        const payloadVal = (p as unknown as Record<string, string>)[k] ?? "";
        if (formVal !== payloadVal) {
            oauthLog.consentNonceInvalid({
                reason: "field_mismatch",
                ip,
                field: k,
            });
            res.status(400).json({
                error: "invalid_request",
                error_description: "consent parameters do not match.",
            });
            return;
        }
    }

    // (4) Look up the client. A client may have been evicted (lazy sweep)
    // or explicitly deleted in the window between consent-screen render
    // and form submit.
    const client = clientStore.get(p.client_id);
    if (!client) {
        oauthLog.consentStaleClient({ ip, client_id: p.client_id });
        res.status(400).json({
            error: "unauthorized_client",
            error_description: "Unknown client_id.",
        });
        return;
    }

    // (5a) Re-validate against the redirect_uri policy. Defense in depth:
    // policy may have tightened since the nonce was minted (e.g. operator
    // pushed a stricter ruleset between mint and redeem).
    const policy = validateRedirectUri(p.redirect_uri);
    if (!policy.ok) {
        oauthLog.registerRejected({
            reason: policy.reason,
            ip,
            client_id: p.client_id,
        });
        res.status(400).json({
            error: "invalid_redirect_uri",
            error_description: `redirect_uri rejected: ${policy.reason}`,
        });
        return;
    }

    // (5b) Exact-match against the client's registered list. Distinct
    // log line from (5a) so operators can disambiguate policy-evasion
    // from list-tampering.
    if (
        client.redirect_uris.length > 0 &&
        !client.redirect_uris.includes(p.redirect_uri)
    ) {
        oauthLog.registerRejected({
            reason: "not_in_list",
            ip,
            client_id: p.client_id,
        });
        res.status(400).json({
            error: "invalid_redirect_uri",
            error_description: "redirect_uri not in registered list.",
        });
        return;
    }

    // (6a) Scope re-check — split from response_type/PKCE check so the
    // 400 shapes are distinct (invalid_scope vs invalid_request) and
    // operators can grep them separately.
    if (p.scope !== TOKEN_SCOPE) {
        oauthLog.consentScopeMismatch({
            ip,
            client_id: p.client_id,
            scope: p.scope,
        });
        res.status(400).json({
            error: "invalid_scope",
            error_description: `scope must be ${TOKEN_SCOPE}.`,
        });
        return;
    }

    // (6b) response_type + code_challenge_method re-check.
    if (p.response_type !== "code" || p.code_challenge_method !== "S256") {
        oauthLog.consentParamUnsupported({
            ip,
            client_id: p.client_id,
            response_type: p.response_type,
            code_challenge_method: p.code_challenge_method,
        });
        res.status(400).json({
            error: "invalid_request",
            error_description:
                "response_type or code_challenge_method unsupported.",
        });
        return;
    }

    const decision = body.decision;

    // (7) Deny path. The redirect URL is built from `p.redirect_uri` —
    // the nonce-bound value — NOT from `body.redirect_uri`. Step (3)
    // already proved they're byte-equal, but we still read from the
    // payload as a belt-and-suspenders guarantee: even a programming
    // error in step (3) would not let a tampered body URI win here.
    if (decision === "deny") {
        oauthLog.consentDenied({ client_id: p.client_id, ip });
        let url: URL;
        try {
            url = new URL(p.redirect_uri);
        } catch {
            oauthLog.consentRedirectUriUnparseable({
                ip,
                client_id: p.client_id,
            });
            res.status(400).json({
                error: "invalid_request",
                error_description: "redirect_uri unparseable",
            });
            return;
        }
        url.searchParams.set("error", "access_denied");
        url.searchParams.set("error_description", "user_denied_consent");
        if (p.state) url.searchParams.set("state", p.state);
        res.redirect(url.toString());
        return;
    }

    // (8) Approve path — or anything that isn't `deny` and isn't
    // `approve` falls through to a 400 below.
    if (decision !== "approve") {
        oauthLog.consentUnknownDecision({
            ip,
            client_id: p.client_id,
            decision: String(body.decision),
        });
        res.status(400).json({
            error: "invalid_request",
            error_description: "unknown decision.",
        });
        return;
    }

    // Approve: touch the client (liveness signal for TTL eviction),
    // mint an auth code bound to the nonce's PKCE challenge + resource,
    // and redirect to the nonce-bound URI.
    let url: URL;
    try {
        url = new URL(p.redirect_uri);
    } catch {
        oauthLog.consentRedirectUriUnparseable({
            ip,
            client_id: p.client_id,
        });
        res.status(400).json({
            error: "invalid_request",
            error_description: "redirect_uri unparseable",
        });
        return;
    }
    clientStore.touch(p.client_id);
    const { code } = codeStore.issue({
        clientId: p.client_id,
        codeChallenge: p.code_challenge,
        redirectUri: p.redirect_uri,
        resource: p.resource || undefined,
        ttlMs: CODE_TTL_MS,
    });
    url.searchParams.set("code", code);
    if (p.state) url.searchParams.set("state", p.state);
    oauthLog.consentApproved({ client_id: p.client_id, ip });
    res.redirect(url.toString());
}
