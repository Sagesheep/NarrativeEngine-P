import { Canvas, chance, clamp, pickOne, shapeAt } from './canvas';
import type { AreaLayout, ShapeName } from './canvas';
import { fillTo, runArea } from './bands';
import type { AreaDefinition } from './bands';
import type { MapDensity, Pos, Rng } from '../types';

function pickShape(rng: Rng): ShapeName {
    const roll = rng.next();
    if (roll < 0.35) return 'single';
    if (roll < 0.6) return 'hbar';
    if (roll < 0.85) return 'vbar';
    if (roll < 0.95) return 'ell';
    return 'square';
}

export function placeIsolated(c: Canvas, rng: Rng, shape: ShapeName, tile: 'cover' | 'wall', ring: number, filter?: (p: Pos) => boolean): boolean {
    const options: Pos[][] = [];
    for (const origin of c.floorCells(filter)) {
        const cells = shapeAt(origin, shape, rng);
        if (cells.every(p => c.free(p.x, p.y)) && c.clearAround(cells, ring)) options.push(cells);
    }
    if (options.length === 0) return false;
    const anchors = c.spreadSpots(options.map(o => o[0]), rng, 3);
    const anchor = pickOne(anchors, rng);
    const chosen = options.find(o => anchor && o[0].x === anchor.x && o[0].y === anchor.y) ?? options[0];
    return c.tryPlace(chosen, tile, 'optional');
}

export function difficultPatch(c: Canvas, rng: Rng, size: number, filter?: (p: Pos) => boolean): boolean {
    const seeds = c.floorCells(p => (!filter || filter(p)) && c.clearAround([p], 1));
    const start = pickOne(c.spreadSpots(seeds, rng, 4), rng);
    if (!start) return false;
    const cells = c.blob(start, size, rng, p => c.free(p.x, p.y) && (!filter || filter(p)));
    return c.tryPlace(cells, 'difficult', 'optional', false);
}

function extra(c: Canvas, rng: Rng): boolean {
    if (placeIsolated(c, rng, pickShape(rng), 'cover', 1)) return true;
    return placeIsolated(c, rng, 'single', 'cover', 1);
}

export const OPEN_AREA: AreaDefinition = {
    build(c, target, rng) {
        const patches = target >= 10 || chance(rng, 0.4) ? 2 : 1;
        const size = clamp(Math.round(target * 0.22), 2, 6);
        for (let i = 0; i < patches; i++) difficultPatch(c, rng, size + rng.int(-1, 1));
        fillTo(c, target, [0, c.height - 1], rng, extra);
    },
    extra,
};

export function generateOpen(width: number, height: number, density: MapDensity, rng: Rng): AreaLayout {
    return runArea('open', OPEN_AREA, width, height, density, rng);
}
