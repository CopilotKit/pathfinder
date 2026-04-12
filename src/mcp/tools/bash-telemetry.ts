export interface TelemetryEvent {
  type: "file_access" | "grep_miss" | "command";
  timestamp: string;
  path?: string;
  pattern?: string;
  command?: string;
}

type InsertFn = (
  toolName: string,
  data: Record<string, unknown>,
) => Promise<void>;

const MAX_BUFFER_SIZE = 10000;

export class BashTelemetry {
  private events: TelemetryEvent[] = [];
  private insertFn: InsertFn;

  constructor(insertFn: InsertFn) {
    this.insertFn = insertFn;
  }

  private addEvent(event: TelemetryEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_BUFFER_SIZE) {
      const dropped = this.events.length - MAX_BUFFER_SIZE;
      this.events = this.events.slice(dropped);
      console.warn(
        `[bash-telemetry] Buffer overflow: dropped ${dropped} oldest events`,
      );
    }
  }

  recordFileAccess(path: string, command: string): void {
    this.addEvent({
      type: "file_access",
      timestamp: new Date().toISOString(),
      path,
      command,
    });
  }

  recordGrepMiss(pattern: string, command: string): void {
    this.addEvent({
      type: "grep_miss",
      timestamp: new Date().toISOString(),
      pattern,
      command,
    });
  }

  recordCommand(command: string): void {
    this.addEvent({
      type: "command",
      timestamp: new Date().toISOString(),
      command,
    });
  }

  getEvents(): TelemetryEvent[] {
    return [...this.events];
  }

  getStats(): {
    totalCommands: number;
    fileAccesses: number;
    grepMisses: number;
  } {
    let fileAccesses = 0;
    let grepMisses = 0;
    for (const e of this.events) {
      if (e.type === "file_access") fileAccesses++;
      if (e.type === "grep_miss") grepMisses++;
    }
    return { totalCommands: this.events.length, fileAccesses, grepMisses };
  }

  async flush(): Promise<void> {
    if (this.events.length === 0) return;
    const batch = [...this.events];
    this.events = [];
    try {
      await this.insertFn("_telemetry", {
        events: batch,
        flushed_at: new Date().toISOString(),
      });
    } catch (err) {
      this.events.unshift(...batch);
      console.error(
        "[bash-telemetry] Flush failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
