import { applyStoryMovement } from '../../applyStoryMovement';
import { movementPositionKey } from '../../storyMovement';
import { useAppStore } from '../../../../store/useAppStore';
import { anchorSceneLocation } from '../../../locationHeader';
import type { PostTurnTrack, SequentialTrackContext } from '../types';

export const locationHeaderTrack: PostTurnTrack<SequentialTrackContext> = {
    id: 'track.location-header',
    name: 'Location Header Tracking',
    description: 'Synchronizes the committed scene location with Places and its local features.',
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
        // absent or unusable → no-op. A committed current place is registered before
        // its pointer is published, allowing map subscribers to resolve it immediately.
        try {
            const sNow = useAppStore.getState();
            if (sNow.activeCampaignId === ctx.activeCampaignId) {
                // Replies commit later; manual map movement since generation always wins.
                if (ctx.state?.context && movementPositionKey(ctx.state.context) !== movementPositionKey(sNow.context)) return;
                if (await applyStoryMovement(ctx.lastAssistantContent, ctx.activeCampaignId)) return;
                const { outcome, created } = anchorSceneLocation(
                    ctx.lastAssistantContent,
                    sNow.locationLedger ?? [],
                    sNow.context.currentPlaceId ?? null,
                );
                if (created) sNow.addLocation(created);
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
