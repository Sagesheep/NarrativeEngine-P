import { describe, expect, it, vi } from 'vitest';
import { analyzeScene, parseSceneDefinition } from '../sceneEventExtractor';

const answer = (content: unknown) => vi.fn().mockResolvedValue({ content: typeof content === 'string' ? content : JSON.stringify(content) });
const event = { eventType: 'promise', importance: 7.4, text: 'Grey promised Therese the findings first.', characters: ['Grey', 'Therese'] };
const parsedEvent = { eventType: 'promise', importance: 7, text: 'Grey promised Therese the findings first.', characters: ['Grey', 'Therese'] };

describe('analyzeScene', () => {
    it('asks for thinking off and parses events, tags and hooks in one call', async () => {
        const modelCall = answer({
            definition: 'Grey and Therese Soll bargain in her study; he promises her his findings first.',
            events: [event],
            tags: { negotiation: 3, tense: 2 },
            hooks: [{ type: 'promise', with: ['Therese'], what: 'Findings go to Therese first.' }],
        });

        const result = await analyzeScene(undefined, 'scene text', '042', { modelCall });

        expect(modelCall).toHaveBeenCalledTimes(1);
        expect(modelCall.mock.calls[0][0]).toMatchObject({ thinkingEffort: 'off', maxTokens: 1400, trackingLabel: 'scene-event-extract' });
        expect(modelCall.mock.calls[0][0].prompt).toContain('scene text');
        expect(result).toEqual({
            events: [parsedEvent],
            tags: { negotiation: 3, tense: 2 },
            hooks: [{ id: '042:0', type: 'promise', with: ['Therese'], what: 'Findings go to Therese first.', status: 'open' }],
            resolvedHookIds: [],
            definition: 'Grey and Therese Soll bargain in her study; he promises her his findings first.',
        });
        expect(modelCall.mock.calls[0][0].prompt).toContain('DEFINITION RULES');
    });

    it('accepts a bare events array', async () => {
        const result = await analyzeScene(undefined, 'scene text', '042', { modelCall: answer([event]) });
        expect(result).toEqual({ events: [parsedEvent], tags: {}, hooks: [], resolvedHookIds: [] });
    });

    it('only accepts resolved hooks it actually offered', async () => {
        const shown = { id: '010:0', type: 'promise' as const, with: ['Therese'], what: 'Findings first.', status: 'open' as const };
        const result = await analyzeScene(undefined, 'scene text', '042', {
            modelCall: answer({ events: [], tags: {}, hooks: [], resolvedHooks: ['010:0', '999:9'] }),
            openHooks: [shown],
        });
        expect(result?.resolvedHookIds).toEqual(['010:0']);
    });

    it('returns null with neither a provider nor a model call', async () => {
        expect(await analyzeScene(undefined, 'scene text', '042')).toBeNull();
    });

    it('returns null when the model call fails', async () => {
        const modelCall = vi.fn().mockRejectedValue(new Error('timeout'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await analyzeScene(undefined, 'scene text', '042', { modelCall })).toBeNull();
    });

    it('returns null on an unparseable answer', async () => {
        expect(await analyzeScene(undefined, 'scene text', '042', { modelCall: answer('not json at all') })).toBeNull();
    });
});

describe('parseSceneDefinition', () => {
    it('keeps one clean line', () => {
        expect(parseSceneDefinition(' "Grey and Rin fight\n  bandits at the ford." ')).toBe('Grey and Rin fight bandits at the ford.');
    });

    it('drops answers too short to find a scene by', () => {
        expect(parseSceneDefinition('A fight.')).toBeUndefined();
        expect(parseSceneDefinition(42)).toBeUndefined();
        expect(parseSceneDefinition(undefined)).toBeUndefined();
    });

    it('caps a rambling answer at 60 words', () => {
        expect(parseSceneDefinition(Array.from({ length: 90 }, () => 'word').join(' '))!.split(' ')).toHaveLength(60);
    });
});
