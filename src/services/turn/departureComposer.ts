/**
 * WO 6.5 — shared departure-flow helper. Travel is now an engine action: the
 * first press departs (creating the journey state and landing on camp 1), and
 * no LLM turn runs. This module owns the shared path so all three entry points
 * (map, Places panel, composer TRAVEL) produce the identical `TransitionResult`.
 *
 * It does NOT touch the Zustand store directly: the caller passes the ledger
 * data and the store actions it wants applied. Pure with respect to data,
 * side-effecting only through the supplied callbacks — so it is unit-testable
 * without a store.
 *
 * The composer strip's picker shows a list of candidates. `travellableFrom`
 * returns the destinations the player may pick, with the connection band
 * already resolved. Transit nodes and the current place are excluded.
 */
import type { GameContext, LocationEntry, TravelMode, TravelHop } from '../../types';
import { DISTANCE_BANDS, type DistanceBand } from '../location/distance';
import { gridsPerDayFor } from '../location/travelModes';
import { connectionBand } from '../locationParser';
import {
    depart,
    departMultiHop,
    mergeUpserts,
    type TransitionResult,
} from './travelState';

/** A candidate destination, with the connection band resolved for display. */
export type TravelCandidate = {
    location: LocationEntry;
    /** The connection's band if one exists; `null` when no direct connection. */
    band: DistanceBand | null;
};

/**
 * The destinations the player may travel to from `fromId`: every non-transit
 * place in the ledger that is not the current place. `band` is the resolved
 * connection band when a direct connection exists, else `null` — the picker
 * shows "no road yet" and lets the player choose a band before composing.
 */
export function travellableFrom(
    fromId: string | null | undefined,
    ledger: readonly LocationEntry[],
): TravelCandidate[] {
    if (!fromId) return [];
    return ledger
        .filter(loc => loc.id !== fromId && loc.kind !== 'transit')
        .map(loc => {
            const from = ledger.find(l => l.id === fromId);
            const conn = from?.connections.find(c => c.toId === loc.id);
            return { location: loc, band: conn ? connectionBand(conn) : null };
        });
}

/**
 * Ensure a direct bidirectional connection exists between `fromId` and `toId`
 * at the chosen `band`. If a connection already exists, it is left untouched
 * (its existing band wins). The reciprocal edge is created or kept in sync on
 * the destination.
 *
 * Returns the band the journey will use: the existing connection's band when
 * present, otherwise `band`.
 */
export function ensureConnection(
    fromId: string,
    toId: string,
    band: DistanceBand,
    ledger: readonly LocationEntry[],
    updateLocation: (id: string, patch: Partial<LocationEntry>) => void,
): DistanceBand {
    const from = ledger.find(l => l.id === fromId);
    const target = ledger.find(l => l.id === toId);
    if (!from || !target) return band;
    const existing = from.connections.find(c => c.toId === toId);
    if (existing) return connectionBand(existing);
    updateLocation(fromId, {
        connections: [...from.connections, { toId, band }],
    });
    const reciprocal = target.connections.some(c => c.toId === fromId);
    updateLocation(toId, {
        connections: reciprocal
            ? target.connections.map(c => c.toId === fromId ? { ...c, band } : c)
            : [...target.connections, { toId: fromId, band }],
    });
    return band;
}

/** Store actions the departure applies. */
export type DepartureDeps = {
    updateLocation: (id: string, patch: Partial<LocationEntry>) => void;
    updateContext: (patch: Partial<GameContext>) => void;
};

/**
 * WO 6.5 — start a journey directly. Ensures the connection, persists the
 * mode, and applies the `depart()` transition. Returns the `TransitionResult`
 * (travel state + context patch + ledger upserts) so the caller can apply it
 * to the store and post the engine checkpoint system message. No LLM call.
 *
 * For multi-hop routes (from the map's pathfinder), pass `hops`; the function
 * delegates to `departMultiHop`. The departure names only the final
 * destination.
 */
export function composeDeparture(args: {
    fromId: string;
    toId: string;
    mode: TravelMode;
    band: DistanceBand;
    ledger: readonly LocationEntry[];
    hops?: TravelHop[];
    deps: DepartureDeps;
    currentWorldDay?: number;
}): TransitionResult | null {
    const { fromId, toId, mode, band, ledger, hops, deps, currentWorldDay } = args;
    const target = ledger.find(l => l.id === toId);
    if (!target) throw new Error(`composeDeparture: destination ${toId} not in ledger`);

    const usedBand = ensureConnection(fromId, toId, band, ledger, deps.updateLocation);
    void usedBand;

    deps.updateContext({ travelMode: mode });

    const workingLedger = [...ledger];
    let result: TransitionResult;
    if (hops && hops.length > 1) {
        result = departMultiHop({ fromId, toId, mode, hops, ledger: workingLedger, currentWorldDay });
    } else if (hops && hops.length === 1) {
        const hopBand = bandFromLegs(hops[0].legs, mode);
        result = depart({ fromId, toId, band: hopBand, mode, ledger: workingLedger, currentWorldDay });
    } else {
        result = depart({ fromId, toId, band, mode, ledger: workingLedger, currentWorldDay });
    }

    return result;
}

/** Merge ledger upserts into a ledger — re-exported from travelState. */
export { mergeUpserts };

/**
 * Derive a `DistanceBand` from a terrain-real leg count. Mirrors the private
 * `bandFromLegs` in `travelState.ts`. Used for single-hop map routes.
 */
export function bandFromLegs(legs: number, mode: TravelMode): DistanceBand {
    const grids = Math.max(1, Math.round(legs * gridsPerDayFor(mode)));
    for (const band of DISTANCE_BANDS) {
        if (band.id === 'adjacent') continue;
        if (grids >= band.minGrids && grids <= band.maxGrids) return band.id;
    }
    return 'farthest';
}