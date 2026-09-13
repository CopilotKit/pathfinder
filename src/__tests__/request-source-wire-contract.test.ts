/**
 * The `X-Pathfinder-Source` header is a CROSS-SERVICE CONTRACT, and this file
 * is the place where our side of it is pinned to the words our clients
 * actually put on the wire.
 *
 * It exists because the contract broke silently. Two PRs shipped on the same
 * day: outpost started sending `X-Pathfinder-Source: outpost` on the MCP
 * `initialize` request, and pathfinder started recognizing exactly one
 * non-canonical value, `github-triage`. Neither knew about the other's word.
 * `normalizeRequestSource` has no failure mode for an unrecognized value — it
 * returns the default, `user` — so every relayed row landed in the operator
 * dashboard as a real user query and the `request_source = 'relay'` half of
 * the exclusion counted zero forever. Nothing failed; the number was just
 * wrong.
 *
 * So the assertions below are deliberately written as LITERAL wire strings,
 * not as references to REQUEST_SOURCE_ALIASES. A test that reads the map it
 * is checking cannot fail when the map is missing an entry. The next client
 * that picks a new word for itself has to come here and add it, and until it
 * does, the mismatch is a red CI run instead of a silently mis-attributed
 * quarter of the dashboard.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { __setPoolForTesting, __resetPoolForTesting } from "../db/client.js";
import {
  getAnalyticsSummary,
  getRelayExclusions,
  getTopQueries,
  normalizeRequestSource,
  DEFAULT_REQUEST_SOURCE,
  RELAY_TAG_EXCLUSION_NAME,
  __setMachineRelayRulesForTesting,
} from "../db/analytics.js";
import { generatePostSchemaMigration } from "../db/schema.js";

// ---------------------------------------------------------------------------
// The pinned wire vocabulary
// ---------------------------------------------------------------------------

/**
 * Every value a real client is known to send in `X-Pathfinder-Source`, and the
 * analytics audience it must resolve to.
 *
 * - `outpost` — the shared pathfinder MCP client in CopilotKit's outpost
 *   service. One client, several relays: GitHub issue triage AND the
 *   Discord/Slack/Teams bots all initialize through it, which is why the tag
 *   is the generic service name and maps to the generic `relay` audience
 *   rather than to anything GitHub-shaped.
 * - `github-triage` — the name the triage relay was originally specced to
 *   send. Kept pinned because retiring a wire word needs the sender to stop
 *   sending it first, and we cannot see the senders from here.
 */
const WIRE_SOURCE_TAGS: ReadonlyArray<readonly [string, string]> = [
  ["outpost", "relay"],
  ["github-triage", "relay"],
];

describe("X-Pathfinder-Source wire contract", () => {
  it.each(WIRE_SOURCE_TAGS)(
    "maps the wire value %s to the %s audience",
    (wireValue, audience) => {
      expect(normalizeRequestSource(wireValue)).toBe(audience);
    },
  );

  it("maps the wire values case- and whitespace-insensitively", () => {
    // Header values pass through proxies and hand-written config; a client
    // that sends " Outpost " is still that client.
    expect(normalizeRequestSource(" Outpost ")).toBe("relay");
    expect(normalizeRequestSource("GitHub-Triage")).toBe("relay");
  });

  // ── Negatives: the map must not become permissive ────────────────────────

  it("still defaults an unrecognized client to 'user'", () => {
    // The whole point of an alias map is that it is a CLOSED set. If a typo
    // or an unknown service could land in `relay`, the exclusion would start
    // deleting real traffic from the dashboard instead of relay noise.
    expect(normalizeRequestSource("totally-unknown-client")).toBe("user");
    expect(normalizeRequestSource("totally-unknown-client")).not.toBe("relay");
    expect(normalizeRequestSource("outpos")).toBe("user");
    expect(normalizeRequestSource("outpost-staging")).toBe("user");
  });

  it("does not resolve Object.prototype keys through the alias map", () => {
    // `REQUEST_SOURCE_ALIASES[v]` is an object index. Without a
    // null-prototype map (or an own-property check) a client sending
    // `X-Pathfinder-Source: constructor` gets Object itself back from the
    // lookup, and `?? DEFAULT_REQUEST_SOURCE` does not catch a function.
    for (const key of ["constructor", "toString", "__proto__", "valueOf"]) {
      expect(normalizeRequestSource(key)).toBe(DEFAULT_REQUEST_SOURCE);
      expect(typeof normalizeRequestSource(key)).toBe("string");
    }
  });

  it("leaves ordinary user traffic alone", () => {
    expect(normalizeRequestSource("user")).toBe("user");
    expect(normalizeRequestSource(undefined)).toBe("user");
    expect(normalizeRequestSource("")).toBe("user");
    expect(normalizeRequestSource("synthetic")).toBe("synthetic");
    expect(normalizeRequestSource("analysis")).toBe("analysis");
  });
});

// ---------------------------------------------------------------------------
// End-to-end: a row tagged with the wire value is actually excluded
// ---------------------------------------------------------------------------

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

/** The body outpost relays: an issue/message text, verbatim. */
const RELAYED_BODY = "Bug: useCopilotAction does not fire on first render";
const USER_QUERY = "how do I install copilotkit";

describe("a row tagged by the outpost wire value is excluded", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.waitReady;
    await db.exec(extractAnalyticsDdl());
    __setPoolForTesting(poolFromPglite(db));
  });

  afterAll(async () => {
    __resetPoolForTesting();
    __setMachineRelayRulesForTesting(null);
    await db.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM query_log");
    // NO fingerprint rules: this suite proves the TAG path on its own, so a
    // passing run cannot be an artifact of the User-Agent + CIDR rule that is
    // currently doing all the work in production.
    __setMachineRelayRulesForTesting([]);

    // Both rows are written the way the server writes them: whatever the
    // client put in the header, through normalizeRequestSource, into the
    // column. The relay row's IP and User-Agent are deliberately ordinary.
    await insert(db, USER_QUERY, normalizeRequestSource(undefined));
    await insert(db, RELAYED_BODY, normalizeRequestSource("outpost"));
  });

  async function insert(
    pg: PGlite,
    queryText: string,
    requestSource: string,
  ): Promise<void> {
    await pg.query(
      `INSERT INTO query_log
        (tool_name, query_text, result_count, top_score, score_kind,
         latency_ms, source_name, session_id, request_source, client_ip,
         user_agent)
       VALUES ('search-docs',$1,4,0.4,'cosine',25,'docs',$2,$3,'10.20.30.40','undici')`,
      [queryText, `sess-${requestSource}`, requestSource],
    );
  }

  it("keeps the relayed body out of Top Queries", async () => {
    const texts = (await getTopQueries(7, 200)).map((r) => r.query_text);
    expect(texts).not.toContain(RELAYED_BODY);
    // Negative control in the same assertion: the real query survives, so a
    // green run cannot come from an empty result set.
    expect(texts).toContain(USER_QUERY);
  });

  it("keeps the relayed body out of the summary counts", async () => {
    const s = await getAnalyticsSummary({}, 7);
    expect(s.total_queries_window).toBe(1);
  });

  it("counts the relayed body as a tag exclusion, visibly", async () => {
    const rows = await getRelayExclusions(7, {});
    const tagged = rows.find((r) => r.name === RELAY_TAG_EXCLUSION_NAME);
    expect(tagged?.kind).toBe("tag");
    expect(tagged?.count).toBe(1);
  });

  it("surfaces the relayed body under ?request_source=relay", async () => {
    // Excluded from the default audience is not the same as deleted — the
    // operator must still be able to see what was held back.
    const texts = (
      await getTopQueries(7, 200, { request_source: "relay" })
    ).map((r) => r.query_text);
    expect(texts).toContain(RELAYED_BODY);
    expect(texts).not.toContain(USER_QUERY);
  });
});
