import { useEffect } from 'react';
import { modEventBus } from '../services/mods/events';
import { useAppStore } from '../store/useAppStore';
import { composeDeparture } from '../services/turn/departureComposer';
import { DISTANCE_BANDS, type DistanceBand } from '../services/location/distance';
import { gridsPerDayFor } from '../services/location/travelModes';
import type { TravelHop, TravelMode } from '../types';

/**
 * WO 6.1 — bridge between the World Map mod's `travelRequest` event and the
 * host's shared departure flow.
 *
 * The mod owns the pathfinder and the chunk store, so it computes the route
 * (terrain-real, multi-hop) and emits `mod.worldmap.travelRequest` on commit.
 * The host owns the departure sentence and the pending intent (via
 * `composeDeparture`), so this listener translates the event into the same
 * `composeDeparture` call the Places panel and the composer TRAVEL button
 * use. This is the anti-drift guarantee: all three entry points produce a
 * byte-identical departure sentence.
 *
 * The hops (per-hop terrain-real leg counts) are threaded into the
 * `PendingTravelIntent` so `commitTravelIntent` can create transit nodes per
 * hop and the travel advance track can cross hop boundaries. The departure
 * sentence names only the final destination (WO 6.1 §2).
 *
 * Renders nothing — this is a side-effect-only component. Mounted once in
 * `App.tsx`, active only when a campaign is open.
 */
export function WorldMapTravelBridge() {
    const activeCampaignId = useAppStore(s => s.activeCampaignId);
    // Read the store actions once — they are stable references (Zustand
    // actions don't change between renders). The listener closes over them
    // and reads the latest data at emit time via `useAppStore.getState()`,
    // so the effect only re-subscribes when `activeCampaignId` changes.
    const updateLocation = useAppStore(s => s.updateLocation);
    const updateContext = useAppStore(s => s.updateContext);
    const injectToComposer = useAppStore(s => s.injectToComposer);
    const setPendingTravelIntent = useAppStore(s => s.setPendingTravelIntent);

    useEffect(() => {
        if (!activeCampaignId) return;
        const unsubscribe = modEventBus.on('mod.worldmap.travelRequest', (payload) => {
            const data = payload as {
                fromId: string;
                toId: string;
                mode: TravelMode;
                hops: TravelHop[];
            };
            // Read the latest ledger at emit time so a ledger change between
            // subscription and emit is reflected.
            const state = useAppStore.getState();
            const locationLedger = state.locationLedger;
            const fromId = data.fromId;
            const toId = data.toId;
            if (!fromId || !toId || fromId === toId) return;
            const target = locationLedger.find(l => l.id === toId);
            if (!target) return;

            // Derive the band for the connection from the first hop's leg
            // count (terrain-real). For a single-hop route with no hops
            // array (defensive), fall back to a regional default — the host's
            // `ensureConnection` will create the connection at that band.
            const firstHopLegs = data.hops && data.hops.length > 0 ? data.hops[0].legs : 3;
            const band = bandFromLegs(firstHopLegs, data.mode);

            // The hops carry terrain-real leg counts; thread them into the
            // intent so `commitTravelIntent` can route through transit nodes
            // per hop. The departure sentence names only the final
            // destination — `composeDeparture` builds it via
            // `buildDepartureSentence(target.name, mode)`.
            composeDeparture({
                fromId,
                toId,
                mode: data.mode,
                band,
                ledger: locationLedger,
                deps: {
                    updateLocation,
                    updateContext,
                    injectToComposer,
                    setPendingTravelIntent,
                },
            });

            // If the route is multi-hop, augment the intent with the hops so
            // `commitTravelIntent` uses `departMultiHop`. `composeDeparture`
            // set a single-hop intent; we replace it with a multi-hop intent
            // that carries the hops. The `injectedText` stays the same
            // (built from the final destination), so `sentTextCommitsIntent`
            // still matches.
            if (data.hops && data.hops.length > 1) {
                const sentence = `We set out for ${target.name} by ${data.mode}.`;
                setPendingTravelIntent({
                    toId,
                    mode: data.mode,
                    agency: 'free',
                    injectedText: sentence,
                    hops: data.hops,
                });
            }
        });
        return () => unsubscribe();
        // Only re-subscribe when the campaign changes or the store actions
        // change (they don't — Zustand actions are stable). Data is read at
        // emit time, not subscription time.
    }, [activeCampaignId, updateLocation, updateContext, injectToComposer, setPendingTravelIntent]);

    return null;
}

/**
 * Derive a `DistanceBand` from a terrain-real leg count, mirrored from
 * `travelState.ts`'s private `bandFromLegs`. The first hop's leg count drives
 * the connection's band label so the ledger records a distance consistent
 * with the terrain the party will actually cover.
 */
function bandFromLegs(legs: number, mode: TravelMode): DistanceBand {
    const grids = Math.max(1, Math.round(legs * gridsPerDayFor(mode)));
    for (const band of DISTANCE_BANDS) {
        if (band.id === 'adjacent') continue;
        if (grids >= band.minGrids && grids <= band.maxGrids) return band.id;
    }
    return 'farthest';
}