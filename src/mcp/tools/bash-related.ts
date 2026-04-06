import type { EmbeddingClient } from '../../indexing/embeddings.js';
import type { ChunkResult } from '../../types.js';

export interface RelatedResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export function parseRelatedCommand(command: string): { isRelated: boolean; path: string } {
    const trimmed = command.trim();
    const match = trimmed.match(/^related\s+(\S+)\s*$/);
    if (match) return { isRelated: true, path: match[1] };
    return { isRelated: false, path: '' };
}

export async function handleRelatedCommand(
    filePath: string,
    fileContent: string | undefined,
    embeddingClient: EmbeddingClient,
    searchChunksFn: (embedding: number[], limit: number) => Promise<ChunkResult[]>,
    limit: number = 10,
): Promise<RelatedResult> {
    if (!fileContent) {
        return {
            stdout: '',
            stderr: `related: ${filePath}: No such file\n`,
            exitCode: 1,
        };
    }

    try {
        // Embed the file's content (truncate to reasonable length for embedding)
        const contentForEmbedding = fileContent.slice(0, 8000);
        const embedding = await embeddingClient.embed(contentForEmbedding);
        const results = await searchChunksFn(embedding, limit);

        // Deduplicate by file_path (keep highest similarity)
        const byFile = new Map<string, { path: string; similarity: number }>();
        for (const r of results) {
            const vPath = r.source_name ? `/${r.source_name}/${r.file_path}` : `/${r.file_path}`;
            if (vPath === filePath) continue; // skip self — exact match only
            const existing = byFile.get(vPath);
            if (!existing || r.similarity > existing.similarity) {
                byFile.set(vPath, { path: vPath, similarity: r.similarity });
            }
        }

        if (byFile.size === 0) {
            return { stdout: 'No related files found.\n', stderr: '', exitCode: 0 };
        }

        const sorted = [...byFile.values()].sort((a, b) => b.similarity - a.similarity);
        const lines = [`Semantically related files for ${filePath}:\n`];
        for (const { path, similarity } of sorted) {
            lines.push(`  ${similarity.toFixed(2)}  ${path}`);
        }
        return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[bash-related] Error: ${msg}`);
        return { stdout: '', stderr: `related: error: ${msg}\n`, exitCode: 1 };
    }
}

export function formatGrepMissSuggestion(searchToolNames: string[]): string {
    if (searchToolNames.length === 0) return '';
    const tools = searchToolNames.join(', ');
    return `\nNo matches found. Try semantic search: qmd "your query" or ${tools}("your query")\n`;
}
