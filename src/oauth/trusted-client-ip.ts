import type { Request } from "express";
import { clientIp } from "../ip-util.js";

/**
 * Setter-injection seam — server.ts calls setTrustingProxy(...) at bootstrap.
 *
 * Default is a fail-safe `() => false`, so any caller that imports this
 * module before server bootstrap (or a test that forgets to inject) gets the
 * conservative XFF-ignoring resolver. That fail-closed default is what makes
 * the spoof-bypass test green: without an active accessor, X-Forwarded-For
 * is ignored and the socket peer address wins.
 *
 * NEVER import `server.ts` here:
 *   server.ts → oauth/handlers.ts → oauth/trusted-client-ip.ts
 * would close an ESM cycle. Setter-injection is precisely the seam that
 * keeps that edge from existing in the import graph.
 */
let trustingProxyAccessor: () => boolean = () => false;

/**
 * Tracks whether `setTrustingProxy(...)` has actually been called. The
 * fail-safe default accessor is fine for tests, but in production a deploy
 * that loses the bootstrap call would silently degrade to "ignore XFF /
 * ignore XFP" with no warning. `assertOauthIpResolverInjected()` lets
 * server.ts fail loud at startup if the wiring regresses.
 */
let injected = false;

/**
 * Inject the live "is Express trusting the proxy?" accessor. Called once at
 * server bootstrap (T13 wires `() => isTrustingProxy()` from server.ts).
 * Tests can swap in their own accessor to exercise both trust-proxy modes
 * without booting a real Express app.
 */
export function setTrustingProxy(fn: () => boolean): void {
    trustingProxyAccessor = fn;
    injected = true;
}

/**
 * Read the currently-injected accessor's boolean. Other oauth/ modules (e.g.
 * `handlers.ts:originOf`) need the trust-proxy decision to gate
 * X-Forwarded-Proto without importing server.ts (which would close an ESM
 * cycle). Returns the fail-safe `false` when the accessor has not been
 * injected yet — same behavior as `oauthClientIp` pre-bootstrap.
 */
export function isTrustingProxyForOauth(): boolean {
    return trustingProxyAccessor();
}

/**
 * Diagnostic accessor — returns whether `setTrustingProxy(...)` has been
 * called. Intended for startup self-checks and tests; production code should
 * prefer `assertOauthIpResolverInjected()` which throws on regression.
 */
export function oauthIpResolverInjected(): boolean {
    return injected;
}

/**
 * Fail-loud bootstrap guard. server.ts calls this immediately AFTER
 * `setTrustingProxy(...)` to assert the wiring is live. A deploy that loses
 * the bootstrap call (e.g. a refactor that dead-strips the import) would
 * otherwise silently fall back to the fail-safe `() => false` default, and
 * XFF/XFP would be ignored without an operator-visible signal. Throwing here
 * crashes startup loudly so the regression cannot ship.
 */
export function assertOauthIpResolverInjected(): void {
    if (!injected) {
        throw new Error(
            "oauth trusted-IP resolver was not wired at server bootstrap",
        );
    }
}

/**
 * Resolve the client IP for OAuth handlers, honoring the injected
 * trust-proxy decision. Delegates to the shared `clientIp(req, trustProxy)`
 * in `ip-util.ts` so the OAuth path and the rest of the server stay in
 * lockstep on which header is trusted.
 *
 * Pre-bootstrap (or in tests that don't inject) this returns the
 * socket-only address — i.e. XFF is ignored. Spec §3 line 49 is explicit:
 * the OAuth resolver MUST consult `isTrustingProxy()` rather than trusting
 * XFF unconditionally.
 */
export function oauthClientIp(req: Request): string {
    return clientIp(req, trustingProxyAccessor());
}
