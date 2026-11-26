import { beforeEach, describe, expect, it, vi } from 'vitest';

const recommendContext = vi.hoisted(() => vi.fn());
vi.mock('../../turn/contextRecommender', () => ({ recommendContext }));

import { gatherRecommender } from '../recommenderGather';
import type { TurnState } from '../../turn/turnOrchestrator';

function state(moduleEnabled?: Record<string, boolean>): TurnState {
    return {
        npcLedger: [{ id: 'n1', name: 'Therese Soll' }],
        loreChunks: [],
        messages: [],
        context: {},
        settings: { aiTier: 'max', moduleEnabled },
        getUtilityEndpoint: () => ({ endpoint: 'http://utility', modelName: 'm' }),
    } as unknown as TurnState;
}

const thinkingArg = () => recommendContext.mock.calls[0][11];

beforeEach(() => {
    recommendContext.mockReset();
    recommendContext.mockResolvedValue({ relevantNPCNames: [], relevantLoreIds: [], inventoryCategories: [], profileFields: [] });
});

describe('gatherRecommender — the recommenderThinking block', () => {
    it('is off on Max unless the user switches it on', async () => {
        await gatherRecommender(state(), 'hello', undefined);
        expect(thinkingArg()).toBe(false);
    });

    it('a Block View toggle turns thinking on', async () => {
        await gatherRecommender(state({ recommenderThinking: true }), 'hello', undefined);
        expect(thinkingArg()).toBe(true);
    });
});

describe('gatherRecommender — lore picks', () => {
    // The lore picks used to be logged and dropped; lore selection now fuses them in.
    it('returns the recommender\'s lore picks', async () => {
        recommendContext.mockResolvedValueOnce({ relevantNPCNames: [], relevantLoreIds: ['lore-helena'], inventoryCategories: [], profileFields: [] });
        const result = await gatherRecommender(state(), 'I spot Helena', undefined);
        expect(result.recommendedLoreIds).toEqual(['lore-helena']);
    });
});
