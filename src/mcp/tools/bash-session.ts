import path from "node:path";

export class BashSessionState {
  private cwd: string = "/";

  getCwd(): string {
    return this.cwd;
  }

  setCwd(dir: string): void {
    this.cwd = dir === "/" ? "/" : dir.replace(/\/+$/, "");
  }

  resolvePath(target: string): string {
    const resolved = target.startsWith("/")
      ? path.posix.normalize(target)
      : path.posix.normalize(path.posix.join(this.cwd, target));
    return resolved === "/" ? "/" : resolved.replace(/\/+$/, "");
  }
}

export class SessionStateManager {
  private sessions = new Map<string, BashSessionState>();

  getOrCreate(sessionId: string): BashSessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = new BashSessionState();
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  cleanup(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  cleanupAll(): void {
    this.sessions.clear();
  }

  get size(): number {
    return this.sessions.size;
  }
}

const DEFAULT_WORKSPACE_MAX_BYTES = 1024 * 1024; // 1MB

export class WorkspaceTracker {
  private usedBytes = 0;
  private maxBytes: number;

  constructor(maxBytes: number = DEFAULT_WORKSPACE_MAX_BYTES) {
    this.maxBytes = maxBytes;
  }

  getUsedBytes(): number {
    return this.usedBytes;
  }

  getMaxBytes(): number {
    return this.maxBytes;
  }

  trackWrite(bytes: number): boolean {
    if (this.usedBytes + bytes > this.maxBytes) return false;
    this.usedBytes += bytes;
    return true;
  }

  reset(): void {
    this.usedBytes = 0;
  }
}
