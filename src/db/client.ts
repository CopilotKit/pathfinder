import pg from "pg";
import pgvector from "pgvector/pg";
import { generateSchema, generateMigration } from "./schema.js";
import { getConfig, getServerConfig } from "../config.js";

let pool: pg.Pool | null = null;

/**
 * Returns a singleton pg Pool, creating it on first call.
 * Reads DATABASE_URL from the environment.
 */
export function getPool(): pg.Pool {
    if (pool) return pool;

    const databaseUrl = getConfig().databaseUrl;

    pool = new pg.Pool({
        connectionString: databaseUrl,
    });

    // Register pgvector type on every new client so vector columns work correctly
    pool.on('connect', async (client) => {
        await pgvector.registerType(client);
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

    const dimensions = getServerConfig().embedding.dimensions;

    // Run migration + schema creation atomically
    const migrationClient = await p.connect();
    try {
        await migrationClient.query('BEGIN');
        await migrationClient.query(generateMigration());
        await migrationClient.query(generateSchema(dimensions));
        await migrationClient.query('COMMIT');
    } catch (err) {
        await migrationClient.query('ROLLBACK');
        throw err;
    } finally {
        migrationClient.release();
    }
}
