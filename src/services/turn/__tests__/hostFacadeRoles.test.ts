import { describe, expect, it } from 'vitest';
import type { AppSettings } from '../../../types';
import type { TurnCallbacks, TurnState } from '../turnOrchestrator';
import { buildHostFacade, hasHostModelRole } from '../hostFacade';

const state = (utility: unknown) => ({
    input: 'x', displayInput: 'x',
    settings: { contextLimit: 8192, aiTier: 'max' } as unknown as AppSettings,
    context: {}, messages: [], condenser: { condensedUpToIndex: -1 }, loreChunks: [], npcLedger: [], archiveIndex: [],
    activeCampaignId: 'c1',
    getFreshProvider: () => ({ endpoint: 'http://story', modelName: 'story' }),
    // The getter always exists; it returns undefined when the preset has no utility model.
    getUtilityEndpoint: () => utility,
}) as unknown as TurnState;

describe('host facade — utility role availability', () => {
    it('no utility model set → the role is unavailable, so utility steps skip instead of throwing', () => {
        expect(hasHostModelRole(buildHostFacade(state(undefined), {} as TurnCallbacks), 'utility')).toBe(false);
    });

    it('a utility model set → available', () => {
        const facade = buildHostFacade(state({ endpoint: 'http://utility', modelName: 'u' }), {} as TurnCallbacks);
        expect(hasHostModelRole(facade, 'utility')).toBe(true);
    });
});
