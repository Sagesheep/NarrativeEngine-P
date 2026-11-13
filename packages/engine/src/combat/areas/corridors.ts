import { Canvas, chance, clamp, pickOne, rectCells, shuffle } from './canvas';
import type { AreaLayout, Rect } from './canvas';
import { fillTo, runArea, structuralTarget } from './bands';
import type { AreaDefinition } from './bands';
import type { MapDensity, Pos, Rng } from '../types';

function carve(c: Canvas, r: Rect): void {
    for (const p of rectCells(r)) if (c.inner(p.x, p.y)) c.tiles[c.index(p.x, p.y)] = 'floor';
}

function ringIsSolid(c: Canvas, r: Rect): boolean {
    for (let y = r.y - 1; y <= r.y + r.h; y++) {
        for (let x = r.x - 1; x <= r.x + r.w; x++) {
            if (!c.inside(x, y)) continue;
            if (!c.inner(x, y)) return false;
            if (c.get(x, y) !== 'wall') return false;
        }
    }
    return true;
}

function sideRoom(c: Canvas, rng: Rng): boolean {
    const w = rng.int(3, 4);
    const h = rng.int(2, 3);
    const options: Array<{ room: Rect; door: Pos }> = [];
    for (let y = 0; y + h <= c.height; y++) {
        for (let x = c.x0 + 1; x + w <= c.x1; x++) {
            const room = { x, y, w, h };
            if (!ringIsSolid(c, room)) continue;
            const doors: Array<[Pos, Pos]> = [];
            for (let i = 0; i < w; i++) {
                doors.push([{ x: x + i, y: y - 1 }, { x: x + i, y: y - 2 }], [{ x: x + i, y: y + h }, { x: x + i, y: y + h + 1 }]);
            }
            for (let j = 0; j < h; j++) {
                doors.push([{ x: x - 1, y: y + j }, { x: x - 2, y: y + j }], [{ x: x + w, y: y + j }, { x: x + w + 1, y: y + j }]);
            }
            for (const [door, out] of doors) {
                if (c.inside(door.x, door.y) && c.inside(out.x, out.y) && c.get(out.x, out.y) !== 'wall') options.push({ room, door });
            }
        }
    }
    const chosen = pickOne(options, rng);
    if (!chosen) return false;
    carve(c, chosen.room);
    carve(c, { x: chosen.door.x, y: chosen.door.y, w: 1, h: 1 });
    return true;
}

function nook(c: Canvas, p: Pos): boolean {
    let walls = 0;
    for (const d of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]) {
        if (c.get(p.x + d.x, p.y + d.y) === 'wall' && c.inner(p.x + d.x, p.y + d.y)) walls++;
    }
    return walls === 2 && c.neighbourCount(p.x, p.y, 'wall', false) >= 3;
}

function crate(c: Canvas, rng: Rng): boolean {
    const spots = shuffle(c.floorCells(p => p.x > c.x0 && p.x < c.x1 && nook(c, p) && c.neighbourCount(p.x, p.y, 'cover', false) === 0), rng);
    for (const spot of spots.slice(0, 6)) if (c.tryPlace([spot], 'cover', 'optional')) return true;
    return false;
}

function debris(c: Canvas, rng: Rng): boolean {
    const seeds = c.floorCells(p => c.neighbourCount(p.x, p.y, 'wall', false) >= 2 && c.neighbourCount(p.x, p.y, 'difficult', false) === 0);
    const start = pickOne(seeds, rng);
    if (!start) return false;
    return c.tryPlace(c.blob(start, rng.int(1, 3), rng, p => c.free(p.x, p.y)), 'difficult', 'optional', false);
}

function extra(c: Canvas, rng: Rng): boolean {
    if (chance(rng, 0.55) && crate(c, rng)) return true;
    return debris(c, rng);
}

export const CORRIDORS_AREA: AreaDefinition = {
    build(c, target, rng) {
        for (const p of rectCells({ x: c.x0, y: 0, w: c.innerWidth, h: c.height })) c.tiles[c.index(p.x, p.y)] = 'wall';
        const cells = c.innerWidth * c.height;
        const goal = structuralTarget(cells, rng);
        const mainW = c.height >= 14 ? 3 : c.height >= 10 ? rng.int(2, 3) : 2;
        const mainY = clamp(Math.floor(c.height / 2) - Math.floor(mainW / 2) + rng.int(-1, 1), 1, c.height - 1 - mainW);
        const jogX = c.x0 + rng.int(2, Math.max(2, c.innerWidth - 3));
        const jog = chance(rng, 0.5) ? clamp(mainY + (chance(rng, 0.5) ? 1 : -1), 1, c.height - 1 - mainW) - mainY : 0;
        carve(c, { x: c.x0, y: mainY, w: jogX - c.x0, h: mainW });
        carve(c, { x: jogX, y: mainY + jog, w: c.x1 - jogX + 1, h: mainW });
        if (jog !== 0) carve(c, { x: jogX - 1, y: Math.min(mainY, mainY + jog), w: 2, h: mainW + 1 });
        const crossings = c.innerWidth >= 10 ? 2 : 1;
        const crossXs: number[] = [];
        for (let k = 0; k < crossings; k++) {
            const x = clamp(c.x0 + Math.round(((k + 1) * c.innerWidth) / (crossings + 1)) - 1 + rng.int(-1, 1), c.x0 + 1, c.x1 - 2);
            crossXs.push(x);
            const full = k === 0 || chance(rng, 0.5);
            const up = chance(rng, 0.5);
            if (full) carve(c, { x, y: 0, w: 2, h: c.height });
            else if (up) carve(c, { x, y: 0, w: 2, h: mainY + 1 });
            else carve(c, { x, y: mainY, w: 2, h: c.height - mainY });
        }
        const hub = pickOne(crossXs, rng) as number;
        const junction = { x: hub - 1, y: mainY - 1, w: 4, h: mainW + 2 };
        carve(c, junction);
        if (c.height >= 14) {
            const top = chance(rng, 0.5);
            carve(c, { x: c.x0, y: top ? 1 : c.height - 3, w: c.innerWidth, h: 2 });
        }
        for (let i = 0; i < 30 && c.count() > goal; i++) {
            if (!sideRoom(c, rng)) break;
        }
        c.claim('structural');
        const corners = shuffle([
            { x: junction.x, y: junction.y }, { x: junction.x + junction.w - 1, y: junction.y },
            { x: junction.x, y: junction.y + junction.h - 1 }, { x: junction.x + junction.w - 1, y: junction.y + junction.h - 1 },
        ], rng);
        let placed = 0;
        for (const p of corners) {
            if (placed >= 2 || c.count() >= target) break;
            if (c.free(p.x, p.y) && nook(c, p) && c.tryPlace([p], 'cover', 'optional')) placed++;
        }
        fillTo(c, target, [0, c.height - 1], rng, extra);
    },
    extra,
};

export function generateCorridors(width: number, height: number, density: MapDensity, rng: Rng): AreaLayout {
    return runArea('corridors', CORRIDORS_AREA, width, height, density, rng);
}
