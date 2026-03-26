-- pgvector schema — applied automatically by docker-entrypoint-initdb.d
-- Idempotent: safe to run multiple times

CREATE EXTENSION IF NOT EXISTS vector;

-- doc_chunks: stores documentation content with embeddings
CREATE TABLE IF NOT EXISTS doc_chunks (
    id          SERIAL PRIMARY KEY,
    source_url  TEXT NOT NULL,
    title       TEXT NOT NULL,
    content     TEXT NOT NULL,
    embedding   vector(1536) NOT NULL,
    file_path   TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    metadata    JSONB NOT NULL DEFAULT '{}',
    indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    commit_sha  TEXT,

    CONSTRAINT doc_chunks_file_chunk_uniq UNIQUE (file_path, chunk_index)
);

-- code_chunks: stores code content with embeddings
CREATE TABLE IF NOT EXISTS code_chunks (
    id          SERIAL PRIMARY KEY,
    repo_url    TEXT NOT NULL,
    file_path   TEXT NOT NULL,
    content     TEXT NOT NULL,
    embedding   vector(1536) NOT NULL,
    start_line  INTEGER NOT NULL,
    end_line    INTEGER NOT NULL,
    language    TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    metadata    JSONB NOT NULL DEFAULT '{}',
    indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    commit_sha  TEXT,

    CONSTRAINT code_chunks_repo_file_chunk_uniq UNIQUE (repo_url, file_path, chunk_index)
);

-- index_state: tracks per-source indexing status
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

-- HNSW indexes for cosine similarity search on embedding columns.
-- HNSW works with any number of rows (unlike IVFFlat which needs training data).
CREATE INDEX IF NOT EXISTS idx_doc_chunks_embedding
    ON doc_chunks USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_code_chunks_embedding
    ON code_chunks USING hnsw (embedding vector_cosine_ops);

-- Filtering index for code_chunks by repo_url
CREATE INDEX IF NOT EXISTS idx_code_chunks_repo_url
    ON code_chunks (repo_url);
