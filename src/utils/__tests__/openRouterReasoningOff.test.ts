// Reasoning off on OpenRouter.
//
// OpenRouter leaves a model on its default when a request says nothing about
// reasoning, and many models default to reasoning on. A call that asks for
// thinking off (scene analysis, the Director's brief, any short JSON job with a
// small max_tokens) then spends its budget on reasoning and returns nothing.
// OpenRouter's switch is `reasoning: { effort: "none" }`. The relay half of the
// change (retry when a model refuses the switch) is in
// services/llm/__tests__/llmFetchReasoningRetry.test.ts.
import { beforeEach, describe, expect, it } from 'vitest';
import {
    buildChatBody, noteReasoningOffRefused, reasoningOffRefused, resetReasoningOffRefusals, withoutReasoningOff,
} from '../llmApiHelper';
import type { EndpointConfig } from '../../types';

const messages = [{ role: 'user', content: 'Hello' }];

const openRouter: EndpointConfig = {
    endpoint: 'https://openrouter.ai/api/v1',
    apiKey: 'test-key',
    modelName: 'vendor/reasoning-model',
    apiFormat: 'openai',
};
const otherHost: EndpointConfig = { ...openRouter, endpoint: 'https://api.example.com/v1' };

beforeEach(() => resetReasoningOffRefusals());

describe('buildChatBody — thinking off on OpenRouter', () => {
    it('sends the explicit switch when the call asks for off, and leaves max_tokens alone', () => {
        const body = buildChatBody(openRouter, messages, { stream: false, max_tokens: 1400, thinkingEffort: 'off' });
        expect(body.reasoning).toEqual({ effort: 'none' });
        expect(body.reasoning_effort).toBeUndefined();
        expect(body.thinking).toBeUndefined();
        expect(body.max_tokens).toBe(1400);
    });

    it('sends it when the endpoint itself is set to off, and when a call turns off an endpoint set to high', () => {
        expect(buildChatBody({ ...openRouter, thinkingEffort: 'off' }, messages, { stream: true }).reasoning).toEqual({ effort: 'none' });
        const body = buildChatBody({ ...openRouter, thinkingEffort: 'high' }, messages, { stream: false, max_tokens: 300, thinkingEffort: 'off' });
        expect(body.reasoning).toEqual({ effort: 'none' });
        expect(body.reasoning_effort).toBeUndefined();
    });

    it('is recognised under the openrouter api format and on a subdomain', () => {
        expect(buildChatBody({ ...openRouter, apiFormat: 'openrouter' }, messages, { thinkingEffort: 'off' }).reasoning).toEqual({ effort: 'none' });
        expect(buildChatBody({ ...openRouter, endpoint: 'https://eu.openrouter.ai/api/v1' }, messages, { thinkingEffort: 'off' }).reasoning).toEqual({ effort: 'none' });
    });

    it('leaves the model default alone when no effort is configured', () => {
        const body = buildChatBody(openRouter, messages, { stream: false, max_tokens: 300 });
        expect(body.reasoning).toBeUndefined();
        expect(body.reasoning_effort).toBeUndefined();
    });

    it('still sends an effort level when one is asked for', () => {
        const body = buildChatBody(openRouter, messages, { stream: true, thinkingEffort: 'low' });
        expect(body.reasoning_effort).toBeDefined();
        expect(body.reasoning).toBeUndefined();
    });

    it('does not send the switch to other OpenAI-compatible hosts', () => {
        const body = buildChatBody(otherHost, messages, { stream: false, max_tokens: 300, thinkingEffort: 'off' });
        expect(body.reasoning).toBeUndefined();
    });

    it("lets the provider's custom body override it", () => {
        const body = buildChatBody({ ...openRouter, customBody: '{"reasoning": {"effort": "low", "exclude": true}}' }, messages, { thinkingEffort: 'off' });
        expect(body.reasoning).toEqual({ effort: 'low', exclude: true });
        expect(buildChatBody({ ...openRouter, customBody: '{"reasoning": null}' }, messages, { thinkingEffort: 'off' }).reasoning).toBeUndefined();
    });

    it('stops sending the switch for a model that has refused it, and only for that model', () => {
        noteReasoningOffRefused('vendor/reasoning-model');
        expect(reasoningOffRefused('vendor/reasoning-model')).toBe(true);
        expect(buildChatBody(openRouter, messages, { thinkingEffort: 'off' }).reasoning).toBeUndefined();
        expect(buildChatBody({ ...openRouter, modelName: 'vendor/other-model' }, messages, { thinkingEffort: 'off' }).reasoning).toEqual({ effort: 'none' });
    });
});

describe('withoutReasoningOff', () => {
    it('removes exactly the switch and reports the model', () => {
        const sent = JSON.stringify(buildChatBody(openRouter, messages, { stream: false, max_tokens: 1400, thinkingEffort: 'off' }));
        const out = withoutReasoningOff(sent);
        expect(out?.model).toBe('vendor/reasoning-model');
        const parsed = JSON.parse(out?.body ?? '{}');
        expect(parsed.reasoning).toBeUndefined();
        expect(parsed.max_tokens).toBe(1400);
        expect(parsed.messages).toEqual(messages);
    });

    it("leaves alone a request without the switch, a user's own reasoning settings, and text that is not a request", () => {
        expect(withoutReasoningOff(JSON.stringify({ model: 'm', messages }))).toBeNull();
        expect(withoutReasoningOff(JSON.stringify({ model: 'm', reasoning: { effort: 'low' } }))).toBeNull();
        expect(withoutReasoningOff(JSON.stringify({ model: 'm', reasoning: { effort: 'none', exclude: true } }))).toBeNull();
        expect(withoutReasoningOff(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'say "reasoning"' }] }))).toBeNull();
        expect(withoutReasoningOff('not json "reasoning"')).toBeNull();
    });
});
