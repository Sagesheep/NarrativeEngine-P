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

/**
 * Pending travel intent set by the `TRAVEL HERE` departure flow (WO3 §5) and
 * consumed at send time. Pairs with the composer injection: the injection is
 * the text the player edits/sends/clears; the intent is the data. Sending the
 * injected sentence commits the intent; sending anything else drops it.
 */
export type PendingTravelIntent = {
    toId: string;
    mode: TravelMode;
    agency: 'free' | 'constrained';
    /** The exact sentence injected into the composer. Used to detect whether
     *  the player sent the travel departure (commit) or typed something else
     *  (drop). The player may edit the sentence; we match on a prefix so a
     *  lightly-edited send still commits. */
    injectedText: string;
    /** WO 6.1 §2 — the multi-hop route, terrain-priced, when the journey is
     *  more than one hop. Each hop carries `fromId`/`toId` (ledger place ids)
     *  and `legs` (terrain-real leg count from the pathfinder). The host's
     *  `commitTravelIntent` resolves these into transit nodes per hop. Absent
     *  for a single-hop journey (the WO 3 case) — `commitTravelIntent` then
     *  looks up the direct connection's band, as before. */
    hops?: TravelHop[];
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
 * `depart(to, mode, agency)` — start a journey.
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
}): TransitionResult {
    const { fromId, toId, band, mode, agency = 'free', ledger } = params;
    if (fromId === toId) return EMPTY;

    const connectionUpserts = ensureDirectConnection(fromId, toId, band, ledger);
    const ledgerWithConnections = mergeUpserts(ledger, connectionUpserts);
    const { transitId, upsert: transitUpserts } = ensureTransitNode(fromId, toId, band, ledgerWithConnections);
    const totalLegs = legsFor(band, mode);

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
    const contextPatch: Partial<GameContext> = {
        travel,
        travelMode: mode,
        currentPlaceId: transitId,
        currentFeature: null,
    };
    return { travel, contextPatch, ledgerUpsert: ledgerUpserts.length > 0 ? ledgerUpserts : undefined };
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
 * departure sentence (built by the caller via `buildDepartureSentence`) names
 * only the final destination.
 */
export function departMultiHop(params: {
    fromId: string;
    toId: string;
    mode: TravelMode;
    hops: TravelHop[];
    agency?: 'free' | 'constrained';
    ledger: LocationEntry[];
}): TransitionResult {
    const { fromId, toId, mode, hops, agency = 'free', ledger } = params;
    if (fromId === toId) return EMPTY;
    if (hops.length === 0) return EMPTY;
    if (hops.length === 1) {
        // A single-hop route is an ordinary depart. Derive the band from the
        // hop's leg count so the transit node and connection are created at a
        // band consistent with the terrain-real distance.
        const band = bandFromLegs(hops[0].legs, mode);
        return depart({ fromId, toId, band, mode, agency, ledger });
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
    const contextPatch: Partial<GameContext> = {
        travel,
        travelMode: mode,
        currentPlaceId: firstHop.transitId,
        currentFeature: null,
    };
    return { travel, contextPatch, ledgerUpsert: allUpserts.length > 0 ? allUpserts : undefined };
}

/**
 * `advance()` — move to the next leg. Called at commit while travelling.
 * Increments `leg` and `worldDay` by 1. When `leg` exceeds `totalLegs`, the
 * journey is over — see `arrive`.
 *
 * For a multi-hop journey (WO 6.1 §2), advancing past a hop's leg range
 * arrives at that hop's destination and starts the next hop from there: the
 * party reaches the intermediate place, `currentPlaceId` moves to it for one
 * turn, then the next hop's transit node takes over. The overall `fromId`/
 * `toId` stay the journey's endpoints; only `hopIndex` and `transitId` move.
 *
 * Returns the new travel state (with leg+1) and a context patch that writes
 * `worldDay + 1`. The caller decides whether to also apply `arrive`.
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

// ── Departure flow helpers (WO3 §5) ──────────────────────────────────────

/**
 * Build the composer sentence for a departure: `We set out for {name} by {mode}.`
 * Uses the lowercase mode id (`foot`, `cart`, `horseback`, `flying`) so the
 * sentence reads naturally — "by foot", "by cart" — matching the `[TRAVEL]`
 * block's wording (WO3 §8). The player edits this sentence or clears it.
 * Sending it commits the intent.
 */
export function buildDepartureSentence(destinationName: string, mode: TravelMode): string {
    return `We set out for ${destinationName} by ${mode}.`;
}

/**
 * Resolve a pending travel intent into a `depart` transition. Looks up the
 * band from the direct connection (creating it is the caller's job — the
 * `TRAVEL HERE` flow ensures the connection exists before setting the intent).
 * Returns `null` when the journey cannot start (same place, or `adjacent` —
 * adjacent destinations never enter the travel state, WO3 §6).
 *
 * WO 6.1 §2 — when the intent carries `hops` (a multi-hop route from the
 * pathfinder), resolves via `departMultiHop` instead. The hops' terrain-real
 * leg counts drive the transit nodes and the total leg count; the departure
 * sentence (already injected by the caller) names only the final destination.
 */
export function commitTravelIntent(
    intent: PendingTravelIntent,
    fromId: string,
    ledger: LocationEntry[],
): TransitionResult | null {
    if (intent.toId === fromId) return null;
    if (intent.hops && intent.hops.length > 0) {
        return departMultiHop({
            fromId,
            toId: intent.toId,
            mode: intent.mode,
            hops: intent.hops,
            agency: intent.agency,
            ledger,
        });
    }
    const from = ledger.find(l => l.id === fromId);
    if (!from) return null;
    const conn = from.connections.find(c => c.toId === intent.toId);
    if (!conn) return null;
    const band = connectionBand(conn);
    if (band === 'adjacent') return null;
    return depart({
        fromId,
        toId: intent.toId,
        band,
        mode: intent.mode,
        agency: intent.agency,
        ledger,
    });
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
function bandFromLegs(legs: number, mode: TravelMode): DistanceBand {
    const grids = Math.max(1, Math.round(legs * gridsPerDayFor(mode)));
    for (const band of DISTANCE_BANDS) {
        if (band.id === 'adjacent') continue;
        if (grids >= band.minGrids && grids <= band.maxGrids) return band.id;
    }
    return 'farthest';
}

/**
 * Does the sent text commit the pending intent? Matches on a normalized prefix
 * so a lightly-edited sentence still commits, but a completely different text
 * drops it. The player may edit the destination name or mode wording; they may
 * not substitute an entirely different action and still expect travel to start.
 */
export function sentTextCommitsIntent(sentText: string, intent: PendingTravelIntent): boolean {
    const sent = sentText.trim().toLowerCase();
    const injected = intent.injectedText.trim().toLowerCase();
    if (!sent || !injected) return false;
    // The sentence starts with "We set out for" — match on that prefix so the
    // player can edit the destination/mode and still commit. A completely
    // different sentence (e.g. "I attack the goblin") does not match.
    const prefix = 'we set out for';
    return sent.startsWith(prefix) && injected.startsWith(prefix);
}