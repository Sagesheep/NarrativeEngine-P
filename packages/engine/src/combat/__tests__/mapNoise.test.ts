import { describe, it, expect } from 'vitest';
import {
    AREA_TYPES, HAZARD_KINDS, MAP_GENERATOR_VERSION, SPAWN_COLUMNS, buildMapFromSeed, createCombat, buildPcCombatant,
    hasHazardFreeRoute, isFullyConnected, shareBand, terrainShare,
} from '../index';
import type { AreaType, Grid, MapSize, PcCombatantInput } from '../index';

const SIZES: readonly MapSize[] = ['small', 'medium', 'large'];
const SEEDS = 300;
const CHARS: Record<string, string> = { floor: '.', wall: '#', cover: 'o', difficult: '~', hazard: '!' };
const BLOCK_AREAS: readonly AreaType[] = ['open', 'scattered', 'wetland', 'ruins', 'ledge'];

function render(g: Grid): string[] {
    const rows: string[] = [];
    for (let y = 0; y < g.height; y++) rows.push(g.tiles.slice(y * g.width, (y + 1) * g.width).map(t => CHARS[t]).join(''));
    return rows;
}

function components(g: Grid): string[] {
    const seen = new Set<number>();
    const keys: string[] = [];
    for (let i = 0; i < g.tiles.length; i++) {
        const tile = g.tiles[i];
        if (tile === 'floor' || tile === 'hazard' || seen.has(i)) continue;
        const cells = [i];
        seen.add(i);
        for (let k = 0; k < cells.length; k++) {
            const x = cells[k] % g.width;
            const y = Math.floor(cells[k] / g.width);
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= g.width || ny >= g.height) continue;
                const n = ny * g.width + nx;
                if (seen.has(n) || g.tiles[n] !== tile) continue;
                seen.add(n);
                cells.push(n);
            }
        }
        const pts = cells.map(c => ({ x: c % g.width, y: Math.floor(c / g.width) }));
        const mx = Math.min(...pts.map(p => p.x));
        const my = Math.min(...pts.map(p => p.y));
        keys.push(`${tile}:${pts.map(p => `${p.x - mx},${p.y - my}`).sort().join(';')}`);
    }
    return keys;
}

function densityVariance(g: Grid): number {
    const counts: number[] = [];
    for (let y = 0; y + 3 <= g.height; y++) {
        for (let x = SPAWN_COLUMNS; x + 3 <= g.width - SPAWN_COLUMNS; x++) {
            let n = 0;
            for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) if (g.tiles[(y + dy) * g.width + x + dx] !== 'floor') n++;
            counts.push(n);
        }
    }
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    return counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
}

function hasSolid2x2(g: Grid): boolean {
    for (let y = 0; y + 1 < g.height; y++) {
        for (let x = 0; x + 1 < g.width; x++) {
            if ([0, 1].every(dy => [0, 1].every(dx => g.tiles[(y + dy) * g.width + x + dx] === 'wall'))) return true;
        }
    }
    return false;
}

describe('map generator version 2 keeps every guarantee', () => {
    it('is the current version', () => {
        expect(MAP_GENERATOR_VERSION).toBe(2);
    });

    for (const area of AREA_TYPES) {
        it(`${area}: ${SEEDS} seeds per size keep spawn columns, connectivity, hazard route and share band`, () => {
            const [lo, hi] = shareBand(area, 'normal');
            for (const size of SIZES) {
                for (let seed = 1; seed <= SEEDS; seed++) {
                    const hazard = HAZARD_KINDS[seed % HAZARD_KINDS.length];
                    const g = buildMapFromSeed({ area, density: 'normal', size, hazard }, seed);
                    const label = `${area} ${size} seed ${seed}`;
                    expect(g.area, label).toBe(area);
                    for (let y = 0; y < g.height; y++) {
                        for (const x of [0, 1, g.width - 2, g.width - 1]) expect(g.tiles[y * g.width + x], label).toBe('floor');
                    }
                    expect(isFullyConnected(g), label).toBe(true);
                    expect(hasHazardFreeRoute(g), label).toBe(true);
                    expect(g.tiles.includes('hazard'), label).toBe(hazard !== 'none');
                    const share = terrainShare(area, g);
                    expect(share, label).toBeGreaterThanOrEqual(lo - 1e-9);
                    expect(share, label).toBeLessThanOrEqual(hi + 1e-9);
                }
            }
        });
    }

    it('is deterministic for a seed and varies across seeds', () => {
        for (const area of AREA_TYPES) {
            const spec = { area, density: 'normal', size: 'medium', hazard: 'fire' } as const;
            expect(buildMapFromSeed(spec, 41)).toEqual(buildMapFromSeed(spec, 41));
            const distinct = new Set(Array.from({ length: 20 }, (_, i) => buildMapFromSeed(spec, i + 1).tiles.join('')));
            expect(distinct.size, area).toBeGreaterThanOrEqual(18);
        }
    });
});

describe('map generator version 2 is less regular than version 1', () => {
    const stats = AREA_TYPES.map(area => {
        const measure = (version: number) => {
            let shapes = 0;
            let spread = 0;
            const n = 80;
            for (let seed = 1; seed <= n; seed++) {
                const g = buildMapFromSeed({ area, density: 'normal', size: 'medium' }, seed, version);
                shapes += new Set(components(g)).size;
                spread += densityVariance(g);
            }
            return { shapes: shapes / n, spread: spread / n };
        };
        return { area, old: measure(1), now: measure(2) };
    });

    it('raises the average number of distinct shapes and the clumpiness of density', () => {
        const mean = (pick: (s: typeof stats[number]) => number) => stats.reduce((a, s) => a + pick(s), 0) / stats.length;
        expect(mean(s => s.now.shapes)).toBeGreaterThan(mean(s => s.old.shapes));
        expect(mean(s => s.now.spread)).toBeGreaterThan(mean(s => s.old.spread));
        for (const s of stats) {
            expect(s.now.shapes, s.area).toBeGreaterThan(s.old.shapes * 0.9);
            expect(s.now.spread, s.area).toBeGreaterThan(s.old.spread * 0.8);
        }
    });

    it('breaks up the rows layout most', () => {
        const rows = stats.find(s => s.area === 'rows');
        expect(rows!.now.shapes).toBeGreaterThan(rows!.old.shapes * 1.5);
        expect(rows!.now.spread).toBeGreaterThan(rows!.old.spread * 1.5);
    });

    it('gives outdoor maps room for a large piece now and then, which the old layouts never did', () => {
        for (const area of BLOCK_AREAS) {
            if (area === 'ledge') continue;
            let old = 0;
            let now = 0;
            for (let seed = 1; seed <= 100; seed++) {
                if (hasSolid2x2(buildMapFromSeed({ area, density: 'normal', size: 'medium' }, seed, 1))) old++;
                if (hasSolid2x2(buildMapFromSeed({ area, density: 'normal', size: 'medium' }, seed, 2))) now++;
            }
            expect(now, area).toBeGreaterThan(old);
            expect(now, area).toBeGreaterThanOrEqual(8);
        }
    });
});

describe('the old generator version still reproduces the old grids exactly', () => {
    it('pins three grids', () => {
        expect(render(buildMapFromSeed({ area: 'open', size: 'small', density: 'sparse' }, 3, 1))).toEqual([
            '...~......', '...~...o..', '..........', '..........', '..........', '..........', '.......~..', '.......~..',
        ]);
        expect(render(buildMapFromSeed({ area: 'rows', size: 'medium', density: 'normal', hazard: 'fire' }, 11, 1))).toEqual([
            '.....!!!......', '..............', '....o.....o...', '....o..o..o...', '....o..o..o...',
            '....o!.o..o...', '....o!.o......', '....o!.o......', '.......o......', '..............',
        ]);
        expect(render(buildMapFromSeed({ area: 'cavern', size: 'small', density: 'dense', hazard: 'toxic' }, 5, 1))).toEqual([
            '...####...', '....##....', '..........', '..~##!!...', '..~##..o..', '.....!!...', '....###...', '..######..',
        ]);
    });

    it('stores the version a fight was built with and rebuilds nothing from the seed afterwards', () => {
        const pc: PcCombatantInput = { name: 'PC', sheet: { abilities: { STR: 12, DEX: 12, CON: 12, INT: 10, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 1, needsAllocation: false } };
        const spec = { id: 'v', combatants: [{ name: 'Foe', side: 'enemy' as const, tier: 'grunt' as const }], map: { area: 'rows' as const, size: 'medium' as const }, mapSeed: 11 };
        const current = createCombat(spec, buildPcCombatant(pc), 1).state;
        const old = createCombat({ ...spec, mapVersion: 1 }, buildPcCombatant(pc), 1).state;
        expect(current.mapVersion).toBe(MAP_GENERATOR_VERSION);
        expect(old.mapVersion).toBeUndefined();
        expect(current.grid).toEqual(buildMapFromSeed(spec.map, 11));
        expect(old.grid).toEqual(buildMapFromSeed(spec.map, 11, 1));
        expect(old.grid).not.toEqual(current.grid);
    });
});
