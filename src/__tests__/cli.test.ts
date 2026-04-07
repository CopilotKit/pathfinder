import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'cli.js');
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

describe('pathfinder CLI', () => {
    const tmpDirs: string[] = [];

    function makeTmpDir(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pathfinder-cli-test-'));
        tmpDirs.push(dir);
        return dir;
    }

    afterEach(() => {
        for (const dir of tmpDirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        tmpDirs.length = 0;
    });

    describe('init', () => {
        it('creates pathfinder.yaml and .env in a temp directory', () => {
            const cwd = makeTmpDir();
            execSync(`node ${CLI} init`, { cwd, env: { ...process.env, PATH: process.env.PATH } });

            expect(fs.existsSync(path.join(cwd, 'pathfinder.yaml'))).toBe(true);
            expect(fs.existsSync(path.join(cwd, '.env'))).toBe(true);

            // Verify content matches the templates
            const yamlContent = fs.readFileSync(path.join(cwd, 'pathfinder.yaml'), 'utf-8');
            const templateContent = fs.readFileSync(path.join(PROJECT_ROOT, 'pathfinder.example.yaml'), 'utf-8');
            expect(yamlContent).toBe(templateContent);
        });

        it('does NOT overwrite existing pathfinder.yaml', () => {
            const cwd = makeTmpDir();
            const existingContent = 'my-existing-config: true\n';
            fs.writeFileSync(path.join(cwd, 'pathfinder.yaml'), existingContent);

            const output = execSync(`node ${CLI} init`, { cwd, encoding: 'utf-8' });

            expect(fs.readFileSync(path.join(cwd, 'pathfinder.yaml'), 'utf-8')).toBe(existingContent);
            expect(output).toContain('already exists');
        });

        it('does NOT overwrite existing .env', () => {
            const cwd = makeTmpDir();
            const existingEnv = 'MY_SECRET=keep_this\n';
            fs.writeFileSync(path.join(cwd, '.env'), existingEnv);

            const output = execSync(`node ${CLI} init`, { cwd, encoding: 'utf-8' });

            expect(fs.readFileSync(path.join(cwd, '.env'), 'utf-8')).toBe(existingEnv);
            expect(output).toContain('already exists');
        });
    });

    describe('serve', () => {
        it('--help prints help without starting a server', () => {
            const output = execSync(`node ${CLI} serve --help`, { encoding: 'utf-8' });

            expect(output).toContain('Start the Pathfinder MCP server');
            expect(output).toContain('--port');
            expect(output).toContain('--config');
        });
    });
});
