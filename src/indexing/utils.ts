// Shared indexing utilities — used by providers, bash-fs, and test scripts.

import type { SourceConfig } from '../types.js';

/**
 * Check if file content has low semantic value (SVG paths, base64, minified code).
 * Samples the first 8KB and checks the ratio of digits, dots, commas, semicolons,
 * and equals signs. If >30% of characters are these low-value tokens, the file
 * is likely SVG path data, base64, or minified code with no search value.
 */
export function hasLowSemanticValue(content: string): boolean {
    if (content.length < 500) return false;

    const sample = content.slice(0, 8192);
    let lowValueChars = 0;

    for (let i = 0; i < sample.length; i++) {
        const c = sample.charCodeAt(i);
        if (
            (c >= 48 && c <= 57) ||  // 0-9
            c === 46 ||               // .
            c === 44 ||               // ,
            c === 59 ||               // ;
            c === 61                  // =
        ) {
            lowValueChars++;
        }
    }

    const ratio = lowValueChars / sample.length;
    return ratio > 0.3;
}

/**
 * Convert a glob pattern to a RegExp.
 * Supports: ** (any path), * (any segment), ? (any char)
 */
export function globToRegex(pattern: string): RegExp {
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
 * Check if a relative file path matches the source's file_patterns (include)
 * and does not match exclude_patterns.
 */
export function matchesPatterns(relPath: string, sourceConfig: SourceConfig): boolean {
    const normalized = relPath.replace(/\\/g, '/');

    // Check excludes first (takes precedence)
    const excludes = sourceConfig.exclude_patterns ?? [];
    for (const pattern of excludes) {
        if (globToRegex(pattern).test(normalized)) {
            return false;
        }
    }

    // Must match at least one include pattern
    for (const pattern of sourceConfig.file_patterns) {
        if (globToRegex(pattern).test(normalized)) {
            return true;
        }
    }

    return false;
}
