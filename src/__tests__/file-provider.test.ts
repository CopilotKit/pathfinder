import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileDataProvider } from '../indexing/providers/file.js';
import type { SourceConfig } from '../types.js';

describe('FileDataProvider', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fp-test-'));
        await fs.promises.writeFile(path.join(tmpDir, 'readme.md'), '# Hello\nWorld');
        await fs.promises.writeFile(path.join(tmpDir, 'guide.md'), '# Guide\nContent here');
        await fs.promises.writeFile(path.join(tmpDir, 'style.css'), 'body { color: red; }');
        await fs.promises.mkdir(path.join(tmpDir, 'sub'), { recursive: true });
        await fs.promises.writeFile(path.join(tmpDir, 'sub', 'nested.md'), '# Nested');
    });

    afterEach(async () => {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
    });

    function makeConfig(overrides?: Partial<SourceConfig>): SourceConfig {
        return {
            name: 'test',
            type: 'markdown',
            path: tmpDir,
            file_patterns: ['**/*.md'],
            chunk: { target_tokens: 600, overlap_tokens: 50 },
            ...overrides,
        };
    }

    it('fullAcquire returns matching files as ContentItems', async () => {
        const provider = new FileDataProvider(makeConfig(), { cloneDir: '/tmp/test-clones' });
        const result = await provider.fullAcquire();
        expect(result.items.length).toBe(3);
        expect(result.removedIds).toEqual([]);
        expect(result.stateToken).toMatch(/^local-/);
        const ids = result.items.map(i => i.id).sort();
        expect(ids).toContain('readme.md');
        expect(ids).toContain('guide.md');
        expect(ids).toContain('sub/nested.md');
        const readme = result.items.find(i => i.id === 'readme.md');
        expect(readme?.content).toBe('# Hello\nWorld');
    });

    it('fullAcquire excludes non-matching patterns', async () => {
        const provider = new FileDataProvider(makeConfig(), { cloneDir: '/tmp/test-clones' });
        const result = await provider.fullAcquire();
        const ids = result.items.map(i => i.id);
        expect(ids).not.toContain('style.css');
    });

    it('fullAcquire filters out low-semantic-value content', async () => {
        const svgContent = 'M0,0 L100,100 C50,50 200.5,300.7 '.repeat(100);
        await fs.promises.writeFile(path.join(tmpDir, 'data.md'), svgContent);
        const provider = new FileDataProvider(makeConfig(), { cloneDir: '/tmp/test-clones' });
        const result = await provider.fullAcquire();
        const ids = result.items.map(i => i.id);
        expect(ids).not.toContain('data.md');
    });

    it('getCurrentStateToken returns local hash for local sources', async () => {
        const provider = new FileDataProvider(makeConfig(), { cloneDir: '/tmp/test-clones' });
        const token = await provider.getCurrentStateToken();
        expect(token).toMatch(/^local-/);
    });

    it('getCurrentStateToken returns null when path does not exist', async () => {
        const provider = new FileDataProvider(
            makeConfig({ path: '/nonexistent/path' }),
            { cloneDir: '/tmp/test-clones' },
        );
        const token = await provider.getCurrentStateToken();
        expect(token).toBeNull();
    });

    it('incrementalAcquire falls back to fullAcquire for local sources', async () => {
        const provider = new FileDataProvider(makeConfig(), { cloneDir: '/tmp/test-clones' });
        const result = await provider.incrementalAcquire('old-token');
        expect(result.items.length).toBe(3);
    });
});
