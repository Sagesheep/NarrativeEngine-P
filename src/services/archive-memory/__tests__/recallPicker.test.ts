import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyRecallPicks, buildRecallPickerPrompt, parseRecallPicks, runRecallPicker } from '../recallPicker';

const candidates = ['101', '202', '303'].map(sceneId => ({ sceneId, line: `Scene ${sceneId} happened.` }));

afterEach(() => vi.useRealTimers());

describe('parseRecallPicks', () => {
    it('maps 1-based numbers to scene ids, best first, without repeats or invalid numbers', () => {
        expect(parseRecallPicks([3, '1', 3, 9, 0, 'x'], candidates)).toEqual(['303', '101']);
    });

    it('caps at five picks', () => {
        const many = Array.from({ length: 8 }, (_, i) => ({ sceneId: String(i), line: 'x' }));
        expect(parseRecallPicks([1, 2, 3, 4, 5, 6, 7], many)).toHaveLength(5);
    });

    it('treats anything but an array as no answer', () => {
        expect(parseRecallPicks({ picks: [1] }, candidates)).toBeNull();
        expect(parseRecallPicks([], candidates)).toEqual([]);
    });
});

describe('applyRecallPicks', () => {
    it('puts picks first, then everything the engine recalled, without repeats', () => {
        expect(applyRecallPicks(['1', '2', '3'], ['3'])).toEqual(['3', '1', '2']);
    });

    it('adds picks from outside the engine list rather than pushing engine hits out', () => {
        expect(applyRecallPicks(['1', '2'], ['9', '8'])).toEqual(['9', '8', '1', '2']);
    });
});

describe('buildRecallPickerPrompt', () => {
    it('numbers the definitions and shows only the end of a long GM reply', () => {
        const prompt = buildRecallPickerPrompt('I open the letter.', `START ${'x'.repeat(3000)} END`, candidates);
        expect(prompt).toContain('[2] Scene 202 happened.');
        expect(prompt).toContain('I open the letter.');
        expect(prompt).toContain('END');
        expect(prompt).not.toContain('START');
    });
});

describe('runRecallPicker', () => {
    it('asks with thinking off and returns the picks', async () => {
        const modelCall = vi.fn().mockResolvedValue({ content: '[2, 1]' });
        expect(await runRecallPicker({ userMessage: 'q', lastReply: '', candidates, modelCall })).toEqual(['202', '101']);
        expect(modelCall.mock.calls[0][0]).toMatchObject({ thinkingEffort: 'off', trackingLabel: 'recall-picker' });
    });

    it('gives up after the timeout so the turn is not held', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const modelCall = vi.fn(() => new Promise<never>(() => {}));
        const pending = runRecallPicker({ userMessage: 'q', lastReply: '', candidates, modelCall, timeoutMs: 5000 });
        await vi.advanceTimersByTimeAsync(5000);
        expect(await pending).toBeNull();
    });

    it('returns null with no model to ask', async () => {
        expect(await runRecallPicker({ userMessage: 'q', lastReply: '', candidates })).toBeNull();
    });
});
