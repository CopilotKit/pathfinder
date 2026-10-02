/**
 * Boundary contract for client-supplied strings, through the REAL path:
 * a raw initialize JSON body -> isInitializeRequest -> handshakeOf (the value
 * the `[mcp] initialize client=` log line prints) -> analyticsContextFields ->
 * logQuery -> query_log in PGlite (no mocked pool).
 *
 * For every hostile input it asserts that (a) the row is written, blocked
 * rows included, (b) the stored value is the cleaned value, and (c) the
 * handshake value (what the log line prints) equals the stored value.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Request } from "express";
import { __setPoolForTesting, __resetPoolForTesting } from "../db/client.js";
import { logQuery } from "../db/analytics.js";
import { generatePostSchemaMigration } from "../db/schema.js";
import {
  analyticsContextFields,
  handshakeOf,
  requestContext,
  type SessionAnalyticsContext,
} from "../request-context.js";
import type { AuthContext } from "../oauth/handlers.js";

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

/**
 * Build the initialize body as raw JSON text, the way it arrives on the wire.
 * JSON.stringify writes a lone surrogate as a `\udXXX` escape, so JSON.parse
 * hands the server the same lone surrogate a hostile client could send.
 */
function initializeBody(protocolVersion: string, clientName: string): unknown {
  const wire = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      capabilities: {},
      protocolVersion,
      clientInfo: { name: clientName, version: "1" },
    },
  });
  return JSON.parse(wire);
}

function mkReq(clientId: string): Request & { auth?: AuthContext } {
  const req: unknown = {
    headers: { "user-agent": "contract-ua" },
    ip: "203.0.113.9",
    socket: { remoteAddress: "203.0.113.9" },
    auth: { sub: "anonymous", client_id: clientId },
  };
  return req as Request & { auth?: AuthContext };
}

interface StoredRow {
  protocol_version: string | null;
  client_name: string | null;
  auth_client_id: string | null;
  blocked: boolean;
}

const EMOJI = "\u{1F600}";

/** [label, raw client value, expected stored value]. */
const HANDSHAKE_CASES: ReadonlyArray<[string, string, string | null]> = [
  ["NUL inside", "a\u0000b", "ab"],
  ["NUL only", "\u0000", null],
  ["surrounding spaces", "  x  ", "x"],
  ["whitespace only", "   ", null],
  ["C1 NEL", "\u0085x", "x"],
  [
    "C0, DEL and C1 controls",
    "\u0001a\u001fb\u007fc\u009fd\u001b[31m",
    "abcd[31m",
  ],
  ["control then space then text", "\u0000 x", "x"],
  [
    "emoji across the 64-unit boundary",
    "a".repeat(63) + EMOJI + "b",
    "a".repeat(63) + EMOJI,
  ],
  ["emoji just past the 64 cap", "a".repeat(64) + EMOJI, "a".repeat(64)],
  ["lone high surrogate", "\ud83d", null],
  ["lone surrogate inside", "x\ud83dy", "xy"],
  ["lone low surrogate", "x\ude00y", "xy"],
  ["200 characters", "c".repeat(200), "c".repeat(64)],
];

/** [label, raw OAuth client id, expected stored value]. */
const AUTH_ID_CASES: ReadonlyArray<[string, string, string | null]> = [
  ["whitespace only", "   ", null],
  ["NUL inside", "id\u0000x", "idx"],
  ["exactly 256 code points", "k".repeat(256), "k".repeat(256)],
  ["256 code points of emoji", EMOJI.repeat(256), EMOJI.repeat(256)],
  ["300 characters (stored as NULL, never a prefix)", "k".repeat(300), null],
  ["257 code points (stored as NULL, never a prefix)", "k".repeat(257), null],
];

describe("client-string boundary contract: initialize -> handshakeOf -> logQuery -> PGlite", () => {
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

  /** Drive one session through the real path and log one tool call. */
  async function logSession(opts: {
    protocolVersion: string;
    clientName: string;
    clientId: string;
    blocked: boolean;
  }): Promise<{
    hs: ReturnType<typeof handshakeOf>;
    ctx: SessionAnalyticsContext;
    rows: StoredRow[];
    errors: unknown[][];
  }> {
    const body = initializeBody(opts.protocolVersion, opts.clientName);
    // Same classification server.ts / sse-handlers.ts do before handshakeOf.
    expect(isInitializeRequest(body)).toBe(true);
    const hs = handshakeOf(isInitializeRequest(body) ? body : undefined);
    const reqCtx = requestContext(mkReq(opts.clientId));
    const ctx: SessionAnalyticsContext = {
      transport: "streamable_http",
      protocol_era: "modern",
      protocol_version: hs.protocolVersion,
      client_name: hs.clientName,
      auth_client_id: reqCtx.authClientId,
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let errors: unknown[][] = [];
    try {
      await logQuery({
        tool_name: "search-docs",
        query_text: "q",
        result_count: 1,
        top_score: null,
        latency_ms: 5,
        source_name: "docs",
        session_id: "sess-contract",
        client_ip: reqCtx.ip,
        user_agent: reqCtx.userAgent,
        blocked: opts.blocked,
        block_reason: opts.blocked ? "contract" : null,
        ...analyticsContextFields(() => ctx),
      });
    } finally {
      errors = [...errSpy.mock.calls];
      errSpy.mockRestore();
    }
    const res = await db.query<StoredRow>(
      "SELECT protocol_version, client_name, auth_client_id, blocked FROM query_log",
    );
    return { hs, ctx, rows: res.rows, errors };
  }

  for (const blocked of [false, true]) {
    describe(blocked ? "blocked row" : "normal row", () => {
      it.each(HANDSHAKE_CASES)(
        "handshake string: %s",
        async (_label, raw, expected) => {
          const { hs, rows, errors } = await logSession({
            protocolVersion: raw,
            clientName: raw,
            clientId: "client-ok",
            blocked,
          });
          expect(errors).toEqual([]);
          // (a) the row is written, and the blocked flag survives.
          expect(rows).toHaveLength(1);
          expect(rows[0].blocked).toBe(blocked);
          // (b) the stored values are the cleaned values.
          expect(rows[0].protocol_version).toBe(expected);
          expect(rows[0].client_name).toBe(expected);
          expect(rows[0].auth_client_id).toBe("client-ok");
          // (c) the handshake (what the log line prints) equals the DB.
          expect(hs.protocolVersion).toBe(rows[0].protocol_version);
          expect(hs.clientName).toBe(rows[0].client_name);
        },
      );

      it.each(AUTH_ID_CASES)(
        "auth_client_id: %s",
        async (_label, raw, expected) => {
          const { rows, errors } = await logSession({
            protocolVersion: "2025-06-18",
            clientName: "claude-code",
            clientId: raw,
            blocked,
          });
          expect(errors).toEqual([]);
          expect(rows).toHaveLength(1);
          expect(rows[0].blocked).toBe(blocked);
          expect(rows[0].auth_client_id).toBe(expected);
          expect(rows[0].client_name).toBe("claude-code");
        },
      );
    });
  }

  it("two distinct over-cap auth ids that share a 256-point prefix never merge into one stored key", async () => {
    const prefix = "p".repeat(256);
    for (const tail of ["-one", "-two"]) {
      await logSession({
        protocolVersion: "2025-06-18",
        clientName: "claude-code",
        clientId: prefix + tail,
        blocked: false,
      });
    }
    const res = await db.query<{ auth_client_id: string | null }>(
      "SELECT auth_client_id FROM query_log",
    );
    // logSession clears nothing between calls; each call SELECTs all rows.
    expect(res.rows.map((r) => r.auth_client_id)).toEqual([null, null]);
  });
});
