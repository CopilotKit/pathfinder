import { describe, expect, it } from "vitest";
import { scanSensitivity } from "../atlas/adapters/sensitivity-scan.js";

// Unit tests for the SHARED first-pass sensitivity scan regexes. The adapter
// suites (memory/github/linear/notion) pin each caller's wiring; this file
// pins the regex semantics themselves — in particular the plural forms of the
// customer-identifying GTM alternatives, where a singular-only `\b` match
// would under-flag in the LEAK direction ("named customers" / "account names"
// are exactly as identifying as their singular forms). memory.ts consumes
// this scan with pinned behavior, so the plural escalations asserted here
// also stand in for the memory-side "account names" check (escalation-only:
// the widening can only flag MORE, never downgrade).

describe("scanSensitivity (shared regexes)", () => {
  describe("customer-identifying GTM signals → proprietary", () => {
    it("flags the SINGULAR alternatives (pinned behavior)", () => {
      expect(scanSensitivity("note", "", "our named customer Acme")).toBe(
        "proprietary",
      );
      expect(scanSensitivity("note", "", "the account name is recorded")).toBe(
        "proprietary",
      );
      expect(
        scanSensitivity("note", "", "customer-identifying details inside"),
      ).toBe("proprietary");
    });

    it("flags the PLURAL alternatives — 'named customers' must not under-flag", () => {
      expect(
        scanSensitivity("note", "", "the named customers in this cohort"),
      ).toBe("proprietary");
    });

    it("flags the PLURAL alternatives — 'account names' must not under-flag", () => {
      // Also the memory-side carry: memory.ts consumes this scan unchanged.
      expect(scanSensitivity("note", "", "our account names list")).toBe(
        "proprietary",
      );
    });

    it("flags commercial GTM vocabulary", () => {
      expect(scanSensitivity("note", "", "the contract value doubled")).toBe(
        "proprietary",
      );
    });
  });

  describe("credential-VALUE signals → secret", () => {
    it("flags an assignment-shaped api key", () => {
      expect(scanSensitivity("note", "", "api_key=abc123")).toBe("secret");
    });

    it("flags an assignment-shaped password", () => {
      expect(scanSensitivity("note", "", "password=hunter2")).toBe("secret");
    });

    it("flags a PEM private-key block", () => {
      expect(
        scanSensitivity(
          "note",
          "",
          "-----BEGIN RSA PRIVATE KEY-----\nMIIEow…\n-----END RSA PRIVATE KEY-----",
        ),
      ).toBe("secret");
    });

    it("flags a long opaque value after a bare token assignment", () => {
      expect(
        scanSensitivity("note", "", "token: AbCdEfGhIjKlMnOpQrStUvWx"),
      ).toBe("secret");
    });
  });

  // ADVERSARIAL near-miss block (S18). The module docstring claims it catches
  // "an embedded API key / token / password / private-key block". The
  // assignment-shaped patterns above catch `key=…` forms, but a credential can
  // also arrive WITHOUT an assignment: inside an `Authorization: Bearer …`
  // header, or as a bare high-entropy provider token (`ghp_…`, `sk-…`, an AWS
  // `AKIA…` id). Those are the SAME class of embedded raw credential and must
  // ALSO escalate to `secret` — not slip to `internal` and dodge the
  // DEFAULT_EXCLUSION_RULES layer. These are near-misses: the leak vector is a
  // real credential the detector previously recognized only in canonical
  // assignment shape. All escalate-only (can never downgrade).
  describe("adversarial near-miss credentials → secret (S18)", () => {
    it("flags a Bearer token in an Authorization header (no assignment)", () => {
      // A JWT-shaped bearer credential — the classic API-request carrier. No
      // `key=`/`token=` assignment, so the assignment patterns miss it.
      expect(
        scanSensitivity(
          "note",
          "",
          "curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVC.payloadpart.signaturepart'",
        ),
      ).toBe("secret");
    });

    it("flags a bare 'Bearer <opaque>' credential outside a header", () => {
      expect(
        scanSensitivity(
          "note",
          "",
          "auth with Bearer AbCdEf0123456789GhIjKlMn",
        ),
      ).toBe("secret");
    });

    it("flags a bare provider PAT prefix (embedded raw credential)", () => {
      // Constructed so the literal never appears in prose analysis tooling.
      const pat = "g" + "hp_" + "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
      expect(scanSensitivity("note", "", `deploy key ${pat} rotate soon`)).toBe(
        "secret",
      );
    });

    it("flags a bare 'sk-' provider secret-key prefix", () => {
      const sk = "sk-" + "proj-" + "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
      expect(scanSensitivity("note", "", `using ${sk} for calls`)).toBe(
        "secret",
      );
    });

    it("flags a bare AWS access-key id (AKIA…)", () => {
      const akia = "AKIA" + "IOSFODNN7EXAMPLE";
      expect(scanSensitivity("note", "", `${akia} is our access key`)).toBe(
        "secret",
      );
    });

    it("flags a private-key block regardless of the key-type header variant", () => {
      // EC / OPENSSH variants, not just RSA — the fence is the credential.
      expect(
        scanSensitivity(
          "note",
          "",
          "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----",
        ),
      ).toBe("secret");
    });

    it("does NOT over-flag ordinary prose that merely says 'bearer' or 'aws'", () => {
      // Guard the escalate-only patterns against benign prose: "bearer" without
      // an opaque credential value, and "AWS" without an AKIA id, stay internal.
      expect(
        scanSensitivity("note", "", "the bearer of this note is friendly"),
      ).toBe("internal");
      expect(
        scanSensitivity("note", "", "we deploy our app on AWS every week"),
      ).toBe("internal");
    });

    it("does NOT over-flag a short bearer word followed by a normal token", () => {
      // A capitalized 'Bearer' in prose followed by a short word must not trip
      // the header pattern (requires an opaque, credential-length value).
      expect(scanSensitivity("note", "", "Bearer bonds are a thing")).toBe(
        "internal",
      );
    });
  });

  describe("default / opt-in behavior (pinned)", () => {
    it("keeps ordinary prose at internal", () => {
      expect(
        scanSensitivity("note", "", "make the tests pass: run vitest"),
      ).toBe("internal");
    });

    it("does NOT escalate a bare credential MENTION by default", () => {
      expect(scanSensitivity("note", "", "rotate the API keys")).toBe(
        "internal",
      );
    });

    it("escalates a bare credential MENTION when the caller opts in", () => {
      expect(
        scanSensitivity("note", "", "rotate the API keys", {
          bareCredentialMentions: true,
        }),
      ).toBe("secret");
    });

    it("strips SAFE op:// pointers before the credential scan", () => {
      expect(
        scanSensitivity("note", "", "see op://Vault/Item/api_token= here"),
      ).toBe("internal");
    });
  });
});
