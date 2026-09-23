import { useEffect } from 'react';
import { closeWindow } from '../services/mods/mounts/windowStore';
import { modEventBus } from '../services/mods/events';
import { useAppStore } from '../store/useAppStore';
import { composeDeparture, mergeUpserts, bandFromLegs } from '../services/turn/departureComposer';
import { applyTravelAdvance } from './TravelButton';
import { applyAbandonJourney } from './chat/AbandonJourneyChip';
import type { TravelHop, TravelMode } from '../types';

/**
 * WO 6.5 — bridge between the World Map mod's `travelRequest` event and the
 * host's direct departure flow.
 *
 * The mod owns the pathfinder and the chunk store, so it computes the route
 * (terrain-real, multi-hop) and emits `mod.worldmap.travelRequest` on commit.
 * The host owns the travel state, so this listener translates the event into a
 * `composeDeparture` call that immediately applies the `depart()` transition
 * without routine chat output. No LLM call, no intent,
 * no composer injection.
 *
 * It also carries the map panel's two journey controls — Continue and
 * Abandon. Advancing a day by clicking a 32px cell is a fiddly way to spend a
 * press, so the map's route panel becomes the journey's control while one is
 * running. Both actions run the exact functions the composer strip's buttons
 * run: the mod owns route geometry, the host owns travel state, and one act
 * must not have two implementations.
 *
 * Renders nothing — this is a side-effect-only component. Mounted once in
 * `App.tsx`, active only when a campaign is open.
 */
export function WorldMapTravelBridge() {
    const activeCampaignId = useAppStore(s => s.activeCampaignId);
    const updateLocation = useAppStore(s => s.updateLocation);
    const updateContext = useAppStore(s => s.updateContext);

    useEffect(() => {
        if (!activeCampaignId) return;
        const unsubscribe = modEventBus.on('mod.worldmap.travelRequest', (payload) => {
            const data = payload as {
                fromId: string;
                toId: string;
                mode: TravelMode;
                hops: TravelHop[];
            };
            const state = useAppStore.getState();
            const locationLedger = state.locationLedger;
            const fromId = data.fromId;
            const toId = data.toId;
            if (!fromId || !toId || fromId === toId || state.context.travel) return;
            const target = locationLedger.find(l => l.id === toId);
            if (!target) return;

            const currentWorldDay = state.context.worldDay;
            const firstHopLegs = data.hops && data.hops.length > 0 ? data.hops[0].legs : 3;

            const result = composeDeparture({
                fromId,
                toId,
                mode: data.mode,
                band: bandFromLegs(firstHopLegs, data.mode),
                ledger: locationLedger,
                hops: data.hops && data.hops.length > 0 ? data.hops : undefined,
                deps: { updateLocation, updateContext },
                currentWorldDay,
                currentTravelMinutes: state.context.travelMinutesToday,
            });
            if (!result) return;

            state.updateContext(result.contextPatch);
            if (result.ledgerUpsert && result.ledgerUpsert.length > 0) {
                state.setLocationLedger(mergeUpserts(locationLedger, result.ledgerUpsert));
            }


        });
        const unsubscribeAdvance = modEventBus.on('mod.worldmap.travelAdvance', () => {
            applyTravelAdvance();
        });
        const unsubscribeAbandon = modEventBus.on('mod.worldmap.travelAbandon', () => {
            applyAbandonJourney();
        });
        const unsubscribeRoleplay = modEventBus.on('mod.worldmap.roleplayRequest', (rawPayload) => {
            const payload = rawPayload as Record<string, unknown> | undefined;
            const state = useAppStore.getState();
            const scene = state.context.mapEncounter;
            // The store's `isStreaming` is never set — the turn streams through
            // local state in useChatOperations — so on its own this guard never
            // fired. `pipelinePhase` is live for the whole turn; the selection
            // menu and the chat's busy flag check the same pair.
            const storyBusy = state.isStreaming || state.pipelinePhase !== 'idle';
            if (!payload || payload.campaignId !== state.activeCampaignId || !scene || storyBusy
                || payload.key !== scene.key || payload.placeId !== state.context.currentPlaceId
                || payload.worldDay !== state.context.worldDay || payload.leg !== (state.context.travel?.leg ?? null)
                || scene.placeId !== state.context.currentPlaceId || scene.worldDay !== state.context.worldDay
                || scene.leg !== (state.context.travel?.leg ?? null)) return;
            if (typeof payload.kind !== 'string' || !['reply', 'camp', 'look'].includes(payload.kind)
                || (payload.kind === 'reply' && (scene.quiet || scene.status !== 'available'
                    || (state.context.mapWorldSetting && (scene.worldProfile ?? 'fantasy') !== state.context.mapWorldSetting.id)))
                || typeof payload.text !== 'string' || !payload.text.trim()) return;
            state.injectToComposer(payload.text.trim().slice(0, 2000));
            closeWindow('mod.worldmap.map-canvas');
        });
        const unsubscribeCurrent = modEventBus.on('mod.worldmap.setCurrentPlace', (payload) => {
            const locationId = typeof payload?.locationId === 'string' ? payload.locationId : null;
            if (!locationId) return;
            updateContext({ currentPlaceId: locationId, currentFeature: null, travel: null });
        });
        return () => {
            unsubscribe();
            unsubscribeAdvance();
            unsubscribeAbandon();
            unsubscribeCurrent();
            unsubscribeRoleplay();
        };
    }, [activeCampaignId, updateLocation, updateContext]);

    return null;
}