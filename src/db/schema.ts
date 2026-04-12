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
 * Generate post-schema migration SQL for columns added after initial release.
 * Safe to run repeatedly — uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
 */
export function generatePostSchemaMigration(): string {
  return `
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS version TEXT;
CREATE INDEX IF NOT EXISTS idx_chunks_version ON chunks (version);
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
