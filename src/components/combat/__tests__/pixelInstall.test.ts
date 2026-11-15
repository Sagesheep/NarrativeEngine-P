import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CombatAreaType, CombatGrid, CombatTile } from '../../../types';
import { PIXEL_FOLDERS, buildPixelCatalog } from '../pixelCatalog';
import type { PixelFolder } from '../pixelCatalog';
import { PIXEL_ALIASES, buildPixelPlan, choosePixelFloor } from '../pixelMap';
import { PAINTED_ONLY_FLOORS, PIXEL_PLACE_KEYWORDS, PIXEL_SETS, areaAllowsFloor, classifiedNames, setIdForFloor } from '../pixelSets';
import type { PixelPieceKind } from '../pixelSets';
import { AREA_DEFAULTS, FLOOR_KEYWORDS } from '../tileset';

const ROOT = join(process.cwd(), 'public', 'assets', 'combat');

function listPng(dir: string): string[] {
    return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.png')).map(f => f.slice(0, -4)).sort() : [];
}

const raw: Partial<Record<PixelFolder, string[]>> = {};
for (const folder of PIXEL_FOLDERS) raw[folder] = listPng(join(ROOT, 'pixel', folder));
const catalog = buildPixelCatalog(raw);
const AREAS = Object.keys(AREA_DEFAULTS) as CombatAreaType[];

function baseName(file: string): string {
    return file.replace(/@.*$/, '').replace(/-[abc]$/, '');
}

function propNames(kind: 'cover' | 'wall'): Set<string> {
    const names = new Set<string>();
    for (const file of raw[kind] ?? []) names.add(file.replace(/@.*$/, ''));
    return names;
}

function mixedGrid(area: CombatAreaType, hazardType: CombatGrid['hazardType'], labels?: CombatGrid['labels']): CombatGrid {
    const width = 24;
    const height = 16;
    const order: CombatTile[] = ['floor', 'cover', 'wall', 'difficult', 'hazard', 'floor', 'wall', 'wall'];
    const tiles: CombatTile[] = [];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) tiles.push(x < 8 && y < 8 ? 'wall' : order[(x * 7 + y * 3 + (x >> 2)) % order.length]);
    }
    return { width, height, tiles, area, hazardType, labels };
}

describe('installed pixel art', () => {
    it('is present and every file parses', () => {
        expect(catalog.rejected).toEqual([]);
        expect([...catalog.floors.keys()].length).toBeGreaterThan(0);
        expect(catalog.covers.length).toBeGreaterThan(0);
        expect(catalog.walls.length + catalog.fills.length).toBeGreaterThan(0);
    });

    it('classifies every installed file into at least one set, and every set entry names a file', () => {
        const floorBases = new Set(catalog.floors.keys());
        const listed = new Set(Object.values(PIXEL_SETS).flatMap(s => s.floors));
        expect([...floorBases].filter(f => !listed.has(f))).toEqual([]);
        expect([...listed].filter(f => !floorBases.has(f))).toEqual([]);
        const files: Record<Exclude<PixelPieceKind, 'wall' | 'cover'>, readonly string[]> = {
            difficult: catalog.difficult, hazard: catalog.hazard, decal: catalog.decals,
        };
        for (const kind of ['difficult', 'hazard', 'decal'] as const) {
            const known = classifiedNames(kind);
            expect(files[kind].filter(n => !known.has(n))).toEqual([]);
            expect([...known].filter(n => !files[kind].includes(n))).toEqual([]);
        }
        for (const kind of ['cover', 'wall'] as const) {
            const known = classifiedNames(kind);
            const present = new Set([...propNames(kind), ...(kind === 'wall' ? catalog.fills : [])]);
            expect([...present].filter(n => !known.has(n))).toEqual([]);
            expect([...known].filter(n => !present.has(n))).toEqual([]);
        }
    });

    it('every floor belongs to exactly one set', () => {
        for (const base of catalog.floors.keys()) {
            const owners = Object.values(PIXEL_SETS).filter(s => s.floors.includes(base));
            expect(owners, base).toHaveLength(1);
        }
    });

    it('every set has floor variants, a cover prop and a wall piece', () => {
        for (const [id, set] of Object.entries(PIXEL_SETS)) {
            expect(set.floors.every(f => (catalog.floors.get(f)?.length ?? 0) >= 1), id).toBe(true);
            expect(set.cover.length, id).toBeGreaterThan(0);
            expect(set.wall.length, id).toBeGreaterThan(0);
        }
    });
});

describe('every place type picks a pixel floor with fitting art', () => {
    it.each(AREAS)('area %s resolves to a pixel floor whose set has cover and wall pieces', area => {
        const floor = choosePixelFloor(catalog, undefined, area);
        expect(floor).not.toBeNull();
        const set = PIXEL_SETS[setIdForFloor(floor as string) as string];
        expect(set.cover.length).toBeGreaterThan(0);
        expect(set.wall.length).toBeGreaterThan(0);
    });

    it('every place keyword resolves to a pixel floor, or is painted on purpose', () => {
        const unresolved: string[] = [];
        for (const entry of [...FLOOR_KEYWORDS, ...PIXEL_PLACE_KEYWORDS]) {
            for (const word of entry.words) {
                if (choosePixelFloor(catalog, word, undefined) === null && !PAINTED_ONLY_FLOORS.includes(entry.floor)) unresolved.push(`${word} -> ${entry.floor}`);
            }
        }
        expect(unresolved).toEqual([]);
    });

    it('every painted floor maps to a pixel floor or is listed as painted on purpose', () => {
        const painted = listPng(join(ROOT, 'tiles', 'floor'));
        expect(painted.length).toBeGreaterThan(0);
        const none = painted.filter(name => {
            const base = name.replace(/-alt$/, '');
            const names = [...(PIXEL_ALIASES[name] ?? []), name, ...(PIXEL_ALIASES[base] ?? []), base];
            return !names.some(n => catalog.floors.has(n));
        });
        expect(none).toEqual([...PAINTED_ONLY_FLOORS].sort());
    });

    it('a place word wins over the area default', () => {
        expect(choosePixelFloor(catalog, 'a derelict freighter', 'corridors')).toBe('rusted-deck');
        expect(choosePixelFloor(catalog, 'a frozen lake', 'open')).toBe('snow');
        expect(choosePixelFloor(catalog, 'the old tavern', 'room')).toBe('wood-planks');
        expect(choosePixelFloor(catalog, 'the ruins', 'open')).toBe('mossy-stone');
    });
});

describe('a map never mixes sets', () => {
    const wetLabels = { cover: 'server racks', wall: 'billboards', difficult: 'cables', hazard: 'toxic sludge' };
    const hazards: CombatGrid['hazardType'][] = [undefined, 'fire', 'deep_water', 'electric', 'toxic', 'pit'];

    const PLACES: Readonly<Record<string, { place?: string; area?: CombatAreaType }>> = {
        grass: { place: 'a meadow' },
        'dirt-path': { area: 'ledge' },
        'dirt-road': { place: 'a village' },
        'wood-planks': { place: 'a tavern' },
        'city-cobblestone': { place: 'a town street' },
        'dungeon-flagstone': { place: 'a dungeon' },
        'cave-stone': { place: 'a cave' },
        'sewer-brick': { place: 'a sewer' },
        'stone-rampart': { place: 'the rampart' },
        asphalt: { place: 'a parking lot' },
        pavement: { place: 'a plaza' },
        carpet: { place: 'an office' },
        'tiled-floor': { place: 'a lobby' },
        'asphalt-wet': { place: 'a neon alley' },
        concrete: { place: 'a warehouse' },
        'metal-grating': { place: 'a catwalk' },
        'metal-plating': { place: 'a starship' },
        'rusted-deck': { place: 'a derelict hulk' },
        'alien-organic': { place: 'an alien hive' },
        swamp: { place: 'a swamp' },
        'swamp-water': { place: 'a pond' },
        sand: { place: 'a desert' },
        snow: { place: 'the tundra' },
        'mossy-stone': { place: 'the ruins' },
    };

    function areaFor(floor: string): CombatAreaType {
        return AREAS.find(a => areaAllowsFloor(a, floor)) as CombatAreaType;
    }

    it('every floor has a place that selects it', () => {
        for (const floor of catalog.floors.keys()) {
            const where = PLACES[floor];
            expect(where, floor).toBeDefined();
            expect(choosePixelFloor(catalog, where.place, where.area ?? areaFor(floor)), floor).toBe(floor);
        }
    });

    function used(floor: string, area: CombatAreaType, hazardType: CombatGrid['hazardType'], labels: CombatGrid['labels'], seed: number): Record<PixelPieceKind, Set<string>> {
        const set = PIXEL_SETS[setIdForFloor(floor) as string];
        const where = PLACES[floor];
        const grid = mixedGrid(where.area ?? area, hazardType, labels);
        const plan = buildPixelPlan({ grid, catalog, seed, style: 'auto', place: where.place });
        const out: Record<PixelPieceKind, Set<string>> = { cover: new Set(), wall: new Set(), difficult: new Set(), hazard: new Set(), decal: new Set() };
        expect(plan).not.toBeNull();
        if (!plan) return out;
        expect(plan.floor).toBe(floor);
        for (const p of plan.props) out[p.kind].add(p.name);
        for (const path of plan.fillPaths) if (path) out.wall.add(path.split('/')[1]);
        for (const path of plan.overlayPaths) {
            if (!path) continue;
            const [folder, name] = path.split('/');
            out[folder === 'hazard' ? 'hazard' : 'difficult'].add(name);
        }
        for (const path of plan.decalPaths) if (path) out.decal.add(path.split('/')[1]);
        for (const path of plan.floorPaths) if (path) expect(set.floors).toContain(baseName(path.split('/')[1]));
        return out;
    }

    for (const [id, set] of Object.entries(PIXEL_SETS)) {
        for (const floor of set.floors) {
            it(`${id}/${floor}: only its own pieces appear, for any area, hazard, label and seed`, () => {
                for (const area of AREAS) {
                    if (!PLACES[floor].area && !areaAllowsFloor(area, floor)) continue;
                    for (const hazardType of hazards) {
                        for (const labels of [undefined, wetLabels]) {
                            const result = used(floor, area, hazardType, labels, 1);
                            for (const kind of ['cover', 'wall', 'difficult', 'hazard', 'decal'] as const) {
                                const stray = [...result[kind]].filter(n => !set[kind].includes(n));
                                expect(stray, `${floor}/${area}/${String(hazardType)}/${kind}`).toEqual([]);
                            }
                        }
                    }
                }
            });

            it(`${id}/${floor}: draws cover props and wall pieces on a mixed board`, () => {
                const result = used(floor, areaFor(floor), 'fire', undefined, 3);
                expect(result.cover.size).toBeGreaterThan(0);
                expect(result.wall.size).toBeGreaterThan(0);
            });
        }
    }

    it('a forest gets trees and rocks, a starship gets consoles and bulkheads', () => {
        const forest = buildPixelPlan({ grid: mixedGrid('scattered', undefined), catalog, seed: 4, style: 'auto', place: 'a forest clearing' });
        expect(forest?.floor).toBe('grass');
        expect(forest?.props.some(p => /^tree-/.test(p.name))).toBe(true);
        const ship = buildPixelPlan({ grid: mixedGrid('corridors', 'electric'), catalog, seed: 4, style: 'auto', place: 'the starship corridor' });
        expect(ship?.floor).toBe('metal-plating');
        expect(ship?.props.every(p => PIXEL_SETS.starship[p.kind].includes(p.name))).toBe(true);
        expect(ship?.fillPaths.filter(Boolean).every(p => p === 'wall/metal-bulkhead')).toBe(true);
    });
});
