import type { PostCommitTrackContext, PostTurnTrack } from '../types';
import { halt, isUnrelatedPlace } from '../../travelState';
import { useAppStore } from '../../../../store/useAppStore';

/**
 * WO 6.5 — the travel advance track is now the halt safety valve only.
 *
 * The engine travel press (see `travelPress.ts`) advances the leg and day.
 * A normal RP turn at a checkpoint does NOT advance — the player is RPing at
 * the camp, and the next press moves them forward. So this track no longer
 * calls `advance()`.
 *
 * What remains is the safety valve: if the location header (resolved by the
 * sequential `locationHeaderTrack` into `freshContext.currentPlaceId`) names
 * a place that is neither the transit node nor the destination, the journey
 * was interrupted by the fiction. Clear `travel` and let the header's
 * position stand. Prose is never wrong — it is only unrecorded.
 *
 * Structural (not toggleable): the safety valve is bookkeeping, not a feature.
 * A campaign that never sets `travel` reads this track as a no-op.
 */
export const travelAdvanceTrack: PostTurnTrack<PostCommitTrackContext> = {
    id: 'track.travel-advance',
    name: 'Travel Advance',
    description: 'WO 6.5 — halt safety valve only. The engine press advances the leg.',
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

        // WO 6.5: no advance here. The engine press advances the leg.
        const storeNow = useAppStore.getState();
        if (storeNow.activeCampaignId !== ctx.activeCampaignId) return;
        const newTravel = storeNow.context.travel;
        if (newTravel) {
            console.log(`[TravelAdvance] RP at leg ${newTravel.leg}/${newTravel.totalLegs} (day ${storeNow.context.worldDay}) — no advance`);
        }
    },
};