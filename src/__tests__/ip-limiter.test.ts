import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { IpSessionLimiter, type TryAddResult } from "../ip-limiter.js";

describe("IpSessionLimiter", () => {
  let limiter: IpSessionLimiter;

  beforeEach(() => {
    limiter = new IpSessionLimiter(3); // max 3 sessions per IP
  });

  describe("constructor maxPerIp validation", () => {
    // Belt-and-suspenders guard for direct consumers of the exported class.
    // Schema upstream enforces max_sessions_per_ip as a positive integer, but
    // IpSessionLimiter is a public export — a caller could still hand in a
    // nonsense value. Silently accepting 0/NaN/negative/non-integer turns the
    // limiter into "reject every non-allowlisted session" without any signal,
    // which is indistinguishable from a successful DoS.
    it("throws TypeError on maxPerIp = 0", () => {
      expect(() => new IpSessionLimiter(0)).toThrow(TypeError);
    });

    it("throws TypeError on negative maxPerIp", () => {
      expect(() => new IpSessionLimiter(-1)).toThrow(TypeError);
    });

    it("throws TypeError on NaN maxPerIp", () => {
      expect(() => new IpSessionLimiter(Number.NaN)).toThrow(TypeError);
    });

    it("throws TypeError on non-integer maxPerIp", () => {
      expect(() => new IpSessionLimiter(1.5)).toThrow(TypeError);
    });

    it("accepts maxPerIp = 1", () => {
      expect(() => new IpSessionLimiter(1)).not.toThrow();
    });

    it("accepts maxPerIp = 20", () => {
      expect(() => new IpSessionLimiter(20)).not.toThrow();
    });
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

  describe("allowlist", () => {
    let infoSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    });

    afterEach(() => {
      infoSpy.mockRestore();
    });

    it("bypasses the limit for an exact plain-IP match", () => {
      const allow = new IpSessionLimiter(2, {
        allowlist: ["160.79.106.35"],
      });
      // Fill well past capacity — allowlisted IPs never count against the cap.
      expect(allow.tryAdd("160.79.106.35", "sess-1")).toBe(true);
      expect(allow.tryAdd("160.79.106.35", "sess-2")).toBe(true);
      expect(allow.tryAdd("160.79.106.35", "sess-3")).toBe(true);
      expect(allow.tryAdd("160.79.106.35", "sess-4")).toBe(true);
      // Allowlisted traffic is not counted in getSessionCount.
      expect(allow.getSessionCount("160.79.106.35")).toBe(0);
    });

    it("bypasses the limit for a CIDR match", () => {
      const allow = new IpSessionLimiter(1, {
        allowlist: ["160.79.106.0/24"],
      });
      expect(allow.tryAdd("160.79.106.7", "a")).toBe(true);
      expect(allow.tryAdd("160.79.106.7", "b")).toBe(true);
      expect(allow.tryAdd("160.79.106.250", "c")).toBe(true);
    });

    it("still enforces the limit on non-matching IPs", () => {
      const allow = new IpSessionLimiter(2, {
        allowlist: ["160.79.106.0/24"],
      });
      expect(allow.tryAdd("9.9.9.9", "a")).toBe(true);
      expect(allow.tryAdd("9.9.9.9", "b")).toBe(true);
      expect(allow.tryAdd("9.9.9.9", "c")).toBe(false);
    });

    it("supports IPv6 addresses and CIDR ranges", () => {
      const allow = new IpSessionLimiter(1, {
        allowlist: ["2001:db8::/32"],
      });
      // Both in-range calls bypass the cap.
      expect(allow.tryAdd("2001:db8::1", "a")).toBe(true);
      expect(allow.tryAdd("2001:db8::1", "b")).toBe(true);
      // A non-matching IPv6 outside the range is subject to the cap (=1) and
      // should succeed once, then be rejected on the second add.
      expect(allow.tryAdd("2001:db9::1", "c")).toBe(true);
      expect(allow.tryAdd("2001:db9::1", "d")).toBe(false);
    });

    it("matches an IPv4-mapped IPv6 allowlist entry against an IPv4 request", () => {
      // Operator writes the mapped form in YAML; request arrives as plain IPv4.
      const allow = new IpSessionLimiter(1, {
        allowlist: ["::ffff:127.0.0.1"],
      });
      expect(allow.isAllowlisted("127.0.0.1")).toBe(true);
      // And the cap is bypassed for that IPv4 traffic.
      expect(allow.tryAdd("127.0.0.1", "a")).toBe(true);
      expect(allow.tryAdd("127.0.0.1", "b")).toBe(true);
    });

    it("logs an info message on bypass (rate-limited per IP)", () => {
      const allow = new IpSessionLimiter(1, {
        allowlist: ["160.79.106.35"],
      });
      allow.tryAdd("160.79.106.35", "a");
      allow.tryAdd("160.79.106.35", "b");
      allow.tryAdd("160.79.106.35", "c");
      // The log is throttled per IP — expect at least one but not one-per-call.
      expect(infoSpy).toHaveBeenCalled();
      const callsForThisIp = infoSpy.mock.calls.filter((c: unknown[]) =>
        String(c[0]).includes("160.79.106.35"),
      );
      expect(callsForThisIp.length).toBeGreaterThanOrEqual(1);
      expect(callsForThisIp.length).toBeLessThan(3);
    });

    it("isAllowlisted returns true/false for matching / non-matching IPs", () => {
      const allow = new IpSessionLimiter(5, {
        allowlist: ["10.0.0.0/8", "192.168.1.5"],
      });
      expect(allow.isAllowlisted("10.1.2.3")).toBe(true);
      expect(allow.isAllowlisted("192.168.1.5")).toBe(true);
      expect(allow.isAllowlisted("192.168.1.6")).toBe(false);
      expect(allow.isAllowlisted("8.8.8.8")).toBe(false);
    });

    it("ignores unknown / 'unknown' IPs (never allowlisted)", () => {
      const allow = new IpSessionLimiter(5, {
        allowlist: ["10.0.0.0/8"],
      });
      expect(allow.isAllowlisted("unknown")).toBe(false);
      expect(allow.isAllowlisted("")).toBe(false);
      expect(allow.isAllowlisted("not-an-ip")).toBe(false);
    });

    it("emits a single loud error when ALL allowlist entries are invalid", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        // Two entries, both invalid — per-entry warnings plus one summary error.
        const allow = new IpSessionLimiter(2, {
          allowlist: ["not-an-ip", "also-bogus/33"],
        });
        // Nothing should be allowlisted.
        expect(allow.isAllowlisted("10.0.0.1")).toBe(false);
        const summaryCalls = errorSpy.mock.calls.filter((c: unknown[]) =>
          String(c[0]).includes("allowlist is now EMPTY"),
        );
        expect(summaryCalls.length).toBe(1);
      } finally {
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it("does NOT emit the 'all invalid' error when at least one entry parses", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        new IpSessionLimiter(2, {
          allowlist: ["not-an-ip", "10.0.0.0/8"],
        });
        const summaryCalls = errorSpy.mock.calls.filter((c: unknown[]) =>
          String(c[0]).includes("allowlist is now EMPTY"),
        );
        expect(summaryCalls.length).toBe(0);
      } finally {
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it("does NOT emit the 'all invalid' error for an empty allowlist", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        new IpSessionLimiter(2, { allowlist: [] });
        const summaryCalls = errorSpy.mock.calls.filter((c: unknown[]) =>
          String(c[0]).includes("allowlist is now EMPTY"),
        );
        expect(summaryCalls.length).toBe(0);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it("lastAllowlistLog map does not grow unbounded under many distinct IPs", () => {
      // Use a /8 so 10,000 distinct source IPs all hit the bypass path.
      const allow = new IpSessionLimiter(1, {
        allowlist: ["10.0.0.0/8"],
      });
      for (let i = 0; i < 10_000; i++) {
        const a = (i >> 16) & 0xff;
        const b = (i >> 8) & 0xff;
        const c = i & 0xff;
        allow.tryAdd(`10.${a}.${b}.${c}`, `sess-${i}`);
      }
      // Internal map must not grow past a sane cap (1000).
      const internal = (
        allow as unknown as { lastAllowlistLog: Map<string, number> }
      ).lastAllowlistLog;
      expect(internal.size).toBeLessThanOrEqual(1000);
    });

    it("remove() on an allowlisted session is a safe no-op", () => {
      const allow = new IpSessionLimiter(2, {
        allowlist: ["160.79.106.35"],
      });
      allow.tryAdd("160.79.106.35", "sess-a");
      // Allowlisted sessions are not tracked; remove() must not throw or
      // affect any counters.
      expect(() => allow.remove("sess-a")).not.toThrow();
      expect(allow.getSessionCount("160.79.106.35")).toBe(0);
    });

    it("getSessionCount reflects pre-allowlist tracking for an IP later covered by the allowlist", () => {
      // IP was tracked BEFORE the allowlist covered it (e.g. allowlist
      // loaded after sessions already opened, or allowlist hot-reloaded).
      // Retroactively applying the allowlist must not silently zero out the
      // already-counted sessions. We can't hot-swap an allowlist on an
      // existing limiter, so we model the scenario by flipping internals
      // on a limiter that was CONSTRUCTED with the allowlist already set:
      // the internal `ipToSessions` map has pre-existing entries, and
      // getSessionCount must return them regardless of allowlist coverage
      // at call time.
      const allow = new IpSessionLimiter(5, { allowlist: ["10.0.0.0/8"] });
      // Manually simulate pre-existing tracked state — models "IP was
      // tracked, then allowlist was applied".
      const internalIpToSessions = (
        allow as unknown as { ipToSessions: Map<string, Set<string>> }
      ).ipToSessions;
      internalIpToSessions.set("10.1.2.3", new Set(["s1", "s2"]));
      expect(allow.getSessionCount("10.1.2.3")).toBe(2);
    });

    it("tryAdd with a re-used sid from a DIFFERENT IP does not cause counter drift", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const drift = new IpSessionLimiter(5);
        expect(drift.tryAdd("1.2.3.4", "sid-x")).toBe(true);
        expect(drift.getSessionCount("1.2.3.4")).toBe(1);

        // Same sid, different IP. Conservative behavior: reject and warn.
        expect(drift.tryAdd("5.6.7.8", "sid-x")).toBe(false);
        // Neither IP's counter should drift.
        expect(drift.getSessionCount("1.2.3.4")).toBe(1);
        expect(drift.getSessionCount("5.6.7.8")).toBe(0);

        // remove() targets the original IP cleanly.
        drift.remove("sid-x");
        expect(drift.getSessionCount("1.2.3.4")).toBe(0);
        expect(drift.getSessionCount("5.6.7.8")).toBe(0);

        // A warning was logged.
        const warnings = warnSpy.mock.calls.filter((c: unknown[]) =>
          String(c[0]).includes("re-added from different IP"),
        );
        expect(warnings.length).toBe(1);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("tryAdd with a re-used sid from the SAME IP is idempotent (returns true)", () => {
      const same = new IpSessionLimiter(5);
      expect(same.tryAdd("1.2.3.4", "sid-y")).toBe(true);
      expect(same.tryAdd("1.2.3.4", "sid-y")).toBe(true);
      expect(same.getSessionCount("1.2.3.4")).toBe(1);
    });

    it("ESCALATES to console.error when ALL allowlist entries are invalid", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        new IpSessionLimiter(2, {
          allowlist: ["not-an-ip", "also-bogus/33", "still-wrong"],
        });
        // Must log a loud error (not just a warn) explaining the impact.
        const errorCalls = errorSpy.mock.calls.filter((c: unknown[]) => {
          const msg = String(c[0]);
          return (
            msg.includes("allowlist is now EMPTY") &&
            msg.includes("rate limiting will apply")
          );
        });
        expect(errorCalls.length).toBe(1);
        // Failed-count surfaces in the error message.
        expect(String(errorCalls[0][0])).toContain("3");
      } finally {
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });
  });

  describe("IPv4-mapped IPv6 normalization at map-key boundaries", () => {
    it("buckets ::ffff:10.0.0.1 and 10.0.0.1 into the SAME per-IP counter", () => {
      // Without normalization the two forms would double-bucket and effectively
      // double the per-IP cap for dual-stack clients.
      const l = new IpSessionLimiter(3);
      expect(l.tryAdd("::ffff:10.0.0.1", "a")).toBe(true);
      expect(l.tryAdd("10.0.0.1", "b")).toBe(true);
      expect(l.tryAdd("::ffff:10.0.0.1", "c")).toBe(true);
      // Cap is 3 — the fourth (any form) must be rejected.
      expect(l.tryAdd("10.0.0.1", "d")).toBe(false);
      expect(l.tryAdd("::ffff:10.0.0.1", "e")).toBe(false);
      // getSessionCount is consistent across forms.
      expect(l.getSessionCount("10.0.0.1")).toBe(3);
      expect(l.getSessionCount("::ffff:10.0.0.1")).toBe(3);
    });

    it("remove() works regardless of which form called tryAdd()", () => {
      const l = new IpSessionLimiter(2);
      expect(l.tryAdd("::ffff:10.0.0.1", "sid-x")).toBe(true);
      // remove() via the plain-IPv4 form still frees the slot.
      l.remove("sid-x");
      expect(l.getSessionCount("10.0.0.1")).toBe(0);
      expect(l.getSessionCount("::ffff:10.0.0.1")).toBe(0);
      expect(l.tryAdd("10.0.0.1", "sid-y")).toBe(true);
    });

    it("non-parseable IPs ('unknown', empty) are bucketed by the raw string", () => {
      // Fall-through behavior: strings that don't parse as IP are used as-is
      // for keying, preserving existing test expectations for "unknown".
      const l = new IpSessionLimiter(1);
      expect(l.tryAdd("unknown", "a")).toBe(true);
      expect(l.tryAdd("unknown", "b")).toBe(false);
      expect(l.getSessionCount("unknown")).toBe(1);
    });
  });

  describe("maybeLogBypass cost / LRU semantics", () => {
    it("does NOT run the O(n) sweep on the throttled path (cooldown early-return)", () => {
      // Fill the log map to capacity with one IP's recent log, then hammer
      // the same IP. The sweep branch, if run, mutates the internal Map —
      // assert the Map's contents are untouched across repeated bypass hits
      // within the cooldown window.
      const allow = new IpSessionLimiter(1, {
        allowlist: ["10.0.0.0/8"],
      });
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        const internal = (
          allow as unknown as { lastAllowlistLog: Map<string, number> }
        ).lastAllowlistLog;
        // Prime the map to ~capacity with stale entries that WOULD be swept
        // if the sweep ran. Use a timestamp far in the past so the sweep
        // cutoff would delete them.
        const staleTs = Date.now() - 10 * 60 * 60 * 1000; // 10h ago
        for (let i = 0; i < 1000; i++) {
          internal.set(`stale-${i}`, staleTs);
        }
        // Now record a recent bypass for a hot IP so subsequent calls are
        // within the cooldown.
        allow.tryAdd("10.1.2.3", "first");
        const sizeAfterFirst = internal.size;
        // Hammer the same IP within cooldown — this must early-return and
        // NOT run the sweep (which would delete the stale-* entries).
        for (let i = 0; i < 50; i++) {
          allow.tryAdd("10.1.2.3", `hot-${i}`);
        }
        // If the sweep ran on the throttled path, size would have dropped
        // by up to 1000. It must not have.
        expect(internal.size).toBe(sizeAfterFirst);
      } finally {
        infoSpy.mockRestore();
      }
    });

    it("evicts entries in true LRU order, not insertion order", () => {
      // A hot IP that keeps getting re-touched must stay in the LRU map
      // while cold one-shot IPs get evicted as the cap is exceeded. Without
      // true-LRU semantics (delete-then-set on each touch), the hot IP sits
      // at the head of insertion order and is the FIRST thing evicted once
      // cold traffic fills the map.
      const allow = new IpSessionLimiter(1, {
        allowlist: ["10.0.0.0/8"],
      });
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        vi.useFakeTimers();
        const start = Date.now();
        vi.setSystemTime(start);

        // Hot IP logs first (inserted at position 0 of the LRU map).
        allow.tryAdd("10.9.9.9", "hot-initial");

        // Churn cold IPs while periodically re-touching the hot IP outside
        // the cooldown window. Without delete-then-set, "10.9.9.9" sits at
        // the insertion-order head and gets evicted as soon as cold IPs
        // push the map to capacity.
        const cooldownMs = 5 * 60 * 1000;
        const touchEveryNthCold = 500;
        for (let i = 0; i < 5000; i++) {
          // Advance time by more than the cooldown per cold IP so each one
          // actually logs and inserts into the LRU map.
          vi.setSystemTime(start + (i + 1) * (cooldownMs + 1));
          allow.tryAdd(`10.1.${(i >> 8) & 0xff}.${i & 0xff}`, `cold-${i}`);

          // Every N iterations, re-touch the hot IP so true-LRU moves it
          // back to the tail.
          if ((i + 1) % touchEveryNthCold === 0) {
            vi.setSystemTime(start + (i + 1) * (cooldownMs + 1) + 1);
            allow.tryAdd("10.9.9.9", `hot-touch-${i}`);
          }
        }

        const internal = (
          allow as unknown as { lastAllowlistLog: Map<string, number> }
        ).lastAllowlistLog;
        // (1) Hot IP survived — the core true-LRU contract.
        expect(internal.has("10.9.9.9")).toBe(true);
        // (2) Capacity was enforced. Without this assertion the test
        //     would pass even if the LRU map grew unbounded (all 5000
        //     cold IPs retained), which is the exact regression the
        //     capacity-bound is meant to prevent. The hard cap is 1000
        //     (see ALLOWLIST_LOG_MAX_ENTRIES in src/ip-limiter.ts); we
        //     asserted the same bound in the earlier "internal map
        //     must not grow past a sane cap" test, so pin it here too.
        expect(internal.size).toBeLessThanOrEqual(1000);
        // (3) Eviction actually happened. With 5000 distinct cold IPs
        //     inserted and a 1000-entry cap, the map must have dropped
        //     at least 4000 entries. Asserting strict `< insertedTotal`
        //     catches "eviction code path never ran" while the cap
        //     assertion above catches "eviction ran but didn't keep the
        //     size bounded". Together they pin the full contract.
        const insertedColdCount = 5000;
        expect(internal.size).toBeLessThan(insertedColdCount);
      } finally {
        vi.useRealTimers();
        infoSpy.mockRestore();
      }
    });
  });

  describe("CIDR with non-zero host bits", () => {
    it("warns and normalizes 10.0.0.1/24 to the network address 10.0.0.0/24", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const allow = new IpSessionLimiter(2, {
          // Operator typo / confusion: "10.0.0.1/24" means the whole /24,
          // not just 10.0.0.1. Must emit a warning so misconfig is visible.
          allowlist: ["10.0.0.1/24"],
        });
        // Network-wide coverage applies (operator's likely intent).
        expect(allow.isAllowlisted("10.0.0.50")).toBe(true);
        expect(allow.isAllowlisted("10.0.0.250")).toBe(true);
        // A warning with identifying detail was emitted.
        const warns = warnSpy.mock.calls.filter((c: unknown[]) => {
          const msg = String(c[0]);
          return msg.includes("10.0.0.1/24") && msg.includes("host bits");
        });
        expect(warns.length).toBe(1);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("accepts properly-formed CIDR without warning", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        new IpSessionLimiter(2, { allowlist: ["10.0.0.0/24"] });
        const hostBitWarns = warnSpy.mock.calls.filter((c: unknown[]) =>
          String(c[0]).includes("host bits"),
        );
        expect(hostBitWarns.length).toBe(0);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe("IPv4 loopback does NOT implicitly cover IPv6 ::1", () => {
    // Documented non-auto-expand behavior. An operator who writes 127.0.0.0/8
    // intending "all loopback" must ALSO add ::1/128 for native IPv6 loopback.
    // We deliberately don't auto-expand because magic could mask operator
    // intent in other configurations.
    it("127.0.0.0/8 does not match ::1", () => {
      const allow = new IpSessionLimiter(1, {
        allowlist: ["127.0.0.0/8"],
      });
      expect(allow.isAllowlisted("127.0.0.1")).toBe(true);
      // ::1 is a distinct address family, not covered by the IPv4 range.
      expect(allow.isAllowlisted("::1")).toBe(false);
    });

    it("operator can opt-in to IPv6 loopback by adding ::1/128 explicitly", () => {
      const allow = new IpSessionLimiter(1, {
        allowlist: ["127.0.0.0/8", "::1/128"],
      });
      expect(allow.isAllowlisted("127.0.0.1")).toBe(true);
      expect(allow.isAllowlisted("::1")).toBe(true);
    });
  });

  describe("IPv4-mapped IPv6 CIDR with prefix > 32 after normalization", () => {
    // Regression guard for the CIDR-normalization path: ipaddr.parseCIDR on
    // "::ffff:10.0.0.0/104" returns [IPv6, 104]. normalizeMapped collapses
    // the address to IPv4 10.0.0.0, but if we then call
    // IPv4.networkAddressFromCIDR("10.0.0.0/104") it throws (IPv4 max
    // prefix is /32). Fix: subtract 96 from the prefix when collapsing the
    // mapped form, so /104 → /8 (the IPv4 portion of the original prefix).
    it("accepts ::ffff:10.0.0.0/104 and treats it as IPv4 10.0.0.0/8", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const allow = new IpSessionLimiter(1, {
          allowlist: ["::ffff:10.0.0.0/104"],
        });
        // Plain IPv4 request matches the collapsed /8.
        expect(allow.isAllowlisted("10.0.0.1")).toBe(true);
        expect(allow.isAllowlisted("10.255.255.255")).toBe(true);
        // IPv4-mapped IPv6 form of the same request matches too.
        expect(allow.isAllowlisted("::ffff:10.0.0.1")).toBe(true);
        // Outside /8 does not match.
        expect(allow.isAllowlisted("11.0.0.1")).toBe(false);
        // No "invalid allowlist entry" warning should have fired.
        const invalidWarns = warnSpy.mock.calls.filter((c: unknown[]) =>
          String(c[0]).includes("ignoring invalid allowlist entry"),
        );
        expect(invalidWarns.length).toBe(0);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("rejects ::ffff:a.b.c.d/<=96 (does not map cleanly to IPv4 space)", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const allow = new IpSessionLimiter(1, {
          // Prefix /64 covers a huge block of IPv6 that extends beyond the
          // mapped IPv4 region. Refuse rather than silently approximate.
          allowlist: ["::ffff:10.0.0.0/64"],
        });
        // The entry was rejected — no IP should match it.
        expect(allow.isAllowlisted("10.0.0.1")).toBe(false);
        expect(allow.isAllowlisted("::ffff:10.0.0.1")).toBe(false);
        // A warning explaining the rejection must have fired.
        const rejectWarns = warnSpy.mock.calls.filter((c: unknown[]) =>
          String(c[0]).includes("::ffff:10.0.0.0/64"),
        );
        expect(rejectWarns.length).toBeGreaterThanOrEqual(1);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe("maybeLogBypass normalizes IP before cooldown lookup", () => {
    // A dual-stack client alternating between "127.0.0.1" and
    // "::ffff:127.0.0.1" must share ONE cooldown slot, not two — otherwise
    // the log throttle is halved and the LRU map wastes slots on what is
    // really the same physical client.
    it("shares a cooldown slot across plain and IPv4-mapped forms", () => {
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        const allow = new IpSessionLimiter(1, {
          allowlist: ["127.0.0.0/8"],
        });
        allow.tryAdd("::ffff:127.0.0.1", "sess-a");
        allow.tryAdd("127.0.0.1", "sess-b");
        // Only one info log for these two calls — second must be throttled.
        const loopbackCalls = infoSpy.mock.calls.filter((c: unknown[]) =>
          String(c[0]).includes("127.0.0.1"),
        );
        expect(loopbackCalls.length).toBe(1);
        // The cooldown map itself should only have one entry for this client.
        const internal = (
          allow as unknown as { lastAllowlistLog: Map<string, number> }
        ).lastAllowlistLog;
        expect(internal.size).toBe(1);
      } finally {
        infoSpy.mockRestore();
      }
    });
  });

  describe("tryAddWithReason: discriminated union result", () => {
    it("returns { ok: true } on success", () => {
      const l = new IpSessionLimiter(2);
      const r: TryAddResult = l.tryAddWithReason("1.2.3.4", "sid-1");
      expect(r.ok).toBe(true);
    });

    it("returns { ok: false, reason: 'rate-limit' } when cap hit", () => {
      const l = new IpSessionLimiter(1);
      l.tryAddWithReason("1.2.3.4", "sid-1");
      const r = l.tryAddWithReason("1.2.3.4", "sid-2");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("rate-limit");
    });

    it("returns { ok: false, reason: 'sid-collision' } when sid re-used from a different IP", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const l = new IpSessionLimiter(5);
        l.tryAddWithReason("1.2.3.4", "sid-shared");
        const r = l.tryAddWithReason("5.6.7.8", "sid-shared");
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe("sid-collision");
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("returns { ok: true } when the same sid is re-added from the SAME IP (idempotent)", () => {
      const l = new IpSessionLimiter(5);
      l.tryAddWithReason("1.2.3.4", "sid-same");
      const r = l.tryAddWithReason("1.2.3.4", "sid-same");
      expect(r.ok).toBe(true);
    });

    it("returns { ok: true } for allowlisted traffic regardless of cap", () => {
      const l = new IpSessionLimiter(1, { allowlist: ["10.0.0.0/8"] });
      expect(l.tryAddWithReason("10.1.2.3", "a").ok).toBe(true);
      expect(l.tryAddWithReason("10.1.2.3", "b").ok).toBe(true);
      expect(l.tryAddWithReason("10.1.2.3", "c").ok).toBe(true);
    });

    it("tryAdd (boolean) delegates to tryAddWithReason and preserves existing contract", () => {
      const l = new IpSessionLimiter(1);
      expect(l.tryAdd("1.2.3.4", "sid-1")).toBe(true);
      expect(l.tryAdd("1.2.3.4", "sid-2")).toBe(false);
    });
  });

  describe("sid-collision warn log does not leak full session id", () => {
    // Session ids are bearer-equivalent; logs shipped to stdout/aggregators
    // should mask them. /messages handler already masks to sid.slice(0, 8);
    // mirror that discipline here.
    it("masks the sessionId in the re-added-from-different-IP warning", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const fullSid = "session-abcdef0123456789-secret-token";
        const l = new IpSessionLimiter(5);
        l.tryAdd("1.2.3.4", fullSid);
        l.tryAdd("5.6.7.8", fullSid);
        const collisionWarns = warnSpy.mock.calls.filter((c: unknown[]) =>
          String(c[0]).includes("re-added from different IP"),
        );
        expect(collisionWarns.length).toBe(1);
        const msg = String(collisionWarns[0][0]);
        // Must NOT contain the full sid.
        expect(msg).not.toContain(fullSid);
        // Must contain only the 8-char masked prefix.
        expect(msg).toContain(fullSid.slice(0, 8));
      } finally {
        warnSpy.mockRestore();
      }
    });
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
