/**
 * R3 #3 — logs that currently render only `err.message` must render the full
 * error (with stack) so operators can correlate failures to code lines during
 * incident triage. The helper exported here is the single canonical place
 * that formats an unknown error for a server-side log line.
 */
import { describe, it, expect } from "vitest";
import { formatErrorForLog } from "../server.js";

describe("formatErrorForLog (R3 #3)", () => {
  it("includes the stack trace when the error is an Error instance", () => {
    const err = new Error("boom");
    const out = formatErrorForLog(err);
    expect(out).toContain("boom");
    // Stack always includes the error message + the function frame; match
    // on the "at " prefix that Node's V8 stack traces use so we're not
    // coupling to a specific frame path.
    expect(out).toMatch(/\n\s+at\s/);
  });

  it("falls back to String(err) when the value has no stack", () => {
    expect(formatErrorForLog("plain string")).toBe("plain string");
    expect(formatErrorForLog(42)).toBe("42");
    expect(formatErrorForLog(null)).toBe("null");
  });

  it("handles Error-like objects without a stack property", () => {
    // e.g. thrown object literals { message: "..." }
    const errLike = { message: "custom" };
    const out = formatErrorForLog(errLike);
    // We don't promise a specific format here — just that the message
    // content survives into the log line.
    expect(out).toContain("custom");
  });

  it("preserves the message even when stack is present", () => {
    const err = new Error("very specific message");
    const out = formatErrorForLog(err);
    expect(out).toContain("very specific message");
  });
});
