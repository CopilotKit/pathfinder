// CLI: trigger full re-index locally
//
// Usage:
//   npx tsx scripts/seed-index.ts              # Full re-index (docs + code)
//   npx tsx scripts/seed-index.ts --docs-only  # Only docs
//   npx tsx scripts/seed-index.ts --code-only  # Only code

import { initializeSchema, getPool } from '../src/db/client.js';
import { getConfig } from '../src/config.js';
import { EmbeddingClient } from '../src/indexing/embeddings.js';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const docsOnly = args.includes('--docs-only');
const codeOnly = args.includes('--code-only');

if (docsOnly && codeOnly) {
    console.error('Error: --docs-only and --code-only are mutually exclusive.');
    process.exit(1);
}

const indexDocs = !codeOnly;
const indexCode = !docsOnly;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const overallStart = Date.now();

    console.log('=== seed-index ===');
    console.log(`Mode: ${docsOnly ? 'docs-only' : codeOnly ? 'code-only' : 'full (docs + code)'}`);
    console.log('');

    // Load config (validates env vars)
    const config = getConfig();

    // Initialize database schema
    console.log('Initializing database schema...');
    await initializeSchema();
    console.log('Schema initialized.\n');

    // Create embedding client
    const embeddingClient = new EmbeddingClient(
        config.openaiApiKey,
        config.embeddingModel,
        config.embeddingDimensions,
    );

    // Index docs
    if (indexDocs) {
        const start = Date.now();
        console.log('--- Indexing docs ---');
        try {
            const { DocsIndexer } = await import('../src/indexing/docs-indexer.js');
            const indexer = new DocsIndexer(embeddingClient, config.cloneDir, config.githubToken);
            await indexer.fullIndex();
            const elapsed = ((Date.now() - start) / 1000).toFixed(1);
            console.log(`Docs indexing complete in ${elapsed}s\n`);
        } catch (err: unknown) {
            if (isModuleNotFound(err)) {
                console.warn('DocsIndexer not yet implemented, skipping docs indexing.\n');
            } else {
                throw err;
            }
        }
    }

    // Index code
    if (indexCode) {
        const start = Date.now();
        console.log('--- Indexing code ---');
        try {
            const { CodeIndexer } = await import('../src/indexing/code-indexer.js');
            const indexer = new CodeIndexer(embeddingClient, config.cloneDir, config.githubToken);
            await indexer.fullIndex();
            const elapsed = ((Date.now() - start) / 1000).toFixed(1);
            console.log(`Code indexing complete in ${elapsed}s\n`);
        } catch (err: unknown) {
            if (isModuleNotFound(err)) {
                console.warn('CodeIndexer not yet implemented, skipping code indexing.\n');
            } else {
                throw err;
            }
        }
    }

    const totalElapsed = ((Date.now() - overallStart) / 1000).toFixed(1);
    console.log(`=== Done in ${totalElapsed}s ===`);
}

function isModuleNotFound(err: unknown): boolean {
    if (err instanceof SyntaxError) return false;
    if (err instanceof Error) {
        // Dynamic import of a stub file won't have the named export
        return err.message.includes('does not provide an export named') ||
            err.message.includes('is not a constructor');
    }
    return false;
}

main()
    .catch((err) => {
        console.error('Fatal error:', err);
        process.exit(1);
    })
    .finally(async () => {
        try {
            const pool = getPool();
            await pool.end();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes('DATABASE_URL')) {
                console.warn('[seed-index] Error closing pool:', msg);
            }
        }
    });
