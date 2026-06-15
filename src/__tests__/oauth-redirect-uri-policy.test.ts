import { describe, it, expect } from "vitest";
import {
  validateRedirectUri,
  validateRedirectUris,
} from "../oauth/redirect-uri-policy.js";

describe("validateRedirectUri — accepts", () => {
  it.each([
    "https://example.com/cb",
    "https://sub.example.com/cb?x=1",
    "http://localhost:3000/cb",
    "http://127.0.0.1/cb",
    "http://[::1]:8080/cb",
    "https://localhost:3000/cb",
    // fe80::/10 upper boundary: fe80..febf are link-local, fec0 is NOT.
    // Policy must NOT reject fec0:: as link-local. (Other reasons may
    // apply in a stricter future policy, but per spec §2 only the
    // explicit private/link-local/ULA ranges are rejected for IPv6.)
    // NOTE: the plan listed `fea0::` here, but fea0 IS within fe80::/10
    // — fe80 (1111 1110 10) and fea0 (1111 1110 10) share the same /10
    // prefix. The correct outside-boundary value is fec0::.
    "https://[fec0::1]/",
  ])("%s", (uri) => {
    expect(validateRedirectUri(uri)).toEqual({ ok: true });
  });
});

describe("validateRedirectUri — rejects", () => {
  it.each<[string, string]>([
    ["not a url", "parse"],
    ["ftp://example.com/", "scheme"],
    ["http://example.com/", "scheme"],
    ["https://0.0.0.0/", "private_address"],
    ["https://[::]/", "private_address"],
    ["https://10.0.0.1/", "private_address"],
    ["https://172.16.5.4/", "private_address"],
    ["https://192.168.1.1/", "private_address"],
    ["https://169.254.169.254/", "private_address"],
    ["https://[fe80::1]/", "private_address"],
    // fe80::/10 upper boundary: febf:: IS link-local (10th bit still in range).
    ["https://[febf::1]/", "private_address"],
    ["https://[fc00::1]/", "private_address"],
    ["https://[fd00::1]/", "private_address"],
    ["https://[::ffff:10.0.0.1]/", "private_address"],
    ["https://*.example.com/cb", "wildcard"],
    ["https://foo..bar.com/cb", "empty_label"],
    ["https://user:pass@example.com/cb", "userinfo"],
    ["https://example.com/cb#frag", "fragment"],
    ["https://example.com:0/", "port"],
    ["https://example.com:99999/", "parse"],
    ["https://" + "a".repeat(2100) + ".com/", "too_long"],
  ])("%s → %s", (uri, reason) => {
    const r = validateRedirectUri(uri);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(reason);
  });

  it("rejects empty string", () => {
    const r = validateRedirectUri("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("empty");
  });
});

describe("0.0.0.0/8 (RFC 6890 'this network')", () => {
  it.each(["0.0.0.0", "0.0.0.1", "0.1.2.3", "0.255.255.254"])(
    "rejects https://%s/",
    (ip) => {
      const r = validateRedirectUri(`https://${ip}/`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("private_address");
    },
  );
});

describe("127.0.0.0/8 (loopback)", () => {
  it.each(["127.0.0.1", "127.0.0.2", "127.255.255.254"])(
    "accepts http://%s/ (loopback over http)",
    (ip) => {
      const r = validateRedirectUri(`http://${ip}/`);
      expect(r.ok).toBe(true);
    },
  );
  it.each(["127.0.0.1", "127.0.0.2"])(
    "accepts https://%s/ (loopback over https)",
    (ip) => {
      const r = validateRedirectUri(`https://${ip}/`);
      expect(r.ok).toBe(true);
    },
  );
  it("rejects http://127.0.0.0/ (network address, not loopback)", () => {
    const r = validateRedirectUri("http://127.0.0.0/");
    expect(r.ok).toBe(false);
  });
  it("rejects https://127.0.0.0/ as private_address (network address)", () => {
    const r = validateRedirectUri("https://127.0.0.0/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("private_address");
  });
});

describe("validateRedirectUris (array)", () => {
  it("accepts up to 10", () => {
    const uris = Array.from(
      { length: 10 },
      (_, i) => `https://example.com/cb${i}`,
    );
    expect(validateRedirectUris(uris)).toEqual({ ok: true });
  });

  it("rejects 11", () => {
    const uris = Array.from(
      { length: 11 },
      (_, i) => `https://example.com/cb${i}`,
    );
    const r = validateRedirectUris(uris);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_many_uris");
  });

  it("reports first bad index", () => {
    const r = validateRedirectUris(["https://ok.com/", "https://*.bad/"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.index).toBe(1);
      expect(r.reason).toBe("wildcard");
    }
  });

  it("rejects empty array", () => {
    const r = validateRedirectUris([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("empty");
  });
});
