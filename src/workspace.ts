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
        try {
            fs.mkdirSync(baseDir, { recursive: true });
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            console.error(`[workspace] Failed to create base directory ${baseDir}: ${detail}`);
            throw new Error(`WorkspaceManager: cannot create base directory: ${detail}`);
        }
    }

    ensureSession(sessionId: string): string {
        const dir = path.join(this.baseDir, sessionId);
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            console.error(`[workspace] Failed to create session directory ${dir}: ${detail}`);
            throw new Error(`WorkspaceManager: cannot create session directory: ${detail}`);
        }
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
        const sessionDir = path.resolve(this.baseDir, sessionId);
        if (!path.resolve(filePath).startsWith(sessionDir + path.sep) && path.resolve(filePath) !== sessionDir) {
            return false;
        }

        try {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, content, 'utf-8');
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            console.error(`[workspace] Failed to write file ${filePath}: ${detail}`);
            return false;
        }
        return true;
    }

    readFile(sessionId: string, filename: string): string | null {
        const filePath = path.join(this.baseDir, sessionId, filename);
        const sessionDir = path.resolve(this.baseDir, sessionId);
        if (!path.resolve(filePath).startsWith(sessionDir + path.sep) && path.resolve(filePath) !== sessionDir) {
            return null;
        }

        try {
            return fs.readFileSync(filePath, 'utf-8');
        } catch {
            return null;
        }
    }

    listFiles(sessionId: string, subdir?: string): string[] {
        let dir = path.join(this.baseDir, sessionId);
        if (subdir) {
            dir = path.join(dir, subdir);
            const sessionDir = path.resolve(this.baseDir, sessionId);
            if (!path.resolve(dir).startsWith(sessionDir + path.sep) && path.resolve(dir) !== sessionDir) {
                return [];
            }
        }
        try {
            return fs.readdirSync(dir);
        } catch {
            return [];
        }
    }

    cleanup(sessionId: string): void {
        const dir = path.join(this.baseDir, sessionId);
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            console.error(`[workspace] Failed to cleanup session ${sessionId}: ${detail}`);
        }
        this.trackers.delete(sessionId);
    }

    cleanupAll(): void {
        let entries: string[];
        try {
            entries = fs.readdirSync(this.baseDir);
        } catch {
            entries = [];
        }
        for (const entry of entries) {
            try {
                fs.rmSync(path.join(this.baseDir, entry), { recursive: true, force: true });
            } catch (err) {
                const detail = err instanceof Error ? err.message : String(err);
                console.error(`[workspace] Failed to cleanup entry ${entry}: ${detail}`);
            }
        }
        this.trackers.clear();
    }
}
