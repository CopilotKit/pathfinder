import ipaddr from "ipaddr.js";

/**
 * An allowlist entry — either a plain IPv4/IPv6 address ("160.79.106.35") or
 * a CIDR range ("160.79.106.0/24", "2001:db8::/32").
 */
export type AllowlistEntry = string;

/**
 * Discriminated result of tryAddWithReason — distinguishes the per-IP cap
 * being hit from a sid-collision across IPs. Callers that need to surface
 * different 429 reasons (rate-limit exhaustion vs transport-level sid reuse)
 * should switch on `reason`. The legacy boolean `tryAdd` wraps this and
 * returns `result.ok`.
 */
export type TryAddResult =
  | { ok: true }
  | { ok: false; reason: "rate-limit" | "sid-collision" };

export interface IpSessionLimiterOptions {
  /**
   * IPs / CIDR ranges that bypass the per-IP session cap entirely.
   * Allowlisted sessions are NOT tracked in the per-IP counters.
   *
   * Use sparingly — intended for trusted crawlers (e.g. the Anthropic
   * Assistant crawler 160.79.106.35) and internal health probes.
   */
  allowlist?: AllowlistEntry[];
}

type ParsedAllowlist = Array<
  | { kind: "ip"; addr: ipaddr.IPv4 | ipaddr.IPv6 }
  | { kind: "cidr"; range: [ipaddr.IPv4 | ipaddr.IPv6, number] }
>;

/**
 * Normalize an IPv4-mapped IPv6 address (e.g. ::ffff:127.0.0.1) to its IPv4
 * form. Node's dual-stack sockets often report remote addresses in the mapped
 * form; operators naturally write either form in YAML. Collapse to IPv4 up
 * front so family comparisons later are consistent.
 */
function normalizeMapped(
  addr: ipaddr.IPv4 | ipaddr.IPv6,
): ipaddr.IPv4 | ipaddr.IPv6 {
  if (addr.kind() === "ipv6") {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) return v6.toIPv4Address();
  }
  return addr;
}

/**
 * Normalize an IP string to its canonical form for use as a Map key.
 * Specifically collapses IPv4-mapped IPv6 (::ffff:a.b.c.d) to IPv4 so that
 * dual-stack bindings which sometimes emit the mapped form and sometimes the
 * plain form don't double-bucket the same physical client (which would
 * silently double the per-IP cap).
 *
 * Non-parseable inputs (e.g. "unknown" from clientIp(), empty string) are
 * returned unchanged to preserve existing fall-through bucketing.
 */
function normalizeIp(ip: string): string {
  try {
    const parsed = ipaddr.parse(ip);
    return normalizeMapped(parsed).toNormalizedString();
  } catch {
    return ip;
  }
}

/**
 * Parse allowlist entries once at construction time. Invalid entries are
 * logged and skipped — schema validation in src/types.ts is the primary
 * gate, but we belt-and-suspenders here so a bad entry can't crash the
 * limiter at request time.
 *
 * Correctness notes for operators reading this:
 *   - IPv4 entries match IPv4 requests only and IPv6 entries match IPv6
 *     requests only. `127.0.0.0/8` does NOT cover native `::1` requests;
 *     if you want both loopback families, allowlist both `127.0.0.0/8` and
 *     `::1/128` explicitly. We deliberately do NOT auto-expand — magic could
 *     mask operator intent in non-loopback configurations.
 *   - CIDR entries with non-zero host bits (e.g. `10.0.0.1/24`) are accepted
 *     and normalized to the network address (`10.0.0.0/24`) with a warning.
 *     The entry still matches the whole /24; the warning exists so an
 *     operator who meant "just 10.0.0.1" can fix the typo.
 *
 * If EVERY provided entry fails to parse, escalate from per-entry warn to a
 * summary error — an "allowlist effectively disabled" state silently turns
 * the rate limiter on for IPs the operator explicitly meant to exempt.
 */
function parseAllowlist(entries: AllowlistEntry[]): ParsedAllowlist {
  const out: ParsedAllowlist = [];
  let invalidCount = 0;
  for (const entry of entries) {
    try {
      if (entry.includes("/")) {
        const [addr, rawPrefix] = ipaddr.parseCIDR(entry);
        const wasMapped =
          addr.kind() === "ipv6" &&
          (addr as ipaddr.IPv6).isIPv4MappedAddress();
        const normalized = normalizeMapped(addr);
        let effectivePrefix = rawPrefix;
        // If we collapsed an IPv4-mapped IPv6 CIDR into IPv4 space, the
        // original prefix is measured in the 128-bit IPv6 space; the first
        // 96 bits are the ::ffff:0:0 mapping prefix and the last 32 bits are
        // the IPv4 portion. So "::ffff:10.0.0.0/104" = IPv4 10.0.0.0/8.
        // Prefix <= 96 covers IPv6 space beyond the mapped block, which does
        // NOT cleanly reduce to any IPv4 CIDR — reject with a warning.
        if (wasMapped && normalized.kind() === "ipv4") {
          if (rawPrefix < 96) {
            console.warn(
              `[mcp] ignoring allowlist entry ${JSON.stringify(entry)}: IPv4-mapped IPv6 CIDR prefix /${rawPrefix} is <96 and does not map cleanly to IPv4 space. If you want IPv4 coverage, use a plain IPv4 CIDR (e.g. 10.0.0.0/8).`,
            );
            invalidCount++;
            continue;
          }
          effectivePrefix = rawPrefix - 96;
        }
        // Detect non-zero host bits. ipaddr.js doesn't reject e.g.
        // "10.0.0.1/24", but an entry whose address isn't already the network
        // base is almost always an operator typo. Normalize to the network
        // address (so the match set still covers what the operator wrote) and
        // warn so the misconfig is visible.
        let effective: ipaddr.IPv4 | ipaddr.IPv6 = normalized;
        const networkBase =
          normalized.kind() === "ipv4"
            ? ipaddr.IPv4.networkAddressFromCIDR(`${normalized.toNormalizedString()}/${effectivePrefix}`)
            : ipaddr.IPv6.networkAddressFromCIDR(`${normalized.toNormalizedString()}/${effectivePrefix}`);
        if (
          normalized.toNormalizedString() !== networkBase.toNormalizedString()
        ) {
          console.warn(
            `[mcp] allowlist entry ${JSON.stringify(entry)} has non-zero host bits — normalizing to ${networkBase.toNormalizedString()}/${effectivePrefix}. If you meant a single host, drop the /${effectivePrefix} suffix.`,
          );
          effective = networkBase;
        }
        out.push({ kind: "cidr", range: [effective, effectivePrefix] });
      } else {
        out.push({ kind: "ip", addr: normalizeMapped(ipaddr.parse(entry)) });
      }
    } catch (err) {
      invalidCount++;
      console.warn(
        `[mcp] ignoring invalid allowlist entry ${JSON.stringify(entry)}: ${String(err)}`,
      );
    }
  }
  if (entries.length > 0 && out.length === 0) {
    // All-invalid is a correctness cliff: the allowlist is now EMPTY, so
    // traffic the operator meant to exempt (e.g. crawler IPs) will be
    // rate-limited instead. Escalate to error — do not fail startup because
    // the deployment may still want to come up with degraded protection.
    console.error(
      `[mcp] ERROR: ${invalidCount} of ${entries.length} allowlist entries failed to parse — allowlist is now EMPTY, rate limiting will apply to every IP including the ones you intended to allowlist. Check YAML config.`,
    );
  }
  return out;
}

/** Info log is throttled per IP to avoid flooding on repeated bypasses. */
const ALLOWLIST_LOG_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
/**
 * Cap on the cooldown-log map size. Without a cap, a large CIDR allowlist
 * (e.g. 10.0.0.0/8) combined with diverse source IPs could grow the map to
 * millions of entries over the process lifetime.
 */
const ALLOWLIST_LOG_MAX_ENTRIES = 1000;

export class IpSessionLimiter {
  private maxPerIp: number;
  private ipToSessions = new Map<string, Set<string>>();
  private sessionToIp = new Map<string, string>();
  private allowlist: ParsedAllowlist;
  private lastAllowlistLog = new Map<string, number>();

  constructor(maxPerIp: number, options: IpSessionLimiterOptions = {}) {
    // Defense-in-depth: the upstream Zod schema already requires
    // max_sessions_per_ip to be a positive integer, but IpSessionLimiter is a
    // public export — a direct consumer could still hand in 0, a negative
    // number, NaN, or a fraction. Accepting those silently turns tryAdd() into
    // "reject every non-allowlisted session" (cap check `sessions.size >= 0`
    // fails immediately) with no signal — indistinguishable from a DoS. Fail
    // loudly at construction so misuse is visible.
    if (!Number.isInteger(maxPerIp) || maxPerIp < 1) {
      throw new TypeError(
        `IpSessionLimiter: maxPerIp must be a positive integer (got ${String(maxPerIp)})`,
      );
    }
    this.maxPerIp = maxPerIp;
    this.allowlist = parseAllowlist(options.allowlist ?? []);
  }

  /**
   * True when the given IP matches any allowlist entry. Returns false for
   * unknown / malformed inputs (e.g. "unknown" from clientIp()).
   */
  isAllowlisted(ip: string): boolean {
    if (!ip || this.allowlist.length === 0) return false;
    let parsed: ipaddr.IPv4 | ipaddr.IPv6;
    try {
      parsed = ipaddr.parse(ip);
    } catch {
      return false;
    }
    parsed = normalizeMapped(parsed);
    for (const entry of this.allowlist) {
      if (entry.kind === "ip") {
        if (entry.addr.kind() !== parsed.kind()) continue;
        if (entry.addr.toNormalizedString() === parsed.toNormalizedString()) {
          return true;
        }
      } else {
        const [rangeAddr] = entry.range;
        if (rangeAddr.kind() !== parsed.kind()) continue;
        // Branch on the narrowed family — both IPv4.match and IPv6.match
        // accept the [addr, prefix] tuple; narrowing here keeps the call
        // type-safe without any `as` intersection cast. The family-match
        // guard above means .match() receives a same-family tuple and
        // cannot throw in practice, so no defensive try/catch is warranted.
        const matched =
          parsed.kind() === "ipv4"
            ? (parsed as ipaddr.IPv4).match(
                entry.range as [ipaddr.IPv4, number],
              )
            : (parsed as ipaddr.IPv6).match(
                entry.range as [ipaddr.IPv6, number],
              );
        if (matched) return true;
      }
    }
    return false;
  }

  private maybeLogBypass(ip: string): void {
    // Normalize at the map-key boundary so a dual-stack client alternating
    // between "127.0.0.1" and "::ffff:127.0.0.1" shares ONE cooldown slot
    // instead of two. Without this, the log throttle would be halved and the
    // bounded LRU map would waste entries on what is really the same
    // physical client.
    const key = normalizeIp(ip);
    const now = Date.now();
    const last = this.lastAllowlistLog.get(key) ?? 0;

    // Check cooldown FIRST. The 99% hot path for high-volume allowlisted
    // traffic (a crawler hammering the endpoint) is "already logged
    // recently, nothing to do" — that path must NOT pay the O(n) sweep.
    if (now - last < ALLOWLIST_LOG_COOLDOWN_MS) return;

    // About to actually log — now bound the map size. Sweep old entries and
    // only if the sweep didn't free space, drop the LRU-oldest entry.
    if (this.lastAllowlistLog.size >= ALLOWLIST_LOG_MAX_ENTRIES) {
      const cutoff = now - ALLOWLIST_LOG_COOLDOWN_MS * 2;
      for (const [k, v] of this.lastAllowlistLog) {
        if (v < cutoff) this.lastAllowlistLog.delete(k);
      }
      if (this.lastAllowlistLog.size >= ALLOWLIST_LOG_MAX_ENTRIES) {
        const oldest = this.lastAllowlistLog.keys().next().value;
        if (oldest !== undefined) this.lastAllowlistLog.delete(oldest);
      }
    }

    // True-LRU insertion: Map.set on an existing key does NOT reinsert at
    // the tail, so a frequently-touched entry would get evicted as cold
    // traffic churns in. Delete-then-set moves this entry to the tail, so
    // eviction (oldest key) really is least-recently-used.
    this.lastAllowlistLog.delete(key);
    this.lastAllowlistLog.set(key, now);
    console.info(`[mcp] IP ${key} on allowlist, bypassing session limit`);
  }

  /**
   * Attempt to admit a new session for the given IP.
   *
   * Returns a discriminated result so callers can distinguish per-IP cap
   * exhaustion ("rate-limit") from transport-level session id reuse across
   * IPs ("sid-collision"). Allowlisted traffic always returns `{ ok: true }`.
   *
   * Callers that only need a pass/fail signal should prefer the boolean
   * overload `tryAdd`, which delegates to this method.
   */
  tryAddWithReason(ip: string, sessionId: string): TryAddResult {
    // Allowlisted traffic bypasses the per-IP session CAP but still consumes
    // transport/session resources normally. Operators must rely on upstream
    // rate-limits or resource quotas for crawler traffic. Allowlisted
    // sessions are intentionally NOT tracked in the per-IP counter so a
    // remove() call for one of them never affects a non-allowlisted IP.
    if (this.isAllowlisted(ip)) {
      this.maybeLogBypass(ip);
      return { ok: true };
    }

    // Normalize at the map-key boundary so dual-stack dual-form (plain IPv4
    // vs ::ffff:IPv4) requests from the same physical client bucket into the
    // SAME counter. Without this, a client alternating forms would silently
    // double the per-IP cap.
    const key = normalizeIp(ip);

    // Guard against sid collision across IPs. If the caller hands us the
    // same sid twice from different source IPs, accepting the second call
    // would orphan the first IP's counter entry (remove() later cleans the
    // second IP only, leaving the first permanently inflated). Be
    // conservative: idempotent-accept on the same IP, warn + reject on a
    // different IP. Compare normalized forms so an IP reported as two
    // different forms is recognized as the same client.
    const existingIp = this.sessionToIp.get(sessionId);
    if (existingIp !== undefined) {
      if (existingIp === key) return { ok: true };
      // Session ids are bearer-equivalent secrets (whoever holds the sid can
      // drive the session). Mask to the first 8 chars — same discipline as
      // the /messages handler in sse-handlers.ts — so stdout/aggregator
      // exfiltration of logs can't escalate to session hijack.
      console.warn(
        `[mcp] session ${sessionId.slice(0, 8)} re-added from different IP (was ${existingIp}, now ${key}); ignoring`,
      );
      return { ok: false, reason: "sid-collision" };
    }

    const sessions = this.ipToSessions.get(key);
    if (sessions && sessions.size >= this.maxPerIp) {
      return { ok: false, reason: "rate-limit" };
    }

    if (!sessions) {
      this.ipToSessions.set(key, new Set([sessionId]));
    } else {
      sessions.add(sessionId);
    }
    this.sessionToIp.set(sessionId, key);
    return { ok: true };
  }

  /**
   * Boolean shim over `tryAddWithReason` — preserves the pre-R4 call
   * signature so existing callers (server.ts, sse-handlers.ts) don't have
   * to migrate in the same PR. New callers that need to distinguish
   * rate-limit exhaustion from sid-collision should prefer
   * `tryAddWithReason`.
   */
  tryAdd(ip: string, sessionId: string): boolean {
    return this.tryAddWithReason(ip, sessionId).ok;
  }

  remove(sessionId: string): void {
    const ip = this.sessionToIp.get(sessionId);
    if (!ip) return;
    this.sessionToIp.delete(sessionId);
    // `ip` here is the normalized form we stored at tryAdd() time, so no
    // re-normalization is needed. (The Map lookup is safe by key equality.)
    const sessions = this.ipToSessions.get(ip);
    if (sessions) {
      sessions.delete(sessionId);
      if (sessions.size === 0) this.ipToSessions.delete(ip);
    }
  }

  getSessionCount(ip: string): number {
    // Normalize so callers can ask about the same client in either form.
    return this.ipToSessions.get(normalizeIp(ip))?.size ?? 0;
  }

  getMax(): number {
    return this.maxPerIp;
  }
}
