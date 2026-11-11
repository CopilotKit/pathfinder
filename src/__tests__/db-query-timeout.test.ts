import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import net from "node:net";
import http from "node:http";
import express from "express";
import pg from "pg";
import pgvector from "pgvector/pg";
import type { DeadlineQueryConfig } from "../db/client.js";

// Every socket the test servers open, so teardown can destroy the ones that
// are still open.
const sockets = new Set<net.Socket>();

// Records a socket for teardown. Every socket gets an "error" listener: an
// error event with no listener (for example a reset from the other end)
// crashes the test worker.
function trackSocket(socket: net.Socket, label: string): void {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", (err) => {
    console.warn(`[test] ${label} socket error: ${err.message}`);
  });
}

// How the fake Postgres host behaves right now. The tests switch it.
// - frozen: the host reads nothing and answers nothing, but keeps every TCP
//   connection open. That is how a frozen database host looks from the
//   client: the socket stays up, the kernel still ACKs, no reply ever comes.
// - replyDelayMs: the host answers each query after this delay, like a
//   healthy database that runs a slow query.
// - slowSql: when set, only a query whose SQL text matches it waits
//   replyDelayMs. The host answers every other query at once.
// - failSql: when set, the host answers a simple query whose SQL text
//   matches it with an ErrorResponse (MISSING_RELATION), like a database
//   that rejects the statement. The connection stays healthy.
const host: {
  frozen: boolean;
  replyDelayMs: number;
  slowSql: RegExp | null;
  failSql: RegExp | null;
} = { frozen: false, replyDelayMs: 0, slowSql: null, failSql: null };

// The SQLSTATE and message of the ErrorResponse for a failSql query.
const MISSING_RELATION = {
  code: "42P01",
  message: 'relation "missing_table" does not exist',
};

// The reply delay for one query with this SQL text.
function replyDelayFor(sql: string): number {
  if (host.slowSql && !host.slowSql.test(sql)) return 0;
  return host.replyDelayMs;
}

// The SQL text in the body of a Query ("Q") or Parse ("P") message. Query:
// the text, then NUL. Parse: the statement name, NUL, the text, NUL.
function sqlText(type: string, body: Buffer): string {
  const fields = body.toString("utf8").split("\0");
  return type === "P" ? fields[1] : fields[0];
}

// The row count the fake host reports for every query with values.
const DELETED_ROWS = 7;

// A minimal Postgres wire-protocol server: it accepts any startup message
// with AuthenticationOk + ReadyForQuery, answers every simple query with an
// empty CommandComplete, and every query with values with a DELETE of
// DELETED_ROWS rows. That is enough for real pg clients to connect and run
// queries, so the pool below is the real pg-pool with real pg Clients over TCP.
const fakePostgres = net.createServer((socket) => {
  trackSocket(socket, "fake Postgres");
  const message = (type: string, body: Buffer): Buffer => {
    const header = Buffer.alloc(5);
    header.write(type, 0, "latin1");
    header.writeInt32BE(body.length + 4, 1);
    return Buffer.concat([header, body]);
  };
  const authOk = message("R", Buffer.from([0, 0, 0, 0]));
  const readyForQuery = message("Z", Buffer.from("I", "latin1"));
  const selectDone = message("C", Buffer.from("SELECT 0\0", "latin1"));
  const parseDone = message("1", Buffer.alloc(0));
  const bindDone = message("2", Buffer.alloc(0));
  const noData = message("n", Buffer.alloc(0));
  const deleteDone = message(
    "C",
    Buffer.from(`DELETE ${DELETED_ROWS}\0`, "latin1"),
  );
  // ErrorResponse: one-byte field type and NUL-terminated value per field,
  // then a NUL. S and V: severity, C: SQLSTATE, M: message.
  const missingRelation = message(
    "E",
    Buffer.from(
      `SERROR\0VERROR\0C${MISSING_RELATION.code}\0M${MISSING_RELATION.message}\0\0`,
      "utf8",
    ),
  );
  let extended: Buffer[] = [];
  let extendedSql = "";
  const reply = (data: Buffer, delayMs: number): void => {
    const write = (): void => {
      if (!socket.destroyed) socket.write(data);
    };
    if (delayMs > 0) setTimeout(write, delayMs);
    else write();
  };

  let pending = Buffer.alloc(0);
  let started = false;
  socket.on("data", (chunk: Buffer) => {
    // A frozen host never processes what it receives.
    if (host.frozen) return;
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      if (!started) {
        if (pending.length < 4) return;
        const length = pending.readInt32BE(0);
        if (pending.length < length) return;
        pending = pending.subarray(length);
        started = true;
        reply(Buffer.concat([authOk, readyForQuery]), 0);
        continue;
      }
      if (pending.length < 5) return;
      const type = String.fromCharCode(pending[0]);
      const length = pending.readInt32BE(1);
      if (pending.length < 1 + length) return;
      const body = pending.subarray(5, 1 + length);
      pending = pending.subarray(1 + length);
      if (type === "Q") {
        const sql = sqlText(type, body);
        const answer = host.failSql?.test(sql) ? missingRelation : selectDone;
        reply(Buffer.concat([answer, readyForQuery]), replyDelayFor(sql));
      }
      // A query with values uses the extended protocol: Parse, Bind,
      // Describe, Execute, then Sync. The answers go out together at Sync,
      // after the same delay as a simple query.
      if (type === "P") {
        extended.push(parseDone);
        extendedSql = sqlText(type, body);
      }
      if (type === "B") extended.push(bindDone);
      if (type === "D") extended.push(noData);
      if (type === "E") extended.push(deleteDone);
      if (type === "S") {
        reply(
          Buffer.concat([...extended, readyForQuery]),
          replyDelayFor(extendedSql),
        );
        extended = [];
        extendedSql = "";
      }
      if (type === "X") socket.end();
    }
  });
});

let databaseUrl = "";

// The /health handler takes its DB branch when a search tool is configured.
vi.mock("../config.js", () => ({
  getServerConfig: () => ({
    server: { name: "test-server" },
    embedding: { dimensions: 3 },
  }),
  getAnalyticsConfig: () => undefined,
  getConfig: () => ({
    port: 3001,
    databaseUrl,
    openaiApiKey: "",
    githubToken: "",
    githubWebhookSecret: "",
    nodeEnv: "test",
    logLevel: "info",
    cloneDir: "/tmp/test",
    slackBotToken: "",
    slackSigningSecret: "",
    discordBotToken: "",
    discordPublicKey: "",
    notionToken: "",
    mcpJwtSecret: "x".repeat(32),
    p2pTelemetryUrl: undefined,
    p2pTelemetryDisabled: false,
    packageVersion: "test",
  }),
  hasSearchTools: () => true,
  hasKnowledgeTools: () => false,
  hasCollectTools: () => false,
  hasBashSemanticSearch: () => false,
}));

const {
  getPool,
  closePool,
  initializeSchema,
  DB_CONNECT_TIMEOUT_MS,
  DB_QUERY_TIMEOUT_MS,
  DB_MAINTENANCE_QUERY_TIMEOUT_MS,
} = await import("../db/client.js");
const { registerHealthRoute } = await import("../server.js");
const { cleanupOldQueryLogs } = await import("../db/analytics.js");
const {
  cleanupOldWebhookDeliveries,
  getAllChunksForLlms,
  LLMS_EXPORT_QUERY_TIMEOUT_MS,
} = await import("../db/queries.js");

// Every timing below is derived from the real DB_QUERY_TIMEOUT_MS, so a
// change to the constant moves the waits, deadlines and test timeouts with it.
// Extra time allowed on a slow CI host before a deadline counts as a failure.
const SLOW_HOST_MARGIN_MS = 3_000;
// Node can fire a timer about 1ms before its delay when measured with
// Date.now(), from clock rounding. Lower bounds on elapsed time subtract
// this margin so that correct code does not fail on that rounding.
const TIMER_EARLY_MARGIN_MS = 100;
// A per-query deadline far below the default, for the checkout test.
const SHORT_QUERY_TIMEOUT_MS = 1_000;
// The deadline of a query that waits in a client's queue behind an active
// one, and how long the host takes to answer that active one. The queued
// deadline expires first.
const QUEUED_QUERY_TIMEOUT_MS = 500;
const QUEUED_REPLY_DELAY_MS = 2_000;
// How long past the default deadline the slow host takes to answer.
const SLOW_REPLY_EXTRA_MS = 2_000;
vi.setConfig({
  testTimeout: DB_QUERY_TIMEOUT_MS + SLOW_REPLY_EXTRA_MS + 15_000,
});

afterEach(() => {
  vi.restoreAllMocks();
  host.frozen = false;
  host.replyDelayMs = 0;
  host.slowSql = null;
  host.failSql = null;
});

// Settles with the promise's outcome and the time it took, or with
// "did not settle" at `limitMs`. A query that hangs (no deadline) then fails
// the test with a clear message instead of a test timeout.
async function settle<T>(
  promise: Promise<T>,
  limitMs: number,
): Promise<{ value?: T; error?: unknown; hung?: true; elapsed: number }> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ value, elapsed: Date.now() - started }),
        (error: unknown) => ({ error, elapsed: Date.now() - started }),
      ),
      new Promise<{ hung: true; elapsed: number }>((resolve) => {
        timer = setTimeout(
          () => resolve({ hung: true, elapsed: Date.now() - started }),
          limitMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function expectTimedOutAt(
  outcome: { error?: unknown; hung?: true; elapsed: number },
  limitMs: number,
): void {
  expect(outcome.hung, `query still pending after ${outcome.elapsed}ms`).toBe(
    undefined,
  );
  const { port } = fakePostgres.address() as net.AddressInfo;
  const error = outcome.error;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(
    `Postgres query to 127.0.0.1:${port} timed out after ${limitMs}ms`,
  );
  // pg's own read-timeout error is kept as the cause.
  expect((error as Error).cause).toBeInstanceOf(Error);
  expect(((error as Error).cause as Error).message).toBe("Query read timeout");
  expect(outcome.elapsed).toBeGreaterThanOrEqual(
    limitMs - TIMER_EARLY_MARGIN_MS,
  );
  expect(outcome.elapsed).toBeLessThan(limitMs + SLOW_HOST_MARGIN_MS);
}

function dbLines(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls
    .map((args) => args.map(String).join(" "))
    .filter((line) => line.startsWith("[db]"));
}

// Records every client the pool hands out until stop() is called, so a test
// can check those same clients afterwards.
function recordCheckouts(pool: pg.Pool): {
  clients: Set<pg.PoolClient>;
  stop: () => void;
} {
  const clients = new Set<pg.PoolClient>();
  const onAcquire = (client: pg.PoolClient): void => {
    clients.add(client);
  };
  pool.on("acquire", onAcquire);
  return { clients, stop: () => pool.off("acquire", onAcquire) };
}

// Each of these clients is open (not ending) and is back in the pool's idle
// list. pg-pool keeps that list in _idle, as IdleItems with a client field.
// The counts alone cannot show this: 0 total and 0 idle are equal too.
function expectBackInPoolIdle(
  pool: pg.Pool,
  clients: Set<pg.PoolClient>,
): void {
  const idle: unknown = Reflect.get(pool, "_idle");
  const idleClients = Array.isArray(idle)
    ? idle.map((item: unknown) => Reflect.get(Object(item), "client"))
    : [];
  for (const client of clients) {
    expect(Reflect.get(client, "_ending")).toBe(false);
    expect(idleClients).toContain(client);
  }
  expect(pool.totalCount).toBeGreaterThanOrEqual(clients.size);
  expect(pool.idleCount).toBe(pool.totalCount);
}

function getHealth(port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: "/health" }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

describe("database query deadline on an open connection", () => {
  const app = express();
  registerHealthRoute(app);
  const healthServer = http.createServer(app);

  beforeAll(async () => {
    await new Promise<void>((resolve) =>
      fakePostgres.listen(0, "127.0.0.1", resolve),
    );
    await new Promise<void>((resolve) =>
      healthServer.listen(0, "127.0.0.1", resolve),
    );
    const { port } = fakePostgres.address() as net.AddressInfo;
    databaseUrl = `postgres://user:pass@127.0.0.1:${port}/db`;
  });

  afterAll(async () => {
    // pg-pool's end() waits until every client is gone. Destroying the
    // sockets ends any client that is still open.
    const closing = Promise.all([
      closePool(),
      new Promise<void>((resolve) => fakePostgres.close(() => resolve())),
      new Promise<void>((resolve) => healthServer.close(() => resolve())),
    ]);
    healthServer.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    await closing;
  });

  it("fails a query on a reused idle client at the deadline, drops the client and recovers", async () => {
    const pool = getPool();
    // Query 1 opens a connection; the client goes back to the pool idle.
    await pool.query("SELECT 1");
    expect(pool.totalCount).toBe(1);
    expect(pool.idleCount).toBe(1);

    // The host freezes. Query 2 gets the same idle client.
    host.frozen = true;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = await settle(
      pool.query("SELECT 1"),
      DB_QUERY_TIMEOUT_MS + SLOW_HOST_MARGIN_MS,
    );
    const lines = dbLines(logged);
    logged.mockRestore();

    expectTimedOutAt(outcome, DB_QUERY_TIMEOUT_MS);
    // Logged once, with the same text as the error.
    expect(lines).toEqual([`[db] ${(outcome.error as Error).message}`]);
    // The frozen client is gone from the pool.
    expect(pool.totalCount).toBe(0);
    expect(pool.idleCount).toBe(0);

    // The host answers again: the same pool opens a fresh connection.
    host.frozen = false;
    const result = await pool.query("SELECT 1");
    expect(result.command).toBe("SELECT");
    expect(pool.totalCount).toBe(1);
    expect(pool.idleCount).toBe(1);
  });

  it("destroys a timed-out client that the caller releases without an error", async () => {
    const pool = getPool();
    // Start from one idle client that is known to work.
    await pool.query("SELECT 1");
    const before = pool.totalCount;
    expect(before).toBeGreaterThan(0);

    // The checkout pattern of replaceChunksForFile and upsertChunks: the
    // caller swallows the query error and calls release() with no argument.
    const client = await pool.connect();
    host.frozen = true;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const short: DeadlineQueryConfig = {
      text: "SELECT 1",
      query_timeout: SHORT_QUERY_TIMEOUT_MS,
    };
    const outcome = await settle(
      client.query(short),
      SHORT_QUERY_TIMEOUT_MS + SLOW_HOST_MARGIN_MS,
    );
    logged.mockRestore();
    client.release();

    expectTimedOutAt(outcome, SHORT_QUERY_TIMEOUT_MS);
    // The released client did not go back to the idle list.
    expect(pool.totalCount).toBe(before - 1);
    expect(pool.idleCount).toBe(before - 1);

    // A query after the host recovers runs on a working connection. A frozen
    // client left in the pool would make this query time out.
    host.frozen = false;
    const recovered = await settle(
      pool.query("SELECT 1"),
      SHORT_QUERY_TIMEOUT_MS + SLOW_HOST_MARGIN_MS,
    );
    expect(recovered.error).toBeUndefined();
    expect(recovered.hung).toBeUndefined();
    expect(recovered.value?.command).toBe("SELECT");
  });

  it("fails a timed-out queued query alone and keeps the client and its active query", async () => {
    const pool = getPool();
    // Start from one idle client that is known to work.
    await pool.query("SELECT 1");
    const before = pool.totalCount;
    expect(before).toBeGreaterThan(0);

    // A is on the wire; the host answers it after QUEUED_REPLY_DELAY_MS,
    // inside A's own deadline. B waits in the client's queue behind A with a
    // shorter deadline, so B times out before it is ever sent.
    const client = await pool.connect();
    try {
      host.replyDelayMs = QUEUED_REPLY_DELAY_MS;
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const active: DeadlineQueryConfig = {
        text: "SELECT 1",
        query_timeout: DB_QUERY_TIMEOUT_MS,
      };
      const queued: DeadlineQueryConfig = {
        text: "SELECT 1",
        query_timeout: QUEUED_QUERY_TIMEOUT_MS,
      };
      const [a, b] = await Promise.all([
        settle(
          client.query(active),
          QUEUED_REPLY_DELAY_MS + SLOW_HOST_MARGIN_MS,
        ),
        settle(
          client.query(queued),
          QUEUED_QUERY_TIMEOUT_MS + SLOW_HOST_MARGIN_MS,
        ),
      ]);
      const lines = dbLines(logged);
      logged.mockRestore();

      // B fails alone, with the wrapped error, at its own deadline.
      expectTimedOutAt(b, QUEUED_QUERY_TIMEOUT_MS);
      expect(lines).toEqual([`[db] ${(b.error as Error).message}`]);
      // A is not touched: it gets the host's answer when it comes.
      expect(a.hung).toBeUndefined();
      expect(a.error, `A failed after ${a.elapsed}ms`).toBeUndefined();
      expect(a.value?.command).toBe("SELECT");
      expect(a.elapsed).toBeGreaterThanOrEqual(
        QUEUED_REPLY_DELAY_MS - TIMER_EARLY_MARGIN_MS,
      );

      // The client still works.
      host.replyDelayMs = 0;
      const next = await settle(
        client.query("SELECT 1"),
        SHORT_QUERY_TIMEOUT_MS + SLOW_HOST_MARGIN_MS,
      );
      expect(next.error).toBeUndefined();
      expect(next.value?.command).toBe("SELECT");
    } finally {
      // Released on a failed check too, so the pool can end in afterAll.
      client.release();
    }
    // It went back to the pool, idle.
    expect(pool.totalCount).toBe(before);
    expect(pool.idleCount).toBe(before);
  });

  it("lets a query with a longer query_timeout outlive the default deadline", async () => {
    const pool = getPool();
    host.replyDelayMs = DB_QUERY_TIMEOUT_MS + SLOW_REPLY_EXTRA_MS;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const long: DeadlineQueryConfig = {
      text: "SELECT 1",
      query_timeout: DB_MAINTENANCE_QUERY_TIMEOUT_MS,
    };
    // Both run at once, each on its own connection. The slow host answers
    // both after the default deadline.
    const [plain, extended] = await Promise.all([
      settle(pool.query("SELECT 1"), DB_QUERY_TIMEOUT_MS + SLOW_HOST_MARGIN_MS),
      settle(
        pool.query(long),
        DB_QUERY_TIMEOUT_MS + SLOW_REPLY_EXTRA_MS + SLOW_HOST_MARGIN_MS,
      ),
    ]);
    logged.mockRestore();

    // The default deadline applies to the plain query.
    expectTimedOutAt(plain, DB_QUERY_TIMEOUT_MS);
    // The long one waits past it and gets the slow answer.
    expect(extended.hung).toBeUndefined();
    expect(extended.error).toBeUndefined();
    expect(extended.value?.command).toBe("SELECT");
    expect(extended.elapsed).toBeGreaterThanOrEqual(
      DB_QUERY_TIMEOUT_MS + SLOW_REPLY_EXTRA_MS - TIMER_EARLY_MARGIN_MS,
    );
  });

  it("lets the nightly retention purges outlive the default deadline", async () => {
    const pool = getPool();
    // The first purge of a large backlog: the host answers each DELETE only
    // after the default deadline has passed.
    host.replyDelayMs = DB_QUERY_TIMEOUT_MS + SLOW_REPLY_EXTRA_MS;
    const limitMs =
      DB_QUERY_TIMEOUT_MS + SLOW_REPLY_EXTRA_MS + SLOW_HOST_MARGIN_MS;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const checkouts = recordCheckouts(pool);
    // Both run at once, each on its own connection, so the test waits for
    // the slow answer only once.
    const [queryLogs, webhookDeliveries] = await Promise.all([
      settle(cleanupOldQueryLogs(90), limitMs),
      settle(cleanupOldWebhookDeliveries(30), limitMs),
    ]);
    checkouts.stop();
    const lines = dbLines(errors);

    for (const purge of [queryLogs, webhookDeliveries]) {
      expect(purge.hung).toBeUndefined();
      expect(purge.error).toBeUndefined();
      expect(purge.value).toBe(DELETED_ROWS);
      expect(purge.elapsed).toBeGreaterThanOrEqual(
        DB_QUERY_TIMEOUT_MS + SLOW_REPLY_EXTRA_MS - TIMER_EARLY_MARGIN_MS,
      );
    }
    expect(lines).toEqual([]);
    // No purge closed its connection: each purge ran on its own client, and
    // both clients are open and back in the pool, idle.
    expect(checkouts.clients.size).toBe(2);
    expectBackInPoolIdle(pool, checkouts.clients);
  });

  it("lets the llms.txt export and the schema COMMIT outlive the default deadline", async () => {
    const pool = getPool();
    // A large index: the host answers the full chunks read and the COMMIT of
    // the schema transaction only after the default deadline has passed.
    // Every other statement is answered at once.
    host.replyDelayMs = DB_QUERY_TIMEOUT_MS + SLOW_REPLY_EXTRA_MS;
    host.slowSql = /^(SELECT source_name, file_path, title, content, |COMMIT$)/;
    const limitMs =
      DB_QUERY_TIMEOUT_MS + SLOW_REPLY_EXTRA_MS + SLOW_HOST_MARGIN_MS;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // The fake host has no pg_type rows, so pgvector cannot find the vector
    // type. Only that type-parser setup is stubbed; every schema statement
    // still goes over the socket.
    vi.spyOn(pgvector, "registerType").mockResolvedValue(undefined);
    // The deadline each statement asks pg for (undefined: the client default).
    const sent: Array<[string, number | undefined]> = [];
    const query = pg.Client.prototype.query;
    vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (
      this: pg.Client,
      ...args: Parameters<typeof query>
    ) {
      const config: unknown = args[0];
      if (typeof config === "string") sent.push([config.trim(), undefined]);
      else if (typeof config === "object" && config !== null)
        sent.push([
          String(Reflect.get(config, "text")).trim(),
          Reflect.get(config, "query_timeout"),
        ]);
      return Reflect.apply(query, this, args);
    });
    const checkouts = recordCheckouts(pool);
    // Both run at once, each on its own connection, so the test waits for
    // the slow answer only once.
    const [llms, schema] = await Promise.all([
      settle(getAllChunksForLlms(), limitMs),
      settle(initializeSchema(), limitMs),
    ]);
    checkouts.stop();
    const lines = dbLines(errors);

    // One assertion for both, so a failure shows both outcomes.
    expect({ llms: llms.error, schema: schema.error }).toEqual({
      llms: undefined,
      schema: undefined,
    });
    for (const outcome of [llms, schema]) {
      expect(outcome.hung).toBeUndefined();
      expect(outcome.elapsed).toBeGreaterThanOrEqual(
        DB_QUERY_TIMEOUT_MS + SLOW_REPLY_EXTRA_MS - TIMER_EARLY_MARGIN_MS,
      );
    }
    expect(llms.value).toEqual([]);
    // The export asks for its own bound, not the 30-minute maintenance one.
    expect(sent).toContainEqual([
      "SELECT source_name, file_path, title, content, chunk_index FROM chunks ORDER BY source_name, file_path, chunk_index",
      LLMS_EXPORT_QUERY_TIMEOUT_MS,
    ]);
    expect(LLMS_EXPORT_QUERY_TIMEOUT_MS).toBeGreaterThan(DB_QUERY_TIMEOUT_MS);
    expect(LLMS_EXPORT_QUERY_TIMEOUT_MS).toBeLessThan(
      DB_MAINTENANCE_QUERY_TIMEOUT_MS,
    );
    // Both ends of the schema transaction carry the maintenance deadline.
    expect(sent).toContainEqual(["BEGIN", DB_MAINTENANCE_QUERY_TIMEOUT_MS]);
    expect(sent).toContainEqual(["COMMIT", DB_MAINTENANCE_QUERY_TIMEOUT_MS]);
    expect(lines).toEqual([]);
    // No connection was closed: every client the export and the schema
    // checked out is open and back in the pool, idle.
    expect(checkouts.clients.size).toBeGreaterThan(0);
    expectBackInPoolIdle(pool, checkouts.clients);
  });

  it("keeps the schema COMMIT timeout error when the ROLLBACK after it fails", async () => {
    const pool = getPool();
    // The COMMIT gets a short deadline, so the test does not wait 30 minutes.
    // The deadline is set on the pool's own client class (DeadlineClient),
    // so the timeout runs through its real handling: it closes the client,
    // and the ROLLBACK after it then fails.
    const probe = await pool.connect();
    const clientClass: { query: (...args: unknown[]) => unknown } =
      Object.getPrototypeOf(probe);
    probe.release();
    const query = clientClass.query;
    vi.spyOn(clientClass, "query").mockImplementation(function (
      this: pg.Client,
      ...args: unknown[]
    ) {
      const config: unknown = args[0];
      if (
        typeof config === "object" &&
        config !== null &&
        Reflect.get(config, "text") === "COMMIT"
      ) {
        args[0] = { ...config, query_timeout: QUEUED_QUERY_TIMEOUT_MS };
      }
      return Reflect.apply(query, this, args);
    });
    host.replyDelayMs = QUEUED_REPLY_DELAY_MS;
    host.slowSql = /^COMMIT$/;
    // See the test above: the fake host has no pg_type rows.
    vi.spyOn(pgvector, "registerType").mockResolvedValue(undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // The error that each client checked out by initializeSchema() was
    // released with.
    const released: Array<Error | undefined> = [];
    const onRelease = (err: Error | undefined): void => {
      released.push(err);
    };
    pool.on("release", onRelease);
    const outcome = await settle(
      initializeSchema(),
      QUEUED_QUERY_TIMEOUT_MS + SLOW_HOST_MARGIN_MS,
    );
    pool.off("release", onRelease);
    const lines = dbLines(errors);

    // The caller gets the COMMIT timeout, not the ROLLBACK failure.
    expectTimedOutAt(outcome, QUEUED_QUERY_TIMEOUT_MS);
    expect(lines).toEqual([
      `[db] ${(outcome.error as Error).message}`,
      "[db] Schema transaction ROLLBACK failed: Client was closed and is not queryable. Releasing the client with this error; the original error is rethrown.",
    ]);
    // The clients before it (the dimension check and the setup client) go
    // back to the pool without an error. The migration client is released
    // last, with the ROLLBACK error, so pg-pool drops it.
    const migrationRelease = released.pop();
    expect(released.length).toBeGreaterThan(0);
    for (const err of released) expect(err).toBeFalsy();
    expect(migrationRelease).toBeInstanceOf(Error);
    expect((migrationRelease as Error).message).toBe(
      "Client was closed and is not queryable",
    );
  });

  it("answers /health with 503 at the deadline instead of hanging, then recovers", async () => {
    const pool = getPool();
    const { port } = healthServer.address() as net.AddressInfo;
    const { port: dbPort } = fakePostgres.address() as net.AddressInfo;

    // A healthy /health leaves its clients idle in the pool.
    expect((await getHealth(port)).status).toBe(200);
    const warm = pool.totalCount;
    expect(warm).toBeGreaterThan(0);
    expect(pool.idleCount).toBe(warm);

    // The host freezes. /health reuses those idle clients.
    host.frozen = true;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = await settle(
      getHealth(port),
      DB_QUERY_TIMEOUT_MS + SLOW_HOST_MARGIN_MS,
    );
    const lines = dbLines(logged);
    logged.mockRestore();

    expect(
      outcome.hung,
      `/health still pending after ${outcome.elapsed}ms`,
    ).toBe(undefined);
    expect(outcome.value?.status).toBe(503);
    expect(JSON.parse(outcome.value?.body ?? "{}")).toMatchObject({
      status: "degraded",
      index: "unavailable",
    });
    expect(outcome.elapsed).toBeGreaterThanOrEqual(
      DB_QUERY_TIMEOUT_MS - TIMER_EARLY_MARGIN_MS,
    );
    expect(outcome.elapsed).toBeLessThan(
      DB_QUERY_TIMEOUT_MS + SLOW_HOST_MARGIN_MS,
    );
    // One line per timed-out client, each naming host, port and limit.
    expect(lines).toEqual(
      Array.from(
        { length: warm },
        () =>
          `[db] Postgres query to 127.0.0.1:${dbPort} timed out after ${DB_QUERY_TIMEOUT_MS}ms`,
      ),
    );
    // Every frozen client is gone.
    expect(pool.totalCount).toBe(0);

    // The host answers again: /health is healthy on the same pool.
    host.frozen = false;
    expect((await getHealth(port)).status).toBe(200);
  });

  // Only pg's query read timeout is wrapped, logged and closes the client.
  // Any other query error, such as a statement the database rejects, reaches
  // the caller as pg's own error, and the client stays open and pooled.
  describe("a query error that is not a timeout", () => {
    // Records each query error that pg's own Client.query() hands back, and
    // the client that ran each query, so the test can check that the caller
    // gets that same error object and that the next query reuses the client.
    function spyOnPgQuery(): { errors: Error[]; clients: pg.Client[] } {
      const seen: { errors: Error[]; clients: pg.Client[] } = {
        errors: [],
        clients: [],
      };
      const query = pg.Client.prototype.query;
      vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (
        this: pg.Client,
        ...args: Parameters<typeof query>
      ) {
        seen.clients.push(this);
        const last: unknown = args[args.length - 1];
        if (typeof last === "function") {
          args[args.length - 1] = (err: Error | null, result?: unknown) => {
            if (err) seen.errors.push(err);
            Reflect.apply(last, undefined, [err, result]);
          };
        }
        const result: unknown = Reflect.apply(query, this, args);
        if (result instanceof Promise) {
          result.catch((err: Error) => seen.errors.push(err));
        }
        return result;
      });
      return seen;
    }

    // The caller got pg's own DatabaseError, not a wrapper made in
    // src/db/client.ts.
    function expectPgError(error: unknown, pgErrors: Error[]): void {
      expect(pgErrors).toHaveLength(1);
      expect(error).toBe(pgErrors[0]);
      expect(error).toBeInstanceOf(pg.DatabaseError);
      expect((error as pg.DatabaseError).code).toBe(MISSING_RELATION.code);
      expect((error as Error).message).toBe(MISSING_RELATION.message);
      expect((error as Error).cause).toBeUndefined();
    }

    it("passes it through unchanged on pool.query and does not log or end the client", async () => {
      const pool = getPool();
      // Start from one idle client that is known to work.
      await pool.query("SELECT 1");
      const before = pool.totalCount;
      expect(before).toBeGreaterThan(0);
      expect(pool.idleCount).toBe(before);

      host.failSql = /missing_table/;
      const seen = spyOnPgQuery();
      // pg-pool's own query() releases the client with the query error, so
      // pg-pool removes it from the pool. That is upstream behavior. What
      // this test checks is that src/db/client.ts did not end the client
      // first: at the release, the client is not ending.
      const released: Array<{ err: Error; ending: unknown }> = [];
      const onRelease = (err: Error, client: pg.PoolClient): void => {
        released.push({ err, ending: Reflect.get(client, "_ending") });
      };
      pool.on("release", onRelease);
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const outcome = await settle(
        pool.query("SELECT * FROM missing_table"),
        SHORT_QUERY_TIMEOUT_MS + SLOW_HOST_MARGIN_MS,
      );
      const lines = dbLines(logged);
      logged.mockRestore();
      pool.off("release", onRelease);

      expect(outcome.hung).toBeUndefined();
      expectPgError(outcome.error, seen.errors);
      // No [db] line: only the read timeout is logged.
      expect(lines).toEqual([]);
      // pg-pool got pg's error at the release, and the client was not ending.
      expect(released).toEqual([{ err: outcome.error, ending: false }]);
      expect(pool.totalCount).toBe(before - 1);
      expect(pool.idleCount).toBe(before - 1);
    });

    it("passes it through unchanged on a checked-out client and keeps the client pooled", async () => {
      const pool = getPool();
      // Start from one idle client that is known to work.
      await pool.query("SELECT 1");
      const before = pool.totalCount;
      expect(before).toBeGreaterThan(0);
      expect(pool.idleCount).toBe(before);

      host.failSql = /missing_table/;
      const seen = spyOnPgQuery();
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const client = await pool.connect();
      let outcome: Awaited<ReturnType<typeof settle>>;
      try {
        outcome = await settle(
          client.query("SELECT * FROM missing_table"),
          SHORT_QUERY_TIMEOUT_MS + SLOW_HOST_MARGIN_MS,
        );
      } finally {
        // The checkout pattern of replaceChunksForFile: release() with no
        // error after a failed query.
        client.release();
      }
      const lines = dbLines(logged);
      logged.mockRestore();

      expect(outcome.hung).toBeUndefined();
      expectPgError(outcome.error, seen.errors);
      expect(seen.clients).toEqual([client]);
      // No [db] line: only the read timeout is logged.
      expect(lines).toEqual([]);
      // The client was not ended: it went back to the pool, idle.
      expect(pool.totalCount).toBe(before);
      expect(pool.idleCount).toBe(pool.totalCount);

      // The next query runs on that same client.
      host.failSql = null;
      const next = await settle(
        pool.query("SELECT 1"),
        SHORT_QUERY_TIMEOUT_MS + SLOW_HOST_MARGIN_MS,
      );
      expect(next.error).toBeUndefined();
      expect(next.value?.command).toBe("SELECT");
      expect(seen.clients).toEqual([client, client]);
      expect(pool.totalCount).toBe(before);
      expect(pool.idleCount).toBe(pool.totalCount);
    });
  });

  // The error and the log must name the deadline pg actually set. pg takes
  // the query's own query_timeout when it is truthy, else the client's (which
  // a query_timeout in DATABASE_URL replaces), and Node's setTimeout() then
  // turns a string into a number and anything below 1 or above 2^31-1 into
  // 1ms.
  describe("reported limit", () => {
    const realUrl = (): string => {
      const { port } = fakePostgres.address() as net.AddressInfo;
      return `postgres://user:pass@127.0.0.1:${port}/db`;
    };

    afterEach(async () => {
      host.frozen = false;
      await closePool();
      databaseUrl = realUrl();
    });

    it("names the query_timeout from DATABASE_URL", async () => {
      const urlTimeoutMs = 1_500;
      await closePool();
      databaseUrl = `${realUrl()}?query_timeout=${urlTimeoutMs}`;
      const pool = getPool();
      await pool.query("SELECT 1");

      host.frozen = true;
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const outcome = await settle(
        pool.query("SELECT 1"),
        urlTimeoutMs + SLOW_HOST_MARGIN_MS,
      );
      const lines = dbLines(logged);
      logged.mockRestore();

      expectTimedOutAt(outcome, urlTimeoutMs);
      expect(lines).toEqual([`[db] ${(outcome.error as Error).message}`]);
    });

    it("names the deadline pg applies to a numeric-string query_timeout", async () => {
      const pool = getPool();
      await pool.query("SELECT 1");

      host.frozen = true;
      vi.spyOn(console, "error").mockImplementation(() => {});
      // pg passes the string to setTimeout(), which reads it as a number.
      const config = { text: "SELECT 1", query_timeout: "1200" };
      const outcome = await settle(
        pool.query(config),
        1_200 + SLOW_HOST_MARGIN_MS,
      );

      expectTimedOutAt(outcome, 1_200);
    });

    it("names 1ms for a query_timeout that setTimeout() clamps", async () => {
      const pool = getPool();
      await pool.query("SELECT 1");
      // Node warns when it clamps a delay. The warning is expected here.
      const warn = vi
        .spyOn(process, "emitWarning")
        .mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});

      // A negative value is truthy, so pg uses it instead of the default; a
      // value above 2^31-1 does not fit Node's timer. Both become 1ms.
      for (const queryTimeout of [-5, 2 ** 31]) {
        const client = await pool.connect();
        try {
          host.frozen = true;
          const config: DeadlineQueryConfig = {
            text: "SELECT 1",
            query_timeout: queryTimeout,
          };
          const outcome = await settle(
            client.query(config),
            SLOW_HOST_MARGIN_MS,
          );
          expectTimedOutAt(outcome, 1);
        } finally {
          client.release();
          host.frozen = false;
        }
      }
      expect(warn).toHaveBeenCalled();
    });

    it("keeps naming DB_CONNECT_TIMEOUT_MS when DATABASE_URL sets a connect timeout", async () => {
      // pg times the connect with the constructor's connectionTimeoutMillis
      // (pg/lib/client.js), never with a URL parameter: connect_timeout
      // from the URL only reaches the native libpq connection string.
      await closePool();
      databaseUrl = `${realUrl()}?connect_timeout=1&connectionTimeoutMillis=1000`;
      host.frozen = true;
      const { port } = fakePostgres.address() as net.AddressInfo;
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const outcome = await settle(
        getPool().query("SELECT 1"),
        DB_CONNECT_TIMEOUT_MS + SLOW_HOST_MARGIN_MS,
      );
      const lines = dbLines(logged);
      logged.mockRestore();

      expect(outcome.hung).toBeUndefined();
      const message = `Postgres connect to 127.0.0.1:${port} timed out after ${DB_CONNECT_TIMEOUT_MS}ms`;
      expect((outcome.error as Error).message).toBe(message);
      expect(lines).toEqual([`[db] ${message}`]);
      expect(outcome.elapsed).toBeGreaterThanOrEqual(
        DB_CONNECT_TIMEOUT_MS - TIMER_EARLY_MARGIN_MS,
      );
      expect(outcome.elapsed).toBeLessThan(
        DB_CONNECT_TIMEOUT_MS + SLOW_HOST_MARGIN_MS,
      );
    });
  });
});

// The purges pass a query config ({ text, values, query_timeout }), not a
// text with values. The in-process PGlite pool must take that form too.
describe("retention purges on the PGlite pool", () => {
  beforeAll(async () => {
    await closePool();
    databaseUrl = "pglite://memory://";
    await initializeSchema();
  });

  afterAll(async () => {
    await closePool();
  });

  it("deletes only the rows past retention", async () => {
    const pool = getPool();
    await pool.query(
      `INSERT INTO query_log (tool_name, query_text, result_count, latency_ms, created_at)
       VALUES ('search', 'old', 0, 1, NOW() - INTERVAL '91 days'),
              ('search', 'new', 0, 1, NOW())`,
    );
    await pool.query(
      `INSERT INTO webhook_deliveries (source, decision, delivered_at)
       VALUES ('github', 'skip', NOW() - INTERVAL '31 days'),
              ('github', 'skip', NOW())`,
    );
    vi.spyOn(console, "log").mockImplementation(() => {});

    // The returned count is not checked: PGlite results carry affectedRows,
    // not pg's rowCount, so the purges report 0 on PGlite.
    await cleanupOldQueryLogs(90);
    await cleanupOldWebhookDeliveries(30);

    const logs = await pool.query("SELECT query_text FROM query_log");
    expect(logs.rows).toEqual([{ query_text: "new" }]);
    const deliveries = await pool.query(
      "SELECT delivered_at > NOW() - INTERVAL '1 day' AS fresh FROM webhook_deliveries",
    );
    expect(deliveries.rows).toEqual([{ fresh: true }]);
  });
});
