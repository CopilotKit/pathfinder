import fs from 'node:fs';
import path from 'node:path';
import { matchesPatterns } from '../../indexing/source-indexer.js';
import type { SourceConfig } from '../../types.js';

const DEFAULT_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git']);
const DEFAULT_MAX_FILE_SIZE = 102400; // 100KB

async function walkFiles(
    dir: string,
    skipDirs: Set<string>,
    maxFileSize: number,
): Promise<string[]> {
    const results: string[] = [];
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
        console.warn(`[bash-fs] Failed to read directory ${dir}:`, err);
        return results;
    }
    for (const entry of entries) {
        if (skipDirs.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...await walkFiles(fullPath, skipDirs, maxFileSize));
        } else if (entry.isFile()) {
            try {
                const stat = await fs.promises.stat(fullPath);
                if (stat.size <= maxFileSize) results.push(fullPath);
            } catch (err) {
                console.warn(`[bash-fs] Failed to stat ${fullPath}:`, err);
                continue;
            }
        }
    }
    return results;
}

export async function buildBashFilesMap(
    sources: SourceConfig[],
): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    const multiSource = sources.length > 1;

    for (const source of sources) {
        const rootDir = path.resolve(source.path);
        if (!fs.existsSync(rootDir)) {
            console.warn(`[bash-fs] Source "${source.name}" path does not exist: ${rootDir}`);
            continue;
        }

        const skipDirs = new Set([...DEFAULT_SKIP_DIRS, ...(source.skip_dirs ?? [])]);
        const maxFileSize = source.max_file_size ?? DEFAULT_MAX_FILE_SIZE;
        const allFiles = await walkFiles(rootDir, skipDirs, maxFileSize);

        for (const absPath of allFiles) {
            const relPath = path.relative(rootDir, absPath);
            if (!matchesPatterns(relPath, source)) continue;

            let content: string;
            try {
                content = await fs.promises.readFile(absPath, 'utf-8');
            } catch (err) {
                console.warn(`[bash-fs] Failed to read ${absPath}, skipping:`, err);
                continue;
            }
            const virtualPath = multiSource
                ? `/${source.name}/${relPath}`
                : `/${relPath}`;
            files[virtualPath] = content;
        }
    }

    return files;
}
