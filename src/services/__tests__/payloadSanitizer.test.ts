import { describe, it, expect } from 'vitest';
import { sanitizePayloadForApi } from '../lib/payloadSanitizer';

const user = (content: string) => ({ role: 'user', content });
const assistant = (content: string) => ({ role: 'assistant', content });
const assistantWithTools = (calls: any[]) => ({ role: 'assistant', content: null, tool_calls: calls });
const toolMsg = (id: string, result: string) => ({ role: 'tool', tool_call_id: id, content: result });
const validCall = (id: string, name = 'query_campaign_lore') => ({
    type: 'function', id, function: { name, arguments: '{}' },
});

describe('sanitizePayloadForApi', () => {
    it('returns empty array for empty input', () => {
        expect(sanitizePayloadForApi([], true)).toEqual([]);
        expect(sanitizePayloadForApi([], false)).toEqual([]);
    });

    it('passes through user and plain assistant messages unchanged', () => {
        const payload = [user('hello'), assistant('hi')];
        expect(sanitizePayloadForApi(payload, true)).toEqual(payload);
        expect(sanitizePayloadForApi(payload, false)).toEqual(payload);
    });

    it('skips null/non-object entries', () => {
        const payload = [null, undefined, 'string', user('ok')];
        expect(sanitizePayloadForApi(payload as any, true)).toEqual([user('ok')]);
    });

    it('strips tool_calls from assistant when allowTools=false', () => {
        const payload = [assistantWithTools([validCall('c1')])];
        const result = sanitizePayloadForApi(payload, false);
        expect(result).toHaveLength(1);
        expect(result[0].tool_calls).toBeUndefined();
        expect(result[0].content).toBeNull();
    });

    it('strips empty tool_calls array from assistant even when allowTools=true', () => {
        const payload = [{ role: 'assistant', content: null, tool_calls: [] }];
        const result = sanitizePayloadForApi(payload, true);
        expect(result).toHaveLength(1);
        expect(result[0].tool_calls).toBeUndefined();
    });

    it('filters invalid tool_calls (missing id)', () => {
        const badCall = { type: 'function', function: { name: 'query_campaign_lore', arguments: '{}' } };
        const payload = [assistantWithTools([badCall])];
        const result = sanitizePayloadForApi(payload, true);
        expect(result).toHaveLength(1);
        expect(result[0].tool_calls).toBeUndefined();
    });

    it('filters invalid tool_calls (missing function.name)', () => {
        const badCall = { type: 'function', id: 'c1', function: { arguments: '{}' } };
        const payload = [assistantWithTools([badCall])];
        const result = sanitizePayloadForApi(payload, true);
        expect(result[0].tool_calls).toBeUndefined();
    });

    it('keeps valid tool_calls and matching tool response', () => {
        const payload = [
            assistantWithTools([validCall('c1')]),
            toolMsg('c1', 'lore result'),
        ];
        const result = sanitizePayloadForApi(payload, true);
        expect(result).toHaveLength(2);
        expect(result[0].tool_calls).toHaveLength(1);
        expect(result[1].role).toBe('tool');
    });

    it('drops orphan tool message with no matching open call', () => {
        const payload = [user('hi'), toolMsg('nonexistent', 'stale result')];
        const result = sanitizePayloadForApi(payload, true);
        expect(result).toHaveLength(1);
        expect(result[0].role).toBe('user');
    });

    it('drops tool message when allowTools=false even with matching call', () => {
        const payload = [
            assistantWithTools([validCall('c1')]),
            toolMsg('c1', 'result'),
        ];
        const result = sanitizePayloadForApi(payload, false);
        // assistant has tool_calls stripped; tool msg dropped
        expect(result).toHaveLength(1);
        expect(result[0].tool_calls).toBeUndefined();
    });

    it('drops second tool message for same call_id (already consumed)', () => {
        const payload = [
            assistantWithTools([validCall('c1')]),
            toolMsg('c1', 'first'),
            toolMsg('c1', 'duplicate'),
        ];
        const result = sanitizePayloadForApi(payload, true);
        expect(result).toHaveLength(2);
        expect(result[1].content).toBe('first');
    });
});
