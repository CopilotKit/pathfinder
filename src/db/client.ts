import pg from "pg";
import pgvector from "pgvector/pg";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolve the schema.sql path. In dev mode (tsx), it sits alongside client.ts
 * in src/db/. In production (compiled), the Dockerfile places it at dist/db/.
 */
function resolveSchemaPath(): string {
    // First try co-located (works in dev and if build output mirrors src/)
    const colocated = join(__dirname, "schema.sql");
    if (existsSync(colocated)) return colocated;

    // Fallback: Dockerfile copies to dist/db/schema.sql — walk up to find it
    const fallback = join(__dirname, "..", "db", "schema.sql");
    if (existsSync(fallback)) return fallback;

    // Last resort: relative to __dirname going up to dist/
    const distRoot = join(__dirname, "..", "..", "db", "schema.sql");
    if (existsSync(distRoot)) return distRoot;

    throw new Error(
        `schema.sql not found. Searched:\n  ${colocated}\n  ${fallback}\n  ${distRoot}`,
    );
}

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
 * Reads schema.sql and executes it against the pool.
 * Idempotent — all DDL uses IF NOT EXISTS.
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

    const schemaPath = resolveSchemaPath();
    const schemaSql = readFileSync(schemaPath, "utf-8");

    await p.query(schemaSql);
}
