// Fixed-window per-IP rate limiter for OAuth endpoints.
// Simple and cheap; the in-memory Map naturally bounded by unique IPs per window.

interface WindowState {
  count: number;
  windowStart: number;
}

export interface CheckResult {
  ok: boolean;
  retryAfterSec?: number;
}

export class OAuthRateLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly buckets = new Map<string, WindowState>();

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  check(ip: string): CheckResult {
    const now = Date.now();
    const state = this.buckets.get(ip);
    if (!state || now - state.windowStart >= this.windowMs) {
      this.buckets.set(ip, { count: 1, windowStart: now });
      return { ok: true };
    }

    if (state.count < this.max) {
      state.count += 1;
      return { ok: true };
    }

    const elapsed = now - state.windowStart;
    const retryAfterSec = Math.max(1, Math.ceil((this.windowMs - elapsed) / 1000));
    return { ok: false, retryAfterSec };
  }
}

export const registerLimiter = new OAuthRateLimiter(10, 60_000);
export const authorizeLimiter = new OAuthRateLimiter(30, 60_000);
export const tokenLimiter = new OAuthRateLimiter(30, 60_000);
