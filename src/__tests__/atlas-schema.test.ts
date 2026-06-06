import { describe, expect, it } from "vitest";
import { generatePostSchemaMigration } from "../db/schema.js";

describe("Atlas schema foundation", () => {
  const sql = generatePostSchemaMigration();

  it("creates durable atlas seed entries with provenance and ratification fields", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS atlas_seed_entries");
    for (const column of [
      "canonical_key",
      "source_name",
      "repo_url",
      "ref",
      "subsystem",
      "status",
      "provenance",
      "evidence",
      "approved_by",
      "approved_at",
      "rejected_by",
      "rejected_at",
      "created_at",
      "updated_at",
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql).toContain("atlas_seed_entries_canonical_key_uniq");
    expect(sql).toContain(
      "CHECK (status IN ('pending', 'approved', 'rejected'))",
    );
    expect(sql).toContain("provenance     JSONB NOT NULL DEFAULT '{}'");
    expect(sql).toContain("evidence       JSONB NOT NULL DEFAULT '[]'");
  });

  it("creates useful atlas seed indexes", () => {
    expect(sql).toContain(
      "CREATE INDEX IF NOT EXISTS idx_atlas_seed_entries_status",
    );
    expect(sql).toContain(
      "CREATE INDEX IF NOT EXISTS idx_atlas_seed_entries_source_name",
    );
    expect(sql).toContain(
      "CREATE INDEX IF NOT EXISTS idx_atlas_seed_entries_repo_ref_subsystem",
    );
  });

  it("creates disposable atlas cache pages with stale and generation metadata", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS atlas_cache_pages");
    for (const column of [
      "page_key",
      "source_name",
      "title",
      "content_hash",
      "stale",
      "stale_reason",
      "generated_seed_ids",
      "provenance",
      "generated_at",
      "error_at",
      "error_message",
      "created_at",
      "updated_at",
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql).toContain("atlas_cache_pages_page_key_uniq");
    expect(sql).toContain("stale          BOOLEAN NOT NULL DEFAULT FALSE");
    expect(sql).toContain("generated_seed_ids JSONB NOT NULL DEFAULT '[]'");
  });

  it("creates useful atlas cache indexes", () => {
    expect(sql).toContain(
      "CREATE INDEX IF NOT EXISTS idx_atlas_cache_pages_source_name",
    );
    expect(sql).toContain(
      "CREATE INDEX IF NOT EXISTS idx_atlas_cache_pages_stale",
    );
    expect(sql).toContain(
      "CREATE INDEX IF NOT EXISTS idx_atlas_cache_pages_generated_at",
    );
  });
});
