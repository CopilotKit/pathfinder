// Pure URL policy validator for OAuth client redirect_uris.
//
// Rules (spec §2):
// - Length ≤ 2048 chars.
// - Scheme `https` (any host) OR `http`/`https` on loopback
//   (`localhost`, `[::1]`, anything in `127.0.0.0/8` except the
//   network address `127.0.0.0`).
// - Reject the full `0.0.0.0/8` (RFC 6890 "this network"), `[::]`,
//   RFC1918 IPv4 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`),
//   link-local `169.254.0.0/16`, the loopback network address
//   `127.0.0.0`, IPv6 link-local `fe80::/10`, IPv6 ULA `fc00::/7`,
//   IPv4-mapped IPv6 (`::ffff:a.b.c.d`) whose embedded address falls
//   in any rejected range.
// - Reject hostnames containing `*`, `..`, or empty labels.
// - Reject userinfo (`url.username !== ""` or `url.password !== ""`).
// - Reject fragments (`url.hash !== ""`).
// - Reject explicit port outside `1–65535`.
// - No DNS resolution by design — a pure policy check.
//
// Boundary discipline: IPv6 link-local fe80::/10 uses precise prefix
// matching `(v & 0xffc0) === 0xfe80` (not a regex) so fea0:: (10th bit=0)
// is NOT misclassified as link-local while febf:: IS (10th bit in range).
//
// Note on Node URL normalization quirks driving this code:
// - `url.hostname` for an IPv6 literal RETAINS the brackets (e.g.
//   `[::1]`), unlike most documentation suggests.
// - Node compresses `::ffff:10.0.0.1` → `::ffff:a00:1`, so IPv4-mapped
//   detection must support BOTH the dotted form AND the hex form (the
//   last 32 bits being `ffff:XXXX:YYYY`).

import { isIPv4 } from "node:net";

const MAX_URI_LEN = 2048;
const MAX_URIS = 10;

export type PolicyResult = { ok: true } | { ok: false; reason: string };
export type PolicyArrayResult =
    | { ok: true }
    | { ok: false; reason: string; index: number };

/**
 * Loopback hosts get the http-scheme exception. The literal forms
 * `localhost` and `[::1]` are matched directly; for IPv4 the entire
 * `127.0.0.0/8` range is loopback per RFC 6890, EXCEPT the network
 * address `127.0.0.0` itself, which is treated as a private address and
 * rejected.
 */
function isLoopbackHost(host: string): boolean {
    const lower = host.toLowerCase();
    if (lower === "localhost" || lower === "[::1]") return true;
    // Defensive: Node's `url.hostname` keeps brackets around IPv6
    // literals, but accept the bracketless form too in case a caller
    // passes a pre-normalized value.
    if (lower === "::1") return true;
    if (!isIPv4(host)) return false;
    // 127.0.0.0/8 is loopback, but 127.0.0.0 is the network address —
    // reject it as private, not loopback.
    if (host === "127.0.0.0") return false;
    return host.split(".")[0] === "127";
}

function isPrivateIPv4(ip: string): boolean {
    const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return false;
    const a = parseInt(m[1]!, 10);
    const b = parseInt(m[2]!, 10);
    // 0.0.0.0/8 — RFC 6890 "this network". Reject the entire /8, not
    // just the literal 0.0.0.0.
    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    // 127.0.0.0 is the loopback network address — not a usable host.
    if (ip === "127.0.0.0") return true;
    return false;
}

/**
 * Numeric prefix tests so the regex doesn't drift on Node's URL
 * normalization. `host` is the bracketed IPv6 form returned by
 * `url.hostname` (e.g. `[fe80::1]`).
 * - fe80::/10 → first 16-bit group v satisfies (v & 0xffc0) === 0xfe80
 * - fc00::/7  → first 16-bit group v satisfies (v & 0xfe00) === 0xfc00
 * Catches fe80..febf as link-local; fea0:: must NOT match (10th bit = 0).
 *
 * Also detects IPv4-mapped IPv6 (`::ffff:a.b.c.d` or its hex-compressed
 * cousin `::ffff:XXXX:YYYY`) whose embedded address falls in any
 * rejected IPv4 range.
 */
function isPrivateIPv6(host: string): boolean {
    if (host === "[::]") return true;
    const inner = host.replace(/^\[|\]$/g, "").toLowerCase();

    // IPv4-mapped form with dotted suffix: ::ffff:a.b.c.d
    const dotted = inner.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) {
        const v4 = dotted[1]!;
        return isPrivateIPv4(v4) || v4 === "0.0.0.0";
    }

    // IPv4-mapped form with hex suffix: ::ffff:XXXX:YYYY (Node's
    // normalized form for ::ffff:a.b.c.d). The last two 16-bit groups
    // encode the IPv4 address as 4 hex bytes.
    const hexMapped = inner.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped) {
        const hi = parseInt(hexMapped[1]!, 16);
        const lo = parseInt(hexMapped[2]!, 16);
        if (Number.isFinite(hi) && Number.isFinite(lo)) {
            const a = (hi >> 8) & 0xff;
            const b = hi & 0xff;
            const c = (lo >> 8) & 0xff;
            const d = lo & 0xff;
            const v4 = `${a}.${b}.${c}.${d}`;
            return isPrivateIPv4(v4) || v4 === "0.0.0.0";
        }
    }

    const seg0 = inner.split(":")[0] ?? "";
    if (seg0.length === 0) return false;
    const v = parseInt(seg0, 16);
    if (!Number.isFinite(v)) return false;
    if ((v & 0xffc0) === 0xfe80) return true; // fe80::/10
    if ((v & 0xfe00) === 0xfc00) return true; // fc00::/7
    return false;
}

export function validateRedirectUri(uri: string): PolicyResult {
    if (typeof uri !== "string" || uri.length === 0) {
        return { ok: false, reason: "empty" };
    }
    if (uri.length > MAX_URI_LEN) return { ok: false, reason: "too_long" };

    let url: URL;
    try {
        url = new URL(uri);
    } catch {
        return { ok: false, reason: "parse" };
    }

    if (url.username !== "" || url.password !== "") {
        return { ok: false, reason: "userinfo" };
    }
    if (url.hash !== "") return { ok: false, reason: "fragment" };

    const host = url.hostname; // IPv6 keeps brackets (e.g. "[::1]")
    if (host.length === 0) return { ok: false, reason: "empty_label" };
    if (host.includes("*")) return { ok: false, reason: "wildcard" };

    // Empty-label check is only meaningful for hostnames (not IPv6 literals).
    if (!host.startsWith("[")) {
        const labels = host.split(".");
        if (labels.length > 1 && labels.some((l) => l.length === 0)) {
            return { ok: false, reason: "empty_label" };
        }
    }

    if (url.port !== "") {
        const p = parseInt(url.port, 10);
        if (!Number.isInteger(p) || p < 1 || p > 65535) {
            return { ok: false, reason: "port" };
        }
    }

    const scheme = url.protocol.replace(/:$/, "");
    const isLoopback = isLoopbackHost(host);
    if (scheme === "https") {
        // ok for any host EXCEPT private space (checked below)
    } else if (scheme === "http") {
        if (!isLoopback) return { ok: false, reason: "scheme" };
    } else {
        return { ok: false, reason: "scheme" };
    }

    if (!isLoopback) {
        if (host.startsWith("[")) {
            if (isPrivateIPv6(host)) {
                return { ok: false, reason: "private_address" };
            }
        } else if (isIPv4(host) && isPrivateIPv4(host)) {
            return { ok: false, reason: "private_address" };
        }
    }

    return { ok: true };
}

export function validateRedirectUris(list: string[]): PolicyArrayResult {
    if (!Array.isArray(list) || list.length === 0) {
        return { ok: false, reason: "empty", index: 0 };
    }
    if (list.length > MAX_URIS) {
        return { ok: false, reason: "too_many_uris", index: MAX_URIS };
    }
    for (let i = 0; i < list.length; i++) {
        const r = validateRedirectUri(list[i]!);
        if (!r.ok) return { ok: false, reason: r.reason, index: i };
    }
    return { ok: true };
}
