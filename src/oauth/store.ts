// In-memory stores for OAuth state — dynamic clients and authorization codes.
// Singleton exports match the `src/ip-limiter.ts` pattern.

import { randomBytes, randomUUID } from "node:crypto";
import { oauthLog } from "./observability.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TOTAL = 10_000;
const DEFAULT_MAX_PER_IP = 100;
// Eviction policy (spec §3 lines 43–53):
//   - lastUsedAt < now - 30d            → "ttl" (used at least once, then stale)
//   - registeredAt < now - 7d AND
//     lastUsedAt === registeredAt       → "unused" (never used after registration)
const USED_TTL_MS = 30 * DAY_MS;
const UNUSED_TTL_MS = 7 * DAY_MS;

export interface RegisteredClient {
  client_id: string;
  client_secret: string;
  client_id_issued_at: number;
  client_secret_issued_at: number;
  client_secret_expires_at: number;
  redirect_uris: string[];
  client_name: string;
  registeredAt: number;
  lastUsedAt: number;
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export interface AuthCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  resource?: string;
  expiresAt: number;
}

export interface IssueCodeInput {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  resource?: string;
  ttlMs: number;
}

export type CapOverflow = "total" | "per_ip";

export class ClientCapError extends Error {
  constructor(public readonly scope: CapOverflow) {
    super(`client cap overflow: ${scope}`);
    this.name = "ClientCapError";
  }
}

export interface RegisterInput {
  redirect_uris: string[];
  client_name?: string;
  ip: string;
}

export class ClientStore {
  private clients = new Map<string, RegisteredClient>();
  // Per-IP index for O(1) per-IP cap check; siblings of `clients`.
  private byIp = new Map<string, Set<string>>();
  // Reverse map so `delete(id)` can find the IP bucket without scanning.
  private clientIpOf = new Map<string, string>();
  private readonly maxTotal: number;
  private readonly maxPerIp: number;

  constructor(opts: { maxTotal?: number; maxPerIp?: number } = {}) {
    this.maxTotal = opts.maxTotal ?? DEFAULT_MAX_TOTAL;
    this.maxPerIp = opts.maxPerIp ?? DEFAULT_MAX_PER_IP;
  }

  /**
   * Single-pass eviction. Returns counts by reason so the caller can emit
   * `cap_evicted` for observability. No-op when nothing matches the policy.
   */
  private sweepOnce(now: number): { ttl: number; unused: number } {
    let ttl = 0;
    let unused = 0;
    for (const [id, c] of this.clients) {
      const usedStale = c.lastUsedAt + USED_TTL_MS < now;
      const neverUsed = c.lastUsedAt === c.registeredAt;
      const unusedStale = neverUsed && c.registeredAt + UNUSED_TTL_MS < now;
      if (usedStale) {
        this.deleteInternal(id);
        ttl++;
      } else if (unusedStale) {
        this.deleteInternal(id);
        unused++;
      }
    }
    return { ttl, unused };
  }

  private deleteInternal(id: string): void {
    const ip = this.clientIpOf.get(id);
    this.clients.delete(id);
    this.clientIpOf.delete(id);
    if (ip) {
      const set = this.byIp.get(ip);
      if (set) {
        set.delete(id);
        if (set.size === 0) this.byIp.delete(ip);
      }
    }
  }

  register(input: RegisterInput): RegisteredClient {
    const now = Date.now();
    const perIp = this.byIp.get(input.ip)?.size ?? 0;
    // Lazy sweep: only run when at-or-over a cap. Single sweep per call.
    if (perIp >= this.maxPerIp || this.clients.size >= this.maxTotal) {
      const swept = this.sweepOnce(now);
      oauthLog.capEvicted(swept);
    }
    const perIpAfter = this.byIp.get(input.ip)?.size ?? 0;
    if (perIpAfter >= this.maxPerIp) throw new ClientCapError("per_ip");
    if (this.clients.size >= this.maxTotal) throw new ClientCapError("total");

    const issuedAt = Math.floor(now / 1000);
    const rawName =
      typeof input.client_name === "string" ? input.client_name : "";
    const client: RegisteredClient = {
      client_id: randomUUID(),
      client_secret: base64url(randomBytes(32)),
      client_id_issued_at: issuedAt,
      client_secret_issued_at: issuedAt,
      client_secret_expires_at: 0,
      redirect_uris: [...input.redirect_uris],
      client_name: rawName.slice(0, 80),
      registeredAt: now,
      lastUsedAt: now,
    };
    this.clients.set(client.client_id, client);
    this.clientIpOf.set(client.client_id, input.ip);
    let set = this.byIp.get(input.ip);
    if (!set) {
      set = new Set();
      this.byIp.set(input.ip, set);
    }
    set.add(client.client_id);
    return client;
  }

  get(clientId: string): RegisteredClient | undefined {
    return this.clients.get(clientId);
  }

  /**
   * Bumps `lastUsedAt` to now. No-op for unknown clients — they may have
   * been evicted by a prior sweep, and callers (token grant paths) should
   * not crash on that race.
   */
  touch(clientId: string): void {
    const c = this.clients.get(clientId);
    if (c) c.lastUsedAt = Date.now();
  }
}

export class CodeStore {
  private codes = new Map<string, AuthCode>();

  issue(input: IssueCodeInput): { code: string; expiresAt: number } {
    const code = randomUUID();
    const expiresAt = Date.now() + input.ttlMs;
    this.codes.set(code, {
      clientId: input.clientId,
      codeChallenge: input.codeChallenge,
      redirectUri: input.redirectUri,
      resource: input.resource,
      expiresAt,
    });
    return { code, expiresAt };
  }

  consume(code: string): AuthCode | undefined {
    const record = this.codes.get(code);
    if (!record) return undefined;
    // One-time use: always remove on consume attempt
    this.codes.delete(code);
    if (record.expiresAt < Date.now()) return undefined;
    return record;
  }
}

export const clientStore = new ClientStore();
export const codeStore = new CodeStore();
