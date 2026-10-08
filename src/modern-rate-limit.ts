import ipaddr from "ipaddr.js";
import { IpSessionLimiter, type AllowlistEntry } from "./ip-limiter.js";

/** Hard cap on tracked IPs; beyond it the oldest-touched bucket is evicted. */
const MAX_TRACKED_IPS = 50_000;
/** Idle full buckets are swept at most this often. */
const SWEEP_INTERVAL_MS = 60_000;

export interface ModernRateLimiterOptions {
  /** Sustained requests per minute per IP (refill rate = rpm / 60 per second). */
  rpm: number;
  /** Bucket capacity: the burst a fresh or idle IP may spend at once. */
  burst: number;
  /** IPs / CIDR ranges that are never limited (same format as ip-limiter). */
  allowlist?: AllowlistEntry[];
  now?: () => number;
}

export type ModernRateLimitResult =
  { ok: true } | { ok: false; retryAfterSeconds: number };

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** Collapse IPv4-mapped IPv6 so one client never gets two buckets. */
function bucketKey(ip: string): string {
  try {
    return ipaddr.process(ip).toNormalizedString();
  } catch {
    return ip;
  }
}

/**
 * Per-IP token bucket for modern (stateless) requests. Each bucket starts
 * full at `burst` and refills at `rpm / 60` tokens per second. Allowlist
 * matching reuses IpSessionLimiter.isAllowlisted so both limiters agree on
 * what an allowlist entry means.
 */
export class ModernRateLimiter {
  private readonly ratePerMs: number;
  private readonly burst: number;
  private readonly now: () => number;
  private readonly matcher: IpSessionLimiter;
  // Map iteration order is insertion order; touched buckets are re-inserted
  // at the tail, so the head is always the least recently used.
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep: number;

  constructor(opts: ModernRateLimiterOptions) {
    if (!(opts.rpm > 0) || !(opts.burst > 0)) {
      throw new TypeError(
        `ModernRateLimiter: rpm and burst must be > 0 (got rpm=${String(opts.rpm)}, burst=${String(opts.burst)})`,
      );
    }
    this.ratePerMs = opts.rpm / 60_000;
    this.burst = opts.burst;
    this.now = opts.now ?? Date.now;
    this.matcher = new IpSessionLimiter(1, { allowlist: opts.allowlist });
    this.lastSweep = this.now();
  }

  /** Number of tracked IPs (bounded by MAX_TRACKED_IPS). */
  get size(): number {
    return this.buckets.size;
  }

  take(ip: string): ModernRateLimitResult {
    if (this.matcher.isAllowlisted(ip)) return { ok: true };

    const now = this.now();
    this.maybeSweep(now);

    const key = bucketKey(ip);
    const existing = this.buckets.get(key);
    const bucket: Bucket = existing
      ? {
          tokens: Math.min(
            this.burst,
            existing.tokens + (now - existing.updatedAt) * this.ratePerMs,
          ),
          updatedAt: now,
        }
      : { tokens: this.burst, updatedAt: now };

    let result: ModernRateLimitResult;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      result = { ok: true };
    } else {
      result = this.refusal(bucket.tokens);
    }

    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    this.enforceCap();
    return result;
  }

  /** The refusal for a bucket holding `tokens` (< 1). */
  private refusal(tokens: number): ModernRateLimitResult {
    const seconds = Math.ceil((1 - tokens) / this.ratePerMs / 1000);
    return { ok: false, retryAfterSeconds: Math.max(1, seconds) };
  }

  /** Drop buckets that have refilled to full: they equal a fresh bucket. */
  private maybeSweep(now: number): void {
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    for (const [key, b] of this.buckets) {
      const tokens = b.tokens + (now - b.updatedAt) * this.ratePerMs;
      if (tokens >= this.burst) this.buckets.delete(key);
    }
  }

  private enforceCap(): void {
    while (this.buckets.size > MAX_TRACKED_IPS) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) return;
      this.buckets.delete(oldest);
    }
  }
}

/**
 * Most POST /mcp bodies one IP may have in era classification at once. Only
 * a body express.json did not parse (a non-JSON or missing Content-Type) is
 * read there, and the read buffers up to the SDK's 4 MiB limit, so one IP
 * can hold at most 4 x 4 MiB = 16 MiB of unread bodies. MCP clients send
 * application/json, which never takes a slot, so 4 leaves room for a few
 * clients behind one NAT address that use an odd Content-Type.
 */
export const MAX_CONCURRENT_BODY_READS_PER_IP = 4;

/**
 * Per-IP count of requests in progress, refused past a fixed cap. Keys are
 * normalized like the rate limiter's, and an IP's entry is dropped when its
 * count returns to 0, so the map holds only IPs with a request in progress.
 */
export class ConcurrentReadCap {
  private readonly counts = new Map<string, number>();

  constructor(private readonly max: number) {
    if (!(max >= 1)) {
      throw new TypeError(
        `ConcurrentReadCap: max must be >= 1 (got ${String(max)})`,
      );
    }
  }

  /**
   * Take a slot for `ip`. Returns the release function, or undefined when
   * the IP already holds `max` slots. Release is idempotent: only its first
   * call frees the slot.
   */
  tryAcquire(ip: string): (() => void) | undefined {
    const key = bucketKey(ip);
    const count = this.counts.get(key) ?? 0;
    if (count >= this.max) return undefined;
    this.counts.set(key, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.counts.get(key) ?? 1) - 1;
      if (left > 0) this.counts.set(key, left);
      else this.counts.delete(key);
    };
  }

  /** Slots `ip` holds now. */
  inFlight(ip: string): number {
    return this.counts.get(bucketKey(ip)) ?? 0;
  }

  /** IPs that hold at least one slot. */
  get trackedIps(): number {
    return this.counts.size;
  }
}
