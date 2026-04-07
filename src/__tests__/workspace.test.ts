import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { WorkspaceManager } from '../workspace.js';

describe('WorkspaceManager', () => {
    let baseDir: string;
    let mgr: WorkspaceManager;

    beforeEach(() => {
        baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-workspace-'));
        mgr = new WorkspaceManager(baseDir, 1024); // 1KB max per session
    });

    afterEach(() => {
        fs.rmSync(baseDir, { recursive: true, force: true });
    });

    it('creates session workspace directory', () => {
        mgr.ensureSession('sess-1');
        expect(fs.existsSync(path.join(baseDir, 'sess-1'))).toBe(true);
    });

    it('writes file to session workspace', () => {
        mgr.ensureSession('sess-1');
        const ok = mgr.writeFile('sess-1', 'notes.md', '# Notes\nHello');
        expect(ok).toBe(true);
        const content = fs.readFileSync(path.join(baseDir, 'sess-1', 'notes.md'), 'utf-8');
        expect(content).toBe('# Notes\nHello');
    });

    it('reads file from session workspace', () => {
        mgr.ensureSession('sess-1');
        mgr.writeFile('sess-1', 'test.txt', 'hello');
        expect(mgr.readFile('sess-1', 'test.txt')).toBe('hello');
    });

    it('rejects writes exceeding size budget', () => {
        mgr.ensureSession('sess-1');
        const bigContent = 'x'.repeat(2048); // 2KB > 1KB limit
        const ok = mgr.writeFile('sess-1', 'big.txt', bigContent);
        expect(ok).toBe(false);
    });

    it('cleans up session workspace', () => {
        mgr.ensureSession('sess-1');
        mgr.writeFile('sess-1', 'test.txt', 'hello');
        mgr.cleanup('sess-1');
        expect(fs.existsSync(path.join(baseDir, 'sess-1'))).toBe(false);
    });

    it('cleanupAll removes all workspaces', () => {
        mgr.ensureSession('sess-1');
        mgr.ensureSession('sess-2');
        mgr.cleanupAll();
        expect(fs.readdirSync(baseDir)).toHaveLength(0);
    });

    it('lists files in session workspace', () => {
        mgr.ensureSession('sess-1');
        mgr.writeFile('sess-1', 'a.txt', 'a');
        mgr.writeFile('sess-1', 'b.txt', 'b');
        expect(mgr.listFiles('sess-1').sort()).toEqual(['a.txt', 'b.txt']);
    });

    it('rejects path traversal in writeFile', () => {
        mgr.ensureSession('sess-1');
        const ok = mgr.writeFile('sess-1', '../escape.txt', 'pwned');
        expect(ok).toBe(false);
        // Verify file was NOT created outside session dir
        expect(fs.existsSync(path.join(baseDir, 'escape.txt'))).toBe(false);
    });

    it('rejects path traversal in readFile', () => {
        mgr.ensureSession('sess-1');
        mgr.ensureSession('sess-2');
        mgr.writeFile('sess-2', 'secret.txt', 'sensitive');
        // Try to read another session's file via traversal
        const result = mgr.readFile('sess-1', '../sess-2/secret.txt');
        expect(result).toBeNull();
    });

    it('rejects deeply nested path traversal', () => {
        mgr.ensureSession('sess-1');
        const ok = mgr.writeFile('sess-1', 'subdir/../../../etc/passwd', 'pwned');
        expect(ok).toBe(false);
    });
});
