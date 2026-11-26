import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PromptInjection, EndpointConfig } from '../../types';

const state = vi.hoisted(() => ({
    activeCampaignId: 'campaign-a' as string | null,
    context: { promptInjections: [] as PromptInjection[] },
    settings: {
        storyTimeoutSeconds: 600, contextLimit: 8192, activePresetId: 'test',
        presets: [{ id: 'test', promptInjections: [] as PromptInjection[] }],
    },
}));
vi.mock('../../store/useAppStore', () => ({ useAppStore: { getState: () => state } }));
vi.mock('../llm/llmFetch', () => ({ llmFetch: vi.fn() }));
vi.mock('../llm/llmRequestQueue', () => ({
    getQueueForEndpoint: () => ({ acquireSlot: async () => {}, releaseSlot: vi.fn(), onRateLimitHit: vi.fn() }),
}));
import { sendMessage } from '../llm/llmService';
import { llmFetch } from '../llm/llmFetch';
const provider = { endpoint: 'http://localhost/v1', modelName: 'test', apiKey: '', apiFormat: 'openai' } as EndpointConfig;
afterEach(() => vi.clearAllMocks());

describe('injections at the streaming request boundary', () => {
    it.each(['story-generation', 'swipe-generation', 'scene-continue'])('injects once for %s and keeps cached payload clean', async label => {
        state.context.promptInjections = [{
            id: 'a', name: 'Direction', content: 'Added instruction', enabled: true,
            role: 'system', depth: 0, mode: 'message', triggers: ['reply', 'swipe', 'continue'],
        }];
        vi.mocked(llmFetch).mockImplementation(async () => ({ ok: true, body: new ReadableStream({ start(c) { c.close(); } }) }) as Response);
        const input = [{ role: 'user' as const, content: 'Player' }];
        for (let i = 0; i < 2; i++) {
            const onError = vi.fn();
            await sendMessage(provider, input, vi.fn(), vi.fn(), onError, undefined, undefined, undefined, undefined, label);
            expect(onError).not.toHaveBeenCalled();
        }
        for (const call of vi.mocked(llmFetch).mock.calls) {
            const body = JSON.parse(call[1]?.body as string);
            expect(body.messages).toEqual([...input, { role: 'system', content: 'Added instruction' }]);
        }
        expect(input).toHaveLength(1);
    });
    it('does not apply story injections to other streaming consumers', async () => {
        state.context.promptInjections = [{
            id: 'a', name: 'Direction', content: 'Added instruction', enabled: true,
            role: 'system', depth: 0, mode: 'message', triggers: ['reply', 'swipe', 'continue'],
        }];
        vi.mocked(llmFetch).mockImplementation(async () => ({ ok: true, body: new ReadableStream({ start(c) { c.close(); } }) }) as Response);
        await sendMessage(provider, [{ role: 'user', content: 'Utility' }], vi.fn(), vi.fn(), vi.fn());
        expect(JSON.parse(vi.mocked(llmFetch).mock.calls[0][1]?.body as string).messages).toHaveLength(1);
    });
});

it('rejects injections that overflow an older cached request without sending it', async () => {
    state.settings.contextLimit = 40;
    state.context.promptInjections = [{
        id: 'a', name: 'Direction', content: 'Added instruction', enabled: true,
        role: 'system', depth: 0, mode: 'message', triggers: ['swipe'],
    }];
    const onError = vi.fn();
    await sendMessage(provider, [{ role: 'user', content: 'Long cached message. '.repeat(40) }], vi.fn(), vi.fn(), onError,
        undefined, undefined, undefined, undefined, 'swipe-generation');
    expect(llmFetch).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('refit history'));
    state.settings.contextLimit = 8192;
});

it.each(['story-generation', 'swipe-generation', 'scene-continue'])('uses only the current campaign for %s even with the same AI preset', async label => {
    const card: PromptInjection = {
        id: 'a', name: 'Direction', content: 'Campaign A only', enabled: true,
        role: 'system', depth: 0, mode: 'message', triggers: ['reply', 'swipe', 'continue'],
    };
    state.settings.presets[0].promptInjections = [{ ...card, content: 'Legacy preset must not leak' }];
    vi.mocked(llmFetch).mockImplementation(async () => ({ ok: true, body: new ReadableStream({ start(c) { c.close(); } }) }) as Response);
    const send = () => sendMessage(provider, [{ role: 'user', content: 'Player' }], vi.fn(), vi.fn(), vi.fn(), undefined, undefined, undefined, undefined, label);
    state.activeCampaignId = 'campaign-a';
    state.context.promptInjections = [card];
    await send();
    state.activeCampaignId = 'campaign-b';
    state.context.promptInjections = [{ ...card, content: 'Campaign B only' }];
    await send();
    state.context.promptInjections = [];
    await send();
    const bodies = vi.mocked(llmFetch).mock.calls.map(call => JSON.parse(call[1]?.body as string));
    expect(bodies[0].messages.at(-1).content).toBe('Campaign A only');
    expect(bodies[1].messages.at(-1).content).toBe('Campaign B only');
    expect(bodies[2].messages).toHaveLength(1);
    expect(JSON.stringify(bodies)).not.toContain('Legacy preset');
});

it('does not send stale campaign injections when no campaign is active', async () => {
    state.activeCampaignId = null;
    state.context.promptInjections = [{
        id: 'a', name: 'Direction', content: 'Stale campaign', enabled: true,
        role: 'system', depth: 0, mode: 'message', triggers: ['reply'],
    }];
    vi.mocked(llmFetch).mockImplementation(async () => ({ ok: true, body: new ReadableStream({ start(c) { c.close(); } }) }) as Response);
    await sendMessage(provider, [{ role: 'user', content: 'Player' }], vi.fn(), vi.fn(), vi.fn(),
        undefined, undefined, undefined, undefined, 'story-generation');
    expect(JSON.parse(vi.mocked(llmFetch).mock.calls[0][1]?.body as string).messages).toHaveLength(1);
    state.activeCampaignId = 'campaign-a';
});
