import { describe, expect, it, vi } from 'vitest';
import { extractSceneEvents } from '../sceneEventExtractor';

describe('extractSceneEvents — model-call path', () => {
    it('asks for thinking off and parses the events', async () => {
        const modelCall = vi.fn().mockResolvedValue({
            content: '[{"eventType":"promise","importance":7.4,"text":"Grey promised Therese the findings first.","characters":["Grey","Therese"]}]',
        });

        const events = await extractSceneEvents(undefined, 'scene text', undefined, modelCall);

        expect(modelCall).toHaveBeenCalledTimes(1);
        expect(modelCall.mock.calls[0][0]).toMatchObject({ thinkingEffort: 'off', maxTokens: 1000, trackingLabel: 'scene-event-extract' });
        expect(modelCall.mock.calls[0][0].prompt).toContain('scene text');
        expect(events).toEqual([
            { eventType: 'promise', importance: 7, text: 'Grey promised Therese the findings first.', characters: ['Grey', 'Therese'] },
        ]);
    });

    it('returns no events with neither a provider nor a model call', async () => {
        expect(await extractSceneEvents(undefined, 'scene text')).toEqual([]);
    });

    it('returns no events when the model call fails', async () => {
        const modelCall = vi.fn().mockRejectedValue(new Error('timeout'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await extractSceneEvents(undefined, 'scene text', undefined, modelCall)).toEqual([]);
    });
});
