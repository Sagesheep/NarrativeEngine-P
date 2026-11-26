/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { extractJsonRobust, extractJson } from '../infrastructure/jsonExtract';

describe('extractJsonRobust', () => {
    describe('object root', () => {
        it('parses a clean JSON object', () => {
            const raw = '{"groups":[{"name":"a","factIds":["1"]}]}';
            const { value, parseOk } = extractJsonRobust(raw, { groups: [] });
            expect(parseOk).toBe(true);
            expect(value.groups).toHaveLength(1);
            expect((value.groups as { name: string }[])[0].name).toBe('a');
        });

        it('strips think blocks before parsing', () => {
            const raw = '<think>reasoning here</think>{"groups":[]}';
            const { value, parseOk } = extractJsonRobust(raw, { groups: [] });
            expect(parseOk).toBe(true);
            expect(value.groups).toHaveLength(0);
        });

        it('strips markdown fences', () => {
            const raw = '```json\n{"groups":[{"name":"x","factIds":["1","2"]}]}\n```';
            const { value, parseOk } = extractJsonRobust(raw, { groups: [] });
            expect(parseOk).toBe(true);
            expect((value.groups as { name: string }[])[0].name).toBe('x');
        });

        it('recovers from truncated object at depth 1', () => {
            const raw = '{"groups":[{"name":"a","factIds":["1"]},{"name":"b","factIds":["2"';
            const { value, parseOk } = extractJsonRobust(raw, { groups: [] });
            expect(parseOk).toBe(true);
            expect(value.groups).toHaveLength(1);
            expect((value.groups as { name: string }[])[0].name).toBe('a');
        });

        it('handles escaped strings inside JSON', () => {
            const raw = '{"groups":[{"name":"he said \\"hello\\"","factIds":["1"]}]}';
            const { value, parseOk } = extractJsonRobust(raw, { groups: [] });
            expect(parseOk).toBe(true);
            expect((value.groups as { name: string }[])[0].name).toBe('he said "hello"');
        });

        it('returns fallback when no JSON found', () => {
            const raw = 'no json here at all';
            const { value, parseOk } = extractJsonRobust(raw, { groups: [] });
            expect(parseOk).toBe(false);
            expect(value.groups).toHaveLength(0);
        });

        it('handles nested objects', () => {
            const raw = '{"a":{"b":2},"c":3}';
            const { value, parseOk } = extractJsonRobust<Record<string, unknown>>(raw, {});
            expect(parseOk).toBe(true);
            expect((value as any).a.b).toBe(2);
        });
    });

    describe('array root', () => {
        it('parses a clean JSON array', () => {
            const raw = '[1, 2, 3]';
            const { value, parseOk } = extractJsonRobust<number[]>(raw, []);
            expect(parseOk).toBe(true);
            expect(value).toEqual([1, 2, 3]);
        });

        it('parses a JSON array of strings', () => {
            const raw = '["014","012","001"]';
            const { value, parseOk } = extractJsonRobust<string[]>(raw, []);
            expect(parseOk).toBe(true);
            expect(value).toEqual(['014', '012', '001']);
        });

        it('recovers from truncated array at depth 1', () => {
            const raw = '["a","b","c';
            const { value, parseOk } = extractJsonRobust<string[]>(raw, []);
            expect(parseOk).toBe(true);
            expect(value).toEqual(['a', 'b']);
        });

        it('handles think blocks + markdown with array', () => {
            const raw = '<think>thinking</think>```json\n[1,2,3]\n```';
            const { value, parseOk } = extractJsonRobust<number[]>(raw, []);
            expect(parseOk).toBe(true);
            expect(value).toEqual([1, 2, 3]);
        });

        it('extracts first root-level JSON when both { and [ present', () => {
            const raw = 'prefix [1,2] and {"a":3}';
            const { value, parseOk } = extractJsonRobust<unknown>(raw, null);
            expect(parseOk).toBe(true);
            expect(Array.isArray(value)).toBe(true);
            expect(value).toEqual([1, 2]);
        });

        it('returns fallback when no array found', () => {
            const raw = 'just text no brackets';
            const { value, parseOk } = extractJsonRobust<string[]>(raw, []);
            expect(parseOk).toBe(false);
            expect(value).toEqual([]);
        });
    });
});

describe('extractJson', () => {
    it('strips <think>...</think> blocks before extracting', () => {
        const input = '<think>some internal reasoning</think>{"key":"value"}';
        const result = extractJson(input);
        expect(JSON.parse(result)).toEqual({ key: 'value' });
        expect(result).not.toContain('<think>');
    });

    it('unwraps a ```json fenced code block', () => {
        const input = '```json\n{"name":"Alice","level":5}\n```';
        const result = extractJson(input);
        expect(JSON.parse(result)).toEqual({ name: 'Alice', level: 5 });
    });

    it('repairs a trailing comma before }', () => {
        const input = '{"a":1,"b":2,}';
        const result = extractJson(input);
        expect(JSON.parse(result)).toEqual({ a: 1, b: 2 });
    });

    it('repairs a trailing comma before ]', () => {
        const input = '{"items":["x","y",]}';
        const result = extractJson(input);
        expect(JSON.parse(result)).toEqual({ items: ['x', 'y'] });
    });

    it('converts single-quoted string values to double-quoted', () => {
        const input = "{'key': 'hello'}";
        // repairJson converts single-quoted values; result should be parseable
        const result = extractJson(input);
        // After repair the value should be accessible
        expect(result).toContain('"hello"');
    });

    it('selects object root when { precedes [', () => {
        // { before [ — extractJson starts at { and ends at last }, so object wins
        const input = 'preamble {"items":[1,2,3]}';
        const result = extractJson(input);
        const parsed = JSON.parse(result);
        expect(parsed).toHaveProperty('items');
        expect(Array.isArray(parsed.items)).toBe(true);
    });

    it('selects array root when [ precedes {', () => {
        // [ before any { — extractJson starts at [ and ends at last ]
        const input = 'preamble [1,2,3]';
        const result = extractJson(input);
        const parsed = JSON.parse(result);
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed).toEqual([1, 2, 3]);
    });

    it('trims and returns input as-is when no JSON present', () => {
        const input = '   just plain text   ';
        const result = extractJson(input);
        expect(result).toBe('just plain text');
    });
});

// Documents the response shapes deepArchiveSearch relies on after migrating
// off its local extractJson onto extractJsonRobust (the canonical parser).
describe('deepArchiveSearch response contract', () => {
    it('parses a chapter-scan response with chatter + fence', () => {
        const raw = 'Here are the chapters:\n```json\n{"chapters":["CH01","CH03"]}\n```';
        const { value, parseOk } = extractJsonRobust<{ chapters?: string[] }>(raw, {});
        expect(parseOk).toBe(true);
        expect(value.chapters).toEqual(['CH01', 'CH03']);
    });

    it('recovers a scene-scan response missing its closing brace', () => {
        // Array closed but outer object truncated — recoverable.
        const raw = '{"scenes":["042","011"]';
        const { value, parseOk } = extractJsonRobust<{ scenes?: string[] }>(raw, {});
        expect(parseOk).toBe(true);
        expect(value.scenes).toEqual(['042', '011']);
    });

    it('returns fallback (parseOk=false) when the model emits no JSON', () => {
        const raw = 'I could not find any relevant chapters.';
        const { value, parseOk } = extractJsonRobust<{ chapters?: string[] }>(raw, {});
        expect(parseOk).toBe(false);
        expect(value.chapters).toBeUndefined();
    });
});