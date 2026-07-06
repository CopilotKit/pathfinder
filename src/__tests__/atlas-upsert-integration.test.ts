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

  it("persists the derived approvable snapshot on the written row (C.1)", async () => {
    // An unverified behavior/architecture fact is NOT approvable (§7). The
    // finalized Candidate carries approvable=false; the upsert MUST persist it
    // onto the additive column so the row is a queryable audit snapshot.
    const unverifiedBehavior = makeCandidate({
      canonical_key: "github-pr:runtime:unverified-behavior",
      approvable: false,
      provenance: {
        source: "github-pr",
        url: "https://github.com/CopilotKit/pathfinder/pull/99",
        classification: {
          sensitivity: "public",
          knowledge_type: "root-cause",
          audience: "all-staff",
          validation_status: "unverified",
          confidence: "high",
          provenance_class: "primary",
          freshness: { as_of: "2026-06-08" },
        },
      },
    });

    await upsertAtlasSeedCandidate(toSeedEntryRow(unverifiedBehavior));

    const { rows } = await db.query<{ approvable: boolean }>(
      "SELECT approvable FROM atlas_seed_entries WHERE canonical_key = $1",
      ["github-pr:runtime:unverified-behavior"],
    );
    expect(rows[0]?.approvable).toBe(false);

    // A source-verified fact is approvable and persists as true.
    await upsertAtlasSeedCandidate(toSeedEntryRow(makeCandidate()));
    const approvableRow = await db.query<{ approvable: boolean }>(
      "SELECT approvable FROM atlas_seed_entries WHERE canonical_key = $1",
      ["github-pr:runtime:tools-before-stream"],
    );
    expect(approvableRow.rows[0]?.approvable).toBe(true);
  });

  it("throws a clear, contextful error when the upsert RETURNs zero rows", async () => {
    // Real-surface repro of the empty-rows crash: a BEFORE INSERT trigger that
    // returns NULL genuinely suppresses the row on the real engine, so the
    // ON CONFLICT ... RETURNING clause yields zero rows — the same shape a
    // DO-NOTHING / filtered-RETURNING path would produce in production.
    // Before the guard this fed `mapSeedRow(undefined)` and blew up with an
    // opaque "Cannot read properties of undefined (reading 'id')" and no row
    // context. After the guard it must be a clear error naming the canonical_key.
    await db.exec(`
      CREATE OR REPLACE FUNCTION __suppress_atlas_seed_insert()
      RETURNS trigger AS $$ BEGIN RETURN NULL; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER __suppress_atlas_seed_insert_trg
        BEFORE INSERT ON atlas_seed_entries
        FOR EACH ROW EXECUTE FUNCTION __suppress_atlas_seed_insert();
    `);

    try {
      const candidate = makeCandidate({
        canonical_key: "github-pr:runtime:zero-row-return",
      });

      await expect(
        upsertAtlasSeedCandidate(toSeedEntryRow(candidate)),
      ).rejects.toThrow(/github-pr:runtime:zero-row-return/);
    } finally {
      await db.exec(
        "DROP TRIGGER __suppress_atlas_seed_insert_trg ON atlas_seed_entries;",
      );
    }
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

// C.1 backfill (S10). The `approvable` column is additive; installs whose
// atlas_seed_entries predates it must backfill EACH existing row from its own
// validation_status + knowledge_type under the SAME §7 gate rule the three
// runtime gate sites use — NOT a blanket `DEFAULT true`. A blanket default
// silently blesses an unverified behavior/architecture row (approvable should be
// false), which is exactly the wrong-backfill bug the spec forbids. The runtime
// gates keep DERIVING approvability independently; the column is an audit-only
// snapshot the gates never read back.
describe("Atlas approvable column backfill (real PGlite, pre-column install)", () => {
  // The pre-column atlas_seed_entries DDL: the CREATE TABLE without the
  // `approvable` column, so we can seed a legacy row and then apply the real
  // migration's ADD COLUMN + per-row backfill against it.
  const PRE_COLUMN_ATLAS_DDL = `
CREATE TABLE IF NOT EXISTS atlas_seed_entries (
    id              SERIAL PRIMARY KEY,
    canonical_key   TEXT NOT NULL,
    source_name     TEXT NOT NULL,
    repo_url        TEXT,
    ref             TEXT,
    subsystem       TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    title           TEXT NOT NULL,
    content         TEXT NOT NULL,
    provenance     JSONB NOT NULL DEFAULT '{}',
    evidence       JSONB NOT NULL DEFAULT '[]',
    approved_by     TEXT,
    approved_at     TIMESTAMPTZ,
    rejected_by     TEXT,
    rejected_at     TIMESTAMPTZ,
    rejection_reason TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT atlas_seed_entries_canonical_key_uniq UNIQUE (canonical_key),
    CONSTRAINT atlas_seed_entries_status_check CHECK (status IN ('pending', 'approved', 'rejected'))
);
`;

  // Extract ONLY the approvable ADD COLUMN + backfill fragment from the real
  // migration so we exercise the shipped SQL (not a re-typed copy).
  const APPROVABLE_MARKER = "-- C.1 approvable audit snapshot";

  function extractApprovableMigration(): string {
    const sql = generatePostSchemaMigration();
    const idx = sql.indexOf(APPROVABLE_MARKER);
    if (idx < 0) {
      throw new Error(`Could not locate "${APPROVABLE_MARKER}" in schema SQL`);
    }
    // Take from the marker to the end of the atlas seed DDL region (the next
    // CREATE TABLE that follows is atlas_cache_pages; slice up to it).
    const rest = sql.slice(idx);
    const nextTableIdx = rest.indexOf("-- Atlas derived pages.");
    return nextTableIdx < 0 ? rest : rest.slice(0, nextTableIdx);
  }

  // A legacy unverified behavior row: knowledge_type=root-cause (a gated
  // behavior type) + validation_status=unverified → the §7 rule → approvable
  // FALSE. This is the row a blanket DEFAULT true would wrongly bless.
  const UNVERIFIED_BEHAVIOR = {
    canonical_key: "legacy:runtime:unverified-behavior",
    knowledge_type: "root-cause",
    validation_status: "unverified",
  };
  // A legacy approvable row: source-verified behavior fact → approvable TRUE.
  const VERIFIED_BEHAVIOR = {
    canonical_key: "legacy:runtime:verified-behavior",
    knowledge_type: "architecture",
    validation_status: "source-verified",
  };
  // A legacy exempt row: operational (process/etiquette) type → always
  // approvable regardless of validation_status.
  const EXEMPT_OPERATIONAL = {
    canonical_key: "legacy:runtime:operational",
    knowledge_type: "operational",
    validation_status: "unverified",
  };

  async function seedLegacyRows(db: PGlite): Promise<void> {
    for (const row of [
      UNVERIFIED_BEHAVIOR,
      VERIFIED_BEHAVIOR,
      EXEMPT_OPERATIONAL,
    ]) {
      await db.query(
        `INSERT INTO atlas_seed_entries
           (canonical_key, source_name, title, content, provenance)
         VALUES ($1, 'atlas', 'legacy', 'legacy content', $2::jsonb)`,
        [
          row.canonical_key,
          JSON.stringify({
            classification: {
              knowledge_type: row.knowledge_type,
              validation_status: row.validation_status,
            },
          }),
        ],
      );
    }
  }

  async function approvableOf(
    db: PGlite,
    canonicalKey: string,
  ): Promise<boolean | null> {
    const { rows } = await db.query<{ approvable: boolean | null }>(
      "SELECT approvable FROM atlas_seed_entries WHERE canonical_key = $1",
      [canonicalKey],
    );
    return rows[0]?.approvable ?? null;
  }

  it("RED (1b): a blanket DEFAULT true backfill WRONGLY blesses the unverified behavior row", async () => {
    // Reproduces the forbidden wrong-backfill bug: adding the column with a
    // blanket `DEFAULT true` (no per-row compute) sets approvable=true on EVERY
    // legacy row — including the unverified behavior row that the §7 gate rule
    // says must be approvable=false. This documents WHY a blanket default is
    // unsafe; the shipped migration (below) must NOT behave this way.
    const db = new PGlite();
    await db.waitReady;
    await db.exec(PRE_COLUMN_ATLAS_DDL);
    await seedLegacyRows(db);

    // The NAIVE migration the spec forbids.
    await db.exec(
      "ALTER TABLE atlas_seed_entries ADD COLUMN IF NOT EXISTS approvable BOOLEAN NOT NULL DEFAULT TRUE;",
    );

    // The unverified behavior row comes out approvable=true — WRONG. This is the
    // silent blessing the per-row backfill must prevent.
    expect(await approvableOf(db, UNVERIFIED_BEHAVIOR.canonical_key)).toBe(
      true,
    );

    await db.close();
  });

  it("GREEN: the shipped per-row backfill computes approvable from each row's own status + type", async () => {
    const db = new PGlite();
    await db.waitReady;
    await db.exec(PRE_COLUMN_ATLAS_DDL);
    await seedLegacyRows(db);

    // Apply the REAL migration fragment (ADD COLUMN + per-row backfill).
    await db.exec(extractApprovableMigration());

    // The unverified behavior row backfills to FALSE — NOT blessed.
    expect(await approvableOf(db, UNVERIFIED_BEHAVIOR.canonical_key)).toBe(
      false,
    );
    // The source-verified behavior row backfills to TRUE.
    expect(await approvableOf(db, VERIFIED_BEHAVIOR.canonical_key)).toBe(true);
    // The exempt operational row backfills to TRUE regardless of unverified.
    expect(await approvableOf(db, EXEMPT_OPERATIONAL.canonical_key)).toBe(true);

    // The column is queryable and idempotent: re-running the migration does not
    // flip any backfilled value (ADD COLUMN IF NOT EXISTS + WHERE approvable IS
    // NULL guard on the backfill).
    await db.exec(extractApprovableMigration());
    expect(await approvableOf(db, UNVERIFIED_BEHAVIOR.canonical_key)).toBe(
      false,
    );

    await db.close();
  });
});
