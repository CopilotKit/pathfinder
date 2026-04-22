/**
 * R4-5 — the 503 body emitted on handleSessionInitAccept rollback must
 * carry a `reason:` discriminant (workspace_init_failed / state_init_failed
 * / ip_limit_rollback) so clients and monitoring can tell the three
 * failure modes apart. Additionally, the full error (stack) must be
 * logged server-side, not just err.message.
 */
import { describe, it, expect, vi } from "vitest";

describe("handleSessionInitAccept 503 reason + full-error logging (R4-5)", () => {
  it("rollback body carries reason=workspace_init_failed", async () => {
    const { handleSessionInitAccept } = await import("../server.js");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const bodies: unknown[] = [];
      const boomed = new Error("disk full stack included");
      const res = {
        headersSent: false,
        status: () => ({
          json: (b: unknown) => {
            bodies.push(b);
            return {};
          },
        }),
      };
      const accepted = handleSessionInitAccept({
        transport: { close: () => {} },
        sid: "sid-test-xxxxxxxx",
        ip: "127.0.0.1",
        transports: {},
        sessionLastActivity: {},
        workspaceManager: {
          ensureSession: () => {
            throw boomed;
          },
        },
        res,
      });
      expect(accepted).toBe(false);
      expect(bodies).toHaveLength(1);
      const body = bodies[0] as {
        jsonrpc: string;
        error: { code: number; message: string; data?: { reason?: string } };
      };
      expect(body.error?.data?.reason).toBe("workspace_init_failed");
      // Full Error instance (stack-bearing) must be in the server log, not
      // just the stringified message.
      const sawErrorObj = errSpy.mock.calls.some((args) =>
        args.some((a) => a instanceof Error && a.message === boomed.message),
      );
      expect(sawErrorObj).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("SSE sseGet ensureSession rollback reason (R4-5)", () => {
  it("503 body uses reason=workspace_init_failed discriminant", async () => {
    const { createSseHandlers } = await import("../sse-handlers.js");
    const workspaceManager = {
      ensureSession: () => {
        throw new Error("ws-throw");
      },
      cleanup: () => {},
    };
    const sseTransports: Record<string, unknown> = {};
    const sessionLastActivity: Record<string, number> = {};
    const { getHandler } = createSseHandlers({
      sseTransports: sseTransports as never,
      sessionLastActivity,
      ipLimiter: undefined,
      workspaceManager,
      createMcpServer: () => ({}) as never,
    });
    // Drive the sseGet handler; the handler factory returns
    // [bearerMiddleware, sseGet]. Invoke the sseGet tail directly.
    const sseGet = getHandler[getHandler.length - 1];
    const captured: unknown[] = [];
    const res: Record<string, unknown> = {
      headersSent: false,
      destroyed: false,
      writableEnded: false,
      setHeader: () => {},
      on: () => {},
      status: (_c: number) => ({
        json: (b: unknown) => {
          captured.push(b);
          return {};
        },
      }),
    };
    const req = {
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    } as never;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await (sseGet as unknown as (req: never, res: never) => Promise<void>)(
        req,
        res as never,
      );
    } finally {
      errSpy.mockRestore();
    }
    // Should have captured a 503 body with reason discriminant.
    const gotReason = captured.some(
      (b) =>
        !!b &&
        typeof b === "object" &&
        (b as { reason?: string }).reason === "workspace_init_failed",
    );
    expect(gotReason).toBe(true);
  });
});
