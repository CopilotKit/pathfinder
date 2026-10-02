// Boot the real app in-process for route-level tests.
//
// The helper calls startServer({ port: 0 }), so the OS picks a free port, and
// reads the port back from the bound server's address. It resolves once the
// server is listening. It rejects on the server's first "error" event, and on
// any other failure after startServer() returns. On those failures it calls
// stop() and then rethrows the failure. If stop() also rejects, it throws an
// AggregateError of [failure, stop error] with the failure as its cause. It
// does not intercept process.exit: the server's own "error" handler still
// runs shutdown(), which ends the process. With port 0, a bind conflict is
// not a realistic case.
//
// stop() is StartedServer.stop(). It closes this listener and its
// connections, writes out the pending unknown-session 404 counts, clears the
// module's session reaper and telemetry flush intervals, and removes the
// SIGINT/SIGTERM listeners that this boot added. It does not exit the
// process. It does NOT close the DB pool, live MCP transports or the
// nightly-reindex interval, and it does not unmount the routes that
// startServer() added to the module-level app.
//
// That module state is shared by every boot in the module instance. Run one
// in-process server at a time per test file, and stop it before the file
// boots another.
//
// The calling test file must vi.mock src/config.js before this runs, the same
// way it would for a direct startServer() call. From a test file in
// src/__tests__/, that path is "../config.js" (vi.mock paths are relative to
// the file that calls vi.mock, not to this helper).
import { once } from "node:events";
import { startServer } from "../../server.js";

export interface InProcessServer {
  baseUrl: string;
  stop(): Promise<void>;
}

export async function startInProcessServer(): Promise<InProcessServer> {
  const started = await startServer({ port: 0 });
  try {
    if (!started.server.listening) await once(started.server, "listening");
    const address = started.server.address();
    if (address === null || typeof address === "string") {
      throw new Error(`expected a TCP address, got ${String(address)}`);
    }
    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      stop: () => started.stop(),
    };
  } catch (err) {
    try {
      await started.stop();
    } catch (stopErr) {
      // Keep the original failure: it is the root cause.
      throw new AggregateError(
        [err, stopErr],
        "startInProcessServer failed, and stop() also failed",
        { cause: err },
      );
    }
    throw err;
  }
}
