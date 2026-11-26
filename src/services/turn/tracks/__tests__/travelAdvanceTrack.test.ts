import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostCommitTrackContext } from '../types';
import type { GameContext, TravelState } from '../../../../types';
import { travelAdvanceTrack } from '../postCommit/travelAdvanceTrack';

// WO 6.5 — the travel advance track is now the halt safety valve only. The
// engine travel press advances the leg; an RP turn at a checkpoint does NOT.
// This test file verifies the track no longer advances, and that the halt
// safety valve still fires when the header names an unrelated place.

const storeState = vi.hoisted(() => ({
    activeCampaignId: 'campaign-1',
    context: {} as GameContext,
}));

vi.mock('../../../../store/useAppStore', () => ({
    useAppStore: {
        getState: () => ({
            activeCampaignId: storeState.activeCampaignId,
            context: storeState.context,
        }),
    },
}));

function makeTravel(overrides: Partial<TravelState> = {}): TravelState {
    return {
        fromId: 'loc_a',
        toId: 'loc_b',
        transitId: 'loc_t',
        mode: 'cart',
        leg: 1,
        totalLegs: 3,
        agency: 'free',
        ...overrides,
    };
}

function makeCtx(overrides: Partial<GameContext> = {}): GameContext {
    return { ...({} as GameContext), currentPlaceId: 'loc_t', worldDay: 12, ...overrides };
}

function makeTrackCtx(overrides: Partial<PostCommitTrackContext> = {}): PostCommitTrackContext {
    const guardedUpdateContext = vi.fn((patch: Partial<GameContext>) => {
        storeState.context = { ...storeState.context, ...patch };
    });
    return {
        state: {} as never,
        facade: undefined,
        callbacks: {} as never,
        displayInput: '',
        lastAssistantContent: '',
        activeCampaignId: 'campaign-1',
        sceneId: '025',
        freshIndex: [],
        freshChapters: [],
        entry: undefined,
        eventExtractionProvider: undefined,
        bookkeepingDue: false,
        bkProvider: undefined,
        bkAvailable: false,
        snapshotContext: undefined,
        freshContext: makeCtx(),
        inventoryItems: [],
        profileData: {} as never,
        scanMessages: [],
        storyModelCall: undefined,
        guardedUpdateContext,
        guardedSetCharacterProfileData: vi.fn(),
        guardedSetInventoryItems: vi.fn(),
        guardedSetLocationLedger: vi.fn(),
        guardedAddLocationSuggestions: vi.fn(),
        ...overrides,
    } as PostCommitTrackContext;
}

describe('travelAdvanceTrack — shouldRun', () => {
    it('returns false when freshContext.travel is unset', () => {
        const ctx = makeTrackCtx({ freshContext: makeCtx({ travel: undefined }) });
        expect(travelAdvanceTrack.shouldRun(ctx)).toBe(false);
    });

    it('returns false when freshContext.travel is null', () => {
        const ctx = makeTrackCtx({ freshContext: makeCtx({ travel: null }) });
        expect(travelAdvanceTrack.shouldRun(ctx)).toBe(false);
    });

    it('returns true when freshContext.travel is set', () => {
        const ctx = makeTrackCtx({ freshContext: makeCtx({ travel: makeTravel() }) });
        expect(travelAdvanceTrack.shouldRun(ctx)).toBe(true);
    });
});

describe('travelAdvanceTrack — WO 6.5: does NOT advance', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        storeState.activeCampaignId = 'campaign-1';
    });

    it('an RP turn at a checkpoint does NOT advance the leg or day', async () => {
        const travel = makeTravel({ leg: 1, totalLegs: 3 });
        const freshContext = makeCtx({ travel, worldDay: 12, currentPlaceId: 'loc_t' });
        storeState.context = { ...freshContext };
        const ctx = makeTrackCtx({ freshContext });
        await travelAdvanceTrack.run(ctx);
        // The track no longer advances — guardedUpdateContext is NOT called
        // when the header names a valid place (the transit node).
        expect(ctx.guardedUpdateContext).not.toHaveBeenCalled();
    });

    it('a mid-journey RP turn does NOT advance the leg', async () => {
        const travel = makeTravel({ leg: 2, totalLegs: 3 });
        const freshContext = makeCtx({ travel, worldDay: 13, currentPlaceId: 'loc_t' });
        storeState.context = { ...freshContext };
        const ctx = makeTrackCtx({ freshContext });
        await travelAdvanceTrack.run(ctx);
        expect(ctx.guardedUpdateContext).not.toHaveBeenCalled();
    });

    it('the final leg RP turn does NOT arrive', async () => {
        const travel = makeTravel({ leg: 3, totalLegs: 3, toId: 'loc_b' });
        const freshContext = makeCtx({ travel, worldDay: 14, currentPlaceId: 'loc_t' });
        storeState.context = { ...freshContext };
        const ctx = makeTrackCtx({ freshContext });
        await travelAdvanceTrack.run(ctx);
        // The track does NOT advance or arrive — the engine press does that.
        expect(ctx.guardedUpdateContext).not.toHaveBeenCalled();
    });
});

describe('travelAdvanceTrack — safety valve (halt)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        storeState.activeCampaignId = 'campaign-1';
    });

    it('clears travel when the header named an unrelated place', async () => {
        const travel = makeTravel({ leg: 2, totalLegs: 3, transitId: 'loc_t', toId: 'loc_b' });
        // The header named 'loc_x' — neither transit nor destination.
        const freshContext = makeCtx({ travel, currentPlaceId: 'loc_x', worldDay: 13 });
        storeState.context = { ...freshContext };
        const ctx = makeTrackCtx({ freshContext });
        await travelAdvanceTrack.run(ctx);
        const patch = (ctx.guardedUpdateContext as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(patch.travel).toBeNull();
        // halt() does not change currentPlaceId — the header's position stands.
        expect(patch.currentPlaceId).toBeUndefined();
    });

    it('does NOT clear travel when the header named the transit node', async () => {
        const travel = makeTravel({ leg: 2, totalLegs: 3, transitId: 'loc_t', toId: 'loc_b' });
        const freshContext = makeCtx({ travel, currentPlaceId: 'loc_t', worldDay: 13 });
        storeState.context = { ...freshContext };
        const ctx = makeTrackCtx({ freshContext });
        await travelAdvanceTrack.run(ctx);
        // Valid place — no halt, no advance (WO 6.5).
        expect(ctx.guardedUpdateContext).not.toHaveBeenCalled();
    });

    it('does NOT clear travel when the header named the destination', async () => {
        const travel = makeTravel({ leg: 2, totalLegs: 3, transitId: 'loc_t', toId: 'loc_b' });
        const freshContext = makeCtx({ travel, currentPlaceId: 'loc_b', worldDay: 14 });
        storeState.context = { ...freshContext };
        const ctx = makeTrackCtx({ freshContext });
        await travelAdvanceTrack.run(ctx);
        // Valid place — no halt, no advance (WO 6.5).
        expect(ctx.guardedUpdateContext).not.toHaveBeenCalled();
    });
});

describe('travelAdvanceTrack — no-op when travel is unset', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        storeState.activeCampaignId = 'campaign-1';
    });

    it('does not advance when travel is unset (no-op)', async () => {
        const freshContext = makeCtx({ travel: undefined, worldDay: 12 });
        storeState.context = { ...freshContext };
        const ctx = makeTrackCtx({ freshContext });
        expect(travelAdvanceTrack.shouldRun(ctx)).toBe(false);
        // shouldRun false → the runner never calls run. Verify the no-op path.
        await travelAdvanceTrack.run(ctx);
        expect(ctx.guardedUpdateContext).not.toHaveBeenCalled();
    });
});