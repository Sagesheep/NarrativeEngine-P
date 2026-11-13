import { Canvas, chance, clamp } from './canvas';
import type { AreaLayout, ShapeName } from './canvas';
import { fillTo, runArea } from './bands';
import type { AreaDefinition } from './bands';
import { placeIsolated } from './open';
import type { MapDensity, Pos, Rng } from '../types';

function tableShape(rng: Rng, wide: boolean): { shape: ShapeName; tile: 'cover' | 'wall' } {
    const roll = rng.next();
    if (wide && roll < 0.15) return { shape: 'single', tile: 'wall' };
    if (roll < 0.4) return { shape: 'square', tile: 'cover' };
    if (roll < 0.7) return { shape: 'hbar', tile: 'cover' };
    if (roll < 0.85) return { shape: 'vbar', tile: 'cover' };
    return { shape: 'single', tile: 'cover' };
}

function interior(c: Canvas): (p: Pos) => boolean {
    return p => p.y >= 1 && p.y <= c.height - 2;
}

function extra(c: Canvas, rng: Rng): boolean {
    const { shape, tile } = tableShape(rng, c.innerWidth >= 10);
    if (placeIsolated(c, rng, shape, tile, 1, interior(c))) return true;
    return placeIsolated(c, rng, 'single', 'cover', 1, interior(c));
}

export const ROOM_AREA: AreaDefinition = {
    build(c, target, rng) {
        const north = chance(rng, 0.5);
        for (const y of north ? [0, c.height - 1] : [c.height - 1, 0]) {
            const row: Pos[] = [];
            for (let x = c.x0; x <= c.x1; x++) row.push({ x, y });
            c.place(row, 'wall', 'structural');
        }
        const barRow = north ? 2 : c.height - 3;
        const barLen = clamp(Math.round(target * 0.45), 3, Math.min(7, c.innerWidth - 1));
        const slack = c.innerWidth - barLen;
        const offset = slack >= 2 ? rng.int(1, slack - 1) : rng.int(0, slack);
        const bar: Pos[] = [];
        for (let i = 0; i < barLen; i++) bar.push({ x: c.x0 + offset + i, y: barRow });
        c.tryPlace(bar, 'cover', 'structural');
        const tableZone = (p: Pos) => (north ? p.y >= barRow + 2 && p.y <= c.height - 2 : p.y <= barRow - 2 && p.y >= 1);
        const wide = c.innerWidth >= 10;
        for (let i = 0; i < 40 && c.count([1, c.height - 2]) < target; i++) {
            const { shape, tile } = tableShape(rng, wide);
            if (!placeIsolated(c, rng, shape, tile, 1, tableZone)) placeIsolated(c, rng, 'single', 'cover', 1, tableZone);
        }
        fillTo(c, target, [1, c.height - 2], rng, extra);
    },
    extra,
};

export function generateRoom(width: number, height: number, density: MapDensity, rng: Rng): AreaLayout {
    return runArea('room', ROOM_AREA, width, height, density, rng);
}
