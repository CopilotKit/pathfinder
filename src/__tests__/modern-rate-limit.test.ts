import { describe, it, expect } from "vitest";
import { ModernRateLimiter } from "../modern-rate-limit.js";

function ipAt(i: number): string {
  return `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
}

function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("ModernRateLimiter", () => {
  it("passes burst requests then denies", () => {
    const c = clock();
    const l = new ModernRateLimiter({ rpm: 120, burst: 60, now: c.now });
    for (let i = 0; i < 60; i++) expect(l.take("1.2.3.4").ok).toBe(true);
    expect(l.take("1.2.3.4").ok).toBe(false);
  });

  it("refills rpm/60 tokens per second (2 tokens after 1s at rpm 120)", () => {
    const c = clock();
    const l = new ModernRateLimiter({ rpm: 120, burst: 60, now: c.now });
    for (let i = 0; i < 60; i++) l.take("1.2.3.4");
    expect(l.take("1.2.3.4").ok).toBe(false);
    c.advance(1000);
    expect(l.take("1.2.3.4").ok).toBe(true);
    expect(l.take("1.2.3.4").ok).toBe(true);
    expect(l.take("1.2.3.4").ok).toBe(false);
  });

  it("never refills above burst", () => {
    const c = clock();
    const l = new ModernRateLimiter({ rpm: 120, burst: 3, now: c.now });
    l.take("1.2.3.4");
    c.advance(3_600_000);
    for (let i = 0; i < 3; i++) expect(l.take("1.2.3.4").ok).toBe(true);
    expect(l.take("1.2.3.4").ok).toBe(false);
  });

  it("reports Retry-After as ceil(time to one token), minimum 1", () => {
    const c = clock();
    // rpm 30 = 0.5 token/s -> 2s per token
    const l = new ModernRateLimiter({ rpm: 30, burst: 1, now: c.now });
    expect(l.take("1.2.3.4").ok).toBe(true);
    expect(l.take("1.2.3.4")).toEqual({ ok: false, retryAfterSeconds: 2 });
    c.advance(500);
    expect(l.take("1.2.3.4")).toEqual({ ok: false, retryAfterSeconds: 2 });
    c.advance(1000);
    expect(l.take("1.2.3.4")).toEqual({ ok: false, retryAfterSeconds: 1 });
    // fast refill: 0.01s per token still reports at least 1
    const f = new ModernRateLimiter({ rpm: 6000, burst: 1, now: c.now });
    f.take("5.5.5.5");
    expect(f.take("5.5.5.5")).toEqual({ ok: false, retryAfterSeconds: 1 });
  });

  it("never denies an allowlisted IP or CIDR", () => {
    const c = clock();
    const l = new ModernRateLimiter({
      rpm: 60,
      burst: 1,
      allowlist: ["9.9.9.9", "10.1.0.0/16"],
      now: c.now,
    });
    for (let i = 0; i < 100; i++) {
      expect(l.take("9.9.9.9").ok).toBe(true);
      expect(l.take("10.1.200.3").ok).toBe(true);
    }
    expect(l.take("11.1.1.1").ok).toBe(true);
    expect(l.take("11.1.1.1").ok).toBe(false);
  });

  it("keeps IPs independent", () => {
    const c = clock();
    const l = new ModernRateLimiter({ rpm: 60, burst: 1, now: c.now });
    expect(l.take("1.1.1.1").ok).toBe(true);
    expect(l.take("1.1.1.1").ok).toBe(false);
    expect(l.take("2.2.2.2").ok).toBe(true);
  });

  it("buckets IPv4 and its IPv4-mapped IPv6 form together", () => {
    const c = clock();
    const l = new ModernRateLimiter({ rpm: 60, burst: 1, now: c.now });
    expect(l.take("1.1.1.1").ok).toBe(true);
    expect(l.take("::ffff:1.1.1.1").ok).toBe(false);
  });

  it("evicts oldest entries beyond the 50k cap and drops idle full buckets", () => {
    const c = clock();
    const l = new ModernRateLimiter({ rpm: 60, burst: 2, now: c.now });
    // Drained buckets are not evictable by idleness; the cap must hold.
    for (let i = 0; i < 50_001; i++) {
      const ip = ipAt(i);
      l.take(ip);
      l.take(ip);
      l.take(ip);
    }
    expect(l.size).toBe(50_000);
    // After a long idle, every bucket is full again and gets swept.
    c.advance(10 * 60_000);
    l.take("200.200.200.200");
    expect(l.size).toBe(1);
  });

  it("at the cap evicts the least recently used IP, not the newest", () => {
    const c = clock();
    // The clock never moves, so a drained bucket stays drained and no sweep runs.
    const l = new ModernRateLimiter({ rpm: 60, burst: 1, now: c.now });
    for (let i = 0; i < 50_001; i++) expect(l.take(ipAt(i)).ok).toBe(true);
    expect(l.size).toBe(50_000);
    // The newest IP is still tracked and still drained.
    expect(l.take(ipAt(50_000)).ok).toBe(false);
    // The oldest IP was evicted, so it gets a fresh full bucket.
    expect(l.take(ipAt(0)).ok).toBe(true);
  });

  it("a touched IP moves to the tail and survives the next eviction", () => {
    const c = clock();
    const l = new ModernRateLimiter({ rpm: 60, burst: 1, now: c.now });
    for (let i = 0; i < 50_000; i++) expect(l.take(ipAt(i)).ok).toBe(true);
    // Touch the oldest IP: this refreshes its recency.
    expect(l.take(ipAt(0)).ok).toBe(false);
    // One new IP pushes the map over the cap. IP 1 is now the oldest.
    expect(l.take(ipAt(50_000)).ok).toBe(true);
    expect(l.size).toBe(50_000);
    // IP 0 survived and is still drained; IP 1 was evicted and starts fresh.
    expect(l.take(ipAt(0)).ok).toBe(false);
    expect(l.take(ipAt(1)).ok).toBe(true);
  });

  it("the sweep keeps a bucket that is still below burst", () => {
    const c = clock();
    // rpm 1 = one token per minute, so a drained bucket is far from full
    // when the 60s sweep runs.
    const l = new ModernRateLimiter({ rpm: 1, burst: 5, now: c.now });
    for (let i = 0; i < 5; i++) expect(l.take("1.1.1.1").ok).toBe(true);
    expect(l.take("1.1.1.1").ok).toBe(false);
    // B refills to full before the sweep: the positive control that the
    // sweep runs and removes full buckets.
    expect(l.take("2.2.2.2").ok).toBe(true);
    expect(l.size).toBe(2);

    c.advance(60_001);
    // This take triggers the sweep. A has refilled one token (1 < burst 5),
    // so the sweep keeps it and A spends that one token.
    expect(l.take("1.1.1.1").ok).toBe(true);
    expect(l.size).toBe(1);
    // A is still limited. A sweep that also dropped A would give it a fresh
    // full bucket and reset its limit.
    expect(l.take("1.1.1.1").ok).toBe(false);
  });
});
