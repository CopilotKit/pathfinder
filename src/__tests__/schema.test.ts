import { describe, it, expect } from 'vitest';
import { generateSchema, generateMigration, generatePostSchemaMigration } from '../db/schema.js';

describe('generateSchema', () => {
    it('returns SQL containing the vector extension', () => {
        const ddl = generateSchema(1536);
        expect(ddl).toContain('CREATE EXTENSION IF NOT EXISTS vector');
    });

    it('includes the correct vector dimension in the chunks table', () => {
        const ddl = generateSchema(1536);
        expect(ddl).toContain('vector(1536)');
    });

    it('parameterizes dimensions correctly for different values', () => {
        const ddl768 = generateSchema(768);
        expect(ddl768).toContain('vector(768)');
        expect(ddl768).not.toContain('vector(1536)');

        const ddl3072 = generateSchema(3072);
        expect(ddl3072).toContain('vector(3072)');
    });

    // -- chunks table -----------------------------------------------------

    describe('chunks table', () => {
        it('creates the chunks table', () => {
            const ddl = generateSchema(1536);
            expect(ddl).toContain('CREATE TABLE IF NOT EXISTS chunks');
        });

        it('includes required columns', () => {
            const ddl = generateSchema(1536);
            const requiredColumns = [
                'source_name',
                'source_url',
                'title',
                'content',
                'embedding',
                'repo_url',
                'file_path',
                'start_line',
                'end_line',
                'language',
                'chunk_index',
                'metadata',
                'indexed_at',
                'commit_sha',
                'version',
            ];
            for (const col of requiredColumns) {
                expect(ddl).toContain(col);
            }
        });

        it('has a unique constraint on source_name, file_path, chunk_index', () => {
            const ddl = generateSchema(1536);
            expect(ddl).toContain('chunks_source_file_chunk_uniq');
            expect(ddl).toContain('UNIQUE (source_name, file_path, chunk_index)');
        });

        it('defines HNSW index on embedding column', () => {
            const ddl = generateSchema(1536);
            expect(ddl).toContain('CREATE INDEX IF NOT EXISTS idx_chunks_embedding');
            expect(ddl).toContain('USING hnsw (embedding vector_cosine_ops)');
        });

        it('defines indexes on source_name and repo_url', () => {
            const ddl = generateSchema(1536);
            expect(ddl).toContain('CREATE INDEX IF NOT EXISTS idx_chunks_source_name');
            expect(ddl).toContain('CREATE INDEX IF NOT EXISTS idx_chunks_repo_url');
        });

        it('has a serial primary key', () => {
            const ddl = generateSchema(1536);
            expect(ddl).toMatch(/id\s+SERIAL PRIMARY KEY/);
        });

        it('defaults metadata to empty JSON object', () => {
            const ddl = generateSchema(1536);
            expect(ddl).toContain("JSONB NOT NULL DEFAULT '{}'");
        });

        it('defaults indexed_at to NOW()', () => {
            const ddl = generateSchema(1536);
            expect(ddl).toContain('TIMESTAMPTZ NOT NULL DEFAULT NOW()');
        });
    });

    // -- index_state table ------------------------------------------------

    describe('index_state table', () => {
        it('creates the index_state table', () => {
            const ddl = generateSchema(1536);
            expect(ddl).toContain('CREATE TABLE IF NOT EXISTS index_state');
        });

        it('includes required columns', () => {
            const ddl = generateSchema(1536);
            const cols = ['source_type', 'source_key', 'last_commit_sha', 'last_indexed_at', 'status', 'error_message'];
            for (const col of cols) {
                expect(ddl).toContain(col);
            }
        });

        it('has a unique constraint on source_type, source_key', () => {
            const ddl = generateSchema(1536);
            expect(ddl).toContain('index_state_source_uniq');
            expect(ddl).toContain('UNIQUE (source_type, source_key)');
        });

        it('defaults status to idle', () => {
            const ddl = generateSchema(1536);
            expect(ddl).toContain("DEFAULT 'idle'");
        });
    });

    // -- collected_data table ---------------------------------------------

    describe('collected_data table', () => {
        it('creates the collected_data table', () => {
            const ddl = generateSchema(1536);
            expect(ddl).toContain('CREATE TABLE IF NOT EXISTS collected_data');
        });

        it('includes required columns', () => {
            const ddl = generateSchema(1536);
            expect(ddl).toContain('tool_name');
            expect(ddl).toContain('data');
            expect(ddl).toContain('created_at');
        });
    });
});

describe('generateMigration', () => {
    it('drops doc_chunks table', () => {
        const sql = generateMigration();
        expect(sql).toContain('DROP TABLE IF EXISTS doc_chunks CASCADE');
    });

    it('drops code_chunks table', () => {
        const sql = generateMigration();
        expect(sql).toContain('DROP TABLE IF EXISTS code_chunks CASCADE');
    });
});

describe('generatePostSchemaMigration', () => {
    it('adds version column to chunks', () => {
        const sql = generatePostSchemaMigration();
        expect(sql).toContain('ALTER TABLE chunks ADD COLUMN IF NOT EXISTS version TEXT');
    });

    it('creates index on version column', () => {
        const sql = generatePostSchemaMigration();
        expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_chunks_version ON chunks (version)');
    });
});
