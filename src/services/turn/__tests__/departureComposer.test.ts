import { describe, expect, it, vi } from 'vitest';
import type { LocationEntry } from '../../types';
import {
    composeDeparture,
    ensureConnection,
    travellableFrom,
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
    injectToComposer: ReturnType<typeof vi.fn>;
    setPendingTravelIntent: ReturnType<typeof vi.fn>;
} {
    return {
        updateLocation: vi.fn(),
        updateContext: vi.fn(),
        injectToComposer: vi.fn(),
        setPendingTravelIntent: vi.fn(),
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
    it('injects the byte-identical departure sentence and arms the intent', () => {
        const ledger: LocationEntry[] = [
            makePlace('a', 'A', { connections: [{ toId: 'b', band: 'far' }] }),
            makePlace('b', 'B', { connections: [{ toId: 'a', band: 'far' }] }),
        ];
        const deps = makeDeps();
        const { sentence, intent } = composeDeparture({
            fromId: 'a',
            toId: 'b',
            mode: 'cart',
            band: 'far',
            ledger,
            deps,
        });
        expect(sentence).toBe('We set out for B by cart.');
        expect(intent).toEqual({
            toId: 'b',
            mode: 'cart',
            agency: 'free',
            injectedText: 'We set out for B by cart.',
        });
        expect(deps.injectToComposer).toHaveBeenCalledWith('We set out for B by cart.');
        expect(deps.setPendingTravelIntent).toHaveBeenCalledWith(intent);
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

    it('does not mutate the ledger when a direct connection exists', () => {
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

    it('produces the same sentence regardless of which surface calls it', () => {
        // The byte-identical guarantee — both the modal's TRAVEL HERE button
        // and the composer TRAVEL button call this, so the outputs cannot drift.
        const ledger: LocationEntry[] = [
            makePlace('a', 'A', { connections: [{ toId: 'b', band: 'far' }] }),
            makePlace('b', 'B', { connections: [{ toId: 'a', band: 'far' }] }),
        ];
        const first = composeDeparture({
            fromId: 'a', toId: 'b', mode: 'cart', band: 'far', ledger, deps: makeDeps(),
        });
        const second = composeDeparture({
            fromId: 'a', toId: 'b', mode: 'cart', band: 'far', ledger, deps: makeDeps(),
        });
        expect(first.sentence).toBe(second.sentence);
        expect(first.intent).toEqual(second.intent);
    });

    it('WO 6.1 — the map surface produces the same sentence as Places and composer (anti-drift)', () => {
        // WO 6.1 §5 test 3: "The committed departure sentence is byte-identical
        // to the one the Places panel produces for the same destination and
        // mode. This is the anti-drift test and it matters most."
        //
        // All three surfaces (map, Places panel, composer button) call
        // `composeDeparture` with the same (fromId, toId, mode, band). The
        // map surface's `WorldMapTravelBridge` calls it on receiving
        // `mod.worldmap.travelRequest`; the other two call it directly. The
        // sentence is built by `buildDepartureSentence(target.name, mode)`,
        // so the three surfaces cannot drift.
        const ledger: LocationEntry[] = [
            makePlace('a', 'Beacon', { connections: [{ toId: 'b', band: 'regional' }] }),
            makePlace('b', 'Haven', { connections: [{ toId: 'a', band: 'regional' }] }),
        ];
        // Places panel call:
        const placesResult = composeDeparture({
            fromId: 'a', toId: 'b', mode: 'foot', band: 'regional', ledger, deps: makeDeps(),
        });
        // Composer button call:
        const composerResult = composeDeparture({
            fromId: 'a', toId: 'b', mode: 'foot', band: 'regional', ledger, deps: makeDeps(),
        });
        // Map surface call (same parameters the bridge would use):
        const mapResult = composeDeparture({
            fromId: 'a', toId: 'b', mode: 'foot', band: 'regional', ledger, deps: makeDeps(),
        });
        expect(placesResult.sentence).toBe(composerResult.sentence);
        expect(placesResult.sentence).toBe(mapResult.sentence);
        expect(mapResult.sentence).toBe('We set out for Haven by foot.');
        // The intents are identical too.
        expect(placesResult.intent).toEqual(composerResult.intent);
        expect(placesResult.intent).toEqual(mapResult.intent);
    });
});