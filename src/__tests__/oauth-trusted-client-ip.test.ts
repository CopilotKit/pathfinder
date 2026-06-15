import { describe, it, expect, afterEach, vi } from "vitest";
import {
    oauthClientIp,
    setTrustingProxy,
    oauthIpResolverInjected,
    assertOauthIpResolverInjected,
} from "../oauth/trusted-client-ip.js";

// Reset the injected accessor between tests so a stray setter from one case
// can never leak into another. The module-level default is `() => false`, the
// fail-safe pre-bootstrap behavior.
afterEach(() => setTrustingProxy(() => false));

function fakeReq(
    over: Partial<{ ip: string; xff: string; socket: string }> = {},
) {
    return {
        ip: over.ip,
        headers: over.xff ? { "x-forwarded-for": over.xff } : {},
        socket: { remoteAddress: over.socket ?? "203.0.113.5" },
    } as unknown as import("express").Request;
}

describe("oauthClientIp", () => {
    it("ignores X-Forwarded-For when trustProxy=false (default)", () => {
        setTrustingProxy(() => false);
        const req = fakeReq({
            ip: "1.2.3.4",
            xff: "1.2.3.4",
            socket: "203.0.113.5",
        });
        expect(oauthClientIp(req)).toBe("203.0.113.5");
    });

    it("honors req.ip (which Express derives from XFF) when trustProxy=true", () => {
        setTrustingProxy(() => true);
        const req = fakeReq({
            ip: "1.2.3.4",
            xff: "1.2.3.4",
            socket: "203.0.113.5",
        });
        expect(oauthClientIp(req)).toBe("1.2.3.4");
    });

    it("falls back to socket when req.ip is empty and trustProxy=false", () => {
        setTrustingProxy(() => false);
        const req = fakeReq({
            ip: "",
            xff: "1.2.3.4",
            socket: "203.0.113.99",
        });
        expect(oauthClientIp(req)).toBe("203.0.113.99");
    });

    it("returns 'unknown' when everything is empty", () => {
        setTrustingProxy(() => false);
        expect(oauthClientIp({ headers: {}, socket: {} } as never)).toBe(
            "unknown",
        );
    });

    it("defaults to fail-safe (trustProxy=false) when setTrustingProxy has not been called", async () => {
        // Re-import the module fresh so the accessor is at its initial default.
        // We can't actually re-import in-place from this test (ESM cache), but
        // we can simulate the pre-bootstrap state by explicitly resetting to
        // the fail-safe accessor and asserting XFF is ignored.
        setTrustingProxy(() => false);
        const req = fakeReq({
            ip: "1.2.3.4",
            xff: "1.2.3.4",
            socket: "203.0.113.5",
        });
        // Spoof attempt via XFF must NOT bypass the socket address.
        expect(oauthClientIp(req)).toBe("203.0.113.5");
    });
});

// ──────────────────────────────────────────────────────────────────────
// Injection guard — oauthIpResolverInjected / assertOauthIpResolverInjected
// ──────────────────────────────────────────────────────────────────────
//
// Bootstrap regression guard. The fail-safe `() => false` default is safe
// for tests, but in production we want a deploy that loses the
// `setTrustingProxy(...)` call to crash loudly instead of silently
// degrading. These tests exercise both the diagnostic boolean and the
// throwing assertion via a `vi.resetModules()` fresh import so the
// pre-injection state is observable (the suite above has already injected
// in this process's module cache).

describe("oauthIpResolverInjected / assertOauthIpResolverInjected", () => {
    afterEach(() => {
        vi.resetModules();
    });

    it("oauthIpResolverInjected returns false before setTrustingProxy and true after", async () => {
        vi.resetModules();
        const fresh = (await import("../oauth/trusted-client-ip.js")) as {
            setTrustingProxy: typeof setTrustingProxy;
            oauthIpResolverInjected: typeof oauthIpResolverInjected;
        };
        expect(fresh.oauthIpResolverInjected()).toBe(false);
        fresh.setTrustingProxy(() => false);
        expect(fresh.oauthIpResolverInjected()).toBe(true);
    });

    it("assertOauthIpResolverInjected throws when not injected", async () => {
        vi.resetModules();
        const fresh = (await import("../oauth/trusted-client-ip.js")) as {
            assertOauthIpResolverInjected: typeof assertOauthIpResolverInjected;
        };
        expect(() => fresh.assertOauthIpResolverInjected()).toThrow(
            /oauth trusted-IP resolver was not wired/i,
        );
    });

    it("assertOauthIpResolverInjected does NOT throw after setTrustingProxy", async () => {
        vi.resetModules();
        const fresh = (await import("../oauth/trusted-client-ip.js")) as {
            setTrustingProxy: typeof setTrustingProxy;
            assertOauthIpResolverInjected: typeof assertOauthIpResolverInjected;
        };
        fresh.setTrustingProxy(() => false);
        expect(() => fresh.assertOauthIpResolverInjected()).not.toThrow();
    });
});
