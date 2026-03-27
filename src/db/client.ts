import pg from "pg";
import pgvector from "pgvector/pg";
import { generateSchema, generateMigration } from "./schema.js";
import { getServerConfig } from "../config.js";

let pool: pg.Pool | null = null;

/**
 * Returns a singleton pg Pool, creating it on first call.
 * Reads DATABASE_URL from the environment.
 */
export function getPool(): pg.Pool {
    if (pool) return pool;

    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        throw new Error("DATABASE_URL environment variable is required");
    }

    pool = new pg.Pool({
        connectionString: databaseUrl,
    });

    return pool;
}

/**
 * Runs migration (drop old tables) then creates the unified schema.
 * Idempotent — all DDL uses IF NOT EXISTS / IF EXISTS.
 * Also registers the pgvector type so vector columns are handled correctly.
 */
export async function initializeSchema(): Promise<void> {
    const p = getPool();

    // Register pgvector type — must use a client, not the pool directly
    const client = await p.connect();
    try {
        await pgvector.registerType(client);
    } finally {
        client.release();
    }

    const dimensions = getServerConfig().embedding.dimensions;

    // Drop old split tables (doc_chunks, code_chunks) if they exist
    await p.query(generateMigration());

    // Create unified schema
    await p.query(generateSchema(dimensions));
}
