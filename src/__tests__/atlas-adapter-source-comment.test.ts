// Unit tests for the Atlas source-comment / agent-doc leaf adapter (S8).
//
// The adapter FUSES a design-block comment ("The Problem / The Solution",
// intentional-coupling rationale) with the code region it annotates into ONE
// DERIVED CandidateFragment. The defining property of a derived fragment is that
// it DISTILLS — it must NOT verbatim-copy the comment text into `content`. The
// canonical worked example is §12.2 of the strategy (the react-core
// state-render-bridge messageId-binding fact), encoded here over a fixture that
// mimics `use-coagent-state-render-bridge.tsx`.
//
// No LLM is involved: the unit is a fully structured `SourceCommentUnit`, and
// distillation is deterministic, so a plain Vitest unit test (no aimock) is
// correct here.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  sourceCommentAdapter,
  type SourceCommentUnit,
} from "../atlas/adapters/source-comment.js";
import type { AdapterContext } from "../atlas/adapters/types.js";
import { CandidateFragmentSchema } from "../atlas/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(
  __dirname,
  "../../fixtures/atlas/source/use-coagent-state-render-bridge.tsx",
);

// The design-block comment region (lines ~24-45 of the fixture). Lifted verbatim
// from the fixture so the test proves the adapter does NOT echo it back.
const COMMENT_TEXT = `The Problem
-----------
Co-agent state-render output is asynchronous. By the time a state update
arrives, the conversation may have advanced to a later message. If we render
that update against whatever the "current" message happens to be, custom UI
detaches from the message that actually triggered it — the render lands on the
wrong message and the user sees stale or misplaced UI.

The Solution
------------
Bind each render to the messageId that triggered it, captured at the moment
the render request was issued. Re-renders then stay attached to the correct
message even as the conversation advances. This is an INTENTIONAL coupling
between a render and its originating messageId, not an incidental one — do not
"simplify" it away by rendering against the live/current message.`;

const CODE_REGION = `export function useCoAgentStateRenderBridge(messageId: string) {
  const boundMessageId = useRef(messageId);
  useEffect(() => {
    boundMessageId.current = messageId;
  }, [messageId]);
  return boundMessageId.current;
}`;

function makeUnit(
  overrides: Partial<SourceCommentUnit> = {},
): SourceCommentUnit {
  return {
    filePath:
      "packages/react-core/src/hooks/use-coagent-state-render-bridge.tsx",
    lineStart: 24,
    lineEnd: 45,
    commentText: COMMENT_TEXT,
    codeRegion: CODE_REGION,
    subsystem: "cpk-react-core",
    repoUrl: "https://github.com/CopilotKit/CopilotKit",
    ref: "main",
    sourceUrl:
      "https://github.com/CopilotKit/CopilotKit/blob/main/packages/react-core/src/hooks/use-coagent-state-render-bridge.tsx#L24-L45",
    ...overrides,
  };
}

const CTX: AdapterContext = { now: new Date("2026-06-08T00:00:00.000Z") };

describe("sourceCommentAdapter", () => {
  it("declares the agent-doc sourcetype discriminant", () => {
    expect(sourceCommentAdapter.sourcetype).toBe("agent-doc");
  });

  it("fuses a design-block comment + code region into exactly ONE fragment", async () => {
    const out = await sourceCommentAdapter.extract(makeUnit(), CTX);
    expect(out).toHaveLength(1);
  });

  it("produces a DERIVED fragment (provenance_class:derived)", async () => {
    const [frag] = await sourceCommentAdapter.extract(makeUnit(), CTX);
    expect(frag.provenance.classification.provenance_class).toBe("derived");
    // sourcetype is one of the derived-class source types
    expect(["agent-doc", "derived"]).toContain(frag.sourcetype);
  });

  it("DISTILLS — does NOT verbatim-copy the comment into content", async () => {
    const [frag] = await sourceCommentAdapter.extract(makeUnit(), CTX);

    // The content must be prose, but it must not be a copy of the raw comment.
    // The adapter whitespace-collapses content, so a literal multi-line
    // COMMENT_TEXT could never be a substring (the assertion would be vacuous).
    // Compare against a whitespace-normalized form so the anti-verbatim-copy
    // guarantee is actually exercised against what the adapter produces.
    expect(frag.content.length).toBeGreaterThan(0);
    const normalizedComment = COMMENT_TEXT.replace(/\s+/g, " ").trim();
    expect(frag.content).not.toContain(normalizedComment);
    // The decorative section headers / rule lines of the design block must not
    // survive into the distilled claim.
    expect(frag.content).not.toContain("The Problem");
    expect(frag.content).not.toContain("The Solution");
    expect(frag.content).not.toContain("-----------");
    // Likewise the title is a distilled claim, not the raw first comment line.
    expect(frag.title).not.toContain("The Problem");
    // It still captures the load-bearing concept (messageId binding intent).
    expect(frag.content.toLowerCase()).toContain("messageid");
    expect(frag.content.toLowerCase()).toContain("intentional");
  });

  it("anchors evidence at the file:line via changed_file AND records the fusion via fused_from", async () => {
    const [frag] = await sourceCommentAdapter.extract(makeUnit(), CTX);

    const fileLine =
      "packages/react-core/src/hooks/use-coagent-state-render-bridge.tsx:24-45";

    const changedFile = frag.evidence.find((e) => e.kind === "changed_file");
    expect(changedFile).toBeDefined();
    if (changedFile && changedFile.kind === "changed_file") {
      expect(changedFile.path).toBe(fileLine);
    }

    const fusedFrom = frag.evidence.find((e) => e.kind === "fused_from");
    expect(fusedFrom).toBeDefined();
    if (fusedFrom && fusedFrom.kind === "fused_from") {
      // fused_from ref points back at the source-comment unit (file:line based).
      expect(fusedFrom.ref).toContain(
        "use-coagent-state-render-bridge.tsx:24-45",
      );
    }
  });

  it("carries provenance source/url and a deterministic freshness from ctx.now", async () => {
    const [frag] = await sourceCommentAdapter.extract(makeUnit(), CTX);

    expect(frag.sourcetype).toBe("agent-doc");
    expect(frag.subsystem).toBe("cpk-react-core");
    expect(frag.provenance.source).toBe("source-comment");
    expect(frag.provenance.url).toContain(
      "use-coagent-state-render-bridge.tsx",
    );
    // freshness derives from the injected clock, never new Date() inline.
    expect(frag.provenance.classification.freshness.as_of).toBe("2026-06-08");
    // validated_against points at the file:line region (source-verified anchor).
    expect(frag.provenance.validated_against).toContain(
      "use-coagent-state-render-bridge.tsx:24-45",
    );
  });

  it("classifies a design-rationale/architecture comment as internal engineering knowledge", async () => {
    const [frag] = await sourceCommentAdapter.extract(makeUnit(), CTX);
    const c = frag.provenance.classification;
    expect(c.knowledge_type).toBe("architecture");
    expect(c.sensitivity).toBe("internal");
    expect(c.confidence).toBe("high");
    // The comment is source-anchored, so the fragment is source-verified.
    expect(c.validation_status).toBe("source-verified");
  });

  describe("first-pass sensitivity scan (shared credential/GTM scan)", () => {
    // This adapter is the likeliest credential carrier in the fleet (it embeds
    // a raw code region) AND the only adapter that self-stamps
    // `source-verified`/`high`, so an under-flagged leak here ranks HIGHEST in
    // the review queue. It must run the shared scan over title + commentText +
    // codeRegion instead of hardcoding sensitivity:"internal".
    it("escalates a codeRegion embedding a live-looking credential value to secret", async () => {
      const unit = makeUnit({
        codeRegion:
          'const client = createClient({\n  token: "sk_live_abcdef0123456789abcdef",\n});',
      });
      const [frag] = await sourceCommentAdapter.extract(unit, CTX);
      expect(frag.provenance.classification.sensitivity).toBe("secret");
    });

    it("escalates GTM commercial terms in the comment to proprietary", async () => {
      const unit = makeUnit({
        commentText:
          "This fast path exists because the ACME contract value depends on the renewal demo staying under 200ms.",
      });
      const [frag] = await sourceCommentAdapter.extract(unit, CTX);
      expect(frag.provenance.classification.sensitivity).toBe("proprietary");
    });

    it("keeps a bare credential MENTION internal (bareCredentialMentions stays OFF over code)", async () => {
      // Code regions routinely NAME apiKey/token identifiers; bare-mention
      // escalation over code would drown the review queue with honest
      // fragments. Only credential-VALUE signals (assignment-shaped, PEM)
      // escalate here — pin the judged default-options call.
      const unit = makeUnit({
        commentText:
          "We bind the request signer here so callers never handle the API keys directly.",
      });
      const [frag] = await sourceCommentAdapter.extract(unit, CTX);
      expect(frag.provenance.classification.sensitivity).toBe("internal");
    });
  });

  it("emits a CandidateFragment that satisfies the S0 Zod contract", async () => {
    const [frag] = await sourceCommentAdapter.extract(makeUnit(), CTX);
    // Round-trips through the foundational schema with no errors.
    expect(() => CandidateFragmentSchema.parse(frag)).not.toThrow();
  });

  it("sets validationTargets to the annotated symbol so validate.ts can grep it", async () => {
    const [frag] = await sourceCommentAdapter.extract(makeUnit(), CTX);
    expect(frag.validationTargets).toContain("useCoAgentStateRenderBridge");
  });

  it("uses the on-disk fixture as a faithful mirror of the unit", () => {
    // Guards that the inline COMMENT_TEXT the adapter consumes really IS the
    // fixture's design block: extract the JSDoc block from the fixture, strip
    // its ` * ` markers, and compare whitespace-normalized bodies. A drive-by
    // edit to either side breaks the mirror and fails here.
    const file = readFileSync(FIXTURE_PATH, "utf8");
    const block = file.match(/\/\*\*\r?\n([\s\S]*?)\r?\n\s*\*\//);
    expect(block).not.toBeNull();
    const fixtureBody = (block as RegExpMatchArray)[1]
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*\*\s?/, ""))
      .join("\n");
    const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
    expect(normalize(fixtureBody)).toBe(normalize(COMMENT_TEXT));
    // The annotated symbol the unit's codeRegion declares is the fixture's too.
    expect(file).toContain("useCoAgentStateRenderBridge");
  });

  it("emits nothing for an orphaned comment (no load-bearing prose)", async () => {
    // A comment that is only decorative headers/rule lines strips down to empty
    // prose. Rather than emit a malformed claim ("As implemented in `x`, ."),
    // the adapter must emit nothing.
    const out = await sourceCommentAdapter.extract(
      makeUnit({
        commentText: "The Problem\n-----------\nThe Solution\n------------",
      }),
      CTX,
    );
    expect(out).toEqual([]);
  });

  it("clamps re_verify_by so a +3-month roll never skips a month (end-of-month overflow)", async () => {
    // 2026-11-30 + 3 months is February, but a naive setUTCMonth(+3) overflows
    // (Feb has no 30th) and rolls forward to 2027-03-02, silently SKIPPING
    // February. The correct +3 lands on the clamped last valid day of Feb 2027
    // (2027-02-28). This guards against the month-skip bug.
    const endOfNov: AdapterContext = {
      now: new Date("2026-11-30T00:00:00.000Z"),
    };
    const [frag] = await sourceCommentAdapter.extract(makeUnit(), endOfNov);
    const reVerifyBy = frag.provenance.classification.freshness.re_verify_by;
    expect(reVerifyBy).toBe("2027-02-28");
  });

  it("does NOT decapitalize an acronym-led sentence when embedding it in the claim", async () => {
    // The selected core sentence leads with an acronym ("API ..."). Naively
    // lowercasing the first letter yields garbage ("aPI ..."), so the
    // decapitalize step must leave acronym-shaped leading words intact.
    const unit = makeUnit({
      commentText:
        "API consumers bind directly to the captured messageId rather than the live message. This coupling is intentional.",
    });
    const [frag] = await sourceCommentAdapter.extract(unit, CTX);
    expect(frag.content).not.toContain("aPI");
    expect(frag.content).toContain("API consumers bind");
  });

  it("still decapitalizes a normal capitalized sentence when embedding it", async () => {
    // Regression guard for the acronym fix: ordinary sentences ("Bind each
    // render ...") must still lower-case their first letter so they read as a
    // mid-claim clause after the synthesized lead.
    const [frag] = await sourceCommentAdapter.extract(makeUnit(), CTX);
    expect(frag.content).toContain(", bind each render");
    expect(frag.content).not.toContain(", Bind each render");
  });

  it("distills a //-style design block — no '//' markers, headers, or rule lines leak into the claim", async () => {
    // `//` is the dominant comment style in the harvested repos (incl. the
    // canonical §12.2 example's siblings). The marker strip must be
    // comment-style-agnostic, not JSDoc-`*`-only.
    const unit = makeUnit({
      commentText: [
        "// The Problem",
        "// -----------",
        "// Async renders can land on the wrong message, so custom UI detaches",
        "// from the message that triggered it.",
        "//",
        "// The Solution",
        "// ------------",
        "// Bind each render to the messageId captured at request time. This",
        "// coupling is intentional.",
      ].join("\n"),
    });
    const [frag] = await sourceCommentAdapter.extract(unit, CTX);
    expect(frag.content).not.toContain("//");
    expect(frag.content).not.toContain("The Problem");
    expect(frag.content).not.toContain("The Solution");
    expect(frag.content).not.toMatch(/-{3,}/);
    expect(frag.title).not.toContain("//");
    expect(frag.content.toLowerCase()).toContain("messageid");
  });

  it("distills JSDoc-fenced (/** … */) and #-style blocks without marker leakage", async () => {
    // Full JSDoc fences: the `/**` open and `*/` close lines strip to empty and
    // are dropped rather than surviving as garbage prose.
    const jsdoc = makeUnit({
      commentText: [
        "/**",
        " * The Problem",
        " * -----------",
        " * Renders detach from their originating message.",
        " *",
        " * The Solution",
        " * ------------",
        " * Bind each render to the captured messageId. This coupling is",
        " * intentional.",
        " */",
      ].join("\n"),
    });
    const [jsdocFrag] = await sourceCommentAdapter.extract(jsdoc, CTX);
    expect(jsdocFrag.content).not.toContain("/*");
    expect(jsdocFrag.content).not.toContain("*/");
    expect(jsdocFrag.content).not.toContain("The Problem");
    expect(jsdocFrag.content.toLowerCase()).toContain("messageid");

    // `#` style (shell/Python/YAML design blocks).
    const hash = makeUnit({
      commentText: [
        "# The Problem",
        "# -----------",
        "# Renders detach from their originating message.",
        "#",
        "# The Solution",
        "# ------------",
        "# Bind each render to the captured messageId. This coupling is",
        "# intentional.",
      ].join("\n"),
    });
    const [hashFrag] = await sourceCommentAdapter.extract(hash, CTX);
    expect(hashFrag.content).not.toContain("#");
    expect(hashFrag.content).not.toContain("The Problem");
    expect(hashFrag.content.toLowerCase()).toContain("messageid");
  });

  it("falls back to a 'derived' sourcetype-less unit gracefully (no comment headers leak)", async () => {
    // A design block without the literal 'The Problem/The Solution' headers
    // should still distill (the adapter must not depend on those exact tokens).
    const unit = makeUnit({
      commentText:
        "We deliberately keep the retry budget and the circuit-breaker threshold coupled: decoupling them lets a half-open breaker exhaust the budget before recovery. This coupling is intentional.",
      filePath: "packages/runtime/src/agent/index.ts",
      lineStart: 1250,
      lineEnd: 1280,
      subsystem: "cpk-runtime",
      sourceUrl: undefined,
    });
    const [frag] = await sourceCommentAdapter.extract(unit, CTX);
    expect(frag.provenance.classification.provenance_class).toBe("derived");
    expect(frag.content).not.toContain("We deliberately keep the retry budget");
    expect(frag.content.length).toBeGreaterThan(0);
  });

  it("returns the TRIMMED subsystem for a padded unit.subsystem", async () => {
    // subsystemFor checks `unit.subsystem.trim() !== ""` but must also RETURN
    // the trimmed value — `subsystem` is a STRUCTURAL canonical-key component
    // (<sourcetype>:<subsystem>:<claim-slug>), and a padded " cpk-react-core "
    // would mint a padded canonical key downstream.
    const [frag] = await sourceCommentAdapter.extract(
      makeUnit({ subsystem: " cpk-react-core " }),
      CTX,
    );
    expect(frag.subsystem).toBe("cpk-react-core");
  });
});
