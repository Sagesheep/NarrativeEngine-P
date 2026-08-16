/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LocationEntry, GameContext } from '../../types';
import {
    applyLocationOps,
    resolvePlace,
    connectionBand,
    mergeLocationScanLedger,
    type LocationScanResult,
} from '../locationParser';
import { buildLocationBlock, buildTravelBlock } from '../payload/volatile';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<LocationEntry> = {}): LocationEntry {
    return {
        id: `loc_${Math.random().toString(36).slice(2, 7)}`,
        name: 'Academy',
        aliases: 'the academy, NA',
        broadLocation: 'Konoha',
        features: ['Class A', 'training yard'],
        connections: [],
        description: 'A ninja training school.',
        firstSeenScene: '001',
        lastSeenScene: '001',
        source: 'llm',
        ...overrides,
    };
}

const baseRaw = (overrides: any = {}) => ({
    current: { place: 'unclear', feature: null },
    newPlaces: [],
    updates: [],
    ...overrides,
});

// ── applyLocationOps ───────────────────────────────────────────────────

describe('applyLocationOps', () => {
    beforeEach(() => vi.clearAllMocks());

    it('alias resolution: case-insensitive + loose match moves pointer', () => {
        const academy = makeEntry({ id: 'loc_a', name: 'Ninja Academy', aliases: 'the academy, NA' });
        const ledger = [academy];
        const out = applyLocationOps(baseRaw({ current: { place: 'THE ACADEMY', feature: null } }), ledger, null);
        expect(out.currentPlaceId).toBe('loc_a');
    });

    it('single-token loose match: "academy" matches "Ninja Academy"', () => {
        const academy = makeEntry({ id: 'loc_a', name: 'Ninja Academy', aliases: '' });
        const out = applyLocationOps(baseRaw({ current: { place: 'academy', feature: 'Class B' } }), [academy], null);
        expect(out.currentPlaceId).toBe('loc_a');
        expect(out.currentFeature).toBe('Class B');
    });

    it('"unclear" leaves the pointer and ledger untouched (no lastSeenScene touch)', () => {
        const academy = makeEntry({ id: 'loc_a', lastSeenScene: '001' });
        const out = applyLocationOps(baseRaw({ current: { place: 'unclear', feature: null } }), [academy], 'loc_a');
        expect(out.currentPlaceId).toBe('loc_a'); // unchanged
        expect(out.ledger[0].lastSeenScene).toBe('001'); // not touched
    });

    it('"unclear" preserves the current feature as well as the place pointer', () => {
        const academy = makeEntry({ id: 'loc_a' });
        const out = applyLocationOps(baseRaw(), [academy], 'loc_a', 'Class A');
        expect(out.currentPlaceId).toBe('loc_a');
        expect(out.currentFeature).toBe('Class A');
    });
    it('parse-garbage (non-object) → unchanged', () => {
        const academy = makeEntry({ id: 'loc_a' });
        const out = applyLocationOps(null as any, [academy], 'loc_a');
        expect(out.currentPlaceId).toBe('loc_a');
        expect(out.ledger).toEqual([academy]);
    });

    it('a non-matching place string (not "unclear"/"new") falls back to unclear → keep last pointer', () => {
        const academy = makeEntry({ id: 'loc_a' });
        const out = applyLocationOps(baseRaw({ current: { place: 'Mars Base', feature: null } }), [academy], 'loc_a');
        expect(out.currentPlaceId).toBe('loc_a'); // unchanged
    });

    it('new place lands in suggestions, NOT the ledger', () => {
        const academy = makeEntry({ id: 'loc_a' });
        const out = applyLocationOps(baseRaw({
            current: { place: 'unclear', feature: null },
            newPlaces: [{ name: 'Hidden Cave', connectedTo: 'Academy', context: 'a dark cave' }],
        }), [academy], null);
        expect(out.suggestions).toHaveLength(1);
        expect(out.suggestions[0].name).toBe('Hidden Cave');
        expect(out.ledger).toHaveLength(1); // unchanged — never auto-added
    });

    it('suggestion cap of 2 — drops extras', () => {
        const out = applyLocationOps(baseRaw({
            current: { place: 'unclear', feature: null },
            newPlaces: [
                { name: 'Place1' }, { name: 'Place2' }, { name: 'Place3' }, { name: 'Place4' },
            ],
        }), [], null);
        expect(out.suggestions).toHaveLength(2);
    });

    it('suggestions skip names already in the ledger (name OR alias)', () => {
        const academy = makeEntry({ id: 'loc_a', name: 'Academy', aliases: 'the academy' });
        const out = applyLocationOps(baseRaw({
            current: { place: 'unclear', feature: null },
            newPlaces: [{ name: 'Academy' }, { name: 'the academy' }, { name: 'New Place' }],
        }), [academy], null);
        expect(out.suggestions).toHaveLength(1);
        expect(out.suggestions[0].name).toBe('New Place');
    });

    it('feature dedupe is case-insensitive + capped at 20', () => {
        const academy = makeEntry({ id: 'loc_a', features: ['Class A'] });
        const lots = Array.from({ length: 25 }, (_, i) => `Feature ${i + 1}`);
        const out = applyLocationOps(baseRaw({
            current: { place: 'Academy', feature: null },
            updates: [{ place: 'Academy', addFeatures: ['CLASS A', ...lots] }], // CLASS A is a dup
        }), [academy], null);
        const entry = out.ledger.find(l => l.id === 'loc_a')!;
        // Original (1) + 25 new - 1 dup = 25, then capped at 20
        expect(entry.features.length).toBe(20);
        expect(entry.features.some(f => f === 'CLASS A')).toBe(false); // dup not added
    });

    it('connection dedupe + bidirectional mirroring (A→B also adds B→A)', () => {
        const a = makeEntry({ id: 'loc_a', name: 'Academy', connections: [] });
        const b = makeEntry({ id: 'loc_b', name: 'Barracks', connections: [] });
        const out = applyLocationOps(baseRaw({
            current: { place: 'Academy', feature: null },
            updates: [{ place: 'Academy', addConnections: ['Barracks'] }],
        }), [a, b], null);
        const aOut = out.ledger.find(l => l.id === 'loc_a')!;
        const bOut = out.ledger.find(l => l.id === 'loc_b')!;
        expect(aOut.connections.some(c => c.toId === 'loc_b')).toBe(true);
        expect(bOut.connections.some(c => c.toId === 'loc_a')).toBe(true);
    });

    it('connection cap of 8 per entry', () => {
        const a = makeEntry({ id: 'loc_a', name: 'Academy', connections: [] });
        const others = Array.from({ length: 10 }, (_, i) =>
            makeEntry({ id: `loc_o${i}`, name: `Other${i}`, connections: [] })
        );
        const out = applyLocationOps(baseRaw({
            current: { place: 'Academy', feature: null },
            updates: [{ place: 'Academy', addConnections: others.map(o => o.name) }],
        }), [a, ...others], null);
        const aOut = out.ledger.find(l => l.id === 'loc_a')!;
        expect(aOut.connections.length).toBe(8);
    });

    it('connection updates can only target existing entries — unknown name is ignored', () => {
        const a = makeEntry({ id: 'loc_a', name: 'Academy', connections: [] });
        const out = applyLocationOps(baseRaw({
            current: { place: 'Academy', feature: null },
            updates: [{ place: 'Academy', addConnections: ['Nonexistent Place'] }],
        }), [a], null);
        const aOut = out.ledger.find(l => l.id === 'loc_a')!;
        expect(aOut.connections).toHaveLength(0);
    });

    it('lastSeenScene is touched on the resolved current entry', () => {
        const a = makeEntry({ id: 'loc_a', name: 'Academy', lastSeenScene: '001' });
        const out = applyLocationOps(baseRaw({ current: { place: 'Academy', feature: null } }), [a], null);
        const aOut = out.ledger.find(l => l.id === 'loc_a')!;
        expect(aOut.lastSeenScene).not.toBe('001');
    });

    it('"new" as current.place keeps the last known pointer (does not move to a suggestion)', () => {
        const a = makeEntry({ id: 'loc_a', name: 'Academy' });
        const out = applyLocationOps(baseRaw({
            current: { place: 'new', feature: null },
            newPlaces: [{ name: 'Fresh Place' }],
        }), [a], 'loc_a');
        expect(out.currentPlaceId).toBe('loc_a'); // unchanged
        expect(out.suggestions).toHaveLength(1);
    });

    it('empty current.place string is treated as unclear (keeps last pointer)', () => {
        const a = makeEntry({ id: 'loc_a', name: 'Academy' });
        const out = applyLocationOps(baseRaw({ current: { place: '', feature: null } }), [a], 'loc_a');
        expect(out.currentPlaceId).toBe('loc_a');
    });

    it('does not mutate the input ledger (pure function)', () => {
        const a = makeEntry({ id: 'loc_a', name: 'Academy', features: ['Class A'], connections: [] });
        const snapshot = JSON.stringify(a);
        applyLocationOps(baseRaw({
            current: { place: 'Academy', feature: null },
            updates: [{ place: 'Academy', addFeatures: ['Class B'], addConnections: [] }],
        }), [a], null);
        expect(JSON.stringify(a)).toBe(snapshot);
    });
});

describe('mergeLocationScanLedger', () => {
    it('keeps a manual edit made while a scan is in flight', () => {
        const baseline = [makeEntry({ id: 'loc_a', name: 'Academy', description: 'Old', features: [] })];
        const scanned = [{ ...baseline[0], features: ['Library'], lastSeenScene: '002' }];
        const live = [{ ...baseline[0], description: 'Player edit' }];
        const merged = mergeLocationScanLedger(baseline, scanned, live);
        expect(merged[0].description).toBe('Player edit');
        expect(merged[0].features).toEqual(['Library']);
        expect(merged[0].lastSeenScene).toBe('002');
    });

    it('does not resurrect a place deleted while a scan is in flight', () => {
        const baseline = [makeEntry({ id: 'loc_a' })];
        const scanned = [{ ...baseline[0], features: [...baseline[0].features, 'Library'] }];
        expect(mergeLocationScanLedger(baseline, scanned, [])).toEqual([]);
    });

    it('returns the live array unchanged when the scan produced no ledger delta', () => {
        const baseline = [makeEntry({ id: 'loc_a', description: 'Old' })];
        const live = [{ ...baseline[0], description: 'Player edit' }];
        expect(mergeLocationScanLedger(baseline, baseline, live)).toBe(live);
    });
});
// ── resolvePlace (exported helper) ─────────────────────────────────────

describe('resolvePlace', () => {
    it('returns undefined for "unclear" / "new" / empty', () => {
        const ledger = [makeEntry({ name: 'Academy' })];
        expect(resolvePlace('unclear', ledger)).toBeUndefined();
        expect(resolvePlace('new', ledger)).toBeUndefined();
        expect(resolvePlace('', ledger)).toBeUndefined();
    });

    it('exact name match (case-insensitive)', () => {
        const a = makeEntry({ id: 'loc_a', name: 'Academy' });
        expect(resolvePlace('ACADEMY', [a])?.id).toBe('loc_a');
    });

    it('exact alias match', () => {
        const a = makeEntry({ id: 'loc_a', name: 'Ninja Academy', aliases: 'the academy, NA' });
        expect(resolvePlace('NA', [a])?.id).toBe('loc_a');
    });

    it('returns undefined when no match', () => {
        const a = makeEntry({ id: 'loc_a', name: 'Academy' });
        expect(resolvePlace('Mars', [a])).toBeUndefined();
    });
});

// ── connectionBand (exported helper) ───────────────────────────────────

describe('connectionBand', () => {
    it('returns an authored band when set', () => {
        expect(connectionBand({ toId: 'x', band: 'adjacent' })).toBe('adjacent');
        expect(connectionBand({ toId: 'x', band: 'regional' })).toBe('regional');
    });
    it('lazily migrates legacy long to far', () => {
        const legacyLong = 'long' as unknown as LocationEntry['connections'][number]['band'];
        expect(connectionBand({ toId: 'x', band: legacyLong })).toBe('far');
    });
    it('defaults to local when unset', () => {
        expect(connectionBand({ toId: 'x' })).toBe('local');
    });
});

// ── Volatile [LOCATION] block ──────────────────────────────────────────

describe('buildLocationBlock', () => {
    function makeCtx(overrides: Partial<GameContext> = {}): GameContext {
        return { ...({} as GameContext), currentPlaceId: null, ...overrides };
    }

    it('emits nothing when there is no resolved current place (zero-regression)', () => {
        const ctx = makeCtx({ currentPlaceId: null });
        expect(buildLocationBlock(ctx, [])).toBe('');
    });

    it('emits nothing when currentPlaceId points to a missing entry', () => {
        const ctx = makeCtx({ currentPlaceId: 'loc_missing' });
        expect(buildLocationBlock(ctx, [])).toBe('');
    });

    it('emits the fixed format: header + description + nearby + features', () => {
        const a = makeEntry({
            id: 'loc_a', name: 'Academy', broadLocation: 'Konoha',
            description: 'A ninja training school.',
            features: ['Class A', 'training yard'],
            connections: [{ toId: 'loc_b', band: 'adjacent' }, { toId: 'loc_c' }],
        });
        const b = makeEntry({ id: 'loc_b', name: 'Barracks' });
        const c = makeEntry({ id: 'loc_c', name: 'Shrine' });
        const ctx = makeCtx({ currentPlaceId: 'loc_a', currentFeature: 'Class A' });
        const block = buildLocationBlock(ctx, [a, b, c]);
        expect(block).toContain('[LOCATION]');
        expect(block).toContain('At: Academy (Konoha) — Class A');
        expect(block).toContain('A ninja training school.');
        expect(block).toContain('Nearby: Barracks (adjacent), Shrine');
        expect(block).toContain('Known rooms/features: Class A, training yard');
    });

    it('renders band ranges in Nearby', () => {
        const a = makeEntry({
            id: 'loc_a',
            connections: [{ toId: 'loc_b', band: 'far' }, { toId: 'loc_c' }],
        });
        const b = makeEntry({ id: 'loc_b', name: 'Ravenhold' });
        const c = makeEntry({ id: 'loc_c', name: 'Ashfen Deep' });
        const block = buildLocationBlock(makeCtx({ currentPlaceId: 'loc_a' }), [a, b, c]);
        expect(block).toContain('Nearby: Ravenhold (far, 6–10d), Ashfen Deep');
    });

    it('status suffix appears when set', () => {
        const a = makeEntry({ id: 'loc_a', name: 'Academy', broadLocation: 'Konoha', status: 'burned down' });
        const ctx = makeCtx({ currentPlaceId: 'loc_a' });
        const block = buildLocationBlock(ctx, [a]);
        expect(block).toContain('At: Academy (Konoha) — burned down');
    });

    it('honors the ~400-char cap: trims features first, then Nearby', () => {
        const a = makeEntry({
            id: 'loc_a', name: 'Academy', broadLocation: 'Konoha',
            description: 'A ninja training school.',
            features: Array.from({ length: 60 }, (_, i) => `FeatureRoom${i + 1}`),
            connections: [{ toId: 'loc_b', band: 'adjacent' }],
        });
        const b = makeEntry({ id: 'loc_b', name: 'Barracks' });
        const ctx = makeCtx({ currentPlaceId: 'loc_a' });
        const block = buildLocationBlock(ctx, [a, b]);
        expect(block.length).toBeLessThanOrEqual(400);
        expect(block).toContain('[LOCATION]');
        // Header + description must survive the trim
        expect(block).toContain('At: Academy (Konoha)');
        expect(block).toContain('A ninja training school.');
    });
});

// ── WO2 — The Clock: Day: line + day-with-no-place + zero-regression ──

describe('buildLocationBlock (WO2 — clock)', () => {
    function makeCtx(overrides: Partial<GameContext> = {}): GameContext {
        return { ...({} as GameContext), currentPlaceId: null, ...overrides };
    }

    it('no worldDay: byte-identical to the pre-clock output', () => {
        const a = makeEntry({
            id: 'loc_a', name: 'Academy', broadLocation: 'Konoha',
            description: 'A ninja training school.',
            features: ['Class A', 'training yard'],
            connections: [{ toId: 'loc_b', band: 'adjacent' }, { toId: 'loc_c' }],
        });
        const b = makeEntry({ id: 'loc_b', name: 'Barracks' });
        const c = makeEntry({ id: 'loc_c', name: 'Shrine' });
        const ctx = makeCtx({ currentPlaceId: 'loc_a', currentFeature: 'Class A' });
        const block = buildLocationBlock(ctx, [a, b, c]);
        // The exact pre-clock string — no `Day:` line anywhere.
        expect(block).toBe(
            '[LOCATION]\n' +
            'At: Academy (Konoha) — Class A\n' +
            'A ninja training school.\n' +
            'Nearby: Barracks (adjacent), Shrine\n' +
            'Known rooms/features: Class A, training yard',
        );
        expect(block).not.toContain('Day:');
    });

    it('worldDay set: Day: line is the first body line, above At:', () => {
        const a = makeEntry({
            id: 'loc_a', name: 'Academy', broadLocation: 'Konoha',
            description: 'A ninja training school.',
            features: ['Class A'],
            connections: [],
        });
        const ctx = makeCtx({ currentPlaceId: 'loc_a', worldDay: 12 });
        const block = buildLocationBlock(ctx, [a]);
        const lines = block.split('\n');
        expect(lines[0]).toBe('[LOCATION]');
        expect(lines[1]).toBe('Day: 12');
        expect(lines[2]).toBe('At: Academy (Konoha)');
        expect(block).toContain('Day: 12');
    });

    it('worldDay set + currentPlaceId unresolved: emits [LOCATION]\\nDay: N and nothing else', () => {
        const ctx = makeCtx({ currentPlaceId: 'loc_missing', worldDay: 12 });
        const block = buildLocationBlock(ctx, []);
        expect(block).toBe('[LOCATION]\nDay: 12');
    });

    it('worldDay set + currentPlaceId null: emits [LOCATION]\\nDay: N and nothing else', () => {
        const ctx = makeCtx({ currentPlaceId: null, worldDay: 12 });
        expect(buildLocationBlock(ctx, [])).toBe('[LOCATION]\nDay: 12');
    });

    it('no worldDay + no place: empty string (unchanged)', () => {
        const ctx = makeCtx({ currentPlaceId: null });
        expect(buildLocationBlock(ctx, [])).toBe('');
    });

    it('no worldDay + missing place: empty string (unchanged)', () => {
        const ctx = makeCtx({ currentPlaceId: 'loc_missing' });
        expect(buildLocationBlock(ctx, [])).toBe('');
    });

    it('Day: line survives the 400-char trim (features trim before it; Day is exempt)', () => {
        const a = makeEntry({
            id: 'loc_a', name: 'Academy', broadLocation: 'Konoha',
            description: 'A ninja training school.',
            features: Array.from({ length: 60 }, (_, i) => `FeatureRoom${i + 1}`),
            connections: [{ toId: 'loc_b', band: 'adjacent' }],
        });
        const b = makeEntry({ id: 'loc_b', name: 'Barracks' });
        const ctx = makeCtx({ currentPlaceId: 'loc_a', worldDay: 12 });
        const block = buildLocationBlock(ctx, [a, b]);
        expect(block.length).toBeLessThanOrEqual(400);
        const lines = block.split('\n');
        expect(lines[0]).toBe('[LOCATION]');
        expect(lines[1]).toBe('Day: 12');
        // Day line survived; the cap still holds.
        expect(block).toContain('Day: 12');
        // Header survives (the cap trims features first, then Nearby — header is core).
        expect(block).toContain('At: Academy (Konoha)');
    });

    it('Day: line survives the hard truncate last-resort step (it is first, ~8 chars)', () => {
        // Make the header + description so long that even after dropping features and Nearby
        // the block still exceeds 400 chars, forcing the `block.slice(0, CAP)` path.
        const longDesc = 'X'.repeat(500);
        const a = makeEntry({
            id: 'loc_a', name: 'Academy', broadLocation: 'Konoha',
            description: longDesc,
            features: [],
            connections: [],
        });
        const ctx = makeCtx({ currentPlaceId: 'loc_a', worldDay: 12 });
        const block = buildLocationBlock(ctx, [a]);
        expect(block.length).toBe(400);
        const lines = block.split('\n');
        expect(lines[0]).toBe('[LOCATION]');
        expect(lines[1]).toBe('Day: 12');
    });

    it('NaN / Infinity worldDay is treated as unset (no Day: line)', () => {
        const a = makeEntry({ id: 'loc_a', name: 'Academy', broadLocation: 'Konoha' });
        const ctx = makeCtx({ currentPlaceId: 'loc_a', worldDay: Number.NaN });
        expect(buildLocationBlock(ctx, [a])).not.toContain('Day:');
        const ctx2 = makeCtx({ currentPlaceId: 'loc_a', worldDay: Number.POSITIVE_INFINITY });
        expect(buildLocationBlock(ctx2, [a])).not.toContain('Day:');
    });

    it('worldDay: 0 is a valid day and emits Day: 0', () => {
        const ctx = makeCtx({ currentPlaceId: null, worldDay: 0 });
        expect(buildLocationBlock(ctx, [])).toBe('[LOCATION]\nDay: 0');
    });
});

// ── Guard behavior: campaign-switch during scan drops the write ────────
// Reuses the campaignGuard.test.ts approach: mock the store, flip activeCampaignId,
// assert the guarded setters don't fire. Mirrors inventory scan guards.

describe('Guard behavior (campaign-switch during scan)', () => {
    // The guard logic lives in postTurnPipeline (makeGuarded / assertStillActive).
    // Here we test the contract that applyLocationOps returns a valid result the
    // guard can choose to drop or pass — i.e. the parser itself never throws on
    // valid input, so a dropped write is always the guard's decision, never a
    // parser crash. This keeps the guard unit-test boundary honest.
    it('applyLocationOps is total: never throws on malformed input (returns unchanged)', () => {
        const a = makeEntry({ id: 'loc_a', name: 'Academy' });
        const weird = [
            () => applyLocationOps(undefined as any, [a], 'loc_a'),
            () => applyLocationOps({ current: undefined } as any, [a], 'loc_a'),
            () => applyLocationOps({ current: 'not-an-object' } as any, [a], 'loc_a'),
            () => applyLocationOps({ current: { place: 123 } } as any, [a], 'loc_a'),
            () => applyLocationOps({ updates: 'nope' } as any, [a], 'loc_a'),
            () => applyLocationOps({ newPlaces: 'nope' } as any, [a], 'loc_a'),
        ];
        for (const fn of weird) {
            const out: LocationScanResult = fn();
            expect(out.currentPlaceId).toBe('loc_a');
            expect(out.ledger).toEqual([a]);
        }
    });
});

// ── WO3 §3 — transit nodes are excluded from the Nearby line ─────────────

describe('buildLocationBlock (WO3 — transit exclusion from Nearby)', () => {
    function makeCtx(overrides: Partial<GameContext> = {}): GameContext {
        return { ...({} as GameContext), currentPlaceId: null, ...overrides };
    }

    it('Nearby omits kind: transit entries', () => {
        const a = makeEntry({
            id: 'loc_a', name: 'Academy', broadLocation: 'Konoha',
            connections: [{ toId: 'loc_t' }, { toId: 'loc_b', band: 'regional' }],
        });
        const transit = makeEntry({
            id: 'loc_t', name: 'Road between Academy and Barracks', kind: 'transit',
            connections: [{ toId: 'loc_a' }, { toId: 'loc_b' }],
        });
        const b = makeEntry({ id: 'loc_b', name: 'Barracks' });
        const block = buildLocationBlock(makeCtx({ currentPlaceId: 'loc_a' }), [a, transit, b]);
        expect(block).toContain('Nearby: Barracks (regional, 3–5d)');
        expect(block).not.toContain('Road between');
        expect(block).not.toContain('loc_t');
    });

    it('Nearby still lists place entries that are not transit', () => {
        const a = makeEntry({
            id: 'loc_a', name: 'Academy',
            connections: [{ toId: 'loc_b', band: 'adjacent' }, { toId: 'loc_c' }],
        });
        const b = makeEntry({ id: 'loc_b', name: 'Barracks' });
        const c = makeEntry({ id: 'loc_c', name: 'Shrine' });
        const block = buildLocationBlock(makeCtx({ currentPlaceId: 'loc_a' }), [a, b, c]);
        expect(block).toContain('Barracks (adjacent)');
        expect(block).toContain('Shrine');
    });
});

// ── WO3 §8 — the [TRAVEL] block ──────────────────────────────────────────

describe('buildTravelBlock (WO3 §8)', () => {
    function makeCtx(overrides: Partial<GameContext> = {}): GameContext {
        return { ...({} as GameContext), currentPlaceId: null, ...overrides };
    }
    function makeTravel(overrides: Partial<NonNullable<GameContext['travel']>> = {}): NonNullable<GameContext['travel']> {
        return {
            fromId: 'loc_a',
            toId: 'loc_b',
            transitId: 'loc_t',
            mode: 'cart',
            leg: 2,
            totalLegs: 3,
            agency: 'free',
            ...overrides,
        };
    }

    it('emits nothing when context.travel is not set (zero-regression)', () => {
        const ctx = makeCtx();
        expect(buildTravelBlock(ctx, [])).toBe('');
    });

    it('emits nothing when context.travel is null', () => {
        const ctx = makeCtx({ travel: null });
        expect(buildTravelBlock(ctx, [])).toBe('');
    });

    it('mid-journey: emits Day leg/total, from → to by mode, and the stop instruction', () => {
        const a = makeEntry({ id: 'loc_a', name: 'Point A' });
        const b = makeEntry({ id: 'loc_b', name: 'Point B' });
        const ctx = makeCtx({ travel: makeTravel({ leg: 2, totalLegs: 3, mode: 'cart' }) });
        const block = buildTravelBlock(ctx, [a, b]);
        expect(block).toContain('[TRAVEL]');
        expect(block).toContain('Day 2 of 3 — Point A → Point B by cart.');
        expect(block).toContain('End this scene at nightfall. Do not reach Point B.');
    });

    it('final leg: the second line says the party reaches the destination', () => {
        const a = makeEntry({ id: 'loc_a', name: 'Point A' });
        const b = makeEntry({ id: 'loc_b', name: 'Point B' });
        const ctx = makeCtx({ travel: makeTravel({ leg: 3, totalLegs: 3, mode: 'cart' }) });
        const block = buildTravelBlock(ctx, [a, b]);
        expect(block).toContain('Day 3 of 3 — Point A → Point B by cart.');
        expect(block).toContain('The party reaches Point B in this scene.');
        expect(block).not.toContain('Do not reach');
    });

    it('constrained agency: the second line is the control line, on every leg', () => {
        const a = makeEntry({ id: 'loc_a', name: 'Point A' });
        const b = makeEntry({ id: 'loc_b', name: 'Point B' });
        const ctx = makeCtx({ travel: makeTravel({ leg: 2, totalLegs: 3, agency: 'constrained' }) });
        const block = buildTravelBlock(ctx, [a, b]);
        expect(block).toContain('The party does not control this journey.');
        expect(block).not.toContain('Do not reach');
        expect(block).not.toContain('reaches Point B');
    });

    it('constrained agency on the final leg still shows the control line (no arrival instruction)', () => {
        const a = makeEntry({ id: 'loc_a', name: 'Point A' });
        const b = makeEntry({ id: 'loc_b', name: 'Point B' });
        const ctx = makeCtx({ travel: makeTravel({ leg: 3, totalLegs: 3, agency: 'constrained' }) });
        const block = buildTravelBlock(ctx, [a, b]);
        expect(block).toContain('The party does not control this journey.');
        expect(block).not.toContain('reaches Point B');
    });

    it('honors the 200-char hard cap', () => {
        const a = makeEntry({ id: 'loc_a', name: 'A'.repeat(80) });
        const b = makeEntry({ id: 'loc_b', name: 'B'.repeat(80) });
        const ctx = makeCtx({ travel: makeTravel({ leg: 2, totalLegs: 3 }) });
        const block = buildTravelBlock(ctx, [a, b]);
        expect(block.length).toBeLessThanOrEqual(200);
        expect(block.startsWith('[TRAVEL]')).toBe(true);
    });

    it('uses the id fallback when the ledger is missing an endpoint', () => {
        const ctx = makeCtx({ travel: makeTravel({ leg: 2, totalLegs: 3, fromId: 'loc_x', toId: 'loc_y' }) });
        const block = buildTravelBlock(ctx, []);
        expect(block).toContain('Day 2 of 3 — loc_x → loc_y by cart.');
    });

    it('zero-regression: a context with no travel produces byte-identical volatile payload', () => {
        // The [TRAVEL] block is the only new volatile part. When travel is unset,
        // buildTravelBlock returns '' and is not pushed into volatileParts, so
        // the assembled volatileContent is byte-identical to the pre-WO3 output.
        const a = makeEntry({
            id: 'loc_a', name: 'Academy', broadLocation: 'Konoha',
            description: 'A ninja training school.',
            features: ['Class A'],
            connections: [],
        });
        const ctx = makeCtx({ currentPlaceId: 'loc_a' });
        expect(buildTravelBlock(ctx, [a])).toBe('');
    });
});