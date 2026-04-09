import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

// We need to control the module cache for config.ts, so we mock fs and
// re-import config functions fresh in each test via resetModules.

vi.mock('node:fs', async () => {
    const actual = await vi.importActual('node:fs');
    return {
        ...actual,
        existsSync: vi.fn(),
        readFileSync: vi.fn(),
    };
});

const mockedExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockedReadFileSync = readFileSync as ReturnType<typeof vi.fn>;

// Helper to build a minimal valid YAML config string
function makeYaml(overrides: Record<string, unknown> = {}): string {
    const base = {
        server: { name: 'test', version: '1.0' },
        sources: [
            { name: 'docs', type: 'markdown', path: './docs', file_patterns: ['**/*.md'], chunk: {} },
        ],
        tools: [
            { name: 'search-docs', type: 'search', source: 'docs', description: 'Search docs', default_limit: 10, max_limit: 50, result_format: 'docs' },
        ],
        embedding: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 },
        indexing: { auto_reindex: true, reindex_hour_utc: 4, stale_threshold_hours: 24 },
        ...overrides,
    };
    // Use yaml library for proper serialization
    const { stringify } = require('yaml');
    return stringify(base);
}

// Fresh import helper — resets module cache so cached config is cleared
async function freshImport() {
    vi.resetModules();
    // Re-mock fs after resetModules
    vi.doMock('node:fs', async () => {
        const actual = await vi.importActual('node:fs');
        return {
            ...actual,
            existsSync: mockedExistsSync,
            readFileSync: mockedReadFileSync,
        };
    });
    const mod = await import('../config.js');
    return mod;
}

describe('config.ts', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env = { ...originalEnv };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    // ── resolveConfigPath ────────────────────────────────────────────────────

    describe('resolveConfigPath (via getServerConfig)', () => {
        it('uses PATHFINDER_CONFIG env var when set', async () => {
            process.env.PATHFINDER_CONFIG = '/tmp/custom-config.yaml';
            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(makeYaml());

            const { getServerConfig } = await freshImport();
            const cfg = getServerConfig();
            expect(cfg.server.name).toBe('test');
            expect(mockedReadFileSync).toHaveBeenCalledWith(
                expect.stringContaining('custom-config.yaml'),
                'utf-8'
            );
        });

        it('throws when PATHFINDER_CONFIG points to non-existent file', async () => {
            process.env.PATHFINDER_CONFIG = '/tmp/missing.yaml';
            mockedExistsSync.mockReturnValue(false);

            const { getServerConfig } = await freshImport();
            expect(() => getServerConfig()).toThrow('PATHFINDER_CONFIG points to');
        });

        it('falls back to MCP_DOCS_CONFIG with deprecation warning', async () => {
            delete process.env.PATHFINDER_CONFIG;
            process.env.MCP_DOCS_CONFIG = '/tmp/legacy.yaml';
            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(makeYaml());
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

            const { getServerConfig } = await freshImport();
            getServerConfig();
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('MCP_DOCS_CONFIG is deprecated'));
            warnSpy.mockRestore();
        });

        it('throws when MCP_DOCS_CONFIG points to non-existent file', async () => {
            delete process.env.PATHFINDER_CONFIG;
            process.env.MCP_DOCS_CONFIG = '/tmp/missing-legacy.yaml';
            mockedExistsSync.mockReturnValue(false);

            const { getServerConfig } = await freshImport();
            expect(() => getServerConfig()).toThrow('MCP_DOCS_CONFIG points to');
        });

        it('falls back to pathfinder.yaml in cwd', async () => {
            delete process.env.PATHFINDER_CONFIG;
            delete process.env.MCP_DOCS_CONFIG;
            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(makeYaml());

            const { getServerConfig } = await freshImport();
            const cfg = getServerConfig();
            expect(cfg.server.name).toBe('test');
        });

        it('falls back to mcp-docs.yaml with deprecation warning', async () => {
            delete process.env.PATHFINDER_CONFIG;
            delete process.env.MCP_DOCS_CONFIG;
            mockedExistsSync.mockImplementation((p: string) => {
                if (p.endsWith('pathfinder.yaml')) return false;
                return true;
            });
            mockedReadFileSync.mockReturnValue(makeYaml());
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

            const { getServerConfig } = await freshImport();
            getServerConfig();
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('mcp-docs.yaml is deprecated'));
            warnSpy.mockRestore();
        });

        it('throws when no config file is found', async () => {
            delete process.env.PATHFINDER_CONFIG;
            delete process.env.MCP_DOCS_CONFIG;
            mockedExistsSync.mockReturnValue(false);

            const { getServerConfig } = await freshImport();
            expect(() => getServerConfig()).toThrow('No pathfinder.yaml found');
        });
    });

    // ── loadServerConfig ─────────────────────────────────────────────────────

    describe('loadServerConfig (via getServerConfig)', () => {
        beforeEach(() => {
            process.env.PATHFINDER_CONFIG = '/tmp/test.yaml';
            mockedExistsSync.mockReturnValue(true);
        });

        it('parses valid YAML and returns server config', async () => {
            mockedReadFileSync.mockReturnValue(makeYaml());

            const { getServerConfig } = await freshImport();
            const cfg = getServerConfig();
            expect(cfg.server.name).toBe('test');
            expect(cfg.sources).toHaveLength(1);
            expect(cfg.tools).toHaveLength(1);
        });

        it('throws on invalid YAML schema (missing server)', async () => {
            const { stringify } = require('yaml');
            mockedReadFileSync.mockReturnValue(stringify({
                sources: [{ name: 'x', type: 'markdown', path: '.', file_patterns: ['**/*.md'], chunk: {} }],
                tools: [{ name: 't', type: 'search', source: 'x', description: 'd', default_limit: 5, max_limit: 10, result_format: 'docs' }],
            }));

            const { getServerConfig } = await freshImport();
            expect(() => getServerConfig()).toThrow('Invalid config');
        });

        it('defaults tool type to search when missing', async () => {
            const { stringify } = require('yaml');
            const config = {
                server: { name: 'test', version: '1.0' },
                sources: [{ name: 'docs', type: 'markdown', path: './docs', file_patterns: ['**/*.md'], chunk: {} }],
                tools: [{ name: 'search-docs', source: 'docs', description: 'Search', default_limit: 10, max_limit: 50, result_format: 'docs' }],
                embedding: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 },
                indexing: { auto_reindex: true, reindex_hour_utc: 4, stale_threshold_hours: 24 },
            };
            mockedReadFileSync.mockReturnValue(stringify(config));
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

            const { getServerConfig } = await freshImport();
            const cfg = getServerConfig();
            expect(cfg.tools[0].type).toBe('search');
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no type field'));
            warnSpy.mockRestore();
        });

        it('rejects duplicate source names', async () => {
            const { stringify } = require('yaml');
            mockedReadFileSync.mockReturnValue(stringify({
                server: { name: 'test', version: '1.0' },
                sources: [
                    { name: 'docs', type: 'markdown', path: './a', file_patterns: ['**/*.md'], chunk: {} },
                    { name: 'docs', type: 'markdown', path: './b', file_patterns: ['**/*.md'], chunk: {} },
                ],
                tools: [{ name: 't', type: 'search', source: 'docs', description: 'd', default_limit: 5, max_limit: 10, result_format: 'docs' }],
                embedding: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 },
                indexing: { auto_reindex: true, reindex_hour_utc: 4, stale_threshold_hours: 24 },
            }));

            const { getServerConfig } = await freshImport();
            expect(() => getServerConfig()).toThrow('Duplicate source names');
        });

        it('rejects duplicate tool names', async () => {
            const { stringify } = require('yaml');
            mockedReadFileSync.mockReturnValue(stringify({
                server: { name: 'test', version: '1.0' },
                sources: [
                    { name: 'docs', type: 'markdown', path: './docs', file_patterns: ['**/*.md'], chunk: {} },
                ],
                tools: [
                    { name: 'search', type: 'search', source: 'docs', description: 'd', default_limit: 5, max_limit: 10, result_format: 'docs' },
                    { name: 'search', type: 'search', source: 'docs', description: 'd2', default_limit: 5, max_limit: 10, result_format: 'docs' },
                ],
                embedding: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 },
                indexing: { auto_reindex: true, reindex_hour_utc: 4, stale_threshold_hours: 24 },
            }));

            const { getServerConfig } = await freshImport();
            expect(() => getServerConfig()).toThrow('Duplicate tool names');
        });

        it('rejects search tool referencing non-existent source', async () => {
            const { stringify } = require('yaml');
            mockedReadFileSync.mockReturnValue(stringify({
                server: { name: 'test', version: '1.0' },
                sources: [
                    { name: 'docs', type: 'markdown', path: './docs', file_patterns: ['**/*.md'], chunk: {} },
                ],
                tools: [
                    { name: 'search', type: 'search', source: 'missing-source', description: 'd', default_limit: 5, max_limit: 10, result_format: 'docs' },
                ],
                embedding: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 },
                indexing: { auto_reindex: true, reindex_hour_utc: 4, stale_threshold_hours: 24 },
            }));

            const { getServerConfig } = await freshImport();
            expect(() => getServerConfig()).toThrow('references source "missing-source"');
        });

        it('rejects knowledge tool referencing non-existent source', async () => {
            const { stringify } = require('yaml');
            mockedReadFileSync.mockReturnValue(stringify({
                server: { name: 'test', version: '1.0' },
                sources: [
                    { name: 'docs', type: 'markdown', path: './docs', file_patterns: ['**/*.md'], chunk: {} },
                ],
                tools: [
                    { name: 'faq', type: 'knowledge', sources: ['ghost'], description: 'd', min_confidence: 0.5, default_limit: 10, max_limit: 50 },
                ],
                embedding: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 },
                indexing: { auto_reindex: true, reindex_hour_utc: 4, stale_threshold_hours: 24 },
            }));

            const { getServerConfig } = await freshImport();
            expect(() => getServerConfig()).toThrow('references source "ghost"');
        });

        it('validates webhook repo_sources reference existing sources', async () => {
            const { stringify } = require('yaml');
            mockedReadFileSync.mockReturnValue(stringify({
                server: { name: 'test', version: '1.0' },
                sources: [
                    { name: 'docs', type: 'markdown', path: './docs', file_patterns: ['**/*.md'], chunk: {} },
                ],
                tools: [
                    { name: 'search', type: 'search', source: 'docs', description: 'd', default_limit: 5, max_limit: 10, result_format: 'docs' },
                ],
                embedding: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 },
                indexing: { auto_reindex: true, reindex_hour_utc: 4, stale_threshold_hours: 24 },
                webhook: {
                    repo_sources: { 'org/repo': ['missing-source'] },
                    path_triggers: {},
                },
            }));

            const { getServerConfig } = await freshImport();
            expect(() => getServerConfig()).toThrow('references source "missing-source"');
        });

        it('validates webhook path_triggers reference existing sources', async () => {
            const { stringify } = require('yaml');
            mockedReadFileSync.mockReturnValue(stringify({
                server: { name: 'test', version: '1.0' },
                sources: [
                    { name: 'docs', type: 'markdown', path: './docs', file_patterns: ['**/*.md'], chunk: {} },
                ],
                tools: [
                    { name: 'search', type: 'search', source: 'docs', description: 'd', default_limit: 5, max_limit: 10, result_format: 'docs' },
                ],
                embedding: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 },
                indexing: { auto_reindex: true, reindex_hour_utc: 4, stale_threshold_hours: 24 },
                webhook: {
                    repo_sources: { 'org/repo': ['docs'] },
                    path_triggers: { 'ghost-source': ['docs/**'] },
                },
            }));

            const { getServerConfig } = await freshImport();
            expect(() => getServerConfig()).toThrow('path_triggers key "ghost-source"');
        });

        it('warns when knowledge tool references non-FAQ source', async () => {
            const { stringify } = require('yaml');
            mockedReadFileSync.mockReturnValue(stringify({
                server: { name: 'test', version: '1.0' },
                sources: [
                    { name: 'docs', type: 'markdown', path: './docs', file_patterns: ['**/*.md'], chunk: {} },
                ],
                tools: [
                    { name: 'faq', type: 'knowledge', sources: ['docs'], description: 'd', min_confidence: 0.5, default_limit: 10, max_limit: 50 },
                ],
                embedding: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 },
                indexing: { auto_reindex: true, reindex_hour_utc: 4, stale_threshold_hours: 24 },
            }));
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

            const { getServerConfig } = await freshImport();
            getServerConfig();
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('does not have category: "faq"'));
            warnSpy.mockRestore();
        });

        it('validates local file source paths exist', async () => {
            mockedExistsSync.mockImplementation((p: string) => {
                if (p.includes('test.yaml')) return true;
                // Simulate the local path not existing
                return false;
            });
            mockedReadFileSync.mockReturnValue(makeYaml());

            const { getServerConfig } = await freshImport();
            expect(() => getServerConfig()).toThrow('does not exist');
        });

        it('skips path validation for file sources with repo (remote)', async () => {
            const { stringify } = require('yaml');
            mockedExistsSync.mockImplementation((p: string) => {
                if (p.includes('test.yaml')) return true;
                // Local path does NOT exist, but we have a repo so it should not throw
                return false;
            });
            mockedReadFileSync.mockReturnValue(stringify({
                server: { name: 'test', version: '1.0' },
                sources: [
                    { name: 'docs', type: 'markdown', path: './docs', file_patterns: ['**/*.md'], chunk: {}, repo: 'https://github.com/org/repo' },
                ],
                tools: [
                    { name: 'search', type: 'search', source: 'docs', description: 'd', default_limit: 5, max_limit: 10, result_format: 'docs' },
                ],
                embedding: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 },
                indexing: { auto_reindex: true, reindex_hour_utc: 4, stale_threshold_hours: 24 },
            }));

            const { getServerConfig } = await freshImport();
            // Should not throw — repo sources skip local path validation
            const cfg = getServerConfig();
            expect(cfg.sources[0].name).toBe('docs');
        });

        it('skips path validation for non-file sources (slack, discord, notion)', async () => {
            const { stringify } = require('yaml');
            mockedExistsSync.mockImplementation((p: string) => {
                if (p.includes('test.yaml')) return true;
                return false; // nothing else exists
            });
            mockedReadFileSync.mockReturnValue(stringify({
                server: { name: 'test', version: '1.0' },
                sources: [
                    { name: 'slack-src', type: 'slack', channels: ['C123'], chunk: {} },
                ],
                tools: [
                    { name: 'collect', type: 'collect', description: 'collect stuff', response: 'Collected', schema: { field1: { type: 'string' } } },
                ],
            }));

            const { getServerConfig } = await freshImport();
            const cfg = getServerConfig();
            expect(cfg.sources[0].type).toBe('slack');
        });
    });

    // ── Helper functions ─────────────────────────────────────────────────────

    describe('helper functions', () => {
        function setupConfig(tools: Array<Record<string, unknown>>, sources?: Array<Record<string, unknown>>) {
            const { stringify } = require('yaml');
            const srcs = sources ?? [
                { name: 'docs', type: 'markdown', path: './docs', file_patterns: ['**/*.md'], chunk: {} },
            ];
            const cfg: Record<string, unknown> = {
                server: { name: 'test', version: '1.0' },
                sources: srcs,
                tools,
            };
            // Add embedding/indexing if search or knowledge tools present
            if (tools.some(t => t.type === 'search' || t.type === 'knowledge')) {
                cfg.embedding = { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 };
                cfg.indexing = { auto_reindex: true, reindex_hour_utc: 4, stale_threshold_hours: 24 };
            }
            return stringify(cfg);
        }

        beforeEach(() => {
            process.env.PATHFINDER_CONFIG = '/tmp/test.yaml';
        });

        it('hasSearchTools returns true when search tools exist', async () => {
            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(setupConfig([
                { name: 's', type: 'search', source: 'docs', description: 'd', default_limit: 5, max_limit: 10, result_format: 'docs' },
            ]));

            const { hasSearchTools } = await freshImport();
            expect(hasSearchTools()).toBe(true);
        });

        it('hasSearchTools returns false when no search tools', async () => {
            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(setupConfig([
                { name: 'c', type: 'collect', description: 'collect', response: 'Collected', schema: { field1: { type: 'string' } } },
            ]));

            const { hasSearchTools } = await freshImport();
            expect(hasSearchTools()).toBe(false);
        });

        it('hasKnowledgeTools returns true when knowledge tools exist', async () => {
            const sources = [
                { name: 'faq', type: 'discord', guild_id: '123', channels: [{ id: '1', type: 'forum' }], category: 'faq', chunk: {} },
            ];
            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(setupConfig([
                { name: 'k', type: 'knowledge', sources: ['faq'], description: 'd', min_confidence: 0.5, default_limit: 10, max_limit: 50 },
            ], sources));

            const { hasKnowledgeTools } = await freshImport();
            expect(hasKnowledgeTools()).toBe(true);
        });

        it('hasKnowledgeTools returns false when no knowledge tools', async () => {
            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(setupConfig([
                { name: 'c', type: 'collect', description: 'collect', response: 'Collected', schema: { field1: { type: 'string' } } },
            ]));

            const { hasKnowledgeTools } = await freshImport();
            expect(hasKnowledgeTools()).toBe(false);
        });

        it('hasCollectTools returns true when collect tools exist', async () => {
            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(setupConfig([
                { name: 'c', type: 'collect', description: 'collect', response: 'Collected', schema: { field1: { type: 'string' } } },
            ]));

            const { hasCollectTools } = await freshImport();
            expect(hasCollectTools()).toBe(true);
        });

        it('hasCollectTools returns false when no collect tools', async () => {
            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(setupConfig([
                { name: 's', type: 'search', source: 'docs', description: 'd', default_limit: 5, max_limit: 10, result_format: 'docs' },
            ]));

            const { hasCollectTools } = await freshImport();
            expect(hasCollectTools()).toBe(false);
        });

        it('hasBashSemanticSearch returns true for vector grep strategy', async () => {
            mockedExistsSync.mockReturnValue(true);
            const { stringify } = require('yaml');
            mockedReadFileSync.mockReturnValue(stringify({
                server: { name: 'test', version: '1.0' },
                sources: [{ name: 'docs', type: 'markdown', path: './docs', file_patterns: ['**/*.md'], chunk: {} }],
                tools: [{ name: 'b', type: 'bash', sources: ['docs'], description: 'd', bash: { grep_strategy: 'vector' } }],
                embedding: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 },
            }));

            const { hasBashSemanticSearch } = await freshImport();
            expect(hasBashSemanticSearch()).toBe(true);
        });

        it('hasBashSemanticSearch returns true for hybrid grep strategy', async () => {
            mockedExistsSync.mockReturnValue(true);
            const { stringify } = require('yaml');
            mockedReadFileSync.mockReturnValue(stringify({
                server: { name: 'test', version: '1.0' },
                sources: [{ name: 'docs', type: 'markdown', path: './docs', file_patterns: ['**/*.md'], chunk: {} }],
                tools: [{ name: 'b', type: 'bash', sources: ['docs'], description: 'd', bash: { grep_strategy: 'hybrid' } }],
                embedding: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 },
            }));

            const { hasBashSemanticSearch } = await freshImport();
            expect(hasBashSemanticSearch()).toBe(true);
        });

        it('hasBashSemanticSearch returns false for memory grep strategy', async () => {
            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(setupConfig([
                { name: 'b', type: 'bash', sources: ['docs'], description: 'd', bash: { grep_strategy: 'memory' } },
            ]));

            const { hasBashSemanticSearch } = await freshImport();
            expect(hasBashSemanticSearch()).toBe(false);
        });

        it('getIndexableSourceNames returns sources from search and knowledge tools', async () => {
            const sources = [
                { name: 'docs', type: 'markdown', path: './docs', file_patterns: ['**/*.md'], chunk: {} },
                { name: 'faq', type: 'discord', guild_id: '123', channels: [{ id: '1', type: 'forum' }], category: 'faq', chunk: {} },
            ];
            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(setupConfig([
                { name: 's', type: 'search', source: 'docs', description: 'd', default_limit: 5, max_limit: 10, result_format: 'docs' },
                { name: 'k', type: 'knowledge', sources: ['faq'], description: 'd', min_confidence: 0.5, default_limit: 10, max_limit: 50 },
            ], sources));

            const { getIndexableSourceNames } = await freshImport();
            const names = getIndexableSourceNames();
            expect(names).toEqual(new Set(['docs', 'faq']));
        });

        it('getIndexableSourceNames returns empty set when no search/knowledge tools', async () => {
            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(setupConfig([
                { name: 'c', type: 'collect', description: 'collect', response: 'Collected', schema: { field1: { type: 'string' } } },
            ]));

            const { getIndexableSourceNames } = await freshImport();
            const names = getIndexableSourceNames();
            expect(names.size).toBe(0);
        });
    });

    // ── parseConfig (via getConfig) ──────────────────────────────────────────

    describe('parseConfig (via getConfig)', () => {
        beforeEach(() => {
            process.env.PATHFINDER_CONFIG = '/tmp/test.yaml';
        });

        it('returns config with all env vars set for search tools', async () => {
            process.env.DATABASE_URL = 'postgresql://test';
            process.env.OPENAI_API_KEY = 'sk-test';
            process.env.PORT = '4000';
            process.env.NODE_ENV = 'production';
            process.env.LOG_LEVEL = 'debug';
            process.env.CLONE_DIR = '/tmp/clones';
            process.env.GITHUB_TOKEN = 'ghp_test';
            process.env.GITHUB_WEBHOOK_SECRET = 'secret';

            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(makeYaml());

            const { getConfig } = await freshImport();
            const cfg = getConfig();
            expect(cfg.databaseUrl).toBe('postgresql://test');
            expect(cfg.openaiApiKey).toBe('sk-test');
            expect(cfg.port).toBe(4000);
            expect(cfg.nodeEnv).toBe('production');
            expect(cfg.logLevel).toBe('debug');
            expect(cfg.cloneDir).toBe('/tmp/clones');
        });

        it('uses default values for optional env vars', async () => {
            process.env.DATABASE_URL = 'postgresql://test';
            process.env.OPENAI_API_KEY = 'sk-test';
            delete process.env.PORT;
            delete process.env.NODE_ENV;
            delete process.env.LOG_LEVEL;
            delete process.env.CLONE_DIR;

            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(makeYaml());

            const { getConfig } = await freshImport();
            const cfg = getConfig();
            expect(cfg.port).toBe(3001);
            expect(cfg.nodeEnv).toBe('development');
            expect(cfg.logLevel).toBe('info');
            expect(cfg.cloneDir).toBe('/tmp/mcp-repos');
        });

        it('throws when DATABASE_URL missing and search tools configured', async () => {
            delete process.env.DATABASE_URL;
            process.env.OPENAI_API_KEY = 'sk-test';

            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(makeYaml());

            const { getConfig } = await freshImport();
            expect(() => getConfig()).toThrow('DATABASE_URL');
        });

        it('throws when OPENAI_API_KEY missing and search tools configured', async () => {
            process.env.DATABASE_URL = 'postgresql://test';
            delete process.env.OPENAI_API_KEY;

            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(makeYaml());

            const { getConfig } = await freshImport();
            expect(() => getConfig()).toThrow('OPENAI_API_KEY');
        });

        it('does not require OPENAI_API_KEY for collect-only tools (but requires DATABASE_URL)', async () => {
            process.env.DATABASE_URL = 'postgresql://test';
            delete process.env.OPENAI_API_KEY;

            const { stringify } = require('yaml');
            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(stringify({
                server: { name: 'test', version: '1.0' },
                sources: [{ name: 'docs', type: 'markdown', path: './docs', file_patterns: ['**/*.md'], chunk: {} }],
                tools: [{ name: 'c', type: 'collect', description: 'collect', response: 'Collected', schema: { field1: { type: 'string' } } }],
            }));

            const { getConfig } = await freshImport();
            const cfg = getConfig();
            expect(cfg.openaiApiKey).toBe('');
        });

        it('requires DATABASE_URL when collect tools are configured', async () => {
            delete process.env.DATABASE_URL;
            delete process.env.OPENAI_API_KEY;

            const { stringify } = require('yaml');
            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(stringify({
                server: { name: 'test', version: '1.0' },
                sources: [{ name: 'docs', type: 'markdown', path: './docs', file_patterns: ['**/*.md'], chunk: {} }],
                tools: [{ name: 'c', type: 'collect', description: 'collect', response: 'Collected', schema: { field1: { type: 'string' } } }],
            }));

            const { getConfig } = await freshImport();
            expect(() => getConfig()).toThrow('DATABASE_URL');
        });

        it('throws when SLACK_BOT_TOKEN missing and slack source configured', async () => {
            delete process.env.SLACK_BOT_TOKEN;
            process.env.DATABASE_URL = 'postgresql://test';
            process.env.OPENAI_API_KEY = 'sk-test';

            const { stringify } = require('yaml');
            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(stringify({
                server: { name: 'test', version: '1.0' },
                sources: [
                    { name: 'slack', type: 'slack', channels: ['C123'], chunk: {} },
                ],
                tools: [
                    { name: 's', type: 'search', source: 'slack', description: 'd', default_limit: 5, max_limit: 10, result_format: 'docs' },
                ],
                embedding: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 },
                indexing: { auto_reindex: true, reindex_hour_utc: 4, stale_threshold_hours: 24 },
            }));

            const { getConfig } = await freshImport();
            expect(() => getConfig()).toThrow('SLACK_BOT_TOKEN');
        });

        it('throws when DISCORD_BOT_TOKEN missing and discord source configured', async () => {
            delete process.env.DISCORD_BOT_TOKEN;
            delete process.env.DISCORD_PUBLIC_KEY;
            process.env.DATABASE_URL = 'postgresql://test';
            process.env.OPENAI_API_KEY = 'sk-test';

            const { stringify } = require('yaml');
            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(stringify({
                server: { name: 'test', version: '1.0' },
                sources: [
                    { name: 'disc', type: 'discord', guild_id: '123', channels: [{ id: '1', type: 'forum' }], chunk: {} },
                ],
                tools: [
                    { name: 's', type: 'search', source: 'disc', description: 'd', default_limit: 5, max_limit: 10, result_format: 'docs' },
                ],
                embedding: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 },
                indexing: { auto_reindex: true, reindex_hour_utc: 4, stale_threshold_hours: 24 },
            }));

            const { getConfig } = await freshImport();
            expect(() => getConfig()).toThrow('DISCORD_BOT_TOKEN');
        });

        it('throws when NOTION_TOKEN missing and notion source configured', async () => {
            delete process.env.NOTION_TOKEN;
            process.env.DATABASE_URL = 'postgresql://test';
            process.env.OPENAI_API_KEY = 'sk-test';

            const { stringify } = require('yaml');
            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(stringify({
                server: { name: 'test', version: '1.0' },
                sources: [
                    { name: 'notion', type: 'notion', chunk: {} },
                ],
                tools: [
                    { name: 's', type: 'search', source: 'notion', description: 'd', default_limit: 5, max_limit: 10, result_format: 'docs' },
                ],
                embedding: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 },
                indexing: { auto_reindex: true, reindex_hour_utc: 4, stale_threshold_hours: 24 },
            }));

            const { getConfig } = await freshImport();
            expect(() => getConfig()).toThrow('NOTION_TOKEN');
        });

        it('throws on invalid PORT value', async () => {
            process.env.PORT = 'not-a-number';
            process.env.DATABASE_URL = 'postgresql://test';
            process.env.OPENAI_API_KEY = 'sk-test';

            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(makeYaml());

            const { getConfig } = await freshImport();
            expect(() => getConfig()).toThrow('Invalid PORT');
        });

        it('throws on PORT out of range (negative)', async () => {
            process.env.PORT = '-1';
            process.env.DATABASE_URL = 'postgresql://test';
            process.env.OPENAI_API_KEY = 'sk-test';

            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(makeYaml());

            const { getConfig } = await freshImport();
            expect(() => getConfig()).toThrow('Invalid PORT');
        });

        it('throws on PORT out of range (>65535)', async () => {
            process.env.PORT = '70000';
            process.env.DATABASE_URL = 'postgresql://test';
            process.env.OPENAI_API_KEY = 'sk-test';

            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(makeYaml());

            const { getConfig } = await freshImport();
            expect(() => getConfig()).toThrow('Invalid PORT');
        });
    });

    // ── Config caching ───────────────────────────────────────────────────────

    describe('caching', () => {
        it('getServerConfig returns cached result on second call', async () => {
            process.env.PATHFINDER_CONFIG = '/tmp/test.yaml';
            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(makeYaml());

            const { getServerConfig } = await freshImport();
            const first = getServerConfig();
            const second = getServerConfig();
            expect(first).toBe(second); // same reference
            // readFileSync called only once
            expect(mockedReadFileSync).toHaveBeenCalledTimes(1);
        });

        it('getConfig returns cached result on second call', async () => {
            process.env.PATHFINDER_CONFIG = '/tmp/test.yaml';
            process.env.DATABASE_URL = 'postgresql://test';
            process.env.OPENAI_API_KEY = 'sk-test';
            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(makeYaml());

            const { getConfig } = await freshImport();
            const first = getConfig();
            const second = getConfig();
            expect(first).toBe(second);
        });
    });

    // ── Config proxy ─────────────────────────────────────────────────────────

    describe('config proxy', () => {
        it('proxies property access to getConfig()', async () => {
            process.env.PATHFINDER_CONFIG = '/tmp/test.yaml';
            process.env.DATABASE_URL = 'postgresql://test';
            process.env.OPENAI_API_KEY = 'sk-test';
            process.env.PORT = '5555';
            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(makeYaml());

            const { config } = await freshImport();
            expect(config.port).toBe(5555);
            expect(config.openaiApiKey).toBe('sk-test');
        });
    });
});
