// Seed the query_log table with realistic fixture data for analytics dashboard testing.
//
// Usage:
//   npx tsx scripts/seed-analytics.ts
//
// Requires PATHFINDER_CONFIG and DATABASE_URL to be set. For a quick local test:
//   DATABASE_URL=pglite:///tmp/analytics-test \
//   PATHFINDER_CONFIG=fixtures/analytics-test/pathfinder.yaml \
//   npx tsx scripts/seed-analytics.ts

import { getAnalyticsSummary, ALL_TIME_DAYS } from "../src/db/analytics.js";
import { initializeSchema, getPool, closePool } from "../src/db/client.js";

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const TOOL_NAMES = ["search-docs", "search-code", "get-knowledge"];
const SOURCE_NAMES = ["docs", "code", "community"];
const PROTOCOL_VERSIONS = ["2025-03-26", "2025-06-18", "2025-11-25"];
const CLIENT_NAMES = ["claude-code", "cursor", "mcp-inspector"];
const AUTH_CLIENT_IDS = ["client_a1b2c3", "client_d4e5f6", "client_g7h8i9"];
const USER_AGENTS = [
  "claude-code/1.0.30",
  "Cursor/0.50.5",
  "mcp-inspector/0.14.0",
  "node",
];
const SESSION_POOL_SIZE = 14;

const QUERIES = [
  "how to authenticate",
  "deployment guide",
  "error handling best practices",
  "rate limiting configuration",
  "webhook setup",
  "getting started tutorial",
  "API reference overview",
  "database migrations",
  "environment variables",
  "testing strategies",
  "CI/CD pipeline setup",
  "logging and monitoring",
  "caching strategies",
  "user permissions and roles",
  "file upload handling",
  "pagination implementation",
  "search indexing",
  "background jobs",
  "email notifications",
  "REST vs GraphQL",
  "docker container setup",
  "kubernetes deployment",
  "SSL certificate configuration",
  "CORS configuration",
  "session management",
  "input validation",
  "response formatting",
  "middleware patterns",
  "dependency injection",
  "configuration management",
  "health check endpoint",
  "graceful shutdown",
  "connection pooling",
  "streaming responses",
  "batch processing",
  "retry logic",
  "circuit breaker pattern",
  "feature flags",
  "A/B testing setup",
  "analytics integration",
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

  // Bias toward business hours: each of up to 3 attempts has a 70% chance of
  // resampling the hour into 9-18 UTC. A successful resample lands in-range,
  // so the loop exits next iteration. Effective P(business-hour) ≈ 1 - 0.3³ ≈ 97%.
  for (let i = 0; i < 3; i++) {
    const hour = base.getUTCHours();
    if (hour >= 9 && hour <= 18) break;
    if (Math.random() < 0.7) {
      base.setUTCHours(randomInt(9, 18));
    }
  }
  return base;
}

// A seeded session: one set of context values shared by its rows. Anonymous
// sessions carry no auth_client_id, so the unique-client metric falls back to
// their client_ip|user_agent pair.
interface SeedSession {
  session_id: string;
  transport: string;
  protocol_era: string;
  protocol_version: string;
  client_name: string;
  auth_client_id: string | null;
  client_ip: string;
  user_agent: string;
}

function buildSessionPool(): SeedSession[] {
  const pool: SeedSession[] = [];
  for (let i = 0; i < SESSION_POOL_SIZE; i++) {
    pool.push({
      session_id: `sess_${1000 + i}`,
      transport: Math.random() < 0.85 ? "streamable_http" : "sse",
      // Legacy era, as every current writer stamps (see
      // SessionAnalyticsContext.protocol_era in src/request-context.ts).
      protocol_era: "legacy",
      protocol_version: pick(PROTOCOL_VERSIONS),
      client_name: pick(CLIENT_NAMES),
      // ~30% authenticated; never the empty string.
      auth_client_id: Math.random() < 0.3 ? pick(AUTH_CLIENT_IDS) : null,
      // Documentation range 203.0.113.0/24; distinct per session.
      client_ip: `203.0.113.${10 + i}`,
      user_agent: pick(USER_AGENTS),
    });
  }
  return pool;
}

interface SeedRow {
  tool_name: string;
  query_text: string;
  result_count: number;
  top_score: number | null;
  latency_ms: number;
  source_name: string;
  session_id: string | null;
  request_source: string | null;
  transport: string;
  protocol_era: string;
  protocol_version: string;
  client_name: string;
  auth_client_id: string | null;
  client_ip: string;
  user_agent: string;
  created_at: Date;
}

// Request-origin mix: mostly real users, a slice of synthetic/analysis traffic
// plus some untagged (null) rows to mimic historical data predating the column.
function pickRequestSource(): string | null {
  const r = Math.random();
  if (r < 0.7) return "user";
  if (r < 0.82) return "synthetic";
  if (r < 0.9) return "analysis";
  return null; // untagged historical row
}

function generateRow(pool: SeedSession[]): SeedRow {
  const session = pick(pool);
  const isEmptyResult = Math.random() < 0.15; // ~15% empty
  const resultCount = isEmptyResult ? 0 : randomInt(1, 20);
  const topScore = isEmptyResult
    ? null
    : parseFloat((Math.random() * 0.65 + 0.3).toFixed(3)); // 0.3-0.95

  return {
    tool_name: pick(TOOL_NAMES),
    query_text: pick(QUERIES),
    result_count: resultCount,
    top_score: topScore,
    latency_ms: randomInt(50, 500),
    source_name: pick(SOURCE_NAMES),
    // ~40% of rows carry no session id but still come from a known client.
    session_id: Math.random() < 0.6 ? session.session_id : null,
    request_source: pickRequestSource(),
    transport: session.transport,
    protocol_era: session.protocol_era,
    protocol_version: session.protocol_version,
    client_name: session.client_name,
    auth_client_id: session.auth_client_id,
    client_ip: session.client_ip,
    user_agent: session.user_agent,
    created_at: randomTimestamp(),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("[seed] Initializing database schema...");
  await initializeSchema();

  const pool = getPool();
  const count = 200;
  const rows: SeedRow[] = [];
  const sessionPool = buildSessionPool();

  for (let i = 0; i < count; i++) {
    rows.push(generateRow(sessionPool));
  }

  console.log(`[seed] Inserting ${count} query_log entries...`);

  for (const row of rows) {
    await pool.query(
      `INSERT INTO query_log (tool_name, query_text, result_count, top_score, latency_ms, source_name, session_id, request_source, transport, protocol_era, protocol_version, client_name, auth_client_id, client_ip, user_agent, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        row.tool_name,
        row.query_text,
        row.result_count,
        row.top_score,
        row.latency_ms,
        row.source_name,
        row.session_id,
        row.request_source,
        row.transport,
        row.protocol_era,
        row.protocol_version,
        row.client_name,
        row.auth_client_id,
        row.client_ip,
        row.user_agent,
        row.created_at,
      ],
    );
  }

  // Print summary
  const totalRes = await pool.query(
    "SELECT count(*)::int AS count FROM query_log",
  );
  const emptyRes = await pool.query(
    "SELECT count(*)::int AS count FROM query_log WHERE result_count = 0",
  );
  const toolRes = await pool.query(
    "SELECT tool_name, count(*)::int AS count FROM query_log GROUP BY tool_name ORDER BY count DESC",
  );
  const sourceRes = await pool.query(
    "SELECT source_name, count(*)::int AS count FROM query_log WHERE source_name IS NOT NULL GROUP BY source_name ORDER BY count DESC",
  );
  // Unique-client count comes from the real summary reader so the seed can
  // never drift from the dashboard's definition of a client.
  const summary = await getAnalyticsSummary({}, ALL_TIME_DAYS);
  const authedRes = await pool.query(
    "SELECT count(*) FILTER (WHERE auth_client_id IS NOT NULL)::int AS authed_rows FROM query_log",
  );
  const ctxByCol = async (col: string) =>
    (
      await pool.query(
        `SELECT ${col} AS value, count(*)::int AS count FROM query_log GROUP BY ${col} ORDER BY count DESC`,
      )
    ).rows;

  console.log("\n--- Seed Summary ---");
  console.log(`Total entries:  ${totalRes.rows[0].count}`);
  console.log(`Empty results:  ${emptyRes.rows[0].count}`);
  console.log("\nBy tool:");
  for (const r of toolRes.rows) {
    console.log(`  ${r.tool_name}: ${r.count}`);
  }
  console.log("\nBy source:");
  for (const r of sourceRes.rows) {
    console.log(`  ${r.source_name}: ${r.count}`);
  }
  console.log(
    `\nClients: ${summary.unique_client_count_window} unique (${summary.unique_session_count_window} sessions, ${summary.unique_ip_count_window} IPs, ${authedRes.rows[0].authed_rows} authenticated rows)`,
  );
  for (const col of [
    "transport",
    "protocol_era",
    "protocol_version",
    "client_name",
    "auth_client_id",
    "user_agent",
  ]) {
    console.log(`\nBy ${col}:`);
    for (const r of await ctxByCol(col)) {
      console.log(`  ${r.value ?? "(none)"}: ${r.count}`);
    }
  }

  console.log(`
To view the dashboard:
  1. Start the server:
     DATABASE_URL=pglite:///tmp/analytics-test \\
     PATHFINDER_CONFIG=fixtures/analytics-test/pathfinder.yaml \\
     npx tsx src/index.ts

  2. The server logs only a short fingerprint of the auto-generated token
     (for safety). To obtain a usable token, set ANALYTICS_TOKEN explicitly
     when starting the server, then:
     http://localhost:3001/analytics
     and paste the token into the "Analytics Token" prompt.
`);

  await closePool();
}

main().catch(async (err) => {
  console.error("[seed] Fatal error:", err);
  try {
    await closePool();
  } catch (closeErr) {
    console.error("[seed] closePool failed:", closeErr);
  }
  process.exit(1);
});
