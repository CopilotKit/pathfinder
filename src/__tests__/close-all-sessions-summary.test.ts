/**
 * R3 #12 — closeAllSessions must emit a summary log that includes BOTH the
 * count of rejected close() calls and the sid label of each failing
 * transport so operators see which transport misbehaved during shutdown.
 */
import { describe, it, expect, vi } from "vitest";

describe("closeAllSessions rejection summary (R3 #12)", () => {
  it("emits a summary with the rejection count for each map", async () => {
    const { closeAllSessions } = await import("../server.js");
    const errLogs: unknown[][] = [];
    const logLogs: unknown[][] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...a) => {
      errLogs.push(a);
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation((...a) => {
      logLogs.push(a);
    });
    try {
      const transports = {
        "s-good": { close: async () => {} },
        "s-bad-1": {
          close: async () => {
            throw new Error("boom-s-1");
          },
        },
        "s-bad-2": {
          close: async () => {
            throw new Error("boom-s-2");
          },
        },
      };
      const sseTransports = {
        "e-bad": {
          close: async () => {
            throw new Error("boom-e");
          },
        },
      };
      await closeAllSessions({
        transports: transports as unknown as Parameters<
          typeof closeAllSessions
        >[0]["transports"],
        sseTransports: sseTransports as unknown as Parameters<
          typeof closeAllSessions
        >[0]["sseTransports"],
      });
      const allArgs = [...errLogs, ...logLogs].flat();
      // Summary must explicitly include a rejection count.
      const hasStreamableSummary = allArgs.some(
        (a) =>
          typeof a === "string" &&
          /2 of 3.*reject|2.*rejected|streamable.*2/i.test(a),
      );
      expect(hasStreamableSummary).toBe(true);
      const hasSseSummary = allArgs.some(
        (a) =>
          typeof a === "string" && /1 of 1.*reject|1.*rejected|sse.*1/i.test(a),
      );
      expect(hasSseSummary).toBe(true);
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("still emits existing per-sid error logs for each rejection", async () => {
    const { closeAllSessions } = await import("../server.js");
    const errLogs: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => {
      errLogs.push(a);
    });
    try {
      const transports = {
        "s-bad": {
          close: async () => {
            throw new Error("boom");
          },
        },
      };
      await closeAllSessions({
        transports: transports as unknown as Parameters<
          typeof closeAllSessions
        >[0]["transports"],
        sseTransports: {} as unknown as Parameters<
          typeof closeAllSessions
        >[0]["sseTransports"],
      });
      const sawSidLog = errLogs.some((args) =>
        args.some((a) => typeof a === "string" && a.includes("s-bad")),
      );
      expect(sawSidLog).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not emit a summary with rejection>0 when every close succeeds", async () => {
    const { closeAllSessions } = await import("../server.js");
    const logs: unknown[][] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => {
      logs.push(a);
    });
    try {
      const transports = { "s-ok": { close: async () => {} } };
      await closeAllSessions({
        transports: transports as unknown as Parameters<
          typeof closeAllSessions
        >[0]["transports"],
        sseTransports: {} as unknown as Parameters<
          typeof closeAllSessions
        >[0]["sseTransports"],
      });
      const sawRejectionCount = logs
        .flat()
        .some(
          (a) => typeof a === "string" && / 1.*rejected|rejected: 1/.test(a),
        );
      expect(sawRejectionCount).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
