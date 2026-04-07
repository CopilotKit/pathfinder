import { describe, it, expect } from 'vitest';
import { globToRegex, matchesPatterns, hasLowSemanticValue } from '../indexing/utils.js';
import type { SourceConfig } from '../types.js';

describe('globToRegex', () => {
    it('matches ** glob patterns', () => {
        expect(globToRegex('**/*.ts').test('src/foo.ts')).toBe(true);
        expect(globToRegex('**/*.ts').test('foo.ts')).toBe(true);
        expect(globToRegex('**/*.ts').test('foo.js')).toBe(false);
    });

    it('matches * glob patterns', () => {
        expect(globToRegex('*.ts').test('foo.ts')).toBe(true);
        expect(globToRegex('*.ts').test('src/foo.ts')).toBe(false);
    });
});

describe('matchesPatterns', () => {
    const config: SourceConfig = {
        name: 'test',
        type: 'code',
        path: '.',
        file_patterns: ['**/*.ts', '**/*.tsx'],
        exclude_patterns: ['**/test/**', '**/*.test.*'],
        chunk: { target_lines: 80, overlap_lines: 10 },
    };

    it('includes matching files', () => {
        expect(matchesPatterns('src/index.ts', config)).toBe(true);
        expect(matchesPatterns('src/deep/path/file.tsx', config)).toBe(true);
    });

    it('excludes matching patterns', () => {
        expect(matchesPatterns('src/test/helper.ts', config)).toBe(false);
        expect(matchesPatterns('src/foo.test.ts', config)).toBe(false);
    });

    it('rejects non-matching extensions', () => {
        expect(matchesPatterns('src/index.js', config)).toBe(false);
    });
});

describe('hasLowSemanticValue', () => {
    it('returns false for short content', () => {
        expect(hasLowSemanticValue('short')).toBe(false);
    });

    it('returns true for SVG-like content', () => {
        const svgData = 'M0,0 L100,100 C50,50 200.5,300.7 '.repeat(100);
        expect(hasLowSemanticValue(svgData)).toBe(true);
    });

    it('returns false for normal text', () => {
        const text = 'This is a normal document with some text content that describes how things work. '.repeat(20);
        expect(hasLowSemanticValue(text)).toBe(false);
    });
});
