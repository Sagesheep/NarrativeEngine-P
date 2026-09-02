import type { GameContext, LocationEntry, TravelHop, TravelState, TravelMode } from '../../types';
import type { DistanceBand } from '../location/distance';
import { DISTANCE_BANDS } from '../location/distance';
import { connectionBand } from '../locationParser';
import { legsFor, gridsPerDayFor } from '../location/travelModes';
import { newLocationId } from '../../utils/locationIds';

/** Result of a transition: the new travel state plus the context writes it implies. */
export type TransitionResult = {
    travel: TravelState | null;
    /** Patch to apply to GameContext. */
    contextPatch: Partial<GameContext>;
    /** Ledger writes: entries to upsert (add or replace) into the location ledger. */
    ledgerUpsert?: LocationEntry[];
};

const EMPTY: TransitionResult = { travel: null, contextPatch: {} };

/**
 * Find an existing transit node for the A→B edge, if one was created before.
 * A transit node is reused when its connections include BOTH endpoints.
 */
export function findTransitNode(fromId: string, toId: string, ledger: LocationEntry[]): LocationEntry | undefined {
    return ledger.find(entry =>
        entry.kind === 'transit'
        && entry.connections.some(c => c.toId === fromId)
        && entry.connections.some(c => c.toId === toId),
    );
}

/** Build the canonical transit-node name: `Road between {from} and {to}`. */
export function transitName(fromName: string, toName: string): string {
    return `Road between ${fromName} and ${toName}`;
}

/**
 * Create a transit node for the A→B edge. Reuses an existing one when present
 * (the caller passes the ledger; this function is idempotent). The node carries
 * a connection to each endpoint at the same band as the direct edge.
 */
export function ensureTransitNode(
    fromId: string,
    toId: string,
    band: DistanceBand,
    ledger: LocationEntry[],
): { transitId: string; upsert: LocationEntry[] } {
    const existing = findTransitNode(fromId, toId, ledger);
    if (existing) return { transitId: existing.id, upsert: [] };

    const from = ledger.find(l => l.id === fromId);
    const to = ledger.find(l => l.id === toId);
    const fromName = from?.name ?? fromId;
    const toName = to?.name ?? toId;
    const transit: LocationEntry = {
        id: newLocationId(),
        name: transitName(fromName, toName),
        aliases: '',
        broadLocation: from?.broadLocation || to?.broadLocation || '',
        features: [],
        connections: [
            { toId: fromId, band },
            { toId: toId, band },
        ],
        description: '',
        firstSeenScene: String(Date.now()),
        lastSeenScene: String(Date.now()),
        source: 'manual',
        kind: 'transit',
    };
    return { transitId: transit.id, upsert: [transit] };
}

/**
 * Ensure both endpoints carry a direct connection at `band`. Returns ledger
 * patches (entries to upsert) for any missing or stale-band connections. The
 * connection is symmetric — both directions are written.
 */
export function ensureDirectConnection(
    fromId: string,
    toId: string,
    band: DistanceBand,
    ledger: LocationEntry[],
): LocationEntry[] {
    const upserts: LocationEntry[] = [];
    const from = ledger.find(l => l.id === fromId);
    const to = ledger.find(l => l.id === toId);
    if (!from || !to) return upserts;

    const fromConn = from.connections.find(c => c.toId === toId);
    if (!fromConn || connectionBand(fromConn) !== band) {
        const updatedFrom: LocationEntry = fromConn
            ? { ...from, connections: from.connections.map(c => c.toId === toId ? { ...c, band } : c) }
            : { ...from, connections: [...from.connections, { toId, band }] };
        upserts.push(updatedFrom);
    }
    const toConn = to.connections.find(c => c.toId === fromId);
    if (!toConn || connectionBand(toConn) !== band) {
        const updatedTo: LocationEntry = toConn
            ? { ...to, connections: to.connections.map(c => c.toId === fromId ? { ...c, band } : c) }
            : { ...to, connections: [...to.connections, { toId: fromId, band }] };
        upserts.push(updatedTo);
    }
    return upserts;
}

/**
 * `depart(to, mode, agency)` — start a journey. WO 6.5: the first press is
 * camp 1, so `depart` advances the day and lands the party on the first
 * checkpoint. A single-day journey (`totalLegs <= 1`) arrives immediately —
 * there are no camps, just the destination.
 *
 * The caller supplies the band for the A→B edge. If a direct connection does
 * not exist at that band, it is created (and the back-link too). A transit
 * node is created (or reused) for the road between the two endpoints.
 *
 * `adjacent` destinations never enter the travel state — the caller must gate
 * on the band before calling `depart`. This function will still produce a
 * one-leg journey for `adjacent`, but the work order rules it out at the UI.
 */
export function depart(params: {
    fromId: string;
    toId: string;
    band: DistanceBand;
    mode: TravelMode;
    agency?: 'free' | 'constrained';
    ledger: LocationEntry[];
    currentWorldDay?: number;
}): TransitionResult {
    const { fromId, toId, band, mode, agency = 'free', ledger, currentWorldDay } = params;
    if (fromId === toId) return EMPTY;

    const connectionUpserts = ensureDirectConnection(fromId, toId, band, ledger);
    const ledgerWithConnections = mergeUpserts(ledger, connectionUpserts);
    const { transitId, upsert: transitUpserts } = ensureTransitNode(fromId, toId, band, ledgerWithConnections);
    const totalLegs = legsFor(band, mode);
    const nextDay = (currentWorldDay ?? 0) + 1;

    const travel: TravelState = {
        fromId,
        toId,
        transitId,
        mode,
        leg: 1,
        totalLegs,
        agency,
    };
    const ledgerUpserts = [...connectionUpserts, ...transitUpserts];
    const ledgerPatch = ledgerUpserts.length > 0 ? ledgerUpserts : undefined;

    // Single-day journey: depart and arrive in one press.
    if (totalLegs <= 1) {
        const arriveResult = arrive(travel, nextDay);
        return { ...arriveResult, ledgerUpsert: ledgerPatch };
    }

    const contextPatch: Partial<GameContext> = {
        travel,
        travelMode: mode,
        currentPlaceId: transitId,
        currentFeature: null,
        worldDay: nextDay,
    };
    return { travel, contextPatch, ledgerUpsert: ledgerPatch };
}

/**
 * WO 6.1 §2 — start a multi-hop journey. Each hop is a leg of the route
 * through the ledger graph (A→B→C where no direct A→C connection exists).
 * The pathfinder costs each hop terrain-realistically; the mod supplies the
 * hop sequence with per-hop leg counts.
 *
 * A transit node is created (or reused) for each hop. The overall `fromId`
 * and `toId` are the journey's endpoints, so the `[TRAVEL]` block names only
 * the destination — intermediate places are the engine's business, not the
 * prose's (WO 6.1 §2). `totalLegs` is the sum of all hops' legs; `leg` is the
 * cumulative leg across the whole journey.
 *
 * Direct connections are ensured for every adjacent pair in the route, so the
 * ledger's topology reflects the journey the party actually walked. The
 * engine's checkpoint system message names only the final destination.
 */
export function departMultiHop(params: {
    fromId: string;
    toId: string;
    mode: TravelMode;
    hops: TravelHop[];
    agency?: 'free' | 'constrained';
    ledger: LocationEntry[];
    currentWorldDay?: number;
}): TransitionResult {
    const { fromId, toId, mode, hops, agency = 'free', ledger, currentWorldDay } = params;
    if (fromId === toId) return EMPTY;
    if (hops.length === 0) return EMPTY;
    if (hops.length === 1) {
        // A single-hop route is an ordinary depart. Derive the band from the
        // hop's leg count so the transit node and connection are created at a
        // band consistent with the terrain-real distance.
        const band = bandFromLegs(hops[0].legs, mode);
        return depart({ fromId, toId, band, mode, agency, ledger, currentWorldDay });
    }

    // Ensure direct connections + transit nodes for every hop. Each hop's
    // band is derived from its terrain-real leg count, so the ledger records
    // the distance the party actually covered, not a guessed midpoint.
    let workingLedger = ledger;
    const allUpserts: LocationEntry[] = [];
    const resolvedHops: TravelHop[] = [];
    for (const hop of hops) {
        const band = bandFromLegs(hop.legs, mode);
        const connectionUpserts = ensureDirectConnection(hop.fromId, hop.toId, band, workingLedger);
        if (connectionUpserts.length > 0) {
            allUpserts.push(...connectionUpserts);
            workingLedger = mergeUpserts(workingLedger, connectionUpserts);
        }
        const { transitId, upsert: transitUpserts } = ensureTransitNode(hop.fromId, hop.toId, band, workingLedger);
        if (transitUpserts.length > 0) {
            allUpserts.push(...transitUpserts);
            workingLedger = mergeUpserts(workingLedger, transitUpserts);
        }
        resolvedHops.push({ ...hop, transitId, legs: Math.max(1, hop.legs) });
    }

    const totalLegs = resolvedHops.reduce((sum, h) => sum + h.legs, 0);
    const firstHop = resolvedHops[0];
    const nextDay = (currentWorldDay ?? 0) + 1;
    const travel: TravelState = {
        fromId,
        toId,
        transitId: firstHop.transitId,
        mode,
        leg: 1,
        totalLegs,
        agency,
        hops: resolvedHops,
        hopIndex: 0,
    };
    // Single-day multi-hop: depart and arrive in one press.
    if (totalLegs <= 1) {
        const arriveResult = arrive(travel, nextDay);
        return { ...arriveResult, ledgerUpsert: allUpserts.length > 0 ? allUpserts : undefined };
    }
    const contextPatch: Partial<GameContext> = {
        travel,
        travelMode: mode,
        currentPlaceId: firstHop.transitId,
        currentFeature: null,
        worldDay: nextDay,
    };
    return { travel, contextPatch, ledgerUpsert: allUpserts.length > 0 ? allUpserts : undefined };
}

/**
 * `advance()` — move to the next leg. WO 6.5: called by the engine travel
 * press (not the post-commit advance track — that is now the safety-valve
 * only). Increments `leg` and `worldDay` by 1. When `leg` exceeds
 * `totalLegs`, the journey is over — see `arrive`.
 *
 * For a multi-hop journey (WO 6.1 §2), advancing past a hop's leg range
 * arrives at that hop's destination and starts the next hop from there: the
 * party reaches the intermediate place, `currentPlaceId` moves to it for one
 * turn, then the next hop's transit node takes over. The overall `fromId`/
 * `toId` stay the journey's endpoints; only `hopIndex` and `transitId` move.
 *
 * Returns the new travel state (with leg+1) and a context patch that writes
 * `worldDay + 1`.
 */
export function advance(state: TravelState, currentWorldDay: number | undefined): TransitionResult {
    const nextLeg = state.leg + 1;
    const nextDay = (currentWorldDay ?? 0) + 1;
    if (nextLeg > state.totalLegs) {
        return arrive(state, nextDay);
    }
    // Multi-hop: check whether we're crossing a hop boundary. Each hop covers
    // a leg range; when the new leg falls in the next hop, the party has
    // reached the current hop's destination and starts the next hop from its
    // transit node.
    if (state.hops && state.hops.length > 1 && state.hopIndex !== undefined) {
        let cumulative = 0;
        for (let i = 0; i < state.hops.length; i += 1) {
            cumulative += state.hops[i].legs;
            if (nextLeg <= cumulative) {
                if (i === state.hopIndex) break;
                // Crossing into hop i: the party arrived at hop (i-1)'s
                // destination (which is hop i's fromId) and now sits on hop
                // i's transit node.
                const nextHop = state.hops[i];
                const travel: TravelState = {
                    ...state,
                    leg: nextLeg,
                    hopIndex: i,
                    transitId: nextHop.transitId,
                };
                return { travel, contextPatch: { travel, worldDay: nextDay, currentPlaceId: nextHop.transitId, currentFeature: null } };
            }
        }
    }
    const travel: TravelState = { ...state, leg: nextLeg };
    return { travel, contextPatch: { travel, worldDay: nextDay } };
}

/**
 * `arrive()` — the journey is over. Sets `currentPlaceId` to `toId`, clears
 * `travel`, and advances the day. The transit node is left in the ledger as a
 * walked road (it remains in the UI, visually marked, excluded from Nearby).
 */
export function arrive(state: TravelState, nextDay: number): TransitionResult {
    return {
        travel: null,
        contextPatch: {
            travel: null,
            currentPlaceId: state.toId,
            currentFeature: null,
            worldDay: nextDay,
        },
    };
}

/**
 * WO 6.5 §4 — abandon the active journey. Clears `travel` without arriving.
 * `currentPlaceId` stays wherever it is (the transit node — the party is on
 * the road and stops where they stopped). The host also clears the mod's
 * journey record via the location-watch (§4 of WO 6.2).
 */
export function abandonJourney(): TransitionResult {
    return { travel: null, contextPatch: { travel: null } };
}

/**
 * `halt()` — the fiction named a place that is neither the transit node nor
 * the destination. The journey was interrupted by the story. Clear `travel`
 * and let the header's position stand (the caller has already written the
 * header's place id to `currentPlaceId`).
 */
export function halt(): TransitionResult {
    return { travel: null, contextPatch: { travel: null } };
}

/**
 * `jump(to)` — a portal or scene cut moved the party to `toId` while no travel
 * was in progress. Not a journey — no legs, no day advance, no transit node.
 */
export function jump(toId: string): TransitionResult {
    return { travel: null, contextPatch: { currentPlaceId: toId, currentFeature: null, travel: null } };
}

/**
 * Detect the safety-valve condition: the header named a place that is neither
 * the transit node nor the destination. Returns true when the header's place
 * is unrelated to the active journey.
 *
 * For a multi-hop journey (WO 6.1 §2), every hop endpoint and every transit
 * node is a valid place to be — the party passes through intermediate places.
 * Only a place that is none of those triggers the safety valve.
 */
export function isUnrelatedPlace(headerPlaceId: string | null | undefined, state: TravelState): boolean {
    if (!headerPlaceId) return false;
    if (headerPlaceId === state.transitId || headerPlaceId === state.toId) return false;
    if (state.hops) {
        for (const hop of state.hops) {
            if (headerPlaceId === hop.transitId || headerPlaceId === hop.toId || headerPlaceId === hop.fromId) return false;
        }
    }
    if (headerPlaceId === state.fromId) return false;
    return true;
}

/** Merge upserts into a ledger, replacing by id. Pure; does not mutate input. */
export function mergeUpserts(ledger: LocationEntry[], upserts: LocationEntry[]): LocationEntry[] {
    if (upserts.length === 0) return ledger;
    const byId = new Map(ledger.map(l => [l.id, l] as const));
    for (const entry of upserts) byId.set(entry.id, entry);
    return [...byId.values()];
}

/**
 * WO 6.1 §2 — derive a `DistanceBand` from a terrain-real leg count. The
 * pathfinder costs each hop in terrain-weighted grids; `bandFromLegs` maps
 * that to the nearest band so the transit node and connection are labelled
 * consistently with the journey's actual distance. Used by `departMultiHop`
 * when creating transit nodes for each hop.
 *
 * The leg count is converted back to a grid estimate via the mode's
 * `gridsPerDay` (one leg ≈ one day ≈ `gridsPerDay` grids), then matched
 * against `DISTANCE_BANDS`. `adjacent` is never returned — a hop always
 * covers ground.
 */
export function bandFromLegs(legs: number, mode: TravelMode): DistanceBand {
    const grids = Math.max(1, Math.round(legs * gridsPerDayFor(mode)));
    for (const band of DISTANCE_BANDS) {
        if (band.id === 'adjacent') continue;
        if (grids >= band.minGrids && grids <= band.maxGrids) return band.id;
    }
    return 'farthest';
}