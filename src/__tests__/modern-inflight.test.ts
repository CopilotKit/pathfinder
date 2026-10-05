import { describe, it, expect } from "vitest";
import { InflightCeiling } from "../modern-inflight.js";

describe("InflightCeiling", () => {
  it("grants up to max slots and then returns null", () => {
    const c = new InflightCeiling(2);
    expect(c.tryAcquire()).toBeTypeOf("function");
    expect(c.tryAcquire()).toBeTypeOf("function");
    expect(c.tryAcquire()).toBeNull();
    expect(c.inflight).toBe(2);
  });

  it("frees a slot on release", () => {
    const c = new InflightCeiling(2);
    const a = c.tryAcquire();
    c.tryAcquire();
    expect(c.tryAcquire()).toBeNull();
    a?.();
    expect(c.inflight).toBe(1);
    expect(c.tryAcquire()).toBeTypeOf("function");
    expect(c.inflight).toBe(2);
  });

  it("double release neither goes below 0 nor frees two slots", () => {
    const c = new InflightCeiling(2);
    const a = c.tryAcquire();
    c.tryAcquire();
    a?.();
    a?.();
    expect(c.inflight).toBe(1);
    const only = new InflightCeiling(1);
    const r = only.tryAcquire();
    r?.();
    r?.();
    expect(only.inflight).toBe(0);
    expect(only.tryAcquire()).toBeTypeOf("function");
    expect(only.tryAcquire()).toBeNull();
  });

  it("inflight reports the count", () => {
    const c = new InflightCeiling(3);
    expect(c.inflight).toBe(0);
    c.tryAcquire();
    expect(c.inflight).toBe(1);
  });
});
