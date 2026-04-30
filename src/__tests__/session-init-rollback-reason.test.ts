/**
 * Session hardening: handleSessionInitAccept no longer calls ensureSession
 * (lazy workspace allocation). These tests verify the new behavior.
 */
import { describe, it, expect, vi } from "vitest";

describe("handleSessionInitAccept (lazy workspace — no ensureSession)", () => {
  it("does not call ensureSession, always returns true", async () => {
    const { handleSessionInitAccept } = await import("../server.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const ensureCalls: string[] = [];
      const accepted = handleSessionInitAccept({
        transport: { close: () => {} },
        sid: "sid-test-xxxxxxxx",
        ip: "127.0.0.1",
        transports: { "sid-test-xxxxxxxx": {} },
        sessionLastActivity: { "sid-test-xxxxxxxx": Date.now() },
        workspaceManager: {
          ensureSession: (s: string) => {
            ensureCalls.push(s);
          },
        },
      });
      expect(accepted).toBe(true);
      expect(ensureCalls).toEqual([]);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("SSE sseGet (lazy workspace — no ensureSession)", () => {
  it("does not call ensureSession, proceeds to connect", async () => {
    const { createSseHandlers } = await import("../sse-handlers.js");
    const ensureCalls: string[] = [];
    const workspaceManager = {
      ensureSession: (s: string) => {
        ensureCalls.push(s);
      },
      cleanup: () => {},
    };
    const sseTransports: Record<string, unknown> = {};
    const sessionLastActivity: Record<string, number> = {};
    const connectCalls: unknown[] = [];
    const mockMcpServer = {
      connect: async (t: unknown) => {
        connectCalls.push(t);
      },
    };
    const { getHandler } = createSseHandlers({
      sseTransports: sseTransports as never,
      sessionLastActivity,
      ipLimiter: undefined,
      workspaceManager,
      createMcpServer: () => mockMcpServer as never,
    });
    // Drive the sseGet handler; the handler factory returns
    // [bearerMiddleware, sseGet]. Invoke the sseGet tail directly.
    const sseGet = getHandler[getHandler.length - 1];
    const res: Record<string, unknown> = {
      headersSent: false,
      destroyed: false,
      writableEnded: false,
      setHeader: () => {},
      on: () => {},
      status: (_c: number) => ({
        json: () => ({}),
      }),
    };
    const req = {
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    } as never;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await (sseGet as unknown as (req: never, res: never) => Promise<void>)(
        req,
        res as never,
      );
    } finally {
      logSpy.mockRestore();
    }
    // ensureSession should NOT have been called
    expect(ensureCalls).toEqual([]);
    // But server.connect should have been called
    expect(connectCalls.length).toBe(1);
  });
});
