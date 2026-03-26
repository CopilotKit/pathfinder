import pgvector from "pgvector";
import { getPool } from "./client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DocChunk {
    source_url: string;
    title: string;
    content: string;
    embedding: number[];
    file_path: string;
    chunk_index: number;
    metadata?: Record<string, unknown>;
    commit_sha?: string;
}

export interface DocChunkResult {
    id: number;
    source_url: string;
    title: string;
    content: string;
    file_path: string;
    similarity: number;
}

export interface CodeChunk {
    repo_url: string;
    file_path: string;
    content: string;
    embedding: number[];
    start_line: number;
    end_line: number;
    language: string;
    chunk_index: number;
    metadata?: Record<string, unknown>;
    commit_sha?: string;
}

export interface CodeChunkResult {
    id: number;
    repo_url: string;
    file_path: string;
    content: string;
    start_line: number;
    end_line: number;
    language: string;
    similarity: number;
}

export type IndexStatus = 'idle' | 'indexing' | 'error';

export interface IndexState {
    source_type: string;
    source_key: string;
    last_commit_sha?: string | null;
    last_indexed_at?: Date | null;
    status?: IndexStatus;
    error_message?: string | null;
}

// ---------------------------------------------------------------------------
// Search queries
// ---------------------------------------------------------------------------

/**
 * Cosine similarity search on doc_chunks.
 * Returns results ordered by similarity (highest first).
 */
export async function searchDocChunks(
    embedding: number[],
    limit: number,
): Promise<DocChunkResult[]> {
    const pool = getPool();
    const sql = `
        SELECT
            id,
            source_url,
            title,
            content,
            file_path,
            1 - (embedding <=> $1) AS similarity
        FROM doc_chunks
        ORDER BY embedding <=> $1
        LIMIT $2
    `;
    const { rows } = await pool.query(sql, [pgvector.toSql(embedding), limit]);
    return rows.map((r: Record<string, unknown>) => ({
        id: r.id as number,
        source_url: r.source_url as string,
        title: r.title as string,
        content: r.content as string,
        file_path: r.file_path as string,
        similarity: parseFloat(r.similarity as string),
    }));
}

/**
 * Cosine similarity search on code_chunks, optionally filtered by repo_url.
 * Returns results ordered by similarity (highest first).
 */
export async function searchCodeChunks(
    embedding: number[],
    limit: number,
    repoUrl?: string,
): Promise<CodeChunkResult[]> {
    const pool = getPool();

    let sql: string;
    let params: unknown[];

    if (repoUrl) {
        sql = `
            SELECT
                id,
                repo_url,
                file_path,
                content,
                start_line,
                end_line,
                language,
                1 - (embedding <=> $1) AS similarity
            FROM code_chunks
            WHERE repo_url = $2
            ORDER BY embedding <=> $1
            LIMIT $3
        `;
        params = [pgvector.toSql(embedding), repoUrl, limit];
    } else {
        sql = `
            SELECT
                id,
                repo_url,
                file_path,
                content,
                start_line,
                end_line,
                language,
                1 - (embedding <=> $1) AS similarity
            FROM code_chunks
            ORDER BY embedding <=> $1
            LIMIT $2
        `;
        params = [pgvector.toSql(embedding), limit];
    }

    const { rows } = await pool.query(sql, params);
    return rows.map((r: Record<string, unknown>) => ({
        id: r.id as number,
        repo_url: r.repo_url as string,
        file_path: r.file_path as string,
        content: r.content as string,
        start_line: r.start_line as number,
        end_line: r.end_line as number,
        language: r.language as string,
        similarity: parseFloat(r.similarity as string),
    }));
}

// ---------------------------------------------------------------------------
// Upsert queries
// ---------------------------------------------------------------------------

/**
 * Batch upsert doc chunks. Uses ON CONFLICT to update existing rows
 * matched by (file_path, chunk_index).
 */
export async function upsertDocChunks(chunks: DocChunk[]): Promise<void> {
    if (chunks.length === 0) return;

    const pool = getPool();
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const sql = `
            INSERT INTO doc_chunks
                (source_url, title, content, embedding, file_path, chunk_index, metadata, commit_sha, indexed_at)
            VALUES
                ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
            ON CONFLICT (file_path, chunk_index) DO UPDATE SET
                source_url = EXCLUDED.source_url,
                title      = EXCLUDED.title,
                content    = EXCLUDED.content,
                embedding  = EXCLUDED.embedding,
                metadata   = EXCLUDED.metadata,
                commit_sha = EXCLUDED.commit_sha,
                indexed_at = NOW()
        `;

        for (const chunk of chunks) {
            await client.query(sql, [
                chunk.source_url,
                chunk.title,
                chunk.content,
                pgvector.toSql(chunk.embedding),
                chunk.file_path,
                chunk.chunk_index,
                JSON.stringify(chunk.metadata ?? {}),
                chunk.commit_sha ?? null,
            ]);
        }

        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Batch upsert code chunks. Uses ON CONFLICT to update existing rows
 * matched by (repo_url, file_path, chunk_index).
 */
export async function upsertCodeChunks(chunks: CodeChunk[]): Promise<void> {
    if (chunks.length === 0) return;

    const pool = getPool();
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const sql = `
            INSERT INTO code_chunks
                (repo_url, file_path, content, embedding, start_line, end_line, language, chunk_index, metadata, commit_sha, indexed_at)
            VALUES
                ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
            ON CONFLICT (repo_url, file_path, chunk_index) DO UPDATE SET
                content    = EXCLUDED.content,
                embedding  = EXCLUDED.embedding,
                start_line = EXCLUDED.start_line,
                end_line   = EXCLUDED.end_line,
                language   = EXCLUDED.language,
                metadata   = EXCLUDED.metadata,
                commit_sha = EXCLUDED.commit_sha,
                indexed_at = NOW()
        `;

        for (const chunk of chunks) {
            await client.query(sql, [
                chunk.repo_url,
                chunk.file_path,
                chunk.content,
                pgvector.toSql(chunk.embedding),
                chunk.start_line,
                chunk.end_line,
                chunk.language,
                chunk.chunk_index,
                JSON.stringify(chunk.metadata ?? {}),
                chunk.commit_sha ?? null,
            ]);
        }

        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

// ---------------------------------------------------------------------------
// Delete queries
// ---------------------------------------------------------------------------

/**
 * Delete all doc chunks for a given file path.
 */
export async function deleteDocChunksByFile(filePath: string): Promise<void> {
    const pool = getPool();
    await pool.query("DELETE FROM doc_chunks WHERE file_path = $1", [filePath]);
}

/**
 * Delete all code chunks for a given repo + file path.
 */
export async function deleteCodeChunksByFile(
    repoUrl: string,
    filePath: string,
): Promise<void> {
    const pool = getPool();
    await pool.query(
        "DELETE FROM code_chunks WHERE repo_url = $1 AND file_path = $2",
        [repoUrl, filePath],
    );
}

// ---------------------------------------------------------------------------
// Index state queries
// ---------------------------------------------------------------------------

/**
 * Get the indexing state for a given source.
 */
export async function getIndexState(
    sourceType: string,
    sourceKey: string,
): Promise<IndexState | null> {
    const pool = getPool();
    const sql = `
        SELECT source_type, source_key, last_commit_sha, last_indexed_at, status, error_message
        FROM index_state
        WHERE source_type = $1 AND source_key = $2
    `;
    const { rows } = await pool.query(sql, [sourceType, sourceKey]);
    if (rows.length === 0) return null;

    const row = rows[0];
    return {
        source_type: row.source_type,
        source_key: row.source_key,
        last_commit_sha: row.last_commit_sha,
        last_indexed_at: row.last_indexed_at,
        status: row.status,
        error_message: row.error_message,
    };
}

/**
 * Upsert the indexing state for a given source.
 */
export async function upsertIndexState(state: IndexState): Promise<void> {
    const pool = getPool();
    const sql = `
        INSERT INTO index_state
            (source_type, source_key, last_commit_sha, last_indexed_at, status, error_message)
        VALUES
            ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (source_type, source_key) DO UPDATE SET
            last_commit_sha = EXCLUDED.last_commit_sha,
            last_indexed_at = EXCLUDED.last_indexed_at,
            status          = EXCLUDED.status,
            error_message   = EXCLUDED.error_message
    `;
    await pool.query(sql, [
        state.source_type,
        state.source_key,
        state.last_commit_sha ?? null,
        state.last_indexed_at ?? null,
        state.status ?? "idle",
        state.error_message ?? null,
    ]);
}
