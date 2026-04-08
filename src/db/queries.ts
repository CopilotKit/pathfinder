import pgvector from "pgvector";
import { getPool } from "./client.js";
import type { Chunk, ChunkResult, FaqChunkResult, IndexState, IndexStatus } from "../types.js";

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Cosine similarity search on the unified chunks table.
 * Optionally filtered by source_name and/or version. Returns results ordered
 * by similarity (highest first).
 */
export async function searchChunks(
    embedding: number[],
    limit: number,
    sourceName?: string,
    version?: string,
): Promise<ChunkResult[]> {
    const pool = getPool();

    const conditions: string[] = [];
    const params: unknown[] = [pgvector.toSql(embedding)];
    let paramIdx = 2;

    if (sourceName) {
        conditions.push(`source_name = $${paramIdx++}`);
        params.push(sourceName);
    }
    if (version) {
        conditions.push(`version = $${paramIdx++}`);
        params.push(version);
    }

    const whereClause = conditions.length > 0
        ? `WHERE ${conditions.join(' AND ')}`
        : '';

    const sql = `
        SELECT
            id,
            source_name,
            source_url,
            title,
            content,
            repo_url,
            file_path,
            start_line,
            end_line,
            language,
            1 - (embedding <=> $1) AS similarity
        FROM chunks
        ${whereClause}
        ORDER BY embedding <=> $1
        LIMIT $${paramIdx}
    `;
    params.push(limit);

    const { rows } = await pool.query(sql, params);
    return rows.map((r: Record<string, unknown>) => ({
        id: r.id as number,
        source_name: r.source_name as string,
        source_url: (r.source_url as string) ?? null,
        title: (r.title as string) ?? null,
        content: r.content as string,
        repo_url: (r.repo_url as string) ?? null,
        file_path: r.file_path as string,
        start_line: (r.start_line as number) ?? null,
        end_line: (r.end_line as number) ?? null,
        language: (r.language as string) ?? null,
        similarity: parseFloat(r.similarity as string),
    }));
}

/**
 * Text search (ILIKE) on the unified chunks table.
 * Optionally filtered by source_name. Returns results ordered by id.
 */
export async function textSearchChunks(
    pattern: string,
    limit: number,
    sourceName?: string,
): Promise<ChunkResult[]> {
    const pool = getPool();
    const escaped = pattern.replace(/[%_\\]/g, '\\$&');
    const likePattern = `%${escaped}%`;
    let sql: string;
    let params: unknown[];
    if (sourceName) {
        sql = `SELECT id, source_name, source_url, title, content, repo_url, file_path, start_line, end_line, language, 0.0 AS similarity FROM chunks WHERE source_name = $1 AND content ILIKE $2 ORDER BY id LIMIT $3`;
        params = [sourceName, likePattern, limit];
    } else {
        sql = `SELECT id, source_name, source_url, title, content, repo_url, file_path, start_line, end_line, language, 0.0 AS similarity FROM chunks WHERE content ILIKE $1 ORDER BY id LIMIT $2`;
        params = [likePattern, limit];
    }
    const { rows } = await pool.query(sql, params);
    return rows.map((r: Record<string, unknown>) => ({
        id: r.id as number,
        source_name: r.source_name as string,
        source_url: (r.source_url as string) ?? null,
        title: (r.title as string) ?? null,
        content: r.content as string,
        repo_url: (r.repo_url as string) ?? null,
        file_path: r.file_path as string,
        start_line: (r.start_line as number) ?? null,
        end_line: (r.end_line as number) ?? null,
        language: (r.language as string) ?? null,
        similarity: parseFloat(r.similarity as string),
    }));
}

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------

/**
 * Batch upsert chunks. Uses ON CONFLICT to update existing rows matched by
 * (source_name, file_path, chunk_index).
 */
export async function upsertChunks(chunks: Chunk[]): Promise<void> {
    if (chunks.length === 0) return;

    const pool = getPool();
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const sql = `
            INSERT INTO chunks
                (source_name, source_url, title, content, embedding, repo_url,
                 file_path, start_line, end_line, language, chunk_index,
                 metadata, commit_sha, version, indexed_at)
            VALUES
                ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
            ON CONFLICT (source_name, file_path, chunk_index) DO UPDATE SET
                source_url = EXCLUDED.source_url,
                title      = EXCLUDED.title,
                content    = EXCLUDED.content,
                embedding  = EXCLUDED.embedding,
                repo_url   = EXCLUDED.repo_url,
                start_line = EXCLUDED.start_line,
                end_line   = EXCLUDED.end_line,
                language   = EXCLUDED.language,
                metadata   = EXCLUDED.metadata,
                commit_sha = EXCLUDED.commit_sha,
                version    = EXCLUDED.version,
                indexed_at = NOW()
        `;

        for (const chunk of chunks) {
            await client.query(sql, [
                chunk.source_name,
                chunk.source_url ?? null,
                chunk.title ?? null,
                chunk.content,
                pgvector.toSql(chunk.embedding),
                chunk.repo_url,
                chunk.file_path,
                chunk.start_line ?? null,
                chunk.end_line ?? null,
                chunk.language ?? null,
                chunk.chunk_index,
                JSON.stringify(chunk.metadata ?? {}),
                chunk.commit_sha ?? null,
                chunk.version ?? null,
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
// Delete
// ---------------------------------------------------------------------------

/**
 * Delete all chunks for a given source + file path.
 */
export async function deleteChunksByFile(
    sourceName: string,
    filePath: string,
): Promise<void> {
    const pool = getPool();
    await pool.query(
        "DELETE FROM chunks WHERE source_name = $1 AND file_path = $2",
        [sourceName, filePath],
    );
}

/**
 * Delete all chunks for a source (useful for full reindex).
 */
export async function deleteChunksBySource(sourceName: string): Promise<void> {
    const pool = getPool();
    await pool.query("DELETE FROM chunks WHERE source_name = $1", [sourceName]);
}

// ---------------------------------------------------------------------------
// Index state
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
        status: row.status as IndexStatus,
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

// ---------------------------------------------------------------------------
// Collected data
// ---------------------------------------------------------------------------

/**
 * Insert a row into the collected_data table.
 */
export async function insertCollectedData(
    toolName: string,
    data: Record<string, unknown>,
): Promise<void> {
    const pool = getPool();
    await pool.query(
        "INSERT INTO collected_data (tool_name, data) VALUES ($1, $2)",
        [toolName, JSON.stringify(data)],
    );
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export interface IndexStats {
    totalChunks: number;
    bySource: Array<{ source_name: string; count: number }>;
    indexedRepos: number;
    indexStates: IndexState[];
}

/**
 * Fetch all chunks (without embeddings) for llms.txt generation.
 * Ordered by source_name, file_path, chunk_index for deterministic output.
 */
export async function getAllChunksForLlms(): Promise<{ source_name: string; file_path: string; title: string | null; content: string; chunk_index: number }[]> {
    const pool = getPool();
    const result = await pool.query(
        'SELECT source_name, file_path, title, content, chunk_index FROM chunks ORDER BY source_name, file_path, chunk_index'
    );
    return result.rows;
}

/**
 * Fetch FAQ chunks filtered by source name and minimum confidence.
 * Confidence is stored in chunk metadata JSONB; this query extracts and filters it.
 * Results are ordered by source_name, then indexed_at DESC (most recent first).
 */
export async function getFaqChunks(
    sourceNames: string[],
    minConfidence: number,
    limit?: number,
): Promise<FaqChunkResult[]> {
    const pool = getPool();

    if (sourceNames.length === 0) return [];

    // Build parameterized source_name IN clause
    const placeholders = sourceNames.map((_, i) => `$${i + 1}`).join(', ');
    const confidenceParam = sourceNames.length + 1;

    let sql = `
        SELECT
            id,
            source_name,
            source_url,
            title,
            content,
            repo_url,
            file_path,
            start_line,
            end_line,
            language,
            0.0 AS similarity,
            metadata,
            (metadata->>'confidence')::float AS confidence
        FROM chunks
        WHERE source_name IN (${placeholders})
          AND (metadata->>'confidence')::float >= $${confidenceParam}
        ORDER BY source_name, indexed_at DESC
    `;

    const params: unknown[] = [...sourceNames, minConfidence];

    if (limit != null) {
        sql += ` LIMIT $${confidenceParam + 1}`;
        params.push(limit);
    }

    const { rows } = await pool.query(sql, params);
    return rows.map((r: Record<string, unknown>) => ({
        id: r.id as number,
        source_name: r.source_name as string,
        source_url: (r.source_url as string) ?? null,
        title: (r.title as string) ?? null,
        content: r.content as string,
        repo_url: (r.repo_url as string) ?? null,
        file_path: r.file_path as string,
        start_line: (r.start_line as number) ?? null,
        end_line: (r.end_line as number) ?? null,
        language: (r.language as string) ?? null,
        similarity: parseFloat(r.similarity as string),
        metadata: (r.metadata as Record<string, unknown>) ?? {},
        confidence: parseFloat(r.confidence as string),
    }));
}

/**
 * Get aggregate statistics for the health endpoint.
 */
export async function getIndexStats(): Promise<IndexStats> {
    const pool = getPool();

    const [totalCount, bySource, repoCount, states] = await Promise.all([
        pool.query("SELECT count(*)::int AS count FROM chunks"),
        pool.query(
            "SELECT source_name, count(*)::int AS count FROM chunks GROUP BY source_name ORDER BY source_name",
        ),
        pool.query("SELECT count(DISTINCT repo_url)::int AS count FROM chunks WHERE repo_url IS NOT NULL"),
        pool.query(
            "SELECT source_type, source_key, last_commit_sha, last_indexed_at, status, error_message FROM index_state ORDER BY source_type, source_key",
        ),
    ]);

    return {
        totalChunks: totalCount.rows[0]?.count ?? 0,
        bySource: bySource.rows.map((r: Record<string, unknown>) => ({
            source_name: r.source_name as string,
            count: r.count as number,
        })),
        indexedRepos: repoCount.rows[0]?.count ?? 0,
        indexStates: states.rows.map((r: Record<string, unknown>) => ({
            source_type: r.source_type as string,
            source_key: r.source_key as string,
            last_commit_sha: r.last_commit_sha as string | null,
            last_indexed_at: r.last_indexed_at as Date | null,
            status: r.status as IndexStatus,
            error_message: r.error_message as string | null,
        })),
    };
}
