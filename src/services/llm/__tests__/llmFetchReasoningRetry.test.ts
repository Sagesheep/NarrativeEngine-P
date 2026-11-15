// llmFetch — one retry when OpenRouter refuses the reasoning-off switch.
//
// Models whose reasoning is mandatory reject `reasoning: { effort: "none" }`.
// The relay sends the request once more without the switch and remembers the
// model, so the call still completes and later calls skip the failed attempt.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { llmFetch } from '../llmFetch';
import { reasoningOffRefused, resetReasoningOffRefusals } from '../../../utils/llmApiHelper';

const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';
const messages = [{ role: 'user', content: 'Hello' }];
const withSwitch = JSON.stringify({ model: 'vendor/mandatory-model', messages, max_tokens: 1400, reasoning: { effort: 'none' } });

const fetchMock = vi.fn();
const reply = (status: number, text: string) => new Response(text, { status });

/** The provider request body the relay was asked to forward on call `n`. */
const forwarded = (n: number): Record<string, unknown> => {
    const envelope = JSON.parse(String((fetchMock.mock.calls[n][1] as RequestInit).body)) as { body: string };
    return JSON.parse(envelope.body) as Record<string, unknown>;
};

beforeEach(() => {
    resetReasoningOffRefusals();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('llmFetch — reasoning-off refusal', () => {
    it('retries once without the switch and remembers the model', async () => {
        fetchMock
            .mockResolvedValueOnce(reply(400, '{"error":{"message":"Reasoning is mandatory for this endpoint and cannot be disabled."}}'))
            .mockResolvedValueOnce(reply(200, '{"choices":[]}'));

        const res = await llmFetch(OPENROUTER, { method: 'POST', headers: {}, body: withSwitch });

        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(forwarded(0).reasoning).toEqual({ effort: 'none' });
        expect(forwarded(1).reasoning).toBeUndefined();
        expect(forwarded(1).max_tokens).toBe(1400);
        expect(forwarded(1).messages).toEqual(messages);
        expect(reasoningOffRefused('vendor/mandatory-model')).toBe(true);
    });

    it('returns the first reply untouched when it succeeds', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, '{"choices":[]}'));
        const res = await llmFetch(OPENROUTER, { method: 'POST', headers: {}, body: withSwitch });
        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(reasoningOffRefused('vendor/mandatory-model')).toBe(false);
    });

    it('does not retry an error that is not about reasoning, and leaves its body readable', async () => {
        fetchMock.mockResolvedValueOnce(reply(402, '{"error":{"message":"Insufficient credits"}}'));
        const res = await llmFetch(OPENROUTER, { method: 'POST', headers: {}, body: withSwitch });
        expect(res.status).toBe(402);
        expect(await res.text()).toContain('Insufficient credits');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(reasoningOffRefused('vendor/mandatory-model')).toBe(false);
    });

    it('does not retry a request that carried no switch, a server error, or another host', async () => {
        const plain = JSON.stringify({ model: 'vendor/mandatory-model', messages });
        fetchMock.mockResolvedValue(reply(400, 'reasoning is not supported'));
        await llmFetch(OPENROUTER, { method: 'POST', headers: {}, body: plain });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        fetchMock.mockReset();
        fetchMock.mockResolvedValue(reply(503, 'reasoning backend overloaded'));
        await llmFetch(OPENROUTER, { method: 'POST', headers: {}, body: withSwitch });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        fetchMock.mockReset();
        fetchMock.mockResolvedValue(reply(400, 'reasoning is not supported'));
        await llmFetch('https://api.example.com/v1/chat/completions', { method: 'POST', headers: {}, body: withSwitch });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
