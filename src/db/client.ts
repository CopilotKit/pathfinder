import pg from "pg";
import pgvector from "pgvector/pg";
import {
  generateSchema,
  generateMigration,
  generatePostSchemaMigration,
  generateTsvTriggerDdl,
  generateDimensionCheckQuery,
  generateStoredDimensionQuery,
} from "./schema.js";
import { getConfig, getServerConfig } from "../config.js";

let pool: pg.Pool | null = null;

/** The pooled clients a caller has checked out right now (see getPool()). */
const checkedOutClients = new WeakSet<object>();

/**
 * Upper bound for opening one NEW Postgres connection. pg starts the timer
 * before it calls socket.connect(), and clears it at the server's first
 * ReadyForQuery message. So it covers the DNS lookup (when the host is a
 * name), the TCP connect, TLS, the startup message and authentication.
 *
 * Without it, pg sets no deadline on the connect. If TCP never completes,
 * the connect waits until the OS TCP connect timeout (typically a minute or
 * more). If the host accepts TCP but never sends a protocol reply, the
 * connect waits with no bound at all. A healthy connect takes well under a
 * second, so this value is generous.
 *
 * When the timer expires, pg destroys the socket with the error
 * "timeout expired". DeadlineClient logs it and replaces it with an error
 * that names the host, the port and the limit (pg's error stays as
 * `cause`). The query (or /health check) that was waiting for that new
 * connection fails with that error.
 *
 * A query on a connection that is already open is bounded separately, by
 * DB_QUERY_TIMEOUT_MS.
 */
export const DB_CONNECT_TIMEOUT_MS = 5_000;

/**
 * Default upper bound for one query on a connection that is already open,
 * for example an idle client that the pool hands out again. It is pg's
 * query_timeout: a timer in pg, on the client, that runs from the query()
 * call until the whole result is in. So it also bounds a query that waits
 * in this client's own queue, and the time to receive every row.
 *
 * Without it, a query on an open connection has no deadline. If the host
 * freezes after the connection opened, the query, and /health with it,
 * waits forever. statement_timeout does not help there: the server process
 * enforces it, so it works only while that process still runs. TCP
 * keepAlive (off by default in pg) does not help either. The OS drops the
 * socket only when the peer does not ACK the keepalive probes, and the
 * kernel of a frozen server can still ACK them.
 *
 * Request-path queries (search, /health, analytics, atlas, index writes)
 * take well under a second on a healthy database. 30 seconds stays far above
 * that, and still ends a hang. Schema setup at startup and the nightly
 * retention purges use DB_MAINTENANCE_QUERY_TIMEOUT_MS instead.
 *
 * When the timer expires, DeadlineClient logs an error that names the host,
 * the port and the limit, fails the query with it (pg's "Query read timeout"
 * stays as `cause`). If that query was on the wire, it also closes the
 * connection. A closed client never goes back to the pool, so a frozen
 * socket is not used again. A query that timed out while it waited in the
 * client's queue was never sent, so the connection stays open (see
 * DeadlineClient.onQueryError()).
 */
export const DB_QUERY_TIMEOUT_MS = 30_000;

/**
 * Upper bound for each maintenance statement, which can legitimately run for
 * minutes, so the request-path default would fail valid work:
 * - Each schema statement in initializeSchema(): the migration, the schema
 *   DDL and the tsvector trigger. These can build indexes (HNSW, GIN) on a
 *   full chunks table, backfill a column, or wait for a lock that another
 *   instance holds during a deploy.
 * - The nightly retention purges (cleanupOldQueryLogs,
 *   cleanupOldWebhookDeliveries). The first purge of a large backlog can
 *   delete millions of rows in one statement. A purge that timed out would
 *   roll back, so it would fail the same way every night.
 * 30 minutes still ends a hang if the host freezes.
 */
export const DB_MAINTENANCE_QUERY_TIMEOUT_MS = 30 * 60_000;

/**
 * A QueryConfig with pg's per-query deadline. pg reads `query_timeout` from
 * the query config before it falls back to the client's default
 * (pg/lib/client.js, Client.prototype.query), but @types/pg leaves the field
 * out of QueryConfig. A value of 0 or no value means the client default
 * (DB_QUERY_TIMEOUT_MS, or a query_timeout in DATABASE_URL): pg cannot turn
 * the deadline off for one query. The timeout error names the deadline pg
 * applied (see DeadlineClient.queryDeadlineMs()).
 */
export interface DeadlineQueryConfig extends pg.QueryConfig {
  query_timeout?: number;
}

// The largest delay Node's setTimeout() accepts. It sets a larger one to 1ms.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

// The callback form of pg's query(): (err) on failure, (null, result) on
// success.
type QueryCallback = (err: Error | null, result?: unknown) => void;

function isQueryCallback(value: unknown): value is QueryCallback {
  return typeof value === "function";
}

function isSubmittable(value: unknown): value is pg.Submittable {
  return (
    typeof value === "object" &&
    value !== null &&
    "submit" in value &&
    typeof value.submit === "function"
  );
}

/**
 * A pg Client with a deadline on its connect (DB_CONNECT_TIMEOUT_MS) and on
 * each query (DB_QUERY_TIMEOUT_MS, or the query's own `query_timeout`).
 *
 * The connect bound is set here, NOT as the pool's connectionTimeoutMillis.
 * In pg-pool that option also limits how long a caller waits in the queue
 * for a free client when all `max` clients are checked out. On a healthy but
 * busy database, queued queries would then fail after DB_CONNECT_TIMEOUT_MS
 * with "timeout exceeded when trying to connect". The queue wait stays
 * unbounded, as it was before this bound existed.
 */
class DeadlineClient extends pg.Client {
  // True after the first connection error while checked out, so that error
  // is logged once.
  private failedInUse = false;

  constructor(config: pg.ClientConfig = {}) {
    super({
      ...config,
      connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
      query_timeout: DB_QUERY_TIMEOUT_MS,
    });
    this.on("error", (err: Error) => this.onInUseError(err));
  }

  /**
   * Handles an error on this connection while a caller has it checked out
   * (pool.connect() or pool.query()), for example when the database resets
   * the socket.
   *
   * pg emits "error" on the client when its socket fails
   * (_handleErrorEvent in pg/lib/client.js). pg-pool listens for it only
   * while the client is idle: it removes its idle listener when it hands the
   * client out and adds it back on release (_acquireClient and _release in
   * pg-pool/index.js). An "error" event with no listener is thrown as an
   * uncaught exception, which would crash the server. This listener is
   * always attached, so that cannot happen.
   *
   * While the client is idle, pg-pool's idle listener handles the error and
   * the pool's "error" listener logs it (onIdleClientError), so this one does
   * nothing. While it is checked out, this one logs once and closes the
   * connection.
   *
   * pg has already failed every query on this connection with the error
   * (_errorAllQueries), so the caller still sees it, and has set
   * `_queryable` to false. end() sets `_ending`, which also stops pg from
   * emitting a second "Connection terminated unexpectedly" error when the
   * socket closes. On release, pg-pool sees either flag and removes the
   * client from the pool (Pool._release), so it is never used again.
   *
   * Logs the host, the port and pg's message only, never the error object
   * or the connection string.
   */
  private onInUseError(err: Error): void {
    if (!checkedOutClients.has(this) || this.failedInUse) return;
    this.failedInUse = true;
    void this.end();
    console.error(
      `[db] Postgres connection to ${this.host}:${this.port} failed while in use: ${err.message}. Closed it; the pool removes it when it is released.`,
    );
  }

  // pg-pool calls connect(callback); other code may await connect(). Both
  // forms pass every result through unchanged, except that pg's bare
  // "timeout expired" is replaced by an error that says where and how long.
  override connect(): Promise<pg.Client>;
  override connect(
    callback: ((err: Error) => void) | ((err: null, c: pg.Client) => void),
  ): void;
  override connect(
    callback?: ((err: Error) => void) | ((err: null, c: pg.Client) => void),
  ): Promise<pg.Client> | void {
    if (!callback) {
      return super.connect().catch((err: unknown) => {
        throw this.describeConnectError(err);
      });
    }
    // The union above is how @types/pg declares the callback. pg calls it as
    // (err) on failure and (null, client) on success.
    const done = callback as (err: Error | null, c?: pg.Client) => void;
    super.connect((err: Error | null, c?: pg.Client) => {
      if (err) done(this.describeConnectError(err));
      else done(null, c);
    });
  }

  // The overloads are the ones @types/pg declares for ClientBase.query.
  override query<T extends pg.Submittable>(queryStream: T): T;
  override query<R extends unknown[] = unknown[], I = unknown[]>(
    queryConfig: pg.QueryArrayConfig<I>,
    values?: pg.QueryConfigValues<I>,
  ): Promise<pg.QueryArrayResult<R>>;
  override query<R extends pg.QueryResultRow = pg.QueryResultRow, I = unknown>(
    queryConfig: pg.QueryConfig<I>,
  ): Promise<pg.QueryResult<R>>;
  override query<
    R extends pg.QueryResultRow = pg.QueryResultRow,
    I = unknown[],
  >(
    queryTextOrConfig: string | pg.QueryConfig<I>,
    values?: pg.QueryConfigValues<I>,
  ): Promise<pg.QueryResult<R>>;
  override query<R extends unknown[] = unknown[], I = unknown[]>(
    queryConfig: pg.QueryArrayConfig<I>,
    callback: (err: Error, result: pg.QueryArrayResult<R>) => void,
  ): void;
  override query<
    R extends pg.QueryResultRow = pg.QueryResultRow,
    I = unknown[],
  >(
    queryTextOrConfig: string | pg.QueryConfig<I>,
    callback: (err: Error, result: pg.QueryResult<R>) => void,
  ): void;
  override query<
    R extends pg.QueryResultRow = pg.QueryResultRow,
    I = unknown[],
  >(
    queryText: string,
    values: pg.QueryConfigValues<I>,
    callback: (err: Error, result: pg.QueryResult<R>) => void,
  ): void;
  /**
   * Runs pg's own query() with the arguments unchanged. pg-pool calls
   * query(text, values, callback); other code awaits query(text, values).
   * Both forms pass every result through unchanged, except a query read
   * timeout: see onQueryError().
   *
   * A Submittable (pg.Query, pg-cursor, pg-query-stream) carries its own
   * callback or events, so it passes through untouched. pg still applies the
   * deadline to it, but this class does not close the connection after it.
   * Nothing in this codebase submits one.
   */
  override query(...args: unknown[]): unknown {
    const [config] = args;
    if (isSubmittable(config)) return Reflect.apply(super.query, this, args);

    const limitMs = this.queryDeadlineMs(config);

    // The callback is the last argument: query(text, callback) or
    // query(text, values, callback).
    const callbackIndex = args.findIndex(
      (arg, i) => i > 0 && isQueryCallback(arg),
    );
    const callback = args[callbackIndex];
    // The pg Query object this call creates. pg can time it out only after
    // query() returns, so it is always set by then.
    let pgQuery: unknown;
    if (isQueryCallback(callback)) {
      args[callbackIndex] = (err: Error | null, result?: unknown) =>
        callback(err ? this.onQueryError(err, limitMs, pgQuery) : err, result);
      const { value, query } = this.enqueue(args);
      pgQuery = query;
      return value;
    }

    const { value: result, query } = this.enqueue(args);
    pgQuery = query;
    if (!(result instanceof Promise)) return result;
    return result.catch((err: unknown) => {
      throw this.onQueryError(err, limitMs, pgQuery);
    });
  }

  /**
   * The deadline in ms that pg sets for a query with this config, so that
   * the timeout error names the real limit. It follows the same steps:
   *
   * - pg takes the query's own query_timeout when it is truthy, else the
   *   client's (`config.query_timeout ||
   *   this.connectionParameters.query_timeout` in Client.prototype.query,
   *   pg/lib/client.js). So a negative value or a numeric string counts.
   * - The client's value is the constructor's DB_QUERY_TIMEOUT_MS, unless
   *   DATABASE_URL has a query_timeout parameter: pg merges the URL
   *   parameters over the constructor config, as strings (`Object.assign({},
   *   config, parse(config.connectionString))` and `val('query_timeout', ...)`
   *   in pg/lib/connection-parameters.js).
   * - pg passes the value to setTimeout(). Node reads it as a number, and
   *   sets any value that is not from 1 to 2^31-1 (negative, too large, not
   *   a number) to 1ms.
   *
   * When the value is falsy (for example an empty query_timeout in the URL),
   * pg sets no timer, so no read timeout can occur and the result is not
   * used.
   */
  private queryDeadlineMs(config: unknown): number {
    const own: unknown =
      typeof config === "object" && config !== null
        ? Reflect.get(config, "query_timeout")
        : undefined;
    const value: unknown =
      own || Reflect.get(this.pgConnectionParameters(), "query_timeout");
    const ms = Number(value);
    return ms >= 1 && ms <= MAX_TIMER_DELAY_MS ? ms : 1;
  }

  // pg's parsed connection settings. @types/pg does not declare them.
  private pgConnectionParameters(): object {
    const params: unknown = Reflect.get(this, "connectionParameters");
    return typeof params === "object" && params !== null ? params : {};
  }

  /**
   * Calls pg's own query() with `args`. Returns what it returned, and the pg
   * Query object it created, so that a read timeout can tell whether that
   * query was on the wire (see onQueryError()).
   *
   * pg pushes the new query onto the end of `_queryQueue`. Then
   * _pulseQueryQueue() moves the head of the queue to `_activeQuery`, but
   * only when the connection is ready for a query: no query is active and
   * the queue was empty (pg/lib/client.js, query() and _pulseQueryQueue()).
   * So the new query is the last one in the queue, or, when the queue did
   * not grow, the new active query. A client that is ending or not
   * queryable queues nothing; the query is then undefined.
   */
  private enqueue(args: unknown[]): { value: unknown; query: unknown } {
    const activeBefore = this.pgActiveQuery();
    const queuedBefore = this.pgQueryQueue().length;
    const value: unknown = Reflect.apply(super.query, this, args);
    const queue = this.pgQueryQueue();
    if (queue.length === queuedBefore + 1) {
      return { value, query: queue[queue.length - 1] };
    }
    const active = this.pgActiveQuery();
    return { value, query: active !== activeBefore ? active : undefined };
  }

  // pg keeps the query on the wire in `_activeQuery` and the queries that
  // wait behind it in `_queryQueue`. @types/pg declares neither, and pg's
  // public getters for them log a deprecation warning, so they are read by
  // name.
  private pgActiveQuery(): unknown {
    return Reflect.get(this, "_activeQuery");
  }

  private pgQueryQueue(): unknown[] {
    const queue: unknown = Reflect.get(this, "_queryQueue");
    return Array.isArray(queue) ? queue : [];
  }

  /**
   * Returns pg's connect-timeout error wrapped in one that names the host,
   * the port and the limit, and logs it. Host and port only, never the
   * connection string or credentials. Any other error is returned unchanged.
   */
  private describeConnectError<E>(err: E): E | Error {
    if (!(err instanceof Error) || err.message !== "timeout expired") {
      return err;
    }
    const message = `Postgres connect to ${this.host}:${this.port} timed out after ${DB_CONNECT_TIMEOUT_MS}ms`;
    console.error(`[db] ${message}`);
    return new Error(message, { cause: err });
  }

  /**
   * Handles pg's query read timeout ("Query read timeout"): logs, and returns
   * an error that names the host, the port and the limit (pg's error stays
   * as `cause`). Host and port only, never the query text, the connection
   * string or credentials. Any other error is returned unchanged.
   *
   * pg's timer for a query starts at the query() call. So it runs while the
   * query waits in this client's queue, and while the query is on the wire.
   * pg handles the two cases differently (pg/lib/client.js, the
   * readTimeoutTimer in query()), and so does this method:
   *
   * - The query is active (`pgQuery` is `_activeQuery`): pg sent it. pg
   *   fails it, but leaves it active on the open connection. Every later
   *   query would queue behind it and time out too. So this method closes
   *   the connection: end() sees the active query and destroys the socket.
   *   It runs before the caller sees the error. When the caller then
   *   releases the client, pg-pool finds it ending (`client._ending` in
   *   Pool._release) and removes it from the pool, even on a release()
   *   without an error.
   * - The query is still in the queue: pg never sent it. pg fails it and
   *   removes it from `_queryQueue` (the splice after "Remove from queue").
   *   The connection and its active query are healthy, so this method does
   *   not close them. A close would fail that active query with pg's bare
   *   "Connection terminated".
   *
   * pg calls the callback form inside the timer, and the promise form one
   * microtask later. In both cases, `_activeQuery` is still the timed-out
   * query if that query was active: pg reads no socket data in between.
   * When `pgQuery` is unknown, the connection is closed, as for an active
   * query.
   */
  private onQueryError<E>(
    err: E,
    limitMs: number,
    pgQuery: unknown,
  ): E | Error {
    if (!(err instanceof Error) || err.message !== "Query read timeout") {
      return err;
    }
    if (pgQuery === undefined || this.pgActiveQuery() === pgQuery) {
      void this.end();
    }
    const message = `Postgres query to ${this.host}:${this.port} timed out after ${limitMs}ms`;
    console.error(`[db] ${message}`);
    return new Error(message, { cause: err });
  }
}

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
    Client: DeadlineClient,
  });
  pool.on("error", onIdleClientError);
  // pg-pool emits "acquire" when it hands a client out and "release" when it
  // takes it back, in the same calls that remove and re-add its idle
  // listener. DeadlineClient uses this set to tell which listener handles an
  // error.
  pool.on("acquire", (client) => checkedOutClients.add(client));
  pool.on("release", (_err, client) => checkedOutClients.delete(client));

  return pool;
}

/**
 * Handles an error on an IDLE pooled connection, for example when the
 * database restarts or the network drops while the client waits in the pool.
 *
 * pg-pool listens for errors on each idle client. On an error it removes
 * that client from the pool and ends it, then emits "error" on the pool
 * (makeIdleListener in pg-pool/index.js). An "error" event with no listener
 * is thrown as an uncaught exception, which would crash the server. This
 * listener only logs: the broken client is already gone. A later query uses
 * another idle client, or opens a new connection if none is idle.
 *
 * Logs the host, the port and pg's message only, never the error object (it
 * carries the client, with the user name) or the connection string.
 */
function onIdleClientError(err: Error, client: pg.PoolClient): void {
  const where =
    client instanceof pg.Client
      ? `${client.host}:${client.port}`
      : "unknown host";
  console.error(
    `[db] Idle Postgres connection to ${where} failed: ${err.message}. Removed it from the pool; a later query opens a new connection if none is idle.`,
  );
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
  // Supported pg.Pool surface: query(text, params?), query({ text, values }),
  // connect() → {query, release}, end().
  // Other pg.Pool methods (e.g. on(), totalCount, idleCount) are NOT implemented —
  // the cast below is intentional since queries.ts only uses the supported subset.
  // PGlite runs in this process and has no query deadline, so a config's
  // query_timeout (see DeadlineQueryConfig) is ignored.
  const query = (textOrConfig: string | pg.QueryConfig, params?: unknown[]) =>
    typeof textOrConfig === "string"
      ? db.query(textOrConfig, params)
      : db.query(textOrConfig.text, textOrConfig.values ?? params);
  const wrapper = {
    query,
    connect: async () => ({
      query,
      release: () => {},
    }),
    end: async () => db.close(),
  };

  pool = wrapper as unknown as pg.Pool;
}

/**
 * Check that the configured embedding dimension matches chunks.embedding.
 *
 * Reads the column's declared size from the catalog, so an empty table is
 * checked too. A `vector` column with no declared size falls back to the
 * dimension of a stored row. The check is skipped when the table does not
 * exist yet (the DDL will create it with the configured size). It is logged
 * as NOT performed when the column is unsized and has no rows with an
 * embedding.
 *
 * Throws on a confirmed mismatch, and when the column is not a `vector` at
 * all, with the recovery steps.
 * Exported for tests.
 */
export async function checkDimensionMismatch(
  p: pg.Pool,
  configuredDimensions: number,
): Promise<void> {
  try {
    const result = await p.query(generateDimensionCheckQuery());
    if (result.rows.length === 0) return;

    const remedy =
      "Switching embedding dimensions requires a full reindex. Drop the old index " +
      "(DROP TABLE chunks, index_state;) and restart pathfinder serve. Startup " +
      `recreates chunks as vector(${configuredDimensions}) and re-indexes every source.`;

    const { type_name, declared_type } = result.rows[0];
    if (type_name !== "vector") {
      // The column cannot hold embeddings, so every upsert and search would
      // fail later. Fail now. The message must contain "dimension mismatch"
      // so the catch below re-throws it.
      console.error(
        `[db] DIMENSION MISMATCH: chunks.embedding has type ${declared_type}, expected vector(${configuredDimensions}). ${remedy}`,
      );
      throw new Error(
        `Embedding dimension mismatch: chunks.embedding has type ${declared_type}, expected vector(${configuredDimensions}). ${remedy}`,
      );
    }

    let dbDimensions: number | null = result.rows[0].dimensions;
    if (dbDimensions == null) {
      const stored = await p.query(generateStoredDimensionQuery());
      if (stored.rows.length === 0) {
        console.warn(
          "[db] Dimension check NOT performed: chunks.embedding has no declared dimension and chunks has no rows with an embedding.",
        );
        return;
      }
      dbDimensions = stored.rows[0].dimensions;
    }

    if (dbDimensions !== configuredDimensions) {
      console.error(
        `[db] DIMENSION MISMATCH: Database has vector(${dbDimensions}) but config specifies dimensions=${configuredDimensions}. ${remedy}`,
      );
      throw new Error(
        `Embedding dimension mismatch: database=${dbDimensions}, config=${configuredDimensions}. ${remedy}`,
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
    // Anything else is unexpected (connection, permissions, a broken query).
    // Startup continues, but say clearly that no check ran.
    console.warn(
      `[db] Dimension check NOT performed: ${error instanceof Error ? error.message : String(error)}`,
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

  // Schema statements can build indexes on a full table or wait for a lock,
  // so each gets DB_MAINTENANCE_QUERY_TIMEOUT_MS, not the request-path default.
  // That includes BEGIN, COMMIT and ROLLBACK: COMMIT ends a transaction that
  // holds the schema DDL, and none of them is a request-path query.
  const schemaQuery = (text: string): DeadlineQueryConfig => ({
    text,
    query_timeout: DB_MAINTENANCE_QUERY_TIMEOUT_MS,
  });

  // Ensure the vector extension exists before registering types
  const setupClient = await p.connect();
  try {
    // Requires superuser or pg_extension_owner — works with the default Docker image
    // but will fail on locked-down setups (e.g. RDS) without explicit grants
    await setupClient.query(
      schemaQuery("CREATE EXTENSION IF NOT EXISTS vector"),
    );
    await pgvector.registerType(setupClient);
  } finally {
    setupClient.release();
  }

  // Run migration + schema creation atomically
  const migrationClient = await p.connect();
  // Set when ROLLBACK fails. Releasing with an error makes pg-pool destroy
  // the client instead of reusing it.
  let releaseError: Error | undefined;
  try {
    await migrationClient.query(schemaQuery("BEGIN"));
    await migrationClient.query(schemaQuery(generateMigration()));
    await migrationClient.query(schemaQuery(generateSchema(dimensions)));
    await migrationClient.query(schemaQuery(generatePostSchemaMigration()));
    await migrationClient.query(schemaQuery("COMMIT"));
  } catch (err) {
    // ROLLBACK fails, for example, on a client that a query timeout closed.
    // The original error is more useful, so it is the one rethrown.
    try {
      await migrationClient.query(schemaQuery("ROLLBACK"));
    } catch (rollbackError: unknown) {
      releaseError =
        rollbackError instanceof Error
          ? rollbackError
          : new Error(String(rollbackError));
      console.error(
        `[db] Schema transaction ROLLBACK failed: ${releaseError.message}. ` +
          `Releasing the client with this error; the original error is rethrown.`,
      );
    }
    throw err;
  } finally {
    migrationClient.release(releaseError);
  }

  // Apply tsvector trigger DDL outside the transaction (idempotent)
  const triggerClient = await p.connect();
  try {
    await triggerClient.query(schemaQuery(generateTsvTriggerDdl()));
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
