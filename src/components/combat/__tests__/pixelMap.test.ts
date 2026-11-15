import { describe, it, expect } from 'vitest';
import type { CombatAreaType, CombatGrid, CombatTile } from '../../../types';
import { buildPixelCatalog } from '../pixelCatalog';
import type { PixelFolder } from '../pixelCatalog';
import {
    PIXEL_ALIASES, buildPixelPlan, choosePixelFloor, depthOrder, fadedProps, packProps, pickNames, pixelBoardSize, snapTileSize,
} from '../pixelMap';
import type { PlacedProp } from '../pixelMap';

const CHAR: Record<string, CombatTile> = { '.': 'floor', o: 'cover', '#': 'wall', '~': 'difficult', '!': 'hazard' };

function gridOf(rows: string[], extra: Partial<CombatGrid> = {}): CombatGrid {
    return { width: rows[0].length, height: rows.length, tiles: rows.join('').split('').map(ch => CHAR[ch]), area: 'open', ...extra };
}

function open(width: number, height: number, ch = '.'): string[] {
    return Array.from({ length: height }, () => ch.repeat(width));
}

function catalog(lists: Partial<Record<PixelFolder, string[]>>) {
    return buildPixelCatalog(lists);
}

const GRASS = ['grass-a', 'grass-b', 'grass-c'];

function plan(grid: CombatGrid, lists: Partial<Record<PixelFolder, string[]>>, extra: { seed?: number; place?: string; style?: 'auto' | 'painted'; occupied?: Set<string> } = {}) {
    return buildPixelPlan({ grid, catalog: catalog(lists), seed: extra.seed ?? 7, style: extra.style ?? 'auto', place: extra.place, occupied: extra.occupied });
}

describe('choosing the style for a map', () => {
    it('auto uses pixel when a pixel floor exists for the map', () => {
        const result = plan(gridOf(open(4, 3)), { floor: GRASS });
        expect(result?.floor).toBe('grass');
    });

    it('auto falls back to painted when the map has no pixel floor', () => {
        expect(plan(gridOf(open(4, 3)), { floor: ['wood-planks-a'] })).toBeNull();
        expect(plan(gridOf(open(4, 3)), {})).toBeNull();
        expect(plan(gridOf(open(4, 3), { area: undefined }), { floor: GRASS })).toBeNull();
    });

    it('forced painted never uses pixel', () => {
        expect(plan(gridOf(open(4, 3)), { floor: GRASS }, { style: 'painted' })).toBeNull();
    });

    it('the place text picks the floor through the same keyword table as the painted tiles', () => {
        const lists = { floor: ['grass-a', 'wood-planks-a', 'wood-planks-b'] };
        expect(plan(gridOf(open(3, 3)), lists, { place: 'the old tavern' })?.floor).toBe('wood-planks');
        expect(plan(gridOf(open(3, 3)), lists, { place: 'a forest clearing' })?.floor).toBe('grass');
    });

    it('maps a painted name to the pixel name through the alias table, in one place', () => {
        expect(PIXEL_ALIASES.earth).toEqual(['dirt-path']);
        const forest = buildPixelCatalog({ floor: ['dirt-path-a'] });
        expect(choosePixelFloor(forest, undefined, 'open')).toBe('dirt-path');
        expect(choosePixelFloor(forest, 'a muddy track', 'open')).toBe('dirt-path');
        expect(choosePixelFloor(forest, undefined, 'room')).toBeNull();
    });

    it('never mixes painted and pixel floors: every tile is a pixel floor, a pixel fill or a marker', () => {
        const rows = ['..#..', '.o.~.', '..!..', '#...#'];
        const result = plan(gridOf(rows), { floor: GRASS, wall: ['cliff'] }) as NonNullable<ReturnType<typeof plan>>;
        for (let i = 0; i < rows.join('').length; i++) {
            const paths = [result.floorPaths[i], result.fillPaths[i]].filter(Boolean) as string[];
            expect(paths).toHaveLength(1);
            expect(paths[0]).toMatch(/^(floor\/grass-[abc]|wall\/cliff)$/);
        }
    });

    it('draws a plain marker for a kind that has no pixel art', () => {
        const result = plan(gridOf(['.o#', '~!.']), { floor: GRASS }) as NonNullable<ReturnType<typeof plan>>;
        expect(result.markers).toEqual([null, 'cover', 'wall', 'difficult', 'hazard', null]);
        expect(result.overlayPaths.every(p => p === null)).toBe(true);
        expect(result.props).toEqual([]);
    });

    it('uses difficult and hazard art by label, area default and hazard type', () => {
        const grid = gridOf(['.~!'], { labels: { difficult: 'deep mud', hazard: 'a campfire' }, hazardType: 'fire' });
        const result = plan(grid, { floor: GRASS, difficult: ['mud', 'rubble'], hazard: ['campfire', 'flames'] }) as NonNullable<ReturnType<typeof plan>>;
        expect(result.overlayPaths[1]).toBe('difficult/mud');
        expect(result.overlayPaths[2]).toBe('hazard/campfire');
        const unlabelled = gridOf(['.~!'], { hazardType: 'fire' });
        const second = plan(unlabelled, { floor: GRASS, difficult: ['mud', 'rubble'], hazard: ['campfire', 'flames'] }) as NonNullable<ReturnType<typeof plan>>;
        expect(second.overlayPaths[1]).toBe('difficult/rubble');
        expect(second.overlayPaths[2]).toBe('hazard/flames');
        expect(second.markers).toEqual([null, null, null]);
    });
});

describe('name matching for props', () => {
    const pool = ['bush', 'server-rack', 'tree-pine', 'tree-oak', 'rock-large'];

    it('matches a label phrase, with plurals', () => {
        expect(pickNames(pool, 'bushes', [])).toEqual(['bush']);
        expect(pickNames(pool, 'server racks', [])).toEqual(['server-rack']);
    });

    it('falls back to any word of the name, then to the area default through the alias table', () => {
        expect(pickNames(pool, 'pine trees', [])).toEqual(['tree-pine', 'tree-oak']);
        expect(pickNames(pool, undefined, ['tree'])).toEqual(['tree-pine', 'tree-oak']);
        expect(pickNames(pool, 'something odd', ['crates', 'tree'])).toEqual(['tree-pine', 'tree-oak']);
        expect(pickNames(pool, undefined, ['crates'])).toEqual([]);
    });

    it('a forest map uses trees and rocks, not server racks', () => {
        const grid = gridOf(open(6, 6, '#'), { area: 'scattered' });
        const result = plan(grid, { floor: GRASS, wall: ['tree-pine@1x1+1', 'server-rack@1x1', 'rock-large@2x2'] }) as NonNullable<ReturnType<typeof plan>>;
        expect(result.props.length).toBeGreaterThan(0);
        expect(result.props.some(p => p.name === 'server-rack')).toBe(false);
    });
});

describe('floor variants and decals', () => {
    it('picks a variant per tile that is stable for a seed and different across tiles', () => {
        const grid = gridOf(open(12, 12));
        const a = plan(grid, { floor: GRASS }) as NonNullable<ReturnType<typeof plan>>;
        const b = plan(grid, { floor: GRASS }) as NonNullable<ReturnType<typeof plan>>;
        expect(a.floorPaths).toEqual(b.floorPaths);
        expect(new Set(a.floorPaths).size).toBe(3);
        const other = plan(grid, { floor: GRASS }, { seed: 8 }) as NonNullable<ReturnType<typeof plan>>;
        expect(other.floorPaths).not.toEqual(a.floorPaths);
    });

    it('places a decal on about one floor tile in eight, stable for a seed', () => {
        const grid = gridOf(open(30, 30));
        const a = plan(grid, { floor: GRASS, decal: ['pebbles'] }) as NonNullable<ReturnType<typeof plan>>;
        const b = plan(grid, { floor: GRASS, decal: ['pebbles'] }) as NonNullable<ReturnType<typeof plan>>;
        const count = a.decalPaths.filter(Boolean).length;
        expect(count).toBeGreaterThan(900 * 0.08);
        expect(count).toBeLessThan(900 * 0.18);
        expect(a.decalPaths).toEqual(b.decalPaths);
        const other = plan(grid, { floor: GRASS, decal: ['pebbles'] }, { seed: 99 }) as NonNullable<ReturnType<typeof plan>>;
        expect(other.decalPaths).not.toEqual(a.decalPaths);
    });

    it('never puts a decal on an occupied tile, an overlay, a prop or next to a hazard', () => {
        const rows = open(30, 30);
        rows[10] = `${'.'.repeat(10)}!${'.'.repeat(19)}`;
        rows[20] = `${'.'.repeat(5)}o~#${'.'.repeat(22)}`;
        const grid = gridOf(rows);
        const everything = new Set<string>();
        for (let y = 0; y < 30; y++) for (let x = 0; x < 30; x++) if ((x + y) % 2 === 0) everything.add(`${x},${y}`);
        const result = plan(grid, { floor: GRASS, decal: ['pebbles'] }, { occupied: everything }) as NonNullable<ReturnType<typeof plan>>;
        const free = plan(grid, { floor: GRASS, decal: ['pebbles'] }) as NonNullable<ReturnType<typeof plan>>;
        expect(free.decalPaths.filter(Boolean).length).toBeGreaterThan(result.decalPaths.filter(Boolean).length);
        result.decalPaths.forEach((path, i) => {
            if (!path) return;
            const x = i % 30;
            const y = Math.floor(i / 30);
            expect(everything.has(`${x},${y}`)).toBe(false);
            expect(grid.tiles[i]).toBe('floor');
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx >= 0 && ny >= 0 && nx < 30 && ny < 30) expect(grid.tiles[ny * 30 + nx]).not.toBe('hazard');
            }
        });
        free.decalPaths.forEach((path, i) => {
            if (path) expect(grid.tiles[i]).toBe('floor');
        });
    });

    it('keeps flowers off a dungeon floor and shows decals that name no floor anywhere', () => {
        const grid = gridOf(open(30, 30), { area: 'corridors' });
        const result = plan(grid, { floor: ['dungeon-flagstone-a'], decal: ['flowers-yellow'] }) as NonNullable<ReturnType<typeof plan>>;
        expect(result.decalPaths.filter(Boolean)).toHaveLength(0);
        const any = plan(grid, { floor: ['dungeon-flagstone-a'], decal: ['pebbles'] }) as NonNullable<ReturnType<typeof plan>>;
        expect(any.decalPaths.filter(Boolean).length).toBeGreaterThan(0);
    });
});

function footprints(placed: readonly PlacedProp[]): string[] {
    return placed.flatMap(p => Array.from({ length: p.w * p.h }, (_, i) => `${p.x + (i % p.w)},${p.y + Math.floor(i / p.w)}`));
}

describe('packing props', () => {
    const big = { name: 'boulder', file: 'boulder@2x2', w: 2, h: 2, up: 0 };
    const small = { name: 'rock', file: 'rock@1x1', w: 1, h: 1, up: 0 };
    const tall = { name: 'pine', file: 'pine@1x1+1', w: 1, h: 1, up: 1 };

    it('covers every tile of the kind exactly once when a 1x1 prop is available', () => {
        const grid = gridOf(['#####', '##.##', '#####', '..###']);
        const { placed, covered } = packProps(grid, 'wall', [big, small], 3);
        const tiles = footprints(placed);
        expect(new Set(tiles).size).toBe(tiles.length);
        const walls = grid.tiles.filter(t => t === 'wall').length;
        expect(tiles).toHaveLength(walls);
        expect(covered.filter(Boolean)).toHaveLength(walls);
    });

    it('uses the largest footprint first', () => {
        const block = packProps(gridOf(['##', '##']), 'wall', [small, big], 5).placed;
        expect(block.map(p => p.name)).toEqual(['boulder']);
        const grid = gridOf(open(6, 6, '#'));
        const { placed } = packProps(grid, 'wall', [small, big], 5);
        expect(placed.filter(p => p.name === 'boulder').length).toBeGreaterThanOrEqual(6);
        const rocks = new Set(footprints(placed.filter(p => p.name === 'rock')));
        for (let y = 0; y < 5; y++) {
            for (let x = 0; x < 5; x++) {
                expect([`${x},${y}`, `${x + 1},${y}`, `${x},${y + 1}`, `${x + 1},${y + 1}`].every(k => rocks.has(k))).toBe(false);
            }
        }
    });

    it('never lets a footprint cross kinds or leave the board', () => {
        const grid = gridOf(['##o#', '##o#', 'oo##']);
        const wide = { name: 'wide', file: 'wide@2x2', w: 2, h: 2, up: 0 };
        const { placed } = packProps(grid, 'wall', [wide], 2);
        for (const p of placed) {
            for (let dy = 0; dy < p.h; dy++) for (let dx = 0; dx < p.w; dx++) expect(grid.tiles[(p.y + dy) * 4 + p.x + dx]).toBe('wall');
        }
        expect(placed).toHaveLength(1);
        const none = packProps(gridOf(['#.', '.#']), 'wall', [wide], 2);
        expect(none.placed).toEqual([]);
    });

    it('is deterministic for a seed and varies with it', () => {
        const grid = gridOf(open(8, 8, '#'));
        const props = [big, small, tall];
        const a = packProps(grid, 'wall', props, 11).placed;
        const b = packProps(grid, 'wall', props, 11).placed;
        expect(a).toEqual(b);
        const c = packProps(grid, 'wall', props, 12).placed;
        expect(c).not.toEqual(a);
    });

    it('lets a tall sprite stand on the top row, drawn clipped by the board', () => {
        const grid = gridOf(['###', '###']);
        const { placed } = packProps(grid, 'wall', [tall], 1);
        expect(placed.filter(p => p.y === 0)).toHaveLength(3);
        expect(placed).toHaveLength(6);
    });

    it('leaves what no prop fits to the fill, or to a marker with no fill', () => {
        const grid = gridOf(['##', '#.'], { labels: { wall: 'wide cliff' } });
        const noFill = plan(grid, { floor: GRASS, wall: ['wide@2x2'] }) as NonNullable<ReturnType<typeof plan>>;
        expect(noFill.props).toEqual([]);
        expect(noFill.markers.filter(Boolean)).toHaveLength(3);
        const filled = plan(grid, { floor: GRASS, wall: ['cliff', 'wide@2x2'] }) as NonNullable<ReturnType<typeof plan>>;
        expect(filled.props).toEqual([]);
        expect(filled.fillPaths.filter(Boolean)).toEqual(['wall/cliff', 'wall/cliff', 'wall/cliff']);
        expect(filled.markers.filter(Boolean)).toHaveLength(0);
    });

    it('every wall and cover tile is covered exactly once in a built plan', () => {
        const rows = ['####o..', '#..#oo.', '#####..', '...~..#'];
        const grid = gridOf(rows, { area: 'scattered', labels: { cover: 'bushes', wall: 'big trees' } });
        const result = plan(grid, { floor: GRASS, cover: ['bush@1x1', 'log@2x1'], wall: ['tree-oak@2x2+1', 'tree-pine@1x1+1', 'cliff'] }) as NonNullable<ReturnType<typeof plan>>;
        const covered = footprints(result.props);
        expect(new Set(covered).size).toBe(covered.length);
        grid.tiles.forEach((tile, i) => {
            const key = `${i % 7},${Math.floor(i / 7)}`;
            const byProp = covered.includes(key) ? 1 : 0;
            const byFill = result.fillPaths[i] ? 1 : 0;
            const byMarker = result.markers[i] === 'wall' || result.markers[i] === 'cover' ? 1 : 0;
            if (tile === 'wall' || tile === 'cover') expect(byProp + byFill + byMarker).toBe(1);
            else expect(byProp + byFill + byMarker).toBe(0);
        });
    });

    it('uses only the props eligible for the map', () => {
        const grid = gridOf(open(6, 3, 'o'), { labels: { cover: 'bushes' } });
        const result = plan(grid, { floor: GRASS, cover: ['bush@1x1', 'server-rack@1x1', 'desk@2x1'] }) as NonNullable<ReturnType<typeof plan>>;
        expect(result.props.length).toBeGreaterThan(0);
        expect(new Set(result.props.map(p => p.name))).toEqual(new Set(['bush']));
    });
});

describe('draw order and fading', () => {
    const prop = (id: string, x: number, y: number, w: number, h: number, up: number): PlacedProp => ({ id, kind: 'wall', name: id, path: `wall/${id}`, x, y, w, h, up, mirror: false });

    it('sorts rows top to bottom with tokens mixed in, and a prop before a token on its own row', () => {
        const props = [prop('tree', 2, 3, 2, 2, 1), prop('rock', 0, 1, 1, 1, 0)];
        const order = depthOrder(props, [{ id: 'low', y: 5 }, { id: 'same', y: 4 }, { id: 'top', y: 0 }]);
        expect(order.map(i => (i.type === 'prop' ? i.prop.id : i.id))).toEqual(['top', 'rock', 'tree', 'same', 'low']);
    });

    it('fades a prop whose raised part or upper footprint covers a token or the hovered tile', () => {
        const props = [prop('pine', 2, 3, 1, 1, 1), prop('house', 5, 4, 3, 2, 1)];
        expect([...fadedProps(props, [{ x: 2, y: 2 }])]).toEqual(['pine']);
        expect([...fadedProps(props, [{ x: 2, y: 3 }])]).toEqual([]);
        expect([...fadedProps(props, [{ x: 6, y: 3 }])]).toEqual(['house']);
        expect([...fadedProps(props, [{ x: 6, y: 4 }])]).toEqual(['house']);
        expect([...fadedProps(props, [{ x: 6, y: 5 }])]).toEqual([]);
        expect([...fadedProps(props, [{ x: 0, y: 0 }, { x: 3, y: 2 }])]).toEqual([]);
    });
});

describe('whole-number scale', () => {
    it('snaps the tile size to a multiple of 32, then 16, and never up', () => {
        expect(snapTileSize(100)).toBe(96);
        expect(snapTileSize(64)).toBe(64);
        expect(snapTileSize(200)).toBe(192);
        expect(snapTileSize(31.9)).toBe(16);
        expect(snapTileSize(16)).toBe(16);
        expect(snapTileSize(12.5)).toBe(12.5);
    });

    it('sizes the board from the space, fitting both directions', () => {
        expect(pixelBoardSize(6, 4, 700, 500)).toEqual({ tile: 96, width: 576, height: 384 });
        expect(pixelBoardSize(6, 4, 700, 200)).toEqual({ tile: 32, width: 192, height: 128 });
        expect(pixelBoardSize(6, 4, 0, 200)).toBeNull();
    });
});

describe('area defaults are reused for the pixel mapping', () => {
    it.each<CombatAreaType>(['open', 'scattered', 'room', 'rows', 'corridors', 'cavern', 'street', 'ledge', 'ruins', 'wetland'])('%s resolves to a plan or to painted, never throws', area => {
        const grid = gridOf(['.o#', '~!.'], { area });
        expect(() => plan(grid, { floor: ['grass-a', 'dirt-path-a', 'dungeon-flagstone-a', 'cave-stone-a'], wall: ['cliff'] })).not.toThrow();
    });
});
