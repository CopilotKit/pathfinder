// Tests for path filter — verifies include/exclude glob logic in source-indexer
//
// Usage: npx tsx scripts/test-path-filter.ts

import { globToRegex, matchesPatterns } from '../src/indexing/source-indexer.js';
import type { SourceConfig } from '../src/types.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, description: string): void {
    if (condition) {
        console.log(`  PASS: ${description}`);
        passed++;
    } else {
        console.error(`  FAIL: ${description}`);
        failed++;
    }
}

// ---------------------------------------------------------------------------
// Helper: build a minimal SourceConfig for testing patterns
// ---------------------------------------------------------------------------

function makeSourceConfig(
    filePatterns: string[],
    excludePatterns?: string[],
): SourceConfig {
    return {
        name: 'test',
        type: 'code',
        repo: 'https://github.com/test/test.git',
        path: '.',
        file_patterns: filePatterns,
        exclude_patterns: excludePatterns,
        chunk: { target_lines: 80, overlap_lines: 10 },
    };
}

// Code source config — matches the real mcp-docs.yaml code source patterns
const codeConfig = makeSourceConfig(
    ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.py'],
    [
        'packages/v1/**',
        'packages/v1-*/**',
        '**/test/**',
        '**/tests/**',
        '**/__tests__/**',
        '**/*.test.*',
        '**/*.spec.*',
    ],
);

// Docs source config — only *.mdx, no excludes
const docsConfig = makeSourceConfig(['**/*.mdx']);

console.log('=== Path Filter Tests ===\n');

// --- v1 exclusion ---
console.log('--- v1 exclusion ---');
assert(!matchesPatterns('packages/v1/runtime/src/index.ts', codeConfig), 'packages/v1/ excluded');
assert(!matchesPatterns('packages/v1/react-core/src/hooks.ts', codeConfig), 'packages/v1/react-core excluded');
assert(!matchesPatterns('packages/v1/react-ui/src/components/chat/Markdown.tsx', codeConfig), 'packages/v1/react-ui deep path excluded');
assert(!matchesPatterns('packages/v1-compatibility/src/index.ts', codeConfig), 'packages/v1-* prefix excluded');

// --- v2 included ---
console.log('\n--- v2 included ---');
assert(matchesPatterns('packages/v2/runtime/src/runtime.ts', codeConfig), 'packages/v2/ included');
assert(matchesPatterns('packages/v2/react/src/hooks/useCopilotAction.ts', codeConfig), 'packages/v2 deep path included');
assert(matchesPatterns('packages/shared/src/utils.ts', codeConfig), 'packages/shared included');

// --- test file exclusion ---
console.log('\n--- test file exclusion ---');
assert(!matchesPatterns('packages/v2/runtime/src/__tests__/runtime.test.ts', codeConfig), '__tests__ dir excluded');
assert(!matchesPatterns('packages/v2/runtime/test/integration.ts', codeConfig), 'test/ dir excluded');
assert(!matchesPatterns('packages/v2/runtime/tests/unit.ts', codeConfig), 'tests/ dir excluded');
assert(!matchesPatterns('packages/v2/runtime/src/runtime.test.ts', codeConfig), '*.test.ts excluded');
assert(!matchesPatterns('packages/v2/runtime/src/runtime.spec.ts', codeConfig), '*.spec.ts excluded');
assert(!matchesPatterns('packages/v2/runtime/src/runtime.test.tsx', codeConfig), '*.test.tsx excluded');
assert(!matchesPatterns('examples/with-agno/tests/test_agent.py', codeConfig), 'Python test dir excluded');

// --- non-test files included ---
console.log('\n--- non-test files included ---');
assert(matchesPatterns('packages/v2/runtime/src/runtime.ts', codeConfig), 'normal src file included');
assert(matchesPatterns('examples/with-agno/src/agent.py', codeConfig), 'example src file included');
assert(matchesPatterns('src/index.ts', codeConfig), 'root src file included');

// --- docs (*.mdx only) ---
console.log('\n--- docs (*.mdx only) ---');
assert(matchesPatterns('docs/content/docs/(root)/quickstart.mdx', docsConfig), 'docs included');
assert(matchesPatterns('docs/content/docs/reference/v1/hooks.mdx', docsConfig), 'v1 docs included (no code excludes on docs)');
assert(!matchesPatterns('docs/content/docs/reference/v1/hooks.ts', docsConfig), 'ts file not matched by docs config');

// --- edge cases ---
console.log('\n--- edge cases ---');
assert(matchesPatterns('packages/v2/runtime/src/v1-compat.ts', codeConfig), 'file named v1-compat in v2 included');
assert(!matchesPatterns('packages/v1/index.ts', codeConfig), 'packages/v1/ root file excluded');
assert(matchesPatterns('v1-notes.ts', codeConfig), 'root file starting with v1 included (not under packages/v1/)');

// --- glob specifics ---
console.log('\n--- glob specifics ---');
assert(!matchesPatterns('deeply/nested/test/file.ts', codeConfig), '**/test/** matches deep paths');
assert(!matchesPatterns('a/b/c/__tests__/d.ts', codeConfig), '**/__tests__/** matches deep paths');
assert(!matchesPatterns('foo.test.js', codeConfig), '**/*.test.* matches root level');
assert(!matchesPatterns('dir/foo.spec.tsx', codeConfig), '**/*.spec.* matches in subdirs');

// --- globToRegex unit tests ---
console.log('\n--- globToRegex unit tests ---');
const mdxPattern = globToRegex('**/*.mdx');
assert(mdxPattern.test('docs/quickstart.mdx'), '**/*.mdx matches nested mdx');
assert(mdxPattern.test('quickstart.mdx'), '**/*.mdx matches root mdx');
assert(!mdxPattern.test('quickstart.ts'), '**/*.mdx does not match .ts');

const v1Pattern = globToRegex('packages/v1/**');
assert(v1Pattern.test('packages/v1/index.ts'), 'packages/v1/** matches file in v1');
assert(v1Pattern.test('packages/v1/a/b/c.ts'), 'packages/v1/** matches deep file');
assert(!v1Pattern.test('packages/v2/index.ts'), 'packages/v1/** does not match v2');

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
