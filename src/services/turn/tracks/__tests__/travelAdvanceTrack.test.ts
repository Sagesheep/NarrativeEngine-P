import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostCommitTrackContext } from '../types';
import type { GameContext, TravelState } from '../../../../types';
import { travelAdvanceTrack } from '../postCommit/travelAdvanceTrack';

// The track reads `freshContext.travel` / `freshContext.currentPlaceId` /
// `freshContext.worldDay` and writes via `guardedUpdateContext`. It also reads
// the live store after the write for a sanity log. We mock the store so the
// sanity read returns the patched context.

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
        // Reflect the patch into the mocked store so the sanity read sees it.
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

describe('travelAdvanceTrack — advance', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        storeState.activeCampaignId = 'campaign-1';
    });

    it('increments leg and worldDay by 1 on a mid-journey leg', async () => {
        const travel = makeTravel({ leg: 1, totalLegs: 3 });
        const freshContext = makeCtx({ travel, worldDay: 12, currentPlaceId: 'loc_t' });
        storeState.context = { ...freshContext };
        const ctx = makeTrackCtx({ freshContext });
        await travelAdvanceTrack.run(ctx);
        expect(ctx.guardedUpdateContext).toHaveBeenCalledTimes(1);
        const patch = (ctx.guardedUpdateContext as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(patch.worldDay).toBe(13);
        expect(patch.travel).toMatchObject({ leg: 2, totalLegs: 3 });
        expect(patch.travel).not.toBeNull();
    });

    it('arrives on the final leg — clears travel and sets currentPlaceId to toId', async () => {
        const travel = makeTravel({ leg: 3, totalLegs: 3, toId: 'loc_b' });
        const freshContext = makeCtx({ travel, worldDay: 14, currentPlaceId: 'loc_t' });
        storeState.context = { ...freshContext };
        const ctx = makeTrackCtx({ freshContext });
        await travelAdvanceTrack.run(ctx);
        const patch = (ctx.guardedUpdateContext as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(patch.travel).toBeNull();
        expect(patch.currentPlaceId).toBe('loc_b');
        expect(patch.currentFeature).toBeNull();
        expect(patch.worldDay).toBe(15);
    });

    it('leaves currentPlaceId on the transit node when the leg is not final', async () => {
        const travel = makeTravel({ leg: 1, totalLegs: 3, transitId: 'loc_t' });
        const freshContext = makeCtx({ travel, worldDay: 12, currentPlaceId: 'loc_t' });
        storeState.context = { ...freshContext };
        const ctx = makeTrackCtx({ freshContext });
        await travelAdvanceTrack.run(ctx);
        const patch = (ctx.guardedUpdateContext as ReturnType<typeof vi.fn>).mock.calls[0][0];
        // The advance path does NOT write currentPlaceId — it stays on the transit node.
        expect(patch.currentPlaceId).toBeUndefined();
        expect(patch.travel).toMatchObject({ leg: 2 });
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

    it('does not clear travel when the header named the transit node', async () => {
        const travel = makeTravel({ leg: 2, totalLegs: 3, transitId: 'loc_t', toId: 'loc_b' });
        const freshContext = makeCtx({ travel, currentPlaceId: 'loc_t', worldDay: 13 });
        storeState.context = { ...freshContext };
        const ctx = makeTrackCtx({ freshContext });
        await travelAdvanceTrack.run(ctx);
        const patch = (ctx.guardedUpdateContext as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(patch.travel).not.toBeNull();
        expect(patch.travel).toMatchObject({ leg: 3 });
    });

    it('does not clear travel when the header named the destination', async () => {
        const travel = makeTravel({ leg: 3, totalLegs: 3, transitId: 'loc_t', toId: 'loc_b' });
        const freshContext = makeCtx({ travel, currentPlaceId: 'loc_b', worldDay: 14 });
        storeState.context = { ...freshContext };
        const ctx = makeTrackCtx({ freshContext });
        await travelAdvanceTrack.run(ctx);
        const patch = (ctx.guardedUpdateContext as ReturnType<typeof vi.fn>).mock.calls[0][0];
        // Header named the destination on the final leg → arrive, not halt.
        expect(patch.travel).toBeNull();
        expect(patch.currentPlaceId).toBe('loc_b');
    });
});

// ── The double-advance guard (WO3 §7) ─────────────────────────────────────
// The most likely bug and the hardest to notice: a swipe/regenerate followed
// by a commit must advance the clock by exactly one day, not two. The track
// runs at commit (postCommit), not at generation. Simulate the lifecycle:
//   1. Turn N generates (travel leg 1, day 12). The track does NOT run.
//   2. The player swipes — a new variant generates. The track does NOT run.
//   3. The player commits the visible variant. The track runs ONCE → leg 2, day 13.
// The track running once per commit (not once per generation) is the guard.

describe('travelAdvanceTrack — double-advance guard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        storeState.activeCampaignId = 'campaign-1';
    });

    it('a regenerate/swipe followed by a commit advances exactly one day', async () => {
        // Start: leg 1 of 3, day 12. The transit node is current.
        const travel = makeTravel({ leg: 1, totalLegs: 3, transitId: 'loc_t', toId: 'loc_b' });
        const freshContext = makeCtx({ travel, currentPlaceId: 'loc_t', worldDay: 12 });
        storeState.context = { ...freshContext };

        // Simulate two swipe-generations (the orchestrator fires runTurn twice,
        // but the track only fires on commit — so shouldRun is checked against
        // freshContext, which is only re-read at commit). The track's shouldRun
        // returns true, but the orchestrator never calls `run` during generation
        // — only the post-commit pipeline does. We model that by calling `run`
        // exactly once, simulating the single commit.
        const ctx = makeTrackCtx({ freshContext });
        expect(travelAdvanceTrack.shouldRun(ctx)).toBe(true);

        // The commit fires the track exactly once.
        await travelAdvanceTrack.run(ctx);

        const patch = (ctx.guardedUpdateContext as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(patch.worldDay).toBe(13);       // +1 day, not +2
        expect(patch.travel).toMatchObject({ leg: 2 }); // +1 leg, not +2

        // A second commit (the next turn) advances by exactly one more.
        storeState.context = { ...storeState.context, ...patch };
        const ctx2 = makeTrackCtx({ freshContext: storeState.context });
        await travelAdvanceTrack.run(ctx2);
        const patch2 = (ctx2.guardedUpdateContext as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(patch2.worldDay).toBe(14);
        expect(patch2.travel).toMatchObject({ leg: 3 });
    });

    it('does not advance when travel is unset (no-op)', async () => {
        const freshContext = makeCtx({ travel: undefined, worldDay: 12 });
        storeState.context = { ...freshContext };
        const ctx = makeTrackCtx({ freshContext });
        expect(travelAdvanceTrack.shouldRun(ctx)).toBe(false);
        // shouldRun false → the runner never calls run. Verify the no-op path.
        await travelAdvanceTrack.run(ctx);
        // run has an early return when travel is falsy; it should not write.
        expect(ctx.guardedUpdateContext).not.toHaveBeenCalled();
    });
});