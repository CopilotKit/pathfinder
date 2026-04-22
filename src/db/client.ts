import pg from "pg";
import pgvector from "pgvector/pg";
import {
  generateSchema,
  generateMigration,
  generatePostSchemaMigration,
  generateTsvTriggerDdl,
  generateDimensionCheckQuery,
} from "./schema.js";
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

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set. Cannot create database pool.");
  }

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

function isPGliteUrl(url: string | undefined): boolean {
  return !!url && url.startsWith("pglite://");
}

function parsePGliteDataDir(url: string): string {
  return url.replace(/^pglite:\/\//, "");
}

async function initializePGlite(): Promise<void> {
  const databaseUrl = getConfig().databaseUrl;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set. Cannot initialize PGlite.");
  }
  const dataDir = parsePGliteDataDir(databaseUrl);
  const dimensions = getServerConfig().embedding?.dimensions;
  if (!dimensions)
    throw new Error(
      "embedding.dimensions is required for database schema initialization",
    );

  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");

  const db = new PGlite({ dataDir, extensions: { vector } });
  await db.waitReady;

  // Run DDL in a transaction to avoid partial state on failure
  await db.exec("BEGIN");
  try {
    await db.exec(generateMigration());
    await db.exec(generateSchema(dimensions));
    await db.exec(generatePostSchemaMigration());
    await db.exec("COMMIT");
  } catch (err) {
    try {
      await db.exec("ROLLBACK");
    } catch {
      // ROLLBACK failed — original error is more useful
    }
    throw err;
  }

  // Attempt tsvector trigger creation — PGlite does not support PL/pgSQL triggers
  try {
    await db.exec(generateTsvTriggerDdl());
  } catch (error: unknown) {
    console.warn(
      `[db] tsvector trigger creation skipped (PGlite or unsupported): ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        `tsv column will be populated in application code during upsert.`,
    );
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
 * Check if the configured embedding dimensions match what's stored in the database.
 * Skips gracefully on empty tables, missing tables, or PGlite limitations.
 * Throws on a confirmed mismatch with instructions to reindex.
 */
async function checkDimensionMismatch(
  p: pg.Pool,
  configuredDimensions: number,
): Promise<void> {
  try {
    const result = await p.query(generateDimensionCheckQuery());
    if (result.rows.length === 0 || result.rows[0].dimensions == null) return;

    const dbDimensions = result.rows[0].dimensions;
    if (dbDimensions !== configuredDimensions) {
      console.error(
        `[db] DIMENSION MISMATCH: Database has vector(${dbDimensions}) but config specifies dimensions=${configuredDimensions}. ` +
          `Switching embedding providers requires a full reindex. Run: pathfinder reindex --force`,
      );
      throw new Error(
        `Embedding dimension mismatch: database=${dbDimensions}, config=${configuredDimensions}. ` +
          `Run "pathfinder reindex --force" to rebuild with the new dimensions.`,
      );
    }
  } catch (error: unknown) {
    // Re-throw our own mismatch error
    if (
      error instanceof Error &&
      error.message.includes("dimension mismatch")
    ) {
      throw error;
    }
    // Expected failures: table doesn't exist yet, PGlite doesn't support vector_dims(), etc.
    console.warn(
      `[db] Dimension check skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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

  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. Cannot initialize database schema.",
    );
  }

  if (isPGliteUrl(databaseUrl)) {
    await initializePGlite();
    // Check dimension mismatch on PGlite — skip gracefully on failure
    const dimensions = getServerConfig().embedding?.dimensions;
    if (dimensions) {
      await checkDimensionMismatch(getPool(), dimensions);
    }
    return;
  }

  const p = getPool();

  const dimensions = getServerConfig().embedding?.dimensions;
  if (!dimensions)
    throw new Error(
      "embedding.dimensions is required for database schema initialization",
    );

  // Check for dimension mismatch before running DDL
  await checkDimensionMismatch(p, dimensions);

  // Ensure the vector extension exists before registering types
  const setupClient = await p.connect();
  try {
    // Requires superuser or pg_extension_owner — works with the default Docker image
    // but will fail on locked-down setups (e.g. RDS) without explicit grants
    await setupClient.query("CREATE EXTENSION IF NOT EXISTS vector");
    await pgvector.registerType(setupClient);
  } finally {
    setupClient.release();
  }

  // Run migration + schema creation atomically
  const migrationClient = await p.connect();
  try {
    await migrationClient.query("BEGIN");
    await migrationClient.query(generateMigration());
    await migrationClient.query(generateSchema(dimensions));
    await migrationClient.query(generatePostSchemaMigration());
    await migrationClient.query("COMMIT");
  } catch (err) {
    await migrationClient.query("ROLLBACK");
    throw err;
  } finally {
    migrationClient.release();
  }

  // Apply tsvector trigger DDL outside the transaction (idempotent)
  const triggerClient = await p.connect();
  try {
    await triggerClient.query(generateTsvTriggerDdl());
  } catch (error: unknown) {
    console.warn(
      `[db] tsvector trigger creation skipped: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        `tsv column will be populated in application code during upsert.`,
    );
  } finally {
    triggerClient.release();
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

// ---------------------------------------------------------------------------
// Test-only hooks (NOT part of the public API)
// ---------------------------------------------------------------------------
//
// These exports let tests swap the module-level pool with a pg.Pool-shaped
// stand-in (for example a PGlite-backed wrapper like the one in
// initializePGlite above) without touching DATABASE_URL or spinning up a
// real Postgres. Production code MUST NOT import these.
//
// The double-underscore prefix signals "test-only" — it is the only contract
// we have short of splitting the module; any production use is a bug.

/**
 * Test-only: replace the module-level singleton with an override so the next
 * and all subsequent getPool() calls return it. Does not close the existing
 * pool — tests own lifecycle management and should tear down their override
 * via __resetPoolForTesting() in afterAll/afterEach.
 *
 * Accepts anything pg.Pool-shaped; in practice tests pass a minimal
 * { query, connect, end } wrapper around PGlite. The cast is intentional so
 * tests don't have to fabricate unused pg.Pool methods (on(), totalCount,
 * etc.) just to satisfy the type.
 */
export function __setPoolForTesting(override: unknown): void {
  pool = override as pg.Pool;
}

/**
 * Test-only: drop the override so the next getPool() call falls back to
 * constructing a real pool from DATABASE_URL (or throws if unset).
 */
export function __resetPoolForTesting(): void {
  pool = null;
}
