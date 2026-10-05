/**
 * Global in-flight ceiling for modern (2026-07-28, stateless) requests.
 *
 * tryAcquire() returns an idempotent release function, or null when the
 * ceiling is reached. Callers must invoke the release exactly when the
 * request finishes; extra calls are no-ops.
 */
export class InflightCeiling {
  private count = 0;

  constructor(private readonly max: number) {}

  tryAcquire(): (() => void) | null {
    if (this.count >= this.max) return null;
    this.count++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.count--;
    };
  }

  get inflight(): number {
    return this.count;
  }
}
