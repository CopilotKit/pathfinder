// Seed the query_log table with realistic fixture data for analytics dashboard testing.
//
// Usage:
//   npx tsx scripts/seed-analytics.ts
//
// Requires PATHFINDER_CONFIG and DATABASE_URL to be set. For a quick local test:
//   DATABASE_URL=pglite:///tmp/analytics-test \
//   PATHFINDER_CONFIG=fixtures/analytics-test/pathfinder.yaml \
//   npx tsx scripts/seed-analytics.ts

import { initializeSchema, getPool, closePool } from '../src/db/client.js';

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const TOOL_NAMES = ['search-docs', 'search-code', 'get-knowledge'];
const SOURCE_NAMES = ['docs', 'code', 'community'];

const QUERIES = [
    'how to authenticate',
    'deployment guide',
    'error handling best practices',
    'rate limiting configuration',
    'webhook setup',
    'getting started tutorial',
    'API reference overview',
    'database migrations',
    'environment variables',
    'testing strategies',
    'CI/CD pipeline setup',
    'logging and monitoring',
    'caching strategies',
    'user permissions and roles',
    'file upload handling',
    'pagination implementation',
    'search indexing',
    'background jobs',
    'email notifications',
    'REST vs GraphQL',
    'docker container setup',
    'kubernetes deployment',
    'SSL certificate configuration',
    'CORS configuration',
    'session management',
    'input validation',
    'response formatting',
    'middleware patterns',
    'dependency injection',
    'configuration management',
    'health check endpoint',
    'graceful shutdown',
    'connection pooling',
    'streaming responses',
    'batch processing',
    'retry logic',
    'circuit breaker pattern',
    'feature flags',
    'A/B testing setup',
    'analytics integration',
];

function pick<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)]!;
}

function randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Generate a timestamp within the past 7 days, weighted toward business hours.
 */
function randomTimestamp(): Date {
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const base = new Date(now - Math.random() * sevenDaysMs);

    // Bias toward business hours (9-18 UTC) — retry up to 3 times
    for (let i = 0; i < 3; i++) {
        const hour = base.getUTCHours();
        if (hour >= 9 && hour <= 18) break;
        if (Math.random() < 0.7) {
            base.setUTCHours(randomInt(9, 18));
        }
    }
    return base;
}

interface SeedRow {
    tool_name: string;
    query_text: string;
    result_count: number;
    top_score: number | null;
    latency_ms: number;
    source_name: string;
    session_id: string | null;
    created_at: Date;
}

function generateRow(): SeedRow {
    const isEmptyResult = Math.random() < 0.15; // ~15% empty
    const resultCount = isEmptyResult ? 0 : randomInt(1, 20);
    const topScore = isEmptyResult ? null : parseFloat((Math.random() * 0.65 + 0.3).toFixed(3)); // 0.3-0.95

    return {
        tool_name: pick(TOOL_NAMES),
        query_text: pick(QUERIES),
        result_count: resultCount,
        top_score: topScore,
        latency_ms: randomInt(50, 500),
        source_name: pick(SOURCE_NAMES),
        session_id: Math.random() < 0.6 ? `sess_${randomInt(1000, 9999)}` : null,
        created_at: randomTimestamp(),
    };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    console.log('[seed] Initializing database schema...');
    await initializeSchema();

    const pool = getPool();
    const count = 200;
    const rows: SeedRow[] = [];

    for (let i = 0; i < count; i++) {
        rows.push(generateRow());
    }

    console.log(`[seed] Inserting ${count} query_log entries...`);

    for (const row of rows) {
        await pool.query(
            `INSERT INTO query_log (tool_name, query_text, result_count, top_score, latency_ms, source_name, session_id, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                row.tool_name,
                row.query_text,
                row.result_count,
                row.top_score,
                row.latency_ms,
                row.source_name,
                row.session_id,
                row.created_at,
            ],
        );
    }

    // Print summary
    const totalRes = await pool.query('SELECT count(*)::int AS count FROM query_log');
    const emptyRes = await pool.query('SELECT count(*)::int AS count FROM query_log WHERE result_count = 0');
    const toolRes = await pool.query(
        'SELECT tool_name, count(*)::int AS count FROM query_log GROUP BY tool_name ORDER BY count DESC',
    );
    const sourceRes = await pool.query(
        'SELECT source_name, count(*)::int AS count FROM query_log WHERE source_name IS NOT NULL GROUP BY source_name ORDER BY count DESC',
    );

    console.log('\n--- Seed Summary ---');
    console.log(`Total entries:  ${totalRes.rows[0].count}`);
    console.log(`Empty results:  ${emptyRes.rows[0].count}`);
    console.log('\nBy tool:');
    for (const r of toolRes.rows) {
        console.log(`  ${r.tool_name}: ${r.count}`);
    }
    console.log('\nBy source:');
    for (const r of sourceRes.rows) {
        console.log(`  ${r.source_name}: ${r.count}`);
    }

    console.log(`
To view the dashboard:
  1. Start the server:
     DATABASE_URL=pglite:///tmp/analytics-test \\
     PATHFINDER_CONFIG=fixtures/analytics-test/pathfinder.yaml \\
     npx tsx src/index.ts

  2. Open the URL printed in the console (includes auto-generated token):
     http://localhost:3001/analytics?token=<token>
`);

    await closePool();
}

main().catch((err) => {
    console.error('[seed] Fatal error:', err);
    process.exit(1);
});
