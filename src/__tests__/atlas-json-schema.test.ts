// T3 — Atlas JSON Schema derivation tests (spec §4.1, §7.1, §7.3).
//
// Verifies the family-picker + the two derived JSON Schema documents in
// `src/atlas/json-schema.ts`:
//
//   1. Each derived schema has the expected top-level structure (`object`
//      type at the schema root, regardless of whether zod-to-json-schema
//      wraps it in `definitions`).
//   2. `jsonSchemaForFamily("episodic")` returns the episodic schema by
//      reference; every other `SourceType` returns the base schema.
//   3. Conformance test — a known-good fragment validates against the
//      derived JSON Schema via ajv. This guards against silent prop-drop
//      in the zod-to-json-schema converter (any required property the
//      converter loses would cause the validator to accept a malformed
//      fragment OR reject a valid one).
//
// ajv is a JSON Schema validator (Draft-07 / 2019-09 / 2020-12); the
// zod-to-json-schema output targets Draft-07 by default, which ajv@8
// supports natively. ajv-formats wires the standard format keywords
// (`uri`, `date-time`, etc.) even though we don't currently use them on
// the fragment — added defensively so a future `.regex(...)` / format
// constraint added to types.ts surfaces immediately.

import { describe, it, expect } from "vitest";
// ajv + ajv-formats ship CJS default exports; under our ESM `"type": "module"`
// + `verbatimModuleSyntax` config, the runtime value lives on `.default` while
// the type still resolves through the namespace import. Pull both off `.default`.
import * as ajvNs from "ajv";
import * as ajvFormatsNs from "ajv-formats";
const Ajv = (ajvNs as unknown as { default: typeof import("ajv").default })
  .default;
const addFormats = (
  ajvFormatsNs as unknown as { default: typeof import("ajv-formats").default }
).default;

import {
  CANDIDATE_FRAGMENT_JSON_SCHEMA,
  EPISODIC_CANDIDATE_FRAGMENT_JSON_SCHEMA,
  jsonSchemaForFamily,
} from "../atlas/json-schema.js";
import {
  CandidateFragmentSchema,
  type CandidateFragment,
} from "../atlas/types.js";

// A structurally-valid CandidateFragment matching the §9.3 contract. Mirrors
// the cross-source-subsystem fixture shape (notion-doc fragment from
// fixtures/atlas/aggregate/cross-source-subsystem.json) but inlined so the
// test does not depend on fixture-file path stability.
const KNOWN_GOOD_FRAGMENT: CandidateFragment = {
  sourcetype: "notion-doc",
  subsystem: "agui-protocol",
  claimSlugHint: "interrupt-resume-keying",
  source_name: "notion-doc",
  repo_url: "https://github.com/ag-ui-protocol/ag-ui",
  ref: "interrupts-adr",
  title: "Interrupt resume links via interruptId, NOT parentRunId",
  content:
    "The Interrupts design decided a resume is linked to its interrupt via interruptId rather than parentRunId.",
  provenance: {
    source: "notion-doc",
    url: "https://www.notion.so/copilotkit/Interrupts-Proposal-Design-Decisions-Reasoning",
    date: "2026-04-18",
    classification: {
      sensitivity: "internal",
      knowledge_type: "design-rationale",
      audience: "engineering",
      validation_status: "source-verified",
      confidence: "high",
      provenance_class: "primary",
      freshness: { as_of: "2026-04-18", re_verify_by: "2026-09-18" },
    },
  },
  evidence: [
    {
      kind: "thread",
      body: "Interrupts Proposal — Design Decisions & Reasoning",
    },
  ],
  needsReview: false,
  validationTargets: [],
};

// Sanity check — the inline fragment matches the Zod contract. If this fails,
// the conformance assertion below would test a different schema than the one
// the rest of the harvest pipeline parses (silent test rot).
describe("KNOWN_GOOD_FRAGMENT sanity", () => {
  it("parses against the Zod CandidateFragmentSchema", () => {
    expect(() =>
      CandidateFragmentSchema.parse(KNOWN_GOOD_FRAGMENT),
    ).not.toThrow();
  });
});

// `zod-to-json-schema` with `name: "..."` wraps the derived schema in a
// top-level `{ $ref: "#/definitions/<name>", definitions: { <name>: {...} } }`
// container. With `$refStrategy: "none"` the SUB-schemas are inlined, but
// the OUTER wrapper still exists. Both ajv and a manual structural check
// need to drill through `definitions[name]` to reach the actual schema body.
function rootSchemaBody(
  schema: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  const defs = schema.definitions as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (defs && defs[name]) return defs[name];
  // Fallback if a future zod-to-json-schema version stops wrapping.
  return schema;
}

describe("CANDIDATE_FRAGMENT_JSON_SCHEMA shape", () => {
  it("derives an object schema with the expected required keys", () => {
    const schema = CANDIDATE_FRAGMENT_JSON_SCHEMA as Record<string, unknown>;
    const body = rootSchemaBody(schema, "CandidateFragment");
    expect(body.type).toBe("object");
    // Top-level required-shape keys per spec §9.3 (mirrors
    // CandidateFragmentObject.shape in types.ts).
    const properties = body.properties as Record<string, unknown>;
    expect(properties).toBeDefined();
    for (const key of [
      "sourcetype",
      "subsystem",
      "source_name",
      "title",
      "content",
      "provenance",
      "evidence",
      "needsReview",
      "validationTargets",
    ]) {
      expect(Object.keys(properties)).toContain(key);
    }
  });

  it("validates a known-good fragment via ajv", () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(CANDIDATE_FRAGMENT_JSON_SCHEMA);
    const ok = validate(KNOWN_GOOD_FRAGMENT);
    if (!ok) {
      // Surface ajv errors so a converter regression is debuggable.
      throw new Error(
        `ajv rejected a known-good fragment: ${JSON.stringify(validate.errors, null, 2)}`,
      );
    }
    expect(ok).toBe(true);
  });
});

describe("EPISODIC_CANDIDATE_FRAGMENT_JSON_SCHEMA shape", () => {
  it("derives an object schema (sub-shape inherited from base)", () => {
    const schema = EPISODIC_CANDIDATE_FRAGMENT_JSON_SCHEMA as Record<
      string,
      unknown
    >;
    const body = rootSchemaBody(schema, "EpisodicCandidateFragment");
    expect(body.type).toBe("object");
    const properties = body.properties as Record<string, unknown>;
    expect(properties).toBeDefined();
    expect(Object.keys(properties)).toContain("sourcetype");
    expect(Object.keys(properties)).toContain("needsReview");
  });
});

describe("jsonSchemaForFamily", () => {
  it("returns the episodic schema for family=episodic", () => {
    expect(jsonSchemaForFamily("episodic")).toBe(
      EPISODIC_CANDIDATE_FRAGMENT_JSON_SCHEMA,
    );
  });

  it("returns the base schema for non-episodic families", () => {
    // Cover several non-episodic SourceType values to guard against a future
    // `if/else` ladder that special-cases more than just episodic.
    for (const family of [
      "memory",
      "github-pr",
      "github-issue",
      "notion-doc",
      "linear-doc",
      "agent-doc",
      "derived",
    ] as const) {
      expect(jsonSchemaForFamily(family)).toBe(CANDIDATE_FRAGMENT_JSON_SCHEMA);
    }
  });
});
