import { describe, expect, it, vi } from 'vitest';
import type { LocationEntry } from '../../types';
import {
    composeDeparture,
    ensureConnection,
    travellableFrom,
    mergeUpserts,
    bandFromLegs,
    type DepartureDeps,
} from '../departureComposer';

function makePlace(id: string, name: string, overrides: Partial<LocationEntry> = {}): LocationEntry {
    return {
        id,
        name,
        aliases: '',
        broadLocation: 'Region',
        features: [],
        connections: [],
        description: '',
        firstSeenScene: '001',
        lastSeenScene: '001',
        source: 'manual',
        ...overrides,
    };
}

function makeDeps(): DepartureDeps & {
    updateLocation: ReturnType<typeof vi.fn>;
    updateContext: ReturnType<typeof vi.fn>;
} {
    return {
        updateLocation: vi.fn(),
        updateContext: vi.fn(),
    };
}

describe('travellableFrom', () => {
    it('returns every non-current, non-transit place', () => {
        const ledger: LocationEntry[] = [
            makePlace('a', 'A'),
            makePlace('b', 'B'),
            makePlace('c', 'C', { kind: 'transit' }),
        ];
        const result = travellableFrom('a', ledger);
        expect(result.map(r => r.location.id)).toEqual(['b']);
        expect(result[0].band).toBeNull();
    });

    it('resolves the band of a direct connection', () => {
        const ledger: LocationEntry[] = [
            makePlace('a', 'A', { connections: [{ toId: 'b', band: 'far' }] }),
            makePlace('b', 'B'),
        ];
        const result = travellableFrom('a', ledger);
        expect(result[0].band).toBe('far');
    });

    it('returns an empty list when fromId is null', () => {
        const ledger: LocationEntry[] = [makePlace('a', 'A')];
        expect(travellableFrom(null, ledger)).toEqual([]);
        expect(travellableFrom(undefined, ledger)).toEqual([]);
    });

    it('returns an empty list when only the current place exists', () => {
        const ledger: LocationEntry[] = [makePlace('a', 'A')];
        expect(travellableFrom('a', ledger)).toEqual([]);
    });
});

describe('ensureConnection', () => {
    it('returns the existing band and writes nothing when a connection exists', () => {
        const ledger: LocationEntry[] = [
            makePlace('a', 'A', { connections: [{ toId: 'b', band: 'far' }] }),
            makePlace('b', 'B', { connections: [{ toId: 'a', band: 'far' }] }),
        ];
        const updateLocation = vi.fn();
        const band = ensureConnection('a', 'b', 'regional', ledger, updateLocation);
        expect(band).toBe('far');
        expect(updateLocation).not.toHaveBeenCalled();
    });

    it('creates a bidirectional connection at the chosen band when none exists', () => {
        const ledger: LocationEntry[] = [
            makePlace('a', 'A'),
            makePlace('b', 'B'),
        ];
        const updateLocation = vi.fn();
        const band = ensureConnection('a', 'b', 'regional', ledger, updateLocation);
        expect(band).toBe('regional');
        expect(updateLocation).toHaveBeenCalledTimes(2);
        expect(updateLocation).toHaveBeenNthCalledWith(1, 'a', {
            connections: [{ toId: 'b', band: 'regional' }],
        });
        expect(updateLocation).toHaveBeenNthCalledWith(2, 'b', {
            connections: [{ toId: 'a', band: 'regional' }],
        });
    });

    it('keeps an existing reciprocal edge in sync when adding the reverse', () => {
        const ledger: LocationEntry[] = [
            makePlace('a', 'A'),
            makePlace('b', 'B', { connections: [{ toId: 'a', band: 'local' }] }),
        ];
        const updateLocation = vi.fn();
        ensureConnection('a', 'b', 'far', ledger, updateLocation);
        // The reciprocal on b is updated (mapped), not appended.
        expect(updateLocation).toHaveBeenNthCalledWith(2, 'b', {
            connections: [{ toId: 'a', band: 'far' }],
        });
    });
});

describe('composeDeparture', () => {
    it('returns a TransitionResult with travel state, context patch, and ledger upserts', () => {
        const ledger: LocationEntry[] = [
            makePlace('a', 'A', { connections: [{ toId: 'b', band: 'far' }] }),
            makePlace('b', 'B', { connections: [{ toId: 'a', band: 'far' }] }),
        ];
        const deps = makeDeps();
        const result = composeDeparture({
            fromId: 'a',
            toId: 'b',
            mode: 'cart',
            band: 'far',
            ledger,
            deps,
            currentWorldDay: 10,
        });
        expect(result).not.toBeNull();
        expect(result!.travel).not.toBeNull();
        expect(result!.travel!.toId).toBe('b');
        expect(result!.travel!.mode).toBe('cart');
        expect(result!.travel!.leg).toBe(1);
        // WO 6.5: depart advances the day.
        expect(result!.contextPatch.worldDay).toBe(11);
        expect(result!.contextPatch.currentPlaceId).toBe(result!.travel!.transitId);
    });

    it('persists the chosen travel mode on the context', () => {
        const ledger: LocationEntry[] = [
            makePlace('a', 'A', { connections: [{ toId: 'b', band: 'far' }] }),
            makePlace('b', 'B', { connections: [{ toId: 'a', band: 'far' }] }),
        ];
        const deps = makeDeps();
        composeDeparture({
            fromId: 'a',
            toId: 'b',
            mode: 'horseback',
            band: 'far',
            ledger,
            deps,
        });
        expect(deps.updateContext).toHaveBeenCalledWith({ travelMode: 'horseback' });
    });

    it('does not call updateLocation when a direct connection exists', () => {
        const ledger: LocationEntry[] = [
            makePlace('a', 'A', { connections: [{ toId: 'b', band: 'far' }] }),
            makePlace('b', 'B', { connections: [{ toId: 'a', band: 'far' }] }),
        ];
        const deps = makeDeps();
        composeDeparture({
            fromId: 'a',
            toId: 'b',
            mode: 'foot',
            band: 'far',
            ledger,
            deps,
        });
        // ensureConnection does not call updateLocation when the connection
        // already exists. But updateContext IS called for travelMode.
        expect(deps.updateLocation).not.toHaveBeenCalled();
    });

    it('creates the bidirectional connection when none exists', () => {
        const ledger: LocationEntry[] = [
            makePlace('a', 'A'),
            makePlace('b', 'B'),
        ];
        const deps = makeDeps();
        composeDeparture({
            fromId: 'a',
            toId: 'b',
            mode: 'foot',
            band: 'regional',
            ledger,
            deps,
        });
        expect(deps.updateLocation).toHaveBeenCalledTimes(2);
    });

    it('throws when the destination is missing from the ledger', () => {
        const ledger: LocationEntry[] = [makePlace('a', 'A')];
        const deps = makeDeps();
        expect(() => composeDeparture({
            fromId: 'a',
            toId: 'missing',
            mode: 'foot',
            band: 'regional',
            ledger,
            deps,
        })).toThrow();
    });

    it('WO 6.1 — all three surfaces produce the same observable travel state (anti-drift)', () => {
        // All three surfaces (map, Places panel, composer button) call
        // composeDeparture with the same parameters. The observable fields
        // (toId, mode, leg, totalLegs, worldDay) cannot drift. The transitId
        // is a random id per call (new transit node), so it is excluded.
        const ledger: LocationEntry[] = [
            makePlace('a', 'Beacon', { connections: [{ toId: 'b', band: 'regional' }] }),
            makePlace('b', 'Haven', { connections: [{ toId: 'a', band: 'regional' }] }),
        ];
        const placesResult = composeDeparture({
            fromId: 'a', toId: 'b', mode: 'foot', band: 'regional', ledger, deps: makeDeps(),
            currentWorldDay: 5,
        });
        const composerResult = composeDeparture({
            fromId: 'a', toId: 'b', mode: 'foot', band: 'regional', ledger, deps: makeDeps(),
            currentWorldDay: 5,
        });
        const mapResult = composeDeparture({
            fromId: 'a', toId: 'b', mode: 'foot', band: 'regional', ledger, deps: makeDeps(),
            currentWorldDay: 5,
        });
        // Compare observable fields (exclude transitId which is a random id).
        const { transitId: _pt, ...placesObservable } = placesResult!.travel!;
        const { transitId: _ct, ...composerObservable } = composerResult!.travel!;
        const { transitId: _mt, ...mapObservable } = mapResult!.travel!;
        expect(placesObservable).toEqual(composerObservable);
        expect(placesObservable).toEqual(mapObservable);
        expect(placesResult!.contextPatch.worldDay).toBe(6);
        expect(composerResult!.contextPatch.worldDay).toBe(6);
        expect(mapResult!.contextPatch.worldDay).toBe(6);
    });

    it('supports multi-hop routes via the hops parameter', () => {
        const a = makePlace('a', 'A');
        const b = makePlace('b', 'B');
        const c = makePlace('c', 'C');
        const ledger = [a, b, c];
        const hops = [
            { fromId: 'a', toId: 'b', transitId: 't1', legs: 2 },
            { fromId: 'b', toId: 'c', transitId: 't2', legs: 3 },
        ];
        const result = composeDeparture({
            fromId: 'a',
            toId: 'c',
            mode: 'foot',
            band: 'regional',
            ledger,
            hops,
            deps: makeDeps(),
            currentWorldDay: 1,
        });
        expect(result).not.toBeNull();
        expect(result!.travel!.toId).toBe('c');
        expect(result!.travel!.totalLegs).toBe(5);
        expect(result!.travel!.hops).toHaveLength(2);
    });
});

describe('mergeUpserts', () => {
    it('replaces entries by id', () => {
        const a = makePlace('a', 'Old');
        const b = makePlace('b', 'B');
        const updated = makePlace('a', 'New');
        const merged = mergeUpserts([a, b], [updated]);
        expect(merged.find(l => l.id === 'a')!.name).toBe('New');
    });
});

describe('bandFromLegs', () => {
    it('maps a leg count to a distance band', () => {
        expect(bandFromLegs(3, 'foot')).toBe('regional');
        expect(bandFromLegs(1, 'foot')).not.toBe('adjacent');
    });
});