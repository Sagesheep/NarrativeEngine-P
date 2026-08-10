import { useAppStore } from '../../../../store/useAppStore';
import { resolveLocationHeader } from '../../../locationHeader';
import type { PostTurnTrack, SequentialTrackContext } from '../types';

export const locationHeaderTrack: PostTurnTrack<SequentialTrackContext> = {
    id: 'track.location-header',
    name: 'Location Header Tracking',
    description: 'Tracks the GM’s authoritative location header and suggests unknown places.',
    toggleable: false,
    defaultEnabled: true,
    trigger: 'automatic',
    callsModel: false,
    shouldRun: () => true,
    async run(ctx) {
        // Sibling of the 👥 [Present] parse: the GM's 📍 [Location] header is the
        // authoritative per-turn location self-report (requested by defaultRules.ts:51).
        // Engine regex, zero LLM, every tier. The interval-gated scanLocation call in
        // runArchiveTrack stays the cold path (features/connections enrichment). Header
        // absent or unusable → no-op; the last known pointer stands. Unknown places are
        // suggested, never auto-added (same trust model as NPC suggestions).
        try {
            const sNow = useAppStore.getState();
            if (sNow.activeCampaignId === ctx.activeCampaignId) {
                const outcome = resolveLocationHeader(
                    ctx.lastAssistantContent,
                    sNow.locationLedger ?? [],
                    sNow.context.currentPlaceId ?? null,
                );
                if (outcome.kind === 'resolved') {
                    ctx.callbacks.updateContext({ currentPlaceId: outcome.placeId, currentFeature: outcome.feature });
                    if (outcome.appendFeature && outcome.feature) {
                        const entry = sNow.locationLedger.find(l => l.id === outcome.placeId);
                        if (entry) sNow.updateLocation(outcome.placeId, { features: [...entry.features, outcome.feature], lastSeenScene: String(Date.now()) });
                    }
                } else if (outcome.kind === 'feature-only') {
                    ctx.callbacks.updateContext({ currentFeature: outcome.feature });
                    if (outcome.appendFeature && sNow.context.currentPlaceId) {
                        const entry = sNow.locationLedger.find(l => l.id === sNow.context.currentPlaceId);
                        if (entry) sNow.updateLocation(entry.id, { features: [...entry.features, outcome.feature] });
                    }
                } else if (outcome.kind === 'unknown') {
                    sNow.addLocationSuggestions([outcome.suggestion]);
                }
            }
        } catch (err) {
            console.warn('[LocationHeader] Parse failed (non-fatal):', err);
        }
    },
};
