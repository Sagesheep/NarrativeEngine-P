import { describe, expect, it } from 'vitest';
import type { LocationEntry, TravelHop } from '../../types';
import {
    departMultiHop,
    advance,
    arrive,
    isUnrelatedPlace,
    commitTravelIntent,
    buildDepartureSentence,
} from '../travelState';
import type { DistanceBand } from '../location/distance';

function makePlace(overrides: Partial<LocationEntry> = {}): LocationEntry {
    return {
        id: `loc_${Math.random().toString(36).slice(2, 7)}`,
        name: 'Place',
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

function makeHops(placeIds: string[], legsPerHop: number[]): TravelHop[] {
    const hops: TravelHop[] = [];
    for (let i = 0; i < placeIds.length - 1; i += 1) {
        hops.push({
            fromId: placeIds[i],
            toId: placeIds[i + 1],
            transitId: `transit_${i}`,
            legs: legsPerHop[i] ?? 1,
        });
    }
    return hops;
}

describe('departMultiHop', () => {
    it('creates transit nodes and connections for every hop in an A→B→C route', () => {
        const a = makePlace({ id: 'loc_a', name: 'A' });
        const b = makePlace({ id: 'loc_b', name: 'B' });
        const c = makePlace({ id: 'loc_c', name: 'C' });
        const ledger = [a, b, c];
        const hops = makeHops(['loc_a', 'loc_b', 'loc_c'], [2, 3]);
        const result = departMultiHop({
            fromId: 'loc_a',
            toId: 'loc_c',
            mode: 'foot',
            hops,
            ledger,
        });
        expect(result.travel).not.toBeNull();
        expect(result.travel!.fromId).toBe('loc_a');
        expect(result.travel!.toId).toBe('loc_c');
        expect(result.travel!.totalLegs).toBe(5);
        expect(result.travel!.leg).toBe(1);
        expect(result.travel!.hops).toHaveLength(2);
        expect(result.travel!.hopIndex).toBe(0);
        expect(result.travel!.transitId).toBe(result.travel!.hops![0].transitId);
        // The party starts on the first hop's transit node.
        expect(result.contextPatch.currentPlaceId).toBe(result.travel!.hops![0].transitId);
        // Connections are ensured for both hops.
        expect(result.ledgerUpsert).toBeDefined();
        const upsertIds = result.ledgerUpsert!.map(l => l.id);
        expect(upsertIds).toContain('loc_a');
        expect(upsertIds).toContain('loc_b');
    });

    it('falls back to single-hop depart for a one-hop route', () => {
        const a = makePlace({ id: 'loc_a', name: 'A' });
        const b = makePlace({ id: 'loc_b', name: 'B' });
        const hops = makeHops(['loc_a', 'loc_b'], [3]);
        const result = departMultiHop({
            fromId: 'loc_a',
            toId: 'loc_b',
            mode: 'foot',
            hops,
            ledger: [a, b],
        });
        // Single-hop departMultiHop delegates to depart — no hops array on
        // the resulting travel state.
        expect(result.travel).not.toBeNull();
        expect(result.travel!.hops).toBeUndefined();
        expect(result.travel!.hopIndex).toBeUndefined();
        expect(result.travel!.totalLegs).toBeGreaterThanOrEqual(1);
    });

    it('returns EMPTY for a zero-hop route', () => {
        const a = makePlace({ id: 'loc_a', name: 'A' });
        const result = departMultiHop({
            fromId: 'loc_a',
            toId: 'loc_a',
            mode: 'foot',
            hops: [],
            ledger: [a],
        });
        expect(result.travel).toBeNull();
    });

    it('the departure sentence names only the final destination', () => {
        // WO 6.1 §2 — "Do not enumerate every intermediate place in the prose."
        const sentence = buildDepartureSentence('C', 'foot');
        expect(sentence).toBe('We set out for C by foot.');
        expect(sentence).not.toContain('B');
    });
});

describe('advance — multi-hop', () => {
    it('advances the cumulative leg within the first hop', () => {
        const a = makePlace({ id: 'loc_a', name: 'A' });
        const b = makePlace({ id: 'loc_b', name: 'B' });
        const c = makePlace({ id: 'loc_c', name: 'C' });
        const hops = makeHops(['loc_a', 'loc_b', 'loc_c'], [2, 3]);
        const result = departMultiHop({
            fromId: 'loc_a', toId: 'loc_c', mode: 'foot', hops, ledger: [a, b, c],
        });
        const travel = result.travel!;
        // Leg 1 → leg 2, still in hop 0 (legs 1–2).
        const next = advance(travel, 10);
        expect(next.travel!.leg).toBe(2);
        expect(next.travel!.hopIndex).toBe(0);
        expect(next.contextPatch.worldDay).toBe(11);
    });

    it('crosses a hop boundary: arriving at B and starting hop 1', () => {
        const a = makePlace({ id: 'loc_a', name: 'A' });
        const b = makePlace({ id: 'loc_b', name: 'B' });
        const c = makePlace({ id: 'loc_c', name: 'C' });
        const hops = makeHops(['loc_a', 'loc_b', 'loc_c'], [2, 3]);
        const result = departMultiHop({
            fromId: 'loc_a', toId: 'loc_c', mode: 'foot', hops, ledger: [a, b, c],
        });
        const travel = result.travel!;
        // Leg 2 → leg 3: crosses into hop 1 (legs 3–5). The party arrives at
        // B (hop 1's fromId) and sits on hop 1's transit node.
        const next = advance(travel, 10);
        const next2 = advance(next.travel!, 11);
        expect(next2.travel!.leg).toBe(3);
        expect(next2.travel!.hopIndex).toBe(1);
        expect(next2.travel!.transitId).toBe(travel.hops![1].transitId);
        expect(next2.contextPatch.currentPlaceId).toBe(travel.hops![1].transitId);
        expect(next2.contextPatch.worldDay).toBe(12);
    });

    it('arrives at the final destination when leg exceeds totalLegs', () => {
        const a = makePlace({ id: 'loc_a', name: 'A' });
        const b = makePlace({ id: 'loc_b', name: 'B' });
        const c = makePlace({ id: 'loc_c', name: 'C' });
        const hops = makeHops(['loc_a', 'loc_b', 'loc_c'], [2, 3]);
        const result = departMultiHop({
            fromId: 'loc_a', toId: 'loc_c', mode: 'foot', hops, ledger: [a, b, c],
        });
        const travel = result.travel!;
        // Advance through all 5 legs.
        let state = travel;
        let day = 10;
        for (let i = 1; i < 5; i += 1) {
            const r = advance(state, day);
            state = r.travel!;
            day = r.contextPatch.worldDay as number;
        }
        // Final advance: leg 5 → leg 6 > totalLegs(5) → arrive.
        const final = advance(state, day);
        expect(final.travel).toBeNull();
        expect(final.contextPatch.currentPlaceId).toBe('loc_c');
        expect(final.contextPatch.worldDay).toBe(day + 1);
    });
});

describe('isUnrelatedPlace — multi-hop', () => {
    it('recognises intermediate hop endpoints as valid (not a halt)', () => {
        const hops = makeHops(['loc_a', 'loc_b', 'loc_c'], [2, 3]);
        const travel = {
            fromId: 'loc_a', toId: 'loc_c', transitId: hops[0].transitId,
            mode: 'foot' as const, leg: 1, totalLegs: 5, agency: 'free' as const,
            hops, hopIndex: 0,
        };
        // B is an intermediate endpoint — not unrelated.
        expect(isUnrelatedPlace('loc_b', travel)).toBe(false);
        expect(isUnrelatedPlace('loc_a', travel)).toBe(false);
        expect(isUnrelatedPlace('loc_c', travel)).toBe(false);
        expect(isUnrelatedPlace(hops[0].transitId, travel)).toBe(false);
        expect(isUnrelatedPlace(hops[1].transitId, travel)).toBe(false);
        // A place not in the route is unrelated.
        expect(isUnrelatedPlace('loc_x', travel)).toBe(true);
    });
});

describe('commitTravelIntent — multi-hop', () => {
    it('resolves a multi-hop intent via departMultiHop', () => {
        const a = makePlace({ id: 'loc_a', name: 'A' });
        const b = makePlace({ id: 'loc_b', name: 'B' });
        const c = makePlace({ id: 'loc_c', name: 'C' });
        const ledger = [a, b, c];
        const hops = makeHops(['loc_a', 'loc_b', 'loc_c'], [2, 3]);
        const intent = {
            toId: 'loc_c',
            mode: 'foot' as const,
            agency: 'free' as const,
            injectedText: 'We set out for C by foot.',
            hops,
        };
        const result = commitTravelIntent(intent, 'loc_a', ledger);
        expect(result).not.toBeNull();
        expect(result!.travel!.fromId).toBe('loc_a');
        expect(result!.travel!.toId).toBe('loc_c');
        expect(result!.travel!.hops).toHaveLength(2);
        expect(result!.travel!.totalLegs).toBe(5);
    });

    it('resolves a single-hop intent via depart (no hops array)', () => {
        const a = makePlace({ id: 'loc_a', name: 'A', connections: [{ toId: 'loc_b', band: 'regional' as DistanceBand }] });
        const b = makePlace({ id: 'loc_b', name: 'B' });
        const intent = {
            toId: 'loc_b',
            mode: 'foot' as const,
            agency: 'free' as const,
            injectedText: 'We set out for B by foot.',
        };
        const result = commitTravelIntent(intent, 'loc_a', [a, b]);
        expect(result).not.toBeNull();
        expect(result!.travel!.hops).toBeUndefined();
        expect(result!.travel!.toId).toBe('loc_b');
    });

    it('returns null for same-place intent', () => {
        const a = makePlace({ id: 'loc_a', name: 'A' });
        const intent = {
            toId: 'loc_a',
            mode: 'foot' as const,
            agency: 'free' as const,
            injectedText: 'We set out for A by foot.',
            hops: makeHops(['loc_a', 'loc_a'], [1]),
        };
        expect(commitTravelIntent(intent, 'loc_a', [a])).toBeNull();
    });
});