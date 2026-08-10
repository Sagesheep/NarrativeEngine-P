import { mergeLocationScanLedger, scanLocation } from '../../../locationParser';
import { backgroundQueue } from '../../../infrastructure/backgroundQueue';
import { tierAllows } from '../../aiTier';
import type { PostCommitTrackContext, PostTurnTrack } from '../types';
import { assertStillActive } from '../guarded';

export const locationScanTrack: PostTurnTrack<PostCommitTrackContext> = {
    id: 'track.location-scan',
    name: 'Location Scan',
    description: 'Updates the location ledger from recent messages.',
    toggleable: true,
    defaultEnabled: true,
    trigger: 'automatic',
    callsModel: true,
    shouldRun: (ctx) => ctx.bookkeepingDue
        && ctx.bkAvailable
        && tierAllows(ctx.facade?.config.aiTier ?? ctx.state.settings.aiTier, 'locationScan'),
    async run(ctx) {
        backgroundQueue.push('Location-Scan', async () => {
            if (!assertStillActive(ctx.activeCampaignId, 'Location-Scan')) return;
            const before = ctx.callbacks.getFreshLocationState();
            const baselineLedger = before.locationLedger ?? [];
            const baselinePlaceId = before.context.currentPlaceId ?? null;
            const baselineFeature = before.context.currentFeature ?? null;
            const scan = await scanLocation(
                ctx.facade ? undefined : ctx.bkProvider,
                ctx.scanMessages,
                baselineLedger,
                baselinePlaceId,
                baselineFeature,
                ctx.storyModelCall,
            );
            if (!assertStillActive(ctx.activeCampaignId, 'Location-Scan')) return;
            const after = ctx.callbacks.getFreshLocationState();
            if (after.activeCampaignId !== ctx.activeCampaignId) return;

            // A manual/header pointer change made while the LLM was in flight wins.
            if (after.context.currentPlaceId === baselinePlaceId && (after.context.currentFeature ?? null) === baselineFeature
                && (scan.currentPlaceId !== baselinePlaceId || scan.currentFeature !== baselineFeature)) {
                ctx.guardedUpdateContext({ currentPlaceId: scan.currentPlaceId, currentFeature: scan.currentFeature });
            }

            const mergedLedger = mergeLocationScanLedger(baselineLedger, scan.ledger, after.locationLedger ?? []);
            if (mergedLedger !== after.locationLedger) {
                (ctx.facade?.write.setLocationLedger ?? ctx.guardedSetLocationLedger)(mergedLedger);
            }
            if (scan.suggestions.length > 0) {
                (ctx.facade?.write.addLocationSuggestions ?? ctx.guardedAddLocationSuggestions)(scan.suggestions);
            }
            console.log(`[Auto Bookkeeping] Location scan at scene #${ctx.sceneId}: current=${scan.currentPlaceId ?? '(unclear)'}, suggestions=${scan.suggestions.length}`);
        }).catch(err => console.warn('[Auto Bookkeeping] Location scan failed:', err));
    },
};
