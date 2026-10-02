/**
 * unique_client_count_window and the protocol-mix counts on the analytics
 * summary. Real SQL against PGlite (no mocked pool).
 *
 * Client identity: the OAuth client id when present and non-empty, otherwise
 * the `client_ip|user_agent` pair (a missing user_agent counts as ''). Rows
 * with no auth id and no client_ip are not counted. The `c:` / `ip:` key
 * prefixes keep an auth id from colliding with an ip|ua key.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { __setPoolForTesting, __resetPoolForTesting } from "../db/client.js";
import { getAnalyticsSummary } from "../db/analytics.js";
import { generatePostSchemaMigration } from "../db/schema.js";

const QUERY_LOG_DDL_MARKER =
  "-- Analytics: query_log table for tracking tool usage";

function extractAnalyticsDdl(): string {
  const full = generatePostSchemaMigration();
  const idx = full.indexOf(QUERY_LOG_DDL_MARKER);
  if (idx < 0) {
    throw new Error(`Could not locate "${QUERY_LOG_DDL_MARKER}" in schema`);
  }
  return full.slice(idx);
}

function poolFromPglite(db: PGlite) {
  return {
    query: (text: string, params?: unknown[]) => db.query(text, params),
    connect: async () => ({
      query: (text: string, params?: unknown[]) => db.query(text, params),
      release: () => {},
    }),
    end: async () => db.close(),
  };
}

interface Row {
  clientIp: string | null;
  userAgent: string | null;
  authClientId: string | null;
  transport: string | null;
  protocolEra: string | null;
  requestSource?: string | null;
  sessionId?: string | null;
  /** Age of the row in days; omitted means NOW(). */
  ageDays?: number;
}

async function insertRow(db: PGlite, row: Row): Promise<void> {
  await db.query(
    `INSERT INTO query_log
      (tool_name, query_text, result_count, latency_ms, session_id,
       request_source, client_ip, user_agent, auth_client_id, transport,
       protocol_era, created_at)
     VALUES ('search-docs','q',1,25,$1,$2,$3,$4,$5,$6,$7,
             NOW() - make_interval(days => $8::int))`,
    [
      row.sessionId ?? null,
      row.requestSource === undefined ? "user" : row.requestSource,
      row.clientIp,
      row.userAgent,
      row.authClientId,
      row.transport,
      row.protocolEra,
      row.ageDays ?? 0,
    ],
  );
}

describe("summary unique_client_count_window and protocol mix", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.waitReady;
    await db.exec(extractAnalyticsDdl());
    __setPoolForTesting(poolFromPglite(db));
  });

  afterAll(async () => {
    __resetPoolForTesting();
    await db.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM query_log");
  });

  it("counts auth ids and ip|ua pairs; an empty auth id falls back to ip|ua; a NULL-IP row with no auth id is not counted", async () => {
    // Same auth id twice, different IPs: one client.
    await insertRow(db, {
      clientIp: "1.1.1.1",
      userAgent: "a",
      authClientId: "client-A",
      transport: "streamable_http",
      protocolEra: "legacy",
    });
    await insertRow(db, {
      clientIp: "2.2.2.2",
      userAgent: "b",
      authClientId: "client-A",
      transport: "streamable_http",
      protocolEra: "legacy",
    });
    // Empty-string auth id falls back to ip|ua.
    await insertRow(db, {
      clientIp: "3.3.3.3",
      userAgent: "c",
      authClientId: "",
      transport: "sse",
      protocolEra: "legacy",
    });
    // ip|ua only, repeated: one client; same IP other UA: another client.
    for (const ua of ["d", "d", "e"]) {
      await insertRow(db, {
        clientIp: "4.4.4.4",
        userAgent: ua,
        authClientId: null,
        transport: "sse",
        protocolEra: "modern",
      });
    }
    // NULL IP and no auth id: not counted as a client.
    await insertRow(db, {
      clientIp: null,
      userAgent: "z",
      authClientId: null,
      transport: null,
      protocolEra: null,
    });
    // NULL IP but with an auth id: counted by auth id.
    await insertRow(db, {
      clientIp: null,
      userAgent: null,
      authClientId: "client-B",
      transport: "streamable_http",
      protocolEra: "modern",
    });
    // Auth id equal to an ip|ua-looking string must not collide.
    await insertRow(db, {
      clientIp: "5.5.5.5",
      userAgent: "f",
      authClientId: "5.5.5.5|f",
      transport: "streamable_http",
      protocolEra: "legacy",
    });
    await insertRow(db, {
      clientIp: "5.5.5.5",
      userAgent: "f",
      authClientId: null,
      transport: "streamable_http",
      protocolEra: "legacy",
    });

    const s = await getAnalyticsSummary({}, 7);
    // c:client-A, ip:3.3.3.3|c, ip:4.4.4.4|d, ip:4.4.4.4|e, c:client-B,
    // c:5.5.5.5|f, ip:5.5.5.5|f
    expect(s.unique_client_count_window).toBe(7);
    expect(s.total_queries_window).toBe(10);
    expect(s.legacy_query_count_window).toBe(5);
    expect(s.modern_query_count_window).toBe(4);
    expect(s.streamable_http_query_count_window).toBe(5);
    expect(s.sse_query_count_window).toBe(4);
  });

  it("treats the clientIp() fallback 'unknown' and an empty client_ip as no IP", async () => {
    // clientIp() returns the literal "unknown" when no address resolves. Two
    // unrelated anonymous callers with that sentinel and the same UA must not
    // collapse into one 'ip:unknown|<ua>' client; with no auth id they have
    // no identity at all, the same as a NULL client_ip.
    for (const clientIp of ["unknown", "unknown", "", ""]) {
      await insertRow(db, {
        clientIp,
        userAgent: "shared-ua",
        authClientId: null,
        transport: "sse",
        protocolEra: "legacy",
      });
    }
    // A sentinel IP with an auth id is still counted, by the auth id.
    await insertRow(db, {
      clientIp: "unknown",
      userAgent: "shared-ua",
      authClientId: "client-U",
      transport: "sse",
      protocolEra: "legacy",
    });
    await insertRow(db, {
      clientIp: "",
      userAgent: "shared-ua",
      authClientId: "client-E",
      transport: "sse",
      protocolEra: "legacy",
    });
    // A real IP with the same UA is one client.
    await insertRow(db, {
      clientIp: "9.9.9.9",
      userAgent: "shared-ua",
      authClientId: null,
      transport: "sse",
      protocolEra: "legacy",
    });

    const s = await getAnalyticsSummary({}, 7);
    // c:client-U, c:client-E, ip:9.9.9.9|shared-ua
    expect(s.unique_client_count_window).toBe(3);
    expect(s.total_queries_window).toBe(7);
  });

  it("does not count an 'unknown'-IP or ''-IP row with no auth id as a client", async () => {
    await insertRow(db, {
      clientIp: "unknown",
      userAgent: "a",
      authClientId: null,
      transport: "sse",
      protocolEra: "legacy",
    });
    await insertRow(db, {
      clientIp: "",
      userAgent: "b",
      authClientId: "",
      transport: "sse",
      protocolEra: "legacy",
    });

    const s = await getAnalyticsSummary({}, 7);
    expect(s.unique_client_count_window).toBe(0);
  });

  it("keys an empty-string auth id by ip|ua, so it merges with the same ip|ua and splits by ip|ua", async () => {
    const row = (
      clientIp: string | null,
      userAgent: string,
      authClientId: string | null,
    ): Row => ({
      clientIp,
      userAgent,
      authClientId,
      transport: "sse",
      protocolEra: "legacy",
    });
    // '' and NULL auth id with the same ip|ua: one client.
    await insertRow(db, row("3.3.3.3", "c", ""));
    await insertRow(db, row("3.3.3.3", "c", null));
    // Two more '' auth ids, each with its own ip|ua: two more clients. Without
    // NULLIF, every '' auth id collapses onto one shared 'c:' key.
    await insertRow(db, row("6.6.6.6", "g", ""));
    await insertRow(db, row("7.7.7.7", "h", ""));
    // '' auth id and NULL IP: no identity, not counted.
    await insertRow(db, row(null, "z", ""));

    const s = await getAnalyticsSummary({}, 7);
    // ip:3.3.3.3|c, ip:6.6.6.6|g, ip:7.7.7.7|h
    expect(s.unique_client_count_window).toBe(3);
    expect(s.total_queries_window).toBe(5);
  });

  it("treats a NULL user_agent and an empty user_agent on the same IP as one client", async () => {
    for (const userAgent of [null, ""]) {
      await insertRow(db, {
        clientIp: "8.8.8.8",
        userAgent,
        authClientId: null,
        transport: "streamable_http",
        protocolEra: "modern",
      });
    }
    // A non-empty UA on the same IP is still a different client.
    await insertRow(db, {
      clientIp: "8.8.8.8",
      userAgent: "ua",
      authClientId: null,
      transport: "streamable_http",
      protocolEra: "modern",
    });
    const s = await getAnalyticsSummary({}, 7);
    expect(s.unique_client_count_window).toBe(2);
    expect(s.total_queries_window).toBe(3);
  });

  it("excludes rows older than the window from unique clients and the protocol mix", async () => {
    // In the window: one client, one legacy streamable_http row.
    await insertRow(db, {
      clientIp: "1.1.1.1",
      userAgent: "a",
      authClientId: null,
      transport: "streamable_http",
      protocolEra: "legacy",
      ageDays: 1,
    });
    // Outside a 7-day window: new clients and every era/transport bucket.
    await insertRow(db, {
      clientIp: "9.9.9.9",
      userAgent: "old",
      authClientId: null,
      transport: "sse",
      protocolEra: "modern",
      ageDays: 30,
    });
    await insertRow(db, {
      clientIp: null,
      userAgent: null,
      authClientId: "old-client",
      transport: "streamable_http",
      protocolEra: "legacy",
      ageDays: 30,
    });
    await insertRow(db, {
      clientIp: "9.9.9.8",
      userAgent: "old",
      authClientId: null,
      transport: null,
      protocolEra: null,
      ageDays: 30,
    });

    const s = await getAnalyticsSummary({}, 7);
    expect(s.total_queries_window).toBe(1);
    expect(s.unique_client_count_window).toBe(1);
    expect(s.legacy_query_count_window).toBe(1);
    expect(s.modern_query_count_window).toBe(0);
    expect(s.streamable_http_query_count_window).toBe(1);
    expect(s.sse_query_count_window).toBe(0);
    expect(s.unclassified_era_query_count_window).toBe(0);
    expect(s.unclassified_transport_query_count_window).toBe(0);

    // Positive control: a 60-day window does see the old rows.
    const wide = await getAnalyticsSummary({}, 60);
    expect(wide.total_queries_window).toBe(4);
    expect(wide.unique_client_count_window).toBe(4);
    expect(wide.modern_query_count_window).toBe(1);
    expect(wide.sse_query_count_window).toBe(1);
  });

  it("counts NULL and out-of-vocabulary era/transport rows as unclassified", async () => {
    // 2 classified on both axes, 2 NULL on both, 1 era-only, 1 transport-only,
    // 1 with values outside the vocabulary.
    const rows: Array<[string | null, string | null]> = [
      ["streamable_http", "legacy"],
      ["sse", "modern"],
      [null, null],
      [null, null],
      [null, "legacy"],
      ["sse", null],
      ["websocket", "future"],
    ];
    for (const [transport, protocolEra] of rows) {
      await insertRow(db, {
        clientIp: "1.1.1.1",
        userAgent: "a",
        authClientId: null,
        transport,
        protocolEra,
      });
    }
    const s = await getAnalyticsSummary({}, 7);
    expect(s.total_queries_window).toBe(7);
    expect(s.unclassified_era_query_count_window).toBe(4);
    expect(s.unclassified_transport_query_count_window).toBe(4);
    // The three era buckets (and the three transport buckets) partition the
    // windowed population.
    expect(
      s.legacy_query_count_window +
        s.modern_query_count_window +
        s.unclassified_era_query_count_window,
    ).toBe(s.total_queries_window);
    expect(
      s.streamable_http_query_count_window +
        s.sse_query_count_window +
        s.unclassified_transport_query_count_window,
    ).toBe(s.total_queries_window);
  });

  it("applies the request_source filter", async () => {
    await insertRow(db, {
      clientIp: "1.1.1.1",
      userAgent: "a",
      authClientId: null,
      transport: "sse",
      protocolEra: "legacy",
    });
    await insertRow(db, {
      clientIp: "2.2.2.2",
      userAgent: "b",
      authClientId: null,
      transport: "streamable_http",
      protocolEra: "modern",
      requestSource: "synthetic",
    });

    const user = await getAnalyticsSummary({}, 7);
    expect(user.unique_client_count_window).toBe(1);
    expect(user.legacy_query_count_window).toBe(1);
    expect(user.modern_query_count_window).toBe(0);
    expect(user.sse_query_count_window).toBe(1);
    expect(user.streamable_http_query_count_window).toBe(0);

    const all = await getAnalyticsSummary({ request_source: "all" }, 7);
    expect(all.unique_client_count_window).toBe(2);
    expect(all.modern_query_count_window).toBe(1);
    expect(all.streamable_http_query_count_window).toBe(1);

    const synthetic = await getAnalyticsSummary(
      { request_source: "synthetic" },
      7,
    );
    expect(synthetic.unique_client_count_window).toBe(1);
    expect(synthetic.legacy_query_count_window).toBe(0);
  });

  it("applies the service-traffic filter", async () => {
    await insertRow(db, {
      clientIp: "1.1.1.1",
      userAgent: "a",
      authClientId: null,
      transport: "sse",
      protocolEra: "legacy",
    });
    await insertRow(db, {
      clientIp: "2.2.2.2",
      userAgent: "b",
      authClientId: null,
      transport: "sse",
      protocolEra: "legacy",
      sessionId: "service:atlas-probe",
    });
    const def = await getAnalyticsSummary({}, 7);
    expect(def.unique_client_count_window).toBe(1);
    expect(def.sse_query_count_window).toBe(1);
    const withSvc = await getAnalyticsSummary(
      { include_service_traffic: true },
      7,
    );
    expect(withSvc.unique_client_count_window).toBe(2);
    expect(withSvc.sse_query_count_window).toBe(2);
  });
});
