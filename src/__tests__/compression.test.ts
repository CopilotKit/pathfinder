import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import compression from "compression";
import http from "node:http";
import zlib from "node:zlib";

// ---------------------------------------------------------------------------
// Verify that the compression middleware compresses HTTP responses when the
// client sends an Accept-Encoding header.  We spin up a minimal Express app
// (same pattern as health-endpoint.test.ts) rather than importing the full
// Pathfinder server, which pulls in DB drivers and config.
// ---------------------------------------------------------------------------

function request(
  server: http.Server,
  path: string,
  acceptEncoding: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; raw: Buffer }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method: "GET",
        headers: { "Accept-Encoding": acceptEncoding },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            raw: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("compression middleware", () => {
  let server: http.Server;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // Build a payload large enough that compression kicks in (the default
  // threshold is 1 KB).
  const LARGE_BODY = "A".repeat(2048);

  function startApp(): Promise<void> {
    return new Promise((resolve) => {
      const app = express();
      app.use(compression());
      app.get("/test", (_req, res) => {
        res.type("text/plain").send(LARGE_BODY);
      });
      server = app.listen(0, () => resolve());
    });
  }

  it("returns Content-Encoding: gzip when client accepts gzip", async () => {
    await startApp();
    const res = await request(server, "/test", "gzip");

    expect(res.headers["content-encoding"]).toBe("gzip");

    // Decompress and verify the body round-trips correctly.
    const decompressed = zlib.gunzipSync(res.raw).toString();
    expect(decompressed).toBe(LARGE_BODY);
  });

  it("returns Content-Encoding: deflate when client accepts deflate", async () => {
    await startApp();
    const res = await request(server, "/test", "deflate");

    expect(res.headers["content-encoding"]).toBe("deflate");
  });

  it("returns uncompressed when no Accept-Encoding is sent", async () => {
    await startApp();
    // Pass an encoding the middleware won't act on.
    const res = await request(server, "/test", "identity");

    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.raw.toString()).toBe(LARGE_BODY);
  });
});

// ---------------------------------------------------------------------------
// Verify that the production server.ts wires compression correctly by
// checking the import is present (static analysis guard).
// ---------------------------------------------------------------------------

describe("server.ts wiring", () => {
  it("imports and uses the compression middleware", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const serverSrc = fs.readFileSync(
      path.resolve(import.meta.dirname, "..", "server.ts"),
      "utf-8",
    );

    expect(serverSrc).toContain('import compression from "compression"');
    expect(serverSrc).toContain("app.use(compression())");
  });
});
