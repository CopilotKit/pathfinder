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
