/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TurnState, TurnCallbacks } from '../../turnOrchestrator';

/**
 * WO-P2-03 characterization test for `track.enemy-suggestion`.
 *
 * Pins what the migration had to preserve: the gating decision, the single-flight flag, the
 * in-flight reset, and the THREE campaign-id re-verifications inside the queued closure — one
 * before the LLM request, one before the suggestion write, one gating the `lastScanScene` stamp.
 *
 * Also pins WO-P2-00's fix: discovery must read the RAW auxiliary/summariser resolvers, never
 * `getFreshAuxiliaryProvider`, which silently falls back to the Story provider. Using the Story
 * AI for a background scan is exactly what that fix exists to prevent, so it is asserted here
 * rather than left to a comment.
 */

let mockActiveCampaignId: string | null = 'campaign-1';
vi.mock('../../../../store/useAppStore', () => ({
    useAppStore: { getState: () => ({ activeCampaignId: mockActiveCampaignId }) },
}));
// Executes the queued closure inline so the guards inside it are reachable from a test.
vi.mock('../../../infrastructure/backgroundQueue', () => ({
    backgroundQueue: { push: vi.fn(async (_label: string, fn: () => Promise<void>) => fn()) },
}));
vi.mock('../../../enemy/enemySuggestions', () => ({
    detectEnemySuggestions: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../enemy/enemyDiscoveryController', () => ({
    decideDiscoveryScan: vi.fn().mockReturnValue({ kind: 'skip' }),
}));

import { enemySuggestionTrack, clearEnemyDiscoveryState } from '../enemySuggestionTrack';
import type { PostTurnTrackContext } from '../types';
import { backgroundQueue } from '../../../infrastructure/backgroundQueue';
import { detectEnemySuggestions } from '../../../enemy/enemySuggestions';
import { decideDiscoveryScan } from '../../../enemy/enemyDiscoveryController';

const mockPush = vi.mocked(backgroundQueue.push);
const mockDetect = vi.mocked(detectEnemySuggestions);
const mockDecide = vi.mocked(decideDiscoveryScan);

const PROVIDER = { endpoint: 'http://utility', apiKey: '', modelName: 'u' };

const makeCtx = (over: {
    addEnemySuggestions?: any;
    state?: Partial<TurnState>;
} = {}): { ctx: PostTurnTrackContext; addEnemySuggestions: any } => {
    const addEnemySuggestions = over.addEnemySuggestions === null
        ? undefined
        : over.addEnemySuggestions ?? vi.fn();
    const state = {
        settings: { aiTier: 'max' } as any,
        context: {} as any,
        archiveIndex: [{ sceneId: '12' }],
        enemyCompendium: [],
        enemyCombatConfig: { enemyDiscoveryEnabled: true },
        activeCampaignId: 'campaign-1',
        getUtilityEndpoint: vi.fn().mockReturnValue(PROVIDER),
        getRawAuxiliaryProvider: vi.fn().mockReturnValue({ endpoint: 'http://aux' }),
        getRawSummariserProvider: vi.fn().mockReturnValue({ endpoint: 'http://sum' }),
        getFreshAuxiliaryProvider: vi.fn().mockReturnValue({ endpoint: 'http://STORY-FALLBACK' }),
        getFreshProvider: vi.fn().mockReturnValue({ endpoint: 'http://story' }),
        ...over.state,
    } as unknown as TurnState;
    return {
        ctx: {
            state,
            callbacks: { addEnemySuggestions } as unknown as TurnCallbacks,
            displayInput: 'I draw my blade.',
            lastAssistantContent: 'A dire wolf lunges from the treeline.',
            allMsgs: [],
            npcLedger: [],
            activeCampaignId: 'campaign-1',
        },
        addEnemySuggestions,
    };
};

beforeEach(() => {
    vi.clearAllMocks();
    mockActiveCampaignId = 'campaign-1';
    clearEnemyDiscoveryState('campaign-1');
    mockDecide.mockReturnValue({ kind: 'skip' } as any);
    mockDetect.mockResolvedValue([]);
    mockPush.mockImplementation(async (_label: string, fn: any) => fn());
});

describe('track.enemy-suggestion — metadata', () => {
    it('declares a stable id and is toggleable-by-default and on-by-default', () => {
        expect(enemySuggestionTrack.id).toBe('track.enemy-suggestion');
        expect(enemySuggestionTrack.defaultEnabled).toBe(true);
        expect(enemySuggestionTrack.toggleable).not.toBe(false);
    });

    it('shouldRun mirrors the body\'s own addEnemySuggestions guard', () => {
        expect(enemySuggestionTrack.shouldRun(makeCtx({ addEnemySuggestions: null }).ctx)).toBe(false);
        expect(enemySuggestionTrack.shouldRun(makeCtx().ctx)).toBe(true);
    });
});

describe('track.enemy-suggestion — gating', () => {
    it('queues nothing when the controller declines the scan', async () => {
        await enemySuggestionTrack.run(makeCtx().ctx);

        expect(mockPush).not.toHaveBeenCalled();
    });

    it('reads the RAW auxiliary and summariser resolvers, never the Story-fallback getter', async () => {
        const { ctx } = makeCtx();
        await enemySuggestionTrack.run(ctx);

        const passed = mockDecide.mock.calls[0][0];
        expect(passed.providers.auxiliaryProvider).toEqual({ endpoint: 'http://aux' });
        expect(passed.providers.summariserProvider).toEqual({ endpoint: 'http://sum' });
        // WO-P2-00: the Story-fallback getter must not be consulted here at all.
        expect((ctx.state as any).getFreshAuxiliaryProvider).not.toHaveBeenCalled();
    });

    it('passes the current scene number and single-flight state to the controller', async () => {
        await enemySuggestionTrack.run(makeCtx().ctx);

        const passed = mockDecide.mock.calls[0][0];
        expect(passed.sceneNumber).toBe(12);
        expect(passed.inFlight).toBe(false);
        expect(passed.campaignId).toBe('campaign-1');
    });
});

describe('track.enemy-suggestion — scan and race guards', () => {
    beforeEach(() => {
        mockDecide.mockReturnValue({ kind: 'run', provider: PROVIDER } as any);
    });

    it('writes detected suggestions when nothing changed underfoot', async () => {
        mockDetect.mockResolvedValue([{ name: 'Dire Wolf' }] as any);
        const { ctx, addEnemySuggestions } = makeCtx();

        await enemySuggestionTrack.run(ctx);

        expect(addEnemySuggestions).toHaveBeenCalledWith(
            [{ name: 'Dire Wolf' }],
            'A dire wolf lunges from the treeline.',
        );
    });

    it('writes nothing when the scan finds no enemies', async () => {
        mockDetect.mockResolvedValue([]);
        const { ctx, addEnemySuggestions } = makeCtx();

        await enemySuggestionTrack.run(ctx);

        expect(addEnemySuggestions).not.toHaveBeenCalled();
    });

    it('GUARD 1 — skips the LLM request entirely when the campaign changed before start', async () => {
        const { ctx, addEnemySuggestions } = makeCtx();
        mockPush.mockImplementation(async (_label: string, fn: any) => {
            mockActiveCampaignId = 'campaign-2';
            return fn();
        });

        await enemySuggestionTrack.run(ctx);

        expect(mockDetect).not.toHaveBeenCalled();
        expect(addEnemySuggestions).not.toHaveBeenCalled();
    });

    it('GUARD 2 — drops the suggestions when the campaign changed during the request', async () => {
        const { ctx, addEnemySuggestions } = makeCtx();
        mockDetect.mockImplementation(async () => {
            mockActiveCampaignId = 'campaign-2';
            return [{ name: 'Dire Wolf' }] as any;
        });

        await enemySuggestionTrack.run(ctx);

        expect(mockDetect).toHaveBeenCalled();
        expect(addEnemySuggestions).not.toHaveBeenCalled();
    });

    it('clears the in-flight flag even when the scan throws', async () => {
        mockDetect.mockRejectedValue(new Error('provider exploded'));
        const { ctx } = makeCtx();

        await enemySuggestionTrack.run(ctx);

        // A crashed scan must never permanently block the campaign.
        await enemySuggestionTrack.run(ctx);
        expect(mockDecide.mock.calls[1][0].inFlight).toBe(false);
    });

    it('GUARD 3 — does not stamp lastScanScene when the campaign changed', async () => {
        const { ctx } = makeCtx();
        mockDetect.mockImplementation(async () => {
            mockActiveCampaignId = 'campaign-2';
            return [];
        });

        await enemySuggestionTrack.run(ctx);
        mockActiveCampaignId = 'campaign-1';
        await enemySuggestionTrack.run(ctx);

        // lastScanScene stayed at its initial -Infinity, so the cooldown never advanced.
        expect(mockDecide.mock.calls[1][0].lastScanScene).toBe(-Infinity);
    });

    it('stamps lastScanScene when the campaign is unchanged', async () => {
        const { ctx } = makeCtx();

        await enemySuggestionTrack.run(ctx);
        await enemySuggestionTrack.run(ctx);

        expect(mockDecide.mock.calls[1][0].lastScanScene).toBe(12);
    });

    it('clearEnemyDiscoveryState resets the per-campaign entry', async () => {
        const { ctx } = makeCtx();
        await enemySuggestionTrack.run(ctx);
        clearEnemyDiscoveryState('campaign-1');

        await enemySuggestionTrack.run(ctx);
        expect(mockDecide.mock.calls[1][0].lastScanScene).toBe(-Infinity);
    });
});
