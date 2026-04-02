import pg from "pg";
import pgvector from "pgvector/pg";
import { generateSchema, generateMigration } from "./schema.js";
import { getConfig, getServerConfig } from "../config.js";

let pool: pg.Pool | null = null;

/**
 * Returns a singleton pg Pool.
 * For standard Postgres URLs, creates a pg.Pool on first call.
 * For PGlite URLs (pglite://...), initializeSchema() must be called first
 * or this will throw — PGlite requires async setup that getPool() cannot do.
 */
export function getPool(): pg.Pool {
    if (pool) return pool;

    const databaseUrl = getConfig().databaseUrl;

    if (isPGliteUrl(databaseUrl)) {
        throw new Error(
            "PGlite pool not initialized. Call initializeSchema() first.",
        );
    }

    pool = new pg.Pool({
        connectionString: databaseUrl,
    });

    return pool;
}

function isPGliteUrl(url: string): boolean {
    return url.startsWith("pglite://");
}

function parsePGliteDataDir(url: string): string {
    return url.replace(/^pglite:\/\//, "");
}

async function initializePGlite(): Promise<void> {
    const databaseUrl = getConfig().databaseUrl;
    const dataDir = parsePGliteDataDir(databaseUrl);
    const dimensions = getServerConfig().embedding.dimensions;

    const { PGlite } = await import("@electric-sql/pglite");
    const { vector } = await import("@electric-sql/pglite/vector");

    const db = new PGlite({ dataDir, extensions: { vector } });
    await db.waitReady;

    // Run DDL in a transaction to avoid partial state on failure
    await db.exec('BEGIN');
    try {
        await db.exec(generateMigration());
        await db.exec(generateSchema(dimensions));
        await db.exec('COMMIT');
    } catch (err) {
        try {
            await db.exec('ROLLBACK');
        } catch {
            // ROLLBACK failed — original error is more useful
        }
        throw err;
    }

    // Build a wrapper that duck-types as pg.Pool.
    // Supported pg.Pool surface: query(text, params?), connect() → {query, release}, end().
    // Other pg.Pool methods (e.g. on(), totalCount, idleCount) are NOT implemented —
    // the cast below is intentional since queries.ts only uses the supported subset.
    const wrapper = {
        query: (text: string, params?: unknown[]) => db.query(text, params),
        connect: async () => ({
            query: (text: string, params?: unknown[]) => db.query(text, params),
            release: () => {},
        }),
        end: async () => db.close(),
    };

    pool = wrapper as unknown as pg.Pool;
}

/**
 * Runs migration (drop old tables) then creates the unified schema.
 * Idempotent — all DDL uses IF NOT EXISTS / IF EXISTS.
 * Also registers the pgvector type so vector columns are handled correctly.
 *
 * When DATABASE_URL starts with "pglite://", uses an in-process PGlite
 * instance instead of connecting to an external PostgreSQL server.
 */
export async function initializeSchema(): Promise<void> {
    const databaseUrl = getConfig().databaseUrl;

    if (isPGliteUrl(databaseUrl)) {
        await initializePGlite();
        return;
    }

    const p = getPool();

    const dimensions = getServerConfig().embedding.dimensions;

    // Register pgvector types on a dedicated client first
    const setupClient = await p.connect();
    try {
        await pgvector.registerType(setupClient);
    } finally {
        setupClient.release();
    }

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

/**
 * Close the pool if it was initialized. Safe to call at any time.
 */
export async function closePool(): Promise<void> {
    if (pool) {
        const p = pool;
        pool = null;
        await p.end();
    }
}
