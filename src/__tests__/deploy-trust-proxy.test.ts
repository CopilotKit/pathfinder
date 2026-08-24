import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Request, Response } from "express";
import { clientIp } from "../ip-util.js";
import { IpSessionLimiter } from "../ip-limiter.js";

/**
 * Regression suite for the shipped `trust_proxy` value in `deploy/*.yaml`.
 *
 * Background — the shipped configs used to set `trust_proxy: true`. Express's
 * boolean `trust proxy = true` does NOT mean "one proxy"; it trusts EVERY hop
 * on the `X-Forwarded-For` chain and resolves `req.ip` to the LEFTMOST entry,
 * which is fully client-supplied. Because these deployments also carry an
 * `allowlist` that exempts the Anthropic crawler IP from the per-IP session
 * cap, any caller could send `X-Forwarded-For: 160.79.106.35` and be
 * attributed to the allowlisted crawler — bypassing `max_sessions_per_ip`
 * (default 20) and poisoning `query_log.client_ip` attribution.
 *
 * The fix is a numeric hop count. Exactly one proxy fronts these containers
 * (Railway's edge terminates TLS and forwards to the Node process; there is no
 * CDN and no in-container reverse proxy), so `trust_proxy: 1` is the correct
 * depth. With a hop count Express counts inward from the socket, so a
 * client-forged XFF prefix is ignored — the edge appends the real peer to the
 * RIGHT of anything the client sent.
 *
 * These tests read `trust_proxy` out of the shipped YAML rather than
 * hard-coding it, so reverting the production line to `true` fails the
 * behavioral assertions and not merely the shape assertion.
 */

const DEPLOY_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "deploy",
);

const DEPLOY_CONFIGS = [
  "copilotkit-docs.yaml",
  "pathfinder-docs.yaml",
  "aimock-docs.yaml",
] as const;

type ShippedServerConfig = {
  allowlist?: string[];
  trust_proxy?: boolean | number | string[];
};

function loadShippedServerConfig(file: string): ShippedServerConfig {
  const raw = readFileSync(path.join(DEPLOY_DIR, file), "utf-8");
  const parsed = parseYaml(raw) as { server?: ShippedServerConfig };
  expect(parsed.server, `${file} must define a server block`).toBeDefined();
  return parsed.server as ShippedServerConfig;
}

/**
 * The allowlisted crawler IP an attacker would forge to win the session-cap
 * bypass. Asserted to actually be on the shipped allowlist below, so the
 * suite can't silently drift into testing a meaningless address.
 */
const ALLOWLISTED_CRAWLER_IP = "160.79.106.35";

/** Stand-in for the real peer address the fronting proxy appends. */
const REAL_CLIENT_IP = "203.0.113.7";

/** Stand-in for a legitimate single-hop XFF set by the fronting proxy. */
const LEGITIMATE_PROXY_HOP_IP = "198.51.100.9";

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

/**
 * Boot a real Express app wired exactly the way `startServer()` wires it:
 * `app.set("trust proxy", <shipped value>)` and IP resolution through the
 * shared `clientIp()` helper. Returns the base URL.
 */
async function startProbeApp(
  trustProxy: boolean | number | string[],
  limiter?: IpSessionLimiter,
): Promise<string> {
  const app = express();
  app.set("trust proxy", trustProxy);
  let sessionSeq = 0;
  app.get("/whoami", (req: Request, res: Response) => {
    const ip = clientIp(req, trustProxy);
    if (limiter) {
      const allowlisted = limiter.isAllowlisted(ip);
      // Mirrors the real admission path in sse-handlers/server: resolve the
      // IP, then hand it to the limiter, which exempts allowlisted IPs from
      // the per-IP session cap.
      const admitted = limiter.tryAdd(ip, `probe-${++sessionSeq}`);
      res.status(admitted ? 200 : 429).json({ ip, allowlisted });
      return;
    }
    res.status(200).json({ ip, allowlisted: false });
  });

  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function whoami(
  baseUrl: string,
  xff?: string,
): Promise<{ status: number; ip: string; allowlisted: boolean }> {
  const res = await fetch(`${baseUrl}/whoami`, {
    headers: xff ? { "X-Forwarded-For": xff } : {},
  });
  const body = (await res.json()) as { ip: string; allowlisted: boolean };
  return { status: res.status, ip: body.ip, allowlisted: body.allowlisted };
}

describe("deploy configs pin a numeric trust_proxy hop count", () => {
  for (const file of DEPLOY_CONFIGS) {
    it(`${file} sets trust_proxy to a positive integer hop count, not boolean true`, () => {
      const { trust_proxy: trustProxy } = loadShippedServerConfig(file);

      // Boolean `true` is the vulnerability: it resolves req.ip to the
      // leftmost (client-supplied) XFF entry.
      expect(trustProxy).not.toBe(true);
      expect(typeof trustProxy).toBe("number");
      expect(Number.isInteger(trustProxy as number)).toBe(true);
      // One proxy hop: Railway's edge. Anything larger would trust an
      // attacker-supplied entry again.
      expect(trustProxy).toBe(1);
    });

    it(`${file} still allowlists the crawler IP the hop count protects`, () => {
      const { allowlist } = loadShippedServerConfig(file);
      // If the allowlist ever drops, the forgery tests below stop being
      // meaningful — pin it so they fail loudly instead of passing vacuously.
      expect(allowlist).toContain(ALLOWLISTED_CRAWLER_IP);
    });
  }
});

describe("resolved client IP under the shipped trust_proxy value", () => {
  for (const file of DEPLOY_CONFIGS) {
    describe(file, () => {
      it("ignores a forged multi-entry X-Forwarded-For and uses the proxy-appended peer", async () => {
        const { trust_proxy: trustProxy } = loadShippedServerConfig(file);
        const baseUrl = await startProbeApp(
          trustProxy as boolean | number | string[],
        );

        // What the app sees when a client forges XFF and the single fronting
        // proxy appends the real peer to the right of it.
        const result = await whoami(
          baseUrl,
          `${ALLOWLISTED_CRAWLER_IP}, ${REAL_CLIENT_IP}`,
        );

        expect(result.ip).toBe(REAL_CLIENT_IP);
        // The whole point: the forged allowlisted IP must never win.
        expect(result.ip).not.toBe(ALLOWLISTED_CRAWLER_IP);
      });

      it("resolves a legitimate single proxy hop correctly", async () => {
        const { trust_proxy: trustProxy } = loadShippedServerConfig(file);
        const baseUrl = await startProbeApp(
          trustProxy as boolean | number | string[],
        );

        // Real proxy attribution must keep working — a fix that hardened
        // forgery by breaking legitimate XFF would silently collapse every
        // rate-limit bucket and analytics row onto the proxy address.
        const result = await whoami(baseUrl, LEGITIMATE_PROXY_HOP_IP);

        expect(result.ip).toBe(LEGITIMATE_PROXY_HOP_IP);
      });

      it("falls back to the socket peer when no X-Forwarded-For is present", async () => {
        const { trust_proxy: trustProxy } = loadShippedServerConfig(file);
        const baseUrl = await startProbeApp(
          trustProxy as boolean | number | string[],
        );

        const result = await whoami(baseUrl);

        // Node reports loopback as either form depending on stack config.
        expect(["127.0.0.1", "::ffff:127.0.0.1"]).toContain(result.ip);
      });

      it("does not let a forged X-Forwarded-For win the allowlist session-cap bypass", async () => {
        const { trust_proxy: trustProxy, allowlist } =
          loadShippedServerConfig(file);
        // Cap of 1 with the shipped allowlist: an allowlisted IP bypasses the
        // cap entirely, so a successful forgery would return 200 twice.
        const limiter = new IpSessionLimiter(1, { allowlist });
        const baseUrl = await startProbeApp(
          trustProxy as boolean | number | string[],
          limiter,
        );

        const forged = `${ALLOWLISTED_CRAWLER_IP}, ${REAL_CLIENT_IP}`;

        const first = await whoami(baseUrl, forged);
        expect(first.status).toBe(200);
        expect(first.allowlisted).toBe(false);
        expect(first.ip).toBe(REAL_CLIENT_IP);

        // Second forged request must be rate-limited. Under `trust_proxy:
        // true` this returned 200 with allowlisted=true — the bypass.
        const second = await whoami(baseUrl, forged);
        expect(second.status).toBe(429);
        expect(second.allowlisted).toBe(false);

        // The forged crawler IP must never have been counted or exempted.
        expect(limiter.getSessionCount(ALLOWLISTED_CRAWLER_IP)).toBe(0);
      });
    });
  }
});
