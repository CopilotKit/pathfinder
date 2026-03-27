// Path filtering for indexing — controls which files get indexed via include/exclude globs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface PathFilterConfig {
    docs: {
        include: string[];
        exclude: string[];
    };
    code: {
        include: string[];
        exclude: string[];
    };
}

let cachedConfig: PathFilterConfig | null = null;

/**
 * Load the index-config.json file. Checks repo root (dev) and dist parent (prod).
 */
function loadConfig(): PathFilterConfig {
    if (cachedConfig) return cachedConfig;

    const candidates = [
        join(__dirname, '..', '..', 'index-config.json'),   // dev: src/indexing/ -> root
        join(__dirname, '..', 'index-config.json'),          // prod: dist/indexing/ -> dist/../
        join(__dirname, '..', '..', '..', 'index-config.json'), // fallback
    ];

    for (const candidate of candidates) {
        try {
            const raw = readFileSync(candidate, 'utf-8');
            cachedConfig = JSON.parse(raw) as PathFilterConfig;
            return cachedConfig;
        } catch {
            continue;
        }
    }

    // Default: no filters
    cachedConfig = { docs: { include: [], exclude: [] }, code: { include: [], exclude: [] } };
    return cachedConfig;
}

/**
 * Convert a glob pattern to a RegExp.
 * Supports: ** (any path), * (any segment), ? (any char)
 */
function globToRegex(pattern: string): RegExp {
    let re = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex chars (except * and ?)
        .replace(/\*\*\//g, '{{GLOBSTAR_SLASH}}') // **/ = any path prefix (including empty)
        .replace(/\*\*/g, '{{GLOBSTAR}}')          // ** alone = anything
        .replace(/\*/g, '[^/]*')                    // * = anything except /
        .replace(/\?/g, '[^/]')                     // ? = single char except /
        .replace(/\{\{GLOBSTAR_SLASH\}\}/g, '(?:.*/)?') // **/ = optional path prefix
        .replace(/\{\{GLOBSTAR\}\}/g, '.*');             // ** = anything including /

    return new RegExp(`^${re}$`);
}

/**
 * Check if a relative file path should be indexed, given include/exclude rules.
 *
 * Rules:
 * - If include is non-empty, the path MUST match at least one include pattern
 * - If exclude is non-empty, the path must NOT match any exclude pattern
 * - Exclude takes precedence over include
 */
export function shouldIndex(relPath: string, source: 'docs' | 'code'): boolean {
    const config = loadConfig();
    const rules = config[source];

    // Normalize path separators
    const normalized = relPath.replace(/\\/g, '/');

    // Check excludes first (takes precedence)
    if (rules.exclude.length > 0) {
        for (const pattern of rules.exclude) {
            if (globToRegex(pattern).test(normalized)) {
                return false;
            }
        }
    }

    // Check includes (if specified, path must match at least one)
    if (rules.include.length > 0) {
        for (const pattern of rules.include) {
            if (globToRegex(pattern).test(normalized)) {
                return true;
            }
        }
        return false; // didn't match any include
    }

    return true; // no include rules = include everything (that wasn't excluded)
}

/**
 * Get the current filter config for logging purposes.
 */
export function getPathFilterConfig(): PathFilterConfig {
    return loadConfig();
}
