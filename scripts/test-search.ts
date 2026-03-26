// CLI: run test queries against local server or database directly
//
// Usage:
//   npx tsx scripts/test-search.ts "how to use useCopilotAction"
//   npx tsx scripts/test-search.ts --type code "CopilotRuntime"
//   npx tsx scripts/test-search.ts --type docs "getting started" --limit 3
//   npx tsx scripts/test-search.ts --server "how to use useCopilotAction"

import { initializeSchema, getPool } from '../src/db/client.js';
import { getConfig } from '../src/config.js';
import { EmbeddingClient } from '../src/indexing/embeddings.js';
import { searchDocChunks, searchCodeChunks } from '../src/db/queries.js';
import type { DocChunkResult, CodeChunkResult } from '../src/db/queries.js';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function parseArgs() {
    let type: 'docs' | 'code' | 'both' = 'both';
    let limit: number | undefined;
    let server = false;
    let url = '';
    const positional: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--type') {
            const val = args[++i];
            if (val !== 'docs' && val !== 'code') {
                console.error(`Error: --type must be "docs" or "code", got "${val}"`);
                process.exit(1);
            }
            type = val;
        } else if (arg === '--limit') {
            limit = parseInt(args[++i], 10);
            if (isNaN(limit) || limit < 1) {
                console.error('Error: --limit must be a positive integer');
                process.exit(1);
            }
        } else if (arg === '--server') {
            server = true;
        } else if (arg === '--url') {
            server = true;
            url = args[++i];
        } else if (arg === '--help' || arg === '-h') {
            printUsage();
            process.exit(0);
        } else {
            positional.push(arg);
        }
    }

    const query = positional.join(' ').trim();
    if (!query) {
        console.error('Error: no query provided.\n');
        printUsage();
        process.exit(1);
    }

    return { query, type, limit, server, url };
}

function printUsage(): void {
    console.log(`Usage: npx tsx scripts/test-search.ts [options] <query>

Options:
  --type <docs|code>  Search type (default: both)
  --limit <n>         Max results (default: 5 for docs, 10 for code)
  --server            Query via JSON-RPC to the MCP endpoint (default: localhost:3001)
  --url <url>         MCP endpoint URL (implies --server). e.g. https://mcp-server-production-2253.up.railway.app/mcp
  -h, --help          Show this help message
`);
}

// ---------------------------------------------------------------------------
// Direct mode: query database directly
// ---------------------------------------------------------------------------

async function directSearch(
    query: string,
    type: 'docs' | 'code' | 'both',
    limit?: number,
): Promise<void> {
    const config = getConfig();

    console.log('Initializing database schema...');
    await initializeSchema();

    const embeddingClient = new EmbeddingClient(
        config.openaiApiKey,
        config.embeddingModel,
        config.embeddingDimensions,
    );

    console.log(`Embedding query: "${query}"...`);
    const embedStart = Date.now();
    const embedding = await embeddingClient.embed(query);
    const embedMs = Date.now() - embedStart;
    console.log(`Embedding generated in ${embedMs}ms\n`);

    const searchDocs = type === 'docs' || type === 'both';
    const searchCode = type === 'code' || type === 'both';

    if (searchDocs) {
        const docLimit = limit ?? 5;
        console.log(`--- Doc results (limit ${docLimit}) ---\n`);
        const docStart = Date.now();
        const docResults = await searchDocChunks(embedding, docLimit);
        const docMs = Date.now() - docStart;

        if (docResults.length === 0) {
            console.log('No doc results found.\n');
        } else {
            formatDocResults(docResults);
        }
        console.log(`(${docResults.length} results in ${docMs}ms)\n`);
    }

    if (searchCode) {
        const codeLimit = limit ?? 10;
        console.log(`--- Code results (limit ${codeLimit}) ---\n`);
        const codeStart = Date.now();
        const codeResults = await searchCodeChunks(embedding, codeLimit);
        const codeMs = Date.now() - codeStart;

        if (codeResults.length === 0) {
            console.log('No code results found.\n');
        } else {
            formatCodeResults(codeResults);
        }
        console.log(`(${codeResults.length} results in ${codeMs}ms)\n`);
    }
}

// ---------------------------------------------------------------------------
// Server mode: query via JSON-RPC to local MCP server
// ---------------------------------------------------------------------------

async function serverSearch(
    query: string,
    type: 'docs' | 'code' | 'both',
    limit?: number,
    url?: string,
): Promise<void> {
    const baseUrl = url || 'http://localhost:3001/mcp';
    const toolCalls: Array<{ name: string; params: Record<string, unknown> }> = [];

    if (type === 'docs' || type === 'both') {
        toolCalls.push({
            name: 'search-docs',
            params: { query, limit: limit ?? 5 },
        });
    }
    if (type === 'code' || type === 'both') {
        toolCalls.push({
            name: 'search-code',
            params: { query, limit: limit ?? 10 },
        });
    }

    for (const call of toolCalls) {
        console.log(`--- Calling tool: ${call.name} ---\n`);
        const start = Date.now();

        const rpcRequest = {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
                name: call.name,
                arguments: call.params,
            },
        };

        const response = await fetch(baseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rpcRequest),
        });

        if (!response.ok) {
            console.error(`Server returned ${response.status}: ${await response.text()}`);
            continue;
        }

        const body = await response.json() as Record<string, unknown>;
        const elapsed = Date.now() - start;

        if (body.error) {
            const err = body.error as Record<string, unknown>;
            console.error(`RPC error: ${err.message}`);
        } else {
            const result = body.result as Record<string, unknown>;
            const content = result?.content as Array<Record<string, unknown>> | undefined;
            if (content && content.length > 0) {
                for (const item of content) {
                    console.log(item.text);
                }
            } else {
                console.log('No results.');
            }
        }

        console.log(`(${elapsed}ms)\n`);
    }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatDocResults(results: DocChunkResult[]): void {
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const similarity = (r.similarity * 100).toFixed(1);
        console.log(`SNIPPET ${i + 1} [${similarity}% match]`);
        console.log(`  TITLE:   ${r.title}`);
        console.log(`  SOURCE:  ${r.source_url}`);
        console.log(`  CONTENT: ${truncate(r.content, 200)}`);
        console.log('');
    }
}

function formatCodeResults(results: CodeChunkResult[]): void {
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const similarity = (r.similarity * 100).toFixed(1);
        console.log(`SNIPPET ${i + 1} [${similarity}% match]`);
        console.log(`  REPOSITORY: ${r.repo_url}`);
        console.log(`  PATH:       ${r.file_path}:${r.start_line}-${r.end_line}`);
        console.log(`  LANGUAGE:   ${r.language}`);
        console.log(`  CONTENT:    ${truncate(r.content, 200)}`);
        console.log('');
    }
}

function truncate(text: string, maxLen: number): string {
    const oneLine = text.replace(/\n/g, ' ').trim();
    if (oneLine.length <= maxLen) return oneLine;
    return oneLine.slice(0, maxLen) + '...';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const { query, type, limit, server, url } = parseArgs();

const overallStart = Date.now();
console.log(`Query: "${query}"`);
console.log(`Type: ${type} | Limit: ${limit ?? 'default'} | Mode: ${server ? `server (${url || 'localhost:3001'})` : 'direct'}`);
console.log('');

const run = server
    ? serverSearch(query, type, limit, url || undefined)
    : directSearch(query, type, limit);

run
    .then(() => {
        const elapsed = ((Date.now() - overallStart) / 1000).toFixed(1);
        console.log(`=== Total time: ${elapsed}s ===`);
    })
    .catch((err) => {
        console.error('Fatal error:', err);
        process.exit(1);
    })
    .finally(async () => {
        if (!server) {
            try {
                const pool = getPool();
                await pool.end();
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (!msg.includes('DATABASE_URL')) {
                    console.warn('[test-search] Error closing pool:', msg);
                }
            }
        }
    });
