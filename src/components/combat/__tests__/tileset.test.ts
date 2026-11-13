import { describe, it, expect } from 'vitest';
import { AREA_TYPES, defaultLabels } from '@narrative/engine';
import type { CombatAreaType, CombatGrid, CombatTile } from '../../../types';
import { tilesFrom } from '../tileAvailability';
import { RUN_PIECES, artFor, cellArt, hasArt, matchLabel, phraseIn, resolveTileset, tileHash, withoutPaths } from '../tileset';
import type { TileRef } from '../tileset';

const TODAY = tilesFrom({
    floor: ['cave-stone', 'city-cobblestone', 'deep-water', 'dungeon-flagstone', 'earth', 'earth-alt', 'forest-floor', 'grass', 'gravel', 'lava', 'sand', 'shallow-water', 'snow', 'swamp', 'wood-planks'],
    wall: ['stone-brick'],
    cover: ['crates'],
    difficult: ['rubble'],
});

function grid(patch: Partial<CombatGrid> = {}, rows: string[] = ['....', '....']): CombatGrid {
    const chars: Record<string, CombatTile> = { '.': 'floor', '#': 'wall', o: 'cover', '~': 'difficult', '!': 'hazard' };
    return { width: rows[0].length, height: rows.length, tiles: rows.join('').split('').map(ch => chars[ch]), ...patch };
}

const ref = (r: TileRef | null) => (r ? `${r.folder}/${r.name}` : null);

describe('label matching', () => {
    it('tolerates plural s and es, hyphens as spaces and case', () => {
        expect(phraseIn('Old Tombstones', 'tombstone')).toBe(true);
        expect(phraseIn('thorny bushes', 'bush')).toBe(true);
        expect(phraseIn('rows of server racks', 'server rack')).toBe(true);
        expect(phraseIn('a dense-forest edge', 'dense forest')).toBe(true);
        expect(phraseIn('barrels', 'bar')).toBe(false);
        expect(phraseIn('dusty bookshelves', 'bookshelf')).toBe(true);
        expect(phraseIn('gantries', 'gantry')).toBe(true);
    });

    it('picks the file named in the label, longest name winning', () => {
        const tiles = tilesFrom({ cover: ['tombstone', 'crates', 'server-rack', 'rack'], wall: ['forest', 'dense-forest', 'stone-brick'] });
        expect(ref(resolveTileset({ grid: grid({ labels: { cover: 'tombstones' } }), tiles }).cover)).toBe('cover/tombstone');
        expect(ref(resolveTileset({ grid: grid({ labels: { cover: 'server racks' } }), tiles }).cover)).toBe('cover/server-rack');
        expect(ref(resolveTileset({ grid: grid({ labels: { wall: 'Dense Forest' } }), tiles }).wall)).toBe('wall/dense-forest');
    });

    it('never matches an -alt file by label', () => {
        expect(matchLabel('crates alt', [{ folder: 'cover', name: 'crates-alt' }])).toBeNull();
    });

    it('lets difficult ground and hazards resolve to a liquid from floor/', () => {
        const tiles = tilesFrom({ floor: ['swamp-water', 'grass'], difficult: ['rubble'] });
        const set = resolveTileset({ grid: grid({ labels: { difficult: 'swamp water', hazard: 'swamp water' } }), tiles });
        expect(ref(set.difficult)).toBe('floor/swamp-water');
        expect(ref(set.hazard)).toBe('floor/swamp-water');
        expect(ref(resolveTileset({ grid: grid({ area: 'wetland' }), tiles: tilesFrom({ floor: ['shallow-water'] }) }).difficult)).toBe('floor/shallow-water');
    });
});

describe('floors from the place text', () => {
    const tiles = tilesFrom({ floor: ['wood-planks', 'snow', 'forest-floor', 'cave-stone', 'earth'] });

    it('uses the first keyword group that matches and exists, over the area default', () => {
        expect(ref(resolveTileset({ grid: grid({ area: 'cavern' }), tiles, place: 'The Prancing Pony tavern' }).floor)).toBe('floor/wood-planks');
        expect(ref(resolveTileset({ grid: grid({ area: 'cavern' }), tiles, place: 'a frozen lake' }).floor)).toBe('floor/snow');
        expect(ref(resolveTileset({ grid: grid(), tiles, place: 'a tavern in the forest' }).floor)).toBe('floor/wood-planks');
        expect(ref(resolveTileset({ grid: grid(), tiles, place: 'the old woods' }).floor)).toBe('floor/forest-floor');
    });

    it('skips a keyword whose file is missing', () => {
        expect(ref(resolveTileset({ grid: grid({ area: 'cavern' }), tiles, place: 'the graveyard' }).floor)).toBe('floor/cave-stone');
    });
});

describe('area defaults, generic fallback and null', () => {
    it('takes the first existing area default', () => {
        const tiles = tilesFrom({ floor: ['dungeon-flagstone', 'wood-planks'], wall: ['stone-brick'], cover: ['crates'], difficult: ['debris', 'rubble'] });
        const set = resolveTileset({ grid: grid({ area: 'rows' }), tiles });
        expect(ref(set.floor)).toBe('floor/dungeon-flagstone');
        expect(ref(set.wall)).toBe('wall/stone-brick');
        expect(ref(set.difficult)).toBe('difficult/debris');
    });

    it('falls back to the generic tile of each kind without an area', () => {
        const set = resolveTileset({ grid: grid(), tiles: TODAY });
        expect([ref(set.floor), ref(set.wall), ref(set.cover), ref(set.difficult), ref(set.hazard)])
            .toEqual(['floor/earth', 'wall/stone-brick', 'cover/crates', 'difficult/rubble', null]);
    });

    it('resolves every kind to null with no files', () => {
        const set = resolveTileset({ grid: grid({ area: 'room', hazardType: 'fire' }), tiles: tilesFrom({}) });
        expect(Object.values(set).every(v => v === null)).toBe(true);
        expect(hasArt(set)).toBe(false);
        expect(cellArt(set, tilesFrom({}), grid(), 0, 0, 1)).toEqual({ flat: true });
    });
});

describe('hazards', () => {
    const tiles = tilesFrom({ floor: ['lava', 'acid-pool', 'deep-water'], hazard: ['gas-cloud', 'burning-debris', 'pit'] });
    const hazard = (hazardType: string | undefined, label?: string) =>
        ref(resolveTileset({ grid: grid({ hazardType, labels: label ? { hazard: label } : {} }), tiles }).hazard);

    it('follows the hazard table by type', () => {
        expect(hazard('fire')).toBe('hazard/burning-debris');
        expect(ref(resolveTileset({ grid: grid({ hazardType: 'fire' }), tiles: tilesFrom({ floor: ['lava'] }) }).hazard)).toBe('floor/lava');
        expect(hazard('deep_water')).toBe('floor/deep-water');
        expect(hazard('toxic')).toBe('floor/acid-pool');
        expect(hazard('pit')).toBe('hazard/pit');
        expect(hazard('electric')).toBeNull();
        expect(hazard(undefined)).toBeNull();
    });

    it('tries the hazard label first', () => {
        expect(hazard('fire', 'drifting gas clouds')).toBe('hazard/gas-cloud');
    });
});

describe('variety', () => {
    const wide = grid({ area: 'open' }, Array.from({ length: 12 }, () => '.'.repeat(12)));
    const tiles = tilesFrom({ floor: ['grass', 'grass-alt'], cover: ['crates'] });

    it('uses an -alt floor on about a third of tiles, the same every time', () => {
        const set = resolveTileset({ grid: wide, tiles });
        const paths = (seed: number) => wide.tiles.map((_, i) => {
            const cell = cellArt(set, tiles, wide, i % 12, Math.floor(i / 12), seed);
            return cell.flat ? null : cell.base?.path;
        });
        const first = paths(7);
        expect(paths(7)).toEqual(first);
        expect(paths(8)).not.toEqual(first);
        const alt = first.filter(p => p === 'floor/grass-alt').length / first.length;
        expect(alt).toBeGreaterThan(0.2);
        expect(alt).toBeLessThan(0.47);
        for (let i = 0; i < wide.tiles.length; i++) {
            const art = artFor({ folder: 'floor', name: 'grass' }, tiles, i % 12, Math.floor(i / 12), 7);
            expect(art.mirror).toBe(false);
        }
    });

    it('mirrors cover objects on about half the tiles and keeps hashes stable', () => {
        let mirrored = 0;
        for (let i = 0; i < 144; i++) if (artFor({ folder: 'cover', name: 'crates' }, tiles, i % 12, Math.floor(i / 12), 3).mirror) mirrored++;
        expect(mirrored / 144).toBeGreaterThan(0.3);
        expect(mirrored / 144).toBeLessThan(0.7);
        expect(tileHash(3, 4, 5, 1)).toBe(tileHash(3, 4, 5, 1));
    });

    it('draws run pieces as they are, never mirrored or rotated, in horizontal and vertical runs', () => {
        const g = grid({}, ['.o..', '.o..', '...o', '.ooo']);
        const t = tilesFrom({ cover: [...RUN_PIECES] });
        const set = resolveTileset({ grid: { ...g, labels: { cover: 'bookshelves' } }, tiles: t });
        expect(set.cover).toEqual({ folder: 'cover', name: 'bookshelf' });
        for (const name of RUN_PIECES) {
            for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
                const art = artFor({ folder: 'cover', name }, t, x, y, 9);
                expect(art).toEqual({ path: `cover/${name}`, opaque: false, mirror: false });
                expect(Object.keys(art)).not.toContain('rotate');
            }
        }
    });
});

describe('cell layering', () => {
    const g = grid({ area: 'open', hazardType: 'fire' }, ['.#o~!']);
    const set = resolveTileset({ grid: g, tiles: TODAY });

    it('draws walls as their own opaque image and puts the rest over the floor', () => {
        expect(cellArt(set, TODAY, g, 1, 0, 1)).toEqual({ flat: false, base: expect.objectContaining({ path: 'wall/stone-brick', opaque: true }), top: null });
        expect(cellArt(set, TODAY, g, 2, 0, 1)).toMatchObject({ flat: false, base: { path: 'floor/grass' }, top: { path: 'cover/crates', opaque: false } });
        expect(cellArt(set, TODAY, g, 4, 0, 1)).toMatchObject({ flat: false, top: { path: 'floor/lava', opaque: true } });
    });

    it('drops failed files so the next candidate or flat colour takes over', () => {
        const left = withoutPaths(TODAY, new Set(['floor/grass', 'cover/crates']));
        const next = resolveTileset({ grid: g, tiles: left });
        expect(ref(next.floor)).toBe('floor/sand');
        expect(next.cover).toBeNull();
        expect(cellArt(next, left, g, 2, 0, 1)).toEqual({ flat: true });
    });
});

const NOW = tilesFrom({
    floor: ['cave-stone', 'city-cobblestone', 'deep-water', 'dirt-road', 'dungeon-flagstone', 'earth', 'earth-alt', 'forest-floor', 'grass', 'gravel', 'graveyard-soil', 'lava', 'marble', 'sand', 'scorched-earth', 'shallow-water', 'snow', 'stone-rampart', 'swamp', 'swamp-water', 'wood-planks'],
    wall: ['building-roof', 'cave-rock', 'dense-forest', 'ruined-wall', 'sheer-drop', 'stone-brick', 'wooden-wall'],
    cover: ['bar-counter', 'barrels', 'bookshelf', 'boulder', 'bush', 'campfire-logs', 'cart', 'crates', 'dead-tree', 'fallen-pillar', 'fallen-stones', 'fence', 'low-wall', 'market-stall', 'merlon', 'pillar', 'rocks', 'stalagmite', 'statue', 'table', 'table-overturned', 'tent', 'tomb', 'tombstone', 'tree'],
    difficult: ['debris', 'mud', 'roots', 'rubble', 'scree', 'undergrowth'],
    hazard: ['burning-debris', 'flames', 'pit', 'spikes'],
});

describe('the 63-file art batch', () => {
    const expected: Record<CombatAreaType, [string, string, string, string]> = {
        open: ['floor/grass', 'wall/stone-brick', 'cover/crates', 'difficult/rubble'],
        scattered: ['floor/forest-floor', 'wall/dense-forest', 'cover/tree', 'difficult/undergrowth'],
        room: ['floor/wood-planks', 'wall/wooden-wall', 'cover/table', 'difficult/debris'],
        rows: ['floor/dungeon-flagstone', 'wall/stone-brick', 'cover/crates', 'difficult/debris'],
        corridors: ['floor/dungeon-flagstone', 'wall/stone-brick', 'cover/crates', 'difficult/debris'],
        cavern: ['floor/cave-stone', 'wall/cave-rock', 'cover/boulder', 'difficult/rubble'],
        street: ['floor/city-cobblestone', 'wall/building-roof', 'cover/crates', 'difficult/debris'],
        ledge: ['floor/gravel', 'wall/sheer-drop', 'cover/rocks', 'difficult/scree'],
        ruins: ['floor/dungeon-flagstone', 'wall/ruined-wall', 'cover/fallen-stones', 'difficult/rubble'],
        wetland: ['floor/swamp', 'wall/cave-rock', 'cover/dead-tree', 'floor/swamp-water'],
    };

    it('resolves every kind of every area type with its default labels', () => {
        for (const area of AREA_TYPES) {
            const set = resolveTileset({ grid: grid({ area, labels: defaultLabels(area) }), tiles: NOW });
            expect([ref(set.floor), ref(set.wall), ref(set.cover), ref(set.difficult)]).toEqual(expected[area]);
        }
    });

    it('resolves fire, deep water and pit hazards and leaves electric and toxic flat', () => {
        const hazard = (h: 'fire' | 'deep_water' | 'electric' | 'toxic' | 'pit') =>
            ref(resolveTileset({ grid: grid({ area: 'open', hazardType: h, labels: defaultLabels('open', h) }), tiles: NOW }).hazard);
        expect([hazard('fire'), hazard('deep_water'), hazard('electric'), hazard('toxic'), hazard('pit')])
            .toEqual(['hazard/flames', 'floor/deep-water', null, null, 'hazard/pit']);
    });

    it('also gave every area type a floor image with the first 18 files', () => {
        for (const area of AREA_TYPES) {
            expect(resolveTileset({ grid: grid({ area, labels: defaultLabels(area) }), tiles: TODAY }).floor).not.toBeNull();
        }
    });
});
