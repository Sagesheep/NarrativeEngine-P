import type { PostCommitTrackContext, PostTurnTrack } from '../types';
import { advance, halt, isUnrelatedPlace } from '../../travelState';
import { useAppStore } from '../../../../store/useAppStore';

/**
 * WORKORDER 3 §7 — the travel advance track.
 *
 * On each **committed** turn where `context.travel` is set:
 *   1. `worldDay += 1`
 *   2. `travel.leg += 1`
 *   3. If `travel.leg > travel.totalLegs` → set `currentPlaceId = travel.toId`,
 *      clear `travel`.
 *   4. Otherwise leave `currentPlaceId` on the transit node.
 *
 * **Must run at commit, not at generation.** Swiping and regenerating must not
 * advance the clock twice. The `pendingCommit` lifecycle guarantees this: the
 * orchestrator's generation stage fires per swipe, but `commitPendingTurn()`
 * — and therefore `runPostTurnPipeline` and this track — fires once per turn,
 * only when the player commits the visible variant.
 *
 * **Safety valve:** if the location header (already resolved by the sequential
 * `locationHeaderTrack` into `freshContext.currentPlaceId`) names a place that
 * is neither the transit node nor the destination, the journey was interrupted
 * by the fiction. Clear `travel` and let the header's position stand. Prose is
 * never wrong — it is only unrecorded.
 *
 * Structural (not toggleable): advancing the clock is bookkeeping, not a
 * feature. A campaign that never sets `travel` reads this track as a no-op,
 * so toggling it off would only ever lose data.
 */
export const travelAdvanceTrack: PostTurnTrack<PostCommitTrackContext> = {
    id: 'track.travel-advance',
    name: 'Travel Advance',
    description: 'Advances the world clock and travel leg at turn commit.',
    toggleable: false,
    defaultEnabled: true,
    trigger: 'automatic',
    callsModel: false,
    shouldRun: (ctx) => {
        const travel = ctx.freshContext.travel;
        return Boolean(travel);
    },
    async run(ctx) {
        const travel = ctx.freshContext.travel;
        if (!travel) return;

        // Safety valve: the location header named an unrelated place.
        const headerPlaceId = ctx.freshContext.currentPlaceId ?? null;
        if (isUnrelatedPlace(headerPlaceId, travel)) {
            const { contextPatch } = halt();
            ctx.guardedUpdateContext(contextPatch);
            console.log(`[TravelAdvance] Journey halted at leg ${travel.leg}/${travel.totalLegs} — header named unrelated place ${headerPlaceId}`);
            return;
        }

        // Advance the leg + day. `advance` handles `arrive` when leg > totalLegs.
        const result = advance(travel, ctx.freshContext.worldDay);
        ctx.guardedUpdateContext(result.contextPatch);

        // Sanity: confirm the store took the write. Defensive — the guarded
        // setter drops writes on campaign switch, which is correct behaviour
        // (the turn was for the old campaign; the new one keeps its own clock).
        const storeNow = useAppStore.getState();
        if (storeNow.activeCampaignId !== ctx.activeCampaignId) return;

        const newTravel = storeNow.context.travel;
        if (!newTravel) {
            console.log(`[TravelAdvance] Arrived at ${travel.toId} on leg ${travel.leg + 1} (day ${storeNow.context.worldDay})`);
        } else {
            console.log(`[TravelAdvance] Leg ${newTravel.leg}/${newTravel.totalLegs} committed (day ${storeNow.context.worldDay})`);
        }
    },
};