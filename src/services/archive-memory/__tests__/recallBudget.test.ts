import { describe, expect, it } from 'vitest';
import { normalizeSceneRecallBudget, SCENE_RECALL_BUDGETS } from '../recallBudget';

describe('Scene Recall Space', () => {
    it('offers 3k, 4k and 6k', () => {
        expect(SCENE_RECALL_BUDGETS).toEqual([3000, 4000, 6000]);
    });

    it('keeps a valid choice and falls back to 3,000 for anything else', () => {
        expect(normalizeSceneRecallBudget(6000)).toBe(6000);
        for (const v of [undefined, null, 5000, '6000', 0]) expect(normalizeSceneRecallBudget(v)).toBe(3000);
    });
});
