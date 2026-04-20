import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { OAuthRateLimiter } from "../oauth/rate-limiter.js";

describe("OAuthRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("check returns {ok: true} under the limit", () => {
    const limiter = new OAuthRateLimiter(3, 60_000);
    expect(limiter.check("1.2.3.4")).toEqual({ ok: true });
    expect(limiter.check("1.2.3.4")).toEqual({ ok: true });
    expect(limiter.check("1.2.3.4")).toEqual({ ok: true });
  });

  it("returns {ok: false, retryAfterSec} when exceeded", () => {
    const limiter = new OAuthRateLimiter(2, 60_000);
    limiter.check("1.2.3.4");
    limiter.check("1.2.3.4");
    const result = limiter.check("1.2.3.4");
    expect(result.ok).toBe(false);
    expect(result.retryAfterSec).toBeGreaterThan(0);
    expect(result.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it("resets after windowMs elapses", () => {
    const limiter = new OAuthRateLimiter(2, 60_000);
    limiter.check("1.2.3.4");
    limiter.check("1.2.3.4");
    expect(limiter.check("1.2.3.4").ok).toBe(false);

    vi.advanceTimersByTime(60_001);
    expect(limiter.check("1.2.3.4").ok).toBe(true);
  });

  it("tracks different IPs independently", () => {
    const limiter = new OAuthRateLimiter(1, 60_000);
    expect(limiter.check("1.2.3.4").ok).toBe(true);
    expect(limiter.check("5.6.7.8").ok).toBe(true);
    expect(limiter.check("1.2.3.4").ok).toBe(false);
    expect(limiter.check("5.6.7.8").ok).toBe(false);
  });

  it("retryAfterSec reflects time remaining in the current window", () => {
    const limiter = new OAuthRateLimiter(1, 60_000);
    limiter.check("1.2.3.4");
    vi.advanceTimersByTime(15_000);
    const result = limiter.check("1.2.3.4");
    expect(result.ok).toBe(false);
    // Roughly 45 seconds left
    expect(result.retryAfterSec).toBeLessThanOrEqual(45);
    expect(result.retryAfterSec).toBeGreaterThanOrEqual(44);
  });
});
