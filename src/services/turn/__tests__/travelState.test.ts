import { describe, expect, it } from 'vitest';
import type { LocationEntry, TravelState } from '../../types';
import {
    depart,
    advance,
    arrive,
    halt,
    jump,
    isUnrelatedPlace,
    findTransitNode,
    ensureTransitNode,
    ensureDirectConnection,
    mergeUpserts,
    buildDepartureSentence,
    commitTravelIntent,
    sentTextCommitsIntent,
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

function makeTravel(overrides: Partial<TravelState> = {}): TravelState {
    return {
        fromId: 'loc_a',
        toId: 'loc_b',
        transitId: 'loc_t',
        mode: 'foot',
        leg: 1,
        totalLegs: 3,
        agency: 'free',
        ...overrides,
    };
}

describe('ensureDirectConnection', () => {
    it('creates a bidirectional connection when none exists', () => {
        const a = makePlace({ id: 'loc_a', name: 'A' });
        const b = makePlace({ id: 'loc_b', name: 'B' });
        const upserts = ensureDirectConnection('loc_a', 'loc_b', 'regional', [a, b]);
        expect(upserts).toHaveLength(2);
        const updatedA = upserts.find(l => l.id === 'loc_a')!;
        const updatedB = upserts.find(l => l.id === 'loc_b')!;
        expect(updatedA.connections).toContainEqual({ toId: 'loc_b', band: 'regional' });
        expect(updatedB.connections).toContainEqual({ toId: 'loc_a', band: 'regional' });
    });

    it('is a no-op when the connection already exists at the same band', () => {
        const a = makePlace({
            id: 'loc_a',
            connections: [{ toId: 'loc_b', band: 'regional' }],
        });
        const b = makePlace({
            id: 'loc_b',
            connections: [{ toId: 'loc_a', band: 'regional' }],
        });
        const upserts = ensureDirectConnection('loc_a', 'loc_b', 'regional', [a, b]);
        expect(upserts).toHaveLength(0);
    });

    it('updates the band when the connection exists at a different band', () => {
        const a = makePlace({
            id: 'loc_a',
            connections: [{ toId: 'loc_b', band: 'local' }],
        });
        const b = makePlace({
            id: 'loc_b',
            connections: [{ toId: 'loc_a', band: 'local' }],
        });
        const upserts = ensureDirectConnection('loc_a', 'loc_b', 'far', [a, b]);
        expect(upserts).toHaveLength(2);
        expect(upserts.find(l => l.id === 'loc_a')!.connections[0].band).toBe('far');
        expect(upserts.find(l => l.id === 'loc_b')!.connections[0].band).toBe('far');
    });
});

describe('ensureTransitNode', () => {
    it('creates a transit node with kind: transit and connections to both endpoints', () => {
        const a = makePlace({ id: 'loc_a', name: 'Aldoria' });
        const b = makePlace({ id: 'loc_b', name: 'Beacon' });
        const { transitId, upsert } = ensureTransitNode('loc_a', 'loc_b', 'regional', [a, b]);
        expect(upsert).toHaveLength(1);
        const transit = upsert[0];
        expect(transit.id).toBe(transitId);
        expect(transit.kind).toBe('transit');
        expect(transit.source).toBe('manual');
        expect(transit.name).toBe('Road between Aldoria and Beacon');
        expect(transit.connections).toContainEqual({ toId: 'loc_a', band: 'regional' });
        expect(transit.connections).toContainEqual({ toId: 'loc_b', band: 'regional' });
    });

    it('reuses an existing transit node — no duplicate created', () => {
        const a = makePlace({ id: 'loc_a', name: 'Aldoria' });
        const b = makePlace({ id: 'loc_b', name: 'Beacon' });
        const existing = makePlace({
            id: 'loc_t1',
            name: 'Road between Aldoria and Beacon',
            kind: 'transit',
            connections: [{ toId: 'loc_a', band: 'regional' }, { toId: 'loc_b', band: 'regional' }],
        });
        const { transitId, upsert } = ensureTransitNode('loc_a', 'loc_b', 'regional', [a, b, existing]);
        expect(transitId).toBe('loc_t1');
        expect(upsert).toHaveLength(0);
    });
});

describe('findTransitNode', () => {
    it('finds a transit node whose connections include both endpoints', () => {
        const a = makePlace({ id: 'loc_a' });
        const b = makePlace({ id: 'loc_b' });
        const transit = makePlace({
            id: 'loc_t', kind: 'transit',
            connections: [{ toId: 'loc_a' }, { toId: 'loc_b' }],
        });
        expect(findTransitNode('loc_a', 'loc_b', [a, b, transit])?.id).toBe('loc_t');
    });

    it('returns undefined when no transit node connects both endpoints', () => {
        const a = makePlace({ id: 'loc_a' });
        const b = makePlace({ id: 'loc_b' });
        const transit = makePlace({
            id: 'loc_t', kind: 'transit',
            connections: [{ toId: 'loc_a' }, { toId: 'loc_c' }],
        });
        expect(findTransitNode('loc_a', 'loc_b', [a, b, transit])).toBeUndefined();
    });

    it('does not match a place node (only kind: transit)', () => {
        const a = makePlace({ id: 'loc_a' });
        const b = makePlace({ id: 'loc_b' });
        const c = makePlace({
            id: 'loc_c',
            connections: [{ toId: 'loc_a' }, { toId: 'loc_b' }],
        });
        expect(findTransitNode('loc_a', 'loc_b', [a, b, c])).toBeUndefined();
    });
});

describe('depart', () => {
    it('creates a travel state with the correct leg count and a transit node', () => {
        const a = makePlace({ id: 'loc_a', name: 'Aldoria' });
        const b = makePlace({ id: 'loc_b', name: 'Beacon' });
        const result = depart({
            fromId: 'loc_a', toId: 'loc_b', band: 'regional', mode: 'cart', ledger: [a, b],
        });
        expect(result.travel).not.toBeNull();
        expect(result.travel!.fromId).toBe('loc_a');
        expect(result.travel!.toId).toBe('loc_b');
        expect(result.travel!.leg).toBe(1);
        expect(result.travel!.totalLegs).toBe(3); // regional × cart = 3 legs
        expect(result.travel!.agency).toBe('free');
        expect(result.contextPatch.travel).toBe(result.travel);
        expect(result.contextPatch.currentPlaceId).toBe(result.travel!.transitId);
        expect(result.contextPatch.currentFeature).toBeNull();
        expect(result.contextPatch.travelMode).toBe('cart');
        // Transit node + two endpoint connection upserts.
        expect(result.ledgerUpsert).toBeDefined();
        expect(result.ledgerUpsert!.length).toBeGreaterThanOrEqual(1);
        const transit = result.ledgerUpsert!.find(l => l.kind === 'transit');
        expect(transit).toBeDefined();
        expect(transit!.name).toBe('Road between Aldoria and Beacon');
    });

    it('reuses the transit node on a second A→B departure (no duplicate)', () => {
        const a = makePlace({ id: 'loc_a', name: 'Aldoria' });
        const b = makePlace({ id: 'loc_b', name: 'Beacon' });
        const first = depart({
            fromId: 'loc_a', toId: 'loc_b', band: 'regional', mode: 'cart', ledger: [a, b],
        });
        const ledgerWithTransit = mergeUpserts([a, b], first.ledgerUpsert ?? []);
        // Second departure — ledger already has the transit node + connections.
        const second = depart({
            fromId: 'loc_a', toId: 'loc_b', band: 'regional', mode: 'cart', ledger: ledgerWithTransit,
        });
        const transitNodes = (second.ledgerUpsert ?? []).filter(l => l.kind === 'transit');
        expect(transitNodes).toHaveLength(0);
        expect(second.travel!.transitId).toBe(first.travel!.transitId);
    });

    it('returns empty when fromId === toId', () => {
        const a = makePlace({ id: 'loc_a' });
        const result = depart({
            fromId: 'loc_a', toId: 'loc_a', band: 'regional', mode: 'foot', ledger: [a],
        });
        expect(result.travel).toBeNull();
    });

    it('supports constrained agency', () => {
        const a = makePlace({ id: 'loc_a', name: 'A' });
        const b = makePlace({ id: 'loc_b', name: 'B' });
        const result = depart({
            fromId: 'loc_a', toId: 'loc_b', band: 'regional', mode: 'foot', agency: 'constrained', ledger: [a, b],
        });
        expect(result.travel!.agency).toBe('constrained');
    });
});

describe('advance', () => {
    it('increments leg and worldDay by 1 on a mid-journey leg', () => {
        const travel = makeTravel({ leg: 1, totalLegs: 3 });
        const result = advance(travel, 12);
        expect(result.travel!.leg).toBe(2);
        expect(result.contextPatch.worldDay).toBe(13);
        expect(result.contextPatch.travel).toBe(result.travel);
    });

    it('arrives when leg exceeds totalLegs — clears travel, sets currentPlaceId to toId', () => {
        const travel = makeTravel({ leg: 3, totalLegs: 3, toId: 'loc_b' });
        const result = advance(travel, 14);
        expect(result.travel).toBeNull();
        expect(result.contextPatch.travel).toBeNull();
        expect(result.contextPatch.currentPlaceId).toBe('loc_b');
        expect(result.contextPatch.currentFeature).toBeNull();
        expect(result.contextPatch.worldDay).toBe(15);
    });

    it('handles undefined worldDay by treating it as 0', () => {
        const travel = makeTravel({ leg: 1, totalLegs: 3 });
        const result = advance(travel, undefined);
        expect(result.contextPatch.worldDay).toBe(1);
    });
});

describe('arrive', () => {
    it('clears travel and moves currentPlaceId to toId', () => {
        const travel = makeTravel({ toId: 'loc_b' });
        const result = arrive(travel, 20);
        expect(result.travel).toBeNull();
        expect(result.contextPatch.travel).toBeNull();
        expect(result.contextPatch.currentPlaceId).toBe('loc_b');
        expect(result.contextPatch.currentFeature).toBeNull();
        expect(result.contextPatch.worldDay).toBe(20);
    });
});

describe('halt', () => {
    it('clears travel without changing currentPlaceId (the header already did)', () => {
        const result = halt();
        expect(result.travel).toBeNull();
        expect(result.contextPatch.travel).toBeNull();
        expect(result.contextPatch.currentPlaceId).toBeUndefined();
    });
});

describe('jump', () => {
    it('sets currentPlaceId and clears travel', () => {
        const result = jump('loc_x');
        expect(result.travel).toBeNull();
        expect(result.contextPatch.currentPlaceId).toBe('loc_x');
        expect(result.contextPatch.travel).toBeNull();
        expect(result.contextPatch.currentFeature).toBeNull();
    });
});

describe('isUnrelatedPlace', () => {
    it('returns true when the header names a place that is neither transit nor destination', () => {
        const travel = makeTravel({ transitId: 'loc_t', toId: 'loc_b' });
        expect(isUnrelatedPlace('loc_x', travel)).toBe(true);
    });

    it('returns false when the header names the transit node', () => {
        const travel = makeTravel({ transitId: 'loc_t', toId: 'loc_b' });
        expect(isUnrelatedPlace('loc_t', travel)).toBe(false);
    });

    it('returns false when the header names the destination', () => {
        const travel = makeTravel({ transitId: 'loc_t', toId: 'loc_b' });
        expect(isUnrelatedPlace('loc_b', travel)).toBe(false);
    });

    it('returns false when the header is null or undefined', () => {
        const travel = makeTravel();
        expect(isUnrelatedPlace(null, travel)).toBe(false);
        expect(isUnrelatedPlace(undefined, travel)).toBe(false);
    });
});

describe('mergeUpserts', () => {
    it('replaces entries by id and preserves order of the rest', () => {
        const a = makePlace({ id: 'loc_a', name: 'Old' });
        const b = makePlace({ id: 'loc_b', name: 'B' });
        const updated = makePlace({ id: 'loc_a', name: 'New' });
        const merged = mergeUpserts([a, b], [updated]);
        expect(merged.find(l => l.id === 'loc_a')!.name).toBe('New');
        expect(merged.find(l => l.id === 'loc_b')!.name).toBe('B');
    });

    it('returns the input ledger when upserts is empty', () => {
        const a = makePlace({ id: 'loc_a' });
        expect(mergeUpserts([a], [])).toStrictEqual([a]);
    });
});

// ── Departure flow helpers ──────────────────────────────────────────────

describe('buildDepartureSentence', () => {
    it('builds the composer sentence using the lowercase mode id', () => {
        expect(buildDepartureSentence('Beacon', 'cart')).toBe('We set out for Beacon by cart.');
        expect(buildDepartureSentence('Beacon', 'foot')).toBe('We set out for Beacon by foot.');
        expect(buildDepartureSentence('Beacon', 'horseback')).toBe('We set out for Beacon by horseback.');
        expect(buildDepartureSentence('Beacon', 'flying')).toBe('We set out for Beacon by flying.');
    });
});

describe('commitTravelIntent', () => {
    it('resolves a pending intent into a depart transition', () => {
        const a = makePlace({ id: 'loc_a', name: 'A', connections: [{ toId: 'loc_b', band: 'regional' }] });
        const b = makePlace({ id: 'loc_b', name: 'B', connections: [{ toId: 'loc_a', band: 'regional' }] });
        const intent = { toId: 'loc_b', mode: 'cart' as const, agency: 'free' as const, injectedText: 'We set out for B by cart.' };
        const result = commitTravelIntent(intent, 'loc_a', [a, b]);
        expect(result).not.toBeNull();
        expect(result!.travel!.toId).toBe('loc_b');
        expect(result!.travel!.mode).toBe('cart');
    });

    it('returns null when fromId === toId', () => {
        const a = makePlace({ id: 'loc_a' });
        const intent = { toId: 'loc_a', mode: 'foot' as const, agency: 'free' as const, injectedText: '' };
        expect(commitTravelIntent(intent, 'loc_a', [a])).toBeNull();
    });

    it('returns null when the connection is adjacent (adjacent never enters travel state)', () => {
        const a = makePlace({ id: 'loc_a', connections: [{ toId: 'loc_b', band: 'adjacent' }] });
        const b = makePlace({ id: 'loc_b' });
        const intent = { toId: 'loc_b', mode: 'foot' as const, agency: 'free' as const, injectedText: '' };
        expect(commitTravelIntent(intent, 'loc_a', [a, b])).toBeNull();
    });

    it('returns null when no connection exists', () => {
        const a = makePlace({ id: 'loc_a' });
        const b = makePlace({ id: 'loc_b' });
        const intent = { toId: 'loc_b', mode: 'foot' as const, agency: 'free' as const, injectedText: '' };
        expect(commitTravelIntent(intent, 'loc_a', [a, b])).toBeNull();
    });
});

describe('sentTextCommitsIntent', () => {
    const intent = { toId: 'loc_b', mode: 'cart' as const, agency: 'free' as const, injectedText: 'We set out for Beacon by cart.' };

    it('commits when the sent text matches the injected sentence', () => {
        expect(sentTextCommitsIntent('We set out for Beacon by cart.', intent)).toBe(true);
    });

    it('commits when the sent text is a lightly-edited version (prefix match)', () => {
        expect(sentTextCommitsIntent('We set out for Beacon by horse, taking the long way.', intent)).toBe(true);
    });

    it('does not commit when the sent text is a completely different action', () => {
        expect(sentTextCommitsIntent('I attack the goblin.', intent)).toBe(false);
    });

    it('does not commit when the sent text is empty', () => {
        expect(sentTextCommitsIntent('', intent)).toBe(false);
        expect(sentTextCommitsIntent('   ', intent)).toBe(false);
    });
});