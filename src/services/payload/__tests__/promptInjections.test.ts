import { describe, it, expect } from 'vitest';
import { applyInjections, injectionTrigger, normalizeInjections, planInjections } from '../promptInjections';
import type { PromptInjection, EndpointConfig } from '../../../types';
import type { OpenAIMessage } from '../../llm/llmService';
import { buildChatBody } from '../../../utils/llmApiHelper';
import { migrateSettings, defaultSettings } from '../../../store/slices/settingsHelpers';

const item = (patch: Partial<PromptInjection> = {}): PromptInjection => ({
    id: 'a', name: 'Reminder', enabled: true, role: 'system', content: 'Remember the rain',
    depth: 0, mode: 'message', triggers: ['reply', 'swipe', 'continue'], ...patch,
});
const messages: OpenAIMessage[] = [
    { role: 'system', content: 'Rules', cache_control: { type: 'ephemeral' } },
    { role: 'user', content: 'Old player' },
    { role: 'assistant', content: 'Old narrator', cache_control: { type: 'ephemeral' } },
    { role: 'user', content: 'New player' },
];

describe('prompt injection placement', () => {
    it.each([[0, 4], [1, 3], [2, 2], [999, 1]])('places depth %s at index %s without crossing context', (depth, index) => {
        expect(planInjections(messages, [item({ depth })], 'reply')[0].index).toBe(index);
    });
    it('preserves same-depth card order, explicit roles, cached markers and input snapshots', () => {
        const original = structuredClone(messages);
        const inputs = [item({ content: 'First', role: 'assistant', depth: 1 }), item({ id: 'b', content: 'Second', role: 'user', depth: 1 })];
        const result = applyInjections(messages, inputs, 'reply');
        expect(result.slice(3, 5)).toEqual([{ role: 'assistant', content: 'First' }, { role: 'user', content: 'Second' }]);
        expect(messages).toEqual(original);
        expect(result[2].cache_control).toEqual({ type: 'ephemeral' });
        expect(applyInjections(messages, inputs, 'reply')).toEqual(result);
    });
    it('skips disabled, empty and non-triggered cards; no injections is byte-identical', () => {
        const inputs = [item({ enabled: false }), item({ content: ' ' }), item({ triggers: ['swipe'] })];
        expect(applyInjections(messages, inputs, 'reply')).toBe(messages);
        expect(applyInjections(messages, inputs, 'swipe')).toHaveLength(5);
        expect(applyInjections(messages, undefined, 'reply')).toBe(messages);
    });
    it('keeps tool call/result groups intact', () => {
        const toolMessages: OpenAIMessage[] = [...messages,
            { role: 'assistant', content: null, tool_calls: [{ id: 't' }] },
            { role: 'tool', tool_call_id: 't', content: 'Result' },
            { role: 'assistant', content: 'Narration' },
        ];
        const result = applyInjections(toolMessages, [item({ depth: 1 })], 'reply');
        expect(result[4]).toEqual(toolMessages[4]);
        expect(result[5]).toEqual(toolMessages[5]);
        expect(result[6].content).toBe('Remember the rain');
    });
    it('puts combined assistant/reasoning prefills after depth-zero messages', () => {
        const result = applyInjections(messages, [
            item({ mode: 'prefill', content: 'Start here' }),
            item({ id: 'b', mode: 'message', content: 'Final reminder' }),
            item({ id: 'c', mode: 'reasoning', content: 'Consider the scene' }),
        ], 'reply');
        expect(result.at(-2)).toEqual({ role: 'system', content: 'Final reminder' });
        expect(result.at(-1)).toEqual({ role: 'assistant', content: 'Start here\n\n<think>\nConsider the scene' });
    });
    it.each(['claude', 'gemini'] as const)('preserves depth on the %s wire using a labeled user message', apiFormat => {
        const provider = { apiFormat, endpoint: 'http://localhost', modelName: 'test', apiKey: '' } as EndpointConfig;
        const request = applyInjections(messages, [item()], 'reply', apiFormat);
        const body = buildChatBody(provider, request);
        const serialized = JSON.stringify(body);
        expect(serialized).toContain('[System instruction]\\nRemember the rain');
        expect(JSON.stringify(apiFormat === 'claude' ? body.system : body.systemInstruction)).not.toContain('Remember the rain');
    });
    it('does not opt utility calls in through the default tracking label', () => {
        expect(injectionTrigger(undefined)).toBeUndefined();
        expect(injectionTrigger('ask-gm')).toBeUndefined();
        expect(injectionTrigger('story-generation')).toBe('reply');
        expect(injectionTrigger('swipe-generation')).toBe('swipe');
        expect(injectionTrigger('scene-continue')).toBe('continue');
    });
    it('normalizes malformed saved values and retains injection presets on reload', () => {
        expect(normalizeInjections([null, {}, item({ depth: -3.2 })])).toEqual([item({ depth: 0 })]);
        const saved = { ...defaultSettings, presets: [{ ...defaultSettings.presets[0], promptInjections: [item()] }] };
        expect(migrateSettings({ settings: saved }).presets[0].promptInjections).toEqual([item()]);
    });
});
