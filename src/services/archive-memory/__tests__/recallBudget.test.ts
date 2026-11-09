import { describe, expect, it } from 'vitest';
import { effectiveSceneRecallBudget, normalizeSceneRecallBudget } from '../recallBudget';

describe('Scene Recall Space', () => {
    it('keeps any whole number from 500 up and falls back to 3,000 for anything else', () => {
        expect(normalizeSceneRecallBudget(6000)).toBe(6000);
        expect(normalizeSceneRecallBudget(5250.4)).toBe(5250);
        expect(normalizeSceneRecallBudget(500)).toBe(500);
        for (const v of [undefined, null, '6000', 0, 499, -1, NaN, Infinity]) expect(normalizeSceneRecallBudget(v)).toBe(3000);
    });

    it('is never more than the context window', () => {
        expect(effectiveSceneRecallBudget(20000, 8192)).toBe(8192);
        expect(effectiveSceneRecallBudget(6000, 128000)).toBe(6000);
        expect(effectiveSceneRecallBudget(6000, undefined)).toBe(6000);
    });
});
