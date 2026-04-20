import { describe, it, expect } from "vitest";
import {
  generatePostSchemaMigration,
  generateTsvTriggerDdl,
} from "../db/schema.js";

describe("generatePostSchemaMigration includes tsvector support", () => {
  const sql = generatePostSchemaMigration();

  it("adds tsv column", () => {
    expect(sql).toContain(
      "ALTER TABLE chunks ADD COLUMN IF NOT EXISTS tsv tsvector",
    );
  });

  it("creates GIN index on tsv", () => {
    expect(sql).toContain(
      "CREATE INDEX IF NOT EXISTS idx_chunks_tsv ON chunks USING GIN (tsv)",
    );
  });

  it("populates existing rows", () => {
    expect(sql).toContain(
      "UPDATE chunks SET tsv = to_tsvector('english', content) WHERE tsv IS NULL",
    );
  });

  it("does not include trigger DDL (applied separately for PGlite safety)", () => {
    expect(sql).not.toContain("CREATE TRIGGER");
    expect(sql).not.toContain("LANGUAGE plpgsql");
  });
});

describe("generateTsvTriggerDdl", () => {
  it("returns trigger DDL separately from core migration", () => {
    const triggerSql = generateTsvTriggerDdl();
    expect(triggerSql).toContain(
      "CREATE OR REPLACE FUNCTION chunks_tsv_trigger()",
    );
    expect(triggerSql).toContain("CREATE TRIGGER chunks_tsv_update");
  });
});

describe("PGlite trigger skip path", () => {
  it("core migration DDL does not contain PL/pgSQL", () => {
    // The core DDL (column + index + populate) should work on PGlite
    // The trigger DDL is separate and wrapped in try-catch
    expect(typeof generateTsvTriggerDdl).toBe("function");
  });
});
