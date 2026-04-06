import type { EmbeddingClient } from '../../indexing/embeddings.js';
import type { ChunkResult } from '../../types.js';

export interface ParsedGrep {
    isGrep: boolean;
    pattern: string;
    flags: string[];
    paths: string[];
}

/** Flags that consume the next token as their argument. */
const FLAGS_WITH_ARGS = new Set(['-e', '-m', '-f', '-A', '-B', '-C']);

export function parseGrepCommand(command: string): ParsedGrep {
    const trimmed = command.trim();
    if (trimmed.includes('|') || trimmed.includes(';') || trimmed.includes('&&')) {
        return { isGrep: false, pattern: '', flags: [], paths: [] };
    }
    if (!trimmed.startsWith('grep ') && trimmed !== 'grep') {
        return { isGrep: false, pattern: '', flags: [], paths: [] };
    }
    const tokens: string[] = [];
    let i = 5;
    while (i < trimmed.length) {
        while (i < trimmed.length && trimmed[i] === ' ') i++;
        if (i >= trimmed.length) break;
        if (trimmed[i] === '"' || trimmed[i] === "'") {
            const quote = trimmed[i]; i++;
            let token = '';
            while (i < trimmed.length && trimmed[i] !== quote) { token += trimmed[i]; i++; }
            i++;
            tokens.push(token);
        } else {
            let token = '';
            while (i < trimmed.length && trimmed[i] !== ' ') { token += trimmed[i]; i++; }
            tokens.push(token);
        }
    }
    const flags: string[] = [];
    let pattern = '';
    const paths: string[] = [];
    let patternFound = false;
    for (let t = 0; t < tokens.length; t++) {
        const token = tokens[t];
        if (token.startsWith('-') && !patternFound) {
            flags.push(token);
            // If this flag takes an argument, consume the next token too
            if (FLAGS_WITH_ARGS.has(token) && t + 1 < tokens.length) {
                t++;
                flags.push(tokens[t]);
            }
        }
        else if (!patternFound) { pattern = token; patternFound = true; }
        else { paths.push(token); }
    }
    if (!pattern) return { isGrep: false, pattern: '', flags: [], paths: [] };
    if (paths.length === 0) paths.push('/');
    return { isGrep: true, pattern, flags, paths };
}

export interface ParsedQmd {
    isQmd: boolean;
    query: string;
}

export function parseQmdCommand(command: string): ParsedQmd {
    const trimmed = command.trim();
    // Reject piped/chained commands
    if (trimmed.includes('|') || trimmed.includes(';') || trimmed.includes('&&')) {
        return { isQmd: false, query: '' };
    }
    if (!trimmed.startsWith('qmd ') && trimmed !== 'qmd') {
        return { isQmd: false, query: '' };
    }
    // Extract the query after "qmd "
    const rest = trimmed.slice(4).trim();
    if (!rest) return { isQmd: false, query: '' };
    // Handle quoted query: qmd "query" or qmd 'query'
    if ((rest.startsWith('"') && rest.endsWith('"')) || (rest.startsWith("'") && rest.endsWith("'"))) {
        const query = rest.slice(1, -1);
        if (!query) return { isQmd: false, query: '' };
        return { isQmd: true, query };
    }
    // Unquoted: qmd query words here
    return { isQmd: true, query: rest };
}

export interface VectorGrepOptions {
    pattern: string;
    sourceName?: string;
    embeddingClient: EmbeddingClient;
    searchChunksFn: (embedding: number[], limit: number, sourceName?: string) => Promise<ChunkResult[]>;
    textSearchFn: (pattern: string, limit: number, sourceName?: string) => Promise<ChunkResult[]>;
    limit?: number;
}

export interface GrepResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function vectorGrep(options: VectorGrepOptions): Promise<GrepResult> {
    const { pattern, sourceName, embeddingClient, searchChunksFn, textSearchFn, limit = 20 } = options;
    let semanticResults: ChunkResult[] = [];
    let semanticError: string | null = null;
    try {
        const embedding = await embeddingClient.embed(pattern);
        semanticResults = await searchChunksFn(embedding, limit, sourceName);
    } catch (err) {
        semanticError = err instanceof Error ? err.message : String(err);
        console.warn(`[bash-grep] Semantic search failed: ${semanticError}`);
    }
    let textResults: ChunkResult[] = [];
    let textError: string | null = null;
    try {
        textResults = await textSearchFn(pattern, limit, sourceName);
    } catch (err) {
        textError = err instanceof Error ? err.message : String(err);
        console.warn(`[bash-grep] Text search failed: ${textError}`);
    }
    if (semanticResults.length === 0 && textResults.length === 0 && semanticError && textError) {
        return {
            stdout: '',
            stderr: `grep: search unavailable (semantic: ${semanticError}, text: ${textError})\n`,
            exitCode: 2,
        };
    }
    const seenIds = new Set<number>();
    const allResults: ChunkResult[] = [];
    for (const r of [...textResults, ...semanticResults]) {
        if (!seenIds.has(r.id)) { seenIds.add(r.id); allResults.push(r); }
    }
    const regex = new RegExp(escapeRegex(pattern), 'i');
    const matching = allResults.filter(r => regex.test(r.content));
    if (matching.length === 0) return { stdout: '', stderr: '', exitCode: 1 };
    const lines: string[] = [];
    for (const r of matching) {
        const contentLines = r.content.split('\n');
        const startLine = r.start_line ?? 1;
        for (let i = 0; i < contentLines.length; i++) {
            if (regex.test(contentLines[i])) {
                lines.push(`/${r.file_path}:${startLine + i}:${contentLines[i]}`);
            }
        }
    }
    if (lines.length === 0) return { stdout: '', stderr: '', exitCode: 1 };
    return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
}
