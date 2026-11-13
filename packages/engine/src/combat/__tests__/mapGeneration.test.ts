import { describe, it, expect } from 'vitest';
import {
    AREA_TYPES, MAP_DENSITIES, HAZARD_KINDS, KEYWORD_COUNT, DEFAULT_AREA_LABELS,
    buildMapFromSeed, ensureGrid, hasHazardFreeRoute, inferHazard, inferMapSpec, isFullyConnected,
    mapSizeFor, normalizeMapSpec, resolveMapSpec, shareBand, terrainShare, cleanLabel,
} from '../index';
import type { AreaType, CombatState, Grid, MapSize } from '../index';
import calls from './fixtures/haikuCombatCalls.json';

const CHARS: Record<string, string> = { floor: '.', wall: '#', cover: 'o', difficult: '~', hazard: '!' };
const SIZES: readonly MapSize[] = ['small', 'medium', 'large'];
const SEEDS = 150;

function render(g: Grid): string {
    const rows: string[] = [];
    for (let y = 0; y < g.height; y++) rows.push(g.tiles.slice(y * g.width, (y + 1) * g.width).map(t => CHARS[t]).join(''));
    return rows.join('\n');
}

function spawnColumnsFloor(g: Grid): boolean {
    for (let y = 0; y < g.height; y++) {
        for (const x of [0, 1, g.width - 2, g.width - 1]) if (g.tiles[y * g.width + x] !== 'floor') return false;
    }
    return true;
}

function hazardsAwayFromSpawns(g: Grid): boolean {
    return g.tiles.every((t, i) => t !== 'hazard' || ((i % g.width) >= 3 && (i % g.width) <= g.width - 4));
}

describe('T6 property: every area, density, size and seed', () => {
    const ranges: string[] = [];
    for (const area of AREA_TYPES) {
        for (const density of MAP_DENSITIES) {
            it(`${area} / ${density} keeps every invariant and lands in its share band`, () => {
                const [lo, hi] = shareBand(area, density);
                for (const size of SIZES) {
                    let min = 1;
                    let max = 0;
                    for (let seed = 1; seed <= SEEDS; seed++) {
                        const hazard = HAZARD_KINDS[seed % HAZARD_KINDS.length];
                        const g = buildMapFromSeed({ area, density, size, hazard }, seed);
                        const label = `${area} ${density} ${size} seed ${seed}`;
                        expect(g.area, label).toBe(area);
                        expect(spawnColumnsFloor(g), label).toBe(true);
                        expect(isFullyConnected(g), label).toBe(true);
                        expect(hasHazardFreeRoute(g), label).toBe(true);
                        expect(hazardsAwayFromSpawns(g), label).toBe(true);
                        if (hazard !== 'none') expect(g.tiles.includes('hazard'), label).toBe(true);
                        else expect(g.tiles.includes('hazard'), label).toBe(false);
                        const share = terrainShare(area, g);
                        expect(share, label).toBeGreaterThanOrEqual(lo - 1e-9);
                        expect(share, label).toBeLessThanOrEqual(hi + 1e-9);
                        expect(Object.keys(g.labels ?? {}).sort()).toEqual(['cover', 'difficult', 'hazard', 'wall']);
                        min = Math.min(min, share);
                        max = Math.max(max, share);
                    }
                    ranges.push(`${area} ${density} ${size}: ${(min * 100).toFixed(1)}-${(max * 100).toFixed(1)}%`);
                }
                expect(buildMapFromSeed({ area, density, size: 'medium', hazard: 'fire' }, 77)).toEqual(buildMapFromSeed({ area, density, size: 'medium', hazard: 'fire' }, 77));
            });
        }
    }
    it('prints the measured share ranges', () => {
        console.log(`[map-share]\n${ranges.join('\n')}`);
        expect(ranges.length).toBe(AREA_TYPES.length * MAP_DENSITIES.length * SIZES.length);
    });
});

describe('T6 snapshot: one map per area (medium, normal)', () => {
    for (const area of AREA_TYPES) {
        it(`${area}`, () => {
            const g = buildMapFromSeed({ area, density: 'normal', size: 'medium' }, 2026);
            expect(`${render(g)}\nshare ${(terrainShare(area, g) * 100).toFixed(1)}% labels ${JSON.stringify(g.labels)}`).toMatchSnapshot();
        });
    }
});

type FixtureCall = { scene: number; title: string; args: { combatants: unknown[]; map?: unknown; reason: string } };

describe('T6 fixture: the 12 model calls as they were sent', () => {
    it('converts the old shape, infers an area and builds a map with terrain', () => {
        const lines: string[] = [];
        for (const call of calls as FixtureCall[]) {
            const legacy = normalizeMapSpec(call.args.map);
            if (call.args.map) expect(legacy.place, `scene ${call.scene}`).toBeTruthy();
            const { size: _ignored, ...withoutSize } = legacy;
            void _ignored;
            const resolved = resolveMapSpec(withoutSize, { combatants: call.args.combatants.length, texts: [call.args.reason] });
            const g = buildMapFromSeed(resolved, call.scene * 1000 + 7);
            const share = terrainShare(g.area as AreaType, g);
            expect(share, `scene ${call.scene}`).toBeGreaterThanOrEqual(0.08);
            if (call.scene === 9) expect(g.area).toBe('open');
            else expect(g.area, `scene ${call.scene}`).not.toBe('open');
            lines.push(`#${call.scene} ${call.title} | area ${g.area} | size ${resolved.size} | hazard ${resolved.hazard} | share ${(share * 100).toFixed(1)}% | labels ${JSON.stringify(g.labels)}\n${render(g)}`);
        }
        console.log(`[fixture-maps]\n${lines.join('\n\n')}`);
    });
});

describe('T3 inference', () => {
    it('maps typical places to their area across genres', () => {
        const cases: Array<[string, AreaType]> = [
            ['a sunny field', 'open'], ['the rooftop of the arcology', 'open'], ['dense forest', 'scattered'], ['the old graveyard', 'scattered'],
            ['a smoky tavern', 'room'], ['the throne room', 'room'], ['server room', 'rows'], ['abandoned warehouse', 'rows'],
            ['starship corridor junction', 'corridors'], ['the sewers below the city', 'corridors'], ['a crystal cave', 'cavern'], ['an old mineshaft', 'cavern'],
            ['neon-lit alley', 'street'], ['canal side', 'street'], ['narrow mountain pass', 'ledge'], ['castle rampart walkway', 'ledge'],
            ['ruined temple', 'ruins'], ['a ruined tavern', 'ruins'], ['the swamp', 'wetland'], ['flooded cave', 'wetland'], ['river ford', 'wetland'],
        ];
        for (const [text, area] of cases) expect(inferMapSpec(text).area, text).toBe(area);
        expect(KEYWORD_COUNT).toBeGreaterThan(150);
    });

    it('uses the first source that matches and falls back to scattered', () => {
        expect(inferMapSpec(['', 'they jump you in the alley', 'a quiet forest']).area).toBe('street');
        expect(inferMapSpec(['a strange place', undefined, 'nowhere in particular'])).toEqual({ matched: false, area: 'scattered' });
        expect(inferMapSpec('the bandits swing a club at you').area).toBe('scattered');
    });

    it('reads a hazard only from place text and names it', () => {
        expect(inferHazard('exposed plasma conduits')).toEqual({ hazard: 'electric', label: 'plasma conduits' });
        expect(inferHazard('a pool of lava')?.hazard).toBe('fire');
        expect(inferHazard('a fire escape')).toBeNull();
        const resolved = resolveMapSpec({ place: 'warehouse' }, { texts: ['the fire spreads'] });
        expect(resolved.hazard).toBe('none');
        expect(resolveMapSpec({ place: 'starship, exposed plasma conduits' }).labels.hazard).toBe('plasma conduits');
    });

    it('keeps labels the AI gave, takes inferred labels only for the inferred area, and fills defaults', () => {
        const auto = resolveMapSpec({ place: 'night graveyard' });
        expect(auto.labels.cover).toBe('tombstones');
        const switched = resolveMapSpec({ place: 'night graveyard', area: 'cavern' });
        expect(switched.labels).toEqual({ ...DEFAULT_AREA_LABELS.cavern, hazard: 'hazard' });
        const named = resolveMapSpec({ area: 'rows', labels: { cover: 'Server Racks!!' } });
        expect(named.labels.cover).toBe('server racks');
        expect(cleanLabel('An extremely long description of a barricade')).toHaveLength(cleanLabel('An extremely long description of a barricade').length);
        expect(cleanLabel('An extremely long description of a barricade').length).toBeLessThanOrEqual(24);
    });
});

describe('T4 size from the fight', () => {
    it('chooses size from the number of combatants besides the player', () => {
        expect([1, 3, 4, 7, 8, 12].map(n => mapSizeFor(n))).toEqual(['small', 'small', 'medium', 'medium', 'large', 'large']);
        expect(mapSizeFor(2, 'ledge')).toBe('medium');
        expect(mapSizeFor(2, 'street')).toBe('medium');
        expect(resolveMapSpec({ area: 'room' }, { combatants: 5 }).size).toBe('medium');
        expect(resolveMapSpec({ area: 'room', size: 'large' }, { combatants: 1 }).size).toBe('large');
    });
});

describe('T1 old shapes still load', () => {
    it('turns theme and feature kinds into place text', () => {
        expect(normalizeMapSpec({ size: 'large', theme: 'night graveyard', features: [{ kind: 'tombstones', where: 'scattered' }, { kind: 3 }] }))
            .toEqual({ size: 'large', place: 'night graveyard, tombstones' });
    });

    it('gives a stored grid without area or labels the open area and default labels', () => {
        const grid: Grid = { width: 4, height: 4, tiles: new Array(16).fill('floor'), hazardType: 'acid' };
        const state: CombatState = {
            id: 'old', round: 1, order: [], turnIndex: 0, combatants: {}, rngSeed: 1, rngCursor: 0, eventSeq: 0, outcome: null, grid, turnCount: 1,
            turn: { actorId: 'x', moveLeft: 6, actionUsed: false },
        };
        const upgraded = ensureGrid(state);
        expect(upgraded.grid?.area).toBe('open');
        expect(upgraded.grid?.labels).toEqual({ ...DEFAULT_AREA_LABELS.open, hazard: 'acid' });
        expect(upgraded.grid?.tiles).toEqual(grid.tiles);
        expect(ensureGrid(upgraded)).toBe(upgraded);
    });
});
