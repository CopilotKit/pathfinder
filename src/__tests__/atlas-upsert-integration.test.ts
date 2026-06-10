import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { __setPoolForTesting, __resetPoolForTesting } from "../db/client.js";
import { generatePostSchemaMigration } from "../db/schema.js";
import {
  upsertAtlasSeedCandidate,
  approveAtlasSeedEntry,
  listPendingAtlasSeedCandidates,
} from "../db/atlas.js";
import { toSeedEntryRow } from "../atlas/types.js";
import type { Candidate } from "../atlas/types.js";

// Real-DB integration for the harvest's write path. The org rule is explicit:
// NEVER mock the DB for SQL semantics — the pending-only mutation guard and the
// approved-row immutability live in `upsertAtlasSeedCandidate`'s ON CONFLICT
// body, so they must be exercised against a real Postgres-compatible engine.
// We use the in-repo PGlite seam (`__setPoolForTesting` from src/db/client.ts)
// exactly as atlas-db.test.ts / atlas-ratification-endpoints.test.ts do.
//
// This slot's specific contract: the S0 `toSeedEntryRow(candidate)` bridge maps
// a finalized Candidate (snake_case contract fields) onto the REAL camelCase
// UpsertAtlasSeedCandidateInput, and the resulting row round-trips through the
// REAL upsert as a `pending` row, refreshes on re-run, and is NOT clobbered
// once approved (spec §5).

const ATLAS_DDL_MARKER = "-- Atlas durable seed knowledge.";

function extractAtlasDdl(): string {
  const sql = generatePostSchemaMigration();
  const idx = sql.indexOf(ATLAS_DDL_MARKER);
  if (idx < 0) {
    throw new Error(`Could not locate "${ATLAS_DDL_MARKER}" in schema SQL`);
  }
  return sql.slice(idx);
}

function poolFromPglite(db: PGlite) {
  return {
    query: (text: string, params?: unknown[]) => db.query(text, params),
    connect: async () => ({
      query: (text: string, params?: unknown[]) => db.query(text, params),
      release: () => {},
    }),
    end: async () => db.close(),
  };
}

// A finalized Candidate matching the S0 CandidateSchema. The harvest produces
// these; toSeedEntryRow bridges them to the storage layer.
function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    sourcetype: "github-pr",
    subsystem: "runtime",
    source_name: "atlas",
    repo_url: "https://github.com/CopilotKit/pathfinder",
    ref: "main",
    title: "Runtime executes tools before streaming the final message",
    content:
      "The runtime drains the tool queue before emitting the terminal " +
      "assistant message so partial tool state never leaks to the client.",
    provenance: {
      source: "github-pr",
      url: "https://github.com/CopilotKit/pathfinder/pull/42",
      classification: {
        sensitivity: "public",
        knowledge_type: "architecture",
        audience: "all-staff",
        validation_status: "source-verified",
        confidence: "high",
        provenance_class: "primary",
        freshness: { as_of: "2026-06-08" },
      },
    },
    evidence: [{ kind: "changed_file", path: "src/runtime/stream.ts" }],
    needsReview: false,
    validationTargets: [],
    canonical_key: "github-pr:runtime:tools-before-stream",
    rankScore: 0.87,
    approvable: true,
    ...overrides,
  };
}

describe("Atlas harvest upsert integration (real PGlite)", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.waitReady;
    await db.exec(extractAtlasDdl());
    __setPoolForTesting(poolFromPglite(db));
  });

  afterAll(async () => {
    __resetPoolForTesting();
    await db.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM atlas_cache_pages");
    await db.query("DELETE FROM atlas_seed_entries");
  });

  it("writes a pending row from a finalized Candidate via toSeedEntryRow", async () => {
    const candidate = makeCandidate();

    const row = await upsertAtlasSeedCandidate(toSeedEntryRow(candidate));

    expect(row.status).toBe("pending");
    expect(row.canonicalKey).toBe("github-pr:runtime:tools-before-stream");
    expect(row.sourceName).toBe("atlas");
    expect(row.repoUrl).toBe("https://github.com/CopilotKit/pathfinder");
    expect(row.ref).toBe("main");
    expect(row.subsystem).toBe("runtime");
    expect(row.title).toBe(candidate.title);
    expect(row.content).toBe(candidate.content);
    // provenance + evidence persist as JSONB and round-trip byte-compatibly.
    expect(row.provenance).toMatchObject({
      source: "github-pr",
      classification: { sensitivity: "public", knowledge_type: "architecture" },
    });
    expect(row.evidence).toEqual([
      { kind: "changed_file", path: "src/runtime/stream.ts" },
    ]);

    const pending = await listPendingAtlasSeedCandidates();
    expect(pending.map((p) => p.canonicalKey)).toEqual([
      "github-pr:runtime:tools-before-stream",
    ]);
  });

  it("REFRESHES the pending row in place on a re-run with updated content", async () => {
    const first = await upsertAtlasSeedCandidate(
      toSeedEntryRow(makeCandidate()),
    );

    const updated = await upsertAtlasSeedCandidate(
      toSeedEntryRow(
        makeCandidate({
          title: "Runtime now flushes tool state atomically",
          content: "Refined rationale after a follow-up PR.",
          rankScore: 0.95,
        }),
      ),
    );

    // Same row (idempotent on canonical_key), but the pending fields refresh.
    expect(updated.id).toBe(first.id);
    expect(updated.status).toBe("pending");
    expect(updated.title).toBe("Runtime now flushes tool state atomically");
    expect(updated.content).toBe("Refined rationale after a follow-up PR.");

    const pending = await listPendingAtlasSeedCandidates();
    expect(pending).toHaveLength(1);
  });

  it("does NOT clobber an approved row on re-upsert (pending-only mutation, §5)", async () => {
    const candidate = makeCandidate();
    await upsertAtlasSeedCandidate(toSeedEntryRow(candidate));
    await approveAtlasSeedEntry(
      candidate.canonical_key,
      "reviewer@example.test",
    );

    const reUpserted = await upsertAtlasSeedCandidate(
      toSeedEntryRow(
        makeCandidate({
          title: "MUST NOT overwrite an approved row",
          content: "MUST NOT overwrite the approved content",
        }),
      ),
    );

    // The approved row is immutable to the harvest: status, title, content all
    // retain their pre-approval values, and approver attribution is preserved.
    expect(reUpserted.status).toBe("approved");
    expect(reUpserted.title).toBe(candidate.title);
    expect(reUpserted.content).toBe(candidate.content);
    expect(reUpserted.approvedBy).toBe("reviewer@example.test");

    // An approved row is no longer pending — the harvest cannot resurrect it.
    const pending = await listPendingAtlasSeedCandidates();
    expect(pending).toHaveLength(0);
  });
});
