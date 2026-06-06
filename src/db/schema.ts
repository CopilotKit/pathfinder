// Programmatic DDL generation for the unified chunks schema.
// Replaces the old static schema.sql file.

/**
 * Generate the full DDL for creating the unified chunks schema.
 * The vector dimension is parameterized from config.
 */
export function generateSchema(dimensions: number): string {
  return `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS chunks (
    id              SERIAL PRIMARY KEY,
    source_name     TEXT NOT NULL,
    source_url      TEXT,
    title           TEXT,
    content         TEXT NOT NULL,
    embedding       vector(${dimensions}) NOT NULL,
    repo_url        TEXT,
    file_path       TEXT NOT NULL,
    start_line      INTEGER,
    end_line        INTEGER,
    language        TEXT,
    chunk_index     INTEGER NOT NULL,
    metadata        JSONB NOT NULL DEFAULT '{}',
    indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    commit_sha      TEXT,
    version         TEXT,
    CONSTRAINT chunks_source_file_chunk_uniq UNIQUE (source_name, file_path, chunk_index)
);

CREATE TABLE IF NOT EXISTS index_state (
    id              SERIAL PRIMARY KEY,
    source_type     TEXT NOT NULL,
    source_key      TEXT NOT NULL,
    last_commit_sha TEXT,
    last_indexed_at TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'idle',
    error_message   TEXT,
    CONSTRAINT index_state_source_uniq UNIQUE (source_type, source_key)
);

CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_chunks_source_name ON chunks (source_name);
CREATE INDEX IF NOT EXISTS idx_chunks_repo_url ON chunks (repo_url);

CREATE TABLE IF NOT EXISTS collected_data (
    id          SERIAL PRIMARY KEY,
    tool_name   TEXT NOT NULL,
    data        JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;
}

/**
 * Generate migration SQL that drops the old split tables.
 * Safe to run even if they don't exist (IF EXISTS).
 */
export function generateMigration(): string {
  return `
DROP TABLE IF EXISTS doc_chunks CASCADE;
DROP TABLE IF EXISTS code_chunks CASCADE;
`;
}

/**
 * Generate post-schema migration SQL for objects added after initial release.
 * Safe to run repeatedly — uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
 *
 * Returns ONLY core DDL that works on both PostgreSQL and PGlite:
 * - tsvector support for hybrid search (v1.8.0): the `tsv` column, a one-time
 *   populate of existing rows, and the GIN index.
 * - The analytics `query_log` table (+ its indexes and the idempotent
 *   `request_source` ADD COLUMN for back-compat).
 * - The `webhook_deliveries` table (+ its indexes).
 *
 * The tsvector TRIGGER is NOT included here — it is returned separately by
 * {@link generateTsvTriggerDdl} and applied in its own try-catch by
 * initializeSchema, because PGlite does not support PL/pgSQL triggers.
 */
export function generatePostSchemaMigration(): string {
  const coreSql = `
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS version TEXT;
CREATE INDEX IF NOT EXISTS idx_chunks_version ON chunks (version);

-- Hybrid search: tsvector column for full-text search
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS tsv tsvector;

-- Populate tsvector for any existing rows that don't have it yet
UPDATE chunks SET tsv = to_tsvector('english', content) WHERE tsv IS NULL;

-- GIN index for fast full-text search
CREATE INDEX IF NOT EXISTS idx_chunks_tsv ON chunks USING GIN (tsv);

-- Analytics: query_log table for tracking tool usage
--
-- request_source tags the ORIGIN of the request (user|synthetic|analysis),
-- derived from the X-Pathfinder-Source header on the MCP init request. It is
-- distinct from source_name, which is the DATA source the tool queried (e.g.
-- "docs"). Nullable so historical rows written before this column existed read
-- back as NULL; analytics treats NULL as a real user (see db/analytics.ts).
CREATE TABLE IF NOT EXISTS query_log (
    id              SERIAL PRIMARY KEY,
    tool_name       TEXT NOT NULL,
    query_text      TEXT NOT NULL,
    result_count    INTEGER NOT NULL,
    top_score       REAL,
    latency_ms      INTEGER NOT NULL,
    source_name     TEXT,
    session_id      TEXT,
    request_source  TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_query_log_created_at ON query_log (created_at);
CREATE INDEX IF NOT EXISTS idx_query_log_tool_name ON query_log (tool_name);

-- request_source added after query_log shipped — ADD COLUMN IF NOT EXISTS keeps
-- the migration idempotent and back-compatible for installs whose query_log
-- predates the column. The CREATE TABLE above carries it for fresh installs.
ALTER TABLE query_log ADD COLUMN IF NOT EXISTS request_source TEXT;
CREATE INDEX IF NOT EXISTS idx_query_log_request_source ON query_log (request_source);

-- Webhook delivery tracking
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id              SERIAL PRIMARY KEY,
    source          TEXT NOT NULL,
    event_type      TEXT,
    repo            TEXT,
    decision        TEXT NOT NULL,
    reason          TEXT,
    payload_size    INTEGER,
    delivered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_source ON webhook_deliveries (source);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_delivered_at ON webhook_deliveries (delivered_at);

-- Atlas durable seed knowledge. Seed rows are the reviewed source of truth for
-- non-reconstructable architecture and rationale; derived pages remain cache.
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

CREATE INDEX IF NOT EXISTS idx_atlas_seed_entries_status ON atlas_seed_entries (status);
CREATE INDEX IF NOT EXISTS idx_atlas_seed_entries_source_name ON atlas_seed_entries (source_name);
CREATE INDEX IF NOT EXISTS idx_atlas_seed_entries_repo_ref_subsystem ON atlas_seed_entries (repo_url, ref, subsystem);

-- Atlas derived pages. These rows describe disposable generated pages whose
-- retrieval projection is stored in chunks.
CREATE TABLE IF NOT EXISTS atlas_cache_pages (
    id              SERIAL PRIMARY KEY,
    page_key        TEXT NOT NULL,
    source_name     TEXT NOT NULL,
    title           TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    stale          BOOLEAN NOT NULL DEFAULT FALSE,
    stale_reason    TEXT,
    generated_seed_ids JSONB NOT NULL DEFAULT '[]',
    provenance      JSONB NOT NULL DEFAULT '{}',
    generated_at    TIMESTAMPTZ,
    error_at        TIMESTAMPTZ,
    error_message   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT atlas_cache_pages_page_key_uniq UNIQUE (page_key)
);

CREATE INDEX IF NOT EXISTS idx_atlas_cache_pages_source_name ON atlas_cache_pages (source_name);
CREATE INDEX IF NOT EXISTS idx_atlas_cache_pages_stale ON atlas_cache_pages (stale);
CREATE INDEX IF NOT EXISTS idx_atlas_cache_pages_generated_at ON atlas_cache_pages (generated_at);
`;

  return coreSql;
}

/**
 * Returns ONLY the trigger DDL, for use in try-catch migration.
 * Called separately from core DDL so PGlite can skip it gracefully.
 */
export function generateTsvTriggerDdl(): string {
  return `
-- Trigger to auto-populate tsvector on insert/update of content
CREATE OR REPLACE FUNCTION chunks_tsv_trigger() RETURNS trigger AS $$
BEGIN
    NEW.tsv := to_tsvector('english', NEW.content);
    RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chunks_tsv_update ON chunks;
CREATE TRIGGER chunks_tsv_update
    BEFORE INSERT OR UPDATE OF content ON chunks
    FOR EACH ROW EXECUTE FUNCTION chunks_tsv_trigger();
`;
}

/**
 * SQL to query the current vector dimension of the embedding column.
 * Uses vector_dims() on actual data instead of pg_attribute (which PGlite may not support).
 * Returns { dimensions: number } or empty result if table has no rows.
 */
export function generateDimensionCheckQuery(): string {
  return `
SELECT vector_dims(embedding) AS dimensions
FROM chunks
LIMIT 1;
`;
}
