import { Canvas, chance, pickOne } from './canvas';
import type { AreaLayout, Rect } from './canvas';
import { fillTo, runArea } from './bands';
import type { AreaDefinition } from './bands';
import { placeIsolated } from './open';
import type { MapDensity, Pos, Rng } from '../types';

function perimeter(r: Rect): Pos[][] {
    const top: Pos[] = [];
    const right: Pos[] = [];
    const bottom: Pos[] = [];
    const left: Pos[] = [];
    for (let x = r.x; x < r.x + r.w; x++) top.push({ x, y: r.y });
    for (let y = r.y + 1; y < r.y + r.h; y++) right.push({ x: r.x + r.w - 1, y });
    for (let x = r.x + r.w - 2; x >= r.x; x--) bottom.push({ x, y: r.y + r.h - 1 });
    for (let y = r.y + r.h - 2; y > r.y; y--) left.push({ x: r.x, y });
    return [top, right, bottom, left];
}

function brokenRoom(c: Canvas, rng: Rng, budget: number): number {
    const w = rng.int(4, Math.min(6, c.innerWidth));
    const h = rng.int(3, Math.min(5, c.height - 1));
    const options: Rect[] = [];
    for (let y = 0; y + h <= c.height; y++) {
        for (let x = c.x0; x + w - 1 <= c.x1; x++) {
            const r = { x, y, w, h };
            const ring: Pos[] = [];
            for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) ring.push({ x: xx, y: yy });
            if (ring.every(p => c.free(p.x, p.y)) && c.clearAround(ring, 1)) options.push(r);
        }
    }
    const room = pickOne(options, rng);
    if (!room) return 0;
    const sides = perimeter(room);
    if (chance(rng, 0.3)) sides.splice(rng.int(0, 3), 1, []);
    const ring = sides.flat();
    const open = new Set<number>();
    const gaps = 2;
    for (let g = 0; g < gaps; g++) {
        const at = rng.int(0, ring.length - 1);
        const len = rng.int(1, 2);
        for (let k = 0; k < len; k++) open.add((at + k) % ring.length);
    }
    const runs: Pos[][] = [];
    let current: Pos[] = [];
    ring.forEach((p, i) => {
        const prev = i > 0 ? ring[i - 1] : undefined;
        const touching = prev && Math.abs(prev.x - p.x) + Math.abs(prev.y - p.y) === 1;
        if (open.has(i) || !touching) {
            if (current.length > 0) runs.push(current);
            current = open.has(i) ? [] : [p];
            return;
        }
        current.push(p);
    });
    if (current.length > 0) runs.push(current);
    let placed = 0;
    for (const run of runs) {
        let k = 0;
        while (k < run.length && placed < budget) {
            const len = Math.min(rng.int(2, 4), run.length - k);
            const chunk = run.slice(k, k + len);
            if (chunk.length >= 2 && c.tryPlace(chunk, 'wall', 'optional')) placed += chunk.length;
            k += len + (chance(rng, 0.2) ? 1 : 0);
        }
    }
    return placed;
}

function rubble(c: Canvas, rng: Rng): boolean {
    const seeds = c.floorCells(p => c.neighbourCount(p.x, p.y, 'wall', false) >= 1 && c.neighbourCount(p.x, p.y, 'difficult', false) === 0);
    const start = pickOne(seeds, rng);
    if (!start) return false;
    return c.tryPlace(c.blob(start, rng.int(1, 3), rng, p => c.free(p.x, p.y)), 'difficult', 'optional', false);
}

function fragment(c: Canvas, rng: Rng): boolean {
    const len = rng.int(2, 3);
    const horizontal = chance(rng, 0.5);
    const options: Pos[][] = [];
    for (const o of c.floorCells()) {
        const cells: Pos[] = [];
        for (let i = 0; i < len; i++) cells.push(horizontal ? { x: o.x + i, y: o.y } : { x: o.x, y: o.y + i });
        if (cells.every(p => c.free(p.x, p.y)) && c.clearAround(cells, 1)) options.push(cells);
    }
    const anchors = c.spreadSpots(options.map(o => o[0]), rng, 3);
    const anchor = pickOne(anchors, rng);
    const chosen = options.find(o => anchor && o[0].x === anchor.x && o[0].y === anchor.y);
    return !!chosen && c.tryPlace(chosen, 'wall', 'optional');
}

function extra(c: Canvas, rng: Rng): boolean {
    const roll = rng.next();
    if (roll < 0.4 && fragment(c, rng)) return true;
    if (roll < 0.8 && rubble(c, rng)) return true;
    return placeIsolated(c, rng, 'single', 'cover', 1);
}

export const RUINS_AREA: AreaDefinition = {
    build(c, target, rng) {
        const rooms = c.innerWidth >= 14 ? rng.int(2, 3) : c.innerWidth >= 10 ? 2 : 1;
        const wallBudget = Math.round(target * 0.75);
        for (let i = 0; i < rooms; i++) {
            const left = wallBudget - c.count();
            if (left < 2) break;
            brokenRoom(c, rng, left);
        }
        fillTo(c, Math.round(target * 0.92), [0, c.height - 1], rng, rubble, 30);
        fillTo(c, target, [0, c.height - 1], rng, extra);
    },
    extra,
};

export function generateRuins(width: number, height: number, density: MapDensity, rng: Rng): AreaLayout {
    return runArea('ruins', RUINS_AREA, width, height, density, rng);
}
