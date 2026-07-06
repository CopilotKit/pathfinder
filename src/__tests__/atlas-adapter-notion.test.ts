import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LLMock } from "@copilotkit/aimock";
import { notionAdapter } from "../atlas/adapters/notion.js";
import type { NotionPageUnit } from "../atlas/adapters/notion.js";
import { CandidateFragmentSchema } from "../atlas/types.js";
import { OpenAIDistiller } from "../atlas/llm.js";
import type { AdapterContext } from "../atlas/adapters/types.js";

// ── Fixture loading ───────────────────────────────────────────────────────────
// Fixtures are NotionPageUnit-shaped JSON (the structured page the Tier-1 leaf
// harness hands the adapter). The adapter is a PURE function of one unit — no
// LLM, no network — so the deterministic decision-split is fully testable here.

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "atlas",
  "notion",
);

function loadUnit(name: string): NotionPageUnit {
  const raw = readFileSync(join(FIXTURE_DIR, name), "utf8");
  return JSON.parse(raw) as NotionPageUnit;
}

// Deterministic injected clock so provenance/freshness dates are stable.
const CTX: AdapterContext = { now: new Date("2026-06-08T00:00:00.000Z") };

describe("notionAdapter", () => {
  it("conforms to the LeafAdapter contract with sourcetype notion-doc", () => {
    expect(notionAdapter.sourcetype).toBe("notion-doc");
    expect(typeof notionAdapter.extract).toBe("function");
  });

  describe("multi-decision page (ADR set)", () => {
    it("SPLITS an N-decision page into N fragments (one per ratified decision)", async () => {
      const unit = loadUnit("interrupts-proposal-design-decisions.json");
      const fragments = await notionAdapter.extract(unit, CTX);

      // The page has a Context section + 3 Decision sections → 3 fragments.
      expect(fragments).toHaveLength(3);
    });

    it("emits one distinct fragment per decision, each contract-valid", async () => {
      const unit = loadUnit("interrupts-proposal-design-decisions.json");
      const fragments = await notionAdapter.extract(unit, CTX);

      for (const f of fragments) {
        // Every fragment must validate against the S0 contract schema.
        expect(() => CandidateFragmentSchema.parse(f)).not.toThrow();
        expect(f.sourcetype).toBe("notion-doc");
        expect(f.subsystem).toBe("agui-protocol");
        // provenance.url is the Notion page URL (shared across the split).
        expect(f.provenance.url).toBe(unit.url);
        expect(f.source_name).toBe("notion-doc");
      }

      // Each fragment carries a DISTINCT distilled claim (the per-decision
      // title), proving the split is per-decision and not duplicated.
      const titles = fragments.map((f) => f.title);
      expect(new Set(titles).size).toBe(3);

      // The resume-keying decision (ROW_12_6) is among them, carrying the
      // interruptId-not-parentRunId rationale in its content.
      const resume = fragments.find((f) => /resume keying/i.test(f.title));
      expect(resume).toBeDefined();
      expect(resume?.content).toMatch(/interruptId/);
      expect(resume?.content).toMatch(/parentRunId/);
    });

    it("flags multi-decision (ADR) fragments internal + design-rationale", async () => {
      const unit = loadUnit("interrupts-proposal-design-decisions.json");
      const fragments = await notionAdapter.extract(unit, CTX);

      for (const f of fragments) {
        expect(f.provenance.classification.sensitivity).toBe("internal");
        expect(f.provenance.classification.knowledge_type).toBe(
          "design-rationale",
        );
        // A ratified design doc is a primary source (not a derived fusion).
        expect(f.provenance.classification.provenance_class).toBe("primary");
        // Notion text is not yet source-verified by this adapter.
        expect(f.provenance.classification.validation_status).toBe(
          "unverified",
        );
      }
    });

    it("attaches the page as thread evidence on each fragment", async () => {
      const unit = loadUnit("interrupts-proposal-design-decisions.json");
      const fragments = await notionAdapter.extract(unit, CTX);

      for (const f of fragments) {
        const thread = f.evidence.find((e) => e.kind === "thread");
        expect(thread).toBeDefined();
        if (thread?.kind === "thread") {
          expect(thread.body).toContain(unit.title);
        }
      }
    });

    it("lifts cited PR/issue references into linked_issue evidence", async () => {
      const unit = loadUnit("interrupts-proposal-design-decisions.json");
      const fragments = await notionAdapter.extract(unit, CTX);

      // The resume-keying decision cites ag-ui PR #1746.
      const resume = fragments.find((f) => /resume keying/i.test(f.title));
      const cited = resume?.evidence.filter((e) => e.kind === "linked_issue");
      expect(cited && cited.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("single-decision page", () => {
    it("maps a one-decision page to exactly one fragment", async () => {
      const unit = loadUnit("single-decision-rrf-ranking.json");
      const fragments = await notionAdapter.extract(unit, CTX);

      expect(fragments).toHaveLength(1);
      const [f] = fragments;
      expect(() => CandidateFragmentSchema.parse(f)).not.toThrow();
      expect(f.subsystem).toBe("search-ranking");
      expect(f.title).toMatch(/RRF|Reciprocal Rank Fusion/i);
      expect(f.content).toMatch(/Reciprocal Rank Fusion/);
      expect(f.provenance.classification.sensitivity).toBe("internal");
      expect(f.provenance.classification.knowledge_type).toBe(
        "design-rationale",
      );
    });
  });

  describe("GTM / customer-identifying page (sensitivity-careful first-pass)", () => {
    it("first-pass-flags a GTM page's fragment for later EXCLUSION", async () => {
      const unit = loadUnit("gtm-pricing-strategy.json");
      const fragments = await notionAdapter.extract(unit, CTX);

      expect(fragments.length).toBeGreaterThanOrEqual(1);
      for (const f of fragments) {
        expect(() => CandidateFragmentSchema.parse(f)).not.toThrow();
        // The whole point: a customer-identifying GTM page is flagged
        // proprietary|secret on first pass so the DEFAULT_EXCLUSION_RULES
        // (drop sensitivity:proprietary|secret + customer GTM) drop it later.
        expect(["proprietary", "secret"]).toContain(
          f.provenance.classification.sensitivity,
        );
        expect(f.provenance.classification.knowledge_type).toBe("gtm");
      }
    });

    it("treats a named-customer + revenue page as the most-restrictive (secret)", async () => {
      const unit = loadUnit("gtm-pricing-strategy.json");
      const fragments = await notionAdapter.extract(unit, CTX);

      // Customer-IDENTIFYING (named customer + contract value) escalates beyond
      // plain proprietary to secret.
      const f = fragments[0];
      expect(f.provenance.classification.sensitivity).toBe("secret");
    });

    it("escalates PLURAL credential terms to secret ('rotate the API keys')", async () => {
      // The credential alternatives must match plural forms too — "API keys",
      // "access tokens", "credentials" are exactly as customer-identifying as
      // their singular forms, and an under-flag here leaks past
      // DEFAULT_EXCLUSION_RULES (the same direction as the heading-only case).
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/plural-credentials",
        title: "ADR: Staging key rotation",
        subsystem: "ci-supply-chain",
        sections: [
          {
            heading: "Decision: Rotate the API keys quarterly",
            body: "We rotate the API keys for staging on a quarterly cadence.",
          },
        ],
      };
      const [f] = await notionAdapter.extract(unit, CTX);
      expect(f.provenance.classification.sensitivity).toBe("secret");
    });

    it("escalates the other plural credential forms (access tokens, credentials)", async () => {
      const cases = [
        "All access tokens are minted by the central issuer.",
        "The deploy credentials live in the org vault.",
        "Secret keys are rotated by the scheduler.",
      ];
      for (const body of cases) {
        const unit: NotionPageUnit = {
          url: "https://www.notion.so/copilotkit/plural-credential-forms",
          // The title must carry NO credential term itself — the plural in the
          // BODY is what must trip the escalation.
          title: "ADR: Issuance policy",
          subsystem: "ci-supply-chain",
          sections: [{ heading: "Decision: Centralize issuance", body }],
        };
        const [f] = await notionAdapter.extract(unit, CTX);
        expect(f.provenance.classification.sensitivity).toBe("secret");
      }
    });

    it("escalates the PLURAL named-party forms ('account names', 'named customers')", async () => {
      // Like the credential alternatives, the named-party alternatives must
      // match their plurals — `\baccount name\b` fails before a trailing "s",
      // and a singular-only match under-flags in the LEAK direction.
      // CUSTOMER_IDENTIFYING is the secret tier here.
      const cases = [
        "Maintain our account names list per region.",
        "The named customers in this cohort renewed early.",
      ];
      for (const body of cases) {
        const unit: NotionPageUnit = {
          url: "https://www.notion.so/copilotkit/plural-named-party-forms",
          // The title must carry NO signal itself — the plural in the BODY is
          // what must trip the escalation.
          title: "ADR: Cohort tracking",
          subsystem: "gtm-accounts",
          sections: [{ heading: "Decision: Track per region", body }],
        };
        const [f] = await notionAdapter.extract(unit, CTX);
        expect(f.provenance.classification.sensitivity).toBe("secret");
      }
    });

    it("escalates a raw credential VALUE on the page to secret (shared-scan composition)", async () => {
      // Notion's bespoke CUSTOMER_IDENTIFYING catches credential MENTIONS
      // ("api key", "access token") but has no VALUE-shaped patterns — a raw
      // assignment like `password=hunter2` or a PEM block carries the secret
      // itself yet names no credential keyword the mention regex knows. The
      // shared scanSensitivity is composed escalate-only to close that gap;
      // without it the page classifies `internal` and dodges
      // DEFAULT_EXCLUSION_RULES.
      const bodies = [
        "The temporary workaround sets password=hunter2 in the env file.",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA…\n-----END RSA PRIVATE KEY-----",
      ];
      for (const body of bodies) {
        const unit: NotionPageUnit = {
          url: "https://www.notion.so/copilotkit/raw-credential-value",
          // No credential MENTION anywhere — only the VALUE-shaped signal in
          // the body may trip the escalation.
          title: "ADR: Staging environment bring-up",
          subsystem: "ci-supply-chain",
          sections: [{ heading: "Decision: Bootstrap staging env", body }],
        };
        const [f] = await notionAdapter.extract(unit, CTX);
        expect(f.provenance.classification.sensitivity).toBe("secret");
      }
    });

    it("flags every decision when the GTM signal lives ONLY in a non-decision Background section", async () => {
      // Non-decision sections (Background / Context / Overview) emit no
      // fragments — but they are still PAGE content. A GTM/credential signal
      // that appears only there must flag the page's decisions: the
      // classification haystack is page-wide, and the module's own doctrine is
      // to over-flag (the exclusion stage is the safety net).
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/background-gtm",
        title: "Enterprise rollout plan",
        subsystem: "gtm-accounts",
        sections: [
          {
            heading: "Background",
            body: "These notes support the go-to-market pricing push for Q3.",
          },
          {
            heading: "Decision: Standardize the tier structure",
            body: "We standardize the tier structure across the segment.",
          },
          {
            heading: "Decision: Single rollout wave",
            body: "We roll out to the whole segment in one wave.",
          },
        ],
      };
      const fragments = await notionAdapter.extract(unit, CTX);
      expect(fragments).toHaveLength(2);
      for (const f of fragments) {
        expect(["proprietary", "secret"]).toContain(
          f.provenance.classification.sensitivity,
        );
        expect(f.provenance.classification.knowledge_type).toBe("gtm");
      }
    });

    it("escalates when the GTM term appears ONLY in the section heading", async () => {
      // The heading BECOMES the persisted fragment title, so it must be part
      // of the sensitivity haystack: a GTM/credential term that appears only
      // in the heading (not the page title, not the body) must not dodge the
      // first-pass escalation — that would leak past DEFAULT_EXCLUSION_RULES.
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/heading-only-gtm",
        title: "Q3 account planning",
        subsystem: "gtm-accounts",
        sections: [
          {
            heading: "3. Acme pricing decision",
            body: "We standardize the tier structure across the segment.",
          },
        ],
      };
      const [f] = await notionAdapter.extract(unit, CTX);
      expect(["proprietary", "secret"]).toContain(
        f.provenance.classification.sensitivity,
      );
      expect(f.provenance.classification.knowledge_type).toBe("gtm");
    });
  });

  describe("title derivation edge cases", () => {
    it("strips the enumerator BEFORE the decision prefix ('1. Decision: Use X' → 'Use X')", async () => {
      // Numbered ADR entries commonly carry BOTH markers. The enumerator must
      // be stripped first so the decision-prefix strip can see (and remove)
      // the "Decision:" marker — otherwise the title (and the claim slug
      // derived from it) keeps the noise.
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/numbered-decision-prefix",
        title: "Saga concurrency proposal",
        subsystem: "agui-protocol",
        sections: [
          { heading: "1. Decision: Use X", body: "Rationale for using X." },
        ],
      };
      const [f] = await notionAdapter.extract(unit, CTX);
      expect(f.title).toBe("Use X");
    });

    it("strips the enumerator BEFORE an ADR prefix ('2) ADR 2: Use Y' → 'Use Y')", async () => {
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/numbered-adr-prefix",
        title: "Saga concurrency proposal",
        subsystem: "agui-protocol",
        sections: [
          { heading: "2) ADR 2: Use Y", body: "Rationale for using Y." },
        ],
      };
      const [f] = await notionAdapter.extract(unit, CTX);
      expect(f.title).toBe("Use Y");
    });

    it("falls back to the original heading when stripping a marker leaves an empty title", async () => {
      // A skeleton heading "Decision:" strips to "" — which would otherwise
      // produce a degenerate canonical-key slug downstream. Fall back to the
      // trimmed original heading instead.
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/skeleton-decision",
        title: "Skeleton ADR",
        subsystem: "agui-protocol",
        sections: [{ heading: "Decision:", body: "Some rationale body." }],
      };
      const [f] = await notionAdapter.extract(unit, CTX);
      expect(f.title).not.toBe("");
      expect(f.title).toBe("Decision:");
    });

    it("strips the PLURAL 'Decisions:' prefix too ('Decisions: Use X' → 'Use X')", async () => {
      // isDecisionHeading matches singular AND plural, so the title strip
      // must too — otherwise a "Decisions: Use X" heading (which IS split as
      // a decision) titles as "Decisions: Use X" with the marker noise kept.
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/plural-decisions-prefix",
        title: "Saga concurrency proposal",
        subsystem: "agui-protocol",
        sections: [
          { heading: "Decisions: Use X", body: "Rationale for using X." },
        ],
      };
      const [f] = await notionAdapter.extract(unit, CTX);
      expect(f.title).toBe("Use X");
    });
  });

  describe("knowledge-type classification (no false GTM)", () => {
    it("does NOT classify an architecture decision using 'deal with' as gtm", async () => {
      // The bare verb "deal" (as in "deal with") is ordinary architecture
      // prose, NOT a GTM commercial signal. It must not mislabel the fragment.
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/error-handling-adr",
        title: "ADR: Error propagation across the delegation chain",
        subsystem: "agui-protocol",
        sections: [
          {
            heading: "Decision: How to deal with downstream errors",
            body: "We decided to deal with downstream transport errors by surfacing them as structured RUN_ERROR events rather than swallowing them.",
          },
        ],
      };
      const [f] = await notionAdapter.extract(unit, CTX);
      expect(f.provenance.classification.knowledge_type).not.toBe("gtm");
      expect(f.provenance.classification.sensitivity).not.toBe("proprietary");
      expect(f.provenance.classification.sensitivity).not.toBe("secret");
    });
  });

  describe("decision-heading keyword screening", () => {
    it("does NOT split a context heading that merely MENTIONS 'decision' ('Background on the decision')", async () => {
      // The context screen must run BEFORE the decision-keyword test: a
      // heading that READS as context ("Background …") is page context even
      // when the word "decision" appears later in it.
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/context-mentions-decision",
        title: "Saga concurrency proposal",
        subsystem: "agui-protocol",
        sections: [
          {
            heading: "Background on the decision",
            body: "Why we had to decide anything at all.",
          },
        ],
      };
      const fragments = await notionAdapter.extract(unit, CTX);
      expect(fragments).toHaveLength(0);
    });

    it("does NOT split standard ADR non-decision sections (Alternatives Considered, Decision Drivers, …)", async () => {
      // The standard ADR template's non-decision sections must be screened as
      // context even when numbered — "4. Alternatives Considered" records the
      // REJECTED options, and harvesting it as a ratified decision is the
      // unsafe over-capture direction. "Decision Drivers" mentions "decision"
      // but is criteria, not a ratified decision; the context screen runs
      // FIRST so it never reaches the keyword test.
      const headings = [
        "4. Alternatives Considered",
        "Decision Drivers",
        "Consequences",
        "Status",
        "5. Open Questions",
        "Risks",
        "References",
        "Appendix",
      ];
      for (const heading of headings) {
        const unit: NotionPageUnit = {
          url: "https://www.notion.so/copilotkit/adr-non-decision-sections",
          title: "Saga concurrency ADR",
          subsystem: "agui-protocol",
          sections: [{ heading, body: "Some substantive prose." }],
        };
        const fragments = await notionAdapter.extract(unit, CTX);
        expect(fragments, `heading "${heading}" must not split`).toHaveLength(
          0,
        );
      }
    });

    it("STILL splits a real decision heading alongside ADR non-decision sections", async () => {
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/adr-with-alternatives",
        title: "Saga concurrency ADR",
        subsystem: "agui-protocol",
        sections: [
          { heading: "Context", body: "Why we needed to decide." },
          { heading: "Decision: Use X", body: "We ratified X." },
          {
            heading: "Alternatives Considered",
            body: "Y and Z were rejected.",
          },
        ],
      };
      const fragments = await notionAdapter.extract(unit, CTX);
      expect(fragments).toHaveLength(1);
      expect(fragments[0].title).toBe("Use X");
    });

    it("DOES split a plural 'Decisions' heading", async () => {
      // ADR sets commonly title the ratified section "Decisions" (plural);
      // the keyword match must cover both singular and plural forms.
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/plural-decisions",
        title: "Interrupts proposal",
        subsystem: "agui-protocol",
        sections: [
          {
            heading: "Decisions",
            body: "We key resume on interruptId, not parentRunId.",
          },
        ],
      };
      const fragments = await notionAdapter.extract(unit, CTX);
      expect(fragments).toHaveLength(1);
    });
  });

  describe("content-free decision sections", () => {
    it("does NOT emit a fragment for a heading-only decision section (empty body)", async () => {
      // A decision heading with no prose has no claim content — emitting it
      // would produce a content-free fragment (every sibling adapter guards
      // against empty content; this adapter must too).
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/heading-only-decision",
        title: "Sparse ADR",
        subsystem: "agui-protocol",
        sections: [
          { heading: "Decision: Use X", body: "" },
          { heading: "Decision: Use Y", body: "   \n\t  " },
          { heading: "Decision: Use Z", body: "Real rationale prose." },
        ],
      };
      const fragments = await notionAdapter.extract(unit, CTX);
      // Only the section with substantive body content yields a fragment.
      expect(fragments).toHaveLength(1);
      expect(fragments[0].title).toBe("Use Z");
    });
  });

  describe("credential-only hit keeps non-GTM knowledge_type", () => {
    it("flags a credential-bearing security decision secret WITHOUT mislabeling it gtm", async () => {
      // A credential signal alone (no GTM/commercial signal) must escalate
      // sensitivity to secret — but the PAGE is a security/architecture
      // decision, not GTM knowledge. knowledge_type follows the normal
      // ARCH_SIGNAL/design-rationale classification.
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/oidc-rotation",
        title: "ADR: Rotate credentials via OIDC",
        subsystem: "ci-supply-chain",
        sections: [
          {
            heading: "Decision: Rotate credentials via OIDC",
            body: "We rotate the deploy credential via OIDC instead of long-lived api key material.",
          },
        ],
      };
      const [f] = await notionAdapter.extract(unit, CTX);
      expect(f.provenance.classification.sensitivity).toBe("secret");
      expect(f.provenance.classification.knowledge_type).not.toBe("gtm");
      expect(f.provenance.classification.knowledge_type).toBe(
        "design-rationale",
      );
    });

    it("classifies a credential-bearing decision with architecture signals as architecture", async () => {
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/token-infra",
        title: "ADR: Access token handling in deployment infrastructure",
        subsystem: "ci-supply-chain",
        sections: [
          {
            heading: "Decision: Centralize access token issuance",
            body: "All deployment infrastructure fetches an access token from the central issuer.",
          },
        ],
      };
      const [f] = await notionAdapter.extract(unit, CTX);
      expect(f.provenance.classification.sensitivity).toBe("secret");
      expect(f.provenance.classification.knowledge_type).toBe("architecture");
    });
  });

  describe("numbered context headings are NOT spurious decisions", () => {
    it("does NOT split a numbered context heading ('1. Background') into a decision fragment", async () => {
      // A numbered NON-decision heading like "1. Background" matches the bare
      // "^\\d+[.)]\\s+" enumerator, but it is a context section — Context /
      // Background / Overview / Summary are deliberately NOT split out. The
      // numeric prefix must not defeat that intent.
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/numbered-context",
        title: "Saga concurrency proposal",
        subsystem: "agui-protocol",
        sections: [
          { heading: "1. Background", body: "Prior art and motivation." },
          { heading: "2) Overview", body: "High-level shape of the system." },
          { heading: "3. Context", body: "Constraints we operate under." },
          { heading: "4. Summary", body: "Recap of the proposal." },
        ],
      };
      const fragments = await notionAdapter.extract(unit, CTX);
      // None of these numbered context headings produce a fragment.
      expect(fragments).toHaveLength(0);
    });

    it("STILL splits a real numbered decision ('1. Use OCC for saga concurrency')", async () => {
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/numbered-decision",
        title: "Saga concurrency proposal",
        subsystem: "agui-protocol",
        sections: [
          { heading: "1. Background", body: "Prior art and motivation." },
          {
            heading: "1. Use OCC for saga concurrency",
            body: "We use optimistic concurrency control to coordinate sagas.",
          },
        ],
      };
      const fragments = await notionAdapter.extract(unit, CTX);
      // Only the real numbered decision is split out; the context heading is not.
      expect(fragments).toHaveLength(1);
      expect(fragments[0].title).toBe("Use OCC for saga concurrency");
    });

    it("does NOT produce a fragment for a bare enumerator heading with no substantive text", async () => {
      // A bare-enumerator heading ("1. ") strips to "" — it has no decision
      // claim, so it must be skipped rather than emitting a degenerate fragment.
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/bare-enumerator",
        title: "Proposal",
        subsystem: "agui-protocol",
        sections: [{ heading: "1. ", body: "Some body without a real title." }],
      };
      const fragments = await notionAdapter.extract(unit, CTX);
      expect(fragments).toHaveLength(0);
    });
  });

  describe("cited-reference dedup", () => {
    it("collapses a full GitHub URL and a bare PR mention of the SAME ref into one linked_issue", async () => {
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/dedup-refs",
        title: "ADR: Resume keying",
        subsystem: "agui-protocol",
        sections: [
          {
            heading: "Decision: Resume keying",
            body: "Implemented in https://github.com/ag-ui-protocol/ag-ui/pull/1746 — see PR #1746 for the full discussion.",
          },
        ],
      };
      const [f] = await notionAdapter.extract(unit, CTX);
      const cited = f.evidence.filter((e) => e.kind === "linked_issue");
      // The URL and the bare "PR #1746" name the SAME reference (repo + number)
      // and must collapse to a single linked_issue entry.
      expect(cited).toHaveLength(1);
    });

    it("keeps two URLs to the same number in DIFFERENT repos as distinct linked_issues", async () => {
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/cross-repo-refs",
        title: "ADR: Cross-repo references",
        subsystem: "agui-protocol",
        sections: [
          {
            heading: "Decision: Cross-repo references",
            body: "See https://github.com/copilotkit/pathfinder/pull/42 and https://github.com/copilotkit/showcase/issues/42 for context.",
          },
        ],
      };
      const [f] = await notionAdapter.extract(unit, CTX);
      const cited = f.evidence.filter((e) => e.kind === "linked_issue");
      // Same number (42), different repos — these are two distinct references
      // and must NOT collide on the bare number.
      expect(cited).toHaveLength(2);
      const urls = cited.map((e) => (e.kind === "linked_issue" ? e.url : ""));
      expect(urls).toContain(
        "https://github.com/copilotkit/pathfinder/pull/42",
      );
      expect(urls).toContain(
        "https://github.com/copilotkit/showcase/issues/42",
      );
    });
  });

  describe("empty-subsystem guard (fail-loud intake)", () => {
    // `subsystem` is a STRUCTURAL canonical-key component
    // (<sourcetype>:<subsystem>:<claim-slug>) — an empty/blank value would
    // yield a degenerate key far downstream, away from the identifiable
    // producer. The adapter must fail loud at intake instead.
    it("throws on an empty subsystem", async () => {
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/empty-subsystem",
        title: "ADR: Some decision",
        subsystem: "",
        sections: [{ heading: "Decision: Use X", body: "Rationale." }],
      };
      await expect(notionAdapter.extract(unit, CTX)).rejects.toThrow(
        /subsystem/i,
      );
    });

    it("throws on a whitespace-only subsystem", async () => {
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/blank-subsystem",
        title: "ADR: Some decision",
        subsystem: "   ",
        sections: [{ heading: "Decision: Use X", body: "Rationale." }],
      };
      await expect(notionAdapter.extract(unit, CTX)).rejects.toThrow(
        /subsystem/i,
      );
    });

    it("uses the TRIMMED subsystem on the emitted fragment for a padded value", async () => {
      // The guard trims for the CHECK only; the fragment must carry the
      // TRIMMED value too — a padded " auth " would mint a padded
      // `notion-doc: auth :<slug>` canonical key downstream.
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/padded-subsystem",
        title: "ADR: Some decision",
        subsystem: " auth ",
        sections: [{ heading: "Decision: Use X", body: "Rationale." }],
      };
      const [fragment] = await notionAdapter.extract(unit, CTX);
      expect(fragment.subsystem).toBe("auth");
    });
  });

  describe("provenance + freshness", () => {
    it("derives freshness.as_of from ctx.now when the unit omits a date", async () => {
      const unit = loadUnit("single-decision-rrf-ranking.json");
      // Strip the page date to exercise the ctx.now fallback.
      const undated: NotionPageUnit = { ...unit, date: undefined };
      const [f] = await notionAdapter.extract(undated, CTX);
      expect(f.provenance.classification.freshness.as_of).toBe("2026-06-08");
    });

    it("prefers the page's own date for provenance.date when present", async () => {
      const unit = loadUnit("single-decision-rrf-ranking.json");
      const [f] = await notionAdapter.extract(unit, CTX);
      expect(f.provenance.date).toBe("2026-03-30");
    });
  });

  // ── validationTargets: cited symbols/paths make a fragment source-verifiable ──
  //
  // A notion decision that CITES a concrete repo-relative path or a code symbol
  // gives validate.ts (S14) something to grep on origin/main. Those targets are
  // lifted onto the fragment's `validationTargets` so the gate can source-verify
  // and (only then) promote. A decision that cites nothing keeps an EMPTY
  // target list by design — target-less prose stays unverified and falls to the
  // human review page (the strict + prose-aware policy).
  describe("validationTargets (cited symbols/paths)", () => {
    it("lifts a cited repo-relative path into validationTargets", async () => {
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/cited-path",
        title: "ADR: RRF ranking lives in the search module",
        subsystem: "search-ranking",
        sections: [
          {
            heading: "Decision: Fuse ranks in src/atlas/rag-dedup.ts",
            body: "We implement Reciprocal Rank Fusion in src/atlas/rag-dedup.ts so the overlap oracle stays in one place.",
          },
        ],
      };
      const [f] = await notionAdapter.extract(unit, CTX);
      expect(f.validationTargets).toContain("src/atlas/rag-dedup.ts");
    });

    it("lifts a cited code symbol into validationTargets", async () => {
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/cited-symbol",
        title: "ADR: Canonical keying",
        subsystem: "canonicalize",
        sections: [
          {
            heading: "Decision: Key on claimSlug()",
            body: "The canonical key is derived from the claimSlug() helper rather than the sourcetype prefix.",
          },
        ],
      };
      const [f] = await notionAdapter.extract(unit, CTX);
      expect(f.validationTargets).toContain("claimSlug");
    });

    it("scans the section heading too (the persisted title may carry the citation)", async () => {
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/cited-in-heading",
        title: "ADR: Validation gate",
        subsystem: "atlas",
        sections: [
          {
            heading: "Decision: Gate promotion in src/atlas/validate.ts",
            body: "Promotion is gated by the source-verify grep.",
          },
        ],
      };
      const [f] = await notionAdapter.extract(unit, CTX);
      expect(f.validationTargets).toContain("src/atlas/validate.ts");
    });

    it("produces a contract-valid fragment with populated targets", async () => {
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/cited-valid",
        title: "ADR: Dedup",
        subsystem: "atlas",
        sections: [
          {
            heading: "Decision: dedup in src/atlas/rag-dedup.ts",
            body: "See dedupAgainstRagCorpus() for the probe loop.",
          },
        ],
      };
      const [f] = await notionAdapter.extract(unit, CTX);
      expect(() => CandidateFragmentSchema.parse(f)).not.toThrow();
      expect(f.validationTargets).toContain("src/atlas/rag-dedup.ts");
      expect(f.validationTargets).toContain("dedupAgainstRagCorpus");
    });

    it("emits distinct, deterministically-ordered targets (no duplicates)", async () => {
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/cited-dedup-order",
        title: "ADR: Paths",
        subsystem: "atlas",
        sections: [
          {
            heading: "Decision: touch src/atlas/canonicalize.ts",
            body: "Both src/atlas/canonicalize.ts and src/atlas/aggregate.ts change; src/atlas/canonicalize.ts is mentioned twice.",
          },
        ],
      };
      const [f] = await notionAdapter.extract(unit, CTX);
      // De-duped (canonicalize.ts appears twice in the source prose)...
      expect(
        f.validationTargets.filter((t) => t === "src/atlas/canonicalize.ts"),
      ).toHaveLength(1);
      // ...and sorted for deterministic fragment output.
      expect(f.validationTargets).toStrictEqual(
        [...f.validationTargets].sort(),
      );
    });

    it("does NOT capture language keywords or prose runtime tokens as targets", async () => {
      // Over-capture guard: `CITED_SYMBOL_RE` matched any `word(` — including
      // language keywords (`if (x)`) — and `FILE_TARGET_RE` matched any dotted
      // prose token ending in a known extension (`node.js`). Neither is a real
      // cited code entity; both spuriously made a decision source-verifiable.
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/over-capture",
        title: "ADR: Runtime choice",
        subsystem: "runtime",
        sections: [
          {
            heading: "Decision: We use node.js",
            body: "We use node.js as the runtime. if (x) { return early; } and we switch on the mode; for now this is fine.",
          },
        ],
      };
      const [f] = await notionAdapter.extract(unit, CTX);
      expect(f.validationTargets).not.toContain("node.js");
      expect(f.validationTargets).not.toContain("if");
      expect(f.validationTargets).not.toContain("for");
      expect(f.validationTargets).not.toContain("switch");
      expect(f.validationTargets).not.toContain("return");
      expect(f.validationTargets).toStrictEqual([]);
    });

    it("STILL captures a genuine cited path and a genuine cited call amid prose noise", async () => {
      // The tightening must not throw out the baby: a real repo-relative path
      // and a real call citation are still lifted even when prose keywords and
      // runtime tokens surround them.
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/genuine-amid-noise",
        title: "ADR: Dedup lives in one place",
        subsystem: "atlas",
        sections: [
          {
            heading: "Decision: dedup in src/atlas/rag-dedup.ts",
            body: "We run on node.js; if (corpus) { dedupAgainstRagCorpus(); } — the probe lives in src/atlas/rag-dedup.ts.",
          },
        ],
      };
      const [f] = await notionAdapter.extract(unit, CTX);
      expect(f.validationTargets).toContain("src/atlas/rag-dedup.ts");
      expect(f.validationTargets).toContain("dedupAgainstRagCorpus");
      expect(f.validationTargets).not.toContain("node.js");
      expect(f.validationTargets).not.toContain("if");
    });

    it("leaves target-less prose with an EMPTY validationTargets (stays unverified → human page)", async () => {
      // A decision that cites no concrete symbol/path has nothing for the
      // validation gate to grep, so it must stay unverified and fall to the
      // human review page — NOT be silently promotable. This is the correct
      // prose-aware behavior, not a regression.
      const unit: NotionPageUnit = {
        url: "https://www.notion.so/copilotkit/no-citation",
        title: "ADR: Team norms",
        subsystem: "process",
        sections: [
          {
            heading: "Decision: We prefer small PRs",
            body: "We keep pull requests small so review stays fast and focused.",
          },
        ],
      };
      const [f] = await notionAdapter.extract(unit, CTX);
      expect(f.validationTargets).toStrictEqual([]);
      // Target-less prose remains unverified (human-gated).
      expect(f.provenance.classification.validation_status).toBe("unverified");
    });
  });

  // ── aimock-routing guard (Theme E cheap check, folded from S20) ────────────────
  //
  // ORG RULE: any LLM-touching path in this repo routes through aimock, never a
  // vi.fn / vi.mock stub. The notion adapter is a DETERMINISTIC derivation of the
  // structured page (`ctx.llm` is unused) — it must make NO model call at all,
  // even now that it extracts validationTargets (which is a pure regex lift, not
  // an LLM call). This guard pins that: it installs a REAL `OpenAIDistiller`
  // pointed at an in-process aimock server as `ctx.llm` (the only sanctioned LLM
  // seam) and asserts extract produces its fragments while the aimock journal
  // stays EMPTY — proving the adapter neither invokes the seam nor bypasses it
  // with a hidden model call. If org-rule drift ever adds an LLM call here, it
  // MUST go through this same aimock-backed seam (any request lands in
  // `getRequests()`), so this test trips instead of a live-LLM leak reaching the
  // suite. Using a real aimock distiller (not a stub) is itself the org-rule proof.
  describe("notionAdapter.extract — aimock-routing guard", () => {
    const mock = new LLMock({ port: 0, logLevel: "silent" });
    let llmCtx: AdapterContext;

    beforeAll(async () => {
      await mock.start();
      // A real distiller pointed at aimock IS the sanctioned `ctx.llm` seam — no
      // vi.fn stub (org rule). No fixtures are registered: the adapter must not
      // make a model call, so any request would 404 at aimock AND surface in the
      // request journal — either way the guard trips.
      const llm = new OpenAIDistiller({
        baseURL: `${mock.url}/v1`,
        apiKey: "mock",
        now: () => new Date("2026-06-08T00:00:00.000Z"),
      });
      llmCtx = { now: new Date("2026-06-08T00:00:00.000Z"), llm };
    });

    afterAll(async () => {
      await mock.stop();
    });

    beforeEach(() => {
      mock.clearRequests();
    });

    it("derives fragments without touching the LLM seam (no aimock request)", async () => {
      const unit = loadUnit("single-decision-rrf-ranking.json");
      const fragments = await notionAdapter.extract(unit, llmCtx);

      // The adapter still produces its derived fragment(s)...
      expect(fragments.length).toBeGreaterThanOrEqual(1);
      expect(fragments[0]?.sourcetype).toBe("notion-doc");
      // ...and made ZERO calls to the aimock-backed LLM seam. Any hidden model
      // call (org-rule drift) would route through this seam — landing a request
      // in the journal — or bypass aimock entirely (banned). Either way the
      // empty journal is the assertion that guards the seam.
      expect(mock.getRequests()).toHaveLength(0);
    });
  });
});
