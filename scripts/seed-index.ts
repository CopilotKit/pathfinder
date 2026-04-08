// CLI: trigger full re-index locally
//
// Usage:
//   npx tsx scripts/seed-index.ts                    # All sources
//   npx tsx scripts/seed-index.ts --source=docs      # Just the "docs" source
//   npx tsx scripts/seed-index.ts --source=code      # Just the "code" source

import { initializeSchema, getPool } from '../src/db/client.js';
import { getConfig, getServerConfig } from '../src/config.js';
import { EmbeddingClient } from '../src/indexing/embeddings.js';
import { getProvider } from '../src/indexing/providers/index.js';
import { IndexingPipeline } from '../src/indexing/pipeline.js';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let sourceName: string | undefined;

for (const arg of args) {
    if (arg.startsWith('--source=')) {
        sourceName = arg.slice('--source='.length);
    } else if (arg === '--help' || arg === '-h') {
        console.log(`Usage: npx tsx scripts/seed-index.ts [options]

Options:
  --source=<name>  Index only the named source (default: all sources)
  -h, --help       Show this help message
`);
        process.exit(0);
    } else {
        console.error(`Unknown argument: ${arg}`);
        process.exit(1);
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const overallStart = Date.now();

    const config = getConfig();
    const serverConfig = getServerConfig();

    // Determine which sources to index
    let sources = serverConfig.sources;
    if (sourceName) {
        sources = sources.filter(s => s.name === sourceName);
        if (sources.length === 0) {
            const available = serverConfig.sources.map(s => s.name).join(', ');
            console.error(`Error: source "${sourceName}" not found in config. Available sources: ${available}`);
            process.exit(1);
        }
    }

    console.log('=== seed-index ===');
    console.log(`Mode: ${sourceName ? `source=${sourceName}` : `all (${sources.map(s => s.name).join(', ')})`}`);
    console.log('');

    // Initialize database schema
    console.log('Initializing database schema...');
    await initializeSchema();
    console.log('Schema initialized.\n');

    // Create embedding client from YAML config
    const embeddingClient = new EmbeddingClient(
        config.openaiApiKey,
        serverConfig.embedding.model,
        serverConfig.embedding.dimensions,
    );

    // Index each source
    for (const sourceConfig of sources) {
        const start = Date.now();
        console.log(`--- Indexing source: ${sourceConfig.name} (${sourceConfig.type}) ---`);

        const provider = getProvider(sourceConfig.type)(sourceConfig, {
            cloneDir: config.cloneDir,
            githubToken: config.githubToken || undefined,
        });
        const pipeline = new IndexingPipeline(embeddingClient, sourceConfig);
        const result = await provider.fullAcquire();
        if (result.items.length > 0) {
            await pipeline.indexItems(result.items, result.stateToken);
        }

        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`Source "${sourceConfig.name}" indexed ${result.items.length} items in ${elapsed}s\n`);
    }

    const totalElapsed = ((Date.now() - overallStart) / 1000).toFixed(1);
    console.log(`=== Done in ${totalElapsed}s ===`);
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
