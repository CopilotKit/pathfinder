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

/**
 * Parse SSE response body into JSON-RPC messages.
 */
function parseSseMessages(text: string): Record<string, unknown>[] {
    const messages: Record<string, unknown>[] = [];
    for (const line of text.split('\n')) {
        if (line.startsWith('data: ')) {
            try {
                messages.push(JSON.parse(line.slice(6).trim()) as Record<string, unknown>);
            } catch { /* skip */ }
        }
    }
    return messages;
}

/**
 * Send a JSON-RPC request to the MCP endpoint. Returns parsed messages and session ID.
 */
async function mcpPost(
    baseUrl: string,
    body: unknown,
    sessionId?: string,
): Promise<{ messages: Record<string, unknown>[]; sessionId: string | null }> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    const response = await fetch(baseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });

    const sid = response.headers.get('mcp-session-id');

    if (response.status === 202) {
        return { messages: [], sessionId: sid ?? sessionId ?? null };
    }

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text}`);
    }

    const text = await response.text();
    const messages = parseSseMessages(text);
    if (messages.length === 0 && text.trim()) {
        try {
            return { messages: [JSON.parse(text) as Record<string, unknown>], sessionId: sid ?? sessionId ?? null };
        } catch {
            throw new Error(`Unparseable response: ${text.slice(0, 200)}`);
        }
    }
    return { messages, sessionId: sid ?? sessionId ?? null };
}

async function serverSearch(
    query: string,
    type: 'docs' | 'code' | 'both',
    limit?: number,
    url?: string,
): Promise<void> {
    const baseUrl = url || 'http://localhost:3001/mcp';

    // Step 1: Initialize to get a session
    console.log('Connecting to MCP server...');
    const initResp = await mcpPost(baseUrl, {
        jsonrpc: '2.0',
        method: 'initialize',
        id: 0,
        params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test-search', version: '1.0.0' },
        },
    });

    const sid = initResp.sessionId;
    if (!sid) {
        console.error('No session ID returned — server may be in stateless mode without session support');
    }

    // Send initialized notification
    await mcpPost(baseUrl, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid ?? undefined);

    // Step 2: Call tools
    const toolCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
    if (type === 'docs' || type === 'both') {
        toolCalls.push({ name: 'search-docs', params: { query, limit: limit ?? 5 } });
    }
    if (type === 'code' || type === 'both') {
        toolCalls.push({ name: 'search-code', params: { query, limit: limit ?? 10 } });
    }

    let callId = 1;
    for (const call of toolCalls) {
        console.log(`\n--- ${call.name} ---\n`);
        const start = Date.now();

        const resp = await mcpPost(baseUrl, {
            jsonrpc: '2.0',
            method: 'tools/call',
            id: callId++,
            params: { name: call.name, arguments: call.params },
        }, sid ?? undefined);

        const elapsed = Date.now() - start;
        const toolResp = resp.messages.find((m) => m.result || m.error);

        if (toolResp?.error) {
            const err = toolResp.error as Record<string, unknown>;
            console.error(`Error: ${err.message}`);
        } else if (toolResp?.result) {
            const result = toolResp.result as Record<string, unknown>;
            const content = result?.content as Array<Record<string, unknown>> | undefined;
            if (content && content.length > 0) {
                for (const item of content) {
                    console.log(item.text);
                }
            } else {
                console.log('No results.');
            }
        } else {
            console.log('No response.');
        }

        console.log(`(${elapsed}ms)`);
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
