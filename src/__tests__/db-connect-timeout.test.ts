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
import { inspect } from "node:util";
import pg from "pg";

// Every socket the test servers and the proxy open, so teardown can destroy
// the ones that are still open.
const sockets = new Set<net.Socket>();

// Records a socket for teardown. Every socket gets an "error" listener: an
// error event with no listener (for example a reset from the other end)
// crashes the test worker. The error is logged with the socket's label, so
// the cause shows in the test output.
function trackSocket(socket: net.Socket, label: string): void {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", (err) => {
    console.warn(`[test] ${label} socket error: ${err.message}`);
  });
}

// A TCP listener that accepts connections and never answers. pg sends its
// startup packet and waits for a reply that never comes, which is how a
// frozen database host looks from the client. The TCP connect succeeds, so
// the OS connect timeout never applies. TCP keepAlive would not end the wait
// either: the local kernel ACKs every keepalive probe for this listener, as
// the kernel of a frozen host does. Only pg's connect timeout ends it.
// Without that timeout the query waits forever.
const silentServer = net.createServer((socket) => {
  trackSocket(socket, "silent server");
});

let databaseUrl = "";

vi.mock("../config.js", () => ({
  getConfig: () => ({ databaseUrl }),
  getServerConfig: () => ({ embedding: { dimensions: 3 } }),
}));

const { getPool, closePool, DB_CONNECT_TIMEOUT_MS } =
  await import("../db/client.js");

// Every timing below is derived from the real DB_CONNECT_TIMEOUT_MS, so a
// change to the constant moves the waits, deadlines and test timeouts with it.
// Extra time allowed on a slow CI host before a deadline counts as a failure.
const SLOW_HOST_MARGIN_MS = 3_000;
// Node can fire a timer about 1ms before its delay when measured with
// Date.now(), from clock rounding. Lower bounds on elapsed time subtract
// this margin so that correct code does not fail on that rounding.
const TIMER_EARLY_MARGIN_MS = 100;
// How far past the connect timeout the queue test waits. It must stay above
// the connect timeout, so that a pool-level queue bound set to the same value
// fails the queued query before the wait ends.
const QUEUE_WAIT_MS = DB_CONNECT_TIMEOUT_MS + 2_000;
// Vitest timeout for each test in this file: the longest wait in a test
// plus a wide margin.
vi.setConfig({ testTimeout: DB_CONNECT_TIMEOUT_MS + 15_000 });

// Tests restore their own spies right after the query, so a failed assertion
// still prints. If a test throws before that restore, this hook restores the
// spies, so a mocked console.error or pg connect does not leak into later
// tests and hide their output.
afterEach(() => {
  vi.restoreAllMocks();
});

// Closes the pool and the test servers within a fixed time. pg-pool's
// end() waits until every client is gone, so the pool is closed first (idle
// clients end cleanly) and the sockets are destroyed next: a client that is
// still connecting to a listener that never answers then fails and leaves
// the pool. If the pool still does not close, the hook fails with an error
// that says so, not with a hook timeout that hides the test's own failure.
async function closePoolAndServers(...servers: net.Server[]): Promise<void> {
  const closing = Promise.all([
    closePool(),
    ...servers
      .filter((server) => server.listening)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  ]);
  for (const socket of sockets) socket.destroy();
  let deadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      closing,
      new Promise((_, reject) => {
        deadline = setTimeout(
          () =>
            reject(
              new Error(
                `teardown did not finish within ${SLOW_HOST_MARGIN_MS}ms: a pool client or a test server is still open`,
              ),
            ),
          SLOW_HOST_MARGIN_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

describe("database pool connect timeout", () => {
  // A user name and a password that appear nowhere else in the log line or
  // in the error and its stack (file paths, pg messages). A leak check that
  // finds them has found the credentials.
  const DB_USER = "leakprobe_user_k4";
  const DB_PASSWORD = "leakprobe_pw_7Qz";

  beforeAll(async () => {
    await new Promise<void>((resolve) =>
      silentServer.listen(0, "127.0.0.1", resolve),
    );
    const { port } = silentServer.address() as net.AddressInfo;
    databaseUrl = `postgres://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${port}/db`;
  });

  afterAll(async () => {
    await closePoolAndServers(silentServer);
  });

  it("fails a query fast when the database never answers", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const started = Date.now();
    const error = await getPool()
      .query("SELECT 1")
      .then(
        () => null,
        (err: unknown) => err,
      );
    const elapsed = Date.now() - started;
    const loggedLines = logged.mock.calls.map((args) => args.join(" "));
    const loggedArgs = logged.mock.calls.map((args) =>
      args.map((arg) => inspect(arg, { depth: null })).join(" "),
    );
    logged.mockRestore();

    // The error names the host, the port and the limit, so a log line alone
    // says which database did not answer.
    const { port } = silentServer.address() as net.AddressInfo;
    const expected = `Postgres connect to 127.0.0.1:${port} timed out after ${DB_CONNECT_TIMEOUT_MS}ms`;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(expected);
    // "timeout expired" is pg's own connect-timeout error, kept as the cause.
    // If the bound moves back to the pool options, pg-pool's own timer ends
    // this in-flight connect first and fails it with "Connection terminated
    // due to connection timeout", so these checks fail.
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).message).toBe("timeout expired");
    // Logged once with the same text.
    expect(loggedLines).toEqual([`[db] ${expected}`]);
    // The exact matches above pin the two messages only. The user name, the
    // password and the connection string must also be absent from the rest
    // of the error (its stack, its own properties, the whole cause chain)
    // and from every logged argument.
    const surfaces = {
      error: inspect(error, { depth: null }),
      logged: loggedArgs.join("\n"),
    };
    for (const [surface, text] of Object.entries(surfaces)) {
      for (const secret of [databaseUrl, DB_USER, DB_PASSWORD]) {
        expect(text, `${surface} contains ${secret}`).not.toContain(secret);
      }
    }
    // Node does not run a timer before its delay, except for about 1ms of
    // clock rounding, so the failure cannot come much before the timeout.
    // The 100ms margin covers that rounding. A timeout set too short, or a
    // failure that does not wait for the timeout, is below it.
    expect(elapsed).toBeGreaterThanOrEqual(
      DB_CONNECT_TIMEOUT_MS - TIMER_EARLY_MARGIN_MS,
    );
    // The upper margin covers a slow CI host.
    expect(elapsed).toBeLessThan(DB_CONNECT_TIMEOUT_MS + SLOW_HOST_MARGIN_MS);
  });
});

// Only pg's "timeout expired" is wrapped and logged. Any other connect error
// must reach the caller as pg produced it, with no [db] log line. The
// listener stays bound for the whole test, so no other process can take its
// port. It reads pg's startup packet and then ends the connection cleanly
// (FIN, not a reset: the packet is already read). pg then fails the connect
// at once with its own "Connection terminated unexpectedly".
describe("database pool connect error other than a timeout", () => {
  const hangupServer = net.createServer((socket) => {
    trackSocket(socket, "hangup server");
    socket.once("data", () => socket.end());
  });

  beforeAll(async () => {
    await closePool();
    await new Promise<void>((resolve) =>
      hangupServer.listen(0, "127.0.0.1", resolve),
    );
    const { port } = hangupServer.address() as net.AddressInfo;
    databaseUrl = `postgres://user:pass@127.0.0.1:${port}/db`;
  });

  afterAll(async () => {
    await closePoolAndServers(hangupServer);
  });

  it("passes a dropped connect through unchanged and does not log it", async () => {
    const pool = getPool();
    // Records each error that pg's own Client.connect() hands back, so the
    // test can check that the caller gets that same object. pg-pool replaces
    // the stack of a rejected query, so the stack cannot show where the
    // error was made.
    const pgErrors: Error[] = [];
    const pgConnect = pg.Client.prototype.connect;
    const connectSpy = vi
      .spyOn(pg.Client.prototype, "connect")
      .mockImplementation(function (this: pg.Client, callback) {
        const done = callback as (err: Error | null, c?: pg.Client) => void;
        pgConnect.call(this, (err: Error | null, c?: pg.Client) => {
          if (err) pgErrors.push(err);
          done(err, c);
        });
      });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const started = Date.now();
    const error = await pool.query("SELECT 1").then(
      () => null,
      (err: unknown) => err,
    );
    const elapsed = Date.now() - started;
    const loggedLines = logged.mock.calls.map((args) => args.join(" "));
    logged.mockRestore();
    connectSpy.mockRestore();

    // The caller gets the very error object pg made, with pg's message and
    // no cause: not a wrapper made in src/db/client.ts.
    expect(pgErrors).toHaveLength(1);
    expect(error).toBe(pgErrors[0]);
    expect((error as Error).message).toBe("Connection terminated unexpectedly");
    expect((error as Error).cause).toBeUndefined();
    // No [db] line: only the connect timeout is logged.
    expect(loggedLines.filter((line) => line.startsWith("[db]"))).toEqual([]);
    // The hangup fails the connect at once, far inside the connect timeout.
    expect(elapsed).toBeLessThan(DB_CONNECT_TIMEOUT_MS);
    // The failed client is gone from the pool.
    expect(pool.totalCount).toBe(0);
    expect(pool.idleCount).toBe(0);
    expect(pool.waitingCount).toBe(0);
  });
});

// A minimal Postgres wire-protocol server: it accepts any startup message
// with AuthenticationOk + ReadyForQuery and answers every simple query with an
// empty CommandComplete. That is enough for real pg clients to connect and run
// queries, so the pool below is the real pg-pool with real pg Clients over TCP.
// Set PATHFINDER_TEST_PG_URL to use a real Postgres in its place. That
// variable affects two tests: the queue-wait test below connects to it
// directly, and the recovery test uses it as the upstream behind its proxy.
function startMinimalPostgres(): net.Server {
  const message = (type: string, body: Buffer): Buffer => {
    const header = Buffer.alloc(5);
    header.write(type, 0, "latin1");
    header.writeInt32BE(body.length + 4, 1);
    return Buffer.concat([header, body]);
  };
  const authOk = message("R", Buffer.from([0, 0, 0, 0]));
  const readyForQuery = message("Z", Buffer.from("I", "latin1"));
  const selectDone = message("C", Buffer.from("SELECT 0\0", "latin1"));

  return net.createServer((socket) => {
    trackSocket(socket, "minimal Postgres");
    let pending = Buffer.alloc(0);
    let started = false;
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        if (!started) {
          if (pending.length < 4) return;
          const length = pending.readInt32BE(0);
          if (pending.length < length) return;
          pending = pending.subarray(length);
          started = true;
          socket.write(Buffer.concat([authOk, readyForQuery]));
          continue;
        }
        if (pending.length < 5) return;
        const type = String.fromCharCode(pending[0]);
        const length = pending.readInt32BE(1);
        if (pending.length < 1 + length) return;
        pending = pending.subarray(1 + length);
        if (type === "Q")
          socket.write(Buffer.concat([selectDone, readyForQuery]));
        if (type === "X") socket.end();
      }
    });
  });
}

describe("database pool queue wait under load", () => {
  const healthyServer = startMinimalPostgres();

  beforeAll(async () => {
    await closePool();
    const realUrl = process.env.PATHFINDER_TEST_PG_URL;
    if (realUrl) {
      databaseUrl = realUrl;
      return;
    }
    await new Promise<void>((resolve) =>
      healthyServer.listen(0, "127.0.0.1", resolve),
    );
    const { port } = healthyServer.address() as net.AddressInfo;
    databaseUrl = `postgres://user:pass@127.0.0.1:${port}/db`;
  });

  afterAll(async () => {
    await closePoolAndServers(healthyServer);
  });

  it("keeps a query queued past the connect timeout while every client is busy", async () => {
    const pool = getPool();
    const max = pool.options.max;
    // allSettled, so a failed connect still leaves the clients that did
    // connect in the list, where the finally block below releases them.
    const connects = await Promise.allSettled(
      Array.from({ length: max }, () => pool.connect()),
    );
    const busy = connects.flatMap((c) =>
      c.status === "fulfilled" ? [c.value] : [],
    );
    const released = new Set<pg.PoolClient>();
    const release = (client: pg.PoolClient): void => {
      if (released.has(client)) return;
      released.add(client);
      client.release();
    };
    // Every checked-out client is released even when an assertion fails.
    // pg-pool's end() waits for checked-out clients, so one left out would
    // make teardown wait forever and hide the failure behind a hook timeout.
    try {
      const failed = connects.find((c) => c.status === "rejected");
      if (failed) throw failed.reason;
      expect(pool.totalCount).toBe(max);

      // Wait past the connect timeout (QUEUE_WAIT_MS) with all clients
      // checked out: the queued query must still be waiting, not failed.
      const started = Date.now();
      let outcome:
        { rows: unknown[] } | { error: unknown; afterMs: number } | null = null;
      const queued = pool.query("SELECT 1").then(
        (result) => (outcome = { rows: result.rows }),
        (error: unknown) =>
          (outcome = { error, afterMs: Date.now() - started }),
      );
      await new Promise((resolve) => setTimeout(resolve, QUEUE_WAIT_MS));
      const waitedMs = Date.now() - started;

      expect(outcome).toBeNull();
      expect(pool.waitingCount).toBe(1);
      // The margin covers timer rounding (see TIMER_EARLY_MARGIN_MS). The wait
      // still ends well past the connect timeout, so a pool-level queue bound
      // at that timeout has already failed the queued query.
      expect(waitedMs).toBeGreaterThanOrEqual(
        QUEUE_WAIT_MS - TIMER_EARLY_MARGIN_MS,
      );

      // A client comes free: the queued query now runs and succeeds.
      release(busy[0]);
      await queued;
      expect(outcome).not.toBeNull();
      expect(outcome).not.toHaveProperty("error");
      expect(outcome).toHaveProperty("rows");
    } finally {
      for (const client of busy) release(client);
    }
  });
});

// One fixed address whose behavior the test switches. While `answering` is
// false it accepts connections and never replies, like the silent server
// above. Once `answering` is true it pipes each new connection to a healthy
// upstream: the minimal Postgres server, or the real Postgres named by
// PATHFINDER_TEST_PG_URL. The pool only ever sees this address, so the
// recovery happens on the same host and port that timed out.
describe("database pool recovery after a connect timeout", () => {
  const upstreamServer = startMinimalPostgres();
  let answering = false;
  let upstream = { host: "127.0.0.1", port: 0 };
  // Errors from the upstream connection. The proxy cannot pass them to the
  // pg client, which only sees its own socket close, so they are kept here
  // and added to the phase 2 failure message.
  const upstreamErrors: string[] = [];
  const switchServer = net.createServer((socket) => {
    trackSocket(socket, "switch server");
    if (!answering) return;
    const upstreamSocket = net.connect(upstream.port, upstream.host);
    trackSocket(upstreamSocket, "proxy upstream");
    upstreamSocket.on("error", (err) => {
      upstreamErrors.push(
        `upstream ${upstream.host}:${upstream.port}: ${err.message}`,
      );
      socket.destroy();
    });
    socket.on("error", () => upstreamSocket.destroy());
    socket.pipe(upstreamSocket).pipe(socket);
  });

  beforeAll(async () => {
    await closePool();
    const realUrl = process.env.PATHFINDER_TEST_PG_URL;
    let target: URL;
    if (realUrl) {
      target = new URL(realUrl);
      upstream = { host: target.hostname, port: Number(target.port || 5432) };
    } else {
      await new Promise<void>((resolve) =>
        upstreamServer.listen(0, "127.0.0.1", resolve),
      );
      const { port } = upstreamServer.address() as net.AddressInfo;
      upstream = { host: "127.0.0.1", port };
      target = new URL(`postgres://user:pass@127.0.0.1:${port}/db`);
    }
    await new Promise<void>((resolve) =>
      switchServer.listen(0, "127.0.0.1", resolve),
    );
    const { port } = switchServer.address() as net.AddressInfo;
    target.hostname = "127.0.0.1";
    target.port = String(port);
    databaseUrl = target.toString();
  });

  afterAll(async () => {
    await closePoolAndServers(switchServer, upstreamServer);
  });

  it("drops the timed-out client and serves the next query once the host answers", async () => {
    const pool = getPool();

    // Phase 1: the host never answers, so the new connection times out. The
    // deadline turns a query that never settles (a client stuck in the pool)
    // into a clear failure instead of a test timeout.
    let deadline: NodeJS.Timeout | undefined;
    const error = await Promise.race([
      pool.query("SELECT 1").then(
        () => null,
        (err: unknown) => err,
      ),
      new Promise((resolve) => {
        deadline = setTimeout(
          () => resolve("query did not settle"),
          DB_CONNECT_TIMEOUT_MS + SLOW_HOST_MARGIN_MS,
        );
      }),
    ]);
    clearTimeout(deadline);
    expect(error).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).message).toBe("timeout expired");

    // The dead client must be gone: no slot is held by it, nothing idles,
    // nothing waits.
    expect(pool.totalCount).toBe(0);
    expect(pool.idleCount).toBe(0);
    expect(pool.waitingCount).toBe(0);

    // Phase 2: the same address answers again. A query on the SAME pool must
    // open a fresh connection and succeed, well inside the connect timeout.
    answering = true;
    const started = Date.now();
    const result = await pool.query("SELECT 1").catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const upstreamCause = upstreamErrors.join("; ") || "none";
      throw new Error(
        `phase 2 query failed: ${message} (proxy upstream errors: ${upstreamCause})`,
        { cause: err },
      );
    });
    expect(Date.now() - started).toBeLessThan(DB_CONNECT_TIMEOUT_MS);
    expect(result.command).toBe("SELECT");

    // Exactly one client exists, it is the healthy one, and it is back in the
    // idle list. A ghost client left over from phase 1 would make totalCount
    // larger than idleCount.
    expect(pool.totalCount).toBe(1);
    expect(pool.idleCount).toBe(pool.totalCount);
    expect(pool.waitingCount).toBe(0);
  });
});
