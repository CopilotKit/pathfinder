import { describe, it, expect, beforeEach } from "vitest";
import { IpSessionLimiter } from "../ip-limiter.js";

describe("IpSessionLimiter", () => {
  let limiter: IpSessionLimiter;

  beforeEach(() => {
    limiter = new IpSessionLimiter(3); // max 3 sessions per IP
  });

  it("allows sessions up to the limit", () => {
    expect(limiter.tryAdd("1.2.3.4", "sess-1")).toBe(true);
    expect(limiter.tryAdd("1.2.3.4", "sess-2")).toBe(true);
    expect(limiter.tryAdd("1.2.3.4", "sess-3")).toBe(true);
  });

  it("rejects sessions beyond the limit", () => {
    limiter.tryAdd("1.2.3.4", "sess-1");
    limiter.tryAdd("1.2.3.4", "sess-2");
    limiter.tryAdd("1.2.3.4", "sess-3");
    expect(limiter.tryAdd("1.2.3.4", "sess-4")).toBe(false);
  });

  it("tracks IPs independently", () => {
    limiter.tryAdd("1.2.3.4", "sess-1");
    limiter.tryAdd("1.2.3.4", "sess-2");
    limiter.tryAdd("1.2.3.4", "sess-3");
    expect(limiter.tryAdd("5.6.7.8", "sess-4")).toBe(true);
  });

  it("frees slots on remove", () => {
    limiter.tryAdd("1.2.3.4", "sess-1");
    limiter.tryAdd("1.2.3.4", "sess-2");
    limiter.tryAdd("1.2.3.4", "sess-3");
    limiter.remove("sess-2");
    expect(limiter.tryAdd("1.2.3.4", "sess-4")).toBe(true);
  });

  it("cleans up empty IP entries", () => {
    limiter.tryAdd("1.2.3.4", "sess-1");
    limiter.remove("sess-1");
    expect(limiter.getSessionCount("1.2.3.4")).toBe(0);
  });

  it("returns 0 for unknown IPs", () => {
    expect(limiter.getSessionCount("9.9.9.9")).toBe(0);
  });

  it("does not double-count duplicate session IDs", () => {
    limiter.tryAdd("1.2.3.4", "sess-1");
    limiter.tryAdd("1.2.3.4", "sess-1");
    expect(limiter.getSessionCount("1.2.3.4")).toBe(1);
  });

  it("getMax returns configured limit", () => {
    expect(limiter.getMax()).toBe(3);
  });

  it("remove with unknown session is a no-op", () => {
    expect(() => limiter.remove("nonexistent")).not.toThrow();
  });

  // Regression guard for the server.ts onclose path: when a session is
  // rejected at tryAdd() time (IP limit exceeded), transport.close() fires
  // onclose, which calls ipLimiter.remove(sid) for a sid that was NEVER
  // successfully added to the limiter. That call must NOT decrement any
  // counter — otherwise a rejected attempt would leak a slot back to the
  // offending IP and its in-flight successful sessions would be counted
  // low, eventually allowing MORE sessions than configured.
  it("remove on a never-added session (rejection path) does not decrement counters", () => {
    // Fill the limiter to capacity so we can observe whether an extra
    // remove() call silently frees a slot.
    expect(limiter.tryAdd("1.2.3.4", "sess-1")).toBe(true);
    expect(limiter.tryAdd("1.2.3.4", "sess-2")).toBe(true);
    expect(limiter.tryAdd("1.2.3.4", "sess-3")).toBe(true);

    // Reject: at-capacity tryAdd returns false, and the never-added sid
    // must be safely removable without side effects.
    expect(limiter.tryAdd("1.2.3.4", "sess-4-rejected")).toBe(false);
    limiter.remove("sess-4-rejected");

    // Still at capacity — a fresh tryAdd for a real sid must still fail.
    expect(limiter.tryAdd("1.2.3.4", "sess-5")).toBe(false);
    expect(limiter.getSessionCount("1.2.3.4")).toBe(3);
  });
});
