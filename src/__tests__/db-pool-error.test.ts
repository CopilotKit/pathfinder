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

// Every socket the test server opens, in the order it accepted them, so a
// test can reset one from the server side and teardown can destroy the
// ones that are still open.
const sockets: net.Socket[] = [];
// The socket that received the most recent query.
let lastQuerySocket: net.Socket | null = null;

// A minimal Postgres wire-protocol server: it accepts any startup message
// with AuthenticationOk + ReadyForQuery and answers every simple query with
// an empty CommandComplete, except a query whose text contains "hang": that
// one gets a TCP reset instead of an answer, so the reset lands while the
// query is in flight. That is enough for real pg clients to connect and
// run queries, so the pool below is the real pg-pool with real pg Clients
// over TCP.
const fakePostgres = net.createServer((socket) => {
  sockets.push(socket);
  // An error event with no listener (for example a reset from the other
  // end) crashes the test worker.
  socket.on("error", (err) => {
    console.warn(`[test] fake Postgres socket error: ${err.message}`);
  });
  const message = (type: string, body: Buffer): Buffer => {
    const header = Buffer.alloc(5);
    header.write(type, 0, "latin1");
    header.writeInt32BE(body.length + 4, 1);
    return Buffer.concat([header, body]);
  };
  const authOk = message("R", Buffer.from([0, 0, 0, 0]));
  const readyForQuery = message("Z", Buffer.from("I", "latin1"));
  const selectDone = message("C", Buffer.from("SELECT 0\0", "latin1"));

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
      const body = pending.subarray(5, 1 + length).toString("utf8");
      pending = pending.subarray(1 + length);
      if (type === "Q") {
        lastQuerySocket = socket;
        if (body.includes("hang")) {
          socket.resetAndDestroy();
          return;
        }
        socket.write(Buffer.concat([selectDone, readyForQuery]));
      }
      if (type === "X") socket.end();
    }
  });
});

let databaseUrl = "";

vi.mock("../config.js", () => ({
  getConfig: () => ({ databaseUrl }),
  getServerConfig: () => ({ embedding: { dimensions: 3 } }),
}));

const { getPool, closePool } = await import("../db/client.js");

// Upper bound for the pool to drop the reset client. The reset reaches the
// client over loopback within milliseconds.
const REMOVE_WAIT_MS = 3_000;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("database pool connection errors", () => {
  // A user name and a password that appear nowhere else in the log line. A
  // leak check that finds them has found the credentials.
  const DB_USER = "leakprobe_user_k4";
  const DB_PASSWORD = "leakprobe_pw_7Qz";

  beforeAll(async () => {
    await new Promise<void>((resolve) =>
      fakePostgres.listen(0, "127.0.0.1", resolve),
    );
    const { port } = fakePostgres.address() as net.AddressInfo;
    databaseUrl = `postgres://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${port}/db`;
  });

  afterAll(async () => {
    const closing = Promise.all([
      closePool(),
      new Promise<void>((resolve) => fakePostgres.close(() => resolve())),
    ]);
    for (const socket of sockets) socket.destroy();
    await closing;
  });

  it("attaches an error listener to the real pool", () => {
    // pg-pool emits "error" on the pool when an idle client fails. With no
    // listener, Node throws it as an uncaught exception.
    expect(getPool().listenerCount("error")).toBeGreaterThanOrEqual(1);
  });

  it("logs a server reset of an idle client once, drops it, and serves the next query", async () => {
    const pool = getPool();
    await pool.query("SELECT 1");
    // The client is back in the pool, idle, on the one server connection.
    expect(pool.totalCount).toBe(1);
    expect(pool.idleCount).toBe(1);
    expect(sockets).toHaveLength(1);

    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // pg-pool emits "remove" once it has ended the broken client. A plain
    // listener, not events.once(): that one also listens for "error" and
    // would hide a missing pool listener.
    const removed = new Promise<"removed" | "not removed">((resolve) => {
      const timer = setTimeout(() => resolve("not removed"), REMOVE_WAIT_MS);
      pool.once("remove", () => {
        clearTimeout(timer);
        resolve("removed");
      });
    });
    // The database drops the idle connection: a TCP reset from the server.
    sockets[0].resetAndDestroy();
    expect(await removed).toBe("removed");
    const loggedLines = logged.mock.calls.map((args) => args.join(" "));
    const loggedArgs = logged.mock.calls
      .map((args) => args.map((arg) => inspect(arg, { depth: null })).join(" "))
      .join("\n");
    logged.mockRestore();

    // Logged once, with the host, the port and pg's message.
    const { port } = fakePostgres.address() as net.AddressInfo;
    expect(loggedLines).toEqual([
      `[db] Idle Postgres connection to 127.0.0.1:${port} failed: read ECONNRESET. Removed it from the pool; a later query opens a new connection if none is idle.`,
    ]);
    // No credentials and no connection string in anything logged.
    for (const secret of [databaseUrl, DB_USER, DB_PASSWORD]) {
      expect(loggedArgs, `log contains ${secret}`).not.toContain(secret);
    }
    // The broken client is gone from the pool.
    expect(pool.totalCount).toBe(0);
    expect(pool.idleCount).toBe(0);

    // The next query opens a new connection and succeeds.
    const result = await pool.query("SELECT 1");
    expect(result.command).toBe("SELECT");
    expect(pool.totalCount).toBe(1);
    expect(sockets).toHaveLength(2);
  });

  describe("on a checked-out client", () => {
    // pg-pool removes its idle listener while a caller has the client, so
    // only DeadlineClient's own listener stands between a socket error and
    // an uncaught exception.

    // Resolves "done" once `emitter` emits `event`, or "timed out".
    const waitFor = (
      emitter: { once(event: string, listener: () => void): unknown },
      event: string,
    ): Promise<"done" | "timed out"> =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve("timed out"), REMOVE_WAIT_MS);
        emitter.once(event, () => {
          clearTimeout(timer);
          resolve("done");
        });
      });

    // Starts capturing console.error. stop() returns the logged lines and
    // checks that nothing logged holds the credentials or the URL.
    const captureErrors = () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      return {
        stop(): string[] {
          const lines = logged.mock.calls.map((args) => args.join(" "));
          const allArgs = logged.mock.calls
            .map((args) =>
              args.map((arg) => inspect(arg, { depth: null })).join(" "),
            )
            .join("\n");
          logged.mockRestore();
          for (const secret of [databaseUrl, DB_USER, DB_PASSWORD]) {
            expect(allArgs, `log contains ${secret}`).not.toContain(secret);
          }
          return lines;
        },
      };
    };

    const inUseLine = (): string => {
      const { port } = fakePostgres.address() as net.AddressInfo;
      return `[db] Postgres connection to 127.0.0.1:${port} failed while in use: read ECONNRESET. Closed it; the pool removes it when it is released.`;
    };

    it("logs a server reset once, closes the client, and the pool drops it on release", async () => {
      const pool = getPool();
      const client = await pool.connect();
      await client.query("SELECT 1");
      const socket = lastQuerySocket;
      expect(socket).not.toBeNull();

      const errors = captureErrors();
      const ended = waitFor(client, "end");
      // The database drops the connection while the caller still holds it.
      socket?.resetAndDestroy();
      expect(await ended).toBe("done");
      expect(errors.stop()).toEqual([inUseLine()]);

      // A plain release, with no error: pg-pool must still see the client
      // as broken and remove it instead of keeping it idle.
      const removed = waitFor(pool, "remove");
      client.release();
      expect(await removed).toBe("done");
      expect(pool.totalCount).toBe(0);
      expect(pool.idleCount).toBe(0);

      const result = await pool.query("SELECT 1");
      expect(result.command).toBe("SELECT");
    });

    it("fails a query in flight with the reset, logs once, and the pool drops the client on release", async () => {
      const pool = getPool();
      const client = await pool.connect();

      const errors = captureErrors();
      const ended = waitFor(client, "end");
      // The server resets the socket instead of answering this query.
      await expect(client.query("SELECT 'hang'")).rejects.toThrow(
        "read ECONNRESET",
      );
      expect(await ended).toBe("done");
      expect(errors.stop()).toEqual([inUseLine()]);

      const removed = waitFor(pool, "remove");
      client.release();
      expect(await removed).toBe("done");
      expect(pool.totalCount).toBe(0);
      expect(pool.idleCount).toBe(0);

      const result = await pool.query("SELECT 1");
      expect(result.command).toBe("SELECT");
    });

    it("fails a pool.query() in flight with the reset, logs once, and drops the client", async () => {
      const pool = getPool();
      const errors = captureErrors();
      const removed = waitFor(pool, "remove");
      await expect(pool.query("SELECT 'hang'")).rejects.toThrow(
        "read ECONNRESET",
      );
      expect(await removed).toBe("done");
      expect(errors.stop()).toEqual([inUseLine()]);
      expect(pool.totalCount).toBe(0);

      const result = await pool.query("SELECT 1");
      expect(result.command).toBe("SELECT");
    });
  });
});
