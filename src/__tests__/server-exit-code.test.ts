// Process exit codes of the real server entry point (src/index.ts), run as a
// subprocess. Railway's restart policy is ON_FAILURE (railway.toml), so a
// listen failure that exits 0 is never restarted: the service stays down.
// A listen error must therefore exit non-zero, while a normal SIGTERM
// shutdown must still exit 0.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The tsx loader runs inside the server process itself (`node --import`),
// so there is one process per test. The `tsx` CLI would add a parent
// process, and killing only that parent would leave the server running.
const tsxLoader = new URL(
  "../../node_modules/tsx/dist/esm/index.mjs",
  import.meta.url,
).href;
const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
const docs = fileURLToPath(
  new URL("../../fixtures/breeze-api/docs", import.meta.url),
);
// The file src/db/client.ts loads with `import("@electric-sql/pglite")`. The
// preload below patches this same module instance.
const pgliteUrl = new URL(
  "../../node_modules/@electric-sql/pglite/dist/index.js",
  import.meta.url,
).href;

// Bash-only tools: no search tool, so startup skips indexing and never calls
// the embedding provider. Without `withDb` there is no DB at all. `withDb`
// adds a collect tool, which makes startup open the (PGlite) DB pool, so
// shutdown has a pool to close. Only then does the embedding block matter:
// schema initialization needs its `dimensions`. Its base_url is a closed
// port.
function config(withDb: boolean): string {
  const collect = withDb
    ? `  - name: feedback
    type: collect
    description: "Submit feedback."
    response: "Recorded."
    schema:
      rating:
        type: string
        description: "Rating"
        required: true
`
    : "";
  return `server:
  name: exit-code-test
  version: "1.0.0"
sources:
  - name: docs
    type: markdown
    path: ${docs}
    file_patterns:
      - "**/*.md"
    chunk:
      target_tokens: 600
      overlap_tokens: 50
tools:
  - name: explore-docs
    type: bash
    description: "Explore docs."
    sources:
      - docs
${collect}embedding:
  provider: ollama
  model: nomic-embed-text
  dimensions: 768
  base_url: http://127.0.0.1:9
`;
}

// A preload that slows down or hangs the DB pool close inside shutdown.
// "hang" also holds a timer, as an open socket would, so the event loop
// cannot drain and end the process on its own.
function closePreload(mode: { delayMs: number } | "hang"): string {
  const body =
    mode === "hang"
      ? "return new Promise(() => { setInterval(() => {}, 1 << 30); });"
      : `return new Promise((r) => setTimeout(r, ${mode.delayMs})).then(() => original.call(this));`;
  return `import { PGlite } from ${JSON.stringify(pgliteUrl)};
const original = PGlite.prototype.close;
PGlite.prototype.close = function () {
  ${body}
};
`;
}

// A preload that makes an early shutdown step throw: the flush of the
// unknown-session 404 count (it logs with console.warn). It also reports
// when the DB pool close runs after that throw, which shows that the later
// cleanup steps still ran.
const flushThrowPreload = `import { PGlite } from ${JSON.stringify(pgliteUrl)};
let threw = false;
const warn = console.warn;
console.warn = function (...args) {
  if (String(args[0]).startsWith("[mcp] 404 unknown-session-id")) {
    threw = true;
    throw new Error("injected flush failure");
  }
  return warn.apply(this, args);
};
const original = PGlite.prototype.close;
PGlite.prototype.close = function () {
  if (threw) console.log("[preload] pool close ran after the flush failure");
  return original.call(this);
};
`;

let dir: string;
let child: ChildProcess | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pathfinder-exit-code-"));
});

afterEach(() => {
  // The server runs in its own process group (detached), so this kills it and
  // anything it started, and nothing outside this test.
  if (child?.pid !== undefined && child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group is already gone.
    }
  }
  child = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function startServer(
  port: number,
  opts: { withDb?: boolean; preload?: string } = {},
): {
  proc: ChildProcess;
  exited: Promise<number | null>;
  output: () => string;
  waitForOutput: (text: string) => Promise<void>;
} {
  writeFileSync(join(dir, "pathfinder.yaml"), config(opts.withDb ?? false));
  // Always pass a preload, so that the command line names the per-test
  // directory (a unique marker for finding leftover processes).
  const preloadPath = join(dir, "preload.mjs");
  writeFileSync(preloadPath, opts.preload ?? "");
  const proc = spawn(
    process.execPath,
    ["--import", tsxLoader, "--import", pathToFileURL(preloadPath).href, entry],
    {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PORT: String(port),
        DATABASE_URL: `pglite://${join(dir, "db")}`,
        PATHFINDER_CONFIG: join(dir, "pathfinder.yaml"),
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  child = proc;
  let out = "";
  proc.stdout?.on("data", (c: Buffer) => (out += c.toString()));
  proc.stderr?.on("data", (c: Buffer) => (out += c.toString()));
  let closed = false;
  const exited = new Promise<number | null>((done) =>
    proc.on("close", (code) => {
      closed = true;
      done(code);
    }),
  );
  const waitForOutput = async (text: string): Promise<void> => {
    const deadline = Date.now() + 60_000;
    while (!out.includes(text)) {
      if (closed || Date.now() > deadline) {
        throw new Error(`never saw ${JSON.stringify(text)}; output:\n${out}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return { proc, exited, output: () => out, waitForOutput };
}

function listenOnFreePort(): Promise<Server> {
  return new Promise((done, fail) => {
    const holder = createServer();
    holder.once("error", fail);
    holder.listen(0, () => done(holder));
  });
}

async function freePort(): Promise<number> {
  const probe = await listenOnFreePort();
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

async function withHeldPort(
  run: (port: number) => Promise<void>,
): Promise<void> {
  const holder = await listenOnFreePort();
  const { port } = holder.address() as AddressInfo;
  try {
    await run(port);
  } finally {
    await new Promise<void>((done) => holder.close(() => done()));
  }
}

async function waitForHealthy(
  port: number,
  proc: ChildProcess,
  output: () => string,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  let healthy = false;
  while (!healthy && Date.now() < deadline && proc.exitCode === null) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      healthy = res.ok;
    } catch {
      // Not listening yet.
    }
    if (!healthy) await new Promise((r) => setTimeout(r, 250));
  }
  expect(healthy, output()).toBe(true);
}

describe("server process exit code", () => {
  it("exits non-zero when the port is already in use", async () => {
    await withHeldPort(async (port) => {
      const { exited, output } = startServer(port);
      const code = await exited;
      expect(output()).toContain(`[startup] Port ${port} is already in use`);
      expect(output()).toContain("Received server-error:EADDRINUSE");
      // Express 5 calls the listen callback on an error too; no success
      // banner may print for a server that never bound its port.
      expect(output()).not.toContain("Running at");
      expect(code, output()).toBe(1);
    });
  }, 90_000);

  it("forces exit 1 at once when a SIGTERM arrives during the listen-error shutdown", async () => {
    await withHeldPort(async (port) => {
      // Slow the pool close so the SIGTERM lands while shutdown is running.
      const { proc, exited, output, waitForOutput } = startServer(port, {
        withDb: true,
        preload: closePreload({ delayMs: 5_000 }),
      });
      await waitForOutput("Received server-error:EADDRINUSE");
      const signalled = Date.now();
      proc.kill("SIGTERM");
      const code = await exited;
      expect(output()).toContain(
        "[shutdown] Received SIGTERM during shutdown, forcing exit 1",
      );
      expect(code, output()).toBe(1);
      // At once: well before the delayed pool close would finish.
      expect(Date.now() - signalled, output()).toBeLessThan(3_000);
    });
  }, 90_000);

  it("forces exit 1 when a cleanup step never settles", async () => {
    await withHeldPort(async (port) => {
      const { exited, output, waitForOutput } = startServer(port, {
        withDb: true,
        preload: closePreload("hang"),
      });
      await waitForOutput("Received server-error:EADDRINUSE");
      const started = Date.now();
      const code = await exited;
      const elapsed = Date.now() - started;
      expect(output()).toContain(
        "[shutdown] Cleanup exceeded 8000ms, forcing exit 1",
      );
      expect(code, output()).toBe(1);
      // The 8s deadline plus slack for a loaded CI host.
      expect(elapsed, output()).toBeLessThan(15_000);
    });
  }, 90_000);

  it("forces exit 1, not 0, when a SIGTERM shutdown never settles", async () => {
    const port = await freePort();
    const { proc, exited, output } = startServer(port, {
      withDb: true,
      preload: closePreload("hang"),
    });
    await waitForHealthy(port, proc, output);
    const signalled = Date.now();
    proc.kill("SIGTERM");
    const code = await exited;
    const elapsed = Date.now() - signalled;
    expect(output()).toContain(
      "[shutdown] Cleanup exceeded 8000ms, forcing exit 1",
    );
    expect(code, output()).toBe(1);
    // The log line and the lower bound prove the 8s deadline fired (not an
    // outside kill). Railway sends SIGKILL 10s after the SIGTERM; the 8s
    // SHUTDOWN_DEADLINE_MS keeps us inside it. The parent wall clock adds
    // signal delivery, exit and pipe teardown on a loaded CI host, so the
    // upper bound only catches a deadline that is grossly late, not one
    // that is late by a few hundred ms.
    expect(elapsed, output()).toBeGreaterThanOrEqual(7_500);
    expect(elapsed, output()).toBeLessThan(12_000);
  }, 90_000);

  it("exits at once with the first code on a second SIGINT", async () => {
    const port = await freePort();
    const { proc, exited, output, waitForOutput } = startServer(port, {
      withDb: true,
      preload: closePreload("hang"),
    });
    await waitForHealthy(port, proc, output);
    proc.kill("SIGINT");
    await waitForOutput("[shutdown] Received SIGINT, shutting down");
    const signalled = Date.now();
    proc.kill("SIGINT");
    const code = await exited;
    expect(output()).toContain(
      "[shutdown] Received SIGINT during shutdown, forcing exit 0",
    );
    expect(output()).not.toContain("Cleanup exceeded");
    expect(code, output()).toBe(0);
    expect(Date.now() - signalled, output()).toBeLessThan(3_000);
  }, 90_000);

  it("logs a failed shutdown step, runs the rest of the cleanup, and exits 1", async () => {
    const port = await freePort();
    const { proc, exited, output } = startServer(port, {
      withDb: true,
      preload: flushThrowPreload,
    });
    await waitForHealthy(port, proc, output);
    // Count one unknown-session 404, so that shutdown has a count to flush.
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      headers: {
        "Mcp-Session-Id": "no-such-session",
        Accept: "text/event-stream",
      },
    });
    expect(res.status).toBe(404);
    proc.kill("SIGTERM");
    const code = await exited;
    expect(output()).toContain(
      "[shutdown] Unknown-session 404 count flush failed: Error: injected flush failure",
    );
    expect(output()).toContain(
      "[preload] pool close ran after the flush failure",
    );
    expect(code, output()).toBe(1);
  }, 90_000);

  it("exits 0 on a SIGTERM shutdown", async () => {
    const port = await freePort();
    const { proc, exited, output } = startServer(port);
    await waitForHealthy(port, proc, output);
    proc.kill("SIGTERM");
    const code = await exited;
    expect(output()).toContain("Received SIGTERM");
    expect(code, output()).toBe(0);
  }, 90_000);
});
