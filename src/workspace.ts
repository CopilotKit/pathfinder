import fs from 'fs';
import path from 'path';
import { WorkspaceTracker } from './mcp/tools/bash-session.js';

export class WorkspaceManager {
    private baseDir: string;
    private maxBytesPerSession: number;
    private trackers = new Map<string, WorkspaceTracker>();

    constructor(baseDir: string, maxBytesPerSession: number = 1024 * 1024) {
        this.baseDir = baseDir;
        this.maxBytesPerSession = maxBytesPerSession;
        fs.mkdirSync(baseDir, { recursive: true });
    }

    ensureSession(sessionId: string): string {
        const dir = path.join(this.baseDir, sessionId);
        fs.mkdirSync(dir, { recursive: true });
        if (!this.trackers.has(sessionId)) {
            this.trackers.set(sessionId, new WorkspaceTracker(this.maxBytesPerSession));
        }
        return dir;
    }

    writeFile(sessionId: string, filename: string, content: string): boolean {
        const tracker = this.trackers.get(sessionId);
        if (!tracker) return false;
        const bytes = Buffer.byteLength(content, 'utf-8');
        if (!tracker.trackWrite(bytes)) return false;
        const filePath = path.join(this.baseDir, sessionId, filename);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, 'utf-8');
        return true;
    }

    readFile(sessionId: string, filename: string): string | null {
        const filePath = path.join(this.baseDir, sessionId, filename);
        if (!fs.existsSync(filePath)) return null;
        return fs.readFileSync(filePath, 'utf-8');
    }

    listFiles(sessionId: string): string[] {
        const dir = path.join(this.baseDir, sessionId);
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir);
    }

    cleanup(sessionId: string): void {
        const dir = path.join(this.baseDir, sessionId);
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        this.trackers.delete(sessionId);
    }

    cleanupAll(): void {
        for (const entry of fs.readdirSync(this.baseDir)) {
            fs.rmSync(path.join(this.baseDir, entry), { recursive: true, force: true });
        }
        this.trackers.clear();
    }
}
