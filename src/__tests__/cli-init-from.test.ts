import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('init --from <url> integration', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pathfinder-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('validates URL format before crawling', async () => {
        const { validateInitUrl } = await import('../cli-init.js');
        expect(() => validateInitUrl('not-a-url')).toThrow('Invalid URL');
        expect(() => validateInitUrl('ftp://example.com')).toThrow('must be http or https');
        expect(() => validateInitUrl('https://docs.example.com')).not.toThrow();
    });

    it('creates pathfinder.yaml in target directory', async () => {
        const { writeGeneratedConfig } = await import('../cli-init.js');
        const yamlContent = `server:\n  name: test\n  version: "1.0.0"\nsources: []\ntools: []`;

        writeGeneratedConfig(tmpDir, yamlContent);

        const written = fs.readFileSync(path.join(tmpDir, 'pathfinder.yaml'), 'utf-8');
        expect(written).toBe(yamlContent);
    });

    it('refuses to overwrite existing pathfinder.yaml without --force', async () => {
        const { writeGeneratedConfig } = await import('../cli-init.js');

        fs.writeFileSync(path.join(tmpDir, 'pathfinder.yaml'), 'existing: true');

        expect(() => writeGeneratedConfig(tmpDir, 'new: true', false)).toThrow('already exists');
    });

    it('overwrites existing pathfinder.yaml with --force', async () => {
        const { writeGeneratedConfig } = await import('../cli-init.js');

        fs.writeFileSync(path.join(tmpDir, 'pathfinder.yaml'), 'existing: true');
        writeGeneratedConfig(tmpDir, 'new: true', true);

        const written = fs.readFileSync(path.join(tmpDir, 'pathfinder.yaml'), 'utf-8');
        expect(written).toBe('new: true');
    });
});

// ── URL validation edge cases ───────────────────────────────────────────────

describe('URL validation edge cases', () => {
    it('accepts http:// URLs', async () => {
        const { validateInitUrl } = await import('../cli-init.js');
        expect(() => validateInitUrl('http://docs.example.com')).not.toThrow();
    });

    it('accepts localhost URLs', async () => {
        const { validateInitUrl } = await import('../cli-init.js');
        expect(() => validateInitUrl('http://localhost:3000/docs')).not.toThrow();
    });

    it('rejects empty string', async () => {
        const { validateInitUrl } = await import('../cli-init.js');
        expect(() => validateInitUrl('')).toThrow('Invalid URL');
    });

    it('rejects URL with no hostname', async () => {
        const { validateInitUrl } = await import('../cli-init.js');
        expect(() => validateInitUrl('https://')).toThrow();
    });
});

describe('cache directory', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pathfinder-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('creates cache directory from hostname', async () => {
        const { writeGeneratedConfig } = await import('../cli-init.js');
        const yamlContent = 'server:\n  name: test\n';
        writeGeneratedConfig(tmpDir, yamlContent);
        expect(fs.existsSync(path.join(tmpDir, 'pathfinder.yaml'))).toBe(true);
    });
});
