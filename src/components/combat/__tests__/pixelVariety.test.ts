import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AREA_TYPES, DEFAULT_AREA_LABELS, buildMapFromSeed, buildPcCombatant, createCombat } from '@narrative/engine';
import type { CombatAreaType, CombatGrid, CombatTile } from '../../../types';
import { PIXEL_FOLDERS, buildPixelCatalog } from '../pixelCatalog';
import type { PixelFolder } from '../pixelCatalog';
import { buildPixelPlan, choosePixelFloor } from '../pixelMap';
import type { PixelPlan } from '../pixelMap';
import { AREA_FLOORS, NO_MIRROR, PIXEL_COMPANIONS, PIXEL_SETS, areaAllowsSet, setIdForFloor } from '../pixelSets';
import { AREA_DEFAULTS } from '../tileset';

const ROOT = join(process.cwd(), 'public', 'assets', 'combat', 'pixel');

function listPng(dir: string): string[] {
    return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.png')).map(f => f.slice(0, -4)).sort() : [];
}

const raw: Partial<Record<PixelFolder, string[]>> = {};
for (const folder of PIXEL_FOLDERS) raw[folder] = listPng(join(ROOT, folder));
const real = buildPixelCatalog(raw);
const AREAS = AREA_TYPES as readonly CombatAreaType[];

const CHAR: Record<string, CombatTile> = { '.': 'floor', o: 'cover', '#': 'wall', '~': 'difficult', '!': 'hazard' };

function gridOf(rows: string[], extra: Partial<CombatGrid> = {}): CombatGrid {
    return { width: rows[0].length, height: rows.length, tiles: rows.join('').split('').map(ch => CHAR[ch]), area: 'open', ...extra };
}

function filled(width: number, height: number, ch: string): string[] {
    return Array.from({ length: height }, () => ch.repeat(width));
}

function plan(grid: CombatGrid, catalog = real, extra: { seed?: number; place?: string; occupied?: ReadonlySet<string> } = {}): PixelPlan {
    const result = buildPixelPlan({ grid, catalog, seed: extra.seed ?? 5, style: 'auto', place: extra.place, occupied: extra.occupied });
    if (!result) throw new Error('no plan');
    return result;
}

function names(p: PixelPlan, kind: 'cover' | 'wall'): string[] {
    return p.props.filter(x => x.kind === kind).map(x => x.name);
}

const GRASS = ['grass-a', 'grass-b', 'grass-c'];

describe('a map mixes several pieces', () => {
    it('uses several cover and wall pieces on a big enough map', () => {
        const grid = gridOf([...filled(30, 8, 'o'), ...filled(30, 8, '#')], { area: 'scattered' });
        const result = plan(grid, real, { place: 'a forest clearing' });
        expect(new Set(names(result, 'cover')).size).toBeGreaterThanOrEqual(3);
        expect(new Set(names(result, 'wall')).size).toBeGreaterThanOrEqual(3);
    });

    it('keeps the label piece dominant and the rest of the set below it', () => {
        const grid = gridOf(filled(30, 12, 'o'), { labels: { cover: 'crates' } });
        const result = plan(grid, real, { place: 'a meadow' });
        const list = names(result, 'cover');
        const crates = list.filter(n => n === 'crates').length;
        expect(crates / list.length).toBeGreaterThan(0.4);
        expect(crates / list.length).toBeLessThan(0.9);
        expect(new Set(list).size).toBeGreaterThan(1);
        const weights = result.palettes.cover;
        expect(weights.find(e => e.name === 'crates')?.weight).toBeCloseTo(0.6, 5);
        expect(weights.reduce((a, e) => a + e.weight, 0)).toBeCloseTo(1, 5);
    });

    it('never pulls a piece from another set, and leaves no marker', () => {
        const rows = [...filled(24, 6, 'o'), ...filled(24, 6, '#')];
        const grid = gridOf(rows, { area: 'cavern', labels: { cover: 'trees', wall: 'houses' } });
        const result = plan(grid, real, { place: 'a deep forest' });
        expect(result.floor).toBe('cave-stone');
        const set = PIXEL_SETS.dungeon;
        for (const p of result.props) expect(set[p.kind]).toContain(p.name);
        for (const path of result.fillPaths) if (path) expect(set.wall).toContain(path.split('/')[1]);
        expect(result.markers.filter(Boolean)).toEqual([]);
        expect(names(result, 'cover').some(n => /tree|house/.test(n))).toBe(false);
    });

    it('is the same for a seed and different for another', () => {
        const grid = gridOf([...filled(20, 6, 'o'), ...filled(20, 6, '#')], { area: 'scattered' });
        const a = plan(grid, real, { seed: 9, place: 'forest' });
        expect(plan(grid, real, { seed: 9, place: 'forest' })).toEqual(a);
        const b = plan(grid, real, { seed: 10, place: 'forest' });
        expect(b.props.map(p => `${p.name}${p.x}${p.y}`)).not.toEqual(a.props.map(p => `${p.name}${p.x}${p.y}`));
    });

    it('lets neighbouring tiles share a piece more often than chance', () => {
        const cat = buildPixelCatalog({ floor: GRASS, cover: ['bush', 'crates', 'log@1x1', 'rock', 'stump'] });
        const grid = gridOf(filled(30, 30, 'o'));
        const list = plan(grid, cat).props.filter(p => p.kind === 'cover');
        const at = new Map(list.map(p => [`${p.x},${p.y}`, p.name]));
        const freq = new Map<string, number>();
        for (const n of at.values()) freq.set(n, (freq.get(n) ?? 0) + 1);
        const chance = [...freq.values()].reduce((a, c) => a + (c / at.size) ** 2, 0);
        let pairs = 0;
        let same = 0;
        for (const [key, name] of at) {
            const [x, y] = key.split(',').map(Number);
            const right = at.get(`${x + 1},${y}`);
            if (right) {
                pairs++;
                if (right === name) same++;
            }
        }
        expect(same / pairs).toBeGreaterThan(chance + 0.15);
    });
});

describe('floors and decals', () => {
    it('draws floor variants in patches, not as a checkerboard', () => {
        const result = plan(gridOf(filled(30, 30, '.')), buildPixelCatalog({ floor: GRASS }));
        let runs = 0;
        let cells = 0;
        let alternating = 0;
        for (let y = 0; y < 30; y++) {
            let prev = '';
            for (let x = 0; x < 30; x++) {
                const v = result.floorPaths[y * 30 + x] as string;
                if (v !== prev) runs++;
                if (x >= 2 && result.floorPaths[y * 30 + x - 2] === v && result.floorPaths[y * 30 + x - 1] !== v) alternating++;
                prev = v;
                cells++;
            }
        }
        expect(cells / runs).toBeGreaterThan(2.2);
        expect(alternating / cells).toBeLessThan(0.1);
        expect(new Set(result.floorPaths).size).toBe(3);
    });

    it('scatters decals in drifts that average about one tile in eight', () => {
        const cat = buildPixelCatalog({ floor: GRASS, decal: ['flowers-white', 'flowers-yellow', 'pebbles'] });
        let total = 0;
        let tiles = 0;
        const blocks: number[] = [];
        let samePairs = 0;
        let pairs = 0;
        for (const seed of [1, 2, 3, 4]) {
            const result = plan(gridOf(filled(30, 30, '.')), cat, { seed });
            total += result.decalPaths.filter(Boolean).length;
            tiles += 900;
            for (let by = 0; by < 30; by += 5) {
                for (let bx = 0; bx < 30; bx += 5) {
                    let n = 0;
                    for (let y = by; y < by + 5; y++) for (let x = bx; x < bx + 5; x++) if (result.decalPaths[y * 30 + x]) n++;
                    blocks.push(n);
                }
            }
            for (let y = 0; y < 30; y++) {
                for (let x = 0; x < 29; x++) {
                    const a = result.decalPaths[y * 30 + x];
                    const b = result.decalPaths[y * 30 + x + 1];
                    if (a && b) {
                        pairs++;
                        if (a === b) samePairs++;
                    }
                }
            }
        }
        const density = total / tiles;
        expect(density).toBeGreaterThan(0.09);
        expect(density).toBeLessThan(0.16);
        const mean = blocks.reduce((a, b) => a + b, 0) / blocks.length;
        const variance = blocks.reduce((a, b) => a + (b - mean) ** 2, 0) / blocks.length;
        expect(variance / (25 * density * (1 - density))).toBeGreaterThan(1.5);
        expect(samePairs / pairs).toBeGreaterThan(0.55);
    });

    it('draws the companion floor only on plain floor tiles, and only where a set declares one', () => {
        const rows = filled(30, 20, '.').map((row, y) => (y % 5 === 2 ? 'o#~'.repeat(10) : row));
        const grid = gridOf(rows);
        let seen = 0;
        for (const seed of [1, 2, 3, 4, 5, 6]) {
            const result = plan(grid, real, { seed, place: 'a meadow' });
            result.floorPaths.forEach((path, i) => {
                if (!path || !path.startsWith('floor/dirt-path')) return;
                seen++;
                expect(grid.tiles[i]).toBe('floor');
            });
        }
        expect(seen).toBeGreaterThan(20);
        const desert = plan(gridOf(filled(30, 20, '.')), real, { place: 'a desert' });
        expect(new Set(desert.floorPaths.map(p => (p as string).replace(/-[abc]$/, ''))).size).toBe(1);
        for (const [floor, other] of Object.entries(PIXEL_COMPANIONS)) expect(setIdForFloor(other), floor).toBe(setIdForFloor(floor));
    });
});

describe('mirroring', () => {
    it('mirrors about half of the props, never one marked as not mirrorable', () => {
        const grid = gridOf([...filled(30, 10, 'o'), ...filled(30, 10, '#')], { area: 'scattered' });
        let mirrored = 0;
        let others = 0;
        for (const seed of [1, 2, 3]) {
            for (const p of plan(grid, real, { seed, place: 'forest' }).props) {
                if (NO_MIRROR.has(p.name)) expect(p.mirror, p.name).toBe(false);
                else {
                    others++;
                    if (p.mirror) mirrored++;
                }
            }
        }
        expect(mirrored / others).toBeGreaterThan(0.3);
        expect(mirrored / others).toBeLessThan(0.7);
        const houses = plan(gridOf(filled(20, 12, '#'), { area: 'street' }), real, { place: 'a town street', seed: 3 }).props;
        expect(houses.filter(p => NO_MIRROR.has(p.name)).every(p => !p.mirror)).toBe(true);
    });
});

describe('the board and the preview dress a map the same way', () => {
    it('gives the same plan for the same map seed, whether the grid is built for the preview or for the fight', () => {
        const spec = { area: 'scattered' as const, size: 'medium' as const, density: 'normal' as const, place: 'a forest clearing' };
        const preview = buildMapFromSeed(spec, 77);
        const pc = buildPcCombatant({ name: 'PC', sheet: { abilities: { STR: 12, DEX: 12, CON: 12, INT: 10, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 1, needsAllocation: false } });
        const { state } = createCombat({ id: 'x', combatants: [{ name: 'Foe', side: 'enemy', tier: 'grunt' }], map: spec, mapSeed: 77 }, pc, 5);
        const spots = new Set(Object.values(state.combatants).flatMap(c => (c.position ? [`${c.position.x},${c.position.y}`] : [])));
        const a = buildPixelPlan({ grid: preview as CombatGrid, catalog: real, seed: 77, style: 'auto', place: spec.place, occupied: spots });
        const b = buildPixelPlan({ grid: state.grid as CombatGrid, catalog: real, seed: state.mapSeed ?? 0, style: 'auto', place: spec.place, occupied: spots });
        expect(a).not.toBeNull();
        expect(b).toEqual(a);
    });
});

describe('the floor fits the area type', () => {
    const PLACES: readonly (string | undefined)[] = ['forest clearing', 'starship corridor', 'city street', 'old crypt', undefined];

    it.each(AREAS)('%s: every place text picks a floor whose set the area allows', area => {
        for (const place of PLACES) {
            const floor = choosePixelFloor(real, place, area) as string;
            expect(floor, `${area} / ${place}`).toBeTruthy();
            expect(areaAllowsSet(area, setIdForFloor(floor) as string), `${area} / ${place} -> ${floor}`).toBe(true);
            expect(AREA_FLOORS[area]).toContain(floor);
        }
    });

    it('a cavern is never grass, and the place still wins where the area allows it', () => {
        for (const place of PLACES) expect(choosePixelFloor(real, place, 'cavern')).not.toBe('grass');
        expect(choosePixelFloor(real, 'forest clearing', 'cavern')).toBe('cave-stone');
        expect(choosePixelFloor(real, 'starship corridor', 'corridors')).toBe('metal-plating');
        expect(choosePixelFloor(real, 'forest clearing', 'scattered')).toBe('grass');
        expect(choosePixelFloor(real, 'forest clearing', 'room')).not.toBe('grass');
        expect(choosePixelFloor(real, 'old crypt', 'corridors')).toBe('dungeon-flagstone');
    });

    it('every area default floor is allowed for its own area', () => {
        for (const area of AREAS) {
            const floor = choosePixelFloor(real, undefined, area);
            expect(floor, area).not.toBeNull();
            expect(AREA_DEFAULTS[area].floor.length).toBeGreaterThan(0);
        }
    });

    it('with no place text, each area looks different from at least three others', () => {
        const signature = (area: CombatAreaType): string => {
            const labels = { ...DEFAULT_AREA_LABELS[area], hazard: 'hazard' };
            const grid = buildMapFromSeed({ area, size: 'large', density: 'dense', labels }, 12) as CombatGrid;
            const result = plan(grid, real, { seed: 12 });
            const pieces = [...new Set(result.props.map(p => `${p.kind}:${p.name}`))].sort();
            const fills = [...new Set(result.fillPaths.filter(Boolean))].sort();
            return `${result.floor}|${pieces.join(',')}|${fills.join(',')}`;
        };
        const sigs = new Map(AREAS.map(a => [a, signature(a)]));
        for (const area of AREAS) {
            const different = AREAS.filter(other => other !== area && sigs.get(other) !== sigs.get(area)).length;
            expect(different, area).toBeGreaterThanOrEqual(3);
        }
    });
});
