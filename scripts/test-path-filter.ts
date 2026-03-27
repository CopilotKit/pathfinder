// Tests for path filter — verifies include/exclude glob logic
//
// Usage: npx tsx scripts/test-path-filter.ts

import { shouldIndex } from '../src/indexing/path-filter.js';

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

console.log('=== Path Filter Tests ===\n');

// --- v1 exclusion ---
console.log('--- v1 exclusion ---');
assert(!shouldIndex('packages/v1/runtime/src/index.ts', 'code'), 'packages/v1/ excluded');
assert(!shouldIndex('packages/v1/react-core/src/hooks.ts', 'code'), 'packages/v1/react-core excluded');
assert(!shouldIndex('packages/v1/react-ui/src/components/chat/Markdown.tsx', 'code'), 'packages/v1/react-ui deep path excluded');
assert(!shouldIndex('packages/v1-compatibility/src/index.ts', 'code'), 'packages/v1-* prefix excluded');

// --- v2 included ---
console.log('\n--- v2 included ---');
assert(shouldIndex('packages/v2/runtime/src/runtime.ts', 'code'), 'packages/v2/ included');
assert(shouldIndex('packages/v2/react/src/hooks/useCopilotAction.ts', 'code'), 'packages/v2 deep path included');
assert(shouldIndex('packages/shared/src/utils.ts', 'code'), 'packages/shared included');

// --- test file exclusion ---
console.log('\n--- test file exclusion ---');
assert(!shouldIndex('packages/v2/runtime/src/__tests__/runtime.test.ts', 'code'), '__tests__ dir excluded');
assert(!shouldIndex('packages/v2/runtime/test/integration.ts', 'code'), 'test/ dir excluded');
assert(!shouldIndex('packages/v2/runtime/tests/unit.ts', 'code'), 'tests/ dir excluded');
assert(!shouldIndex('packages/v2/runtime/src/runtime.test.ts', 'code'), '*.test.ts excluded');
assert(!shouldIndex('packages/v2/runtime/src/runtime.spec.ts', 'code'), '*.spec.ts excluded');
assert(!shouldIndex('packages/v2/runtime/src/runtime.test.tsx', 'code'), '*.test.tsx excluded');
assert(!shouldIndex('examples/with-agno/tests/test_agent.py', 'code'), 'Python test dir excluded');

// --- non-test files included ---
console.log('\n--- non-test files included ---');
assert(shouldIndex('packages/v2/runtime/src/runtime.ts', 'code'), 'normal src file included');
assert(shouldIndex('examples/with-agno/src/agent.py', 'code'), 'example src file included');
assert(shouldIndex('src/index.ts', 'code'), 'root src file included');

// --- docs (no filters by default) ---
console.log('\n--- docs (no filters) ---');
assert(shouldIndex('docs/content/docs/(root)/quickstart.mdx', 'docs'), 'docs included (no filters)');
assert(shouldIndex('docs/content/docs/reference/v1/hooks.mdx', 'docs'), 'v1 docs included (no code filter on docs)');

// --- edge cases ---
console.log('\n--- edge cases ---');
assert(shouldIndex('packages/v2/runtime/src/v1-compat.ts', 'code'), 'file named v1-compat in v2 included');
assert(!shouldIndex('packages/v1/index.ts', 'code'), 'packages/v1/ root file excluded');
assert(shouldIndex('v1-notes.ts', 'code'), 'root file starting with v1 included (not under packages/v1/)');

// --- glob patterns ---
console.log('\n--- glob specifics ---');
assert(!shouldIndex('deeply/nested/test/file.ts', 'code'), '**/test/** matches deep paths');
assert(!shouldIndex('a/b/c/__tests__/d.ts', 'code'), '**/__tests__/** matches deep paths');
assert(!shouldIndex('foo.test.js', 'code'), '**/*.test.* matches root level');
assert(!shouldIndex('dir/foo.spec.tsx', 'code'), '**/*.spec.* matches in subdirs');

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
