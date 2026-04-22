import type { Request } from "express";

/**
 * Extract the client IP for rate-limiting, tracing, and analytics purposes.
 *
 * Security model — this helper is load-bearing for the IP allowlist in the
 * per-IP session limiter, so it MUST NOT be fooled by a client-supplied
 * `X-Forwarded-For` header. An attacker who could spoof XFF could trivially
 * claim to be an allowlisted crawler IP (e.g. 160.79.106.35) and bypass the
 * rate limit entirely.
 *
 * The decision of whether to honor `X-Forwarded-For` is delegated to Express
 * via `app.set("trust proxy", …)` (see server.ts). When trustProxy is true,
 * Express walks the XFF chain and assigns the result to `req.ip`; we simply
 * return that. When trustProxy is false, we ignore XFF entirely and trust
 * only the socket's peer address — which cannot be spoofed at the HTTP layer.
 *
 * Operators should only enable trust_proxy when the deployment sits behind a
 * reverse proxy that strips and rewrites the incoming `X-Forwarded-For`
 * header. Railway's edge does this correctly; a bare `node` process exposed
 * directly to the public internet does not.
 *
 * IMPORTANT — Express `trust proxy = true` leftmost-XFF caveat: see the
 * detailed warning in startServer() in `src/server.ts` (search for
 * "leftmost (client-supplied, potentially spoofable)"). In short, Express's
 * boolean `trust proxy = true` trusts EVERY hop in the X-Forwarded-For chain
 * and resolves `req.ip` to the LEFTMOST entry — which is the client-supplied
 * (and therefore spoofable) value unless the fronting reverse proxy strips
 * and rewrites XFF before it reaches us. For tighter single-hop deployments
 * prefer a numeric hop count (`app.set("trust proxy", 1)`); the IP allowlist
 * bypass in the per-IP session limiter is only as strong as the trust
 * boundary configured here. See `pathfinder.example.yaml` next to
 * `server.trust_proxy` for the operator-facing version of this warning.
 */
export function clientIp(
  req: Request,
  trustProxy: boolean | number | string[],
): string {
  // NOTE: we use `||` rather than `??` throughout so the empty string also
  // falls through to the next candidate. An empty `remoteAddress` can show
  // up after abrupt disconnects, in some HTTP/2 upgrade paths, and in test
  // mocks; `??` would preserve it and every such request would then bucket
  // into a single "" counter in the per-IP rate limiter, letting one
  // client DoS every other client in that state. `||` treats "" the same
  // as undefined/null and keeps walking the fallback chain.
  //
  // `trustProxy` mirrors Express's `trust proxy` union: truthy boolean,
  // positive hop count, or non-empty CIDR/IP array all honor req.ip (which
  // Express resolves from the XFF chain). Falsy boolean / 0 / empty array
  // ignores XFF and trusts only the TCP peer.
  const honorXff =
    trustProxy === true ||
    (typeof trustProxy === "number" && trustProxy > 0) ||
    (Array.isArray(trustProxy) && trustProxy.length > 0);
  if (honorXff) {
    // Express populates req.ip from the XFF chain when `trust proxy` is set.
    // Fall back to the socket if the framework somehow didn't resolve one
    // (or left an empty string), and to "unknown" only as a last resort so
    // logs/counters stay sortable.
    return req.ip || req.socket?.remoteAddress || "unknown";
  }
  // Hardened path: ignore X-Forwarded-For (and req.ip, which could also have
  // been populated from XFF by a mis-configured upstream). Trust only the
  // TCP peer address.
  return req.socket?.remoteAddress || "unknown";
}
