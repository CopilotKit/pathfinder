import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { memoryAdapter } from "../atlas/adapters/memory.js";
import type { MemoryFileUnit } from "../atlas/adapters/memory.js";
import type { AdapterContext } from "../atlas/adapters/types.js";

// Fixture memory files live under fixtures/atlas/memory/. Each is a real-shaped
// memory file (YAML frontmatter: name/description/type/originSessionId + body).
const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "atlas",
  "memory",
);

// Build the MemoryFileUnit the way the S18 driver will: filename (carries the
// reference_/project_/feedback_ prefix the classifier keys on) + raw contents.
function loadUnit(filename: string): MemoryFileUnit {
  const contents = readFileSync(join(FIXTURE_DIR, filename), "utf8");
  return { filename, contents };
}

// Deterministic clock — provenance dates / freshness derive from ctx.now, never
// `new Date()` inline (matches the AdapterContext contract).
const ctx: AdapterContext = { now: new Date("2026-06-08T00:00:00.000Z") };

describe("memory leaf adapter", () => {
  it("declares the memory sourcetype", () => {
    expect(memoryAdapter.sourcetype).toBe("memory");
  });

  describe("reference_/project_/feedback_ KEEP/DROP classifier", () => {
    it("KEEPs a reference_ file → exactly one fragment", async () => {
      const out = await memoryAdapter.extract(
        loadUnit("reference_1password_cli.md"),
        ctx,
      );
      expect(out).toHaveLength(1);
    });

    it("KEEPs a project_ file → exactly one fragment", async () => {
      const out = await memoryAdapter.extract(
        loadUnit("project_agentcore_upstream_pr.md"),
        ctx,
      );
      expect(out).toHaveLength(1);
    });

    it("KEEPs an operational/infra/codebase feedback_ file → one fragment", async () => {
      const out = await memoryAdapter.extract(
        loadUnit("feedback_nextjs_bundles_node_modules.md"),
        ctx,
      );
      expect(out).toHaveLength(1);
    });

    it("DROPs a pure-etiquette feedback_ file → empty array", async () => {
      const out = await memoryAdapter.extract(
        loadUnit("feedback_end_of_line.md"),
        ctx,
      );
      expect(out).toEqual([]);
    });
  });

  describe("frontmatter → fragment field mapping (§6.1)", () => {
    it("maps name→distilled title, description→summary, body→content, originSessionId→provenance", async () => {
      const [fragment] = await memoryAdapter.extract(
        loadUnit("reference_1password_cli.md"),
        ctx,
      );

      // name → distilled claim title (NOT the raw filename)
      expect(fragment.title).toBe("1Password CLI (op) access");

      // body (markdown after the frontmatter) → why/how content
      expect(fragment.content).toContain("1Password CLI (`op`) v2.32+");
      // frontmatter delimiters never bleed into content
      expect(fragment.content).not.toContain("---");
      expect(fragment.content).not.toContain("originSessionId");

      // sourcetype discriminant
      expect(fragment.sourcetype).toBe("memory");

      // source_name carries the memory filename (the unit identity)
      expect(fragment.source_name).toBe("reference_1password_cli.md");

      // originSessionId → provenance (session is the primary source of the fact)
      expect(fragment.provenance.source).toContain(
        "e654541f-dcb7-4152-8ee8-f669848555ee",
      );
      // description → summary lives on provenance (validated_against is the
      // single free-text provenance slot for the distilled summary)
      expect(fragment.provenance.validated_against).toBe(
        "1Password CLI is available and authenticated to both personal and CopilotKit org vaults — use for secrets management",
      );

      // provenance.date derives from the injected clock (deterministic)
      expect(fragment.provenance.date).toBe("2026-06-08");
      expect(fragment.provenance.classification.freshness.as_of).toBe(
        "2026-06-08",
      );
    });

    it("derives a non-empty subsystem and a claimSlugHint from the slug", async () => {
      const [fragment] = await memoryAdapter.extract(
        loadUnit("feedback_nextjs_bundles_node_modules.md"),
        ctx,
      );
      expect(fragment.subsystem.length).toBeGreaterThan(0);
      // claim-slug hint is derived from the filename slug (prefix stripped)
      expect(fragment.claimSlugHint).toBe("nextjs-bundles-node-modules");
    });

    it("first-pass classification: reference_/project_ are primary, memory facts default internal+unverified", async () => {
      const [ref] = await memoryAdapter.extract(
        loadUnit("reference_1password_cli.md"),
        ctx,
      );
      expect(ref.provenance.classification.provenance_class).toBe("primary");
      expect(ref.provenance.classification.validation_status).toBe(
        "unverified",
      );
      // memory facts are never public by default (conservative sensitivity)
      expect(ref.provenance.classification.sensitivity).not.toBe("public");
    });

    it("produces a fragment that satisfies the CandidateFragment schema", async () => {
      // Importing the schema lazily keeps the contract dependency explicit.
      const { CandidateFragmentSchema } = await import("../atlas/types.js");
      const [fragment] = await memoryAdapter.extract(
        loadUnit("project_agentcore_upstream_pr.md"),
        ctx,
      );
      expect(() => CandidateFragmentSchema.parse(fragment)).not.toThrow();
    });
  });

  describe("frontmatter fence parsing (hand-edited files)", () => {
    it("does not throw on malformed frontmatter YAML — degrades to empty frontmatter and keeps the body", async () => {
      // Hand-edited file with tab-indented (spec-invalid) YAML: parsing must
      // never crash the unit; the fence is still recognized, frontmatter
      // degrades to {} and the body survives.
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const unit: MemoryFileUnit = {
          filename: "reference_hand_edited.md",
          contents: [
            "---",
            "name: Broken",
            "\tindent: tab-indented yaml is invalid",
            "---",
            "The body survives a malformed frontmatter block.",
          ].join("\n"),
        };
        const out = await memoryAdapter.extract(unit, ctx);
        expect(out).toHaveLength(1);
        expect(out[0].content).toBe(
          "The body survives a malformed frontmatter block.",
        );
        // the unparseable name is lost → title falls back to the slug
        expect(out[0].title).toBe("hand-edited");
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("WARNS — naming the file — when malformed frontmatter YAML degrades", async () => {
      // The degrade must not be silent (fail-loud discipline): the catch emits
      // one console.warn that names the offending file so an operator can find
      // and repair it. Behavior (degrade + keep the body) is unchanged.
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const unit: MemoryFileUnit = {
          filename: "reference_hand_edited.md",
          contents: [
            "---",
            'name: "unterminated quote',
            "---",
            "The body survives a malformed frontmatter block.",
          ].join("\n"),
        };
        const out = await memoryAdapter.extract(unit, ctx);
        expect(out).toHaveLength(1);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const message = String(warnSpy.mock.calls[0][0]);
        expect(message).toContain("reference_hand_edited.md");
        expect(message).toContain("malformed YAML frontmatter");
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("does NOT warn on well-formed frontmatter", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const out = await memoryAdapter.extract(
          loadUnit("reference_1password_cli.md"),
          ctx,
        );
        expect(out).toHaveLength(1);
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("handles an empty frontmatter block (---/---) without leaking the fences into content", async () => {
      const unit: MemoryFileUnit = {
        filename: "reference_empty_frontmatter.md",
        contents: ["---", "---", "Body after an empty frontmatter block."].join(
          "\n",
        ),
      };
      const out = await memoryAdapter.extract(unit, ctx);
      expect(out).toHaveLength(1);
      expect(out[0].content).toBe("Body after an empty frontmatter block.");
      expect(out[0].content).not.toContain("---");
      expect(out[0].title).toBe("empty-frontmatter");
    });

    it("tolerates trailing whitespace after the closing fence", async () => {
      const unit: MemoryFileUnit = {
        filename: "reference_sloppy_close.md",
        contents: [
          "---",
          "name: Trailing close",
          "type: reference",
          "--- ",
          "Body after a sloppy close fence.",
        ].join("\n"),
      };
      const out = await memoryAdapter.extract(unit, ctx);
      expect(out).toHaveLength(1);
      expect(out[0].title).toBe("Trailing close");
      expect(out[0].content).toBe("Body after a sloppy close fence.");
      expect(out[0].content).not.toContain("---");
    });

    it("WARNS — naming the file — on an unterminated frontmatter fence, treating the entire file as body", async () => {
      // A hand-edited file that OPENS a fence but never closes it falls to the
      // no-fence branch — the YAML lines become body content. That degrade must
      // not be SILENT (it is indistinguishable from "no fence" otherwise): warn
      // with the filename so an operator can find and repair the file. Behavior
      // (whole file as body) is unchanged.
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const unit: MemoryFileUnit = {
          filename: "reference_unterminated_fence.md",
          contents: [
            "---",
            "name: Never closed",
            "The body keeps the full text.",
          ].join("\n"),
        };
        const out = await memoryAdapter.extract(unit, ctx);
        expect(out).toHaveLength(1);
        // The whole file — including the absorbed YAML line — is the body.
        expect(out[0].content).toContain("name: Never closed");
        expect(out[0].content).toContain("The body keeps the full text.");
        // The absorbed name never reaches frontmatter → title falls back to slug.
        expect(out[0].title).toBe("unterminated-fence");
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const message = String(warnSpy.mock.calls[0][0]);
        expect(message).toContain("reference_unterminated_fence.md");
        expect(message).toContain("unterminated frontmatter fence");
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("does not terminate the fence on an inline '---' inside a frontmatter value", async () => {
      // The close fence must be its own line — `ab---cd` inside a value is NOT
      // a close fence.
      const unit: MemoryFileUnit = {
        filename: "reference_inline_dashes.md",
        contents: [
          "---",
          "name: ab---cd",
          "type: reference",
          "---",
          "Body text.",
        ].join("\n"),
      };
      const out = await memoryAdapter.extract(unit, ctx);
      expect(out).toHaveLength(1);
      expect(out[0].title).toBe("ab---cd");
      expect(out[0].content).toBe("Body text.");
    });
  });

  describe("content-free unit (empty body AND empty description)", () => {
    it("emits NO fragment for a reference_ file with empty body and no description", async () => {
      // A KEEP-by-prefix file whose resolved content (body || description) is
      // empty carries no knowledge — return [] to match the sibling adapters.
      const unit: MemoryFileUnit = {
        filename: "reference_empty_note.md",
        contents: [
          "---",
          "name: Empty note",
          "type: reference",
          "---",
          "",
        ].join("\n"),
      };
      const out = await memoryAdapter.extract(unit, ctx);
      expect(out).toEqual([]);
    });

    it("emits NO fragment for a project_ file with whitespace-only body and no description", async () => {
      const unit: MemoryFileUnit = {
        filename: "project_whitespace.md",
        contents: [
          "---",
          "name: WS note",
          "type: project",
          "---",
          "   \n\t",
        ].join("\n"),
      };
      const out = await memoryAdapter.extract(unit, ctx);
      expect(out).toEqual([]);
    });

    it("KEEPs a file when description backstops an empty body", async () => {
      const unit: MemoryFileUnit = {
        filename: "reference_desc_only.md",
        contents: [
          "---",
          "name: Desc-only note",
          "description: A durable fact recorded as the summary",
          "type: reference",
          "---",
          "",
        ].join("\n"),
      };
      const out = await memoryAdapter.extract(unit, ctx);
      expect(out).toHaveLength(1);
      expect(out[0].content).toBe("A durable fact recorded as the summary");
    });
  });

  describe("blank-slug intake guard (fail-loud)", () => {
    it("throws loud — naming the filename — when a bare-prefix filename yields an empty slug", async () => {
      // `slug` is BOTH the subsystem and the claimSlugHint — STRUCTURAL
      // canonical-key components (<sourcetype>:<subsystem>:<claim-slug>). A
      // bare-prefix filename ("reference_.md") slugs to "" and would mint a
      // degenerate `memory::` key silently, far downstream. Fail loud at
      // intake instead, mirroring the notion/github/showcase sibling guards.
      const unit: MemoryFileUnit = {
        filename: "reference_.md",
        contents: [
          "---",
          "name: Bare prefix",
          "type: reference",
          "---",
          "Some durable content.",
        ].join("\n"),
      };
      await expect(memoryAdapter.extract(unit, ctx)).rejects.toThrow(
        /\[atlas\/adapters\/memory\].*empty slug.*reference_\.md/,
      );
    });
  });

  describe("first-pass sensitivity scan (credential / customer-identifying)", () => {
    it("escalates to secret when the body embeds a raw API key", async () => {
      const unit: MemoryFileUnit = {
        filename: "reference_leaky_key.md",
        contents: [
          "---",
          "name: Service config",
          "type: reference",
          "---",
          "Set the env var: api_key=sk-live-ABCDEF1234567890",
        ].join("\n"),
      };
      const [fragment] = await memoryAdapter.extract(unit, ctx);
      expect(fragment.provenance.classification.sensitivity).toBe("secret");
    });

    it("escalates to secret when the body embeds a private-key block", async () => {
      const unit: MemoryFileUnit = {
        filename: "reference_private_key.md",
        contents: [
          "---",
          "name: Deploy key",
          "type: reference",
          "---",
          "-----BEGIN RSA PRIVATE KEY-----",
          "MIIEpAIBAAKCAQEA...",
          "-----END RSA PRIVATE KEY-----",
        ].join("\n"),
      };
      const [fragment] = await memoryAdapter.extract(unit, ctx);
      expect(fragment.provenance.classification.sensitivity).toBe("secret");
    });

    it("escalates to proprietary for customer-identifying GTM signals", async () => {
      const unit: MemoryFileUnit = {
        filename: "reference_named_customer.md",
        contents: [
          "---",
          "name: Account note",
          "type: reference",
          "---",
          "The named customer Acme Corp signed a contract value of $250k ARR.",
        ].join("\n"),
      };
      const [fragment] = await memoryAdapter.extract(unit, ctx);
      expect(fragment.provenance.classification.sensitivity).toBe(
        "proprietary",
      );
    });

    it("keeps an ordinary operational note at internal", async () => {
      const [fragment] = await memoryAdapter.extract(
        loadUnit("feedback_nextjs_bundles_node_modules.md"),
        ctx,
      );
      expect(fragment.provenance.classification.sensitivity).toBe("internal");
    });

    it("keeps a benign 'token:' mention in non-credential prose at internal", async () => {
      // A protocol-primitive mention like "resume token:" carries NO credential
      // context (no access/auth/api keyword prefix, no secret-shaped value) and
      // must NOT escalate — mirrors notion.ts's context-qualified approach.
      const unit: MemoryFileUnit = {
        filename: "reference_resume_token.md",
        contents: [
          "---",
          "name: Resume semantics",
          "type: reference",
          "---",
          "The protocol's resume token: an opaque value the client replays on reconnect.",
        ].join("\n"),
      };
      const [fragment] = await memoryAdapter.extract(unit, ctx);
      expect(fragment.provenance.classification.sensitivity).toBe("internal");
    });

    it("escalates to secret for a credential-qualified token assignment", async () => {
      // access_token / auth_token keep flagging — the keyword prefix IS the
      // credential context.
      const unit: MemoryFileUnit = {
        filename: "reference_leaky_token.md",
        contents: [
          "---",
          "name: Service auth",
          "type: reference",
          "---",
          "Configure with access_token: eyJhbGciOiJIUzI1NiJ9.payload",
        ].join("\n"),
      };
      const [fragment] = await memoryAdapter.extract(unit, ctx);
      expect(fragment.provenance.classification.sensitivity).toBe("secret");
    });

    it("escalates to secret when a bare token assignment carries a secret-shaped value", async () => {
      // Even without a keyword prefix, `token=<long opaque run>` embeds a raw
      // credential — the VALUE shape is the credential context.
      const unit: MemoryFileUnit = {
        filename: "reference_bare_token_value.md",
        contents: [
          "---",
          "name: CI config",
          "type: reference",
          "---",
          "Set token=ghp_AbCdEf1234567890XyZ1234567890 in the workflow env.",
        ].join("\n"),
      };
      const [fragment] = await memoryAdapter.extract(unit, ctx);
      expect(fragment.provenance.classification.sensitivity).toBe("secret");
    });

    it("keeps ordinary prose containing bare 'pass:' at internal", async () => {
      // "pass" is common English ("make the tests pass: …") — only the full
      // credential words password/passwd may escalate.
      const unit: MemoryFileUnit = {
        filename: "reference_test_workflow.md",
        contents: [
          "---",
          "name: Test workflow",
          "type: reference",
          "---",
          "To finish: make the tests pass: run vitest and confirm green.",
        ].join("\n"),
      };
      const [fragment] = await memoryAdapter.extract(unit, ctx);
      expect(fragment.provenance.classification.sensitivity).toBe("internal");
    });

    it("still escalates an embedded password assignment to secret", async () => {
      const unit: MemoryFileUnit = {
        filename: "reference_dev_login.md",
        contents: [
          "---",
          "name: Dev login",
          "type: reference",
          "---",
          "Local dev login uses password: hunter2 for the seeded admin user.",
        ].join("\n"),
      };
      const [fragment] = await memoryAdapter.extract(unit, ctx);
      expect(fragment.provenance.classification.sensitivity).toBe("secret");
    });

    it("still escalates a passwd assignment to secret", async () => {
      const unit: MemoryFileUnit = {
        filename: "reference_unix_account.md",
        contents: [
          "---",
          "name: Service account",
          "type: reference",
          "---",
          "The service account ships with passwd=changeme until first boot.",
        ].join("\n"),
      };
      const [fragment] = await memoryAdapter.extract(unit, ctx);
      expect(fragment.provenance.classification.sensitivity).toBe("secret");
    });

    it("treats an op:// 1Password pointer as SAFE (stays internal)", async () => {
      // op:// references are safe pointers, NOT raw secrets — must NOT escalate.
      const unit: MemoryFileUnit = {
        filename: "reference_op_pointer.md",
        contents: [
          "---",
          "name: Secrets pointer",
          "type: reference",
          "---",
          "Read the value from `op://DevOps/MyService/api_token` at deploy time.",
        ].join("\n"),
      };
      const [fragment] = await memoryAdapter.extract(unit, ctx);
      expect(fragment.provenance.classification.sensitivity).toBe("internal");
    });
  });
});
