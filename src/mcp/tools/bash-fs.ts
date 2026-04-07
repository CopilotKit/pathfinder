import fs from 'node:fs';
import path from 'node:path';
import { Bash } from 'just-bash';
import { matchesPatterns } from '../../indexing/utils.js';
import type { SourceConfig } from '../../types.js';
import { generateIndexMd, generateSearchTipsMd } from './bash-virtual-files.js';

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

export interface BashFilesMapOptions {
    virtualFiles?: boolean;
    searchToolNames?: string[];
    cloneDir?: string;
}

export async function buildBashFilesMap(
    sources: SourceConfig[],
    options?: BashFilesMapOptions,
): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    const multiSource = sources.length > 1;

    for (const source of sources) {
        let rootDir: string;
        if (source.repo && options?.cloneDir) {
            // Git-based source: the orchestrator clones into cloneDir/<repoName>/
            const repoName = source.repo.replace(/\.git$/, '').split('/').pop()!;
            rootDir = path.join(options.cloneDir, repoName, source.path);
        } else {
            rootDir = path.resolve(source.path);
        }
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

    if (options?.virtualFiles) {
        files['/INDEX.md'] = generateIndexMd(files);
        files['/SEARCH_TIPS.md'] = generateSearchTipsMd(options.searchToolNames ?? []);
    }

    return files;
}

export interface FileMetadata {
    size: number;
    lines: number;
}

export function buildFileMetadata(files: Record<string, string>): Record<string, FileMetadata> {
    const meta: Record<string, FileMetadata> = {};
    for (const [path, content] of Object.entries(files)) {
        const size = Buffer.byteLength(content, 'utf-8');
        const lines = content === '' ? 0 : content.endsWith('\n')
            ? content.split('\n').length - 1
            : content.split('\n').length;
        meta[path] = { size, lines };
    }
    return meta;
}

export function formatLsLong(
    dir: string,
    allPaths: string[],
    metadata: Record<string, FileMetadata>,
): string {
    const normalizedDir = dir.endsWith('/') ? dir : dir + '/';
    const files: string[] = [];
    const subdirs = new Set<string>();

    for (const p of allPaths) {
        if (!p.startsWith(normalizedDir)) continue;
        const rest = p.slice(normalizedDir.length);
        const slashIdx = rest.indexOf('/');
        if (slashIdx === -1) {
            files.push(p);
        } else {
            subdirs.add(rest.slice(0, slashIdx));
        }
    }

    const lines: string[] = [];
    for (const d of [...subdirs].sort()) {
        lines.push(`drwxr-xr-x  ${d}/`);
    }
    for (const f of files.sort()) {
        const name = f.slice(normalizedDir.length);
        const meta = metadata[f];
        if (meta) {
            const sizeStr = String(meta.size).padStart(8);
            lines.push(`-rw-r--r--  ${sizeStr}  ${meta.lines} lines  ${name}`);
        } else {
            lines.push(`-rw-r--r--  ${name}`);
        }
    }
    return lines.join('\n') + '\n';
}

export async function rebuildBashInstance(
    sources: SourceConfig[],
    options?: BashFilesMapOptions,
): Promise<{ bash: Bash; fileCount: number }> {
    const filesMap = await buildBashFilesMap(sources, { ...options });
    return {
        bash: new Bash({ files: filesMap, cwd: '/' }),
        fileCount: Object.keys(filesMap).length,
    };
}
