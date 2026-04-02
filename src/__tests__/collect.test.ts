import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { yamlSchemaToZod } from '../mcp/tools/collect.js';
import type { CollectToolConfig } from '../types.js';

type Schema = CollectToolConfig['schema'];

describe('yamlSchemaToZod', () => {
    it('converts string fields', () => {
        const schema: Schema = {
            name: { type: 'string', required: true },
        };
        const shape = yamlSchemaToZod(schema);
        const zod = z.object(shape);

        expect(zod.parse({ name: 'hello' })).toEqual({ name: 'hello' });
        expect(() => zod.parse({ name: 123 })).toThrow();
        expect(() => zod.parse({})).toThrow();
    });

    it('converts number fields', () => {
        const schema: Schema = {
            count: { type: 'number', required: true },
        };
        const shape = yamlSchemaToZod(schema);
        const zod = z.object(shape);

        expect(zod.parse({ count: 42 })).toEqual({ count: 42 });
        expect(() => zod.parse({ count: 'not a number' })).toThrow();
    });

    it('converts enum fields', () => {
        const schema: Schema = {
            rating: { type: 'enum', values: ['good', 'bad'], required: true },
        };
        const shape = yamlSchemaToZod(schema);
        const zod = z.object(shape);

        expect(zod.parse({ rating: 'good' })).toEqual({ rating: 'good' });
        expect(() => zod.parse({ rating: 'neutral' })).toThrow();
    });

    it('makes fields optional when required is false', () => {
        const schema: Schema = {
            comment: { type: 'string', required: false },
        };
        const shape = yamlSchemaToZod(schema);
        const zod = z.object(shape);

        expect(zod.parse({})).toEqual({});
        expect(zod.parse({ comment: 'hi' })).toEqual({ comment: 'hi' });
    });

    it('makes fields optional when required is omitted', () => {
        const schema: Schema = {
            comment: { type: 'string' },
        };
        const shape = yamlSchemaToZod(schema);
        const zod = z.object(shape);

        expect(zod.parse({})).toEqual({});
    });

    it('attaches descriptions', () => {
        const schema: Schema = {
            query: { type: 'string', description: 'The search query', required: true },
        };
        const shape = yamlSchemaToZod(schema);

        expect(shape.query.description).toBe('The search query');
    });

    it('rejects invalid inputs against the feedback schema', () => {
        const schema: Schema = {
            tool_name: { type: 'string', required: true },
            query: { type: 'string', required: true },
            rating: { type: 'enum', values: ['helpful', 'not_helpful'], required: true },
            comment: { type: 'string', required: true },
        };
        const shape = yamlSchemaToZod(schema);
        const zod = z.object(shape);

        // completely empty
        expect(zod.safeParse({}).success).toBe(false);

        // missing required fields
        expect(zod.safeParse({ tool_name: 'search-docs' }).success).toBe(false);

        // wrong type for string field
        expect(zod.safeParse({
            tool_name: 123, query: 'test', rating: 'helpful', comment: 'ok',
        }).success).toBe(false);

        // invalid enum value
        expect(zod.safeParse({
            tool_name: 'search-docs', query: 'test', rating: 'meh', comment: 'ok',
        }).success).toBe(false);

        // wrong type for enum field
        expect(zod.safeParse({
            tool_name: 'search-docs', query: 'test', rating: 42, comment: 'ok',
        }).success).toBe(false);
    });

    it('throws on unsupported field type', () => {
        const schema = {
            flag: { type: 'boolean' as unknown as 'string', required: true },
        };
        expect(() => yamlSchemaToZod(schema)).toThrow('Unsupported field type "boolean" for field "flag"');
    });

    it('handles a full feedback schema', () => {
        const schema: Schema = {
            tool_name: { type: 'string', description: 'Which tool', required: true },
            query: { type: 'string', description: 'The query', required: true },
            rating: { type: 'enum', values: ['helpful', 'not_helpful'], description: 'Rating', required: true },
            comment: { type: 'string', description: 'Details', required: true },
        };
        const shape = yamlSchemaToZod(schema);
        const zod = z.object(shape);

        const valid = { tool_name: 'search-docs', query: 'how to auth', rating: 'helpful', comment: 'worked great' };
        expect(zod.parse(valid)).toEqual(valid);

        expect(() => zod.parse({ ...valid, rating: 'meh' })).toThrow();
        expect(() => zod.parse({ tool_name: 'search-docs', query: 'test', rating: 'helpful' })).toThrow();
    });
});
