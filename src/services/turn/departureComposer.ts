/**
 * WO 3.1 — shared departure-flow helper.
 *
 * Two entry points start travel: the `TRAVEL HERE` button on each place row in
 * `LocationLedgerModal`, and the `TRAVEL` button in the composer action strip.
 * Both must produce a byte-identical departure sentence and an identical
 * `PendingTravelIntent`, and both must ensure the direct connection exists
 * before the intent is set (the intent's resolver — `commitTravelIntent` —
 * looks up the connection).
 *
 * This module owns that shared path. It does NOT touch the Zustand store
 * directly: the caller passes the ledger data and the store actions it wants
 * applied (`updateLocation`, `updateContext`, `injectToComposer`,
 * `setPendingTravelIntent`). Pure with respect to data, side-effecting only
 * through the supplied callbacks — so it is unit-testable without a store.
 *
 * The composer strip's picker shows a list of candidates. `travellableFrom`
 * returns the destinations the player may pick, with the connection band
 * already resolved. Transit nodes and the current place are excluded — the
 * same rule `canTravelHere` enforced inside the modal.
 */
import type { LocationEntry, TravelMode } from '../../types';
import type { DistanceBand } from '../location/distance';
import { connectionBand } from '../locationParser';
import { buildDepartureSentence, type PendingTravelIntent } from './travelState';

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
 * The store actions `composeDeparture` applies. Passed in by the caller so
 * this module stays store-agnostic and testable. `updateLocation` mutates the
 * ledger (only when no direct connection exists, to create one bidirectionally
 * at the chosen band); `updateContext` persists the travel-mode choice;
 * `injectToComposer` places the sentence in the composer; `setPendingTravelIntent`
 * arms the intent consumed at send.
 */
export type DepartureDeps = {
    updateLocation: (id: string, patch: Partial<LocationEntry>) => void;
    updateContext: (patch: { travelMode?: TravelMode }) => void;
    injectToComposer: (text: string) => void;
    setPendingTravelIntent: (intent: PendingTravelIntent | null) => void;
};

/**
 * Ensure a direct bidirectional connection exists between `fromId` and `toId`
 * at the chosen `band`. If a connection already exists, it is left untouched
 * (its existing band wins — `connectionBand` resolves it at send time). The
 * reciprocal edge is created or kept in sync on the destination.
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

/**
 * Compose a departure: ensure the connection, persist the mode, inject the
 * sentence, arm the intent. Returns the sentence and intent so the caller
 * (and tests) can assert on them. The two entry points call this, so their
 * outputs cannot drift.
 */
export function composeDeparture(args: {
    fromId: string;
    toId: string;
    mode: TravelMode;
    band: DistanceBand;
    ledger: readonly LocationEntry[];
    deps: DepartureDeps;
}): { sentence: string; intent: PendingTravelIntent } {
    const { fromId, toId, mode, band, ledger, deps } = args;
    const target = ledger.find(l => l.id === toId);
    if (!target) throw new Error(`composeDeparture: destination ${toId} not in ledger`);

    const usedBand = ensureConnection(fromId, toId, band, ledger, deps.updateLocation);
    void usedBand;

    deps.updateContext({ travelMode: mode });
    const sentence = buildDepartureSentence(target.name, mode);
    deps.injectToComposer(sentence);
    const intent: PendingTravelIntent = {
        toId,
        mode,
        agency: 'free',
        injectedText: sentence,
    };
    deps.setPendingTravelIntent(intent);
    return { sentence, intent };
}