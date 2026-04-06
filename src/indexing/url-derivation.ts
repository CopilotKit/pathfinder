// Configurable URL derivation from file paths based on source config.

import type { SourceConfig } from '../types.js';

/**
 * Derive a public URL from a relative file path using the source's URL derivation rules.
 * Returns null if the source has no base_url or url_derivation configured.
 */
export function deriveUrl(filePath: string, sourceConfig: SourceConfig): string | null {
    if (!sourceConfig.base_url || !sourceConfig.url_derivation) return null;

    const d = sourceConfig.url_derivation;
    let slug = filePath;

    if (d.strip_prefix && slug.startsWith(d.strip_prefix)) {
        slug = slug.slice(d.strip_prefix.length);
    }
    if (d.strip_suffix) {
        const re = new RegExp(escapeRegex(d.strip_suffix) + '$');
        slug = slug.replace(re, '');
    }
    if (d.strip_route_groups) {
        slug = slug.replace(/\([^)]+\)\//g, '');
    }
    if (d.strip_index) {
        slug = slug.replace(/\/index$/, '');
        if (slug === 'index') slug = '';
    }

    return sourceConfig.base_url + slug;
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
